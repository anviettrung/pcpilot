# UnityPilot

UnityPilot cho chơi thử game Unity đang mở trong Editor ngay trên điện thoại: PC stream Game view sang, điện thoại gửi
chạm đa điểm thẳng vào game. Từ điện thoại còn mở/tắt project trên mọi PC, Play/Stop và trả lời hộp thoại của Unity.

## Install bằng AI

Mở Claude Code (hoặc AI agent khác chạy được lệnh trên máy) ở một thư mục bất kỳ trên PC, dán prompt sau:

````text
Cài UnityPilot cho tôi trên máy Windows này. Mã nguồn: https://github.com/anviettrung/unitypilot (private, tôi đã
được cấp quyền đọc). Làm lần lượt, mỗi bước kiểm tra kết quả rồi mới sang bước sau:

1. Kiểm tra có git và GitHub CLI (gh) đã đăng nhập (`gh auth status`). Thiếu gì thì cài bằng winget nếu được; việc
   cần tôi đăng nhập thì dừng lại chỉ tôi cách làm.
2. Hỏi tôi: (a) thư mục đặt kho (gợi ý D:\Projects\unitypilot, nên giống nhau trên mọi máy), (b) email tài khoản
   Tailscale tôi dùng (hoặc sẽ dùng), (c) đây là máy đầu tiên hay tôi đã có kho unitypilot riêng rồi, (d) các thư mục
   chứa project Unity của tôi (có thể bỏ trống nếu project nào cũng có trong Unity Hub).
3. Máy đầu tiên: clone https://github.com/anviettrung/unitypilot.git vào thư mục đó, đổi remote origin thành upstream,
   tạo kho private của tôi bằng `gh repo create <tài khoản gh của tôi>/unitypilot --private --source . --push`.
   Đã có kho riêng: clone kho riêng của tôi vào thư mục đó.
4. Đọc README.md trong kho, làm theo mục "Install manual": sửa machines.json (owner = email ở bước 2; thêm dòng cho
   máy này nếu chưa có, computer = $env:COMPUTERNAME, host = tên ngắn chữ thường không dấu, name = tên ngắn viết hoa;
   nếu tôi đã cài ClaudeMon thì dùng đúng các tên máy trong machines.json của ClaudeMon), thêm thư mục ở bước 2d vào
   projectRoots trong unitypilot.json (dấu /), commit và push. Không để lại dòng mẫu PC1/PC2 nếu không dùng.
5. Cài Tailscale nếu chưa có (`winget install --id Tailscale.Tailscale -e`). Nếu Tailscale chưa đăng nhập, chỉ tôi
   chạy `tailscale up --unattended` và đăng nhập trong trình duyệt, chờ tôi báo xong. Đặt tên máy trong tailnet:
   `tailscale set --hostname <host>`.
6. Chạy `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` trong kho (không cần quyền admin). Đọc từng
   dòng nó in ra, có lỗi thì đọc sidecar.log / sidecar.err.log trong kho để sửa.
7. Kiểm tra http://127.0.0.1:7440/api/status trả JSON. Chạy `tailscale serve status` xem đã
   có cổng 8443.
8. Cuối cùng liệt kê cho tôi các việc phải tự làm tay (mục "Việc làm tay" trong README), yêu cầu với project Unity
   (Unity 6000.3+, Input System) và địa chỉ để mở UnityPilot trên điện thoại.
````

Máy thứ hai trở đi: dán lại đúng prompt đó, trả lời "đã có kho riêng".

## Install manual

Cần: **Windows** 10/11, `git`, Unity 6000.3+ cài qua Unity Hub. Bun và ffmpeg được `install.ps1` tự cài bằng winget.
PC và điện thoại nối với nhau bằng **Tailscale** (không mở port, không cần server).

**1. Tạo kho riêng (một lần).** Mỗi người một kho private, vì nút **Cập nhật** trên trang kéo bản mới từ kho này. Giữ
kho gốc làm `upstream` để sau này lấy bản mới:

```powershell
git clone https://github.com/anviettrung/unitypilot.git D:\Projects\unitypilot
cd D:\Projects\unitypilot
git remote rename origin upstream
gh repo create <you>/unitypilot --private --source . --push     # hoặc tạo kho trống trên web, rồi git remote add origin ... && git push -u origin main
```

**2. Cấu hình**, rồi commit, push:

| Tệp, trường | Ý nghĩa |
|---|---|
| `machines.json` → `owner` | Email tài khoản Tailscale của bạn. Truy cập qua tailnet chỉ nhận đúng tài khoản này. |
| `machines.json` → `machines[]` | Mỗi PC một dòng: `name` (tên ngắn hiện trên trang), `computer` (= `$env:COMPUTERNAME`), `host` (tên máy trong tailnet, chữ thường). Dùng chung tên với ClaudeMon nếu có. |
| `unitypilot.json` → `projectRoots` | Thư mục quét tìm project Unity (2 tầng), vd `["D:/Projects"]`. Để `[]` thì chỉ dùng các project Unity Hub đã biết (luôn được cộng thêm). |
| `unitypilot.json` → cổng | `port` 7440 (web + WebSocket, 127.0.0.1), `httpsPort` 8443 (tailscale serve), `unityPort` 7441 (Unity Editor nối vào, 127.0.0.1) |

**3. Tailscale:**

- Một lần trên [trang quản trị](https://login.tailscale.com/admin): trang DNS bật **MagicDNS** và **HTTPS
  Certificates**; trang Machines chọn **Disable key expiry** cho từng PC.
- Mỗi PC: `winget install --id Tailscale.Tailscale -e`, `tailscale up --unattended` (đăng nhập trong trình duyệt), rồi
  `tailscale set --hostname <host>` theo `machines.json`.
- Điện thoại: cài app Tailscale, đăng nhập cùng tài khoản, bật VPN.

**4. Cài trên từng PC:** clone kho riêng của bạn, nháy đúp `install.cmd` (chạy lại bao nhiêu lần cũng được, không cần
quyền admin). Nó làm:

1. Tìm Bun và ffmpeg, chưa có thì cài bằng winget; `bun install`.
2. Đăng ký Scheduled Task **UnityPilot Sidecar** (quyền thường) chạy lúc đăng nhập, không cửa sổ.
3. Khởi động lại sidecar khi kho sang commit khác.
4. Tailscale đã đăng nhập thì bật `tailscale serve --https=8443` → `http://127.0.0.1:7440`.

**5. Gắn package vào project Unity.** Mở project từ trang thì sidecar tự gắn theo cách thứ nhất, không cần làm tay.

- **Chỉ máy mình, không commit gì vào repo game** (nên dùng):
  `powershell -File scripts/link-project.ps1 -Project <thư mục project>`. Tạo junction `Assets/UnityPilot` → thư mục
  `unity/` của kho và khai nó trong `.git/info/exclude`. Unity cảnh báo "Assets/UnityPilot is a symbolic link…": vô
  hại. Vài project vẫn thấy `Assets/UnityPilot.meta` là tệp mới (do `.gitignore` mẫu của Unity có
  `!/[Aa]ssets/**/*.meta`): đừng stage.
- **Cả team dùng chung qua manifest:** thêm vào `Packages/manifest.json`
  `"com.unitypilot.unity": "https://github.com/<you>/unitypilot.git?path=unity"` (kho private thì máy phải đọc được kho
  qua git; thêm `#<tag hoặc commit>` cuối URL để ghim bản). Sidecar thấy dòng này thì không tự tạo junction. Đừng dùng
  cả hai cách trong cùng một project (trùng assembly).

Yêu cầu với project: bật Input System (*Active Input Handling* = Input System hoặc Both). Game đọc chạm qua
`Touchscreen`, EnhancedTouch, hoặc UI EventSystem với `InputSystemUIInputModule` (tạo bằng code thì phải gọi
`AssignDefaultActions()`). `Input.touches` kiểu cũ không nhận.

**Việc làm tay sau khi cài:**

- Điện thoại (đã bật Tailscale) mở `https://<host>.<tailnet>.ts.net:8443/` của một PC bất kỳ: link nào cũng điều khiển
  được mọi PC. Chọn *Thêm vào màn hình chính* để dùng như app.
- ☰ → **Máy** đổi PC đang xem, **Project** → **Mở** để mở Unity, rồi ▶ Play.

## Gỡ, cập nhật

**Cập nhật**

- Bản mới từ kho gốc: `git pull upstream main`, `git push`, rồi chạy lại `install.cmd`. Cấu hình trùng dòng sửa thì giữ
  bản của bạn.
- Máy khác nhận bản mới: trên trang, ô của máy chạy bản cũ hơn ở hàng **Máy** có nút **Cập nhật** (sidecar kéo kho của
  bạn, chỉ fast-forward, tự khởi động lại khoảng 10 giây), hoặc `git pull` + `install.cmd` trên máy đó.
- Package Unity gắn bằng junction nhận mã mới ngay khi Unity refresh; gắn qua manifest thì đổi `#<tag>` hoặc xoá mục
  trong `packages-lock.json` để Unity tải lại.

**Gỡ khỏi một máy**

```powershell
powershell -File scripts\link-project.ps1 -Project <project> -Remove     # cho từng project đã gắn
Unregister-ScheduledTask 'UnityPilot Sidecar' -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | ? CommandLine -like '*unitypilot*' | % { Stop-Process -Id $_.ProcessId -Force }
tailscale serve --https=8443 off
Remove-Item "$env:USERPROFILE\.unitypilot", "$env:LOCALAPPDATA\unitypilot" -Recurse -Force -ErrorAction SilentlyContinue
```

Rồi xoá thư mục kho. Tạm tắt mà không gỡ: `Disable-ScheduledTask -TaskName 'UnityPilot Sidecar'`.

## Kiến trúc

```
Điện thoại (PWA)                     Mỗi PC
┌──────────────────────┐        ┌───────────────────────────────────────────────┐
│ canvas + WebCodecs   │◀ H.264 │ sidecar (Bun, 127.0.0.1:7440, quyền thường)   │
│ chạm đa điểm         │   WS   │  - web, bảo mật, encode, gửi khung            │
│ Play/Stop, project   ├───────▶│  - project, mở/tắt Unity, hộp thoại           │
└──────────────────────┘        │        ▲ RGBA, trạng thái  │ chạm, lệnh       │
  tailscale serve :8443          │        │  TCP :7441        ▼                  │
                                 │ Unity Editor + package com.unitypilot.unity  │
                                 └───────────────────────────────────────────────┘
```

**Sidecar** (`src/`, TypeScript trên Bun):

- `main.ts`: Bun.serve (PWA + WebSocket `/ws`). Bảo mật: chỉ nghe ở `127.0.0.1`; request qua `tailscale serve` phải
  có `Tailscale-User-Login` đúng `owner`; `Origin` của WebSocket phải là localhost hoặc `https://<máy>.<tailnet>.ts.net`.
  Người xem vào sau cùng quyết định cỡ khung; không còn ai xem (sau 3 giây) thì tắt chụp và ffmpeg. Tự cập nhật.
- `core/encoder.ts`: RGBA qua stdin của ffmpeg → H.264. `h264_nvenc` (`-preset p1 -tune ull -zerolatency 1`) nếu có
  card NVIDIA, không thì `libx264 -preset ultrafast -tune zerolatency`; baseline, không B-frame, keyframe mỗi giây.
  Mạng chậm (bộ đệm WebSocket > 512 KB) thì bỏ khung tới keyframe kế tiếp. Trình duyệt không có WebCodecs thì ffmpeg
  thứ hai ra JPEG. Ép encoder: `UNITYPILOT_ENCODER=libx264`.
- `apps/unity/`: `link.ts` (TCP cho Unity Editor, nhiều Editor cùng lúc), `projects.ts` (quét project, tìm Unity
  Editor, mở/tắt qua WMI nên Unity không là tiến trình con của sidecar; cất `Temp/__Backupscenes` sang
  `%LOCALAPPDATA%\unitypilot\scene-backups\` trước khi mở để Unity khỏi đứng chờ hộp thoại khôi phục), `popups.ts` +
  `scripts/win-helper.ps1` (tìm, chụp và bấm hộp thoại của Unity qua Win32). Đang mở nhận ra nhờ `Temp/UnityLockfile`.
  Sidecar chỉ mở/tắt project có trong danh sách.
- `apps/`: kiến trúc lõi / app để thêm app khác về sau: class theo `App` (`src/apps/types.ts`, `stream()` +
  `host.pushRaw()`), khai trong `src/apps/index.ts`, phần giao diện là một `WebApp` (`web/core.ts`) trong
  `web/apps/index.ts`. Mục **Ứng dụng** trong ☰ tự hiện khi có từ 2 app.

**Package Unity** (`unity/`, `com.unitypilot.unity`, chỉ chạy trong Editor):

- `Runtime/PilotCapture.cs`: cuối mỗi khung `ScreenCapture.CaptureScreenshotIntoRenderTexture`, thu nhỏ và lật trên GPU,
  đọc về bằng `AsyncGPUReadback`; giữ nhịp theo fps, còn 2 lần đọc đang chờ thì bỏ khung.
- `Editor/PilotBridge.cs`: client TCP tới sidecar, tự nối lại sau mỗi domain reload. Gói `u32 độ dài | u8 loại | nội
  dung`. Play từ điện thoại gọi `AssetDatabase.Refresh()` trước, chờ compile xong mới vào Play. Lệnh: `play`, `stop`,
  `pause`, `refresh`, `quit` (`save` / `discard`), `scene`, `touch`, `stream`.
- `Editor/PilotTouch.cs`: `Touchscreen` ảo `UnityPilotTouch`; khi vào Play đặt (chỉ trong bộ nhớ)
  `AllDeviceInputAlwaysGoesToGameView` và `IgnoreFocus`. `Editor/PilotGameView.cs`: Game view theo tỉ lệ điện thoại.

**PWA** (`web/`): `app.ts` nối tới sidecar của mọi PC (`wss://<máy>.<tailnet>:8443/ws`), giải mã bằng `VideoDecoder`
(`optimizeForLatency`, hàng đợi > 4 thì bỏ tới keyframe), thanh dưới (độ trễ, Play/Stop), bảng ☰ (máy, project, tỉ lệ
màn hình, chất lượng 360p–1080p, 30/60 fps, thông số đo). Hộp thoại của Unity hiện lên điện thoại khi đang xem đúng máy
đó. `public/sw.js` lưu vỏ trang để mở được cả khi PC của link đang tắt.

**Độ trễ đo được** (i5-12400, RTX 3060, Unity 6000.3 D3D12, khung 720x1476, 4 Mbps, trung vị): chụp→hiện 18 ms,
chạm→hiện 35 ms trên chính máy; iPhone qua Wi-Fi nhà và Tailscale: chụp→hiện 37 ms.

**Phát triển và kiểm thử**

- Chạy tay: dừng task "UnityPilot Sidecar" rồi `bun run dev`. Chạy thêm một sidecar thử cạnh sidecar thật:
  `UNITYPILOT_PORT=7451 UNITYPILOT_UNITY_PORT=7452`. Log: `sidecar.log`, `sidecar.out.log`, `sidecar.err.log`.
- `scripts/ui-shots.ts [thư mục]`: chụp giao diện trong Chrome headless, không gửi lệnh nào sang máy.
- `scripts/probe.ts <label> [scene] [giây] [quality] [fps]`: đo cả chuỗi ở chế độ `?autotest`.
- `scripts/check.ts [giây]`: client WebSocket tối giản, đếm khung mỗi giây.
- `scripts/focus.ps1 [tiến trình|minimize-unity|restore-unity]`: thử stream khi Unity không ở trên cùng.
