"""Reconcile one omitted private cache volume for a completed Fullmag task.

This is deliberately narrower than garbage collection. It authenticates the
canonical completed-task registry, the immutable worktree-retirement evidence,
the archived backend-package labels, and the current Docker/control state. It
never targets control, ledger, frontend, shared, or arbitrary volumes.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import Any, Mapping


SCHEMA = "fullmag.docker-completed-cache-reconciliation.v1"
PLAN_SCHEMA = "fullmag.docker-completed-cache-reconciliation-plan.v1"
INTENT_SCHEMA = "fullmag.docker-completed-cache-reconciliation-intent.v1"
RECEIPT_SCHEMA = "fullmag.docker-completed-cache-reconciliation.v1"
RETIREMENT_PLAN_SCHEMA = "fullmag.docker-cache-retirement-plan.v1"
RETIREMENT_RESULT_SCHEMA = "fullmag.docker-cache-retirement.v1"
RETIREMENT_CLOSING_SCHEMA = "fullmag.docker-cache-retirement-closing.v1"
PLAN_PATH = "cache-retirement/plan.json"
RESULT_PATH = "cache-retirement/result.json"
CLOSING_PATH = "cache-retirement/closing.json"
GROUP_STORAGE_PATH = "backend/group-storage.json"
GROUP_OWNER_PATH = "private/.owner.json"
MAX_INDEX_RECORDS = 4096
MAX_INDEX_RECORD_BYTES = 2 * 1024 * 1024
MAX_CONTROL_RECORD_BYTES = 8 * 1024 * 1024
_SHA = re.compile(r"^[0-9a-f]{64}$")
_GIT_SHA = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
_RECOVERY_ID = re.compile(r"^[0-9a-f]{32}$")
_VOLUME = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,199}$")
_IMAGE = re.compile(r"^(?:[^\s]+@sha256:[0-9a-f]{64}|sha256:[0-9a-f]{64})$")


class CompletedCacheReconcileError(RuntimeError):
    """A completed-cache target or its safety evidence could not be proven."""


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def plan_sha256(plan: Mapping[str, Any]) -> str:
    """Hash a plan without its display-only digest field."""
    body = dict(plan)
    body.pop("plan_sha256", None)
    return hashlib.sha256(_canonical(body)).hexdigest()


def _duplicate_rejector(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _json(raw: bytes, label: str) -> dict[str, Any]:
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_CONTROL_RECORD_BYTES:
        raise CompletedCacheReconcileError(f"{label} is missing or outside its byte limit")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_duplicate_rejector)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise CompletedCacheReconcileError(f"{label} is not unambiguous JSON") from error
    if not isinstance(value, dict):
        raise CompletedCacheReconcileError(f"{label} must be a JSON object")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CompletedCacheReconcileError(f"{label} is missing or malformed")
    return value


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _safe_abs_path(value: Any, label: str) -> Path:
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise CompletedCacheReconcileError(f"{label} must be an absolute path")
    path = Path(os.path.normpath(value))
    if str(path) != value or ".." in Path(value).parts:
        raise CompletedCacheReconcileError(f"{label} is not canonical")
    return path


def _storage_identifier(path: str | os.PathLike[str]) -> str:
    import fullmag_storage

    return fullmag_storage.identifier(path)


def _probe(args: Any):
    provided = getattr(args, "probe", None)
    return provided if provided is not None else _DockerProbe()


def _container_safety_projection(document):
    """Pin consumer identity and safety state, excluding healthcheck telemetry."""
    state = document.get("State", {})
    return {
        key: document.get(key) for key in ("Id", "Name", "Image", "Created", "Mounts")
    } | {
        "labels": document.get("Config", {}).get("Labels"),
        "state": {key: state.get(key) for key in (
            "Status", "Running", "Paused", "Restarting", "OOMKilled", "Dead",
            "Pid", "ExitCode", "Error", "StartedAt", "FinishedAt",
        )},
    }


def _reference_metadata(storage, roots):
    """Snapshot bounded JSON consumer metadata using directory-relative nofollow IO.

    Walk only canonical consumer roots from runtime retention, plus the index.
    Do not follow symlinks, skip on unreadable metadata, or infer legacy coverage.
    """
    entries_seen = files_seen = bytes_seen = 0
    documents = {}
    flags = os.O_RDONLY | os.O_NOFOLLOW

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)

    def walk(descriptor, relative, depth):
        nonlocal entries_seen, files_seen, bytes_seen
        if depth > 32:
            raise CompletedCacheReconcileError(f"Reference metadata depth limit exceeded: {relative}")
        before = os.fstat(descriptor)
        with os.scandir(descriptor) as stream:
            names = []
            for entry in stream:
                entries_seen += 1
                if entries_seen > 100000:
                    raise CompletedCacheReconcileError("Reference metadata entry limit exceeded")
                names.append(entry.name)
        for name in sorted(names):
            path = relative / name
            info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise CompletedCacheReconcileError(f"Unsafe symlink in reference metadata: {path}")
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, flags | os.O_DIRECTORY, dir_fd=descriptor)
                try:
                    if identity(os.fstat(child)) != identity(info):
                        raise CompletedCacheReconcileError(f"Reference directory changed: {path}")
                    walk(child, path, depth + 1)
                finally:
                    os.close(child)
            elif name.lower().endswith(".json"):
                files_seen += 1
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or info.st_size > MAX_INDEX_RECORD_BYTES or files_seen > 20000):
                    raise CompletedCacheReconcileError(f"Invalid or oversized reference metadata: {path}")
                child = os.open(name, flags, dir_fd=descriptor)
                with os.fdopen(child, "rb") as stream:
                    if identity(os.fstat(stream.fileno())) != identity(info):
                        raise CompletedCacheReconcileError(f"Reference metadata changed: {path}")
                    raw = stream.read(MAX_INDEX_RECORD_BYTES + 1)
                    after = os.fstat(stream.fileno())
                bytes_seen += len(raw)
                if len(raw) > MAX_INDEX_RECORD_BYTES or bytes_seen > 64 * 1024 * 1024:
                    raise CompletedCacheReconcileError("Reference metadata byte limit exceeded")
                if identity(after) != identity(info):
                    raise CompletedCacheReconcileError(f"Reference metadata changed: {path}")
                _json(raw, f"Reference metadata {path}")
                documents[str(path)] = raw
        if identity(os.fstat(descriptor)) != identity(before):
            raise CompletedCacheReconcileError(f"Reference directory changed during snapshot: {relative}")

    try:
        # Open each component relative to the pinned storage descriptor so a
        # substituted parent cannot redirect reads to a different filesystem.
        storage_fd = os.open(storage, flags | os.O_DIRECTORY)
        try:
            for root in sorted(set(roots)):
                relative = root.relative_to(storage)
                descriptor = os.dup(storage_fd)
                try:
                    for component in relative.parts:
                        child = os.open(component, flags | os.O_DIRECTORY, dir_fd=descriptor)
                        os.close(descriptor)
                        descriptor = child
                    walk(descriptor, relative, 0)
                finally:
                    os.close(descriptor)
        finally:
            os.close(storage_fd)
    except (OSError, ValueError) as error:
        raise CompletedCacheReconcileError(f"Cannot prove reference metadata coverage: {error}") from error
    return documents


class _DockerProbe:
    """Production adapters; tests inject a bounded fake probe instead."""

    def resolve_layout(self, repo_root):
        import fullmag_storage

        return fullmag_storage.resolve_layout(repo_root)

    def read_registry(self, path, layout):
        import fullmag_storage

        candidate = fullmag_storage.validate_path(path, layout["storage_root"], "task registry")
        if candidate != Path(layout["storage_root"]) / "index" / candidate.name:
            raise CompletedCacheReconcileError("Registry must be a canonical file under storage/index")
        info = candidate.lstat()
        if not candidate.is_file() or candidate.is_symlink() or info.st_nlink != 1 or info.st_size > MAX_INDEX_RECORD_BYTES:
            raise CompletedCacheReconcileError("Canonical task registry is not a bounded regular file")
        raw = candidate.read_bytes()
        return raw, _json(raw, "Canonical task registry")

    def main_checkout(self, layout):
        import fullmag_storage

        records = fullmag_storage.worktree_records(layout["repo_root"])
        if not records or not isinstance(records[0].get("worktree"), str):
            raise CompletedCacheReconcileError("Executor has no registered main checkout")
        return Path(records[0]["worktree"]).resolve()

    def merge_is_ancestor(self, main_checkout, merge_sha):
        result = subprocess.run(
            ["git", "-C", str(main_checkout), "merge-base", "--is-ancestor", merge_sha, "refs/heads/master"],
            capture_output=True,
        )
        return result.returncode == 0

    def helper_image(self, repo_root, identity):
        from docker_build_control import docker_capture, toolchain_configuration

        configuration = toolchain_configuration(repo_root, identity)
        try:
            image = configuration["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
        except (KeyError, TypeError) as error:
            raise CompletedCacheReconcileError("Executor has no pinned BuildControl helper image") from error
        if not isinstance(image, str) or _IMAGE.fullmatch(image) is None:
            raise CompletedCacheReconcileError("BuildControl helper image is not immutable")
        inspected = docker_capture("image", "inspect", "--format", "{{.Id}}", image, allow_failure=True)
        if inspected.returncode or not inspected.stdout.decode("utf-8", "replace").strip():
            raise CompletedCacheReconcileError("Pinned BuildControl helper image is not already present locally")
        return image

    def make_control(self, identity, helper_image):
        """Construct an archived control identity without prepare/namespace writes."""
        from bootstrap_docker_toolchain import control_volume_name
        from docker_build_control import BuildControl, LABEL_SCHEMA

        if _IMAGE.fullmatch(helper_image or "") is None:
            raise CompletedCacheReconcileError("Control helper image is not immutable")
        # BuildControl.__init__ resolves namespaces using a writable mount. This
        # operation intentionally admits only the un-namespaced archived root;
        # all reads below use an explicit readonly mount instead.
        control = BuildControl.__new__(BuildControl)
        control.identity = dict(identity)
        control.project = identity["project_name"]
        control.image = helper_image
        control.volume = control_volume_name(control.project)
        control.labels = {
            "org.fullmag.build-control.schema": LABEL_SCHEMA,
            "org.fullmag.compose.project": control.project,
            "org.fullmag.source.worktree-id": identity["worktree_id"],
            "org.fullmag.build.role": "control",
            "com.fullmag.compose.project": control.project,
            "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
            "com.fullmag.toolchain.control.project": control.project,
            "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
        }
        control.namespace = ""
        control.namespace_registry = None
        control.namespace_registry_sha256 = None
        control._active_operation = None
        return control

    def engine_id(self):
        from docker_build_control import docker_capture

        value = docker_capture("info", "--format", "{{.ID}}").stdout.decode("utf-8", "strict").strip()
        if not value or re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", value) is None:
            raise CompletedCacheReconcileError("Docker engine did not return an immutable ID")
        return value

    def inspect_volume(self, name):
        import docker_cache_retirement

        return docker_cache_retirement._inspect_volume(name, None)

    def container_inventory(self):
        import docker_cache_retirement

        return docker_cache_retirement._container_inventory(None)

    def active_pins(self, context):
        """Check exact operational-registry references and group-cache claims."""
        from local_runner.runtime_retention import _reference_roots

        volume = context["volume"]
        storage = Path(context["layout"]["storage_root"])
        try:
            # Preview is a read-only advisory snapshot. Apply holds the real
            # retention_mutation_guard across its authoritative rechecks and rm;
            # this read adapter must not create a gate during preview.
            roots, complete, stale = _reference_roots(
                storage, context["layout"], admission_gate_held=True,
            )
        except Exception as error:
            raise CompletedCacheReconcileError(f"Reference root coverage unavailable: {error}") from error
        if not complete or stale:
            raise CompletedCacheReconcileError(f"Reference root coverage incomplete: {stale}")
        roots = list(roots) + [storage / "index"]
        if os.path.lexists(storage / "runs"):
            roots.append(storage / "runs")
        documents = _reference_metadata(storage, roots)
        references = []
        def mentions_target(document):
            pending = [document]
            while pending:
                item = pending.pop()
                if isinstance(item, str) and volume in item:
                    return True
                if isinstance(item, dict):
                    pending.extend(item.keys())
                    pending.extend(item.values())
                elif isinstance(item, list):
                    pending.extend(item)
            return False

        for path, raw in documents.items():
            # Retain all exact volume mentions, including nested backend_start
            # cache/attestation identities, active pins and protected packages.
            if mentions_target(_json(raw, f"Reference metadata {path}")):
                references.append(path)
        group_raw = _read_control(context["control"], GROUP_STORAGE_PATH, optional=True)
        owner_raw = _read_control(context["control"], GROUP_OWNER_PATH, optional=True)
        if (group_raw is None) != (owner_raw is None):
            raise CompletedCacheReconcileError("Backend group registry and owner marker are incomplete")
        if group_raw is not None:
            group = _json(group_raw, "Backend group-storage registry")
            owner = _json(owner_raw, "Backend private owner marker")
            if group.get("schema") != "fullmag.private-group-cache-registry.v1" or group.get("state") != "ready":
                raise CompletedCacheReconcileError("Backend group-storage pin is malformed")
            profile = group.get("profile")
            if not isinstance(profile, Mapping) or not isinstance(profile.get("volume_names"), Mapping):
                raise CompletedCacheReconcileError("Backend group-storage volume identity is malformed")
            if profile["volume_names"].get("package") == volume:
                references.append(GROUP_STORAGE_PATH)
            if owner.get("volume_name") == volume or owner.get("package_volume") == volume:
                references.append(GROUP_OWNER_PATH)
        return {"metadata_files_scanned": len(documents),
                "metadata_sha256": _digest(_canonical({path: _digest(raw)
                                                        for path, raw in sorted(documents.items())})),
                "reference_roots": sorted(str(root.relative_to(storage)) for root in set(roots)),
                "references": sorted(set(references))}

    def retention_guard(self, layout):
        from local_runner.runtime_use import retention_mutation_guard
        return retention_mutation_guard(layout)

    def remove_volume(self, name):
        import docker_cache_retirement

        docker_cache_retirement._run(("volume", "rm", name), None)


def _readonly_control_bytes(control, relative: str, *, optional: bool) -> bytes | None:
    """Read a control record with a short-lived helper and readonly mounts."""
    active_operation = getattr(control, "_active_operation", None)
    if active_operation is not None:
        return control.read_bytes(relative, optional=optional, maximum=MAX_CONTROL_RECORD_BYTES)

    from docker_build_control import MAX_DOCUMENT_BYTES, bounded_capture, control_read_script

    if not hasattr(control, "helper_args"):
        return control.read_bytes(relative, optional=optional, maximum=MAX_CONTROL_RECORD_BYTES)
    maximum = min(MAX_CONTROL_RECORD_BYTES, MAX_DOCUMENT_BYTES)
    args = control.helper_args(control_read_script(control.path(relative), maximum))
    for index, value in enumerate(args[:-1]):
        if value == "--mount":
            mount = args[index + 1]
            if mount.startswith("type=volume,src=" + control.volume + ",dst=") and ",readonly" not in mount:
                args[index + 1] = mount + ",readonly"
    result = bounded_capture(args, data=b"", timeout=90, maximum=maximum + 64 * 1024)
    if optional and result.returncode == 44:
        return None
    if result.returncode:
        raise CompletedCacheReconcileError(f"Read-only BuildControl probe failed for {relative}")
    if len(result.stdout) > maximum:
        raise CompletedCacheReconcileError(f"BuildControl record exceeds its byte limit: {relative}")
    return bytes(result.stdout)


def _read_control(control, relative, *, optional=False):
    try:
        return _readonly_control_bytes(control, relative, optional=optional)
    except CompletedCacheReconcileError:
        raise
    except Exception as error:
        raise CompletedCacheReconcileError(f"Cannot read BuildControl record {relative}: {error}") from error


def _control_json(control, relative, *, optional=False):
    raw = _read_control(control, relative, optional=optional)
    return (raw, None if raw is None else _json(raw, relative))


def _archived_identity(registry: Mapping[str, Any], layout: Mapping[str, Any], probe: Any):
    import fullmag_storage
    from docker_compose_identity import compose_network_name

    task_id = _text(registry.get("task_id"), "registry task_id")
    owner = _text(registry.get("owner"), "registry owner")
    source = _safe_abs_path(registry.get("repo_root"), "archived source root")
    project_root = Path(_text(layout.get("project_root"), "executor project_root")).resolve()
    expected_source = project_root / "worktrees" / task_id
    if source != expected_source or source.name != task_id or source.exists():
        raise CompletedCacheReconcileError("Completed task source is not the exact removed worktree")
    worktree_id = _text(registry.get("worktree_id"), "registry worktree_id")
    if fullmag_storage.identifier(source) != worktree_id:
        raise CompletedCacheReconcileError("Registry worktree_id does not derive from its archived source path")
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", worktree_id) is None:
        raise CompletedCacheReconcileError("Archived worktree_id is malformed")
    if _GIT_SHA.fullmatch(registry.get("head", "")) is None:
        raise CompletedCacheReconcileError("Completed registry has no exact source HEAD")
    merge_sha = _text(registry.get("merge_commit"), "registry merge_commit")
    if _GIT_SHA.fullmatch(merge_sha) is None or registry.get("pr_state") != "merged":
        raise CompletedCacheReconcileError("Task registry does not prove a merged PR and merge commit")
    pr_url = _text(registry.get("pr_url"), "registry pr_url")
    if not re.fullmatch(r"https://github\.com/[^/]+/[^/]+/pull/[1-9][0-9]*", pr_url):
        raise CompletedCacheReconcileError("Task registry PR URL is not an exact merged GitHub PR")
    if registry.get("state") != "completed" or registry.get("schema") != "fullmag_storage_v1":
        raise CompletedCacheReconcileError("Task registry is not a completed Fullmag worktree record")
    cleanup_state = registry.get("worktree_cleanup")
    if not isinstance(cleanup_state, str) or "removed" not in cleanup_state.lower():
        raise CompletedCacheReconcileError("Task registry does not record removal of the completed worktree")
    project_id = _text(layout.get("project_id") or (layout.get("env") or {}).get("FULLMAG_PROJECT_ID"),
                       "executor Fullmag project_id")
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", project_id) is None:
        raise CompletedCacheReconcileError("Executor Fullmag project_id is malformed")
    import docker_backend_volume_cache as backend_cache

    # Older standalone cache volumes used a path-derived cache project key.
    # Derive it from the surviving resolver boundary, not a removed checkout
    # and not the candidate volume labels.
    cache_project_id = backend_cache._safe_project_id({"project_root": project_root})
    if (isinstance(registry.get("docker_cache_retirement_result"), Mapping)
            and registry["docker_cache_retirement_result"].get("cache_project_id")
            not in (None, cache_project_id)):
        raise CompletedCacheReconcileError("Archived retirement cache project identity differs from this project")
    segment = re.sub(r"[^a-z0-9_-]+", "-", worktree_id).strip("-")
    project = f"fullmag-worktree-{segment}"
    retirement_result = registry.get("docker_cache_retirement_result")
    retirement = registry.get("docker_cache_retirement")
    if not isinstance(retirement_result, Mapping) or not isinstance(retirement, Mapping):
        raise CompletedCacheReconcileError("Registry has no managed Docker retirement evidence")
    if (retirement.get("state") != "succeeded" or retirement.get("compose_project") != project
            or retirement.get("receipt") != f"docker-volume://{_control_volume(project)}/cache-retirement/result.json"):
        raise CompletedCacheReconcileError("Registry Docker retirement receipt does not bind the archived group")
    preserved = registry.get("preserved_volumes")
    control_volume = _control_volume(project)
    if not isinstance(preserved, list) or control_volume not in preserved:
        raise CompletedCacheReconcileError("Registry does not preserve the exact group control root")
    main_checkout = Path(probe.main_checkout(layout)).resolve()
    if registry.get("main_checkout") != str(main_checkout):
        raise CompletedCacheReconcileError("Registry executor/main checkout identity differs")
    if not probe.merge_is_ancestor(main_checkout, merge_sha):
        raise CompletedCacheReconcileError("Recorded merge commit is not an ancestor of current master")
    identity = {
        "project_name": project,
        "network_name": compose_network_name(project),
        "project_id": project_id,
        "worktree_id": worktree_id,
        "checkout_kind": "worktree",
        "source_root": str(source),
        "registered_name": worktree_id,
    }
    return {
        "task_id": task_id,
        "owner": owner,
        "source_root": str(source),
        "worktree_id": worktree_id,
        "project_id": project_id,
        "cache_project_id": cache_project_id,
        "project_name": project,
        "control_volume": control_volume,
        "merge_commit": merge_sha,
        "pr_url": pr_url,
        "main_checkout": str(main_checkout),
        "identity": identity,
        "retirement_result": dict(retirement_result),
    }


def _control_volume(project: str) -> str:
    from bootstrap_docker_toolchain import control_volume_name

    return control_volume_name(project)


def _validate_control(control: Any, archived: Mapping[str, Any], probe: Any, layout: Mapping[str, Any]):
    from docker_named_volume_safety import DockerNamedVolumeSafetyError, validate_local_named_volume

    if (control.project != archived["project_name"] or control.volume != archived["control_volume"]
            or getattr(control, "namespace", "") != ""):
        raise CompletedCacheReconcileError("Archived BuildControl identity or namespace differs")
    root = probe.inspect_volume(control.volume)
    if root is None:
        raise CompletedCacheReconcileError("The preserved group control volume is absent")
    try:
        validate_local_named_volume(root, control.volume)
    except DockerNamedVolumeSafetyError as error:
        raise CompletedCacheReconcileError(f"Preserved control volume backing is unsafe: {error}") from error
    labels = root.get("Labels")
    if not isinstance(labels, Mapping):
        raise CompletedCacheReconcileError("Preserved control volume labels are unavailable")
    for key, value in control.labels.items():
        if labels.get(key) != value:
            raise CompletedCacheReconcileError(f"Preserved control volume label differs: {key}")
    for key in labels:
        if str(key).startswith("com.fullmag.backend-cache."):
            raise CompletedCacheReconcileError("Backend cache volume cannot serve as the control root")
    namespace_raw = _read_control(control, "namespaces/current.json", optional=True)
    if namespace_raw is not None:
        raise CompletedCacheReconcileError("Archived group has a control namespace; namespace recovery is separate")
    return root


def _validate_retirement(control: Any, archived: Mapping[str, Any]):
    raw_plan, plan = _control_json(control, PLAN_PATH)
    raw_closing, closing = _control_json(control, CLOSING_PATH)
    raw_result, result = _control_json(control, RESULT_PATH)
    identity = {
        "worktree_id": archived["worktree_id"],
        "source_root": archived["source_root"],
        "project_id": archived["project_id"],
        "compose_project": archived["project_name"],
    }
    expected_prefix = {"task_id": archived["task_id"], "owner": archived["owner"], **identity}
    if plan.get("schema") != RETIREMENT_PLAN_SCHEMA or any(plan.get(key) != value for key, value in expected_prefix.items()):
        raise CompletedCacheReconcileError("Old retirement plan does not match exact registry task ownership")
    if (result.get("schema") != RETIREMENT_RESULT_SCHEMA or result.get("state") != "succeeded"
            or any(result.get(key) != value for key, value in expected_prefix.items())):
        raise CompletedCacheReconcileError("Old retirement result does not match exact registry task ownership")
    if result != archived["retirement_result"]:
        raise CompletedCacheReconcileError("Old retirement result raw content differs from registry projection")
    volumes = plan.get("volumes")
    if not isinstance(volumes, list) or len(volumes) > 64:
        raise CompletedCacheReconcileError("Old retirement plan volume inventory is malformed")
    old_names = []
    for item in volumes:
        if not isinstance(item, Mapping) or not isinstance(item.get("name"), str):
            raise CompletedCacheReconcileError("Old retirement plan contains an ambiguous volume")
        old_names.append(item["name"])
    if len(old_names) != len(set(old_names)):
        raise CompletedCacheReconcileError("Old retirement plan contains duplicate volume targets")
    deleted = result.get("deleted_volumes")
    absent = result.get("already_absent_volumes")
    if (not isinstance(deleted, list) or not isinstance(absent, list)
            or any(not isinstance(item, str) for item in deleted + absent)
            or len(set(deleted + absent)) != len(deleted + absent)
            or sorted(deleted + absent) != sorted(old_names)):
        raise CompletedCacheReconcileError("Old retirement result does not cover its exact plan")
    plan_sha = hashlib.sha256(_canonical(plan)).hexdigest()
    if result.get("plan_sha256") != plan_sha:
        raise CompletedCacheReconcileError("Old retirement result plan hash does not match its immutable plan")
    expected_closing = {
        "schema": RETIREMENT_CLOSING_SCHEMA,
        "state": "closing",
        "plan_sha256": plan_sha,
        **expected_prefix,
    }
    if closing != expected_closing:
        raise CompletedCacheReconcileError("Old permanent closing marker differs from its plan")
    return {
        "plan_sha256": plan_sha,
        "legacy_cache_project_id": archived["cache_project_id"],
        "plan_raw_sha256": _digest(raw_plan),
        "closing_raw_sha256": _digest(raw_closing),
        "result_raw_sha256": _digest(raw_result),
        "planned_volumes": old_names,
        "deleted_volumes": sorted(deleted),
        "already_absent_volumes": sorted(absent),
    }


def _validate_created_at(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise CompletedCacheReconcileError("Docker volume inspect has no exact CreatedAt")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CompletedCacheReconcileError("Docker volume CreatedAt is malformed") from error
    if parsed.tzinfo is None:
        raise CompletedCacheReconcileError("Docker volume CreatedAt has no timezone")
    return value


def _validate_target(document: Mapping[str, Any], archived: Mapping[str, Any], control: Any):
    import docker_backend_volume_cache as cache
    from docker_named_volume_safety import DockerNamedVolumeSafetyError

    labels = document.get("Labels")
    if not isinstance(labels, Mapping):
        raise CompletedCacheReconcileError("Backend package volume labels are missing")
    role = labels.get(cache.LABEL_ROLE)
    if role != cache.PACKAGE_VOLUME_ROLE:
        raise CompletedCacheReconcileError("Only a private backend package volume is eligible")
    required_identity = {
        cache.LABEL_SCHEMA: cache.SCHEMA,
        cache.LABEL_PROFILE: cache.PROFILE,
        cache.LABEL_PROJECT: archived["cache_project_id"],
        cache.LABEL_WORKTREE: archived["worktree_id"],
        cache.LABEL_ROLE: cache.PACKAGE_VOLUME_ROLE,
    }
    if any(labels.get(key) != value for key, value in required_identity.items()):
        raise CompletedCacheReconcileError("Backend package volume labels belong to another worktree or role")
    toolchain = labels.get(cache.LABEL_TOOLCHAIN)
    cargo_profile = labels.get(cache.LABEL_CARGO_PROFILE)
    if not isinstance(toolchain, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", toolchain):
        raise CompletedCacheReconcileError("Backend package toolchain label is not immutable")
    if cargo_profile not in cache.SUPPORTED_CARGO_PROFILES:
        raise CompletedCacheReconcileError("Backend package Cargo profile is unsupported")
    cache_key = labels.get(cache.LABEL_CACHE_KEY)
    unit_key = labels.get(cache.LABEL_UNIT)
    owner_id = labels.get(cache.LABEL_OWNER)
    source = archived["source_root"]
    expected_cache_key = cache._sha256({
        "schema": cache.KEY_SCHEMA,
        "source_root": source,
        "worktree_id": archived["worktree_id"],
        "toolchain_image_id": toolchain,
        "cargo_profile": cargo_profile,
    })
    expected_unit = cache._sha256({
        "schema": cache.SCHEMA,
        "project_id": archived["cache_project_id"],
        "cache_key": expected_cache_key,
        "worktree_id": archived["worktree_id"],
        "toolchain_image_id": toolchain,
        "cargo_profile": cargo_profile,
    })
    if cache_key != expected_cache_key or unit_key != expected_unit or owner_id != expected_unit:
        raise CompletedCacheReconcileError("Backend package cache key/unit/owner does not derive from the registry")
    names = cache._volume_names(archived["cache_project_id"], expected_unit, control.volume, shared_packages=False)
    profile = {
        "schema": cache.SCHEMA,
        "profile": cache.PROFILE,
        "shared_packages": False,
        "project_id": archived["cache_project_id"],
        "worktree_id": archived["worktree_id"],
        "cache_key": expected_cache_key,
        "unit_key": expected_unit,
        "owner_id": expected_unit,
        "toolchain_image_id": toolchain,
        "cargo_profile": cargo_profile,
        "volume_names": names,
    }
    try:
        checked = cache._validate_volume_document(document, profile, cache.PACKAGE_VOLUME_ROLE)
    except (cache.BackendVolumeCacheError, DockerNamedVolumeSafetyError, KeyError, TypeError, ValueError) as error:
        raise CompletedCacheReconcileError(f"Private backend package inspect is not canonical: {error}") from error
    if names[cache.PACKAGE_VOLUME_ROLE] != document.get("Name"):
        raise CompletedCacheReconcileError("Backend package volume name does not derive from its exact labels")
    if checked["Name"] == control.volume:
        raise CompletedCacheReconcileError("The control root can never be a cache target")
    _validate_created_at(checked.get("CreatedAt"))
    usage = checked.get("UsageData")
    if usage is not None:
        if not isinstance(usage, Mapping) or type(usage.get("RefCount")) is not int or usage["RefCount"] != 0:
            raise CompletedCacheReconcileError("Docker reports an active or ambiguous volume reference count")
    return dict(checked)


def _paths(volume: str, recovery_id: str):
    target_key = hashlib.sha256(volume.encode("ascii")).hexdigest()
    return (
        f"completed-cache-reconciliation/targets/{target_key}.json",
        f"completed-cache-reconciliation/{recovery_id}/receipt.json",
    )


def _control_state(control, volume, recovery_id, archived, retirement, probe, layout):
    intent_path, receipt_path = _paths(volume, recovery_id)
    intent_raw, intent = _control_json(control, intent_path, optional=True)
    receipt_raw, receipt = _control_json(control, receipt_path, optional=True)
    if intent is not None:
        expected = {
            "schema": INTENT_SCHEMA,
            "state": "delete-authorized-outcome-must-be-reconciled",
            "volume": volume,
            "recovery_id": recovery_id,
            "worktree_id": archived["worktree_id"],
            "task_id": archived["task_id"],
            "owner": archived["owner"],
            "registry_sha256": retirement["registry_sha256"],
            "old_plan_raw_sha256": retirement["plan_raw_sha256"],
            "old_result_raw_sha256": retirement["result_raw_sha256"],
            "engine_id": probe.engine_id(),
        }
        if any(intent.get(key) != value for key, value in expected.items()):
            raise CompletedCacheReconcileError("Existing per-volume intent belongs to another recovery proof")
        saved_inspect = intent.get("target_inspect")
        if not isinstance(saved_inspect, Mapping) or _digest(_canonical(saved_inspect)) != intent.get("target_inspect_sha256"):
            raise CompletedCacheReconcileError("Existing per-volume intent has no authentic target inspect")
        _validate_target(saved_inspect, archived, control)
    if receipt is not None:
        if (receipt.get("schema") != RECEIPT_SCHEMA
                or receipt.get("recovery_id") != recovery_id
                or receipt.get("volume") != volume
                or receipt.get("worktree_id") != archived["worktree_id"]
                or receipt.get("task_id") != archived["task_id"]
                or receipt.get("owner") != archived["owner"]):
            raise CompletedCacheReconcileError("Existing reconciliation receipt has a foreign identity")
        if intent is None or receipt.get("intent_sha256") != _digest(intent_raw):
            raise CompletedCacheReconcileError("Existing reconciliation receipt is not bound to its durable intent")
        if receipt.get("state") not in {"succeeded", "outcome-unknown-resources-retained"}:
            raise CompletedCacheReconcileError("Existing reconciliation receipt has an unsupported terminal state")
        expected_receipt_pins = {
            "registry_sha256": retirement["registry_sha256"],
            "old_plan_raw_sha256": retirement["plan_raw_sha256"],
            "old_result_raw_sha256": retirement["result_raw_sha256"],
            "engine_id": probe.engine_id(),
            "control_volume": archived["control_volume"],
            "target_inspect_sha256": intent.get("target_inspect_sha256"),
            "plan_sha256": intent.get("plan_sha256"),
        }
        if any(receipt.get(key) != value for key, value in expected_receipt_pins.items()):
            raise CompletedCacheReconcileError("Existing reconciliation receipt differs from pinned proof")
        if _canonical(receipt.get("target_inspect")) != _canonical(intent.get("target_inspect")):
            raise CompletedCacheReconcileError("Existing reconciliation receipt target inspect differs from intent")
        if receipt.get("state") == "succeeded" and receipt.get("deleted_volumes") != [volume]:
            raise CompletedCacheReconcileError("Successful reconciliation receipt does not name exactly its target")
        if receipt.get("state") == "succeeded" and not (
                isinstance(receipt.get("post_removal_inspect"), Mapping)
                and receipt["post_removal_inspect"].get("state") == "absent"):
            raise CompletedCacheReconcileError("Successful reconciliation receipt has no post-removal absence proof")
        if receipt.get("state") == "outcome-unknown-resources-retained" and receipt.get("deleted_volumes") != []:
            raise CompletedCacheReconcileError("Unknown reconciliation receipt cannot claim a deletion")
    return {
        "intent_path": intent_path,
        "intent": intent,
        "intent_raw_sha256": _digest(intent_raw) if intent_raw is not None else None,
        "receipt_path": receipt_path,
        "receipt": receipt,
        "receipt_raw_sha256": _digest(receipt_raw) if receipt_raw is not None else None,
    }


def _validate_old_identity(registry: Mapping[str, Any], archived: Mapping[str, Any]):
    result = archived["retirement_result"]
    if (result.get("project_id") != archived["project_id"]
            or result.get("worktree_id") != archived["worktree_id"]
            or result.get("source_root") != archived["source_root"]
            or result.get("compose_project") != archived["project_name"]
            or result.get("task_id") != archived["task_id"]
            or result.get("owner") != archived["owner"]):
        raise CompletedCacheReconcileError("Retirement result identity differs from the completed registry")
    if result.get("cache_project_id") not in (None, archived["cache_project_id"]):
        raise CompletedCacheReconcileError("Retirement result legacy-cache project identity differs")


def _collect(args: Any, probe: Any, *, control_override=None, expected_active_token=None,
             allowed_helpers=frozenset()):
    if _RECOVERY_ID.fullmatch(getattr(args, "recovery_id", "")) is None:
        raise CompletedCacheReconcileError("recovery_id must be exactly 32 lowercase hexadecimal characters")
    volume = getattr(args, "volume", None)
    if not isinstance(volume, str) or _VOLUME.fullmatch(volume) is None:
        raise CompletedCacheReconcileError("volume must be one exact literal Docker volume name")
    repo_root = _safe_abs_path(getattr(args, "repo_root", None), "executor repo_root")
    engine_before = probe.engine_id()
    layout = probe.resolve_layout(str(repo_root))
    if str(Path(layout["repo_root"]).resolve()) != str(repo_root.resolve()):
        raise CompletedCacheReconcileError("repo_root is not the surviving registered executor checkout")
    registry_arg = _safe_abs_path(getattr(args, "registry", None), "registry argument")
    raw_registry, registry = probe.read_registry(registry_arg, layout)
    if not isinstance(raw_registry, bytes) or _json(raw_registry, "Canonical task registry") != registry:
        raise CompletedCacheReconcileError("Registry object differs from its exact raw bytes")
    registry_path = Path(layout["storage_root"]) / "index" / f"{registry.get('worktree_id')}.json"
    if registry_arg != registry_path:
        raise CompletedCacheReconcileError("Registry path is not its canonical storage/index identity")
    archived = _archived_identity(registry, layout, probe)
    _validate_old_identity(registry, archived)
    expected_control_volume = archived["control_volume"]
    helper_image = (getattr(control_override, "image", None)
                    if control_override is not None else probe.helper_image(str(repo_root), archived["identity"]))
    control = control_override or probe.make_control(archived["identity"], helper_image)
    if getattr(control, "image", helper_image) != helper_image:
        raise CompletedCacheReconcileError("BuildControl helper image changed during reconciliation")
    if control.volume != expected_control_volume:
        raise CompletedCacheReconcileError("BuildControl root does not derive from the archived Compose project")
    root_document = _validate_control(control, archived, probe, layout)
    registry_retirement = _validate_retirement(control, archived)
    registry_retirement["registry_sha256"] = _digest(raw_registry)
    namespace_result = registry.get("docker_cache_retirement_result")
    if not isinstance(namespace_result, Mapping):
        raise CompletedCacheReconcileError("Registry retirement projection is missing")
    # The permanent old result/plan remain evidence only. Already deleted or
    # already absent names are never fed into this separate remover.
    intent_state = _control_state(control, volume, args.recovery_id, archived, registry_retirement, probe, layout)
    existing_intent = intent_state["intent"]
    existing_receipt = intent_state["receipt"]
    if volume in (registry_retirement["planned_volumes"]
                  + registry_retirement["deleted_volumes"]
                  + registry_retirement["already_absent_volumes"]):
        raise CompletedCacheReconcileError("Target is covered by old deleted/already-absent evidence; separate reconcile required")

    observed_target = probe.inspect_volume(volume)
    if observed_target is None:
        if existing_intent is None:
            raise CompletedCacheReconcileError("Target volume is already absent without this reconciler's durable intent")
        target = _validate_target(existing_intent["target_inspect"], archived, control)
        target_state = "absent-after-durable-intent"
    else:
        target = _validate_target(observed_target, archived, control)
        if existing_intent is not None and _canonical(target) != _canonical(existing_intent["target_inspect"]):
            raise CompletedCacheReconcileError("Target Docker inspect drifted after a durable deletion intent")
        target_state = "present"
    expected_target_name = target.get("Name")
    if expected_target_name != volume:
        raise CompletedCacheReconcileError("Literal target volume does not match its backend-cache-derived name")

    active_raw = _read_control(control, "active", optional=True)
    if expected_active_token is None:
        if active_raw is not None:
            raise CompletedCacheReconcileError("BuildControl has an active operation lease; target is retained")
    elif active_raw != (expected_active_token + "\n").encode():
        raise CompletedCacheReconcileError("BuildControl operation lease changed during target recheck")

    pin_state = probe.active_pins({
        "volume": volume, "control": control, "layout": layout,
        "archived": archived, "target": target,
    })
    if isinstance(pin_state, list):
        pin_state = {"references": pin_state}
    if not isinstance(pin_state, Mapping) or not isinstance(pin_state.get("references"), list):
        raise CompletedCacheReconcileError("Active pin inventory is malformed or unavailable")
    if pin_state.get("references"):
        raise CompletedCacheReconcileError(f"Target has an operational registry or group-storage pin: {pin_state['references']}")

    containers = probe.container_inventory()
    try:
        import docker_cache_retirement as retirement_module

        container_sha = _digest(_canonical(sorted(
            [_container_safety_projection(item) for item in containers
             if item.get("Id") not in allowed_helpers],
            key=lambda item: item.get("Id", ""),
        )))
        retirement_module._check_consumers(
            containers,
            {
                "worktree_id": archived["worktree_id"],
                "project_id": archived["project_id"],
                "compose_project": archived["project_name"],
            },
            [{"name": volume, "mountpoint": target["Mountpoint"]}],
            None,
            set(),
            set(allowed_helpers),
            control.volume,
            root_document["Mountpoint"],
        )
    except Exception as error:
        if isinstance(error, CompletedCacheReconcileError):
            raise
        raise CompletedCacheReconcileError(f"Container/reference proof failed: {error}") from error

    if existing_receipt is not None and existing_receipt.get("state") == "succeeded" and target_state != "absent-after-durable-intent":
        raise CompletedCacheReconcileError("Successfully reconciled volume reappeared; refusing another deletion")
    plan = {
        "schema": PLAN_SCHEMA,
        "state": "preview",
        "recovery_id": args.recovery_id,
        "executor": {"repo_root": str(repo_root), "worktree_id": layout.get("worktree_id")},
        "engine_id": engine_before,
        "registry": {
            "path": str(registry_arg),
            "sha256": _digest(raw_registry),
            "task_id": archived["task_id"],
            "owner": archived["owner"],
            "worktree_id": archived["worktree_id"],
            "source_root": archived["source_root"],
            "merge_commit": archived["merge_commit"],
            "main_checkout": archived["main_checkout"],
        },
        "retirement": registry_retirement,
        "control": {
            "volume": control.volume,
            "inspect": dict(root_document),
            "inspect_sha256": _digest(_canonical(root_document)),
            "helper_image": helper_image,
        },
        "target": {
            "volume": volume,
            "role": "backend-package",
            "state": target_state,
            "inspect": dict(target),
            "inspect_sha256": _digest(_canonical(target)),
        },
        "proof": {
            "container_count": len(containers) - len(allowed_helpers),
            "container_inventory_sha256": container_sha,
            "active_pins": dict(pin_state),
            "reference_snapshot": "read-only-advisory; apply-requires-retention-mutation-guard",
            # The current lease is checked exactly above. Keep it out of the
            # plan digest so the pre-lease approval stays comparable under it.
            "active_control_lease": "none",
            "shared_storage_target": False,
        },
        "prior_reconciliation": {
            "intent_sha256": intent_state["intent_raw_sha256"],
            "receipt_sha256": intent_state["receipt_raw_sha256"],
            "intent_state": existing_intent.get("state") if existing_intent else None,
            "receipt_state": existing_receipt.get("state") if existing_receipt else None,
        },
    }
    if probe.engine_id() != engine_before:
        raise CompletedCacheReconcileError("Docker engine identity changed while collecting proof")
    plan["plan_sha256"] = plan_sha256(plan)
    return plan, {
        "probe": probe,
        "layout": layout,
        "registry": registry,
        "registry_raw": raw_registry,
        "archived": archived,
        "retirement": registry_retirement,
        "control": control,
        "root_document": root_document,
        "target": target,
        "target_state": target_state,
        "intent_state": intent_state,
    }


def collect(args: Any) -> dict[str, Any]:
    """Return a read-only, hash-pinned plan for one exact legacy private package."""
    try:
        plan, _context = _collect(args, _probe(args))
        return plan
    except CompletedCacheReconcileError:
        raise
    except Exception as error:
        raise CompletedCacheReconcileError(str(error)) from error


def _same_proof(first: Mapping[str, Any], second: Mapping[str, Any]) -> bool:
    def core(plan):
        value = dict(plan)
        value.pop("plan_sha256", None)
        value.pop("prior_reconciliation", None)
        return value
    return _canonical(core(first)) == _canonical(core(second))


def _receipt_base(plan: Mapping[str, Any], intent: Mapping[str, Any], state: str):
    return {
        "schema": RECEIPT_SCHEMA,
        "state": state,
        "recovery_id": plan["recovery_id"],
        "volume": plan["target"]["volume"],
        "task_id": plan["registry"]["task_id"],
        "owner": plan["registry"]["owner"],
        "worktree_id": plan["registry"]["worktree_id"],
        "registry_sha256": plan["registry"]["sha256"],
        "old_plan_raw_sha256": plan["retirement"]["plan_raw_sha256"],
        "old_result_raw_sha256": plan["retirement"]["result_raw_sha256"],
        "engine_id": plan["engine_id"],
        "plan_sha256": intent["plan_sha256"],
        "intent_sha256": _digest(_canonical(intent) + b"\n"),
        "target_inspect_sha256": plan["target"]["inspect_sha256"],
        "target_inspect": dict(plan["target"]["inspect"]),
        "control_volume": plan["control"]["volume"],
        "control_inspect_sha256": plan["control"]["inspect_sha256"],
        "deleted_volumes": [plan["target"]["volume"]] if state == "succeeded" else [],
        "post_removal_inspect": {"state": "absent"} if state == "succeeded" else None,
    }


def _write_receipt(control, path, receipt):
    try:
        control.write(path, receipt)
    except Exception as error:
        raise CompletedCacheReconcileError("Could not publish additive reconciliation receipt") from error


def apply(args: Any) -> dict[str, Any]:
    """Apply one preview under the archived group's BuildControl lease."""
    expected = getattr(args, "expected_plan_sha256", None)
    if _SHA.fullmatch(expected or "") is None:
        raise CompletedCacheReconcileError("Apply requires expected_plan_sha256 from the exact preview")
    probe = _probe(args)
    try:
        plan, context = _collect(args, probe)
        if plan["plan_sha256"] != expected:
            raise CompletedCacheReconcileError("Expected plan SHA-256 differs from current proof")
        control = context["control"]
        existing_receipt = context["intent_state"]["receipt"]
        if existing_receipt is not None and existing_receipt.get("state") == "succeeded":
            return dict(existing_receipt)
        if (existing_receipt is not None
                and existing_receipt.get("state") == "outcome-unknown-resources-retained"
                and context["target_state"] == "present"):
            return dict(existing_receipt)

        operation_inputs = {
            "recovery_id": args.recovery_id,
            "volume": args.volume,
            "plan_sha256": plan["plan_sha256"],
            "registry_sha256": plan["registry"]["sha256"],
            "old_plan_raw_sha256": plan["retirement"]["plan_raw_sha256"],
            "old_result_raw_sha256": plan["retirement"]["result_raw_sha256"],
            "engine_id": plan["engine_id"],
        }
        from docker_build_control import MIN_FREE_CONTROL_BYTES

        with probe.retention_guard(context["layout"]), control.operation(
            "cache-retirement", operation_inputs,
            minimum_free_bytes=MIN_FREE_CONTROL_BYTES,
        ) as operation:
            attempt = operation.get("receipt", {}).get("attempt")
            helper_id = operation.get("helper_container_id")
            if not isinstance(attempt, str) or _RECOVERY_ID.fullmatch(attempt) is None:
                raise CompletedCacheReconcileError("BuildControl returned no exact operation lease token")
            if not isinstance(helper_id, str) or re.fullmatch(r"[0-9a-f]{64}", helper_id) is None:
                raise CompletedCacheReconcileError("BuildControl returned no pinned lease helper ID")
            locked_plan, locked_context = _collect(
                args, probe, control_override=control,
                expected_active_token=attempt, allowed_helpers={helper_id},
            )
            if locked_plan["plan_sha256"] != expected or not _same_proof(plan, locked_plan):
                raise CompletedCacheReconcileError("Full proof drifted while acquiring the BuildControl lease")

            intent_state = locked_context["intent_state"]
            intent = intent_state["intent"]
            intent_path = intent_state["intent_path"]
            receipt_path = intent_state["receipt_path"]
            if intent is not None:
                # A durable intent means a prior remove may have run. Never
                # replay volume rm; absence can only be reconciled by inspect.
                current = probe.inspect_volume(args.volume)
                if current is None:
                    receipt = _receipt_base(locked_plan, intent, "succeeded")
                    receipt["state"] = "succeeded"
                    receipt["deleted_volumes"] = [args.volume]
                    receipt["post_removal_inspect"] = {"state": "absent", "reconciled_from_intent": True}
                    receipt["outcome"] = "absence-confirmed-after-existing-intent"
                else:
                    if _canonical(dict(current)) != _canonical(intent["target_inspect"]):
                        raise CompletedCacheReconcileError("Target drifted after an uncertain delete; retaining intent")
                    receipt = _receipt_base(locked_plan, intent, "outcome-unknown-resources-retained")
                    receipt["state"] = "outcome-unknown-resources-retained"
                    receipt["deleted_volumes"] = []
                    receipt["post_removal_inspect"] = {"state": "present-unchanged"}
                    receipt["outcome"] = "prior-delete-outcome-unknown; volume-rm-not-replayed"
                _write_receipt(control, receipt_path, receipt)
                operation["daemon_pending"] = False
                operation["receipt"].update(
                    state="succeeded" if receipt["state"] == "succeeded" else "failed-confirmed",
                    result=receipt,
                )
                if receipt["state"] != "succeeded":
                    operation["receipt"]["error"] = "Prior volume-rm outcome remains unknown; target was not retried"
                return receipt

            if locked_context["target_state"] != "present":
                raise CompletedCacheReconcileError("New deletion requires the exact private volume to be present")
            intent = {
                "schema": INTENT_SCHEMA,
                "state": "delete-authorized-outcome-must-be-reconciled",
                "recovery_id": args.recovery_id,
                "volume": args.volume,
                "task_id": plan["registry"]["task_id"],
                "owner": plan["registry"]["owner"],
                "worktree_id": plan["registry"]["worktree_id"],
                "registry_sha256": plan["registry"]["sha256"],
                "old_plan_raw_sha256": plan["retirement"]["plan_raw_sha256"],
                "old_result_raw_sha256": plan["retirement"]["result_raw_sha256"],
                "engine_id": plan["engine_id"],
                "plan_sha256": plan["plan_sha256"],
                "target_inspect": dict(plan["target"]["inspect"]),
                "target_inspect_sha256": plan["target"]["inspect_sha256"],
                "control_volume": plan["control"]["volume"],
                "control_inspect_sha256": plan["control"]["inspect_sha256"],
            }
            control.write(intent_path, intent)

            # Re-read all registry, control, Docker, pin and container evidence
            # after durable intent publication and immediately before rm.
            final_plan, final_context = _collect(
                args, probe, control_override=control,
                expected_active_token=attempt, allowed_helpers={helper_id},
            )
            if not _same_proof(plan, final_plan) or final_context["target_state"] != "present":
                raise CompletedCacheReconcileError("Full proof drifted after durable intent; volume retained")
            if final_context["intent_state"]["intent"] != intent:
                raise CompletedCacheReconcileError("Durable target intent changed before volume removal")

            operation["daemon_pending"] = True
            remove_error = None
            try:
                probe.remove_volume(args.volume)
            except Exception as error:
                remove_error = error
            try:
                after = probe.inspect_volume(args.volume)
            except Exception as error:
                # Keep the operation lease when even the daemon outcome cannot
                # be observed; the durable target intent prevents replay.
                raise RuntimeError("Docker remove outcome cannot be inspected; intent and lease retained") from error
            if after is None:
                receipt = _receipt_base(plan, intent, "succeeded")
                receipt["outcome"] = "volume-absence-confirmed"
            else:
                receipt = _receipt_base(plan, intent, "outcome-unknown-resources-retained")
                receipt["state"] = "outcome-unknown-resources-retained"
                receipt["deleted_volumes"] = []
                receipt["post_removal_inspect"] = {
                    "state": "present",
                    "inspect_sha256": _digest(_canonical(dict(after))),
                    "remove_error": str(remove_error)[:512] if remove_error else None,
                }
                receipt["outcome"] = "volume-rm-not-replayed-after-uncertain-result"
            _write_receipt(control, receipt_path, receipt)
            operation["daemon_pending"] = False
            operation["receipt"].update(
                state="succeeded" if receipt["state"] == "succeeded" else "failed-confirmed",
                result=receipt,
            )
            if receipt["state"] != "succeeded":
                operation["receipt"]["error"] = "Volume-rm outcome remains unknown; target was retained and will not be retried"
            return receipt
    except CompletedCacheReconcileError:
        raise
    except Exception as error:
        raise CompletedCacheReconcileError(str(error)) from error


def run(args: Any):
    """Dispatch preview/apply using the caller's parsed argument namespace."""
    if getattr(args, "apply", False):
        return apply(args)
    return collect(args)
