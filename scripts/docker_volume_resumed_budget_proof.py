"""Authenticate a failed resume without rewriting its development parent.

This module only collects/validates evidence. Signalling and durable intent
publication belong to docker_volume_cold_budget_restore.
"""
from __future__ import annotations

import json

import docker_volume_preowner_drained as base
from docker_build_control import canonical, docker_capture

VARIANT = 'cold-resume-restore-stored-budget'

# Reuse the existing stable, locked ledger reader. CAS objects are read under
# that same shared writer lock, before it is released.
_CAS_READ = r'''
runtime=doc.get('runtime_state',{})
if runtime.get('schema_version')!='host_runtime_state.v1': raise RuntimeError('unknown ledger runtime state')
cas={}
for kind in ('snapshot','readiness'):
 digest=runtime.get(kind+'_sha256')
 if not isinstance(digest,str) or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest): raise RuntimeError('invalid CAS digest')
 path=root/'runtime-state'/'cas'/kind/(digest+'.json')
 if any(p.is_symlink() for p in (path,*path.parents)): raise RuntimeError('CAS traverses symlink')
 data=read(path)
 if hashlib.sha256(data).hexdigest()!=digest: raise RuntimeError('CAS bytes differ')
 cas[kind+'_sha256']=digest; cas[kind+'_raw']=data.decode('utf-8')
'''


def ledger_probe():
    script = base._LEDGER_PROBE.replace("'/ledger/ledger'", "'/host-ledger/ledger'")
    script = script.replace(" print(json.dumps({'schema':'fullmag.preowner-ledger-policy.v1'",
                            '\n'.join(' ' + line if line else '' for line in _CAS_READ.splitlines())
                            + "\n print(json.dumps({'schema':'fullmag.preowner-ledger-policy.v1'")
    return script.replace("'total_budget':budget}", "'total_budget':budget,'policy':policy,'cas':cas}")


LIMITS_PROBE = r'''import json,os,pathlib
def observe():
 mounts=[line.split() for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()]
 roots=[r for r in mounts if '-' in r and r[r.index('-')+1]=='cgroup2' and r[3]=='/']
 if len(roots)!=1 or '\\' in roots[0][4]: raise RuntimeError('no unique complete visible cgroup root')
 root=pathlib.Path(roots[0][4]); membership=pathlib.Path('/proc/self/cgroup').read_text().splitlines()
 if len(membership)!=1 or not membership[0].startswith('0::/'): raise RuntimeError('unknown cgroup hierarchy')
 relative=membership[0][3:]
 if '..' in relative.split('/'): raise RuntimeError('invalid cgroup membership')
 here=root/relative.lstrip('/'); rows=[]; quotas=[]; memories=[]
 while True:
  cpu=(here/'cpu.max').read_text().strip()
  try: memory=(here/'memory.max').read_text().strip()
  except FileNotFoundError:
   if here==root or 'memory' in (here/'cgroup.controllers').read_text().split() or 'memory' in (here.parent/'cgroup.subtree_control').read_text().split(): raise
   memory=None
  fields=cpu.split()
  if len(fields)!=2 or not fields[1].isdigit() or int(fields[1])<=0: raise RuntimeError('invalid cpu.max')
  if fields[0]!='max':
   if not fields[0].isdigit() or int(fields[0])<=0: raise RuntimeError('invalid quota')
   quotas.append(int(fields[0])*1000//int(fields[1]))
  if memory is not None and memory!='max':
   if not memory.isdigit() or int(memory)<=0: raise RuntimeError('invalid memory.max')
   memories.append(int(memory))
  rows.append({'relative':str(here.relative_to(root)), 'cpu.max':cpu, 'memory.max':memory})
  if here==root: break
  here=here.parent
 if not quotas or not memories: raise RuntimeError('unlimited cold budget')
 return {'rows':rows,'limits':{'cpu_millis':min(quotas),'memory_bytes':min(memories),
                            'allowed_cpu_ids':sorted(os.sched_getaffinity(0))}}
a=observe()
if observe()!=a: raise RuntimeError('cgroup limits changed')
print(json.dumps(a,sort_keys=True,separators=(',',':')))
'''


def limits_observation(backend_id, resume):
    result = docker_capture('exec', backend_id, 'python3', '-I', '-B', '-c', LIMITS_PROBE, timeout=15)
    base._require(result.returncode == 0, 'visible cgroup ancestor limits unavailable')
    value = base._json(result.stdout, 'resume cgroup observation', maximum=16384)
    rows = value.get('rows', [])
    outer = resume.get('worker_cgroup', {}).get('outer_limits', {})
    base._require(rows and rows[-1].get('relative') == '.'
                  and all(rows[-1].get(key) == str(outer.get(key, '')).strip() for key in ('cpu.max', 'memory.max')),
                  'visible root cgroup limits differ from failed resume')
    return value


def projected_budget(cold, ledger, document):
    from docker_volume_resumed_budget_projection import validate_projection
    cas = ledger.get('cas', {})
    readiness_raw = cas.get('readiness_raw', '').encode()
    base._require(base._sha(readiness_raw) == cas.get('readiness_sha256'), 'readiness CAS changed')
    readiness = base._json(readiness_raw, 'ledger readiness')
    base._require(readiness.get('inventory_sha256') == ledger['policy']['topology_sha256'],
                  'readiness topology differs from stored policy')
    return validate_projection(cold.get('requested_policy'), ledger['policy'], document,
                               cas.get('snapshot_raw', '').encode(), cas.get('snapshot_sha256'),
                               cold.get('limits_witness', {}).get('limits'))


def validate_startup(control, parent, resume, document, *, source_root, resume_attempt):
    config_sha = base._sha(canonical(document))
    for value, phase in ((parent, 'development'), (resume, 'resume')):
        base._require(value.get('schema') == 'fullmag.docker-build-operation.v1'
                      and value.get('phase') == phase and value.get('state') == 'failed-confirmed'
                      and value.get('compose_project') == control.project
                      and value.get('control_volume') == control.volume
                      and value.get('control_namespace', '') == control.namespace
                      and value.get('inputs', {}).get('source_root') == source_root,
                      'failed resume/development scope differs')
    image = document.get('services', {}).get('backend', {}).get('image')
    base._require(document.get('name') == control.project and isinstance(image, str)
                  and base.IMAGE.fullmatch(image)
                  and all(v['inputs'].get('image_id') == image for v in (parent, resume))
                  and parent.get('ledger_profile') == 'group-ledger-v1'
                  and parent.get('config_sha256', config_sha) == config_sha
                  and resume.get('config_sha256') == resume['inputs'].get('config_sha256') == config_sha
                  and isinstance(parent.get('attempt'), str) and base.ATTEMPT.fullmatch(parent['attempt'])
                  and resume['inputs'].get('attempt') == parent['attempt']
                  and isinstance(resume_attempt, str) and base.ATTEMPT.fullmatch(resume_attempt)
                  and resume.get('attempt') == resume_attempt,
                  'failed resume does not bind the exact parent Compose/image')
    for key in ('backend_container', 'frontend_container'):
        base._require(isinstance(parent.get(key), str) and base.CONTAINER.fullmatch(parent[key])
                      and resume.get(key) == parent[key], 'failed resume changed service identity')
    base._require(isinstance(parent.get('state_root'), str) and parent['state_root']
                  and resume.get('state_root') == parent['state_root']
                  and resume.get('frontend_started_at') == parent.get('frontend_started_at')
                  and isinstance(resume.get('backend_started_at'), str)
                  and resume['backend_started_at'] > parent.get('backend_started_at', '')
                  and resume.get('error', '').startswith('Runtime startup failed; diagnostic API retained: ')
                  and base.REFUSAL in resume['error'], 'resume is not a later cold policy-refused startup')
    group = resume.get('worker_cgroup', {})
    base._require(group.get('schema') == 'fullmag.worker-cgroup-ready.v1'
                  and group.get('state') == 'ready' and group.get('container_id') == parent['backend_container']
                  and group.get('image_id') == image and group.get('compose_project') == control.project,
                  'resume lacks exact current worker-cgroup proof')


def load_startup(control, parent, document, *, source_root, resume_attempt, current=True):
    """Return the independently authenticated startup witness and raw pins."""
    base._require(isinstance(resume_attempt, str) and base.ATTEMPT.fullmatch(resume_attempt),
                  'invalid failed resume attempt')
    hashes = {}
    def read(path):
        raw, value, digest = base._record(control, path, canonical_record=True)
        hashes[path] = digest
        return raw, value
    root = 'development/attempts/' + parent['attempt']
    parent_raw, actual_parent = read(root + '/terminal.json')
    receipt_raw, _ = read(root + '/receipt.json')
    compose_raw, actual_document = read(root + '/compose.json')
    base._require(parent_raw == receipt_raw and actual_parent == parent and actual_document == document,
                  'development parent bytes differ')
    root = 'resume/attempts/' + resume_attempt
    resume_raw, resume = read(root + '/terminal.json')
    receipt_raw, _ = read(root + '/receipt.json')
    # Resume reuses the parent's CAS-pinned Compose; it does not write a
    # second compose.json. Both resume digest fields are checked below.
    base._require(resume_raw == receipt_raw, 'failed resume terminal/receipt bytes differ')
    if current:
        base._require(base._record(control, 'development/current.json', canonical_record=True)[0] == parent_raw
                      and base._record(control, 'resume/current.json', canonical_record=True)[0] == resume_raw,
                      'failed resume is not the exact current operation')
    validate_startup(control, parent, resume, document, source_root=source_root, resume_attempt=resume_attempt)
    return resume, hashes, parent_raw, compose_raw


def validate_bridge(control, parent, terminal, compose, recreate, retained, *, iteration, recreate_attempt):
    """Authenticate either a stop-only idle drain or a failed rebuild before recreate."""
    if terminal.get('state') == 'succeeded':
        config_sha = base._sha(canonical(compose))
        base._require(terminal.get('schema') == recreate.get('schema') == 'fullmag.docker-build-operation.v1'
                      and terminal.get('phase') == 'iteration'
                      and terminal.get('attempt') == iteration
                      and terminal.get('idle_backend_stopped') is True
                      and terminal.get('error') in (None, '')
                      and terminal.get('inputs', {}).get('config_sha256') == config_sha
                      and terminal.get('config_sha256') == config_sha
                      and compose.get('name') == control.project
                      and terminal.get('inputs', {}).get('source_root') == parent['inputs']['source_root']
                      and compose['services']['backend'].get('image') == terminal['inputs'].get('image_id')
                      and recreate.get('phase') == 'recreate-services' and recreate.get('state') == 'succeeded'
                      and recreate.get('attempt') == recreate_attempt and recreate.get('fresh_state') is False,
                      'successful idle drain terminal differs')
        successful_idle_drain = True
    else:
        # Preserve the previous failed-build bridge predicate as-is. A
        # successful idle stop cannot qualify through the failure branch.
        base._require(terminal.get('schema') == recreate.get('schema') == 'fullmag.docker-build-operation.v1'
                      and terminal.get('phase') == 'iteration' and terminal.get('state') == 'failed-confirmed'
                      and terminal.get('attempt') == iteration
                      and terminal.get('error', '').startswith('Backend exited during build;')
                      and terminal.get('inputs', {}).get('config_sha256') == base._sha(canonical(compose))
                      and terminal.get('config_sha256', base._sha(canonical(compose))) == base._sha(canonical(compose))
                      and compose.get('name') == control.project
                      and terminal.get('inputs', {}).get('source_root') == parent['inputs']['source_root']
                      and compose['services']['backend'].get('image') == terminal['inputs'].get('image_id')
                      and recreate.get('phase') == 'recreate-services' and recreate.get('state') == 'succeeded'
                      and recreate.get('attempt') == recreate_attempt and recreate.get('fresh_state') is False,
                      'history is not a failed rebuild after drain and a completed retained recreate')
        successful_idle_drain = False
    for record in (terminal, recreate):
        base._require(record.get('compose_project') == control.project
                      and record.get('control_volume') == control.volume
                      and record.get('control_namespace', '') == control.namespace,
                      'historical operation scope differs')
    base._require(terminal.get('state_root') == recreate.get('previous_state_root') == parent.get('state_root')
                  and all(recreate.get('inputs', {}).get(key) == terminal['inputs'].get(key)
                          for key in ('attempt', 'config_sha256'))
                  and isinstance(terminal.get('finished_at'), (int, float))
                  and terminal['finished_at'] < recreate.get('started_at', 0)
                  and recreate.get('finished_at', float('inf')) < parent.get('started_at', 0),
                  'historical drain/recreate continuity differs')
    base._require(isinstance(retained, dict) and set(retained) == {'backend', 'frontend'},
                  'historical retained pair is incomplete')
    ids = []
    for name, row in retained.items():
        identifier = row.get('Id')
        base._require(isinstance(identifier, str) and base.CONTAINER.fullmatch(identifier)
                      and identifier == terminal.get(name + '_container')
                      and identifier != parent.get(name + '_container'), 'historical service ID differs')
        ids.append(identifier)
    backend = retained['backend']
    if successful_idle_drain:
        base._require(backend.get('Image') == terminal['inputs']['image_id']
                      and backend.get('State', {}).get('StartedAt') == terminal.get('backend_started_at')
                      and backend['State'].get('Running') is False and backend['State'].get('Status') == 'exited'
                      and backend['State'].get('Pid') == 0 and backend['State'].get('OOMKilled') is False
                      and backend['State'].get('ExitCode') == 0
                      and set(recreate.get('removed_containers', [])) == set(ids)
                      and len(recreate['removed_containers']) == 2,
                      'successful idle-stop service is not confirmed stopped: backend')
    else:
        base._require(backend.get('Image') == terminal['inputs']['image_id']
                      and backend.get('State', {}).get('StartedAt') == terminal.get('backend_started_at')
                      and backend['State'].get('Running') is False and backend['State'].get('Status') == 'exited'
                      and backend['State'].get('Pid') == 0 and backend['State'].get('OOMKilled') is False
                      and backend['State'].get('ExitCode') == 2
                      and set(recreate.get('removed_containers', [])) == set(ids)
                      and len(recreate['removed_containers']) == 2,
                      'completed recreate did not remove the exact failed-build pair')
    return ids


def validate_idle_stop_snapshot(terminal, retained, snapshot):
    base._require(isinstance(snapshot, dict) and set(snapshot) == {'backend', 'frontend'},
                  'successful idle-stop service snapshot is incomplete')
    for name in ('backend', 'frontend'):
        stopped = snapshot[name]
        retained_service = retained[name]
        base._require(isinstance(stopped, dict) and isinstance(retained_service, dict),
                      'successful idle-stop snapshot service differs: ' + name)
        state = stopped.get('State', {})
        retained_state = retained_service.get('State', {})
        base._require(isinstance(state, dict) and isinstance(retained_state, dict),
                      'successful idle-stop snapshot service differs: ' + name)
        started_at = terminal.get(name + '_started_at')
        base._require(stopped.get('Id') == retained_service.get('Id') == terminal.get(name + '_container')
                      and isinstance(stopped.get('Image'), str) and bool(stopped.get('Image'))
                      and stopped.get('Image') == retained_service.get('Image')
                      and isinstance(started_at, str) and bool(started_at)
                      and state.get('StartedAt') == retained_state.get('StartedAt') == started_at
                      and all(row.get('Running') is False and row.get('Status') == 'exited'
                              and type(row.get('Pid')) is int and row.get('Pid') == 0
                              and type(row.get('ExitCode')) is int and row.get('ExitCode') == 0
                              and row.get('OOMKilled') is False for row in (state, retained_state)),
                      'successful idle-stop snapshot service differs: ' + name)


def load_bridge(control, parent, terminal, compose, *, iteration, recreate_attempt, record):
    base._require(isinstance(iteration, str) and base.ATTEMPT.fullmatch(iteration),
                  'invalid historical idle-stop attempt')
    base._require(isinstance(recreate_attempt, str) and base.ATTEMPT.fullmatch(recreate_attempt),
                  'invalid historical recreate attempt')
    idle_snapshot = None
    if terminal.get('state') == 'succeeded':
        idle_path = 'iteration/attempts/' + iteration + '/idle-stop-containers.json'
        idle_raw, idle_snapshot = record(idle_path)
        snapshot_sha = terminal.get('idle_stop_containers_sha256')
        base._require(isinstance(snapshot_sha, str) and base.SHA.fullmatch(snapshot_sha)
                      and base._sha(idle_raw) == snapshot_sha,
                      'successful idle-stop snapshot digest differs')
    root = 'recreate-services/attempts/' + recreate_attempt
    raw, recreate = record(root + '/terminal.json')
    receipt_raw, _ = record(root + '/receipt.json')
    _, retained = record(root + '/retained-containers.json')
    base._require(raw == receipt_raw, 'historical recreate is not terminal')
    ids = validate_bridge(control, parent, terminal, compose, recreate, retained,
                          iteration=iteration, recreate_attempt=recreate_attempt)
    if terminal.get('state') == 'succeeded':
        validate_idle_stop_snapshot(terminal, retained, idle_snapshot)
    # Enumeration must succeed: an inspect error is not proof of absence.
    result = docker_capture('ps', '-a', '--no-trunc', '--format', '{{.ID}}', timeout=15)
    base._require(result.returncode == 0 and not set(ids).intersection(result.stdout.decode().split()),
                  'historical removed pair is still present or inventory unavailable')
    return recreate_attempt


def authenticate_archived_history(control, parent, observed):
    """Recheck immutable history after later startups replace mutable OWNER.

The live collector additionally authenticates the current OWNER/process-tree
before and after stop. Future budget consumers must use the immutable drain
copy, not demand that a later legitimate owner still be the old Drained one.
"""
    history = observed['history']
    def record(path):
        expected = history['control_hashes'].get(path)
        base._require(isinstance(expected, str) and base.SHA.fullmatch(expected), 'missing archived history pin')
        raw, value, _ = base._record(control, path, expected=expected, canonical_record=True)
        return raw, value
    root = 'iteration/attempts/' + history['iteration']
    raw, terminal = record(root + '/terminal.json')
    receipt_raw, _ = record(root + '/receipt.json')
    _, compose = record(root + '/compose.json')
    _, drain = record(root + '/backend-drain.json')
    process = drain.get('process_receipt', {})
    base._require(raw == receipt_raw and drain.get('schema') == 'fullmag.docker-idle-restart-drain.v1'
                  and drain.get('backend_container_id') == terminal.get('backend_container')
                  and process.get('schema') == 'fullmag.docker-process-tree.v1'
                  and process.get('state') == 'drained'
                  and drain.get('process_receipt_sha256') == base._sha(canonical(process) + b'\n')
                  == observed['cold_api']['process_tree_sha256'], 'archived completed drain differs')
    load_bridge(control, parent, terminal, compose, iteration=history['iteration'],
                recreate_attempt=history['recreate_attempt'], record=record)
