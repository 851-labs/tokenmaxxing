# Win32 helpers for the session probe and the window watcher (dot-source this file).
if (-not ("TmxE2EWin32" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class TmxE2EWin32 {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  public class Win {
    public long Hwnd; public uint Pid; public string Class; public string Title; public string Rect;
    public bool Visible; public bool Iconic; public bool Cloaked;
  }

  public static Win Describe(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    var title = new StringBuilder(512); GetWindowText(h, title, 512);
    RECT r; GetWindowRect(h, out r);
    int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
    return new Win { Hwnd = h.ToInt64(), Pid = pid, Class = cls.ToString(), Title = title.ToString(),
      Rect = r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom,
      Visible = IsWindowVisible(h), Iconic = IsIconic(h), Cloaked = cloaked != 0 };
  }

  public static List<Win> VisibleWindows() {
    var list = new List<Win>();
    EnumWindows(delegate (IntPtr h, IntPtr l) { if (IsWindowVisible(h)) list.Add(Describe(h)); return true; }, IntPtr.Zero);
    return list;
  }

  public static Win Foreground() {
    var h = GetForegroundWindow();
    return h == IntPtr.Zero ? null : Describe(h);
  }

  static string ObjectName(IntPtr obj) {
    if (obj == IntPtr.Zero) return null;
    var sb = new StringBuilder(256); int needed;
    return GetUserObjectInformation(obj, 2, sb, 512, out needed) ? sb.ToString() : null;
  }
  public static string WindowStationName() { return ObjectName(GetProcessWindowStation()); }
  public static string DesktopName() { return ObjectName(GetThreadDesktop(GetCurrentThreadId())); }
  public static string InputDesktopName() { return ObjectName(OpenInputDesktop(0, false, 0x0001)); }
}
"@
}

function Get-WindowInfo($Window) {
  if ($null -eq $Window) { return $null }
  $proc = if ($Window.Pid -ne 0) { Get-Process -Id $Window.Pid -ErrorAction SilentlyContinue } else { $null }
  [ordered]@{
    hwnd = ('0x{0:X}' -f $Window.Hwnd)
    pid = [int]$Window.Pid
    process = if ($proc) { $proc.ProcessName } else { $null }
    sessionId = if ($proc) { $proc.SessionId } else { $null }
    class = $Window.Class
    title = $Window.Title
    rect = $Window.Rect
    iconic = $Window.Iconic
    cloaked = $Window.Cloaked
  }
}

function Save-Screenshot([string]$Path) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bmp.Dispose()
    "ok $($bounds.Width)x$($bounds.Height)"
  } catch {
    "failed: $($_.Exception.Message)"
  }
}
