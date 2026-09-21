"""Managed diagnostic of Windows storage as seen by Docker Desktop Linux.

Never enrolls a filesystem for FEM qualification or changes Docker storage.
The small probe and its stopped container are retained for inspection.
"""
import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import uuid

from fullmag_storage import atomic_json, build_lock, initialize, resolve_layout, validate_path
from local_runner.coordinator import CoordinatorError, configured_image, docker, inspect_owned
from local_runner.queue import JobQueue
from fullmag_storage import file_lock
from storage_capabilities import evaluate_capability_report
import getpass
import os
import socket
import subprocess


def host_volume(path):
    """Record the local Windows volume, not merely a Docker filesystem name."""
    if os.name != 'nt' or not re.match(r'^[A-Za-z]:[\\/]', str(path)):
        raise CoordinatorError('Probe requires a local Windows drive path, not UNC')
    volume_path = ctypes.create_unicode_buffer(32768)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetVolumePathNameW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ulong]
    kernel.GetDriveTypeW.argtypes = [ctypes.c_wchar_p]
    kernel.GetVolumeInformationW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
        ctypes.c_wchar_p, ctypes.c_ulong]
    if not kernel.GetVolumePathNameW(str(path), volume_path, len(volume_path)):
        raise ctypes.WinError(ctypes.get_last_error())
    if kernel.GetDriveTypeW(volume_path.value) != 3:
        raise CoordinatorError('Probe storage must be on a fixed local Windows drive')
    serial = ctypes.c_ulong()
    fs_name = ctypes.create_unicode_buffer(256)
    if not kernel.GetVolumeInformationW(volume_path.value, None, 0, ctypes.byref(serial),
                                        None, None, fs_name, len(fs_name)):
        raise ctypes.WinError(ctypes.get_last_error())
    return dict(volume_path=volume_path.value, serial=serial.value, filesystem=fs_name.value)


def command(job_id, image, script, root, evidence, role):
    if role not in ('source', 'artifact', 'build'):
        raise ValueError('Unknown storage role')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image) or not re.fullmatch('[a-f0-9]{32}', job_id):
        raise ValueError('Immutable image and unique job identity required')
    paths = [str(path) for path in (script, root, evidence)]
    if any(',' in path or '\n' in path for path in paths):
        raise ValueError('Unsupported Docker mount path')
    return ['create', '--name', f'fullmag-worker-{job_id}',
        '--label', 'owner=fullmag-local-runner', '--label', f'job={job_id}',
        '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--user', '65532:65532',
        '--cpus', '1', '--memory', str(512 * 1024**2), '--pids-limit', '32',
        '--env', 'PYTHONDONTWRITEBYTECODE=1',
        '--mount', f'type=bind,src={script},dst=/probe-script.py,readonly',
        '--mount', f'type=bind,src={root},dst=/probe',
        '--mount', f'type=bind,src={evidence},dst=/evidence',
        '--entrypoint', 'python3', image, '/probe-script.py', '--root', '/probe',
        '--role', role, '--output', '/evidence/capabilities.json']


def canonical_mounts(mounts):
    if not isinstance(mounts, list):
        raise CoordinatorError('Missing mount inventory')
    return sorted(json.dumps(mount, sort_keys=True) for mount in mounts)


def enable_case_sensitive(root):
    if os.name != 'nt' or not root.is_dir() or root.is_symlink() or any(root.iterdir()):
        raise CoordinatorError('Case sensitivity may only be enabled on this new empty Windows probe directory')
    executable = Path(os.environ['SystemRoot']) / 'System32/fsutil.exe'
    result = subprocess.run([str(executable), 'file', 'setCaseSensitiveInfo', str(root), 'enable'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15)
    if result.returncode or not query_case_sensitive(root):
        raise CoordinatorError(f'Cannot enable case sensitivity for {root}: {result.stdout.strip()} {result.stderr.strip()}')
    return {'requested': True, 'exit_code': result.returncode, 'output': result.stdout.strip()}


def query_case_sensitive(root):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong,
                                  ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.GetFileInformationByHandleEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.CreateFileW(str(root), 0x80, 7, None, 3, 0x02200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        flags = ctypes.c_ulong()
        if not kernel.GetFileInformationByHandleEx(handle, 23, ctypes.byref(flags), ctypes.sizeof(flags)):
            raise ctypes.WinError(ctypes.get_last_error())
        return bool(flags.value & 1)
    finally:
        kernel.CloseHandle(handle)


def run(layout, role, *, owner, call=docker, case_sensitive=False):
    initialize(layout)
    storage = Path(layout['storage_root'])
    if (storage / 'index/local-runner-container.json').exists():
        raise CoordinatorError('Container coordinator owns the queue; legacy host probes are disabled')
    with file_lock(storage / 'locks/local-runner-coordinator.lock', 'storage probe'), build_lock(layout):
        volume = host_volume(storage)
        database = storage / 'index/runner-jobs.sqlite'
        queue = JobQueue(database)
        if queue.active():
            raise CoordinatorError('An active runner lease must finish or be reconciled first')
        if queue.has_queued(owner):
            raise CoordinatorError('Finish or cancel queued jobs before a storage probe')
        info = json.loads(call(['info', '--format', '{{json .}}']))
        if info.get('OperatingSystem') != 'Docker Desktop' or info.get('OSType') != 'linux':
            raise CoordinatorError('Expected local Docker Desktop Linux engine')
        image = configured_image(layout, owner)
        source = Path(__file__).with_name('storage_capabilities.py')
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        job = queue.submit(owner=owner, worktree_id=layout['worktree_id'], source_digest=digest,
            profile='storage-capabilities-v1', operation='storage-probe', request_key=uuid.uuid4().hex,
            payload={'role': role, 'origin_repo': layout['repo_root']})
        job = queue.claim('local-storage-probe', owner=owner, expected_job_id=job['job_id'])
        if job is None or job['operation'] != 'storage-probe':
            raise CoordinatorError('Storage probe could not claim its queue slot')
        job_id = job['job_id']
        run_root = validate_path(Path(layout['runs_root']) / job_id, storage)
        probe_root = validate_path(Path(layout['build_root']) / f'storage-probe-{job_id}', storage)
        run_root.mkdir(parents=True, exist_ok=False)
        probe_root.mkdir(parents=True, exist_ok=False)
        evidence = run_root / 'evidence'
        evidence.mkdir()
        script = run_root / 'storage_capabilities.py'
        shutil.copyfile(source, script)
        if hashlib.sha256(script.read_bytes()).hexdigest() != digest:
            raise CoordinatorError('Probe source changed during capture; explicitly recover uncreated job')
        record = dict(schema='fullmag.local-runner.coordinator.v1', job_id=job_id,
            owner=owner, host=socket.gethostname(), pid=os.getpid(), lease_token=job['lease_token'],
            source_digest=digest, phase='create-requested',
            container_name=f'fullmag-worker-{job_id}',
            worktree_id=layout['worktree_id'], role=role, image_digest=image,
            engine_id=info.get('ID'), probe_sha256=digest, host_root=str(probe_root),
            host_volume=volume,
            evidence_root=str(evidence), state='create-requested', qualification='NOT VERIFIED')
        journal = run_root / 'coordinator.json'
        atomic_json(journal, record)
        if case_sensitive:
            try:
                record['case_sensitivity_adapter'] = enable_case_sensitive(probe_root)
                atomic_json(journal, record)
            except (OSError, CoordinatorError, subprocess.SubprocessError):
                # No Docker mutation has occurred yet.
                queue.finish(job_id, job['lease_token'], 'blocked', None)
                record.update(phase='precreate-failed', state='blocked')
                atomic_json(journal, record)
                raise
        container_id = call(command(job_id, image, script, probe_root, evidence, role)).strip()
        if not re.fullmatch('[a-f0-9]{64}', container_id):
            raise CoordinatorError('No full probe container ID returned; inspect retained create intent')
        record.update(container_id=container_id, state='created')
        atomic_json(journal, record)
        inspected = inspect_owned(call, container_id, job_id)
        if inspected.get('Image') != image:
            raise CoordinatorError('Probe image identity mismatch')
        expected = {'/probe-script.py': (script, False), '/probe': (probe_root, True), '/evidence': (evidence, True)}
        mounts = inspected.get('Mounts', [])
        if len(mounts) != len(expected) or {mount.get('Destination') for mount in mounts} != set(expected):
            raise CoordinatorError('Unexpected probe mounts')
        for mount in mounts:
            destination = mount.get('Destination')
            if destination not in expected:
                raise CoordinatorError('Unexpected probe mount destination')
            path, writable = expected[destination]
            if (mount.get('Type') != 'bind' or mount.get('RW') is not writable
                    or os.path.normcase(os.path.abspath(mount.get('Source', ''))) != os.path.normcase(str(path))):
                raise CoordinatorError('Probe mount differs from approved host path or mode')
        record['phase'] = 'created'
        record['mounts'] = inspected.get('Mounts')
        record['state'] = 'start-requested'
        atomic_json(journal, record)
        try:
            output = call(['start', '--attach', container_id])
        except CoordinatorError as error:
            output = str(error)
        (run_root / 'worker.log').write_text(output, encoding='utf-8')
        final = inspect_owned(call, container_id, job_id)
        if final.get('Image') != image or canonical_mounts(final.get('Mounts')) != canonical_mounts(record['mounts']):
            raise CoordinatorError('Probe image/mount identity changed')
        state = final.get('State', {})
        if state.get('Running') is not False or state.get('Status') != 'exited':
            raise CoordinatorError('Probe not confirmed exited; retained lease requires reconciliation')
        if type(state.get('ExitCode')) is not int:
            raise CoordinatorError('Missing probe exit code')
        if hashlib.sha256(script.read_bytes()).hexdigest() != digest:
            raise CoordinatorError('Probe source changed during execution')
        if host_volume(storage) != volume:
            raise CoordinatorError('Host volume identity changed during probe')
        receipt_path = validate_path(evidence / 'capabilities.json', storage)
        if receipt_path.stat().st_size > 1024**2:
            raise CoordinatorError('Oversized probe receipt')
        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
        if (receipt.get('schema') != 'fullmag.storage-capabilities.v1'
                or receipt.get('role') != role or receipt.get('root') != '/probe'
                or receipt.get('qualification') != 'NOT VERIFIED'
                or receipt.get('state') not in ('passed', 'failed')):
            raise CoordinatorError('Invalid probe receipt')
        if receipt['state'] == 'passed' and not evaluate_capability_report(receipt)['accepted']:
            raise CoordinatorError('Probe PASS is unsupported by its individual checks')
        record.update(state=receipt['state'], exit_code=state.get('ExitCode'),
            receipt_sha256=hashlib.sha256(receipt_path.read_bytes()).hexdigest())
        if (record['state'] == 'passed') != (record['exit_code'] == 0):
            raise CoordinatorError('Probe receipt/exit code mismatch')
        queue.finish(job_id, job['lease_token'], 'succeeded' if record['state'] == 'passed' else 'failed', record['exit_code'])
        record['phase'] = 'terminal'
        atomic_json(journal, record)
        return {key: value for key, value in record.items() if key != 'lease_token'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('source', 'artifact', 'build'), default='build')
    parser.add_argument('--case-sensitive', action='store_true', help='Enable NTFS case sensitivity only on the new empty probe directory')
    args = parser.parse_args()
    layout = resolve_layout(Path(__file__).resolve().parents[1], 'windows-native')
    result = run(layout, args.role, owner=getpass.getuser(), case_sensitive=args.case_sensitive)
    print(json.dumps(result, indent=2))
    return 0 if result['state'] == 'passed' else 2


if __name__ == '__main__':
    sys.exit(main())
