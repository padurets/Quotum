// A real cross-process receiver for the smoke helper's acceptance and timeout tests.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class QuotumTestReceiver {
  delegate IntPtr Procedure(IntPtr window,uint message,IntPtr w,IntPtr l);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Class {
    public uint Size,Style;public Procedure Procedure;public int ClassExtra,WindowExtra;
    public IntPtr Instance,Icon,Cursor,Background;public string Menu,Name;public IntPtr SmallIcon;
  }
  [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr Window;public uint Id;public UIntPtr W;public IntPtr L;public uint Time;public int X,Y;public uint Private;}
  [StructLayout(LayoutKind.Sequential)] struct CopyData {public UIntPtr Kind;public uint Size;public IntPtr Data;}
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClassEx(ref Class cls);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint extra,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr data);
  [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr window,uint min,uint max);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr window,uint message,IntPtr w,IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static Procedure callback;
  static void Publish(string file,string value) {
    File.WriteAllText(file+".tmp",value);File.Move(file+".tmp",file,true);
  }
  public static void Run(string mode,string ready,string delivered) {
    // The observer must see a real dependency on a suspended owner, not a later replay.
    Mutex held=null;
    if(mode=="wait-chain")held=new Mutex(true,"Local\\quotum-private-wait-canary-"+Guid.NewGuid().ToString("N"));
    callback=(window,message,w,l)=>{
      if(message==0x8006 && held!=null){held.ReleaseMutex();return IntPtr.Zero;}
      if(message==0 && mode=="unresponsive")Thread.Sleep(5000);
      if(message==0x4a){
        if(mode=="late")Thread.Sleep(5000);
        var value=Marshal.PtrToStructure<CopyData>(l);
        byte[] bytes=new byte[value.Size];Marshal.Copy(value.Data,bytes,0,bytes.Length);
        bool valid=value.Kind==new UIntPtr(1542) && Encoding.UTF8.GetString(bytes).EndsWith("|fixture.exe\0");
        Publish(delivered,valid?"valid":"invalid");
        return mode=="rejected"?IntPtr.Zero:new IntPtr(1);
      }
      return DefWindowProc(window,message,w,l);
    };
    var cls=new Class{Size=(uint)Marshal.SizeOf<Class>(),Name="com.padurets.quotum-sic",Procedure=callback};
    if(RegisterClassEx(ref cls)==0)throw new Exception("Cannot register receiver");
    var handle=CreateWindowEx(0,cls.Name,"fixture",0,0,0,1,1,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
    if(handle==IntPtr.Zero)throw new Exception("Cannot create receiver");
    Publish(ready,handle.ToInt64().ToString());
    if(held!=null){
      var waiter=new Thread(()=>{
        Publish(delivered,GetCurrentThreadId().ToString());
        held.WaitOne();held.ReleaseMutex();Publish(delivered,"released");
      });
      waiter.IsBackground=true;waiter.Start();
    }
    Message next;while(GetMessage(out next,IntPtr.Zero,0,0)>0)DispatchMessage(ref next);
  }
}
