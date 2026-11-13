"""Retained inputs for one live migrated DEV restart, never a replay recipe.

The caller keeps the original copied host scope and OLD fences. This module
authenticates retained records and produces arguments for the ordinary DEV
launcher; it does not remove services, start a runtime, or commit registration.
"""
from __future__ import annotations

from argparse import Namespace
from copy import deepcopy
import hashlib
import os
from pathlib import Path
import re
import threading

from docker_build_control import canonical
from docker_dev_data_volume import _decode, _runtime_pins
from docker_volume_accepted_reattach import _control_bytes
from docker_data_volume_relocated import require_relocated
import docker_data_volume_startup_scope as startup_scope
import docker_volume_dev as volume
import docker_volume_terminal_observation as observation
import docker_volume_cold_budget_restore as cold
import fullmag_storage as storage
import linux_native_host as host


COMPONENTS = (
    'docker_data_volume_restart_context.py', 'docker_dev_data_volume_restart.py',
    'docker_data_volume_startup_scope.py', 'docker_data_volume_copy_guard.py',
    'docker_data_volume_stopped_group.py', 'docker_data_volume_removed_group.py',
    'docker_volume_terminal_observation.py', 'docker_volume_dev.py', 'docker_dev.py',
    'docker_volume_cold_budget_restore.py', 'docker_volume_resources.py',
    'docker_build_control.py', 'linux_native_host.py',
)
UNSUPPORTED = (
    'helper_source', 'accepted_reattach', 'container_recovery', 'native_failed_restart',
    'post_build_generation', 'post_build_start', 'startup_diagnostic_restart',
    'unclaimed_cancellation', 'isolated_snapshot',
)
RECOVERY_ENV_PREFIXES = ('FULLMAG_CONTAINER_RECOVERY_', 'FULLMAG_ACCEPTED_REATTACH_',
    'FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_', 'FULLMAG_DOCKER_POST_BUILD_CONTINUATION',
    'FULLMAG_ISOLATED_SNAPSHOT_START')


def require(value, message):
    if not value:
        raise ValueError(message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _read(control, relative, *, optional=False):
    return _control_bytes(control, relative, optional=optional, maximum=8*1024**2)


def _source_pins(source):
    pins = {}
    for name in COMPONENTS:
        path = source/'scripts'/name
        require(path.is_file() and not path.is_symlink(), 'Restart helper source is missing or linked: '+name)
        pins[name] = _sha(path.read_bytes())
    return pins


def _prepared_scope(prepared):
    issuer = startup_scope._require_prepared(prepared)
    scope = startup_scope.current_scope()
    require(scope is not None and scope._prepared is prepared,
            'Restart inputs require the original active prepared startup scope')
    context = prepared['context']
    require(context['source'] == Path(__file__).resolve().parents[1],
            'Restart helper does not belong to the selected checkout')
    return issuer, scope


def _held(control, prepared, snapshot, fence):
    _issuer, scope = _prepared_scope(prepared)
    context = prepared['context']; plan = context['plan']; operation = control._active_operation
    require(operation is not None and operation['receipt'].get('phase') == 'data-volume-migration'
        and operation.get('lease_ready') is True and operation.get('daemon_pending') is True,
        'Retained restart preparation requires its live guarded migration operation')
    token = operation['receipt'].get('attempt')
    require(type(token) is str and re.fullmatch('[0-9a-f]{32}', token) and
        operation.get('root') == 'data-volume-migration/attempts/'+token and
        control.project == context['identity']['project_name'] == plan['compose_project'] and
        control.image == plan['runtime_pins']['image_id'] and control.namespace == '',
        'Retained restart operation source/group/image/namespace differs')
    control._assert_live_operation_helper(operation)
    require(fence.control is control and fence.operation is operation and fence.relocated is prepared['relocated']
        and fence.released is False and fence.request['token'] == token and
        fence.request['volume_id'] == context['linux']['volume_id'] and
        fence.request['process_receipt_sha256'] == snapshot['process_receipt_sha256'] ==
            context['drain']['process_receipt_sha256'], 'Restart OLD guard belongs to another scope')
    fence.check()
    actual = snapshot['actual']; pins = _runtime_pins(plan['runtime_pins'])
    require(type(actual) is dict and set(actual) == {'backend','frontend'} and
        all(actual[role].get('Id') == pins[role] and actual[role].get('Image') == pins['image_id']
            for role in actual), 'Retained restart stopped pair differs')
    return scope, operation, pins


def _retained_records(control, context, snapshot):
    pins = _runtime_pins(context['plan']['runtime_pins']); records = {}
    def read(relative):
        raw = _read(control, relative)
        records[relative] = _sha(raw)
        return _decode(raw)
    base = 'development/attempts/'+pins['attempt']
    previous = read(base+'/terminal.json'); document = read(base+'/compose.json')
    witness = read(pins['runtime_witness_path'])
    require(records[pins['runtime_witness_path']] == pins['runtime_witness_sha256'],
            'Retained runtime witness bytes changed')
    require(_sha(canonical(document)) == pins['config_sha256'] and document.get('name') == control.project,
            'Retained Compose identity or digest changed')
    require(previous.get('phase') == 'development' and previous.get('state') == 'succeeded'
        and previous.get('attempt') == pins['attempt'] and previous.get('compose_project') == control.project
        and previous.get('control_volume') == control.volume and previous.get('state_root') == pins['state_root']
        and previous.get('config_sha256') == pins['config_sha256'] and
        previous.get('inputs',{}).get('source_root') == str(context['source']) and
        previous['inputs'].get('image_id') == pins['image_id'] and
        all(previous.get(role+'_container') == pins[role] for role in ('backend','frontend')),
        'Retained successful development does not bind this source/pair/state')
    require(witness.get('state') == 'succeeded' and
        witness.get('phase') == pins['runtime_witness_path'].split('/')[0] and
        witness.get('compose_project') == control.project and witness.get('control_volume') == control.volume
        and witness.get('state_root') == pins['state_root'] and witness.get('config_sha256') == pins['config_sha256']
        and all(witness.get(role+'_container') == pins[role] for role in ('backend','frontend')),
        'Retained witness no longer identifies the same successful pair')
    if witness['phase'] != 'development':
        require(witness.get('inputs',{}).get('attempt') == pins['attempt'] and
            witness['inputs'].get('config_sha256') == pins['config_sha256'], 'Retained witness predecessor differs')
    require(volume._control_namespace_from_document(document) == '' and
        previous.get('control_namespace') is None and previous.get('namespace_registry_sha256') is None and
        previous.get('ledger_profile') == 'group-ledger-v1' and
        not getattr(control,'namespace_registry',None), 'Migrated restart does not support a namespace or legacy ledger')
    require(all(previous.get(key) is None for key in UNSUPPORTED),
            'Migrated restart has another retained recovery/continuation context')
    environment = document.get('services',{}).get('backend',{}).get('environment',{})
    require(type(environment) is dict and environment.get('FULLMAG_SESSION_STORAGE_PROFILE') == 'linux-native-v1'
        and not any(key.startswith(RECOVERY_ENV_PREFIXES) for key in environment),
        'Migrated restart does not support this retained runtime/storage context')
    from docker_volume_cold_budget_restore import _paths
    absent = (*_paths(pins['backend']), *('verification/preowner-drained-stop-'+pins['backend']+suffix
                                        for suffix in ('.json','.intent.json')))
    require(all(_read(control,path,optional=True) is None for path in absent),
            'Current-backend cold/pre-owner stop requires a separate relocated adapter')
    recovery = volume._retained_recovery_context(control,previous,document,fresh_state=False,
        backend_id=pins['backend'],actual=snapshot['actual'])
    require(type(recovery) is dict and set(recovery) <= {'cold_budget_restore'} and
        recovery.get('cold_budget_restore') == previous.get('cold_budget_restore'),
        'Migrated restart must preserve only its authenticated historical cold-budget pin')
    cold_pin = recovery.get('cold_budget_restore')
    if cold_pin is not None:
        journal = cold.authenticate_journal(control,cold_pin)
        require(journal['observation']['source_root'] == str(context['source']), 'Retained budget journal source differs')
        raw = _read(control,cold_pin['journal_relative'])
        require(_sha(raw) == cold_pin['journal_sha256'], 'Retained budget journal changed')
        records[cold_pin['journal_relative']] = cold_pin['journal_sha256']
    return previous, document, records, tuple(absent), recovery


def _arguments(context, previous, document, recovery):
    from docker_dev import _parser
    from docker_dev_network import retained_requested_subnet
    source = context['source']; backend = document['services']['backend']; frontend = document['services']['frontend']
    ports = frontend.get('ports')
    require(type(ports) is list and len(ports) == 1 and type(ports[0]) is dict, 'Retained frontend port is ambiguous')
    port = ports[0]; published = port.get('published')
    require(port.get('host_ip') == '127.0.0.1' and port.get('target') == 8080 and port.get('mode') == 'ingress'
        and port.get('protocol') == 'tcp' and type(published) is str and re.fullmatch('[1-9][0-9]{0,4}',published)
        and 1024 <= int(published) <= 65535 and frontend.get('environment',{}).get('FULLMAG_FRONTEND_HOST_PORT') == published,
        'Retained frontend loopback port differs')
    ui_mode = previous.get('ui_mode')
    require(ui_mode in ('gui','headless') and previous['inputs'].get('ui_mode') == ui_mode,
            'Retained UI mode differs')
    if ui_mode == 'gui': require(previous.get('url') == 'http://127.0.0.1:'+published, 'Retained UI URL differs')
    policy = previous['inputs'].get('gpu_access_requested')
    access = volume._retained_device_access(previous,document)
    operator = volume._operator_probe_record_from_retained(previous,document)
    contracts = volume._retained_native_contracts(previous,document)
    allowlist = volume.include_untracked_from_compose(document)
    subnet = retained_requested_subnet(document,None)
    argv = ['--repo-root',str(source),'up','--source-root',str(source),'--profile','dev',
            '--port',published,'--gpu-access',policy]
    if ui_mode == 'headless': argv.append('--headless')
    if subnet is not None: argv.extend(('--network-subnet',subnet))
    for value in contracts: argv.extend(('--native-contract',value))
    for value in allowlist: argv.extend(('--include-untracked',value))
    args = _parser().parse_args(argv)
    state = Path(context['plan']['runtime_pins']['state_root'])
    kwargs = {'reuse_state': {'state':state,'host_certificate':state/host.CERTIFICATE_NAME,
        'owner_marker':state/host.OWNER_NAME,'receipt':{'image_id':context['plan']['runtime_pins']['image_id']},
        'operator_probe_environment_record':operator}, 'retained_device_access':access,'capture_terminal':True, **recovery}
    details = {'port':int(published),'ui_mode':ui_mode,'gpu_access_requested':policy,'device_access':access,
        'native_contracts':list(contracts),'include_untracked':list(allowlist),'network_subnet':subnet,
        'operator_probe_environment_sha256':operator['operator_probe_environment_sha256'],
        'previous_config_sha256':None,'cold_budget_restore':recovery.get('cold_budget_restore')}
    return vars(args), kwargs, details


class _RestartContext:
    def __init__(self, control, prepared, scope, operation, fence, values):
        self._control=control; self._prepared=prepared; self._scope=scope; self._operation=operation; self._fence=fence
        self._pid=os.getpid(); self._thread=threading.get_ident(); self._values=deepcopy(values)
        self._snapshot=deepcopy(values); self._consumed=False


def _issued_context(value):
    require(type(value) is _RestartContext, 'The issued retained restart context is required')
    startup_scope._require_prepared(value._prepared)
    require(getattr(value._prepared,'_retained_restart',None) is value and
        value._pid == os.getpid() and value._thread == threading.get_ident() and value._values == value._snapshot,
        'Retained restart context was not issued here, expired, or changed')
    source=value._prepared['context']['source']
    require(_source_pins(source) == value._values['components'] and
        storage.git(source,'rev-parse','HEAD') == value._values['source_commit'], 'Restart sources changed during migration')
    return value


def require_context(value):
    _issued_context(value)
    _issuer,scope = _prepared_scope(value._prepared)
    require(value._scope is scope, 'Retained restart requires its original active startup scope')
    return value


def prepare_context(control, prepared, snapshot, *, fence):
    scope,operation,pins = _held(control,prepared,snapshot,fence)
    require(getattr(prepared,'_retained_restart',None) is None, 'Retained restart was already prepared; do not replay')
    context=prepared['context']; source=context['source']; components=_source_pins(source)
    previous,document,records,absent,recovery = _retained_records(control,context,snapshot)
    arguments,kwargs,details = _arguments(context,previous,document,recovery)
    terminal_context=None
    if previous.get('terminal_observation') is not None:
        view=require_relocated(prepared['relocated'],source,context['plan'])
        terminal_context=observation.prepare_captured_context(control,
            stop_attempt=context['drain']['stop_attempt'],store_root=view['old_roots']['state']/'runs/docker-all/session-store',
            source_root=str(source),attempt=pins['attempt'],config_sha256=pins['config_sha256'],
            actual=snapshot['actual'],owned_operation=operation)
        observation.revalidate_context(control,terminal_context,
            store_root=view['old_roots']['state']/'runs/docker-all/session-store',source_root=str(source),
            attempt=pins['attempt'],config_sha256=pins['config_sha256'],actual=snapshot['actual'])
        prefix='runtime-control/terminal-observation/'+terminal_context['metadata']['proof_sha256']
        for name, pin in (('proof.json','proof_sha256'),('request.json','request_sha256')):
            raw=_read(control,prefix+'/'+name)
            require(_sha(raw) == terminal_context['metadata'][pin], 'Published observation bytes changed')
            records[prefix+'/'+name]=terminal_context['metadata'][pin]
        kwargs['terminal_observation']=terminal_context
    values={'arguments':arguments,'kwargs':kwargs,'records':records,'absent':absent,'components':components,
        'source_commit':storage.git(source,'rev-parse','HEAD'),'source_proof':snapshot['source_proof'],
        'process_receipt_sha256':snapshot['process_receipt_sha256'],'actual':snapshot['actual'],
        'details':dict(details,terminal_observation=None if terminal_context is None else terminal_context['metadata'])}
    result=_RestartContext(control,prepared,scope,operation,fence,values)
    prepared._retained_restart=result
    revalidate_context(control,prepared,result,snapshot,fence=fence)
    return result


def _readback(value):
    for relative,pin in value._values['records'].items():
        require(_sha(_read(value._control,relative)) == pin, 'Retained restart record changed: '+relative)
    require(all(_read(value._control,path,optional=True) is None for path in value._values['absent']),
            'Another current-backend recovery appeared during restart')


def revalidate_context(control, prepared, restart, snapshot, *, fence):
    require_context(restart)
    _scope,operation,pins=_held(control,prepared,snapshot,fence)
    require(restart._control is control and restart._prepared is prepared and restart._operation is operation and
        restart._fence is fence and not restart._consumed and snapshot['source_proof'] == restart._values['source_proof']
        and snapshot['actual'] == restart._values['actual'] and
        snapshot['process_receipt_sha256'] == restart._values['process_receipt_sha256'],
        'Retained source changed under its original OLD guards')
    _readback(restart)
    terminal_context=restart._values['kwargs'].get('terminal_observation')
    if terminal_context is not None:
        context=prepared['context']; view=require_relocated(prepared['relocated'],context['source'],context['plan'])
        observation.revalidate_context(control,terminal_context,
            store_root=view['old_roots']['state']/'runs/docker-all/session-store',source_root=str(context['source']),
            attempt=pins['attempt'],config_sha256=pins['config_sha256'],actual=snapshot['actual'])
    _readback(restart); fence.check(); require_context(restart)
    return restart


def summary(restart):
    require_context(restart)
    context=restart._prepared['context']
    return deepcopy({'schema':'fullmag.data-volume-retained-restart.v1',
        'source_root':str(context['source']),'source_commit':restart._values['source_commit'],
        'development_attempt':context['plan']['runtime_pins']['attempt'],
        'compose_sha256':context['plan']['runtime_pins']['config_sha256'],
        'records':restart._values['records'],'components':restart._values['components'], **restart._values['details']})


def start_arguments(restart):
    require_context(restart)
    require(not restart._consumed and restart._control._active_operation is None and
        restart._operation.get('daemon_pending') is False and restart._operation['receipt'].get('state') == 'succeeded'
        and restart._fence.released is True, 'Start requires its closed successful removal operation')
    _readback(restart)
    restart._consumed=True
    return Namespace(**deepcopy(restart._values['arguments'])), deepcopy(restart._values['kwargs'])


def validate_started(control, prepared, restart, captured):
    require_context(restart)
    return _started_evidence(control,prepared,restart,captured)


def _started_evidence(control, prepared, restart, captured):
    _issued_context(restart)
    require(restart._consumed and restart._control is control and restart._prepared is prepared and
        control._active_operation is None, 'Started runtime has no consumed retained restart context')
    require(type(captured) is dict and set(captured) == {'schema','relative','sha256','receipt'} and
        captured['schema'] == 'fullmag.development-start-terminal.v1' and type(captured['receipt']) is dict,
        'Exact captured development terminal required')
    receipt=captured['receipt']; attempt=receipt.get('attempt'); context=prepared['context']; pins=context['plan']['runtime_pins']
    require(type(attempt) is str and re.fullmatch('[0-9a-f]{32}',attempt) and attempt != pins['attempt'] and
        captured['relative'] == 'development/attempts/'+attempt+'/terminal.json' and
        receipt.get('phase') == 'development' and receipt.get('state') == 'succeeded' and
        receipt.get('compose_project') == control.project and receipt.get('control_volume') == control.volume and
        receipt.get('state_root') == pins['state_root'] and receipt.get('source_commit') == restart._values['source_commit'],
        'Started development identity/source/state differs')
    raw=_read(control,captured['relative'])
    require(raw == canonical(receipt)+b'\n' and _sha(raw) == captured['sha256'], 'Captured start terminal bytes changed')
    identifiers={role:receipt.get(role+'_container') for role in ('backend','frontend')}
    require(all(type(identifier) is str and re.fullmatch('[0-9a-f]{64}',identifier) for identifier in identifiers.values())
        and len(set(identifiers.values())) == 2 and set(identifiers.values()).isdisjoint((pins['backend'],pins['frontend'])),
        'Started runtime did not create the exact replacement service pair')
    inputs=receipt.get('inputs',{}); details=restart._values['details']
    require(inputs.get('source_root') == str(context['source']) and inputs.get('device_access') == details['device_access']
        and inputs.get('gpu_access_requested') == details['gpu_access_requested'] and
        receipt.get('terminal_observation') == details['terminal_observation'] and
        receipt.get('cold_budget_restore') == details['cold_budget_restore'], 'Started retained intent or contexts differ')
    for key in ('config_sha256','source_snapshot_sha256','backend_build_receipt_sha256'):
        require(type(receipt.get(key)) is str and re.fullmatch('[0-9a-f]{64}',receipt[key]), 'Started provenance is missing: '+key)
    compose_raw=_read(control,'development/attempts/'+attempt+'/compose.json'); document=_decode(compose_raw)
    require(_sha(canonical(document)) == receipt['config_sha256'] and document.get('name') == control.project,
            'Started Compose bytes differ from its exact terminal')
    env=document.get('services',{}).get('backend',{}).get('environment',{})
    require(env.get('FULLMAG_STARTUP_ENABLED') == '0' and 'FULLMAG_STARTUP_SCRIPT' not in env,
        'Started runtime would replay a script')
    started_recovery={} if receipt.get('cold_budget_restore') is None else {'cold_budget_restore':receipt['cold_budget_restore']}
    _arguments_value,_kwargs_value,started_details=_arguments(context,receipt,document,started_recovery)
    started_details['terminal_observation']=receipt.get('terminal_observation')
    require(started_details == details and volume._control_namespace_from_document(document) == '' and
        receipt.get('control_namespace') is None and receipt.get('namespace_registry_sha256') is None and
        receipt.get('ledger_profile') == 'group-ledger-v1',
        'Started runtime changed retained intent/port/UI/operator/allowlist/network or storage topology')
    state=Path(pins['state_root']); certificate_raw=host.read_owned_regular(state/host.CERTIFICATE_NAME)
    certificate=_decode(certificate_raw); row=prepared['bound_terminal']['result']['switch']['roots']['state']
    candidate=_decode(prepared['native_before']['candidate_raw'])
    owner=candidate.get('owner_token')
    require(type(owner) is str and re.fullmatch('[0-9a-f]{32}',owner) and owner != '0'*32 and
        host.read_owned_regular(state/host.OWNER_NAME) == certificate_raw and certificate.get('owner_token') == owner and
        certificate.get('schema') == host.HOST_SCHEMA and certificate.get('storage_profile') == 'linux-native-v1' and
        certificate.get('restart_verified') is True and certificate.get('host_root') == str(state) and
        certificate.get('host_device') == row['bound_identity']['device'] and
        certificate.get('host_inode') == row['bound_identity']['inode'] and
        certificate.get('image_id') == inputs.get('image_id') and
        certificate.get('engine_id') == context['plan']['observation']['engine_id'] and
        host._readmission_certificate_inode(state) == prepared['native_before']['certificate_inode'],
        'Started namespace admission or in-place certificate identity differs')
    _readback(restart); _issued_context(restart)
    return {'schema':'fullmag.data-volume-started-evidence.v1','development_attempt':attempt,
        'development_terminal':{'relative':captured['relative'],'sha256':captured['sha256']},
        'config_sha256':receipt['config_sha256'],'source_commit':receipt['source_commit'],
        'source_snapshot_sha256':receipt['source_snapshot_sha256'],
        'backend_build_receipt_sha256':receipt['backend_build_receipt_sha256'],
        'containers':identifiers,'certificate_sha256':_sha(certificate_raw),
        'namespace_admitted':True,'data_migrated':False,'originals_retired':False}


def revalidate_started(control, prepared, restart, evidence):
    """Repeat readback after the scope closed, never create a new start authority."""
    _issued_context(restart)
    require(type(evidence) is dict and type(evidence.get('development_terminal')) is dict and
        set(evidence['development_terminal']) == {'relative','sha256'}, 'Exact started evidence required')
    terminal=evidence['development_terminal']; relative=terminal['relative']
    require(type(relative) is str and re.fullmatch('development/attempts/[0-9a-f]{32}/terminal.json',relative) and
        type(terminal['sha256']) is str and re.fullmatch('[0-9a-f]{64}',terminal['sha256']),
        'Started evidence terminal reference differs')
    raw=_read(control,relative)
    captured={'schema':'fullmag.development-start-terminal.v1','relative':relative,
        'sha256':terminal['sha256'],'receipt':_decode(raw)}
    actual=_started_evidence(control,prepared,restart,captured)
    require(actual == evidence, 'Started runtime evidence changed after its scope closed')
    return deepcopy(actual)
