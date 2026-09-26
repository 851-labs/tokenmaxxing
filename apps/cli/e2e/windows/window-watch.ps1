# Polls (~200 ms) for new visible top-level windows, foreground changes and
# the processes a scheduled-task run starts. service-e2e.ps1 starts one
# hidden watcher per task run.
#
#   window-watch.ps1 -OutDir <dir> -Label <name> -StopFile <path> [-MaxSeconds 240]
#
# Writes <Label>.ready once the baseline is captured, <Label>-events.jsonl
# while running and <Label>-summary.json on exit, plus screenshots at the
# start, after 2.5 s and when a new window appears.
param(
  [Parameter(Mandatory)] [string]$OutDir,
  [Parameter(Mandatory)] [string]$Label,
  [Parameter(Mandatory)] [string]$StopFile,
  [int]$MaxSeconds = 240
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\win32.ps1")

$events = Join-Path $OutDir "$Label-events.jsonl"
function Emit($Event) { ($Event | ConvertTo-Json -Compress -Depth 6) | Add-Content -LiteralPath $events -Encoding utf8 }

$watchNames = @("cmd", "conhost", "OpenConsole", "WindowsTerminal", "tokenmaxxing", "wscript", "cscript", "bun", "node", "timeout")
$started = Get-Date
$baseline = @{}
foreach ($window in [TmxE2EWin32]::VisibleWindows()) { $baseline[$window.Hwnd] = $true }
$lastForeground = [TmxE2EWin32]::Foreground()
$lastForegroundHwnd = if ($lastForeground) { $lastForeground.Hwnd } else { 0 }
$screenshots = [ordered]@{ start = Save-Screenshot (Join-Path $OutDir "$Label-start.png") }
Emit ([ordered]@{ t = 0; kind = "baseline"; visibleWindows = $baseline.Count; foreground = (Get-WindowInfo $lastForeground) })
Set-Content -LiteralPath (Join-Path $OutDir "$Label.ready") -Value "ready"

$newWindows = [ordered]@{}
$foregroundChanges = New-Object System.Collections.ArrayList
$processes = New-Object System.Collections.ArrayList
$seenPids = @{}
$polls = 0
$windowShots = 0
$tookLateShot = $false

while (-not (Test-Path -LiteralPath $StopFile)) {
  $elapsed = ((Get-Date) - $started).TotalSeconds
  if ($elapsed -gt $MaxSeconds) { break }
  $polls++
  $t = [math]::Round($elapsed, 2)

  foreach ($window in [TmxE2EWin32]::VisibleWindows()) {
    if ($baseline.ContainsKey($window.Hwnd)) { continue }
    $key = '0x{0:X}' -f $window.Hwnd
    if ($newWindows.Contains($key)) { $newWindows[$key]["lastSeen"] = $t; continue }
    $info = Get-WindowInfo $window
    $info["firstSeen"] = $t
    $info["lastSeen"] = $t
    $newWindows[$key] = $info
    Emit ([ordered]@{ t = $t; kind = "new-visible-window"; window = $info })
    if ($windowShots -lt 3 -and -not $window.Cloaked) {
      $windowShots++
      Start-Sleep -Milliseconds 150
      $screenshots["window-$windowShots"] = Save-Screenshot (Join-Path $OutDir "$Label-window-$windowShots.png")
    }
  }

  # Describe the new foreground window right away: a window that flashes and
  # closes may be gone by the next poll.
  $foreground = [TmxE2EWin32]::Foreground()
  $foregroundHwnd = if ($foreground) { $foreground.Hwnd } else { 0 }
  if ($foregroundHwnd -ne $lastForegroundHwnd) {
    $change = [ordered]@{ t = $t; window = (Get-WindowInfo $foreground) }
    [void]$foregroundChanges.Add($change)
    Emit ([ordered]@{ t = $t; kind = "foreground-changed"; change = $change })
    $lastForegroundHwnd = $foregroundHwnd
  }

  if ($polls % 3 -eq 1) {
    $filter = ($watchNames | ForEach-Object { "Name='$_.exe'" }) -join " OR "
    foreach ($process in (Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue)) {
      if ($seenPids.ContainsKey($process.ProcessId) -or $process.ProcessId -eq $PID) { continue }
      $seenPids[$process.ProcessId] = $true
      $entry = [ordered]@{ t = $t; pid = $process.ProcessId; ppid = $process.ParentProcessId; name = $process.Name; sessionId = $process.SessionId; commandLine = $process.CommandLine }
      [void]$processes.Add($entry)
      Emit ([ordered]@{ t = $t; kind = "process"; process = $entry })
    }
  }

  if (-not $tookLateShot -and $elapsed -ge 2.5) {
    $tookLateShot = $true
    $screenshots["2s"] = Save-Screenshot (Join-Path $OutDir "$Label-2s.png")
  }
  Start-Sleep -Milliseconds 200
}

[ordered]@{
  label = $Label
  durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  polls = $polls
  baselineVisibleWindows = $baseline.Count
  newVisibleWindows = @($newWindows.Values | Where-Object { -not $_.cloaked })
  foregroundChanges = @($foregroundChanges)
  processes = @($processes)
  screenshots = $screenshots
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir "$Label-summary.json") -Encoding utf8
