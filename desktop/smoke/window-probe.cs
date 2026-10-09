using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class QuotumWindowProbe {
  public delegate bool EnumCallback(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static void Escape(IntPtr window, int process) {
    uint owner; GetWindowThreadProcessId(window,out owner);
    if(owner!=(uint)process) throw new Exception("Not the test app window");
    SetForegroundWindow(window);
    if(GetForegroundWindow()!=window) throw new Exception("Test panel does not own keyboard focus");
    keybd_event(27,0,0,UIntPtr.Zero);
    keybd_event(27,0,2,UIntPtr.Zero);
  }
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  public static IntPtr Find(int process) {
    return FindOther(process,IntPtr.Zero);
  }
  public static IntPtr FindOther(int process, IntPtr except) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,data) => {
      uint owner; GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process || window==except || !IsWindowVisible(window)) return true;
      var kind=new StringBuilder(256); GetClassName(window,kind,kind.Capacity);
      if(kind.ToString()=="QuotumLoading") return true;
      var text=new StringBuilder(256); GetWindowText(window,text,text.Capacity);
      if(text.ToString()!="Quotum") return true;
      found=window; return false;
    },IntPtr.Zero);
    return found;
  }
  [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access, bool inherit, uint thread);
  [DllImport("kernel32.dll")] static extern uint GetProcessIdOfThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint SuspendThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int x1,int y1,int x2,int y2);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr window,IntPtr region);
  [DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr region,int x,int y);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
  public static bool Rounded(IntPtr window) {
    IntPtr region=CreateRectRgn(0,0,0,0);
    try {
      Rect outer,client;var origin=new Point();
      if(GetWindowRgn(window,region)==0 || !GetWindowRect(window,out outer) || !GetClientRect(window,out client) || !ClientToScreen(window,ref origin)) return false;
      int x=origin.X-outer.Left,y=origin.Y-outer.Top;
      return !PtInRegion(region,x,y) && PtInRegion(region,x+client.Right/2,y+client.Bottom/2);
    } finally { DeleteObject(region); }
  }
  public static IntPtr Loading(int process) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,data)=>{
      uint owner;GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process || !IsWindowVisible(window)) return true;
      var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
      if(name.ToString()!="QuotumLoading") return true;
      found=window;return false;
    },IntPtr.Zero);return found;
  }
  public static IntPtr PauseUi(IntPtr window,int process,uint expected=0) {
    uint owner;uint thread=GetWindowThreadProcessId(window,out owner);
    if(owner!=(uint)process || thread==0 || expected!=0 && expected!=thread) throw new Exception("Not the test app UI thread");
    IntPtr handle=OpenThread(0x0802,false,thread);
    if(handle==IntPtr.Zero) throw new Exception("Cannot open the test UI thread");
    if(GetProcessIdOfThread(handle)!=(uint)process || GetWindowThreadProcessId(window,out owner)!=thread || owner!=(uint)process){CloseHandle(handle);throw new Exception("UI thread ownership changed");}
    if(SuspendThread(handle)==uint.MaxValue){CloseHandle(handle);throw new Exception("Cannot pause the test UI thread");}
    return handle;
  }
  public static void ResumeUi(IntPtr thread) {
    try { if(ResumeThread(thread)==uint.MaxValue) throw new Exception("Cannot resume the test UI thread"); }
    finally {CloseHandle(thread);}
  }
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint process);
  [StructLayout(LayoutKind.Sequential)] struct CopyData { public UIntPtr Kind; public uint Size; public IntPtr Data; }
  public sealed class PauseGuard : IDisposable {
    internal IntPtr Handle;
    internal DispatchReading Reading;
    public bool Resumed { get; private set; }
    public void Dispose() {
      if(Handle==IntPtr.Zero)return;
      var handle=Handle;Handle=IntPtr.Zero;
      if(Reading!=null){Reading.ResumeAttempted=true;Reading.Stage="resuming";}
      ResumeUi(handle);Resumed=true;
      if(Reading!=null){Reading.Resumed=true;Reading.Stage="resumed";}
    }
  }
  public sealed class DispatchReading {
    public string Stage="find-target", Acceptance="not-sent";
    public long Window, ElapsedMs;
    public uint Process, Thread;
    public bool Paused, ResumeAttempted, Resumed;
  }
  public static DispatchReading LastDispatch { get; private set; }
  public static void ResetDispatch() { LastDispatch=null; }
  public static PauseGuard MainRequestThenPause(int process,string exe) {
    var clock=Stopwatch.StartNew();
    var reading=new DispatchReading();LastDispatch=reading;
    var guard=new PauseGuard();
    IntPtr target=IntPtr.Zero;
    try {
      EnumWindows((window,data)=>{
        uint owner;uint thread=GetWindowThreadProcessId(window,out owner);
        var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
        if(owner!=(uint)process || name.ToString()!="com.padurets.quotum-sic")return true;
        target=window;reading.Window=window.ToInt64();reading.Process=owner;reading.Thread=thread;return false;
      },IntPtr.Zero);
      if(target==IntPtr.Zero)throw new Exception("Main dispatch: no owned target");
      // Cross-process WM_COPYDATA is marshalled by Windows, including a receiver
      // that outlives our timeout. Never use this path for an in-process HWND.
      if(process==Process.GetCurrentProcess().Id)throw new Exception("Main dispatch: target must be another process");
      reading.Stage="preflight";
      IntPtr result;
      uint remaining=(uint)Math.Max(0,3000-clock.ElapsedMilliseconds);
      if(remaining==0 || SendMessageTimeout(target,0,IntPtr.Zero,IntPtr.Zero,2,Math.Min(1000u,remaining),out result)==IntPtr.Zero)
        throw new Exception("Main dispatch: owned target unresponsive");
      byte[] bytes=Encoding.UTF8.GetBytes(Environment.CurrentDirectory+"|"+exe+"\0");
      IntPtr dataBuffer=Marshal.AllocHGlobal(bytes.Length),message=IntPtr.Zero;
      try {
        message=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CopyData)));
        Marshal.Copy(bytes,0,dataBuffer,bytes.Length);
        Marshal.StructureToPtr(new CopyData{Kind=new UIntPtr(1542),Size=(uint)bytes.Length,Data=dataBuffer},message,false);
        AllowSetForegroundWindow((uint)process);
        reading.Stage="dispatch";
        remaining=(uint)Math.Max(0,3000-clock.ElapsedMilliseconds);
        if(remaining==0)throw new Exception("Main dispatch: deadline before send");
        reading.Acceptance="unknown";
        if(SendMessageTimeout(target,0x4a,IntPtr.Zero,message,2,remaining,out result)==IntPtr.Zero)
          throw new Exception("Main dispatch: timeout or delivery failure; acceptance unknown");
        reading.Acceptance=result==new IntPtr(1)?"accepted":"rejected";
        if(reading.Acceptance!="accepted")throw new Exception("Main dispatch: rejected");
      } finally {if(message!=IntPtr.Zero)Marshal.FreeHGlobal(message);Marshal.FreeHGlobal(dataBuffer);}
      if(clock.ElapsedMilliseconds>=3000)throw new Exception("Main dispatch: deadline elapsed before pause");
      reading.Stage="pause";
      guard.Reading=reading;
      guard.Handle=PauseUi(target,process,reading.Thread);
      reading.Paused=true;reading.Stage="paused";
      return guard;
    } catch {guard.Dispose();throw;}
    finally {reading.ElapsedMs=clock.ElapsedMilliseconds;}
  }
  public sealed class WindowReading {
    public long Window;public uint Process,Thread;public bool Owned,Visible,Foreground,Rounded;
    public int[] Bounds;
  }
  public static WindowReading Snapshot(IntPtr window,int process) {
    var reading=new WindowReading{Window=window.ToInt64()};
    reading.Thread=GetWindowThreadProcessId(window,out reading.Process);
    reading.Owned=reading.Process==(uint)process && reading.Thread!=0;
    if(!reading.Owned)return reading;
    Rect rect;
    if(GetWindowRect(window,out rect))reading.Bounds=new int[]{rect.Left,rect.Top,rect.Right,rect.Bottom};
    reading.Visible=IsWindowVisible(window);reading.Foreground=Foreground(window);reading.Rounded=Rounded(window);
    return reading;
  }
  public static bool Foreground(IntPtr window) { return GetForegroundWindow()==window; }
  public static bool OpenPanel(int process) {
    IntPtr tray=IntPtr.Zero;
    EnumWindows((window,data) => {
      uint owner; GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process) return true;
      var name=new StringBuilder(256); GetClassName(window,name,name.Capacity);
      if(name.ToString()!="QuotumTray") return true;
      tray=window; return false;
    },IntPtr.Zero);
    // The Shell icon's version-4 NIN_SELECT callback (icon 1).
    return tray!=IntPtr.Zero && PostMessage(tray,0x8002,IntPtr.Zero,new IntPtr(0x10400));
  }
  public static bool Responsive(IntPtr window) {
    IntPtr result;
    return SendMessageTimeout(window,0,IntPtr.Zero,IntPtr.Zero,2,1000,out result)!=IntPtr.Zero;
  }
  public static int[] Bounds(IntPtr window) {
    Rect rect;
    var info=new MonitorInfo(); info.Size=Marshal.SizeOf(info);
    if(!GetWindowRect(window,out rect) || !GetMonitorInfo(MonitorFromWindow(window,2),ref info)) throw new Exception("Cannot read the window work area");
    return new int[]{rect.Left,rect.Top,rect.Right,rect.Bottom,info.Work.Left,info.Work.Top,info.Work.Right,info.Work.Bottom};
  }
}
