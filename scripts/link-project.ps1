<#
.SYNOPSIS
    Gắn package Unity của PcPilot vào một project Unity chỉ trên máy này, không để lại thay đổi nào cho git của project.
.DESCRIPTION
    Tạo junction Assets/PcPilot -> <kho pcpilot>/unity (đặt trong Assets thì Unity không ghi gì vào
    Packages/manifest.json hay packages-lock.json), rồi khai Assets/PcPilot và Assets/PcPilot.meta trong
    .git/info/exclude (danh sách bỏ qua riêng của máy, không commit).
    Xong thì bấm vào cửa sổ Unity (hoặc Stop rồi Play từ trang PcPilot) để Unity nạp.

    powershell -File scripts/link-project.ps1 -Project D:\Projects\MyGame
    powershell -File scripts/link-project.ps1 -Project D:\Projects\MyGame -Remove
#>
param(
    [Parameter(Mandatory)][string]$Project,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath (Join-Path $Project 'ProjectSettings\ProjectVersion.txt'))) { throw "$Project không phải project Unity" }
$Pkg = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\unity')).Path
$Link = Join-Path $Project 'Assets\PcPilot'

function Say([string]$Text) { Write-Output "pcpilot: $Text" }
function Is-Junction([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# Gỡ junction bằng Directory.Delete(path, false): chỉ xoá junction, không đụng nội dung thư mục đích.
# Junction trỏ vào thư mục đã mất (kho bị dời chỗ) thì Test-Path báo false nhưng Get-Item -Force vẫn thấy.
function Remove-Junction([string]$Path) {
    if (Is-Junction $Path) { [IO.Directory]::Delete($Path, $false); return $true }
    return $false
}

# --- .git/info/exclude -------------------------------------------------------------------------------
$exclude = $null
$prefix = ''
Push-Location -LiteralPath $Project
try {
    $ErrorActionPreference = 'Continue'
    $gitDir = (& git rev-parse --git-common-dir 2>$null)
    if ($LASTEXITCODE -eq 0 -and $gitDir) {
        $exclude = Join-Path (Resolve-Path -LiteralPath $gitDir).Path 'info\exclude'
        $prefix = (& git rev-parse --show-prefix 2>$null) -replace '\\', '/'
    }
    $ErrorActionPreference = 'Stop'
} finally { Pop-Location }
$lines = @("/${prefix}Assets/PcPilot/", "/${prefix}Assets/PcPilot.meta")
# exclude của git đọc như văn bản thường: dòng ghi chú viết ASCII.
$marker = '# PcPilot (chi may nay, xem kho pcpilot)'

# Đọc exclude bỏ ký tự CR, ghi lại toàn bộ bằng LF: git không bỏ CR cuối dòng, dòng "/Assets/PcPilot.meta`r" sẽ
# không khớp (Add-Content của PowerShell ghi CRLF vào tệp vốn dùng LF).
function Read-Exclude { if (Test-Path -LiteralPath $exclude) { @([IO.File]::ReadAllLines($exclude) | ForEach-Object { $_.TrimEnd("`r") }) } else { @() } }
function Write-Exclude([string[]]$Content) {
    $text = ($Content -join "`n").TrimEnd("`n") + "`n"
    [IO.File]::WriteAllText($exclude, $text, (New-Object Text.ASCIIEncoding))
}

if ($Remove) {
    if (Remove-Junction $Link) { Say "đã gỡ $Link" }
    $meta = "$Link.meta"
    if (Test-Path -LiteralPath $meta) { Remove-Item -LiteralPath $meta -Force }
    if ($exclude -and (Test-Path -LiteralPath $exclude)) {
        Write-Exclude @(Read-Exclude | Where-Object { $_ -ne $marker -and $lines -notcontains $_ })
    }
    Say 'đã gỡ package PcPilot khỏi project'
    exit 0
}

if (Test-Path -LiteralPath $Link) {
    if (-not (Is-Junction $Link)) { throw "$Link đã có và không phải junction, không đụng vào" }
} else {
    if (Is-Junction $Link) { [IO.Directory]::Delete($Link, $false) } # junction hỏng
    New-Item -ItemType Junction -Path $Link -Target $Pkg | Out-Null
    Say "đã tạo $Link -> $Pkg"
}

if ($exclude) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $exclude) | Out-Null
    $raw = if (Test-Path -LiteralPath $exclude) { [IO.File]::ReadAllText($exclude) } else { '' }
    $have = @(Read-Exclude)
    $add = @($lines | Where-Object { $have -notcontains $_ })
    if ($add.Count) {
        Write-Exclude (@($have) + @($marker) + $add)
        Say "đã thêm vào $exclude"
    } elseif ($raw.Contains("`r")) {
        Write-Exclude $have
        Say "đã sửa $exclude"
    }
    Push-Location -LiteralPath $Project
    try {
        $ErrorActionPreference = 'Continue'
        $st = (& git status --porcelain -- 'Assets/PcPilot' 'Assets/PcPilot.meta' 2>$null) -join "`n"
        $ErrorActionPreference = 'Stop'
    } finally { Pop-Location }
    if ($st) { Say "git vẫn thấy thay đổi:`n$st" } else { Say 'git không thấy thay đổi nào của PcPilot' }
} else {
    Say 'project không nằm trong repo git, bỏ qua bước exclude'
}
Say 'bấm vào cửa sổ Unity (hoặc Stop rồi Play từ trang PcPilot) để Unity nạp'
