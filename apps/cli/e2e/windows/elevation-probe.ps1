# Prints what `tokenmaxxing service install/repair` decides "elevated from a
# normal user's terminal" from: the token's integrity level, its logon-type
# groups, the UAC settings, and the token elevation type (1 = Default: no
# linked token; 2 = Full: elevated half of a UAC split token; 3 = Limited).
$ErrorActionPreference = "Continue"
$groups = whoami /groups /fo csv | ConvertFrom-Csv
$label = ($groups | Where-Object { $_.SID -like "S-1-16-*" }).'Group Name'
$logon = ($groups | Where-Object { $_.SID -in @("S-1-5-4", "S-1-5-6", "S-1-5-2", "S-1-5-3", "S-1-2-1", "S-1-5-14") }).'Group Name' -join ", "
$system = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
$uac = Get-ItemProperty -Path $system -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TmxToken {
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);
  public static int ElevationType() {
    int type; int returned;
    return GetTokenInformation(System.Security.Principal.WindowsIdentity.GetCurrent().Token, 18, out type, 4, out returned) ? type : -1;
  }
}
"@
Write-Host "user:            $(whoami) ($((whoami /user /fo csv | ConvertFrom-Csv).SID))"
Write-Host "integrity:       $label"
Write-Host "logon groups:    $logon"
Write-Host "EnableLUA:       $($uac.EnableLUA)"
Write-Host "FilterAdminTok:  $($uac.FilterAdministratorToken)"
Write-Host "ConsentAdmin:    $($uac.ConsentPromptBehaviorAdmin)"
Write-Host "elevation type:  $([TmxToken]::ElevationType())"
