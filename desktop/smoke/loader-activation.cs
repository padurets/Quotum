// Native activation diagnostics. The policy is a model of the Rust loader branch.
// Actual WM_ACTIVATE messages and current foreground HWNDs qualify the schedule.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class QuotumLoaderActivationControl {
  delegate IntPtr Procedure(IntPtr window,uint message,IntPtr w,IntPtr l);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Class {
    public uint Size,Style;public Procedure Procedure;public int ClassExtra,WindowExtra;
    public IntPtr Instance,Icon,Cursor,Background;public string Menu,Name;public IntPtr SmallIcon;
  }
  [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr Window;public uint Id;public UIntPtr W;public IntPtr L;public uint Time;public int X,Y;public uint Private;}
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClassEx(ref Class cls);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint extra,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr data);
  [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr window,uint min,uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr window,uint message,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  const uint Show=0x8001,Gate=0x8002,Close=0x8003;
  static readonly object sync=new object();
  static readonly List<object> receipts=new List<object>();
  static readonly ManualResetEventSlim mainReady=new ManualResetEventSlim(),loaderReady=new ManualResetEventSlim(),shown=new ManualResetEventSlim(),gateEntered=new ManualResetEventSlim(),gateRelease=new ManualResetEventSlim();
  static Procedure callback;
  static IntPtr main,loader;
  static bool guarded;
  static volatile bool visible,wanted;
  static volatile IntPtr ready;
  static volatile int cancelled,staleObserved,linkedStaleObserved,staleIgnored,gateStarted,gateReturned,gateExpired;
  static int overflow;
  static long sequence;
  static string failure;
  static readonly Stopwatch clock=Stopwatch.StartNew();
  public sealed class Reading {
    public long N,UtcTicks,MonotonicTicks,Window,Foreground,L,Ready;
    public uint Message,Thread,CurrentThread,Process;public int W,Cancellations,GateStarted,GateReturned;
    public bool Owned,Visible,NativeVisible,Wanted;public string Kind;
  }
  static void Record(string kind,IntPtr window,uint message=0,IntPtr w=default(IntPtr),IntPtr l=default(IntPtr)) {
    uint process;uint thread=GetWindowThreadProcessId(window,out process);
    var reading=new Reading{N=Interlocked.Increment(ref sequence),UtcTicks=DateTime.UtcNow.Ticks,MonotonicTicks=Stopwatch.GetTimestamp(),Window=window.ToInt64(),Message=message,W=(int)w.ToInt64(),L=l.ToInt64(),Foreground=GetForegroundWindow().ToInt64(),Thread=thread,CurrentThread=GetCurrentThreadId(),Process=process,Owned=process==(uint)Process.GetCurrentProcess().Id && thread!=0,Visible=visible,NativeVisible=IsWindowVisible(window),Wanted=wanted,Ready=ready.ToInt64(),Cancellations=cancelled,GateStarted=gateStarted,GateReturned=gateReturned,Kind=kind};
    lock(sync){if(receipts.Count<128)receipts.Add(reading);else overflow++;}
  }
  static void Dismiss(IntPtr window) {
    cancelled++;wanted=false;visible=false;Record("cancel",window);ShowWindow(window,0);
  }
  static IntPtr Handle(IntPtr window,uint message,IntPtr w,IntPtr l) {
    if(message==6 || window==loader && message==0x100)Record("native-message",window,message,w,l);
    if(window==loader && message==6 && (w.ToInt64()&65535)==0 && visible){
      var foreground=GetForegroundWindow();
      if(foreground==loader){
        staleObserved++;Record("stale-inactive",window,message,w,l);
        if(l==main)linkedStaleObserved++;
        if(guarded){staleIgnored++;Record("stale-ignored",window,message,w,l);return IntPtr.Zero;}
      }
      if(ready!=IntPtr.Zero && foreground==ready){visible=false;Record("handoff",window);ShowWindow(window,0);}
      else Dismiss(window);
      return IntPtr.Zero;
    }
    if(window==loader && message==0x100 && w.ToInt64()==27){Dismiss(window);return IntPtr.Zero;}
    if(window==loader && message==Show){
      visible=true;wanted=true;Record("show-before",window);
      ShowWindow(window,5);Record("show-returned",window);
      bool applied=SetForegroundWindow(window);Record(applied?"foreground-call-true":"foreground-call-false",window);
      SetFocus(window);shown.Set();return IntPtr.Zero;
    }
    if(window==loader && message==Gate){
      Interlocked.Increment(ref gateStarted);Record("gate-entered",window);gateEntered.Set();
      try {if(!gateRelease.Wait(3000)){Interlocked.Increment(ref gateExpired);Record("gate-expired",window);}}
      finally {Interlocked.Increment(ref gateReturned);Record("gate-returned",window);}
      return IntPtr.Zero;
    }
    if(message==Close){DestroyWindow(window);PostQuitMessage(0);return IntPtr.Zero;}
    return DefWindowProc(window,message,w,l);
  }
  static void Window(bool isLoader) {
    try {
      string name="QuotumActivationControl"+(isLoader?"Loader":"Main")+Process.GetCurrentProcess().Id;
      var cls=new Class{Size=(uint)Marshal.SizeOf<Class>(),Name=name,Procedure=callback};
      if(RegisterClassEx(ref cls)==0)throw new Exception("class");
      var handle=CreateWindowEx(isLoader?0x80u:0u,name,"fixture",0x80000000,20+(isLoader?240:0),20,200,100,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
      if(handle==IntPtr.Zero)throw new Exception("window");
      if(isLoader){loader=handle;loaderReady.Set();}else{main=handle;ShowWindow(handle,5);mainReady.Set();}
      Record("created",handle);
      Message next;while(GetMessage(out next,IntPtr.Zero,0,0)>0){TranslateMessage(ref next);DispatchMessage(ref next);}
      Record("loop-ended",handle);
    } catch(Exception e){failure=e.GetType().Name;mainReady.Set();loaderReady.Set();}
  }
  static void Require(bool condition,string reason){if(!condition)throw new InvalidOperationException(reason);}
  static bool Until(Func<bool> condition,int limit=1000){var watch=Stopwatch.StartNew();do{if(condition())return true;Thread.Sleep(1);}while(watch.ElapsedMilliseconds<limit);return condition();}
  static void Activate(IntPtr window,string kind,int limit=1000){
    bool call=SetForegroundWindow(window);Record(call?kind+"-call-true":kind+"-call-false",window);
    Require(Until(()=>GetForegroundWindow()==window,limit),kind+"-not-observed");Record(kind+"-observed",window);
  }
  public static object Run(string policy,string scenario) {
    guarded=policy=="guard";callback=Handle;
    var first=new Thread(()=>Window(false));var second=new Thread(()=>Window(true));
    first.IsBackground=true;second.IsBackground=true;
    bool qualified=false,passed=false;string status="unavailable",reason=null;int transitions=0;
    try {
      first.Start();second.Start();Require(mainReady.Wait(2000)&&loaderReady.Wait(2000)&&main!=IntPtr.Zero&&loader!=IntPtr.Zero,"creation-unavailable");
      uint mainProcess,loaderProcess;uint mainThread=GetWindowThreadProcessId(main,out mainProcess),loaderThread=GetWindowThreadProcessId(loader,out loaderProcess);
      Require(mainProcess==(uint)Process.GetCurrentProcess().Id&&loaderProcess==mainProcess&&mainThread!=loaderThread&&mainThread!=0&&loaderThread!=0,"ownership-unavailable");
      Activate(main,"initial-main");
      Require(PostMessage(loader,Show,IntPtr.Zero,IntPtr.Zero),"show-not-posted");
      Require(shown.Wait(1000)&&Until(()=>GetForegroundWindow()==loader)&&visible&&wanted,"initial-loader-not-observed");
      transitions++;Record("transition-main-loader",loader);
      if(scenario=="stale"){
        Require(PostMessage(loader,Gate,IntPtr.Zero,IntPtr.Zero)&&gateEntered.Wait(1000),"gate-not-entered");
        var remaining=Stopwatch.StartNew();
        try {
          Activate(main,"held-main",1000);transitions++;Record("transition-loader-main",main);
          Activate(loader,"held-loader",(int)Math.Max(1,2000-remaining.ElapsedMilliseconds));transitions++;Record("transition-main-loader-again",loader);
          Require(gateReturned==0&&gateExpired==0,"gate-returned-before-foreground-reversal");
        } finally {gateRelease.Set();}
        Require(Until(()=>gateReturned==1)&&gateExpired==0,"gate-not-cleanly-returned");
        Require(Until(()=>linkedStaleObserved>0),"linked-native-stale-inactive-not-observed");
        qualified=transitions==3&&gateStarted==1&&gateReturned==1&&linkedStaleObserved>0;
        passed=guarded?staleIgnored>0&&cancelled==0&&visible&&wanted&&IsWindowVisible(loader):cancelled==1&&!wanted&&!visible&&!IsWindowVisible(loader);
      } else if(scenario=="blur"){
        Activate(main,"true-blur");transitions++;
        Require(Until(()=>cancelled==1&&!visible&&!wanted&&!IsWindowVisible(loader)),"true-blur-not-cancelled");qualified=true;passed=true;
      } else if(scenario=="escape"){
        Require(GetForegroundWindow()==loader,"escape-no-foreground");Record("escape-input",loader);
        keybd_event(27,0,0,UIntPtr.Zero);keybd_event(27,0,2,UIntPtr.Zero);
        Require(Until(()=>cancelled==1&&!visible&&!wanted&&!IsWindowVisible(loader)),"native-escape-not-cancelled");qualified=true;passed=true;
      } else if(scenario=="handoff"){
        ready=main;Record("ready-target",loader);Activate(main,"ready-handoff");transitions++;
        Require(Until(()=>!visible&&!IsWindowVisible(loader)),"ready-handoff-not-hidden");qualified=true;passed=cancelled==0&&wanted;
      } else throw new InvalidOperationException("invalid-scenario");
      status=qualified?(passed?"qualified":"policy-failed"):"unavailable";
    } catch(Exception e){reason=e.Message;status="unavailable";}
    finally {
      gateRelease.Set();if(loader!=IntPtr.Zero)Record("final-snapshot",loader);
      if(loader!=IntPtr.Zero)PostMessage(loader,Close,IntPtr.Zero,IntPtr.Zero);if(main!=IntPtr.Zero)PostMessage(main,Close,IntPtr.Zero,IntPtr.Zero);
      bool loaderEnded=second.Join(1000),mainEnded=first.Join(1000);
      if(!loaderEnded||!mainEnded){qualified=false;passed=false;status="cleanup-unconfirmed";reason="native-loop-not-ended";}
    }
    if(overflow!=0||failure!=null){qualified=false;passed=false;status="unavailable";reason=overflow!=0?"receipt-overflow":"native-thread-failure";}
    return new {scope="native-policy-model",nativeRuntimeExecuted=true,policy,scenario,status,qualified,passed,reason,transitions,cancelled,staleObserved,linkedStaleObserved,staleIgnored,gateStarted,gateReturned,gateExpired,overflow,elapsedMs=clock.ElapsedMilliseconds,receipts};
  }
}
