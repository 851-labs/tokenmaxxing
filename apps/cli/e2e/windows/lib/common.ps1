# Shared helpers for the Windows e2e scripts. Dot-source this file, then call
# Initialize-E2E once.
#
# Every check is one JSON line in <OutDir>/results.jsonl:
#   { suite, scenario, check, status, detail }
# status is PASS, FAIL or INFO. A check tied to a known issue records XFAIL
# when it fails as expected, and XPASS when it passes: XPASS fails the run so
# the known-issue entry gets removed once the fix lands. summarize.ps1 renders
# the file into the GitHub step summary.

function Initialize-E2E {
  param([Parameter(Mandatory)] [string]$OutDir, [Parameter(Mandatory)] [string]$Suite)
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $script:E2EOutDir = $OutDir
  $script:E2ESuite = $Suite
  $script:E2EResults = Join-Path $OutDir "results.jsonl"
  $script:E2ELog = Join-Path $OutDir "$Suite.log"
}

function Write-E2ELog([string]$Text) {
  $Text | Add-Content -LiteralPath $script:E2ELog -Encoding utf8
  Write-Host $Text
}

# $Pass: $true/$false, or "INFO" for a record-only row.
function Add-Check {
  param(
    [Parameter(Mandatory)] [string]$Scenario,
    [Parameter(Mandatory)] [string]$Check,
    [Parameter(Mandatory)] [AllowNull()] [AllowEmptyString()] [AllowEmptyCollection()] $Pass,
    [string]$Detail = "",
    [string]$KnownIssue = ""
  )
  $status = if ($Pass -is [string]) { $Pass }
    elseif ($KnownIssue) { if ($Pass) { "XPASS" } else { "XFAIL" } }
    elseif ($Pass) { "PASS" } else { "FAIL" }
  if ($KnownIssue) { $Detail = "[known issue $KnownIssue] $Detail" }
  [ordered]@{ suite = $script:E2ESuite; scenario = $Scenario; check = $Check; status = $status; detail = $Detail } |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $script:E2EResults -Encoding utf8
  $line = "$status [$Scenario] $Check :: $Detail"
  if ($status -in @("FAIL", "XPASS")) { Write-Host "::error::$line" }
  Write-E2ELog $line
}

function Get-FailedChecks([string]$Results = $script:E2EResults) {
  @(Get-Content -LiteralPath $Results -ErrorAction SilentlyContinue |
      ForEach-Object { $_ | ConvertFrom-Json } |
      Where-Object { $_.status -in @("FAIL", "XPASS") })
}

function Format-OneLine([string]$Text, [int]$Max = 600) {
  $flat = ($Text -replace "\r?\n", " | ").Trim()
  if ($flat.Length -gt $Max) { $flat.Substring(0, $Max) + "..." } else { $flat }
}

# Runs a native command block, logs its output and returns { code, out }.
function Invoke-Logged([string]$Label, [scriptblock]$Block) {
  $out = (& $Block 2>&1 | Out-String)
  $code = $LASTEXITCODE
  Write-E2ELog "---- $Label (exit $code)`n$out"
  [pscustomobject]@{ code = $code; out = $out.Trim() }
}

function Wait-Http([string]$Url, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-RestMethod -Uri $Url -TimeoutSec 3 | Out-Null; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

# Starts a long-lived helper (no window) with stdout/stderr in <OutDir>/<Name>.*.log.
function Start-Background([string]$Name, [string]$FilePath, [string[]]$Arguments) {
  $quoted = $Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
  Start-Process -FilePath $FilePath -ArgumentList ($quoted -join " ") -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $script:E2EOutDir "$Name.out.log") `
    -RedirectStandardError (Join-Path $script:E2EOutDir "$Name.err.log")
}

function Stop-Background($Process) {
  if ($Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
}

# Starts the local npm registry (registry-server.ts) serving the given
# package directories; returns { process, url }.
function Start-E2ERegistry([string]$Root, [string[]]$PackageDirs, [int]$Port = 4873) {
  $url = "http://127.0.0.1:$Port"
  $serverArgs = @("$PSScriptRoot\..\registry-server.ts", "--port", "$Port", "--out", (Join-Path $Root "registry")) + $PackageDirs
  $process = Start-Background "registry" "bun" $serverArgs
  if (-not (Wait-Http "$url/-/ping" 120)) {
    Get-Content -LiteralPath (Join-Path $script:E2EOutDir "registry.err.log") -ErrorAction SilentlyContinue | Write-Host
    throw "e2e registry did not start"
  }
  [pscustomobject]@{ process = $process; url = $url }
}

# These scripts register a machine-wide scheduled task, edit the hosts file
# and install global packages, so they only run on throwaway machines.
function Assert-DisposableMachine([switch]$Force) {
  if ($env:CI -ne "true" -and -not $Force) {
    throw "The Windows e2e changes machine state (scheduled task tokenmaxxing-sync, hosts file, global packages). Run it on a disposable VM with -Force, or in CI."
  }
}
