# Global-install shim matrix: installs this build from the local registry
# with each package manager, then runs `tokenmaxxing --version` through each
# shell. Extend it by adding rows to $Installers or $Shells.
#
#   run-shim-matrix.ps1 -Build <build.json> [-Root <dir>] [-OutDir <dir>] [-Force]
#
# $KnownIssues lists installers whose --version checks currently fail: they
# record XFAIL instead of FAIL, and XPASS (which fails the job) once they
# pass, so the entry is removed together with the fix.
param(
  [Parameter(Mandatory)] [string]$Build,
  [string]$Root = (Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) "tmx-e2e-shims"),
  [string]$OutDir = (Join-Path $Root "out"),
  [switch]$Force
)
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "lib\common.ps1")
Assert-DisposableMachine -Force:$Force
Initialize-E2E -OutDir $OutDir -Suite "shims"

$build = Get-Content -LiteralPath $Build -Raw | ConvertFrom-Json
$package = "@851-labs/tokenmaxxing"
$spec = "$package@$($build.version)"

$KnownIssues = @{
  # bun links the bin as a node script before preinstall swaps in the native exe.
  "bun add -g --trust" = "851-labs/tokenmaxxing#28"
}

$Installers = [ordered]@{
  "npm i -g" = @{
    install = { npm install -g $spec --registry "$registryUrl/" --no-audit --no-fund }
    bin = { (npm prefix -g | Out-String).Trim() }
    packageDir = { Join-Path (npm prefix -g | Out-String).Trim() "node_modules\$package" }
    uninstall = { npm uninstall -g $package }
  }
  "bun add -g" = @{
    install = { bun add -g $spec --registry "$registryUrl/" }
    bin = { (bun pm bin -g | Out-String).Trim() }
    packageDir = { Join-Path $env:USERPROFILE ".bun\install\global\node_modules\$package" }
    uninstall = { bun remove -g $package }
  }
  "bun add -g --trust" = @{
    install = { bun add -g --trust $spec --registry "$registryUrl/" }
    bin = { (bun pm bin -g | Out-String).Trim() }
    packageDir = { Join-Path $env:USERPROFILE ".bun\install\global\node_modules\$package" }
    uninstall = { bun remove -g $package }
  }
}

$Shells = [ordered]@{
  "cmd.exe" = { cmd.exe /d /c "tokenmaxxing --version" }
  "pwsh" = { pwsh -NoProfile -Command "tokenmaxxing --version; exit `$LASTEXITCODE" }
  "Windows PowerShell 5.1" = { powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "tokenmaxxing --version; exit `$LASTEXITCODE" }
}

function Describe-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "missing" }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $kind = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0x4D -and $bytes[1] -eq 0x5A) { "PE executable" }
    elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0x23 -and $bytes[1] -eq 0x21) { "script (shebang)" }
    else { "other" }
  "$kind, $($bytes.Length) bytes"
}

$registry = Start-E2ERegistry -Root $Root -PackageDirs @($build.nativeDir, $build.mainDir)
$registryUrl = $registry.url
$basePath = $env:PATH
try {
  foreach ($name in $Installers.Keys) {
    Write-Host "::group::$name"
    $installer = $Installers[$name]
    $install = Invoke-Logged "$name install" $installer.install
    Add-Check $name "install" ($install.code -eq 0) "exit $($install.code): $(Format-OneLine (($install.out -split "\r?\n" | Select-Object -Last 6) -join "`n"))"
    $bin = & $installer.bin
    $env:PATH = "$bin;$basePath"
    try {
      $where = (where.exe tokenmaxxing 2>&1 | Out-String).Trim()
      $packageBin = Join-Path (& $installer.packageDir) "bin\tokenmaxxing.exe"
      Add-Check $name "resolved shim" "INFO" "$(Format-OneLine $where); package bin/tokenmaxxing.exe: $(Describe-File $packageBin)"
      foreach ($shell in $Shells.Keys) {
        $run = Invoke-Logged "$name via $shell" $Shells[$shell]
        $ok = $run.code -eq 0 -and $run.out -match [regex]::Escape($build.version)
        Add-Check $name "tokenmaxxing --version via $shell" $ok "exit $($run.code): $(Format-OneLine $run.out 300)" -KnownIssue ($KnownIssues[$name] ?? "")
      }
    } finally {
      $env:PATH = $basePath
      Invoke-Logged "$name uninstall" $installer.uninstall | Out-Null
    }
    Write-Host "::endgroup::"
  }
} finally {
  Stop-Background $registry.process
}

& "$PSScriptRoot\summarize.ps1" -OutDir $OutDir -Title "Windows global-install shims"
exit $(if ((Get-FailedChecks).Count -gt 0) { 1 } else { 0 })
