"""Managed stop of a pre-owner startup failure after an idle iteration.

Preserve the already drained owner and all data. Only the exact diagnostic
backend may be stopped, under the existing Compose BuildControl lease.
"""
from __future__ import annotations

import json
import base64
import shlex
import time
import re
from pathlib import Path

from docker_build_control import BuildControl, BuildControlError, canonical, compose_capture, docker_capture, toolchain_configuration
from docker_dev_host import require_host
from docker_volume_stop_bootstrap import _read_raw, _json, _sha256, _runtime_relative, _assert_group_consumers


def _require(condition, message):
    if not condition:
        raise BuildControlError(message)


def validate_receipts(args, control, selected, parent, iteration, document, failure):
    for value in (args.attempt, args.iteration_attempt):
        _require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value), "Exact attempt identity required")
    _require(isinstance(args.config_sha256, str) and re.fullmatch(r"[0-9a-f]{64}", args.config_sha256), "Exact Compose digest required")
    _require(type(args.port) is int and 1 <= args.port <= 65535, "Invalid frontend port")
    for receipt, phase, attempt, state in (
        (parent, "development", args.attempt, "succeeded"),
        (iteration, "iteration", args.iteration_attempt, "failed-confirmed"),
    ):
        _require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
                 and receipt.get("phase") == phase and receipt.get("attempt") == attempt
                 and receipt.get("state") == state
                 and receipt.get("compose_project") == control.project
                 and receipt.get("control_volume") == control.volume
                 and receipt.get("control_namespace") == (control.namespace or None), "Operation identity or terminal state differs")
        inputs = receipt.get("inputs", {})
        _require(inputs.get("source_root") == str(selected), "Operation belongs to another checkout")
    inputs = iteration.get("inputs", {})
    _require(inputs.get("attempt") == args.attempt
             and inputs.get("config_sha256") == args.config_sha256
             and iteration.get("config_sha256") == args.config_sha256
             and inputs.get("image_id") == parent.get("inputs", {}).get("image_id")
             and iteration.get("state_root") == parent.get("state_root"), "Iteration does not bind the exact development attempt")
    _require(document.get("name") == control.project and _sha256(canonical(document)) == args.config_sha256, "Compose CAS differs")
    cgroup = iteration.get("worker_cgroup", {})
    _require(cgroup.get("schema") == "fullmag.worker-cgroup-ready.v1" and cgroup.get("state") == "ready"
             and cgroup.get("container_id") == parent.get("backend_container")
             and cgroup.get("image_id") == inputs.get("image_id")
             and cgroup.get("compose_project") == control.project, "Iteration container binding differs")
    _require(isinstance(iteration.get("backend_started_at"), str) and bool(iteration["backend_started_at"]), "Iteration has no start identity")
    fence = failure.get("fence", {})
    _runtime_relative(failure.get("path"))
    _require(fence.get("schema") == "fullmag.api-runtime-failure-fence.v1"
             and fence.get("stage") == "runtime_startup"
             and isinstance(fence.get("reason"), str) and bool(fence["reason"].strip())
             and iteration.get("error") == "Runtime startup failed; services retained: " + fence["reason"], "Iteration does not bind the startup failure")


PROBE = r'''import sys,json,pathlib,os,hashlib
sys.path.insert(0,'/opt/fullmag')
import runtime_service
failure=json.loads(sys.argv[1])
root=pathlib.Path('/opt/fullmag/runtime-control')
def read(p): return runtime_service._bounded_regular(p,'startup recovery evidence')
fence_raw=read(pathlib.Path(failure['path']))
if json.loads(fence_raw)!=failure['fence']: raise RuntimeError('startup fence changed')
owner_raw=read(root/'runtime-services/OWNER.json')
process_raw=read(root/'runtime-service/process-tree.json')
owner=json.loads(owner_raw); process=json.loads(process_raw)
if owner.get('schema_version')!='runtime_service_owner.v1' or owner.get('target_id')!='docker-all' or owner.get('state')!='drained' or process.get('schema')!='fullmag.docker-process-tree.v1' or process.get('state')!='drained' or process.get('terminal_service_owner')!=owner:
 raise RuntimeError('prior owner was not conclusively drained')
if any(c.get('status')!='exited_success' for c in owner.get('children',[])):
 raise RuntimeError('prior worker did not exit successfully')
rows=[]
for p in pathlib.Path('/proc').iterdir():
 if p.name.isdigit():
  try:
   argv=(p/'cmdline').read_bytes().split(b'\0'); comm=(p/'comm').read_text().strip()
   ppid=int(next(x.split()[1] for x in (p/'status').read_text().splitlines() if x.startswith('PPid:')))
   rows.append(dict(pid=int(p.name),ppid=ppid,argv=argv,comm=comm,exe=os.readlink(p/'exe')))
  except FileNotFoundError: raise RuntimeError('process set changed during observation')
self_pid=os.getpid()
init=[r for r in rows if r['pid']==1 and r['comm'] in ('docker-init','tini')]
supervisors=[r for r in rows if b'/opt/fullmag/entrypoint.py' in r['argv'] and r['ppid']==1]
apis=[r for r in rows if r['exe']=='/opt/fullmag/package/bin/fullmag-api']
if len(init)!=1 or len(supervisors)!=1 or len(apis)!=1 or len(rows)!=4:
 raise RuntimeError('unexpected process or active worker in diagnostic backend')
api=apis[0]; supervisor=supervisors[0]
if api['ppid']!=supervisor['pid'] or {r['pid'] for r in rows}!={1,supervisor['pid'],api['pid'],self_pid}:
 raise RuntimeError('diagnostic process tree differs')
env=(pathlib.Path('/proc')/str(api['pid'])/'environ').read_bytes().split(b'\0')
if ('FULLMAG_API_RUNTIME_FAILURE_FENCE='+failure['path']).encode() not in env:
 raise RuntimeError('API is not bound to the exact startup fence')
print(json.dumps(dict(owner_sha256=hashlib.sha256(owner_raw).hexdigest(),process_sha256=hashlib.sha256(process_raw).hexdigest(),fence_sha256=hashlib.sha256(fence_raw).hexdigest(),api_pid=api['pid'],supervisor_pid=supervisor['pid'])))
'''


def operation_success(receipt):
    _require(receipt.get('state') == 'stopped-confirmed', 'Stop has no confirmed outcome')
    return dict(receipt, state='succeeded', stop_state='stopped-confirmed')


def reconcile_completed_stop(args, control, selected, identity, paths):
    from docker_volume_stop_diagnostic import _container_snapshot, _port_matches
    token = args.reconcile_stop_attempt
    _require(isinstance(token, str) and re.fullmatch(r'[0-9a-f]{32}', token), 'Exact stop attempt required')
    root = 'stop-bootstrap/attempts/' + token
    active_raw = _read_raw(control, 'active')
    _require(active_raw == (token+'\n').encode(), 'Stop attempt does not hold the active lease')
    original_raw = _read_raw(control, root+'/receipt.json')
    original = _json(original_raw, 'stop receipt')
    inputs = original.get('inputs', {})
    _require(original.get('phase') == 'stop-bootstrap' and original.get('attempt') == token
             and original.get('compose_project') == control.project and original.get('control_volume') == control.volume
             and inputs == dict(attempt=args.attempt, iteration_attempt=args.iteration_attempt,
                                config_sha256=args.config_sha256, source_root=str(selected),port=args.port),
             'Stop receipt belongs to another operation')
    completed_raw = _read_raw(control, root+'/iteration-startup-stop.json')
    completed = _json(completed_raw, 'confirmed stop')
    proof = completed.get('proof')
    _require(isinstance(proof, dict) and completed.get('state') == 'stopped-confirmed', 'Stop did not finish')
    _require(_json(_read_raw(control, root+'/iteration-startup-preflight.json'), 'preflight') == proof, 'Stop proof differs from preflight')
    def verify():
        raws = [_read_raw(control,p) for p in paths]
        parent, iteration, document, failure = [_json(raw,p) for raw,p in zip(raws,paths)]
        validate_receipts(args,control,selected,parent,iteration,document,failure)
        _port_matches(document,args.port)
        _require([_sha256(raw) for raw in raws] == proof['receipts'], 'Original receipt pins changed')
        effective = dict(parent,backend_started_at=iteration['backend_started_at'])
        image, ids, actual = _container_snapshot(args,selected,identity,control,effective,document,allow_stopped_backend=True)
        _require(not actual['backend']['State']['Running'] and ids==proof['ids'] and image==proof['image']
                 and {s:actual[s]['State']['StartedAt'] for s in ids}==proof['starts'], 'Service incarnation changed')
        _require(_sha256(_read_raw(control,'runtime-control/runtime-services/OWNER.json')) == proof['probe']['owner_sha256'], 'Drained owner changed')
        helper = _assert_group_consumers(control, {'receipt':original}, ids)
        rows = json.loads(docker_capture('inspect',helper).stdout)
        _require(rows[0]['Config']['Cmd'][-1] == control.operation_script('stop-bootstrap',token), 'Original lease protocol differs')
        return helper
    helper = verify()
    result = operation_success(completed)
    terminal = dict(original, **result, finished_at=time.time(), reconciliation='confirmed-stop-finalization')
    if not args.apply:
        return dict(state='validated-reconciliation-preview', attempt=token)
    _require(verify()==helper, 'Original stop helper changed')
    # Only the original live helper publishes a terminal; its protocol releases
    # active itself. Never edit or remove the active marker from the host.
    directory = shlex.quote(control.path(root))
    checks = ''
    for relative, digest in [('active',_sha256(active_raw)),(root+'/receipt.json',_sha256(original_raw)),
                             (root+'/iteration-startup-stop.json',_sha256(completed_raw))]:
        path = shlex.quote(control.path(relative))
        checks += f"test ! -L {path}; test -f {path}; test $(stat -c %h {path}) = 1; test \"$(sha256sum {path} | cut -d' ' -f1)\" = '{digest}'; "
    target = shlex.quote(control.path(root+'/terminal.json'))
    encoded = shlex.quote(base64.b64encode(canonical(terminal)+b'\n').decode())
    script = ("set -euo pipefail; umask 027; " + checks + f"test ! -e {target}; test ! -L {target}; "
              + f"tmp=$(mktemp {directory}/.finalize.XXXXXXXX); trap 'rm -f -- \"$tmp\"' EXIT; "
              + f"printf %s {encoded} | base64 -d > \"$tmp\"; sync \"$tmp\"; ln -T -- \"$tmp\" {target}; rm -f -- \"$tmp\"; sync {directory}; printf 'FINALIZED\\n'")
    published = docker_capture('exec','--user','65532:65532',helper,'/bin/bash','-c',control._namespace_guard(script),timeout=30)
    _require(published.stdout.strip()==b'FINALIZED','Stop finalization acknowledgement missing')
    return dict(state='reconciled-confirmed',attempt=token,backend='stopped',terminal=terminal)


def stop_iteration(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_stop_diagnostic import _container_snapshot, _port_matches
    from docker_volume_dev import _operator_probe_record_from_retained
    require_host()
    # Validate path components before using them to read the control volume.
    for value in (args.attempt, args.iteration_attempt):
        _require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value), "Exact attempt identity required")
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    control.prepare()
    paths = [f'development/attempts/{args.attempt}/terminal.json', f'iteration/attempts/{args.iteration_attempt}/terminal.json',
             f'development/attempts/{args.attempt}/compose.json', f'iteration/attempts/{args.iteration_attempt}/startup-failure.json']
    if getattr(args, 'reconcile_stop_attempt', None):
        return reconcile_completed_stop(args, control, selected, identity, paths)
    def observe():
        raws = [_read_raw(control, p) for p in paths]
        parent, iteration, document, failure = [_json(raw, p) for raw, p in zip(raws, paths)]
        validate_receipts(args, control, selected, parent, iteration, document, failure)
        _port_matches(document, args.port)
        _operator_probe_record_from_retained(parent, document)
        effective = dict(parent, backend_started_at=iteration['backend_started_at'])
        image, ids, actual = _container_snapshot(args, selected, identity, control, effective, document)
        result = docker_capture('exec', ids['backend'], '/usr/local/bin/python3', '-B', '-c', PROBE, json.dumps(failure), timeout=30)
        _require(result.returncode == 0, 'Diagnostic-only process proof failed: '+result.stderr.decode('utf-8','replace')[-2048:])
        probe = json.loads(result.stdout)
        signature = dict(receipts=[_sha256(raw) for raw in raws], probe=probe, ids=ids, image=image,
                         starts={s: actual[s]['State']['StartedAt'] for s in ids})
        return signature, document, effective
    initial, _, _ = observe()
    if not args.apply:
        return dict(state='validated-preview', proof=initial, next_action='Repeat with --apply; all evidence will be revalidated under the control lease')
    with control.operation('stop-bootstrap', {'attempt':args.attempt,'iteration_attempt':args.iteration_attempt,
            'config_sha256':args.config_sha256,'source_root':str(selected),'port':args.port}) as operation:
        current, document, effective = observe()
        _require(current == initial, 'Startup recovery pins changed under lease')
        helper = _assert_group_consumers(control, operation, current['ids'])
        control.write(operation['root']+'/iteration-startup-preflight.json', current)
        final, _, _ = observe()
        _require(final == initial and _assert_group_consumers(control, operation, final['ids']) == helper, 'Startup recovery pins changed before stop')
        control._assert_live_operation_helper(operation)
        operation['daemon_pending'] = True
        compose_capture(document, 'stop', '--timeout', '60', 'backend', timeout=90)
        image, ids, actual = _container_snapshot(args, selected, identity, control, effective, document, allow_stopped_backend=True)
        _require(not actual['backend']['State']['Running'] and actual['frontend']['State']['StartedAt']==initial['starts']['frontend'], 'Exact backend stop not confirmed or frontend restarted')
        _require([_sha256(_read_raw(control,p)) for p in paths] == initial['receipts'], 'Original operation receipts changed')
        _require(_sha256(_read_raw(control,'runtime-control/runtime-services/OWNER.json')) == initial['probe']['owner_sha256'], 'Historical owner changed during stop')
        _assert_group_consumers(control, operation, ids)
        operation['daemon_pending'] = False
        receipt = dict(state='stopped-confirmed', backend_container=ids['backend'], frontend_container=ids['frontend'],
                       backend_started_at=initial['starts']['backend'], preserved='owner, results, runtime volumes and original receipts', proof=initial)
        control.write(operation['root']+'/iteration-startup-stop.json', receipt)
        operation['receipt'].update(operation_success(receipt))
        return receipt
