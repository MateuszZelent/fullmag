"""Reconcile one completed, pinned output-preflight rejection; never run Solve."""
from pathlib import Path
import json
import subprocess
import uuid

from docker_build_control import canonical, docker_capture
import docker_activation_preflight as preflight
import docker_volume_reconcile as recovery


def controller_digest():
    root = Path(__file__).parent
    names = (Path(__file__).name, 'docker_activation_preflight.py', 'docker_volume_reconcile.py',
             'docker_volume_activate.py', 'docker_volume_activation_reconcile.py',
             'docker_volume_stop_unadmitted.py', 'docker_startup_script.py')
    return recovery.digest(canonical({name: recovery.digest((root / name).read_bytes()) for name in names}))


def _execution_observation(backend_id, wrapper_sha256, inputs, helper_sha256):
    # Store/ledger observations are anomaly guards, not global API quiescence.
    from docker_volume_stop_unadmitted import _probe_script
    script = _probe_script().split('receipt_candidates=[]', 1)[0] + r'''
import hashlib
if hashlib.sha256(read_regular('/opt/fullmag/docker_startup_script.py','image startup helper')).hexdigest()!=sys.argv[2]:
 raise RuntimeError('Image startup helper differs from original controller')
if hashlib.sha256(read_regular(sys.argv[1],'original script',1024*1024)).hexdigest()!=sys.argv[3]:
 raise RuntimeError('Original script source changed')
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit() or int(entry.name)==os.getpid(): continue
 try: args=(entry/'cmdline').read_bytes().split(b'\0')
 except (FileNotFoundError,ProcessLookupError,PermissionError): continue
 for i,arg in enumerate(args[:-1]):
  if arg==b'-c' and hashlib.sha256(args[i+1]).hexdigest()==sys.argv[5]:
   raise RuntimeError('Original activation wrapper is still executing')
health_status,health=api_get('/v2/platform/health')
if health_status!=200 or health.get('status')!='ok': raise RuntimeError('API is not healthy')
status,current=api_get('/v2/sessions/current')
if status!=404 or health.get('active_session') is not False:
 raise RuntimeError('A current session requires separate recovery')
status,queue=api_get('/v2/platform/compute/queue')
if status!=200 or queue.get('items')!=[]: raise RuntimeError('Compute queue is not empty')
store=scan_store(os.environ.get('FULLMAG_RUNS_ROOT','/state/runs/docker-all')+'/session-store')
ledger=scan_ledger(os.environ.get('FULLMAG_HOST_LEDGER_ROOT','/host-ledger/ledger'))
print(json.dumps({'schema':'fullmag.activation-preflight-observation.v1','activation_exec_completed':True,
 'matching_accepted_request':False,'health':health,'current_status':404,'queue':queue,
 'accepted_store':store,'ledger':ledger,'global_api_quiescence_proven':False},sort_keys=True))
'''
    result = docker_capture('exec', backend_id, '/usr/local/bin/python3', '-B', '-c', script,
                            '/opt/fullmag/source/' + inputs['source_relative'], helper_sha256,
                            inputs['source_sha256'], 'unused', wrapper_sha256, timeout=90)
    value = json.loads(result.stdout)
    recovery.require(value.get('schema') == 'fullmag.activation-preflight-observation.v1'
                     and value.get('activation_exec_completed') is True
                     and value.get('matching_accepted_request') is False, 'Incomplete execution observation')
    return value


def reconcile_preflight(args, control, selected, request, request_raw):
    import docker_backend_volume_cache as cache_adapter
    import docker_volume_activate as activation
    import docker_volume_activation_reconcile as retained
    import docker_volume_dev as dev
    recovery.require(request.get('controller_sha256') == controller_digest(), 'Reviewed controller code differs')
    recovery.require(request.get('source_root') == str(selected) and request.get('compose_project') == control.project
                     and request.get('port') == args.port, 'Selected source/project/port differs')
    attempt, development = request.get('attempt', ''), request.get('development_attempt', '')
    recovery.require(isinstance(attempt, str) and recovery.TOKEN.fullmatch(attempt)
                     and isinstance(development, str) and recovery.TOKEN.fullmatch(development), 'Invalid exact attempts')
    root = 'activation/attempts/' + attempt
    journal_root = root + '/reconciliation'
    terminal_raw = recovery.read_raw(control, root + '/terminal.json', optional=True)
    if terminal_raw is not None:
        terminal = json.loads(terminal_raw)
        proof = terminal.get('reconciliation', {})
        recovery.require(proof.get('request_sha256') == args.request_sha256
                         and proof.get('unknown_receipt_sha256') == request['unknown_receipt_sha256'],
                         'Existing terminal belongs to a different reconciliation')
        journal = journal_root + '/' + recovery.digest(terminal_raw)
        recovery.require(recovery.read_raw(control, journal + '/result.json') == terminal_raw
                         and recovery.read_raw(control, root + '/receipt.json') == terminal_raw
                         and recovery.read_raw(control, 'activation/current.json') == terminal_raw,
                         'Terminal publication is incomplete')
        marker = proof.get('marker_relative', '')
        recovery.require(marker.startswith('backend/script-activation-') and marker.endswith('/activation.json'),
                         'Terminal marker path differs')
        recovery.require(recovery.read_raw(control, marker) == recovery.read_raw(control, journal + '/marker.json')
                         and recovery.read_raw(control, 'active', optional=True) is None,
                         'Terminal marker or lease release is unconfirmed')
        print(json.dumps({'state':'failed-confirmed','activation_state':'rejected','attempt':attempt,'replay':True}))
        return
    saved = recovery.read_raw(control, root + '/unknown-receipt.json', optional=True)
    current_raw = recovery.read_raw(control, root + '/receipt.json')
    original_raw = saved if saved is not None else current_raw
    recovery.require(recovery.digest(original_raw) == request['unknown_receipt_sha256'], 'Original receipt CAS differs')
    original = json.loads(original_raw)
    previous_raw = recovery.read_raw(control, 'development/attempts/' + development + '/terminal.json')
    previous = json.loads(previous_raw)
    document = control.read('development/attempts/' + development + '/compose.json')
    recovery.require(previous.get('state') == 'succeeded' and previous.get('attempt') == development
                     and previous.get('backend_container') == request['containers']['backend']['id']
                     and previous.get('frontend_container') == request['containers']['frontend']['id']
                     and previous.get('backend_started_at') == request['containers']['backend']['started_at']
                     and previous.get('config_sha256') == request['config_sha256']
                     and previous.get('inputs', {}).get('source_root') == str(selected)
                     and recovery.digest(canonical(document)) == request['config_sha256']
                     and document.get('name') == control.project, 'Development/configuration authority differs')
    for path in ('development/current.json','development/verified.json'):
        recovery.require(recovery.read_raw(control, path) == previous_raw, 'Development authority was superseded')
    recovery.require(recovery.read_raw(control, 'activation/unresolved.json', optional=True) is None,
                     'Quarantined activation requires dedicated recovery')
    actual = recovery.inspect_pins(request)
    image = request['containers']['backend']['image']
    retained._validate_activation_receipt(control, activation_attempt=attempt, development_attempt=development,
        config_sha256=request['config_sha256'], source_root=str(selected), image_id=image,
        backend_id=request['containers']['backend']['id'], receipt_raw=original_raw)
    helper, helper_id = retained._validate_helper(control, original['helper_container'], attempt)
    recovery.require(helper_id == request['containers']['lease']['id'], 'Original lease identity differs')
    retained._validate_helper_logged(helper_id)
    ids = {name: request['containers'][name]['id'] for name in ('backend','frontend')}
    activation._validate_running_group(control, control.identity, document, previous, image, source_root=str(selected))
    cache_adapter.validate_container(actual['backend'], control.read('development/attempts/' + development + '/backend-cache.json'))
    dev._assert_private_restart_network(actual, ids, control.project)
    inputs = original['inputs']
    marker_relative = inputs['activation_receipt_path'].removeprefix('/opt/fullmag/control/')
    marker_saved = recovery.read_raw(control, root + '/started-marker.json', optional=True)
    marker_raw = marker_saved if marker_saved is not None else recovery.read_raw(control, marker_relative)
    provenance_raw = recovery.read_raw(control, root + '/startup-provenance.json')
    authorization_raw = recovery.read_raw(control, root + '/authorization.json')
    wrapper_sha = recovery.digest(activation.FIXED_ACTIVATION_SCRIPT.encode())
    observation = _execution_observation(ids['backend'], wrapper_sha, inputs, original['helper_sha256'])
    prepared = preflight.prepare_transaction(request, receipt_raw=original_raw, marker_raw=marker_raw,
        provenance_raw=provenance_raw, authorization_raw=authorization_raw, observed_containers=request['containers'],
        matching_accepted_request=observation['matching_accepted_request'],
        activation_exec_completed=observation['activation_exec_completed'])
    result = prepared['result']
    result['reconciliation'] = {'schema':preflight.SCHEMA,'request':args.request,
        'request_sha256':args.request_sha256,'unknown_receipt_sha256':request['unknown_receipt_sha256'],
        'controller_sha256':request['controller_sha256'],'marker_relative':marker_relative,
        'evidence_source':'retained-controller-http-rejection','global_api_quiescence_proven':False}
    result_raw, marker_terminal_raw = canonical(result) + b'\n', canonical(prepared['marker']) + b'\n'
    journal = journal_root + '/' + recovery.digest(result_raw)
    claim_request = {**request,'marker_relative':marker_relative,
                     'prepared_marker_sha256':recovery.digest(marker_terminal_raw)}
    recovery.require(current_raw in (original_raw,result_raw), 'Current activation receipt changed')
    recovery.require(recovery.read_raw(control, marker_relative) in (marker_raw,marker_terminal_raw), 'Started marker changed')
    if getattr(args, 'preview', False):
        print(json.dumps({'state':'prepared','schema':preflight.SCHEMA,'attempt':attempt,
            'request_sha256':args.request_sha256,'original_receipt_sha256':recovery.digest(original_raw),
            'terminal_marker_sha256':recovery.digest(marker_terminal_raw),
            'result_sha256':recovery.digest(result_raw),'activation_retried':False,'lifecycle_changed':False}))
        return
    recovery.write_immutable(control, root + '/unknown-receipt.json', original_raw)
    recovery.write_immutable(control, root + '/started-marker.json', marker_raw)
    recovery.write_immutable(control, journal + '/prepared.json', canonical(prepared) + b'\n')
    recovery.write_immutable(control, journal + '/result.json', result_raw)
    recovery.write_immutable(control, journal + '/marker.json', marker_terminal_raw)
    control.write(journal + '/last-observation.json', observation)
    name = 'fullmag-activation-observer-' + uuid.uuid4().hex
    script = recovery.claim_script(control, root, claim_request, recovery.digest(current_raw),
                                   phase='activation', publish_verified=False)
    claim = subprocess.Popen(control.helper_args(script, name=name), stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        recovery.require(control._line(claim) == 'READY', 'Concurrent observer or changed activation; no takeover')
        observers = json.loads(docker_capture('inspect', name).stdout)
        recovery.require(len(observers) == 1 and observers[0].get('State', {}).get('Running') is True,
                         'Observer incarnation is not live')
        observer = observers[0]
        helper_image = json.loads(docker_capture('image', 'inspect', control.image).stdout)[0]['Id']
        recovery.validate_original_owner(observer, {'helper_container':name}, control, helper_image)
        recovery.write_immutable(control, journal + '/observers/' + observer['Id'] + '.json', canonical({
            'schema':preflight.SCHEMA,'request_sha256':args.request_sha256,'container_name':name,
            'container_id':observer['Id'],'image_id':observer['Image'],
            'started_at':observer['State']['StartedAt'],'fingerprint':recovery.fingerprint(observer),
            'phase':'before-BEGIN','unknown_observation_action':'retain owner and inspect this exact observer; never retry activation',
        }) + b'\n')
        recovery.inspect_pins(request)
        recovery.require(recovery.read_raw(control, root + '/receipt.json') == current_raw
                         and recovery.read_raw(control, marker_relative) in (marker_raw,marker_terminal_raw),
                         'Receipt/marker changed before commit admission')
        claim.stdin.write(b'BEGIN\n'); claim.stdin.flush()
        recovery.require(control._line(claim) == 'OBSERVING', 'Observer handoff unknown; original lease retained')
        claim.stdin.write(('COMMIT ' + recovery.digest(result_raw) + '\n').encode()); claim.stdin.flush(); claim.stdin.close()
        recovery.require(control._line(claim) == 'COMMITTED', 'Commit observation unknown; inspect journal')
        recovery.require(claim.wait(timeout=10) == 0, 'Commit helper failed')
        recovery.require(recovery.read_raw(control, root + '/terminal.json') == result_raw
                         and recovery.read_raw(control, marker_relative) == marker_terminal_raw, 'Terminal publication differs')
        try:
            helper_exit = retained._wait_for_helper_exit(helper_id)
            release = {'state':'exited-confirmed','exit_code':helper_exit,'helper_id':helper_id}
        except recovery.BuildControlError:
            absence = retained._probe_helper_absence(original['helper_container'])
            recovery.require(absence is not None and recovery.read_raw(control, 'active', optional=True) is None,
                             'Original helper exit or absence is unconfirmed')
            release = {'state':'absent-confirmed','exit_code':None,'helper_id':helper_id,
                       'absence_probe_sha256':absence}
        recovery.require(recovery.read_raw(control, 'active', optional=True) is None, 'Lease release unconfirmed')
        control.write(journal + '/helper-release.json', release)
        print(json.dumps({'state':'failed-confirmed','activation_state':'rejected','attempt':attempt,
                          'request_id':inputs['request_id'],'activation_retried':False,'lifecycle_changed':False}))
    finally:
        if claim.stdin and not claim.stdin.closed: claim.stdin.close()
        if claim.poll() is not None and claim.stdout: claim.stdout.close()
