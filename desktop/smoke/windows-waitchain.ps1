# Runs only as a disposable diagnostic worker, after the scenario's pause was released.
param([int]$Owner,[long]$Birth,[uint32]$Thread)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class QuotumWaitChain {
  [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access,bool inherit,uint id);
  [DllImport("kernel32.dll")] static extern uint GetProcessIdOfThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll",SetLastError=true)] static extern IntPtr OpenThreadWaitChainSession(uint flags,IntPtr callback);
  [DllImport("advapi32.dll")] static extern void CloseThreadWaitChainSession(IntPtr session);
  [StructLayout(LayoutKind.Explicit,Size=280)] struct Node {
    [FieldOffset(0)]public uint Type;[FieldOffset(4)]public uint Status;
    [FieldOffset(8)]public uint Process;[FieldOffset(12)]public uint Thread;
  }
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetThreadWaitChain(IntPtr session,UIntPtr context,uint flags,uint thread,ref uint count,[Out] Node[] nodes,out bool cycle);
  public static object Read(int owner,long birth,uint thread) {
    using(var process=Process.GetProcessById(owner)){
      if(process.StartTime.ToUniversalTime().Ticks!=birth)return new {status="identity-changed"};
      var handle=OpenThread(0x0800,false,thread);
      if(handle==IntPtr.Zero)return new {status="thread-unavailable"};
      try {
        if(GetProcessIdOfThread(handle)!=(uint)owner)return new {status="foreign-thread"};
        var session=OpenThreadWaitChainSession(0,IntPtr.Zero);
        if(session==IntPtr.Zero)return new {status="unavailable",error=Marshal.GetLastWin32Error()};
        try {
          uint count=16;bool cycle;var nodes=new Node[16];
          bool ok=GetThreadWaitChain(session,UIntPtr.Zero,0,thread,ref count,nodes,out cycle);
          int error=ok?0:Marshal.GetLastWin32Error();
          var safe=new List<object>();
          // No object names, and no traversal or identities beyond the owned process.
          if(ok || error==234 || error==565)for(int i=0;i<Math.Min(count,16);i++){
            var node=nodes[i];safe.Add(new {type=node.Type,status=node.Status,
              process=node.Type==8 && node.Process==(uint)owner?node.Process:0,
              thread=node.Type==8 && node.Process==(uint)owner?node.Thread:0});
          }
          return new {status=ok?"complete":"unavailable",error,cycle,nodes=safe};
        } finally {CloseThreadWaitChainSession(session);}
      } finally {CloseHandle(handle);}
    }
  }
}
'@
try {[QuotumWaitChain]::Read($Owner,$Birth,$Thread) | ConvertTo-Json -Depth 4 -Compress}
catch {'{"status":"unavailable"}'}
