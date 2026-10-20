"""Private loop-backed ext4 for the Windows accepted closed-loop launcher."""
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil

CONTROL = r'''import codecs,ctypes,json,os,stat,subprocess,sys
# setns changes access to the image's stdlib tree; load codecs first.
codecs.lookup('ascii');codecs.lookup('utf-8')
action,raw=sys.argv[1:]
records=json.loads(raw)
if action not in ('prepare','verify','cleanup') or len(records)!=2 or {r['kind'] for r in records}!={'proof','runs'}:
    raise ValueError('Unsupported private storage operation')
if action=='prepare':
    for record in records:
        image='/proc/1/root'+record['image']
        info=os.lstat(image)
        if not stat.S_ISREG(info.st_mode) or info.st_size!=record['bytes']:
            raise ValueError('Private backing image differs')
        subprocess.run(['mkfs.ext4','-F','-q','-E','lazy_itable_init=1,lazy_journal_init=1',image],check=True,stdout=subprocess.DEVNULL)
fd=os.open('/proc/1/ns/mnt',os.O_RDONLY)
libc=ctypes.CDLL(None,use_errno=True)
if libc.setns(fd,0x20000): raise OSError(ctypes.get_errno(),'setns failed')
os.close(fd)
result=[]
for record in (reversed(records) if action=='cleanup' else records):
    target='/proc/1/root'+record['target']
    if action=='prepare':
        if subprocess.run(['mountpoint','-q',target]).returncode==0 or os.listdir(target):
            raise ValueError('Private mount target is occupied')
        subprocess.run(['mount','-t','ext4','-o','loop,rw,noatime','/proc/1/root'+record['image'],target],check=True)
    fields=subprocess.check_output(['findmnt','-n','-o','FSTYPE,SOURCE','--target',target],encoding='utf-8').strip().split()
    if len(fields)!=2 or fields[0]!='ext4' or not fields[1].startswith('/dev/loop'):
        raise ValueError('Private target is not loop-backed ext4')
    device=fields[1]
    backing=open('/proc/1/root/sys/block/'+device.rsplit('/',1)[1]+'/loop/backing_file',encoding='utf-8').read().strip()
    if backing!=record['image'] or (action!='prepare' and device!=record['device']):
        raise ValueError('Private loop ownership changed')
    if action=='cleanup':
        subprocess.run(['umount',target],check=True)
        if subprocess.run(['mountpoint','-q',target]).returncode==0:
            raise ValueError('Private mount remained')
    else:
        if action=='prepare': os.chown(target,65532,65532)
        info=os.stat(target);space=os.statvfs(target)
        result.append({**record,'device':device,'device_id':[os.major(info.st_dev),os.minor(info.st_dev)],'free_bytes':space.f_bavail*space.f_frsize})
print(json.dumps(result))
'''


def daemon_path(path):
    path = Path(path)
    if path.drive.lower() != 'd:' or '..' in path.parts:
        raise ValueError('Private Windows storage must be on D:')
    return '/run/desktop/mnt/host/d/' + path.as_posix()[3:]


def mount_source(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Missing Docker mount source")
    windows = PureWindowsPath(value)
    if windows.drive.lower() == 'd:':
        if not windows.is_absolute() or '..' in windows.parts:
            raise ValueError("Noncanonical private Docker mount source")
        value = '/run/desktop/mnt/host/d/' + windows.as_posix()[3:]
    return value.rstrip('/').casefold()


def operate(action, records, token, image, docker):
    raw = docker('run', '--pull=never', '--rm', '--name', 'fullmag-b02-storage-' + token,
                 '--label', 'fullmag.accepted-closed-loop.storage-owner=' + token,
                 '--network', 'none', '--read-only', '--pid', 'host', '--privileged',
                 '--user', '0:0', '--cpus', '0.25', '--memory', '128m', '--pids-limit', '64',
                 '--entrypoint', '/usr/bin/python3', image, '-c', CONTROL,
                 action, json.dumps(records, separators=(',', ':')), timeout=60)
    if len(raw.encode('utf-8')) > 64 * 1024:
        raise ValueError('Oversized private storage control receipt')
    return json.loads(raw)


def prepare(output, root, token, image, docker, check_path, save):
    if os.name != 'nt' or not re.fullmatch('[a-f0-9]{32}', token):
        raise ValueError('Windows private storage owner required')
    output, root = check_path(output), check_path(root)
    volumes = check_path(root / 'build-volumes')
    if not output.is_relative_to(root / 'builds') or shutil.disk_usage(root).free < 7 * 1024**3:
        raise ValueError('Private storage scope or available disk differs')
    volumes.mkdir(exist_ok=True)
    records = []
    for kind, size in (('proof', 2 * 1024**3), ('runs', 4 * 1024**3)):
        target = check_path(output / kind)
        if not target.is_dir() or list(target.iterdir()):
            raise ValueError('Private output must be fresh and empty')
        backing = check_path(volumes / ('b02-' + token + '-' + kind + '.ext4'))
        with backing.open('xb') as stream:
            stream.truncate(size)
        records.append({'kind': kind, 'bytes': size, 'image': daemon_path(backing), 'target': daemon_path(target), 'host_target': str(target)})
    intent = {'schema': 'fullmag.accepted-closed-loop.windows-storage.v1',
              'owner': token, 'controller_image': image,
              'controller_sha256': hashlib.sha256(CONTROL.encode()).hexdigest(),
              'state': 'preparing', 'records': records}
    save(output / 'windows-storage.json', intent)
    try:
        prepared = operate('prepare', records, token, image, docker)
        if (not isinstance(prepared, list) or len(prepared) != 2 or
                any({key: item.get(key) for key in record} != record
                    for item, record in zip(prepared, records))):
            raise ValueError('Private storage control did not preserve exact inputs')
        intent.update(state='mounted', records=prepared)
        save(output / 'windows-storage.json', intent)
        verify(prepared, token, image, docker)
        return prepared
    except Exception as error:
        intent.update(state="retained-control-error", error=str(error))
        save(output / "windows-storage.json", intent)
        raise


def verify(records, token, image, docker):
    observed = operate('verify', records, token, image, docker)
    if (not isinstance(observed, list) or len(observed) != len(records) or
            any(any(item.get(key) != expected[key] for key in ('kind', 'bytes', 'image', 'target', 'host_target', 'device', 'device_id'))
                for item, expected in zip(observed, records))):
        raise ValueError('Private ext4 devices changed')
    code = r'''import json,os,uuid
result={}
for kind in ('proof','runs'):
    root='/'+kind
    info=os.stat(root)
    path=root+'/.fullmag-storage-probe-'+uuid.uuid4().hex
    owned=False
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        owned=True
        with os.fdopen(fd,'wb') as stream:
            stream.write(b'fullmag-private-ext4-write-probe');stream.flush();os.fsync(stream.fileno())
        with open(path,'rb') as stream:
            if stream.read()!=b'fullmag-private-ext4-write-probe':raise ValueError('Private storage write differs')
    finally:
        if owned:os.unlink(path)
    result[kind]=[os.major(info.st_dev),os.minor(info.st_dev)]
print(json.dumps(result))
'''
    args = ['run', '--pull=never', '--rm', '--network', 'none', '--read-only', '--user', '65532:65532',
            '--cap-drop', 'ALL', '--cpus', '0.25', '--memory', '64m', '--pids-limit', '64']
    for record in records:
        args += ['--volume', record['host_target'] + ':/' + record['kind'] + ':rw']
    sibling = json.loads(docker(*args, '--entrypoint', '/usr/bin/python3', image, '-c', code))
    if sibling != {record['kind']: record['device_id'] for record in records}:
        raise ValueError('Docker sibling does not see the exact private ext4 devices')


def cleanup(records, output, token, image, docker, save):
    ids = docker('ps', '-aq', '--no-trunc').split()
    if ids:
        for container in json.loads(docker('inspect', *ids)):
            for mount in container.get('Mounts', []):
                source = mount_source(mount.get('Source'))
                for record in records:
                    target = mount_source(record['target'])
                    # Parent binds can expose recursive submounts. Retain storage
                    # unless every container is demonstrably disjoint.
                    if (source == target or source.startswith(target + '/') or
                            target.startswith(source + '/')):
                        raise ValueError('A container may reference private ext4 storage through a related bind')
    operate('cleanup', records, token, image, docker)
    save(output / 'windows-storage-cleanup.json', {'owner': token, 'state': 'unmounted',
         'records': records, 'backing_images': 'retained; no deletion'})


def export_receipt(output, image, docker):
    code = 'import os,stat,sys; p="/proof/run/receipt.json"; s=os.lstat(p); assert stat.S_ISREG(s.st_mode) and s.st_size <= 4*1024*1024; sys.stdout.write(open(p,encoding="utf-8").read())'
    raw = docker('run', '--pull=never', '--rm', '--network', 'none', '--read-only', '--user', '65532:65532',
                 '--cap-drop', 'ALL', '--cpus', '0.25', '--memory', '64m', '--pids-limit', '64',
                 '--volume', str(output / 'proof') + ':/proof:ro', '--entrypoint', '/usr/bin/python3', image, '-c', code)
    return raw
