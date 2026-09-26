# Service scenarios for the Windows Task Scheduler backend. Run by
# run-service-e2e.ps1, which provides the installed CLI, the fake bun, the
# sandbox API and the legacy release; every check lands in results.jsonl.
#
#   core            install -> task + launcher -> scheduled run (no window) ->
#                   error paths -> status/doctor/repair -> deferred repairs -> uninstall
#   path cases      install -> run -> reload-required deferred repair -> run -> uninstall,
#                   under config paths with (), &, ', %, spaces and non-ASCII
#   legacy upgrade  a release from before the hidden launcher (template 5, task runs the
#                   .cmd directly) upgraded by runner auto-update, and by `service repair`
param(
  [Parameter(Mandatory)] [string]$Root,
  [Parameter(Mandatory)] [string]$OutDir,
  [Parameter(Mandatory)] [string]$TmxBin,
  [Parameter(Mandatory)] [string]$FakeBin,
  [Parameter(Mandatory)] [string]$Api,
  [Parameter(Mandatory)] [int]$TemplateVersion,
  [Parameter(Mandatory)] [string]$RunnerExe,
  [string]$LegacyBin = ""
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
Initialize-E2E -OutDir $OutDir -Suite "service"

$TaskName = "tokenmaxxing-sync"
$BasePath = $env:PATH
# Processes and window classes a scheduled run could show a window through.
$WatchedProcesses = @("cmd", "conhost", "OpenConsole", "WindowsTerminal", "tokenmaxxing", "wscript", "cscript", "bun", "node", "timeout")
$ConsoleClasses = @("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow", "#32770")
# The windows-11-arm image opens its own wsl.exe console now and then.
$ImageNoise = @("wsl")
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

# The registered definition (schtasks /XML): wscript + launcher arguments,
# the config dir as working directory, and the interactive-token logon.
function Assert-TaskDefinition([string]$Scenario, [string]$Label) {
  $xmlText = (schtasks /Query /TN $TaskName /XML 2>&1 | Out-String)
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

# Runs the task once under a window watcher and waits for it to finish.
# -After runs, with the watcher still up, once the task is back to Ready.
function Invoke-TaskRun([string]$Label, [scriptblock]$After = $null) {
  $logPath = Config-File "service.log"
  $logBefore = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).Length } else { 0 }
  $requestsBefore = (Get-Requests).Count
  Update-AgentLogs
  $before = Get-Task
  $stop = Join-Path $OutDir "$Label.stop"
  $ready = Join-Path $OutDir "$Label.ready"
  $watcher = Start-Process -FilePath "pwsh" -WindowStyle Hidden -PassThru -ArgumentList `
    "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\window-watch.ps1`" -OutDir `"$OutDir`" -Label `"$Label`" -StopFile `"$stop`""
  Wait-Until { Test-Path -LiteralPath $ready } 30 | Out-Null

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
  New-Item -ItemType File -Force -Path $stop | Out-Null
  if (-not $watcher.WaitForExit(30000)) { $watcher.Kill() }

  $task = Get-Task
  $logDelta = ""
  if (Test-Path -LiteralPath $logPath) {
    $bytes = [System.IO.File]::ReadAllBytes($logPath)
    if ($bytes.Length -gt $logBefore) { $logDelta = [System.Text.Encoding]::UTF8.GetString($bytes, [int]$logBefore, $bytes.Length - [int]$logBefore) }
  }
  Set-Content -LiteralPath (Join-Path $OutDir "$Label-service-log.txt") -Value $logDelta -Encoding utf8
  $summaryPath = Join-Path $OutDir "$Label-summary.json"
  $run = [pscustomobject]@{
    label = $Label
    lastResult = $task["Last Result"]
    status = $task["Status"]
    seconds = $seconds
    logDelta = $logDelta
    requests = @(Get-Requests | Select-Object -Skip $requestsBefore)
    watch = if (Test-Path -LiteralPath $summaryPath) { Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -Depth 10 } else { $null }
    after = $afterResult
  }
  Write-E2ELog "run $Label ($runOut) -> Last Result $($run.lastResult) after ${seconds}s; requests: $(($run.requests | ForEach-Object { "$($_.method) $($_.path) $($_.status)" }) -join ', ')"
  $run
}

function Get-RunWindows($Run) {
  $watch = $Run.watch
  $windows = @($watch.newVisibleWindows | Where-Object {
      $_.process -notin $ImageNoise -and ($WatchedProcesses -contains $_.process -or $ConsoleClasses -contains $_.class)
    })
  # A foreground change to one of our processes, or to a window that closed
  # before it could be described, is a stolen focus.
  $focus = @($watch.foregroundChanges | Where-Object {
      $null -eq $_.window -or $null -eq $_.window.process -or $WatchedProcesses -contains $_.window.process -or $ConsoleClasses -contains $_.window.class
    })
  $describe = { param($w) "$($w.process)#$($w.pid) class=$($w.class) title='$($w.title)' rect=$($w.rect)" }
  [pscustomobject]@{
    windows = $windows
    focus = $focus
    detail = "windows=[$(($windows | ForEach-Object { & $describe $_ }) -join '; ')] focus=[$(($focus | ForEach-Object { "$($_.t)s->$(if ($_.window) { & $describe $_.window } else { 'gone' })" }) -join '; ')] allNew=[$(($watch.newVisibleWindows | ForEach-Object { "$($_.process):$($_.class)" }) -join ', ')] allForeground=[$(($watch.foregroundChanges | ForEach-Object { "$($_.window.process):$($_.window.class)" }) -join ', ')] polls=$($watch.polls)"
  }
}

function Assert-NoWindow([string]$Scenario, $Run) {
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
  $checkIns = @($Run.requests | Where-Object { $_.path -eq "/usage/check-in" -and $_.status -eq 200 }).Count
  $ingests = @($Run.requests | Where-Object { $_.path -eq "/usage/ingest" -and $_.status -eq 200 }).Count
  if ($AllowCooldown -and $ingests -eq 0) {
    # A run seconds after the previous one may skip every source (cadence cooldown).
    Add-Check $Scenario "sandbox got a check-in; sources on cooldown ($($Run.label))" ($checkIns -ge 1 -and $line -match '"rows":0') $paths
  } else {
    Add-Check $Scenario "sandbox got check-in + ingest ($($Run.label))" ($checkIns -ge 1 -and $ingests -ge 1) $paths
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
  }
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
  $line = & $launcherLine
  Add-Check $scenario "doctor: OK launcher" ($line -match '^\s*OK\s+launcher\s+.*service-sync\.vbs') "$line"

  Remove-Item -LiteralPath (Config-File "service-sync.vbs") -Force
  $line = & $launcherLine
  Add-Check $scenario "doctor: WARN launcher missing" ($line -match '^\s*WARN\s+launcher\s+.*missing; repair with tokenmaxxing service repair') "$line"
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

  # A failed sync (revoked token) spawns a hidden service-failure repair.
  Invoke-RestMethod -Method Post -Uri "$Api/__sandbox/revoke" -ContentType "application/json" -Body (@{ userId = $script:UserId; revoked = $true } | ConvertTo-Json) | Out-Null
  $failRun = Invoke-TaskRun "core-service-failure" { $state = Wait-RepairFinished; "status=$($state.lastRepairStatus) error=$($state.lastRepairError)" }
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

  $runnerPath = (Get-Content -LiteralPath (Config-File "service-runner-current") -Raw).Trim()
  Copy-Item -LiteralPath $RunnerExe -Destination $runnerPath -Force
  $reloadRun = Invoke-TaskRun "legacy-reload-required" {
    Wait-Until { (Get-Task)["Task To Run"] -match $WscriptPattern -and (Read-ConfigJson "service.json").templateVersion -eq $TemplateVersion } 90 | Out-Null
    Start-Sleep -Seconds 3
    "Task To Run=$((Get-Task)['Task To Run']) templateVersion=$((Read-ConfigJson 'service.json').templateVersion)"
  }
  # The repair re-creates the task, so Last Result may already belong to the
  # new, never-run task (267011 = SCHED_S_TASK_HAS_NOT_RUN).
  $line = Get-ServiceRunLine $reloadRun
  Add-Check $scenario "upgraded runner syncs under the old task" ($reloadRun.lastResult -in @("0", "267011") -and $line -match '"status":"success"') "Last Result=$($reloadRun.lastResult); $(Format-OneLine $line 500)"
  Add-Check $scenario "run reports reloadRequired" ($line -match '"reloadRequired":true') (Format-OneLine $line 500)
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

# ------------------------------------------------------------ main
Use-Cli $TmxBin
$version = Tmx @("--version")
Add-Check "setup" "tokenmaxxing --version" ($version.code -eq 0) "$(Format-OneLine $version.out) ($((Get-Command tokenmaxxing -ErrorAction SilentlyContinue).Source))"
schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null

Invoke-Core

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
  Invoke-PathCase $case (Join-Path $Root $pathCases[$case])
}

if ($LegacyBin) {
  Invoke-LegacyUpgrade
} else {
  Add-Check "legacy upgrade" "legacy release available" $false "no -LegacyBin"
}
schtasks /Delete /TN $TaskName /F 2>&1 | Out-Null
