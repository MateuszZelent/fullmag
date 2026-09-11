#!/usr/bin/env python3
"""Host-local client. Execution and GitHub ingress require a trusted coordinator.

This CLI uses the current OS user's filesystem permissions, not an HTTP API.
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
from local_runner.coordinator import CoordinatorError, acknowledge_uncreated, configure_image, configured_image, execute_once, reconcile


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', '--worktree', dest='repo_root', default=str(Path(__file__).resolve().parents[1]))
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('list')
    sub.add_parser('doctor')
    execute = sub.add_parser('run-once')
    execute.add_argument('--cpus', type=float, default=2)
    execute.add_argument('--memory-mib', type=int, default=1024)
    configure = sub.add_parser('configure-image')
    configure.add_argument('--image-id', required=True)
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
    submit.add_argument('--operation', choices=('verify-source',), default='verify-source')
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
        if args.action == 'doctor':
            from local_runner.doctor import inspect_host
            result = inspect_host(layout)
        elif args.action == 'run-once':
            result = execute_once(layout, owner=owner, image_digest=configured_image(layout, owner),
                                  cpus=args.cpus, memory_bytes=args.memory_mib * 1024**2)
        elif args.action == 'configure-image':
            result = configure_image(layout, args.image_id, owner=owner)
        elif args.action == 'acknowledge-uncreated':
            result = acknowledge_uncreated(layout, args.job_id, owner=owner, reason=args.reason)
        elif args.action == 'reconcile':
            result = reconcile(layout, args.job_id, owner=owner)
        elif args.action == 'submit':
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
                destination.mkdir(parents=True, exist_ok=False)
                manifest = capture_source(Path(layout['repo_root']), destination,
                                          mode=args.source, ref=args.ref,
                                          include_untracked=tuple(args.include_untracked))
            queue = JobQueue(db_path)
            result = queue.submit(owner=owner, worktree_id=layout['worktree_id'],
                source_digest=manifest['source_digest'], profile='source-verification-v1',
                operation=args.operation, request_key=args.request_key or uuid.uuid4().hex,
                identity_payload={'source_mode': args.source, 'origin_repo': layout['repo_root']},
                payload={'source_mode': args.source, 'capsule_relative': destination.relative_to(storage).as_posix(),
                         'origin_repo': layout['repo_root'], 'capture_id': capture_id})
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
                        raise QueueError('No collected worker log yet; inspect job state or reconcile after termination')
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
        return 0
    except (StorageError, QueueError, SourceError, CoordinatorError, OSError, ValueError, sqlite3.Error) as error:
        print(f'local-runner: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
