<#
.SYNOPSIS
    Cài PcPilot cho máy hiện tại: Bun, ffmpeg, thư viện, hai Scheduled Task chạy lúc đăng nhập, `tailscale serve`.
.DESCRIPTION
    Chạy bằng install.cmd (nháy đúp) hoặc powershell -File install.ps1. Chạy lặp lại được, không hỏi gì, không mở cửa sổ.
    - "PcPilot Sidecar" (quyền thường): web, stream, Unity. Chỉ khởi động lại khi kho sang commit khác.
    - "PcPilot Input" (quyền cao nhất): gửi phím, chuột tới app chạy quyền admin. Đăng ký cần quyền admin một lần:
      chạy tệp này bằng PowerShell "Run as administrator" (hoặc scripts/register-input-task.ps1 quyền admin). Chưa có
      thì PcPilot vẫn chạy, chỉ không gửi phím, chuột tới được app quyền admin. Các lần sau chạy quyền thường được.
    Phần Unity (package UPM) gắn riêng vào từng project, xem README.md.
#>
param(
    [string]$UserHome = ''
)

$ErrorActionPreference = 'Stop'
if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath('UserProfile') }

$Root = $PSScriptRoot
$RepoRoot = $Root
$TaskName = 'PcPilot Sidecar'
$InputTaskName = 'PcPilot Input'
$StateDir = Join-Path $UserHome '.pcpilot'
$StateFile = Join-Path $StateDir 'pcpilot-tree.txt'
$InputStateFile = Join-Path $StateDir 'pcpilot-input-tree.txt'
$Config = Get-Content -LiteralPath (Join-Path $Root 'pcpilot.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Port = [int]$Config.port
$HttpsPort = [int]$Config.httpsPort
$InputPort = [int]$Config.inputPort
$TokenFile = Join-Path $env:LOCALAPPDATA 'pcpilot\input-token.txt'
$Machines = Get-Content -LiteralPath (Join-Path $Root 'machines.json') -Raw -Encoding UTF8 | ConvertFrom-Json

function Say([string]$Text) { Write-Output "pcpilot: $Text" }
function Fail([string]$Text) { Write-Output "pcpilot: $Text"; exit 1 }

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# git báo lỗi ra stderr (vd chưa commit); 5.1 với ErrorActionPreference = Stop coi đó là lỗi dừng script.
function Git-Tree([string[]]$Paths) {
    $ErrorActionPreference = 'Continue'
    $out = foreach ($p in $Paths) { & git -C $RepoRoot rev-parse "HEAD:$p" 2>$null }
    return ($out -join ',')
}

function Get-ListenPid([int]$P) {
    $c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $P -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess } else { return $null }
}

# --- 1. Bun, ffmpeg -------------------------------------------------------------------------------
function Find-Bun {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'),
        (Join-Path $UserHome '.bun\bin\bun.exe')
    ) + @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Oven-sh.Bun_*\*\bun.exe') -ErrorAction SilentlyContinue |
            ForEach-Object FullName)
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

function Find-Ffmpeg {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $c = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Gyan.FFmpeg_*\*\bin\ffmpeg.exe') -ErrorAction SilentlyContinue)
    if ($c.Count) { return $c[0].FullName }
    return $null
}

function Install-Winget([string]$Id) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "chưa có $Id và không có winget để cài" }
    & winget install --id $Id -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
}

$Bun = Find-Bun
if (-not $Bun) {
    Install-Winget 'Oven-sh.Bun'
    $Bun = Find-Bun
    if (-not $Bun) { Fail 'cài Bun bằng winget xong vẫn không thấy bun.exe' }
    Say "đã cài Bun ($Bun)"
}
if (-not (Find-Ffmpeg)) {
    Install-Winget 'Gyan.FFmpeg'
    if (-not (Find-Ffmpeg)) { Fail 'cài ffmpeg bằng winget xong vẫn không thấy ffmpeg.exe' }
    Say 'đã cài ffmpeg'
}

# --- 2. Thư viện -----------------------------------------------------------------------------------
$marker = Join-Path $Root 'node_modules\.pcpilot-installed'
$lock = Join-Path $Root 'bun.lock'
$needInstall = -not (Test-Path -LiteralPath $marker) -or
    ((Get-Item -LiteralPath $lock).LastWriteTimeUtc -gt (Get-Item -LiteralPath $marker).LastWriteTimeUtc)
if ($needInstall) {
    Push-Location -LiteralPath $Root
    try {
        # 2>&1 trên lệnh ngoài làm 5.1 ném NativeCommandError khi ErrorActionPreference = Stop: tạm hạ xuống.
        $ErrorActionPreference = 'Continue'
        $out = & $Bun install --frozen-lockfile 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -and $out -match 'Unknown lockfile version') {
            # bun.lock do Bun mới hơn tạo (máy khác): nâng Bun máy này rồi thử lại.
            if ($Bun -like '*\WinGet\*') {
                & winget upgrade --id Oven-sh.Bun -e --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
            } else {
                & $Bun upgrade 2>&1 | Out-Null
            }
            Say "đã nâng Bun lên $((& $Bun --version 2>$null | Out-String).Trim()) (bun.lock mới hơn Bun cũ)"
            $out = & $Bun install --frozen-lockfile 2>&1 | Out-String
        }
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { Fail "bun install lỗi: $($out.Trim())" }
    } finally { Pop-Location }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
    Set-Content -LiteralPath $marker -Value (Get-Date -Format o)
    Say 'đã cài thư viện'
}

# --- 3. Scheduled Task (quyền thường) ---------------------------------------------------------------
# conhost --headless chạy PowerShell mà không hiện cửa sổ nào.
$runner = Join-Path $Root 'scripts\run-sidecar.ps1'
$taskArgs = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Bun `"$Bun`" -Entry src/main.ts -Name sidecar"
$user = "$env:USERDOMAIN\$env:USERNAME"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$same = $existing -and $existing.Actions.Count -eq 1 -and $existing.Actions[0].Execute -eq 'conhost.exe' -and $existing.Actions[0].Arguments -eq $taskArgs
if (-not $same) {
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $taskArgs -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'pcpilot: remote màn hình, Unity từ điện thoại (kho pcpilot)' -Force | Out-Null
    Say "đã đăng ký Scheduled Task '$TaskName'"
}

$tree = Git-Tree @('')
$lastTree = if (Test-Path -LiteralPath $StateFile) { (Get-Content -LiteralPath $StateFile -Raw).Trim() } else { '' }
$taskRunning = (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'
$sidecarPid = Get-ListenPid $Port

if (-not ($sidecarPid -and $taskRunning -and $tree -eq $lastTree)) {
    # Dừng cả task, vòng lặp run-sidecar.ps1 cũ lẫn sidecar đang giữ cổng (dừng task chỉ tắt conhost).
    if ($taskRunning) { Stop-ScheduledTask -TaskName $TaskName }
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like '*pcpilot*run-sidecar.ps1*-Name sidecar*' -and $_.ProcessId -ne $PID } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($sidecarPid) { Stop-Process -Id $sidecarPid -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-ListenPid $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(40)
    while (-not (Get-ListenPid $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Get-ListenPid $Port)) { Fail "sidecar không lên ở cổng $Port, xem $(Join-Path $Root 'sidecar.log')" }
    if ($tree) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null; Set-Content -LiteralPath $StateFile -Value $tree }
    Say "sidecar đã chạy ở http://127.0.0.1:$Port"
}

# --- 4. Tiến trình gửi phím quyền admin -------------------------------------------------------------
$inTask = Get-ScheduledTask -TaskName $InputTaskName -ErrorAction SilentlyContinue
if ($IsAdmin -and (-not $inTask -or $inTask.State -ne 'Disabled')) {
    & (Join-Path $Root 'scripts\register-input-task.ps1') -Bun $Bun -User $user
    $inTask = Get-ScheduledTask -TaskName $InputTaskName -ErrorAction SilentlyContinue
}
if (-not $inTask) {
    Say "chưa có task '$InputTaskName': phím, chuột chưa tới được app chạy quyền admin. Cài một lần bằng PowerShell 'Run as administrator':"
    Say "  powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'install.ps1')`""
} elseif ($inTask.State -ne 'Disabled') {
    # Mã của tiến trình phụ đổi: nhờ nó tự thoát (quyền thường không tắt được tiến trình quyền admin), vòng lặp
    # của nó chạy lại bằng mã mới.
    $inputTree = Git-Tree @('src/elevated.ts', 'src/screen', 'src/core/config.ts', 'src/core/access.ts', 'shared')
    $lastInput = if (Test-Path -LiteralPath $InputStateFile) { (Get-Content -LiteralPath $InputStateFile -Raw).Trim() } else { '' }
    $inputPid = Get-ListenPid $InputPort
    if ($inputPid -and $inputTree -ne $lastInput -and (Test-Path -LiteralPath $TokenFile)) {
        try {
            $tcp = New-Object Net.Sockets.TcpClient('127.0.0.1', $InputPort)
            $w = New-Object IO.StreamWriter($tcp.GetStream())
            $w.Write("{`"t`":`"$((Get-Content -LiteralPath $TokenFile -Raw).Trim())`"}`n{`"op`":`"quit`"}`n")
            $w.Flush()
            Start-Sleep -Milliseconds 300
            $tcp.Close()
        } catch {}
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-ListenPid $InputPort) -eq $inputPid -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
        Say 'tiến trình gửi phím quyền admin chạy lại bằng mã mới'
    } elseif (-not $inputPid -and (Get-ScheduledTask -TaskName $InputTaskName).State -ne 'Running') {
        Start-ScheduledTask -TaskName $InputTaskName
    }
    if ($inputTree) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null; Set-Content -LiteralPath $InputStateFile -Value $inputTree }
}

# --- 5. Tailscale ---------------------------------------------------------------------------------
$Mode = if ($Machines.access -and $Machines.access.mode) { [string]$Machines.access.mode } else { 'tailscale' }
if ($Mode -ne 'tailscale') { Say "truy cập từ xa: chế độ '$Mode' (machines.json > access), bỏ qua tailscale serve"; exit 0 }
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
if (-not (Test-Path -LiteralPath $ts)) { Say 'chưa cài Tailscale, điện thoại chưa vào được'; exit 0 }

$status = $null
try { $status = & $ts status --json 2>$null | Out-String | ConvertFrom-Json } catch {}
if (-not $status -or $status.BackendState -ne 'Running') { Say 'Tailscale chưa đăng nhập, bỏ qua tailscale serve'; exit 0 }

$ErrorActionPreference = 'Continue'
$serve = (& $ts serve status --json 2>$null | Out-String)
if ($serve -notmatch ":$HttpsPort`"[\s\S]*?127\.0\.0\.1:$Port") {
    & $ts serve --bg "--https=$HttpsPort" "http://127.0.0.1:$Port" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "tailscale serve --https=$HttpsPort $Port lỗi (mã $LASTEXITCODE)" }
    Say "đã mở trong tailnet: https://$(($status.Self.DNSName).TrimEnd('.')):$HttpsPort/"
}
exit 0
