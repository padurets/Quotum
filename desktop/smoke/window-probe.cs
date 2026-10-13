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
  public static void ResetDispatch() { LastDispatch=null; LastUnresponsive=null; LastPanelDispatch=null; requestProcess=null; requestBirth=0; }
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
    public int? LoadingPhase;
  }
  public static WindowReading Snapshot(IntPtr window,int process) {
    var reading=new WindowReading{Window=window.ToInt64()};
    reading.Thread=GetWindowThreadProcessId(window,out reading.Process);
    reading.Owned=reading.Process==(uint)process && reading.Thread!=0;
    if(!reading.Owned)return reading;
    reading.LoadingPhase=LoadingPhase(window);
    Rect rect;
    if(GetWindowRect(window,out rect))reading.Bounds=new int[]{rect.Left,rect.Top,rect.Right,rect.Bottom};
    reading.Visible=IsWindowVisible(window);reading.Foreground=Foreground(window);reading.Rounded=Rounded(window);
    return reading;
  }
  public static bool Foreground(IntPtr window) { return GetForegroundWindow()==window; }
  public static IntPtr Tray(int process) {
    IntPtr tray=IntPtr.Zero;
    EnumWindows((window,data) => {
      uint owner; GetWindowThreadProcessId(window,out owner);
      if(owner!=(uint)process) return true;
      var name=new StringBuilder(256); GetClassName(window,name,name.Capacity);
      if(name.ToString()!="QuotumTray") return true;
      tray=window; return false;
    },IntPtr.Zero);
    return tray;
  }
  public sealed class PanelDispatchReading {
    public long Window,ForegroundWindow,FromUtcTicks,ToUtcTicks;
    public uint Process,Thread,ForegroundProcess,ForegroundThread;
    public RequestHeader RequestBefore;
    public bool Owned,Posted;
  }
  public static PanelDispatchReading LastPanelDispatch;
  public static bool OpenPanel(int process) {
    var reading=new PanelDispatchReading{FromUtcTicks=DateTime.UtcNow.Ticks};
    LastPanelDispatch=reading;
    var tray=Tray(process);
    reading.Window=tray.ToInt64();
    if(tray!=IntPtr.Zero)reading.Thread=GetWindowThreadProcessId(tray,out reading.Process);
    reading.Owned=reading.Process==(uint)process && reading.Thread!=0;
    var foreground=GetForegroundWindow();reading.ForegroundWindow=foreground.ToInt64();
    if(foreground!=IntPtr.Zero)reading.ForegroundThread=GetWindowThreadProcessId(foreground,out reading.ForegroundProcess);
    // The Shell icon's version-4 NIN_SELECT callback (icon 1).
    // Posting proves delivery to the queue, not acceptance by the tray callback.
    if(requestProcess!=null && reading.Owned)reading.RequestBefore=RequestHead(tray,process);
    reading.Posted=tray!=IntPtr.Zero && PostMessage(tray,0x8002,IntPtr.Zero,new IntPtr(0x10400));
    reading.ToUtcTicks=DateTime.UtcNow.Ticks;
    return reading.Posted;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr window,string name);
  static int? LoadingPhase(IntPtr window) {
    long value=GetProp(window,"Quotum.LoadingPhase").ToInt64();
    if(value<1 || value>0xffffff)return null;
    long digits=value;
    while(digits>1){long stage=digits&15;if(stage<2 || stage>14)return null;digits>>=4;}
    return digits==1 ? (int?)value : null;
  }
  public sealed class ResponseReading {
    public long Window,FromUtcTicks,ToUtcTicks;public uint Process,Thread;public bool Owned;public int? LoadingPhase;
  }
  public static ResponseReading LastUnresponsive;
  public static bool Responsive(IntPtr window,int process) {
    IntPtr result;
    bool responsive=SendMessageTimeout(window,0,IntPtr.Zero,IntPtr.Zero,2,1000,out result)!=IntPtr.Zero;
    if(!responsive){
      var reading=new ResponseReading{Window=window.ToInt64(),FromUtcTicks=DateTime.UtcNow.Ticks};
      reading.Thread=GetWindowThreadProcessId(window,out reading.Process);
      reading.Owned=reading.Process==(uint)process && reading.Thread!=0;
      if(reading.Owned)reading.LoadingPhase=LoadingPhase(window);
      reading.ToUtcTicks=DateTime.UtcNow.Ticks;
      LastUnresponsive=reading;
    }
    return responsive;
  }
  public static int[] Bounds(IntPtr window) {
    Rect rect;
    var info=new MonitorInfo(); info.Size=Marshal.SizeOf(info);
    if(!GetWindowRect(window,out rect) || !GetMonitorInfo(MonitorFromWindow(window,2),ref info)) throw new Exception("Cannot read the window work area");
    return new int[]{rect.Left,rect.Top,rect.Right,rect.Bottom,info.Work.Left,info.Work.Top,info.Work.Right,info.Work.Bottom};
  }
  // This channel contains the last natural owner-thread snapshot. Worker writes
  // after that snapshot are deliberately invisible until another natural callback.
  static Process requestProcess;
  static long requestBirth;
  public static void ObserveRequests(Process process) {
    requestProcess=null;requestBirth=0;
    try {if(process!=null && !process.HasExited){requestBirth=process.StartTime.ToUniversalTime().Ticks;requestProcess=process;}} catch {}
  }
  public sealed class RequestHeader {
    public long Window,Birth,SequenceBefore,SequenceAfter,Schema,Lifetime,Epoch,Source,Event,SourceWindow,Kind,OwnerThread,Callbacks,Activations,Errors;
    public uint Process,Thread;
    public bool Owned;
    public string Class="",Status="unavailable";
  }
  public sealed class RequestRecord {
    public int Lane;
    public long Sequence,Epoch;
    public long[] Values;
    public string Status="unknown-milestone";
  }
  public sealed class RequestFrame {
    public long FromUtcTicks,ToUtcTicks;
    public RequestHeader Before,After;
    public RequestRecord[] Rows;
    public bool BeforeCleanup;
  }
  public sealed class RequestEvidence {
    public string Status="unavailable",LinkStatus="unavailable",Scope="last-natural-owner-snapshot",InputAttribution="unknown-last-natural-baseline",CurrentPublisherHealth="unknown-after-last-natural-snapshot";
    public long Request,Callback,ActivationOmissions;
    public bool CallbackObserved,CallbackAccepted,WantedCompact;
    public bool OriginalPostedInputAccepted=false,FreshWorkerAtFailedDeadline=false,ProductionAcceptance=false,CausalPass=false,VisibilityProved=false,WholePipelineQualified=false;
    public RequestFrame Frame;
    public RequestHeader Baseline;
  }
  static string RequestKey(int row,int field) {return "Quotum.Request."+row.ToString("D2")+"."+field.ToString("D2");}
  static long RequestValue(IntPtr window,int row,int field) {return GetProp(window,RequestKey(row,field)).ToInt64();}
  static RequestHeader RequestHead(IntPtr window,int process) {
    var h=new RequestHeader{Window=window.ToInt64()};
    if(IntPtr.Size!=8 || requestProcess==null || process!=requestProcess.Id)return h;
    try {
      h.Birth=requestProcess.StartTime.ToUniversalTime().Ticks;
      h.Thread=GetWindowThreadProcessId(window,out h.Process);
      var name=new StringBuilder(64);GetClassName(window,name,name.Capacity);h.Class=name.ToString()=="QuotumTray"?"QuotumTray":"";
      h.Owned=h.Process==(uint)process && h.Thread!=0 && h.Birth==requestBirth && !requestProcess.HasExited && h.Class=="QuotumTray";
      if(!h.Owned)return h;
      h.SequenceBefore=RequestValue(window,15,0);
      var values=new long[11];
      for(int field=0;field<11;field++)values[field]=RequestValue(window,15,field+1)-1;
      h.SequenceAfter=RequestValue(window,15,0);
      h.Schema=values[0];h.Lifetime=values[1];h.Epoch=values[2];h.Source=values[3];h.Event=values[4];
      h.SourceWindow=values[5];h.Kind=values[6];h.OwnerThread=values[7];h.Callbacks=values[8];h.Activations=values[9];h.Errors=values[10];
      h.Status="qualified";if(!HeaderComplete(h,process,requestBirth))h.Status="unavailable";
    } catch {h.Status="unavailable";}
    return h;
  }
  static RequestRecord RequestRow(IntPtr window,int lane) {
    var row=new RequestRecord{Lane=lane,Values=new long[10]};
    row.Sequence=RequestValue(window,lane,0)-1;
    for(int field=0;field<10;field++)row.Values[field]=RequestValue(window,lane,field+1)-1;
    row.Epoch=RequestValue(window,lane,11)-1;
    return row;
  }
  public static RequestEvidence Requests(int process,bool beforeCleanup) {
    var frame=new RequestFrame{FromUtcTicks=DateTime.UtcNow.Ticks,BeforeCleanup=beforeCleanup};
    try {
      var window=Tray(process);frame.Before=RequestHead(window,process);
      if(frame.Before.Status=="qualified"){
        frame.Rows=new RequestRecord[15];
        for(int lane=0;lane<15;lane++)frame.Rows[lane]=RequestRow(window,lane);
      }
      frame.After=RequestHead(window,process);
    } catch {}
    frame.ToUtcTicks=DateTime.UtcNow.Ticks;
    return QualifyRequests(frame,LastPanelDispatch==null?null:LastPanelDispatch.RequestBefore,process,requestBirth);
  }
  static bool HeaderComplete(RequestHeader h,int process,long birth) {
    return h!=null && h.Status=="qualified" && h.Owned && h.Process==(uint)process && birth>0 && h.Birth==birth && h.Window>0 && h.Thread>0 && h.Class=="QuotumTray" &&
      h.SequenceBefore>0 && (h.SequenceBefore&1)==0 && h.SequenceAfter==h.SequenceBefore && h.Schema==1 && h.Lifetime>0 &&
      h.Epoch>=0 && h.Epoch<=long.MaxValue-2 && h.Source==1 && h.Event>=1 && h.Event<=6 && h.SourceWindow>0 && h.OwnerThread==h.Thread &&
      h.Callbacks>=0 && h.Callbacks<=long.MaxValue-2 && h.Activations>=0 && h.Activations<=long.MaxValue-2 && h.Errors==0 &&
      (h.Kind==1 && h.SourceWindow==h.Window || h.Kind==2 && h.SourceWindow!=h.Window);
  }
  static bool HeaderEqual(RequestHeader a,RequestHeader b,int process,long birth) {
    return HeaderComplete(a,process,birth) && HeaderComplete(b,process,birth) &&
      a.Window==b.Window && a.Thread==b.Thread && a.Lifetime==b.Lifetime && a.SequenceBefore==b.SequenceBefore &&
      a.Epoch==b.Epoch && a.SourceWindow==b.SourceWindow && a.Kind==b.Kind && a.Event==b.Event &&
      a.Callbacks==b.Callbacks && a.Activations==b.Activations;
  }
  static bool RecordComplete(RequestRecord row,long epoch) {
    if(row==null || row.Values==null || row.Values.Length!=10 || row.Sequence<0 || (row.Sequence&1)!=0 || row.Epoch<0 || row.Epoch>epoch)return false;
    foreach(long value in row.Values)if(value<0 || value>long.MaxValue-2)return false;
    if(row.Sequence==0){if(row.Epoch!=0)return false;foreach(long value in row.Values)if(value!=0)return false;return true;}
    return row.Epoch>0 && row.Values[2]>0 && row.Values[3]>0;
  }
  public static RequestRecord ForRequest(RequestEvidence evidence,int lane) {
    if(evidence==null || evidence.Status!="qualified" || evidence.LinkStatus!="qualified" || !evidence.CallbackAccepted || evidence.Frame==null || lane<1 || lane>6)return null;
    var row=evidence.Frame.Rows[lane];
    return row.Status=="qualified" && row.Sequence>0 && row.Values[0]==evidence.Request?row:null;
  }
  public static RequestEvidence QualifyRequests(RequestFrame frame,RequestHeader baseline,int process,long birth) {
    var e=new RequestEvidence{Frame=frame,Baseline=baseline};
    if(frame==null || frame.Before==null || frame.After==null)return e;
    if(!frame.BeforeCleanup){e.Status="unknown-cleanup";return e;}
    if(!HeaderEqual(frame.Before,frame.After,process,birth)){e.Status="unknown-header";return e;}
    if(frame.Rows==null || frame.Rows.Length!=15){e.Status="unknown-partial";return e;}
    for(int lane=0;lane<15;lane++){
      var row=frame.Rows[lane];
      if(row==null || row.Lane!=lane || !RecordComplete(row,frame.After.Epoch)){e.Status="unknown-partial";return e;}
      row.Status=row.Sequence==0?"unknown-milestone":"qualified";
    }
    long first=Math.Max(1,frame.After.Activations-7);
    e.ActivationOmissions=Math.Max(0,frame.After.Activations-8);
    for(int slot=0;slot<8;slot++){
      var row=frame.Rows[7+slot];long ordinal=0;
      for(int offset=0;offset<8;offset++){long candidate=frame.After.Activations-offset;if(candidate>=first && (candidate-1)%8==slot)ordinal=candidate;}
      if(ordinal==0){if(row.Sequence!=0){e.Status="unknown-activation";return e;}continue;}
      if(row.Sequence==0 || row.Values[1]!=ordinal || row.Values[3]>3 || row.Values[4]==0 || (row.Values[5]&0xffff)!=0){e.Status="unknown-activation";return e;}
      long flags=row.Values[9];
      if(flags>31 || (flags&4)!=0 && ((flags&2)==0 || row.Values[7]==0) || (flags&24)==24 ||
        (flags&8)!=0 && ((flags&7)!=7 || row.Values[8]!=row.Values[7])){e.Status="unknown-activation";return e;}
    }
    if(frame.After.Kind==2){
      bool sourceBound=false;
      if(frame.After.Event==3)sourceBound=frame.Rows[6].Sequence>0 && frame.Rows[6].Values[4]==frame.After.SourceWindow && frame.Rows[6].Values[2]==frame.After.OwnerThread;
      if((frame.After.Event==4 || frame.After.Event==5) && frame.After.Activations>0){
        var latest=frame.Rows[7+(int)((frame.After.Activations-1)%8)];
        sourceBound=latest.Values[4]==frame.After.SourceWindow && latest.Values[2]==frame.After.OwnerThread && latest.Values[3]==(frame.After.Event==4?1:2);
      }
      if(!sourceBound){e.Status="unknown-owner-source";return e;}
    }
    e.Status="qualified";e.LinkStatus="insufficient";
    if(!HeaderComplete(baseline,process,birth) || baseline.Window!=frame.After.Window || baseline.Thread!=frame.After.Thread || baseline.Lifetime!=frame.After.Lifetime || baseline.Epoch>frame.After.Epoch || baseline.SequenceBefore>frame.After.SequenceBefore || baseline.Activations>frame.After.Activations){e.LinkStatus="unknown-baseline";return e;}
    if(baseline.Callbacks==long.MaxValue || frame.After.Callbacks!=baseline.Callbacks+1){e.LinkStatus="ambiguous-callback";return e;}
    e.Callback=frame.After.Callbacks;
    var accepted=frame.Rows[0];
    if(accepted.Sequence==0 || accepted.Values[1]!=e.Callback || accepted.Values[2]!=frame.After.OwnerThread){e.LinkStatus="unknown-callback";return e;}
    e.CallbackObserved=true;
    if(accepted.Values[3]==1 && accepted.Values[0]==0){e.LinkStatus="observed-not-accepted";return e;}
    if(accepted.Values[0]==0 || accepted.Values[3]!=2 && accepted.Values[3]!=3 || accepted.Values[5]!=(accepted.Values[3]==2?1:0)){e.LinkStatus="unknown-request";return e;}
    if(frame.After.Activations-baseline.Activations>8){e.LinkStatus="unknown-activation-omissions";return e;}
    e.Request=accepted.Values[0];e.CallbackAccepted=true;e.WantedCompact=accepted.Values[3]==2;e.LinkStatus="qualified";
    for(int lane=1;lane<15;lane++)if(frame.Rows[lane].Sequence>0 && frame.Rows[lane].Values[0]!=e.Request)frame.Rows[lane].Status="other-request";
    return e;
  }
}
