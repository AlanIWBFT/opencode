#:property TargetFramework=net10.0
#:property OutputType=WinExe
#:property AssemblyName=OpenCode.ProcessBroker
#:property PublishAot=true
#:property PublishSingleFile=true
#:property SelfContained=true
#:property DebugType=None
#:property DebugSymbols=false
#:property OptimizationPreference=Size
#:property InvariantGlobalization=true

using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

if (!OperatingSystem.IsWindows()) return 1;
if (args is ["--protocol-version"])
{
    Console.WriteLine(Protocol.Version);
    return 0;
}
if (args is ["--runtime-kind"])
{
    Console.WriteLine(RuntimeFeature.IsDynamicCodeSupported ? "coreclr" : "nativeaot");
    return 0;
}
if (!BrokerArguments.TryParse(args, out var pipeName, out var parentPid)) return 1;
return await Broker.RunAsync(pipeName, parentPid);

static class Protocol
{
    public const uint Magic = 0x4250434f;
    public const ushort Version = 2;
    public const int HeaderBytes = 20;
    public const int MaxPayloadBytes = 16 * 1024 * 1024;

    public enum FrameType : ushort
    {
        Hello = 1,
        HelloOk = 2,
        Spawn = 3,
        Spawned = 4,
        Stdin = 5,
        StdinClose = 6,
        Stdout = 7,
        Stderr = 8,
        Exit = 9,
        Close = 10,
        Cancel = 11,
        Error = 12,
        Credit = 13,
        StdinAck = 14,
    }
}

static class BrokerArguments
{
    public static bool TryParse(string[] args, out string pipeName, out int parentPid)
    {
        pipeName = string.Empty;
        parentPid = 0;
        for (var index = 0; index + 1 < args.Length; index++)
        {
            if (args[index] == "--pipe") pipeName = args[++index];
            else if (args[index] == "--parent-pid" && int.TryParse(args[++index], out var value)) parentPid = value;
        }

        const string prefix = @"\\.\pipe\";
        if (!pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || pipeName.Length == prefix.Length || parentPid <= 0) return false;
        pipeName = pipeName[prefix.Length..];
        return pipeName.IndexOfAny(['\\', '/']) < 0;
    }
}

static class Broker
{
    private static readonly SemaphoreSlim LaunchSlots = new(4, 4);

    public static async Task<int> RunAsync(string pipeName, int parentPid)
    {
        Process parent;
        try
        {
            parent = Process.GetProcessById(parentPid);
            if (parent.HasExited) return 2;
        }
        catch
        {
            return 2;
        }

        _ = ExitWithParentAsync(parent);
        while (true)
        {
            NamedPipeServerStream pipe;
            try
            {
                pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    16,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
                    64 * 1024,
                    64 * 1024);
                await pipe.WaitForConnectionAsync();
            }
            catch
            {
                return 3;
            }

            _ = new ClientSession(pipe, LaunchSlots).RunAsync();
        }
    }

    private static async Task ExitWithParentAsync(Process parent)
    {
        using (parent)
        {
            try
            {
                await parent.WaitForExitAsync();
            }
            catch
            {
            }
        }
        Environment.Exit(0);
    }
}

sealed class ClientSession
{
    private readonly NamedPipeServerStream _pipe;
    private readonly SemaphoreSlim _launchSlots;
    private readonly CancellationTokenSource _closed = new();
    private readonly ConcurrentDictionary<ulong, ManagedCommand> _commands = new();
    private readonly object _writerLock = new();
    private readonly Queue<OutgoingFrame> _controlFrames = new();
    private readonly Dictionary<ulong, Queue<OutgoingFrame>> _outputFrames = new();
    private readonly Queue<ulong> _readyOutputCommands = new();
    private readonly SemaphoreSlim _writeSignal = new(0);
    private Task? _writerTask;

    public ClientSession(NamedPipeServerStream pipe, SemaphoreSlim launchSlots)
    {
        _pipe = pipe;
        _launchSlots = launchSlots;
    }

    public CancellationToken Closed => _closed.Token;

    public async Task RunAsync()
    {
        _writerTask = WriteFramesAsync();
        try
        {
            var hello = await ReadFrameAsync(_closed.Token);
            if (hello.Type != Protocol.FrameType.Hello || hello.Id != 0 || hello.Payload.Length != 0) return;
            await SendAsync(Protocol.FrameType.HelloOk, 0, ReadOnlyMemory<byte>.Empty);

            while (!_closed.IsCancellationRequested)
            {
                var frame = await ReadFrameAsync(_closed.Token);
                switch (frame.Type)
                {
                    case Protocol.FrameType.Spawn:
                        Spawn(frame.Id, SpawnRequest.Parse(frame.Payload));
                        break;
                    case Protocol.FrameType.Stdin:
                        if (!_commands.TryGetValue(frame.Id, out var stdin) || !stdin.TryWriteStdin(frame.Payload, close: false)) return;
                        break;
                    case Protocol.FrameType.StdinClose:
                        if (frame.Payload.Length != 0 || !_commands.TryGetValue(frame.Id, out var close) || !close.TryWriteStdin(frame.Payload, close: true)) return;
                        break;
                    case Protocol.FrameType.Cancel:
                        if (frame.Payload.Length != 0 || !_commands.TryGetValue(frame.Id, out var cancel)) return;
                        cancel.Cancel();
                        break;
                    case Protocol.FrameType.Credit:
                        if (_commands.TryGetValue(frame.Id, out var credit) && !credit.GrantOutputCredit(frame.Payload)) return;
                        break;
                    default:
                        return;
                }
            }
        }
        catch (Exception error) when (error is EndOfStreamException or IOException or OperationCanceledException or ProtocolException)
        {
        }
        finally
        {
            _closed.Cancel();
            foreach (var command in _commands.Values) command.Cancel();
            _pipe.Dispose();
            if (_writerTask is not null) await _writerTask;
        }
    }

    public Task SendAsync(Protocol.FrameType type, ulong id, ReadOnlyMemory<byte> payload) => EnqueueFrame(type, id, payload, output: false);

    public Task SendOutputAsync(Protocol.FrameType type, ulong id, ReadOnlyMemory<byte> payload) => EnqueueFrame(type, id, payload, output: true);

    private Task EnqueueFrame(Protocol.FrameType type, ulong id, ReadOnlyMemory<byte> payload, bool output)
    {
        if (payload.Length > Protocol.MaxPayloadBytes) throw new ProtocolException("Frame payload is too large");
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_writerLock)
        {
            if (_closed.IsCancellationRequested) return Task.FromCanceled(_closed.Token);
            var frame = new OutgoingFrame(type, id, payload, completion);
            if (!output)
            {
                _controlFrames.Enqueue(frame);
            }
            else
            {
                if (!_outputFrames.TryGetValue(id, out var frames))
                {
                    frames = new Queue<OutgoingFrame>();
                    _outputFrames.Add(id, frames);
                    _readyOutputCommands.Enqueue(id);
                }
                frames.Enqueue(frame);
            }
            _writeSignal.Release();
        }
        return completion.Task;
    }

    public Task SendUInt32Async(Protocol.FrameType type, ulong id, uint value)
    {
        var payload = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(payload, value);
        return SendAsync(type, id, payload);
    }

    public Task SendErrorAsync(ulong id, string stage, Exception error)
    {
        var code = error is Win32Exception windows ? (uint)windows.NativeErrorCode : NativeMethods.ErrorGenFailure;
        var message = error.Message;
        return SendAsync(Protocol.FrameType.Error, id, PayloadWriter.Error(code, stage, message));
    }

    public void Remove(ulong id) => _commands.TryRemove(id, out _);

    private async Task WriteFramesAsync()
    {
        Exception? failure = null;
        try
        {
            while (true)
            {
                await _writeSignal.WaitAsync(_closed.Token);
                OutgoingFrame frame;
                lock (_writerLock)
                {
                    if (_controlFrames.Count != 0)
                    {
                        frame = _controlFrames.Dequeue();
                    }
                    else
                    {
                        var id = _readyOutputCommands.Dequeue();
                        var frames = _outputFrames[id];
                        frame = frames.Dequeue();
                        if (frames.Count == 0) _outputFrames.Remove(id);
                        else _readyOutputCommands.Enqueue(id);
                    }
                }

                try
                {
                    await WriteFrameAsync(frame);
                    frame.Completion.TrySetResult();
                }
                catch (Exception error)
                {
                    frame.Completion.TrySetException(error);
                    throw;
                }
            }
        }
        catch (Exception error)
        {
            failure = error;
        }
        finally
        {
            _closed.Cancel();
            var pending = new List<OutgoingFrame>();
            lock (_writerLock)
            {
                pending.AddRange(_controlFrames);
                _controlFrames.Clear();
                foreach (var frames in _outputFrames.Values) pending.AddRange(frames);
                _outputFrames.Clear();
                _readyOutputCommands.Clear();
            }
            failure ??= new OperationCanceledException("Windows process broker connection closed");
            foreach (var frame in pending) frame.Completion.TrySetException(failure);
        }
    }

    private async Task WriteFrameAsync(OutgoingFrame frame)
    {
        var header = new byte[Protocol.HeaderBytes];
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(0, 4), Protocol.Magic);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(4, 2), Protocol.Version);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(6, 2), (ushort)frame.Type);
        BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(8, 8), frame.Id);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(16, 4), (uint)frame.Payload.Length);
        await _pipe.WriteAsync(header, _closed.Token);
        if (!frame.Payload.IsEmpty) await _pipe.WriteAsync(frame.Payload, _closed.Token);
    }

    private void Spawn(ulong id, SpawnRequest request)
    {
        var command = new ManagedCommand(this, _launchSlots, id, request);
        if (!_commands.TryAdd(id, command)) throw new ProtocolException("Duplicate command id");
        _ = command.RunAsync();
    }

    private async Task<Frame> ReadFrameAsync(CancellationToken cancellationToken)
    {
        var header = new byte[Protocol.HeaderBytes];
        await _pipe.ReadExactlyAsync(header, cancellationToken);
        if (BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(0, 4)) != Protocol.Magic ||
            BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(4, 2)) != Protocol.Version)
        {
            throw new ProtocolException("Invalid frame header");
        }

        var size = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(16, 4));
        if (size > Protocol.MaxPayloadBytes) throw new ProtocolException("Frame payload is too large");
        var payload = new byte[(int)size];
        if (size != 0) await _pipe.ReadExactlyAsync(payload, cancellationToken);
        return new Frame(
            (Protocol.FrameType)BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(6, 2)),
            BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(8, 8)),
            payload);
    }

    private readonly record struct Frame(Protocol.FrameType Type, ulong Id, byte[] Payload);
    private sealed record OutgoingFrame(Protocol.FrameType Type, ulong Id, ReadOnlyMemory<byte> Payload, TaskCompletionSource Completion);
}

sealed class ManagedCommand : IDisposable
{
    private readonly ClientSession _client;
    private readonly SemaphoreSlim _launchSlots;
    private readonly ulong _id;
    private readonly SpawnRequest _request;
    private readonly CancellationTokenSource _cancel = new();
    private readonly CancellationTokenSource _stdinCancel = new();
    private readonly Channel<StdinRequest> _stdinRequests = Channel.CreateBounded<StdinRequest>(new BoundedChannelOptions(1)
    {
        SingleReader = true,
        SingleWriter = true,
        FullMode = BoundedChannelFullMode.Wait,
    });
    private readonly object _handlesLock = new();
    private readonly OutputCredit _stdoutCredit = new();
    private readonly OutputCredit _stderrCredit = new();
    private SafeJobHandle? _job;
    private SafeProcessHandle? _process;
    private NamedPipeServerStream? _stdin;
    private NamedPipeServerStream? _stdout;
    private NamedPipeServerStream? _stderr;
    private bool _closed;

    public ManagedCommand(ClientSession client, SemaphoreSlim launchSlots, ulong id, SpawnRequest request)
    {
        _client = client;
        _launchSlots = launchSlots;
        _id = id;
        _request = request;
    }

    public async Task RunAsync()
    {
        var acquired = false;
        try
        {
            await _launchSlots.WaitAsync(_cancel.Token);
            acquired = true;
            var pid = Launch();
            _launchSlots.Release();
            acquired = false;

            if (!_request.KeepStdinOpen)
            {
                _stdinCancel.Cancel();
                _stdin?.Dispose();
            }
            await _client.SendUInt32Async(Protocol.FrameType.Spawned, _id, pid);
            var stdinTask = _request.KeepStdinOpen ? PumpStdinAsync() : Task.CompletedTask;
            var stdoutTask = PumpOutputAsync(_stdout!, Protocol.FrameType.Stdout);
            var stderrTask = PumpOutputAsync(_stderr!, Protocol.FrameType.Stderr);

            await NativeMethods.WaitForProcessAsync(_process!);
            if (!NativeMethods.GetExitCodeProcess(_process!, out var exitCode)) throw new Win32Exception(Marshal.GetLastWin32Error());
            TerminateJob(exitCode == 0 ? 1u : exitCode);
            _stdinCancel.Cancel();
            _stdin?.Dispose();
            await _client.SendUInt32Async(Protocol.FrameType.Exit, _id, exitCode);
            await IgnoreCancellationAsync(stdinTask);
            await Task.WhenAll(stdoutTask, stderrTask);
            await _client.SendAsync(Protocol.FrameType.Close, _id, ReadOnlyMemory<byte>.Empty);
        }
        catch (OperationCanceledException)
        {
            await TrySendErrorAsync("spawn", new Win32Exception((int)NativeMethods.ErrorCancelled));
        }
        catch (Exception error)
        {
            Cancel();
            await TrySendErrorAsync("spawn", error);
        }
        finally
        {
            if (acquired) _launchSlots.Release();
            _client.Remove(_id);
            Dispose();
        }
    }

    public bool TryWriteStdin(byte[] payload, bool close)
    {
        if (_closed || !_request.KeepStdinOpen) return false;
        if (!close && payload.Length == 0)
        {
            _ = AcknowledgeEmptyStdinAsync();
            return true;
        }
        return _stdinRequests.Writer.TryWrite(new StdinRequest(payload, close));
    }

    public bool GrantOutputCredit(byte[] payload)
    {
        if (payload.Length != 6) return false;
        var type = (Protocol.FrameType)BinaryPrimitives.ReadUInt16LittleEndian(payload.AsSpan(0, 2));
        var amount = BinaryPrimitives.ReadUInt32LittleEndian(payload.AsSpan(2, 4));
        return type switch
        {
            Protocol.FrameType.Stdout => _stdoutCredit.Grant(amount),
            Protocol.FrameType.Stderr => _stderrCredit.Grant(amount),
            _ => false,
        };
    }

    public void Cancel()
    {
        if (_closed) return;
        try
        {
            _cancel.Cancel();
            _stdinCancel.Cancel();
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        TerminateJob(NativeMethods.ErrorCancelled);
        _stdin?.Dispose();
    }

    public void Dispose()
    {
        if (_closed) return;
        _closed = true;
        _cancel.Cancel();
        _stdinCancel.Cancel();
        _stdinRequests.Writer.TryComplete();
        _stdin?.Dispose();
        _stdout?.Dispose();
        _stderr?.Dispose();
        lock (_handlesLock)
        {
            _process?.Dispose();
            _job?.Dispose();
        }
        _cancel.Dispose();
        _stdinCancel.Dispose();
    }

    private uint Launch()
    {
        _cancel.Token.ThrowIfCancellationRequested();
        using var stdin = ChildPipe.Create(PipeDirection.Out);
        using var stdout = ChildPipe.Create(PipeDirection.In);
        using var stderr = ChildPipe.Create(PipeDirection.In);
        using var job = NativeMethods.CreateKillOnCloseJob();
        using var attributes = new ProcessAttributeList(
            [stdin.ChildHandle, stdout.ChildHandle, stderr.ChildHandle],
            job.DangerousGetHandle());

        var startup = new NativeMethods.StartupInfoEx
        {
            StartupInfo = new NativeMethods.StartupInfo
            {
                Size = (uint)Marshal.SizeOf<NativeMethods.StartupInfoEx>(),
                Flags = NativeMethods.StartfUseStdHandles,
                StdInput = stdin.ChildHandle,
                StdOutput = stdout.ChildHandle,
                StdError = stderr.ChildHandle,
            },
            AttributeList = attributes.Pointer,
        };

        var commandLine = new StringBuilder(CommandLine.Build(_request.Executable, _request.Arguments));
        var environment = EnvironmentBlock.Create(_request.Environment);
        var environmentPointer = Marshal.AllocHGlobal(environment.Length * sizeof(char));
        try
        {
            Marshal.Copy(environment, 0, environmentPointer, environment.Length);
            if (!NativeMethods.CreateProcess(
                    _request.Executable,
                    commandLine,
                    environmentPointer,
                    _request.WorkingDirectory,
                    ref startup,
                    out var information))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            NativeMethods.CloseHandle(information.Thread);
            var process = new SafeProcessHandle(information.Process, ownsHandle: true);
            lock (_handlesLock)
            {
                _job = new SafeJobHandle(job.DangerousGetHandle(), ownsHandle: true);
                job.SetHandleAsInvalid();
                _process = process;
                if (_cancel.IsCancellationRequested) NativeMethods.TerminateJobObject(_job, NativeMethods.ErrorCancelled);
            }
            _stdin = stdin.TakeServer();
            _stdout = stdout.TakeServer();
            _stderr = stderr.TakeServer();
            return information.ProcessId;
        }
        finally
        {
            Marshal.FreeHGlobal(environmentPointer);
        }
    }

    private async Task PumpStdinAsync()
    {
        try
        {
            await foreach (var request in _stdinRequests.Reader.ReadAllAsync(_stdinCancel.Token))
            {
                if (request.Close)
                {
                    _stdin?.Dispose();
                    await _client.SendUInt32Async(Protocol.FrameType.StdinAck, _id, 0);
                    return;
                }

                try
                {
                    await _stdin!.WriteAsync(request.Payload, _stdinCancel.Token);
                    await _client.SendUInt32Async(Protocol.FrameType.StdinAck, _id, 0);
                }
                catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException)
                {
                    await TrySendStdinErrorAsync(error);
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task PumpOutputAsync(NamedPipeServerStream stream, Protocol.FrameType type)
    {
        var buffer = new byte[64 * 1024];
        var credit = type == Protocol.FrameType.Stdout ? _stdoutCredit : _stderrCredit;
        try
        {
            while (true)
            {
                var allowance = await credit.TakeAsync(buffer.Length, _cancel.Token);
                var count = await stream.ReadAsync(buffer.AsMemory(0, allowance), _cancel.Token);
                if (count == 0) return;
                credit.Return(allowance - count);
                await _client.SendOutputAsync(type, _id, buffer.AsMemory(0, count));
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException)
        {
            if (!_client.Closed.IsCancellationRequested && !_cancel.IsCancellationRequested) throw;
        }
    }

    private void TerminateJob(uint exitCode)
    {
        lock (_handlesLock)
        {
            if (_job is { IsInvalid: false, IsClosed: false }) NativeMethods.TerminateJobObject(_job, exitCode);
        }
    }

    private async Task TrySendErrorAsync(string stage, Exception error)
    {
        try
        {
            await _client.SendErrorAsync(_id, stage, error);
        }
        catch
        {
        }
    }

    private async Task TrySendStdinErrorAsync(Exception error)
    {
        try
        {
            var code = error is Win32Exception windows ? (uint)windows.NativeErrorCode : NativeMethods.ErrorBrokenPipe;
            await _client.SendUInt32Async(Protocol.FrameType.StdinAck, _id, code);
        }
        catch
        {
        }
    }

    private async Task AcknowledgeEmptyStdinAsync()
    {
        try
        {
            await _client.SendUInt32Async(Protocol.FrameType.StdinAck, _id, 0);
        }
        catch
        {
        }
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException)
        {
        }
    }

    private readonly record struct StdinRequest(byte[] Payload, bool Close);
}

sealed class OutputCredit
{
    private const long MaxAvailable = Protocol.MaxPayloadBytes;
    private readonly object _lock = new();
    private long _available;
    private TaskCompletionSource? _waiter;

    public bool Grant(uint amount)
    {
        if (amount == 0) return false;
        TaskCompletionSource? waiter;
        lock (_lock)
        {
            if (_available > MaxAvailable - amount) return false;
            _available += amount;
            waiter = _waiter;
            _waiter = null;
        }
        waiter?.TrySetResult();
        return true;
    }

    public async ValueTask<int> TakeAsync(int maximum, CancellationToken cancellationToken)
    {
        while (true)
        {
            Task wait;
            lock (_lock)
            {
                if (_available != 0)
                {
                    var amount = (int)Math.Min(_available, maximum);
                    _available -= amount;
                    return amount;
                }
                _waiter ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                wait = _waiter.Task;
            }
            await wait.WaitAsync(cancellationToken);
        }
    }

    public void Return(int amount)
    {
        if (amount == 0) return;
        TaskCompletionSource? waiter;
        lock (_lock)
        {
            if (amount < 0 || _available > MaxAvailable - amount) throw new ProtocolException("Output credit overflow");
            _available += amount;
            waiter = _waiter;
            _waiter = null;
        }
        waiter?.TrySetResult();
    }
}

sealed class ChildPipe : IDisposable
{
    private NamedPipeServerStream? _server;
    private readonly NamedPipeClientStream _client;

    private ChildPipe(NamedPipeServerStream server, NamedPipeClientStream client)
    {
        _server = server;
        _client = client;
    }

    public nint ChildHandle => _client.SafePipeHandle.DangerousGetHandle();

    public static ChildPipe Create(PipeDirection brokerDirection)
    {
        var name = $"opencode-process-stdio-{Environment.ProcessId}-{Guid.NewGuid():N}";
        var server = new NamedPipeServerStream(
            name,
            brokerDirection,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
            64 * 1024,
            64 * 1024);
        var childDirection = brokerDirection == PipeDirection.In ? PipeDirection.Out : PipeDirection.In;
        var client = new NamedPipeClientStream(".", name, childDirection, PipeOptions.None);
        try
        {
            var connected = server.WaitForConnectionAsync();
            client.Connect(5_000);
            connected.GetAwaiter().GetResult();
            if (!NativeMethods.SetHandleInformation(client.SafePipeHandle.DangerousGetHandle(), NativeMethods.HandleFlagInherit, NativeMethods.HandleFlagInherit))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return new ChildPipe(server, client);
        }
        catch
        {
            client.Dispose();
            server.Dispose();
            throw;
        }
    }

    public NamedPipeServerStream TakeServer()
    {
        var server = _server ?? throw new ObjectDisposedException(nameof(ChildPipe));
        _server = null;
        return server;
    }

    public void Dispose()
    {
        _client.Dispose();
        _server?.Dispose();
    }
}

sealed class ProcessAttributeList : IDisposable
{
    private nint _pointer;
    private readonly nint _handles;
    private readonly nint _job;

    public ProcessAttributeList(nint[] handles, nint job)
    {
        nuint size = 0;
        NativeMethods.InitializeProcThreadAttributeList(0, 2, 0, ref size);
        _pointer = Marshal.AllocHGlobal((nint)size);
        _handles = Marshal.AllocHGlobal(handles.Length * nint.Size);
        _job = Marshal.AllocHGlobal(nint.Size);
        try
        {
            if (!NativeMethods.InitializeProcThreadAttributeList(_pointer, 2, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            Marshal.Copy(handles, 0, _handles, handles.Length);
            Marshal.WriteIntPtr(_job, job);
            if (!NativeMethods.UpdateProcThreadAttribute(
                    _pointer,
                    0,
                    NativeMethods.ProcThreadAttributeHandleList,
                    _handles,
                    (nuint)(handles.Length * nint.Size),
                    0,
                    0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!NativeMethods.UpdateProcThreadAttribute(
                    _pointer,
                    0,
                    NativeMethods.ProcThreadAttributeJobList,
                    _job,
                    (nuint)nint.Size,
                    0,
                    0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public nint Pointer => _pointer;

    public void Dispose()
    {
        if (_pointer != 0)
        {
            NativeMethods.DeleteProcThreadAttributeList(_pointer);
            Marshal.FreeHGlobal(_pointer);
            _pointer = 0;
        }
        Marshal.FreeHGlobal(_handles);
        Marshal.FreeHGlobal(_job);
    }
}

sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeJobHandle() : base(ownsHandle: true)
    {
    }

    public SafeJobHandle(nint handle, bool ownsHandle) : base(ownsHandle)
    {
        SetHandle(handle);
    }

    protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
}

sealed record SpawnRequest(bool KeepStdinOpen, string Executable, string WorkingDirectory, string[] Arguments, KeyValuePair<string, string>[] Environment)
{
    public static SpawnRequest Parse(byte[] payload)
    {
        var reader = new PayloadReader(payload);
        var flags = reader.ReadUInt32();
        if ((flags & ~1u) != 0) throw new ProtocolException("Unknown spawn flags");
        var executable = reader.ReadString();
        var workingDirectory = reader.ReadString();
        var argumentCount = reader.ReadUInt32();
        if (argumentCount > 4096) throw new ProtocolException("Too many arguments");
        var arguments = new string[argumentCount];
        for (var index = 0; index < arguments.Length; index++) arguments[index] = reader.ReadString();
        var environmentCount = reader.ReadUInt32();
        if (environmentCount > 32768) throw new ProtocolException("Too many environment variables");
        var environment = new KeyValuePair<string, string>[environmentCount];
        for (var index = 0; index < environment.Length; index++) environment[index] = KeyValuePair.Create(reader.ReadString(), reader.ReadString());
        reader.EnsureDone();

        if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(workingDirectory)) throw new ProtocolException("Executable and working directory must be absolute");
        if (executable.Contains('\0') || workingDirectory.Contains('\0') || arguments.Any(value => value.Contains('\0'))) throw new ProtocolException("Spawn values cannot contain NUL");
        foreach (var item in environment)
        {
            if (item.Key.Length == 0 || item.Key.Contains('=') || item.Key.Contains('\0') || item.Value.Contains('\0')) throw new ProtocolException("Invalid environment variable");
        }
        return new SpawnRequest((flags & 1) != 0, executable, workingDirectory, arguments, environment);
    }
}

sealed class PayloadReader
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly byte[] _payload;
    private int _offset;

    public PayloadReader(byte[] payload) => _payload = payload;

    public uint ReadUInt32()
    {
        if (_offset > _payload.Length - 4) throw new ProtocolException("Truncated payload");
        var value = BinaryPrimitives.ReadUInt32LittleEndian(_payload.AsSpan(_offset, 4));
        _offset += 4;
        return value;
    }

    public string ReadString()
    {
        var size = ReadUInt32();
        if (size > int.MaxValue || _offset > _payload.Length - (int)size) throw new ProtocolException("Truncated string");
        try
        {
            var value = Utf8.GetString(_payload, _offset, (int)size);
            _offset += (int)size;
            return value;
        }
        catch (DecoderFallbackException error)
        {
            throw new ProtocolException("Invalid UTF-8", error);
        }
    }

    public void EnsureDone()
    {
        if (_offset != _payload.Length) throw new ProtocolException("Trailing payload data");
    }
}

static class PayloadWriter
{
    public static byte[] Error(uint code, string stage, string message)
    {
        var stageBytes = Encoding.UTF8.GetBytes(stage);
        var messageBytes = Encoding.UTF8.GetBytes(message);
        var payload = new byte[12 + stageBytes.Length + messageBytes.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, 4), code);
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(4, 4), (uint)stageBytes.Length);
        stageBytes.CopyTo(payload.AsSpan(8));
        var messageOffset = 8 + stageBytes.Length;
        BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(messageOffset, 4), (uint)messageBytes.Length);
        messageBytes.CopyTo(payload.AsSpan(messageOffset + 4));
        return payload;
    }
}

static class EnvironmentBlock
{
    public static char[] Create(IEnumerable<KeyValuePair<string, string>> environment)
    {
        var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var values = environment
            .OrderBy(item => item.Key, StringComparer.Ordinal)
            .Where(item => unique.Add(item.Key))
            .OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase)
            .Select(item => $"{item.Key}={item.Value}")
            .ToArray();
        return (string.Join('\0', values) + "\0\0").ToCharArray();
    }
}

static class CommandLine
{
    public static string Build(string executable, IEnumerable<string> arguments) => string.Join(' ', new[] { executable }.Concat(arguments).Select(Quote));

    private static string Quote(string value)
    {
        if (value.Length != 0 && value.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0) return value;
        var output = new StringBuilder().Append('"');
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                output.Append('\\', slashes * 2 + 1).Append(character);
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }
}

sealed class ProtocolException : Exception
{
    public ProtocolException(string message) : base(message)
    {
    }

    public ProtocolException(string message, Exception inner) : base(message, inner)
    {
    }
}

static class NativeMethods
{
    public const uint StartfUseStdHandles = 0x00000100;
    public const uint HandleFlagInherit = 0x00000001;
    public const uint ProcThreadAttributeHandleList = 0x00020002;
    public const uint ProcThreadAttributeJobList = 0x0002000D;
    public const uint ErrorBrokenPipe = 109;
    public const uint ErrorGenFailure = 31;
    public const uint ErrorCancelled = 1223;
    private const uint DetachedProcess = 0x00000008;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;

    public static SafeJobHandle CreateKillOnCloseJob()
    {
        var job = CreateJobObject(0, null);
        if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose },
        };
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, ref limits, (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>()))
        {
            var error = new Win32Exception(Marshal.GetLastWin32Error());
            job.Dispose();
            throw error;
        }
        return job;
    }

    public static bool CreateProcess(string executable, StringBuilder commandLine, nint environment, string workingDirectory, ref StartupInfoEx startup, out ProcessInformation information) =>
        CreateProcessW(
            executable,
            commandLine,
            0,
            0,
            true,
            DetachedProcess | CreateUnicodeEnvironment | ExtendedStartupInfoPresent,
            environment,
            workingDirectory,
            ref startup,
            out information);

    public static Task WaitForProcessAsync(SafeProcessHandle process)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var wait = new EventWaitHandle(false, EventResetMode.ManualReset)
        {
            SafeWaitHandle = new SafeWaitHandle(process.DangerousGetHandle(), ownsHandle: false),
        };
        RegisteredWaitHandle? registration = null;
        registration = ThreadPool.RegisterWaitForSingleObject(wait, (_, _) => completion.TrySetResult(), null, Timeout.Infinite, executeOnlyOnce: true);
        return CompleteWaitAsync(completion.Task, wait, registration);
    }

    private static async Task CompleteWaitAsync(Task completion, WaitHandle wait, RegisteredWaitHandle registration)
    {
        try
        {
            await completion;
        }
        finally
        {
            registration.Unregister(null);
            wait.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct StartupInfo
    {
        public uint Size;
        public nint Reserved;
        public nint Desktop;
        public nint Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2Size;
        public nint Reserved2;
        public nint StdInput;
        public nint StdOutput;
        public nint StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public nint AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation
    {
        public nint Process;
        public nint Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryUsed;
        public nuint PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        nint processAttributes,
        nint threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        nint environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeJobHandle CreateJobObject(nint securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeJobHandle job, int informationClass, ref JobObjectExtendedLimitInformation information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetHandleInformation(nint handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool InitializeProcThreadAttributeList(nint attributeList, int attributeCount, uint flags, ref nuint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(nint attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UpdateProcThreadAttribute(nint attributeList, uint flags, nuint attribute, nint value, nuint size, nint previousValue, nint returnSize);
}
