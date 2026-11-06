using System.Linq;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using TouchPhase = UnityEngine.InputSystem.TouchPhase;

namespace PcPilot.Unity.Editor
{
    /// <summary>
    /// Touchscreen ảo trong Input System. Chạm từ điện thoại (toạ độ 0..1, gốc trên trái) đổi sang pixel Game view
    /// (gốc dưới trái) rồi đẩy vào như một màn hình cảm ứng thật.
    /// </summary>
    static class PilotTouch
    {
        const string DeviceName = "PcPilotTouch";
        static Touchscreen device;

        public static void ConfigureInput()
        {
            // Chỉ đổi trong bộ nhớ, không ghi vào asset Input Settings của project.
            var s = InputSystem.settings;
            if (s.editorInputBehaviorInPlayMode != InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView)
                s.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            if (s.backgroundBehavior != InputSettings.BackgroundBehavior.IgnoreFocus)
                s.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            Device();
        }

        static Touchscreen Device()
        {
            if (device != null && device.added) return device;
            device = InputSystem.devices.OfType<Touchscreen>().FirstOrDefault(d => d.name.StartsWith(DeviceName));
            if (device == null) device = InputSystem.AddDevice<Touchscreen>(DeviceName);
            return device;
        }

        public static void Inject(int seq, PilotBridge.TouchPoint[] points)
        {
            if (points == null || !Application.isPlaying) return;
            var ts = Device();
            int w = Mathf.Max(1, PilotCapture.ScreenWidth), h = Mathf.Max(1, PilotCapture.ScreenHeight);
            foreach (var p in points)
            {
                var phase = p.ph switch
                {
                    "down" => TouchPhase.Began,
                    "up" => TouchPhase.Ended,
                    "cancel" => TouchPhase.Canceled,
                    _ => TouchPhase.Moved,
                };
                InputSystem.QueueStateEvent(ts, new TouchState
                {
                    touchId = p.id + 1, // 0 không hợp lệ
                    phase = phase,
                    position = new Vector2(Mathf.Clamp01(p.x) * w, (1f - Mathf.Clamp01(p.y)) * h),
                    pressure = 1f,
                });
            }
            ts.MakeCurrent();
            PilotCapture.PendingInputSeq = seq;
        }
    }
}
