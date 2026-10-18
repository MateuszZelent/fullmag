#!/usr/bin/env python3
"""Host-local client. Execution and GitHub ingress require a trusted coordinator.

After container enrollment, this CLI submits through the authenticated local API.
It never accepts a Docker mount or an arbitrary shell command from a job.
"""
import argparse
import getpass
import json
import re
import sqlite3
from pathlib import Path
import sys
import time
import uuid

from fullmag_storage import StorageError, build_lock, initialize, resolve_layout, validate_path
from local_runner.queue import JobQueue, QueueError
from local_runner.source import SourceError
from local_runner.container_client import ContainerClientError, CATALOG_PROFILES
from local_runner.coordinator import CoordinatorError, acknowledge_uncreated, configure_image, configured_image, execute_once, reconcile


def read_untracked_manifest(path):
    """Read explicit source selections once; capture_source owns path policy."""
    file = Path(path)
    if not file.is_file():
        raise SourceError('Untracked manifest must be a regular JSON file')
    with file.open('rb') as stream:
        body = stream.read(65537)
    if not body or len(body) > 65536:
        raise SourceError('Untracked manifest must contain 1..65536 bytes')
    try:
        paths = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise SourceError('Untracked manifest must be a UTF-8 JSON array') from error
    if not isinstance(paths, list) or len(paths) > 1024 or any(
        not isinstance(path, str) or not path or '\x00' in path for path in paths
    ):
        raise SourceError('Untracked manifest requires at most 1024 nonempty paths')
    if len(set(paths)) != len(paths):
        raise SourceError('Untracked manifest paths must be unique')
    return paths


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', '--worktree', dest='repo_root', default=str(Path(__file__).resolve().parents[1]))
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('list')
    sub.add_parser('doctor')
    sub.add_parser('retention-plan')
    preview = sub.add_parser('retention-preview')
    preview.add_argument('--scope', choices=('execution', 'sources', 'runtime'), default='execution')
    preview.add_argument('--job-id', action='append', default=None)
    for action in ('retention-get', 'retention-apply', 'retention-cancel'):
        command = sub.add_parser(action)
        command.add_argument('plan_id')
    container_config = sub.add_parser('container-configure')
    container_config.add_argument('--image-id', required=True)
    container_config.add_argument('--port', type=int, default=None)
    profile_activation = container_config.add_mutually_exclusive_group()
    profile_activation.add_argument('--enable-current-contracts', action='store_true')
    profile_activation.add_argument('--enable-slepc-modal', action='store_true')
    profile_activation.add_argument('--enable-slepc-runtime-v2', action='store_true')
    container_config.add_argument('--enable-boris-cpu', action='store_true')
    reconcile_profiles = sub.add_parser('container-reconcile-desired-profiles')
    for flag in ('container-id', 'image-id', 'public-sha256', 'catalog-sha256', 'observed-sha256', 'instance-id'):
        reconcile_profiles.add_argument('--expected-' + flag, required=True)
    disable_boris = sub.add_parser('container-disable-boris-cpu')
    disable_boris.add_argument('--expected-container-sha256', required=True)
    disable_boris.add_argument('--expected-build-config-sha256', required=True)
    disable_boris.add_argument('--expected-boris-entry-sha256', required=True)
    recovery_boris = sub.add_parser('container-recover-boris-profile')
    recovery_boris.add_argument('--transaction-id', required=True)
    recovery_boris.add_argument('--direction', choices=('before', 'after'), required=True)
    quiesce = sub.add_parser('container-quiesce')
    quiesce.add_argument('--expected-container-id', required=True)
    quiesce.add_argument('--expected-image-id', required=True)
    quiesce.add_argument('--expected-public-sha256', required=True)
    quiesce.add_argument('--expected-catalog-sha256', required=True)
    quiesce.add_argument('--reviewed-source-sha256', action='append', required=True,
                         metavar='PATH=SHA256')
    exited = sub.add_parser('container-replace-exited')
    for flag in ('quiesce-receipt','quiesce-receipt-sha256','expected-container-id','expected-image-id',
                 'expected-container-sha256','expected-build-config-sha256','image-id','image-build-receipt','image-build-receipt-sha256'):
        exited.add_argument('--'+flag, required=True)
    exited.add_argument('--profile-delta', choices=('unchanged','enable-boris-cpu','disable-boris-cpu'), default='unchanged')
    exited.add_argument('--expected-boris-entry-sha256')
    recovery_exited = sub.add_parser('container-recover-exited-replacement')
    recovery_exited.add_argument('--transaction-id', required=True)
    recovery_exited.add_argument('--expected-new-container-id')
    replacement = sub.add_parser('container-replace')
    replacement.add_argument('--image-id', required=True)
    replacement.add_argument('--abandon-readonly-preview', default=None)
    sub.add_parser('container-resume')
    for command in ('container-start', 'container-status', 'container-stop'):
        sub.add_parser(command)
    execute = sub.add_parser('run-once')
    execute.add_argument('--cpus', type=float, default=2)
    execute.add_argument('--memory-mib', type=int, default=1024)
    configure = sub.add_parser('configure-image')
    configure.add_argument('--image-id', required=True)
    build_config = sub.add_parser('configure-build')
    build_config.add_argument('--profile', choices=CATALOG_PROFILES, required=True)
    build_config.add_argument('--image-id', required=True)
    build_config.add_argument('--cpus', type=float, default=2)
    build_config.add_argument('--memory-mib', type=int, default=8192)
    recover = sub.add_parser('acknowledge-uncreated', help='Operator only: confirm rejected create and finished submitting process')
    recover.add_argument('job_id')
    recover.add_argument('--reason', required=True)
    recover.add_argument('--confirm-no-create-request-in-flight', required=True, action='store_true')
    for action in ('status', 'cancel', 'reconcile', 'logs', 'wait'):
        command = sub.add_parser(action)
        command.add_argument('job_id')
        if action == 'wait':
            command.add_argument('--timeout-seconds', type=float, default=30)
    submit = sub.add_parser('submit')
    submit.add_argument('--source', choices=('commit', 'snapshot'), required=True)
    submit.add_argument('--ref')
    submit.add_argument('--include-untracked', action='append', default=[])
    submit.add_argument('--include-untracked-from', metavar='JSON_FILE')
    submit.add_argument('--request-key', default=None)
    # Do not advertise build/qualification until the corresponding executor is verified.
    submit.add_argument('--operation', choices=('verify-source', 'build'), default='verify-source')
    submit.add_argument('--profile', choices=CATALOG_PROFILES)
    args = parser.parse_args(argv)
    try:
        layout = resolve_layout(args.repo_root, 'windows-native')
        storage = Path(layout['storage_root'])
        db_path = validate_path(storage / 'index' / 'runner-jobs.sqlite', storage, 'runner database')
        if args.action == 'list' and not db_path.exists():
            print('[]')
            return 0
        if args.action in ('status', 'cancel', 'reconcile', 'logs', 'wait') and not db_path.exists():
            raise QueueError('No runner jobs have been submitted')
        owner = getpass.getuser()
        container_mode = (storage / 'index' / 'local-runner-container.json').exists()
        if args.action in ('retention-preview', 'retention-get', 'retention-apply', 'retention-cancel'):
            if not container_mode:
                raise QueueError('Maintenance requires the container coordinator')
            from local_runner.container_client import request
            if args.action == 'retention-preview':
                payload = {'scope': args.scope}
                if args.job_id is not None:
                    payload['job_ids'] = args.job_id
                result = request(layout, owner=owner, method='POST', path='/api/v1/retention/plans', payload=payload)
                if result.get('scope') != args.scope:
                    raise QueueError('Coordinator did not acknowledge the requested maintenance scope')
            else:
                if re.fullmatch(r'plan-[a-f0-9]{8,32}', args.plan_id) is None:
                    raise QueueError('Invalid maintenance plan ID')
                path = '/api/v1/retention/plans/' + args.plan_id
                if args.action == 'retention-apply':
                    path += '/apply'
                elif args.action == 'retention-cancel':
                    path += '/cancel'
                mutation = args.action in ('retention-apply', 'retention-cancel')
                result = request(layout, owner=owner, method='POST' if mutation else 'GET',
                                 path=path, payload={} if mutation else None)
        elif args.action == 'retention-plan':
            if not container_mode:
                raise QueueError('Retention inventory requires the container coordinator')
            from local_runner.container_client import request
            result = request(layout, owner=owner, method='GET', path='/retention')
        elif args.action.startswith('container-'):
            from local_runner import container_client
            if args.action == 'container-configure':
                result = container_client.configure(
                    layout,
                    args.image_id,
                    owner=owner,
                    port=args.port,
                    enable_current_contracts=args.enable_current_contracts,
                    enable_slepc_modal=args.enable_slepc_modal,
                    enable_boris_cpu=args.enable_boris_cpu,
                    enable_slepc_runtime_v2=args.enable_slepc_runtime_v2,
                )
            elif args.action == 'container-reconcile-desired-profiles':
                from local_runner.boris_transition import reconcile_desired
                result = reconcile_desired(layout, owner, **{
                    'expected_' + key: getattr(args, 'expected_' + key) for key in
                    ('container_id', 'image_id', 'public_sha256', 'catalog_sha256', 'observed_sha256', 'instance_id')})
            elif args.action == 'container-disable-boris-cpu':
                result = container_client.disable_boris_cpu(
                    layout, owner, args.expected_container_sha256,
                    args.expected_build_config_sha256, args.expected_boris_entry_sha256)
            elif args.action == 'container-recover-boris-profile':
                result = container_client.recover_boris_profile(
                    layout, owner, args.transaction_id, args.direction)
            elif args.action == 'container-quiesce':
                from local_runner.coordinator_lifecycle import quiesce_and_stop
                reviewed = {}
                for entry in args.reviewed_source_sha256:
                    parts = entry.split('=', 1)
                    if len(parts) != 2 or parts[0] in reviewed:
                        raise ContainerClientError('Unique reviewed source PATH=SHA256 entries are required')
                    reviewed[parts[0]] = parts[1]
                result = quiesce_and_stop(
                    layout, owner, expected_container_id=args.expected_container_id,
                    expected_image_id=args.expected_image_id,
                    expected_public_sha256=args.expected_public_sha256,
                    expected_catalog_sha256=args.expected_catalog_sha256,
                    expected_source_hashes=reviewed)
            elif args.action == 'container-replace-exited':
                keys = ('quiesce_receipt','quiesce_receipt_sha256','expected_container_id','expected_image_id',
                        'expected_container_sha256','expected_build_config_sha256','image_id','image_build_receipt',
                        'image_build_receipt_sha256','profile_delta','expected_boris_entry_sha256')
                result = container_client.replace_exited(layout, owner, **{key:getattr(args,key) for key in keys})
            elif args.action == 'container-recover-exited-replacement':
                result = container_client.recover_exited_replacement(layout, owner, args.transaction_id,
                    expected_new_container_id=args.expected_new_container_id)
            elif args.action == 'container-replace':
                options = ({'abandon_readonly_preview': args.abandon_readonly_preview}
                           if args.abandon_readonly_preview is not None else {})
                result = container_client.replace(layout, args.image_id, owner=owner, **options)
            elif args.action == 'container-resume':
                result = container_client.request(layout, owner=owner, method='POST', path='/resume', payload={})
            elif args.action == 'container-start':
                result = container_client.start(layout, owner=owner)
            elif args.action == 'container-status':
                result = container_client.status(layout, owner=owner)
            else:
                result = container_client.request(layout, owner=owner, method='POST', path='/stop', payload={})
        elif container_mode and args.action in ('run-once', 'reconcile', 'acknowledge-uncreated'):
            raise QueueError('The container coordinator owns execution and recovery; use runner-container-status')
        elif container_mode and args.action in ('list', 'status', 'logs', 'wait', 'cancel'):
            from local_runner.container_client import request
            path = '/jobs' if args.action == 'list' else '/jobs/' + args.job_id
            if args.action == 'logs': path += '/logs'
            if args.action == 'cancel': path += '/cancel'
            result = request(layout, owner=owner, method='POST' if args.action == 'cancel' else 'GET', path=path,
                             payload={} if args.action == 'cancel' else None)
            if args.action == 'wait':
                if not 0 <= args.timeout_seconds <= 3600:
                    raise QueueError('Wait timeout must be 0..3600 seconds')
                deadline = time.monotonic() + args.timeout_seconds
                while result['state'] in ('queued', 'running', 'cancel_requested') and time.monotonic() < deadline:
                    time.sleep(1)
                    result = request(layout, owner=owner, method='GET', path=path)
                print(json.dumps(result, indent=2))
                return 0 if result['state'] == 'succeeded' else (124 if result['state'] in ('queued', 'running', 'cancel_requested') else 1)
        elif args.action == 'doctor':
            from local_runner.doctor import inspect_host
            result = inspect_host(layout)
        elif args.action == 'run-once':
            from local_runner.dispatch import execute_next
            result = execute_next(layout, owner)
        elif args.action == 'configure-build':
            from local_runner.build_executor import configure_build
            result = configure_build(layout, args.profile, args.image_id, owner=owner,
                                     cpus=args.cpus, memory_bytes=args.memory_mib * 1024**2)
        elif args.action == 'configure-image':
            result = configure_image(layout, args.image_id, owner=owner)
        elif args.action == 'acknowledge-uncreated':
            result = acknowledge_uncreated(layout, args.job_id, owner=owner, reason=args.reason)
        elif args.action == 'reconcile':
            from local_runner.dispatch import recover
            result = recover(layout, args.job_id, owner)
        elif args.action == 'submit':
            if container_mode:
                if args.operation != 'build':
                    raise QueueError('Container coordinator accepts builds; use runner-build')
                from local_runner.build_executor import configured_build
                configured_build(layout, owner, args.profile)
            if (args.operation == 'build') != bool(args.profile):
                raise QueueError('Build requires a profile; verify-source does not accept one')
            if args.source == 'commit' and not args.ref:
                raise QueueError('commit source requires --ref; dirty files are not included')
            if args.source == 'snapshot' and args.ref:
                raise QueueError('snapshot source cannot accept --ref')
            if args.include_untracked_from and args.source != 'snapshot':
                raise QueueError('Untracked manifest requires snapshot source')
            included = list(args.include_untracked)
            if args.include_untracked_from:
                included.extend(read_untracked_manifest(args.include_untracked_from))
            from local_runner.source import capture_source
            initialize(layout)
            capture_id = uuid.uuid4().hex
            destination = validate_path(storage / 'runs' / layout['worktree_id'] / capture_id / 'source',
                                        storage, 'source capsule')
            # Existing managed writers and captures of this worktree cannot overlap.
            # Editors must still pause writes during capture; the source module detects races.
            with build_lock(layout):
                from local_runner.build_source import native_identity, bind_identity
                native = native_identity(Path(layout['repo_root']), 'snapshot') if args.operation == 'build' and args.source == 'snapshot' else None
                destination.mkdir(parents=True, exist_ok=False)
                manifest = capture_source(Path(layout['repo_root']), destination,
                                          mode=args.source, ref=args.ref,
                                          include_untracked=tuple(included),
                                          content_store=validate_path(
                                              storage / 'cache' / 'source-content-v1',
                                              storage,
                                              'source content store'))
                if args.operation == 'build':
                    final_native = native_identity(Path(layout['repo_root']), args.source, manifest['resolved_commit'])
                    if native is not None and native != final_native:
                        raise QueueError('Native source identity changed during capsule capture')
                    native = bind_identity(final_native, manifest)
            submitted = dict(worktree_id=layout['worktree_id'],
                source_digest=manifest['source_digest'], profile=args.profile or 'source-verification-v1',
                operation=args.operation, request_key=args.request_key or uuid.uuid4().hex,
                payload={'source_mode': args.source, 'capsule_relative': destination.relative_to(storage).as_posix(),
                         'origin_repo': layout['repo_root'], 'capture_id': capture_id,
                         **({'native_source_identity': native} if native is not None else {})})
            if container_mode:
                from local_runner.container_client import request
                result = request(layout, owner=owner, method='POST', path='/jobs', payload=submitted)
            else:
                queue = JobQueue(db_path)
                result = queue.submit(owner=owner, **submitted,
                    identity_payload={'source_mode': args.source, 'origin_repo': layout['repo_root']})
        else:
            queue = JobQueue(db_path, readonly=args.action in ('list', 'status', 'logs', 'wait'))
            if args.action == 'list':
                result = queue.list(owner=owner)
            elif args.action in ('status', 'logs', 'wait'):
                result = queue.get(args.job_id)
                if result['owner'] != owner:
                    raise QueueError('Job owner mismatch')
                if args.action == 'logs':
                    path = validate_path(storage / 'runs' / result['worktree_id'] / result['job_id'] / 'worker.log', storage)
                    if not path.exists():
                        from local_runner.coordinator import docker, inspect_owned
                        journal_path = validate_path(path.parent / 'coordinator.json', storage)
                        journal = json.loads(journal_path.read_text())
                        if journal.get('job_id') != args.job_id or journal.get('owner') != owner:
                            raise QueueError('Log journal identity mismatch')
                        inspect_owned(docker, journal['container_id'], args.job_id)
                        result = {'job_id': args.job_id, 'tail': docker(['logs', '--tail', '300', journal['container_id']])}
                    else:
                        with path.open('rb') as stream:
                            stream.seek(max(0, path.stat().st_size - 65536))
                            result = {'job_id': args.job_id, 'tail': stream.read(65536).decode('utf-8', errors='replace')}
                elif args.action == 'wait':
                    if not 0 <= args.timeout_seconds <= 3600:
                        raise QueueError('Wait timeout must be 0..3600 seconds')
                    deadline = time.monotonic() + args.timeout_seconds
                    while result['state'] in ('queued', 'running', 'cancel_requested') and time.monotonic() < deadline:
                        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
                        result = queue.get(args.job_id)
                    print(json.dumps(result, indent=2))
                    return 0 if result['state'] == 'succeeded' else (124 if result['state'] in ('queued', 'running', 'cancel_requested') else 1)
            else:
                queue.cancel(args.job_id, owner)
                result = queue.get(args.job_id)
        print(json.dumps(result, indent=2))
        if args.action == 'retention-cancel':
            status = result.get('status')
            if status == 'cancelled':
                return 0
            if status == 'cancel_requested':
                return 124
            return 1
        if args.action in ('retention-preview', 'retention-apply') and result.get('status') in (
                'blocked', 'failed', 'partial', 'interrupted_unknown'):
            return 1
        if args.action == 'run-once' and result is not None and result.get('state') != 'succeeded':
            return 1
        return 0
    except (StorageError, QueueError, SourceError, CoordinatorError, ContainerClientError, OSError, ValueError, sqlite3.Error) as error:
        print(f'local-runner: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
