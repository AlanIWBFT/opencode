using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

namespace OpenCode.Windows
{
  public sealed class RecycleOperationEvent
  {
    public string Phase { get; internal set; } = string.Empty;
    public string? ItemPath { get; internal set; }
    public uint Flags { get; internal set; }
    public int HResult { get; internal set; }
    public string HResultHex => HResults.Hex(HResult);
    public string? HResultName => HResults.Name(HResult);
    public int? Win32Error => HResults.Win32Error(HResult);
    public string Message => HResults.Message(HResult);
    public bool RecycleDestinationCreated { get; internal set; }
    public string? RecycleDestinationPath { get; internal set; }
  }

  public sealed class RecycleResult
  {
    public string TargetPath { get; internal set; } = string.Empty;
    public uint OperationFlags { get; internal set; }
    public bool Succeeded { get; internal set; }
    public bool SafetyRejected { get; internal set; }
    public bool AnyOperationsAborted { get; internal set; }
    public bool RecycleDestinationCreated { get; internal set; }
    public bool TargetExistsAfter { get; internal set; }
    public string Stage { get; internal set; } = string.Empty;
    public int HResult { get; internal set; }
    public string HResultHex => HResults.Hex(HResult);
    public string? HResultName => HResults.Name(HResult);
    public int? Win32Error => HResults.Win32Error(HResult);
    public string Message { get; internal set; } = string.Empty;
    public int? PerformOperationsHResult { get; internal set; }
    public int? GetAnyOperationsAbortedHResult { get; internal set; }
    public int? UnadviseHResult { get; internal set; }
    public RecycleOperationEvent[] Events { get; internal set; } = Array.Empty<RecycleOperationEvent>();
    public RecycleLockDiagnosis? LockDiagnosis { get; internal set; }
  }

  public sealed class RecycleBlockingProcess
  {
    public int ProcessId { get; internal set; }
    public string Name { get; internal set; } = string.Empty;
    public string? ServiceName { get; internal set; }
  }

  public sealed class RecycleBlockingItem
  {
    public string Path { get; internal set; } = string.Empty;
    public string Kind { get; internal set; } = string.Empty;
    public RecycleBlockingProcess[] Processes { get; internal set; } = Array.Empty<RecycleBlockingProcess>();
  }

  public sealed class RecycleLockDiagnosis
  {
    public bool Complete { get; internal set; }
    public int ScannedEntries { get; internal set; }
    public int SkippedEntries { get; internal set; }
    public bool TimedOut { get; internal set; }
    public bool Truncated { get; internal set; }
    public int[] InaccessibleProcessIds { get; internal set; } = Array.Empty<int>();
    public string[] Issues { get; internal set; } = Array.Empty<string>();
    public RecycleBlockingItem[] BlockingItems { get; internal set; } = Array.Empty<RecycleBlockingItem>();
  }

  public static class RecycleBin
  {
    public const int ProtocolVersion = 2;

    private const int Ok = 0;
    private const uint FileOperationNoUi = 0x0614;
    private const uint FileOperationWantNukeWarning = 0x4000;
    private const uint FileOperationRecycleOnDelete = 0x00080000;
    private const uint FileOperationEarlyFailure = 0x00100000;
    private const uint FileOperationAddUndoRecord = 0x20000000;
    private const uint OperationFlags = FileOperationNoUi | FileOperationWantNukeWarning |
        FileOperationRecycleOnDelete | FileOperationEarlyFailure | FileOperationAddUndoRecord;

    public static RecycleResult Recycle(string path)
    {
      if (path == null) throw new ArgumentNullException(nameof(path));

      var result = new RecycleResult
      {
        TargetPath = Path.GetFullPath(path),
        OperationFlags = OperationFlags,
      };
      var thread = new Thread(() => Execute(result))
      {
        IsBackground = true,
        Name = "OpenCode Recycle Bin",
      };
      thread.SetApartmentState(ApartmentState.STA);
      thread.Start();
      thread.Join();
      if (!result.Succeeded && result.TargetExistsAfter && HResults.Win32Error(result.HResult) == 32)
      {
        result.LockDiagnosis = LockDiagnostics.Diagnose(result.TargetPath);
      }
      return result;
    }

    private static void Execute(RecycleResult result)
    {
      IFileOperation? operation = null;
      IShellItem? item = null;
      var sink = new FileOperationProgressSink();
      uint cookie = 0;
      var advised = false;

      try
      {
        operation = (IFileOperation)new FileOperationComObject();

        var hr = operation.SetOperationFlags(OperationFlags);
        if (HResults.Failed(hr))
        {
          Fail(result, "SetOperationFlags", hr);
          return;
        }

        var shellItemId = typeof(IShellItem).GUID;
        hr = NativeMethods.SHCreateItemFromParsingName(result.TargetPath, IntPtr.Zero, ref shellItemId, out item);
        if (HResults.Failed(hr))
        {
          Fail(result, "SHCreateItemFromParsingName", hr);
          return;
        }

        hr = operation.Advise(sink, out cookie);
        if (HResults.Failed(hr))
        {
          Fail(result, "Advise", hr);
          return;
        }
        advised = true;

        hr = operation.DeleteItem(item, null);
        if (HResults.Failed(hr))
        {
          Fail(result, "DeleteItem", hr);
          return;
        }

        result.PerformOperationsHResult = operation.PerformOperations();
        result.GetAnyOperationsAbortedHResult = operation.GetAnyOperationsAborted(out var aborted);
        result.AnyOperationsAborted = aborted != 0;
        Complete(result, sink);
      }
      catch (Exception exception)
      {
        var root = exception.GetBaseException();
        Fail(result, "ManagedException", Marshal.GetHRForException(root), root.Message);
      }
      finally
      {
        result.SafetyRejected = sink.SafetyRejected;
        result.Events = sink.Snapshot();
        result.TargetExistsAfter = File.Exists(result.TargetPath) || Directory.Exists(result.TargetPath);

        if (advised && operation != null)
        {
          result.UnadviseHResult = operation.Unadvise(cookie);
        }
        if (item != null) Marshal.FinalReleaseComObject(item);
        if (operation != null) Marshal.FinalReleaseComObject(operation);
        GC.KeepAlive(sink);
      }
    }

    private static void Complete(RecycleResult result, FileOperationProgressSink sink)
    {
      var post = sink.Snapshot().LastOrDefault(entry => entry.Phase == "PostDeleteItem");
      if (post != null && HResults.Failed(post.HResult))
      {
        Fail(result, "PostDeleteItem", post.HResult, post.Message);
        return;
      }
      if (sink.FinishOperationsHResult.HasValue && HResults.Failed(sink.FinishOperationsHResult.Value))
      {
        Fail(result, "FinishOperations", sink.FinishOperationsHResult.Value);
        return;
      }
      if (result.PerformOperationsHResult.HasValue && HResults.Failed(result.PerformOperationsHResult.Value))
      {
        Fail(result, "PerformOperations", result.PerformOperationsHResult.Value);
        return;
      }
      if (result.GetAnyOperationsAbortedHResult.HasValue && HResults.Failed(result.GetAnyOperationsAbortedHResult.Value))
      {
        Fail(result, "GetAnyOperationsAborted", result.GetAnyOperationsAbortedHResult.Value);
        return;
      }
      if (result.AnyOperationsAborted)
      {
        Fail(result, "GetAnyOperationsAborted", unchecked((int)0x80004004), "The operation was aborted.");
        return;
      }
      if (post == null)
      {
        Fail(result, "PostDeleteItem", unchecked((int)0x80004005), "PostDeleteItem was not observed.");
        return;
      }
      if (!post.RecycleDestinationCreated)
      {
        Fail(result, "PostDeleteItem", unchecked((int)0x80004005), "The Recycle Bin destination was not reported.");
        return;
      }

      result.Succeeded = true;
      result.RecycleDestinationCreated = true;
      result.Stage = "Completed";
      result.HResult = Ok;
      result.Message = HResults.Message(Ok);
    }

    private static void Fail(RecycleResult result, string stage, int hr, string? message = null)
    {
      result.Succeeded = false;
      result.Stage = stage;
      result.HResult = hr;
      result.Message = message ?? HResults.Message(hr);
    }
  }

  internal static class HResults
  {
    private const int Abort = unchecked((int)0x80004004);
    private const int Fail = unchecked((int)0x80004005);
    private const int CopyEngineDontProcessChildren = 0x00270008;
    private const int CopyEngineSharingViolationSource = unchecked((int)0x80270027);
    private const int CopyEngineSharingViolationDestination = unchecked((int)0x80270028);

    internal static bool Failed(int hr) => hr < 0;

    internal static string Hex(int hr) => "0x" + unchecked((uint)hr).ToString("X8", CultureInfo.InvariantCulture);

    internal static string? Name(int hr)
    {
      switch (hr)
      {
        case 0:
          return "S_OK";
        case Abort:
          return "E_ABORT";
        case Fail:
          return "E_FAIL";
        case CopyEngineDontProcessChildren:
          return "COPYENGINE_S_DONT_PROCESS_CHILDREN";
        case CopyEngineSharingViolationSource:
          return "COPYENGINE_E_SHARING_VIOLATION_SRC";
        case CopyEngineSharingViolationDestination:
          return "COPYENGINE_E_SHARING_VIOLATION_DEST";
        default:
          return null;
      }
    }

    internal static int? Win32Error(int hr)
    {
      if (hr == CopyEngineSharingViolationSource || hr == CopyEngineSharingViolationDestination) return 32;
      var value = unchecked((uint)hr);
      return ((value >> 16) & 0x1fff) == 7 ? (int)(value & 0xffff) : (int?)null;
    }

    internal static string Message(int hr)
    {
      if (hr == 0) return "The operation completed successfully.";
      if (hr == CopyEngineDontProcessChildren) return "The operation completed without processing child items separately.";
      if (hr == CopyEngineSharingViolationSource) return "A source item is in use by another process.";
      if (hr == CopyEngineSharingViolationDestination) return "An item required by the Recycle Bin operation is in use by another process.";
      return Marshal.GetExceptionForHR(hr)?.Message ?? "Unknown HRESULT " + Hex(hr) + ".";
    }
  }

  [ComVisible(true)]
  [ClassInterface(ClassInterfaceType.None)]
  internal sealed class FileOperationProgressSink : IFileOperationProgressSink
  {
    private const int Ok = 0;
    private const int Abort = unchecked((int)0x80004004);
    private const uint DeleteRecycleIfPossible = 0x80;
    private readonly List<RecycleOperationEvent> events = new List<RecycleOperationEvent>();

    internal bool SafetyRejected { get; private set; }
    internal int? FinishOperationsHResult { get; private set; }

    internal RecycleOperationEvent[] Snapshot() => events.ToArray();

    public int StartOperations()
    {
      events.Add(CreateEvent("StartOperations", 0, null, Ok, null));
      return Ok;
    }

    public int FinishOperations(int hrResult)
    {
      FinishOperationsHResult = hrResult;
      events.Add(CreateEvent("FinishOperations", 0, null, hrResult, null));
      return Ok;
    }

    public int PreRenameItem(uint flags, IShellItem item, string? newName) => Ok;

    public int PostRenameItem(uint flags, IShellItem item, string newName, int hrRename, IShellItem? newlyCreated) => Ok;

    public int PreMoveItem(uint flags, IShellItem item, IShellItem destinationFolder, string? newName) => Ok;

    public int PostMoveItem(uint flags, IShellItem item, IShellItem destinationFolder, string? newName, int hrMove, IShellItem? newlyCreated) => Ok;

    public int PreCopyItem(uint flags, IShellItem item, IShellItem destinationFolder, string? newName) => Ok;

    public int PostCopyItem(uint flags, IShellItem item, IShellItem destinationFolder, string? newName, int hrCopy, IShellItem? newlyCreated) => Ok;

    public int PreDeleteItem(uint flags, IShellItem item)
    {
      var hr = (flags & DeleteRecycleIfPossible) != 0 ? Ok : Abort;
      SafetyRejected = HResults.Failed(hr);
      events.Add(CreateEvent("PreDeleteItem", flags, item, hr, null));
      return hr;
    }

    public int PostDeleteItem(uint flags, IShellItem item, int hrDelete, IShellItem? newlyCreated)
    {
      events.Add(CreateEvent("PostDeleteItem", flags, item, hrDelete, newlyCreated));
      return Ok;
    }

    public int PreNewItem(uint flags, IShellItem destinationFolder, string? newName) => Ok;

    public int PostNewItem(uint flags, IShellItem destinationFolder, string? newName, string? templateName, uint fileAttributes, int hrNew, IShellItem? newItem) => Ok;

    public int UpdateProgress(uint workTotal, uint workSoFar) => Ok;

    public int ResetTimer() => Ok;

    public int PauseTimer() => Ok;

    public int ResumeTimer() => Ok;

    private static RecycleOperationEvent CreateEvent(string phase, uint flags, IShellItem? item, int hr, IShellItem? recycleDestination)
    {
      return new RecycleOperationEvent
      {
        Phase = phase,
        ItemPath = ShellItemDisplayName(item),
        Flags = flags,
        HResult = hr,
        RecycleDestinationCreated = recycleDestination != null,
        RecycleDestinationPath = ShellItemDisplayName(recycleDestination),
      };
    }

    private static string? ShellItemDisplayName(IShellItem? item)
    {
      if (item == null) return null;

      var hr = item.GetDisplayName(unchecked((uint)0x80058000), out var value);
      if (HResults.Failed(hr)) hr = item.GetDisplayName(unchecked((uint)0x80028000), out value);
      if (HResults.Failed(hr) || value == IntPtr.Zero) return null;

      try
      {
        return Marshal.PtrToStringUni(value);
      }
      finally
      {
        Marshal.FreeCoTaskMem(value);
      }
    }
  }

  internal static class NativeMethods
  {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    internal static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);
  }

  [ComImport]
  [Guid("3AD05575-8857-4850-9277-11B85BDB8E09")]
  [ClassInterface(ClassInterfaceType.None)]
  internal class FileOperationComObject
  {
  }

  [ComImport]
  [Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOperation
  {
    [PreserveSig]
    int Advise([MarshalAs(UnmanagedType.Interface)] IFileOperationProgressSink sink, out uint cookie);

    [PreserveSig]
    int Unadvise(uint cookie);

    [PreserveSig]
    int SetOperationFlags(uint operationFlags);

    [PreserveSig]
    int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);

    [PreserveSig]
    int SetProgressDialog(IntPtr progressDialog);

    [PreserveSig]
    int SetProperties(IntPtr propertyChangeArray);

    [PreserveSig]
    int SetOwnerWindow(IntPtr ownerWindow);

    [PreserveSig]
    int ApplyPropertiesToItem(IShellItem item);

    [PreserveSig]
    int ApplyPropertiesToItems(IntPtr items);

    [PreserveSig]
    int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink? sink);

    [PreserveSig]
    int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string newName);

    [PreserveSig]
    int MoveItem(IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName, IFileOperationProgressSink? sink);

    [PreserveSig]
    int MoveItems(IntPtr items, IShellItem destinationFolder);

    [PreserveSig]
    int CopyItem(IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? copyName, IFileOperationProgressSink? sink);

    [PreserveSig]
    int CopyItems(IntPtr items, IShellItem destinationFolder);

    [PreserveSig]
    int DeleteItem(IShellItem item, IFileOperationProgressSink? sink);

    [PreserveSig]
    int DeleteItems(IntPtr items);

    [PreserveSig]
    int NewItem(IShellItem destinationFolder, uint fileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string? templateName, IFileOperationProgressSink? sink);

    [PreserveSig]
    int PerformOperations();

    [PreserveSig]
    int GetAnyOperationsAborted(out int anyOperationsAborted);
  }

  [ComImport]
  [Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOperationProgressSink
  {
    [PreserveSig]
    int StartOperations();

    [PreserveSig]
    int FinishOperations(int hrResult);

    [PreserveSig]
    int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string? newName);

    [PreserveSig]
    int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hrRename, IShellItem? newlyCreated);

    [PreserveSig]
    int PreMoveItem(uint flags, IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName);

    [PreserveSig]
    int PostMoveItem(uint flags, IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName, int hrMove, IShellItem? newlyCreated);

    [PreserveSig]
    int PreCopyItem(uint flags, IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName);

    [PreserveSig]
    int PostCopyItem(uint flags, IShellItem item, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName, int hrCopy, IShellItem? newlyCreated);

    [PreserveSig]
    int PreDeleteItem(uint flags, IShellItem item);

    [PreserveSig]
    int PostDeleteItem(uint flags, IShellItem item, int hrDelete, IShellItem? newlyCreated);

    [PreserveSig]
    int PreNewItem(uint flags, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName);

    [PreserveSig]
    int PostNewItem(uint flags, IShellItem destinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string? newName, [MarshalAs(UnmanagedType.LPWStr)] string? templateName, uint fileAttributes, int hrNew, IShellItem? newItem);

    [PreserveSig]
    int UpdateProgress(uint workTotal, uint workSoFar);

    [PreserveSig]
    int ResetTimer();

    [PreserveSig]
    int PauseTimer();

    [PreserveSig]
    int ResumeTimer();
  }

  [ComImport]
  [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem
  {
    [PreserveSig]
    int BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);

    [PreserveSig]
    int GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem parent);

    [PreserveSig]
    int GetDisplayName(uint displayName, out IntPtr name);

    [PreserveSig]
    int GetAttributes(uint mask, out uint attributes);

    [PreserveSig]
    int Compare(IShellItem other, uint hint, out int order);
  }
}
