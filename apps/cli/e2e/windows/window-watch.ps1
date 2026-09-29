# Records, from events rather than polls, every process started, every
# top-level window shown and every foreground change while a scheduled-task
# run is under test (lib/watch-events.ps1). A process or window that lives for
# a few milliseconds is still seen. service-e2e.ps1 starts one hidden watcher
# per task run.
#
#   window-watch.ps1 -OutDir <dir> -Label <name> -StopFile <path> [-MaxSeconds 240]
#
# Writes <Label>.ready once both event sources have proved themselves live
# (a self-test window shown by the watcher, and a hidden child process it
# starts), <Label>-events.jsonl while running and <Label>-summary.json on
# exit, plus screenshots at the start, after 2.5 s and when a new window
# appears. A source that fails its self-test is reported in the summary
# (processSource / windowSource) and the ready file still appears, so the
# caller's checks fail instead of timing out.
param(
  [Parameter(Mandatory)] [string]$OutDir,
  [Parameter(Mandatory)] [string]$Label,
  [Parameter(Mandatory)] [string]$StopFile,
  [int]$MaxSeconds = 240
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\win32.ps1")
. (Join-Path $PSScriptRoot "lib\watch-events.ps1")

$events = Join-Path $OutDir "$Label-events.jsonl"
function Emit($Event) { ($Event | ConvertTo-Json -Compress -Depth 6) | Add-Content -LiteralPath $events -Encoding utf8 }

$baseline = @{}
foreach ($window in [TmxE2EWin32]::VisibleWindows()) { $baseline[$window.Hwnd] = $true }
$started = Get-Date
[TmxE2EWatch]::Start(10000)
$screenshots = [ordered]@{ start = Save-Screenshot (Join-Path $OutDir "$Label-start.png") }

$newWindows = [ordered]@{}
$foregroundChanges = New-Object System.Collections.ArrayList
$processes = [ordered]@{}
$windowShots = 0
$selfTestWindowSeen = $false
# Hidden cmd.exe probes the watcher starts itself (see Wait-ProcessTrace).
$probePids = @{}
$probesSeen = @{}

function Get-ProcessLabel($Event) { if ($Event.Process) { $Event.Process -replace '\.exe$', '' } else { $null } }

function ConvertTo-WindowInfo($Event) {
  [ordered]@{
    hwnd = ('0x{0:X}' -f $Event.Hwnd)
    pid = [int]$Event.Pid
    process = Get-ProcessLabel $Event
    class = $Event.Class
    title = $Event.Title
    rect = $Event.Rect
    visible = $Event.Visible
    iconic = $Event.Iconic
    cloaked = $Event.Cloaked
    source = $Event.Kind
  }
}

function Receive-WatchEvents {
  foreach ($event in [TmxE2EWatch]::Drain()) {
    switch ($event.Kind) {
      "process-start" {
        if ($probePids.ContainsKey([int]$event.Pid)) { $probesSeen[[int]$event.Pid] = $true; continue }
        if ($probePids.ContainsKey([int]$event.Ppid)) { continue }
        $entry = [ordered]@{ t = $event.T; pid = [int]$event.Pid; ppid = [int]$event.Ppid; name = $event.Name; sessionId = [int]$event.SessionId; commandLine = $event.CommandLine }
        if ($event.CommandLineError) { $entry["commandLineError"] = $event.CommandLineError }
        $processes["$($event.Pid)@$($event.T)"] = $entry
        Emit ([ordered]@{ t = $event.T; kind = "process"; process = $entry })
      }
      "process-stop" {
        $entry = @($processes.Values | Where-Object { $_.pid -eq $event.Pid -and -not $_.Contains("exitedAt") }) | Select-Object -Last 1
        if ($entry) {
          $entry["exitedAt"] = $event.T
          $entry["exitCode"] = $event.ExitCode
        }
        Emit ([ordered]@{ t = $event.T; kind = "process-exit"; pid = [int]$event.Pid; name = $event.Name; exitCode = $event.ExitCode })
      }
      "foreground" {
        $change = [ordered]@{ t = $event.T; window = (ConvertTo-WindowInfo $event) }
        [void]$foregroundChanges.Add($change)
        Emit ([ordered]@{ t = $event.T; kind = "foreground-changed"; change = $change })
      }
      default {
        # window-show / window-uncloaked
        if ($event.Hwnd -eq [TmxE2EWatch]::SelfTestHwnd) { $script:selfTestWindowSeen = $true; continue }
        if ($event.Pid -eq $PID -or $baseline.ContainsKey($event.Hwnd)) { continue }
        $key = '0x{0:X}' -f $event.Hwnd
        if ($newWindows.Contains($key)) {
          # Re-shown or uncloaked later: a cloaked window that becomes visible counts.
          $newWindows[$key]["lastSeen"] = $event.T
          if (-not $event.Cloaked) { $newWindows[$key]["cloaked"] = $false }
          continue
        }
        $info = ConvertTo-WindowInfo $event
        $info["firstSeen"] = $event.T
        $info["lastSeen"] = $event.T
        $newWindows[$key] = $info
        Emit ([ordered]@{ t = $event.T; kind = "new-visible-window"; window = $info })
        if ($script:windowShots -lt 3 -and -not $event.Cloaked) {
          $script:windowShots++
          $screenshots["window-$script:windowShots"] = Save-Screenshot (Join-Path $OutDir "$Label-window-$script:windowShots.png")
        }
      }
    }
  }
}

# Starts a hidden cmd.exe and waits until the process trace reports it. The
# trace is delivered in order, so this also flushes every start before it.
function Wait-ProcessTrace([int]$Seconds) {
  if ([TmxE2EWatch]::ProcessSource -ne "Win32_ProcessStartTrace") { return $false }
  $probe = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/d /c exit" -WindowStyle Hidden -PassThru
  $probePids[$probe.Id] = $true
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    Receive-WatchEvents
    if ($probesSeen.ContainsKey($probe.Id)) { return $true }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  $false
}

# Prove both sources live before the caller starts the run: the process trace
# must report a probe of ours, and the hook the self-test window.
$processLive = Wait-ProcessTrace 15
$deadline = (Get-Date).AddSeconds(5)
while (-not $selfTestWindowSeen -and (Get-Date) -lt $deadline) { Receive-WatchEvents; Start-Sleep -Milliseconds 50 }
[TmxE2EWatch]::EndSelfTest()
$processSource = if ([TmxE2EWatch]::ProcessSource -ne "Win32_ProcessStartTrace") { [TmxE2EWatch]::ProcessSource } elseif ($processLive) { "Win32_ProcessStartTrace" } else { "error: the self-test process was never reported" }
$windowSource = if ([TmxE2EWatch]::WindowSource -ne "SetWinEventHook") { [TmxE2EWatch]::WindowSource } elseif ($selfTestWindowSeen) { "SetWinEventHook" } else { "error: the self-test window was never reported" }
Emit ([ordered]@{ t = [math]::Round(((Get-Date) - $started).TotalSeconds, 3); kind = "baseline"; visibleWindows = $baseline.Count; processSource = $processSource; windowSource = $windowSource; foreground = (Get-WindowInfo ([TmxE2EWin32]::Foreground())) })
# Everything up to here is the watcher's own startup, not the run under test.
$processes.Clear()
$foregroundChanges.Clear()
Set-Content -LiteralPath (Join-Path $OutDir "$Label.ready") -Value "ready"
$readyAt = ((Get-Date) - $started).TotalSeconds

$tookLateShot = $false
while (-not (Test-Path -LiteralPath $StopFile)) {
  $elapsed = ((Get-Date) - $started).TotalSeconds
  if ($elapsed -gt $MaxSeconds) { break }
  # Only moves queued events to disk; the sources themselves are event-driven.
  Receive-WatchEvents
  if (-not $tookLateShot -and $elapsed -ge $readyAt + 2.5) {
    $tookLateShot = $true
    $screenshots["2s"] = Save-Screenshot (Join-Path $OutDir "$Label-2s.png")
  }
  Start-Sleep -Milliseconds 100
}
# Every process started before the stop file must be in the summary.
if ($processLive -and -not (Wait-ProcessTrace 15)) { $processSource = "error: the final flush probe was never reported" }
[TmxE2EWatch]::Stop()
Receive-WatchEvents

# A window whose process exited before the hook callback could ask it has no
# process name yet. Windows reuses pids quickly, so take the latest process
# with that pid whose start was delivered by then (starts arrive up to about a
# second late).
function Resolve-WindowProcess($Window, [double]$At) {
  if ($null -eq $Window -or $Window.process -or $Window.pid -eq 0) { return }
  $start = @($processes.Values | Where-Object { $_.pid -eq $Window.pid -and $_.t -le $At + 2 }) | Select-Object -Last 1
  if ($start) { $Window["process"] = $start.name -replace '\.exe$', ''; $Window["processFrom"] = "process trace" }
}
foreach ($window in $newWindows.Values) { Resolve-WindowProcess $window $window.firstSeen }
foreach ($change in $foregroundChanges) { Resolve-WindowProcess $change.window $change.t }

[ordered]@{
  label = $Label
  durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  readyAtSeconds = [math]::Round($readyAt, 3)
  processSource = $processSource
  windowSource = $windowSource
  baselineVisibleWindows = $baseline.Count
  newVisibleWindows = @($newWindows.Values | Where-Object { -not $_.cloaked })
  foregroundChanges = @($foregroundChanges)
  processes = @($processes.Values)
  screenshots = $screenshots
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir "$Label-summary.json") -Encoding utf8
