# Renders <OutDir>/results.jsonl (and session.json, if present) as Markdown
# into <OutDir>/summary.md and, in GitHub Actions, the job's step summary.
param([Parameter(Mandatory)] [string]$OutDir, [Parameter(Mandatory)] [string]$Title)
$rows = @(Get-Content -LiteralPath (Join-Path $OutDir "results.jsonl") -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json })
$session = Get-Content -LiteralPath (Join-Path $OutDir "session.json") -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
$cell = { param($text, $max = 400) $flat = ("$text" -replace '\|', '\|' -replace "\r?\n", ' '); if ($flat.Length -gt $max) { $flat.Substring(0, $max) + "…" } else { $flat } }
$icon = @{ PASS = "✅"; FAIL = "❌"; INFO = "ℹ️"; XFAIL = "⚠️"; XPASS = "❗" }
$failed = @($rows | Where-Object { $_.status -in @("FAIL", "XPASS") })

$md = New-Object System.Collections.Generic.List[string]
$verdict = if ($rows.Count -eq 0) { "❌ no results" } elseif ($failed.Count -gt 0) { "❌ $($failed.Count) failed" } else { "✅ passed" }
$md.Add("## $Title on $env:RUNNER_OS/$env:RUNNER_ARCH: $verdict")
$md.Add("")
if ($session) {
  $md.Add("$($session.os) · image $($session.image) · $($session.whoami) in session $($session.selfSessionId) (console $($session.activeConsoleSessionId)) · $($session.windowStation)\$($session.inputDesktop)")
  $md.Add("")
}
$counts = ($rows | Group-Object status | Sort-Object Name | ForEach-Object { "$($icon[$_.Name]) $($_.Name) $($_.Count)" }) -join " · "
$md.Add("**Checks:** $counts")
$md.Add("")
if ($failed.Count -gt 0) {
  $md.Add("### Failures")
  $md.Add("")
  $md.Add("| | scenario | check | detail |")
  $md.Add("|---|---|---|---|")
  foreach ($row in $failed) { $md.Add("| $($icon[$row.status]) | $(& $cell $row.scenario) | $(& $cell $row.check) | $(& $cell $row.detail 1500) |") }
  $md.Add("")
  $md.Add("Logs, task XML, window-watch events and screenshots are in this run's artifacts.")
  $md.Add("")
}
$md.Add("<details><summary>All checks by scenario</summary>")
$md.Add("")
$md.Add("| | scenario | check | detail |")
$md.Add("|---|---|---|---|")
foreach ($row in $rows) { $md.Add("| $($icon[$row.status]) | $(& $cell $row.scenario) | $(& $cell $row.check) | $(& $cell $row.detail) |") }
$md.Add("")
$md.Add("</details>")
$md.Add("")

$md | Set-Content -LiteralPath (Join-Path $OutDir "summary.md") -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { $md | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8 }
$md -join "`n" | Write-Host
