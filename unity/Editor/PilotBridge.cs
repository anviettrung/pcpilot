using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Unity.Collections;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace PcPilot.Unity.Editor
{
    /// <summary>
    /// Nối Unity Editor với sidecar PcPilot ở 127.0.0.1 (TCP). Mỗi lần domain reload thì nối lại.
    /// Gói tin: u32 độ dài (phần sau nó) | u8 loại | nội dung.
    ///   Unity → sidecar: 1 = JSON trạng thái, 2 = khung hình RGBA.
    ///   sidecar → Unity: 10 = JSON lệnh.
    /// </summary>
    [InitializeOnLoad]
    public static class PilotBridge
    {
        public const int Port = 7441;
        const byte MsgStatus = 1, MsgFrame = 2, MsgCommand = 10;
        const int FrameHeader = 1 + 2 + 2 + 4 + 8 + 4;

        static Thread ioThread;
        static volatile bool running;
        static volatile bool connected;
        static volatile bool streaming;
        static TcpClient client;
        static readonly object gate = new object();
        static byte[] pendingFrame, spareFrame;
        static int pendingFrameLen;
        static readonly ConcurrentQueue<byte[]> outbox = new ConcurrentQueue<byte[]>();
        static readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
        static readonly AutoResetEvent wake = new AutoResetEvent(false);
        static string lastStatus;
        static bool wasConnected;

        public static bool Connected => connected;
        public static bool Streaming => streaming;

        static PilotBridge()
        {
            if (Application.isBatchMode) return;
            running = true;
            ioThread = new Thread(IoLoop) { IsBackground = true, Name = "PcPilot IO" };
            ioThread.Start();

            PilotCapture.WantFrame = () => connected && streaming;
            PilotCapture.OnFrame = OnFrame;
            EditorApplication.update += Tick;
            EditorApplication.playModeStateChanged += OnPlayMode;
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
            EditorApplication.quitting += Shutdown;
            CompilationPipeline.compilationStarted += _ => SendStatus(true);
            if (EditorApplication.isPlaying) EditorApplication.delayCall += EnterPlay;
        }

        static void Shutdown()
        {
            SendStatus(true, reloading: true);
            running = false;
            wake.Set();
            // Cho luồng IO gửi nốt gói "đang reload" rồi mới đóng.
            ioThread?.Join(300);
            try { client?.Close(); } catch { }
        }

        // --- Luồng IO ---------------------------------------------------------------------------------

        static void IoLoop()
        {
            while (running)
            {
                try
                {
                    using (var c = new TcpClient())
                    {
                        c.NoDelay = true;
                        c.SendBufferSize = 8 << 20;
                        var ar = c.BeginConnect("127.0.0.1", Port, null, null);
                        if (!ar.AsyncWaitHandle.WaitOne(1000) || !c.Connected) { Sleep(1000); continue; }
                        c.EndConnect(ar);
                        client = c;
                        var stream = c.GetStream();
                        connected = true;
                        lastStatus = null; // gửi lại trạng thái đầy đủ
                        var reader = new Thread(() => ReadLoop(stream)) { IsBackground = true, Name = "PcPilot Read" };
                        reader.Start();
                        while (running && c.Connected && reader.IsAlive)
                        {
                            wake.WaitOne(50);
                            while (outbox.TryDequeue(out var msg)) stream.Write(msg, 0, msg.Length);
                            byte[] f; int len;
                            lock (gate) { f = pendingFrame; len = pendingFrameLen; pendingFrame = null; }
                            if (f != null)
                            {
                                stream.Write(f, 0, len);
                                lock (gate) spareFrame = f;
                            }
                        }
                        while (outbox.TryDequeue(out var msg)) stream.Write(msg, 0, msg.Length);
                    }
                }
                catch (Exception) { }
                connected = false;
                streaming = false;
                client = null;
                if (running) Sleep(1000);
            }
        }

        static void Sleep(int ms)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (running && DateTime.UtcNow < until) Thread.Sleep(50);
        }

        static void ReadLoop(NetworkStream s)
        {
            var head = new byte[5];
            try
            {
                while (running)
                {
                    ReadExact(s, head, 5);
                    int len = BitConverter.ToInt32(head, 0) - 1;
                    var body = new byte[len];
                    ReadExact(s, body, len);
                    if (head[4] == MsgCommand) inbox.Enqueue(Encoding.UTF8.GetString(body));
                }
            }
            catch (Exception) { }
        }

        static void ReadExact(Stream s, byte[] buf, int n)
        {
            int off = 0;
            while (off < n)
            {
                int r = s.Read(buf, off, n - off);
                if (r <= 0) throw new EndOfStreamException();
                off += r;
            }
        }

        static void Enqueue(byte type, byte[] payload)
        {
            var msg = new byte[5 + payload.Length];
            BitConverter.GetBytes(payload.Length + 1).CopyTo(msg, 0);
            msg[4] = type;
            payload.CopyTo(msg, 5);
            outbox.Enqueue(msg);
            wake.Set();
        }

        // --- Khung hình (luồng chính) ------------------------------------------------------------------

        static void OnFrame(NativeArray<byte> rgba, FrameInfo info)
        {
            if (!connected || !streaming) return;
            int total = 4 + FrameHeader + rgba.Length;
            byte[] buf;
            lock (gate)
            {
                if (pendingFrame != null) return; // luồng IO còn bận gửi khung trước: bỏ khung này
                buf = spareFrame;
                spareFrame = null;
            }
            if (buf == null || buf.Length < total) buf = new byte[total];
            int o = 0;
            Put(buf, ref o, total - 4);
            buf[o++] = MsgFrame;
            PutU16(buf, ref o, info.Width);
            PutU16(buf, ref o, info.Height);
            Put(buf, ref o, (int)info.FrameId);
            BitConverter.GetBytes(info.CaptureMs).CopyTo(buf, o); o += 8;
            Put(buf, ref o, info.InputSeq);
            NativeArray<byte>.Copy(rgba, 0, buf, o, rgba.Length);
            lock (gate) { pendingFrame = buf; pendingFrameLen = total; }
            wake.Set();
        }

        static void Put(byte[] b, ref int o, int v) { BitConverter.GetBytes(v).CopyTo(b, o); o += 4; }
        static void PutU16(byte[] b, ref int o, int v) { b[o++] = (byte)v; b[o++] = (byte)(v >> 8); }

        // --- Trạng thái, lệnh ---------------------------------------------------------------------------

        [Serializable]
        class Status
        {
            public string type = "status";
            public string project, path, unity, scene, platform;
            public bool playing, paused, compiling, reloading, dirty, quitting;
            public int screenW, screenH, pid;
        }

        static readonly string ProjectPath = Path.GetDirectoryName(Application.dataPath);
        static readonly int Pid = System.Diagnostics.Process.GetCurrentProcess().Id;

        // Scene có thay đổi chưa lưu. Lúc Play thì dùng giá trị ngay trước khi vào Play (thay đổi trong Play không lưu
        // được); giữ bằng SessionState vì vào Play có thể domain reload.
        static bool dirtyInEdit
        {
            get => SessionState.GetBool("PcPilot.dirty", false);
            set => SessionState.SetBool("PcPilot.dirty", value);
        }
        static bool ScenesDirty()
        {
            for (int i = 0; i < EditorSceneManager.sceneCount; i++)
                if (EditorSceneManager.GetSceneAt(i).isDirty) return true;
            return false;
        }
        static bool AnySceneDirty() => EditorApplication.isPlayingOrWillChangePlaymode ? dirtyInEdit : ScenesDirty();

        static void SendStatus(bool compiling = false, bool reloading = false)
        {
            var s = new Status
            {
                project = Path.GetFileName(ProjectPath),
                path = ProjectPath,
                pid = Pid,
                dirty = AnySceneDirty(),
                quitting = !string.IsNullOrEmpty(pendingQuit),
                unity = Application.unityVersion,
                scene = EditorSceneManager.GetActiveScene().name,
                platform = SystemInfo.graphicsDeviceType.ToString(),
                playing = EditorApplication.isPlaying,
                paused = EditorApplication.isPaused,
                compiling = compiling || EditorApplication.isCompiling,
                reloading = reloading,
                screenW = PilotCapture.ScreenWidth,
                screenH = PilotCapture.ScreenHeight,
            };
            var json = JsonUtility.ToJson(s);
            if (json == lastStatus && !reloading) return;
            lastStatus = json;
            Enqueue(MsgStatus, Encoding.UTF8.GetBytes(json));
        }

        [Serializable]
        class Command
        {
            public string t;
            public int seq;
            public TouchPoint[] p;
            public bool on;
            public int fps, w, h;
            public string name;
        }

        [Serializable]
        public class TouchPoint
        {
            public int id;
            public string ph;
            public float x, y;
        }

        static double nextStatusAt;
        // Tắt Unity từ điện thoại: "save" lưu scene rồi tắt, "discard" bỏ thay đổi, "go" = không có gì để lưu.
        // Đang Play thì thoát Play trước (có thể domain reload), nên cờ giữ bằng SessionState.
        static string pendingQuit
        {
            get => SessionState.GetString("PcPilot.pendingQuit", "");
            set => SessionState.SetString("PcPilot.pendingQuit", value);
        }
        // Sống qua domain reload: Play bấm từ điện thoại mà phải compile trước thì vẫn Play sau khi reload xong.
        static bool pendingPlay
        {
            get => SessionState.GetBool("PcPilot.pendingPlay", false);
            set => SessionState.SetBool("PcPilot.pendingPlay", value);
        }

        static void Tick()
        {
            if (connected != wasConnected)
            {
                wasConnected = connected;
                if (connected) SendStatus();
            }
            while (inbox.TryDequeue(out var json))
            {
                try { Handle(JsonUtility.FromJson<Command>(json)); }
                catch (Exception e) { Debug.LogWarning($"PcPilot: lệnh lỗi {json}: {e.Message}"); }
            }
            if (connected && EditorApplication.timeSinceStartup >= nextStatusAt)
            {
                nextStatusAt = EditorApplication.timeSinceStartup + 0.25;
                SendStatus();
            }
            if (pendingPlay && !EditorApplication.isCompiling && !EditorApplication.isUpdating)
            {
                pendingPlay = false;
                if (!EditorApplication.isPlaying) EditorApplication.isPlaying = true;
            }
            if (!string.IsNullOrEmpty(pendingQuit) && !EditorApplication.isPlayingOrWillChangePlaymode
                && !EditorApplication.isCompiling && !EditorApplication.isUpdating)
                DoQuit();
            // Editor chỉ vẽ lại khi có lý do; đang stream thì giữ cho Game view luôn chạy.
            if (streaming && EditorApplication.isPlaying) EditorApplication.QueuePlayerLoopUpdate();
        }

        static void Handle(Command c)
        {
            switch (c.t)
            {
                case "touch":
                    PilotTouch.Inject(c.seq, c.p);
                    break;
                case "stream":
                    streaming = c.on;
                    if (c.fps > 0) PilotCapture.MaxFps = c.fps;
                    if (c.w > 0 && c.h > 0)
                    {
                        PilotCapture.MaxWidth = c.w;
                        PilotCapture.MaxHeight = c.h;
                        PilotGameView.SetSize(c.w, c.h);
                    }
                    break;
                case "play":
                    if (EditorApplication.isPlaying) { EditorApplication.isPaused = false; break; }
                    // Unity không focus thì không tự thấy code AI vừa sửa: refresh trước, compile xong mới Play.
                    AssetDatabase.Refresh();
                    pendingPlay = true;
                    break;
                case "refresh":
                    if (!EditorApplication.isPlaying) AssetDatabase.Refresh();
                    break;
                case "stop":
                    EditorApplication.isPlaying = false;
                    break;
                case "pause":
                    if (EditorApplication.isPlaying) EditorApplication.isPaused = !EditorApplication.isPaused;
                    break;
                case "quit":
                    // Không có mode mà scene đang có thay đổi chưa lưu: không tắt, để người dùng chọn lưu hay bỏ.
                    if (string.IsNullOrEmpty(c.name) && AnySceneDirty())
                    {
                        Debug.LogWarning("PcPilot: scene có thay đổi chưa lưu, không tắt Unity");
                        break;
                    }
                    pendingPlay = false;
                    pendingQuit = string.IsNullOrEmpty(c.name) ? "go" : c.name;
                    if (EditorApplication.isPlaying) EditorApplication.isPlaying = false;
                    break;
                case "scene":
                    if (EditorApplication.isPlaying || string.IsNullOrEmpty(c.name)) break;
                    var guids = AssetDatabase.FindAssets($"t:Scene {c.name}");
                    foreach (var g in guids)
                    {
                        var path = AssetDatabase.GUIDToAssetPath(g);
                        if (Path.GetFileNameWithoutExtension(path) != c.name) continue;
                        // Không bật hộp thoại "lưu scene?" khi người dùng không ngồi trước máy: scene đang sửa dở thì thôi.
                        if (EditorSceneManager.GetActiveScene().isDirty) Debug.LogWarning("PcPilot: scene đang có thay đổi chưa lưu, không đổi scene");
                        else EditorSceneManager.OpenScene(path);
                        break;
                    }
                    break;
            }
            SendStatus();
        }

        static bool quitStarted;
        static void DoQuit()
        {
            if (quitStarted) return;
            quitStarted = true;
            // Giữ pendingQuit tới lúc thoát: gói trạng thái cuối mang quitting = true, sidecar biết là tắt chứ không phải reload.
            var mode = pendingQuit;
            Debug.Log($"PcPilot: tắt Unity từ xa ({mode})");
            if (mode == "save")
            {
                EditorSceneManager.SaveOpenScenes();
                AssetDatabase.SaveAssets();
            }
            else if (mode == "go")
            {
                AssetDatabase.SaveAssets();
            }
            // Exit không hỏi lưu scene: thay đổi chưa lưu (mode "discard") bị bỏ.
            EditorApplication.Exit(0);
        }

        static void OnPlayMode(PlayModeStateChange s)
        {
            if (s == PlayModeStateChange.ExitingEditMode) dirtyInEdit = ScenesDirty();
            if (s == PlayModeStateChange.EnteredPlayMode) EnterPlay();
            if (s == PlayModeStateChange.ExitingPlayMode) PilotCapture.Shutdown();
            SendStatus();
        }

        static void EnterPlay()
        {
            if (!EditorApplication.isPlaying) return;
            PilotTouch.ConfigureInput();
            PilotCapture.Ensure();
        }
    }
}
