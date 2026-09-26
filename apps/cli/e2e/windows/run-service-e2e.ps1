# Windows service e2e: sets up the environment, runs service-e2e.ps1 and
# writes the summary. Everything runs in one step because the sandbox API and
# the registry must outlive every phase.
#
#   run-service-e2e.ps1 -Build <build.json> [-Root <dir>] [-OutDir <dir>] [-LegacyVersion 0.7.0-alpha.0] [-Force]
#
# 1. fake bun (fakes/) first on PATH, so scheduled runs never start real ccusage
# 2. the local API sandbox (apps/api/script/sandbox-server.ts) on 127.0.0.1:8799
# 3. the local registry serving this build; `npm install -g` from it
# 4. the pinned legacy release's runner package from registry.npmjs.org
# 5. hosts-file block for the production API and registry.npmjs.org, so no
#    scheduled run (or runner auto-update) can reach either
# 6. service-e2e.ps1, then summarize.ps1
param(
  [Parameter(Mandatory)] [string]$Build,
  [string]$Root = (Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) "tmx-e2e"),
  [string]$OutDir = (Join-Path $Root "out"),
  [string]$LegacyVersion = "0.7.0-alpha.0",
  [switch]$Force
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
Assert-DisposableMachine -Force:$Force
Initialize-E2E -OutDir $OutDir -Suite "setup"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$build = Get-Content -LiteralPath $Build -Raw | ConvertFrom-Json
$api = "http://127.0.0.1:8799"
$fakeBin = Join-Path $Root "fakebin"
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$hostsMarker = "# tokenmaxxing-e2e"
$blockedHosts = @("api.tokenmaxxing.sh", "tokenmaxxing.sh", "www.tokenmaxxing.sh", "registry.npmjs.org")
$servers = @()

function Stop-E2E {
  foreach ($server in $servers) { Stop-Background $server }
  if ($env:CI -ne "true" -and (Test-Path -LiteralPath $hostsPath)) {
    $kept = Get-Content -LiteralPath $hostsPath | Where-Object { $_ -notmatch [regex]::Escape($hostsMarker) }
    Set-Content -LiteralPath $hostsPath -Value $kept -Encoding ascii
  }
}

try {
  Write-Host "::group::fake bun + sandbox API"
  New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
  bun build --compile "$PSScriptRoot\fakes\fake-bun.ts" --outfile (Join-Path $fakeBin "bun.exe") | Out-Host
  Copy-Item -LiteralPath "$PSScriptRoot\fakes\fake-ccusage.mjs" -Destination $fakeBin -Force
  $servers += Start-Background "sandbox" "bun" @("$repo\apps\api\script\sandbox-server.ts", "--port", "8799")
  Add-Check "setup" "sandbox API up" (Wait-Http "$api/__sandbox/health" 120) $api
  Write-Host "::endgroup::"

  Write-Host "::group::local registry + npm install -g"
  $registry = Start-E2ERegistry -Root $Root -PackageDirs @($build.nativeDir, $build.mainDir)
  $servers += $registry.process
  $install = Invoke-Logged "npm install -g" { npm install -g "@851-labs/tokenmaxxing@$($build.version)" --registry "$($registry.url)/" --no-audit --no-fund }
  $tmxBin = (npm prefix -g | Out-String).Trim()
  $shim = Invoke-Logged "tokenmaxxing.cmd --version" { cmd.exe /d /c "`"$tmxBin\tokenmaxxing.cmd`" --version" }
  Add-Check "setup" "npm install -g from the e2e registry" ($install.code -eq 0 -and $shim.out -match [regex]::Escape($build.version)) "prefix=$tmxBin; $(Format-OneLine $shim.out)"
  Write-Host "::endgroup::"

  Write-Host "::group::legacy release $LegacyVersion"
  # Laid out like a global install: bin\tokenmaxxing.exe plus the nested runner package.
  $legacyDir = Join-Path $Root "legacy"
  $legacyPackage = "$($build.nativePackageName)@$LegacyVersion"
  New-Item -ItemType Directory -Force -Path $legacyDir | Out-Null
  $pack = Invoke-Logged "npm pack $legacyPackage" { npm pack $legacyPackage --pack-destination $legacyDir --registry https://registry.npmjs.org/ }
  $tarball = Get-ChildItem -LiteralPath $legacyDir -Filter "*.tgz" | Select-Object -First 1
  $legacyBin = ""
  if ($pack.code -eq 0 -and $tarball) {
    $layout = Join-Path $Root "legacy-install\node_modules\@851-labs\tokenmaxxing"
    $nested = Join-Path $layout "node_modules\$($build.nativePackageName)"
    New-Item -ItemType Directory -Force -Path (Join-Path $layout "bin"), $nested | Out-Null
    tar -xzf $tarball.FullName -C $nested --strip-components 1
    Copy-Item -LiteralPath (Join-Path $nested "bin\tokenmaxxing.exe") -Destination (Join-Path $layout "bin\tokenmaxxing.exe")
    $legacyBin = Join-Path $layout "bin"
  }
  $legacyVersionOut = if ($legacyBin) { (& (Join-Path $legacyBin "tokenmaxxing.exe") --version 2>&1 | Out-String).Trim() } else { "" }
  Add-Check "setup" "legacy release $legacyPackage" ($legacyVersionOut -match [regex]::Escape($LegacyVersion)) "$legacyVersionOut $(Format-OneLine $pack.out 300)"
  Write-Host "::endgroup::"

  Write-Host "::group::block production + registry.npmjs.org"
  Add-Content -LiteralPath $hostsPath -Value ("`r`n" + (($blockedHosts | ForEach-Object { "0.0.0.0 $_ $hostsMarker" }) -join "`r`n")) -Encoding ascii
  ipconfig /flushdns | Out-Null
  foreach ($name in $blockedHosts) {
    $probe = bun -e "fetch('https://$name/', { signal: AbortSignal.timeout(10000) }).then((r) => { console.log('reached', r.status); process.exit(1) }, (e) => { console.log('blocked:', e.code ?? e.name); process.exit(0) })" 2>&1 | Out-String
    Add-Check "setup" "$name is unreachable" ($LASTEXITCODE -eq 0) (Format-OneLine $probe)
  }
  Write-Host "::endgroup::"

  $template = [regex]::Match((Get-Content -LiteralPath "$repo\apps\cli\src\commands\service.ts" -Raw), 'const SERVICE_TEMPLATE_VERSION = (\d+);').Groups[1].Value
  if ((Get-FailedChecks).Count -eq 0) {
    & "$PSScriptRoot\service-e2e.ps1" -Root $Root -OutDir $OutDir -TmxBin $tmxBin -FakeBin $fakeBin -Api $api `
      -TemplateVersion ([int]$template) -RunnerExe $build.nativeExe -LegacyBin $legacyBin
  } else {
    Write-Host "::error::setup failed; skipping the service scenarios"
  }
} finally {
  Copy-Item -LiteralPath (Join-Path $fakeBin "calls.log") -Destination (Join-Path $OutDir "fake-ccusage-calls.log") -ErrorAction SilentlyContinue
  try { Invoke-RestMethod -Uri "$api/__sandbox/requests" | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir "sandbox-requests.json") -Encoding utf8 } catch { }
  Stop-E2E
}

& "$PSScriptRoot\summarize.ps1" -OutDir $OutDir -Title "Windows service e2e"
exit $(if ((Get-FailedChecks).Count -gt 0) { 1 } else { 0 })
