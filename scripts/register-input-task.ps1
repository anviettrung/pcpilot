<#
.SYNOPSIS
    Đăng ký Scheduled Task "PcPilot Input" (quyền cao nhất): tiến trình gửi phím, chuột tới app chạy quyền admin.
    PHẢI chạy với quyền admin. install.ps1 gọi tệp này khi đang chạy bằng PowerShell "Run as administrator"; cũng chạy
    riêng được:
    powershell -ExecutionPolicy Bypass -File scripts/register-input-task.ps1 -Bun "<đường dẫn bun.exe>"
#>
param(
    [Parameter(Mandatory)][string]$Bun,
    [string]$User = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$TaskName = 'PcPilot Input'
if (-not $User) { $User = "$env:USERDOMAIN\$env:USERNAME" }

function Say([string]$Text) { Write-Output "pcpilot: $Text" }

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) { Say 'register-input-task.ps1 cần quyền admin (PowerShell "Run as administrator")'; exit 1 }

$runner = Join-Path $Root 'scripts\run-sidecar.ps1'
$taskArgs = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Bun `"$Bun`" -Entry src/elevated.ts -Name input"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$same = $existing -and $existing.Actions.Count -eq 1 -and $existing.Actions[0].Arguments -eq $taskArgs -and $existing.Principal.RunLevel -eq 'Highest'
if (-not $same) {
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $taskArgs -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    if ($existing) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'pcpilot: gửi phím, chuột từ điện thoại tới app chạy quyền admin (kho pcpilot)' -Force | Out-Null
    Say "đã đăng ký Scheduled Task '$TaskName' (quyền cao nhất)"
}
if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { Start-ScheduledTask -TaskName $TaskName }
exit 0
