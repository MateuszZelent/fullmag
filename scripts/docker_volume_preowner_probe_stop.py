"""Stop an empty, execution-fenced DEV API after a pre-owner probe failure.

Preserve all data and failure evidence. This operation never claims a native
owner drain, repairs a ledger, promotes a package, or starts computation.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shlex

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, semantic_build_inputs
from docker_diagnostic_source_checks import PROBE as ADMISSION_PROBE, validate_diagnostic_evidence
from docker_volume_reconcile import fingerprint

PHASE = 'preowner-probe-stop'
REASON = ('native Docker host profile initialization failed: native runtime service failed: '
          'parse GPU temperature from nvidia-smi: invalid digit found in string')


def require(value, message):
    if not value:
        raise BuildControlError('Pre-owner probe stop: ' + message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_origin(development, resume, document, scope):
    for record, phase, attempt in ((development, 'development', scope['attempt']),
                                   (resume, 'resume', scope['resume_attempt'])):
        require(record.get('schema') == 'fullmag.docker-build-operation.v1'
                and record.get('phase') == phase and record.get('state') == 'failed-confirmed'
                and record.get('attempt') == attempt
                and record.get('compose_project') == scope['project']
                and record.get('control_volume') == scope['volume']
                and record.get('inputs', {}).get('source_root') == scope['source_root'],
                'failed origin/source identity differs')
    image = development.get('inputs', {}).get('image_id')
    require(isinstance(image, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', image)
            and resume.get('inputs', {}).get('image_id') == image,
            'immutable backend image differs')
    require(resume.get('inputs', {}).get('attempt') == scope['attempt']
            and resume.get('config_sha256') == scope['config_sha256']
            and resume.get('inputs', {}).get('config_sha256') == scope['config_sha256']
            and sha(canonical(document)) == scope['config_sha256']
            and document.get('name') == scope['project'], 'predecessor/Compose digest differs')
    require(resume.get('error') == 'Runtime startup failed; diagnostic API retained: ' + REASON,
            'not the supported pre-owner GPU probe failure')
    require(set(document.get('services', {})) == {'backend', 'frontend'}
            and document['services']['backend'].get('environment', {}).get('FULLMAG_STARTUP_ENABLED') != '1'
            and development['inputs'].get('script') is None
            and resume['inputs'].get('script') is None
            and development.get('startup') is None and resume.get('startup') is None,
            'startup activation or unexpected service is outside scope')
    require(all(isinstance(resume.get(role + '_started_at'), str)
                and resume[role + '_started_at'] for role in ('backend', 'frontend')),
            'both service incarnations are required')


def require_apply_plan(preview, inputs, expected, current):
    require(isinstance(preview, dict) and preview.get('state') == 'succeeded'
            and semantic_build_inputs(preview.get('inputs')) == semantic_build_inputs(inputs)
            and preview.get('result', {}).get('plan_sha256') == expected == current,
            'exact successful preview no longer matches')


PRESERVATION_PROBE = r'''import hashlib,json,os,pathlib,re,stat,sys

def bounded(path):
 p=pathlib.Path(path)
 if any(x.is_symlink() for x in (p,*p.parents)): raise RuntimeError('evidence traverses symlink')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>1048576: raise RuntimeError('unbounded evidence')
  raw=os.read(fd,1048577)
  if len(raw)!=st.st_size or raw!=p.read_bytes(): raise RuntimeError('evidence changed')
  return raw
 finally: os.close(fd)

def preserved(fence):
 if re.fullmatch('/opt/fullmag/runtime-control/runtime-service/api-failure-[0-9a-f]{32}[.]json',str(fence)) is None:
  raise RuntimeError('noncanonical fence')
 control=pathlib.Path('/opt/fullmag/runtime-control')
 for relative in ['runtime-services/OWNER.json','runtime-service/process-tree.json','runtime-service/docker-all.json']:
  if os.path.lexists(control/relative): raise RuntimeError('native owner/process/config exists')
 store=pathlib.Path('/state/runs/docker-all/session-store')
 for directory in [control/'runtime-services',store/'runtime-services']:
  if directory.is_symlink(): raise RuntimeError('runtime history traverses symlink')
  if directory.exists():
   entries=list(directory.iterdir())
   if any(p.name!='OWNER.lock' or bounded(p)!=b'' for p in entries): raise RuntimeError('native history exists')
 runs=store/'runs'
 if runs.is_symlink() or not runs.is_dir() or any(runs.iterdir()): raise RuntimeError('accepted run exists or store unknown')
 raw=bounded(fence); value=json.loads(raw)
 if (value.get('schema')!='fullmag.api-runtime-failure-fence.v1' or value.get('stage')!='runtime_startup'
     or str(value.get('reason','')).strip()!='native Docker host profile initialization failed: native runtime service failed: parse GPU temperature from nvidia-smi: invalid digit found in string'):
  raise RuntimeError('failure fence differs')
 ledger=pathlib.Path('/host-ledger/ledger/HOST_RESOURCE_LEDGER.json'); ledger_sha=None
 if os.path.lexists(ledger):
  ledger_raw=bounded(ledger); value=json.loads(ledger_raw)
  if value.get('schema_version')!='host_resource_ledger.v4' or value.get('reservations')!=[]:
   raise RuntimeError('ledger is not empty')
  ledger_sha=hashlib.sha256(ledger_raw).hexdigest()
 return {'fence_path':str(fence),'fence_sha256':hashlib.sha256(raw).hexdigest(),
         'ledger_sha256':ledger_sha,'native_control_absent':True,'runs_empty':True}
'''

LIVE_PROBE = ADMISSION_PROBE + '\n' + PRESERVATION_PROBE + r'''
if paths.config!=pathlib.Path('/opt/fullmag/runtime-control/runtime-service/docker-all.json'):
 raise RuntimeError('only the canonical empty native control is supported')
def process_pin(pid):
 fields=(pathlib.Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
 return {'pid':pid,'ppid':int(fields[1]),'start_ticks':int(fields[19])}
print(json.dumps({'preserved':preserved(fence_path),'api':process_pin(api[0]),
                  'supervisor':process_pin(supervisor[0])}))
'''


def inspect_container(identifier):
    rows = json.loads(docker_capture('inspect', '--type', 'container', identifier).stdout)
    require(len(rows) == 1 and rows[0].get('Id') == identifier, 'container identity differs')
    return rows[0]


def service_pin(actual):
    return {'id': actual['Id'], 'image': actual['Image'],
            'started_at': actual['State']['StartedAt'], 'fingerprint': fingerprint(actual)}


def assert_consumers(control, operation, ids):
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    helper = control._assert_live_operation_helper(operation)
    require(helper == operation.get('helper_container_id')
            and control._inspect_operation_helper(operation) == helper, 'operation helper differs')
    expected = set(ids.values()) | {helper}
    require(_project_container_ids(control.project) == expected
            and _volume_consumer_ids(control.volume) == expected, 'unexpected group/control consumer')


def collect(control, args, selected, operation):
    from docker_compose_identity import validate_source_labels
    from docker_dev_up import _compose_container_id
    from docker_volume_dev import _validate_retained_service
    from docker_volume_stop_diagnostic import _port_matches
    from docker_volume_stop_unadmitted import _validate_network
    dev_root = 'development/attempts/' + args.attempt
    resume_root = 'resume/attempts/' + args.resume_attempt
    dev_raw, resume_raw = (control.read_bytes(root + '/terminal.json') for root in (dev_root, resume_root))
    development, resume = json.loads(dev_raw), json.loads(resume_raw)
    require(control.read_bytes('development/current.json') == dev_raw
            and control.read_bytes('resume/current.json') == resume_raw, 'origin is no longer current')
    document = control.read(dev_root + '/compose.json')
    scope = {'attempt': args.attempt, 'resume_attempt': args.resume_attempt,
             'source_root': str(selected), 'project': control.project,
             'volume': control.volume, 'config_sha256': args.config_sha256}
    validate_origin(development, resume, document, scope)
    require(development['inputs']['image_id'] == control.image, 'control helper/backend image differs')
    _port_matches(document, args.port)
    ids = {role: _compose_container_id(document, role) for role in ('backend', 'frontend')}
    actual = {role: inspect_container(identifier) for role, identifier in ids.items()}
    for role, row in actual.items():
        validate_source_labels(row, control.identity)
        state = row['State']
        require(row['Image'] == document['services'][role]['image']
                and state.get('Running') is True and state.get('OOMKilled') is False
                and state.get('Restarting') is False
                and state.get('StartedAt') == resume[role + '_started_at'], 'service incarnation differs')
        images = json.loads(docker_capture('image', 'inspect', row['Image']).stdout)
        require(len(images) == 1 and images[0].get('Id') == row['Image'], 'image is ambiguous')
        _validate_retained_service(document, row, role, images[0]['Config'],
                                   expected_started_at=resume[role + '_started_at'])
    mounts = {m.get('Destination'): m for m in actual['backend'].get('Mounts', [])}
    require(all(mounts.get(target, {}).get('Type') == 'volume'
                and mounts[target].get('Name') == control.volume
                for target in ('/build', '/opt/fullmag/control', '/opt/fullmag/runtime-control', '/host-ledger')),
            'private native/build/control mounts differ')
    _validate_network(actual, ids, control.project)
    assert_consumers(control, operation, ids)
    result = docker_capture('exec', ids['backend'], 'python3', '-I', '-B', '-c', LIVE_PROBE, timeout=60)
    lines = result.stdout.decode('utf-8').splitlines()
    require(len(lines) == 2, 'diagnostic observation is incomplete')
    admission, guest = (json.loads(line) for line in lines)
    validate_diagnostic_evidence(admission)
    require(admission['fence_sha256'] == guest['preserved']['fence_sha256'], 'fence changed during observation')
    assert_consumers(control, operation, ids)
    plan = {'schema': 'fullmag.preowner-probe-stop-plan.v1', 'scope': scope,
            'development_sha256': sha(dev_raw), 'resume_sha256': sha(resume_raw),
            'services': {role: service_pin(row) for role, row in actual.items()},
            'admission': admission, 'guest': guest,
            'controller_sha256': sha(Path(__file__).read_bytes()),
            'probe_sha256': sha(LIVE_PROBE.encode()), 'native_drained': False}
    return plan, actual


def verify_preserved(control, backend, expected):
    from docker_build_control import bounded_capture
    from docker_volume_preowner_drained import _python_helper_args
    from docker_volume_linux_supervision_stop import readonly_mount
    code = PRESERVATION_PROBE + '\nprint(json.dumps(preserved(sys.argv[1])))'
    command = 'python3 -I -B -c ' + shlex.quote(code) + ' ' + shlex.quote(expected['fence_path'])
    helper = _python_helper_args(control, command, backend['Image'])
    offset = helper.index('--entrypoint')
    mounts = []
    for target in ('/state', '/host-ledger', '/opt/fullmag/runtime-control'):
        mounts += ['--mount', readonly_mount(backend, target)]
    helper[offset:offset] = mounts
    result = bounded_capture(helper, data=b'', timeout=90, maximum=1024 * 1024)
    require(result.returncode == 0 and json.loads(result.stdout) == expected,
            'preserved empty native control/fence/ledger differs after stop')


def stop(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_host import require_host
    for value, pattern in ((args.attempt, '[0-9a-f]{32}'), (args.resume_attempt, '[0-9a-f]{32}'),
                           (args.config_sha256, '[0-9a-f]{64}'), (args.image_id, 'sha256:[0-9a-f]{64}')):
        require(isinstance(value, str) and re.fullmatch(pattern, value), 'full immutable pins required')
    require(type(args.apply) is bool and args.apply == (args.expected_plan_sha256 is not None),
            'apply requires the exact preview digest')
    if args.apply:
        require(re.fullmatch('[0-9a-f]{64}', args.expected_plan_sha256), 'invalid preview digest')
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    require(not control.namespace, 'namespaced native control is outside this recipe')
    phase = PHASE if args.apply else PHASE + '-preview'
    inputs = {'attempt': args.attempt, 'resume_attempt': args.resume_attempt,
              'source_root': str(selected), 'config_sha256': args.config_sha256,
              'port': args.port, 'image_id': args.image_id,
              'controller_sha256': sha(Path(__file__).read_bytes())}
    journal_path = 'verification/' + PHASE + '-' + args.resume_attempt + '.json'
    require(control.read(journal_path, optional=True) is None,
            'stop intent already exists; observe it without repeating the signal')
    with control.operation(phase, inputs) as operation:
        plan, actual = collect(control, args, selected, operation)
        digest = sha(canonical(plan))
        control.write(operation['root'] + '/plan.json', plan)
        if not args.apply:
            operation['receipt'].update(state='succeeded', result={'plan_sha256': digest})
            print(json.dumps({'state': 'preview-passed', 'plan_sha256': digest}))
            return
        preview = control.read(PHASE + '-preview/verified.json')
        require_apply_plan(preview, inputs, args.expected_plan_sha256, digest)
        require(control.read(PHASE + '-preview/attempts/' + preview['attempt'] + '/terminal.json') == preview,
                'preview terminal differs')
        fresh, _ = collect(control, args, selected, operation)
        require(fresh == plan, 'evidence changed immediately before stop')
        journal = {'schema': 'fullmag.preowner-probe-stop.v1', 'state': 'stop-intent',
                   'plan_sha256': digest, 'plan': plan, 'operation_root': operation['root'],
                   'native_owner_drained': False}
        control.write(journal_path, journal)
        operation['daemon_pending'] = True
        for role in ('backend', 'frontend'):
            original = actual[role]
            docker_capture('stop', '--time', '-1', original['Id'], timeout=60)
            after = inspect_container(original['Id'])
            state = after['State']
            require(service_pin(after) == service_pin(original)
                    and state.get('Running') is False and state.get('Pid') == 0
                    and state.get('ExitCode') in ({0} if role == 'backend' else {0, 143})
                    and state.get('OOMKilled') is False, 'graceful stop is not confirmed')
        verify_preserved(control, actual['backend'], plan['guest']['preserved'])
        journal.update(state='stopped-confirmed', data_preserved=True)
        control.write(journal_path, journal)
        operation['daemon_pending'] = False
        operation['receipt'].update(state='succeeded', result={'state': 'stopped-confirmed',
            'journal_path': journal_path, 'native_owner_drained': False, 'computation_replayed': False})
        print(json.dumps(operation['receipt']['result']))