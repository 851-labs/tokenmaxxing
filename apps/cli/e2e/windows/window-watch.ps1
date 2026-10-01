# Records every process started, every top-level window shown and every
# foreground change while a scheduled-task run is under test
# (lib/watch-events.ps1). Windows come from events, so one that lives for a
# few milliseconds is still seen. Process starts come from WMI's process trace
# and a 20 ms process snapshot together: either one seeing a start is enough,
# so a start WMI drops is still seen if the process lived 20 ms.
# service-e2e.ps1 starts one hidden watcher per task run.
#
#   window-watch.ps1 -OutDir <dir> -Label <name> -StopFile <path> [-MaxSeconds 240]
#
# Writes <Label>.ready once every source has proved itself live (a self-test
# window shown by the watcher, and a hidden child process it starts that both
# process sources must report), <Label>-events.jsonl while running and
# <Label>-summary.json on exit, plus screenshots at the start, after 2.5 s and
# when a new window appears. A source that fails its self-test is reported in
# the summary (processSource / pollSource / windowSource) and the ready file
# still appears, so the caller's checks fail instead of timing out.
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
# Hidden probes the watcher starts itself (see Wait-ProcessSources), and the
# sources that reported each.
$probePids = @{}
$probesSeen = @{}
$WmiSourceName = "Win32_ProcessStartTrace"
$PollSourceName = "NtQuerySystemInformation"

# The process another source already reported as this start: same pid, parent
# and image, started within a few seconds (a WMI start whose process was gone
# by delivery only has its delivery time). Windows reuses pids quickly, but not
# for the same image under the same parent within seconds.
function Find-ProcessEntry($Event) {
  @($processes.Values | Where-Object {
      $_.pid -eq [int]$Event.Pid -and $_.ppid -eq [int]$Event.Ppid -and $_.name -ieq $Event.Name -and
      $_.sources -notcontains $Event.Source -and [math]::Abs($_.t - $Event.T) -le 3
    }) | Select-Object -Last 1
}

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
        if ($probePids.ContainsKey([int]$event.Pid)) { $probesSeen["$($event.Pid)/$($event.Source)"] = $true; continue }
        if ($probePids.ContainsKey([int]$event.Ppid)) { continue }
        $entry = Find-ProcessEntry $event
        if ($entry) {
          # The other source already reported this process: keep the exact
          # creation time and whichever command line was read.
          if ($entry.sources -notcontains $event.Source) { $entry.sources = @($entry.sources) + $event.Source }
          if ($event.Exact -and -not $entry.exact) { $entry.t = $event.T; $entry.exact = $true }
          if ($null -eq $entry.commandLine -and $null -ne $event.CommandLine) { $entry.commandLine = $event.CommandLine; $entry.Remove("commandLineError") }
          Emit ([ordered]@{ t = $event.T; kind = "process-source"; pid = [int]$event.Pid; source = $event.Source })
          continue
        }
        $entry = [ordered]@{ t = $event.T; exact = $event.Exact; pid = [int]$event.Pid; ppid = [int]$event.Ppid; name = $event.Name; sessionId = [int]$event.SessionId; commandLine = $event.CommandLine; sources = @($event.Source) }
        if ($event.CommandLineError) { $entry["commandLineError"] = $event.CommandLineError }
        $processes["$($event.Pid)@$($event.T)@$($event.Source)"] = $entry
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

# Starts a hidden ping.exe that runs until both process sources have reported
# it (or the time runs out), then stops it, and returns which sources did.
# Each source reports in order, so this also flushes every start before it.
function Wait-ProcessSources([int]$Seconds) {
  $want = @()
  if ([TmxE2EWatch]::ProcessSource -eq $WmiSourceName) { $want += $WmiSourceName }
  if ([TmxE2EWatch]::PollSource -eq $PollSourceName) { $want += $PollSourceName }
  $seen = @{}
  if ($want.Count -eq 0) { return $seen }
  $probe = Start-Process -FilePath "$env:SystemRoot\System32\PING.EXE" -ArgumentList "-n $($Seconds + 5) 127.0.0.1" -WindowStyle Hidden -PassThru
  $probePids[$probe.Id] = $true
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    Receive-WatchEvents
    foreach ($source in $want) { if ($probesSeen.ContainsKey("$($probe.Id)/$source")) { $seen[$source] = $true } }
    if ($seen.Count -eq $want.Count) { break }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue
  $seen
}

# Prove every source live before the caller starts the run: both process
# sources must report a probe of ours, and the hook the self-test window.
$processLive = Wait-ProcessSources 15
$deadline = (Get-Date).AddSeconds(5)
while (-not $selfTestWindowSeen -and (Get-Date) -lt $deadline) { Receive-WatchEvents; Start-Sleep -Milliseconds 50 }
[TmxE2EWatch]::EndSelfTest()
$processSource = if ([TmxE2EWatch]::ProcessSource -ne $WmiSourceName) { [TmxE2EWatch]::ProcessSource } elseif ($processLive[$WmiSourceName]) { $WmiSourceName } else { "error: the self-test process was never reported" }
$pollSource = if ([TmxE2EWatch]::PollSource -ne $PollSourceName) { [TmxE2EWatch]::PollSource } elseif ($processLive[$PollSourceName]) { $PollSourceName } else { "error: the self-test process was never reported" }
$windowSource = if ([TmxE2EWatch]::WindowSource -ne "SetWinEventHook") { [TmxE2EWatch]::WindowSource } elseif ($selfTestWindowSeen) { "SetWinEventHook" } else { "error: the self-test window was never reported" }
Emit ([ordered]@{ t = [math]::Round(((Get-Date) - $started).TotalSeconds, 3); kind = "baseline"; visibleWindows = $baseline.Count; processSource = $processSource; pollSource = $pollSource; windowSource = $windowSource; foreground = (Get-WindowInfo ([TmxE2EWin32]::Foreground())) })
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
$flushed = Wait-ProcessSources 15
if ($processSource -eq $WmiSourceName -and -not $flushed[$WmiSourceName]) { $processSource = "error: the final flush probe was never reported" }
if ($pollSource -eq $PollSourceName -and -not $flushed[$PollSourceName]) { $pollSource = "error: the final flush probe was never reported" }
[TmxE2EWatch]::Stop()
Receive-WatchEvents
if ([TmxE2EWatch]::PollSource -ne $PollSourceName -and $pollSource -eq $PollSourceName) { $pollSource = [TmxE2EWatch]::PollSource }

# A window whose process exited before the hook callback could ask it has no
# process name yet. Windows reuses pids quickly, so take the latest process
# with that pid started by then (a start only WMI saw has its delivery time, up
# to about a second late).
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
  pollSource = $pollSource
  windowSource = $windowSource
  # How many starts each process source reported: a start only one of them saw is one the other missed.
  processStarts = [ordered]@{
    both = @($processes.Values | Where-Object { $_.sources.Count -gt 1 }).Count
    wmiOnly = @($processes.Values | Where-Object { $_.sources.Count -eq 1 -and $_.sources[0] -eq $WmiSourceName }).Count
    pollOnly = @($processes.Values | Where-Object { $_.sources.Count -eq 1 -and $_.sources[0] -eq $PollSourceName }).Count
    pollSnapshots = [TmxE2EWatch]::PollSnapshots
    wmiHandlerErrors = [TmxE2EWatch]::HandlerErrors
    lastWmiHandlerError = [TmxE2EWatch]::LastHandlerError
  }
  baselineVisibleWindows = $baseline.Count
  newVisibleWindows = @($newWindows.Values | Where-Object { -not $_.cloaked })
  foregroundChanges = @($foregroundChanges)
  # In start order, so a parent always comes before its children.
  processes = @($processes.Values | Sort-Object -Stable { $_.t })
  screenshots = $screenshots
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutDir "$Label-summary.json") -Encoding utf8
