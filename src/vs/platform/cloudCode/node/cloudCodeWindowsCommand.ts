/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICloudCodeCommandResult } from '../common/cloudCodeCommand.js';

type WindowsCommandResult = Pick<ICloudCodeCommandResult, 'exitCode' | 'failure'>;

/** Removes the nonce-bound supervisor result before stderr reaches the model's output budget. */
export class CloudCodeWindowsCommandOutput {
	private pending = '';
	private readonly prefix: string;
	private invalid = false;
	private result: WindowsCommandResult | undefined;

	constructor(nonce: string, private readonly output: (text: string) => void) {
		this.prefix = `\x1eCLOUDCODE_COMMAND_RESULT:${nonce}:`;
	}

	append(text: string): void {
		this.pending += text;
		while (this.pending) {
			const index = this.pending.indexOf(this.prefix);
			if (index < 0) {
				const emitLength = Math.max(0, this.pending.length - this.prefix.length + 1);
				this.output(this.pending.slice(0, emitLength));
				this.pending = this.pending.slice(emitLength);
				return;
			}
			this.output(this.pending.slice(0, index));
			this.pending = this.pending.slice(index);
			const newline = this.pending.indexOf('\n');
			if (newline < 0 && this.pending.length < 256) { return; }
			if (newline < 0) {
				this.invalid = true;
				this.pending = '';
				return;
			}
			const body = this.pending.slice(this.prefix.length, newline).replace(/\r$/, '');
			const match = /^(?<code>null|-?\d{1,10}):(?<status>ok|termination_failed|launch_failed|background_processes)$/.exec(body);
			const code = match?.groups?.code === 'null' ? null : Number(match?.groups?.code);
			const status = match?.groups?.status;
			if (this.result || !match || (code !== null && (!Number.isSafeInteger(code) || code < -2147483648 || code > 4294967295))) {
				this.invalid = true;
			} else if (status === 'ok') {
				this.result = { exitCode: code };
			} else if (status === 'termination_failed' || status === 'launch_failed' || status === 'background_processes') {
				this.result = { exitCode: code, failure: status };
			}
			this.pending = this.pending.slice(newline + 1);
		}
	}

	finish(): WindowsCommandResult | undefined {
		if (this.pending.includes(this.prefix)) { this.invalid = true; }
		this.output(this.pending);
		this.pending = '';
		return this.invalid ? undefined : this.result;
	}
}

/** Constant supervisor program. The command and nonce are sent as JSON over stdin, never code. */
export function cloudCodeWindowsCommandArguments(): string[] {
	return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsCommandScript, 'utf16le').toString('base64')];
}

// Windows 10+ JOB_LIST attaches the job atomically during CreateProcess, before any child code can
// run. An explicit HANDLE_LIST excludes the supervisor's control stdin and sole job handle.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
// https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject
const windowsCommandScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = $null
try {
 [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
 [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
 $request = [Console]::ReadLine() | ConvertFrom-Json
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
public static class CloudCodeCommandJob {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long a,b; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int cb; public IntPtr reserved,desktop,title; public uint x,y,width,height,columns,rows,fill,flags; public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
 [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,IntPtr name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits info,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting info,uint length,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int number);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,ref Security security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool success) { if(!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 static uint Active(IntPtr job) { Accounting info; Check(QueryInformationJobObject(job,1,out info,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)); return info.active; }
 static bool Empty(IntPtr job,int milliseconds) {
  var until=DateTime.UtcNow.AddMilliseconds(milliseconds);
  do { if(Active(job)==0) return true; Thread.Sleep(10); } while(DateTime.UtcNow<until);
  return Active(job)==0;
 }
 public static void Run(string command,string nonce,string cwd) {
  IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobValue=IntPtr.Zero,handles=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;
  ProcessInfo child=new ProcessInfo(); bool created=false,listReady=false; string failure="ok",code="null";
  try {
   job=CreateJobObject(IntPtr.Zero,IntPtr.Zero); Check(job!=IntPtr.Zero);
   var limits=new Limits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
   IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
   list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,2,0,ref size)); listReady=true;
   jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000d),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
   var security=new Security(); security.length=Marshal.SizeOf(typeof(Security)); security.inherit=true;
   input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
   Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out output,0,true,2));
   Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-12),GetCurrentProcess(),out error,0,true,2));
   handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
   Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
   var startup=new StartupEx(); startup.attributes=list; startup.startup.cb=Marshal.SizeOf(typeof(StartupEx)); startup.startup.flags=0x100;
   startup.startup.input=input; startup.startup.output=output; startup.startup.error=error;
   var cancellation=Task.Run(()=>Console.ReadLine());
   if(!cancellation.IsCompleted) {
    string shell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
    var line=new StringBuilder("\""+shell+"\" /d /s /c \""+command+"\"");
    Check(CreateProcess(shell,line,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,cwd,ref startup,out child)); created=true;
    Check(ResumeThread(child.thread)!=0xffffffff);
    while(!cancellation.IsCompleted) { uint wait=WaitForSingleObject(child.process,50); if(wait==0) { uint exitCode; Check(GetExitCodeProcess(child.process,out exitCode)); code=exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture); break; } Check(wait==258); }
    bool remains=!Empty(job,100);
    if(remains) { Check(TerminateJobObject(job,1)); if(!Empty(job,4000)) failure="termination_failed"; else if(!cancellation.IsCompleted) failure="background_processes"; }
   }
  } catch { failure=created ? "termination_failed" : "launch_failed"; }
  finally {
   if(job!=IntPtr.Zero) {
    try { if(Active(job)>0) { Check(TerminateJobObject(job,1)); if(!Empty(job,4000)) failure="termination_failed"; } }
    catch { failure="termination_failed"; }
    CloseHandle(job);
   }
   if(child.thread!=IntPtr.Zero) CloseHandle(child.thread); if(child.process!=IntPtr.Zero) CloseHandle(child.process);
   if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input); if(output!=IntPtr.Zero) CloseHandle(output); if(error!=IntPtr.Zero) CloseHandle(error);
   if(listReady) DeleteProcThreadAttributeList(list); if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list); if(jobValue!=IntPtr.Zero) Marshal.FreeHGlobal(jobValue); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
  }
  Console.Error.WriteLine("\u001eCLOUDCODE_COMMAND_RESULT:"+nonce+":"+code+":"+failure);
 }
}
'@
 [CloudCodeCommandJob]::Run([string]$request.command,[string]$request.nonce,[string]$request.cwd)
} catch {
 if ($request -and $request.nonce) { [Console]::Error.WriteLine([string][char]30 + 'CLOUDCODE_COMMAND_RESULT:' + $request.nonce + ':null:launch_failed') }
 exit 1
}
`;
