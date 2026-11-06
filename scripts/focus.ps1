# Đưa cửa sổ của tiến trình lên trước (mẹo phím Alt để qua chặn giành focus) rồi in cửa sổ đang focus.
#   powershell -File scripts/focus.ps1 [tên tiến trình]   (không có tên thì chỉ in)
param([string]$Name = '')
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class VuFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
'@
if ($Name -eq 'minimize-unity') {
  $u = Get-Process Unity | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  [void][VuFocus]::ShowWindow($u.MainWindowHandle, 6)
} elseif ($Name -eq 'restore-unity') {
  $u = Get-Process Unity | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  [void][VuFocus]::ShowWindow($u.MainWindowHandle, 9)
} elseif ($Name) {
  $p = Get-Process $Name | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  [VuFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [VuFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][VuFocus]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Milliseconds 500
}
$sb = New-Object Text.StringBuilder 256
[void][VuFocus]::GetWindowText([VuFocus]::GetForegroundWindow(), $sb, 256)
$u = Get-Process Unity -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
"focus: $sb | unity minimized: $(if ($u) { [VuFocus]::IsIconic($u.MainWindowHandle) })"
