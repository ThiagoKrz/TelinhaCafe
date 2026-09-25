// InputCtl: injeta mouse/teclado no Windows (controle remoto consentido da tela compartilhada).
// Lê comandos de stdin, um por linha:
//   m <x> <y>        move o mouse para (x, y) em pixels físicos da área de trabalho virtual
//   d <b> / u <b>    aperta / solta botão (0 = esquerdo, 1 = meio, 2 = direito)
//   w <delta>        roda do mouse (múltiplos de 120; positivo = pra cima)
//   kd <sc> <ext>    aperta tecla pelo scancode (ext = 1 para teclas estendidas)
//   ku <sc> <ext>    solta tecla
//   reset            solta tudo que estiver apertado
// Quando stdin fecha (o app saiu ou o controle acabou), solta tudo e sai.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace InputCtl
{
    public static class Program
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx, dy;
            public uint mouseData, dwFlags, time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk, wScan;
            public uint dwFlags, time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct INPUT
        {
            [FieldOffset(0)] public uint type;
            [FieldOffset(8)] public MOUSEINPUT mi;
            [FieldOffset(8)] public KEYBDINPUT ki;
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X, Y; }

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT p);

        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_WHEEL = 0x0800;
        const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;
        static readonly uint[] ButtonDown = { 0x0002, 0x0020, 0x0008 }; // esquerdo, meio, direito
        static readonly uint[] ButtonUp = { 0x0004, 0x0040, 0x0010 };

        static readonly HashSet<int> buttonsDown = new HashSet<int>();
        static readonly HashSet<int> keysDown = new HashSet<int>(); // sc | (ext << 16)

        static void Send(INPUT input)
        {
            SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
        }

        static void Mouse(uint flags, int dx = 0, int dy = 0, uint data = 0)
        {
            var i = new INPUT { type = INPUT_MOUSE };
            i.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
            Send(i);
        }

        static void Key(int sc, bool ext, bool up)
        {
            var i = new INPUT { type = INPUT_KEYBOARD };
            uint flags = KEYEVENTF_SCANCODE | (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
            i.ki = new KEYBDINPUT { wScan = (ushort)sc, dwFlags = flags };
            Send(i);
        }

        static void MoveTo(int x, int y)
        {
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77); // SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN
            int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79); // SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN
            if (vw <= 1 || vh <= 1) return;
            int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
            int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
            Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
        }

        static void ReleaseAll()
        {
            foreach (int b in buttonsDown) Mouse(ButtonUp[b]);
            buttonsDown.Clear();
            foreach (int k in keysDown) Key(k & 0xFFFF, (k >> 16) != 0, true);
            keysDown.Clear();
        }

        public static int Main()
        {
            // Coordenadas em pixels físicos, independente da escala do Windows.
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // PER_MONITOR_AWARE_V2

            Console.Error.WriteLine("OK");
            Console.Error.Flush();

            var input = new StreamReader(Console.OpenStandardInput());
            try
            {
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    var p = line.Trim().Split(' ');
                    if (p.Length == 0) continue;
                    int a, b;
                    switch (p[0])
                    {
                        case "m":
                            if (p.Length >= 3 && int.TryParse(p[1], out a) && int.TryParse(p[2], out b)) MoveTo(a, b);
                            break;
                        case "d":
                            if (p.Length >= 2 && int.TryParse(p[1], out a) && a >= 0 && a <= 2 && buttonsDown.Add(a)) Mouse(ButtonDown[a]);
                            break;
                        case "u":
                            if (p.Length >= 2 && int.TryParse(p[1], out a) && a >= 0 && a <= 2)
                            {
                                buttonsDown.Remove(a);
                                Mouse(ButtonUp[a]);
                            }
                            break;
                        case "w":
                            if (p.Length >= 2 && int.TryParse(p[1], out a)) Mouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)Math.Max(-1200, Math.Min(1200, a))));
                            break;
                        case "kd":
                        case "ku":
                            if (p.Length >= 3 && int.TryParse(p[1], out a) && int.TryParse(p[2], out b) && a > 0 && a < 0x80)
                            {
                                int key = a | ((b != 0 ? 1 : 0) << 16);
                                bool up = p[0] == "ku";
                                if (up) keysDown.Remove(key); else keysDown.Add(key);
                                Key(a, b != 0, up);
                            }
                            break;
                        case "q": // diagnóstico: medidas da área de trabalho virtual + posição do cursor
                            {
                                POINT c;
                                GetCursorPos(out c);
                                Console.Error.WriteLine("Q virt=" + GetSystemMetrics(76) + "," + GetSystemMetrics(77) + " " + GetSystemMetrics(78) + "x" + GetSystemMetrics(79) + " cursor=" + c.X + "," + c.Y);
                                Console.Error.Flush();
                            }
                            break;
                        case "reset":
                            ReleaseAll();
                            break;
                    }
                }
            }
            catch { }
            ReleaseAll();
            return 0;
        }
    }
}
