$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Only the native fixture enables numeric stage observations; stderr stays private.
$observeStages = $env:QUOTUM_TEST_KEY_STAGES -eq '1'
$setupWatch = if ($observeStages) { [Diagnostics.Stopwatch]::StartNew() } else { $null }
function Observe-SetupStage([int]$stage) {
  if ($observeStages) {
    try { [Console]::Error.WriteLine('QKS1 ' + $stage + ' ' + $setupWatch.ElapsedMilliseconds); [Console]::Error.Flush() } catch {}
  }
}
Observe-SetupStage 1
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;

public static class QuotumManagedKey {
  static readonly bool ObserveStages = Environment.GetEnvironmentVariable("QUOTUM_TEST_KEY_STAGES") == "1";
  static void Stage(int stage,Stopwatch watch) {
    if(ObserveStages)try {Console.Error.WriteLine("QKS1 "+stage+" "+watch.ElapsedMilliseconds);Console.Error.Flush();}catch{}
  }
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Length; public IntPtr Descriptor; public int Inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegOpenKeyEx(IntPtr key,string name,int options,int rights,out IntPtr opened);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegCreateKeyEx(IntPtr key,string name,int reserved,string cls,int options,int rights,ref SA security,out IntPtr opened,out int disposition);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegQueryValueEx(IntPtr key,string name,IntPtr reserved,out int type,byte[] bytes,ref int size);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegSetValueEx(IntPtr key,string name,int reserved,int type,byte[] bytes,int size);
  [DllImport("advapi32.dll")] static extern int RegFlushKey(IntPtr key);
  [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateMutexEx(ref SA security,string name,int flags,int rights);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool ReleaseMutex(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle,int type,int information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern int GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  static readonly IntPtr HKCU = new IntPtr(unchecked((int)0x80000001));
  const int Rights = 0x20003, Wow64 = 0x100;
  static SA Security(string sid,string access) {
    var sd=new RawSecurityDescriptor("O:"+sid+"D:P(A;;"+access+";;;"+sid+")(A;;"+access+";;;SY)");
    var bytes=new byte[sd.BinaryLength];sd.GetBinaryForm(bytes,0);
    var ptr=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,ptr,bytes.Length);
    return new SA {Length=Marshal.SizeOf(typeof(SA)),Descriptor=ptr,Inherit=0};
  }
  static void Private(IntPtr handle,int type,string sid,int required) {
    IntPtr owner,group,dacl,sacl,descriptor;
    if(GetSecurityInfo(handle,type,5,out owner,out group,out dacl,out sacl,out descriptor)!=0)throw new Exception();
    try {
      var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);
      var sd=new RawSecurityDescriptor(bytes,0);
      if(sd.Owner==null||sd.Owner.Value!=sid||sd.DiscretionaryAcl==null||(sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw new Exception();
      int mine=0;
      foreach(GenericAce ace in sd.DiscretionaryAcl) {
        var allowed=ace as CommonAce;
        if(allowed==null||allowed.AceQualifier!=AceQualifier.AccessAllowed||(allowed.AceFlags&AceFlags.Inherited)!=0)throw new Exception();
        var who=allowed.SecurityIdentifier.Value;
        if(who!=sid&&who!="S-1-5-18")throw new Exception();
        if(who==sid)mine|=allowed.AccessMask;
      }
      if((mine&required)!=required)throw new Exception();
    } finally {LocalFree(descriptor);}
  }
  static bool Valid(byte[] bytes) {
    if(bytes.Length!=43)return false;
    var text=Encoding.ASCII.GetString(bytes);
    if(!System.Text.RegularExpressions.Regex.IsMatch(text,"^[A-Za-z0-9_-]{43}$"))return false;
    try {var raw=Convert.FromBase64String(text.Replace('-','+').Replace('_','/')+"=");return raw.Length==32&&Convert.ToBase64String(raw).TrimEnd('=').Replace('+','-').Replace('/','_')==text;}catch{return false;}
  }
  static byte[] Query(IntPtr key,out bool missing) {
    var bytes=new byte[44];int size=bytes.Length,type;
    var code=RegQueryValueEx(key,"CurrentKey",IntPtr.Zero,out type,bytes,ref size);
    missing=code==2;
    if(missing)return null;
    if(code!=0||type!=3||size!=43)throw new InvalidDataException();
    var exact=new byte[43];Array.Copy(bytes,exact,43);Array.Clear(bytes,0,bytes.Length);
    if(!Valid(exact))throw new InvalidDataException();return exact;
  }
  public static void Run() {
    var input=new byte[84];byte[] value=null;IntPtr mutex=IntPtr.Zero,leaf=IntPtr.Zero;bool held=false;
    var security=new SA();byte status=3;var watch=Stopwatch.StartNew();
    Stage(3,watch);
    try {
      var stream=Console.OpenStandardInput();int count=0;
      while(count<input.Length){var n=stream.Read(input,count,input.Length-count);if(n==0)throw new Exception();count+=n;}
      Stage(4,watch);
      if(Encoding.ASCII.GetString(input,0,4)!="QKI1"||input[40]>1)throw new Exception();
      var id=Encoding.ASCII.GetString(input,4,36);Guid parsed;
      if(!Guid.TryParseExact(id,"D",out parsed)||parsed.ToString("D")!=id)throw new Exception();
      var candidate=new byte[43];Array.Copy(input,41,candidate,0,43);bool create=input[40]==1;
      if(create&&!Valid(candidate))throw new Exception();
      var sid=WindowsIdentity.GetCurrent().User.Value;
      string hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(sid+"\n"+id))).Replace("-","").ToLowerInvariant();
      security=Security(sid,"0x001f0001");
      mutex=CreateMutexEx(ref security,"Global\\QuotumHubKeys-v1-"+hash,0,0x120001);
      Marshal.FreeHGlobal(security.Descriptor);security.Descriptor=IntPtr.Zero;
      if(mutex==IntPtr.Zero)throw new Exception();Private(mutex,6,sid,0x120001);
      Stage(5,watch);
      var waited=WaitForSingleObject(mutex,8000);
      if(waited!=0&&waited!=0x80)throw new Exception();held=true;
      Stage(6,watch);
      Private(mutex,6,sid,0x120001);
      if(watch.ElapsedMilliseconds>=9000)throw new Exception();
      IntPtr software;
      Stage(7,watch);
      if(RegOpenKeyEx(HKCU,"Software",0,0x20007|Wow64,out software)!=0)throw new Exception();
      leaf=software;security=Security(sid,"KA");
      foreach(var part in new string[]{"Quotum","HubKeys","v1",id}) {
        IntPtr next;var code=RegOpenKeyEx(leaf,part,0,Rights|0x4|Wow64,out next);
        if(code==2&&create){int disposition;if(watch.ElapsedMilliseconds>=9000)throw new Exception();code=RegCreateKeyEx(leaf,part,0,null,0,Rights|0x4|Wow64,ref security,out next,out disposition);}
        if(code==2){status=1;return;}if(code!=0)throw new Exception();
        RegCloseKey(leaf);leaf=next;Private(leaf,4,sid,Rights);
      }
      bool missing;value=Query(leaf,out missing);
      Stage(8,watch);
      if(missing) {
        if(!create){status=1;return;}
        if(watch.ElapsedMilliseconds>=9000)throw new Exception();
        if(RegSetValueEx(leaf,"CurrentKey",0,3,candidate,43)!=0)throw new Exception();value=candidate;
      }
      Stage(9,watch);
      if(RegFlushKey(leaf)!=0)throw new Exception();
      Stage(10,watch);
      var readback=Query(leaf,out missing);
      if(missing||Encoding.ASCII.GetString(readback)!=Encoding.ASCII.GetString(value))throw new Exception();
      Array.Clear(value,0,value.Length);value=readback;Array.Clear(candidate,0,candidate.Length);status=0;
    } catch(InvalidDataException) {status=2;} catch {status=3;}
    finally {
      if(leaf!=IntPtr.Zero)RegCloseKey(leaf);
      if(held)ReleaseMutex(mutex);if(mutex!=IntPtr.Zero)CloseHandle(mutex);
      if(security.Descriptor!=IntPtr.Zero)Marshal.FreeHGlobal(security.Descriptor);
      Array.Clear(input,0,input.Length);
      var output=Console.OpenStandardOutput();var header=new byte[]{81,75,82,49,status};
      Stage(11,watch);
      try {output.Write(header,0,header.Length);if(status==0)output.Write(value,0,value.Length);output.Flush();}catch{}
      if(value!=null)Array.Clear(value,0,value.Length);
    }
  }
}
'@ -ErrorAction Stop | Out-Null
  Observe-SetupStage 2
  [QuotumManagedKey]::Run()
} catch {
  try { $out = [Console]::OpenStandardOutput(); $bytes = [byte[]](81,75,82,49,3); $out.Write($bytes,0,5); $out.Flush() } catch {}
}
