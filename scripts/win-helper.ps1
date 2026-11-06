<#
.SYNOPSIS
    Trợ lý Win32 cho app Unity của UnityPilot: tìm hộp thoại (popup) của Unity Editor, chụp ảnh, bấm nút trong đó.
.DESCRIPTION
    Sidecar chạy tệp này một lần rồi giữ: mỗi dòng stdin là một lệnh JSON, mỗi dòng stdout là một kết quả JSON.
      {"op":"list"}                               -> {"ok":true,"list":[{hwnd,pid,title,cls,w,h,buttons:[{hwnd,text}]}]}
      {"op":"shot","hwnd":N,"max":900}            -> {"ok":true,"png":"<base64>","w":..,"h":..}
      {"op":"button","hwnd":N,"button":M}         -> bấm nút M (BM_CLICK, không cần chuột hay focus)
      {"op":"click","hwnd":N,"x":..,"y":..}       -> chạm vào toạ độ (pixel của ảnh chụp đầy đủ cỡ)
      {"op":"cancel","hwnd":N}                    -> như bấm Esc / nút X (WM_COMMAND IDCANCEL)
    Popup = cửa sổ hiện của Unity.exe có class hộp thoại chuẩn (#32770), hoặc cửa sổ mà cửa sổ chủ (owner) đang bị
    khoá (dấu hiệu hộp thoại modal).
#>
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PilotWin
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    const uint GW_OWNER = 4, WM_COMMAND = 0x111, BM_CLICK = 0xF5, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202;

    public static void Init()
    {
        // Toạ độ, kích thước theo pixel thật của màn hình (không bị Windows co giãn theo DPI).
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    public class Button { public long hwnd; public string text; }
    public class Popup { public long hwnd; public uint pid; public string title, cls; public int w, h; public List<Button> buttons; }

    static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }

    /// <summary>Khung thật của cửa sổ (bỏ phần bóng đổ của Windows 10/11).</summary>
    static RECT Frame(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
        return r;
    }

    static HashSet<uint> UnityPids()
    {
        var set = new HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("Unity")) { set.Add((uint)p.Id); p.Dispose(); }
        return set;
    }

    public static List<Popup> List()
    {
        var pids = UnityPids();
        var res = new List<Popup>();
        EnumWindows((h, l) =>
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
            var cls = Cls(h);
            var owner = GetWindow(h, GW_OWNER);
            bool popup = cls == "#32770" || (owner != IntPtr.Zero && !IsWindowEnabled(owner) && IsWindowEnabled(h));
            if (!popup) return true;
            var r = Frame(h);
            if (r.R - r.L < 40 || r.B - r.T < 30) return true;
            res.Add(new Popup { hwnd = h.ToInt64(), pid = pid, title = Text(h), cls = cls, w = r.R - r.L, h = r.B - r.T, buttons = Buttons(h) });
            return true;
        }, IntPtr.Zero);
        return res;
    }

    static List<Button> Buttons(IntPtr top)
    {
        var res = new List<Button>();
        EnumChildWindows(top, (c, l) =>
        {
            if (IsWindowVisible(c) && IsWindowEnabled(c) && Cls(c) == "Button")
            {
                var t = Text(c).Replace("&", "");
                if (t.Length > 0) res.Add(new Button { hwnd = c.ToInt64(), text = t });
            }
            return true;
        }, IntPtr.Zero);
        return res;
    }

    static bool IsChildOf(IntPtr child, IntPtr top)
    {
        for (var p = GetParent(child); p != IntPtr.Zero; p = GetParent(p)) if (p == top) return true;
        return false;
    }

    /// <summary>Chụp cửa sổ (kể cả khi bị che), thu nhỏ để cạnh dài không quá max, trả PNG base64.</summary>
    public static string Shot(long hwnd, int max, out int w, out int h)
    {
        var top = new IntPtr(hwnd);
        RECT wr; GetWindowRect(top, out wr);
        var fr = Frame(top);
        int ww = wr.R - wr.L, wh = wr.B - wr.T;
        w = fr.R - fr.L; h = fr.B - fr.T;
        using (var full = new Bitmap(Math.Max(1, ww), Math.Max(1, wh), PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(full))
            {
                var hdc = g.GetHdc();
                try { PrintWindow(top, hdc, 2); } finally { g.ReleaseHdc(hdc); }
            }
            double k = Math.Min(1.0, (double)max / Math.Max(w, h));
            int ow = Math.Max(1, (int)(w * k)), oh = Math.Max(1, (int)(h * k));
            using (var outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
            using (var g2 = Graphics.FromImage(outBmp))
            using (var ms = new MemoryStream())
            {
                g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g2.DrawImage(full, new Rectangle(0, 0, ow, oh), new Rectangle(fr.L - wr.L, fr.T - wr.T, w, h), GraphicsUnit.Pixel);
                outBmp.Save(ms, ImageFormat.Png);
                return Convert.ToBase64String(ms.ToArray());
            }
        }
    }

    public static string ClickButton(long top, long button)
    {
        var t = new IntPtr(top); var b = new IntPtr(button);
        if (!IsWindow(b) || !IsChildOf(b, t)) return "nút không còn";
        // Post (không Send): bấm nút có thể mở hộp thoại khác và chặn luồng gửi.
        PostMessage(b, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        return null;
    }

    public static string Cancel(long top)
    {
        PostMessage(new IntPtr(top), WM_COMMAND, new IntPtr(2), IntPtr.Zero); // IDCANCEL
        return null;
    }

    /// <summary>
    /// Chạm vào (x, y) tính theo pixel khung cửa sổ. Trúng nút chuẩn thì BM_CLICK; trúng control khác thì gửi thông điệp
    /// chuột cho control đó; không có control (giao diện tự vẽ của Unity) thì đưa cửa sổ lên trước và bấm chuột thật.
    /// </summary>
    public static string Click(long hwnd, int x, int y)
    {
        var top = new IntPtr(hwnd);
        var fr = Frame(top);
        var screen = new POINT { X = fr.L + x, Y = fr.T + y };
        IntPtr target = top;
        for (int i = 0; i < 8; i++)
        {
            var p = screen; ScreenToClient(target, ref p);
            var c = ChildWindowFromPointEx(target, p, 1 | 2); // bỏ qua control ẩn, control bị khoá
            if (c == IntPtr.Zero || c == target) break;
            target = c;
        }
        if (target != top)
        {
            if (Cls(target) == "Button") { PostMessage(target, BM_CLICK, IntPtr.Zero, IntPtr.Zero); return null; }
            var p = screen; ScreenToClient(target, ref p);
            var lp = new IntPtr((p.Y << 16) | (p.X & 0xFFFF));
            PostMessage(target, WM_LBUTTONDOWN, new IntPtr(1), lp);
            PostMessage(target, WM_LBUTTONUP, IntPtr.Zero, lp);
            return null;
        }
        keybd_event(0x12, 0, 0, IntPtr.Zero); keybd_event(0x12, 0, 2, IntPtr.Zero); // Alt: được phép SetForegroundWindow
        SetForegroundWindow(top);
        System.Threading.Thread.Sleep(80);
        SetCursorPos(screen.X, screen.Y);
        mouse_event(2, 0, 0, 0, IntPtr.Zero);
        mouse_event(4, 0, 0, 0, IntPtr.Zero);
        return null;
    }
}
'@

[PilotWin]::Init()

function Reply($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    try {
        $m = $line | ConvertFrom-Json
        switch ($m.op) {
            'list' { Reply @{ id = $m.id; ok = $true; list = @([PilotWin]::List()) } }
            'shot' {
                $w = 0; $h = 0
                $png = [PilotWin]::Shot([long]$m.hwnd, [int]$m.max, [ref]$w, [ref]$h)
                Reply @{ id = $m.id; ok = $true; png = $png; w = $w; h = $h }
            }
            'button' { $e = [PilotWin]::ClickButton([long]$m.hwnd, [long]$m.button); Reply @{ id = $m.id; ok = -not $e; error = $e } }
            'click' { $e = [PilotWin]::Click([long]$m.hwnd, [int]$m.x, [int]$m.y); Reply @{ id = $m.id; ok = -not $e; error = $e } }
            'cancel' { $e = [PilotWin]::Cancel([long]$m.hwnd); Reply @{ id = $m.id; ok = -not $e; error = $e } }
            default { Reply @{ id = $m.id; ok = $false; error = "lệnh lạ: $($m.op)" } }
        }
    } catch {
        Reply @{ id = $m.id; ok = $false; error = $_.Exception.Message }
    }
}
