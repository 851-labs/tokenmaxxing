# Asserts that this job runs in an interactive desktop session: the console
# session, WinSta0\Default as the input desktop, and explorer.exe alongside.
# The service task is registered with schtasks' interactive token, so only in
# such a session would a console window the task opens actually be visible;
# anywhere else every "no visible window" check passes vacuously. Exits 1 if
# the session is not interactive.
#
#   session-probe.ps1 -OutDir <dir>
#
# Writes <OutDir>/session.json and a desktop screenshot.
param([Parameter(Mandatory)] [string]$OutDir)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
. (Join-Path $PSScriptRoot "lib\win32.ps1")
Initialize-E2E -OutDir $OutDir -Suite "session"

$self = Get-Process -Id $PID
$consoleSession = [TmxE2EWin32]::WTSGetActiveConsoleSessionId()
$explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $self.SessionId })
$os = Get-CimInstance Win32_OperatingSystem
$probe = [ordered]@{
  os = "$($os.Caption) $($os.Version) $($os.OSArchitecture)"
  image = "$env:ImageOS $env:ImageVersion"
  whoami = (whoami | Out-String).Trim()
  queryUser = (query user 2>&1 | Out-String).Trim()
  userInteractive = [Environment]::UserInteractive
  selfSessionId = $self.SessionId
  activeConsoleSessionId = $consoleSession
  windowStation = [TmxE2EWin32]::WindowStationName()
  threadDesktop = [TmxE2EWin32]::DesktopName()
  inputDesktop = [TmxE2EWin32]::InputDesktopName()
  explorerPids = @($explorer | ForEach-Object Id)
  wscript = Test-Path -LiteralPath "$env:SystemRoot\System32\wscript.exe"
  screenshot = Save-Screenshot (Join-Path $OutDir "session-desktop.png")
}
$probe | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir "session.json") -Encoding utf8
$probe | ConvertTo-Json -Depth 4 | Write-Host

$scenario = "interactive session"
Add-Check $scenario "UserInteractive" ($probe.userInteractive -eq $true) "$($probe.userInteractive)"
Add-Check $scenario "job runs in the active console session" ($self.SessionId -ne 0 -and $self.SessionId -eq $consoleSession) "self=$($self.SessionId) console=$consoleSession; $(Format-OneLine $probe.queryUser)"
Add-Check $scenario "WinSta0\Default is the input desktop" ($probe.windowStation -eq "WinSta0" -and $probe.inputDesktop -eq "Default") "winsta=$($probe.windowStation) desktop=$($probe.threadDesktop) input=$($probe.inputDesktop)"
Add-Check $scenario "explorer.exe runs in this session" ($explorer.Count -gt 0) "pids=$($probe.explorerPids -join ',')"
Add-Check $scenario "wscript.exe present" $probe.wscript "$env:SystemRoot\System32\wscript.exe"

$failed = Get-FailedChecks
if ($failed.Count -gt 0) {
  Write-Host "::error title=Windows e2e needs an interactive desktop::This runner's session is not interactive, so the no-visible-window checks would be meaningless. The e2e needs a GitHub-hosted Windows image with the runner user logged on at the console."
  exit 1
}

exit 0
