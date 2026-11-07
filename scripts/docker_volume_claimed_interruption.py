#!/usr/bin/env python3
"""Collect authority and explicitly prepare one dead Started claim interruption.

Collection preserves the lease, consumed launch gate, catalog and results.
Explicit prepare invokes native quarantine with fresh namespace admission.
Neither phase stops containers, publishes packages, starts runtime or Solve.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
from pathlib import Path
import re

import docker_dev_recovery_build as repair
from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_dev_host import require_host


def make_build_pin(ledger, files, observed, run_id, task_id):
    """Derive only the exact claim identity, then apply the build validator."""
    require = repair.require
    require(isinstance(ledger, dict) and isinstance(ledger.get('reservations'), list),
            'Claim collector ledger is invalid')
    active = [row for row in ledger['reservations'] if isinstance(row, dict) and row.get('state') != 'released']
    require(len(active) == 1, 'Claim collector requires exactly one occupied reservation')
    reservation = active[0]
    rid = reservation.get('identity', {})
    owner = rid.get('owner', {})
    require(rid.get('run_id') == run_id and rid.get('task_id') == task_id and owner.get('kind') == 'solver',
            'Claim collector reservation differs from requested task')
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    lease = json.loads(observed['lease'])
    catalog = json.loads(observed['catalog'])
    tasks = [task for task in catalog.get('tasks', []) if task.get('task_id') == task_id]
    require(len(tasks) == 1, 'Claim collector task is absent or duplicated')
    identity = {key: rid[key] for key in ('store_id', 'run_id', 'task_id', 'resource_id', 'lease_token')}
    identity.update(attempt_id=owner['attempt_id'], ownership_epoch=owner['ownership_epoch'],
                    host_id=reservation['host_id'], reservation_request_sha256=reservation['request_sha256'],
                    runtime_generation_sha256=reservation['runtime_generation_sha256'],
                    reservation_before_sha256=digest(reservation), lease_before_sha256=digest(lease))
    pin = dict(schema_version='fullmag.claimed-interruption-build-pin.v1', identity=identity,
               consumed_launch_token=reservation.get('worker_launch_gate', {}).get('token'),
               catalog_revision=catalog.get('revision'), expected_task=tasks[0],
               files={role: dict(path=str(files[role]), sha256=hashlib.sha256(raw).hexdigest())
                      for role, raw in observed.items()})
    repair.validate_claimed_build_snapshot(pin, ledger, observed)
    return pin


# Executed only in the selected existing backend; imported runtime helpers supply
# the canonical paths, no-follow reads and the same guards used by repair builds.
COLLECT = r'''
def collect(request):
    require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == request['compose_project'], 'Collector project differs')
    require(os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == request['source_root'], 'Collector checkout differs')
    with runtime_locks() as paths:
        process_raw = read(runtime.process_receipt_path(paths))
        owner_raw = read(runtime.runtime_services_root(paths)/'OWNER.json')
        require(hashlib.sha256(process_raw).hexdigest() == request['process_receipt_sha256']
                and hashlib.sha256(owner_raw).hexdigest() == request['owner_sha256'], 'Collector owner/process CAS differs')
        process, owner = json.loads(process_raw), json.loads(owner_raw)
        validate_diagnostic_build(process, owner)
        ledger_path = Path(os.environ.get('FULLMAG_HOST_LEDGER_ROOT', '/host-ledger/ledger'))/'HOST_RESOURCE_LEDGER.json'
        ledger = json.loads(read(ledger_path))
        occupied = [row for row in ledger.get('reservations', []) if row.get('state') != 'released']
        require(len(occupied) == 1, 'Collector requires one occupied reservation')
        rid = occupied[0]['identity']
        require(rid.get('run_id') == request['run_id'] and rid.get('task_id') == request['task_id'], 'Collector task differs')
        for value in (rid.get('resource_id'), rid.get('lease_token'), rid.get('owner', {}).get('attempt_id')):
            require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}', value), 'Unsafe claim component')
        epoch = rid['owner']['ownership_epoch']
        require(type(epoch) is int and epoch > 0, 'Invalid claim epoch')
        run = paths.store/'runs'/request['run_id']
        attempt = run/'worker-attempts'/request['task_id']/rid['owner']['attempt_id']/('epoch-'+str(epoch))
        files = dict(catalog=run/'run_catalog.json',
                     lease=run/'resource_leases'/rid['resource_id']/(rid['lease_token']+'.json'),
                     started=attempt/'worker_execution_started.v1.json',
                     supervisor_slot=paths.store/'supervisor-slots'/('resource-'+hashlib.sha256(rid['resource_id'].encode()).hexdigest())/'owner.v2.json',
                     launch=runtime.runtime_services_root(paths)/'LAUNCH.json')
        candidates = list((run/'worker_inbox').glob('*.json'))
        require(len(candidates) <= 4096, 'Collector inbox inventory exceeds bound')
        matches = []
        for path in candidates:
            require(re.fullmatch(r'[0-9a-f]{64}\.json', path.name), 'Collector inbox name invalid')
            payload = json.loads(read(path)).get('payload', {})
            claim = payload.get('claim', {})
            if all(claim.get(key) == value for key, value in dict(run_id=request['run_id'], task_id=request['task_id'],
                    attempt_id=rid['owner']['attempt_id'], ownership_epoch=epoch, lease_token=rid['lease_token']).items()):
                matches.append(path)
        require(len(matches) == 1, 'Collector requires one exact durable inbox')
        files['inbox'] = matches[0]
        observed = {role: read(path) for role, path in files.items()}
        pin = make_build_pin(ledger, files, observed, request['run_id'], request['task_id'])
        with claimed_build_locks({'claimed_interruption_build': pin, 'diagnostic_api_only': True}, paths):
            before = pinned_evidence({**request, 'diagnostic_api_only': True, 'claimed_interruption_build': pin}, paths)
            require(pinned_evidence({**request, 'diagnostic_api_only': True, 'claimed_interruption_build': pin}, paths) == before,
                    'Collector evidence changed under writer guards')
            print(json.dumps({'build_pin': pin, 'process_receipt_sha256': request['process_receipt_sha256'],
                              'owner_sha256': request['owner_sha256']}, sort_keys=True))
'''


def collector_code():
    # Reuse the existing in-container canonical guard implementation without its
    # build/promotion entrypoint. No generated source or log is saved on host.
    source = inspect.getsource(make_build_pin).replace('    require = repair.require\n', '')
    source = source.replace('repair.validate_claimed_build_snapshot(', 'validate_claimed_build_snapshot(')
    return ('import hashlib, json\nfrom pathlib import Path\n' + inspect.getsource(repair.require)
            + inspect.getsource(repair.validate_terminal) + inspect.getsource(repair.validate_diagnostic_build)
            + inspect.getsource(repair.validate_claimed_build_snapshot) + repair.RUNTIME + '\n' + source
            + COLLECT + '\ncollect(json.loads(sys.argv[1]))\n')


def collect_build_pin(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_reconcile import fingerprint
    from docker_volume_unclaimed_cancellation import _json_object, _publish_immutable
    require_host()
    for value, pattern in ((args.backend_container_id, r'[0-9a-f]{64}'),
                           (args.image_id, r'sha256:[0-9a-f]{64}'),
                           (args.process_receipt_sha256, r'[0-9a-f]{64}'),
                           (args.owner_sha256, r'[0-9a-f]{64}'),
                           (args.collection_id, r'[0-9a-f]{32}'),
                           (args.run_id, r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}'),
                           (args.task_id, r'[A-Za-z0-9][A-Za-z0-9._-]{0,199}')):
        repair.require(isinstance(value, str) and re.fullmatch(pattern, value), 'Exact immutable collector pins required')
    selected, layout = _select_source(Path(args.source_root), str(args.source_root))
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    # Collection is admitted only against an existing, authenticated control
    # namespace. prepare() could allocate a new control volume, so do not use it.
    repair.inspect_one('volume', control.volume)
    before = repair.inspect_one('container', args.backend_container_id)
    repair.validate_backend(before, identity, args.backend_container_id, args.image_id)
    inputs = {key: getattr(args, key) for key in ('backend_container_id', 'image_id', 'process_receipt_sha256',
                                               'owner_sha256', 'run_id', 'task_id', 'collection_id')}
    inputs.update(compose_project=control.project, source_root=str(selected), backend_started_at=before['State']['StartedAt'])
    relative = 'verification/claimed-interruption/'+args.collection_id+'/build-pin.json'
    with control.operation('claimed-interruption-collect', inputs) as operation:
        result = docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B', '-c', collector_code(),
                                json.dumps(inputs), timeout=120)
        repair.require(result.returncode == 0, 'Claim collector refused')
        output = _json_object(result.stdout, 'claim collector output', maximum=512*1024)
        pin = output.get('build_pin')
        repair.require(isinstance(pin, dict), 'Collector returned no build pin')
        after = repair.inspect_one('container', args.backend_container_id)
        repair.require(fingerprint(after) == fingerprint(before) and after['State']['StartedAt'] == inputs['backend_started_at']
                       and after['State']['Running'] is True, 'Collector backend incarnation changed')
        raw = canonical(pin)+b'\n'
        _publish_immutable(control, relative, raw)
        digest = hashlib.sha256(raw).hexdigest()
        operation['receipt'].update(state='succeeded', claimed_build_pin=relative, claimed_build_pin_sha256=digest,
                                    runtime_started=False, package_promoted=False, container_stopped=False)
    return dict(claimed_build_pin=relative, claimed_build_pin_sha256=digest, control_volume=control.volume,
                compose_project=control.project, native_interruption='NOT VERIFIED', runtime_started=False)



def make_journal_snapshot(entries, identity):
    """Mirror native per-direction journal ordering and retain the full claim."""
    require = repair.require
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    journal, checkpoints = {'commands': [], 'events': []}, []
    require(isinstance(entries, list) and all(isinstance(entry, dict) for entry in entries), 'Journal entries invalid')
    selected = [entry for entry in entries if all(entry.get(key) == identity[key]
                for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch'))]
    require(selected and all(entry.get('direction') in ('command', 'event') for entry in selected), 'Journal directions invalid')
    for direction, plural in (('command', 'commands'), ('event', 'events')):
        rows = [entry for entry in selected if entry['direction'] == direction]
        require(all(type(entry.get('sequence')) is int for entry in rows), 'Journal sequence invalid')
        rows.sort(key=lambda entry: entry['sequence'])
        require([entry['sequence'] for entry in rows] == list(range(1, len(rows)+1)), 'Journal sequence gap')
        for entry in rows:
            payload = entry['payload']
            require(entry.get('lease_token') == identity['lease_token'] and entry.get('payload_sha256') == digest(payload)
                    and payload['message']['direction'] == direction, 'Journal payload identity differs')
            journal[plural].append(payload['message']['envelope'])
            checkpoints.append(payload['checkpoint'])
    require(journal['commands'] and journal['events'] and checkpoints, 'Claimed journal missing')
    checkpoints.sort(key=lambda item: item['command_sequence']+item['event_sequence'])
    claim = checkpoints[-1]['claim']
    require(all(claim.get(key) == identity[key] for key in ('run_id', 'task_id', 'attempt_id', 'ownership_epoch'))
            and claim['lease']['resource_id'] == identity['resource_id']
            and claim['lease']['lease_token'] == identity['lease_token'], 'Claim checkpoint differs')
    return journal, claim


REQUEST_COLLECT = r"""
def collect_native(request):
    require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == request['compose_project'], 'Request collector project differs')
    require(os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == request['source_root'], 'Request collector checkout differs')
    pin = request['build_pin']
    with runtime_locks() as paths, claimed_build_locks({'claimed_interruption_build': pin, 'diagnostic_api_only': True}, paths):
        guard_request = {**request, 'diagnostic_api_only': True, 'claimed_interruption_build': pin}
        before = pinned_evidence(guard_request, paths)
        identity = pin['identity']
        run = paths.store/'runs'/identity['run_id']
        records = {role: read(Path(binding['path'])) for role, binding in pin['files'].items()}
        for role, raw in records.items():
            require(hashlib.sha256(raw).hexdigest() == pin['files'][role]['sha256'], 'Request collector pin drift: '+role)
        owner_raw = read(runtime.runtime_services_root(paths)/'OWNER.json')
        config_raw = read(paths.config)
        config = json.loads(config_raw)
        process_raw = read(runtime.process_receipt_path(paths))
        owner = json.loads(owner_raw)
        slot = json.loads(records['supervisor_slot'])
        installed = request.get('use_installed_package') is True
        package = (backend.PACKAGE_ROOT if installed else
                   backend.PACKAGE_ROOT/backend.PACKAGE_DEVELOPMENT_DIRNAME/backend.PACKAGE_CANDIDATES_DIRNAME/request['candidate_basename'])
        if not installed:
            backend._validate_candidate_marker(package, backend.PACKAGE_ROOT, Path('/build'), state='ready')
        receipt, receipt_raw, _ = backend._validated_package(package, 'claimed interruption package',
            exclude_candidate_marker=not installed, exclude_development_control=installed)
        require(hashlib.sha256(receipt_raw).hexdigest() == request['candidate_receipt_sha256'], 'Candidate receipt pin differs')
        require(receipt.get('state') == 'succeeded' and receipt.get('schema') == 'fullmag.direct-compose.backend-build-receipt.v1', 'Candidate package not successful')
        executable = package/'bin'/'fullmag-runtime-service'
        artifacts = [item for item in receipt['artifacts'] if item['path'] == 'bin/fullmag-runtime-service']
        require(len(artifacts) == 1, 'Candidate native executable inventory differs')
        executable_sha, executable_size = hash_regular(executable, allow_readonly_hardlink=True)
        require(artifacts[0]['sha256'] == executable_sha and artifacts[0]['size'] == executable_size, 'Candidate executable bytes differ')
        source = receipt['source']
        require(re.fullmatch(r'[0-9a-f]{40}', source['resolved_commit'])
                and re.fullmatch(r'[0-9a-f]{64}', source['source_snapshot_sha256']), 'Candidate source identity invalid')
        entries = []
        for direction in ('command', 'event'):
            paths_in_direction = list((run/'coordinator_journal'/direction).glob('*.json'))
            require(len(paths_in_direction) <= 100000, 'Journal exceeds collector budget')
            entries.extend(json.loads(read(path)) for path in paths_in_direction)
        journal, claim = make_journal_snapshot(entries, identity)
        root_relative = 'runs/{run_id}/worker-attempts/{task_id}/{attempt_id}/epoch-{ownership_epoch}'.format(**identity)
        root = paths.store/root_relative
        manifest = {'schema_version': 'claimed_worker_preserved_files.v1', 'root_relative': root_relative, 'files': {}}
        inventory_regular(root, root, manifest['files'])
        require(len(json.dumps(manifest).encode()) <= 1024*1024, 'Preserved manifest exceeds native budget')
        certificate_raw = read(Path('/run/fullmag/linux-native-host.json'))
        certificate = json.loads(certificate_raw)
        require(certificate == json.loads(read(Path('/state/.fullmag-linux-native-owner.json')))
                and hashlib.sha256(certificate['engine_id'].encode()).hexdigest() == request['docker_engine_id_sha256'], 'Engine/storage certificate differs')
        placement = config['host_execution']['compute_placements'][identity['resource_id']]
        pins = dict(owner_sha256=hashlib.sha256(owner_raw).hexdigest(), config_sha256=hashlib.sha256(config_raw).hexdigest(),
            process_receipt_sha256=hashlib.sha256(process_raw).hexdigest(), launch_sha256=hashlib.sha256(records['launch']).hexdigest(),
            journal_sha256=digest_json(journal), inbox_sha256=digest_json(json.loads(records['inbox'])['payload']),
            execution_started_sha256=hashlib.sha256(records['started']).hexdigest(), supervisor_slot_sha256=hashlib.sha256(records['supervisor_slot']).hexdigest(),
            package_receipt_sha256=request['candidate_receipt_sha256'], executable_sha256=executable_sha,
            source_snapshot_sha256=source['source_snapshot_sha256'], mount_attestation_sha256=hashlib.sha256(certificate_raw).hexdigest(),
            preserved_files_manifest_sha256=digest_json(manifest))
        interruption = dict(schema_version='claimed_worker_interruption.v1', request_id=request['request_id'], identity=identity,
            consumed_launch_token=pin['consumed_launch_token'], catalog_before_sha256=hashlib.sha256(records['catalog']).hexdigest(),
            catalog_revision=pin['catalog_revision'], expected_task=pin['expected_task'], pins=pins,
            docker_engine_id_sha256=request['docker_engine_id_sha256'], device_release_mapping_sha256=digest_json(placement),
            gpu_uuid=placement.get('gpu_uuid'), container=dict(request['container']),
            container_started_at=request['backend_started_at'])
        native = dict(schema_version='runtime_service_claimed_interruption.v1', interruption=interruption, expected_owner=owner,
            claim=claim, supervisor_slot=dict(owner_sha256=pins['supervisor_slot_sha256'], process_id=slot['process_id'], process_start_token=slot['process_start_token']),
            process_receipt_path=str(runtime.process_receipt_path(paths)), pid_namespace=os.readlink('/proc/self/ns/pid'),
            boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(), build_commit=source['resolved_commit'])
        require(pinned_evidence(guard_request, paths) == before, 'Request evidence changed during collection')
        manifest_after = {}
        inventory_regular(root, root, manifest_after)
        require(manifest_after == manifest['files'], 'Preserved worker files changed during collection')
        print(json.dumps(dict(native_request=native, preserved_files_manifest=manifest, executable=str(executable), config_path=str(paths.config)), sort_keys=True))


def digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def hash_regular(path, *, allow_readonly_hardlink=False):
    backend._assert_no_links(path, 'claimed interruption inventory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink >= 1
                and (allow_readonly_hardlink or before.st_nlink == 1),
                'Inventory requires one regular inode')
        # Only receipt-validated published executables opt in. Shared package
        # publication hardlinks immutable binaries; user data remains strict.
        require(not allow_readonly_hardlink or before.st_mode & 0o222 == 0,
                'Published executable must have no write permission bits')
        digest, size = hashlib.sha256(), 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            digest.update(chunk); size += len(chunk)
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink, before.st_mode)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink, after.st_mode)
                and size == before.st_size, 'Inventory changed during read')
        return digest.hexdigest(), size
    finally:
        os.close(fd)


def inventory_regular(root, current, files):
    backend._assert_no_links(current, 'claimed interruption inventory directory')
    require(current.is_dir(), 'Inventory parent must be a real directory')
    for child in sorted(current.iterdir()):
        metadata = child.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            inventory_regular(root, child, files)
        else:
            require(stat.S_ISREG(metadata.st_mode), 'Inventory refuses links and special files')
            digest, size = hash_regular(child)
            files[child.relative_to(root).as_posix()] = dict(bytes=size, sha256=digest)
            require(len(files) <= 100000, 'Inventory exceeds native file budget')
"""


def request_collector_code():
    source = inspect.getsource(make_journal_snapshot).replace('    require = repair.require\n', '')
    return collector_code().rsplit('\ncollect(json.loads(sys.argv[1]))\n', 1)[0] + source + REQUEST_COLLECT + '\ncollect_native(json.loads(sys.argv[1]))\n'


def collect_request(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_reconcile import fingerprint
    from docker_volume_unclaimed_cancellation import _json_object, _publish_immutable
    import docker_claimed_worker_interruption as pure
    import uuid
    require_host()
    repair.require(isinstance(args.request_id, str), 'Request UUID required')
    repair.require(str(uuid.UUID(args.request_id)) == args.request_id and uuid.UUID(args.request_id).int != 0,
                   'Canonical nonzero request UUID required')
    for value, pattern in ((args.backend_container_id, r'[0-9a-f]{64}'), (args.image_id, r'sha256:[0-9a-f]{64}'),
                           (args.process_receipt_sha256, r'[0-9a-f]{64}'), (args.owner_sha256, r'[0-9a-f]{64}'),
                           (args.claimed_build_pin_sha256, r'[0-9a-f]{64}'), (args.candidate_receipt_sha256, r'[0-9a-f]{64}'),
                           (args.candidate_basename, r'\.backend-package-candidate-[A-Za-z0-9._-]+'),
                           (args.claimed_build_pin, r'verification/claimed-interruption/[0-9a-f]{32}/build-pin\.json')):
        repair.require(isinstance(value, str) and re.fullmatch(pattern, value), 'Exact request collector pins required')
    selected, layout = _select_source(Path(args.source_root), str(args.source_root))
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    repair.inspect_one('volume', control.volume)
    pin_raw = control.read_bytes(args.claimed_build_pin, maximum=256*1024)
    repair.require(hashlib.sha256(pin_raw).hexdigest() == args.claimed_build_pin_sha256, 'Build pin CAS differs')
    pin = _json_object(pin_raw, 'claim build pin')
    before = repair.inspect_one('container', args.backend_container_id)
    repair.validate_backend(before, identity, args.backend_container_id, args.image_id)
    repair.require(before.get('HostConfig', {}).get('PidMode', '') in ('', 'private'), 'Private backend PID namespace required')
    engine = _json_object(docker_capture('info', '--format', '{{json .}}').stdout, 'Docker Engine')
    engine_id = engine.get('ID')
    repair.require(isinstance(engine_id, str) and engine_id.strip(), 'Docker Engine identity missing')
    inputs = {key: getattr(args, key) for key in ('backend_container_id', 'image_id', 'process_receipt_sha256', 'owner_sha256',
                                                'candidate_basename', 'candidate_receipt_sha256', 'request_id')}
    inputs.update(source_root=str(selected), compose_project=control.project, build_pin=pin,
        use_installed_package=args.use_installed_package,
        backend_started_at=before['State']['StartedAt'], docker_engine_id_sha256=hashlib.sha256(engine_id.encode()).hexdigest(),
        container=dict(scope='dedicated_parent', container_id=args.backend_container_id, image_id=args.image_id,
            config_sha256=pure.recovery.canonical_json_sha256(before['Config']),
            compose_project=control.project, service='backend', private_pid_namespace=True, host_pid=False, sole_worker_scope=True,
            device_requests=before.get('HostConfig', {}).get('DeviceRequests')))
    root = 'verification/claimed-interruption/'+args.request_id.replace('-', '')
    with control.operation('claimed-interruption-request-collect', inputs) as operation:
        result = docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B', '-c', request_collector_code(),
                                json.dumps(inputs), timeout=300)
        output = _json_object(result.stdout, 'native request collector output', maximum=2*1024*1024)
        native = output['native_request']
        native['interruption'] = pure.validate_request(native['interruption'])
        pure._validate_preserved_files_manifest(output['preserved_files_manifest'], native['interruption'])
        repair.require(native['expected_owner']['state'] == 'unknown' and native['interruption']['identity'] == pin['identity'],
                       'Native request does not bind the retained Unknown claim')
        after = repair.inspect_one('container', args.backend_container_id)
        repair.require(fingerprint(after) == fingerprint(before) and after['State']['StartedAt'] == inputs['backend_started_at']
                       and after['State']['Running'] is True, 'Request collector backend incarnation changed')
        raw = canonical(native)+b'\n'
        manifest_raw = canonical(output['preserved_files_manifest'])+b'\n'
        # Existing immutable publisher has a stricter 256 KiB bound than the
        # native manifest. Check both before creating either record.
        repair.require(len(raw) <= 256*1024 and len(manifest_raw) <= 256*1024, 'Collected request/manifest exceeds publication budget')
        _publish_immutable(control, root+'/request.json', raw)
        _publish_immutable(control, root+'/preserved-files.json', manifest_raw)
        result = dict(request_path=root+'/request.json', request_sha256=hashlib.sha256(raw).hexdigest(),
            interruption_sha256=pure.canonical_request_sha256(native['interruption']), preserved_files_manifest_path=root+'/preserved-files.json',
            preserved_files_manifest_sha256=native['interruption']['pins']['preserved_files_manifest_sha256'],
            executable=output['executable'], config_path=output['config_path'], control_volume=control.volume,
            compose_project=control.project, storage_probe_path='/state/.linux-native-probe.json',
            storage_probe_sha256='REQUIRES_FRESH_PHASE_LOCAL_PROBE', runtime_started=False, native_interruption='NOT VERIFIED')
        operation['receipt'].update(state='succeeded', collected_request=result)
    return result



VERIFY_EFFECTS = r"""
def verify_effects_snapshot(request, paths, native):
    require(request.get('verify_only') is True and request.get('diagnostic_api_only') is True
            and isinstance(request.get('claimed_interruption_build'), dict), 'Verify requires exact claimed-build authority')
    evidence = pinned_evidence(request, paths)
    interruption = native['interruption']
    identity, token = interruption['identity'], interruption['request_id']
    require(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', token), 'Invalid interruption snapshot UUID')
    run = paths.store/'runs'/identity['run_id']
    epoch = run/'worker-attempts'/identity['task_id']/identity['attempt_id']/('epoch-'+str(identity['ownership_epoch']))
    preserved = {}
    inventory_regular(epoch, epoch, preserved)
    manifest = dict(schema_version='claimed_worker_preserved_files.v1',
                    root_relative=epoch.relative_to(paths.store).as_posix(), files=preserved)
    require(digest_json(manifest) == interruption['pins']['preserved_files_manifest_sha256'], 'Verify private manifest differs from request')
    ledger = Path(os.environ.get('FULLMAG_HOST_LEDGER_ROOT', '/host-ledger/ledger'))
    roots = [ledger/'claimed-worker-interruptions'/token,
             run/'claimed-worker-interruptions'/token,
             paths.store/'reaped-worker-recovery'/token,
             runtime.runtime_services_root(paths)/'reaped-worker-recovery'/token]
    trees = {}
    for root in roots:
        tree = {}
        if os.path.lexists(root):
            snapshot_effect_tree(root, root, tree)
        else:
            tree['.'] = {'kind': 'absent'}
        trees[str(root)] = tree
    evidence[str(Path(request['guest_request_path']))] = hashlib.sha256(read(Path(request['guest_request_path']))).hexdigest()
    return dict(evidence=evidence, preserved_files=manifest, interruption_records=trees)


def snapshot_effect_tree(root, path, records):
    backend._assert_no_links(path, 'verify interruption effects')
    metadata = path.lstat()
    relative = path.relative_to(root).as_posix()
    require(len(records) <= 100000, 'Interruption effect snapshot exceeds budget')
    if stat.S_ISDIR(metadata.st_mode):
        records[relative] = {'kind': 'directory'}
        for child in sorted(path.iterdir()):
            snapshot_effect_tree(root, child, records)
    else:
        require(stat.S_ISREG(metadata.st_mode), 'Interruption effect snapshot refuses links/special files')
        digest, size = hash_regular(path)
        records[relative] = dict(kind='file', bytes=size, sha256=digest)
"""

PREPARE = r"""
def prepare_native(request):
    result = {'schema_version': 'fullmag.claimed-interruption-prepare-phase.v1',
              'request_sha256': request['request_sha256'], 'interruption_sha256': request['interruption_sha256'],
              'backend_container_id': request['backend_container_id'], 'backend_started_at': request['backend_started_at'],
              'runtime_started': False, 'container_stopped': False, 'capacity_released': False,
              'native_invoked': False, 'effects_known': False}
    invoked = False
    try:
        require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == request['compose_project'], 'Prepare project differs')
        require(os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == request['source_root'], 'Prepare checkout differs')
        paths = runtime.canonical_paths()
        raw = read(Path(request['guest_request_path']))
        require(hashlib.sha256(raw).hexdigest() == request['request_sha256'], 'Prepare request CAS differs')
        native = json.loads(raw)
        interruption = native['interruption']
        require(digest_json(interruption) == request['interruption_sha256'], 'Prepare interruption digest differs')
        require(interruption['container']['container_id'] == request['backend_container_id']
                and interruption['container']['image_id'] == request['image_id']
                and interruption['container_started_at'] == request['backend_started_at'], 'Prepare container incarnation differs')
        require(hashlib.sha256(read(runtime.runtime_services_root(paths)/'OWNER.json')).hexdigest() == request['owner_sha256']
                and interruption['pins']['owner_sha256'] == request['owner_sha256']
                and hashlib.sha256(read(runtime.process_receipt_path(paths))).hexdigest() == request['process_receipt_sha256']
                and interruption['pins']['process_receipt_sha256'] == request['process_receipt_sha256'], 'Prepare owner/process pins differ')
        installed = request.get('use_installed_package') is True
        package = (backend.PACKAGE_ROOT if installed else
                   backend.PACKAGE_ROOT/backend.PACKAGE_DEVELOPMENT_DIRNAME/backend.PACKAGE_CANDIDATES_DIRNAME/request['candidate_basename'])
        if not installed:
            backend._validate_candidate_marker(package, backend.PACKAGE_ROOT, Path('/build'), state='ready')
        receipt, receipt_raw, _ = backend._validated_package(package, 'claimed administrative package',
            exclude_candidate_marker=not installed, exclude_development_control=installed)
        require(hashlib.sha256(receipt_raw).hexdigest() == interruption['pins']['package_receipt_sha256'], 'Prepare candidate receipt differs')
        executable = package/'bin'/'fullmag-runtime-service'
        artifacts = [item for item in receipt['artifacts'] if item['path'] == 'bin/fullmag-runtime-service']
        require(len(artifacts) == 1, 'Prepare native executable inventory differs')
        executable_sha, executable_size = hash_regular(executable, allow_readonly_hardlink=True)
        require(executable_sha == interruption['pins']['executable_sha256']
                and artifacts[0]['sha256'] == executable_sha and artifacts[0]['size'] == executable_size,
                'Prepare native executable differs')
        before_effects = verify_effects_snapshot(request, paths, native) if request.get('verify_only') is True else None
        import linux_native_probe
        # This probes and republishes admission for this actual existing backend
        # mount namespace; no prior backend/helper evidence is copied.
        fresh_probe = linux_native_probe.run(require_restart=True)
        probe_path = Path('/state/.linux-native-probe.json')
        probe_raw = linux_native_probe.read_regular(probe_path)
        require(json.loads(probe_raw) == fresh_probe, 'Fresh prepare probe readback differs')
        probe_sha = hashlib.sha256(probe_raw).hexdigest()
        result.update(storage_probe_path=str(probe_path), storage_probe_sha256=probe_sha)
        require(read(Path(request['guest_request_path'])) == raw, 'Prepare request changed before native call')
        command = [str(executable), '--prepare-claimed-interruption', '--config', str(paths.config),
                   '--request', request['guest_request_path'], '--request-sha256', request['request_sha256'],
                   '--storage-probe', str(probe_path), '--storage-probe-sha256', probe_sha]
        if request.get('verify_only') is True:
            command.append('--verify-only')
        # Native acquires startup/launch/owner and host->store locks itself.
        # Holding claimed_build_locks here would deadlock its lock hierarchy.
        invoked = True
        child = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        result.update(native_invoked=True, native_exit_code=child.returncode,
                      native_stdout_sha256=hashlib.sha256(child.stdout).hexdigest(),
                      native_stderr_sha256=hashlib.sha256(child.stderr).hexdigest())
        require(len(child.stdout) <= 256*1024 and len(child.stderr) <= 1024*1024, 'Native prepare output exceeds phase bound')
        if request.get('verify_only') is True:
            after_effects = verify_effects_snapshot(request, paths, native)
            require(before_effects == after_effects, 'Native verification changed retained effects')
            result.update(effects_before_sha256=digest_json(before_effects), effects_after_sha256=digest_json(after_effects))
        if child.returncode and request.get('verify_only') is True:
            result.update(state='verified-rejected', effects_known=True,
                          error=child.stderr.decode('utf-8', 'replace')[-4096:])
        elif child.returncode:
            result.update(state='native-error-process-exit-known', effects_known=False,
                          error=child.stderr.decode('utf-8', 'replace')[-4096:])
        else:
            value = json.loads(child.stdout)
            expected = (dict(status='verified_source_protocol', request_sha256=request['interruption_sha256'], mutated=False)
                        if request.get('verify_only') is True else
                        dict(status='prepared', request_sha256=request['interruption_sha256'], capacity_released=False))
            require(value == expected, 'Native prepare returned no exact typed acknowledgement')
            result.update(state='verified' if request.get('verify_only') is True else 'prepared',
                          effects_known=True, native_result=value)
    except BaseException as error:
        # A native invocation without a parsed, exact acknowledgement remains
        # uncertain. A nonzero process exit also leaves durable effects unknown.
        result.update(state='outcome-unknown-resources-retained' if invoked else 'preflight-error-confirmed',
                      effects_known=not invoked, error=str(error)[-4096:])
    backend._write_json(Path(request['result_path']), result, 'claimed interruption prepare phase acknowledgement')
    print(json.dumps(result, sort_keys=True), flush=True)
"""


def prepare_code():
    base = request_collector_code().rsplit('\ncollect_native(json.loads(sys.argv[1]))\n', 1)[0]
    return base + VERIFY_EFFECTS + PREPARE + '\nprepare_native(json.loads(sys.argv[1]))\n'


def validate_prepare_result(result, inputs):
    """Only an exact process acknowledgement can release the host operation."""
    repair.require(isinstance(result, dict) and result.get('schema_version') == 'fullmag.claimed-interruption-prepare-phase.v1'
                   and all(result.get(key) == inputs[key] for key in ('request_sha256', 'interruption_sha256',
                                                                      'backend_container_id', 'backend_started_at')),
                   'Prepare acknowledgement identity differs')
    repair.require(result.get('runtime_started') is False and result.get('container_stopped') is False
                   and result.get('capacity_released') is False, 'Prepare acknowledgement crosses lifecycle boundary')
    state = result.get('state')
    if state in {'prepared', 'verified'}:
        expected_state = 'verified' if inputs.get('verify_only') is True else 'prepared'
        expected_result = (dict(status='verified_source_protocol', request_sha256=inputs['interruption_sha256'], mutated=False)
                           if inputs.get('verify_only') is True else
                           dict(status='prepared', request_sha256=inputs['interruption_sha256'], capacity_released=False))
        repair.require(result.get('native_invoked') is True and type(result.get('native_exit_code')) is int
                       and result['native_exit_code'] == 0 and result.get('effects_known') is True and result.get('native_result') ==
                       expected_result and state == expected_state,
                       'Prepare has no exact typed native acknowledgement')
        repair.require(result.get('storage_probe_path') == '/state/.linux-native-probe.json'
                       and isinstance(result.get('storage_probe_sha256'), str)
                       and re.fullmatch(r'[0-9a-f]{64}', result['storage_probe_sha256']), 'Prepare has no fresh probe digest')
    elif state == 'verified-rejected':
        repair.require(inputs.get('verify_only') is True and inputs.get('diagnostic_api_only') is True
                       and isinstance(inputs.get('claimed_interruption_build'), dict)
                       and result.get('native_invoked') is True and type(result.get('native_exit_code')) is int
                       and result['native_exit_code'] != 0 and result.get('effects_known') is True
                       and isinstance(result.get('effects_before_sha256'), str)
                       and re.fullmatch(r'[0-9a-f]{64}', result['effects_before_sha256'])
                       and result.get('effects_after_sha256') == result['effects_before_sha256'],
                       'Read-only rejection lacks confirmed unchanged durable effects')
    elif state == 'native-error-process-exit-known':
        repair.require(result.get('native_invoked') is True and type(result.get('native_exit_code')) is int
                       and result['native_exit_code'] != 0 and result.get('effects_known') is False, 'Native error has no confirmed exit/effects boundary')
        raise BuildControlError('Native prepare process exited but durable effects are unknown; preserve operation lease and inspect exact request before any retry')
    elif state == 'preflight-error-confirmed':
        repair.require(result.get('native_invoked') is False and result.get('native_exit_code') is None,
                       'Preflight error cannot follow a native invocation')
    else:
        raise BuildControlError('Prepare outcome uncertain; preserve managed operation and native evidence')
    return state


def prepare_request(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_reconcile import fingerprint
    from docker_volume_unclaimed_cancellation import _json_object, _publish_immutable
    import docker_claimed_worker_interruption as pure
    require_host()
    for value, pattern in ((args.backend_container_id, r'[0-9a-f]{64}'), (args.image_id, r'sha256:[0-9a-f]{64}'),
                           (args.owner_sha256, r'[0-9a-f]{64}'), (args.process_receipt_sha256, r'[0-9a-f]{64}'),
                           (args.request_path, r'verification/claimed-interruption/[0-9a-f]{32}/request\.json'),
                           (args.request_sha256, r'[0-9a-f]{64}'),
                           (args.candidate_basename, r'\.backend-package-candidate-[A-Za-z0-9._-]+')):
        repair.require(isinstance(value, str) and re.fullmatch(pattern, value), 'Exact prepare request pins required')
    selected, layout = _select_source(Path(args.source_root), str(args.source_root))
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    repair.inspect_one('volume', control.volume)
    raw = control.read_bytes(args.request_path, maximum=256*1024)
    repair.require(hashlib.sha256(raw).hexdigest() == args.request_sha256, 'Prepare immutable request CAS differs')
    native = _json_object(raw, 'claimed interruption native request', maximum=256*1024)
    interruption = pure.validate_request(native['interruption'])
    repair.require(args.request_path == 'verification/claimed-interruption/'+interruption['request_id'].replace('-', '')+'/request.json',
                   'Prepare request UUID/path differs')
    before = repair.inspect_one('container', args.backend_container_id)
    repair.validate_backend(before, identity, args.backend_container_id, args.image_id)
    repair.require(interruption['container']['container_id'] == before['Id']
                   and interruption['container']['image_id'] == before['Image']
                   and interruption['container']['compose_project'] == control.project
                   and interruption['container_started_at'] == before['State']['StartedAt'], 'Prepare backend incarnation differs')
    inputs = {key: getattr(args, key) for key in ('backend_container_id', 'image_id', 'owner_sha256', 'process_receipt_sha256',
                                                'request_path', 'request_sha256', 'candidate_basename')}
    inputs.update(compose_project=control.project, source_root=str(selected), backend_started_at=before['State']['StartedAt'],
                  verify_only=args.phase == 'verify-prepare',
                  use_installed_package=bool(getattr(args, 'use_installed_package', False)),
                  interruption_sha256=pure.canonical_request_sha256(interruption),
                  guest_request_path=repair.backend_control_path(control.path(args.request_path)))
    if inputs['verify_only']:
        relative, digest = getattr(args, 'claimed_build_pin', None), getattr(args, 'claimed_build_pin_sha256', None)
        repair.require(isinstance(relative, str) and re.fullmatch(r'verification/claimed-interruption/[0-9a-f]{32}/build-pin\.json', relative)
                       and isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest),
                       'Verify requires immutable --claimed-build-pin and --claimed-build-pin-sha256')
        build_raw = control.read_bytes(relative, maximum=256*1024)
        repair.require(hashlib.sha256(build_raw).hexdigest() == digest, 'Verify claimed build pin CAS differs')
        build_pin = _json_object(build_raw, 'verify claimed build pin', maximum=256*1024)
        repair.require(build_pin.get('identity') == interruption['identity'], 'Verify build pin belongs to another claim')
        inputs.update(claimed_build_pin=relative, claimed_build_pin_sha256=digest,
                      claimed_interruption_build=build_pin, diagnostic_api_only=True)
    else:
        repair.require(not getattr(args, 'claimed_build_pin', None) and not getattr(args, 'claimed_build_pin_sha256', None),
                       'Claimed build authority is accepted only for verify-prepare')
    with control.operation('claimed-interruption-verify-prepare' if inputs['verify_only'] else 'claimed-interruption-prepare', inputs) as operation:
        repair.require(control.read_bytes(args.request_path, maximum=256*1024) == raw, 'Prepare control request changed')
        if inputs['verify_only']:
            repair.require(control.read_bytes(inputs['claimed_build_pin'], maximum=256*1024) == build_raw, 'Verify claimed build pin changed')
        fresh = repair.inspect_one('container', args.backend_container_id)
        repair.require(fingerprint(fresh) == fingerprint(before) and fresh['State']['StartedAt'] == inputs['backend_started_at']
                       and fresh['State']['Running'] is True, 'Prepare backend changed before invocation')
        inputs['result_path'] = repair.backend_control_path(control.path(operation['root']+'/phase-ack.json'))
        operation['daemon_pending'] = True
        # Nonzero transport must not be confused with a known native error. The
        # durable per-operation acknowledgement is the sole completion proof.
        docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B', '-c', prepare_code(),
                       json.dumps(inputs), timeout=300, allow_failure=True)
        result_raw = control.read_bytes(operation['root']+'/phase-ack.json', maximum=256*1024)
        result = _json_object(result_raw, 'claimed prepare phase acknowledgement', maximum=256*1024)
        _publish_immutable(control, operation['root']+'/phase-observation.json', canonical(result)+b'\n')
        operation['receipt']['prepare_observation'] = result
        state = validate_prepare_result(result, inputs)
        after = repair.inspect_one('container', args.backend_container_id)
        repair.require(fingerprint(after) == fingerprint(before) and after['State']['StartedAt'] == inputs['backend_started_at']
                       and after['State']['Running'] is True, 'Prepare backend changed before acknowledgement')
        _publish_immutable(control, operation['root']+'/result.json', canonical(result)+b'\n')
        operation['daemon_pending'] = False
        operation['receipt'].update(state='succeeded' if state in {'prepared', 'verified'} else 'failed-confirmed',
                                    prepare_result=result, request_path=args.request_path)
        if state not in {'prepared', 'verified'}:
            raise BuildControlError('Native prepare ended with '+state+'; retained records require review: '+result.get('error', ''))
        return dict(result, operation_root=operation['root'])

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['collect-build-pin', 'collect-request', 'prepare-request', 'verify-prepare'])
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--use-installed-package', action='store_true')
    for name in ('backend-container-id', 'image-id', 'process-receipt-sha256', 'owner-sha256'):
        parser.add_argument('--'+name, required=True)
    for name in ('collection-id', 'run-id', 'task-id', 'claimed-build-pin', 'claimed-build-pin-sha256', 'candidate-basename', 'candidate-receipt-sha256', 'request-id', 'request-path', 'request-sha256'):
        parser.add_argument('--'+name)
    args = parser.parse_args(argv)
    try:
        action = {'collect-build-pin': collect_build_pin, 'collect-request': collect_request,
                  'prepare-request': prepare_request, 'verify-prepare': prepare_request}[args.phase]
        print(json.dumps(action(args), sort_keys=True))
        return 0
    except (BuildControlError, ValueError, KeyError, OSError) as error:
        parser.exit(1, 'claimed-interruption: '+str(error)+'\n')


if __name__ == '__main__':
    raise SystemExit(main())
