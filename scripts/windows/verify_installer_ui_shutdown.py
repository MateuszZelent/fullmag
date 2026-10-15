"""Diagnostic: actual installer UI with a private parent that withholds Cancel ACK.
No BA/helper, setup, environment editor or unit-test compilation is invoked.
Run on Windows after the managed installer producer has completed:
  python scripts/windows/verify_installer_ui_shutdown.py <dist-name> bounded-close no-ack
  python scripts/windows/verify_installer_ui_shutdown.py <dist-name> bounded-close blocked-write
The dist name is a direct child of the canonical task runs directory.
Use reproduce-hang only to demonstrate the regression on an older product.
"""
import ctypes,hashlib,json,os,pathlib,queue,subprocess,sys,threading,time,uuid
from ctypes import wintypes
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
if os.name != 'nt':
 raise SystemExit('This diagnostic requires native Windows Python and a built installer UI.')
w=pathlib.Path(__file__).resolve().parents[2]
os.environ.setdefault('PATHEXT','.COM;.EXE;.BAT;.CMD')
sys.path.insert(0,str(w/'scripts'));import fullmag_storage as storage
layout=storage.resolve_layout(w,profile='windows-installer-source');root=pathlib.Path(layout['storage_root']);runs=pathlib.Path(layout['runs_root'])
if len(sys.argv) not in (3,4):
 raise SystemExit('Usage: verify_installer_ui_shutdown.py DIST_NAME bounded-close|reproduce-hang [no-ack|blocked-write]')
fault=sys.argv[3] if len(sys.argv)==4 else 'no-ack';assert fault in ['no-ack','blocked-write']
public=runs/sys.argv[1];expect=sys.argv[2];assert expect in ['reproduce-hang','bounded-close']
assert public.name.startswith('windows-installer-source-') and public.parent==runs,'Installer distribution must be a direct child of canonical runs_root'
public=storage.validate_path(public,root,'installer distribution')
receipt=json.loads((public/'fullmag-installer-receipt.json').read_bytes());ui=public/'FullmagInstallerUi/FullmagInstallerUi.exe'
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for v in iter(lambda:f.read(1024*1024),b''):h.update(v)
 return h.hexdigest()
assert sha(public/'fullmag.exe')==receipt['output_sha256'],'Public installer hash mismatch'
assert sha(ui)==receipt['avalonia_ui']['payload_sha256'],'Private UI hash mismatch'
r=storage.validate_path(runs/('ui-cancel-no-ack-probe-'+uuid.uuid4().hex),root);r.mkdir();tmp=r/'temp';tmp.mkdir()
record={'schema':'fullmag.installer-ui.cancel-no-ack-probe.v1','state':'running','classification':'compiled UI diagnostic with synthetic private parent; not Burn installation qualification','expected':expect,'fault':fault,'artifact_sha256':receipt['output_sha256'],'ui_sha256':sha(ui),'source_snapshot':receipt['source']['snapshot_id'],'environment_mutation':False,'helper_started':False,'requests':[]}
def save():storage.atomic_json(r/'probe.json',record)
env=os.environ.copy();env.update(TEMP=str(tmp),TMP=str(tmp),DOTNET_BUNDLE_EXTRACT_BASE_DIR=str(tmp/'net'))
p=subprocess.Popen([str(ui)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
record['pid']=p.pid;save();print(json.dumps({'state':'started','pid':p.pid,'evidence':str(r)}),flush=True)
lines=queue.Queue();stop=threading.Event()
def read():
 for raw in iter(p.stdout.readline,b''):
  try:lines.put(json.loads(raw))
  except ValueError:lines.put({'invalid_frame':True})
  if fault=='blocked-write':break
reader_thread=threading.Thread(target=read,daemon=True);reader_thread.start()
u=ctypes.WinDLL('user32',use_last_error=True);u.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)];u.IsWindowVisible.argtypes=[wintypes.HWND];u.IsWindowVisible.restype=wintypes.BOOL;u.PostMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM];u.PostMessageW.restype=wintypes.BOOL
callback_type=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
u.EnumWindows.argtypes=[callback_type,wintypes.LPARAM]
window=None
try:
 hello=lines.get(timeout=30);assert hello.get('type')=='hello',hello;record['hello']=hello
 init={'schema':'fullmag.windows-installer-ui.v1','version':'1.0.0','type':'init','request_id':'','generation':1,'revision':1,'state':'idle','ok':True,'payload':{'session_id':('synthetic-no-ack-session' if fault=='no-ack' else 'synthetic-'+('x'*100000)),'mode':'initial-build'},'message':'Synthetic parent diagnostic'}
 p.stdin.write((json.dumps(init)+'\n').encode());p.stdin.flush()
 deadline=time.monotonic()+20
 while time.monotonic()<deadline and window is None:
  found=[]
  @callback_type
  def collect(hwnd,param):
   pid=wintypes.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
   if pid.value==p.pid and u.IsWindowVisible(hwnd):found.append(hwnd)
   return True
  u.EnumWindows(collect,0)
  if found:window=found[0]
  else:time.sleep(.1)
 assert window is not None,'Owned UI window missing'
 # The handshake event and initial session binding are posted to Avalonia's UI thread.
 time.sleep(1)
 owner=wintypes.DWORD();u.GetWindowThreadProcessId(window,ctypes.byref(owner));assert p.poll() is None and owner.value==p.pid
 started=time.monotonic();assert u.PostMessageW(window,0x0010,0,0)
 deadline=started+(8 if expect=='reproduce-hang' else 6)
 stable_bytes=0;stable_since=None;write_blocked_observed=False
 if fault=='blocked-write':
  import msvcrt
  k=ctypes.WinDLL('kernel32',use_last_error=True);k.PeekNamedPipe.argtypes=[wintypes.HANDLE,wintypes.LPVOID,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD),ctypes.POINTER(wintypes.DWORD),ctypes.POINTER(wintypes.DWORD)];k.PeekNamedPipe.restype=wintypes.BOOL
 while time.monotonic()<deadline and p.poll() is None:
  if fault=='blocked-write':
   available=wintypes.DWORD();count=wintypes.DWORD();buf=ctypes.create_string_buffer(1024)
   peek=k.PeekNamedPipe(msvcrt.get_osfhandle(p.stdout.fileno()),buf,len(buf),ctypes.byref(count),ctypes.byref(available),None)
   prefix=b'\"operation\":\"cancel\"' in buf.raw[:count.value]
   # The command contains the 100k session id and cannot be complete while
   # less than 100k bytes remain in this unread pipe. Observe the same partial
   # write while the exact child is alive, rather than inferring a stall from
   # leftover bytes after a successful or crashed process exit.
   if peek and prefix and 0<available.value<100000 and p.poll() is None:
    if stable_bytes!=available.value:
     stable_bytes=available.value;stable_since=time.monotonic()
    elif stable_since is not None and time.monotonic()-stable_since>=.2:
     write_blocked_observed=True
     record.update(write_blocked_observed=True,stdout_pending_bytes=available.value,cancel_prefix_seen=True,blocked_observed_while_alive=True)
   else:stable_since=None;stable_bytes=0
  try:frame=lines.get(timeout=.1);record['requests'].append(frame)
  except queue.Empty:pass
 record['elapsed_seconds']=time.monotonic()-started;record['exited_without_ack']=p.poll() is not None
 operations=[x.get('payload',{}).get('operation') for x in record['requests']]
 if fault=='no-ack':assert 'cancel' in operations,('Synthetic session did not reach Cancel path',operations)
 else:
  assert write_blocked_observed,'No live stalled Cancel writer was observed; leftover bytes alone do not prove this fault'
 if expect=='reproduce-hang':assert p.poll() is None,'Prior product did not reproduce the missing-ACK hang'
 else:
  assert p.poll() is not None,'UI did not close within bounded diagnostic deadline'
  assert p.returncode==0,('UI crashed during bounded close',p.returncode)
 record['state']='reproduced' if expect=='reproduce-hang' else 'passed';save()
except BaseException as error:
 record.update(state='failed',error=f'{type(error).__name__}: {error}')
 save()
 raise
finally:
 # This is the exact Popen child retained by this process; no foreign PID/tree is selected.
 failing=sys.exc_info()[0] is not None
 cleanup_error=None
 try:
  if p.poll() is None:
   if fault=='blocked-write':p.terminate();p.wait(timeout=5)
   else:
    try:p.stdin.close();p.wait(timeout=5)
    except subprocess.TimeoutExpired:p.terminate();p.wait(timeout=5)
 except Exception as error:
  cleanup_error=f'{type(error).__name__}: {error}'
  record.update(state='failed',cleanup_error=cleanup_error)
 finally:
  reader_thread.join(timeout=1)
  while not lines.empty():record['requests'].append(lines.get_nowait())
  record['cleanup_exit_code']=p.returncode;record['cleanup_owned_child_exited']=p.poll() is not None;save()
  print(json.dumps({'state':record['state'],'evidence':str(r),'requests':[x.get('payload',{}).get('operation',x.get('type')) for x in record['requests']],'elapsed_seconds':record.get('elapsed_seconds'),'cleanup_exit_code':p.returncode}),flush=True)
 if cleanup_error and not failing:raise RuntimeError('Owned UI cleanup failed: '+cleanup_error)
