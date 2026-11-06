# PcPilot

PcPilot điều khiển PC Windows từ điện thoại: xem cả màn hình hay một cửa sổ, chạm thành chuột, gõ phím (cả tiếng Việt
có dấu), bàn phím ảo tự xếp nút. Có thêm app **Unity** để chơi thử game đang mở trong Unity Editor với chạm đa điểm,
mở/tắt project, Play/Stop và trả lời hộp thoại của Unity ngay trên điện thoại.

## Install bằng AI

Mở Claude Code (hoặc AI agent khác chạy được lệnh trên máy) ở một thư mục bất kỳ trên PC, dán prompt sau:

````text
Cài PcPilot cho tôi trên máy Windows này. Mã nguồn: https://github.com/anviettrung/pcpilot. Làm lần lượt, mỗi bước kiểm tra kết quả rồi mới sang bước sau:

1. Kiểm tra có git và GitHub CLI (gh) đã đăng nhập (`gh auth status`). Thiếu gì thì cài bằng winget nếu được; việc
   cần tôi đăng nhập thì dừng lại chỉ tôi cách làm.
2. Hỏi tôi: (a) thư mục đặt kho (gợi ý D:\Projects\pcpilot, nên giống nhau trên mọi máy), (b) đây là máy đầu
   tiên hay tôi đã có kho pcpilot riêng rồi, (c) tôi muốn vào PcPilot từ điện thoại bằng gì: Tailscale (mặc định,
   dễ nhất), Cloudflare Tunnel + Access (cần tên miền trên Cloudflare), proxy khác (ngrok OAuth, oauth2-proxy...), hay
   chỉ dùng trên máy này; giải thích ngắn khác biệt nếu tôi chưa rõ, (d) email tôi dùng để đăng nhập cách đó, (e) các
   thư mục chứa project Unity của tôi (bỏ trống nếu không dùng Unity hoặc project nào cũng có trong Unity Hub).
3. Máy đầu tiên: clone https://github.com/anviettrung/pcpilot.git vào thư mục đó, đổi remote origin thành upstream,
   tạo kho private của tôi bằng `gh repo create <tài khoản gh của tôi>/pcpilot --private --source . --push`.
   Đã có kho riêng: clone kho riêng của tôi vào thư mục đó.
4. Đọc README.md trong kho, làm theo mục "Install manual": sửa machines.json (owner = email ở bước 2d; access
   theo bước 2c; thêm dòng cho máy này nếu chưa có, computer = $env:COMPUTERNAME, host = tên ngắn chữ thường không
   dấu, name = tên ngắn viết hoa, url nếu không dùng Tailscale; nếu tôi đã cài ClaudeMon thì dùng đúng các tên máy và
   cách truy cập trong machines.json của ClaudeMon), thêm thư mục ở bước 2e vào projectRoots trong pcpilot.json
   (dấu /), commit và push. Không để lại dòng mẫu PC1/PC2 nếu không dùng.
5. Dựng cách truy cập từ xa đã chọn theo mục "3. Truy cập từ xa" trong README: tự cài phần mềm được (tailscale,
   cloudflared) thì cài; việc phải đăng nhập hay bấm trên trang quản trị (Tailscale, Cloudflare Zero Trust) thì chỉ tôi
   từng bước, chờ tôi báo xong, hỏi tôi giá trị cần điền (AUD tag, team domain, hostname) rồi ghi vào machines.json.
6. Chạy `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` trong kho. Đọc từng dòng nó in ra, có lỗi
   thì đọc sidecar.log / sidecar.err.log trong kho để sửa.
7. Đăng ký tiến trình gửi phím quyền admin (task "PcPilot Input"), chỉ cần một lần mỗi máy: nhờ tôi mở PowerShell
   bằng "Run as administrator" và chạy đúng lệnh ở bước 6 (đưa tôi lệnh có đường dẫn đầy đủ để dán). Giải thích cho
   tôi: Windows chặn phím, chuột từ tiến trình quyền thường gửi tới app chạy quyền admin, nên bỏ bước này thì PcPilot
   vẫn chạy nhưng app chạy quyền admin (một số game, công cụ hệ thống, Task Manager...) sẽ không nhận phím, chuột từ
   điện thoại. Chờ tôi báo xong rồi kiểm `Get-ScheduledTask 'PcPilot Input'` có và đang chạy.
8. Kiểm tra http://127.0.0.1:7440/api/status trả JSON (stream.elevated = true nếu bước 7 đã xong). Dùng Tailscale thì
   chạy `tailscale serve status` xem đã có cổng 8443; dùng cách khác thì nhờ tôi mở url của máy này trên điện thoại.
9. Cuối cùng liệt kê cho tôi các việc phải tự làm tay (mục "Việc làm tay" trong README), yêu cầu với project Unity
   nếu tôi dùng (Unity 6000.3+, Input System) và địa chỉ để mở PcPilot trên điện thoại.
````

Máy thứ hai trở đi: dán lại đúng prompt đó, trả lời "đã có kho riêng".

## Install manual

Cần: **Windows** 10/11, `git`; Unity 6000.3+ cài qua Unity Hub nếu dùng app Unity. Bun và ffmpeg được `install.ps1`
tự cài bằng winget. Điện thoại vào qua Tailscale, Cloudflare Tunnel hoặc proxy khác tuỳ bạn (bước 3), không cần mở port.

**1. Tạo kho riêng (một lần).** Mỗi người một kho private, vì nút **Cập nhật** trên trang kéo bản mới từ kho này. Giữ
kho gốc làm `upstream` để sau này lấy bản mới:

```powershell
git clone https://github.com/anviettrung/pcpilot.git D:\Projects\pcpilot
cd D:\Projects\pcpilot
git remote rename origin upstream
gh repo create <you>/pcpilot --private --source . --push     # hoặc tạo kho trống trên web, rồi git remote add origin ... && git push -u origin main
```

**2. Cấu hình**, rồi commit, push:

| Tệp, trường | Ý nghĩa |
|---|---|
| `machines.json` → `owner` | Email bạn dùng để đăng nhập lớp truy cập từ xa (tài khoản Tailscale, email Cloudflare Access...). Truy cập từ xa chỉ nhận đúng người này. |
| `machines.json` → `access` | Cách truy cập từ xa, xem bước 3 |
| `machines.json` → `machines[]` | Mỗi PC một dòng: `name` (tên ngắn hiện trên trang), `computer` (= `$env:COMPUTERNAME`), `host` (tên máy trong tailnet, chữ thường, chế độ `tailscale`), `url` (địa chỉ HTTPS của sidecar máy đó khi không dùng Tailscale, vd `https://pc1-pilot.example.com`). Dùng chung tên với ClaudeMon nếu có. |
| `pcpilot.json` → `projectRoots` | Thư mục quét tìm project Unity (2 tầng), vd `["D:/Projects"]`. Để `[]` thì chỉ dùng các project Unity Hub đã biết (luôn được cộng thêm). |
| `pcpilot.json` → cổng | `port` 7440 (web + WebSocket, 127.0.0.1), `httpsPort` 8443 (tailscale serve), `unityPort` 7441 (Unity Editor nối vào), `inputPort` 7442 (tiến trình gửi phím quyền admin), đều ở 127.0.0.1 |

**3. Truy cập từ xa** (chọn một cách, khai ở `access.mode` trong `machines.json`; chỉ dùng một máy thì chọn `local`
và mở bằng `localhost`). PcPilot chỉ nghe ở `127.0.0.1`; máy khác và điện thoại vào qua một lớp chuyển tiếp HTTPS,
lớp đó phải xác nhận người dùng là `owner`. PcPilot điều khiển được chuột, bàn phím của PC: đừng mở nó ra Internet mà
không có lớp xác thực.

| `mode` | Dùng gì | Hợp khi |
|---|---|---|
| `tailscale` (mặc định) | Tailscale + `tailscale serve` | Dễ nhất, không cần tên miền. Mọi thiết bị phải cài Tailscale. |
| `cloudflare` | Cloudflare Tunnel + Cloudflare Access | Có tên miền trên Cloudflare, muốn mở từ trình duyệt bất kỳ không cần cài gì. |
| `proxy` | Reverse proxy tự xác thực: ngrok (OAuth), oauth2-proxy, Authelia, Pomerium... | Đã có sẵn hạ tầng riêng. |
| `local` | Không có | Chỉ dùng trên chính máy. |

*Tailscale*

- Một lần trên [trang quản trị](https://login.tailscale.com/admin) sau khi máy đầu tiên vào tailnet: trang DNS bật
  **MagicDNS** và **HTTPS Certificates** (tên máy sẽ nằm trong nhật ký chứng chỉ công khai, đừng đặt tên chứa thông tin
  riêng); trang Machines chọn **Disable key expiry** cho từng PC để máy không tự rớt sau 180 ngày.
- Mỗi PC: `winget install --id Tailscale.Tailscale -e`, rồi `tailscale up --unattended` (mở trình duyệt để đăng nhập;
  `--unattended` để chạy cả khi chưa đăng nhập Windows). Đặt tên máy: `tailscale set --hostname <host>` theo
  `machines.json`; `install.ps1` bật `tailscale serve`.
- Điện thoại: cài app Tailscale, đăng nhập cùng tài khoản, bật VPN. `owner` = email tài khoản Tailscale.

*Cloudflare Tunnel + Access* (gói Zero Trust miễn phí đủ dùng)

- Mỗi PC: `winget install --id Cloudflare.cloudflared -e`. Trong [Zero Trust](https://one.dash.cloudflare.com) →
  Networks → Tunnels → *Create a tunnel* (Cloudflared), chạy lệnh `cloudflared service install <token>` nó đưa. Thêm
  *Public hostname* cho máy đó, vd `pc1-pilot.example.com` → `http://localhost:7440`. Mỗi máy một tunnel, một hostname,
  cùng một tên miền.
- Một lần: Access → Applications → *Add an application* → Self-hosted, thêm mọi hostname ở trên, policy *Allow* với
  email của bạn. Ghi lại **Application Audience (AUD) tag** và tên miền team (`<team>.cloudflareaccess.com`, ở
  Settings → Custom pages / Team domain).
- Mỗi hostname phải mở (đăng nhập Access) một lần trên điện thoại; hostname nào chưa đăng nhập thì máy đó hiện mất
  kết nối trên trang.
- `machines.json`: `"access": { "mode": "cloudflare", "cloudflare": { "teamDomain": "<team>.cloudflareaccess.com",
  "aud": "<AUD tag>" } }`, mỗi máy điền `url` (vd `https://pc1-pilot.example.com`), `owner` = email đăng nhập Access.
  PcPilot kiểm chữ ký JWT của Access, nên ai gọi thẳng tunnel mà không qua Access đều bị chặn.

*Proxy khác*

- Proxy đưa mỗi máy ra một địa chỉ HTTPS, tự bắt đăng nhập, rồi gắn email người dùng vào một header và **ghi đè**
  header đó nếu client tự gửi. Vd ngrok `ngrok http 7440 --url <tên miền> --oauth google --oauth-allow-email <email>`
  gắn `ngrok-auth-user-email`; oauth2-proxy gắn `X-Forwarded-Email`.
- `machines.json`: `"access": { "mode": "proxy", "userHeader": "<tên header>" }`, mỗi máy điền `url`.

Với `cloudflare` và `proxy`: mở PcPilot bằng url của một máy để thấy cả các máy khác. `httpsPort` chỉ dùng cho
`tailscale serve`.

**4. Cài trên từng PC:** clone kho riêng của bạn, nháy đúp `install.cmd` (chạy lại bao nhiêu lần cũng được). Nó làm:

1. Tìm Bun và ffmpeg, chưa có thì cài bằng winget; `bun install`.
2. Đăng ký Scheduled Task **PcPilot Sidecar** (quyền thường) chạy lúc đăng nhập, không cửa sổ; khởi động lại sidecar
   khi kho sang commit khác.
3. Nếu đang chạy quyền admin: đăng ký Scheduled Task **PcPilot Input** (quyền cao nhất, xem dưới). Đã có task đó thì
   các lần sau chạy quyền thường vẫn được: mã của nó đổi thì `install.ps1` nhờ nó tự thoát để chạy lại bằng mã mới.
4. Chế độ `tailscale` và Tailscale đã đăng nhập: bật `tailscale serve --https=8443` → `http://127.0.0.1:7440`. Chế độ
   khác thì bỏ qua bước này.

**Tiến trình gửi phím quyền admin (một lần mỗi máy).** Windows (UIPI) lặng lẽ bỏ phím, chuột từ tiến trình quyền
thường gửi tới cửa sổ chạy quyền admin. Muốn điều khiển cả app quyền admin (một số game, công cụ hệ thống, Task
Manager; riêng hộp UAC thì không cách nào bấm từ xa), mở PowerShell bằng **Run as administrator** và chạy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Projects\pcpilot\install.ps1
```

(hoặc chỉ `scripts\register-input-task.ps1 -Bun <đường dẫn bun.exe>` quyền admin). Không làm thì PcPilot vẫn chạy, gửi
phím bằng quyền thường; ☰ báo "chưa có tiến trình gửi phím quyền admin".

**5. Gắn package vào project Unity** (chỉ khi dùng app Unity). Mở project từ trang thì sidecar tự gắn theo cách thứ
nhất, không cần làm tay.

- **Chỉ máy mình, không commit gì vào repo game** (nên dùng):
  `powershell -File scripts/link-project.ps1 -Project <thư mục project>`. Tạo junction `Assets/PcPilot` → thư mục
  `unity/` của kho và khai nó trong `.git/info/exclude`. Unity cảnh báo "Assets/PcPilot is a symbolic link…": vô
  hại. Vài project vẫn thấy `Assets/PcPilot.meta` là tệp mới (do `.gitignore` mẫu của Unity có
  `!/[Aa]ssets/**/*.meta`): đừng stage.
- **Cả team dùng chung qua manifest:** thêm vào `Packages/manifest.json`
  `"com.pcpilot.unity": "https://github.com/<you>/pcpilot.git?path=unity"` (kho private thì máy phải đọc được kho
  qua git; thêm `#<tag hoặc commit>` cuối URL để ghim bản). Sidecar thấy dòng này thì không tự tạo junction. Đừng dùng
  cả hai cách trong cùng một project (trùng assembly).

Yêu cầu với project: bật Input System (*Active Input Handling* = Input System hoặc Both). Game đọc chạm qua
`Touchscreen`, EnhancedTouch, hoặc UI EventSystem với `InputSystemUIInputModule` (tạo bằng code thì phải gọi
`AssignDefaultActions()`). `Input.touches` kiểu cũ không nhận.

**Việc làm tay sau khi cài:**

- Điện thoại mở `https://<host>.<tailnet>.ts.net:8443/` (Tailscale, nhớ bật VPN) hoặc `url` (Cloudflare, proxy) của một
  PC bất kỳ: link nào cũng điều khiển được mọi PC. Chọn *Thêm vào màn hình chính* để dùng như app.
- ☰ → **Máy** đổi PC đang xem, **Ứng dụng** đổi giữa Màn hình và Unity (mỗi máy stream một app một lúc).

**Dùng app Màn hình**

- **Chạm = chuột:** chạm nhẹ = click trái, chạm rồi kéo = giữ chuột kéo, giữ yên ~0,5 giây hoặc chạm nhẹ hai ngón =
  click phải, hai ngón kéo = cuộn. Chụm/mở hai ngón = phóng to hình trên điện thoại (máy không biết), nút "1×" để về.
  🖱 bật/tắt chuột.
- ⌨ bàn phím: Ctrl, Alt, Shift, Win (giữ cho phím kế tiếp), Esc, Tab, Del, mũi tên, ⌫, ↵, và **Gõ chữ** mở bàn phím
  điện thoại; chữ (cả tiếng Việt có dấu) gửi bằng ký tự Unicode.
- ✎ **bàn phím ảo** sửa được: kéo nút để dời, đổi phím, nhãn, cỡ; D-pad; nhiều bố cục đổi nhanh ở góc trên trái;
  **nút giữ** (giữ thì nhấn phím của nút và hiện một bố cục khác chồng lên, thả thì về). Bố cục lưu trên từng điện thoại,
  mỗi app một bộ.
- 📱 **chế độ điện thoại**: màn hình máy xoay theo cách cầm điện thoại (hoặc luôn dọc) và tăng cỡ chữ Windows để dễ
  bấm. Máy về đúng như cũ khi tắt chế độ, đổi app, không ai xem quá 1 phút hay sidecar thoát (mức cũ ghi ở
  `%LOCALAPPDATA%\pcpilot\display-saved.json`). Ai ngồi ở máy sẽ thấy màn hình xoay.
- ☰ → **Nguồn**: chọn màn hình, hoặc **Chọn cửa sổ** (chỉ lấy vùng client, theo cửa sổ khi dời chỗ, đổi cỡ). Cửa sổ
  không ở trên cùng thì có nút **Đưa lên trên**.
- Phím không kẹt: thả tay, rời trang, khoá màn hình, mất mạng, đổi app thì phím và chuột đều được nhả.

**Dùng app Unity:** ☰ → **Project** → **Mở** (gắn package nếu cần, mở Unity, tự chuyển sang xem), rồi ▶ Play.
**Tắt** hỏi lưu scene nếu cần. **Tỉ lệ màn hình** đổi Game view theo. Hộp thoại của Unity hiện lên điện thoại khi đang
xem đúng máy đó ở app Unity.

## Gỡ, cập nhật

**Cập nhật**

- Bản mới từ kho gốc: `git pull upstream main`, `git push`, rồi chạy lại `install.cmd`. Cấu hình trùng dòng sửa thì giữ
  bản của bạn.
- Máy khác nhận bản mới: trên trang, ô của máy chạy bản cũ hơn ở hàng **Máy** có nút **Cập nhật** (sidecar kéo kho của
  bạn, chỉ fast-forward, tự khởi động lại khoảng 10 giây; mã của tiến trình gửi phím đổi thì nhờ nó tự chạy lại), hoặc
  `git pull` + `install.cmd` trên máy đó.
- Package Unity gắn bằng junction nhận mã mới ngay khi Unity refresh; gắn qua manifest thì đổi `#<tag>` hoặc xoá mục
  trong `packages-lock.json` để Unity tải lại.

**Gỡ khỏi một máy**

```powershell
powershell -File scripts\link-project.ps1 -Project <project> -Remove     # cho từng project đã gắn
Unregister-ScheduledTask 'PcPilot Sidecar' -Confirm:$false
Unregister-ScheduledTask 'PcPilot Input' -Confirm:$false                  # PowerShell "Run as administrator"
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | ? CommandLine -like '*pcpilot*' | % { Stop-Process -Id $_.ProcessId -Force }   # quyền admin để tắt cả tiến trình gửi phím
tailscale serve --https=8443 off               # nếu dùng Tailscale
Remove-Item "$env:USERPROFILE\.pcpilot", "$env:LOCALAPPDATA\pcpilot" -Recurse -Force -ErrorAction SilentlyContinue
```

Dùng Cloudflare Tunnel thì gỡ thêm `cloudflared service uninstall` (cần quyền admin) và xoá tunnel, hostname trong
Zero Trust. Rồi xoá thư mục kho. Tạm tắt mà không gỡ: `Disable-ScheduledTask -TaskName 'PcPilot Sidecar'` (và
`'PcPilot Input'` bằng quyền admin; `install.ps1` thấy task bị tắt thì để yên).

## Kiến trúc

```
Điện thoại (PWA)                     Mỗi PC
┌──────────────────────┐        ┌─────────────────────────────────────────────────┐
│ canvas + WebCodecs   │◀ H.264 │ sidecar (Bun, 127.0.0.1:7440, quyền thường)     │
│ chạm → chuột / chạm  │   WS   │  - web, bảo mật, chọn app, encode, gửi khung    │
│ bàn phím, bàn phím ảo├───────▶│  - app 'screen': ffmpeg ddagrab cắt vùng → H.264│
│ Play/Stop, project   │        │  - app 'raw': Unity gửi RGBA (TCP :7441) → H.264│
└──────────────────────┘        │        │ phím, chuột (TCP :7442, mã bí mật)     │
  HTTPS (tailscale serve/tunnel) │        ▼                                        │
                                 │ input (Bun, quyền admin): SendInput             │
                                 └─────────────────────────────────────────────────┘
```

**Vì sao hai tiến trình.** App quyền admin chỉ nhận `SendInput` từ tiến trình quyền admin (UIPI; `SendInput` vẫn báo
thành công). Nhưng cả sidecar chạy quyền admin thì Unity mở từ trang cũng chạy quyền admin, và cả web server có quyền
admin. Nên tách: sidecar quyền thường làm mọi việc, chỉ phần gửi phím chuột nằm ở `src/elevated.ts` (task "PcPilot
Input", RunLevel Highest), nghe ở `127.0.0.1:7442`. Kết nối tới nó phải gửi mã bí mật đổi mỗi lần khởi động
(`%LOCALAPPDATA%\pcpilot\input-token.txt`, chỉ người dùng của máy đọc được); nó chỉ nhận phím, chữ, chuột, đưa cửa sổ
lên trên và lệnh thoát. Chưa có tiến trình đó thì sidecar tự gửi bằng quyền thường.

**Sidecar** (`src/`, TypeScript trên Bun):

- `main.ts`: Bun.serve (PWA + WebSocket `/ws`). Bảo mật (`core/access.ts`, chung với ClaudeMon): chỉ nghe ở
  `127.0.0.1`; request thẳng từ chính máy thì cho qua; request qua lớp chuyển tiếp phải mang danh tính đúng `owner`
  (`Tailscale-User-Login`, JWT của Cloudflare Access kiểm chữ ký, hoặc header `userHeader` của proxy); chế độ `local`
  chặn mọi request từ xa. `Origin` của WebSocket phải là localhost hoặc địa chỉ HTTPS của một máy khai báo. Chọn app
  và nguồn hình, đổi toạ độ chạm sang toạ độ màn hình. Người xem vào sau cùng quyết định cỡ khung và app; không còn ai
  xem (sau 3 giây) thì tắt chụp và ffmpeg. Tự cập nhật.
- `core/encoder.ts`: `RawEncoder` (RGBA qua stdin, nguồn Unity) và `ScreenCapture` (`ddagrab` của ffmpeg chụp ở mức
  màn hình như OBS "Display Capture", cắt vùng, scale). `h264_nvenc` (`-preset p1 -tune ull -zerolatency 1`) nếu có
  card NVIDIA, không thì `libx264 -preset ultrafast -tune zerolatency`; baseline, không B-frame, keyframe mỗi giây.
  Mạng chậm (bộ đệm WebSocket > 512 KB) thì bỏ khung tới keyframe kế tiếp. Trình duyệt không có WebCodecs thì ffmpeg
  thứ hai ra JPEG (chỉ nguồn Unity). Ép encoder: `PCPILOT_ENCODER=libx264`.
- `screen/`: `win32.ts` (màn hình, cửa sổ, chỉ đọc qua user32), `input.ts` (`SendInput` theo cách Chrome Remote
  Desktop làm: phím scancode, chuột tuyệt đối trên màn hình ảo, cuộn, chữ Unicode, đưa cửa sổ lên trên), `bridge.ts`
  (gửi qua tiến trình quyền admin hoặc tự gửi), `display.ts` (chế độ điện thoại: xoay màn hình bằng
  `ChangeDisplaySettingsExW` không ghi registry, cỡ chữ DPI như trang Settings). Màn hình đang xoay thì Desktop
  Duplication vẫn trả khung theo chiều gốc: sidecar đổi vùng cắt (`rawRect`) và ffmpeg `transpose` lại.
- `apps/`: mỗi app một lớp theo `App` (`apps/types.ts`), khai trong `apps/index.ts`. `desktop.ts` (Màn hình: chọn
  màn hình / cửa sổ, chế độ điện thoại). `window-app.ts`: khuôn cho app chụp theo một cửa sổ cố định (game, phần mềm),
  tìm cửa sổ theo lớp, cắt viền nếu cần, `requireForeground` chỉ gửi thao tác khi cửa sổ ở trên cùng. `apps/unity/`:
  `link.ts` (TCP cho Unity Editor, nhiều Editor cùng lúc), `projects.ts` (quét project, mở/tắt Unity qua WMI nên Unity
  không là tiến trình con của sidecar; cất `Temp/__Backupscenes` sang `%LOCALAPPDATA%\pcpilot\scene-backups\`),
  `popups.ts` + `scripts/win-helper.ps1` (tìm, chụp, bấm hộp thoại của Unity).

**Package Unity** (`unity/`, `com.pcpilot.unity`, chỉ chạy trong Editor): `Runtime/PilotCapture.cs` chụp Game view
cuối mỗi khung (thu nhỏ, lật trên GPU, `AsyncGPUReadback`); `Editor/PilotBridge.cs` client TCP tới sidecar, tự nối lại
sau domain reload, lệnh `play`, `stop`, `pause`, `refresh`, `quit`, `scene`, `touch`, `stream`; `Editor/PilotTouch.cs`
`Touchscreen` ảo `PcPilotTouch`; `Editor/PilotGameView.cs` Game view theo tỉ lệ điện thoại (mục cỡ "PcPilot").

**PWA** (`web/`): `app.ts` nối tới sidecar của mọi PC (theo `url` sidecar báo, hoặc `wss://<máy>.<tailnet>:8443/ws`),
giải mã bằng `VideoDecoder` (`optimizeForLatency`, hàng đợi > 4 thì bỏ tới keyframe), thanh dưới, bảng ☰, đo độ trễ.
`apps/index.ts` (danh sách app, Màn hình), `apps/screen.ts` (chung cho app chụp màn hình: chuột, bàn phím, bàn phím ảo,
phóng to, khoá ngang), `apps/unity.ts`; `pointer.ts`, `keyboard.ts`, `pad.ts`. `public/sw.js` lưu vỏ trang để mở được
cả khi PC của link đang tắt.

**Thêm app mới.** App chụp theo cửa sổ (thường gặp nhất):

1. Thêm `new WindowApp({ id, name, windowClass, title?, crop?, requireForeground? })` vào `APPS` trong
   `src/apps/index.ts`. Lớp cửa sổ xem bằng Spy++ hoặc ☰ → Màn hình → Chọn cửa sổ (dòng nhỏ dưới tên).
2. `web/apps/index.ts`: `screenApp({ id, icon, mouse, modeToggle?, landscape?, pad?, reasons, label? })` cùng id, thêm
   vào `WEB_APPS`. `mouse`: chạm có là chuột ngay không; `modeToggle`: nút góc đổi bàn phím ảo ↔ click; `landscape`:
   khoá ngang trên điện thoại; `pad`: bố cục bàn phím ảo mặc định; `reasons`: câu báo khi chưa chụp được (`offline`,
   `minimized`, `offscreen`, `monitor`). Icon ảnh đặt ở `web/public/apps/` và thêm vào `routes` trong `src/main.ts`.

App cần hơn thế (nguồn hình riêng như Unity, lệnh riêng): viết lớp theo `App` (`region()` cho nguồn 'screen', hoặc
`stream()` + `host.pushRaw()` cho nguồn 'raw'; `onMessage` cho lệnh riêng) và một `WebApp` (`web/core.ts`).

**Độ trễ đo được** (i5-12400, RTX 3060, Unity 6000.3 D3D12, khung 720x1476, 4 Mbps, trung vị): app Unity chụp→hiện
18 ms, chạm→hiện 35 ms trên chính máy; iPhone qua Wi-Fi nhà và Tailscale: chụp→hiện 37 ms. Chụp màn hình (ddagrab),
iPhone qua Wi-Fi: encode→hiện khoảng 16 ms.

**Phát triển và kiểm thử**

- Chạy tay: dừng task "PcPilot Sidecar" rồi `bun run dev`. Chạy thêm một sidecar thử cạnh sidecar thật:
  `PCPILOT_PORT=7451 PCPILOT_UNITY_PORT=7452 PCPILOT_INPUT_PORT=7453`. Log: `sidecar.log`, `sidecar.out.log`,
  `sidecar.err.log`, `input.log`.
- `scripts/ui-shots.ts [thư mục]`: chụp giao diện trong Chrome headless (`SHOTS_UNITY=1` chụp thêm app Unity), không
  gửi thao tác nào sang máy.
- `scripts/gesture-test.ts`: thử cử chỉ chạm của app Màn hình trong Chrome headless; lệnh chuột phím bị chặn ngay
  trong trang.
- `scripts/probe.ts <label> [scene] [giây] [quality] [fps]`: đo app Unity ở chế độ `?autotest`.
- `scripts/check.ts [giây] [x,y|-] [lệnh] [app]`: client WebSocket tối giản, đếm khung mỗi giây.
- `scripts/focus.ps1 [tiến trình|minimize-unity|restore-unity]`: thử stream khi Unity không ở trên cùng.
