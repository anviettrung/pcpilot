<#
.SYNOPSIS
    Chạy một tiến trình của PcPilot bằng Bun, ghi log, tự chạy lại khi nó thoát. Scheduled Task gọi tệp này qua
    `conhost.exe --headless` để không có cửa sổ:
    - "PcPilot Sidecar" (quyền thường): -Entry src/main.ts -Name sidecar
    - "PcPilot Input" (quyền admin, gửi phím tới app quyền admin): -Entry src/elevated.ts -Name input
#>
param(
    [Parameter(Mandatory)][string]$Bun,
    [string]$Entry = 'src/main.ts',
    [string]$Name = 'sidecar'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root "$Name.log"

function Write-Log([string]$Text) {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Text" -Encoding UTF8
}

Set-Location -LiteralPath $root
$out = Join-Path $root "$Name.out.log"
$err = Join-Path $root "$Name.err.log"
while ($true) {
    # Giữ log gọn: quá 1 MB thì bắt đầu lại.
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) { Remove-Item -LiteralPath $log }
    Write-Log "khởi động $Entry"
    # Start-Process ghi nguyên byte UTF-8 của Bun; còn `>>` của PowerShell 5.1 sẽ đổi sang UTF-16.
    $p = Start-Process -FilePath $Bun -ArgumentList 'run', $Entry -WorkingDirectory $root -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle  # giữ handle thì mới đọc được ExitCode sau khi thoát
    $p.WaitForExit()
    $tail = if (Test-Path -LiteralPath $err) { (Get-Content -LiteralPath $err -Tail 5 -Encoding UTF8) -join ' | ' } else { '' }
    Write-Log "$Entry thoát (mã $($p.ExitCode)) $tail"
    Start-Sleep -Seconds 5
}
