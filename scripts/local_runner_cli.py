#!/usr/bin/env python3
"""Host-local client. Execution and GitHub ingress require a trusted coordinator.

After container enrollment, this CLI submits through the authenticated local API.
It never accepts a Docker mount or an arbitrary shell command from a job.
"""
import argparse
import getpass
import json
import sqlite3
from pathlib import Path
import sys
import time
import uuid

from fullmag_storage import StorageError, build_lock, initialize, resolve_layout, validate_path
from local_runner.queue import JobQueue, QueueError
from local_runner.source import SourceError
from local_runner.container_client import ContainerClientError
from local_runner.coordinator import CoordinatorError, acknowledge_uncreated, configure_image, configured_image, execute_once, reconcile


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', '--worktree', dest='repo_root', default=str(Path(__file__).resolve().parents[1]))
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('list')
    sub.add_parser('doctor')
    sub.add_parser('retention-plan')
    container_config = sub.add_parser('container-configure')
    container_config.add_argument('--image-id', required=True)
    replacement = sub.add_parser('container-replace')
    replacement.add_argument('--image-id', required=True)
    sub.add_parser('container-resume')
    for command in ('container-start', 'container-status', 'container-stop'):
        sub.add_parser(command)
    execute = sub.add_parser('run-once')
    execute.add_argument('--cpus', type=float, default=2)
    execute.add_argument('--memory-mib', type=int, default=1024)
    configure = sub.add_parser('configure-image')
    configure.add_argument('--image-id', required=True)
    build_config = sub.add_parser('configure-build')
    build_config.add_argument('--profile', required=True)
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
    submit.add_argument('--request-key', default=None)
    # Do not advertise build/qualification until the corresponding executor is verified.
    submit.add_argument('--operation', choices=('verify-source', 'build'), default='verify-source')
    submit.add_argument('--profile', choices=('fem-cpu-release', 'fem-gpu-release', 'fdm-cpu-release'))
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
        if args.action == 'retention-plan':
            if not container_mode:
                raise QueueError('Retention inventory requires the container coordinator')
            from local_runner.container_client import request
            result = request(layout, owner=owner, method='GET', path='/retention')
        elif args.action.startswith('container-'):
            from local_runner import container_client
            if args.action == 'container-configure':
                result = container_client.configure(layout, args.image_id, owner=owner)
            elif args.action == 'container-replace':
                result = container_client.replace(layout, args.image_id, owner=owner)
            elif args.action == 'container-resume':
                result = container_client.request(layout, owner=owner, method='POST', path='/resume', payload={})
            elif args.action == 'container-start':
                result = container_client.start(layout, owner=owner)
            elif args.action == 'container-status':
                result = container_client.status(layout, owner=owner)
                if result['running']:
                    try:
                        result['health'] = container_client.request(layout, owner=owner, method='GET', path='/health')
                    except ContainerClientError as error:
                        result['health'] = {'ok': False, 'error': str(error)}
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
                                          include_untracked=tuple(args.include_untracked))
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
        if args.action == 'run-once' and result is not None and result.get('state') != 'succeeded':
            return 1
        return 0
    except (StorageError, QueueError, SourceError, CoordinatorError, ContainerClientError, OSError, ValueError, sqlite3.Error) as error:
        print(f'local-runner: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
