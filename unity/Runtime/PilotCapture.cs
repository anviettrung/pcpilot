#if UNITY_EDITOR
using System;
using System.Collections;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace PcPilot.Unity
{
    /// <summary>Thông tin đi kèm một khung hình.</summary>
    public struct FrameInfo
    {
        public uint FrameId;
        public double CaptureMs;   // Unix ms lúc chụp
        public int InputSeq;       // số thứ tự lệnh chạm mới nhất đã có hiệu lực trong khung này
        public int Width, Height;
    }

    /// <summary>
    /// Chụp khung cuối của Game view (kể cả UI Screen Space Overlay) trong Play Mode, thu nhỏ trên GPU, đọc về bằng
    /// AsyncGPUReadback. Phần Editor (PilotBridge) đặt các hook tĩnh và tạo component này khi vào Play Mode.
    /// Chỉ có trong Editor: bản build không chứa gì.
    /// </summary>
    [AddComponentMenu("")]
    public sealed class PilotCapture : MonoBehaviour
    {
        public static Func<bool> WantFrame;
        public static Action<NativeArray<byte>, FrameInfo> OnFrame;
        public static int MaxWidth = 720, MaxHeight = 1280;
        public static float MaxFps = 30;
        /// <summary>Đảo dọc khi thu nhỏ. null = tự chọn theo nền đồ hoạ.</summary>
        public static bool? FlipOverride;

        /// <summary>Editor ghi số lệnh chạm vừa bơm; khung kế tiếp mang số này.</summary>
        public static volatile int PendingInputSeq;
        public static int ScreenWidth { get; private set; }
        public static int ScreenHeight { get; private set; }
        public static PilotCapture Instance { get; private set; }

        RenderTexture screen, scaled;
        int inFlight;
        float next;
        uint frameId;
        int appliedSeq;

        public static void Ensure()
        {
            if (Instance && Instance.running) return;
            // Bản cũ còn sót (project tắt domain reload: biến tĩnh sống qua các lần Play) thì dọn trước.
            Shutdown();
            var go = new GameObject("PcPilot Capture");
            DontDestroyOnLoad(go);
            // Không đặt DontSave: object phải bị huỷ cùng Play Mode, không thì lần Play sau dùng lại bản có coroutine đã chết.
            go.hideFlags = HideFlags.HideInHierarchy;
            Instance = go.AddComponent<PilotCapture>();
        }

        public static void Shutdown()
        {
            foreach (var c in Resources.FindObjectsOfTypeAll<PilotCapture>())
                if (c) DestroyImmediate(c.gameObject);
            Instance = null;
        }

        bool running;
        void OnDisable() => running = false;

        void Awake() => Application.runInBackground = true;

        void Update()
        {
            ScreenWidth = Screen.width;
            ScreenHeight = Screen.height;
            appliedSeq = PendingInputSeq;
        }

        IEnumerator Start()
        {
            var eof = new WaitForEndOfFrame();
            running = true;
            while (true)
            {
                yield return eof;
                try { Capture(); }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        void Capture()
        {
            if (OnFrame == null || inFlight >= 2) return;
            // Nhịp đều MaxFps: hẹn mốc kế tiếp theo lịch, trễ quá một nhịp thì bắt lại từ bây giờ.
            float now = Time.realtimeSinceStartup, interval = 1f / Mathf.Max(1f, MaxFps);
            if (now < next) return;
            if (WantFrame != null && !WantFrame()) return;
            next = now - next > interval ? now + interval : next + interval;

            int sw = Screen.width, sh = Screen.height;
            if (sw < 16 || sh < 16) return;
            if (!screen || screen.width != sw || screen.height != sh)
            {
                if (screen) screen.Release();
                screen = new RenderTexture(sw, sh, 0, RenderTextureFormat.ARGB32) { name = "PcPilot Screen" };
            }

            // Vừa khung MaxWidth x MaxHeight, giữ tỉ lệ, cạnh chẵn (H.264 4:2:0 cần chẵn).
            float k = Mathf.Min(1f, Mathf.Min((float)MaxWidth / sw, (float)MaxHeight / sh));
            int ow = Mathf.Max(16, Mathf.RoundToInt(sw * k) & ~1), oh = Mathf.Max(16, Mathf.RoundToInt(sh * k) & ~1);
            if (!scaled || scaled.width != ow || scaled.height != oh)
            {
                if (scaled) scaled.Release();
                scaled = new RenderTexture(ow, oh, 0, RenderTextureFormat.ARGB32) { name = "PcPilot Scaled" };
            }

            var info = new FrameInfo
            {
                FrameId = ++frameId,
                CaptureMs = (DateTime.UtcNow - DateTime.UnixEpoch).TotalMilliseconds,
                InputSeq = appliedSeq,
                Width = ow,
                Height = oh,
            };

            ScreenCapture.CaptureScreenshotIntoRenderTexture(screen);
            // AsyncGPUReadback trả hàng dưới cùng trước; ảnh chụp màn hình trên D3D/Metal/Vulkan lại nằm ngược sẵn.
            bool flip = FlipOverride ?? !SystemInfo.graphicsUVStartsAtTop;
            if (flip) Graphics.Blit(screen, scaled, new Vector2(1, -1), new Vector2(0, 1));
            else Graphics.Blit(screen, scaled);

            inFlight++;
            AsyncGPUReadback.Request(scaled, 0, TextureFormat.RGBA32, req =>
            {
                inFlight--;
                if (req.hasError || OnFrame == null) return;
                OnFrame(req.GetData<byte>(), info);
            });
        }

        void OnDestroy()
        {
            if (screen) screen.Release();
            if (scaled) scaled.Release();
            if (Instance == this) Instance = null;
        }
    }
}
#endif
