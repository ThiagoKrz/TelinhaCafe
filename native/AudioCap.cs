// AudioCap: captura de audio por processo (API "process loopback" do WASAPI).
// Saida de audio: PCM s16le, 48000 Hz, estereo, em stdout. Status em stderr.
// Encerra quando stdin fecha (processo pai morreu).
//
// Uso:
//   AudioCap.exe [--self-pid <pid>]         todo o som do PC MENOS o Discord (se o Discord nao
//                                           estiver aberto, exclui o proprio app)
//   AudioCap.exe --include-pid <pid>        SO o som desse processo (e dos filhos)
//   AudioCap.exe --include-hwnd <hwnd>      SO o som do programa dono dessa janela
//   AudioCap.exe --list-sessions [--self-pid <pid>]
//                                           lista (JSON, uma linha por app) quem tem sessao de audio
//   AudioCap.exe --probe                    so testa se a captura funciona e sai (OK ou ERROR)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AudioCap
{
    // ---------- Ativacao do process loopback ----------

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr;
        public object Result;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try
            {
                int hr; object o;
                op.GetActivateResult(out hr, out o);
                Hr = hr; Result = o;
            }
            catch (Exception e) { Hr = Marshal.GetHRForException(e); }
            finally { Done.Set(); }
        }
    }

    // ---------- Enumeracao de sessoes de audio (quem esta tocando som) ----------

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        // IAudioSessionControl
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr a, IntPtr b);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr a, IntPtr b);
        [PreserveSig] int GetGroupingParam(IntPtr a);
        [PreserveSig] int SetGroupingParam(IntPtr a, IntPtr b);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr a);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr a);
        // IAudioSessionControl2
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
    }

    class ProcInfo
    {
        public int Pid, Parent;
        public string Name, Exe;
    }

    public static class Program
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            ref Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        const int MODE_INCLUDE = 0;
        const int MODE_EXCLUDE = 1;

        const int SampleRate = 48000;
        const int Channels = 2;
        const int BytesPerFrame = 4; // 16 bits * 2 canais

        static readonly object StdoutLock = new object();
        static Stream stdout;
        static bool probe;

        static void Log(string msg)
        {
            try { Console.Error.WriteLine(msg); Console.Error.Flush(); } catch { }
        }

        static string Arg(string[] args, string name)
        {
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        public static int Main(string[] args)
        {
            int selfPid;
            if (!int.TryParse(Arg(args, "--self-pid"), out selfPid)) selfPid = -1;
            foreach (var a in args) if (a == "--probe") probe = true;

            if (Array.IndexOf(args, "--list-sessions") >= 0) return ListSessions(selfPid);

            // Modo "so um app": resolve o processo alvo.
            int includePid = -1;
            string hwndArg = Arg(args, "--include-hwnd");
            string pidArg = Arg(args, "--include-pid");
            if (hwndArg != null)
            {
                long hwnd;
                uint pid = 0;
                if (long.TryParse(hwndArg, out hwnd)) GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
                if (pid == 0) { Log("ERROR Nao achei o programa dessa janela."); return 1; }
                includePid = AppRoot((int)pid, Snapshot());
            }
            else if (pidArg != null && !int.TryParse(pidArg, out includePid))
            {
                Log("ERROR PID invalido."); return 1;
            }

            stdout = Console.OpenStandardOutput();

            // Sai quando o processo pai fecha nosso stdin.
            if (!probe)
            {
                var watchdog = new Thread(() =>
                {
                    try
                    {
                        var stdin = Console.OpenStandardInput();
                        var b = new byte[64];
                        while (stdin.Read(b, 0, b.Length) > 0) { }
                    }
                    catch { }
                    Environment.Exit(0);
                });
                watchdog.IsBackground = true;
                watchdog.Start();
            }

            if (includePid > 0)
            {
                if (!IsAlive(includePid)) { Log("ERROR Esse programa ja fechou."); return 1; }
                string err;
                RunCapture(includePid, MODE_INCLUDE, "app", true, out err);
                if (err != null) { Log("ERROR " + err); return 1; }
                Log("ERROR O programa que estava sendo capturado fechou.");
                return 2;
            }

            bool first = true;
            while (true)
            {
                int discord = FindDiscordRoot();
                int target = discord > 0 ? discord : selfPid;
                string label = discord > 0 ? "discord" : "self";
                if (target <= 0)
                {
                    // Sem Discord e sem PID proprio: exclui um PID inexistente => captura tudo.
                    target = 0; label = "none";
                }

                string err;
                bool restart = RunCapture(target, MODE_EXCLUDE, label, first, out err);
                if (err != null)
                {
                    Log((first ? "ERROR " : "WARN ") + err);
                    if (first) return 1;
                    Thread.Sleep(1000);
                }
                first = false;
                if (!restart) return 0;
            }
        }

        // Retorna true quando a captura deve ser reiniciada (ex.: Discord abriu/fechou/reiniciou).
        // No modo include, retorna quando o processo alvo fecha.
        static bool RunCapture(int targetPid, int mode, string label, bool first, out string error)
        {
            error = null;
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            IntPtr pFormat = IntPtr.Zero;
            AutoResetEvent evt = new AutoResetEvent(false);
            try
            {
                client = Activate((uint)targetPid, mode);

                pFormat = Marshal.AllocHGlobal(18);
                Marshal.WriteInt16(pFormat, 0, 1);                              // WAVE_FORMAT_PCM
                Marshal.WriteInt16(pFormat, 2, Channels);
                Marshal.WriteInt32(pFormat, 4, SampleRate);
                Marshal.WriteInt32(pFormat, 8, SampleRate * BytesPerFrame);     // nAvgBytesPerSec
                Marshal.WriteInt16(pFormat, 12, BytesPerFrame);                 // nBlockAlign
                Marshal.WriteInt16(pFormat, 14, 16);                            // wBitsPerSample
                Marshal.WriteInt16(pFormat, 16, 0);                             // cbSize

                Check(client.Initialize(0,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                    200000, 0, pFormat, IntPtr.Zero), "IAudioClient.Initialize");

                Guid iidCap = IID_IAudioCaptureClient;
                object svc;
                Check(client.GetService(ref iidCap, out svc), "IAudioClient.GetService");
                capture = (IAudioCaptureClient)svc;

                Check(client.SetEventHandle(evt.SafeWaitHandle.DangerousGetHandle()), "IAudioClient.SetEventHandle");
                Check(client.Start(), "IAudioClient.Start");

                Log((first ? "OK " : "INFO ") + label + " " + targetPid);
                if (probe) return false;

                byte[] buf = new byte[SampleRate * BytesPerFrame]; // 1s de folga
                var lastCheck = Stopwatch.StartNew();

                while (true)
                {
                    evt.WaitOne(100);

                    uint next;
                    while (capture.GetNextPacketSize(out next) >= 0 && next > 0)
                    {
                        IntPtr data; uint frames, flags; ulong devPos, qpcPos;
                        int hr = capture.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                        Check(hr, "IAudioCaptureClient.GetBuffer");
                        if (hr == 0x08890001) break; // AUDCLNT_S_BUFFER_EMPTY

                        int bytes = (int)frames * BytesPerFrame;
                        if (bytes > buf.Length) buf = new byte[bytes];
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buf, 0, bytes);
                        else Marshal.Copy(data, buf, 0, bytes);
                        capture.ReleaseBuffer(frames);

                        lock (StdoutLock) stdout.Write(buf, 0, bytes);
                    }
                    lock (StdoutLock) stdout.Flush();

                    // A cada ~3s, confere se o alvo ainda e o certo.
                    if (lastCheck.ElapsedMilliseconds > 3000)
                    {
                        lastCheck.Restart();
                        if (mode == MODE_INCLUDE || label == "discord")
                        {
                            if (!IsAlive(targetPid)) return true;
                        }
                        else if (FindDiscordRoot() > 0)
                        {
                            return true;
                        }
                    }
                }
            }
            catch (IOException)
            {
                // stdout fechado: o pai saiu.
                Environment.Exit(0);
                return false;
            }
            catch (Exception e)
            {
                error = e.Message;
                return true;
            }
            finally
            {
                try { if (client != null) client.Stop(); } catch { }
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                if (pFormat != IntPtr.Zero) Marshal.FreeHGlobal(pFormat);
                evt.Dispose();
            }
        }

        static IAudioClient Activate(uint targetPid, int mode)
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType, { TargetProcessId, ProcessLoopbackMode } }
            IntPtr pParams = Marshal.AllocHGlobal(12);
            // PROPVARIANT (x64: 24 bytes) com VT_BLOB
            IntPtr pVariant = Marshal.AllocHGlobal(24);
            try
            {
                Marshal.WriteInt32(pParams, 0, 1);               // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                Marshal.WriteInt32(pParams, 4, (int)targetPid);
                Marshal.WriteInt32(pParams, 8, mode);            // 0 = incluir arvore, 1 = excluir arvore

                for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(pVariant, i, 0);
                Marshal.WriteInt16(pVariant, 0, 65);             // VT_BLOB
                Marshal.WriteInt32(pVariant, 8, 12);             // blob.cbSize
                Marshal.WriteIntPtr(pVariant, 16, pParams);      // blob.pBlobData

                var handler = new CompletionHandler();
                Guid iid = IID_IAudioClient;
                IActivateAudioInterfaceAsyncOperation op;
                int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pVariant, handler, out op);
                Check(hr, "ActivateAudioInterfaceAsync (requer Windows 11 ou Windows 10 atualizado)");

                if (!handler.Done.WaitOne(5000)) throw new Exception("Tempo esgotado ativando a captura de audio");
                Check(handler.Hr, "Ativacao do process loopback (requer Windows 11 ou Windows 10 atualizado)");
                GC.KeepAlive(op);
                return (IAudioClient)handler.Result;
            }
            finally
            {
                Marshal.FreeHGlobal(pVariant);
                Marshal.FreeHGlobal(pParams);
            }
        }

        static void Check(int hr, string what)
        {
            if (hr < 0) throw new Exception(what + " falhou: 0x" + hr.ToString("X8"));
        }

        static bool IsAlive(int pid)
        {
            try { return !Process.GetProcessById(pid).HasExited; }
            catch { return false; }
        }

        // ---------- Processos ----------

        static Dictionary<int, ProcInfo> Snapshot()
        {
            var map = new Dictionary<int, ProcInfo>();
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name, ExecutablePath FROM Win32_Process"))
                using (var results = searcher.Get())
                {
                    foreach (ManagementObject mo in results)
                    {
                        using (mo)
                        {
                            var p = new ProcInfo
                            {
                                Pid = (int)(uint)mo["ProcessId"],
                                Parent = (int)(uint)mo["ParentProcessId"],
                                Name = (string)mo["Name"] ?? "",
                                Exe = (string)mo["ExecutablePath"] ?? "",
                            };
                            map[p.Pid] = p;
                        }
                    }
                }
            }
            catch (Exception e) { Log("WARN lendo processos: " + e.Message); }
            return map;
        }

        // Sobe enquanto o pai for o mesmo programa (ex.: processo de audio do Chrome -> chrome.exe principal).
        // Processos "hospedeiros" (WebView2) contam como parte do app que os abriu.
        static int AppRoot(int pid, Dictionary<int, ProcInfo> map)
        {
            int cur = pid;
            for (int guard = 0; guard < 32; guard++)
            {
                ProcInfo me, parent;
                if (!map.TryGetValue(cur, out me) || !map.TryGetValue(me.Parent, out parent)) break;
                bool sameApp = string.Equals(me.Name, parent.Name, StringComparison.OrdinalIgnoreCase);
                bool hosted = string.Equals(me.Name, "msedgewebview2.exe", StringComparison.OrdinalIgnoreCase)
                              && !parent.Name.Equals("explorer.exe", StringComparison.OrdinalIgnoreCase)
                              && !parent.Name.Equals("svchost.exe", StringComparison.OrdinalIgnoreCase);
                if (!sameApp && !hosted) break;
                cur = parent.Pid;
            }
            return cur;
        }

        static readonly HashSet<string> SystemProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "audiodg.exe", "svchost.exe", "System", "explorer.exe", "ShellExperienceHost.exe", "StartMenuExperienceHost.exe",
        };

        static bool IsDescendantOrSelf(int pid, int ancestor, Dictionary<int, ProcInfo> map)
        {
            int cur = pid;
            for (int guard = 0; guard < 64 && cur > 0; guard++)
            {
                if (cur == ancestor) return true;
                ProcInfo me;
                if (!map.TryGetValue(cur, out me)) return false;
                cur = me.Parent;
            }
            return false;
        }

        // Encontra o processo "raiz" do Discord (o que nao tem outro Discord como pai).
        static int FindDiscordRoot()
        {
            try
            {
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "DiscordDevelopment.exe" };
                var parent = new Dictionary<int, int>();
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name FROM Win32_Process WHERE Name LIKE 'Discord%'"))
                using (var results = searcher.Get())
                {
                    foreach (ManagementObject mo in results)
                    {
                        using (mo)
                        {
                            string name = (string)mo["Name"];
                            if (!names.Contains(name)) continue;
                            parent[(int)(uint)mo["ProcessId"]] = (int)(uint)mo["ParentProcessId"];
                        }
                    }
                }
                foreach (var kv in parent)
                    if (!parent.ContainsKey(kv.Value)) return kv.Key;
            }
            catch (Exception e) { Log("WARN procurando Discord: " + e.Message); }
            return -1;
        }

        // ---------- Lista de apps com audio ----------

        static int ListSessions(int selfPid)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var map = Snapshot();
            var apps = new Dictionary<int, bool>(); // raiz -> tocando agora?
            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
                IMMDeviceCollection devices;
                Check(enumerator.EnumAudioEndpoints(0 /*eRender*/, 1 /*ACTIVE*/, out devices), "EnumAudioEndpoints");
                uint count;
                devices.GetCount(out count);
                for (uint d = 0; d < count; d++)
                {
                    IMMDevice dev;
                    if (devices.Item(d, out dev) < 0) continue;
                    Guid iid = IID_IAudioSessionManager2;
                    object o;
                    if (dev.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o) < 0) continue;
                    var mgr = (IAudioSessionManager2)o;
                    IAudioSessionEnumerator sessions;
                    if (mgr.GetSessionEnumerator(out sessions) < 0) continue;
                    int n;
                    sessions.GetCount(out n);
                    for (int i = 0; i < n; i++)
                    {
                        object so;
                        if (sessions.GetSession(i, out so) < 0) continue;
                        var ctl = so as IAudioSessionControl2;
                        if (ctl == null) continue;
                        uint pid;
                        int state;
                        if (ctl.IsSystemSoundsSession() == 0) continue; // S_OK = sons do sistema
                        if (ctl.GetProcessId(out pid) < 0 || pid == 0) continue;
                        ctl.GetState(out state);
                        int root = AppRoot((int)pid, map);
                        bool active = state == 1;
                        bool prev;
                        apps[root] = apps.TryGetValue(root, out prev) ? prev || active : active;
                    }
                }
            }
            catch (Exception e)
            {
                Log("ERROR " + e.Message);
                return 1;
            }

            int discord = FindDiscordRoot();
            foreach (var kv in apps)
            {
                ProcInfo p;
                if (!map.TryGetValue(kv.Key, out p)) continue;
                if (SystemProcs.Contains(p.Name)) continue;
                if (discord > 0 && IsDescendantOrSelf(kv.Key, discord, map)) continue;
                if (selfPid > 0 && IsDescendantOrSelf(kv.Key, selfPid, map)) continue;
                string name = p.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? p.Name.Substring(0, p.Name.Length - 4) : p.Name;
                try
                {
                    if (p.Exe.Length > 0)
                    {
                        var desc = FileVersionInfo.GetVersionInfo(p.Exe).FileDescription;
                        if (!string.IsNullOrWhiteSpace(desc)) name = desc.Trim();
                    }
                }
                catch { }
                Console.Out.WriteLine("{\"pid\":" + kv.Key + ",\"name\":" + Json(name) + ",\"exe\":" + Json(p.Exe) + ",\"active\":" + (kv.Value ? "true" : "false") + "}");
            }
            Console.Out.Flush();
            return 0;
        }

        static string Json(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
    }
}
