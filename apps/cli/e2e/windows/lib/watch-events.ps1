# Event sources for window-watch.ps1 (dot-source this file). Nothing here
# polls:
#
#   processes  WMI Win32_ProcessStartTrace / Win32_ProcessStopTrace, backed by
#              the kernel's process trace, so every start is delivered however
#              short-lived the process, with its pid, parent pid and image
#              name. WMI hands them over in batches about a second apart, so
#              the command line (read on the event thread with
#              NtQueryInformationProcess) is only there for processes that
#              are still running by then. Needs an administrator token, which
#              the hosted runners have.
#   windows    SetWinEventHook (out of context) for EVENT_OBJECT_SHOW,
#              EVENT_OBJECT_UNCLOAKED and EVENT_SYSTEM_FOREGROUND, on a thread
#              that pumps messages. Each window is described in the callback,
#              before it can close.
#
# Both queue events that the watcher drains. Timestamps are seconds since
# Start() at delivery: exact for windows, up to a second late for processes.
if (-not ("TmxE2EWatch" -as [type])) {
  Add-Type -AssemblyName System.Management
  # Naming any reference drops Add-Type's defaults, so list them all.
  $references = @(
    "System.Collections", "System.Collections.Concurrent", "System.ComponentModel.Primitives",
    "System.Runtime.InteropServices", "System.Threading", "System.Threading.Thread",
    [System.Management.ManagementEventWatcher].Assembly.Location
  )
  Add-Type -ReferencedAssemblies $references -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class TmxE2EWatchEvent {
  public double T; public string Kind; public string Source;
  // process-start / process-stop
  public uint Pid; public uint Ppid; public string Name; public uint SessionId; public string CommandLine; public string CommandLineError; public uint? ExitCode;
  // window-show / window-uncloaked / foreground
  public long Hwnd; public string Class; public string Title; public string Rect; public bool Visible; public bool Iconic; public bool Cloaked; public string Process;
}

public static class TmxE2EWatch {
  delegate void WinEventProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);

  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint EVENT_OBJECT_UNCLOAKED = 0x8018;
  const uint WINEVENT_OUTOFCONTEXT = 0x0000;
  const uint GA_ROOT = 2;
  const uint WM_QUIT = 0x0012;
  const uint WM_CLOSE = 0x0010;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int ProcessCommandLineInformation = 60;

  public static readonly ConcurrentQueue<TmxE2EWatchEvent> Events = new ConcurrentQueue<TmxE2EWatchEvent>();
  static DateTime startedUtc;
  static ManagementEventWatcher startWatcher, stopWatcher;
  static Thread hookThread;
  static uint hookThreadId;
  static WinEventProc hookProc;
  static readonly ManualResetEvent hookReady = new ManualResetEvent(false);
  public static string ProcessSource = "not started";
  public static string WindowSource = "not started";
  public static long SelfTestHwnd;

  static double Now() { return Math.Round((DateTime.UtcNow - startedUtc).TotalSeconds, 3); }

  public static void Start(int hookTimeoutMs) {
    startedUtc = DateTime.UtcNow;
    try {
      var scope = new ManagementScope(@"\\.\root\cimv2");
      scope.Connect();
      startWatcher = new ManagementEventWatcher(scope, new WqlEventQuery("SELECT * FROM Win32_ProcessStartTrace"));
      startWatcher.EventArrived += OnProcessStart;
      startWatcher.Start();
      stopWatcher = new ManagementEventWatcher(scope, new WqlEventQuery("SELECT * FROM Win32_ProcessStopTrace"));
      stopWatcher.EventArrived += OnProcessStop;
      stopWatcher.Start();
      ProcessSource = "Win32_ProcessStartTrace";
    } catch (Exception e) {
      ProcessSource = "error: " + e.GetType().Name + ": " + e.Message;
    }

    hookThread = new Thread(HookLoop);
    hookThread.IsBackground = true;
    hookThread.SetApartmentState(ApartmentState.STA);
    hookThread.Start();
    if (!hookReady.WaitOne(hookTimeoutMs)) WindowSource = "error: hook thread did not start";
  }

  public static void Stop() {
    try { if (startWatcher != null) startWatcher.Stop(); } catch { }
    try { if (stopWatcher != null) stopWatcher.Stop(); } catch { }
    if (hookThreadId != 0) PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    if (hookThread != null) hookThread.Join(3000);
  }

  static void OnProcessStart(object sender, EventArrivedEventArgs args) {
    var e = args.NewEvent;
    var ev = new TmxE2EWatchEvent { Kind = "process-start", Source = "Win32_ProcessStartTrace", T = Now() };
    ev.Pid = Convert.ToUInt32(e["ProcessID"]);
    ev.Ppid = Convert.ToUInt32(e["ParentProcessID"]);
    ev.SessionId = Convert.ToUInt32(e["SessionID"]);
    ev.Name = (string)e["ProcessName"];
    string error;
    ev.CommandLine = CommandLine(ev.Pid, out error);
    ev.CommandLineError = error;
    Events.Enqueue(ev);
  }

  static void OnProcessStop(object sender, EventArrivedEventArgs args) {
    var e = args.NewEvent;
    var ev = new TmxE2EWatchEvent { Kind = "process-stop", Source = "Win32_ProcessStopTrace", T = Now() };
    ev.Pid = Convert.ToUInt32(e["ProcessID"]);
    ev.Ppid = Convert.ToUInt32(e["ParentProcessID"]);
    ev.SessionId = Convert.ToUInt32(e["SessionID"]);
    ev.Name = (string)e["ProcessName"];
    ev.ExitCode = Convert.ToUInt32(e["ExitStatus"]);
    Events.Enqueue(ev);
  }

  public static string CommandLine(uint pid, out string error) {
    error = null;
    var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) { error = "OpenProcess failed: " + Marshal.GetLastWin32Error(); return null; }
    try {
      int size = 0;
      NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out size);
      if (size <= 0) { error = "no command line (process gone?)"; return null; }
      var buffer = Marshal.AllocHGlobal(size);
      try {
        int status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, size, out size);
        if (status != 0) { error = "NtQueryInformationProcess 0x" + status.ToString("X8"); return null; }
        // UNICODE_STRING { ushort Length; ushort MaximumLength; PWSTR Buffer }
        int length = Marshal.ReadInt16(buffer);
        var text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
        return length == 0 ? "" : Marshal.PtrToStringUni(text, length / 2);
      } finally { Marshal.FreeHGlobal(buffer); }
    } finally { CloseHandle(handle); }
  }

  // Null once the process is gone: the watcher then names it from the process
  // trace, which may not have delivered its start yet.
  static string ProcessName(uint pid) {
    var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      var sb = new StringBuilder(1024); int size = sb.Capacity;
      if (!QueryFullProcessImageName(handle, 0, sb, ref size)) return null;
      var path = sb.ToString();
      return path.Substring(path.LastIndexOf('\\') + 1);
    } finally { CloseHandle(handle); }
  }

  // Closes the self-test window once the hook has reported it.
  public static void EndSelfTest() {
    if (SelfTestHwnd != 0) PostMessage(new IntPtr(SelfTestHwnd), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
  }

  static void HookLoop() {
    hookThreadId = GetCurrentThreadId();
    hookProc = OnWinEvent;
    var show = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
    var uncloaked = SetWinEventHook(EVENT_OBJECT_UNCLOAKED, EVENT_OBJECT_UNCLOAKED, IntPtr.Zero, hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
    var foreground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (show == IntPtr.Zero || uncloaked == IntPtr.Zero || foreground == IntPtr.Zero) {
      WindowSource = "error: SetWinEventHook failed";
    } else {
      WindowSource = "SetWinEventHook";
      // Self-test: show a tiny, never-activated window of our own; its
      // EVENT_OBJECT_SHOW proves the hook is live (the watcher waits for it).
      // WS_POPUP, WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, SW_SHOWNOACTIVATE.
      var probe = CreateWindowEx(0x00000080 | 0x08000000, "STATIC", "tmx-e2e-watch-self-test", 0x80000000, -200, -200, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      SelfTestHwnd = probe.ToInt64();
      if (probe != IntPtr.Zero) { ShowWindow(probe, 4); }
    }
    hookReady.Set();
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    if (SelfTestHwnd != 0) DestroyWindow(new IntPtr(SelfTestHwnd));
    UnhookWinEvent(show); UnhookWinEvent(uncloaked); UnhookWinEvent(foreground);
  }

  static void OnWinEvent(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (hwnd == IntPtr.Zero) return;
    if (evt != EVENT_SYSTEM_FOREGROUND) {
      // Only whole top-level windows: not carets, cursors or child controls.
      if (idObject != 0 || idChild != 0 || GetAncestor(hwnd, GA_ROOT) != hwnd) return;
    }
    var ev = Describe(hwnd);
    ev.T = Now();
    ev.Kind = evt == EVENT_SYSTEM_FOREGROUND ? "foreground" : evt == EVENT_OBJECT_SHOW ? "window-show" : "window-uncloaked";
    ev.Source = "SetWinEventHook";
    Events.Enqueue(ev);
  }

  static TmxE2EWatchEvent Describe(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    var title = new StringBuilder(512); GetWindowText(h, title, 512);
    RECT r; GetWindowRect(h, out r);
    int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
    return new TmxE2EWatchEvent { Hwnd = h.ToInt64(), Pid = pid, Process = pid == 0 ? null : ProcessName(pid),
      Class = cls.ToString(), Title = title.ToString(), Rect = r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom,
      Visible = IsWindowVisible(h), Iconic = IsIconic(h), Cloaked = cloaked != 0 };
  }

  public static List<TmxE2EWatchEvent> Drain() {
    var list = new List<TmxE2EWatchEvent>();
    TmxE2EWatchEvent ev;
    while (Events.TryDequeue(out ev)) list.Add(ev);
    return list;
  }
}
"@
}
