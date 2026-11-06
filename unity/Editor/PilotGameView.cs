using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace UnityPilot.Unity.Editor
{
    /// <summary>
    /// Đặt độ phân giải Game view theo màn hình điện thoại. Unity không có API công khai cho việc này nên dùng
    /// reflection (GameViewSizes, GameView.SizeSelectionCallback). Hỏng thì chỉ ghi cảnh báo, stream vẫn chạy
    /// với cỡ Game view hiện tại.
    /// </summary>
    static class PilotGameView
    {
        const string Label = "UnityPilot";
        static bool warned;

        public static void SetSize(int w, int h)
        {
            try
            {
                var asm = typeof(UnityEditor.Editor).Assembly;
                var sizesType = asm.GetType("UnityEditor.GameViewSizes");
                var single = typeof(ScriptableSingleton<>).MakeGenericType(sizesType);
                var sizes = single.GetProperty("instance").GetValue(null);
                var groupType = sizesType.GetProperty("currentGroupType").GetValue(sizes);
                var group = sizesType.GetMethod("GetGroup").Invoke(sizes, new[] { groupType });
                var gType = group.GetType();
                int total = (int)gType.GetMethod("GetTotalCount").Invoke(group, null);

                int index = -1;
                for (int i = 0; i < total; i++)
                {
                    var s = gType.GetMethod("GetGameViewSize").Invoke(group, new object[] { i });
                    var st = s.GetType();
                    if ((string)st.GetProperty("baseText").GetValue(s) != Label) continue;
                    // Dùng lại mục "UnityPilot", đổi cỡ tại chỗ.
                    st.GetProperty("width").SetValue(s, w);
                    st.GetProperty("height").SetValue(s, h);
                    index = i;
                    break;
                }
                if (index < 0)
                {
                    var sizeType = asm.GetType("UnityEditor.GameViewSize");
                    var kind = Enum.Parse(asm.GetType("UnityEditor.GameViewSizeType"), "FixedResolution");
                    var size = Activator.CreateInstance(sizeType, kind, w, h, Label);
                    gType.GetMethod("AddCustomSize").Invoke(group, new[] { size });
                    index = total;
                }

                var gvType = asm.GetType("UnityEditor.GameView");
                foreach (var win in Resources.FindObjectsOfTypeAll(gvType))
                {
                    var prop = gvType.GetProperty("selectedSizeIndex", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (prop != null && prop.CanWrite) prop.SetValue(win, index);
                    else gvType.GetMethod("SizeSelectionCallback", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                        ?.Invoke(win, new object[] { index, null });
                    ((EditorWindow)win).Repaint();
                }
            }
            catch (Exception e)
            {
                if (!warned) Debug.LogWarning($"UnityPilot: không đặt được cỡ Game view ({e.GetType().Name}: {e.Message})");
                warned = true;
            }
        }
    }
}
