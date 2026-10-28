# Windows process ownership: create atomically inside a kill-on-close Job,
# then resume. Descendants remain in the Job even after intermediate parents exit.
$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:STARTER_PROCESS_SPEC)) | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('STARTER_PROCESS_SPEC', $null)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StarterJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup StartupInfo;
    public IntPtr AttributeList;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", ExactSpelling=true)] static extern void SetLastError(uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting accounting, uint size, IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CreateEventW(IntPtr a, bool manual, bool initial, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr OpenEventW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEvent(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimit limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, System.Text.StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Guard(string name, uint parentPid) {
    SetLastError(0);
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    int createdJobError = Marshal.GetLastWin32Error();
    Check(job != IntPtr.Zero);
    IntPtr ready = IntPtr.Zero, parent = IntPtr.Zero;
    try {
      if (createdJobError == 183) throw new InvalidOperationException("Owned Job name already exists");
      ExtendedLimit limits = new ExtendedLimit();
      limits.BasicLimitInformation.LimitFlags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
      parent = OpenProcess(0x100000, false, parentPid);
      Check(parent != IntPtr.Zero);
      SetLastError(0);
      ready = CreateEventW(IntPtr.Zero, true, false, name + "-ready");
      int createdEventError = Marshal.GetLastWin32Error();
      Check(ready != IntPtr.Zero);
      if (createdEventError == 183) throw new InvalidOperationException("Owned Job event name already exists");
      Check(SetEvent(ready));
      var stop = System.Threading.Tasks.Task.Run(() => Console.ReadLine());
      while (!stop.IsCompleted && WaitForSingleObject(parent, 0) == 258)
        System.Threading.Thread.Sleep(25);
      if (stop.IsCompleted && stop.Result != "STOP" && stop.Result != null)
        throw new InvalidOperationException("Invalid owned Job control message");
      Check(TerminateJobObject(job, 1));
      var deadline = System.Diagnostics.Stopwatch.StartNew();
      while (true) {
        Accounting accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.ActiveProcesses == 0) break;
        if (deadline.ElapsedMilliseconds >= 10000)
          throw new TimeoutException("Owned Windows Job processes did not terminate");
        System.Threading.Thread.Sleep(25);
      }
      Console.WriteLine("STOPPED");
      return 0;
    } finally {
      if (ready != IntPtr.Zero) CloseHandle(ready);
      if (parent != IntPtr.Zero) CloseHandle(parent);
      CloseHandle(job);
    }
  }
  public static int Run(string command, string name) {
    IntPtr job = IntPtr.Zero, ready = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero;
    bool initialized = false;
    try {
      var deadline = System.Diagnostics.Stopwatch.StartNew();
      while (ready == IntPtr.Zero && deadline.ElapsedMilliseconds < 10000) {
        ready = OpenEventW(0x100000, false, name + "-ready");
        if (ready == IntPtr.Zero) System.Threading.Thread.Sleep(25);
      }
      Check(ready != IntPtr.Zero);
      Check(WaitForSingleObject(ready, 10000) == 0);
      job = OpenJobObjectW(0x0001, false, name);
      Check(job != IntPtr.Zero);
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      Check(size != IntPtr.Zero);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
      initialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: membership is atomic with creation.
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      StartupEx startup = new StartupEx();
      startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
      startup.StartupInfo.hStdInput = GetStdHandle(-10);
      startup.StartupInfo.hStdOutput = GetStdHandle(-11);
      startup.StartupInfo.hStdError = GetStdHandle(-12);
      startup.AttributeList = attributes;
      Check(CreateProcessW(null, new System.Text.StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x80004, IntPtr.Zero, null, ref startup, out process));
      Check(ResumeThread(process.hThread) != 0xffffffff);
      Check(WaitForSingleObject(process.hProcess, 0xffffffff) == 0);
      uint code;
      Check(GetExitCodeProcess(process.hProcess, out code));
      return unchecked((int)code);
    } finally {
      // All created children already belong to the Job, including before resume.
      if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (ready != IntPtr.Zero) CloseHandle(ready);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
    }
  }
}
'@
if ($spec.role -eq 'guard') {
  exit ([StarterJob]::Guard($spec.jobName, $spec.parentPid))
}
exit ([StarterJob]::Run($spec.commandLine, $spec.jobName))
