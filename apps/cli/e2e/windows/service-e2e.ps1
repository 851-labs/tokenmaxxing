# Service scenarios for the Windows Task Scheduler backend. Run by
# run-service-e2e.ps1, which provides the installed CLI, the fake bun, the
# sandbox API and the legacy release; every check lands in results.jsonl.
#
#   core            install -> task + launcher -> scheduled run (no window) ->
#                   error paths -> status/doctor/repair -> deferred repairs -> uninstall
#   npx fallback    no bun on PATH: scheduled runs sync through npm's npx.cmd shim
#   version-manager node
#                   node only from an fnm per-shell junction: install keeps fnm's default alias,
#                   and a 0.6.0-style wrapper whose junction is gone is repaired back to it
#   overlapping     a held service.log -> side log, no rotation; three runs at once ->
#                   one sync, a log entry each, no window; doctor stays clean
#   path cases      install -> run -> reload-required deferred repair -> run -> uninstall,
#                   under config paths with (), &, ', %, spaces and non-ASCII
#   legacy upgrade  a release from before the hidden launcher (template 5, task runs the
#                   .cmd directly) upgraded by runner auto-update, and by `service repair`
#   uninstall from the runner
#                   install and uninstall run by the service runner exe itself: the task
#                   goes, the running runner is deleted by a hidden cleanup once it exits
#
# -Only <scenario>,... runs just those scenarios (for a local VM run).
# -WatcherTask <name> starts each window watcher through that scheduled task
# instead of directly (see the README: a VM whose user is a UAC-filtered admin).
param(
  [Parameter(Mandatory)] [string]$Root,
  [Parameter(Mandatory)] [string]$OutDir,
  [Parameter(Mandatory)] [string]$TmxBin,
  [Parameter(Mandatory)] [string]$FakeBin,
  [Parameter(Mandatory)] [string]$Api,
  [Parameter(Mandatory)] [int]$TemplateVersion,
  [Parameter(Mandatory)] [string]$RunnerExe,
  [string]$LegacyBin = "",
  [string[]]$Only = @(),
  [string]$WatcherTask = ""
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
Initialize-E2E -OutDir $OutDir -Suite "service"

$TaskName = "tokenmaxxing-sync"
$BasePath = $env:PATH
# Processes worth listing in check details.
$WatchedProcesses = @("cmd", "conhost", "OpenConsole", "WindowsTerminal", "tokenmaxxing", "wscript", "cscript", "bun", "node", "timeout")
# Console hosts started over COM rather than by the console's client (Windows
# Terminal as the default terminal), so a console of ours shows up under them.
$TerminalHosts = @("WindowsTerminal", "OpenConsole")
$WscriptPattern = '^"?[A-Za-z]:\\Windows\\System32\\wscript\.exe"? //B //NoLogo //E:VBScript ".+\\service-sync\.vbs"$'
$CmdPattern = '^"?.+\\service-sync\.cmd"?$'

# ------------------------------------------------------------ profile + CLI
function Tmx([string[]]$CliArgs) { Invoke-Logged "tokenmaxxing $($CliArgs -join ' ')" { tokenmaxxing @CliArgs } }

function ConvertFrom-CliJson([string]$Text) {
  $start = $Text.IndexOf("{")
  if ($start -lt 0) { return $null }
  try { $Text.Substring($start) | ConvertFrom-Json -Depth 20 } catch { $null }
}

function Use-Cli([string]$Bin) { $env:PATH = "$FakeBin;$Bin;$BasePath" }

# Mirrors deterministicServiceJitterMs (apps/cli/src/commands/service.ts):
# scheduled runs sleep up to 60 s, keyed by the deviceId.
function Get-JitterMs([string]$Seed) {
  [uint64]$hash = 2166136261
  foreach ($ch in $Seed.ToCharArray()) {
    $hash = $hash -bxor [uint64][int]$ch
    $hash = ($hash * 16777619) % 4294967296
  }
  [int]($hash % 60001)
}

# A fresh config dir with a sandbox CLI token whose deviceId gives a 2-4 s
# jitter, and agent log roots the wrapper captures at install.
function New-Profile([string]$ConfigDir) {
  if (Test-Path -LiteralPath $ConfigDir) { Remove-Item -LiteralPath $ConfigDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  do { $deviceId = [guid]::NewGuid().ToString(); $jitter = Get-JitterMs $deviceId } while ($jitter -lt 2000 -or $jitter -gt 4000)
  $minted = Invoke-RestMethod -Method Post -Uri "$Api/__sandbox/cli-token" -ContentType "application/json" -Body (@{ deviceId = $deviceId } | ConvertTo-Json)
  @{ apiUrl = $Api; wwwUrl = $Api; token = $minted.token; deviceId = $deviceId } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $ConfigDir "config.json") -Encoding utf8
  $env:TOKENMAXXING_CONFIG_DIR = $ConfigDir
  $env:TOKENMAXXING_API_URL = $Api
  $env:TOKENMAXXING_WWW_URL = $Api
  Remove-Item Env:TOKENMAXXING_API_TOKEN, Env:TOKENMAXXING_ENV -ErrorAction SilentlyContinue
  $env:CLAUDE_CONFIG_DIR = Join-Path $Root "agent-logs\claude"
  $env:CODEX_HOME = Join-Path $Root "agent-logs\codex"
  New-Item -ItemType Directory -Force -Path (Join-Path $env:CLAUDE_CONFIG_DIR "projects\e2e"), (Join-Path $env:CODEX_HOME "sessions") | Out-Null
  $script:UserId = $minted.userId
  Write-E2ELog "profile $ConfigDir user=$($minted.login) device=$deviceId jitter=${jitter}ms"
}

# Scheduled runs skip sources whose log roots are unchanged, so every run
# gets a new log file to keep the claude + codex path exercised.
function Update-AgentLogs {
  $name = "$([guid]::NewGuid()).jsonl"
  Set-Content -LiteralPath (Join-Path $env:CLAUDE_CONFIG_DIR "projects\e2e\$name") -Value '{"e2e":true}' -Encoding ascii
  Set-Content -LiteralPath (Join-Path $env:CODEX_HOME "sessions\$name") -Value '{"e2e":true}' -Encoding ascii
}

function Config-File([string]$Name) { Join-Path $env:TOKENMAXXING_CONFIG_DIR $Name }
function Read-ConfigJson([string]$Name) { try { Get-Content -LiteralPath (Config-File $Name) -Raw | ConvertFrom-Json -Depth 20 } catch { $null } }

function Set-TemplateVersion([int]$Version) {
  $meta = Read-ConfigJson "service.json"
  $meta.templateVersion = $Version
  $meta | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Config-File "service.json") -Encoding utf8
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do { Start-Sleep -Milliseconds 500; if (& $Condition) { return $true } } while ((Get-Date) -lt $deadline)
  return $false
}

function Wait-RepairFinished([int]$Seconds = 60) {
  Wait-Until { (Read-ConfigJson "service-state.json").lastRepairStatus -in @("success", "failure") } $Seconds | Out-Null
  Read-ConfigJson "service-state.json"
}

# ------------------------------------------------------------ task helpers
function Get-Task {
  $raw = (schtasks /Query /TN $TaskName /V /FO LIST 2>&1 | Out-String)
  $map = [ordered]@{ _exit = $LASTEXITCODE; _raw = $raw }
  foreach ($line in ($raw -split "\r?\n")) {
    if ($line -match '^([^:]+?):\s+(.*)$' -and -not $map.Contains($Matches[1])) { $map[$Matches[1]] = $Matches[2].Trim() }
  }
  $map
}

function Assert-TaskAction([string]$Scenario, [ValidateSet("wscript", "cmd")] [string]$Expect) {
  $toRun = (Get-Task)["Task To Run"]
  $pattern = if ($Expect -eq "wscript") { $WscriptPattern } else { $CmdPattern }
  Add-Check $Scenario "task runs $Expect" ($toRun -match $pattern) "Task To Run: $toRun"
}

# The registered definition: wscript + launcher arguments, the config dir as
# working directory, and the interactive-token logon. Read from the task's own
# file (UTF-16 with a BOM), as the CLI does: `schtasks /XML` piped into
# PowerShell is decoded in the console's code page, which turned the "ë" of a
# Zoë config dir into "├½" wherever that is not UTF-8.
function Assert-TaskDefinition([string]$Scenario, [string]$Label) {
  $taskFile = Join-Path $env:SystemRoot "System32\Tasks\$TaskName"
  $xmlText = try { Get-Content -LiteralPath $taskFile -Raw -ErrorAction Stop } catch { (schtasks /Query /TN $TaskName /XML 2>&1 | Out-String) }
  Set-Content -LiteralPath (Join-Path $OutDir "$Label-task.xml") -Value $xmlText -Encoding utf8
  try { $task = ([xml]$xmlText).Task } catch { Add-Check $Scenario "task XML parses" $false (Format-OneLine $xmlText 300); return }
  $exec = $task.Actions.Exec
  $launcher = Config-File "service-sync.vbs"
  Add-Check $Scenario "task XML: Command is wscript.exe" ($exec.Command -match '^"?[A-Za-z]:\\Windows\\System32\\wscript\.exe"?$') "Command=$($exec.Command)"
  Add-Check $Scenario "task XML: Arguments run the launcher hidden" ($exec.Arguments -eq "//B //NoLogo //E:VBScript `"$launcher`"") "Arguments=$($exec.Arguments)"
  Add-Check $Scenario "task XML: WorkingDirectory is the config dir" ($exec.WorkingDirectory.TrimEnd('\') -eq $env:TOKENMAXXING_CONFIG_DIR.TrimEnd('\')) "WorkingDirectory=$($exec.WorkingDirectory)"
  Add-Check $Scenario "task XML: interactive token" ($task.Principals.Principal.LogonType -eq "InteractiveToken") "LogonType=$($task.Principals.Principal.LogonType)"
}

function Assert-Launcher([string]$Scenario) {
  $path = Config-File "service-sync.vbs"
  if (-not (Test-Path -LiteralPath $path)) { Add-Check $Scenario "launcher exists" $false $path; return }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $nonAscii = @($bytes | Where-Object { $_ -gt 0x7F }).Count
  $bareLf = ([regex]::Matches([System.Text.Encoding]::ASCII.GetString($bytes), "(?<!\r)\n")).Count
  Add-Check $Scenario "launcher is ASCII with CRLF" ($nonAscii -eq 0 -and $bareLf -eq 0) "$path bytes=$($bytes.Length) nonAscii=$nonAscii bareLF=$bareLf"
}

function Get-Requests { @((Invoke-RestMethod -Uri "$Api/__sandbox/requests").requests) }

# Starts window-watch.ps1 hidden and waits until it has proved its event
# sources live; Stop-Watcher returns its summary (or $null). With
# -WatcherTask, the task runs pwsh with the arguments in
# <Root>\watcher-task-args.txt, elevated in this session.
function Start-Watcher([string]$Label) {
  $stop = Join-Path $OutDir "$Label.stop"
  $ready = Join-Path $OutDir "$Label.ready"
  $summary = Join-Path $OutDir "$Label-summary.json"
  # Left by an earlier run into the same out dir, they would end this watch at once.
  Remove-Item -LiteralPath $stop, $ready, $summary -ErrorAction SilentlyContinue
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\window-watch.ps1`" -OutDir `"$OutDir`" -Label `"$Label`" -StopFile `"$stop`""
  $process = $null
  if ($WatcherTask) {
    Set-Content -LiteralPath (Join-Path $Root "watcher-task-args.txt") -Value $arguments -Encoding utf8
    schtasks /Run /TN $WatcherTask 2>&1 | Out-Null
  } else {
    $process = Start-Process -FilePath "pwsh" -WindowStyle Hidden -PassThru -ArgumentList $arguments
  }
  Wait-Until { Test-Path -LiteralPath $ready } 45 | Out-Null
  [pscustomobject]@{ process = $process; stop = $stop; summary = $summary }
}

function Read-WatchSummary([string]$Path) {
  if (Test-Path -LiteralPath $Path) { try { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 10 } catch { $null } } else { $null }
}

function Stop-Watcher($Watcher) {
  New-Item -ItemType File -Force -Path $Watcher.stop | Out-Null
  if ($Watcher.process) {
    if (-not $Watcher.process.WaitForExit(30000)) { $Watcher.process.Kill() }
  } else {
    Wait-Until { $null -ne (Read-WatchSummary $Watcher.summary) } 30 | Out-Null
  }
  Read-WatchSummary $Watcher.summary
}

# Runs the task once under a window watcher and waits for it to finish.
# -After runs, with the watcher still up, once the task is back to Ready.
# -Repairs names the deferred repairs the run is expected to spawn; the
# watcher must see each of them (Assert-WatcherSawRun).
function Invoke-TaskRun([string]$Label, [scriptblock]$After = $null, [string[]]$Repairs = @()) {
  $logPath = Config-File "service.log"
  $logBefore = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).Length } else { 0 }
  $requestsBefore = (Get-Requests).Count
  Update-AgentLogs
  $before = Get-Task
  $watcher = Start-Watcher $Label

  $started = Get-Date
  $runOut = (schtasks /Run /TN $TaskName 2>&1 | Out-String).Trim()
  $task = $before
  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $task = Get-Task
    if ($task["Status"] -eq "Running") { continue }
    # 267009 = SCHED_S_TASK_RUNNING
    if ($task["Last Run Time"] -ne $before["Last Run Time"] -and $task["Last Result"] -ne "267009") { break }
  }
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  Start-Sleep -Seconds 2
  $afterResult = if ($After) { & $After } else { $null }
  $watch = Stop-Watcher $watcher

  $task = Get-Task
  $logDelta = ""
  if (Test-Path -LiteralPath $logPath) {
    $bytes = [System.IO.File]::ReadAllBytes($logPath)
    if ($bytes.Length -gt $logBefore) { $logDelta = [System.Text.Encoding]::UTF8.GetString($bytes, [int]$logBefore, $bytes.Length - [int]$logBefore) }
  }
  Set-Content -LiteralPath (Join-Path $OutDir "$Label-service-log.txt") -Value $logDelta -Encoding utf8
  $run = [pscustomobject]@{
    label = $Label
    action = if ($before["Task To Run"] -match $CmdPattern) { "cmd" } else { "wscript" }
    repairs = $Repairs
    lastResult = $task["Last Result"]
    status = $task["Status"]
    seconds = $seconds
    logDelta = $logDelta
    requests = @(Get-Requests | Select-Object -Skip $requestsBefore)
    watch = $watch
    after = $afterResult
  }
  Write-E2ELog "run $Label ($runOut) -> Last Result $($run.lastResult) after ${seconds}s; requests: $(($run.requests | ForEach-Object { "$($_.method) $($_.path) $($_.status)" }) -join ', ')"
  $run
}

# The run's process tree, from the starts the watcher recorded: its roots
# (the task's action, or the pids the harness started for a control) and
# every descendant. Windows reuses pids within seconds, so a parent is the
# latest process with that pid started no later than its child. A start only
# WMI saw, of a process gone by then (exact = false), has its delivery time,
# up to about a second after the real one.
function Get-ParentProcess($Processes, $Child) {
  @($Processes | Where-Object { $_.pid -eq $Child.ppid -and ($_.t -le $Child.t -or ($_.exact -eq $false -and $_.t -le $Child.t + 2)) }) | Select-Object -Last 1
}

function Get-RunRoots($Run) {
  $processes = @($Run.watch.processes)
  if ($Run.rootPids) { return @($processes | Where-Object { $_.pid -in $Run.rootPids }) }
  # Task Scheduler, the action's parent, was running before the watcher.
  @($processes | Where-Object {
      $null -eq (Get-ParentProcess $processes $_) -and (
        ($Run.action -ne "cmd" -and $_.name -eq "wscript.exe") -or
        ($Run.action -eq "cmd" -and $_.name -eq "cmd.exe" -and ($null -eq $_.commandLine -or $_.commandLine -match 'service-sync\.cmd')))
    })
}

function Get-RunTree($Run) {
  $processes = @($Run.watch.processes)
  $tree = New-Object System.Collections.Generic.HashSet[string]
  foreach ($root in (Get-RunRoots $Run)) { [void]$tree.Add("$($root.pid)@$($root.t)") }
  # Starts are in start order, parents before children; repeat until nothing
  # is added in case a start time put a child first.
  do {
    $added = $false
    foreach ($process in $processes) {
      if ($tree.Contains("$($process.pid)@$($process.t)")) { continue }
      $parent = Get-ParentProcess $processes $process
      if ($parent -and $tree.Contains("$($parent.pid)@$($parent.t)")) { [void]$tree.Add("$($process.pid)@$($process.t)"); $added = $true }
    }
  } while ($added)
  $tree
}

# Windows and focus changes owned by the run's process tree fail the run, and
# so do those owned by a terminal host, where a console of ours would land.
# Anything else (the windows-11-arm image runs `wsl.exe --update` in a console
# now and then) is ignored but listed with its process and parent, so one of
# ours under another name would still be noticed.
function Get-RunWindows($Run) {
  $watch = $Run.watch
  $processes = @($watch.processes)
  $tree = Get-RunTree $Run
  # A window's process by pid; its start may be delivered up to about a second
  # after the window shows.
  $owner = { param($w, $at) if ($w -and $w.pid) { @($processes | Where-Object { $_.pid -eq $w.pid -and $_.t -le $at + 2 }) | Select-Object -Last 1 } }
  $isOurs = { param($w, $at)
    if ($null -eq $w) { return $false }
    if ($w.process -in $TerminalHosts) { return $true }
    $process = & $owner $w $at
    $null -ne $process -and $tree.Contains("$($process.pid)@$($process.t)")
  }
  $describe = { param($w, $at)
    if ($null -eq $w) { return "gone" }
    $process = & $owner $w $at
    $parent = if ($process) { Get-ParentProcess $processes $process } else { $null }
    $from = if (-not $process) { "running before the watch" } elseif ($parent) { "started by $($parent.name)#$($parent.pid)" } else { "started by #$($process.ppid), running before the watch" }
    "$($w.process)#$($w.pid) ($from) class=$($w.class) title='$($w.title)' rect=$($w.rect)"
  }
  $windows = @($watch.newVisibleWindows | Where-Object { & $isOurs $_ $_.firstSeen })
  $focus = @($watch.foregroundChanges | Where-Object { & $isOurs $_.window $_.t })
  $ignoredWindows = @($watch.newVisibleWindows | Where-Object { -not (& $isOurs $_ $_.firstSeen) })
  $ignoredFocus = @($watch.foregroundChanges | Where-Object { -not (& $isOurs $_.window $_.t) })
  [pscustomobject]@{
    windows = $windows
    focus = $focus
    ignored = @($ignoredWindows) + @($ignoredFocus)
    detail = "windows=[$(($windows | ForEach-Object { & $describe $_ $_.firstSeen }) -join '; ')] focus=[$(($focus | ForEach-Object { "$($_.t)s->$(& $describe $_.window $_.t)" }) -join '; ')] tree=$($tree.Count) ignored windows=[$(($ignoredWindows | ForEach-Object { & $describe $_ $_.firstSeen }) -join '; ')] ignored focus=[$(($ignoredFocus | ForEach-Object { "$($_.t)s->$(& $describe $_.window $_.t)" }) -join '; ')]"
  }
}

function Test-WatcherLive($Watch) { $Watch.processSource -eq "Win32_ProcessStartTrace" -and $Watch.pollSource -eq "NtQuerySystemInformation" -and $Watch.windowSource -eq "SetWinEventHook" }

function Format-WatchSources($Watch) {
  "processSource=$($Watch.processSource) pollSource=$($Watch.pollSource) windowSource=$($Watch.windowSource) starts=$(($Watch.processStarts | ConvertTo-Json -Compress -Depth 3))"
}

# Each process with the sources that saw its start: w = WMI, p = the snapshot poll.
function Format-WatchedProcesses($Processes) {
  (@($Processes | Where-Object { ($_.name -replace '\.exe$', '') -in $WatchedProcesses -and $_.name -ne "conhost.exe" }) |
      ForEach-Object {
        $by = (@($_.sources) | ForEach-Object { if ($_ -eq "Win32_ProcessStartTrace") { "w" } else { "p" } }) -join ""
        "$($_.name)#$($_.pid)<-$($_.ppid)[$by]: $(if ($null -ne $_.commandLine) { $_.commandLine } else { "(gone before its command line was read)" })"
      }) -join " || "
}

# A watcher that misses the run's own processes is blind, and its "no
# window" verdict means nothing. Every run must show the task's action (the
# wscript launcher, or cmd.exe running the legacy .cmd) and each deferred
# repair it was expected to spawn, however briefly they lived. Either process
# source seeing a start counts: WMI now and then drops one under load, and the
# snapshot poll misses only what lives under 20 ms. Process starts always
# carry the parent pid, command lines only when the process was still running
# when a source reported it, so the process tree decides: the action's parent
# is Task Scheduler, which was running before the watcher started, and a
# deferred repair is a wscript.exe started by the runner (tokenmaxxing.exe).
# The same tree decides which windows count (Get-RunWindows). A miss lists the
# repair the service state recorded, to tell a blind watcher from a repair
# that never ran.
function Assert-WatcherSawRun([string]$Scenario, $Run) {
  $check = "watcher saw the run's processes ($($Run.label))"
  $watch = $Run.watch
  if ($null -eq $watch) { Add-Check $Scenario $check $false "window watcher wrote no summary"; return }
  $processes = @($watch.processes)
  $actionName = if ($Run.action -eq "cmd") { "cmd.exe" } else { "wscript.exe" }
  $actions = @(Get-RunRoots $Run)
  $repairs = @($processes | Where-Object { $_.name -eq "wscript.exe" -and (Get-ParentProcess $processes $_).name -eq "tokenmaxxing.exe" })
  $missing = @()
  if ($actions.Count -eq 0) { $missing += "$actionName started by Task Scheduler" }
  foreach ($reason in $Run.repairs) {
    # A repair whose command line was read must name the reason.
    if (@($repairs | Where-Object { $null -eq $_.commandLine -or $_.commandLine -match "service-sync\.vbs`"? repair $reason" }).Count -eq 0) { $missing += "$reason repair (wscript.exe started by tokenmaxxing.exe)" }
  }
  $state = if ($missing.Count -gt 0) { Read-ConfigJson "service-state.json" } else { $null }
  $recorded = if ($state) { " state: lastRepairReason=$($state.lastRepairReason) status=$($state.lastRepairStatus) attemptAt=$($state.lastRepairAttemptAt)" } else { "" }
  Add-Check $Scenario $check ((Test-WatcherLive $watch) -and $missing.Count -eq 0) "$(Format-WatchSources $watch) missing=[$($missing -join ', ')]$recorded seen=[$(Format-WatchedProcesses $processes)]"
}

function Assert-NoWindow([string]$Scenario, $Run) {
  Assert-WatcherSawRun $Scenario $Run
  if ($null -eq $Run.watch) { Add-Check $Scenario "no window or focus change ($($Run.label))" $false "window watcher wrote no summary"; return }
  $seen = Get-RunWindows $Run
  Add-Check $Scenario "no window or focus change ($($Run.label))" ($seen.windows.Count -eq 0 -and $seen.focus.Count -eq 0) $seen.detail
}

function Get-ServiceRunLine($Run) {
  ($Run.logDelta -split "\r?\n" | Where-Object { $_ -match '"event":"service_run"' } | Select-Object -Last 1)
}

function Assert-SuccessfulRun([string]$Scenario, $Run, [switch]$AllowCooldown) {
  Add-Check $Scenario "Last Result 0 ($($Run.label))" ($Run.lastResult -eq "0") "Last Result=$($Run.lastResult) status=$($Run.status) seconds=$($Run.seconds)"
  $line = Get-ServiceRunLine $Run
  Add-Check $Scenario "service.log records a successful sync ($($Run.label))" ($Run.logDelta -match "tokenmaxxing service sync" -and $line -match '"status":"success"') (Format-OneLine $Run.logDelta 900)
  $paths = ($Run.requests | ForEach-Object { "$($_.method) $($_.path) $($_.status)" }) -join ", "
  # Two check-ins: the started one, and the final one only a run that finished sends. A run
  # that dies mid-sync (0.7.0/0.7.1 without bun on Windows) sends just the first.
  $checkIns = @($Run.requests | Where-Object { $_.path -eq "/usage/check-in" -and $_.status -eq 200 }).Count
  $ingests = @($Run.requests | Where-Object { $_.path -eq "/usage/ingest" -and $_.status -eq 200 }).Count
  if ($AllowCooldown -and $ingests -eq 0) {
    # A run seconds after the previous one may skip every source (cadence cooldown).
    Add-Check $Scenario "sandbox got both check-ins; sources on cooldown ($($Run.label))" ($checkIns -ge 2 -and $line -match '"status":"success"' -and $line -match '"rows":0') $paths
  } else {
    Add-Check $Scenario "sandbox got both check-ins + ingest ($($Run.label))" ($checkIns -ge 2 -and $ingests -ge 1) $paths
  }
}

# A template mismatch makes the next scheduled run spawn a hidden
# reload-required repair, which rewrites service.json at the current template
# and re-registers the task; the run after that must still be clean.
function Invoke-ReloadRequiredRepair([string]$Scenario, [string]$Label) {
  Set-TemplateVersion ($TemplateVersion - 1)
  $run = Invoke-TaskRun "$Label-reload-required" {
    Wait-Until { (Read-ConfigJson "service.json").templateVersion -eq $TemplateVersion } 30 | Out-Null
    Start-Sleep -Seconds 2
    "templateVersion=$((Read-ConfigJson 'service.json').templateVersion)"
  } -Repairs "reload-required"
  Add-Check $Scenario "reload-required repair restores template $TemplateVersion" ($run.after -eq "templateVersion=$TemplateVersion") "after: $($run.after); $(Format-OneLine (Get-ServiceRunLine $run) 400)"
  Assert-NoWindow $Scenario $run
  $state = Wait-RepairFinished
  Add-Check $Scenario "reload-required repair recorded success" ($state.lastRepairStatus -eq "success" -and $state.lastRepairReason -eq "reload-required") "status=$($state.lastRepairStatus) reason=$($state.lastRepairReason) error=$($state.lastRepairError)"
  Assert-TaskAction $Scenario "wscript"
  $next = Invoke-TaskRun "$Label-after-reload"
  Assert-SuccessfulRun $Scenario $next -AllowCooldown
  Assert-NoWindow $Scenario $next
}

function Assert-Uninstall([string]$Scenario) {
  $uninstall = Tmx @("service", "uninstall", "--json")
  Add-Check $Scenario "service uninstall" ($uninstall.code -eq 0) (Format-OneLine $uninstall.out)
  $task = Get-Task
  Add-Check $Scenario "task removed" ($task._exit -ne 0) (Format-OneLine $task._raw 200)
  $leftovers = @("service-sync.vbs", "service-sync.cmd") | Where-Object { Test-Path -LiteralPath (Config-File $_) }
  Add-Check $Scenario "launcher + wrapper removed" ($leftovers.Count -eq 0) "left: $($leftovers -join ', ')"
}

function Get-ScenarioLabel([string]$Scenario) { ($Scenario -replace '[^A-Za-z0-9]+', '-').Trim('-') }

function Install-Service([string]$Scenario) {
  $install = Tmx @("service", "install", "--json")
  Add-Check $Scenario "service install" ($install.code -eq 0) (Format-OneLine $install.out)
  $install.code -eq 0
}

# ------------------------------------------------------------ scenarios
# The watcher against processes that live for milliseconds, far below the
# 200 ms poll it used to have: a hidden one must show up as a process and
# nothing else, a visible console as a process and a window. Each gets its own
# watcher, so a window cannot be pinned on the wrong one.
function Invoke-WatcherControl([string]$Label, [string]$WindowStyle) {
  $watcher = Start-Watcher $Label
  $process = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/d /c exit" -WindowStyle $WindowStyle -PassThru
  $process.WaitForExit()
  Start-Sleep -Seconds 2
  $watch = Stop-Watcher $watcher
  $seen = if ($watch) { @($watch.processes | Where-Object { $_.pid -eq $process.Id -and $_.name -eq "cmd.exe" }) | Select-Object -First 1 } else { $null }
  [pscustomobject]@{
    watch = $watch
    seen = $null -ne $seen
    # The harness started this cmd.exe, so it is the tree's root.
    windows = if ($watch) { Get-RunWindows ([pscustomobject]@{ watch = $watch; rootPids = @($process.Id) }) } else { $null }
    detail = "$(Format-WatchSources $watch) ready after $($watch.readyAtSeconds)s; cmd.exe#$($process.Id) exit=$($process.ExitCode) $(if ($seen) { "seen by $(@($seen.sources) -join '+')" } else { 'not seen' })"
  }
}

function Invoke-WatcherControls {
  $scenario = "window watcher"
  $hidden = Invoke-WatcherControl "watch-hidden-flash" "Hidden"
  Add-Check $scenario "sees a hidden process that lives for milliseconds" ($hidden.watch -and (Test-WatcherLive $hidden.watch) -and $hidden.seen) $hidden.detail
  Add-Check $scenario "no window for it" ($hidden.windows -and $hidden.windows.windows.Count -eq 0 -and $hidden.windows.focus.Count -eq 0) "$($hidden.windows.detail)"
  # A positive control that needs no legacy release: the console Windows opens
  # for a visible cmd.exe (conhost, or Windows Terminal where that is the
  # default terminal) must be caught even though it closes at once.
  $visible = Invoke-WatcherControl "watch-visible-flash" "Normal"
  Add-Check $scenario "sees a visible process that lives for milliseconds" ($visible.watch -and (Test-WatcherLive $visible.watch) -and $visible.seen) $visible.detail
  Add-Check $scenario "catches its console window (positive control)" ($visible.windows -and $visible.windows.windows.Count -gt 0) "$($visible.windows.detail)"
}

# Windows without bun: ccusage runs through npm's npx.cmd, a batch file. Bun 1.4 (the runtime
# since 0.7.0) throws EINVAL starting one without a shell, and that ended every scheduled run
# right after its started check-in, with nothing uploaded, logged or reported. The fake bun the
# other scenarios use is an .exe, so they never took this path.
function Invoke-NpxFallback {
  $scenario = "npx fallback"
  $npxBin = Join-Path $Root "npxbin"
  New-Item -ItemType Directory -Force -Path $npxBin | Out-Null
  Copy-Item -LiteralPath "$PSScriptRoot\..\shared\fakes\fake-npx.mjs", "$PSScriptRoot\..\shared\fakes\fake-ccusage.mjs" -Destination $npxBin -Force
  # Starts node with %*, like npm's shim.
  Set-Content -LiteralPath (Join-Path $npxBin "npx.cmd") -Value "@echo off`r`nnode `"%~dp0fake-npx.mjs`" %*`r`n" -Encoding ascii -NoNewline
  $withoutBun = @($BasePath -split ";" | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ "bun.exe")) })
  $env:PATH = (@($npxBin, $TmxBin) + $withoutBun) -join ";"
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  Add-Check $scenario "no bun on PATH" ($null -eq $bun) "bun: $(if ($bun) { $bun.Source } else { 'none' })"
  New-Profile (Join-Path $Root "cfg-npx")
  if (-not (Install-Service $scenario)) { return }

  $run = Invoke-TaskRun "npx-run"
  Assert-SuccessfulRun $scenario $run
  Assert-NoWindow $scenario $run
  $usage = @((Invoke-RestMethod -Uri "$Api/__sandbox/usage?userId=$script:UserId").rows)
  Add-Check $scenario "ingested usage stored in the sandbox" ($usage.Count -gt 0) "$($usage.Count) usage_days rows"
  $calls = @(Get-Content -LiteralPath (Join-Path $npxBin "calls.log") -ErrorAction SilentlyContinue | Where-Object { $_ -match " npx pid=" })
  Copy-Item -LiteralPath (Join-Path $npxBin "calls.log") -Destination (Join-Path $OutDir "npx-calls.log") -ErrorAction SilentlyContinue
  Add-Check $scenario "ccusage ran through npx.cmd with its version range intact" ($calls.Count -gt 0 -and @($calls | Where-Object { $_ -notmatch " -y ccusage@\^" }).Count -eq 0) "$($calls.Count) calls; first: $($calls | Select-Object -First 1)"
  Assert-Uninstall $scenario
}

# Node only from a version manager: fnm puts each shell's node on PATH through a junction under
# %LOCALAPPDATA%\fnm_multishells\<id> and drops it with the shell, so a wrapper must keep fnm's
# default alias instead. 0.6.0 wrappers baked the junction in; the reload-required repair that
# migrates them re-captures PATH from that wrapper after the junction is gone, and finds fnm's node
# only through fnm's own data dir (%APPDATA%\fnm), since the wrapper never exports FNM_DIR.
function Invoke-VersionManagerNode {
  $scenario = "version-manager node"
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { Add-Check $scenario "node on PATH" $false "no node.exe"; return }
  $fnm = Join-Path $env:APPDATA "fnm"
  if (Test-Path -LiteralPath $fnm) { Add-Check $scenario "no fnm install to shadow" "INFO" "skipped: $fnm exists"; return }
  $installation = Join-Path $fnm "node-versions\v-e2e\installation"
  $alias = Join-Path $fnm "aliases\default"
  $multishell = Join-Path $Root "fnm_multishells\4242_1"
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $installation), (Split-Path $alias), (Split-Path $multishell) | Out-Null
    New-Item -ItemType Junction -Path $installation -Target (Split-Path $node.Source) | Out-Null
    New-Item -ItemType Junction -Path $alias -Target $installation | Out-Null
    if (Test-Path -LiteralPath $multishell) { [System.IO.Directory]::Delete($multishell) }
    New-Item -ItemType Junction -Path $multishell -Target $installation | Out-Null
    $withoutNode = @($BasePath -split ";" | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ "node.exe")) })
    $env:PATH = (@($FakeBin, $multishell, $TmxBin) + $withoutNode) -join ";"
    $resolved = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    Add-Check $scenario "node only from the per-shell junction" ($resolved -like "$multishell\*") "node: $resolved"
    New-Profile (Join-Path $Root "cfg-version-manager")
    if (-not (Install-Service $scenario)) { return }
    $wrapperPath = Config-File "service-sync.cmd"
    $pathEntries = { @(((Get-Content -LiteralPath $wrapperPath | Where-Object { $_ -like 'set "PATH=*' }) | Select-Object -First 1) -replace '^set "PATH=|"$', "" -split ";") }
    $entries = & $pathEntries
    Add-Check $scenario "install writes fnm's default alias, not the per-shell junction" (($entries -contains $alias) -and -not ($entries -contains $multishell)) ($entries -join ";")

    # A 0.6.0 wrapper: the junction baked in, and gone since its shell exited.
    $legacy = (Get-Content -LiteralPath $wrapperPath -Raw).Replace(";$alias;", ";$multishell;")
    [System.IO.File]::WriteAllText($wrapperPath, $legacy, (New-Object System.Text.UTF8Encoding $false))
    $entries = & $pathEntries
    Add-Check $scenario "wrapper rewritten with the junction, as 0.6.0 wrote it" (($entries -contains $multishell) -and -not ($entries -contains $alias)) ($entries -join ";")
    [System.IO.Directory]::Delete($multishell)
    # A new shell gets node through fnm's default alias.
    $env:PATH = (@($FakeBin, $alias, $TmxBin) + $withoutNode) -join ";"
    Set-TemplateVersion ($TemplateVersion - 1)
    $repairRun = Invoke-TaskRun "version-manager-reload" { $state = Wait-RepairFinished; "status=$($state.lastRepairStatus) reason=$($state.lastRepairReason) error=$($state.lastRepairError)" } -Repairs "reload-required"
    $entries = & $pathEntries
    Add-Check $scenario "the repair maps the gone junction to fnm's default alias" (($entries -contains $alias) -and -not ($entries -contains $multishell)) "repair: $($repairRun.after); PATH: $($entries -join ';')"
    $run = Invoke-TaskRun "version-manager-run"
    Assert-SuccessfulRun $scenario $run -AllowCooldown
    Assert-NoWindow $scenario $run
    Assert-Uninstall $scenario
  } finally {
    foreach ($link in @($multishell, $alias, $installation)) { if (Test-Path -LiteralPath $link) { [System.IO.Directory]::Delete($link) } }
    Remove-Item -LiteralPath $fnm -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Core {
  $scenario = "core"
  New-Profile (Join-Path $Root "cfg-core")
  if (-not (Install-Service $scenario)) { return }
  Assert-TaskAction $scenario "wscript"
  Assert-TaskDefinition $scenario "core"
  Assert-Launcher $scenario
  $meta = Read-ConfigJson "service.json"
  Add-Check $scenario "service.json at template $TemplateVersion" ($meta.templateVersion -eq $TemplateVersion) "templateVersion=$($meta.templateVersion) runner=$($meta.runnerPath) target=$($meta.runnerTarget)"
  Copy-Item -LiteralPath (Config-File "service-sync.vbs") -Destination (Join-Path $OutDir "core-service-sync.vbs.txt") -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath (Config-File "service-sync.cmd") -Destination (Join-Path $OutDir "core-service-sync.cmd.txt") -ErrorAction SilentlyContinue

  $run = Invoke-TaskRun "core-run"
  Assert-SuccessfulRun $scenario $run
  Assert-NoWindow $scenario $run
  $usage = @((Invoke-RestMethod -Uri "$Api/__sandbox/usage?userId=$script:UserId").rows)
  Add-Check $scenario "ingested usage stored in the sandbox" ($usage.Count -gt 0) "$($usage.Count) usage_days rows: $(($usage | ForEach-Object { "$($_.date)/$($_.source)" }) -join ', ')"
  if ($run.lastResult -ne "0") {
    $diagnostic = (cmd.exe /d /c "`"$(Config-File 'service-sync.cmd')`"" 2>&1 | Out-String)
    Add-Check $scenario "wrapper run by hand (diagnostic)" "INFO" "exit $LASTEXITCODE; $(Format-OneLine $diagnostic 900)"
  }

  # Error paths keep their exit codes through the launcher, without a window.
  $pointer = Config-File "service-runner-current"
  $runnerPath = (Get-Content -LiteralPath $pointer -Raw).Trim()
  Rename-Item -LiteralPath $pointer -NewName "service-runner-current.bak"
  $errRun = Invoke-TaskRun "core-no-pointer"
  Rename-Item -LiteralPath "$pointer.bak" -NewName "service-runner-current"
  Add-Check $scenario "Last Result 127 when the runner pointer is missing" ($errRun.lastResult -eq "127" -and $errRun.logDelta -match "runner pointer is empty") "Last Result=$($errRun.lastResult); $(Format-OneLine $errRun.logDelta)"
  Assert-NoWindow $scenario $errRun

  Rename-Item -LiteralPath $runnerPath -NewName "tokenmaxxing.exe.bak"
  $errRun = Invoke-TaskRun "core-no-runner"
  Rename-Item -LiteralPath "$runnerPath.bak" -NewName (Split-Path $runnerPath -Leaf)
  Add-Check $scenario "Last Result 127 when the runner is missing" ($errRun.lastResult -eq "127" -and $errRun.logDelta -match "runner missing") "Last Result=$($errRun.lastResult); $(Format-OneLine $errRun.logDelta)"
  Assert-NoWindow $scenario $errRun

  Rename-Item -LiteralPath (Config-File "service-sync.cmd") -NewName "service-sync.cmd.bak"
  $errRun = Invoke-TaskRun "core-no-wrapper"
  Rename-Item -LiteralPath (Config-File "service-sync.cmd.bak") -NewName "service-sync.cmd"
  Add-Check $scenario "Last Result nonzero when the wrapper is missing" ($errRun.lastResult -notin @("0", "", $null)) "Last Result=$($errRun.lastResult)"
  Assert-NoWindow $scenario $errRun

  # status / doctor / repair around the launcher.
  $status = ConvertFrom-CliJson (Tmx @("service", "status", "--json")).out
  Add-Check $scenario "status --json reports the launcher" ($status.launcherPath -eq (Config-File "service-sync.vbs") -and $status.launcherStatus -eq "current") "launcherPath=$($status.launcherPath) launcherStatus=$($status.launcherStatus) installed=$($status.installed) reloadRequired=$($status.reloadRequired)"
  $launcherLine = { ((Tmx @("service", "doctor")).out -split "\r?\n" | Where-Object { $_ -match '\blauncher\b' } | Select-Object -First 1) }
  # Any WARN or FAIL check makes doctor exit 1, so a healthy install must exit 0.
  $doctor = Tmx @("service", "doctor")
  $problems = @($doctor.out -split "\r?\n" | Where-Object { $_ -match '^\s*(WARN|FAIL)\s' })
  Add-Check $scenario "doctor: exit 0 with no WARN or FAIL check" ($doctor.code -eq 0 -and $problems.Count -eq 0) "exit $($doctor.code): $(Format-OneLine ($problems -join ' | ') 600)"
  $line = & $launcherLine
  Add-Check $scenario "doctor: OK launcher" ($line -match '^\s*OK\s+launcher\s+.*service-sync\.vbs') "$line"

  Remove-Item -LiteralPath (Config-File "service-sync.vbs") -Force
  $doctor = Tmx @("service", "doctor")
  $line = ($doctor.out -split "\r?\n" | Where-Object { $_ -match '\blauncher\b' } | Select-Object -First 1)
  Add-Check $scenario "doctor: FAIL launcher missing, exit 1" ($line -match '^\s*FAIL\s+launcher\s+.*missing; repair with tokenmaxxing service repair' -and $doctor.code -eq 1) "exit $($doctor.code): $line"
  $status = ConvertFrom-CliJson (Tmx @("service", "status", "--json")).out
  Add-Check $scenario "status --json launcherStatus=missing" ($status.launcherStatus -eq "missing") "launcherStatus=$($status.launcherStatus)"
  # wscript //B must fail silently, never with an error dialog.
  $missingRun = Invoke-TaskRun "core-no-launcher"
  Add-Check $scenario "task with the launcher deleted fails" ($missingRun.lastResult -notin @("0", "", $null)) "Last Result=$($missingRun.lastResult)"
  Assert-NoWindow $scenario $missingRun
  $repair = Tmx @("service", "repair", "--json")
  Add-Check $scenario "service repair restores the launcher" ($repair.code -eq 0 -and (Test-Path -LiteralPath (Config-File "service-sync.vbs"))) "exit $($repair.code): $(Format-OneLine $repair.out)"
  Assert-TaskAction $scenario "wscript"
  Assert-Launcher $scenario

  Set-Content -LiteralPath (Config-File "service-sync.vbs") -Value "WScript.Quit 0" -Encoding ascii
  $line = & $launcherLine
  Add-Check $scenario "doctor: WARN launcher outdated" ($line -match '^\s*WARN\s+launcher\s+.*outdated') "$line"
  $repair = Tmx @("service", "repair", "--json")
  $line = & $launcherLine
  Add-Check $scenario "service repair rewrites an outdated launcher" ($repair.code -eq 0 -and $line -match '^\s*OK\s+launcher') "$line"
  $run = Invoke-TaskRun "core-after-repair"
  Assert-SuccessfulRun $scenario $run
  Assert-NoWindow $scenario $run

  # A run killed with taskkill /F (or a crash, or a power loss) leaves its lock
  # behind. The next run takes it over once that pid is gone, instead of
  # skipping every sync until the lock goes stale 2 hours later. This is the
  # Windows check that process.kill(pid, 0) tells a dead pid from a live one.
  $dead = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /c exit" -WindowStyle Hidden -PassThru
  $dead.WaitForExit()
  $lock = @{ acquiredAt = (Get-Date).ToUniversalTime().ToString("o"); hostname = $env:COMPUTERNAME; ownerId = "killed"; pid = $dead.Id; version = 1 } | ConvertTo-Json -Compress
  Set-Content -LiteralPath (Config-File "service.lock") -Value $lock -Encoding utf8NoBOM
  $doctor = Tmx @("service", "doctor")
  $deadLine = ($doctor.out -split "\r?\n" | Where-Object { $_ -match '\block\b' } | Select-Object -First 1)
  Add-Check $scenario "doctor: a dead pid's lock is taken over by the next run (INFO, exit 0)" ($deadLine -match "^\s*INFO\s+lock\s+.*pid $($dead.Id) is gone" -and $doctor.code -eq 0) "exit $($doctor.code): $deadLine"
  $lockRun = Invoke-TaskRun "core-dead-lock"
  Assert-SuccessfulRun $scenario $lockRun -AllowCooldown
  Add-Check $scenario "the run took over the dead pid's lock and released it" (-not (Test-Path -LiteralPath (Config-File "service.lock"))) "lock left: $(if (Test-Path -LiteralPath (Config-File 'service.lock')) { Get-Content -LiteralPath (Config-File 'service.lock') -Raw } else { 'none' })"
  Assert-NoWindow $scenario $lockRun

  # A failed sync (revoked token) spawns a hidden service-failure repair.
  Invoke-RestMethod -Method Post -Uri "$Api/__sandbox/revoke" -ContentType "application/json" -Body (@{ userId = $script:UserId; revoked = $true } | ConvertTo-Json) | Out-Null
  $failRun = Invoke-TaskRun "core-service-failure" { $state = Wait-RepairFinished; "status=$($state.lastRepairStatus) error=$($state.lastRepairError)" } -Repairs "service-failure"
  Invoke-RestMethod -Method Post -Uri "$Api/__sandbox/revoke" -ContentType "application/json" -Body (@{ userId = $script:UserId; revoked = $false } | ConvertTo-Json) | Out-Null
  $state = Read-ConfigJson "service-state.json"
  Add-Check $scenario "failed sync runs a service-failure repair" ($state.lastRepairReason -eq "service-failure" -and $state.lastRepairStatus -eq "success") "Last Result=$($failRun.lastResult) reason=$($state.lastRepairReason) status=$($state.lastRepairStatus) error=$($state.lastRepairError) lastError=$(Format-OneLine "$($state.lastError)" 200)"
  $helpers = @($failRun.watch.processes | Where-Object { $_.commandLine -match ' repair' } | ForEach-Object { "$($_.name)<-$($_.ppid): $($_.commandLine)" })
  Add-Check $scenario "repair helper runs through the launcher" (@($helpers -match 'wscript\.exe.*service-sync\.vbs.* repair service-failure').Count -gt 0) "$($helpers -join ' || ')"
  Assert-TaskAction $scenario "wscript"
  Assert-NoWindow $scenario $failRun

  Invoke-ReloadRequiredRepair $scenario "core"
  Assert-Uninstall $scenario
}

function Get-LogSize([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-Item -LiteralPath $Path).Length } else { 0 } }

# What a log gained since it was $Before bytes long.
function Read-LogFrom([string]$Path, [long]$Before = 0) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -le $Before) { return "" }
  [System.Text.Encoding]::UTF8.GetString($bytes, [int]$Before, $bytes.Length - [int]$Before)
}

# Waits until a schtasks /Run that started after $Before has finished.
function Wait-TaskFinished($Before, [int]$Seconds = 180) {
  $task = $Before
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $task = Get-Task
    if ($task["Status"] -eq "Running") { continue }
    # 267009 = SCHED_S_TASK_RUNNING
    if ($task["Last Run Time"] -ne $Before["Last Run Time"] -and $task["Last Result"] -ne "267009") { break }
  }
  $task
}

# Runs that overlap. Task Scheduler never starts the task while an instance
# runs (MultipleInstancesPolicy IgnoreNew), but the wrapper run by hand, or a
# run left going after the task was ended, overlaps it. cmd holds service.log
# for a whole run, so an overlapping run logs to service-overlap-N.log.
function Invoke-Overlap {
  $scenario = "overlapping runs"
  New-Profile (Join-Path $Root "cfg-overlap")
  if (-not (Install-Service $scenario)) { return }
  $logPath = Config-File "service.log"
  $sideLog = Config-File "service-overlap-1.log"

  # (1) Another process holds an oversized service.log the way cmd's >> does
  # (write access, read sharing only). The run logs to the first side log and
  # leaves the rotations alone.
  $file = [System.IO.File]::Create($logPath)
  $file.SetLength(5MB + 1)
  $file.Dispose()
  Set-Content -LiteralPath "$logPath.1" -Value "rotation 1" -Encoding ascii
  $hold = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
  $run = Invoke-TaskRun "overlap-held-log" { $hold.Dispose(); Read-LogFrom $sideLog }
  $hold.Dispose()
  $line = ($run.after -split "\r?\n" | Where-Object { $_ -match '"event":"service_run"' } | Select-Object -Last 1)
  Add-Check $scenario "Last Result 0 with service.log held" ($run.lastResult -eq "0") "Last Result=$($run.lastResult)"
  Add-Check $scenario "the run logs to service-overlap-1.log" ($run.after -match "tokenmaxxing service sync" -and $run.after -match "service\.log is in use by another run" -and $line -match '"status":"success"') (Format-OneLine $run.after 900)
  $rotations = @(1..3 | ForEach-Object { if (Test-Path -LiteralPath "$logPath.$_") { "$_=$((Get-Content -LiteralPath "$logPath.$_" -Raw).Trim())" } })
  Add-Check $scenario "a held log is neither written nor rotated" ((Get-LogSize $logPath) -eq 5MB + 1 -and ($rotations -join ",") -eq "1=rotation 1") "service.log bytes=$(Get-LogSize $logPath) rotations=[$($rotations -join ', ')]"
  Assert-NoWindow $scenario $run
  Get-ChildItem -LiteralPath $env:TOKENMAXXING_CONFIG_DIR -Filter "service*.log*" | Remove-Item -Force

  # (2) Three runs at once: the task, a second schtasks /Run while it runs,
  # and two runs of the launcher by hand. Exactly one syncs; every run that
  # started leaves a log entry.
  Update-AgentLogs
  $requestsBefore = (Get-Requests).Count
  $before = Get-Task
  $watcher = Start-Watcher "overlap-concurrent"
  $runOut = (schtasks /Run /TN $TaskName 2>&1 | Out-String).Trim()
  $locked = Wait-Until { Test-Path -LiteralPath (Config-File "service.lock") } 30
  $againOut = (schtasks /Run /TN $TaskName 2>&1 | Out-String).Trim()
  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $manual = @(1..2 | ForEach-Object {
      Start-Process -FilePath $wscript -ArgumentList "//B //NoLogo //E:VBScript `"$(Config-File 'service-sync.vbs')`"" -PassThru
    })
  $manualCodes = @($manual | ForEach-Object { if ($_.WaitForExit(180000)) { $_.ExitCode } else { "timeout" } })
  $task = Wait-TaskFinished $before
  Start-Sleep -Seconds 2
  # Every root is a wscript.exe the watcher saw start: the task's and the two
  # the harness started.
  $concurrent = [pscustomobject]@{ label = "overlap-concurrent"; action = "wscript"; repairs = @(); watch = (Stop-Watcher $watcher) }
  Write-E2ELog "concurrent runs: schtasks /Run ($runOut), lock seen=$locked, second /Run ($againOut), manual exits=[$($manualCodes -join ', ')]"

  $logs = [ordered]@{}
  Get-ChildItem -LiteralPath $env:TOKENMAXXING_CONFIG_DIR -Filter "service*.log" | Sort-Object Name | ForEach-Object { $logs[$_.Name] = Read-LogFrom $_.FullName }
  $all = ($logs.Values -join "`n")
  Set-Content -LiteralPath (Join-Path $OutDir "overlap-concurrent-service-logs.txt") -Value (($logs.Keys | ForEach-Object { "==== $_`n$($logs[$_])" }) -join "`n") -Encoding utf8
  $headers = ([regex]::Matches($all, "tokenmaxxing service sync")).Count
  $events = @($all -split "\r?\n" | Where-Object { $_ -match '"event":"service_run"' })
  $synced = @($events | Where-Object { $_ -match '"status":"success"' }).Count
  $skipped = @($events | Where-Object { $_ -match '"status":"skipped"' -and $_ -match '"reason":"locked"' }).Count
  $perLog = ($logs.Keys | ForEach-Object { "$_ headers=$(([regex]::Matches($logs[$_], 'tokenmaxxing service sync')).Count)" }) -join "; "
  Add-Check $scenario "the task and both runs by hand exit 0" ($task["Last Result"] -eq "0" -and ($manualCodes -join ",") -eq "0,0") "Last Result=$($task['Last Result']) manual=[$($manualCodes -join ', ')]"
  # IgnoreNew: the second schtasks /Run starts no instance, so three entries, not four.
  Add-Check $scenario "every run leaves one log entry; the second schtasks /Run starts none" ($headers -eq 3 -and $events.Count -eq 3) "headers=$headers service_run=$($events.Count); $perLog"
  Add-Check $scenario "exactly one run syncs; the others log a locked skip" ($synced -eq 1 -and $skipped -eq 2) "success=$synced skipped=$skipped; $(Format-OneLine ($events -join ' || ') 900)"
  $ingests = @(Get-Requests | Select-Object -Skip $requestsBefore | Where-Object { $_.path -eq "/usage/ingest" -and $_.status -eq 200 }).Count
  Add-Check $scenario "the sandbox got the one sync's ingest" ($ingests -ge 1) "ingests=$ingests"
  Add-Check $scenario "the lock is released" (-not (Test-Path -LiteralPath (Config-File "service.lock"))) "lock left: $(if (Test-Path -LiteralPath (Config-File 'service.lock')) { Get-Content -LiteralPath (Config-File 'service.lock') -Raw } else { 'none' })"
  Assert-NoWindow $scenario $concurrent
  $roots = @(Get-RunRoots $concurrent).Count
  Add-Check $scenario "the watcher saw all three launchers" ($roots -eq 3) "wscript roots=$roots; $(Format-WatchedProcesses $concurrent.watch.processes)"

  $doctor = Tmx @("service", "doctor")
  $problems = @($doctor.out -split "\r?\n" | Where-Object { $_ -match '^\s*(WARN|FAIL)\s' })
  Add-Check $scenario "doctor: exit 0 with no WARN or FAIL check" ($doctor.code -eq 0 -and $problems.Count -eq 0) "exit $($doctor.code): $(Format-OneLine ($problems -join ' | ') 600)"
  Assert-Uninstall $scenario
}

function Invoke-PathCase([string]$Scenario, [string]$ConfigDir) {
  $label = Get-ScenarioLabel $Scenario
  New-Profile $ConfigDir
  if (-not (Install-Service $Scenario)) { return }
  Assert-TaskAction $Scenario "wscript"
  Assert-TaskDefinition $Scenario $label
  Assert-Launcher $Scenario
  $run = Invoke-TaskRun "$label-run"
  Assert-SuccessfulRun $Scenario $run
  Assert-NoWindow $Scenario $run
  if ($run.lastResult -eq "0") { Invoke-ReloadRequiredRepair $Scenario $label }
  Assert-Uninstall $Scenario
}

# A release from before the hidden launcher, installed like a global install.
function Install-Legacy([string]$Scenario, [string]$ConfigDir) {
  Use-Cli $LegacyBin
  New-Profile $ConfigDir
  if (-not (Install-Service $Scenario)) { return $false }
  Assert-TaskAction $Scenario "cmd"
  $meta = Read-ConfigJson "service.json"
  Add-Check $Scenario "legacy install is below template $TemplateVersion" ($meta.templateVersion -lt $TemplateVersion) "templateVersion=$($meta.templateVersion) runnerVersion=$($meta.runnerVersion)"
  $true
}

function Invoke-LegacyUpgrade {
  # (1) Runner auto-update: the next scheduled run under the old .cmd task
  # reports reload-required and its hidden deferred repair re-registers the
  # task through the launcher before the following run.
  $scenario = "legacy upgrade (auto-update)"
  if (-not (Install-Legacy $scenario (Join-Path $Root "cfg-legacy"))) { return }
  $legacyRun = Invoke-TaskRun "legacy-task"
  Assert-SuccessfulRun $scenario $legacyRun
  # Positive control: the legacy task runs the .cmd directly, so in an
  # interactive session it MUST show a console. If the watcher sees nothing
  # here, every "no window" check in this run is blind.
  $seen = Get-RunWindows $legacyRun
  Add-Check $scenario "window watcher sees the legacy task's console (positive control)" ($seen.windows.Count -gt 0) $seen.detail
  Assert-WatcherSawRun $scenario $legacyRun

  $runnerPath = (Get-Content -LiteralPath (Config-File "service-runner-current") -Raw).Trim()
  Copy-Item -LiteralPath $RunnerExe -Destination $runnerPath -Force
  $reloadRun = Invoke-TaskRun "legacy-reload-required" {
    Wait-Until { (Get-Task)["Task To Run"] -match $WscriptPattern -and (Read-ConfigJson "service.json").templateVersion -eq $TemplateVersion } 90 | Out-Null
    Start-Sleep -Seconds 3
    "Task To Run=$((Get-Task)['Task To Run']) templateVersion=$((Read-ConfigJson 'service.json').templateVersion)"
  } -Repairs "reload-required"
  # The repair re-creates the task, so Last Result may already belong to the
  # new, never-run task (267011 = SCHED_S_TASK_HAS_NOT_RUN).
  $line = Get-ServiceRunLine $reloadRun
  Add-Check $scenario "upgraded runner syncs under the old task" ($reloadRun.lastResult -in @("0", "267011") -and $line -match '"status":"success"') "Last Result=$($reloadRun.lastResult); $(Format-OneLine $line 500)"
  Add-Check $scenario "run reports reloadRequired" ($line -match '"reloadRequired":true') (Format-OneLine $line 500)
  # Still the old task, so its console shows; the watcher must see the repair.
  Assert-WatcherSawRun $scenario $reloadRun
  # cmd.exe re-reads a running batch file, so the repair must wait for the old
  # wrapper to exit before rewriting it: exactly one clean log entry.
  $headers = ([regex]::Matches($reloadRun.logDelta, "tokenmaxxing service sync")).Count
  Add-Check $scenario "old wrapper exits cleanly before the rewrite" ($headers -eq 1 -and $reloadRun.logDelta -notmatch "not recognized|was unexpected") "sync headers=$headers; $(Format-OneLine $reloadRun.logDelta 300)"
  Add-Check $scenario "deferred repair re-registers the task through wscript" ($reloadRun.after -match "templateVersion=$TemplateVersion$" -and $reloadRun.after -match 'wscript') "$($reloadRun.after)"
  Assert-Launcher $scenario
  $nextRun = Invoke-TaskRun "legacy-after-upgrade"
  Assert-SuccessfulRun $scenario $nextRun -AllowCooldown
  Assert-NoWindow $scenario $nextRun
  Tmx @("service", "uninstall", "--json") | Out-Null

  # (2) `service repair` from the new CLI migrates a legacy install at once.
  $scenario = "legacy upgrade (service repair)"
  if (-not (Install-Legacy $scenario (Join-Path $Root "cfg-legacy-repair"))) { return }
  Use-Cli $TmxBin
  $repair = Tmx @("service", "repair", "--json")
  Add-Check $scenario "service repair" ($repair.code -eq 0) (Format-OneLine $repair.out)
  Assert-TaskAction $scenario "wscript"
  Assert-Launcher $scenario
  Add-Check $scenario "service.json at template $TemplateVersion" ((Read-ConfigJson "service.json").templateVersion -eq $TemplateVersion) "templateVersion=$((Read-ConfigJson 'service.json').templateVersion)"
  $run = Invoke-TaskRun "legacy-repaired"
  Assert-SuccessfulRun $scenario $run
  Assert-NoWindow $scenario $run
  Assert-Uninstall $scenario
}

# `service install` and `uninstall` run by the service runner exe itself, as a
# user who found it in the config dir would. Windows never deletes the image of
# a running process, so uninstall retires the runners dir aside and a hidden
# wscript.exe deletes it once the exe exits.
function Invoke-UninstallFromRunner {
  $scenario = "uninstall from the runner"
  New-Profile (Join-Path $Root "cfg-uninstall-runner")
  if (-not (Install-Service $scenario)) { return }
  $runner = (Get-Content -LiteralPath (Config-File "service-runner-current") -Raw).Trim()

  # A reinstall from the runner keeps the running exe: it is already the current runner.
  $reinstall = Invoke-Logged "runner: service install --json" { & $runner service install --json }
  $pointer = (Get-Content -LiteralPath (Config-File "service-runner-current") -Raw).Trim()
  Add-Check $scenario "service install from the runner over its own service" ($reinstall.code -eq 0 -and $pointer -eq $runner) "exit $($reinstall.code) runner=$pointer; $(Format-OneLine $reinstall.out)"

  # Started through Start-Process so its pid roots the process tree the
  # watcher attributes windows to, as for the watcher's own controls.
  $label = "uninstall-from-runner"
  $watcher = Start-Watcher $label
  $stdout = Join-Path $OutDir "$label.stdout.txt"
  $stderr = Join-Path $OutDir "$label.stderr.txt"
  $uninstallProcess = Start-Process -FilePath $runner -ArgumentList "service uninstall --json" -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null = $uninstallProcess.Handle # keeps ExitCode readable after the exit
  $uninstallProcess.WaitForExit()
  $uninstallOut = "$(Get-Content -LiteralPath $stdout -Raw)$(Get-Content -LiteralPath $stderr -Raw)".Trim()
  Write-E2ELog "---- runner: service uninstall --json (exit $($uninstallProcess.ExitCode))`n$uninstallOut"
  $json = ConvertFrom-CliJson $uninstallOut
  Add-Check $scenario "service uninstall from the runner" ($uninstallProcess.ExitCode -eq 0 -and $json.status -eq "ok") "exit $($uninstallProcess.ExitCode): $(Format-OneLine $uninstallOut)"
  $pending = @($json.pendingRemoval)
  Add-Check $scenario "the running runner is retired aside" ($pending.Count -eq 1 -and $pending[0] -match '\\service-runners\.retired-[0-9a-f]{8}$' -and -not (Test-Path -LiteralPath (Config-File "service-runners"))) "pendingRemoval=$($pending -join ', ')"
  $task = Get-Task
  Add-Check $scenario "task removed" ($task._exit -ne 0) (Format-OneLine $task._raw 200)

  $status = ConvertFrom-CliJson (Tmx @("service", "status", "--json")).out
  Add-Check $scenario "status: not installed, no runner issue" ($status.installed -eq $false -and $null -eq $status.runnerIssue -and $null -eq $status.runnerPath) "installed=$($status.installed) runnerIssue=$($status.runnerIssue) runnerPath=$($status.runnerPath)"
  $doctor = Tmx @("service", "doctor")
  $problems = @($doctor.out -split "\r?\n" | Where-Object { $_ -match '^\s*(WARN|FAIL)\s' })
  Add-Check $scenario "doctor: not installed is its only problem" ($problems.Count -eq 1 -and $problems[0] -match '^\s*FAIL\s+scheduler\s+not installed') "exit $($doctor.code): $(Format-OneLine ($problems -join ' | ') 600)"

  $cleaned = Wait-Until { @(Get-ChildItem -LiteralPath $env:TOKENMAXXING_CONFIG_DIR -Force -Filter "service-runners*").Count -eq 0 } 30
  $left = @(Get-ChildItem -LiteralPath $env:TOKENMAXXING_CONFIG_DIR -Force | ForEach-Object Name)
  Add-Check $scenario "no runner files left after a short wait" $cleaned "config dir: $($left -join ', ')"
  $extra = @($left | Where-Object { $_ -notmatch '^(config\.json|service\.log(\.\d+)?)$' })
  Add-Check $scenario "only config.json and the service log remain" ($extra.Count -eq 0) "left: $($left -join ', ')"
  $watch = Stop-Watcher $watcher
  if ($null -eq $watch) { Add-Check $scenario "no window or focus change ($label)" $false "window watcher wrote no summary"; return }
  $processes = @($watch.processes)
  # The cleanup is a wscript.exe the runner started; its command line is read
  # only if a source reported the start while it still ran, which its 1 s wait allows.
  $cleanup = @($processes | Where-Object { $_.name -eq "wscript.exe" -and (Get-ParentProcess $processes $_).pid -eq $uninstallProcess.Id })
  $cleanupScript = @($cleanup | Where-Object { $null -eq $_.commandLine -or $_.commandLine -match 'service-runners\.retired-[0-9a-f]{8}\.vbs"?$' })
  Add-Check $scenario "cleanup ran through a wscript.exe started by the runner" ((Test-WatcherLive $watch) -and $cleanupScript.Count -gt 0) "$(Format-WatchSources $watch) runner=#$($uninstallProcess.Id) seen=[$(Format-WatchedProcesses $processes)]"
  $seen = Get-RunWindows ([pscustomobject]@{ watch = $watch; rootPids = @($uninstallProcess.Id) })
  Add-Check $scenario "no window or focus change ($label)" ($seen.windows.Count -eq 0 -and $seen.focus.Count -eq 0) $seen.detail
}

# A scenario that throws records a FAIL and the next scenario still runs.
# With -Only, a scenario not listed is skipped.
function Invoke-Scenario([string]$Name, [scriptblock]$Body) {
  if ($Only.Count -gt 0 -and $Name -notin $Only) { return }
  try { & $Body } catch {
    Add-Check $Name "scenario ran to completion" $false "$($_.Exception.Message) $(Format-OneLine $_.InvocationInfo.PositionMessage 300)"
  }
}

# ------------------------------------------------------------ main
Use-Cli $TmxBin
$version = Tmx @("--version")
Add-Check "setup" "tokenmaxxing --version" ($version.code -eq 0) "$(Format-OneLine $version.out) ($((Get-Command tokenmaxxing -ErrorAction SilentlyContinue).Source))"
schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null

Invoke-Scenario "window watcher" { Invoke-WatcherControls }
Invoke-Scenario "core" { Invoke-Core }
Invoke-Scenario "npx fallback" { Invoke-NpxFallback }
Use-Cli $TmxBin
Invoke-Scenario "version-manager node" { Invoke-VersionManagerNode }
Use-Cli $TmxBin
Invoke-Scenario "overlapping runs" { Invoke-Overlap }

# Trimmed from the original harness: plain spaces and "Zoë (Work)" are
# covered by the cases below.
$zoe = "Zo" + [char]0x00EB
$pathCases = [ordered]@{
  "path with parentheses (Tm (Work))" = "Tm (Work)\tm"
  "path with ampersand + apostrophe (Tm & Co's)" = "Tm & Co's\tm"
  "non-ASCII path (Zoe)" = "$zoe\tm"
  "everything path (Zoe O'Neil (Work) & Co 100%)" = "$zoe O'Neil (Work) & Co 100%\tm"
}
foreach ($case in $pathCases.Keys) {
  Use-Cli $TmxBin
  Invoke-Scenario $case { Invoke-PathCase $case (Join-Path $Root $pathCases[$case]) }
}

if ($LegacyBin) {
  Invoke-Scenario "legacy upgrade" { Invoke-LegacyUpgrade }
} elseif ($Only.Count -eq 0 -or "legacy upgrade" -in $Only) {
  Add-Check "legacy upgrade" "legacy release available" $false "no -LegacyBin"
}
Use-Cli $TmxBin
Invoke-Scenario "uninstall from the runner" { Invoke-UninstallFromRunner }
schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null
# run-service-e2e.ps1 fails the job if this marker is missing.
Add-Check "service" "all scenarios ran" $true "$((Get-Content -LiteralPath $script:E2EResults).Count) checks recorded"
