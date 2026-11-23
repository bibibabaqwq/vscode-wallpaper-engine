using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class SceneHelper
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    // 从 Windows 任务栏移除按钮（不改变窗口样式，因此不会影响 PrintWindow 抓帧）
    [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
    private class CTaskbarList { }

    [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
    }

    private const uint PW_RENDERFULLCONTENT = 2;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const int SW_SHOWNOACTIVATE = 4;
    private const uint WM_CLOSE = 0x0010;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    private static readonly object Sync = new object();
    private static byte[] latest = null;
    private static long seq = 0;
    private static double fpsActual = 0;
    private static volatile bool running = true;
    private static string targetTitle = "";

    private static int Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        if (args.Length == 0) { Console.WriteLine("usage: scene-helper <info|place|serve|snap|shot|close|waitgone> ..."); return 1; }
        string cmd = args[0].ToLowerInvariant();
        try
        {
            if (cmd == "info") return Info(args);
            if (cmd == "place") return Place(args);
            if (cmd == "serve") return Serve(args);
            if (cmd == "snap") return Snap(args);
            if (cmd == "shot") return Shot(args);
            if (cmd == "close") return CloseWindow(args);
            if (cmd == "waitgone") return WaitGone(args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 2;
        }
        Console.Error.WriteLine("unknown command");
        return 1;
    }

    private static void HideFromTaskbar(IntPtr h)
    {
        try
        {
            var tbl = (ITaskbarList)new CTaskbarList();
            tbl.HrInit();
            tbl.DeleteTab(h);
        }
        catch { }
    }

    private static void PrepareWindow(IntPtr h)
    {
        // 先设置扩展样式，再在最小化时用 SW_SHOWNOACTIVATE 显示。
        // 绝不能使用 SW_RESTORE：它会激活窗口并把旧预览拉到前台。
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
        HideFromTaskbar(h);
        if (IsIconic(h)) ShowWindowAsync(h, SW_SHOWNOACTIVATE);
    }

    private static IntPtr WaitWindow(string title, int ms)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            IntPtr h = FindWindow(null, title);
            if (h != IntPtr.Zero) return h;
            Thread.Sleep(100);
        }
        return IntPtr.Zero;
    }

    private static int Info(string[] args)
    {
        if (args.Length < 2) return 1;
        IntPtr h = FindWindow(null, args[1]);
        Console.WriteLine("hwnd=" + h.ToInt64());
        if (h == IntPtr.Zero) return 3;
        RECT r; GetWindowRect(h, out r);
        Console.WriteLine("rect=" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top));
        Console.WriteLine("iconic=" + IsIconic(h));
        return 0;
    }

    private static int Place(string[] args)
    {
        if (args.Length < 6) return 1;
        IntPtr h = WaitWindow(args[1], 12000);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("window not found"); return 3; }
        int x = int.Parse(args[2]), y = int.Parse(args[3]), w = int.Parse(args[4]), hh = int.Parse(args[5]);
        // 关键：只改扩展样式，不要使用 SWP_FRAMECHANGED。
        // 实测 SWP_FRAMECHANGED 会让 WE 的渲染表面变黑，导致 PrintWindow 抓到纯黑帧。
        PrepareWindow(h);
        bool ok = SetWindowPos(h, IntPtr.Zero, x, y, w, hh, SWP_NOZORDER | SWP_NOACTIVATE);
        Thread.Sleep(250);
        RECT r; GetWindowRect(h, out r);
        Console.WriteLine("ok=" + ok + " rect=" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top));
        return ok ? 0 : 4;
    }

    private static int CloseWindow(string[] args)
    {
        if (args.Length < 2) return 1;
        IntPtr h = FindWindow(null, args[1]);
        if (h == IntPtr.Zero) return 0;
        PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < 2500)
        {
            if (FindWindow(null, args[1]) == IntPtr.Zero) return 0;
            Thread.Sleep(50);
        }
        return 3;
    }

    private static int WaitGone(string[] args)
    {
        if (args.Length < 2) return 1;
        int ms = args.Length > 2 ? int.Parse(args[2]) : 2000;
        if (ms < 0) ms = 0;
        if (ms > 10000) ms = 10000;
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            if (FindWindow(null, args[1]) == IntPtr.Zero) return 0;
            Thread.Sleep(50);
        }
        return FindWindow(null, args[1]) == IntPtr.Zero ? 0 : 3;
    }

    private static Bitmap Capture(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return null;
        int w = r.Right - r.Left, hh = r.Bottom - r.Top;
        if (w <= 0 || hh <= 0 || w > 8000 || hh > 8000) return null;
        Bitmap bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            IntPtr hdc = g.GetHdc();
            bool ok;
            try { ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(hdc); }
            if (!ok) { bmp.Dispose(); return null; }
        }
        return bmp;
    }

    private static int Snap(string[] args)
    {
        if (args.Length < 3) return 1;
        IntPtr h = WaitWindow(args[1], 12000);
        if (h == IntPtr.Zero) return 3;
        using (Bitmap bmp = Capture(h))
        {
            if (bmp == null) return 4;
            bmp.Save(args[2], ImageFormat.Png);
            Console.WriteLine("saved " + bmp.Width + "x" + bmp.Height);
        }
        return 0;
    }

    private static int Shot(string[] args)
    {
        if (args.Length < 4) return 1;
        IntPtr h = FindWindow(null, args[1]);
        if (h == IntPtr.Zero) return 3;
        int n = int.Parse(args[3]);
        Stopwatch sw = Stopwatch.StartNew();
        for (int i = 0; i < n; i++)
        {
            using (Bitmap bmp = Capture(h))
            {
                if (bmp == null) { Thread.Sleep(30); continue; }
                bmp.Save(args[2].Replace("{n}", i.ToString()), ImageFormat.Jpeg);
            }
        }
        Console.WriteLine("frames=" + n + " ms=" + sw.ElapsedMilliseconds);
        return 0;
    }

    private static ImageCodecInfo JpegCodec()
    {
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") return c;
        return null;
    }

    private static int Serve(string[] args)
    {
        if (args.Length < 5) return 1;
        targetTitle = args[1];
        int port = int.Parse(args[2]);
        double fps = double.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture);
        long quality = long.Parse(args[4]);
        double scale = args.Length > 5 ? double.Parse(args[5], System.Globalization.CultureInfo.InvariantCulture) : 1.0;

        TcpListener listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        Console.WriteLine("listening " + port);

        Thread cap = new Thread(delegate () { CaptureLoop(fps, quality, scale); });
        cap.IsBackground = true;
        cap.Start();

        Thread.Sleep(200);
        while (running)
        {
            try
            {
                TcpClient client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(delegate (object o) { HandleClient((TcpClient)o, port); }, client);
            }
            catch { if (!running) break; Thread.Sleep(20); }
        }
        return 0;
    }

    private static void CaptureLoop(double fps, long quality, double scale)
    {
        long interval = (long)Math.Max(1, 1000.0 / Math.Max(1.0, fps));
        Bitmap bmp = null;
        Graphics g = null;
        Bitmap outBmp = null;
        Graphics og = null;
        int lastW = 0, lastH = 0;
        ImageCodecInfo codec = JpegCodec();
        EncoderParameters ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        MemoryStream ms = new MemoryStream(256 * 1024);
        int miss = 0;
        IntPtr prepared = IntPtr.Zero;
        Stopwatch fpsSw = Stopwatch.StartNew();
        int frames = 0;

        while (running)
        {
            Stopwatch frameSw = Stopwatch.StartNew();
            IntPtr h = FindWindow(null, targetTitle);
            if (h == IntPtr.Zero)
            {
                miss++;
                if (miss == 10) { lock (Sync) { latest = null; } }
                if (miss > 600) { Console.WriteLine("window gone"); running = false; break; }
                Thread.Sleep(100);
                continue;
            }
            miss = 0;
            if (h != prepared)
            {
                PrepareWindow(h);
                prepared = h;
            }

            RECT r;
            if (!GetWindowRect(h, out r)) { Thread.Sleep(50); continue; }
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            if (w <= 0 || hh <= 0) { Thread.Sleep(50); continue; }

            if (bmp == null || w != lastW || hh != lastH)
            {
                if (og != null) og.Dispose();
                if (outBmp != null) outBmp.Dispose();
                if (g != null) g.Dispose();
                if (bmp != null) bmp.Dispose();
                bmp = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
                g = Graphics.FromImage(bmp);
                int ow = Math.Max(2, (int)Math.Round(w * scale));
                int oh = Math.Max(2, (int)Math.Round(hh * scale));
                outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);
                og = Graphics.FromImage(outBmp);
                og.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                lastW = w; lastH = hh;
            }

            bool ok;
            IntPtr hdc = g.GetHdc();
            try { ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT); }
            finally { g.ReleaseHdc(hdc); }

            if (ok)
            {
                og.DrawImage(bmp, 0, 0, outBmp.Width, outBmp.Height);
                ms.SetLength(0);
                outBmp.Save(ms, codec, ep);
                byte[] bytes = ms.ToArray();
                lock (Sync) { latest = bytes; seq++; }
                frames++;
            }

            long wait = interval - frameSw.ElapsedMilliseconds;
            if (wait > 0) Thread.Sleep((int)wait);
            if (fpsSw.ElapsedMilliseconds >= 1000)
            {
                fpsActual = frames * 1000.0 / fpsSw.ElapsedMilliseconds;
                frames = 0;
                fpsSw.Reset(); fpsSw.Start();
            }
        }
        if (og != null) og.Dispose();
        if (outBmp != null) outBmp.Dispose();
        if (g != null) g.Dispose();
        if (bmp != null) bmp.Dispose();
    }

    private static void HandleClient(TcpClient client, int port)
    {
        try
        {
            client.ReceiveTimeout = 5000;
            using (client)
            {
                NetworkStream ns = client.GetStream();
                StreamReader sr = new StreamReader(ns, Encoding.ASCII, false, 1024, true);
                string line = sr.ReadLine();
                string path = "/";
                if (!string.IsNullOrEmpty(line))
                {
                    string[] parts = line.Split(' ');
                    if (parts.Length >= 2) path = parts[1];
                }
                while (true) { string h = sr.ReadLine(); if (string.IsNullOrEmpty(h)) break; }

                if (path.StartsWith("/frame") || path.StartsWith("/scene"))
                {
                    byte[] data;
                    lock (Sync) { data = latest; }
                    if (data == null)
                    {
                        WriteText(ns, "503 Service Unavailable", "no frame yet");
                    }
                    else
                    {
                        byte[] head = Encoding.ASCII.GetBytes(
                            "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: " + data.Length +
                            "\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\n" +
                            "Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
                        ns.Write(head, 0, head.Length);
                        ns.Write(data, 0, data.Length);
                    }
                }
                else if (path.StartsWith("/status") || path.StartsWith("/health"))
                {
                    long s; lock (Sync) { s = seq; }
                    string json = "{\"ok\":true,\"port\":" + port + ",\"frames\":" + s + ",\"fps\":" + fpsActual.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + ",\"title\":\"" + targetTitle.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}";
                    WriteText(ns, "200 OK", json, "application/json");
                }
                else
                {
                    WriteText(ns, "404 Not Found", "not found");
                }
            }
        }
        catch { }
    }

    private static void WriteText(NetworkStream ns, string status, string body, string type = "text/plain")
    {
        byte[] b = Encoding.UTF8.GetBytes(body);
        byte[] head = Encoding.ASCII.GetBytes(
            "HTTP/1.1 " + status + "\r\nContent-Type: " + type + "; charset=utf-8\r\nContent-Length: " + b.Length +
            "\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
        ns.Write(head, 0, head.Length);
        ns.Write(b, 0, b.Length);
    }
}


