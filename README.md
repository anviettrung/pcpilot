# UnityPilot

Chơi thử game Unity trong Editor từ điện thoại: Unity Editor chạy trên PC, điện thoại nhận hình Game view và gửi chạm
đa điểm về. Thêm: danh sách project trên mọi máy, mở/tắt Unity, Play/Stop, trả lời hộp thoại của Unity ngay trên
điện thoại, chọn tỉ lệ màn hình. Tên đọc "iu-ni-ti-pai-lợt".

Chỉ chạy trên **Windows**. Các PC và điện thoại nối với nhau bằng **Tailscale** (không mở port, không cần server).

## Cài

Mỗi người một kho riêng (private), vì nút **Cập nhật** trên trang kéo bản mới từ chính kho của bạn.

1. Trên GitHub tạo kho mới từ kho này (**Use this template** → Private), clone về PC, nên cùng đường dẫn trên mọi máy:
   ```powershell
   git clone https://github.com/<you>/unitypilot.git D:\Projects\unitypilot
   ```
2. Sửa `machines.json`: `owner` = email tài khoản Tailscale của bạn (chỉ tài khoản này mở được trang), mỗi PC một dòng:
   `name` (tên ngắn hiện trên trang), `computer` (= `$env:COMPUTERNAME` của máy đó), `host` (tên máy trong tailnet).
   Sửa `projectRoots` trong `unitypilot.json` nếu project không nằm trong danh sách của Unity Hub. Commit, push.
3. Cài Tailscale trên mọi PC và điện thoại, cùng một tài khoản. Trên trang quản trị Tailscale (DNS) bật **MagicDNS** và
   **HTTPS Certificates**. Mỗi PC: `tailscale up`, rồi `tailscale set --hostname <host>` theo `machines.json`.
4. Nháy đúp `install.cmd` (chạy lại bao nhiêu lần cũng được, không cần quyền admin): cài Bun và ffmpeg (winget) nếu
   chưa có, `bun install`, Scheduled Task "UnityPilot Sidecar" chạy lúc đăng nhập (không cửa sổ), và `tailscale serve`
   ở cổng **8443**. Làm lại bước này trên từng PC.

## Dùng thế nào

1. Điện thoại (đã bật Tailscale) mở `https://<host>.<tailnet>.ts.net:8443/` của một máy bất kỳ: **link nào cũng điều
   khiển được mọi máy.** Thêm vào màn hình chính để dùng như app (PWA): vỏ trang lưu sẵn, máy của link có tắt thì vẫn
   mở được và nối sang máy khác.
2. ☰ → **Máy** đổi máy đang xem; **Project** mở project.

Thanh dưới: ☰, chấm màu độ trễ (xanh ≤ 80 ms, vàng ≤ 160 ms, đỏ) kèm số ms, ⏸ (khi đang Play), nút chính ▶ Play /
■ Stop (quay vòng khi đang chờ Unity), nút thu gọn thanh (thu gọn thì hình chiếm cả màn hình, còn một nút tròn nhỏ kéo
được). ☰ còn có tỉ lệ màn hình, chất lượng (Rất cao 1080p, Cao 720p, Vừa 540p, Thấp 360p; không phóng to quá cỡ gốc),
30/60 fps, hiện điểm chạm, thông số đo, Tải lại. Sidecar khởi động lại (thường là vừa có bản mới) thì trang hiện dải
"Có bản mới · Tải lại". Máy nào chạy bản cũ hơn thì ô của nó ở hàng Máy có nút **Cập nhật** (sidecar máy đó kéo kho
unitypilot, tự khởi động lại, khoảng 10 giây).

- **Project** (☰): project của mọi máy. **Mở** (gắn package nếu cần rồi mở Unity, trang tự chuyển sang xem project
  đó), bấm vào project đang mở để xem nó, **Tắt** (scene chưa lưu thì hỏi "Lưu rồi tắt" / "Bỏ thay đổi"; project chưa
  nối thì đóng cửa sổ như bấm X, hoặc **Buộc tắt**).
- **Tỉ lệ màn hình**: Tự do (theo điện thoại), 16:9, iPhone X, iPad; Game view đổi theo. Dọc hay ngang theo cách cầm.
- Lớp phủ báo: Unity chưa mở, đang mở, đang compile ("compile xong sẽ tự vào Play"), đang vào Play, chưa Play (kèm nút
  Play). Đang Play thì giữ màn hình sáng.
- **Hộp thoại của Unity hiện lên điện thoại** (khôi phục scene, lưu scene, Safe Mode…): ảnh chụp hộp thoại, các nút
  của nó thành nút lớn, "Đóng hộp thoại (Esc)", "Để sau". Chạm thẳng vào ảnh cũng được. Chỉ tự hiện khi đang xem đúng
  máy đó (đang xem máy khác thì không chen lên); muốn trả lời thì ☰ → bấm vào project đang hỏi, trang chuyển sang xem
  nó rồi hiện hộp thoại.
- Danh sách project: `projectRoots` trong `unitypilot.json` (mặc định `[]`, mỗi thư mục quét 2 tầng, vd
  `["D:/Projects"]`) cộng các project Unity Hub biết. Đang mở nhận ra nhờ khoá `Temp/UnityLockfile`. Unity mở qua WMI
  nên không là tiến trình con của sidecar (khởi động lại sidecar không tắt Unity), và chạy quyền thường. Unity bị tắt
  ngang để lại `Temp/__Backupscenes`: trước khi mở, sidecar cất sang `%LOCALAPPDATA%\unitypilot\scene-backups\` để
  Unity khỏi đứng chờ hộp thoại khôi phục. Sidecar chỉ mở/tắt project có trong danh sách.

## Gắn package vào project

Project cần Unity 6000.3+ và bật Input System (*Active Input Handling* = Input System hoặc Both). Game đọc chạm qua
`Touchscreen`, EnhancedTouch, hoặc UI EventSystem với `InputSystemUIInputModule` (tạo bằng code thì phải gọi
`AssignDefaultActions()`). `Input.touches` kiểu cũ không nhận.

- **Chỉ máy mình, không commit gì vào repo game** (nên dùng; mở project từ trang thì sidecar tự làm):
  `powershell -File scripts/link-project.ps1 -Project <thư mục project>`. Tạo junction
  `Assets/UnityPilot` → thư mục `unity/` của kho này và khai nó trong `.git/info/exclude`. Đặt trong `Assets/` thì Unity
  không ghi gì vào `manifest.json` hay `packages-lock.json`. Unity cảnh báo "Assets/UnityPilot is a symbolic link…":
  vô hại. `.gitignore` mẫu của Unity có `!/[Aa]ssets/**/*.meta` (thắng `.git/info/exclude`) nên vài project vẫn thấy
  `Assets/UnityPilot.meta` là tệp mới: đừng stage. Gỡ: thêm `-Remove`.
- **Cả team dùng chung qua manifest:** thêm vào `Packages/manifest.json` của project
  `"com.unitypilot.unity": "https://github.com/<you>/unitypilot.git?path=unity"` (thay `<you>` bằng
  chủ kho; kho private thì máy phải đọc được kho qua git). Có thể thêm `#<tag hoặc commit>` cuối URL để ghim bản.
  Cách này không cần junction (sidecar thấy dòng này thì không tự gắn junction nữa), nhưng sửa package thì phải đẩy lên
  kho rồi Unity mới nhận. Đừng dùng cả hai cách trong cùng một project (trùng assembly).

## Kiến trúc

```
Điện thoại (PWA)                     Mỗi máy
┌──────────────────────┐        ┌───────────────────────────────────────────────┐
│ canvas + WebCodecs   │◀ H.264 │ sidecar (Bun, 127.0.0.1:7440, quyền thường)   │
│ chạm đa điểm         │   WS   │  - web, bảo mật, encode, gửi khung            │
│ Play/Stop, project   ├───────▶│  - project, mở/tắt Unity, hộp thoại           │
└──────────────────────┘        │        ▲ RGBA, trạng thái  │ chạm, lệnh       │
  tailscale serve :8443          │        │  TCP :7441        ▼                  │
                                 │ Unity Editor + package com.unitypilot.unity  │
                                 └───────────────────────────────────────────────┘
```

Cổng ghi trong `unitypilot.json`. Danh sách máy và chủ tài khoản lấy từ `machines.json`.

### Sidecar (`src/`)

- `main.ts`: Bun.serve (PWA + WebSocket `/ws`), bảo mật giống ClaudeMon (`Tailscale-User-Login` phải là chủ tài khoản,
  `Origin` của WebSocket phải là localhost hoặc `https://<máy>.<tailnet>.ts.net`). Chọn app đang xem, bật nguồn hình,
  encode, gửi khung, tự cập nhật.
- Người xem vào sau cùng quyết định cỡ khung. Không còn ai xem (sau 3 giây) thì tắt chụp và ffmpeg.
- `core/encoder.ts`: `RawEncoder` (RGBA qua stdin). `h264_nvenc` (`-preset p1 -tune ull -zerolatency 1`) nếu có card
  NVIDIA, không thì `libx264 -preset ultrafast -tune zerolatency` (đừng tắt `sliced-threads`: trễ lên ~540 ms);
  baseline, không B-frame, keyframe mỗi giây, có AUD. Annex B cắt theo AUD cộng mốc "rảnh 2 ms". Ép encoder:
  `UNITYPILOT_ENCODER=libx264`.
- Mạng chậm (bộ đệm WebSocket > 512 KB): bỏ khung tới keyframe kế tiếp thay vì để trễ dồn lên. Trình duyệt không có
  WebCodecs: ffmpeg thứ hai ra JPEG (tối đa 15 khung/giây).
- Gói gửi điện thoại: 32 byte đầu (loại, keyframe, cỡ, số khung, số chạm, lúc chụp, lúc gửi) + Annex B / JPEG.
- `apps/`: mỗi app một tệp, khai trong `apps/index.ts`. `apps/unity/`: `link.ts` (TCP cho Unity, nhiều Editor cùng
  lúc), `projects.ts` (quét project, tìm Unity Editor, mở/tắt), `popups.ts` + `scripts/win-helper.ps1` (hộp thoại: tìm
  và chụp qua Win32, bấm bằng `BM_CLICK` / thông điệp chuột gửi vào cửa sổ, chỉ khi không được mới click chuột thật).

### Package Unity (`unity/`, `com.unitypilot.unity`)

- `Runtime/PilotCapture.cs` (chỉ có trong Editor): cuối mỗi khung `ScreenCapture.CaptureScreenshotIntoRenderTexture`,
  thu nhỏ và lật trên GPU, đọc về bằng `AsyncGPUReadback`; giữ nhịp theo fps; còn 2 lần đọc đang chờ thì bỏ khung.
- `Editor/PilotBridge.cs`: client TCP tới sidecar, tự nối lại sau mỗi domain reload. Gói `u32 độ dài | u8 loại | nội
  dung`. Play từ điện thoại gọi `AssetDatabase.Refresh()` trước, chờ compile xong mới vào Play. Lệnh: `play`, `stop`,
  `pause`, `refresh`, `quit` (`save` / `discard`), `scene`, `touch`, `stream`.
- `Editor/PilotTouch.cs`: `Touchscreen` ảo `UnityPilotTouch`; khi vào Play đặt (chỉ trong bộ nhớ)
  `AllDeviceInputAlwaysGoesToGameView` và `IgnoreFocus`. `Editor/PilotGameView.cs`: Game view theo tỉ lệ điện thoại
  (mục cỡ "UnityPilot").
- Sửa package: junction (`link-project.ps1`) thì Unity nhận khi sửa mã; khai bằng `file:` trỏ ra ngoài project thì không.

### PWA (`web/`)

- `app.ts` nối mọi thứ: kết nối tới sidecar của mọi máy (`wss://<máy>.<tailnet>:8443/ws`), giải mã (`VideoDecoder`
  với `optimizeForLatency`, codec lấy từ SPS, hàng đợi > 4 thì bỏ tới keyframe), thanh dưới, bảng ☰, đo độ trễ.
  `core.ts`: trạng thái, tiện ích, giao diện `WebApp`. `apps/unity.ts`: phần riêng của app Unity. `public/sw.js` lưu
  vỏ trang (mạng trước, quá 4 giây thì bản đã lưu).
- Đo: lệch giờ với máy chủ ước từ ping có RTT nhỏ nhất; *chụp→hiện* và *chạm→hiện* (Unity gắn số chạm vào khung).

## Thêm app mới

Kiến trúc vẫn chia lõi / app để thêm app khác về sau (vd một công cụ khác tự đưa khung hình). Mục **Ứng dụng** trong ☰
tự hiện khi máy có từ 2 app.

1. `src/apps/<tên>.ts`: class theo `App` trong `src/apps/types.ts`: `stream(target)` bật/tắt nguồn hình theo cỡ khung,
   đưa khung RGBA bằng `host.pushRaw()`, `status()` cho trạng thái riêng, `onMessage` cho lệnh riêng.
2. Thêm vào `APPS` trong `src/apps/index.ts` (app đầu tiên là mặc định).
3. `web/apps/<tên>.ts`: một `WebApp` (`web/core.ts`) cùng `id`: lớp phủ, nút trên thanh (`group` khớp
   `data-group` trong `index.html`), phần riêng trong ☰ (`section` khớp `data-section`), chạm (`pointer`). Thêm vào
   `WEB_APPS` trong `web/apps/index.ts`. Icon ảnh đặt ở `web/public/apps/` và thêm đường dẫn vào `routes` trong
   `src/main.ts`.

## Cài, cập nhật, gỡ

- `install.ps1`: Bun, ffmpeg, `bun install`, task "UnityPilot Sidecar" (quyền thường; khởi động lại khi kho
  sang commit khác), `tailscale serve --https=8443`. Không cần quyền admin.
- Cổng (`unitypilot.json`): `port` 7440 (web + WebSocket, 127.0.0.1), `httpsPort` 8443 (tailscale serve), `unityPort`
  7441 (Unity Editor nối vào, 127.0.0.1).
- Tắt UnityPilot trên một máy: `Disable-ScheduledTask -TaskName 'UnityPilot Sidecar'`. Gỡ hẳn:
  `Unregister-ScheduledTask -TaskName 'UnityPilot Sidecar' -Confirm:$false`, `tailscale serve --https=8443 off`, rồi
  `link-project.ps1 -Project <project> -Remove` cho từng project đã gắn.
- Cập nhật: `git pull` rồi chạy lại `install.cmd`, hoặc bấm **Cập nhật** ở hàng Máy trên trang.
- Log: `sidecar.log`, `sidecar.out.log`, `sidecar.err.log` trong thư mục này (gitignore).

## Công cụ thử (`scripts/`)

- `ui-shots.ts [thư mục]`: chụp giao diện trong Chrome headless (dọc, ☰ với danh sách project, thông số, ngang). Không
  gửi chạm hay lệnh nào sang máy.
- `probe.ts <label> [scene] [giây] [quality] [fps]`: đo cả chuỗi ở chế độ `?autotest` (`PROBE_BASE`, `PROBE_JPEG=1`,
  `PROBE_NOTAP=1`, `PROBE_ASPECT`). Trang nhận `?app=<id>` để xin app khi mở.
- `check.ts [giây] [x,y|-] [lệnh] [app]`: client WebSocket tối giản, đếm khung mỗi giây.
- `focus.ps1 [tiến trình|minimize-unity|restore-unity]`: đổi focus / thu nhỏ Unity để thử stream khi Unity không ở
  trên cùng.
- Chạy sidecar tay khi sửa mã: dừng task "UnityPilot Sidecar" rồi `bun run dev`. Chạy thêm một sidecar thử cạnh sidecar
  thật: `UNITYPILOT_PORT=7451 UNITYPILOT_UNITY_PORT=7452` (Unity vẫn nối vào sidecar thật ở 7441).

## Kết quả đo cũ

i5-12400, RTX 3060, Unity 6000.3.10f1 D3D12, ffmpeg 9.0.2, khung 720x1476, 4 Mbps, Chrome headless trên chính máy đó,
trung vị (p90), ms:

| Trường hợp | fps | chụp→hiện | chạm→hiện |
|---|---|---|---|
| NVENC 30 fps | 30 | 18 (21) | 35 (48) |
| x264 30 fps | 30 | 19 (22) | 36 (49) |
| Qua `tailscale serve` | 30 | 19 (28) | 42 (55) |
| Project thật (URP, D3D11) | 30 | 42 | – |
| **iPhone, Wi-Fi nhà**, qua Tailscale | 30 | **37 (60)** | chưa đo |

Unity thu nhỏ hay mất focus vẫn stream đủ fps (vào Play thì Unity tự lấy focus). Còn chờ: đo chạm→hiện trên điện
thoại, đo qua 4G.

## Để sau

- Xem log và lỗi Console trên điện thoại, đổi scene từ trang (lệnh `scene` đã có), chụp màn hình gửi về; config từ
  điện thoại (field đánh dấu bằng attribute, package xuất schema, trang tự vẽ form).
