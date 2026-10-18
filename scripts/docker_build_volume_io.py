"""Docker-managed build documents and Compose stdin transport.

This module deliberately does not implement os.PathLike: a volume URI must
never be reinterpreted as a Windows path by an existing host consumer.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time


class VolumeBuildError(RuntimeError):
    pass


class VolumeBuildOutcomeUnknown(VolumeBuildError):
    pass


class VolumeBuildTerminalError(VolumeBuildError):
    def __init__(self, message, exit_code):
        super().__init__(message)
        self.exit_code = exit_code


class BuildDocument:
    """Explicit bounded control-volume document, never a host filesystem path."""

    def __init__(self, store, relative):
        path = PurePosixPath(relative)
        if path.is_absolute() or not path.parts or any(p in {'', '.', '..'} for p in str(relative).split('/')):
            raise ValueError('Invalid build document relative path')
        self.store = store
        self.relative = path.as_posix()

    def __truediv__(self, child):
        return BuildDocument(self.store, self.relative + '/' + str(child))

    def __str__(self):
        return self.store.uri(self.relative)

    @property
    def name(self):
        return PurePosixPath(self.relative).name

    def read_bytes(self):
        return self.store.read_bytes(self.relative)

    def read_text(self, encoding='utf-8'):
        return self.read_bytes().decode(encoding)

    def write_bytes(self, data):
        return self.store.write_bytes(self.relative, data)

    def write_json(self, value):
        return self.store.write_json(self.relative, value)

    def exists(self):
        return self.store.stat(self.relative) is not None

    def is_file(self):
        return self.exists()

    def is_symlink(self):
        # Guest operations reject links in every component before returning.
        return False

    def open(self, mode='rb'):
        if mode != 'rb':
            raise ValueError('Use atomic write_bytes/write_json for build documents')
        return io.BytesIO(self.read_bytes())


def control_store(layout, source_root=None, *, helper_image=None):
    """Select an existing local immutable Python helper; never pull silently."""
    from docker_build_control import BuildControlStore
    from docker_compose_identity import compose_project_identity

    source = Path(source_root or layout['repo_root']).resolve(strict=True)
    identity = compose_project_identity(layout)
    reference = helper_image or os.environ.get('FULLMAG_BUILD_CONTROL_IMAGE', 'fullmag/development-base:local')
    result = subprocess.run(
        ['docker', '--context', 'desktop-linux', 'image', 'inspect', reference, '--format', '{{.Id}}'],
        capture_output=True, text=True, timeout=60, check=True,
    )
    image_id = result.stdout.strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise VolumeBuildError('Build control helper has no immutable local image identity')
    store = BuildControlStore(identity['project_name'], identity['worktree_id'], source, image_id)
    store.ensure()
    return store


def compose_capture(source_root, project, document, arguments, *, environment=None, timeout=120):
    """Render/run managed Compose from memory without a host generated file."""
    command = ['docker', '--context', 'desktop-linux', 'compose', '--project-name', project,
               '--project-directory', str(source_root), '-f', '-', *map(str, arguments)]
    try:
        result = subprocess.run(command, input=json.dumps(document), text=True, capture_output=True,
                                env={**os.environ, **(environment or {})}, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise VolumeBuildOutcomeUnknown('Compose client timed out; daemon outcome requires reconciliation') from error
    if result.returncode:
        raise VolumeBuildError(result.stderr.strip() or result.stdout.strip() or 'Compose operation failed')
    return result.stdout


def compose_build(source_root, project, document, service, log_document, *, environment=None):
    """Drain a mutating BuildKit operation to terminal exit, retaining bounded chunks in Docker."""
    command = ['docker', '--context', 'desktop-linux', 'compose', '--project-name', project,
               '--project-directory', str(source_root), '-f', '-', 'build', '--pull=false', service]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, env={**os.environ, **(environment or {})})
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(json.dumps(document).encode('utf-8'))
    process.stdin.close()
    chunks = []
    interrupted = False
    buffer = bytearray()
    persistence_error = None

    def publish(raw):
        nonlocal persistence_error
        relative = log_document.relative + f'.chunks/{len(chunks):08d}.log'
        try:
            log_document.store.write_bytes(relative, raw)
            chunks.append({'path': relative, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
        except Exception as error:
            # Keep observing the actual build even if recording fails. Never
            # release the lease or retry a mutating operation on client failure.
            persistence_error = error

    while True:
        try:
            block = process.stdout.read1(65536)
        except KeyboardInterrupt:
            interrupted = True
            continue
        if not block:
            break
        sys.stdout.write(block.decode('utf-8', 'replace'))
        sys.stdout.flush()
        buffer.extend(block)
        if len(buffer) >= 1024 * 1024:
            publish(bytes(buffer))
            buffer.clear()
    if buffer:
        publish(bytes(buffer))
    while True:
        try:
            code = process.wait()
            break
        except KeyboardInterrupt:
            interrupted = True
    log_document.write_json({'schema': 'fullmag.compose-build-log.v1', 'compose_project': project,
                             'service': service, 'exit_code': code, 'chunks': chunks,
                             'interrupted': interrupted, 'finished_at': time.time()})
    if persistence_error:
        raise VolumeBuildTerminalError('Build terminated but its Docker log could not be fully retained', code) from persistence_error
    if code or interrupted:
        raise VolumeBuildTerminalError(f'Compose build terminal exit {code}; interrupted={interrupted}; data retained', code)
