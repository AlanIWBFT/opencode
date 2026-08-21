using Microsoft.Win32.SafeHandles;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace OpenCode.Windows
{
  internal static class LockDiagnostics
  {
    private const int ErrorAccessDenied = 5;
    private const int ErrorMoreData = 234;
    private const int ErrorSharingViolation = 32;
    private const int MaxEntries = 10000;
    private const int MaxBlockingItems = 20;
    private const int MaxProcessAssociations = 8;
    private const int TimeLimitMilliseconds = 2000;
    private const uint DeleteAccess = 0x00010000;
    private const uint FileShareAll = 0x00000007;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint ProcessVmRead = 0x0010;
    private const uint ProcessQueryInformation = 0x0400;
    private const uint MemMapped = 0x00040000;
    private const uint MemImage = 0x01000000;

    internal static RecycleLockDiagnosis Diagnose(string targetPath)
    {
      var state = new DiagnosticState(targetPath);
      try
      {
        ScanTarget(state);
        if (!state.Expired && state.Files.Count > 0)
        {
          var processes = RestartManager.Query(state.Files);
          if (!processes.Succeeded)
          {
            state.Incomplete("Restart Manager returned error " + processes.Error + ".");
          }
          else
          {
            ScanMappedFiles(state, processes.Processes);
          }
        }
        AssociateOrdinaryHandles(state);
      }
      catch (Exception exception)
      {
        state.Incomplete(exception.GetBaseException().Message);
      }
      return state.Result();
    }

    private static void ScanTarget(DiagnosticState state)
    {
      var pending = new Stack<string>();
      pending.Push(state.TargetPath);

      while (pending.Count > 0)
      {
        if (state.CheckLimits(pending.Count > 0)) return;
        var path = pending.Pop();
        FileAttributes attributes;
        try
        {
          attributes = File.GetAttributes(path);
        }
        catch (Exception exception)
        {
          state.Skip(path, exception);
          continue;
        }

        state.ScannedEntries++;
        var directory = (attributes & FileAttributes.Directory) != 0;
        var probeError = ProbeDeleteAccess(path);
        if (probeError == ErrorSharingViolation) state.Add(path, "delete-sharing-violation", null);
        else if (probeError != 0 && probeError != ErrorAccessDenied) state.Skip(path, "CreateFile returned error " + probeError + ".");
        else if (probeError == ErrorAccessDenied) state.Skip(path, "Delete access was denied.");

        if (!directory)
        {
          state.Files.Add(path);
          state.FilePaths[Normalize(path)] = path;
          continue;
        }
        if ((attributes & FileAttributes.ReparsePoint) != 0) continue;

        try
        {
          foreach (var entry in new DirectoryInfo(path).EnumerateFileSystemInfos()) pending.Push(entry.FullName);
        }
        catch (Exception exception)
        {
          state.Skip(path, exception);
        }
      }
    }

    private static int ProbeDeleteAccess(string path)
    {
      using (var handle = NativeMethods.CreateFile(
          path,
          DeleteAccess,
          FileShareAll,
          IntPtr.Zero,
          OpenExisting,
          FileFlagBackupSemantics | FileFlagOpenReparsePoint,
          IntPtr.Zero))
      {
        return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
      }
    }

    private static void ScanMappedFiles(DiagnosticState state, RestartManagerProcess[] processes)
    {
      var drives = DevicePaths.GetDriveMappings();
      foreach (var process in processes.Concat(new[] { CurrentProcess() }).GroupBy(item => item.ProcessId).Select(group => group.First()))
      {
        if (state.CheckLimits(false)) return;
        using (var handle = NativeMethods.OpenProcess(ProcessQueryInformation | ProcessVmRead, false, process.ProcessId))
        {
          if (handle.IsInvalid || !MatchesStartTime(handle, process.StartTime))
          {
            state.InaccessibleProcessIds.Add(process.ProcessId);
            state.Incomplete("Process " + process.ProcessId + " could not be inspected.");
            continue;
          }
          ScanProcessMappings(state, handle, process, drives);
        }
      }
    }

    private static RestartManagerProcess CurrentProcess()
    {
      using (var process = Process.GetCurrentProcess())
      {
        var started = process.StartTime.ToUniversalTime().ToFileTimeUtc();
        return new RestartManagerProcess
        {
          ProcessId = process.Id,
          StartTime = new FILETIME
          {
            dwLowDateTime = unchecked((int)started),
            dwHighDateTime = unchecked((int)(started >> 32)),
          },
          Name = process.ProcessName,
        };
      }
    }

    private static bool MatchesStartTime(SafeProcessHandle handle, FILETIME expected)
    {
      if (!NativeMethods.GetProcessTimes(handle, out var created, out _, out _, out _)) return false;
      return FileTime(created) == FileTime(expected);
    }

    private static long FileTime(FILETIME value) => ((long)value.dwHighDateTime << 32) | (uint)value.dwLowDateTime;

    private static void ScanProcessMappings(
        DiagnosticState state,
        SafeProcessHandle handle,
        RestartManagerProcess process,
        KeyValuePair<string, string>[] drives)
    {
      var allocations = new HashSet<IntPtr>();
      ulong address = 0;
      while (!state.Expired)
      {
        var queried = NativeMethods.VirtualQueryEx(
            handle,
            new IntPtr(unchecked((long)address)),
            out var information,
            new UIntPtr(unchecked((uint)Marshal.SizeOf(typeof(MemoryBasicInformation)))));
        if (queried == UIntPtr.Zero) return;

        var start = unchecked((ulong)information.BaseAddress.ToInt64());
        var next = start + information.RegionSize.ToUInt64();
        if (next <= address || next > long.MaxValue) return;
        address = next;

        if ((information.Type != MemImage && information.Type != MemMapped) ||
            information.AllocationBase == IntPtr.Zero ||
            !allocations.Add(information.AllocationBase)) continue;

        var buffer = new StringBuilder(32768);
        var length = NativeMethods.GetMappedFileName(handle, information.AllocationBase, buffer, buffer.Capacity);
        if (length == 0 || length >= buffer.Capacity) continue;
        var mappedPath = DevicePaths.ToDosPath(buffer.ToString(), drives);
        if (mappedPath == null || !state.TryTargetPath(mappedPath, out var targetPath)) continue;
        state.Add(
            targetPath,
            information.Type == MemImage ? "mapped-image" : "mapped-file",
            new RecycleBlockingProcess
            {
              ProcessId = process.ProcessId,
              Name = process.Name,
              ServiceName = string.IsNullOrEmpty(process.ServiceName) ? null : process.ServiceName,
            });
      }
      state.Timeout();
    }

    private static void AssociateOrdinaryHandles(DiagnosticState state)
    {
      var candidates = state.Items.Values
          .Where(item => item.Kind == "delete-sharing-violation" && item.Processes.Count == 0 && File.Exists(item.Path))
          .ToArray();
      if (candidates.Length > MaxProcessAssociations)
      {
        state.Incomplete("Process attribution stopped after " + MaxProcessAssociations + " blocking items.");
      }
      foreach (var item in candidates.Take(MaxProcessAssociations))
      {
        if (state.CheckLimits(false)) return;
        var query = RestartManager.Query(new[] { item.Path });
        if (!query.Succeeded)
        {
          state.Incomplete("Restart Manager returned error " + query.Error + " for " + item.Path + ".");
          continue;
        }
        foreach (var process in query.Processes)
        {
          item.AddProcess(new RecycleBlockingProcess
          {
            ProcessId = process.ProcessId,
            Name = process.Name,
            ServiceName = string.IsNullOrEmpty(process.ServiceName) ? null : process.ServiceName,
          });
        }
      }
    }

    private static string Normalize(string path)
    {
      var value = path;
      if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value.Substring(8);
      else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value.Substring(4);
      var fullPath = Path.GetFullPath(value);
      var root = Path.GetPathRoot(fullPath);
      return string.Equals(fullPath, root, StringComparison.OrdinalIgnoreCase)
          ? fullPath
          : fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private sealed class DiagnosticState
    {
      private readonly Stopwatch stopwatch = Stopwatch.StartNew();
      private readonly List<string> issues = new List<string>();

      internal DiagnosticState(string targetPath)
      {
        TargetPath = Normalize(targetPath);
        TargetIsDirectory = Directory.Exists(TargetPath);
      }

      internal string TargetPath { get; }
      internal bool TargetIsDirectory { get; }
      internal List<string> Files { get; } = new List<string>();
      internal Dictionary<string, string> FilePaths { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      internal Dictionary<string, MutableBlockingItem> Items { get; } = new Dictionary<string, MutableBlockingItem>(StringComparer.OrdinalIgnoreCase);
      internal HashSet<int> InaccessibleProcessIds { get; } = new HashSet<int>();
      internal int ScannedEntries { get; set; }
      internal int SkippedEntries { get; private set; }
      internal bool Complete { get; private set; } = true;
      internal bool TimedOut { get; private set; }
      internal bool Truncated { get; private set; }
      internal bool Expired => stopwatch.ElapsedMilliseconds >= TimeLimitMilliseconds;

      internal bool CheckLimits(bool moreEntries)
      {
        if (Expired)
        {
          Timeout();
          return true;
        }
        if (ScannedEntries < MaxEntries || !moreEntries) return false;
        Truncated = true;
        Complete = false;
        AddIssue("Lock diagnosis stopped after " + MaxEntries + " filesystem entries.");
        return true;
      }

      internal void Timeout()
      {
        TimedOut = true;
        Complete = false;
        AddIssue("Lock diagnosis exceeded " + TimeLimitMilliseconds + " milliseconds.");
      }

      internal void Skip(string path, Exception exception) => Skip(path, exception.GetBaseException().Message);

      internal void Skip(string path, string reason)
      {
        SkippedEntries++;
        Complete = false;
        AddIssue(path + ": " + reason);
      }

      internal void Incomplete(string issue)
      {
        Complete = false;
        AddIssue(issue);
      }

      internal void Add(string path, string kind, RecycleBlockingProcess? process)
      {
        var normalized = Normalize(path);
        if (!Items.TryGetValue(normalized, out var item))
        {
          if (Items.Count >= MaxBlockingItems)
          {
            Truncated = true;
            Complete = false;
            AddIssue("Additional blocking items were omitted after " + MaxBlockingItems + " results.");
            return;
          }
          item = new MutableBlockingItem(path, kind);
          Items.Add(normalized, item);
        }
        if (kind == "mapped-image" || (kind == "mapped-file" && item.Kind == "delete-sharing-violation")) item.Kind = kind;
        if (process != null) item.AddProcess(process);
      }

      internal bool TryTargetPath(string path, out string targetPath)
      {
        var normalized = Normalize(path);
        if (FilePaths.TryGetValue(normalized, out var knownPath))
        {
          targetPath = knownPath;
          return true;
        }
        var prefix = TargetPath.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
            ? TargetPath
            : TargetPath + Path.DirectorySeparatorChar;
        if (!TargetIsDirectory || !normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
          targetPath = string.Empty;
          return false;
        }
        targetPath = path;
        return true;
      }

      internal RecycleLockDiagnosis Result()
      {
        if (Expired && !TimedOut) Timeout();
        return new RecycleLockDiagnosis
        {
          Complete = Complete,
          ScannedEntries = ScannedEntries,
          SkippedEntries = SkippedEntries,
          TimedOut = TimedOut,
          Truncated = Truncated,
          InaccessibleProcessIds = InaccessibleProcessIds.OrderBy(value => value).ToArray(),
          Issues = issues.ToArray(),
          BlockingItems = Items.Values.OrderBy(item => item.Path, StringComparer.OrdinalIgnoreCase).Select(item => item.Result()).ToArray(),
        };
      }

      private void AddIssue(string issue)
      {
        if (issues.Count < MaxBlockingItems && !issues.Contains(issue)) issues.Add(issue);
      }
    }

    private sealed class MutableBlockingItem
    {
      private readonly Dictionary<int, RecycleBlockingProcess> processes = new Dictionary<int, RecycleBlockingProcess>();

      internal MutableBlockingItem(string path, string kind)
      {
        Path = path;
        Kind = kind;
      }

      internal string Path { get; }
      internal string Kind { get; set; }
      internal IReadOnlyCollection<RecycleBlockingProcess> Processes => processes.Values;

      internal void AddProcess(RecycleBlockingProcess process) => processes[process.ProcessId] = process;

      internal RecycleBlockingItem Result() => new RecycleBlockingItem
      {
        Path = Path,
        Kind = Kind,
        Processes = processes.Values.OrderBy(process => process.ProcessId).ToArray(),
      };
    }

    private sealed class RestartManagerResult
    {
      internal bool Succeeded { get; set; }
      internal int Error { get; set; }
      internal RestartManagerProcess[] Processes { get; set; } = Array.Empty<RestartManagerProcess>();
    }

    private sealed class RestartManagerProcess
    {
      internal int ProcessId { get; set; }
      internal FILETIME StartTime { get; set; }
      internal string Name { get; set; } = string.Empty;
      internal string ServiceName { get; set; } = string.Empty;
    }

    private static class RestartManager
    {
      internal static RestartManagerResult Query(IEnumerable<string> files)
      {
        var resources = files.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (resources.Length == 0) return new RestartManagerResult { Succeeded = true };

        var key = new StringBuilder(33);
        var error = NativeMethods.RmStartSession(out var session, 0, key);
        if (error != 0) return new RestartManagerResult { Error = error };
        try
        {
          error = NativeMethods.RmRegisterResources(session, (uint)resources.Length, resources, 0, IntPtr.Zero, 0, IntPtr.Zero);
          if (error != 0) return new RestartManagerResult { Error = error };

          uint needed;
          uint count = 0;
          uint reasons = 0;
          error = NativeMethods.RmGetList(session, out needed, ref count, null, ref reasons);
          if (error == 0) return new RestartManagerResult { Succeeded = true };
          if (error != ErrorMoreData) return new RestartManagerResult { Error = error };

          for (var attempt = 0; attempt < 2; attempt++)
          {
            var information = new RmProcessInfo[checked((int)needed)];
            count = needed;
            error = NativeMethods.RmGetList(session, out needed, ref count, information, ref reasons);
            if (error == ErrorMoreData) continue;
            if (error != 0) return new RestartManagerResult { Error = error };
            return new RestartManagerResult
            {
              Succeeded = true,
              Processes = information.Take((int)count).Select(item => new RestartManagerProcess
              {
                ProcessId = item.Process.ProcessId,
                StartTime = item.Process.ProcessStartTime,
                Name = item.ApplicationName ?? string.Empty,
                ServiceName = item.ServiceShortName ?? string.Empty,
              }).ToArray(),
            };
          }
          return new RestartManagerResult { Error = ErrorMoreData };
        }
        finally
        {
          NativeMethods.RmEndSession(session);
        }
      }
    }

    private static class DevicePaths
    {
      internal static KeyValuePair<string, string>[] GetDriveMappings()
      {
        var targets = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in Environment.GetLogicalDrives())
        {
          var drive = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
          var buffer = new StringBuilder(32768);
          if (NativeMethods.QueryDosDevice(drive, buffer, buffer.Capacity) != 0) targets[drive] = buffer.ToString();
        }

        var result = new List<KeyValuePair<string, string>>();
        foreach (var target in targets)
        {
          result.Add(new KeyValuePair<string, string>(ResolveTarget(target.Value, targets, 0), target.Key));
        }
        return result.OrderByDescending(item => item.Key.Length).ToArray();
      }

      private static string ResolveTarget(string target, Dictionary<string, string> targets, int depth)
      {
        const string dosDevices = @"\??\";
        if (depth >= 8 || !target.StartsWith(dosDevices, StringComparison.OrdinalIgnoreCase) || target.Length < 6 || target[5] != ':') return target;
        var drive = target.Substring(4, 2);
        return targets.TryGetValue(drive, out var next)
            ? ResolveTarget(next, targets, depth + 1) + target.Substring(6)
            : target;
      }

      internal static string? ToDosPath(string devicePath, KeyValuePair<string, string>[] drives)
      {
        foreach (var drive in drives)
        {
          if (devicePath.Equals(drive.Key, StringComparison.OrdinalIgnoreCase)) return drive.Value + Path.DirectorySeparatorChar;
          if (devicePath.StartsWith(drive.Key + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
          {
            return drive.Value + devicePath.Substring(drive.Key.Length);
          }
        }
        const string mup = @"\Device\Mup\";
        if (devicePath.StartsWith(mup, StringComparison.OrdinalIgnoreCase)) return @"\\" + devicePath.Substring(mup.Length);
        return null;
      }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryBasicInformation
    {
      internal IntPtr BaseAddress;
      internal IntPtr AllocationBase;
      internal uint AllocationProtect;
      internal UIntPtr RegionSize;
      internal uint State;
      internal uint Protect;
      internal uint Type;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RmUniqueProcess
    {
      internal int ProcessId;
      internal FILETIME ProcessStartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct RmProcessInfo
    {
      internal RmUniqueProcess Process;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] internal string? ApplicationName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] internal string? ServiceShortName;
      internal uint ApplicationType;
      internal uint ApplicationStatus;
      internal uint TerminalServicesSessionId;
      [MarshalAs(UnmanagedType.Bool)] internal bool Restartable;
    }

    private sealed class SafeProcessHandle : SafeHandle
    {
      private SafeProcessHandle() : base(IntPtr.Zero, true) { }
      public override bool IsInvalid => handle == IntPtr.Zero || handle == new IntPtr(-1);
      protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
    }

    private static class NativeMethods
    {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      internal static extern SafeFileHandle CreateFile(
          string fileName,
          uint desiredAccess,
          uint shareMode,
          IntPtr securityAttributes,
          uint creationDisposition,
          uint flagsAndAttributes,
          IntPtr templateFile);

      [DllImport("kernel32.dll", SetLastError = true)]
      internal static extern SafeProcessHandle OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

      [DllImport("kernel32.dll", SetLastError = true)]
      [return: MarshalAs(UnmanagedType.Bool)]
      internal static extern bool GetProcessTimes(
          SafeProcessHandle process,
          out FILETIME creationTime,
          out FILETIME exitTime,
          out FILETIME kernelTime,
          out FILETIME userTime);

      [DllImport("kernel32.dll", SetLastError = true)]
      [return: MarshalAs(UnmanagedType.Bool)]
      internal static extern bool CloseHandle(IntPtr handle);

      [DllImport("kernel32.dll", SetLastError = true)]
      internal static extern UIntPtr VirtualQueryEx(
          SafeProcessHandle process,
          IntPtr address,
          out MemoryBasicInformation buffer,
          UIntPtr length);

      [DllImport("psapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      internal static extern int GetMappedFileName(SafeProcessHandle process, IntPtr address, StringBuilder fileName, int size);

      [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
      internal static extern uint QueryDosDevice(string deviceName, StringBuilder targetPath, int maxLength);

      [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
      internal static extern int RmStartSession(out uint sessionHandle, int sessionFlags, StringBuilder sessionKey);

      [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
      internal static extern int RmRegisterResources(
          uint sessionHandle,
          uint fileCount,
          string[] fileNames,
          uint applicationCount,
          IntPtr applications,
          uint serviceCount,
          IntPtr serviceNames);

      [DllImport("rstrtmgr.dll")]
      internal static extern int RmGetList(
          uint sessionHandle,
          out uint processInfoNeeded,
          ref uint processInfo,
          [In, Out] RmProcessInfo[]? affectedApplications,
          ref uint rebootReasons);

      [DllImport("rstrtmgr.dll")]
      internal static extern int RmEndSession(uint sessionHandle);
    }
  }
}
