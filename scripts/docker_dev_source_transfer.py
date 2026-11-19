"""Explicitly archive a stopped, quarantined DEV group and transfer its source.

This is a fresh-start boundary, never a Windows session-store migration or a
replay. Named volumes, bind-mounted data and original control records remain.
Container writable layers and complete Docker logs are archived before removal.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

from docker_build_control import BuildControl, BuildControlError, bounded_capture, canonical, docker_capture
from docker_control_namespace import REGISTRY_PATH, REGISTRY_SCHEMA, _raw


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inventory(project, ignored=None):
    ids = docker_capture('ps', '-aq', '--no-trunc', '--filter',
                         'label=com.docker.compose.project=' + project).stdout.decode().split()
    rows = json.loads(docker_capture('inspect', *ids).stdout) if ids else []
    return [row for row in rows if row['Name'].lstrip('/') != ignored]


def stopped(row):
    state = row['State']
    if state.get('Running') or state.get('Pid') != 0 or state.get('Status') != 'exited':
        raise BuildControlError('Source transfer requires exited containers: ' + row['Id'])


COMMIT = r'''
import fcntl,hashlib,json,os,pathlib,stat,sys
P=pathlib.Path; root=P('/control')
payload=json.loads(sys.stdin.buffer.readline(8*1024*1024))
record=payload['record']; old=payload['old_namespace']; locks=[]
def read(p):
    st=p.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>8*1024*1024: raise RuntimeError('unsafe record')
    return p.read_bytes()
for rel in ['operation.lock',old+'/runtime-control/runtime-services/STARTUP-GATE.lock',old+'/runtime-control/runtime-services/LAUNCH.lock',old+'/runtime-control/runtime-services/OWNER.lock']:
    p=root/rel
    if p.is_symlink(): raise RuntimeError('linked lock')
    if p.exists():
        fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise RuntimeError('unsafe lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); locks.append(fd)
def verify():
    for rel,expected in payload['pins'].items():
        if hashlib.sha256(read(root/rel)).hexdigest()!=expected: raise RuntimeError('changed control pin: '+rel)
    for rel in ['active','unresolved.json']:
        if (root/old/rel).exists(): raise RuntimeError('old namespace has active operation')
verify()
print('LOCKED',flush=True)
if sys.stdin.buffer.readline(16)!=b'COMMIT\n': raise RuntimeError('no commit authorization')
verify()
def directory(p):
    p.mkdir(mode=0o750,parents=True,exist_ok=True)
    if p.resolve()!=p: raise RuntimeError('noncanonical destination')
def publish(p,data,replace=False):
    directory(p.parent)
    tmp=p.parent/('.transfer-'+record['recovery_id'])
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
    with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
    if replace: os.replace(tmp,p)
    else: os.link(tmp,p); tmp.unlink()
    fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)
publish(root/record['previous_registry_path'],read(root/'namespaces/current.json'))
target=root/record['namespace']; directory(target)
os.link(root/'operation.lock',target/'operation.lock')
encoded=(json.dumps(record,sort_keys=True,separators=(',',':'))+'\n').encode()
receipt='namespace-recovery/'+record['recovery_id']+'/terminal.json'
publish(root/receipt,encoded); publish(target/'namespace.json',encoded)
# Image attestations are cache hints only. Normal source digest checks remain.
for rel in ['toolchain/verified.json','toolchain/dependency-versions.json','image-dev/verified.json','image-backend/verified.json']:
    p=root/old/rel
    if p.exists(): publish(target/rel,read(p))
registry={'schema':'fullmag.docker-control-namespace-registry.v1','namespace':record['namespace'],'recovery_id':record['recovery_id'],'receipt_path':receipt,'receipt_sha256':hashlib.sha256(encoded).hexdigest(),'compose_project':record['compose_project'],'control_volume':record['control_volume'],'source_worktree_id':record['source_worktree_id'],'source_project_id':record['source_project_id']}
publish(root/'namespaces/current.json',(json.dumps(registry,sort_keys=True,separators=(',',':'))+'\n').encode(),True)
print(json.dumps({'state':record['state'],'namespace':record['namespace'],'receipt_path':receipt}),flush=True)
'''


def transfer(args):
    from docker_dev import _select_source, _compose_identity
    _, layout = _select_source(args.repo_root.resolve(), args.source_root.resolve())
    target = _compose_identity(layout)
    project = target['project_name']
    if project != 'fullmag-master' or not re.fullmatch('[0-9a-f]{32}', args.transfer_id):
        raise BuildControlError('Transfer requires main checkout and explicit 32-hex transfer id')
    rows = inventory(project)
    if len(rows) != 2:
        raise BuildControlError('Expected exactly two stopped application containers')
    services = {r['Config']['Labels'].get('com.docker.compose.service'): r for r in rows}
    if set(services) != {'backend', 'frontend'}:
        raise BuildControlError('Unexpected service in source group')
    backend = services['backend']; labels = backend['Config']['Labels']
    old = {**target, 'project_id': labels['org.fullmag.source.project-id'],
           'worktree_id': labels['org.fullmag.source.worktree-id']}
    if old['project_id'] == target['project_id'] or old['worktree_id'] == target['worktree_id']:
        raise BuildControlError('Source identities are equal; use ordinary managed restart')
    from docker_compose_identity import validate_source_labels
    for row in rows:
        stopped(row); validate_source_labels(row, old)
    control = BuildControl(old, backend['Image'])
    if not control.namespace or control.namespace_registry['retirement']['schema'] != 'fullmag.docker-control-namespace-quarantine.v1':
        raise BuildControlError('This transfer supports only the authenticated retired Windows namespace')
    previous = control.namespace_registry['retirement']
    old['source_root'] = previous['source_root']
    old['registered_name'] = old['worktree_id']
    old_namespace = control.namespace
    for rel in ('active', 'unresolved.json'):
        if _raw(control, rel, optional=True) is not None:
            raise BuildControlError('Old namespace has an unresolved operation: ' + rel)
    current = _raw(control, 'development/current.json')
    if json.loads(current).get('state') != 'failed-confirmed':
        raise BuildControlError('Old namespace has no confirmed terminal development attempt')
    # Authenticate via the old source before opening its root retirement records.
    control.namespace = ''; control.namespace_registry_sha256 = None
    registry_raw = _raw(control, REGISTRY_PATH)
    registry = json.loads(registry_raw)
    previous_raw = _raw(control, registry['receipt_path'])
    prefix = 'source-transfer/' + args.transfer_id
    pins = {REGISTRY_PATH: digest(registry_raw), registry['receipt_path']: digest(previous_raw),
            old_namespace + '/development/current.json': digest(current)}
    pins.update({p: digest(_raw(control, p)) for p in previous['control_pins']})
    engine = docker_capture('info', '--format', '{{.ID}}').stdout.decode().strip()
    if not engine:
        raise BuildControlError('Docker engine identity is missing')
    def same_engine():
        if docker_capture('info', '--format', '{{.ID}}').stdout.decode().strip() != engine:
            raise BuildControlError('Docker engine changed during source transfer')
    network_rows = json.loads(docker_capture('network', 'inspect', target['network_name']).stdout)
    network = network_rows[0]
    if (network.get('Containers') or network.get('Labels', {}).get('com.docker.compose.project') != project):
        raise BuildControlError('Old network has consumers or wrong ownership')
    protected = {m['Name'] for row in rows for m in row['Mounts'] if m['Type'] == 'volume'}
    # No live consumer may write the archived technical volumes.
    all_ids = docker_capture('ps', '-q', '--no-trunc').stdout.decode().split()
    live = json.loads(docker_capture('inspect', *all_ids).stdout) if all_ids else []
    if any(m.get('Name') in protected for row in live for m in row.get('Mounts', [])):
        raise BuildControlError('A live foreign container consumes the old group volumes')
    retained_state = {m['Source'].rstrip('/') for row in rows for m in row['Mounts']
                      if m['Type'] == 'bind' and m['Destination'] == '/state'}
    if any(m.get('Type') == 'bind' and any(
            m['Source'].rstrip('/') == root or m['Source'].startswith(root + '/')
            or root.startswith(m['Source'].rstrip('/') + '/') for root in retained_state)
            for row in live for m in row.get('Mounts', [])):
        raise BuildControlError('A live foreign container consumes the old user state')
    record = {
        'schema': 'fullmag.docker-control-source-transfer.v1', 'state': 'source-transferred-not-replayed',
        'recovery_id': args.transfer_id, 'namespace': 'namespaces/' + args.transfer_id,
        'compose_project': project, 'control_volume': control.volume,
        'source_project_id': target['project_id'], 'source_worktree_id': target['worktree_id'],
        'source_root': target['source_root'], 'previous_source_identity': old,
        'previous_registry_path': prefix + '/previous-registry.json',
        'previous_registry_sha256': digest(registry_raw),
        'previous_receipt_path': registry['receipt_path'], 'previous_receipt_sha256': digest(previous_raw),
        'activation_receipt_path': previous['activation_receipt_path'],
        'control_pins': previous['control_pins'], 'old_request_id': previous['old_request_id'],
        'allow_new_requests': True, 'allow_old_request_replay': False,
        'authorization': 'explicit-user-source-transfer', 'created_at': time.time(),
        'archive_path': prefix, 'retained_volumes': sorted(protected),
        'docker_engine_id': engine,
        'containers': {name: row['Id'] for name, row in services.items()},
    }
    if not args.apply:
        print(json.dumps(record, indent=2)); return
    helper_name = 'fullmag-source-transfer-' + args.transfer_id
    command = control.helper_args('exec python3 -I -B -c ' + shlex.quote(COMMIT), name=helper_name)
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(canonical({'record': record, 'pins': pins, 'old_namespace': old_namespace}) + b'\n')
        process.stdin.flush()
        if control._line(process) != 'LOCKED':
            raise BuildControlError('Transfer helper did not acquire the operation locks')
        same_engine()
        fresh = inventory(project, helper_name)
        if {r['Id'] for r in fresh} != {r['Id'] for r in rows}:
            raise BuildControlError('Group changed at the archive boundary')
        for row in fresh: stopped(row)
        control.write(prefix + '/plan.json', record)
        control.write(prefix + '/containers.json', rows)
        control.write(prefix + '/network.json', network)
        archives = {}
        for service, row in services.items():
            logs = docker_capture('logs', '--timestamps', row['Id'])
            control.write_bytes(prefix + '/' + service + '.stdout.log', logs.stdout)
            control.write_bytes(prefix + '/' + service + '.stderr.log', logs.stderr)
            tag = 'fullmag/master-source-archive:' + args.transfer_id + '-' + service
            image = docker_capture('commit', row['Id'], tag).stdout.decode().strip()
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
                raise BuildControlError('Archive image did not return an immutable identity')
            archives[service] = {'image': image, 'tag': tag, 'container': row['Id']}
        control.write(prefix + '/archives.json', archives)
        fresh = inventory(project, helper_name)
        if {r['Id'] for r in fresh} != {r['Id'] for r in rows}:
            raise BuildControlError('Group changed before retirement')
        for row in fresh: stopped(row)
        # No force and no volume removal. A restarted container refuses removal.
        for row in fresh:
            same_engine()
            docker_capture('rm', row['Id'])
        check = json.loads(docker_capture('network', 'inspect', network['Id']).stdout)[0]
        if check.get('Containers'):
            raise BuildControlError('Old network acquired a new consumer; archive retained')
        same_engine()
        docker_capture('network', 'rm', network['Id'])
        if inventory(project, helper_name):
            raise BuildControlError('Group acquired another container before registry publication')
        same_engine()
        process.stdin.write(b'COMMIT\n'); process.stdin.flush(); process.stdin.close()
        result = control._line(process)
        if process.wait(timeout=60) != 0:
            raise BuildControlError('Transfer publication failed; inspect archive and registry')
        print(result)
    finally:
        if not process.stdin.closed: process.stdin.close()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: pass
        if process.poll() is not None:
            detail = process.stderr.read(8192).decode('utf-8', 'replace')
            if detail: print(detail, file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--transfer-id', required=True)
    parser.add_argument('--apply', action='store_true')
    try:
        transfer(parser.parse_args()); return 0
    except (BuildControlError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('source-transfer: ' + str(error), file=sys.stderr); return 1


if __name__ == '__main__':
    raise SystemExit(main())
