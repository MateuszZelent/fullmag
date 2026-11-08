"""Run the managed browser proof against one live volume DEV frontend.

The host process only resolves the selected checkout and observes Docker. The
short-lived browser service owns no build/cache/user-data writes; the durable
attempt and result are published through BuildControl into the selected control
volume.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
from collections.abc import Mapping
from copy import deepcopy
import json
import math
import os
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path, PurePosixPath
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import Request, urlopen

import fullmag_storage as storage
from docker_build_control import (
    BuildControl,
    BuildControlError,
    ControlOutcomeUnknown,
    MIN_FREE_BUILD_BYTES,
    canonical,
    docker_capture,
    mirror_console,
    toolchain_configuration,
)
from docker_compose_identity import compose_project_identity, source_labels, validate_source_labels
from docker_dev_defaults import _validate_live_network, resolve_defaults
from docker_backend_volume_cache import _safe_project_id as cache_project_id_for_layout
from bootstrap_docker_toolchain import CONTROL_ROOT, CONTROL_VOLUME_SCHEMA


PLAYWRIGHT_VERSION = "1.62.1"
DEFAULT_BROWSER_IMAGE = (
    "mcr.microsoft.com/playwright:v1.62.1-noble@"
    "sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e"
)
# The index pin is the default. Child manifest pins are accepted only for the
# same official immutable image when the selected Docker platform requires one.
BROWSER_IMAGE_DIGESTS = frozenset({
    "dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
    "c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    "941cc91e5022880ac1d14ae90b476b624deb6399dbbc28d612d5d5bd7928fcbd",
})
RESULT_SCHEMA = "fullmag.docker-dev-browser-qa-result.v1"
AIRBOX_INSPECTOR_RESULT_SCHEMA = "fullmag.docker-dev-airbox-inspector-result.v1"
INSPECTOR_ACK_RESULT_SCHEMA = "fullmag.docker-dev-inspector-ack-result.v1"
INSPECTOR_ACK_SOURCES = {
    "runner": "apps/control-room/scripts/check-inspector-ack-browser.mjs",
    "loopback_proxy": "apps/control-room/scripts/lib/browser-qa-loopback-proxy.mjs",
    "request_budget": "apps/control-room/scripts/lib/inspector-request-budget.mjs",
}
STUDY_STAGE_RERUN_RESULT_SCHEMA = "fullmag.docker-dev-study-stage-rerun-result.v1"
STUDY_STAGE_RERUN_SRC_TARGET = "/state/development/workspace/apps/control-room/src"
STUDY_STAGE_RERUN_FIXTURE_TARGET = "/opt/fullmag/p22-fixture.py"
STUDY_STAGE_RERUN_SOURCES = {
    "runner": "apps/control-room/scripts/check-study-stage-rerun-browser.mjs",
    "loopback_proxy": "apps/control-room/scripts/lib/browser-qa-loopback-proxy.mjs",
    "fixture": "examples/interactive_study/fdm_cpu_three_relax_continue.py",
    "scene_adapter": "apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts",
    "tree_view": "apps/control-room/src/modules/explorer/ExplorerTreeView.tsx",
    "study_nodes": "apps/control-room/src/modules/explorer/builders/study/studyExplorerNodes.ts",
    "stage_builder": "apps/control-room/src/modules/explorer/builders/study/studyStageCommon.ts",
    "command_adapter": "apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts",
    "command_contributions": "apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts",
    "tab_routes": "apps/control-room/src/kernel/layout/tabRoutes.ts",
    "study_compute_input": "apps/control-room/src/kernel/runtime/studyComputeInput.ts",
}
STUDY_STAGE_MATERIAL_SOURCES = {
    "object_nodes": "apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts",
    "material_panel": "apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx",
    "material_panel_model": "apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.ts",
    "material_edit_session": "apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelEditSession.ts",
    "material_edit_session_bridge": "apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelEditSessionBridge.tsx",
    "authoring_history": "apps/control-room/src/kernel/authoring/authoringHistoryMutation.ts",
    "api_client": "apps/control-room/src/kernel/api/ControlRoomApi.ts",
    "api_paths": "apps/control-room/src/kernel/api/apiPaths.ts",
}
STUDY_STAGE_FDM_CELL_SOURCES = {
    "study_global_authoring_model": "apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts",
    "study_inspector_panel": "apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx",
    "study_execution_profile_model": "apps/control-room/src/modules/inspector/panels/StudyExecutionProfileModel.ts",
    "geometry_lifecycle_commands": "apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts",
    "authoring_history": "apps/control-room/src/kernel/authoring/authoringHistoryMutation.ts",
    "api_client": "apps/control-room/src/kernel/api/ControlRoomApi.ts",
    "api_paths": "apps/control-room/src/kernel/api/apiPaths.ts",
}
STUDY_STAGE_TEXTURE_SOURCES = {
    "texture_helper": "apps/control-room/scripts/lib/study-texture-browser-qa.mjs",
    "stage_inspector_router": "apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx",
    "texture_editor": "apps/control-room/src/modules/inspector/panels/stages/StageTextureAssignmentsEditor.tsx",
    "stage_authoring_model": "apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts",
    "study_inspector_panel": "apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx",
    "initial_state_selector": "apps/control-room/src/modules/inspector/panels/stages/StageInitialStateSelector.tsx",
    "initial_state_model": "apps/control-room/src/kernel/runtime/studyStageInitialState.ts",
    "api_client": "apps/control-room/src/kernel/api/ControlRoomApi.ts",
}
SAVED_PLAYBACK_RESULT_SCHEMA = "fullmag.docker-dev-saved-playback-result.v1"
OPERATION_SCHEMA = "fullmag.docker-dev-browser-qa.v1"
BROWSER_IMAGE_RE = re.compile(
    r"^mcr\.microsoft\.com/playwright:v1\.62\.1-noble@sha256:([0-9a-f]{64})$"
)
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_RESULT_BYTES = 2 * 1024 * 1024
MAX_CANVAS_SCREENSHOT_BYTES = 512 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CANVAS_ONLY_SKIPPED_AREAS = [
    "viewport appearance and color-profile checks",
    "camera interaction checks",
    "viewport export checks at DPR 1 and DPR 2",
    "layout and DPR 1/2 checks",
    "20-cycle viewport lifecycle checks",
    "viewport QA fixture preparation",
    "scene/model adoption readiness endpoint",
    "viewport performance instrumentation",
]
RUN_PERFORMANCE_VIEWPORT_DOM_SKIPPED_AREA = "viewport DOM/model-adoption observations (performance-only scope)"
RUN_PERFORMANCE_VIEWPORT_DOM_OMISSION_REASON = (
    "The performance-only scope proves the viewport canvas and footer performance panel; "
    "it does not inspect model-adoption or quantity-label DOM."
)
RUN_PERFORMANCE_QA_SCOPE = "canvas-engine-run-performance"
VIEWPORT_DOM_OBSERVATIONS_NOTE = (
    "Viewport dataset and quantity label attributes are DOM observations only; "
    "they do not prove field payload presence or values."
)
LIVE_FIELD_OBSERVATION_NOTE = (
    "Quantity label data-ready and viewport datasets are DOM readiness observations only; "
    "they do not prove field payload presence or values."
)
FEM_AIRBOX_VECTOR_OBSERVATION_SCHEMA = "fullmag.fem-airbox-vector-observation.v1"
PLANAR_AIRBOX_OBSERVATION_SCHEMA = "fullmag.docker-dev-planar-airbox-browser-proof.v1"
TERMINAL_TELEMETRY_RESULT_SCHEMA = "fullmag.docker-dev-terminal-telemetry.v1"
RUN_PERFORMANCE_PROOF_SCHEMA = "fullmag.docker-dev-run-performance-browser-proof.v1"
TERMINAL_TELEMETRY_ENERGY_FORMAT = "en-US:maxFractionDigits=6;scientific:toExponential(6)"
MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991

DESKTOP_WSL_BIND_ALIAS_RE = re.compile(
    r"^/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"
    r"([A-Za-z0-9][A-Za-z0-9._-]*)/([0-9a-f]{64})$"
)
LOCAL_WSL_BIND_MOUNT_ROOT = Path("/mnt/wsl/docker-desktop-bind-mounts")


def _text(value: bytes, limit: int = 4096) -> str:
    return value.decode("utf-8", "replace")[-limit:]


def _inspect(identifier: str) -> dict[str, object]:
    try:
        records = json.loads(docker_capture("inspect", identifier).stdout)
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise BuildControlError(f"Docker inspect returned invalid JSON for {identifier}") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
        raise BuildControlError(f"Docker inspect did not identify exactly one resource: {identifier}")
    return records[0]


def _inspect_existing_volume(name: str, label: str) -> dict[str, object]:
    """Inspect an already existing named volume without creating or repairing it."""
    observed = docker_capture("volume", "inspect", name, allow_failure=True, timeout=60)
    if observed.returncode:
        diagnostics = (observed.stderr + observed.stdout).decode("utf-8", "replace")
        raise BuildControlError(
            f"{label} could not be inspected; browser QA requires the existing resource: "
            + diagnostics[-2048:]
        )
    try:
        records = json.loads(observed.stdout)
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise BuildControlError(f"{label} inspection returned invalid JSON") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
        raise BuildControlError(f"{label} inspection did not identify exactly one volume")
    return records[0]


def _has_authenticated_source_namespace(control: BuildControl) -> bool:
    """Use the constructor's receipt-bound namespace, not historical root labels.

    BuildControl resolves and authenticates the root registry before this
    read-only preflight. Subsequent helper reads retain its registry CAS.
    """
    from docker_control_namespace import REGISTRY_SCHEMA

    registry = getattr(control, "namespace_registry", None)
    identity = getattr(control, "identity", None)
    namespace = getattr(control, "namespace", None)
    registry_sha = getattr(control, "namespace_registry_sha256", None)
    if not isinstance(registry, Mapping) or not isinstance(identity, Mapping):
        return False
    token = registry.get("recovery_id")
    if not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{32}", token) is None:
        return False
    expected = {
        "schema": REGISTRY_SCHEMA,
        "namespace": "namespaces/" + token,
        "receipt_path": "namespace-recovery/" + token + "/terminal.json",
        "compose_project": control.project,
        "control_volume": control.volume,
        "source_worktree_id": identity.get("worktree_id"),
        "source_project_id": identity.get("project_id"),
    }
    retirement = registry.get("retirement")
    if (namespace != expected["namespace"]
            or any(not isinstance(value, str) or not value for value in expected.values())
            or any(registry.get(key) != value for key, value in expected.items())
            or not isinstance(retirement, Mapping)
            or not isinstance(registry_sha, str) or SHA256_RE.fullmatch(registry_sha) is None):
        return False
    raw_registry = {key: value for key, value in registry.items() if key != "retirement"}
    try:
        # Cold recovery writes canonical registry bytes without a newline;
        # the regular control writer appends one. The constructor pins the
        # actual bytes, so only those two exact encodings are admissible.
        registry_bytes = canonical(raw_registry)
        return (registry_sha in {hashlib.sha256(registry_bytes).hexdigest(),
                                 hashlib.sha256(registry_bytes + b"\n").hexdigest()}
                and hashlib.sha256(canonical(retirement) + b"\n").hexdigest()
                == registry.get("receipt_sha256"))
    except (TypeError, ValueError):
        return False


def _validate_existing_control_volume(control: BuildControl) -> dict[str, object]:
    """Authenticate the control volume before any helper mount can create it."""
    import docker_group_storage as group_storage

    try:
        expected_name = group_storage.volume_declaration(control)["name"]
    except BuildControlError as error:
        raise BuildControlError("Selected control volume is not the canonical group volume") from error
    volume = _inspect_existing_volume(expected_name, "Selected control volume")
    labels = volume.get("Labels")
    expected_labels = {
        "com.fullmag.compose.project": control.project,
        "com.fullmag.toolchain.control.schema": CONTROL_VOLUME_SCHEMA,
        "com.fullmag.toolchain.control.project": control.project,
        "com.fullmag.toolchain.control.mount": CONTROL_ROOT,
    }
    optional_labels = {
        key: value for key, value in control.labels.items()
        if isinstance(key, str) and key.startswith("org.fullmag.")
    }
    allowed_labels = set(expected_labels) | set(optional_labels)
    try:
        from docker_named_volume_safety import validate_local_named_volume
        validate_local_named_volume(volume, expected_name)
    except ValueError as error:
        raise BuildControlError("Selected control volume backing differs") from error
    if (
        control.volume != expected_name
        or getattr(control, "shared_labels", None) != expected_labels
        or volume.get("Name") != expected_name
        or volume.get("Driver") != "local"
        or volume.get("Options") not in (None, {})
        or not isinstance(labels, Mapping)
        or any(labels.get(key) != value for key, value in expected_labels.items())
        or any(key in labels and labels.get(key) != value
               and not (key == "org.fullmag.source.worktree-id"
                        and _has_authenticated_source_namespace(control))
               for key, value in optional_labels.items())
        or set(labels) - allowed_labels
    ):
        raise BuildControlError(
            "Selected control volume ownership/driver differs; browser QA retains existing data"
        )
    return volume


def _private_group_storage_mode(receipt: Mapping[str, object]) -> bool:
    """Select the retained single-volume layout without guessing from its name."""
    marker = receipt.get("private_group_storage")
    if marker is None:
        return False
    if marker != "group-volume-v1":
        raise BuildControlError("Development receipt has an unsupported private group storage profile")
    return True


def _control_subpath(control: BuildControl, relative: str) -> str:
    """Resolve a control subpath while keeping namespace and relative path exact."""
    namespace = getattr(control, "namespace", None)
    if (not isinstance(namespace, str)
            or (namespace and re.fullmatch(r"namespaces/[0-9a-f]{32}", namespace) is None)):
        raise BuildControlError("Selected control namespace is malformed")
    expected = "/".join(value for value in (namespace, relative) if value)
    resolver = getattr(control, "subpath", None)
    if not callable(resolver) or resolver(relative) != expected:
        raise BuildControlError("Selected control namespace subpath resolver differs")
    return expected


def _volume_mount_source(mountpoint: object, subpath: str) -> str:
    if not isinstance(mountpoint, str) or not mountpoint.startswith("/"):
        raise BuildControlError("Selected group volume has no canonical Docker mountpoint")
    root = PurePosixPath(mountpoint)
    if str(root) != mountpoint or ".." in root.parts:
        raise BuildControlError("Selected group volume mountpoint is not canonical")
    if not isinstance(subpath, str) or (subpath and (
        subpath.startswith("/") or "\\" in subpath
        or any(part in {"", ".", ".."} for part in subpath.split("/"))
    )):
        raise BuildControlError("Selected group volume subpath is not canonical")
    return str(root.joinpath(*subpath.split("/"))) if subpath else str(root)


def _validate_group_volume_mounts(
    document: Mapping[str, object],
    control: BuildControl,
    volume: Mapping[str, object],
    expected: Mapping[str, tuple[str, bool]],
) -> None:
    """Match Docker declarations and resolved mounts for selected private leaves."""
    host = document.get("HostConfig")
    if not isinstance(host, Mapping):
        raise BuildControlError("Selected service HostConfig is malformed")
    host_mounts = host.get("Mounts")
    actual_mounts = document.get("Mounts")
    if not isinstance(host_mounts, list) or not isinstance(actual_mounts, list):
        raise BuildControlError("Selected service does not expose both configured and resolved mounts")
    if (any(not isinstance(mount, Mapping) for mount in host_mounts)
            or any(not isinstance(mount, Mapping) for mount in actual_mounts)):
        raise BuildControlError("Selected service mount records are malformed")
    host_targets = [mount.get("Target") for mount in host_mounts]
    actual_targets = [mount.get("Destination") for mount in actual_mounts]
    if (any(not isinstance(target, str) or not target for target in host_targets + actual_targets)
            or len(set(host_targets)) != len(host_targets)
            or len(set(actual_targets)) != len(actual_targets)
            or set(host_targets) != set(actual_targets)):
        raise BuildControlError("Selected service configured and resolved mount targets differ")

    targets = set(expected)
    declared = [
        mount for mount in host_mounts
        if isinstance(mount, Mapping)
        and (mount.get("Target") in targets or mount.get("Source") == control.volume)
    ]
    if len(declared) != len(expected) or {mount.get("Target") for mount in declared} != targets:
        raise BuildControlError("Selected service has a missing, duplicate, or extra group-volume declaration")
    for mount in declared:
        target = mount.get("Target")
        subpath, read_only = expected[target]
        options = mount.get("VolumeOptions")
        observed_read_only = mount.get("ReadOnly")
        read_only_matches = (
            observed_read_only is True if read_only
            else observed_read_only is None or observed_read_only is False
        )
        if (mount.get("Type") != "volume" or mount.get("Source") != control.volume
                or not read_only_matches
                or not isinstance(options, Mapping)
                or set(options) != {"NoCopy", "Subpath"}
                or options.get("NoCopy") is not True
                or options.get("Subpath") != subpath):
            raise BuildControlError("Selected service group-volume options differ")

    resolved = [
        mount for mount in actual_mounts
        if isinstance(mount, Mapping)
        and (mount.get("Destination") in targets or mount.get("Name") == control.volume)
    ]
    if (len(resolved) != len(expected)
            or {mount.get("Destination") for mount in resolved} != targets):
        raise BuildControlError("Selected service has a missing, duplicate, or extra resolved group mount")
    mountpoint = volume.get("Mountpoint")
    for mount in resolved:
        target = mount.get("Destination")
        subpath, read_only = expected[target]
        root_source = _volume_mount_source(mountpoint, "")
        role_source = _volume_mount_source(mountpoint, subpath)
        if (mount.get("Type") != "volume" or mount.get("Name") != control.volume
                or mount.get("RW") is not (not read_only)
                or mount.get("Driver") != "local"
                or mount.get("Source") not in {root_source, role_source}):
            raise BuildControlError("Selected service resolved group mount differs from its private subpath")


def _mount_path(value: object) -> str | None:
    if isinstance(value, os.PathLike):
        value = os.fspath(value)
    if not isinstance(value, str) or not value:
        return None
    from docker_volume_activate import _canonical_host_path
    return _canonical_host_path(value) or None


def _source_mount_matches_selected(value: object, expected: Path) -> bool:
    """Match the selected source path, proving Desktop WSL aliases by inode."""
    observed = _mount_path(value)
    expected_key = _mount_path(expected)
    if not observed or not expected_key:
        return False
    if observed == expected_key:
        return True

    # Docker Desktop exposes WSL bind mounts through an opaque daemon path. Only
    # accept its exact alias form, then prove it names the selected local source object.
    # Match the raw source so normpath cannot erase traversal or extra segments.
    if isinstance(value, os.PathLike):
        value = os.fspath(value)
    if not isinstance(value, str):
        return False
    match = DESKTOP_WSL_BIND_ALIAS_RE.fullmatch(value)
    if match is None:
        return False
    distro, token = match.groups()
    local_alias = LOCAL_WSL_BIND_MOUNT_ROOT / distro / token
    expected_path = Path(expected_key)
    try:
        return (
            ((local_alias.is_dir() and expected_path.is_dir())
             or (local_alias.is_file() and expected_path.is_file()))
            and local_alias.samefile(expected_path)
        )
    except OSError:
        return False

def _selected_script_bind_matches(actual: object, selected: Path) -> bool:
    return _source_mount_matches_selected(
        actual, selected / "apps/control-room/scripts"
    )

def _script_bind_groups(selected: Path) -> list[str]:
    # Checkout files may be group-readable (0660) on ext4. The browser stays
    # unprivileged and only gains the source group's read access on RO mounts.
    if os.name != "posix":
        return []
    gid = (selected / "apps/control-room/scripts").stat().st_gid
    return [str(gid)] if gid not in (0, 65532) else []


def _inspector_ack_source_sha256(selected: Path) -> dict[str, str]:
    hashes = {}
    for key, relative in INSPECTOR_ACK_SOURCES.items():
        path = selected / relative
        try:
            with path.open("rb") as source:
                payload = source.read(2 * 1024 * 1024 + 1)
        except OSError as error:
            raise BuildControlError("Selected checkout is missing an Inspector ACK proof source") from error
        if len(payload) > 2 * 1024 * 1024:
            raise BuildControlError("Inspector ACK proof source exceeds its pin bound")
        hashes[key] = hashlib.sha256(payload).hexdigest()
    return hashes


def _validate_inspector_ack_hashes(value) -> None:
    if (not isinstance(value, Mapping) or set(value) != set(INSPECTOR_ACK_SOURCES)
            or any(not isinstance(digest, str) or not SHA256_RE.fullmatch(digest) for digest in value.values())):
        raise BuildControlError("Inspector ACK proof source pins are malformed")


def _study_stage_rerun_source_paths(mode: str) -> dict[str, str]:
    if mode not in {"stage-b", "study", "material-stage-a", "fdm-cell-study", "fdm-cell-study-resume",
                    "texture-stage-b", "texture-study"}:
        raise BuildControlError("Study stage rerun requires a fixed mode")
    sources = dict(STUDY_STAGE_RERUN_SOURCES)
    if mode == "material-stage-a":
        sources.update(STUDY_STAGE_MATERIAL_SOURCES)
    if mode in {"fdm-cell-study", "fdm-cell-study-resume"}:
        sources.update(STUDY_STAGE_FDM_CELL_SOURCES)
    if mode in {"texture-stage-b", "texture-study"}:
        sources.update(STUDY_STAGE_TEXTURE_SOURCES)
    return sources


def _study_stage_rerun_source_sha256(selected: Path, mode: str = "stage-b") -> dict[str, str]:
    hashes = {}
    for key, relative in _study_stage_rerun_source_paths(mode).items():
        path = selected / relative
        try:
            with path.open("rb") as source:
                payload = source.read(2 * 1024 * 1024 + 1)
        except OSError as error:
            raise BuildControlError("Selected checkout is missing a Study stage rerun proof source") from error
        if len(payload) > 2 * 1024 * 1024:
            raise BuildControlError("Study stage rerun proof source exceeds its pin bound")
        hashes[key] = hashlib.sha256(payload).hexdigest()
    return hashes


def _validate_study_stage_rerun_hashes(value, mode: str = "stage-b") -> None:
    try:
        expected_sources = _study_stage_rerun_source_paths(mode)
    except BuildControlError:
        raise
    if (not isinstance(value, Mapping) or set(value) != set(expected_sources)
            or any(not isinstance(digest, str) or not SHA256_RE.fullmatch(digest) for digest in value.values())):
        raise BuildControlError("Study stage rerun source pins are malformed")


def _saved_playback_harness_sha256(selected: Path) -> str:
    harness = selected / "apps/control-room/scripts/check-saved-playback-browser.mjs"
    try:
        with harness.open("rb") as source:
            payload = source.read(2 * 1024 * 1024 + 1)
    except OSError as error:
        raise BuildControlError("Selected checkout is missing the Saved Playback browser harness") from error
    if len(payload) > 2 * 1024 * 1024:
        raise BuildControlError("Saved Playback browser harness exceeds its source pin bound")
    return hashlib.sha256(payload).hexdigest()


def _terminal_telemetry_helper_sha256(selected: Path) -> str:
    harness = selected / "apps/control-room/scripts/docker-dev-terminal-telemetry.mjs"
    try:
        with harness.open("rb") as source:
            payload = source.read(2 * 1024 * 1024 + 1)
    except OSError as error:
        raise BuildControlError("Selected checkout is missing the terminal telemetry browser helper") from error
    if len(payload) > 2 * 1024 * 1024:
        raise BuildControlError("Terminal telemetry browser helper exceeds its source pin bound")
    return hashlib.sha256(payload).hexdigest()


def _run_performance_harness_sha256(selected: Path) -> str:
    harness = selected / "apps/control-room/scripts/docker-dev-browser-qa.mjs"
    try:
        with harness.open("rb") as source:
            payload = source.read(2 * 1024 * 1024 + 1)
    except OSError as error:
        raise BuildControlError("Selected checkout is missing the run performance browser harness") from error
    if len(payload) > 2 * 1024 * 1024:
        raise BuildControlError("Run performance browser harness exceeds its source pin bound")
    return hashlib.sha256(payload).hexdigest()


def _planar_airbox_harness_sha256(selected: Path, relative_path: str) -> str:
    harness = selected / relative_path
    try:
        with harness.open("rb") as source:
            payload = source.read(2 * 1024 * 1024 + 1)
    except OSError as error:
        raise BuildControlError("Selected checkout is missing the planar Airbox browser proof source") from error
    if len(payload) > 2 * 1024 * 1024:
        raise BuildControlError("Planar Airbox browser proof source exceeds its source pin bound")
    return hashlib.sha256(payload).hexdigest()


def _validate_frontend_volume(
    control: BuildControl,
    frontend_volume: str,
    frontend_inputs: Mapping[str, object],
    current: Mapping[str, object] | None = None,
) -> None:
    """Require the selected legacy or single-volume frontend ownership contract."""
    if frontend_inputs.get("schema") != "fullmag.docker-development-inputs.v1":
        raise BuildControlError("Frontend inputs have an unsupported schema")
    dependency_digest = frontend_inputs.get("dependency_seed_sha256")
    toolpins_digest = frontend_inputs.get("toolpins_sha256")
    if not isinstance(dependency_digest, str) or SHA256_RE.fullmatch(dependency_digest) is None:
        raise BuildControlError("Frontend inputs have an invalid dependency seed digest")
    if not isinstance(toolpins_digest, str) or SHA256_RE.fullmatch(toolpins_digest) is None:
        raise BuildControlError("Frontend inputs have an invalid tool pin digest")
    grouped = _private_group_storage_mode(current or {})
    if grouped:
        import docker_group_storage as group_storage

        if frontend_volume != control.volume:
            raise BuildControlError("Frontend state volume differs from the pinned private group volume")
        volume = _validate_existing_control_volume(control)
        try:
            expected_marker = group_storage.owner_manifest(
                control, control.identity.get("source_root"),
            )
            owner_marker = control.read("private/.owner.json", optional=True)
        except BuildControlError:
            raise
        except Exception as error:
            raise BuildControlError("Private group storage owner marker could not be validated") from error
        if not isinstance(owner_marker, Mapping) or dict(owner_marker) != expected_marker:
            raise BuildControlError("Private group storage owner marker differs from selected checkout")
        _volume_mount_source(volume.get("Mountpoint"), group_storage.role_subpath(control, "frontend"))
        _volume_mount_source(volume.get("Mountpoint"), _control_subpath(control, "frontend"))
        return

    from docker_development_inputs import metadata_cache_key
    cache_key = metadata_cache_key(frontend_inputs, control.project)
    expected_name = "fullmag-dev-frontend-v1-" + cache_key[:24]
    if frontend_volume != expected_name:
        raise BuildControlError("Frontend state volume is not the deterministic selected-group volume")
    volume = _inspect_existing_volume(frontend_volume, "Frontend state volume")
    labels = volume.get("Labels")
    expected_labels = {
        key: value for key, value in control.labels.items() if key.startswith("org.fullmag.")
    }
    expected_labels.update(
        {
            "org.fullmag.build.role": "frontend",
            "org.fullmag.build.cache-key": cache_key,
        }
    )
    if (
        volume.get("Name") != expected_name
        or volume.get("Driver") != "local"
        or volume.get("Options")
        or not isinstance(labels, Mapping)
        or any(labels.get(key) != value for key, value in expected_labels.items())
    ):
        raise BuildControlError(
            "Frontend state volume ownership/driver differs; browser QA retains existing data"
        )


def _resolve_selected(args: argparse.Namespace) -> tuple[Path, dict[str, object], dict[str, str]]:
    repo = Path(args.repo_root).resolve(strict=True)
    selected = Path(args.source_root or repo).resolve(strict=True)
    if not selected.is_dir() or selected.is_symlink():
        raise BuildControlError(f"Selected source is not a real checkout: {selected}")
    layout = storage.resolve_layout(selected, "docker-all-gpu")
    identity = compose_project_identity(layout)
    if Path(identity["source_root"]).resolve() != selected:
        raise BuildControlError("Resolved Compose source differs from selected checkout")
    return selected, layout, identity


def _read_live_development(
    control: BuildControl,
    selected: Path,
    identity: Mapping[str, str],
    port: int,
) -> tuple[dict[str, object], str, str, str, dict[str, object]]:
    current = control.read("development/current.json")
    current_fence_sha256 = hashlib.sha256(canonical(current)).hexdigest()
    if isinstance(current, dict) and current.get("state") == "failed-confirmed":
        current = _read_recovered_development(control, current, selected, identity)
    if not isinstance(current, dict) or current.get("state") != "succeeded":
        raise BuildControlError("Browser QA requires a succeeded live volume DEV receipt")
    if current.get("compose_project") != control.project:
        raise BuildControlError("Development receipt belongs to another Compose project")
    inputs = current.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("Development receipt has no standard inputs")
    if inputs.get("source_root") != str(selected):
        raise BuildControlError("Development source differs from selected checkout")
    for key, identity_key in (
        ("source_project_id", "project_id"),
        ("source_worktree_id", "worktree_id"),
        ("source_checkout_kind", "checkout_kind"),
    ):
        if inputs.get(key) != identity[identity_key]:
            raise BuildControlError(f"Development source identity differs: {key}")
    frontend_id = current.get("frontend_container")
    backend_id = current.get("backend_container")
    if not isinstance(backend_id, str) or not backend_id.strip():
        raise BuildControlError("Development receipt has no backend container")
    frontend_volume = current.get("frontend_volume")
    if not isinstance(frontend_id, str) or not frontend_id.strip():
        raise BuildControlError("Development receipt has no frontend container")
    if not isinstance(frontend_volume, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", frontend_volume):
        raise BuildControlError("Development receipt has no owned frontend state volume")
    public_url = current.get("url")
    expected_url = f"http://127.0.0.1:{port}"
    if public_url is not None and public_url != expected_url:
        raise BuildControlError("Development receipt URL differs from requested public port")
    frontend_inputs = control.read("frontend/development-inputs.json")
    if not isinstance(frontend_inputs, dict):
        raise BuildControlError("Frontend development-inputs receipt is invalid")
    if frontend_inputs.get("source_root") != str(selected):
        raise BuildControlError("Frontend inputs source differs from selected checkout")
    if frontend_inputs.get("worktree_id") != identity["worktree_id"]:
        raise BuildControlError("Frontend inputs worktree differs from selected checkout")
    if str(frontend_inputs.get("host_port")) != str(port):
        raise BuildControlError("Frontend inputs port differs from requested public port")
    current = {**current, "development_fence_sha256": current_fence_sha256}
    return current, backend_id, frontend_id, frontend_volume, frontend_inputs


def _read_recovered_development(control, original, selected, identity):
    """Resolve an authenticated recovery without rewriting the original receipt."""
    from docker_volume_activate import _linked_runtime_terminals, _validate_running_group

    attempt = original.get("attempt")
    if not isinstance(attempt, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt):
        raise BuildControlError("Development receipt has no valid original attempt")
    root = "development/attempts/" + attempt
    terminal = control.read(root + "/terminal.json")
    if canonical(terminal) != canonical(original):
        raise BuildControlError("Development current differs from its terminal receipt")
    document = control.read(root + "/compose.json")
    config_sha256 = hashlib.sha256(canonical(document)).hexdigest()
    if original.get("config_sha256") not in (None, config_sha256):
        raise BuildControlError("Development original/config pin differs")
    inputs = original.get("inputs")
    if not isinstance(inputs, Mapping) or inputs.get("source_root") != str(selected):
        raise BuildControlError("Development recovery source differs from selected checkout")
    image = inputs.get("image_id")
    if not isinstance(image, str) or not IMAGE_ID_RE.fullmatch(image):
        raise BuildControlError("Development recovery requires an immutable image")
    linked = _linked_runtime_terminals(
        control, attempt, original, source_root=str(selected), image=image,
        config_sha256=config_sha256,
    )
    matches = {}
    for recovered in linked:
        try:
            ids = _validate_running_group(
                control, identity, document, recovered, image, source_root=str(selected),
            )
        except BuildControlError:
            continue
        matches.setdefault(ids, []).append(recovered)
    if len(matches) != 1:
        raise BuildControlError("Development recovery does not identify exactly one live group")
    recovered = max(next(iter(matches.values())), key=lambda item: item.get("finished_at", 0))
    # Keep the development attempt and its standard source/image inputs. The
    # effective runtime has separate provenance, never a fabricated DEV success.
    return {
        **original, **recovered, "inputs": inputs, "attempt": attempt,
        "phase": original.get("phase"), "config_sha256": config_sha256,
        "runtime_phase": recovered["phase"], "runtime_attempt": recovered["attempt"],
        "runtime_terminal_sha256": hashlib.sha256(canonical(recovered)).hexdigest(),
        "development_terminal_state": original["state"],
    }


def _validate_shared_frontend_pnpm(document, identity):
    """Admit only the canonical project-scoped pnpm mount introduced by DEV."""
    import docker_shared_build_storage as shared
    from docker_named_volume_safety import validate_local_named_volume
    target = shared.SHARED_PNPM_TARGET
    values = [entry.split("=", 1)[1] for entry in document.get("Config", {}).get("Env", [])
              if isinstance(entry, str) and entry.startswith("FULLMAG_SHARED_PNPM_STORE=")]
    mounts = document.get("Mounts") or []
    if not values and not any(isinstance(m, Mapping) and m.get("Destination") == target for m in mounts):
        return set()
    if values != [target]:
        raise BuildControlError("Frontend shared pnpm environment differs")
    if not isinstance(identity.get("project_id"), str):
        raise BuildControlError("Frontend shared pnpm cache project identity is unavailable")
    descriptor = shared.volume_descriptors(identity["project_id"])[shared.PNPM_ROLE]
    matches = [m for m in mounts if isinstance(m, Mapping) and
               (m.get("Destination") == target or m.get("Name") == descriptor["name"])]
    if (len(matches) != 1 or matches[0].get("Type") != "volume"
            or matches[0].get("Destination") != target or matches[0].get("Name") != descriptor["name"]
            or matches[0].get("RW") is not True):
        raise BuildControlError("Frontend shared pnpm mount identity differs")
    declarations = [m for m in document.get("HostConfig", {}).get("Mounts", [])
                    if isinstance(m, Mapping) and m.get("Target") == target]
    if (len(declarations) != 1 or declarations[0].get("Type") != "volume"
            or declarations[0].get("Source") != descriptor["name"]
            or declarations[0].get("ReadOnly", False) is not False
            or declarations[0].get("VolumeOptions") != {"NoCopy": True, "Subpath": "store"}):
        raise BuildControlError("Frontend shared pnpm subpath declaration differs")
    volume = _inspect_existing_volume(descriptor["name"], "Shared frontend pnpm")
    try:
        validate_local_named_volume(volume, descriptor["name"])
    except ValueError as error:
        raise BuildControlError(str(error)) from error
    labels = volume.get("Labels") or {}
    if labels != descriptor["labels"]:
        raise BuildControlError("Frontend shared pnpm ownership differs")
    return {descriptor["name"]}


def _validate_private_group_compose(
    compose: Mapping[str, object],
    control: BuildControl,
    current: Mapping[str, object],
) -> None:
    """Validate retained frontend/backend/ledger leaves for group-volume-v1."""
    import docker_backend_volume_cache as backend_cache
    import docker_group_ledger as group_ledger
    import docker_group_storage as group_storage

    if not _private_group_storage_mode(current):
        raise BuildControlError("Private group Compose validation has no pinned layout marker")
    volumes = compose.get("volumes")
    services = compose.get("services")
    if not isinstance(volumes, Mapping) or not isinstance(services, Mapping):
        raise BuildControlError("Retained private group Compose services or volumes are malformed")

    def require_group_volume(alias: str) -> None:
        declaration = volumes.get(alias)
        if (not isinstance(declaration, Mapping)
                or dict(declaration) != {"name": control.volume, "external": True}):
            raise BuildControlError("Retained private group volume declaration differs")

    try:
        group_storage.volume_declaration(control)
        frontend_subpath = group_storage.role_subpath(control, "frontend")
        backend_subpath = group_storage.role_subpath(control, "backend")
        ledger_subpath = group_storage.role_subpath(control, "ledger")
        control_subpath = _control_subpath(control, "frontend")
        expected_frontend_mount = group_storage.compose_mount_descriptor(
            control, "frontend", "/state/development", compose_name="frontend-build",
        )
        expected_backend_mount = group_storage.compose_mount_descriptor(
            control, "backend", backend_cache.BUILD_TARGET,
            compose_name=backend_cache.COMPOSE_BUILD_VOLUME,
        )
    except BuildControlError:
        raise
    except Exception as error:
        raise BuildControlError("Retained private group storage paths are invalid") from error

    frontend = services.get("frontend")
    backend = services.get("backend")
    if not isinstance(frontend, Mapping) or not isinstance(backend, Mapping):
        raise BuildControlError("Retained private group Compose service is missing")
    frontend_environment = frontend.get("environment")
    backend_environment = backend.get("environment")
    if (not isinstance(frontend_environment, Mapping)
            or frontend_environment.get("FULLMAG_PRIVATE_GROUP_STORAGE") != "group-volume-v1"
            or frontend_environment.get("FULLMAG_DEVELOPMENT_INPUTS_PATH")
            != "/opt/fullmag/control/development-inputs.json"
            or not isinstance(backend_environment, Mapping)
            or backend_environment.get("FULLMAG_PRIVATE_GROUP_STORAGE") != "group-volume-v1"):
        raise BuildControlError("Retained private group Compose marker differs")

    for alias in ("frontend-build", "build-control", backend_cache.COMPOSE_BUILD_VOLUME,
                  group_ledger.COMPOSE_VOLUME):
        require_group_volume(alias)

    frontend_mounts = frontend.get("volumes")
    if not isinstance(frontend_mounts, list):
        raise BuildControlError("Retained frontend has no explicit volume declarations")
    expected_control_mount = {
        "type": "volume",
        "source": "build-control",
        "target": "/opt/fullmag/control",
        "read_only": True,
        "volume": {"nocopy": True, "subpath": control_subpath},
    }
    for target, expected_mount in (
        ("/state/development", expected_frontend_mount),
        ("/opt/fullmag/control", expected_control_mount),
    ):
        matches = [mount for mount in frontend_mounts
                   if isinstance(mount, Mapping) and mount.get("target") == target]
        expected_shapes = [expected_mount]
        if target == "/state/development" and expected_mount.get("read_only") is False:
            no_explicit_rw = dict(expected_mount)
            no_explicit_rw.pop("read_only")
            expected_shapes.append(no_explicit_rw)
        if len(matches) != 1 or dict(matches[0]) not in expected_shapes:
            raise BuildControlError("Retained frontend role/control subpath mount differs")

    group_aliases = {
        alias for alias, declaration in volumes.items()
        if isinstance(alias, str) and isinstance(declaration, Mapping)
        and declaration.get("name") == control.volume
    }
    frontend_group_mounts = [mount for mount in frontend_mounts
                             if isinstance(mount, Mapping)
                             and mount.get("source") in group_aliases]
    if (len(frontend_group_mounts) != 2
            or {mount.get("target") for mount in frontend_group_mounts}
            != {"/state/development", "/opt/fullmag/control"}):
        raise BuildControlError("Retained frontend exposes an extra group-volume path")

    backend_mounts = backend.get("volumes")
    if not isinstance(backend_mounts, list):
        raise BuildControlError("Retained backend has no explicit volume declarations")
    build_mounts = [mount for mount in backend_mounts
                    if isinstance(mount, Mapping) and mount.get("target") == backend_cache.BUILD_TARGET]
    if len(build_mounts) != 1 or dict(build_mounts[0]) != expected_backend_mount:
        raise BuildControlError("Retained backend cache mount is not its private/backend subpath")
    backend_group_mounts = [mount for mount in backend_mounts
                            if isinstance(mount, Mapping)
                            and mount.get("source") in group_aliases]
    if any(mount.get("target") == "/" for mount in backend_group_mounts):
        raise BuildControlError("Retained backend exposes the private group volume root")

    backend_image = (current.get("inputs") or {}).get("image_id")
    try:
        ledger = group_ledger.retained_profile(compose, backend_image)
    except Exception as error:
        raise BuildControlError("Retained group ledger mount/profile is invalid") from error
    if (ledger.get("volume_name") != control.volume
            or ledger.get("ledger_subpath") != ledger_subpath):
        raise BuildControlError("Retained group ledger is not the private/ledger subpath")
    if backend_subpath != expected_backend_mount["volume"].get("subpath"):
        raise BuildControlError("Retained backend subpath is not canonical")


def _validate_frontend(
    document: dict[str, object],
    control: BuildControl,
    identity: Mapping[str, str],
    frontend_volume: str,
    current: Mapping[str, object],
    port: int,
    *, cache_project_id: str | None = None,
) -> None:
    grouped = _private_group_storage_mode(current)
    if grouped and frontend_volume != control.volume:
        raise BuildControlError("Frontend state volume differs from the pinned private group volume")
    try:
        validate_source_labels(document, identity)
    except ValueError as error:
        raise BuildControlError(str(error)) from error
    config = document.get("Config")
    host = document.get("HostConfig")
    network_settings = document.get("NetworkSettings")
    if not isinstance(config, Mapping) or not isinstance(host, Mapping) or not isinstance(network_settings, Mapping):
        raise BuildControlError("Frontend inspect document is incomplete")
    labels = config.get("Labels") or {}
    if labels.get("com.docker.compose.project") != control.project or labels.get("com.docker.compose.service") != "frontend":
        raise BuildControlError("Observed frontend is outside the selected Compose service")
    state = document.get("State")
    if not isinstance(state, Mapping) or state.get("Running") is not True:
        raise BuildControlError("Selected frontend is not running")
    attempt = current.get("attempt")
    digest = current.get("config_sha256")
    if (not isinstance(attempt, str) or re.fullmatch(r"[0-9a-f]{32}", attempt) is None
            or not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None):
        raise BuildControlError("Development receipt has no exact Compose attempt/configuration pin")
    compose = control.read(f"development/attempts/{attempt}/compose.json")
    if (not isinstance(compose, Mapping) or compose.get("name") != control.project
            or hashlib.sha256(canonical(compose)).hexdigest() != digest):
        raise BuildControlError("Pinned development Compose identity/configuration differs")
    services = compose.get("services")
    if (not isinstance(services, Mapping) or not isinstance(services.get("frontend"), Mapping)
            or not isinstance(services.get("backend"), Mapping)
            or services["backend"].get("image") != (current.get("inputs") or {}).get("image_id")):
        raise BuildControlError("Pinned development service image declarations differ")
    if grouped:
        _validate_private_group_compose(compose, control, current)
    expected_image = services["frontend"].get("image")
    if (not isinstance(expected_image, str) or IMAGE_ID_RE.fullmatch(expected_image) is None
            or document.get("Image") != expected_image):
        raise BuildControlError("Observed frontend image differs from its pinned Compose service")
    if host.get("NetworkMode") in {"host", "none"}:
        raise BuildControlError("Frontend uses a forbidden host/none network")
    networks = network_settings.get("Networks") or {}
    if set(networks) != {identity["network_name"]}:
        raise BuildControlError("Frontend is not attached only to the selected private network")
    bindings = host.get("PortBindings")
    expected_bindings = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
    if bindings != expected_bindings:
        raise BuildControlError("Frontend must publish exactly the requested loopback port")
    mounts = document.get("Mounts") or []
    if not isinstance(mounts, list):
        raise BuildControlError("Frontend mount inspection is invalid")
    if grouped:
        import docker_group_storage as group_storage

        volume = _validate_existing_control_volume(control)
        _validate_group_volume_mounts(document, control, volume, {
            "/state/development": (group_storage.role_subpath(control, "frontend"), False),
            "/opt/fullmag/control": (_control_subpath(control, "frontend"), True),
        })
    else:
        state_mounts = [m for m in mounts if isinstance(m, Mapping) and m.get("Destination") == "/state/development"]
        if len(state_mounts) != 1 or state_mounts[0].get("Type") != "volume" or state_mounts[0].get("Name") != frontend_volume or state_mounts[0].get("RW") is not True:
            raise BuildControlError("Frontend state mount is not the retained named volume")
        control_mounts = [m for m in mounts if isinstance(m, Mapping) and m.get("Destination") == "/opt/fullmag/control"]
        if len(control_mounts) != 1 or control_mounts[0].get("Type") != "volume" or control_mounts[0].get("Name") != control.volume or control_mounts[0].get("RW") is not False:
            raise BuildControlError("Frontend control mount is not the selected readonly control namespace")
    shared_volumes = _validate_shared_frontend_pnpm(document, {"project_id": cache_project_id})
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise BuildControlError("Frontend mount record is invalid")
        if mount.get("Type") == "bind" and mount.get("RW") is not False:
            raise BuildControlError("Frontend has a writable host bind")
        if mount.get("Type") == "volume" and mount.get("Name") not in {frontend_volume, control.volume, *shared_volumes}:
            raise BuildControlError("Frontend has an unexpected named volume")


def _validate_browser_image_reference(image: str) -> None:
    match = BROWSER_IMAGE_RE.fullmatch(image)
    if match is None or match.group(1) not in BROWSER_IMAGE_DIGESTS:
        raise BuildControlError("Browser QA requires the official immutable Playwright v1.62.1 Noble pin")


def _inspect_image(identifier: str) -> dict[str, object] | None:
    result = docker_capture("image", "inspect", identifier, allow_failure=True)
    if result.returncode:
        diagnostics = (result.stderr + result.stdout).decode("utf-8", "replace")
        if re.search(r"no such (?:image|object)|not found|reference does not exist", diagnostics, re.IGNORECASE):
            return None
        raise BuildControlError("Docker image inspect failed: " + diagnostics[-2048:])
    try:
        records = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        raise BuildControlError("Docker image inspect returned invalid JSON") from error
    if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
        raise BuildControlError("Docker image inspect did not identify exactly one image")
    return records[0]


def _canonical_repo_digest(image: str) -> str:
    repository_with_tag, digest = image.split("@", 1)
    repository = repository_with_tag.rsplit(":", 1)[0]
    return f"{repository}@{digest}"


def _validate_browser_image_document(document: Mapping[str, object], image: str) -> tuple[str, str]:
    image_id = document.get("Id")
    if not isinstance(image_id, str) or IMAGE_ID_RE.fullmatch(image_id) is None:
        raise BuildControlError("Pinned browser image did not resolve to one immutable image ID")
    expected_repo_digest = _canonical_repo_digest(image)
    repo_digests = document.get("RepoDigests")
    if not isinstance(repo_digests, list):
        raise BuildControlError("Pinned browser image inspect did not retain the requested RepoDigest")
    repository = expected_repo_digest.split("@", 1)[0]
    accepted = {
        f"{repository}@sha256:{digest}"
        for digest in BROWSER_IMAGE_DIGESTS
    }
    observed = [digest for digest in repo_digests if isinstance(digest, str) and digest in accepted]
    if not observed:
        raise BuildControlError("Pinned browser image inspect did not retain a known RepoDigest")
    return image_id, expected_repo_digest if expected_repo_digest in observed else observed[0]


def _space_preflight(control: BuildControl) -> dict[str, object]:
    space = control.space()
    backing = space.get("windows_backing_volume")
    backing_available = (
        backing.get("available_bytes")
        if isinstance(backing, Mapping)
        else space.get("available_bytes", -1)
    )
    available = min(
        space.get("available_bytes", -1),
        backing_available,
    )
    if not isinstance(available, int) or available < MIN_FREE_BUILD_BYTES:
        raise BuildControlError("Docker filesystem has less than 32 GiB free; browser image pull refused")
    return space


def _ensure_browser_image(
    operation: dict[str, object],
    control: BuildControl,
    document: dict[str, object],
    image: str,
    pull_timeout: int,
) -> tuple[str, dict[str, object]]:
    _validate_browser_image_reference(image)
    root = operation["root"]
    operation["receipt"]["browser_image_pull_timeout"] = pull_timeout
    existing = _inspect_image(image)
    if existing is not None:
        image_id, repo_digest = _validate_browser_image_document(existing, image)
        operation["receipt"].update(
            browser_image=image,
            browser_image_id=image_id,
            browser_image_repo_digest=repo_digest,
            browser_image_source="local-reuse",
            browser_image_pull_state="reused",
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "reused",
            "image": image,
            "image_id": image_id,
            "repo_digest": repo_digest,
        })
        control.write(root + "/receipt.json", operation["receipt"])
        return image_id, existing

    try:
        preflight = _space_preflight(control)
    except BuildControlError as error:
        if isinstance(error, ControlOutcomeUnknown):
            raise
        operation["receipt"].update(
            browser_image=image,
            browser_image_source="compose-pull",
            browser_image_pull_state="preflight-failed",
            browser_image_pull_error=str(error),
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "preflight-failed",
            "image": image,
            "compose_project": control.project,
            "error": str(error)[:2048],
        })
        control.write(root + "/receipt.json", operation["receipt"])
        raise
    pull_document = deepcopy(document)
    pull_service = pull_document.get("services", {}).get("browser-qa")
    if not isinstance(pull_service, dict):
        raise BuildControlError("Browser pull Compose document has no browser-qa service")
    pull_service["pull_policy"] = "missing"
    operation["receipt"].update(
        browser_image=image,
        browser_image_source="compose-pull",
        browser_image_pull_state="starting",
        browser_image_pull_preflight=preflight,
    )
    control.write(root + "/browser-image-pull.json", {
        "schema": "fullmag.docker-dev-browser-qa-image.v1",
        "state": "starting",
        "image": image,
        "compose_project": control.project,
        "preflight": preflight,
    })
    control.write(root + "/receipt.json", operation["receipt"])
    operation["daemon_pending"] = True
    try:
        pulled = docker_capture(
            "compose",
            "--project-name",
            control.project,
            "--ansi",
            "never",
            "-f",
            "-",
            "pull",
            "browser-qa",
            data=canonical(pull_document),
            timeout=pull_timeout,
            allow_failure=True,
        )
    except ControlOutcomeUnknown as error:
        operation["receipt"].update(
            browser_image_pull_state="outcome-unknown-resources-retained",
            browser_image_pull_error=str(error),
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "outcome-unknown-resources-retained",
            "image": image,
            "compose_project": control.project,
            "error": str(error)[:2048],
        })
        control.write(root + "/receipt.json", operation["receipt"])
        raise
    if pulled.returncode:
        operation["daemon_pending"] = False
        error = "Managed browser image pull failed"
        operation["receipt"].update(
            browser_image_pull_state="failed-confirmed",
            browser_image_pull_exit_code=pulled.returncode,
            browser_image_pull_error=error,
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "failed-confirmed",
            "image": image,
            "compose_project": control.project,
            "exit_code": pulled.returncode,
            "stdout_tail": _text(pulled.stdout),
            "stderr_tail": _text(pulled.stderr),
            "error": error,
        })
        control.write(root + "/receipt.json", operation["receipt"])
        raise BuildControlError(error)

    try:
        pulled_image = _inspect_image(image)
    except (BuildControlError, ControlOutcomeUnknown) as error:
        operation["receipt"].update(
            browser_image_pull_state="outcome-unknown-resources-retained",
            browser_image_pull_error=str(error),
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "outcome-unknown-resources-retained",
            "image": image,
            "compose_project": control.project,
            "error": str(error)[:2048],
        })
        control.write(root + "/receipt.json", operation["receipt"])
        raise ControlOutcomeUnknown("Pulled browser image identity was not confirmed") from error
    if pulled_image is None:
        operation["receipt"].update(
            browser_image_pull_state="outcome-unknown-resources-retained",
            browser_image_pull_error="Compose pull returned but image is absent",
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "outcome-unknown-resources-retained",
            "image": image,
            "compose_project": control.project,
            "error": "Compose pull returned but image is absent",
        })
        control.write(root + "/receipt.json", operation["receipt"])
        raise ControlOutcomeUnknown("Compose pull returned but pinned browser image is absent")
    try:
        image_id, repo_digest = _validate_browser_image_document(pulled_image, image)
    except BuildControlError as error:
        operation["daemon_pending"] = False
        operation["receipt"].update(
            browser_image_pull_state="failed-confirmed",
            browser_image_pull_error=str(error),
        )
        control.write(root + "/browser-image-pull.json", {
            "schema": "fullmag.docker-dev-browser-qa-image.v1",
            "state": "failed-confirmed",
            "image": image,
            "compose_project": control.project,
            "error": str(error)[:2048],
        })
        control.write(root + "/receipt.json", operation["receipt"])
        raise
    operation["daemon_pending"] = False
    operation["receipt"].update(
        browser_image=image,
        browser_image_id=image_id,
        browser_image_repo_digest=repo_digest,
        browser_image_pull_state="succeeded",
    )
    control.write(root + "/browser-image-pull.json", {
        "schema": "fullmag.docker-dev-browser-qa-image.v1",
        "state": "succeeded",
        "image": image,
        "compose_project": control.project,
        "image_id": image_id,
        "repo_digest": repo_digest,
        "stdout_tail": _text(pulled.stdout),
        "stderr_tail": _text(pulled.stderr),
    })
    control.write(root + "/receipt.json", operation["receipt"])
    return image_id, pulled_image


def _compose_document(
    selected: Path,
    identity: Mapping[str, str],
    browser_image: str,
    frontend_volume: str,
    port: int,
    timeout: int,
    prepare_viewport_fixture: bool = False,
    canvas_only: bool | None = None,
    expect_live_field: str | None = None,
    expect_airbox_vectors: bool | None = None,
    expect_ambiguous_compute_fields: bool | None = None,
    airbox_inspector: bool = False,
    saved_playback_item_id: str | None = None,
    source_script_sha256: str | None = None,
    expect_fem_airbox_vectors: bool | None = None,
    expect_terminal_telemetry: bool | None = None,
    expect_run_performance: bool | None = None,
    expect_planar_airbox: bool = False,
    control: BuildControl | None = None,
    private_group_storage: bool = False,
    inspector_ack: bool = False,
    inspector_ack_source_sha256: Mapping[str, str] | None = None,
    study_stage_rerun: str | None = None,
    study_stage_rerun_source_sha256: Mapping[str, str] | None = None,
    study_stage_rerun_resume_evidence: Mapping[str, object] | None = None,
) -> dict[str, object]:
    if type(inspector_ack) is not bool:
        raise BuildControlError("Inspector ACK scenario marker must be boolean")
    if inspector_ack:
        _validate_inspector_ack_hashes(inspector_ack_source_sha256)
        if (prepare_viewport_fixture or canvas_only is not None or expect_live_field is not None
                or expect_airbox_vectors is not None or expect_ambiguous_compute_fields is not None
                or airbox_inspector or saved_playback_item_id is not None
                or expect_fem_airbox_vectors is not None or expect_terminal_telemetry is True
                or expect_run_performance is True or expect_planar_airbox):
            raise BuildControlError("Inspector ACK QA is a separate task-owned live-resource scenario")
    elif inspector_ack_source_sha256 is not None:
        raise BuildControlError("Inspector ACK source pins require their scenario")
    if study_stage_rerun is not None:
        if study_stage_rerun not in {"stage-b", "study", "material-stage-a", "fdm-cell-study",
                                     "fdm-cell-study-resume", "texture-stage-b", "texture-study"}:
            raise BuildControlError("Study stage rerun requires one of the fixed profiles")
        _validate_study_stage_rerun_hashes(study_stage_rerun_source_sha256, study_stage_rerun)
        if study_stage_rerun == "fdm-cell-study-resume":
            _validate_fdm_grid_resume_evidence_shape(
                study_stage_rerun_resume_evidence, study_stage_rerun_source_sha256,
            )
        elif study_stage_rerun_resume_evidence is not None:
            raise BuildControlError("FDM grid resume evidence requires its fixed resume profile")
        if (prepare_viewport_fixture or canvas_only is not None or expect_live_field is not None
                or expect_airbox_vectors is not None or expect_ambiguous_compute_fields is not None
                or airbox_inspector or saved_playback_item_id is not None
                or expect_fem_airbox_vectors is not None or expect_terminal_telemetry is True
                or expect_run_performance is True or expect_planar_airbox or inspector_ack):
            raise BuildControlError("Study stage rerun is a separate task-owned runtime command scenario")
    elif study_stage_rerun_source_sha256 is not None or study_stage_rerun_resume_evidence is not None:
        raise BuildControlError("Study stage rerun source pins require their scenario")
    if type(private_group_storage) is not bool:
        raise BuildControlError("Browser QA private group storage marker must be boolean")
    if type(expect_planar_airbox) is not bool:
        raise BuildControlError("Planar Airbox browser expectation must be boolean")
    frontend_state_volume = {"type": "volume", "source": "frontend-state",
                             "target": "/state/development", "read_only": True,
                             "volume": {"nocopy": True}}
    if private_group_storage:
        import docker_group_storage as group_storage

        if (control is None or control.project != identity.get("project_name")
                or frontend_volume != control.volume):
            raise BuildControlError("Browser QA private group volume differs from the selected BuildControl")
        try:
            group_storage.volume_declaration(control)
            frontend_state_volume["volume"]["subpath"] = group_storage.role_subpath(control, "frontend")
        except BuildControlError:
            raise
        except Exception as error:
            raise BuildControlError("Browser QA private frontend subpath is invalid") from error
    elif control is not None and control.project != identity.get("project_name"):
        raise BuildControlError("Browser QA BuildControl belongs to another Compose project")
    if saved_playback_item_id is not None:
        if not re.fullmatch(r"[0-9]{1,20}", saved_playback_item_id):
            raise BuildControlError("Saved Playback QA requires a decimal item id of at most 20 digits")
        if not isinstance(source_script_sha256, str) or not SHA256_RE.fullmatch(source_script_sha256):
            raise BuildControlError("Saved Playback QA requires the selected harness SHA-256")
        if (
            prepare_viewport_fixture
            or canvas_only is not None
            or expect_live_field is not None
            or expect_airbox_vectors is not None
            or expect_fem_airbox_vectors is True
            or expect_terminal_telemetry is True
            or expect_run_performance is True
            or expect_planar_airbox
            or expect_ambiguous_compute_fields is not None
            or airbox_inspector
        ):
            raise BuildControlError("Saved Playback QA is a separate read-only browser scenario")
    elif source_script_sha256 is not None:
        raise BuildControlError("A saved playback harness hash requires its item id")
    if canvas_only is True and prepare_viewport_fixture:
        raise BuildControlError("Canvas-only browser QA cannot prepare a viewport fixture")
    if (expect_live_field is not None or expect_airbox_vectors is True) and canvas_only is not True:
        raise BuildControlError("Live-field expectations require --canvas-only")
    if expect_airbox_vectors is True and not expect_live_field:
        raise BuildControlError("Airbox-vector expectation requires an expected live field")
    if expect_fem_airbox_vectors is True and (
        canvas_only is not True
        or expect_live_field != "m"
        or expect_airbox_vectors is True
        or expect_ambiguous_compute_fields is True
        or prepare_viewport_fixture
        or expect_terminal_telemetry is True
        or expect_run_performance is True
    ):
        raise BuildControlError(
            "FEM Airbox-vector QA requires canvas-only m readiness and excludes other scenarios"
        )
    if expect_ambiguous_compute_fields is True and canvas_only is not True:
        raise BuildControlError("Ambiguous Compute Fields QA requires --canvas-only")
    if expect_terminal_telemetry is True and (
        canvas_only is not True
        or expect_live_field != "m"
        or expect_airbox_vectors is True
        or expect_fem_airbox_vectors is True
        or expect_ambiguous_compute_fields is True
        or prepare_viewport_fixture
    ):
        raise BuildControlError(
            "Terminal telemetry QA requires canvas-only primary m observation and excludes mutation scenarios"
        )
    if expect_run_performance is True and (
        canvas_only is not True
        or expect_live_field is not None
        or expect_airbox_vectors is True
        or expect_fem_airbox_vectors is True
        or expect_ambiguous_compute_fields is True
        or expect_terminal_telemetry is True
        or prepare_viewport_fixture
        or airbox_inspector
        or saved_playback_item_id is not None
    ):
        raise BuildControlError(
            "Run performance QA requires standalone canvas-only scope and excludes other browser scenarios"
        )
    if expect_planar_airbox and (
        canvas_only is not True
        or expect_live_field != "m"
        or expect_airbox_vectors is not False
        or prepare_viewport_fixture
        or expect_fem_airbox_vectors is True
        or expect_terminal_telemetry is True
        or expect_run_performance is True
        or expect_ambiguous_compute_fields is not False
        or airbox_inspector
        or saved_playback_item_id is not None
    ):
        raise BuildControlError(
            "Planar Airbox QA requires canvas-only m readiness and excludes other browser scenarios"
        )
    if airbox_inspector and (
        prepare_viewport_fixture
        or canvas_only is not None
        or expect_live_field is not None
        or expect_airbox_vectors is not None
        or expect_fem_airbox_vectors is not None
        or expect_terminal_telemetry is True
        or expect_run_performance is True
        or expect_ambiguous_compute_fields is not None
        or saved_playback_item_id is not None
    ):
        raise BuildControlError("Airbox Inspector QA is a separate live-resource scenario")
    labels = {
        **source_labels(identity),
        "org.fullmag.browser-qa.schema": OPERATION_SCHEMA,
        "org.fullmag.browser-qa.playwright-version": PLAYWRIGHT_VERSION,
    }
    environment = {
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "NODE_ENV": "test",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
        # The browser uses the private Compose service path. The
        # host wrapper separately probes the published loopback URL.
        "CONTROL_ROOM_URL": "http://frontend:8080",
        "CONTROL_ROOM_PUBLIC_URL": f"http://127.0.0.1:{port}",
        "CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION": PLAYWRIGHT_VERSION,
        "CONTROL_ROOM_BROWSER_GPU_MODE": "swiftshader-webgl-requested",
        "CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS": str(timeout * 1000),
        "NVIDIA_VISIBLE_DEVICES": "void",
    }
    if private_group_storage:
        environment["FULLMAG_PRIVATE_GROUP_STORAGE"] = "group-volume-v1"
    if inspector_ack:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "inspector-ack"
        environment["CONTROL_ROOM_INSPECTOR_ACK_SOURCE_SHA256"] = canonical(dict(inspector_ack_source_sha256)).decode("utf-8")
    elif study_stage_rerun is not None:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "study-stage-rerun"
        environment["CONTROL_ROOM_STUDY_STAGE_RERUN_MODE"] = study_stage_rerun
        environment["CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256"] = canonical(
            dict(study_stage_rerun_source_sha256)
        ).decode("utf-8")
        if study_stage_rerun == "fdm-cell-study-resume":
            resume_raw = canonical(dict(study_stage_rerun_resume_evidence)).decode("utf-8")
            if len(resume_raw.encode("utf-8")) > 128 * 1024:
                raise BuildControlError("FDM grid resume evidence exceeds its environment bound")
            environment["CONTROL_ROOM_STUDY_STAGE_RERUN_RESUME_EVIDENCE"] = resume_raw
    elif airbox_inspector:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "airbox-inspector"
    elif saved_playback_item_id is not None:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "saved-playback"
        environment["CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_ITEM_ID"] = saved_playback_item_id
        environment["CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_SCRIPT_SHA256"] = source_script_sha256
    elif expect_planar_airbox:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "planar-airbox"
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_PLANAR_AIRBOX"] = "1"
    if prepare_viewport_fixture:
        environment["CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE"] = "1"
    if canvas_only is not None:
        environment["CONTROL_ROOM_BROWSER_QA_CANVAS_ONLY"] = "1" if canvas_only else "0"
    if expect_airbox_vectors is not None:
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_LIVE_FIELD"] = expect_live_field or ""
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS"] = "1" if expect_airbox_vectors else "0"
    if expect_fem_airbox_vectors is True:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "fem-airbox-vectors"
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_FEM_AIRBOX_VECTORS"] = "1"
    if expect_terminal_telemetry is True:
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_TERMINAL_TELEMETRY"] = "1"
    if expect_run_performance is True:
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_RUN_PERFORMANCE"] = "1"
    if expect_ambiguous_compute_fields is not None:
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS"] = (
            "1" if expect_ambiguous_compute_fields else "0"
        )
    browser_volumes = [
        frontend_state_volume,
        {
            "type": "bind",
            "source": str(selected / "apps/control-room/scripts"),
            "target": "/state/development/workspace/apps/control-room/scripts",
            "read_only": True,
            "bind": {"create_host_path": False},
        },
    ]
    if study_stage_rerun is not None:
        browser_volumes.extend([
            {
                "type": "bind",
                "source": str(selected / "apps/control-room/src"),
                "target": STUDY_STAGE_RERUN_SRC_TARGET,
                "read_only": True,
                "bind": {"create_host_path": False},
            },
            {
                "type": "bind",
                "source": str(selected / STUDY_STAGE_RERUN_SOURCES["fixture"]),
                "target": STUDY_STAGE_RERUN_FIXTURE_TARGET,
                "read_only": True,
                "bind": {"create_host_path": False},
            },
        ])
    return {
        "name": identity["project_name"],
        "services": {
            "browser-qa": {
                "image": browser_image,
                "pull_policy": "never",
                "labels": labels,
                "read_only": True,
                "init": True,
                "restart": "no",
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
                "pids_limit": 256,
                "mem_limit": "2g",
                "cpus": 2,
                "shm_size": "256m",
                "logging": {"driver": "none"},
                "environment": environment,
                "user": "65532:65532",
                "group_add": _script_bind_groups(selected),
                "working_dir": "/state/development/workspace/apps/control-room",
                "command": (
                    [
                        "node",
                        "/state/development/workspace/apps/control-room/scripts/check-saved-playback-browser.mjs",
                        "http://frontend:8080",
                        saved_playback_item_id,
                    ]
                    if saved_playback_item_id is not None
                    else [
                        "node",
                        "/state/development/workspace/apps/control-room/scripts/check-study-stage-rerun-browser.mjs",
                        study_stage_rerun,
                    ]
                    if study_stage_rerun is not None
                    else [
                        "node",
                        "/state/development/workspace/apps/control-room/scripts/"
                        + ("check-inspector-ack-browser.mjs" if inspector_ack
                           else "verify-airbox-inspector.mjs" if airbox_inspector else "docker-dev-browser-qa.mjs"),
                    ]
                ),
                "volumes": browser_volumes,
                "tmpfs": ["/tmp:rw,nosuid,nodev,size=256m"],
                "networks": {"fullmag": {"aliases": ["browser-qa"]}},
            }
        },
        "volumes": {
            "frontend-state": {"name": frontend_volume, "external": True},
        },
        "networks": {
            "fullmag": {"name": identity["network_name"], "external": True},
        },
    }


def _validate_browser_helper_source_mount(document, selected: Path, relative_source: str, target: str) -> None:
    host = document.get("HostConfig") or {}
    host_mounts = host.get("Mounts")
    resolved_mounts = document.get("Mounts") or []
    configured = [mount for mount in host_mounts or [] if isinstance(mount, Mapping) and mount.get("Target") == target]
    resolved = [mount for mount in resolved_mounts if isinstance(mount, Mapping) and mount.get("Destination") == target]
    if (not isinstance(host_mounts, list) or len(configured) != 1 or len(resolved) != 1
            or configured[0].get("Type") != "bind" or configured[0].get("ReadOnly") is not True
            or not _source_mount_matches_selected(configured[0].get("Source"), selected / relative_source)
            or resolved[0].get("Type") != "bind" or resolved[0].get("RW") is not False
            or not _source_mount_matches_selected(resolved[0].get("Source"), selected / relative_source)):
        raise ControlOutcomeUnknown("Browser helper proof source is not the exact selected readonly bind: " + target)


def _validate_browser_helper(
    document: dict[str, object],
    control: BuildControl,
    identity: Mapping[str, str],
    frontend_volume: str,
    browser_image_id: str,
    exit_code: int,
    selected: Path,
    canvas_only: bool | None = None,
    expect_live_field: str | None = None,
    expect_airbox_vectors: bool | None = None,
    expect_ambiguous_compute_fields: bool | None = None,
    airbox_inspector: bool = False,
    saved_playback_item_id: str | None = None,
    source_script_sha256: str | None = None,
    expect_fem_airbox_vectors: bool | None = None,
    expect_terminal_telemetry: bool | None = None,
    expect_run_performance: bool | None = None,
    expect_planar_airbox: bool = False,
    private_group_storage: bool = False,
    inspector_ack: bool = False,
    inspector_ack_source_sha256: Mapping[str, str] | None = None,
    study_stage_rerun: str | None = None,
    study_stage_rerun_source_sha256: Mapping[str, str] | None = None,
    study_stage_rerun_resume_evidence: Mapping[str, object] | None = None,
) -> None:
    if type(private_group_storage) is not bool:
        raise ControlOutcomeUnknown("Browser helper private group storage marker is malformed")
    if private_group_storage and frontend_volume != control.volume:
        raise ControlOutcomeUnknown("Browser helper frontend volume differs from the pinned group volume")
    try:
        validate_source_labels(document, identity)
    except ValueError as error:
        raise ControlOutcomeUnknown(f"Browser helper source identity differs: {error}") from error
    config = document.get("Config")
    host = document.get("HostConfig")
    state = document.get("State")
    network_settings = document.get("NetworkSettings")
    if (not isinstance(config, Mapping) or not isinstance(host, Mapping)
            or not isinstance(state, Mapping) or not isinstance(network_settings, Mapping)):
        raise ControlOutcomeUnknown("Browser helper inspect document is incomplete")
    networks = network_settings.get("Networks", {})
    labels = config.get("Labels") or {}
    if labels.get("com.docker.compose.project") != control.project or labels.get("com.docker.compose.service") != "browser-qa":
        raise ControlOutcomeUnknown("Browser helper service identity differs")
    if document.get("Image") != browser_image_id:
        raise ControlOutcomeUnknown("Browser helper image identity differs")
    if config.get("User") != "65532:65532":
        raise ControlOutcomeUnknown("Browser helper user does not match the owned frontend volume")
    if (host.get("GroupAdd") or []) != _script_bind_groups(selected):
        raise ControlOutcomeUnknown("Browser helper source read group differs")
    raw_environment = config.get("Env") or []
    if not isinstance(raw_environment, list) or any(not isinstance(entry, str) for entry in raw_environment):
        raise ControlOutcomeUnknown("Browser helper runtime environment is malformed")
    environment = set(raw_environment)
    if {
        "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
        "CONTROL_ROOM_URL=http://frontend:8080",
        "NVIDIA_VISIBLE_DEVICES=void",
    } - environment:
        raise ControlOutcomeUnknown("Browser helper runtime environment differs")
    private_storage_environment = [
        entry for entry in raw_environment
        if entry.startswith("FULLMAG_PRIVATE_GROUP_STORAGE=")
    ]
    if private_group_storage:
        if private_storage_environment != ["FULLMAG_PRIVATE_GROUP_STORAGE=group-volume-v1"]:
            raise ControlOutcomeUnknown("Browser helper private group storage profile differs")
    elif private_storage_environment:
        raise ControlOutcomeUnknown("Legacy browser helper unexpectedly declares a private group profile")
    ack_environment = [entry for entry in raw_environment
                       if entry.startswith("CONTROL_ROOM_INSPECTOR_ACK_SOURCE_SHA256=")]
    ack_scenario = [entry for entry in raw_environment
                    if entry.startswith("CONTROL_ROOM_BROWSER_QA_SCENARIO=")]
    rerun_source_environment = [entry for entry in raw_environment
                                if entry.startswith("CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256=")]
    rerun_mode_environment = [entry for entry in raw_environment
                              if entry.startswith("CONTROL_ROOM_STUDY_STAGE_RERUN_MODE=")]
    rerun_resume_environment = [entry for entry in raw_environment
                                if entry.startswith("CONTROL_ROOM_STUDY_STAGE_RERUN_RESUME_EVIDENCE=")]
    rerun_scenario = [entry for entry in raw_environment
                      if entry.startswith("CONTROL_ROOM_BROWSER_QA_SCENARIO=study-stage-rerun")]
    if inspector_ack:
        try:
            _validate_inspector_ack_hashes(inspector_ack_source_sha256)
        except BuildControlError as error:
            raise ControlOutcomeUnknown(str(error)) from error
        expected_pin = canonical(dict(inspector_ack_source_sha256)).decode("utf-8")
        if (ack_environment != ["CONTROL_ROOM_INSPECTOR_ACK_SOURCE_SHA256=" + expected_pin]
                or ack_scenario != ["CONTROL_ROOM_BROWSER_QA_SCENARIO=inspector-ack"]
                or config.get("Cmd") != [
                    "node", "/state/development/workspace/apps/control-room/scripts/check-inspector-ack-browser.mjs",
                ]):
            raise ControlOutcomeUnknown("Browser helper Inspector ACK command or source pins differ")
    elif ack_environment or "CONTROL_ROOM_BROWSER_QA_SCENARIO=inspector-ack" in environment:
        raise ControlOutcomeUnknown("Browser helper reported an unrequested Inspector ACK scenario")
    if study_stage_rerun is not None:
        try:
            _validate_study_stage_rerun_hashes(study_stage_rerun_source_sha256, study_stage_rerun)
        except BuildControlError as error:
            raise ControlOutcomeUnknown(str(error)) from error
        expected_pin = canonical(dict(study_stage_rerun_source_sha256)).decode("utf-8")
        if study_stage_rerun == "fdm-cell-study-resume":
            try:
                _validate_fdm_grid_resume_evidence_shape(
                    study_stage_rerun_resume_evidence, study_stage_rerun_source_sha256,
                )
            except BuildControlError as error:
                raise ControlOutcomeUnknown(str(error)) from error
            expected_resume = "CONTROL_ROOM_STUDY_STAGE_RERUN_RESUME_EVIDENCE=" + canonical(
                dict(study_stage_rerun_resume_evidence)
            ).decode("utf-8")
            if rerun_resume_environment != [expected_resume]:
                raise ControlOutcomeUnknown("Browser helper FDM grid resume evidence differs")
        elif rerun_resume_environment or study_stage_rerun_resume_evidence is not None:
            raise ControlOutcomeUnknown("Browser helper reported unrequested FDM grid resume evidence")
        if (study_stage_rerun not in {"stage-b", "study", "material-stage-a", "fdm-cell-study",
                                      "fdm-cell-study-resume", "texture-stage-b", "texture-study"}
                or rerun_source_environment != ["CONTROL_ROOM_STUDY_STAGE_RERUN_SOURCE_SHA256=" + expected_pin]
                or rerun_mode_environment != ["CONTROL_ROOM_STUDY_STAGE_RERUN_MODE=" + study_stage_rerun]
                or rerun_scenario != ["CONTROL_ROOM_BROWSER_QA_SCENARIO=study-stage-rerun"]
                or config.get("Cmd") != [
                    "node", "/state/development/workspace/apps/control-room/scripts/check-study-stage-rerun-browser.mjs",
                    study_stage_rerun,
                ]):
            raise ControlOutcomeUnknown("Browser helper Study stage rerun command or source pins differ")
    elif rerun_source_environment or rerun_mode_environment or rerun_scenario:
        raise ControlOutcomeUnknown("Browser helper reported an unrequested Study stage rerun scenario")
    if saved_playback_item_id is not None:
        if (not re.fullmatch(r"[0-9]{1,20}", saved_playback_item_id)
                or not isinstance(source_script_sha256, str)
                or not SHA256_RE.fullmatch(source_script_sha256)):
            raise ControlOutcomeUnknown("Saved Playback helper identity is malformed")
        if {
            "CONTROL_ROOM_BROWSER_QA_SCENARIO=saved-playback",
            f"CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_ITEM_ID={saved_playback_item_id}",
            f"CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_SCRIPT_SHA256={source_script_sha256}",
        } - environment:
            raise ControlOutcomeUnknown("Browser helper Saved Playback scenario identity differs")
        if config.get("Cmd") != [
            "node",
            "/state/development/workspace/apps/control-room/scripts/check-saved-playback-browser.mjs",
            "http://frontend:8080",
            saved_playback_item_id,
        ]:
            raise ControlOutcomeUnknown("Browser helper did not run the selected Saved Playback harness")
    elif source_script_sha256 is not None:
        raise ControlOutcomeUnknown("Saved Playback helper hash has no item identity")
    elif airbox_inspector:
        if "CONTROL_ROOM_BROWSER_QA_SCENARIO=airbox-inspector" not in environment:
            raise ControlOutcomeUnknown("Browser helper Airbox Inspector scenario differs")
        if config.get("Cmd") != [
            "node",
            "/state/development/workspace/apps/control-room/scripts/verify-airbox-inspector.mjs",
        ]:
            raise ControlOutcomeUnknown("Browser helper did not run the selected Airbox Inspector harness")
    fem_observation_environment = [
        entry for entry in raw_environment
        if entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_FEM_AIRBOX_VECTORS=")
    ]
    fem_scenario_environment = [
        entry for entry in raw_environment
        if entry.startswith("CONTROL_ROOM_BROWSER_QA_SCENARIO=fem-airbox-vectors")
    ]
    if expect_fem_airbox_vectors is True:
        if (canvas_only is not True or expect_live_field != "m" or expect_airbox_vectors is not False):
            raise ControlOutcomeUnknown("FEM Airbox helper expectations differ from the admitted canvas/m scenario")
        if {
            "CONTROL_ROOM_BROWSER_QA_SCENARIO=fem-airbox-vectors",
            "CONTROL_ROOM_BROWSER_QA_EXPECT_FEM_AIRBOX_VECTORS=1",
        } - environment:
            raise ControlOutcomeUnknown("Browser helper FEM Airbox scenario identity differs")
        if (fem_observation_environment != ["CONTROL_ROOM_BROWSER_QA_EXPECT_FEM_AIRBOX_VECTORS=1"]
                or fem_scenario_environment != ["CONTROL_ROOM_BROWSER_QA_SCENARIO=fem-airbox-vectors"]):
            raise ControlOutcomeUnknown("Browser helper FEM Airbox expectation is duplicated or malformed")
    elif fem_observation_environment or fem_scenario_environment:
        raise ControlOutcomeUnknown("Browser helper reported an unrequested FEM Airbox scenario")
    terminal_telemetry_environment = [
        entry for entry in raw_environment
        if entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_TERMINAL_TELEMETRY=")
    ]
    if expect_terminal_telemetry is True:
        if (canvas_only is not True or expect_live_field != "m" or expect_airbox_vectors is not False):
            raise ControlOutcomeUnknown("Terminal telemetry helper expectations differ from the admitted canvas/m scenario")
        if terminal_telemetry_environment != ["CONTROL_ROOM_BROWSER_QA_EXPECT_TERMINAL_TELEMETRY=1"]:
            raise ControlOutcomeUnknown("Browser helper terminal telemetry expectation is duplicated or malformed")
    elif terminal_telemetry_environment:
        raise ControlOutcomeUnknown("Browser helper reported an unrequested terminal telemetry scenario")
    run_performance_environment = [
        entry for entry in raw_environment
        if entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_RUN_PERFORMANCE=")
    ]
    if expect_run_performance is True:
        if canvas_only is not True or expect_live_field is not None:
            raise ControlOutcomeUnknown("Run performance helper is outside standalone canvas-only scope")
        if run_performance_environment != ["CONTROL_ROOM_BROWSER_QA_EXPECT_RUN_PERFORMANCE=1"]:
            raise ControlOutcomeUnknown("Browser helper run performance expectation is duplicated or malformed")
    elif run_performance_environment:
        raise ControlOutcomeUnknown("Browser helper reported an unrequested run performance scenario")
    planar_airbox_environment = [
        entry for entry in raw_environment
        if entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_PLANAR_AIRBOX=")
    ]
    planar_airbox_scenario_environment = [
        entry for entry in raw_environment
        if entry.startswith("CONTROL_ROOM_BROWSER_QA_SCENARIO=planar-airbox")
    ]
    if expect_planar_airbox:
        if (canvas_only is not True or expect_live_field != "m" or expect_airbox_vectors is not False
                or expect_fem_airbox_vectors is True or expect_terminal_telemetry is True
                or expect_run_performance is True or expect_ambiguous_compute_fields is not False):
            raise ControlOutcomeUnknown("Planar Airbox helper differs from the admitted canvas/m scenario")
        if (planar_airbox_environment != ["CONTROL_ROOM_BROWSER_QA_EXPECT_PLANAR_AIRBOX=1"]
                or planar_airbox_scenario_environment != ["CONTROL_ROOM_BROWSER_QA_SCENARIO=planar-airbox"]):
            raise ControlOutcomeUnknown("Browser helper Planar Airbox scenario identity differs")
    elif planar_airbox_environment or planar_airbox_scenario_environment:
        raise ControlOutcomeUnknown("Browser helper reported an unrequested Planar Airbox scenario")
    if canvas_only is not None:
        mode_environment = [
            entry for entry in environment
            if entry.startswith("CONTROL_ROOM_BROWSER_QA_CANVAS_ONLY=")
        ]
        expected_mode = "1" if canvas_only else "0"
        if mode_environment != [f"CONTROL_ROOM_BROWSER_QA_CANVAS_ONLY={expected_mode}"]:
            raise ControlOutcomeUnknown("Browser helper QA scope differs")
    if expect_airbox_vectors is not None:
        expected_field = expect_live_field or ""
        expected_vectors = "1" if expect_airbox_vectors else "0"
        focused_environment = [
            entry for entry in environment
            if entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_LIVE_FIELD=")
            or entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS=")
        ]
        if set(focused_environment) != {
            f"CONTROL_ROOM_BROWSER_QA_EXPECT_LIVE_FIELD={expected_field}",
            f"CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS={expected_vectors}",
        }:
            raise ControlOutcomeUnknown("Browser helper live-field expectation differs")
    if expect_ambiguous_compute_fields is not None:
        expected_ambiguous = "1" if expect_ambiguous_compute_fields else "0"
        ambiguous_environment = [
            entry for entry in environment
            if entry.startswith("CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS=")
        ]
        if ambiguous_environment != [
            f"CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS={expected_ambiguous}"
        ]:
            raise ControlOutcomeUnknown("Browser helper ambiguous-command expectation differs")
    if state.get("Running") is not False or state.get("ExitCode") != exit_code:
        raise ControlOutcomeUnknown("Browser helper exit outcome differs from Compose observation")
    if (host.get("ReadonlyRootfs") is not True or host.get("NetworkMode") in {"host", "none"}
            or host.get("ExtraHosts")):
        raise ControlOutcomeUnknown("Browser helper isolation differs")
    if host.get("PortBindings") or (network_settings.get("Ports") or {}):
        raise ControlOutcomeUnknown("Browser helper unexpectedly publishes a port")
    if set(networks) != {identity["network_name"]}:
        raise ControlOutcomeUnknown("Browser helper is outside the selected private network")
    cap_drop = set(host.get("CapDrop") or [])
    if "ALL" not in cap_drop:
        raise ControlOutcomeUnknown("Browser helper did not drop all capabilities")
    if "no-new-privileges:true" not in set(host.get("SecurityOpt") or []):
        raise ControlOutcomeUnknown("Browser helper lacks no-new-privileges")
    if set(host.get("Tmpfs") or {}) != {"/tmp"}:
        raise ControlOutcomeUnknown("Browser helper temporary filesystem differs")
    mounts = document.get("Mounts") or []
    destinations = {m.get("Destination") for m in mounts if isinstance(m, Mapping)}
    expected = {
        "/state/development",
        "/state/development/workspace/apps/control-room/scripts",
    }
    if study_stage_rerun is not None:
        expected.update({STUDY_STAGE_RERUN_SRC_TARGET, STUDY_STAGE_RERUN_FIXTURE_TARGET})
    if destinations != expected:
        raise ControlOutcomeUnknown("Browser helper has an unexpected mount boundary")
    if private_group_storage:
        import docker_group_storage as group_storage

        volume = _validate_existing_control_volume(control)
        try:
            frontend_subpath = group_storage.role_subpath(control, "frontend")
        except BuildControlError as error:
            raise ControlOutcomeUnknown("Browser helper private frontend subpath is invalid") from error
        try:
            _validate_group_volume_mounts(document, control, volume, {
                "/state/development": (frontend_subpath, True),
            })
        except BuildControlError as error:
            raise ControlOutcomeUnknown(str(error)) from error
        host_mounts = host.get("Mounts")
        expected_mount_count = 4 if study_stage_rerun is not None else 2
        if not isinstance(host_mounts, list) or len(host_mounts) != expected_mount_count:
            raise ControlOutcomeUnknown("Browser helper has a missing or unknown configured mount")
        host_binds = [mount for mount in host_mounts if isinstance(mount, Mapping)
                      and mount.get("Target") == "/state/development/workspace/apps/control-room/scripts"]
        resolved_binds = [mount for mount in mounts if isinstance(mount, Mapping)
                          and mount.get("Destination") == "/state/development/workspace/apps/control-room/scripts"]
        if (len(host_binds) != 1 or len(resolved_binds) != 1
                or host_binds[0].get("Type") != "bind"
                or host_binds[0].get("ReadOnly") is not True
                or not _source_mount_matches_selected(
                    host_binds[0].get("Source"), selected / "apps/control-room/scripts"
                )):
            raise ControlOutcomeUnknown("Browser helper configured script mount is not the selected readonly bind")
        if (resolved_binds[0].get("Type") != "bind"
                or resolved_binds[0].get("RW") is not False
                or not _source_mount_matches_selected(
                    resolved_binds[0].get("Source"), selected / "apps/control-room/scripts"
                )):
            raise ControlOutcomeUnknown("Browser helper resolved script mount is not the selected readonly bind")
    for mount in mounts:
        if mount.get("RW") is not False:
            raise ControlOutcomeUnknown("Browser helper has a writable volume or bind")
    state_mount = next(m for m in mounts if m.get("Destination") == "/state/development")
    if state_mount.get("Type") != "volume" or state_mount.get("Name") != frontend_volume:
        raise ControlOutcomeUnknown("Browser helper state volume differs")
    script_mount = next(m for m in mounts if m.get("Destination") == "/state/development/workspace/apps/control-room/scripts")
    if (
        script_mount.get("Type") != "bind"
        or not _source_mount_matches_selected(
            script_mount.get("Source"), selected / "apps/control-room/scripts"
        )
    ):
        raise ControlOutcomeUnknown("Browser helper script is not a readonly selected-source bind")
    if study_stage_rerun is not None:
        try:
            _validate_study_stage_rerun_hashes(study_stage_rerun_source_sha256, study_stage_rerun)
        except BuildControlError as error:
            raise ControlOutcomeUnknown(str(error)) from error
        if _study_stage_rerun_source_sha256(selected, study_stage_rerun) != study_stage_rerun_source_sha256:
            raise ControlOutcomeUnknown("Browser helper Study stage source pins changed")
        configured_mounts = host.get("Mounts")
        if (not isinstance(configured_mounts, list) or len(configured_mounts) != 4
                or {mount.get("Target") for mount in configured_mounts if isinstance(mount, Mapping)} != expected):
            raise ControlOutcomeUnknown("Browser helper configured mount inventory differs from the pinned P22 sources")
        state_configured = [mount for mount in configured_mounts if isinstance(mount, Mapping)
                            and mount.get("Target") == "/state/development"]
        if (len(state_configured) != 1 or state_configured[0].get("Type") != "volume"
                or state_configured[0].get("Source") != frontend_volume
                or state_configured[0].get("ReadOnly") is not True):
            raise ControlOutcomeUnknown("Browser helper configured state volume differs from the frontend")
        _validate_browser_helper_source_mount(
            document, selected, "apps/control-room/scripts", "/state/development/workspace/apps/control-room/scripts",
        )
        _validate_browser_helper_source_mount(
            document, selected, "apps/control-room/src", STUDY_STAGE_RERUN_SRC_TARGET,
        )
        _validate_browser_helper_source_mount(
            document, selected, STUDY_STAGE_RERUN_SOURCES["fixture"], STUDY_STAGE_RERUN_FIXTURE_TARGET,
        )


def _probe_public_loopback(public_url: str, timeout: int) -> dict[str, object]:
    """Read the host-published frontend without persisting its response body."""
    try:
        request = Request(public_url, method="GET")
        with urlopen(request, timeout=timeout) as response:
            status = int(response.status)
            final_url = response.geturl()
        requested = urlsplit(public_url)
        final = urlsplit(final_url)
        if (final.scheme, final.hostname, final.port) != (requested.scheme, requested.hostname, requested.port):
            raise OSError("public loopback probe followed a redirect outside the selected loopback")
        if not 200 <= status < 400:
            raise OSError(f"unexpected HTTP status {status}")
        return {
            "schema": "fullmag.docker-dev-browser-qa-public-probe.v1",
            "state": "passed",
            "url": public_url,
            "status": status,
            "final_url": final_url,
        }
    except (HTTPError, URLError, OSError, ValueError) as error:
        return {
            "schema": "fullmag.docker-dev-browser-qa-public-probe.v1",
            "state": "failed-confirmed",
            "url": public_url,
            "error": str(error)[:2048],
        }


def _validate_canvas_result(value: object, label: str) -> None:
    if not isinstance(value, Mapping):
        raise BuildControlError(f"Browser helper omitted {label} canvas state")
    rect = value.get("rect")
    if not isinstance(rect, Mapping):
        raise BuildControlError(f"Browser helper {label} canvas rectangle is invalid")
    for key in ("width", "height"):
        if not isinstance(rect.get(key), (int, float)) or rect[key] <= 0:
            raise BuildControlError(f"Browser helper {label} canvas is not visible")
    for key in ("width", "height", "drawing_buffer_width", "drawing_buffer_height"):
        if type(value.get(key)) not in (int, float) or value[key] <= 0:
            raise BuildControlError(f"Browser helper {label} canvas {key} is invalid")
    if not isinstance(value.get("context_type"), str) or not value["context_type"]:
        raise BuildControlError(f"Browser helper {label} canvas has no WebGL context")
    if value.get("context_lost") is not False:
        raise BuildControlError(f"Browser helper {label} WebGL context is lost or unknown")


def _validate_session_result(value: object) -> None:
    if not isinstance(value, Mapping):
        raise BuildControlError("Browser helper omitted canonical session identity")
    for key in ("session_id", "session_epoch", "request_scope_epoch"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise BuildControlError(f"Browser helper session identity field is invalid: {key}")


def _validate_viewport_dom_observations(
    value: object,
    *,
    performance_scope_only: bool = False,
) -> None:
    if performance_scope_only:
        expected_omission = {
            "field_data_proven": False,
            "note": VIEWPORT_DOM_OBSERVATIONS_NOTE,
            "reason": RUN_PERFORMANCE_VIEWPORT_DOM_OMISSION_REASON,
            "scope": RUN_PERFORMANCE_QA_SCOPE,
            "state": "omitted",
        }
        if not isinstance(value, Mapping) or dict(value) != expected_omission:
            raise BuildControlError(
                "Run performance-only browser QA must explicitly omit viewport DOM/model-adoption observations"
            )
        return
    if (not isinstance(value, Mapping) or value.get("field_data_proven") is not False
            or value.get("note") != VIEWPORT_DOM_OBSERVATIONS_NOTE):
        raise BuildControlError("Browser helper omitted bounded viewport DOM observations")
    for key in ("before_home", "after_home"):
        sample = value.get(key)
        if not isinstance(sample, Mapping):
            raise BuildControlError(f"Browser helper omitted viewport DOM observation: {key}")
        dataset = sample.get("dataset")
        labels = sample.get("quantity_labels")
        dataset_count = sample.get("dataset_entry_count")
        label_count = sample.get("quantity_label_count")
        if (not isinstance(dataset, Mapping) or not isinstance(labels, list)
                or type(dataset_count) is not int or not 0 <= dataset_count <= 10000
                or type(label_count) is not int or not 0 <= label_count <= 10000
                or type(sample.get("dataset_truncated")) is not bool
                or type(sample.get("quantity_labels_truncated")) is not bool
                or len(dataset) > 64 or len(labels) > 32
                or dataset_count < len(dataset) or label_count < len(labels)):
            raise BuildControlError(f"Browser helper viewport DOM observation is malformed: {key}")
        if dataset_count > len(dataset) and not sample["dataset_truncated"]:
            raise BuildControlError(f"Browser helper viewport dataset truncation is not reported: {key}")
        if label_count > len(labels) and not sample["quantity_labels_truncated"]:
            raise BuildControlError(f"Browser helper quantity label truncation is not reported: {key}")
        if any(not isinstance(name, str) or len(name) > 128
               or not isinstance(item, str) or len(item) > 1024
               for name, item in dataset.items()):
            raise BuildControlError(f"Browser helper viewport dataset is malformed: {key}")
        for label in labels:
            if not isinstance(label, Mapping):
                raise BuildControlError(f"Browser helper quantity label is malformed: {key}")
            for field in ("tag_name", "quantity_id", "field_state"):
                item = label.get(field)
                limit = 512 if field == "quantity_id" else 128
                if item is not None and (not isinstance(item, str) or len(item) > limit):
                    raise BuildControlError(f"Browser helper quantity label field is malformed: {field}")


def _validate_live_field_observation(
    value: object,
    quantity_id: str,
    expect_airbox_vectors: bool,
) -> None:
    if (not isinstance(value, Mapping) or value.get("field_data_proven") is not False
            or value.get("note") != LIVE_FIELD_OBSERVATION_NOTE
            or value.get("expected_quantity_id") != quantity_id
            or value.get("airbox_vectors_expected") is not expect_airbox_vectors):
        raise BuildControlError("Browser helper omitted the pinned live-field DOM observation")
    for key in ("before_home", "after_home"):
        sample = value.get(key)
        if (not isinstance(sample, Mapping)
                or sample.get("quantity_id") != quantity_id
                or sample.get("label_visible") is not True
                or sample.get("field_state") != "data-ready"
                or sample.get("readiness_signal") != "visible quantity label data-field-state=data-ready"
                or sample.get("solver_family") not in {"fdm", "fem"}):
            raise BuildControlError(f"Browser helper did not observe live field readiness: {key}")
        dataset = sample.get("dataset")
        if not isinstance(dataset, Mapping):
            raise BuildControlError(f"Browser helper live-field dataset is malformed: {key}")
        bounds = dataset.get("fdm_domain_bounds")
        if not isinstance(bounds, str) or len(bounds) > 1024:
            raise BuildControlError(f"Browser helper live-field FDM domain bounds are malformed: {key}")
        count_fields = (
            "fdm_model_count", "fdm_vector_segment_count", "fdm_airbox_model_count",
            "fdm_airbox_vector_segment_count",
        )
        for field in count_fields:
            if type(dataset.get(field)) is not int or dataset[field] < 0:
                raise BuildControlError(f"Browser helper live-field dataset is malformed: {field}")
        if type(dataset.get("fdm_airbox_vectors_visible")) is not bool:
            raise BuildControlError(f"Browser helper live-field dataset is malformed: {key}")
        if sample["solver_family"] == "fdm":
            if dataset["fdm_model_count"] <= 0:
                raise BuildControlError(f"Browser helper FDM field has no live model: {key}")
        elif bounds or dataset["fdm_model_count"] != 0:
            raise BuildControlError(f"Browser helper FEM field observation conflicts with FDM dataset: {key}")
        if expect_airbox_vectors:
            if sample["solver_family"] != "fdm":
                raise BuildControlError("FDM-only airbox-vector gate is unavailable for a FEM viewport")
            if (dataset["fdm_airbox_vectors_visible"] is not True
                    or dataset["fdm_airbox_vector_segment_count"] <= 0):
                raise BuildControlError(f"Browser helper did not observe visible FDM airbox vectors: {key}")


def _format_terminal_footer_energy(value: int | float) -> str:
    number = float(value)
    magnitude = abs(number)
    with localcontext() as context:
        context.prec = 1200
        decimal_value = Decimal.from_float(number)
        if 1e-2 <= magnitude < 1e4:
            rounded = decimal_value.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)
            formatted = format(rounded, ",f")
            if "." in formatted:
                formatted = formatted.rstrip("0").rstrip(".")
            return formatted
        sign = "-" if number < 0 else ""
        absolute = abs(decimal_value)
        exponent = absolute.adjusted() if absolute else 0
        mantissa = absolute.scaleb(-exponent).quantize(
            Decimal("0.000001"), rounding=ROUND_HALF_UP
        ) if absolute else Decimal("0.000000")
        if mantissa >= Decimal(10):
            mantissa = mantissa / Decimal(10)
            exponent += 1
        exponent_text = f"{exponent:+d}"
        return f"{sign}{format(mantissa, '.6f')}e{exponent_text}"


def _terminal_exact_keys(value: object, expected: set[str], label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise BuildControlError(f"Terminal telemetry {label} schema differs")
    return value


def _terminal_finite_number(value: object, label: str) -> int | float:
    if type(value) not in (int, float) or not math.isfinite(float(value)):
        raise BuildControlError(f"Terminal telemetry {label} is not a finite number")
    return value


def _terminal_session_scope_header(session: Mapping[str, object]) -> str:
    safe = "-_.!~*'()"
    session_id = quote(str(session["session_id"]), safe=safe)
    session_epoch = quote(str(session["session_epoch"]), safe=safe)
    request_scope_epoch = quote(str(session["request_scope_epoch"]), safe=safe)
    return (
        f"session={session_id}&epoch={session_epoch}"
        f"&request_scope_epoch={request_scope_epoch}"
    )


def _validate_terminal_telemetry_snapshot(
    value: object,
    session: Mapping[str, object],
    *,
    after_reload: bool,
) -> Mapping[str, object]:
    snapshot = _terminal_exact_keys(value, {"api", "api_requests", "canvas", "field", "footer"}, "snapshot")
    api = _terminal_exact_keys(
        snapshot["api"],
        {
            "api_instance_id", "session_id", "session_epoch", "request_scope_epoch", "run_id",
            "run_status", "status_solver_steps", "current_run_id", "current_run_session_id",
            "observation_session_id", "observation_run_id", "observation_request_scope_epoch",
            "source_step", "scalar_row_step", "scalar_revision", "scalar_window_revision",
            "scalar_energy_j", "current_run_energy_j", "session_summary_energy_j",
        },
        "API source",
    )
    if (not isinstance(api.get("api_instance_id"), str)
            or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", api["api_instance_id"])):
        raise BuildControlError("Terminal telemetry API instance identity is malformed")
    for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id"):
        if not isinstance(api.get(key), str) or not api[key].strip() or len(api[key]) > 512:
            raise BuildControlError(f"Terminal telemetry API identity field is malformed: {key}")
    if any(api.get(key) != session.get(key) for key in ("session_id", "session_epoch", "request_scope_epoch")):
        raise BuildControlError("Terminal telemetry API identity differs from the active browser session")
    if api.get("run_status") != "completed":
        raise BuildControlError("Terminal telemetry source is not a completed run")
    if (api.get("current_run_id") != api.get("run_id")
            or api.get("current_run_session_id") != api.get("session_id")
            or api.get("observation_session_id") != api.get("session_id")
            or api.get("observation_run_id") != api.get("run_id")
            or api.get("observation_request_scope_epoch") != api.get("request_scope_epoch")):
        raise BuildControlError("Terminal telemetry current run/current observation scope differs")
    for key in (
        "source_step", "status_solver_steps", "scalar_row_step", "scalar_revision", "scalar_window_revision"
    ):
        number = api.get(key)
        if type(number) is not int or not 0 <= number <= MAX_SAFE_JSON_INTEGER:
            raise BuildControlError(f"Terminal telemetry {key} is not a safe non-negative integer")
    if (api["source_step"] != api["status_solver_steps"]
            or api["source_step"] != api["scalar_row_step"]
            or api["scalar_revision"] != api["scalar_window_revision"]):
        raise BuildControlError("Terminal telemetry source_step/revision differs from the current run or scalar row")
    energy_values = [
        _terminal_finite_number(api.get(key), key)
        for key in ("scalar_energy_j", "current_run_energy_j", "session_summary_energy_j")
    ]
    if not (energy_values[0] == energy_values[1] == energy_values[2]
            and (energy_values[0] != 0 or all(math.copysign(1.0, float(item)) == math.copysign(1.0, float(energy_values[0])) for item in energy_values[1:]))):
        raise BuildControlError("Terminal telemetry scalar/current-run/session energies differ")

    requests = snapshot["api_requests"]
    expected_paths = [
        "/v2/sessions/current/status",
        "/v2/sessions/current/simulation/runs/current",
        "/v2/sessions/current/data/scalars?columns=step,e_total&limit=1&tail=true",
    ]
    if not isinstance(requests, list) or len(requests) != len(expected_paths):
        raise BuildControlError("Terminal telemetry GET request evidence is malformed")
    expected_session_scope = _terminal_session_scope_header(api)
    for index, (request, path) in enumerate(zip(requests, expected_paths, strict=True)):
        item = _terminal_exact_keys(
            request,
            {"method", "path", "status", "api_instance_header_sent", "session_scope_header_sent"},
            "GET request",
        )
        expected_pin = api["api_instance_id"] if after_reload or index > 0 else None
        if (item.get("method") != "GET" or item.get("path") != path or item.get("status") != 200
                or item.get("api_instance_header_sent") != expected_pin
                or item.get("session_scope_header_sent") != expected_session_scope):
            raise BuildControlError("Terminal telemetry API request identity/method differs")

    canvas = _terminal_exact_keys(
        snapshot["canvas"],
        {"visible", "context_type", "context_lost", "drawing_buffer_width", "drawing_buffer_height", "css_width", "css_height"},
        "canvas",
    )
    if (canvas.get("visible") is not True or canvas.get("context_lost") is not False
            or canvas.get("context_type") not in {"WebGLRenderingContext", "WebGL2RenderingContext"}):
        raise BuildControlError("Terminal telemetry did not preserve a visible, live WebGL canvas")
    for key in ("drawing_buffer_width", "drawing_buffer_height"):
        if type(canvas.get(key)) is not int or canvas[key] <= 0:
            raise BuildControlError(f"Terminal telemetry canvas {key} is invalid")
    for key in ("css_width", "css_height"):
        if type(canvas.get(key)) not in (int, float) or not math.isfinite(float(canvas[key])) or canvas[key] <= 0:
            raise BuildControlError(f"Terminal telemetry canvas {key} is invalid")

    field = _terminal_exact_keys(
        snapshot["field"], {"quantity_id", "label_visible", "field_state", "solver_family"}, "field readiness"
    )
    if (field.get("quantity_id") != "m" or field.get("label_visible") is not True
            or field.get("field_state") != "data-ready" or field.get("solver_family") not in {"fem", "fdm"}):
        raise BuildControlError("Terminal telemetry did not preserve primary m field readiness")

    footer = _terminal_exact_keys(snapshot["footer"], {"step", "energy"}, "footer")
    step = _terminal_exact_keys(
        footer["step"], {"visible", "label", "detail", "value", "unit", "title"}, "Step metric"
    )
    energy = _terminal_exact_keys(
        footer["energy"], {"visible", "label", "detail", "subdetail", "value", "unit", "title"}, "Total energy metric"
    )
    expected_step = f"{api['source_step']:,}"
    expected_energy = _format_terminal_footer_energy(energy_values[0])
    if (step.get("visible") is not True or step.get("label") != "Step"
            or step.get("detail") != "Latest step" or step.get("value") != expected_step
            or step.get("unit") != "steps" or not isinstance(step.get("title"), str)
            or not step["title"].startswith(f"Step: {expected_step} steps\nLatest step\n")):
        raise BuildControlError("Visible Footer Step does not match authoritative source_step")
    expected_energy_title = f"Energy: {expected_energy} J\nTotal\nSession summary"
    if (energy.get("visible") is not True or energy.get("label") != "Energy"
            or energy.get("detail") != "Total" or energy.get("subdetail") != "Session summary"
            or energy.get("value") != expected_energy or energy.get("unit") != "J"
            or energy.get("title") != expected_energy_title):
        raise BuildControlError("Visible Footer Total energy does not match current-run scalar energy formatting")
    return api


def _validate_terminal_telemetry(
    value: object,
    session: Mapping[str, object],
    *,
    public_url: str,
    document_url: object,
) -> None:
    proof = _terminal_exact_keys(
        value,
        {
            "schema", "state", "reload", "before_reload", "after_reload", "api_identity_preserved",
            "prohibited_mutations", "non_mutating_client_ack_requests", "api_observation_methods", "energy_format",
        },
        "proof",
    )
    if proof.get("schema") != TERMINAL_TELEMETRY_RESULT_SCHEMA or proof.get("state") != "passed":
        raise BuildControlError("Terminal telemetry result schema/state differs")
    reload_evidence = _terminal_exact_keys(
        proof["reload"], {"method", "response_status", "path", "count"}, "reload"
    )
    if not isinstance(document_url, str) or len(document_url) > 2048:
        raise BuildControlError("Terminal telemetry document URL is malformed")
    document, public = urlsplit(document_url), urlsplit(public_url)
    # The workspace canonicalizes an active simulation to /session/<slug>.
    # Bind the reload to that actual same-origin document, not its entry alias.
    if (document.scheme != public.scheme or document.netloc != public.netloc
            or document.query or document.fragment
            or not (document.path in {"/", "/workspace"}
                    or re.fullmatch(r"/session/[^/?#\x00-\x20\x7f]{1,512}", document.path))):
        raise BuildControlError("Terminal telemetry did not retain the selected workspace document")
    if (reload_evidence.get("method") != "page.reload" or reload_evidence.get("response_status") != 200
            or reload_evidence.get("path") != document.path or reload_evidence.get("count") != 1):
        raise BuildControlError("Terminal telemetry did not prove one real workspace page reload")
    if proof.get("api_identity_preserved") is not True or proof.get("prohibited_mutations") != []:
        raise BuildControlError("Terminal telemetry API continuity or read-only boundary is unproven")
    acknowledgements = proof.get("non_mutating_client_ack_requests")
    if type(acknowledgements) is not int or not 0 <= acknowledgements <= 64:
        raise BuildControlError("Terminal telemetry client-ack count is outside its bound")
    if proof.get("api_observation_methods") != ["GET"] * 6:
        raise BuildControlError("Terminal telemetry used a non-GET API observation method")
    if proof.get("energy_format") != TERMINAL_TELEMETRY_ENERGY_FORMAT:
        raise BuildControlError("Terminal telemetry energy format declaration differs")
    before = _validate_terminal_telemetry_snapshot(proof["before_reload"], session, after_reload=False)
    after = _validate_terminal_telemetry_snapshot(proof["after_reload"], session, after_reload=True)
    if dict(before) != dict(after):
        raise BuildControlError("Terminal telemetry API instance/run/session/source changed across reload")


def _validate_fem_airbox_vector_observation(
    value: object,
    session: object,
) -> None:
    if not isinstance(value, Mapping) or value.get("schema") != FEM_AIRBOX_VECTOR_OBSERVATION_SCHEMA:
        raise BuildControlError("Browser helper omitted the FEM Airbox vector observation schema")
    if (value.get("solver_family") != "fem"
            or value.get("health_disposition") != "ready"
            or value.get("health_scope") != "render-snapshot"
            or value.get("target_id") != "airbox"
            or value.get("target_kind") != "airbox"
            or value.get("selection_kind") != "airbox.visualization.debug"
            or value.get("quantity_id") != "H_demag"
            or value.get("component") != "full"
            or value.get("scope_kind") != "airbox"):
        raise BuildControlError("Browser helper FEM Airbox target identity differs")
    limitations = value.get("panel_comparison_limitations")
    if (value.get("panel_health_disposition") not in ("ready", "unknown")
            or not isinstance(limitations, list) or len(limitations) > 8
            or any(item != "backend-meta-incomparable" for item in limitations)
            or (value.get("panel_health_disposition") == "unknown" and not limitations)
            or not isinstance(value.get("render_snapshot_frame_commit_id"), str)
            or not value["render_snapshot_frame_commit_id"]):
        raise BuildControlError("Browser helper FEM render snapshot or comparison limitations differ")
    scope_id = value.get("scope_id")
    carrier_id = value.get("carrier_id")
    resource_key = value.get("resource_key")
    if (not isinstance(scope_id, str) or not scope_id or len(scope_id) > 512
            or not isinstance(carrier_id, str) or not carrier_id or len(carrier_id) > 512
            or not isinstance(resource_key, str) or not resource_key or len(resource_key) > 2048):
        raise BuildControlError("Browser helper FEM Airbox resource identity is malformed")
    parsed_key = urlsplit(resource_key)
    query = parse_qs(parsed_key.query, keep_blank_values=True)
    if (parsed_key.scheme or parsed_key.netloc
            or parsed_key.path != "/v2/sessions/current/data/fields/H_demag/samples/vector"
            or query.get("component") != ["full"]
            or query.get("scope_kind") != ["airbox"]
            or query.get("scope_id") != [scope_id]):
        raise BuildControlError("Browser helper FEM Airbox canonical resource key differs")
    request = value.get("request")
    if (not isinstance(request, Mapping)
            or request.get("method") != "GET"
            or request.get("same_origin") is not True
            or type(request.get("status")) is not int
            or request.get("status") != 200
            or request.get("path") != parsed_key.path
            or request.get("quantity_id") != "H_demag"
            or request.get("component") != "full"
            or request.get("scope_kind") != "airbox"
            or request.get("scope_id") != scope_id):
        raise BuildControlError("Browser helper did not observe a successful scoped FEM H_demag HTTP response")
    field_resource_state = value.get("field_resource_state")
    if (not isinstance(field_resource_state, str)
            or not field_resource_state.startswith("ready · data present · last-valid present")):
        raise BuildControlError("Browser helper FEM Airbox field resource is not ready with accepted data")
    if (value.get("payload_scope") != f"airbox:{scope_id}"
            or type(value.get("payload_points")) is not int
            or value["payload_points"] <= 0
            or type(value.get("payload_values")) is not int
            or value["payload_values"] <= 0
            or type(value.get("payload_n_comp")) is not int
            or value["payload_n_comp"] != 3
            or value["payload_values"] != value["payload_points"] * value["payload_n_comp"]):
        raise BuildControlError("Browser helper decoded FEM Airbox payload identity or dimensions differ")
    adopted_field_buffer_id = value.get("adopted_field_buffer_id")
    vector_build_key = value.get("vector_build_key")
    if (value.get("field_buffer_state") != "target-buffer"
            or not isinstance(adopted_field_buffer_id, str)
            or not adopted_field_buffer_id or len(adopted_field_buffer_id) > 512
            or value.get("adopted_resource_key") != resource_key
            or not isinstance(vector_build_key, str)
            or not vector_build_key or len(vector_build_key) > 512
            or type(value.get("rendered_vector_segment_count")) is not int
            or value["rendered_vector_segment_count"] <= 0):
        raise BuildControlError("Browser helper FEM vector field buffer was not adopted and rendered")
    for key in ("session_run_identity_before", "session_run_identity_after"):
        identity = value.get(key)
        if (not isinstance(identity, Mapping)
                or identity.get("discretization") != "fem"
                or not all(isinstance(identity.get(field), str) and identity[field]
                           for field in ("session_id", "session_epoch", "request_scope_epoch", "run_id"))):
            raise BuildControlError(f"Browser helper FEM Airbox {key} is malformed")
    if value["session_run_identity_before"] != value["session_run_identity_after"]:
        raise BuildControlError("Browser helper FEM Airbox proof changed its active session/run identity")
    if (not isinstance(session, Mapping)
            or value["session_run_identity_after"].get("session_id") != session.get("session_id")
            or value["session_run_identity_after"].get("session_epoch") != session.get("session_epoch")
            or value["session_run_identity_after"].get("request_scope_epoch") != session.get("request_scope_epoch")):
        raise BuildControlError("Browser helper FEM Airbox proof does not belong to the admitted active session")
    if (value.get("primary_quantity_id_before") != "m"
            or value.get("primary_quantity_id_after") != "m"
            or value.get("primary_field_state_after") != "data-ready"):
        raise BuildControlError("Browser helper Airbox display selection did not preserve primary FEM magnetization")
    if (type(value.get("display_state_patch_count")) is not int
            or not 0 <= value["display_state_patch_count"] <= 2
            or type(value.get("blocked_mutation_count")) is not int
            or value["blocked_mutation_count"] != 0):
        raise BuildControlError("Browser helper observed a blocked non-display mutation during FEM Airbox QA")
    _validate_canvas_result(value.get("canvas"), "FEM Airbox H_demag vectors")


def _validate_canvas_screenshot(value: object) -> None:
    if not isinstance(value, Mapping) or value.get("media_type") != "image/png":
        raise BuildControlError("Browser helper canvas screenshot observation is malformed")
    width, height = value.get("width"), value.get("height")
    if type(width) is not int or width <= 0 or type(height) is not int or height <= 0:
        raise BuildControlError("Browser helper canvas screenshot dimensions are invalid")
    state = value.get("state")
    data = value.get("png_base64")
    if state == "captured":
        if (value.get("image_proof") is not True or not isinstance(data, str)
                or len(data) > ((MAX_CANVAS_SCREENSHOT_BYTES + 2) // 3) * 4):
            raise BuildControlError("Browser helper canvas screenshot exceeds its encoded size bound")
        try:
            png = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error) as error:
            raise BuildControlError("Browser helper canvas screenshot is not valid base64") from error
        if (not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > MAX_CANVAS_SCREENSHOT_BYTES
                or value.get("byte_length") != len(png) or len(png) < 24
                or int.from_bytes(png[16:20], "big") != width
                or int.from_bytes(png[20:24], "big") != height):
            raise BuildControlError("Browser helper canvas screenshot PNG metadata differs")
    elif state == "omitted-size-limit":
        if (value.get("image_proof") is not False or data is not None
                or type(value.get("byte_length")) is not int
                or value["byte_length"] <= MAX_CANVAS_SCREENSHOT_BYTES):
            raise BuildControlError("Browser helper oversized screenshot omission is malformed")
    elif state == "omitted-capture-failed":
        reason = value.get("reason")
        if (value.get("image_proof") is not False or data is not None
                or value.get("byte_length") is not None
                or not isinstance(reason, str) or not reason or len(reason) > 512):
            raise BuildControlError("Browser helper screenshot capture omission is malformed")
    else:
        raise BuildControlError("Browser helper canvas screenshot state is unknown")


def _validate_run_performance_browser_proof(
    value: object,
    session: object,
    harness_sha256: str | None,
) -> None:
    if not isinstance(value, Mapping) or value.get("schema") != RUN_PERFORMANCE_PROOF_SCHEMA:
        raise BuildControlError("Browser helper run performance proof is missing or malformed")
    if value.get("state") != "passed" or value.get("engine_tab_clicked") is not True:
        raise BuildControlError("Browser helper did not open Engine for run performance QA")
    api = value.get("api")
    if not isinstance(api, Mapping) or not isinstance(session, Mapping):
        raise BuildControlError("Run performance proof omitted its API or active-session identity")
    api_instance_id = api.get("api_instance_id")
    if (not isinstance(api_instance_id, str)
            or re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", api_instance_id) is None):
        raise BuildControlError("Run performance API instance identity is malformed")
    for key in ("session_id", "session_epoch", "request_scope_epoch"):
        field = api.get(key)
        if not isinstance(field, str) or not field or len(field) > 512 or field != session.get(key):
            raise BuildControlError(f"Run performance API session identity differs at {key}")
    expected_scope = "session=" + quote(api["session_id"], safe="-_.!~*'()")
    expected_scope += "&epoch=" + quote(api["session_epoch"], safe="-_.!~*'()")
    expected_scope += "&request_scope_epoch=" + quote(api["request_scope_epoch"], safe="-_.!~*'()")

    def validate_api_snapshot(candidate: object) -> tuple[dict[str, int], float]:
        if not isinstance(candidate, Mapping):
            raise BuildControlError("Run performance API snapshot is malformed")
        for key in ("run_id", "task_id", "step_id", "attempt_id"):
            field = candidate.get(key)
            if not isinstance(field, str) or not field.strip() or len(field) > 512:
                raise BuildControlError(f"Run performance API identity field is malformed: {key}")
        identity_fields = (
            "api_instance_id", "session_id", "session_epoch", "request_scope_epoch",
            "run_id", "task_id", "step_id", "attempt_id", "ownership_epoch",
        )
        if any(candidate.get(key) != api.get(key) for key in identity_fields):
            raise BuildControlError("Run performance API snapshot changed its run/task/attempt/session/API identity")
        if candidate.get("status_run_id") != candidate.get("run_id"):
            raise BuildControlError("Run performance resource differs from the current session run")
        if not isinstance(candidate.get("state"), str) or candidate["state"] == "unavailable":
            raise BuildControlError("Run performance proof has no verified attempt state")
        revision = candidate.get("revision")
        if not isinstance(revision, str) or not revision or len(revision) > 512:
            raise BuildControlError("Run performance resource revision is malformed")
        integer_fields = (
            "ownership_epoch", "first_step_index", "step_index", "elapsed_monotonic_ns",
            "point_count", "sample_sequence",
        )
        integers: dict[str, int] = {}
        for key in integer_fields:
            number = candidate.get(key)
            if type(number) is not int or not 0 <= number <= MAX_SAFE_JSON_INTEGER:
                raise BuildControlError(f"Run performance {key} is not a safe non-negative integer")
            integers[key] = number
        if (integers["elapsed_monotonic_ns"] <= 0
                or integers["step_index"] < integers["first_step_index"]
                or not 1 <= integers["point_count"] <= 120):
            raise BuildControlError("Run performance step span, elapsed time, or bounded sample count is invalid")
        measured: dict[str, int | float | None] = {}
        for key in ("cpu_percent", "gpu_percent"):
            number = candidate.get(key)
            if number is not None and (type(number) not in (int, float) or not math.isfinite(number) or number < 0):
                raise BuildControlError(f"Run performance {key} is not a finite non-negative measurement")
            measured[key] = number
        if measured["cpu_percent"] is None and measured["gpu_percent"] is None:
            raise BuildControlError("Run performance has neither a measured CPU nor GPU value")
        calculated_rate = (
            integers["step_index"] - integers["first_step_index"]
        ) / (integers["elapsed_monotonic_ns"] / 1_000_000_000)
        reported_rate = candidate.get("stage_rate_steps_per_s")
        if (type(reported_rate) not in (int, float) or not math.isfinite(reported_rate)
                or not math.isclose(reported_rate, calculated_rate, rel_tol=1e-12, abs_tol=1e-12)):
            raise BuildControlError("Run performance stage rate does not match the verified step span and elapsed time")
        return integers, calculated_rate

    main_integers, main_rate = validate_api_snapshot(api)
    snapshots = value.get("api_snapshots")
    if not isinstance(snapshots, list) or not 1 <= len(snapshots) <= 8:
        raise BuildControlError("Run performance proof omitted its bounded recent API snapshots")
    previous_sequence = -1
    previous_elapsed = -1
    for snapshot in snapshots:
        integers, _ = validate_api_snapshot(snapshot)
        if (integers["sample_sequence"] < previous_sequence
                or integers["elapsed_monotonic_ns"] < previous_elapsed):
            raise BuildControlError("Run performance API snapshots are not in monotonic sequence order")
        previous_sequence = integers["sample_sequence"]
        previous_elapsed = integers["elapsed_monotonic_ns"]
    if not any(snapshot == api for snapshot in snapshots):
        raise BuildControlError("Run performance selected API snapshot is outside its bounded observation history")

    requests = value.get("api_requests")
    if (not isinstance(requests, list) or not 2 <= len(requests) <= 9
            or not isinstance(requests[0], Mapping)):
        raise BuildControlError("Run performance proof must include bounded scoped status and performance GETs")
    status_request = requests[0]
    if (status_request.get("method") != "GET"
            or status_request.get("path") != "/v2/sessions/current/status"
            or status_request.get("status") != 200
            or status_request.get("api_instance_id") != api_instance_id
            or status_request.get("session_scope_header_sent") != expected_scope
            or status_request.get("api_instance_header_sent") is not None):
        raise BuildControlError("Run performance status GET is not correctly scoped")
    successful_performance_reads = 0
    busy_performance_reads = 0
    for request in requests[1:]:
        if (not isinstance(request, Mapping)
                or request.get("method") != "GET"
                or request.get("path") != "/v2/sessions/current/diagnostics/performance"
                or request.get("session_scope_header_sent") != expected_scope
                or request.get("api_instance_header_sent") != api_instance_id
                or request.get("api_instance_id") != api_instance_id):
            raise BuildControlError("Run performance resource GET changed its session/API scope")
        if request.get("status") == 200 and "error_code" not in request:
            successful_performance_reads += 1
        elif (request.get("status") == 409
                and request.get("error_code") == "performance_observation_busy"):
            busy_performance_reads += 1
        else:
            raise BuildControlError("Run performance observation reported a non-retryable API response")
    if successful_performance_reads != len(snapshots) or successful_performance_reads + busy_performance_reads > 8:
        raise BuildControlError("Run performance snapshot and bounded API request counts differ")

    def parse_displayed_number(text: object, suffix: str, label: str) -> float | None:
        if text == "N/A":
            return None
        if not isinstance(text, str) or not text.endswith(suffix):
            raise BuildControlError(f"Run performance panel {label} display is malformed")
        number_text = text[:-len(suffix)].strip().replace(",", "")
        try:
            number = float(number_text)
        except ValueError as error:
            raise BuildControlError(f"Run performance panel {label} is not numeric") from error
        if not math.isfinite(number):
            raise BuildControlError(f"Run performance panel {label} is not finite")
        return number

    def require_display_matches(text: object, raw: int | float | None, suffix: str, label: str) -> None:
        displayed = parse_displayed_number(text, suffix, label)
        if raw is None:
            if displayed is not None:
                raise BuildControlError(f"Run performance panel {label} must show N/A for an unavailable value")
        elif displayed is None or not math.isclose(displayed, float(raw), rel_tol=1e-12, abs_tol=0.0051):
            raise BuildControlError(f"Run performance panel {label} differs from its scoped API value")

    def validate_panel_match(candidate: object, candidate_api: Mapping[str, object]) -> None:
        if not isinstance(candidate, Mapping) or candidate.get("visible") is not True:
            raise BuildControlError("Automatic performance panel match is not visibly rendered")
        candidate_integers, candidate_rate = validate_api_snapshot(candidate_api)
        expected_identity = " · ".join((
            f"Run {candidate_api['run_id']}", f"Task {candidate_api['task_id']}",
            f"Step {candidate_api['step_id']}", f"Attempt {candidate_api['attempt_id']}",
            f"Epoch {candidate_integers['ownership_epoch']}",
        ))
        if candidate.get("identity") != expected_identity:
            raise BuildControlError("Automatic performance panel identity differs from its matched API snapshot")
        elapsed_ns = candidate_integers["elapsed_monotonic_ns"]
        if elapsed_ns >= 1_000_000_000:
            elapsed_unit, elapsed_expected = " s", elapsed_ns / 1_000_000_000
        elif elapsed_ns >= 1_000_000:
            elapsed_unit, elapsed_expected = " ms", elapsed_ns / 1_000_000
        else:
            elapsed_unit, elapsed_expected = " ns", float(math.floor(elapsed_ns + 0.5))
        elapsed_display = parse_displayed_number(candidate.get("elapsed"), elapsed_unit, "elapsed")
        elapsed_tolerance = 0.51 if elapsed_unit == " ns" else 0.0051
        if elapsed_display is None or not math.isclose(elapsed_display, elapsed_expected, rel_tol=1e-12, abs_tol=elapsed_tolerance):
            raise BuildControlError("Automatic performance panel elapsed value differs from its matched API snapshot")
        require_display_matches(candidate.get("stage_rate"), candidate_rate, " steps/s", "stage rate")
        require_display_matches(candidate.get("cpu"), candidate_api.get("cpu_percent"), "%", "CPU")
        require_display_matches(candidate.get("gpu"), candidate_api.get("gpu_percent"), "%", "GPU")

    panel_matches = value.get("panel_matches")
    if not isinstance(panel_matches, list) or not 1 <= len(panel_matches) <= 8:
        raise BuildControlError("Run performance proof omitted bounded atomically sampled panel matches")
    matched_sequences: set[int] = set()
    for match in panel_matches:
        if not isinstance(match, Mapping) or match.get("matched") is not True:
            raise BuildControlError("Run performance panel observation was not matched to an API snapshot")
        matched_api = match.get("api")
        if not isinstance(matched_api, Mapping) or not any(matched_api == snapshot for snapshot in snapshots):
            raise BuildControlError("Run performance panel match points outside the sampled API history")
        sample_sequence = matched_api.get("sample_sequence")
        if type(sample_sequence) is not int or sample_sequence in matched_sequences:
            raise BuildControlError("Run performance panel matches duplicated a sample sequence")
        matched_sequences.add(sample_sequence)
        validate_panel_match(match.get("panel"), matched_api)

    panel = value.get("panel")
    if not isinstance(panel, Mapping):
        raise BuildControlError("Automatic performance panel observation is missing")
    final_match = panel_matches[-1]
    final_panel_observation = final_match.get("panel")
    if not isinstance(final_panel_observation, Mapping):
        raise BuildControlError("Automatic performance final panel observation is malformed")
    validate_panel_match(final_panel_observation, final_match["api"])
    for key in ("identity", "elapsed", "stage_rate", "cpu", "gpu", "visible", "gpu_scope_note", "status"):
        if panel.get(key) != final_panel_observation.get(key):
            raise BuildControlError("Final Automatic performance panel differs from its atomically matched observation")
    measured = {key: api.get(key) for key in ("cpu_percent", "gpu_percent")}
    expected_metric_label = "CPU per core" if measured["cpu_percent"] is not None else "GPU whole device"
    expected_metric = measured["cpu_percent"] if measured["cpu_percent"] is not None else measured["gpu_percent"]
    if (panel.get("visible") is not True
            or panel.get("metric_label") != expected_metric_label
            or panel.get("metric_value") != panel.get("cpu" if expected_metric_label.startswith("CPU") else "gpu")):
        raise BuildControlError("Automatic performance panel/chart metric differs from its measured API series")

    state_was_running = any(snapshot.get("state") == "running" for snapshot in snapshots)
    live_refresh = value.get("live_refresh")
    if not isinstance(live_refresh, Mapping):
        raise BuildControlError("Run performance proof omitted its refresh classification")
    if state_was_running:
        if live_refresh.get("state") != "verified":
            raise BuildControlError("Running performance proof did not verify a live panel refresh")
        refresh_pair = None
        for first_index, first in enumerate(panel_matches):
            first_api = first["api"]
            for second in panel_matches[first_index + 1:]:
                second_api = second["api"]
                if (first_api.get("state") == second_api.get("state") == "running"
                        and first_api.get("revision") != second_api.get("revision")
                        and first_api.get("sample_sequence") < second_api.get("sample_sequence")
                        and first_api.get("elapsed_monotonic_ns") < second_api.get("elapsed_monotonic_ns")
                        and first["panel"].get("elapsed") != second["panel"].get("elapsed")):
                    refresh_pair = (first, second)
                    break
            if refresh_pair:
                break
        if refresh_pair is None:
            raise BuildControlError("Running performance panel did not match two advancing revisions/sample sequences")
        unique_revisions = {item["api"]["revision"] for item in panel_matches}
        unique_sequences = {item["api"]["sample_sequence"] for item in panel_matches}
        window_ms = live_refresh.get("window_ms")
        if (live_refresh.get("matched_revision_count") != len(unique_revisions)
                or live_refresh.get("matched_sample_sequence_count") != len(unique_sequences)
                or type(window_ms) is not int or not 0 <= window_ms <= 20_000):
            raise BuildControlError("Running performance refresh counts or observation bound are invalid")
    elif live_refresh.get("state") != "terminal-single-snapshot":
        raise BuildControlError("Terminal performance proof changed its single-snapshot QA behavior")
    gpu_scope_note = panel.get("gpu_scope_note")
    if (not isinstance(gpu_scope_note, str)
            or "whole_device" not in gpu_scope_note
            or "not kernel occupancy" not in gpu_scope_note.lower()):
        raise BuildControlError("Automatic performance panel omitted its whole-device GPU scope")
    chart = value.get("chart")
    if (not isinstance(chart, Mapping)
            or chart.get("visible") is not True
            or type(chart.get("canvas_count")) is not int
            or not 1 <= chart["canvas_count"] <= 8
            or type(chart.get("canvas_width")) is not int or chart["canvas_width"] <= 0
            or type(chart.get("canvas_height")) is not int or chart["canvas_height"] <= 0
            or type(chart.get("css_width")) not in (int, float) or chart["css_width"] <= 0
            or type(chart.get("css_height")) not in (int, float) or chart["css_height"] <= 0):
        raise BuildControlError("Automatic performance chart has no nonzero rendered canvas")
    _validate_canvas_screenshot(value.get("screenshot"))
    if (value.get("no_non_read_only_requests") is not True
            or type(value.get("blocked_mutation_count")) is not int
            or value["blocked_mutation_count"] != 0):
        raise BuildControlError("Run performance browser proof did not preserve the read-only boundary")
    if (not isinstance(harness_sha256, str) or not SHA256_RE.fullmatch(harness_sha256)):
        raise BuildControlError("Run performance selected-source harness hash is missing")


def _validate_ambiguous_command_submission(value: object, session: object) -> None:
    if not isinstance(value, Mapping) or value.get("state") != "passed":
        raise BuildControlError("Browser helper omitted accepted Compute Fields response-loss evidence")
    session_scope = value.get("session_scope")
    if not isinstance(session, Mapping) or not isinstance(session_scope, Mapping):
        raise BuildControlError("Browser helper ambiguous-command session scope is missing")
    for field in ("session_id", "session_epoch", "request_scope_epoch"):
        if session_scope.get(field) != session.get(field):
            raise BuildControlError("Browser helper ambiguous-command session scope changed")

    command_posts = value.get("command_posts")
    if (not isinstance(command_posts, Mapping)
            or type(command_posts.get("count")) is not int
            or command_posts.get("count") != 1
            or command_posts.get("kinds") != ["compute_fields"]
            or type(command_posts.get("solve_count")) is not int
            or command_posts.get("solve_count") != 0
            or type(command_posts.get("forwarded_count")) is not int
            or command_posts.get("forwarded_count") != 1
            or type(command_posts.get("expected_abort_count")) is not int
            or command_posts.get("expected_abort_count") != 1
            or type(command_posts.get("expected_request_failure_count")) is not int
            or command_posts.get("expected_request_failure_count") != 1):
        raise BuildControlError("Browser helper did not prove one forwarded Compute Fields POST and one response drop")

    intent_id = value.get("client_intent_id")
    if (not isinstance(intent_id, str) or not intent_id or intent_id != intent_id.strip()
            or len(intent_id) > 512
            or any(ord(character) < 32 or ord(character) == 127 for character in intent_id)):
        raise BuildControlError("Browser helper Compute Fields client intent is malformed")
    upstream = value.get("upstream_response")
    if not isinstance(upstream, Mapping):
        raise BuildControlError("Browser helper omitted the actual Compute Fields response")
    status = upstream.get("status")
    command_id = upstream.get("command_id")
    api_instance = upstream.get("api_instance")
    if (type(status) is not int or not 200 <= status < 300
            or upstream.get("accepted") is not True
            or not isinstance(command_id, str) or not command_id or len(command_id) > 512
            or not isinstance(api_instance, str)
            or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", api_instance)):
        raise BuildControlError("Browser helper did not receive one accepted, API-instance-pinned backend response")
    if upstream.get("request_api_instance") not in (None, api_instance):
        raise BuildControlError("Browser helper POST API-instance request/response pin differs")

    dropped_request = value.get("expected_response_drop")
    if not isinstance(dropped_request, Mapping):
        raise BuildControlError("Browser helper omitted the exact deliberately dropped browser request")
    dropped_url = dropped_request.get("url")
    dropped_error = dropped_request.get("error")
    if (dropped_request.get("method") != "POST"
            or not isinstance(dropped_url, str) or len(dropped_url) > 4096
            or urlsplit(dropped_url).path != "/v2/sessions/current/simulation/commands"
            or urlsplit(dropped_url).scheme not in {"http", "https"}
            or not isinstance(dropped_error, str) or not dropped_error or len(dropped_error) > 2048):
        raise BuildControlError("Browser helper deliberate response drop was not the exact Compute Fields POST")

    journal = value.get("journal")
    if not isinstance(journal, Mapping):
        raise BuildControlError("Browser helper omitted command journal reconciliation")
    if (type(journal.get("queue_status")) is not int or journal.get("queue_status") != 200
            or type(journal.get("detail_status")) is not int
            or journal.get("detail_status") != 200
            or type(journal.get("matching_intent_count")) is not int
            or journal.get("matching_intent_count") != 1
            or journal.get("client_intent_id") != intent_id
            or journal.get("kind") != "compute_fields"
            or journal.get("command_id") != command_id
            or journal.get("detail_command_id") != command_id
            or journal.get("detail_client_intent_id") != intent_id
            or journal.get("detail_kind") != "compute_fields"
            or journal.get("effective_status") != "completed"):
        raise BuildControlError("Browser helper journal does not prove the unique completed command")

    feedback = value.get("ui_feedback")
    statuses = feedback.get("statuses") if isinstance(feedback, Mapping) else None
    if (not isinstance(statuses, list) or len(statuses) > 32
            or any(item not in {"pending", "completed", "failed", "cancelled"} for item in statuses)
            or "failed" in statuses or "cancelled" in statuses
            or "pending" not in statuses or "completed" not in statuses
            or statuses.index("completed") <= statuses.index("pending")):
        raise BuildControlError("Browser helper UI feedback did not show pending then completed")
    messages = feedback.get("messages") if isinstance(feedback, Mapping) else None
    if (not isinstance(messages, list) or len(messages) > 32
            or any(not isinstance(item, str) or len(item) > 512 for item in messages)):
        raise BuildControlError("Browser helper UI feedback messages are malformed")


def _validate_resource_responses(value: object) -> None:
    if not isinstance(value, list) or len(value) > 32:
        raise BuildControlError("Browser helper omitted bounded API resource responses")
    for response in value:
        if not isinstance(response, Mapping):
            raise BuildControlError("Browser helper API resource response is malformed")
        url = response.get("url")
        status = response.get("status")
        if (not isinstance(url, str) or not url.startswith(("http://", "https://"))
                or len(url) > 4096 or type(status) is not int or not 100 <= status < 400):
            raise BuildControlError("Browser helper API resource response is invalid")
        for field in ("content_type", "contract_version"):
            item = response.get(field)
            if item is not None and (not isinstance(item, str) or len(item) > 512):
                raise BuildControlError(f"Browser helper API resource response is malformed: {field}")


def _validate_startup_unmount_cancellation_probes(events_value: object, probes_value: object) -> None:
    allowed_paths = {
        "/v2/sessions/current/diagnostics/cpu",
        "/v2/sessions/current/diagnostics/gpu",
        "/v2/platform/compute/nodes",
        "/v2/platform/health",
        "/v2/sessions/current/model/planar-monitors",
        "/v2/sessions/current/simulation/preparation",
    }
    if not isinstance(events_value, list) or len(events_value) > 32:
        raise BuildControlError("Airbox Inspector startup request audit is malformed or over budget")
    if not isinstance(probes_value, list) or len(probes_value) > len(allowed_paths):
        raise BuildControlError("Airbox Inspector startup cancellation probes are malformed or over budget")

    events: dict[int, Mapping[str, object]] = {}
    failed_events: dict[int, Mapping[str, object]] = {}
    for event in events_value:
        if not isinstance(event, Mapping):
            raise BuildControlError("Airbox Inspector startup request audit entry is malformed")
        request_id = event.get("request_id")
        path = event.get("path")
        method = event.get("method")
        if (type(request_id) is not int or request_id <= 0 or request_id in events
                or not isinstance(path, str) or path not in allowed_paths
                or method != "GET"
                or event.get("same_origin") is not True
                or not isinstance(event.get("resource_type"), str)
                or not isinstance(event.get("started_phase"), str)
                or type(event.get("started_elapsed_ms")) is not int
                or event["started_elapsed_ms"] < 0):
            raise BuildControlError("Airbox Inspector startup request audit identity is invalid")
        events[request_id] = event
        outcome = event.get("outcome")
        if outcome == "finished":
            if (event.get("finished") is not True
                    or type(event.get("response_status")) is not int
                    or not 100 <= event["response_status"] < 600
                    or type(event.get("finished_elapsed_ms")) is not int
                    or event["finished_elapsed_ms"] < event["started_elapsed_ms"]):
                raise BuildControlError("Airbox Inspector startup request completion is malformed")
        elif outcome == "request-failed":
            failure_elapsed = event.get("failure_elapsed_ms")
            if (not isinstance(event.get("error"), str) or not event["error"]
                    or not isinstance(event.get("failure_phase"), str)
                    or type(failure_elapsed) is not int
                    or failure_elapsed < event["started_elapsed_ms"]):
                raise BuildControlError("Airbox Inspector startup request failure evidence is malformed")
            failed_events[request_id] = event
        elif outcome == "browser-context-shutdown":
            if (event.get("failure_phase") != "browser-context-shutdown"
                    or event.get("finished") is not False):
                raise BuildControlError("Airbox Inspector shutdown cancellation evidence is malformed")
        else:
            raise BuildControlError("Airbox Inspector retained an unsettled startup diagnostic request")

    probes_by_cancelled_id: dict[int, Mapping[str, object]] = {}
    probe_paths: set[str] = set()
    for probe in probes_value:
        if not isinstance(probe, Mapping):
            raise BuildControlError("Airbox Inspector startup cancellation probe is malformed")
        cancelled_id = probe.get("cancelled_request_id")
        probe_id = probe.get("probe_request_id")
        path = probe.get("path")
        if (probe.get("classification") != "startup-unmount-cancellation-followed-by-read-probe"
                or type(cancelled_id) is not int or type(probe_id) is not int
                or cancelled_id == probe_id
                or cancelled_id in probes_by_cancelled_id
                or not isinstance(path, str) or path not in allowed_paths or path in probe_paths
                or probe.get("method") != "GET"
                or probe.get("cancellation_error") != "net::ERR_ABORTED"
                or probe.get("cancellation_phase") != "workspace-navigation"
                or probe.get("workspace_ready") is not True
                or probe.get("home_overlay_visible") is not False
                or probe.get("probe_resource_type") != "fetch"
                or type(probe.get("probe_response_status")) is not int
                or not 200 <= probe["probe_response_status"] < 300
                or type(probe.get("probe_body_bytes")) is not int
                or not 0 <= probe["probe_body_bytes"] <= 262_144):
            raise BuildControlError("Airbox Inspector startup cancellation probe is not an exact bounded read")
        cancelled = failed_events.get(cancelled_id)
        replacement = events.get(probe_id)
        started = probe.get("probe_started_elapsed_ms")
        finished = probe.get("probe_finished_elapsed_ms")
        if (cancelled is None or replacement is None
                or cancelled.get("path") != path
                or cancelled.get("method") != "GET"
                or cancelled.get("error") != "net::ERR_ABORTED"
                or cancelled.get("started_phase") != "workspace-navigation"
                or cancelled.get("failure_phase") != "workspace-navigation"
                or replacement.get("path") != path
                or replacement.get("method") != "GET"
                or replacement.get("resource_type") != "fetch"
                or replacement.get("same_origin") is not True
                or replacement.get("outcome") != "finished"
                or replacement.get("response_status") != probe.get("probe_response_status")
                or type(started) is not int or type(finished) is not int
                or started <= cancelled.get("failure_elapsed_ms", -1)
                or started != replacement.get("started_elapsed_ms")
                or finished != replacement.get("finished_elapsed_ms")):
            raise BuildControlError("Airbox Inspector startup cancellation lacks its later successful same-origin read")
        probes_by_cancelled_id[cancelled_id] = probe
        probe_paths.add(path)

    if set(failed_events) != set(probes_by_cancelled_id):
        raise BuildControlError("Airbox Inspector startup request failure was not resolved by an exact follow-up probe")


def _parse_inspector_ack_result(output, public_url, browser_url, expected_sources):
    _validate_inspector_ack_hashes(expected_sources)
    if not isinstance(output, bytes) or len(output) > MAX_RESULT_BYTES:
        raise BuildControlError("Inspector ACK result exceeds its evidence budget")
    payload = None
    for line in reversed(output.decode("utf-8", "replace").splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if (not isinstance(payload, Mapping)
            or payload.get("schema") != INSPECTOR_ACK_RESULT_SCHEMA
            or payload.get("scenario") != "inspector-ack" or payload.get("state") != "passed"
            or payload.get("failure") is not None):
        raise BuildControlError("Inspector ACK helper did not report a passing proof")
    if (payload.get("public_url") != public_url or payload.get("probe_url") != browser_url
            or payload.get("playwright_version") != PLAYWRIGHT_VERSION
            or payload.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or payload.get("source_sha256_before") != expected_sources
            or payload.get("source_sha256_after") != expected_sources):
        raise BuildControlError("Inspector ACK helper URL, browser or source pins differ")
    session = payload.get("session")
    if (not isinstance(session, Mapping) or session.get("name") != "airbox_inspector_mixed"
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))):
        raise BuildControlError("Inspector ACK helper did not pin its task-owned session")
    if payload.get("session_after") != session:
        raise BuildControlError("Inspector ACK helper session changed before restoration readback")
    object_id = payload.get("object_id")
    original = payload.get("original_name")
    generated = payload.get("generated_name")
    if (not isinstance(object_id, str) or not 1 <= len(object_id) <= 512
            or original != "mixed_p1_box_prism"
            or not isinstance(generated, str)
            or re.fullmatch(re.escape(original) + r"_ui_ack_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", generated) is None):
        raise BuildControlError("Inspector ACK helper object/name identity differs")
    if payload.get("node_preserved") is not True or payload.get("focus_preserved") is not True:
        raise BuildControlError("Inspector ACK helper lost its node or focus")
    snapshots = [payload.get(key) for key in ("baseline", "pending", "ack")]
    for snapshot in snapshots:
        if (not isinstance(snapshot, Mapping) or set(snapshot) != {"fields", "opacity_animations", "scroll"}
                or type(snapshot["opacity_animations"]) is not int or snapshot["opacity_animations"] != 0
                or type(snapshot["scroll"]) not in (int, float) or not math.isfinite(snapshot["scroll"])
                or not isinstance(snapshot["fields"], list) or not 1 <= len(snapshot["fields"]) <= 128):
            raise BuildControlError("Inspector ACK helper field/scroll snapshot is malformed")
        for field in snapshot["fields"]:
            if (not isinstance(field, Mapping) or set(field) != {"label", "disabled", "opacity"}
                    or type(field["disabled"]) is not bool
                    or not (field["label"] is None or isinstance(field["label"], str) and len(field["label"]) <= 256)
                    or not isinstance(field["opacity"], str) or len(field["opacity"]) > 32):
                raise BuildControlError("Inspector ACK field availability evidence is malformed")
    baseline, pending, acknowledged = snapshots
    if (baseline["fields"] != pending["fields"] or baseline["fields"] != acknowledged["fields"]
            or pending["scroll"] <= 0 or pending["scroll"] != acknowledged["scroll"]):
        raise BuildControlError("Inspector ACK helper field state or nonzero scroll was not preserved")
    receipts = payload.get("receipts")
    if (not isinstance(receipts, list) or len(receipts) != 2
            or [entry.get("phase") if isinstance(entry, Mapping) else None for entry in receipts] != ["commit", "restore"]):
        raise BuildControlError("Inspector ACK helper omitted exact commit/restore acknowledgements")
    for receipt in receipts:
        if (set(receipt) != {"phase", "status", "revision"} or type(receipt["status"]) is not int
                or not 200 <= receipt["status"] < 300 or type(receipt["revision"]) is not int
                or receipt["revision"] < 0):
            raise BuildControlError("Inspector ACK helper acknowledgement is malformed")
    restoration = payload.get("restoration")
    if (receipts[1]["revision"] <= receipts[0]["revision"] or not isinstance(restoration, Mapping)
            or restoration.get("state") != "restored" or restoration.get("name") != original
            or type(restoration.get("revision")) is not int
            or restoration["revision"] < receipts[1]["revision"]):
        raise BuildControlError("Inspector ACK helper did not confirm restoration through the API")
    counts = payload.get("request_counts")
    if (not isinstance(counts, Mapping) or not 1 <= len(counts) <= 128
            or payload.get("request_limit") != 128 or payload.get("per_path_read_limit") != 16):
        raise BuildControlError("Inspector ACK request budget is missing")
    object_path = "/v2/sessions/current/model/objects/" + quote(object_id, safe="")
    for key, count in counts.items():
        if (not isinstance(key, str) or len(key) > 2048 or type(count) is not int or count < 1
                or " " not in key):
            raise BuildControlError("Inspector ACK request counts are malformed")
        method, path = key.split(" ", 1)
        if method in {"GET", "HEAD"}:
            if not path.startswith("/v2/") or count > 16:
                raise BuildControlError("Inspector ACK read budget was exceeded")
        elif key == "PATCH " + object_path:
            if count != 2:
                raise BuildControlError("Inspector ACK submitted duplicate or missing object writes")
        elif key == "POST /v2/sessions/current/visualization/client-acks":
            if count > 16:
                raise BuildControlError("Inspector ACK visualization acknowledgements exceeded their bound")
        else:
            raise BuildControlError("Inspector ACK reported an unrelated mutation")
    measured = payload.get("measured_requests")
    total = payload.get("total_requests")
    if (counts.get("PATCH " + object_path) != 2 or type(measured) is not int
            or measured != sum(counts.values()) or not 2 <= measured <= 128
            or type(total) is not int or not measured <= total <= 512):
        raise BuildControlError("Inspector ACK helper exceeded its request budget")
    if any(payload.get(key) != [] for key in ("errors", "violations", "proxy_failures")):
        raise BuildControlError("Inspector ACK helper reported browser, proxy or request failures")
    return dict(payload)


def _study_stage_expected_ids(mode: str, phase: str) -> list[str]:
    if mode not in {"stage-b", "study", "material-stage-a", "fdm-cell-study", "texture-stage-b", "texture-study"} or phase not in {"before", "after"}:
        raise BuildControlError("Study stage rerun mode/phase is invalid")
    if phase == "before":
        return ["relax-b"] if mode in {"study", "texture-study"} else ["relax-a"] if mode == "fdm-cell-study" else ["relax-a", "relax-b", "relax-c"]
    if mode == "stage-b":
        return ["relax-b"]
    if mode == "material-stage-a":
        return ["relax-a"]
    if mode == "texture-stage-b":
        return ["relax-b"]
    return ["relax-a", "relax-b", "relax-c"]


def _expected_study_stage_scene_profile(
    *, pipeline_version: str = "study_pipeline.v1", texture_object_id: str | None = None,
) -> dict[str, object]:
    profile = {
        "requested_backend": "fdm",
        "requested_device": "cpu",
        "requested_precision": "double",
        "pipeline_version": pipeline_version,
        "stages": [
            {"id": "relax-a", "enabled": True, "node_kind": "primitive", "stage_kind": "relax",
             "relax_algorithm": "llg_overdamped", "max_steps": "10"},
            {"id": "relax-b", "enabled": True, "node_kind": "primitive", "stage_kind": "relax",
             "relax_algorithm": "projected_gradient_bb", "max_steps": "1"},
            {"id": "relax-c", "enabled": True, "node_kind": "primitive", "stage_kind": "relax",
             "relax_algorithm": "nonlinear_cg", "max_steps": "1"},
        ],
    }
    if pipeline_version == "study_pipeline.v2":
        profile["stage_b_texture_reset"] = {
            "stage_id": "relax-b", "object_id": texture_object_id,
            "scope": "object", "initializer": None,
        }
    return profile


STUDY_CAMERA_PATCH_KEY = "PATCH /v2/sessions/current/visualization/state"


def _validate_study_camera_patches(payload, session):
    receipts = payload.get("camera_patch_receipts", [])
    counts = payload.get("request_counts")
    if (not isinstance(receipts, list) or len(receipts) > 4
            or not isinstance(counts, Mapping) or counts.get(STUDY_CAMERA_PATCH_KEY, 0) != len(receipts)):
        raise BuildControlError("Study camera autosave inventory differs from its bounded receipts")
    if not receipts:
        return
    if not isinstance(session, Mapping):
        raise BuildControlError("Study camera autosave omitted its session")
    scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
        session["session_epoch"], safe="") + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
    fields = {"fov_degrees", "orthographic_scale", "position", "projection", "target", "up"}

    def finite(value):
        return type(value) in (float, int) and math.isfinite(value)

    for receipt in receipts:
        body = receipt.get("payload") if isinstance(receipt, Mapping) else None
        camera = body.get("camera") if isinstance(body, Mapping) else None
        if (not isinstance(receipt, Mapping)
                or set(receipt) != {"method", "path", "scope_header", "payload"}
                or receipt.get("method") != "PATCH"
                or receipt.get("path") != "/v2/sessions/current/visualization/state"
                or receipt.get("scope_header") != scope
                or not isinstance(body, Mapping) or set(body) != {"camera"}
                or not isinstance(camera, Mapping) or set(camera) != fields
                or camera.get("projection") not in ("orthographic", "perspective")
                or not finite(camera.get("fov_degrees")) or not 0 < camera["fov_degrees"] < 180
                or not (camera.get("orthographic_scale") is None
                        or finite(camera["orthographic_scale"]) and camera["orthographic_scale"] > 0)
                or any(not isinstance(camera[key], list) or len(camera[key]) != 3
                       or not all(finite(value) for value in camera[key]) for key in ("position", "target", "up"))):
            raise BuildControlError("Study camera autosave changed its scope or camera-only payload")


STUDY_MATERIAL_TRANSACTION_KEY = "POST /v2/sessions/current/model/transactions"
STUDY_FDM_CELL_TRANSACTION_KEY = "POST /v2/sessions/current/model/transactions"
STUDY_TEXTURE_TRANSACTION_KEY = "POST /v2/sessions/current/model/transactions"
STUDY_FDM_GRID_REFRESH_KEY = "POST /v2/sessions/current/simulation/commands"
STUDY_FDM_CELL_TARGET = [1e-9, 2e-9, 2e-9]


def _validate_study_material_receipt(payload, session, expected_scene_revision=None):
    receipt = payload.get("material_receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("Material-stage-A result omitted its guarded authoring receipt")
    base_fields = {
        "method", "path", "status", "scope_header", "payload", "before_scene_revision",
        "material_before", "acknowledged",
    }
    ack_fields = {
        "transaction_kind", "scene_revision", "material_after",
        "unmodified_scene_sha256_before", "unmodified_scene_sha256_after",
    }
    acknowledged = receipt.get("acknowledged")
    if (type(acknowledged) is not bool
            or set(receipt) != (base_fields | ack_fields if acknowledged else base_fields)
            or receipt.get("method") != "POST"
            or receipt.get("path") != "/v2/sessions/current/model/transactions"
            or receipt.get("status") is not None and (
                type(receipt["status"]) is not int or not 100 <= receipt["status"] <= 599
            )):
        raise BuildControlError("Material-stage-A authoring receipt is malformed")
    if not isinstance(session, Mapping):
        raise BuildControlError("Material-stage-A receipt omitted its session scope")
    scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
        session["session_epoch"], safe="") + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
    before = receipt.get("material_before")
    after = receipt.get("material_after") if acknowledged else None
    request = receipt.get("payload")
    if (receipt.get("scope_header") != scope or type(receipt.get("before_scene_revision")) is not int
            or receipt["before_scene_revision"] < 0 or not isinstance(before, Mapping)
            or not isinstance(request, Mapping)
            or set(request) != {"base_revision", "kind", "material_id", "patch"}
            or request.get("kind") != "patch_material"
            or request.get("base_revision") != receipt["before_scene_revision"]
            or not isinstance(request.get("material_id"), str) or not request["material_id"]
            or not isinstance(before.get("object_id"), str) or not before["object_id"]
            or before.get("material_id") != request["material_id"]
            or not isinstance(before.get("material_name"), str) or not before["material_name"]
            or not isinstance(before.get("magnetization_ref"), str) or not before["magnetization_ref"]
            or not isinstance(before.get("magnetization_asset_sha256"), str)
            or not SHA256_RE.fullmatch(before["magnetization_asset_sha256"])):
        raise BuildControlError("Material-stage-A receipt scope or selected material differs")
    before_properties = before.get("properties")
    patch = request.get("patch")
    patch_properties = patch.get("properties") if isinstance(patch, Mapping) else None
    if (not isinstance(before_properties, Mapping)
            or before_properties.get("Ms") != 800000 or before_properties.get("Aex") != 13e-12
            or before_properties.get("alpha") != 0.5
            or before_properties.get("Dind") is not None or before_properties.get("Dbulk") is not None
            or not isinstance(patch, Mapping) or set(patch) != {"name", "properties"}
            or patch.get("name") != before["material_name"]
            or not isinstance(patch_properties, Mapping)
            or set(patch_properties) != {"Aex", "Dbulk", "Dind", "Ms", "alpha"}
            or patch_properties.get("Ms") != 600000 or patch_properties.get("Aex") != 1e-11
            or patch_properties.get("alpha") != before_properties["alpha"]
            or patch_properties.get("Dind") != before_properties.get("Dind")
            or patch_properties.get("Dbulk") != before_properties.get("Dbulk")):
        raise BuildControlError("Material-stage-A transaction changed an unapproved material field")
    if not acknowledged:
        return dict(receipt)
    after_properties = after.get("properties") if isinstance(after, Mapping) else None
    if (receipt.get("transaction_kind") != "patch_material"
            or type(receipt.get("status")) is not int or not 200 <= receipt["status"] < 300
            or type(receipt.get("scene_revision")) is not int
            or receipt["scene_revision"] != receipt["before_scene_revision"] + 1
            or expected_scene_revision is not None and receipt["scene_revision"] != expected_scene_revision
            or not isinstance(after, Mapping) or after.get("object_id") != before["object_id"]
            or after.get("material_id") != before["material_id"]
            or after.get("material_name") != before["material_name"]
            or after.get("magnetization_ref") != before["magnetization_ref"]
            or after.get("magnetization_asset_sha256") != before["magnetization_asset_sha256"]
            or not isinstance(after_properties, Mapping)
            or after_properties.get("Ms") != 600000 or after_properties.get("Aex") != 1e-11
            or after_properties.get("alpha") != before_properties["alpha"]
            or after_properties.get("Dind") != before_properties.get("Dind")
            or after_properties.get("Dbulk") != before_properties.get("Dbulk")
            or {key: value for key, value in after_properties.items() if key not in {"Ms", "Aex"}}
            != {key: value for key, value in before_properties.items() if key not in {"Ms", "Aex"}}):
        raise BuildControlError("Material-stage-A ACK does not match its accepted exact edit")
    old_scene_sha = receipt.get("unmodified_scene_sha256_before")
    new_scene_sha = receipt.get("unmodified_scene_sha256_after")
    if (not isinstance(old_scene_sha, str) or not SHA256_RE.fullmatch(old_scene_sha)
            or new_scene_sha != old_scene_sha):
        raise BuildControlError("Material-stage-A ACK changed scene state outside the material asset")
    return dict(receipt)


def _validate_study_fdm_cell_receipt(payload, session, expected_before_revision=None, require_acknowledged=True):
    receipt = payload.get("fdm_cell_receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("FDM-cell-study result omitted its guarded Study merge-patch receipt")
    base_fields = {
        "method", "path", "status", "scope_header", "payload", "before_scene_revision",
        "before_cell", "acknowledged",
    }
    ack_fields = {
        "transaction_kind", "scene_revision", "after_cell",
        "unmodified_scene_sha256_before", "unmodified_scene_sha256_after",
    }
    acknowledged = receipt.get("acknowledged")
    if (type(acknowledged) is not bool
            or set(receipt) != (base_fields | ack_fields if acknowledged else base_fields)
            or receipt.get("method") != "POST"
            or receipt.get("path") != "/v2/sessions/current/model/transactions"
            or receipt.get("status") is not None and (
                type(receipt["status"]) is not int or not 100 <= receipt["status"] <= 599
            )):
        raise BuildControlError("FDM-cell-study authoring receipt is malformed")
    if not isinstance(session, Mapping):
        raise BuildControlError("FDM-cell-study receipt omitted its session scope")
    scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
        session["session_epoch"], safe="") + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
    before_cell = receipt.get("before_cell")
    request = receipt.get("payload")
    merge_patch = request.get("merge_patch") if isinstance(request, Mapping) else None
    study_patch = merge_patch.get("study") if isinstance(merge_patch, Mapping) else None
    fdm_patch = study_patch.get("fdm") if isinstance(study_patch, Mapping) else None
    if (receipt.get("scope_header") != scope
            or type(receipt.get("before_scene_revision")) is not int or receipt["before_scene_revision"] < 0
            or expected_before_revision is not None and receipt["before_scene_revision"] != expected_before_revision
            or not isinstance(before_cell, list) or len(before_cell) != 3
            or any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in before_cell)
            or before_cell == STUDY_FDM_CELL_TARGET
            or not isinstance(request, Mapping)
            or set(request) != {"base_revision", "kind", "merge_patch"}
            or request.get("kind") != "merge_patch"
            or request.get("base_revision") != receipt["before_scene_revision"]
            or not isinstance(merge_patch, Mapping) or set(merge_patch) != {"study"}
            or not isinstance(study_patch, Mapping) or set(study_patch) != {"fdm"}
            or not isinstance(fdm_patch, Mapping) or set(fdm_patch) != {"default_cell"}
            or fdm_patch.get("default_cell") != STUDY_FDM_CELL_TARGET):
        raise BuildControlError("FDM-cell-study merge-patch changed its revision, scope or target")
    if not acknowledged:
        if require_acknowledged:
            raise BuildControlError("FDM-cell-study merge-patch was not acknowledged")
        return dict(receipt)
    if (receipt.get("transaction_kind") != "merge_patch"
            or type(receipt.get("status")) is not int or not 200 <= receipt["status"] < 300
            or type(receipt.get("scene_revision")) is not int
            or receipt["scene_revision"] != receipt["before_scene_revision"] + 1
            or receipt.get("after_cell") != STUDY_FDM_CELL_TARGET
            or not isinstance(receipt.get("unmodified_scene_sha256_before"), str)
            or not SHA256_RE.fullmatch(receipt["unmodified_scene_sha256_before"])
            or receipt.get("unmodified_scene_sha256_after") != receipt["unmodified_scene_sha256_before"]):
        raise BuildControlError("FDM-cell-study ACK did not prove exactly the requested grid-policy edit")
    return dict(receipt)


def _validate_study_fdm_material_state(value):
    properties = value.get("properties") if isinstance(value, Mapping) else None
    if (not isinstance(value, Mapping)
            or not isinstance(value.get("object_id"), str) or not value["object_id"]
            or not isinstance(value.get("material_id"), str) or not value["material_id"]
            or value.get("material_name") != "film material"
            or not isinstance(properties, Mapping)
            or properties.get("Ms") != 600000 or properties.get("Aex") != 1e-11
            or properties.get("alpha") != 0.5
            or properties.get("Dind") is not None or properties.get("Dbulk") is not None
            or not isinstance(value.get("magnetization_ref"), str) or not value["magnetization_ref"]
            or not isinstance(value.get("magnetization_asset_sha256"), str)
            or not SHA256_RE.fullmatch(value["magnetization_asset_sha256"])):
        raise BuildControlError("FDM-cell-study did not retain the accepted film material and authored m0")
    return dict(value)


def _validate_study_fdm_request_inventory(payload, expected_grid_posts, expected_compute_posts):
    request_counts = payload.get("request_counts")
    command_key = STUDY_FDM_GRID_REFRESH_KEY
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    if (not isinstance(request_counts, Mapping) or not 1 <= len(request_counts) <= 128
            or request_counts.get(STUDY_FDM_CELL_TRANSACTION_KEY) != 1
            or request_counts.get(command_key, 0) != expected_grid_posts + expected_compute_posts):
        raise BuildControlError("FDM-cell-study request inventory does not match its guarded writes")
    for key, count in request_counts.items():
        if (not isinstance(key, str) or " " not in key or len(key) > 2048
                or type(count) is not int or count < 1 or count > 512):
            raise BuildControlError("FDM-cell-study request inventory is malformed")
        method, path = key.split(" ", 1)
        if method == "GET" and path.startswith("/v2/"):
            continue
        if key == STUDY_FDM_CELL_TRANSACTION_KEY and count == 1:
            continue
        if key == STUDY_CAMERA_PATCH_KEY and count <= 4:
            continue
        if key == ack_key and count <= 16:
            continue
        if key == command_key and count == expected_grid_posts + expected_compute_posts:
            continue
        raise BuildControlError("FDM-cell-study attempted an unapproved or duplicate API mutation")
    if (type(payload.get("total_requests")) is not int
            or sum(request_counts.values()) != payload["total_requests"]
            or payload["total_requests"] > 512
            or payload.get("request_limit") != 512
            or payload.get("request_path_limit") != 128
            or payload.get("per_path_read_limit") != 128):
        raise BuildControlError("FDM-cell-study request inventory exceeded its fixed budget")


def _validate_fdm_cell_study_unknown_before_compute(payload, public_url, browser_url, expected_sources):
    if (payload.get("state") != "outcome-unknown" or payload.get("outcome") != "unknown"
            or not isinstance(payload.get("failure"), str) or not 1 <= len(payload["failure"]) <= 512
            or payload.get("public_url") != public_url or payload.get("probe_url") != browser_url
            or payload.get("playwright_version") != PLAYWRIGHT_VERSION
            or payload.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or payload.get("source_sha256_before") != expected_sources
            or payload.get("source_sha256_after") != expected_sources):
        raise BuildControlError("FDM-cell-study unknown outcome omitted its fixed source/runtime pins")
    session = payload.get("session_before")
    if (not isinstance(session, Mapping) or session.get("name") != "P22 three Relax stages"
            or payload.get("session_after") != session
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))):
        raise BuildControlError("FDM-cell-study unknown outcome did not retain its exact session scope")
    before = payload.get("before")
    if not isinstance(before, Mapping):
        raise BuildControlError("FDM-cell-study unknown outcome omitted its prior A-only run")
    run_id = before.get("run_id")
    profile = before.get("profile")
    precondition = before.get("precondition")
    if (not isinstance(run_id, str) or not run_id
            or before.get("run_status") != "completed"
            or before.get("solver_state") != "awaiting_command"
            or before.get("execution_state") != "completed"
            or before.get("stage_ids") != ["relax-a"]
            or before.get("authored_stage_ids") != ["relax-a", "relax-b", "relax-c"]
            or before.get("stage_statuses") != ["completed", "pending", "pending"]
            or before.get("completed_stage_indexes") != [0]
            or before.get("scene_profile") != _expected_study_stage_scene_profile()
            or not isinstance(profile, Mapping)
            or profile.get("domain_discretization") != "fdm"
            or profile.get("domain_cell_count") != 8
            or profile.get("domain_generation_id") != (precondition.get("domain_generation_id")
                                                         if isinstance(precondition, Mapping) else None)
            or profile.get("requested_backend") != "fdm"
            or profile.get("requested_device") != "cpu"
            or profile.get("requested_precision") != "double"
            or profile.get("script_sha256") != expected_sources["fixture"]
            or profile.get("script_path") != "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py"):
        raise BuildControlError("FDM-cell-study unknown outcome omitted its pinned A-only FDM baseline")
    _validate_study_fdm_material_state(before.get("material_state"))
    if _validate_study_fdm_material_state(payload.get("fdm_material_initial_state")) != before["material_state"]:
        raise BuildControlError("FDM-cell-study changed the material or authored m0 during grid refresh")
    if (type(payload.get("material_count")) is not int or payload.get("material_count") != 0
            or type(payload.get("material_attempt_count")) is not int
            or payload.get("material_attempt_count") != 0
            or payload.get("material_receipt") is not None or payload.get("ui_material_proven") is not False):
        raise BuildControlError("FDM-cell-study unknown outcome reported an out-of-scope material edit")
    if (not isinstance(precondition, Mapping)
            or precondition.get("current_run") != {"kind": "run", "run_id": run_id}
            or precondition.get("runtime_state") != "awaiting_command"
            or not isinstance(precondition.get("domain_generation_id"), str)
            or not precondition["domain_generation_id"]
            or any(type(precondition.get(key)) is not int or precondition[key] < 0 for key in (
                "scene_revision", "mesh_revision", "command_revision",
                "region_topology_revision", "region_membership_revision",
                "region_coefficients_revision", "region_initial_state_revision",
            )) or "stage_execution_revision" in precondition):
        raise BuildControlError("FDM-cell-study unknown outcome omitted its exact current precondition")
    results = before.get("result_identities")
    if (not isinstance(results, list) or len(results) != 1
            or not isinstance(results[0], Mapping)
            or results[0].get("authored_stage_id") != "relax-a"):
        raise BuildControlError("FDM-cell-study unknown outcome omitted the immutable A result")
    source = results[0].get("source")
    if (not isinstance(source, Mapping) or source.get("run_id") != run_id
            or any(not isinstance(source.get(key), str) or not source[key]
                   for key in ("task_id", "step_id", "case_id", "attempt_id"))
            or type(source.get("ownership_epoch")) is not int or source["ownership_epoch"] < 0
            or not isinstance(results[0].get("artifact_sha256"), str)
            or not SHA256_RE.fullmatch(results[0]["artifact_sha256"])):
        raise BuildControlError("FDM-cell-study unknown outcome has a malformed prior A result")
    if (payload.get("after") is not None or payload.get("reload_proof") is not None
            or payload.get("history_identity_preserved") is not None
            or payload.get("public_terminal_proven") is not False
            or payload.get("native_execution_proven") is not False
            or payload.get("field_data_proven") is not False
            or payload.get("command_receipt") is not None
            or payload.get("ui_command_proven") is not False
            or payload.get("command_count") != 0
            or payload.get("command_attempt_count") != 0):
        raise BuildControlError("FDM-cell-study unknown outcome claims a compute dispatch or terminal proof")
    phase = payload.get("phase")
    allowed_phases = ({"fdm-grid-ready", "ui-submit"} if payload.get("prepared_grid_run") is not None else {
        "fdm-cell-dispatched", "fdm-cell-unknown", "fdm-grid-submit", "fdm-grid-dispatched",
        "fdm-grid-observing", "fdm-grid-unknown",
    })
    if phase not in allowed_phases:
        raise BuildControlError("FDM-cell-study unknown outcome ended outside the bounded pre-compute phases")
    cell_receipt = _validate_study_fdm_cell_receipt(
        payload, session,
        expected_before_revision=(precondition["scene_revision"]
                                  if profile["domain_cell_count"] == 8
                                  else precondition["scene_revision"] - 1),
        require_acknowledged=False,
    )
    if (type(payload.get("fdm_cell_count")) is not int or payload.get("fdm_cell_count") != 1
            or type(payload.get("fdm_cell_attempt_count")) is not int
            or payload.get("fdm_cell_attempt_count") != 1
            or payload.get("ui_fdm_cell_proven") is not True):
        raise BuildControlError("FDM-cell-study unknown outcome omitted its one intercepted cell transaction")
    grid_count = payload.get("grid_refresh_count")
    grid_attempts = payload.get("grid_refresh_attempt_count")
    if (type(grid_count) is not int or grid_count not in (0, 1)
            or type(grid_attempts) is not int or grid_attempts != grid_count
            or payload.get("ui_grid_refresh_proven") is not (grid_count == 1)):
        raise BuildControlError("FDM-cell-study unknown outcome has inconsistent grid-refresh attempts")
    if grid_count:
        grid_receipt = _validate_study_fdm_grid_refresh_receipt(
            payload, session, cell_receipt, run_id, results, require_ready=False,
        )
    else:
        if payload.get("grid_refresh_receipt") is not None:
            raise BuildControlError("FDM-cell-study retained a grid receipt without a grid-refresh attempt")
        grid_receipt = None
    prepared = payload.get("prepared_grid_run")
    if prepared is not None:
        if not isinstance(grid_receipt, Mapping) or not grid_receipt.get("accepted"):
            raise BuildControlError("FDM-cell-study reported a held run without an accepted grid refresh")
        prepared = _validate_study_fdm_prepared_grid_run(
            prepared, previous_run=run_id, previous_domain_generation=profile["domain_generation_id"],
            cell_receipt=cell_receipt, previous_precondition=precondition,
            expected_script_sha256=expected_sources["fixture"],
        )
        transition = grid_receipt.get("domain_transition") if grid_receipt else None
        if (payload.get("phase") not in {"fdm-grid-ready", "ui-submit"}
                or not isinstance(transition, Mapping)
                or transition.get("ready_domain_generation_id") != prepared["profile"].get("domain_generation_id")
                or transition.get("prepared_run_id") != prepared.get("run_id")
                or transition.get("prior_run_id") != run_id
                or transition.get("preserved_prior_result_identities") != results
                or transition.get("preparation_id") != prepared["preparation"]["preparation_id"]
                or transition.get("preparation_revision") != prepared["preparation"]["revision"]):
            raise BuildControlError("FDM-cell-study unknown outcome did not retain the ready held-grid frontier")
    elif payload.get("phase") in {"fdm-grid-ready", "ui-submit"}:
        raise BuildControlError("FDM-cell-study reached Compute Study arming without a held-grid proof")
    if (payload.get("client_ack_count") != payload.get("request_counts", {}).get(
            "POST /v2/sessions/current/visualization/client-acks", 0)):
        raise BuildControlError("FDM-cell-study unknown outcome client acknowledgement count differs")
    read_counts = payload.get("read_counts")
    required_reads = {"status", "current_session", "scene", "commands", "current_run", "stage_execution",
                      "solver_status", "stage_results", "command_details", "preparation"}
    if (not isinstance(read_counts, Mapping) or set(read_counts) != required_reads
            or any(type(value) is not int or value < 0 or value > 512 for value in read_counts.values())):
        raise BuildControlError("FDM-cell-study unknown outcome read inventory is malformed")
    _validate_study_camera_patches(payload, session)
    grid_posts = grid_attempts
    _validate_study_fdm_request_inventory(payload, grid_posts, 0)
    for key in ("violations", "errors", "proxy_failures"):
        values = payload.get(key)
        if (not isinstance(values, list) or len(values) > 16
                or any(not isinstance(value, str) or len(value) > 512 for value in values)):
            raise BuildControlError("FDM-cell-study unknown outcome diagnostics are malformed")
    if payload.get("violations") != []:
        raise BuildControlError("FDM-cell-study unknown outcome reported a rejected or out-of-scope request")
    return dict(payload)


def _validate_study_fdm_grid_refresh_receipt(payload, session, cell_receipt, previous_run,
                                              prior_results, require_ready=True):
    receipt = payload.get("grid_refresh_receipt")
    if not isinstance(receipt, Mapping):
        raise BuildControlError("FDM-cell-study result omitted its automatic grid-refresh receipt")
    base_fields = {"method", "path", "status", "scope_header", "payload", "accepted", "terminal_detail",
                   "failed_grid_response"}
    request = receipt.get("payload")
    terminal = receipt.get("terminal_detail")
    transition = receipt.get("domain_transition")
    accepted = receipt.get("accepted")
    allowed_fields = base_fields | ({"command_id"} if accepted is True else set())
    if transition is not None:
        allowed_fields.add("domain_transition")
    if (type(accepted) is not bool or set(receipt) != allowed_fields or receipt.get("method") != "POST"
            or receipt.get("path") != "/v2/sessions/current/simulation/commands"
            or receipt.get("status") is not None and (
                type(receipt["status"]) is not int or not 100 <= receipt["status"] <= 599
            )
            or not isinstance(session, Mapping)
            or receipt.get("scope_header") != "session=" + quote(session["session_id"], safe="")
            + "&epoch=" + quote(session["session_epoch"], safe="")
            + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
            or not isinstance(request, Mapping)
            or set(request) != {"client_intent_id", "kind", "precondition", "reason"}
            or request.get("kind") != "fdm_grid_refresh"
            or request.get("reason") != "study_global_commit"
            or not isinstance(request.get("client_intent_id"), str)
            or not re.fullmatch(r"fdm-grid-refresh-[0-9]+-[0-9]+", request["client_intent_id"])
            or not isinstance(request.get("precondition"), Mapping)
            or not isinstance(cell_receipt, Mapping)
            or request["precondition"] != {"scene_revision": cell_receipt.get("scene_revision")}):
        raise BuildControlError("FDM-cell-study automatic grid-refresh command scope or terminal ACK differs")
    if not accepted:
        if terminal is not None or "command_id" in receipt or transition is not None:
            raise BuildControlError("Unaccepted FDM grid refresh retained contradictory terminal evidence")
        failed_response = receipt.get("failed_grid_response")
        status = receipt.get("status")
        if status is None:
            if failed_response is not None:
                raise BuildControlError("FDM grid refresh retained an error body without an HTTP response")
        elif status >= 400:
            if (not isinstance(failed_response, Mapping) or set(failed_response) != {"code", "message"}
                    or not isinstance(failed_response.get("code"), str)
                    or not 1 <= len(failed_response["code"]) <= 128
                    or not isinstance(failed_response.get("message"), str)
                    or not 1 <= len(failed_response["message"]) <= 512):
                raise BuildControlError("Rejected FDM grid refresh omitted its bounded server error response")
        elif failed_response is not None:
            raise BuildControlError("FDM grid refresh reported an error body for a non-error response")
        if require_ready:
            raise BuildControlError("FDM-cell-study automatic grid refresh was not accepted")
        return dict(receipt)
    if (type(receipt.get("status")) is not int or not 200 <= receipt["status"] < 300
            or not isinstance(receipt.get("command_id"), str) or not receipt["command_id"]
            or receipt.get("failed_grid_response") is not None):
        raise BuildControlError("Accepted FDM grid refresh omitted its command acknowledgement")
    if terminal is None:
        if transition is not None or require_ready:
            raise BuildControlError("Accepted FDM grid refresh omitted its terminal detail")
        return dict(receipt)
    if (not isinstance(terminal, Mapping)
            or set(terminal) != {"command_id", "kind", "status", "completion_status", "client_intent_id", "reason", "seq"}
            or terminal.get("command_id") != receipt["command_id"]
            or terminal.get("kind") != "fdm_grid_refresh"
            or terminal.get("status") != "completed" or terminal.get("completion_status") != "completed"
            or terminal.get("client_intent_id") != request["client_intent_id"]
            or terminal.get("reason") != "study_global_commit"
            or type(terminal.get("seq")) is not int or terminal["seq"] < 0):
        raise BuildControlError("FDM-cell-study automatic grid-refresh terminal detail differs")
    if not require_ready and transition is None:
        return dict(receipt)
    if (not isinstance(transition, Mapping)
            or set(transition) != {"before_domain_cell_count", "before_domain_generation_id",
                "ready_domain_cell_count", "ready_domain_generation_id", "scene_revision",
                "prior_run_id", "preserved_prior_result_identities", "prepared_run_id",
                "preparation_id", "preparation_revision"}
            or transition.get("before_domain_cell_count") != 8
            or not isinstance(transition.get("before_domain_generation_id"), str)
            or not transition["before_domain_generation_id"]
            or transition.get("ready_domain_cell_count") != 16
            or not isinstance(transition.get("ready_domain_generation_id"), str)
            or not transition["ready_domain_generation_id"]
            or transition["ready_domain_generation_id"] == transition["before_domain_generation_id"]
            or transition.get("scene_revision") != cell_receipt["scene_revision"]
            or transition.get("prior_run_id") != previous_run
            or transition.get("preserved_prior_result_identities") != prior_results
            or not isinstance(transition.get("prepared_run_id"), str)
            or not transition["prepared_run_id"] or transition["prepared_run_id"] == previous_run
            or not isinstance(transition.get("preparation_id"), str) or not transition["preparation_id"]
            or type(transition.get("preparation_revision")) is not int
            or transition["preparation_revision"] < 0):
        raise BuildControlError("FDM-cell-study did not prove a held sixteen-cell domain with retained A history")
    return dict(receipt)


def _load_fdm_grid_resume_evidence(control, attempt, *, selected, current, identity, frontend_id,
                                   frontend_volume, public_url, browser_url, expected_sources,
                                   consumed_by=None):
    if not isinstance(attempt, str) or re.fullmatch(r"[0-9a-f]{32}", attempt) is None:
        raise BuildControlError("FDM grid resume requires one exact browser-QA attempt id")
    _validate_study_stage_rerun_hashes(expected_sources, "fdm-cell-study-resume")
    root = "browser-qa/attempts/" + attempt
    marker_path = root + "/resume-consumed.json"
    marker = control.read(marker_path, optional=True)
    if consumed_by is None:
        if marker is not None:
            raise BuildControlError("The accepted FDM grid attempt already has a resume claim")
    elif (not isinstance(marker, Mapping)
          or marker.get("schema") != "fullmag.p22-fdm-grid-resume-consumed.v1"
          or marker.get("parent_attempt") != attempt or marker.get("child_attempt") != consumed_by):
        raise BuildControlError("The FDM grid resume claim does not belong to this child attempt")
    limits = {"receipt": 512 * 1024, "terminal": 512 * 1024,
              "runner_output": MAX_RESULT_BYTES, "result": MAX_RESULT_BYTES}
    relative_names = {"receipt": "receipt.json", "terminal": "terminal.json",
                      "runner_output": "runner-output.json", "result": "result.json"}
    raw_records = {}
    documents = {}
    for key, relative in relative_names.items():
        raw = control.read_bytes(root + "/" + relative, maximum=limits[key])
        raw_records[key] = raw
        try:
            documents[key] = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise BuildControlError("The pinned FDM grid parent has a malformed durable record") from error
    if consumed_by is not None and marker.get("record_sha256") != {
            key: hashlib.sha256(raw).hexdigest() for key, raw in raw_records.items()}:
        raise BuildControlError("The FDM grid resume claim hashes differ from its parent records")
    receipt = documents["receipt"]
    terminal = documents["terminal"]
    wrapper = documents["runner_output"]
    result = documents["result"]
    if (not isinstance(receipt, Mapping)
            or receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "browser-qa" or receipt.get("state") != "failed-confirmed"
            or receipt.get("attempt") != attempt or receipt.get("exit_code") != 1
            or not isinstance(terminal, Mapping) or canonical(terminal) != canonical(receipt)):
        raise BuildControlError("The FDM grid parent is not one failed-confirmed terminal browser-QA attempt")
    inputs = receipt.get("inputs")
    current_source_commit = current.get("source_commit") or (current.get("inputs") or {}).get("source_commit")
    current_terminal_sha = current.get("runtime_terminal_sha256")
    if (not isinstance(inputs, Mapping)
            or inputs.get("scenario") != "study-stage-rerun"
            or inputs.get("study_stage_rerun") != "fdm-cell-study"
            or inputs.get("source_root") != str(selected.resolve(strict=True))
            or inputs.get("source_commit") != current_source_commit
            or inputs.get("worktree_id") != identity.get("worktree_id")
            or inputs.get("development_attempt") != current.get("attempt")
            or inputs.get("development_config_sha256") != current.get("config_sha256")
            or inputs.get("runtime_terminal_sha256") != current_terminal_sha
            or inputs.get("runtime_attempt") != current.get("runtime_attempt", current.get("attempt"))
            or inputs.get("runtime_phase") != current.get("runtime_phase", current.get("phase"))
            or inputs.get("development_terminal_state") != current.get("development_terminal_state", current.get("state"))
            or inputs.get("compose_project") != control.project
            or inputs.get("frontend_container") != frontend_id
            or inputs.get("frontend_volume") != frontend_volume
            or inputs.get("public_loopback_url") != public_url
            or inputs.get("browser_url") != browser_url):
        raise BuildControlError("The FDM grid parent belongs to another source, development runtime or browser endpoint")
    prior_sources = inputs.get("study_stage_rerun_source_sha256")
    _validate_study_stage_rerun_hashes(prior_sources, "fdm-cell-study")
    if any(prior_sources[key] != expected_sources[key] for key in expected_sources if key != "runner"):
        raise BuildControlError("The FDM grid parent source dependencies differ from the selected checkout")
    if (not isinstance(wrapper, Mapping)
            or wrapper.get("schema") != "fullmag.docker-dev-browser-qa-runner-output.v1"
            or wrapper.get("exit_code") != 1 or not isinstance(wrapper.get("stdout"), str)
            or len(wrapper["stdout"].encode("utf-8")) > MAX_RESULT_BYTES
            or not isinstance(result, Mapping) or result.get("schema") != STUDY_STAGE_RERUN_RESULT_SCHEMA
            or result.get("state") != "failed-confirmed" or result.get("outcome") != "unknown"
            or result.get("study_stage_rerun_native_outcome") != "unknown"
            or result.get("requires_current_run_readback") is not True):
        raise BuildControlError("The FDM grid parent has no pinned unknown browser-helper result")
    prior_report = _parse_study_stage_rerun_result(
        wrapper["stdout"].encode("utf-8"), public_url, browser_url, prior_sources, "fdm-cell-study",
    )
    ready_parent = prior_report.get("phase") in {"fdm-grid-ready", "ui-submit"}
    if (prior_report.get("outcome") != "unknown"
            or prior_report.get("phase") not in {"fdm-grid-observing", "fdm-grid-ready", "ui-submit"}
            or (prior_report.get("prepared_grid_run") is not None) != ready_parent
            or prior_report.get("command_receipt") is not None
            or prior_report.get("command_count") != 0
            or prior_report.get("command_attempt_count") != 0):
        raise BuildControlError("The FDM grid parent did not stop before its first Study Solve")
    expected_result = dict(prior_report)
    expected_result.update(
        state="failed-confirmed",
        error="Browser helper exited before a passing public terminal proof",
        study_stage_rerun_native_outcome="unknown",
        requires_current_run_readback=True,
    )
    if canonical(result) != canonical(expected_result):
        raise BuildControlError("The failed-confirmed parent result differs from its pinned browser output")
    grid_receipt = prior_report["grid_refresh_receipt"]
    evidence = {
        "schema": "fullmag.p22-fdm-grid-resume-evidence.v1",
        "prior_attempt": attempt,
        "record_sha256": {key: hashlib.sha256(raw).hexdigest() for key, raw in raw_records.items()},
        "prior_source_sha256": dict(prior_sources),
        "prior_session": dict(prior_report["session_before"]),
        "prior_before": dict(prior_report["before"]),
        "prior_material_initial_state": dict(prior_report["fdm_material_initial_state"]),
        "prior_cell_receipt": dict(prior_report["fdm_cell_receipt"]),
        "prior_grid_receipt": dict(grid_receipt),
        "grid_command_id": grid_receipt["terminal_detail"]["command_id"],
        "prior_report": {
            "mode": prior_report["mode"], "phase": prior_report["phase"],
            "outcome": prior_report["outcome"], "command_count": prior_report["command_count"],
            "command_attempt_count": prior_report["command_attempt_count"],
        },
    }
    if len(canonical(evidence)) > 128 * 1024:
        raise BuildControlError("FDM grid resume evidence exceeds its transport bound")
    return _validate_fdm_grid_resume_evidence_shape(evidence, expected_sources)


def _consume_fdm_grid_resume_evidence(control, evidence, *, child_attempt):
    if (not isinstance(evidence, Mapping)
            or evidence.get("schema") != "fullmag.p22-fdm-grid-resume-evidence.v1"
            or re.fullmatch(r"[0-9a-f]{32}", str(evidence.get("prior_attempt", ""))) is None
            or re.fullmatch(r"[0-9a-f]{32}", child_attempt or "") is None
            or not isinstance(evidence.get("record_sha256"), Mapping)):
        raise BuildControlError("FDM grid resume evidence or child attempt identity is malformed")
    parent = evidence["prior_attempt"]
    root = "browser-qa/attempts/" + parent
    marker_path = root + "/resume-consumed.json"
    if control.read_bytes(marker_path, optional=True) is not None:
        raise BuildControlError("The accepted FDM grid attempt already has a resume claim")
    names = {"receipt": "receipt.json", "terminal": "terminal.json",
             "runner_output": "runner-output.json", "result": "result.json"}
    pins = evidence["record_sha256"]
    if set(pins) != set(names):
        raise BuildControlError("FDM grid resume evidence omits a durable parent record pin")
    for key, name in names.items():
        raw = control.read_bytes(root + "/" + name,
            maximum=MAX_RESULT_BYTES if key in {"runner_output", "result"} else 512 * 1024)
        if hashlib.sha256(raw).hexdigest() != pins[key]:
            raise BuildControlError("The FDM grid parent changed before its resume claim")
    marker = {
        "schema": "fullmag.p22-fdm-grid-resume-consumed.v1",
        "parent_attempt": parent,
        "child_attempt": child_attempt,
        "record_sha256": dict(pins),
    }
    control.write(marker_path, marker)
    return marker


def _validate_fdm_grid_resume_evidence_shape(value, expected_sources=None):
    fields = {"schema", "prior_attempt", "record_sha256", "prior_source_sha256", "prior_session",
              "prior_before", "prior_material_initial_state", "prior_cell_receipt", "prior_grid_receipt",
              "grid_command_id", "prior_report"}
    if (not isinstance(value, Mapping) or set(value) != fields
            or value.get("schema") != "fullmag.p22-fdm-grid-resume-evidence.v1"
            or not isinstance(value.get("prior_attempt"), str)
            or re.fullmatch(r"[0-9a-f]{32}", value["prior_attempt"]) is None):
        raise BuildControlError("FDM grid resume evidence has an unexpected shape")
    pins = value.get("record_sha256")
    if (not isinstance(pins, Mapping) or set(pins) != {"receipt", "terminal", "runner_output", "result"}
            or any(not isinstance(digest, str) or not SHA256_RE.fullmatch(digest) for digest in pins.values())):
        raise BuildControlError("FDM grid resume durable-record hashes are malformed")
    prior_sources = value.get("prior_source_sha256")
    _validate_study_stage_rerun_hashes(prior_sources, "fdm-cell-study")
    if expected_sources is not None:
        _validate_study_stage_rerun_hashes(expected_sources, "fdm-cell-study-resume")
        if any(prior_sources[key] != expected_sources[key] for key in expected_sources if key != "runner"):
            raise BuildControlError("FDM grid resume dependencies differ from the selected checkout")
    session = value.get("prior_session")
    before = value.get("prior_before")
    report = value.get("prior_report")
    cell = value.get("prior_cell_receipt")
    grid = value.get("prior_grid_receipt")
    if (not isinstance(session, Mapping) or session.get("name") != "P22 three Relax stages"
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))
            or not isinstance(before, Mapping)
            or before.get("run_status") != "completed"
            or before.get("stage_ids") != ["relax-a"]
            or not isinstance(before.get("result_identities"), list)
            or len(before["result_identities"]) != 1
            or not isinstance(report, Mapping)
            or report.get("phase") not in {"fdm-grid-observing", "fdm-grid-ready", "ui-submit"}
            or report != {"mode": "fdm-cell-study", "phase": report.get("phase"), "outcome": "unknown",
                          "command_count": 0, "command_attempt_count": 0}
            or not isinstance(value.get("prior_material_initial_state"), Mapping)
            or value.get("prior_material_initial_state") != before.get("material_state")
            or not isinstance(cell, Mapping) or cell.get("acknowledged") is not True
            or cell.get("scene_revision") != cell.get("before_scene_revision", -1) + 1
            or not isinstance(cell.get("unmodified_scene_sha256_after"), str)
            or not SHA256_RE.fullmatch(cell["unmodified_scene_sha256_after"])
            or not isinstance(grid, Mapping) or grid.get("accepted") is not True
            or grid.get("command_id") != value.get("grid_command_id")
            or grid.get("terminal_detail", {}).get("status") != "completed"
            or ("domain_transition" in grid) != (report.get("phase") != "fdm-grid-observing")):
        raise BuildControlError("FDM grid resume evidence does not prove one acknowledged pre-Solve grid attempt")
    if report["phase"] != "fdm-grid-observing":
        profile = before.get("profile")
        transition = grid.get("domain_transition")
        if (not isinstance(profile, Mapping) or profile.get("domain_cell_count") != 8
                or not isinstance(transition, Mapping)
                or transition.get("before_domain_generation_id") != profile.get("domain_generation_id")):
            raise BuildControlError("FDM grid resume transition has a foreign original domain")
        _validate_study_fdm_grid_refresh_receipt(
            {"grid_refresh_receipt": grid}, session, cell, before["run_id"], before["result_identities"],
        )
    if (not isinstance(value.get("grid_command_id"), str) or not 1 <= len(value["grid_command_id"]) <= 128
            or any(ord(character) < 32 or ord(character) == 127 for character in value["grid_command_id"])):
        raise BuildControlError("FDM grid resume evidence has no pinned grid command id")
    if len(canonical(value)) > 128 * 1024:
        raise BuildControlError("FDM grid resume evidence exceeds its transport bound")
    return dict(value)


def _validate_study_fdm_prepared_grid_run(value, *, previous_run, previous_domain_generation, cell_receipt,
                                           previous_precondition, expected_script_sha256,
                                           expected_last_command_id=None):
    if (not isinstance(value, Mapping)
            or set(value) != {"run_id", "run_status", "solver_state", "execution_state", "stage_ids",
                "authored_stage_ids", "stage_statuses", "completed_stage_indexes", "scene_profile", "profile",
                "scene_revision", "precondition", "commands", "preparation"}):
        raise BuildControlError("FDM-cell-study held-run proof has an unexpected shape")
    run_id = value.get("run_id")
    profile = value.get("profile")
    if (not isinstance(run_id, str) or not run_id or run_id == previous_run
            or value.get("run_status") != "waiting_for_solve"
            or value.get("solver_state") != "awaiting_command"
            or value.get("execution_state") != "awaiting_command"
            or value.get("stage_ids") != []
            or value.get("authored_stage_ids") != ["relax-a", "relax-b", "relax-c"]
            or value.get("stage_statuses") != ["pending", "pending", "pending"]
            or value.get("completed_stage_indexes") != []
            or value.get("scene_profile") != _expected_study_stage_scene_profile()
            or not isinstance(profile, Mapping)
            or profile.get("domain_discretization") != "fdm"
            or profile.get("domain_cell_count") != 16
            or not isinstance(profile.get("domain_generation_id"), str)
            or not profile["domain_generation_id"]
            or profile["domain_generation_id"] == previous_domain_generation
            or profile.get("requested_backend") != "fdm"
            or profile.get("requested_device") != "cpu"
            or profile.get("requested_precision") != "double"
            or value.get("scene_revision") != cell_receipt.get("scene_revision")
            or profile.get("script_sha256") != expected_script_sha256
            or profile.get("script_path") != "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py"):
        raise BuildControlError("FDM-cell-study did not retain the pending 16-cell accepted frontier")
    precondition = value.get("precondition")
    commands = value.get("commands")
    preparation = value.get("preparation")
    if (not isinstance(precondition, Mapping)
            or precondition.get("current_run") != {"kind": "run", "run_id": run_id}
            or precondition.get("runtime_state") != "awaiting_command"
            or precondition.get("scene_revision") != cell_receipt.get("scene_revision")
            or precondition.get("domain_generation_id") != profile["domain_generation_id"]
            or type(precondition.get("mesh_revision")) is not int or precondition["mesh_revision"] < 0
            or type(precondition.get("command_revision")) is not int or precondition["command_revision"] < 0
            or any(type(precondition.get(key)) is not int or precondition[key] < 0 for key in (
                "region_topology_revision", "region_membership_revision",
                "region_coefficients_revision", "region_initial_state_revision"))
            or "stage_execution_revision" in precondition):
        raise BuildControlError("FDM-cell-study held-run precondition is stale or incomplete")
    region_revision_keys = ("region_topology_revision", "region_membership_revision",
                            "region_coefficients_revision", "region_initial_state_revision")
    if (not isinstance(previous_precondition, Mapping)
            or any(type(previous_precondition.get(key)) is not int
                   or precondition.get(key) != previous_precondition[key] + 1
                   for key in region_revision_keys)):
        raise BuildControlError("FDM-cell-study grid refresh did not advance exactly the cell-policy region revisions")
    terminal_command_states = {"completed", "failed", "cancelled", "rejected"}
    if (not isinstance(commands, Mapping)
            or set(commands) != {"resource_revision", "count", "pending_count", "running_count",
                                 "terminal_statuses", "last_command_id"}
            or type(commands.get("resource_revision")) is not int or commands["resource_revision"] < 0
            or type(commands.get("count")) is not int or commands["count"] < 0
            or commands.get("count") != precondition.get("command_revision")
            or type(commands.get("pending_count")) is not int or commands["pending_count"] != 0
            or type(commands.get("running_count")) is not int or commands["running_count"] != 0
            or not isinstance(commands.get("terminal_statuses"), list)
            or len(commands["terminal_statuses"]) != commands["count"]
            or commands["count"] > 128
            or not isinstance(commands.get("last_command_id"), str)
            or not commands["last_command_id"] or len(commands["last_command_id"]) > 128
            or (expected_last_command_id is not None
                and commands["last_command_id"] != expected_last_command_id)
            or any(state not in terminal_command_states for state in commands["terminal_statuses"])):
        raise BuildControlError("FDM-cell-study held run retained an active or stale command queue")
    prep_fields = {"preparation_id", "revision", "resource_revision", "status", "active_stage_id", "failure",
                   "receipt", "stages"}
    if (not isinstance(preparation, Mapping) or set(preparation) != prep_fields
            or preparation.get("status") != "ready" or preparation.get("active_stage_id") is not None
            or preparation.get("failure") is not None
            or type(preparation.get("revision")) is not int or preparation["revision"] < 0
            or preparation.get("resource_revision") != preparation.get("revision")
            or not isinstance(preparation.get("preparation_id"), str) or not preparation["preparation_id"]):
        raise BuildControlError("FDM-cell-study held frontier omitted its ready preparation revision")
    receipt = preparation.get("receipt")
    if (not isinstance(receipt, Mapping)
            or set(receipt) != {"schema_version", "preparation_id", "run_id", "plan_fingerprint", "payload_sha256"}
            or receipt.get("schema_version") != "preparation_receipt.v1"
            or receipt.get("preparation_id") != preparation["preparation_id"]
            or receipt.get("run_id") != run_id
            or not isinstance(receipt.get("plan_fingerprint"), str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", receipt["plan_fingerprint"])
            or not isinstance(receipt.get("payload_sha256"), str)
            or not SHA256_RE.fullmatch(receipt["payload_sha256"])):
        raise BuildControlError("FDM-cell-study preparation receipt is malformed or belongs to another run")
    expected_prep_stages = [
        ("runtime_startup", "completed"), ("script_materialization", "completed"),
        ("validation", "completed"), ("planning", "completed"),
        ("domain_preparation", "completed"), ("meshing", "completed"),
        ("mesh_postprocessing", "completed"), ("solver_initialization", "skipped"),
        ("ready", "completed"),
    ]
    prep_stages = preparation.get("stages")
    if (not isinstance(prep_stages, list) or len(prep_stages) != len(expected_prep_stages)
            or any(not isinstance(stage, Mapping) or set(stage) != {"stage_id", "status"}
                   for stage in prep_stages)
            or [(stage.get("stage_id"), stage.get("status")) for stage in prep_stages] != expected_prep_stages):
        raise BuildControlError("FDM-cell-study preparation did not reach the exact ready frontier")
    return dict(value)


def _validate_material_stage_a_unknown_payload(payload, public_url, browser_url, expected_sources):
    if (payload.get("state") != "outcome-unknown" or payload.get("outcome") != "unknown"
            or payload.get("public_url") != public_url or payload.get("probe_url") != browser_url
            or payload.get("playwright_version") != PLAYWRIGHT_VERSION
            or payload.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or payload.get("source_sha256_before") != expected_sources
            or payload.get("source_sha256_after") != expected_sources
            or not isinstance(payload.get("failure"), str) or not 1 <= len(payload["failure"]) <= 512
            or payload.get("phase") not in {"material-dispatched", "material-acknowledged", "ui-submit"}):
        raise BuildControlError("Material-stage-A unknown outcome omitted its pinned phase/source evidence")
    session = payload.get("session_before")
    if (not isinstance(session, Mapping) or session.get("name") != "P22 three Relax stages"
            or payload.get("session_after") != session
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))):
        raise BuildControlError("Material-stage-A unknown outcome changed its session scope")
    before = payload.get("before")
    precondition = before.get("precondition") if isinstance(before, Mapping) else None
    previous_run = before.get("run_id") if isinstance(before, Mapping) else None
    if (not isinstance(before, Mapping) or not isinstance(previous_run, str) or not previous_run
            or before.get("run_status") != "completed" or before.get("solver_state") != "awaiting_command"
            or before.get("execution_state") != "completed"
            or before.get("stage_ids") != ["relax-a", "relax-b", "relax-c"]
            or before.get("authored_stage_ids") != ["relax-a", "relax-b", "relax-c"]
            or before.get("stage_statuses") != ["completed", "completed", "completed"]
            or before.get("completed_stage_indexes") != [0, 1, 2]
            or before.get("scene_profile") != _expected_study_stage_scene_profile()
            or not isinstance(before.get("profile"), Mapping)
            or before["profile"].get("domain_discretization") != "fdm"
            or before["profile"].get("domain_cell_count") != 8
            or before["profile"].get("script_sha256") != expected_sources["fixture"]
            or before["profile"].get("script_path") != "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py"
            or not isinstance(precondition, Mapping)
            or precondition.get("current_run") != {"kind": "run", "run_id": previous_run}
            or type(precondition.get("scene_revision")) is not int or precondition["scene_revision"] < 0):
        raise BuildControlError("Material-stage-A unknown outcome omitted its completed ABC baseline")
    receipt = _validate_study_material_receipt(payload, session)
    if (receipt.get("acknowledged") is True
            and precondition.get("scene_revision") not in (receipt["before_scene_revision"], receipt["scene_revision"])):
        raise BuildControlError("Material-stage-A unknown outcome lost its scene revision boundary")
    if (payload.get("command_receipt") is not None
            or payload.get("after") is not None
            or payload.get("history_identity_preserved") is not None
            or payload.get("public_terminal_proven") is not False
            or payload.get("native_execution_proven") is not False
            or payload.get("field_data_proven") is not False
            or payload.get("ui_command_proven") is not False
            or type(payload.get("command_count")) is not int or payload["command_count"] != 0
            or type(payload.get("command_attempt_count")) is not int or payload["command_attempt_count"] != 0
            or payload.get("material_count") != 1 or payload.get("material_attempt_count") != 1
            or payload.get("ui_material_proven") is not True):
        raise BuildControlError("Material-stage-A unknown outcome overstates or repeats a UI action")
    before_results = before.get("result_identities")
    if not isinstance(before_results, list) or len(before_results) != 3:
        raise BuildControlError("Material-stage-A unknown outcome omitted immutable prior result identities")
    for result, stage_id in zip(before_results, ("relax-a", "relax-b", "relax-c"), strict=True):
        source = result.get("source") if isinstance(result, Mapping) else None
        if (not isinstance(source, Mapping) or source.get("run_id") != previous_run
                or result.get("authored_stage_id") != stage_id
                or any(not isinstance(source.get(key), str) or not source[key]
                       for key in ("task_id", "step_id", "case_id", "attempt_id"))
                or type(source.get("ownership_epoch")) is not int or source["ownership_epoch"] < 0
                or not isinstance(result.get("artifact_sha256"), str)
                or not SHA256_RE.fullmatch(result["artifact_sha256"])):
            raise BuildControlError("Material-stage-A unknown outcome has malformed old result identities")
    _validate_study_camera_patches(payload, session)
    request_counts = payload.get("request_counts")
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    if (not isinstance(request_counts, Mapping) or request_counts.get(STUDY_MATERIAL_TRANSACTION_KEY) != 1
            or request_counts.get("POST /v2/sessions/current/simulation/commands", 0) != 0
            or not 1 <= len(request_counts) <= 128):
        raise BuildControlError("Material-stage-A unknown outcome does not pin one transaction and zero computes")
    for key, count in request_counts.items():
        if (not isinstance(key, str) or " " not in key or len(key) > 2048
                or type(count) is not int or count < 1 or count > 512):
            raise BuildControlError("Material-stage-A request inventory is malformed")
        method, path = key.split(" ", 1)
        if method == "GET" and path.startswith("/v2/"):
            continue
        if key == STUDY_MATERIAL_TRANSACTION_KEY and count == 1:
            continue
        if key == STUDY_CAMERA_PATCH_KEY and count <= 4:
            continue
        if key == ack_key and count <= 16:
            continue
        raise BuildControlError("Material-stage-A unknown outcome attempted another API mutation")
    read_counts = payload.get("read_counts")
    required = {"status", "current_session", "scene", "commands", "current_run", "stage_execution",
                "solver_status", "stage_results", "command_details"}
    if (not isinstance(read_counts, Mapping) or set(read_counts) != required
            or any(type(value) is not int or value < 0 or value > 512 for value in read_counts.values())
            or payload.get("violations") != []):
        raise BuildControlError("Material-stage-A unknown outcome omitted bounded reads or clean guards")
    if (type(payload.get("total_requests")) is not int
            or payload["total_requests"] != sum(request_counts.values()) or payload["total_requests"] > 512
            or payload.get("request_limit") != 512 or payload.get("request_path_limit") != 128
            or payload.get("per_path_read_limit") != 128):
        raise BuildControlError("Material-stage-A unknown outcome exceeded its request budget")
    for key in ("errors", "proxy_failures"):
        values = payload.get(key)
        if (not isinstance(values, list) or len(values) > 16
                or any(not isinstance(value, str) or len(value) > 512 for value in values)):
            raise BuildControlError("Material-stage-A unknown outcome diagnostics are malformed")
    return dict(payload)


def _validate_study_stage_rerun_unknown_payload(payload, public_url, browser_url, expected_sources, expected_mode):
    if (payload.get("state") != "outcome-unknown" or payload.get("outcome") != "unknown"
            or not isinstance(payload.get("failure"), str) or not 1 <= len(payload["failure"]) <= 512
            or payload.get("public_url") != public_url or payload.get("probe_url") != browser_url
            or payload.get("playwright_version") != PLAYWRIGHT_VERSION
            or payload.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or payload.get("source_sha256_before") != expected_sources
            or payload.get("source_sha256_after") != expected_sources):
        raise BuildControlError("Study stage rerun unknown outcome omitted its fixed source/runtime pins")
    session = payload.get("session_before")
    if (not isinstance(session, Mapping) or session.get("name") != "P22 three Relax stages"
            or payload.get("session_after") != session
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))):
        raise BuildControlError("Study stage rerun unknown outcome did not retain its exact session scope")
    before = payload.get("before")
    if not isinstance(before, Mapping):
        raise BuildControlError("Study stage rerun unknown outcome omitted its fresh pre-command snapshot")
    previous_run = before.get("run_id")
    expected_before = _study_stage_expected_ids(expected_mode, "before")
    baseline_precondition = before.get("precondition")
    prepared_grid_run = payload.get("prepared_grid_run") if expected_mode == "fdm-cell-study" else None
    precondition = (prepared_grid_run.get("precondition") if isinstance(prepared_grid_run, Mapping)
                    else baseline_precondition)
    expected_profile = {
        "domain_discretization": "fdm",
        "domain_cell_count": 16 if expected_mode in {"texture-stage-b", "texture-study"} else 8,
        "domain_generation_id": baseline_precondition.get("domain_generation_id")
            if isinstance(baseline_precondition, Mapping) else None,
        "requested_backend": "fdm",
        "requested_device": "cpu",
        "requested_precision": "double",
        "script_sha256": expected_sources["fixture"],
        "script_path": "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py",
    }
    if (not isinstance(previous_run, str) or not previous_run
            or before.get("run_status") != "completed"
            or before.get("solver_state") != "awaiting_command"
            or before.get("execution_state") != "completed"
            or before.get("stage_ids") != expected_before
            or before.get("scene_profile") != _expected_study_stage_scene_profile()
            or not isinstance(before.get("profile"), Mapping)
            or any(before["profile"].get(key) != value for key, value in expected_profile.items())):
        raise BuildControlError("Study stage rerun unknown outcome omitted its qualified baseline")
    if expected_mode == "fdm-cell-study":
        before_material = _validate_study_fdm_material_state(before.get("material_state"))
        if _validate_study_fdm_material_state(payload.get("fdm_material_initial_state")) != before_material:
            raise BuildControlError("FDM-cell-study changed the film material or m0 before Compute Study")
    expected_precondition_run = (prepared_grid_run.get("run_id")
                                 if isinstance(prepared_grid_run, Mapping) else previous_run)
    if (not isinstance(precondition, Mapping)
            or expected_mode == "fdm-cell-study" and not isinstance(prepared_grid_run, Mapping)
            or precondition.get("current_run") != {"kind": "run", "run_id": expected_precondition_run}
            or precondition.get("runtime_state") != "awaiting_command"
            or not isinstance(precondition.get("domain_generation_id"), str)
            or not precondition["domain_generation_id"]
            or any(type(precondition.get(key)) is not int or precondition[key] < 0 for key in (
                "scene_revision", "mesh_revision", "command_revision",
                "region_topology_revision", "region_membership_revision",
                "region_coefficients_revision", "region_initial_state_revision",
            ))):
        raise BuildControlError("Study stage rerun unknown outcome omitted its exact command precondition")
    if expected_mode == "material-stage-a":
        receipt = _validate_study_material_receipt(
            payload, session, precondition.get("scene_revision"),
        )
        if (payload.get("material_count") != 1 or payload.get("material_attempt_count") != 1
                or payload.get("ui_material_proven") is not True or receipt.get("acknowledged") is not True):
            raise BuildControlError("Material-stage-A unknown compute outcome lacks its acknowledged edit")
    elif (type(payload.get("material_count", 0)) is not int or payload.get("material_count", 0) != 0
          or type(payload.get("material_attempt_count", 0)) is not int
          or payload.get("material_attempt_count", 0) != 0
          or payload.get("material_receipt") is not None or payload.get("ui_material_proven", False) is not False):
        raise BuildControlError("Study stage unknown outcome reported an unrequested material edit")
    if "stage_execution_revision" in precondition:
        raise BuildControlError("Unknown Study compute command includes a stage-control revision")
    before_results = before.get("result_identities")
    if not isinstance(before_results, list) or len(before_results) != len(expected_before):
        raise BuildControlError("Study stage rerun unknown outcome omitted its old result identities")
    for result, stage_id in zip(before_results, expected_before, strict=True):
        source = result.get("source") if isinstance(result, Mapping) else None
        if (not isinstance(source, Mapping) or source.get("run_id") != previous_run
                or result.get("authored_stage_id") != stage_id
                or any(not isinstance(source.get(key), str) or not source[key]
                       for key in ("task_id", "step_id", "case_id", "attempt_id"))
                or type(source.get("ownership_epoch")) is not int or source["ownership_epoch"] < 0
                or not isinstance(result.get("artifact_sha256"), str)
                or not SHA256_RE.fullmatch(result["artifact_sha256"])):
            raise BuildControlError("Study stage rerun unknown outcome has malformed old result identities")
    if expected_mode == "fdm-cell-study":
        cell_receipt = _validate_study_fdm_cell_receipt(
            payload, session, precondition.get("scene_revision") - 1,
        )
        if (type(payload.get("fdm_cell_count")) is not int or payload.get("fdm_cell_count") != 1
                or type(payload.get("fdm_cell_attempt_count")) is not int
                or payload.get("fdm_cell_attempt_count") != 1
                or payload.get("ui_fdm_cell_proven") is not True
                or cell_receipt.get("acknowledged") is not True):
            raise BuildControlError("FDM-cell-study unknown compute outcome lacks its acknowledged cell edit")
        grid_receipt = _validate_study_fdm_grid_refresh_receipt(
            payload, session, cell_receipt, previous_run, before.get("result_identities"), require_ready=True,
        )
        prepared_grid_run = _validate_study_fdm_prepared_grid_run(
            prepared_grid_run, previous_run=previous_run,
            previous_domain_generation=before["profile"].get("domain_generation_id"),
            cell_receipt=cell_receipt, previous_precondition=baseline_precondition,
            expected_script_sha256=expected_sources["fixture"],
            expected_last_command_id=grid_receipt["command_id"],
        )
        transition = grid_receipt.get("domain_transition")
        if (type(payload.get("grid_refresh_count")) is not int or payload.get("grid_refresh_count") != 1
                or type(payload.get("grid_refresh_attempt_count")) is not int
                or payload.get("grid_refresh_attempt_count") != 1
                or payload.get("ui_grid_refresh_proven") is not True
                or transition.get("ready_domain_generation_id") != prepared_grid_run["profile"].get("domain_generation_id")
                or transition.get("prepared_run_id") != prepared_grid_run.get("run_id")
                or transition.get("preparation_id") != prepared_grid_run["preparation"].get("preparation_id")
                or transition.get("preparation_revision") != prepared_grid_run["preparation"].get("revision")):
            raise BuildControlError("FDM-cell-study unknown compute outcome omitted its ready sixteen-cell domain")
    receipt = payload.get("command_receipt")
    command = receipt.get("payload") if isinstance(receipt, Mapping) else None
    expected_scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
        session["session_epoch"], safe=""
    ) + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
    stage_target = {"kind": "stage_id", "stage_id": "relax-b" if expected_mode == "stage-b" else "relax-a"}
    expected_command = (
        {"kind": "relax", "target": stage_target}
        if expected_mode in {"stage-b", "material-stage-a"}
        else {"kind": "solve", "target": {"kind": "study"}}
    )
    if (not isinstance(receipt, Mapping)
            or receipt.get("method") != "POST"
            or receipt.get("path") != "/v2/sessions/current/simulation/commands"
            or receipt.get("scope_header") != expected_scope
            or receipt.get("status") is not None and (
                type(receipt.get("status")) is not int or not 100 <= receipt["status"] <= 599
            )
            or not isinstance(command, Mapping)
            or any(command.get(key) != value for key, value in expected_command.items())
            or command.get("precondition") != precondition
            or not isinstance(command.get("client_intent_id"), str)
            or not command["client_intent_id"].startswith(
                "study:" + ("relax" if expected_mode in {"stage-b", "material-stage-a"} else "solve") + ":"
            )
            or len(command["client_intent_id"]) > 128
            or command.get("reason") != "user_requested"
            or type(command.get("requested_at_unix_ms")) is not int
            or command["requested_at_unix_ms"] <= 0):
        raise BuildControlError("Study stage rerun unknown outcome lacks its exact guarded UI command")
    if expected_mode in {"stage-b", "material-stage-a"}:
        if command.get("initial_state") != {"kind": "default_for_target"}:
            raise BuildControlError("Unknown Stage B command changed its initial state")
    elif "initial_state" in command:
        raise BuildControlError("Unknown whole-Study command has a stage-only initial state")
    binding = receipt.get("execution_binding")
    if binding is not None:
        expected_target = expected_command["target"]
        if (not isinstance(binding, Mapping) or binding.get("requested_target") != expected_target
                or not isinstance(binding.get("run_id"), str) or not binding["run_id"]
                or (expected_mode in {"stage-b", "material-stage-a"}
                    and binding.get("step_id") != stage_target["stage_id"])
                or (expected_mode in {"study", "fdm-cell-study"} and binding.get("step_id") is not None)
                or (expected_mode == "fdm-cell-study" and binding.get("run_id") != prepared_grid_run.get("run_id"))):
            raise BuildControlError("Unknown Study command retained a conflicting execution binding")
    if (payload.get("after") is not None or payload.get("history_identity_preserved") is not None
            or payload.get("public_terminal_proven") is not False
            or payload.get("native_execution_proven") is not False
            or payload.get("field_data_proven") is not False
            or payload.get("ui_command_proven") is not True
            or type(payload.get("command_count")) is not int or payload["command_count"] != 1
            or type(payload.get("command_attempt_count")) is not int or payload["command_attempt_count"] != 1):
        raise BuildControlError("Study stage rerun unknown outcome overstates the completed command evidence")
    read_counts = payload.get("read_counts")
    required_counts = {"status": 3, "current_session": 3, "scene": 3, "commands": 3, "current_run": 3,
                       "stage_execution": 3, "solver_status": 3, "stage_results": 3, "command_details": 0}
    if expected_mode == "fdm-cell-study":
        required_counts["preparation"] = 1
    if (not isinstance(read_counts, Mapping) or set(read_counts) != set(required_counts)
            or any(type(read_counts.get(key)) is not int or read_counts[key] < minimum
                   or read_counts[key] > 512 for key, minimum in required_counts.items())):
        raise BuildControlError("Study stage rerun unknown outcome omitted bounded public reads")
    _validate_study_camera_patches(payload, session)
    request_counts = payload.get("request_counts")
    command_key = "POST /v2/sessions/current/simulation/commands"
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    expected_command_posts = 2 if expected_mode == "fdm-cell-study" else 1
    if (not isinstance(request_counts, Mapping) or not 1 <= len(request_counts) <= 128
            or request_counts.get(command_key) != expected_command_posts):
        raise BuildControlError("Study stage rerun unknown outcome does not prove one exact command POST")
    if expected_mode == "material-stage-a" and request_counts.get(STUDY_MATERIAL_TRANSACTION_KEY) != 1:
        raise BuildControlError("Material-stage-A unknown compute outcome omitted one authoring transaction")
    for key, count in request_counts.items():
        if (not isinstance(key, str) or " " not in key or len(key) > 2048
                or type(count) is not int or count < 1 or count > 512):
            raise BuildControlError("Study stage rerun unknown outcome request inventory is malformed")
        method, path = key.split(" ", 1)
        if method == "GET" and path.startswith("/v2/"):
            continue
        if expected_mode == "material-stage-a" and key == STUDY_MATERIAL_TRANSACTION_KEY and count == 1:
            continue
        if expected_mode == "fdm-cell-study" and key == STUDY_FDM_CELL_TRANSACTION_KEY and count == 1:
            continue
        if key == STUDY_CAMERA_PATCH_KEY and count <= 4:
            continue
        if key == ack_key and count <= 16:
            continue
        if key == command_key and count == expected_command_posts:
            continue
        raise BuildControlError("Study stage rerun unknown outcome attempted an unexpected API mutation")
    if (type(payload.get("total_requests")) is not int
            or sum(request_counts.values()) != payload.get("total_requests") or payload["total_requests"] > 512
            or payload.get("request_limit") != 512 or payload.get("request_path_limit") != 128
            or payload.get("per_path_read_limit") != 128
            or payload.get("violations") != []):
        raise BuildControlError("Study stage rerun unknown outcome exceeded its guard or request budget")
    if expected_mode == "fdm-cell-study":
        _validate_study_fdm_request_inventory(payload, 1, 1)
    for key in ("errors", "proxy_failures"):
        values = payload.get(key)
        if (not isinstance(values, list) or len(values) > 16
                or any(not isinstance(value, str) or len(value) > 512 for value in values)):
            raise BuildControlError("Study stage rerun unknown outcome diagnostic list is malformed")
    return dict(payload)


def _study_stage_no_dispatch_proven(output: bytes, expected_sources, expected_mode) -> bool:
    try:
        _validate_study_stage_rerun_hashes(expected_sources, expected_mode)
    except BuildControlError:
        return False
    if not isinstance(output, bytes) or len(output) > MAX_RESULT_BYTES:
        return False
    candidate = None
    for line in reversed(output.decode("utf-8", "replace").splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, Mapping):
            candidate = value
            break
    required_fields = {
        "schema", "scenario", "mode", "state", "outcome", "failure",
        "public_url", "probe_url", "playwright_version", "browser_gpu_mode",
        "source_sha256_before", "source_sha256_after", "session_before", "session_after", "before",
        "command_receipt", "command_count", "command_attempt_count", "client_ack_count", "ui_command_proven",
        "after", "history_identity_preserved", "public_terminal_proven", "native_execution_proven",
        "field_data_proven", "read_counts", "request_counts", "total_requests", "request_limit",
        "request_path_limit", "per_path_read_limit", "violations", "errors", "proxy_failures",
    }
    if (not isinstance(candidate, Mapping)
            or not required_fields.issubset(candidate)
            or candidate.get("schema") != STUDY_STAGE_RERUN_RESULT_SCHEMA
            or candidate.get("scenario") != "study-stage-rerun"
            or candidate.get("mode") != expected_mode
            or candidate.get("state") != "failed"
            or candidate.get("outcome") != "not-dispatched"
            or candidate.get("source_sha256_before") != expected_sources
            or candidate.get("source_sha256_after") != expected_sources
            or candidate.get("playwright_version") != PLAYWRIGHT_VERSION
            or candidate.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or not isinstance(candidate.get("public_url"), str)
            or not isinstance(candidate.get("probe_url"), str)
            or not isinstance(candidate.get("failure"), str)
            or not 1 <= len(candidate["failure"]) <= 512
            or candidate.get("session_after") != candidate.get("session_before")
            or candidate.get("after") is not None
            or candidate.get("history_identity_preserved") is not None
            or candidate.get("public_terminal_proven") is not False
            or candidate.get("native_execution_proven") is not False
            or candidate.get("field_data_proven") is not False
            or type(candidate.get("command_count")) is not int or candidate["command_count"] != 0
            or type(candidate.get("command_attempt_count")) is not int
            or candidate["command_attempt_count"] < 0
            or candidate.get("command_receipt", object()) is not None
            or candidate.get("ui_command_proven") is not False):
        return False
    if expected_mode != "fdm-cell-study" and (
        candidate.get("fdm_cell_count", 0) != 0 or candidate.get("fdm_cell_attempt_count", 0) != 0
        or candidate.get("fdm_cell_receipt") is not None or candidate.get("ui_fdm_cell_proven", False) is not False
        or candidate.get("grid_refresh_count", 0) != 0 or candidate.get("grid_refresh_attempt_count", 0) != 0
        or candidate.get("grid_refresh_receipt") is not None or candidate.get("ui_grid_refresh_proven", False) is not False
        or candidate.get("fdm_material_initial_state") is not None
    ):
        return False
    if expected_mode == "material-stage-a" and (
        candidate.get("material_count") != 0 or candidate.get("material_attempt_count") != 0
        or candidate.get("material_receipt") is not None or candidate.get("ui_material_proven") is not False
    ):
        return False
    if expected_mode in {"texture-stage-b", "texture-study"} and (
        type(candidate.get("texture_transaction_count")) is not int or candidate["texture_transaction_count"] != 0
        or type(candidate.get("texture_transaction_attempt_count")) is not int
        or candidate["texture_transaction_attempt_count"] != 0
        or candidate.get("texture_receipt") is not None or candidate.get("ui_texture_proven") is not False
        or candidate.get("command_count") != 0 or candidate.get("command_attempt_count") != 0
        or candidate.get("command_receipt") is not None
    ):
        return False
    try:
        _validate_study_camera_patches(candidate, candidate.get("session_before"))
    except (BuildControlError, KeyError, TypeError, ValueError):
        return False
    request_counts = candidate.get("request_counts")
    total_requests = candidate.get("total_requests")
    if not isinstance(request_counts, Mapping) or len(request_counts) > 128:
        return False
    if expected_mode == "fdm-cell-study" and (
        type(candidate.get("fdm_cell_count")) is not int or candidate.get("fdm_cell_count") != 0
        or type(candidate.get("fdm_cell_attempt_count")) is not int
        or candidate.get("fdm_cell_attempt_count") != 0
        or candidate.get("fdm_cell_receipt") is not None or candidate.get("ui_fdm_cell_proven") is not False
        or type(candidate.get("grid_refresh_count")) is not int or candidate.get("grid_refresh_count") != 0
        or type(candidate.get("grid_refresh_attempt_count")) is not int
        or candidate.get("grid_refresh_attempt_count") != 0
        or candidate.get("grid_refresh_receipt") is not None or candidate.get("ui_grid_refresh_proven") is not False
        or STUDY_FDM_CELL_TRANSACTION_KEY in request_counts
        or candidate.get("material_count") != 0 or candidate.get("material_attempt_count") != 0
        or candidate.get("material_receipt") is not None or candidate.get("ui_material_proven") is not False
    ):
        return False
    for key, count in request_counts.items():
        if (not isinstance(key, str) or len(key) > 2048 or " " not in key
                or type(count) is not int or count < 1 or count > 512):
            return False
    command_key = "POST /v2/sessions/current/simulation/commands"
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    for key, count in request_counts.items():
        method, path = key.split(" ", 1)
        if method == "GET" and path.startswith("/v2/"):
            continue
        if key == STUDY_CAMERA_PATCH_KEY and count <= 4:
            continue
        if key == ack_key and count <= 16:
            continue
        if expected_mode in {"texture-stage-b", "texture-study"} and key == STUDY_TEXTURE_TRANSACTION_KEY:
            return False
        if key == command_key and count == candidate["command_attempt_count"]:
            continue
        return False
    read_counts = candidate.get("read_counts")
    required_reads = {
        "status", "current_session", "scene", "commands", "current_run",
        "stage_execution", "solver_status", "stage_results", "command_details",
    }
    if (not isinstance(read_counts, Mapping) or set(read_counts) != required_reads
            or any(type(value) is not int or value < 0 or value > 512 for value in read_counts.values())):
        return False
    for key in ("violations", "errors", "proxy_failures"):
        values = candidate.get(key)
        if (not isinstance(values, list) or len(values) > 16
                or any(not isinstance(value, str) or len(value) > 512 for value in values)):
            return False
    return (
        type(total_requests) is int and 0 <= total_requests <= 512
        and total_requests == sum(request_counts.values())
        and type(candidate.get("client_ack_count")) is int and 0 <= candidate["client_ack_count"] <= 16
        and candidate.get("client_ack_count") == request_counts.get(ack_key, 0)
        and candidate.get("request_limit") == 512
        and candidate.get("request_path_limit") == 128
        and candidate.get("per_path_read_limit") == 128
        and request_counts.get(command_key, 0) == candidate["command_attempt_count"]
    )


def _validate_study_texture_profile(payload, expected_mode, before, after, session, precondition):
    if expected_mode not in {"texture-stage-b", "texture-study"}:
        raise BuildControlError("Study texture validator received another profile")
    baseline = payload.get("texture_baseline_state")
    if (not isinstance(baseline, Mapping) or set(baseline) != {"material", "default_cell", "global_m0"}
            or baseline.get("default_cell") != [1e-9, 2e-9, 2e-9]):
        raise BuildControlError("Texture profile omitted its accepted sixteen-cell scene baseline")
    material = baseline.get("material")
    global_m0 = baseline.get("global_m0")
    if (not isinstance(material, Mapping) or set(material) != {
                "object_id", "material_id", "material_name", "properties", "magnetization_ref", "magnetization_asset_sha256"}
            or material.get("object_id") != "film" or material.get("material_name") != "film material"
            or material.get("properties") != {"Ms": 600000, "Aex": 1e-11, "alpha": 0.5, "Dind": None, "Dbulk": None}
            or not isinstance(material.get("material_id"), str) or not material["material_id"]
            or not isinstance(material.get("magnetization_ref"), str) or not material["magnetization_ref"]
            or not isinstance(material.get("magnetization_asset_sha256"), str)
            or not SHA256_RE.fullmatch(material["magnetization_asset_sha256"])
            or global_m0 != {"object_id": "film", "magnetization_ref": material.get("magnetization_ref"),
                             "asset_sha256": material.get("magnetization_asset_sha256"),
                             "preset_kind": "uniform", "direction": [1, 0, 0]}):
        raise BuildControlError("Texture profile material, local grid or global m0 baseline differs")
    reset = {"stage_id": "relax-b", "object_id": "film", "scope": "object", "initializer": None}
    for label, snapshot in (("before", before), ("after", after)):
        if (snapshot.get("texture_state") != reset
                or snapshot.get("texture_baseline_state") != baseline
                or snapshot.get("scene_profile") != _expected_study_stage_scene_profile(
                    pipeline_version="study_pipeline.v2", texture_object_id="film")
                or snapshot.get("profile", {}).get("domain_cell_count") != 16):
            raise BuildControlError(f"Texture profile {label} did not retain the exact B-local reset and sixteen-cell state")

    proof = payload.get("texture_source_proof")
    stage_id = "relax-a" if expected_mode == "texture-stage-b" else "relax-b"
    matching = [item for item in before.get("result_identities", [])
                if isinstance(item, Mapping) and item.get("authored_stage_id") == stage_id]
    if (not isinstance(proof, Mapping) or set(proof) != {
                "authored_stage_id", "object_id", "run_id", "artifact_id", "artifact_sha256", "codec_id",
                "codec_version", "authored_relation", "domain_relation", "supports_magnetization_input"}
            or len(matching) != 1 or proof.get("authored_stage_id") != stage_id
            or proof.get("object_id") != "film" or proof.get("run_id") != before.get("run_id")
            or proof.get("artifact_id") != matching[0].get("artifact_id")
            or proof.get("artifact_sha256") != matching[0].get("artifact_sha256")
            or proof.get("codec_id") != matching[0].get("codec_id")
            or proof.get("codec_version") != matching[0].get("codec_version")
            or not isinstance(proof.get("artifact_sha256"), str)
            or not SHA256_RE.fullmatch(proof["artifact_sha256"])
            or proof.get("authored_relation") != ("authored_input_changed"
                if expected_mode == "texture-stage-b" else "matching_authored_input")
            or proof.get("domain_relation") != "matching_published_layout"
            or proof.get("supports_magnetization_input") is not True):
        raise BuildControlError("Texture profile source is not the exact current same-domain catalog result")
    if payload.get("before", {}).get("texture_source_proof") != proof:
        raise BuildControlError("Texture profile source proof is absent from the bounded baseline snapshot")

    transaction_key = STUDY_TEXTURE_TRANSACTION_KEY
    receipt = payload.get("texture_receipt")
    count, attempts = payload.get("texture_transaction_count"), payload.get("texture_transaction_attempt_count")
    if expected_mode == "texture-study":
        if (count != 0 or attempts != 0 or receipt is not None or payload.get("ui_texture_proven") is not False):
            raise BuildControlError("Texture-study must not author or submit another texture transaction")
        return
    if (type(count) is not int or count != 1 or type(attempts) is not int or attempts != 1
            or payload.get("ui_texture_proven") is not True or not isinstance(receipt, Mapping)
            or set(receipt) != {"method", "path", "scope_header", "status", "payload", "scene_before",
                                "acknowledgement", "helper_ack", "ui_saved_ack_proven", "ui_saved_ack_text"}):
        raise BuildControlError("Texture-stage-B must retain one UI transaction receipt")
    expected_scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
        session["session_epoch"], safe="") + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
    scene_before = receipt.get("scene_before")
    prior_revision = precondition.get("scene_revision") - 1
    if (receipt.get("method") != "POST" or receipt.get("path") != "/v2/sessions/current/model/transactions"
            or receipt.get("scope_header") != expected_scope or type(receipt.get("status")) is not int
            or not 200 <= receipt["status"] < 300 or not isinstance(scene_before, Mapping)
            or scene_before.get("revision") != prior_revision
            or scene_before.get("study", {}).get("study_pipeline", {}).get("version") != "study_pipeline.v1"
            or receipt.get("ui_saved_ack_proven") is not True
            or receipt.get("ui_saved_ack_text") != "Saved stage relax-b."):
        raise BuildControlError("Texture-stage-B transaction scope, revision or Inspector ACK is malformed")
    expected_pipeline = deepcopy(scene_before["study"]["study_pipeline"])
    nodes = expected_pipeline.get("nodes")
    if not isinstance(nodes, list):
        raise BuildControlError("Texture-stage-B transaction baseline pipeline is malformed")
    targets = [node for node in nodes if isinstance(node, Mapping) and node.get("id") == "relax-b"]
    if len(targets) != 1 or not isinstance(targets[0].get("payload"), Mapping):
        raise BuildControlError("Texture-stage-B transaction is not bound to exactly one authored B")
    expected_pipeline["version"] = "study_pipeline.v2"
    expected_pipeline["nodes"] = [
        ({**node, "payload": {**node["payload"], "stage_magnetization_assignments": {
            "schema_version": "fullmag.magnetization-assignments.v1",
            "assignments": [{"object_id": "film", "region_id": None, "initializer": None}],
        }}} if node.get("id") == "relax-b" else node)
        for node in nodes
    ]
    expected_request = {"kind": "merge_patch", "base_revision": prior_revision,
                        "merge_patch": {"study": {"study_pipeline": expected_pipeline}}}
    if canonical(receipt.get("payload")) != canonical(expected_request):
        raise BuildControlError("Texture-stage-B transaction edits more than the exact B-local reset")
    acknowledgement = receipt.get("acknowledgement")
    committed = deepcopy(scene_before)
    committed["revision"] = precondition["scene_revision"]
    committed["study"]["study_pipeline"] = expected_pipeline
    expected_ack = {"transaction_kind": "merge_patch", "scene_revision": precondition["scene_revision"],
                    "committed_scene": committed}
    if (canonical(acknowledgement) != canonical(expected_ack)
            or receipt.get("helper_ack") != {"sceneRevision": precondition["scene_revision"],
                                             "stageId": "relax-b", "objectId": "film"}):
        raise BuildControlError("Texture-stage-B ACK differs from the exact revision-fenced committed scene")
    if before.get("precondition", {}).get("scene_revision") != precondition.get("scene_revision"):
        raise BuildControlError("Texture-stage-B command did not use the post-ACK scene revision")


def _validate_study_texture_unknown_payload(payload, public_url, browser_url, expected_sources, expected_mode):
    if (payload.get("state") != "outcome-unknown" or payload.get("outcome") != "unknown"
            or not isinstance(payload.get("failure"), str) or not 1 <= len(payload["failure"]) <= 512
            or payload.get("public_url") != public_url or payload.get("probe_url") != browser_url
            or payload.get("playwright_version") != PLAYWRIGHT_VERSION
            or payload.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or payload.get("source_sha256_before") != expected_sources
            or payload.get("source_sha256_after") != expected_sources):
        raise BuildControlError("Texture unknown outcome omitted its source, browser or runtime pins")
    session = payload.get("session_before")
    if (not isinstance(session, Mapping) or payload.get("session_after") != session
            or session.get("name") != "P22 three Relax stages"
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))):
        raise BuildControlError("Texture unknown outcome changed its session or request scope")
    before = payload.get("before")
    if not isinstance(before, Mapping):
        raise BuildControlError("Texture unknown outcome omitted its retained baseline")
    expected_before = _study_stage_expected_ids(expected_mode, "before")
    run_id = before.get("run_id")
    precondition = before.get("precondition")
    expected_cells = 16
    if (not isinstance(run_id, str) or not run_id or before.get("run_status") != "completed"
            or before.get("solver_state") != "awaiting_command" or before.get("execution_state") != "completed"
            or before.get("stage_ids") != expected_before
            or before.get("authored_stage_ids") != ["relax-a", "relax-b", "relax-c"]
            or before.get("stage_statuses") != ["completed" if key in expected_before else "pending"
                                                for key in ("relax-a", "relax-b", "relax-c")]
            or before.get("completed_stage_indexes") != [index for index, key in enumerate(
                ("relax-a", "relax-b", "relax-c")) if key in expected_before]
            or before.get("profile", {}).get("domain_cell_count") != expected_cells
            or before.get("profile", {}).get("script_sha256") != expected_sources["fixture"]
            or before.get("profile", {}).get("script_path") != "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py"
            or not isinstance(precondition, Mapping)
            or precondition.get("current_run") != {"kind": "run", "run_id": run_id}
            or precondition.get("runtime_state") != "awaiting_command"
            or type(precondition.get("scene_revision")) is not int
            or type(precondition.get("mesh_revision")) is not int
            or not isinstance(precondition.get("domain_generation_id"), str)
            or not precondition["domain_generation_id"]):
        raise BuildControlError("Texture unknown outcome did not retain the exact sixteen-cell prior run")
    baseline = payload.get("texture_baseline_state")
    if (not isinstance(baseline, Mapping) or before.get("texture_baseline_state") != baseline
            or baseline.get("default_cell") != [1e-9, 2e-9, 2e-9]
            or baseline.get("material", {}).get("object_id") != "film"
            or baseline.get("material", {}).get("material_name") != "film material"
            or baseline.get("material", {}).get("properties") != {
                "Ms": 600000, "Aex": 1e-11, "alpha": 0.5, "Dind": None, "Dbulk": None}
            or baseline.get("global_m0", {}).get("direction") != [1, 0, 0]
            or baseline.get("global_m0", {}).get("preset_kind") != "uniform"):
        raise BuildControlError("Texture unknown outcome changed or omitted the accepted scene baseline")
    expected_reset = {"stage_id": "relax-b", "object_id": "film", "scope": "object", "initializer": None}
    if (expected_mode == "texture-study" or payload.get("command_count") == 1):
        if (before.get("texture_state") != expected_reset
                or before.get("scene_profile") != _expected_study_stage_scene_profile(
                    pipeline_version="study_pipeline.v2", texture_object_id="film")):
            raise BuildControlError("Texture unknown command did not retain the acknowledged B-local recipe")
    proof = payload.get("texture_source_proof")
    stage_id = "relax-a" if expected_mode == "texture-stage-b" else "relax-b"
    old_results = before.get("result_identities")
    identities = [item for item in old_results if isinstance(item, Mapping)
                  and item.get("authored_stage_id") == stage_id] if isinstance(old_results, list) else []
    if (not isinstance(proof, Mapping) or len(identities) != 1
            or proof.get("authored_stage_id") != stage_id or proof.get("run_id") != run_id
            or proof.get("artifact_id") != identities[0].get("artifact_id")
            or proof.get("artifact_sha256") != identities[0].get("artifact_sha256")
            or proof.get("authored_relation") != ("authored_input_changed"
                if expected_mode == "texture-stage-b" and before.get("scene_profile", {}).get("pipeline_version") == "study_pipeline.v2"
                else "matching_authored_input")
            or proof.get("domain_relation") != "matching_published_layout"
            or proof.get("supports_magnetization_input") is not True
            or before.get("texture_source_proof") != proof):
        raise BuildControlError("Texture unknown outcome does not retain the exact same-domain source identity")

    tx_count = payload.get("texture_transaction_count")
    tx_attempts = payload.get("texture_transaction_attempt_count")
    receipt = payload.get("texture_receipt")
    if (type(tx_count) is not int or tx_count not in (0, 1) or type(tx_attempts) is not int
            or tx_attempts != tx_count or payload.get("ui_texture_proven") is not (tx_count == 1)
            or (expected_mode == "texture-study" and (tx_count != 0 or receipt is not None))
            or (tx_count == 0 and receipt is not None)
            or (tx_count == 1 and not isinstance(receipt, Mapping))):
        raise BuildControlError("Texture unknown outcome has inconsistent save attempt evidence")
    if tx_count:
        expected_scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
            session["session_epoch"], safe="") + "&request_scope_epoch=" + quote(
                session["request_scope_epoch"], safe="")
        if (receipt.get("method") != "POST" or receipt.get("path") != "/v2/sessions/current/model/transactions"
                or receipt.get("scope_header") != expected_scope
                or not isinstance(receipt.get("payload"), Mapping)
                or not isinstance(receipt.get("scene_before"), Mapping)
                or receipt.get("scene_before", {}).get("study", {}).get("study_pipeline", {}).get("version") != "study_pipeline.v1"
                or type(receipt.get("status")) is not int and receipt.get("status") is not None
                or receipt.get("ui_saved_ack_proven") is True and receipt.get("ui_saved_ack_text") != "Saved stage relax-b."):
            raise BuildControlError("Texture unknown outcome transaction receipt is malformed")
        scene_before = receipt["scene_before"]
        pipeline = deepcopy(scene_before["study"]["study_pipeline"])
        nodes = pipeline.get("nodes")
        if not isinstance(nodes, list) or sum(1 for node in nodes if node.get("id") == "relax-b") != 1:
            raise BuildControlError("Texture unknown outcome transaction is not bound to exact authored B")
        pipeline["version"] = "study_pipeline.v2"
        pipeline["nodes"] = [
            ({**node, "payload": {**node["payload"], "stage_magnetization_assignments": {
                "schema_version": "fullmag.magnetization-assignments.v1",
                "assignments": [{"object_id": "film", "region_id": None, "initializer": None}],
            }}} if node.get("id") == "relax-b" else node) for node in nodes
        ]
        expected_request = {"kind": "merge_patch", "base_revision": scene_before.get("revision"),
                            "merge_patch": {"study": {"study_pipeline": pipeline}}}
        if canonical(receipt.get("payload")) != canonical(expected_request):
            raise BuildControlError("Texture unknown outcome attempted edits outside the one B-local reset")
        if receipt.get("status") is None:
            if receipt.get("acknowledgement") is not None or receipt.get("helper_ack") is not None:
                raise BuildControlError("Texture unknown outcome claims an ACK without an HTTP response")
        elif receipt.get("acknowledgement") is None:
            raise BuildControlError("Texture unknown outcome omitted the response body for a dispatched save")
        elif 200 <= receipt["status"] < 300:
            committed = deepcopy(scene_before)
            committed["revision"] = scene_before.get("revision") + 1
            committed["study"]["study_pipeline"] = pipeline
            expected_ack = {"transaction_kind": "merge_patch", "scene_revision": committed["revision"],
                            "committed_scene": committed}
            expected_helper_ack = {"sceneRevision": committed["revision"], "stageId": "relax-b", "objectId": "film"}
            if (canonical(receipt.get("acknowledgement")) != canonical(expected_ack)
                    or receipt.get("helper_ack") != expected_helper_ack
                    or (receipt.get("ui_saved_ack_proven") is True
                        and receipt.get("ui_saved_ack_text") != "Saved stage relax-b.")):
                raise BuildControlError("Texture unknown outcome changed or misreported the acknowledged B reset")

    command_count = payload.get("command_count")
    command_attempts = payload.get("command_attempt_count")
    if (type(command_count) is not int or command_count not in (0, 1)
            or type(command_attempts) is not int or command_attempts != command_count
            or payload.get("ui_command_proven") is not (command_count == 1)
            or payload.get("command_receipt") is not None and command_count == 0):
        raise BuildControlError("Texture unknown outcome overstates or repeats its compute command")
    if command_count:
        command_receipt = payload["command_receipt"]
        command = command_receipt.get("payload") if isinstance(command_receipt, Mapping) else None
        stage_target = expected_mode == "texture-stage-b"
        expected_target = ({"kind": "stage_id", "stage_id": "relax-b"} if stage_target
                           else {"kind": "study"})
        if (not isinstance(command, Mapping) or command.get("target") != expected_target
                or command_receipt.get("method") != "POST"
                or command_receipt.get("path") != "/v2/sessions/current/simulation/commands"
                or command_receipt.get("scope_header") != ("session=" + quote(session["session_id"], safe="")
                    + "&epoch=" + quote(session["session_epoch"], safe="") + "&request_scope_epoch="
                    + quote(session["request_scope_epoch"], safe=""))
                or command.get("precondition") != precondition
                or command.get("reason") != "user_requested"
                or not isinstance(command.get("client_intent_id"), str)
                or command_receipt.get("idempotency_key") != command.get("client_intent_id") and stage_target
                or (stage_target and command.get("initial_state") != {
                    "kind": "authored_initial_state", "source": {"kind": "stage",
                        "scene_revision": precondition["scene_revision"], "stage_id": "relax-b"}})
                or (not stage_target and "initial_state" in command)):
            raise BuildControlError("Texture unknown outcome command receipt is not the exact one-shot target")
    if (payload.get("after") is not None or payload.get("reload_proof") is not None
            or payload.get("history_identity_preserved") is not None
            or payload.get("public_terminal_proven") is not False
            or payload.get("native_execution_proven") is not False
            or payload.get("field_data_proven") is not False):
        raise BuildControlError("Texture unknown outcome claims terminal or native proof after an incomplete observation")
    _validate_study_camera_patches(payload, session)
    request_counts = payload.get("request_counts")
    command_key = "POST /v2/sessions/current/simulation/commands"
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    if (not isinstance(request_counts, Mapping) or not 1 <= len(request_counts) <= 128
            or request_counts.get(command_key, 0) != command_attempts
            or request_counts.get(STUDY_TEXTURE_TRANSACTION_KEY, 0) != tx_count):
        raise BuildControlError("Texture unknown outcome request inventory disagrees with observed dispatches")
    for key, count in request_counts.items():
        if (not isinstance(key, str) or " " not in key or type(count) is not int or count < 1 or count > 512):
            raise BuildControlError("Texture unknown outcome request inventory is malformed")
        method, path = key.split(" ", 1)
        if method == "GET" and path.startswith("/v2/"):
            continue
        if key == STUDY_TEXTURE_TRANSACTION_KEY and tx_count == 1:
            continue
        if key == command_key and command_attempts == 1:
            continue
        if key == STUDY_CAMERA_PATCH_KEY and count <= 4:
            continue
        if key == ack_key and count <= 16:
            continue
        raise BuildControlError("Texture unknown outcome attempted another API mutation")
    read_counts = payload.get("read_counts")
    required_reads = {"status", "current_session", "scene", "commands", "current_run", "stage_execution",
                      "solver_status", "stage_results", "command_details"}
    if (not isinstance(read_counts, Mapping) or set(read_counts) != required_reads
            or any(type(value) is not int or value < 0 or value > 512 for value in read_counts.values())
            or payload.get("violations") != []):
        raise BuildControlError("Texture unknown outcome omitted its bounded reads or strict request guard")
    if (type(payload.get("total_requests")) is not int
            or payload["total_requests"] != sum(request_counts.values()) or payload["total_requests"] > 512
            or payload.get("request_limit") != 512 or payload.get("request_path_limit") != 128
            or payload.get("per_path_read_limit") != 128):
        raise BuildControlError("Texture unknown outcome exceeded its request budget")
    return dict(payload)


def _parse_fdm_grid_resume_result(output, public_url, browser_url, expected_sources, evidence):
    """Validate this attempt, then join pinned parent mutations for cycle checks.

    The joined payload is private validation data. The returned report retains
    the measured current-attempt requests and zero cell/grid dispatches.
    """
    if (not isinstance(output, bytes) or len(output) > MAX_RESULT_BYTES
            or not isinstance(evidence, Mapping)
            or evidence.get("schema") != "fullmag.p22-fdm-grid-resume-evidence.v1"
            or not isinstance(evidence.get("prior_before"), Mapping)
            or not isinstance(evidence.get("prior_cell_receipt"), Mapping)
            or not isinstance(evidence.get("prior_grid_receipt"), Mapping)
            or not isinstance(evidence.get("prior_report"), Mapping)):
        raise BuildControlError("FDM resume requires bounded output and trusted parent evidence")
    payload = None
    for line in reversed(output.decode("utf-8", "replace").splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if (not isinstance(payload, Mapping)
            or payload.get("schema") != STUDY_STAGE_RERUN_RESULT_SCHEMA
            or payload.get("scenario") != "study-stage-rerun"
            or payload.get("mode") != "fdm-cell-study-resume"):
        raise BuildControlError("FDM resume output belongs to another browser scenario")
    before = evidence["prior_before"]
    cell = evidence["prior_cell_receipt"]
    prior = evidence["prior_report"]
    expected_proof = {
        "schema": evidence["schema"], "prior_attempt": evidence.get("prior_attempt"),
        "record_sha256": evidence.get("record_sha256"),
        "grid_command_id": evidence.get("grid_command_id"),
        "original_run_id": before.get("run_id"),
        "original_result_identities": before.get("result_identities"),
        "cell_scene_revision": cell.get("scene_revision"),
        "unmodified_scene_sha256_after": cell.get("unmodified_scene_sha256_after"),
    }
    if (prior.get("mode") != "fdm-cell-study"
            or prior.get("phase") not in {"fdm-grid-observing", "fdm-grid-ready", "ui-submit"}
            or prior.get("outcome") != "unknown" or prior.get("command_count") != 0
            or prior.get("command_attempt_count") != 0
            or payload.get("resume_evidence") != expected_proof
            or payload.get("before") != before
            or payload.get("session_before") != evidence.get("prior_session")
            or payload.get("session_after") != evidence.get("prior_session")
            or payload.get("fdm_material_initial_state") != evidence.get("prior_material_initial_state")):
        raise BuildControlError("FDM resume replaced its pinned parent, session or historical A result")
    for key in ("fdm_cell_count", "fdm_cell_attempt_count", "grid_refresh_count", "grid_refresh_attempt_count"):
        if type(payload.get(key)) is not int or payload[key] != 0:
            raise BuildControlError("FDM resume repeated a cell transaction or grid refresh")
    for key in ("fdm_cell_receipt", "grid_refresh_receipt"):
        if payload.get(key) is not None:
            raise BuildControlError("FDM resume attributed a prior mutation receipt to its current attempt")
    if payload.get("ui_fdm_cell_proven") is not False or payload.get("ui_grid_refresh_proven") is not False:
        raise BuildControlError("FDM resume claims a current cell or grid UI action")
    count = payload.get("command_count")
    attempts = payload.get("command_attempt_count")
    if (type(count) is not int or count not in (0, 1)
            or type(attempts) is not int or attempts != count
            or payload.get("ui_command_proven") is not (count == 1)):
        raise BuildControlError("FDM resume duplicated its one Study Solve")
    requests = payload.get("request_counts")
    command_key = "POST /v2/sessions/current/simulation/commands"
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    if (not isinstance(requests, Mapping) or not 1 <= len(requests) <= 128
            or requests.get(command_key, 0) != count
            or requests.get(STUDY_FDM_CELL_TRANSACTION_KEY, 0) != 0):
        raise BuildControlError("FDM resume request inventory differs from its current dispatches")
    for key, value in requests.items():
        if (not isinstance(key, str) or " " not in key or len(key) > 2048
                or type(value) is not int or not 1 <= value <= 128):
            raise BuildControlError("FDM resume request inventory exceeds its bounds")
        method, path = key.split(" ", 1)
        if method == "GET" and path.startswith("/v2/"):
            continue
        if key == command_key and value == count:
            continue
        if key == STUDY_CAMERA_PATCH_KEY and value <= 4:
            continue
        if key == ack_key and value <= 16:
            continue
        raise BuildControlError("FDM resume attempted an additional API mutation")
    if (type(payload.get("total_requests")) is not int
            or payload["total_requests"] != sum(requests.values()) or payload["total_requests"] > 512
            or payload.get("request_limit") != 512 or payload.get("request_path_limit") != 128
            or payload.get("per_path_read_limit") != 128):
        raise BuildControlError("FDM resume omitted its current request budget proof")
    prepared = payload.get("prepared_grid_run")
    commands = prepared.get("commands") if isinstance(prepared, Mapping) else None
    if (not isinstance(commands, Mapping)
            or commands.get("last_command_id") != evidence.get("grid_command_id")):
        raise BuildControlError("FDM resume is not bound to the completed parent grid command")
    _validate_study_fdm_prepared_grid_run(
        prepared, previous_run=before["run_id"],
        previous_domain_generation=before["profile"]["domain_generation_id"],
        cell_receipt=cell, previous_precondition=before["precondition"],
        expected_script_sha256=expected_sources["fixture"],
    )

    # These two mutation receipts were validated from the parent's durable
    # records before launch. Join them with the new held/run observations so
    # the existing complete-cycle guards remain unchanged.
    joined = deepcopy(payload)
    joined.pop("resume_evidence", None)
    joined["mode"] = "fdm-cell-study"
    joined.update(fdm_cell_count=1, fdm_cell_attempt_count=1, ui_fdm_cell_proven=True,
                  grid_refresh_count=1, grid_refresh_attempt_count=1, ui_grid_refresh_proven=True)
    joined["fdm_cell_receipt"] = deepcopy(cell)
    grid = deepcopy(evidence["prior_grid_receipt"])
    observed_transition = grid.get("domain_transition")
    grid["domain_transition"] = {
        "before_domain_cell_count": before["profile"]["domain_cell_count"],
        "before_domain_generation_id": before["profile"]["domain_generation_id"],
        "ready_domain_cell_count": prepared["profile"]["domain_cell_count"],
        "ready_domain_generation_id": prepared["profile"]["domain_generation_id"],
        "scene_revision": cell["scene_revision"], "prior_run_id": before["run_id"],
        "preserved_prior_result_identities": before["result_identities"],
        "prepared_run_id": prepared["run_id"],
        "preparation_id": prepared["preparation"]["preparation_id"],
        "preparation_revision": prepared["preparation"]["revision"],
    }
    if observed_transition is not None and observed_transition != grid["domain_transition"]:
        raise BuildControlError("FDM resume replaced the already observed held preparation")
    joined["grid_refresh_receipt"] = grid
    joined["request_counts"][STUDY_FDM_CELL_TRANSACTION_KEY] = 1
    joined["request_counts"][command_key] = count + 1
    joined["total_requests"] = sum(joined["request_counts"].values())
    _parse_study_stage_rerun_result(
        canonical(joined), public_url, browser_url, expected_sources, "fdm-cell-study",
    )
    return dict(payload)


def _parse_study_stage_rerun_result(output, public_url, browser_url, expected_sources, expected_mode,
                                    *, expected_resume_evidence=None):
    if expected_mode == "fdm-cell-study-resume":
        _validate_study_stage_rerun_hashes(expected_sources, expected_mode)
        return _parse_fdm_grid_resume_result(
            output, public_url, browser_url, expected_sources, expected_resume_evidence,
        )
    _validate_study_stage_rerun_hashes(expected_sources, expected_mode)
    if expected_mode not in {"stage-b", "study", "material-stage-a", "fdm-cell-study", "texture-stage-b", "texture-study"}:
        raise BuildControlError("Study stage rerun expected mode is invalid")
    if not isinstance(output, bytes) or len(output) > MAX_RESULT_BYTES:
        raise BuildControlError("Study stage rerun result exceeds its evidence budget")
    payload = None
    for line in reversed(output.decode("utf-8", "replace").splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if (not isinstance(payload, Mapping)
            or payload.get("schema") != STUDY_STAGE_RERUN_RESULT_SCHEMA
            or payload.get("scenario") != "study-stage-rerun"
            or payload.get("mode") != expected_mode):
        raise BuildControlError("Study stage rerun helper reported another scenario or mode")
    if payload.get("outcome") == "unknown":
        if expected_mode in {"texture-stage-b", "texture-study"}:
            return _validate_study_texture_unknown_payload(
                payload, public_url, browser_url, expected_sources, expected_mode,
            )
        if expected_mode == "material-stage-a" and payload.get("command_count") == 0:
            return _validate_material_stage_a_unknown_payload(
                payload, public_url, browser_url, expected_sources,
            )
        if expected_mode == "fdm-cell-study" and payload.get("command_count") == 0:
            return _validate_fdm_cell_study_unknown_before_compute(
                payload, public_url, browser_url, expected_sources,
            )
        return _validate_study_stage_rerun_unknown_payload(
            payload, public_url, browser_url, expected_sources, expected_mode,
        )
    if (payload.get("state") != "passed" or payload.get("failure") is not None
            or payload.get("outcome") != "terminal-confirmed"):
        raise BuildControlError("Study stage rerun helper did not report the selected terminal proof")
    if (payload.get("public_url") != public_url or payload.get("probe_url") != browser_url
            or payload.get("playwright_version") != PLAYWRIGHT_VERSION
            or payload.get("browser_gpu_mode") != "swiftshader-webgl-requested"
            or payload.get("source_sha256_before") != expected_sources
            or payload.get("source_sha256_after") != expected_sources):
        raise BuildControlError("Study stage rerun helper URL, browser or source pins differ")

    session = payload.get("session_before")
    session_after = payload.get("session_after")
    if (not isinstance(session, Mapping)
            or session.get("name") != "P22 three Relax stages"
            or any(not isinstance(session.get(key), str) or not 1 <= len(session[key]) <= 512
                   for key in ("session_id", "session_epoch", "request_scope_epoch"))
            or session_after != session):
        raise BuildControlError("Study stage rerun helper did not preserve the pinned P22 session")

    before = payload.get("before")
    after = payload.get("after")
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        raise BuildControlError("Study stage rerun helper omitted before/after public resources")
    previous_run = before.get("run_id")
    new_run = after.get("run_id")
    prepared_grid_run = payload.get("prepared_grid_run") if expected_mode == "fdm-cell-study" else None
    if (not isinstance(previous_run, str) or not previous_run or not isinstance(new_run, str)
            or not new_run or new_run == previous_run
            or expected_mode == "fdm-cell-study" and (
                not isinstance(prepared_grid_run, Mapping) or prepared_grid_run.get("run_id") != new_run)):
        raise BuildControlError("Study stage rerun helper did not establish a distinct new run")
    baseline_precondition = before.get("precondition")
    precondition = (prepared_grid_run.get("precondition") if isinstance(prepared_grid_run, Mapping)
                    else baseline_precondition)
    if not isinstance(precondition, Mapping):
        raise BuildControlError("Study stage rerun omitted the fresh runtime command precondition")

    expected_before = _study_stage_expected_ids(expected_mode, "before")
    expected_after = _study_stage_expected_ids(expected_mode, "after")
    expected_profile = {
        "domain_discretization": "fdm",
        "domain_cell_count": 16 if expected_mode in {"texture-stage-b", "texture-study"} else 8,
        "domain_generation_id": baseline_precondition.get("domain_generation_id")
            if isinstance(baseline_precondition, Mapping) else None,
        "requested_backend": "fdm",
        "requested_device": "cpu",
        "requested_precision": "double",
        "script_sha256": expected_sources["fixture"],
        "script_path": "/opt/fullmag/source/examples/interactive_study/fdm_cpu_three_relax_continue.py",
    }
    expected_scene_profile = _expected_study_stage_scene_profile(
        pipeline_version="study_pipeline.v2" if expected_mode in {"texture-stage-b", "texture-study"} else "study_pipeline.v1",
        texture_object_id=(before.get("texture_baseline_state", {}).get("material", {}).get("object_id")
                           if expected_mode in {"texture-stage-b", "texture-study"} else None),
    )
    for value, expected_ids, label in (
        (before, expected_before, "before"),
        (after, expected_after, "after"),
    ):
        current_expected_profile = dict(expected_profile)
        if expected_mode == "fdm-cell-study" and label == "after":
            current_expected_profile["domain_cell_count"] = 16
            current_expected_profile["domain_generation_id"] = (
                prepared_grid_run.get("profile", {}).get("domain_generation_id")
                if isinstance(prepared_grid_run, Mapping) else None
            )
        if (value.get("run_status") != "completed"
                or value.get("solver_state") != "awaiting_command"
                or value.get("execution_state") != "completed"
                or value.get("stage_ids") != expected_ids
                or value.get("authored_stage_ids") != ["relax-a", "relax-b", "relax-c"]
                or value.get("stage_statuses") != [
                    "completed" if stage_id in expected_ids else "pending"
                    for stage_id in ("relax-a", "relax-b", "relax-c")]
                or value.get("completed_stage_indexes") != [
                    index for index, stage_id in enumerate(("relax-a", "relax-b", "relax-c"))
                    if stage_id in expected_ids]
                or value.get("scene_profile") != expected_scene_profile
                or not isinstance(value.get("profile"), Mapping)
                or any(value["profile"].get(key) != expected for key, expected in current_expected_profile.items())
                ):
            raise BuildControlError(f"Study stage rerun {label} public run/stage state differs")

    expected_precondition_run = (prepared_grid_run.get("run_id")
                                 if isinstance(prepared_grid_run, Mapping) else previous_run)
    current_run = precondition.get("current_run")
    if (current_run != {"kind": "run", "run_id": expected_precondition_run}
            or type(precondition.get("scene_revision")) is not int
            or precondition["scene_revision"] < 0
            or type(precondition.get("mesh_revision")) is not int
            or precondition["mesh_revision"] < 0
            or not isinstance(precondition.get("domain_generation_id"), str)
            or not precondition["domain_generation_id"]
            or precondition.get("runtime_state") != "awaiting_command"
            or type(precondition.get("command_revision")) is not int
            or precondition["command_revision"] < 0):
        raise BuildControlError("Study stage rerun precondition is stale or incomplete")
    region_revision_keys = (
        "region_topology_revision", "region_membership_revision",
        "region_coefficients_revision", "region_initial_state_revision",
    )
    if any(type(precondition.get(key)) is not int or precondition[key] < 0 for key in region_revision_keys):
        raise BuildControlError("Study stage rerun omitted one of the current region revision preconditions")
    if "stage_execution_revision" in precondition:
        raise BuildControlError("Study compute command includes a stage-control revision")

    if expected_mode == "material-stage-a":
        material_receipt = _validate_study_material_receipt(
            payload, session, precondition.get("scene_revision"),
        )
        if (payload.get("material_count") != 1 or payload.get("material_attempt_count") != 1
                or payload.get("ui_material_proven") is not True
                or material_receipt.get("acknowledged") is not True):
            raise BuildControlError("Material-stage-A result omitted exactly one acknowledged material edit")
    elif (payload.get("material_count", 0) != 0 or payload.get("material_attempt_count", 0) != 0
          or payload.get("material_receipt") is not None or payload.get("ui_material_proven", False) is not False):
        raise BuildControlError("Legacy Study rerun profile reported an unrequested material edit")

    if expected_mode == "fdm-cell-study":
        before_material = _validate_study_fdm_material_state(before.get("material_state"))
        after_material = _validate_study_fdm_material_state(after.get("material_state"))
        initial_material = _validate_study_fdm_material_state(payload.get("fdm_material_initial_state"))
        if before_material != after_material or before_material != initial_material:
            raise BuildControlError("FDM-cell-study changed the accepted material or authored m0")
        cell_receipt = _validate_study_fdm_cell_receipt(
            payload, session, precondition.get("scene_revision") - 1,
        )
        if (type(payload.get("fdm_cell_count")) is not int or payload.get("fdm_cell_count") != 1
                or type(payload.get("fdm_cell_attempt_count")) is not int
                or payload.get("fdm_cell_attempt_count") != 1
                or payload.get("ui_fdm_cell_proven") is not True
                or cell_receipt.get("acknowledged") is not True):
            raise BuildControlError("FDM-cell-study omitted exactly one acknowledged grid-policy edit")
        grid_receipt = _validate_study_fdm_grid_refresh_receipt(
            payload, session, cell_receipt, previous_run, before.get("result_identities"), require_ready=True,
        )
        prepared_grid_run = _validate_study_fdm_prepared_grid_run(
            prepared_grid_run, previous_run=previous_run,
            previous_domain_generation=before["profile"].get("domain_generation_id"),
            cell_receipt=cell_receipt, previous_precondition=before.get("precondition"),
            expected_script_sha256=expected_sources["fixture"],
            expected_last_command_id=grid_receipt["command_id"],
        )
        transition = grid_receipt.get("domain_transition")
        if (type(payload.get("grid_refresh_count")) is not int or payload.get("grid_refresh_count") != 1
                or type(payload.get("grid_refresh_attempt_count")) is not int
                or payload.get("grid_refresh_attempt_count") != 1
                or payload.get("ui_grid_refresh_proven") is not True
                or transition.get("ready_domain_generation_id") != prepared_grid_run["profile"].get("domain_generation_id")
                or transition.get("ready_domain_cell_count") != 16
                or transition.get("prepared_run_id") != prepared_grid_run.get("run_id")
                or transition.get("prior_run_id") != previous_run
                or transition.get("preserved_prior_result_identities") != before.get("result_identities")
                or transition.get("preparation_id") != prepared_grid_run["preparation"].get("preparation_id")
                or transition.get("preparation_revision") != prepared_grid_run["preparation"].get("revision")
                or precondition != prepared_grid_run.get("precondition")
                or new_run != prepared_grid_run.get("run_id")):
            raise BuildControlError("FDM-cell-study did not bind its automatic refresh to the 16-cell command domain")
    elif (payload.get("fdm_cell_count", 0) != 0 or payload.get("fdm_cell_attempt_count", 0) != 0
          or payload.get("fdm_cell_receipt") is not None or payload.get("ui_fdm_cell_proven", False) is not False
          or payload.get("grid_refresh_count", 0) != 0 or payload.get("grid_refresh_attempt_count", 0) != 0
          or payload.get("grid_refresh_receipt") is not None or payload.get("ui_grid_refresh_proven", False) is not False
          or payload.get("fdm_material_initial_state") is not None):
        raise BuildControlError("Study rerun profile reported an unrequested FDM-grid edit")

    if expected_mode in {"texture-stage-b", "texture-study"}:
        _validate_study_texture_profile(payload, expected_mode, before, after, session, precondition)
    elif (payload.get("texture_transaction_count", 0) != 0
          or payload.get("texture_transaction_attempt_count", 0) != 0
          or payload.get("texture_receipt") is not None or payload.get("ui_texture_proven", False) is not False
          or payload.get("texture_source_proof") is not None or payload.get("texture_baseline_state") is not None):
        raise BuildControlError("Study rerun profile reported an unrequested texture edit")

    receipt = payload.get("command_receipt")
    command = receipt.get("payload") if isinstance(receipt, Mapping) else None
    expected_scope = "session=" + quote(session["session_id"], safe="") + "&epoch=" + quote(
        session["session_epoch"], safe=""
    ) + "&request_scope_epoch=" + quote(session["request_scope_epoch"], safe="")
    stage_target = {"kind": "stage_id", "stage_id": "relax-b" if expected_mode in {"stage-b", "texture-stage-b"} else "relax-a"}
    expected_command = (
        {"kind": "relax", "target": stage_target}
        if expected_mode in {"stage-b", "material-stage-a", "texture-stage-b"}
        else {"kind": "solve", "target": {"kind": "study"}}
    )
    if (not isinstance(receipt, Mapping)
            or receipt.get("method") != "POST"
            or receipt.get("path") != "/v2/sessions/current/simulation/commands"
            or type(receipt.get("status")) is not int
            or not 200 <= receipt["status"] < 300
            or receipt.get("scope_header") != expected_scope
            or not isinstance(command, Mapping)
            or any(command.get(key) != value for key, value in expected_command.items())
            or command.get("precondition") != precondition
            or not isinstance(command.get("client_intent_id"), str)
            or not command["client_intent_id"].startswith(
                "study:" + ("relax" if expected_mode in {"stage-b", "material-stage-a", "texture-stage-b"} else "solve") + ":")
            or len(command["client_intent_id"]) > 128
            or command.get("reason") != "user_requested"
            or type(command.get("requested_at_unix_ms")) is not int
            or command["requested_at_unix_ms"] <= 0):
        raise BuildControlError("Study stage rerun command receipt has the wrong method, scope or target")
    if expected_mode == "texture-stage-b":
        if command.get("initial_state") != {"kind": "authored_initial_state", "source": {
                "kind": "stage", "scene_revision": precondition["scene_revision"], "stage_id": "relax-b"}}:
            raise BuildControlError("Texture-stage-B command did not pin the saved authored-stage input")
        if receipt.get("idempotency_key") != command.get("client_intent_id"):
            raise BuildControlError("Texture-stage-B command idempotency key differs from its client intent")
    elif expected_mode in {"stage-b", "material-stage-a"}:
        if command.get("initial_state") != {"kind": "default_for_target"}:
            raise BuildControlError("Stage B command did not retain its default target initial state")
    elif "initial_state" in command:
        raise BuildControlError("Whole-Study command unexpectedly supplied a stage initial state")
    if (type(payload.get("command_count")) is not int or payload["command_count"] != 1
            or type(payload.get("command_attempt_count")) is not int or payload["command_attempt_count"] != 1
            or payload.get("ui_command_proven") is not True):
        raise BuildControlError("Study stage rerun did not submit exactly one command")
    expected_binding = {"requested_target": expected_command["target"], "run_id": new_run}
    if expected_mode in {"stage-b", "material-stage-a", "texture-stage-b"}:
        expected_binding["step_id"] = stage_target["stage_id"]
    if receipt.get("execution_binding") != expected_binding:
        raise BuildControlError("Study stage rerun terminal run is not bound to its accepted PPM command")

    def validate_result_identities(value, run_id, stage_ids, label):
        if not isinstance(value, list) or len(value) != len(stage_ids):
            raise BuildControlError(f"Study stage rerun {label} result set is incomplete")
        found = []
        for result in value:
            if not isinstance(result, Mapping):
                raise BuildControlError(f"Study stage rerun {label} result identity is malformed")
            source = result.get("source")
            stage_id = result.get("authored_stage_id")
            if (not isinstance(source, Mapping) or source.get("run_id") != run_id
                    or any(not isinstance(source.get(key), str) or not source[key]
                           for key in ("task_id", "step_id", "case_id", "attempt_id"))
                    or type(source.get("ownership_epoch")) is not int or source["ownership_epoch"] < 0
                    or not isinstance(stage_id, str) or stage_id not in stage_ids
                    or not isinstance(result.get("project_id"), str) or not result["project_id"]
                    or not isinstance(result.get("study_id"), str) or not result["study_id"]
                    or not isinstance(result.get("artifact_id"), str) or not result["artifact_id"]
                    or not isinstance(result.get("artifact_sha256"), str)
                    or not SHA256_RE.fullmatch(result["artifact_sha256"])
                    or not isinstance(result.get("codec_id"), str) or not result["codec_id"]
                    or not isinstance(result.get("codec_version"), str) or not result["codec_version"]
                    or not isinstance(result.get("accepted_at"), str) or not result["accepted_at"]):
                raise BuildControlError(f"Study stage rerun {label} result identity is malformed")
            found.append(stage_id)
        if found != stage_ids:
            raise BuildControlError(f"Study stage rerun {label} results include a missing, duplicate or extra stage")

    before_results = before.get("result_identities")
    after_results = after.get("result_identities")
    preserved_results = after.get("preserved_prior_result_identities")
    validate_result_identities(before_results, previous_run, expected_before, "previous run")
    validate_result_identities(after_results, new_run, expected_after, "new run")
    validate_result_identities(preserved_results, previous_run, expected_before, "preserved previous run")
    if (preserved_results != before_results or payload.get("history_identity_preserved") is not True):
        raise BuildControlError("Study stage rerun changed an existing immutable result identity")
    if (payload.get("public_terminal_proven") is not True
            or payload.get("native_execution_proven") is not False
            or payload.get("field_data_proven") is not False):
        raise BuildControlError("Study stage rerun claims unsupported execution or field evidence")

    reload = payload.get("reload_proof")
    canvas = reload.get("canvas") if isinstance(reload, Mapping) else None
    if (not isinstance(reload, Mapping) or reload.get("status") != 200
            or reload.get("path") != "/session/p22-three-relax-stages" or reload.get("run_id") != new_run
            or type(reload.get("command_count")) is not int or reload["command_count"] != 1
            or type(reload.get("command_attempt_count")) is not int or reload["command_attempt_count"] != 1
            or reload.get("stable_projection") is not True or reload.get("history_identity_preserved") is not True
            or not isinstance(canvas, Mapping) or canvas.get("visible") is not True
            or canvas.get("context_type") not in ("WebGLRenderingContext", "WebGL2RenderingContext")
            or canvas.get("context_lost") is not False
            or any(type(canvas.get(key)) is not int or not 0 < canvas[key] <= 16384
                   for key in ("drawing_buffer_width", "drawing_buffer_height"))
            or canvas.get("quantity_id") != "m" or canvas.get("label_visible") is not True
            or canvas.get("field_state") != "data-ready"
            or type(canvas.get("fdm_model_count")) is not int
            or canvas["fdm_model_count"] != (16 if expected_mode in {"fdm-cell-study", "texture-stage-b", "texture-study"} else 8)):
        raise BuildControlError("Study stage rerun omitted its same-run reload, history or WebGL proof")

    read_counts = payload.get("read_counts")
    required_counts = {"status": 2, "current_session": 2, "scene": 2, "commands": 1, "current_run": 2,
                       "stage_execution": 2, "solver_status": 2, "stage_results": 3, "command_details": 0}
    if expected_mode == "fdm-cell-study":
        required_counts["preparation"] = 1
    if (not isinstance(read_counts, Mapping) or set(read_counts) != set(required_counts)
            or any(type(read_counts.get(key)) is not int or read_counts[key] < minimum
                   or read_counts[key] > 512 for key, minimum in required_counts.items())):
        raise BuildControlError("Study stage rerun omitted bounded before/after public resource reads")
    _validate_study_camera_patches(payload, session)
    request_counts = payload.get("request_counts")
    if not isinstance(request_counts, Mapping) or not 1 <= len(request_counts) <= 128:
        raise BuildControlError("Study stage rerun omitted its measured API request inventory")
    command_key = "POST /v2/sessions/current/simulation/commands"
    ack_key = "POST /v2/sessions/current/visualization/client-acks"
    for key, count in request_counts.items():
        if (not isinstance(key, str) or " " not in key or len(key) > 2048
                or type(count) is not int or count < 1 or count > 512):
            raise BuildControlError("Study stage rerun API request inventory is malformed")
        method, path = key.split(" ", 1)
        if method == "GET":
            if not path.startswith("/v2/"):
                raise BuildControlError("Study stage rerun read escaped the public v2 API")
        elif key == STUDY_CAMERA_PATCH_KEY:
            if count > 4:
                raise BuildControlError("Study camera autosave exceeded its bound")
        elif key == ack_key:
            if count > 16:
                raise BuildControlError("Study stage rerun visualization acknowledgements exceeded their bound")
        elif expected_mode == "material-stage-a" and key == STUDY_MATERIAL_TRANSACTION_KEY:
            if count != 1:
                raise BuildControlError("Material-stage-A transaction count differs from one")
        elif expected_mode == "fdm-cell-study" and key == STUDY_FDM_CELL_TRANSACTION_KEY:
            if count != 1:
                raise BuildControlError("FDM-cell-study transaction count differs from one")
        elif expected_mode == "texture-stage-b" and key == STUDY_TEXTURE_TRANSACTION_KEY:
            if count != 1:
                raise BuildControlError("Texture-stage-B transaction count differs from one")
        elif key != command_key or count != (2 if expected_mode == "fdm-cell-study" else 1):
            raise BuildControlError("Study stage rerun attempted an unexpected or duplicate mutation")
    if (request_counts.get(command_key) != (2 if expected_mode == "fdm-cell-study" else 1)
            or type(payload.get("total_requests")) is not int
            or sum(request_counts.values()) != payload.get("total_requests") or payload["total_requests"] > 512
            or payload.get("request_limit") != 512 or payload.get("request_path_limit") != 128
            or payload.get("per_path_read_limit") != 128):
        raise BuildControlError("Study stage rerun command request count differs from one")
    if expected_mode == "material-stage-a" and request_counts.get(STUDY_MATERIAL_TRANSACTION_KEY) != 1:
        raise BuildControlError("Material-stage-A omitted its single scoped material transaction")
    if expected_mode == "texture-stage-b" and request_counts.get(STUDY_TEXTURE_TRANSACTION_KEY) != 1:
        raise BuildControlError("Texture-stage-B omitted its single scoped B-local transaction")
    if expected_mode == "texture-study" and request_counts.get(STUDY_TEXTURE_TRANSACTION_KEY, 0) != 0:
        raise BuildControlError("Texture-study reported an unrequested B-local transaction")
    if expected_mode == "fdm-cell-study":
        _validate_study_fdm_request_inventory(payload, 1, 1)
    if any(payload.get(key) != [] for key in ("violations", "errors", "proxy_failures")):
        raise BuildControlError("Study stage rerun helper reported browser, proxy or scope violations")
    return dict(payload)


def _parse_airbox_inspector_result(
    output: bytes,
    public_url: str,
    browser_url: str,
    expected_script_sha256: str,
) -> dict[str, object]:
    text = output.decode("utf-8", "replace")
    payload = None
    for line in reversed(text.splitlines()):
        if not line.strip():
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if not isinstance(payload, dict):
        raise BuildControlError("Airbox Inspector helper did not emit one JSON result")
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
        raise BuildControlError("Airbox Inspector result exceeds its bounded evidence budget")
    if (payload.get("schema") != AIRBOX_INSPECTOR_RESULT_SCHEMA
            or payload.get("state") != "passed"
            or payload.get("scenario") != "airbox-inspector"):
        raise BuildControlError("Airbox Inspector helper reported a failed or unknown scenario")
    if payload.get("public_url") != public_url or payload.get("probe_url") != browser_url:
        raise BuildControlError("Airbox Inspector helper URL differs from the selected frontend")
    if payload.get("playwright_version") != PLAYWRIGHT_VERSION:
        raise BuildControlError("Airbox Inspector Playwright version differs from the lock pin")
    if payload.get("browser_gpu_mode") != "swiftshader-webgl-requested":
        raise BuildControlError("Airbox Inspector helper browser mode differs")
    for key in ("page_errors", "console_errors", "request_failures"):
        if type(payload.get(key)) is not int or payload[key] != 0:
            raise BuildControlError(f"Airbox Inspector helper reported {key}")
    if payload.get("http_errors") != []:
        raise BuildControlError("Airbox Inspector helper reported HTTP errors")
    _validate_startup_unmount_cancellation_probes(
        payload.get("startup_request_events"),
        payload.get("startup_unmount_cancellation_probes"),
    )
    synthetic_http_errors = payload.get("synthetic_http_errors")
    if (not isinstance(synthetic_http_errors, list)
            or len(synthetic_http_errors) > 6
            or any(
                not isinstance(item, str)
                or item != "503 GET /v2/sessions/current/meshing/meshes/universe/quality"
                for item in synthetic_http_errors
            )
            or not any(
                isinstance(item, str)
                and item == "503 GET /v2/sessions/current/meshing/meshes/universe/quality"
                for item in synthetic_http_errors
            )):
        raise BuildControlError("Airbox Inspector helper omitted its isolated synthetic quality error evidence")
    synthetic_console_errors = payload.get("synthetic_console_errors", [])
    if not isinstance(synthetic_console_errors, list) or len(synthetic_console_errors) > 6:
        raise BuildControlError("Airbox Inspector synthetic console evidence is malformed")
    for item in synthetic_console_errors:
        if not isinstance(item, str) or len(item) > 2048:
            raise BuildControlError("Airbox Inspector synthetic console evidence is malformed")
        location_url = item.split(": ", 1)[0]
        if urlsplit(location_url).path != "/v2/sessions/current/meshing/meshes/universe/quality":
            raise BuildControlError("Airbox Inspector suppressed a console error outside the exact quality endpoint")
    proof = payload.get("inspector_proof")
    if not isinstance(proof, Mapping):
        raise BuildControlError("Airbox Inspector helper omitted its route and API proof")
    if (proof.get("schema") != "fullmag.airbox-inspector-browser-proof.v1"
            or proof.get("script_sha256") != expected_script_sha256
            or proof.get("authored_method") != "fem"
            or proof.get("published_fem_with_unresolved_runtime") is not True
            or proof.get("generic_unknown_header_rejected") is not True
            or proof.get("no_authoring_mutations") is not True
            or proof.get("no_solve_commands") is not True):
        raise BuildControlError("Airbox Inspector helper did not prove the published FEM inspection case")
    acknowledgements = proof.get("visualization_client_acknowledgements")
    if not isinstance(acknowledgements, list) or len(acknowledgements) > 16:
        raise BuildControlError("Airbox Inspector visualization acknowledgements are malformed")
    for acknowledgement in acknowledgements:
        if not isinstance(acknowledgement, Mapping):
            raise BuildControlError("Airbox Inspector visualization acknowledgement is malformed")
        metadata = acknowledgement.get("payload")
        status = acknowledgement.get("response_status")
        if (acknowledgement.get("method") != "POST"
                or acknowledgement.get("path") != "/v2/sessions/current/visualization/client-acks"
                or acknowledgement.get("outcome") != "recorded"
                or type(status) is not int or not 200 <= status < 300
                or not isinstance(metadata, Mapping)
                or metadata.get("body_valid_json") is not True
                or metadata.get("client_id_present") is not True
                or metadata.get("viewport_id_present") is not True
                or metadata.get("status") not in {"applied", "rendered"}
                or metadata.get("error_present") is not False
                or type(metadata.get("revision")) is not int
                or metadata["revision"] < 0):
            raise BuildControlError("Airbox Inspector recorded an invalid or failed visualization acknowledgement")
    unresolved = proof.get("unresolved_status_probe")
    if (not isinstance(unresolved, Mapping)
            or unresolved.get("only_active_lane_resolved_changed") is not True
            or unresolved.get("domain_discretization") != "fem"
            or not isinstance(unresolved.get("domain_generation_id"), str)
            or not unresolved["domain_generation_id"]
            or type(unresolved.get("mesh_revision")) is not int
            or unresolved["mesh_revision"] <= 0
            or type(unresolved.get("topology_revision")) is not int
            or unresolved["topology_revision"] <= 0):
        raise BuildControlError("Airbox Inspector helper did not isolate the unresolved FEM runtime case")
    canvas = proof.get("canvas")
    if (not isinstance(canvas, Mapping)
            or canvas.get("visible") is not True
            or canvas.get("context_lost") is not False
            or type(canvas.get("drawing_buffer_width")) is not int
            or canvas["drawing_buffer_width"] <= 0
            or type(canvas.get("drawing_buffer_height")) is not int
            or canvas["drawing_buffer_height"] <= 0):
        raise BuildControlError("Airbox Inspector helper did not retain a live visible WebGL canvas")

    expected_panels = [
        ("root", "model:airbox", "airbox.root", "Airbox Overview", "Domain policy"),
        ("mesh", "model:airbox:mesh", "airbox.mesh", "Airbox Mesh Overview", "Airbox Mesh Overview"),
        ("parameters", "model:airbox:mesh:parameters", "airbox.mesh.parameters", "Airbox Mesh Parameters", "Canonical Authored Parameters"),
        ("quality-gates", "model:airbox:mesh:quality-gates", "airbox.mesh.quality-gates", "Airbox Mesh Quality Gates", "Airbox Quality Gates"),
        ("statistics", "model:airbox:mesh:statistics", "airbox.mesh.statistics", "Airbox Mesh Statistics", "Airbox Mesh Statistics"),
        ("topology", "model:airbox:mesh:topology", "airbox.mesh.topology", "Airbox Mesh Topology", "Airbox Mesh Topology"),
        ("build", "model:airbox:mesh:build", "airbox.mesh.build", "Airbox Mesh Build", "Airbox Mesh Build"),
    ]
    panels = proof.get("panels")
    if not isinstance(panels, list) or len(panels) != len(expected_panels):
        raise BuildControlError("Airbox Inspector helper did not visit all seven required panels")
    for panel, expected in zip(panels, expected_panels):
        if not isinstance(panel, Mapping):
            raise BuildControlError("Airbox Inspector panel evidence is malformed")
        panel_id, node_id, selection_kind, header, group = expected
        if (panel.get("id") != panel_id or panel.get("node_id") != node_id
                or panel.get("selection_kind") != selection_kind
                or panel.get("header") != header
                or panel.get("required_group") != group
                or panel.get("verified") is not True):
            raise BuildControlError(f"Airbox Inspector panel route was not verified: {panel_id}")
        for field in ("header", "group"):
            item = panel.get(field)
            if not isinstance(item, str) or not item.strip() or len(item) > 256:
                raise BuildControlError(f"Airbox Inspector panel {panel_id} omitted {field}")
        if panel["header"].strip().lower() in {"unknown", "inspector", "airbox inspector", "details"}:
            raise BuildControlError(f"Airbox Inspector panel {panel_id} used a generic header")

    comparisons = proof.get("api_comparisons")
    if not isinstance(comparisons, Mapping):
        raise BuildControlError("Airbox Inspector helper omitted API count/unit comparisons")
    for field in ("airbox_carrier_count", "node_count", "element_count", "boundary_face_count", "surface_face_count"):
        value = comparisons.get(field)
        if type(value) is not int or value < 0:
            raise BuildControlError(f"Airbox Inspector API count is invalid: {field}")
    families = comparisons.get("mixed_element_families")
    if (not isinstance(families, list) or len(families) < 2
            or any(not isinstance(item, str) or not item or len(item) > 128 for item in families)):
        raise BuildControlError("Airbox Inspector proof does not contain mixed element families")
    if (comparisons.get("counts_verified") is not True
            or comparisons.get("length_units_verified") is not True
            or comparisons.get("quality_scope") != "airbox"
            or comparisons.get("quality_marker") != 0
            or comparisons.get("quality_source_verified") is not True):
        raise BuildControlError("Airbox Inspector API counts, SI units, or quality scope differ")
    units = comparisons.get("length_units")
    if not isinstance(units, list) or "m" not in units or any(not isinstance(item, str) for item in units):
        raise BuildControlError("Airbox Inspector helper did not verify SI length units")

    initial_loading = proof.get("initial_quality_loading")
    if (not isinstance(initial_loading, Mapping)
            or initial_loading.get("resource_status") != "loading"
            or initial_loading.get("panel_status") != "loading"
            or initial_loading.get("gate_result") != "unknown"
            or initial_loading.get("live_response_preserved") is not True
            or initial_loading.get("recovered_to_ready") is not True):
        raise BuildControlError("Airbox Inspector showed an invalid gate result during the initial quality load")

    quality_states = proof.get("synthetic_quality_fault_injection")
    baseline = quality_states.get("live_baseline") if isinstance(quality_states, Mapping) else None
    injection = quality_states
    delayed = injection.get("delayed_live_get") if isinstance(injection, Mapping) else None
    failed = injection.get("synthetic_error_get") if isinstance(injection, Mapping) else None
    if (not isinstance(baseline, Mapping)
            or baseline.get("resource_status") != "ready"
            or baseline.get("gate_result") != "unknown"
            or type(baseline.get("revision")) is not int
            or baseline["revision"] <= 0):
        raise BuildControlError("Airbox Inspector helper omitted the live quality baseline")
    if (not isinstance(injection, Mapping)
            or injection.get("evidence_kind") != "fault-injected-ui-only-not-scientific"):
        raise BuildControlError("Airbox Inspector synthetic quality controls are not labeled as UI-only fault injection")
    for control_name in ("synthetic_pass_control", "synthetic_pass_control_for_error"):
        pass_control = injection.get(control_name)
        if (not isinstance(pass_control, Mapping)
                or type(pass_control.get("revision")) is not int
                or pass_control["revision"] != baseline["revision"]
                or pass_control.get("rendered_pass") is not True
                or pass_control.get("revision_matches_live") is not True
                or type(pass_control.get("requests")) is not int
                or not 1 <= pass_control["requests"] <= 4):
            raise BuildControlError("Airbox Inspector omitted the matching-revision synthetic pass control")
    if (not isinstance(delayed, Mapping)
            or delayed.get("cached_synthetic_gate_status") != "pass"
            or delayed.get("resource_status") not in {"stale", "loading", "pending"}
            or delayed.get("panel_status") not in {"stale", "loading", "pending"}
            or delayed.get("gate_result") != "unknown"
            or delayed.get("live_response_preserved") is not True
            or type(delayed.get("live_response_status")) is not int
            or not 200 <= delayed["live_response_status"] < 300
            or delayed.get("restored_to_live_unknown") is not True):
        raise BuildControlError("Airbox Inspector showed an invalid quality result during a delayed live GET")
    if (not isinstance(failed, Mapping)
            or failed.get("cached_synthetic_gate_status") != "pass"
            or failed.get("http_status") != 503
            or failed.get("resource_status") != "error"
            or failed.get("resource_error_observed") is not True
            or failed.get("panel_resource_status") not in {"error", "refresh error"}
            or failed.get("panel_reason_reports_failed_load") is not True
            or failed.get("cached_quality_withheld") is not True
            or failed.get("refresh_error_visible_in_statistics") is not True
            or type(failed.get("requests")) is not int
            or not 1 <= failed["requests"] <= 6
            or failed.get("gate_result") != "unknown"
            or failed.get("restored_to_live_unknown") is not True):
        raise BuildControlError("Airbox Inspector showed an invalid quality result after a synthetic resource failure")
    final_live_state = injection.get("final_live_state")
    if (not isinstance(final_live_state, Mapping)
            or final_live_state.get("resource_status") != "ready"
            or final_live_state.get("gate_result") != "unknown"
            or final_live_state.get("revision_matches_live") is not True):
        raise BuildControlError("Airbox Inspector did not restore the live unknown quality state after fault injection")

    refresh = proof.get("resource_refresh")
    if (not isinstance(refresh, Mapping)
            or refresh.get("resource_path") != "/v2/sessions/current/meshing/meshes/shared-domain/manifest"
            or refresh.get("same_root") is not True
            or refresh.get("live_response_preserved") is not True
            or type(refresh.get("status")) is not int
            or not 200 <= refresh["status"] < 300
            or type(refresh.get("request_count")) is not int
            or not 1 <= refresh["request_count"] <= 4
            or type(refresh.get("delay_ms")) is not int
            or not 250 <= refresh["delay_ms"] <= 2000):
        raise BuildControlError("Airbox Inspector root identity did not survive a bounded live resource refresh")
    _validate_resource_responses(payload.get("resource_responses"))
    return payload


def _parse_saved_playback_result(
    output: bytes,
    public_url: str,
    browser_url: str,
    expected_item_id: str,
    expected_script_sha256: str,
) -> dict[str, object]:
    text = output.decode("utf-8", "replace")
    payload = None
    for line in reversed(text.splitlines()):
        if not line.strip():
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if not isinstance(payload, dict):
        raise BuildControlError("Saved Playback helper did not emit one JSON result")
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
        raise BuildControlError("Saved Playback result exceeds its bounded evidence budget")
    if (payload.get("schema") != SAVED_PLAYBACK_RESULT_SCHEMA
            or payload.get("state") != "passed"
            or payload.get("scenario") != "saved-playback"):
        raise BuildControlError("Saved Playback helper reported a failed or unknown scenario")
    if payload.get("item_id") != expected_item_id:
        raise BuildControlError("Saved Playback helper inspected a different workspace item")
    if (payload.get("public_url") != public_url
            or payload.get("probe_url") != browser_url):
        raise BuildControlError("Saved Playback helper URL differs from the selected frontend")
    if payload.get("playwright_version") != PLAYWRIGHT_VERSION:
        raise BuildControlError("Saved Playback Playwright version differs from the lock pin")
    if payload.get("browser_gpu_mode") != "swiftshader-webgl-requested":
        raise BuildControlError("Saved Playback helper browser mode differs")
    if (payload.get("script_sha256") != expected_script_sha256
            or not SHA256_RE.fullmatch(expected_script_sha256)):
        raise BuildControlError("Saved Playback helper source hash differs from the admitted script")
    geometry_kind = payload.get("geometry_kind", "fdm")
    if geometry_kind not in {"fdm", "fem"}:
        raise BuildControlError("Saved Playback geometry kind is unsupported")
    expected_indices = [0, 400, 800]
    if geometry_kind == "fem":
        frame_count = payload.get("frame_count")
        if type(frame_count) is not int or not 3 <= frame_count <= 100_000:
            raise BuildControlError("Saved FEM Playback frame count is invalid")
        expected_indices = [0, (frame_count - 1) // 2, frame_count - 1]
    if payload.get("frame_indices") != expected_indices:
        raise BuildControlError("Saved Playback helper did not inspect first, midpoint, and last frames")
    frame_hashes = payload.get("frame_sha256")
    if (not isinstance(frame_hashes, list)
            or len(frame_hashes) != 3
            or any(not isinstance(value, str) or not SHA256_RE.fullmatch(value) for value in frame_hashes)):
        raise BuildControlError("Saved Playback helper frame hashes are malformed")
    drawing_buffer = payload.get("drawing_buffer")
    if (not isinstance(drawing_buffer, list)
            or len(drawing_buffer) != 2
            or any(type(value) is not int or value <= 0 for value in drawing_buffer)):
        raise BuildControlError("Saved Playback helper drawing buffer is invalid")
    if (payload.get("canvas_visible") is not True
            or payload.get("context_lost") is not False
            or payload.get("field_payloads_verified") is not True
            or payload.get("changed_canvas") is not True
            or payload.get("inspector_stable") is not True
            or payload.get("camera_stable") is not True):
        raise BuildControlError("Saved Playback helper omitted the required visible canvas and data-plane evidence")
    for key in ("hook_errors", "errors"):
        value = payload.get(key)
        if not isinstance(value, list) or value:
            raise BuildControlError(f"Saved Playback helper reported {key}")

    screenshot = payload.get("screenshot_base64")
    if screenshot is not None:
        if (not isinstance(screenshot, str)
                or len(screenshot) > ((MAX_CANVAS_SCREENSHOT_BYTES + 2) // 3) * 4):
            raise BuildControlError("Saved Playback screenshot exceeds its encoded size limit")
        try:
            screenshot_bytes = base64.b64decode(screenshot, validate=True)
        except (ValueError, binascii.Error) as error:
            raise BuildControlError("Saved Playback screenshot is not valid base64") from error
        if (not screenshot_bytes.startswith(b"\x89PNG\r\n\x1a\n")
                or len(screenshot_bytes) > MAX_CANVAS_SCREENSHOT_BYTES
                or len(screenshot_bytes) < 24
                or int.from_bytes(screenshot_bytes[8:12], "big") != 13
                or screenshot_bytes[12:16] != b"IHDR"
                or int.from_bytes(screenshot_bytes[16:20], "big") <= 0
                or int.from_bytes(screenshot_bytes[20:24], "big") <= 0):
            raise BuildControlError("Saved Playback screenshot is not a bounded PNG")
    return payload


def _validate_planar_airbox_observation(value: object, session: object) -> None:
    if not isinstance(value, Mapping) or value.get("schema") != PLANAR_AIRBOX_OBSERVATION_SCHEMA:
        raise BuildControlError("Browser helper Planar Airbox evidence is missing or malformed")
    if (value.get("state") != "passed" or value.get("quantity_id") != "H_demag"
            or value.get("source_kind") != "default" or value.get("source_id") != "default"
            or value.get("scope_kind") != "airbox" or value.get("scope_id") is not None):
        raise BuildControlError("Browser helper Planar Airbox source or scope differs")
    before, after = value.get("session_before"), value.get("session_after")
    if not isinstance(before, Mapping) or not isinstance(after, Mapping) or not isinstance(session, Mapping):
        raise BuildControlError("Planar Airbox evidence omitted active session/run identity")
    identity_keys = ("session_id", "session_epoch", "request_scope_epoch", "run_id")
    if any(not isinstance(before.get(key), str) or not before[key] for key in identity_keys):
        raise BuildControlError("Planar Airbox before identity is malformed")
    if any(before.get(key) != after.get(key) for key in identity_keys):
        raise BuildControlError("Planar Airbox presentation changed session or run identity")
    if any(after.get(key) != session.get(key) for key in identity_keys[:3]):
        raise BuildControlError("Planar Airbox session identity differs from the browser result")
    request = value.get("meta_request")
    if (not isinstance(request, Mapping) or request.get("method") != "GET"
            or request.get("path") != "/v2/sessions/current/data/fields/H_demag/planar-default/meta"
            or request.get("scope_kind") != "airbox" or request.get("scope_id_present") is not False
            or request.get("status") != 200):
        raise BuildControlError("Planar Airbox metadata request did not use the exact default airbox scope")
    meta, evidence = value.get("meta"), value.get("evidence")
    if not isinstance(meta, Mapping) or not isinstance(evidence, Mapping):
        raise BuildControlError("Planar Airbox evidence omitted metadata or rendered field evidence")
    source = meta.get("source")
    if (not isinstance(source, Mapping) or source.get("kind") != "default"
            or meta.get("scope_kind") != "airbox"
            or not isinstance(meta.get("etag"), str) or not meta["etag"]
            or not isinstance(meta.get("sample_token"), str) or not meta["sample_token"]
            or evidence.get("sampleToken") != meta.get("sample_token")
            or evidence.get("metaIdentity") != meta.get("etag")
            or evidence.get("scalarIdentity") != meta.get("etag")
            or evidence.get("quantityId") != "H_demag"
            or evidence.get("sourceKind") != "default" or evidence.get("sourceId") != "default"
            or evidence.get("component") != "magnitude"):
        raise BuildControlError("Planar Airbox sample token, raster, or metadata identity differs")
    raster = evidence.get("raster")
    if (not isinstance(raster, Mapping) or not isinstance(raster.get("checksum"), str)
            or not raster["checksum"] or type(raster.get("sampleCount")) is not int
            or raster["sampleCount"] <= 0 or type(evidence.get("glyphCount")) is not int
            or evidence["glyphCount"] < 0):
        raise BuildControlError("Planar Airbox raster evidence is missing or malformed")
    for key in ("min", "max"):
        number = raster.get(key)
        if type(number) not in (int, float) or not math.isfinite(number):
            raise BuildControlError("Planar Airbox raster range is non-finite")
    if raster["min"] > raster["max"]:
        raise BuildControlError("Planar Airbox raster range is inverted")
    layout = value.get("domain_layout")
    airbox = layout.get("airbox") if isinstance(layout, Mapping) else None
    if (not isinstance(layout, Mapping) or layout.get("schema_version") != "fdm-multilayer-layout.v1"
            or layout.get("available") is not True or layout.get("backend") != "fdm_multilayer"
            or layout.get("domain_generation_id") != evidence.get("domainGenerationId")
            or not isinstance(airbox, Mapping) or airbox.get("carrier_available") is not True
            or airbox.get("h_demag_available") is not True or airbox.get("target_only") is not True):
        raise BuildControlError("Planar Airbox frame has no current authoritative multilayer Airbox layout")
    cells, origin, spacing = airbox.get("cells"), airbox.get("origin_m"), airbox.get("cell_size_m")
    if (not isinstance(cells, list) or len(cells) != 3
            or any(type(item) is not int or item <= 0 for item in cells)
            or not isinstance(origin, list) or len(origin) != 3
            or not isinstance(spacing, list) or len(spacing) != 3
            or any(type(item) not in (int, float) or not math.isfinite(item) for item in origin + spacing)
            or any(item <= 0 for item in spacing)):
        raise BuildControlError("Authoritative multilayer Airbox grid is malformed")
    frame = meta.get("frame")
    plane = evidence.get("defaultPlane")
    fraction = evidence.get("positionFraction")
    operator_kind = evidence.get("operatorKind")
    if (not isinstance(frame, Mapping) or plane not in {"xy", "xz", "yz"}
            or type(fraction) not in (int, float) or not math.isfinite(fraction) or not 0 <= fraction <= 1
            or operator_kind not in {"plane_sample", "slab_average"}):
        raise BuildControlError("Planar Airbox default slice frame identity is malformed")
    normal_axis, u_axis, v_axis = {
        "xy": (2, 0, 1), "xz": (1, 0, 2), "yz": (0, 1, 2),
    }[plane]
    bounds = [[origin[axis], origin[axis] + cells[axis] * spacing[axis]] for axis in range(3)]
    midpoints = [(minimum + maximum) * 0.5 for minimum, maximum in bounds]
    continuous = bounds[normal_axis][0] + fraction * (bounds[normal_axis][1] - bounds[normal_axis][0])
    expected_coordinate = continuous
    if operator_kind == "plane_sample":
        count = cells[normal_axis]
        scaled = fraction * count
        index = min(max(math.ceil(scaled) - 1, 0), count - 1)
        expected_coordinate = origin[normal_axis] + (index + 0.5) * spacing[normal_axis]
    expected_origin = list(midpoints)
    expected_origin[normal_axis] = expected_coordinate
    expected_bounds_uv = [
        -0.5 * (bounds[u_axis][1] - bounds[u_axis][0]),
        0.5 * (bounds[u_axis][1] - bounds[u_axis][0]),
        -0.5 * (bounds[v_axis][1] - bounds[v_axis][0]),
        0.5 * (bounds[v_axis][1] - bounds[v_axis][0]),
    ]
    expected_axes = {
        "xy": ([1, 0, 0], [0, 1, 0], [0, 0, 1]),
        "xz": ([1, 0, 0], [0, 0, 1], [0, -1, 0]),
        "yz": ([0, 1, 0], [0, 0, 1], [1, 0, 0]),
    }[plane]
    for key, expected in (("origin_m", expected_origin), ("bounds_uv_m", expected_bounds_uv),
                          ("u_axis", expected_axes[0]), ("v_axis", expected_axes[1]),
                          ("normal", expected_axes[2])):
        actual = frame.get(key)
        if (not isinstance(actual, list) or len(actual) != len(expected)
                or any(type(item) not in (int, float) or not math.isfinite(item) for item in actual)
                or any(not math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-18)
                       for a, b in zip(actual, expected))):
            raise BuildControlError(f"Planar Airbox {key} differs from the authoritative Airbox frame")
    canvas = value.get("canvas")
    if (not isinstance(canvas, Mapping) or canvas.get("visible") is not True
            or canvas.get("non_transparent") is not True
            or type(canvas.get("width")) is not int or canvas["width"] <= 0
            or type(canvas.get("height")) is not int or canvas["height"] <= 0):
        raise BuildControlError("Planar Airbox browser canvas is not visibly rendered")
    screenshot = value.get("screenshot")
    _validate_canvas_screenshot(screenshot)
    if not isinstance(screenshot, Mapping) or screenshot.get("state") != "captured":
        raise BuildControlError("Planar Airbox browser screenshot is missing")
    if (value.get("presentation_restored") is not True
            or value.get("blocked_mutation_count") != 0
            or value.get("no_computation_or_monitor_mutations") is not True):
        raise BuildControlError("Planar Airbox browser scenario changed or attempted a non-presentation resource")


def _parse_result(
    output: bytes,
    public_url: str,
    browser_url: str,
    canvas_only: bool = False,
    expect_live_field: str | None = None,
    expect_airbox_vectors: bool = False,
    expect_ambiguous_compute_fields: bool = False,
    expect_fem_airbox_vectors: bool = False,
    expect_terminal_telemetry: bool = False,
    terminal_telemetry_helper_sha256: str | None = None,
    expect_run_performance: bool = False,
    run_performance_harness_sha256: str | None = None,
    expect_planar_airbox: bool = False,
    planar_airbox_harness_sha256: str | None = None,
    planar_field_evidence_sha256: str | None = None,
) -> dict[str, object]:
    text = output.decode("utf-8", "replace")
    payload = None
    for line in reversed(text.splitlines()):
        if not line.strip():
            continue
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if not isinstance(payload, dict):
        raise BuildControlError("Browser helper did not emit one JSON result")
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
        raise BuildControlError("Browser helper result exceeds its bounded evidence budget")
    if payload.get("schema") != RESULT_SCHEMA or payload.get("state") != "passed":
        raise BuildControlError("Browser helper reported a failed or unknown browser result")
    if payload.get("public_url") != public_url:
        raise BuildControlError("Browser helper public URL differs from the selected loopback port")
    if payload.get("probe_url") != browser_url:
        raise BuildControlError("Browser helper did not use the selected private frontend service")
    if payload.get("playwright_version") != PLAYWRIGHT_VERSION:
        raise BuildControlError("Browser helper Playwright version differs from the lock pin")
    if payload.get("browser_gpu_mode") != "swiftshader-webgl-requested":
        raise BuildControlError("Browser helper did not report the pinned SwiftShader browser mode")
    if type(payload.get("canvas_only")) is not bool or payload["canvas_only"] is not canvas_only:
        raise BuildControlError("Browser helper canvas-only mode differs from the admitted operation")
    run_performance_expectation = payload.get("expect_run_performance", False)
    if (type(run_performance_expectation) is not bool
            or run_performance_expectation is not expect_run_performance):
        raise BuildControlError("Browser helper run performance expectation differs from the admitted operation")
    if (payload.get("expect_live_field") != expect_live_field
            or type(payload.get("expect_airbox_vectors")) is not bool
            or payload["expect_airbox_vectors"] is not expect_airbox_vectors):
        raise BuildControlError("Browser helper live-field expectation differs from the admitted operation")
    planar_expectation = payload.get("expect_planar_airbox", False)
    if type(planar_expectation) is not bool or planar_expectation is not expect_planar_airbox:
        raise BuildControlError("Browser helper Planar Airbox expectation differs from the admitted operation")
    fem_expectation = payload.get("expect_fem_airbox_vectors", False)
    if type(fem_expectation) is not bool or fem_expectation is not expect_fem_airbox_vectors:
        raise BuildControlError("Browser helper FEM Airbox expectation differs from the admitted operation")
    if "expect_ambiguous_compute_fields" not in payload:
        if expect_ambiguous_compute_fields:
            raise BuildControlError("Browser helper omitted the enabled ambiguous-command expectation")
    elif (type(payload["expect_ambiguous_compute_fields"]) is not bool
            or payload["expect_ambiguous_compute_fields"] is not expect_ambiguous_compute_fields):
        raise BuildControlError("Browser helper ambiguous-command expectation differs from the admitted operation")
    if expect_live_field is not None and not canvas_only:
        raise BuildControlError("Live-field result is outside the canvas-only QA scope")
    if expect_airbox_vectors and expect_live_field is None:
        raise BuildControlError("Airbox-vector result omitted its expected live field")
    if expect_fem_airbox_vectors and (
        not canvas_only or expect_live_field != "m" or expect_airbox_vectors
        or expect_ambiguous_compute_fields or expect_terminal_telemetry
    ):
        raise BuildControlError("FEM Airbox result is outside its canvas-only primary-m scenario")
    if expect_terminal_telemetry and (
        not canvas_only or expect_live_field != "m" or expect_airbox_vectors
        or expect_fem_airbox_vectors or expect_ambiguous_compute_fields
    ):
        raise BuildControlError("Terminal telemetry result is outside its canvas-only primary-m scenario")
    if expect_run_performance and (
        not canvas_only or expect_live_field is not None or expect_airbox_vectors
        or expect_fem_airbox_vectors or expect_ambiguous_compute_fields or expect_terminal_telemetry
    ):
        raise BuildControlError("Run performance result is outside standalone canvas-only QA scope")
    if expect_planar_airbox and (
        not canvas_only or expect_live_field != "m" or expect_airbox_vectors
        or expect_fem_airbox_vectors or expect_ambiguous_compute_fields
        or expect_terminal_telemetry or expect_run_performance
    ):
        raise BuildControlError("Planar Airbox result is outside its canvas-only primary-m scenario")
    if expect_ambiguous_compute_fields and not canvas_only:
        raise BuildControlError("Ambiguous Compute Fields result is outside canvas-only QA scope")
    expected_scope = (
        "canvas-home-planar-airbox" if expect_planar_airbox else
        "canvas-engine-run-performance" if expect_run_performance else
        "canvas-home-ambiguous-compute-fields" if expect_ambiguous_compute_fields else
        "canvas-home-fem-airbox-vectors" if expect_fem_airbox_vectors else
        "canvas-home-live-field-airbox" if expect_airbox_vectors else
        "canvas-home-live-field" if expect_live_field is not None else
        "canvas-home-only" if canvas_only else
        "full-browser-qa"
    )
    if payload.get("qa_scope") != expected_scope:
        raise BuildControlError("Browser helper QA scope differs from the admitted operation")
    if expect_run_performance:
        expected_skipped = [*CANVAS_ONLY_SKIPPED_AREAS, RUN_PERFORMANCE_VIEWPORT_DOM_SKIPPED_AREA]
    elif canvas_only:
        expected_skipped = CANVAS_ONLY_SKIPPED_AREAS
    else:
        expected_skipped = []
    if payload.get("skipped_areas") != expected_skipped:
        raise BuildControlError("Browser helper skipped-area declaration differs from its QA scope")
    if payload.get("home_round_trip") is not True:
        raise BuildControlError("Browser helper did not prove the Home round trip")
    _validate_session_result(payload.get("session"))
    workspace = payload.get("workspace")
    if (not isinstance(workspace, Mapping) or workspace.get("visible") is not True
            or workspace.get("canvas_dom_stable") is not True):
        raise BuildControlError("Browser helper did not prove a visible, stable workspace canvas")
    _validate_canvas_result(payload.get("canvas_before"), "before Home")
    _validate_canvas_result(payload.get("canvas_after"), "after Home")
    _validate_viewport_dom_observations(
        payload.get("viewport_dom_observations"),
        performance_scope_only=expect_run_performance,
    )
    if expect_live_field is not None:
        _validate_live_field_observation(
            payload.get("live_field_observation"), expect_live_field, expect_airbox_vectors
        )
        _validate_canvas_screenshot(payload.get("canvas_screenshot"))
    elif payload.get("live_field_observation") is not None or payload.get("canvas_screenshot") is not None:
        raise BuildControlError("Browser helper reported an unrequested live-field observation")
    if expect_fem_airbox_vectors:
        _validate_fem_airbox_vector_observation(
            payload.get("fem_airbox_observation"), payload.get("session")
        )
    elif payload.get("fem_airbox_observation") is not None:
        raise BuildControlError("Browser helper reported unrequested FEM Airbox vector evidence")
    if expect_terminal_telemetry:
        if payload.get("expect_terminal_telemetry") is not True:
            raise BuildControlError("Browser helper omitted the enabled terminal telemetry flag")
        if (not isinstance(terminal_telemetry_helper_sha256, str)
                or not SHA256_RE.fullmatch(terminal_telemetry_helper_sha256)):
            raise BuildControlError("Terminal telemetry selected-source helper hash is missing")
        harness_hashes = payload.get("harness_source_sha256")
        if (not isinstance(harness_hashes, Mapping)
                or harness_hashes.get("algorithm") != "sha256"
                or harness_hashes.get("unchanged") is not True
                or harness_hashes.get("terminal_telemetry_helper_before") != terminal_telemetry_helper_sha256
                or harness_hashes.get("terminal_telemetry_helper_after") != terminal_telemetry_helper_sha256):
            raise BuildControlError("Terminal telemetry helper source hash differs or changed during browser QA")
        _validate_terminal_telemetry(
            payload.get("terminal_telemetry"), payload["session"],
            public_url=public_url, document_url=payload.get("final_url"),
        )
    elif ("expect_terminal_telemetry" in payload or "terminal_telemetry" in payload
            or terminal_telemetry_helper_sha256 is not None):
        raise BuildControlError("Browser helper reported an unrequested terminal telemetry proof")
    if expect_run_performance:
        harness_hashes = payload.get("harness_source_sha256")
        if (not isinstance(run_performance_harness_sha256, str)
                or not SHA256_RE.fullmatch(run_performance_harness_sha256)
                or not isinstance(harness_hashes, Mapping)
                or harness_hashes.get("algorithm") != "sha256"
                or harness_hashes.get("unchanged") is not True
                or harness_hashes.get("runner_before") != run_performance_harness_sha256
                or harness_hashes.get("runner_after") != run_performance_harness_sha256):
            raise BuildControlError("Run performance browser harness source pin differs or changed during QA")
        _validate_run_performance_browser_proof(
            payload.get("run_performance"), payload.get("session"), run_performance_harness_sha256,
        )
    elif ("run_performance" in payload or run_performance_harness_sha256 is not None):
        raise BuildControlError("Browser helper reported an unrequested run performance proof")
    if expect_planar_airbox:
        harness_hashes = payload.get("harness_source_sha256")
        if (not isinstance(planar_airbox_harness_sha256, str)
                or not SHA256_RE.fullmatch(planar_airbox_harness_sha256)
                or not isinstance(planar_field_evidence_sha256, str)
                or not SHA256_RE.fullmatch(planar_field_evidence_sha256)
                or not isinstance(harness_hashes, Mapping)
                or harness_hashes.get("algorithm") != "sha256"
                or harness_hashes.get("unchanged") is not True
                or harness_hashes.get("runner_before") != planar_airbox_harness_sha256
                or harness_hashes.get("runner_after") != planar_airbox_harness_sha256
                or harness_hashes.get("planar_field_evidence_before") != planar_field_evidence_sha256
                or harness_hashes.get("planar_field_evidence_after") != planar_field_evidence_sha256):
            raise BuildControlError("Planar Airbox browser source pin differs or changed during QA")
        _validate_planar_airbox_observation(
            payload.get("planar_airbox_observation"), payload.get("session"),
        )
    elif ("planar_airbox_observation" in payload
          or planar_airbox_harness_sha256 is not None
          or planar_field_evidence_sha256 is not None):
        raise BuildControlError("Browser helper reported an unrequested Planar Airbox proof")
    ambiguous_submission = payload.get("ambiguous_command_submission")
    if expect_ambiguous_compute_fields:
        _validate_ambiguous_command_submission(ambiguous_submission, payload.get("session"))
        _validate_canvas_result(payload.get("canvas_after_compute_fields"), "after Compute Fields")
    elif ambiguous_submission is not None:
        raise BuildControlError("Browser helper reported an unrequested ambiguous command submission")
    elif payload.get("canvas_after_compute_fields") is not None:
        raise BuildControlError("Browser helper reported an unrequested post-command canvas check")
    for key in ("page_errors", "console_errors", "request_failures"):
        if type(payload.get(key)) is not int or payload[key] != 0:
            raise BuildControlError(f"Browser helper reported {key}; result is not valid evidence")
    if payload.get("http_errors") != []:
        raise BuildControlError("Browser helper reported HTTP errors; result is not valid evidence")
    if "expected_console_errors" not in payload:
        if expect_ambiguous_compute_fields:
            raise BuildControlError("Browser helper omitted enabled response-loss console evidence")
        expected_console_errors = []
    else:
        expected_console_errors = payload["expected_console_errors"]
    if not isinstance(expected_console_errors, list) or len(expected_console_errors) > 1:
        raise BuildControlError("Browser helper expected-console-error evidence is malformed")
    if expected_console_errors:
        if not expect_ambiguous_compute_fields:
            raise BuildControlError("Browser helper suppressed a console error outside response-loss QA")
        dropped = ambiguous_submission.get("expected_response_drop")
        console_error = expected_console_errors[0]
        if (not isinstance(dropped, Mapping) or not isinstance(console_error, Mapping)
                or console_error.get("url") != dropped.get("url")
                or console_error.get("message") != "Failed to load resource: net::ERR_CONNECTION_RESET"):
            raise BuildControlError("Browser helper expected console error does not match the exact dropped POST")
    if "expected_response_drops" not in payload:
        if expect_ambiguous_compute_fields:
            raise BuildControlError("Browser helper omitted enabled response-drop evidence")
        expected_drops = []
    else:
        expected_drops = payload["expected_response_drops"]
    if not isinstance(expected_drops, list):
        raise BuildControlError("Browser helper response-drop evidence is malformed")
    if not expect_ambiguous_compute_fields and expected_drops:
        raise BuildControlError("Browser helper reported an unrequested response drop")
    if expect_ambiguous_compute_fields:
        proof_drop = ambiguous_submission.get("expected_response_drop")
        if not isinstance(expected_drops, list) or expected_drops != [proof_drop]:
            raise BuildControlError("Browser helper response-drop list differs from the exact command proof")
    _validate_resource_responses(payload.get("resource_responses"))
    return payload


def _remove_helper(operation: dict[str, object], identifier: object) -> None:
    """Remove a completed helper only after its control evidence is durable."""
    operation["daemon_pending"] = True
    try:
        docker_capture("rm", str(identifier))
        remaining = docker_capture("inspect", str(identifier), allow_failure=True)
        if remaining.returncode == 0:
            raise ControlOutcomeUnknown("Browser helper remained after removal")
    except (BuildControlError, ControlOutcomeUnknown) as error:
        raise ControlOutcomeUnknown("Browser helper removal was not confirmed; resources retained") from error
    operation["daemon_pending"] = False


def _run(
    operation: dict[str, object],
    control: BuildControl,
    document: dict[str, object],
    identity: Mapping[str, str],
    selected: Path,
    frontend_volume: str,
    browser_image_id: str,
    public_url: str,
    browser_url: str,
    timeout: int,
    canvas_only: bool | None = False,
    expect_live_field: str | None = None,
    expect_airbox_vectors: bool = False,
    expect_ambiguous_compute_fields: bool = False,
    airbox_inspector: bool = False,
    airbox_inspector_script_sha256: str | None = None,
    saved_playback_item_id: str | None = None,
    source_script_sha256: str | None = None,
    expect_fem_airbox_vectors: bool = False,
    expect_terminal_telemetry: bool = False,
    terminal_telemetry_helper_sha256: str | None = None,
    expect_run_performance: bool = False,
    run_performance_harness_sha256: str | None = None,
    private_group_storage: bool = False,
    expect_planar_airbox: bool = False,
    planar_airbox_harness_sha256: str | None = None,
    planar_field_evidence_sha256: str | None = None,
    inspector_ack: bool = False,
    inspector_ack_source_sha256: Mapping[str, str] | None = None,
    study_stage_rerun: str | None = None,
    study_stage_rerun_source_sha256: Mapping[str, str] | None = None,
    study_stage_rerun_resume_evidence: Mapping[str, object] | None = None,
) -> None:
    root = operation["root"]
    helper_name = "fullmag-browser-qa-" + operation["receipt"]["attempt"][:12]
    control.write(root + "/compose.json", document)
    public_probe = _probe_public_loopback(public_url, min(timeout, 30))
    control.write(root + "/public-loopback-probe.json", public_probe)
    if public_probe["state"] != "passed":
        error = "Host-published frontend loopback probe failed"
        operation["receipt"].update(state="failed-confirmed", public_url=public_url, error=error)
        control.write(root + "/receipt.json", operation["receipt"])
        raise BuildControlError(error)
    operation["receipt"].update(
        state="running",
        browser_container_name=helper_name,
        browser_image_id=browser_image_id,
        public_url=public_url,
        browser_url=browser_url,
    )
    control.write(root + "/receipt.json", operation["receipt"])
    operation["daemon_pending"] = True
    try:
        result = docker_capture(
            "compose",
            "--project-name",
            control.project,
            "--ansi",
            "never",
            "-f",
            "-",
            "run",
            "-T",
            "--no-deps",
            "--name",
            helper_name,
            "browser-qa",
            data=canonical(document),
            # The Node helper owns its own bounded timeout. Leave it a minute
            # to flush the result and stop before the outer Docker capture ends.
            timeout=timeout + 60,
            allow_failure=True,
        )
    except ControlOutcomeUnknown:
        raise
    # Preserve untrusted output before validating the exited helper. A failed
    # mount/identity check must not discard the only evidence of a possible POST.
    raw = result.stdout
    control.write(root + "/runner-output.json", {
        "schema": "fullmag.docker-dev-browser-qa-runner-output.v1",
        "exit_code": result.returncode,
        "stdout": _text(result.stdout, MAX_RESULT_BYTES),
        "stderr_tail": _text(result.stderr),
    })
    # Keep resources quarantined until the helper identity, result, durable
    # control-volume evidence, and explicit removal have all been observed.
    observed = _inspect(helper_name)
    _validate_browser_helper(observed, control, identity, frontend_volume, browser_image_id, result.returncode, selected,
        canvas_only=canvas_only,
        expect_live_field=expect_live_field if expect_live_field is not None else None,
        expect_airbox_vectors=expect_airbox_vectors if expect_live_field is not None else None,
        expect_fem_airbox_vectors=(True if expect_fem_airbox_vectors else None),
        expect_terminal_telemetry=(True if expect_terminal_telemetry else None),
        expect_run_performance=(True if expect_run_performance else None),
        expect_ambiguous_compute_fields=(
            expect_ambiguous_compute_fields
            if not airbox_inspector and not inspector_ack and saved_playback_item_id is None
            and study_stage_rerun is None
            else None
        ),
        airbox_inspector=airbox_inspector,
        inspector_ack=inspector_ack,
        inspector_ack_source_sha256=inspector_ack_source_sha256,
        study_stage_rerun=study_stage_rerun,
        study_stage_rerun_source_sha256=study_stage_rerun_source_sha256,
        study_stage_rerun_resume_evidence=study_stage_rerun_resume_evidence,
        saved_playback_item_id=saved_playback_item_id,
        source_script_sha256=source_script_sha256,
        expect_planar_airbox=expect_planar_airbox,
        private_group_storage=private_group_storage)
    if observed["Config"].get("Cmd") != document["services"]["browser-qa"]["command"]:
        raise ControlOutcomeUnknown("Browser helper command differs from the admitted Compose harness")
    operation["receipt"]["browser_container_id"] = observed["Id"]
    control.write(root + "/receipt.json", operation["receipt"])
    operation["daemon_pending"] = True
    try:
        if saved_playback_item_id is not None:
            if not source_script_sha256:
                raise BuildControlError("Saved Playback helper source hash is missing")
            payload = _parse_saved_playback_result(
                raw, public_url, browser_url, saved_playback_item_id, source_script_sha256,
            )
        elif inspector_ack:
            payload = _parse_inspector_ack_result(raw, public_url, browser_url, inspector_ack_source_sha256)
        elif study_stage_rerun is not None:
            payload = _parse_study_stage_rerun_result(
                raw, public_url, browser_url, study_stage_rerun_source_sha256, study_stage_rerun,
                expected_resume_evidence=study_stage_rerun_resume_evidence,
            )
            if payload.get("outcome") == "unknown" and result.returncode == 0:
                raise BuildControlError("Study stage rerun helper returned success with an unknown command outcome")
        elif airbox_inspector:
            if not airbox_inspector_script_sha256:
                raise BuildControlError("Airbox Inspector helper source hash is missing")
            payload = _parse_airbox_inspector_result(
                raw, public_url, browser_url, airbox_inspector_script_sha256
            )
        else:
            payload = _parse_result(raw, public_url, browser_url, canvas_only=canvas_only,
                expect_live_field=expect_live_field, expect_airbox_vectors=expect_airbox_vectors,
                expect_ambiguous_compute_fields=expect_ambiguous_compute_fields,
                expect_fem_airbox_vectors=expect_fem_airbox_vectors,
                expect_terminal_telemetry=expect_terminal_telemetry,
                terminal_telemetry_helper_sha256=terminal_telemetry_helper_sha256,
                expect_run_performance=expect_run_performance,
                run_performance_harness_sha256=run_performance_harness_sha256,
                expect_planar_airbox=expect_planar_airbox,
                planar_airbox_harness_sha256=planar_airbox_harness_sha256,
                planar_field_evidence_sha256=planar_field_evidence_sha256)
    except BuildControlError as error:
        study_no_dispatch_proven = (
            study_stage_rerun is not None
            and _study_stage_no_dispatch_proven(
                raw, study_stage_rerun_source_sha256, study_stage_rerun,
            )
        )
        control.write(root + "/result.json", {
            "schema": RESULT_SCHEMA,
            "state": "failed-confirmed",
            "exit_code": result.returncode,
            "stdout_tail": _text(result.stdout),
            "stderr_tail": _text(result.stderr),
            "error": str(error),
            **({"inspector_ack_restoration": "unknown", "requires_object_readback": True} if inspector_ack else {}),
            **({"study_stage_rerun_native_outcome": "not-dispatched"}
               if study_no_dispatch_proven else {}),
            **({"study_stage_rerun_native_outcome": "unknown", "requires_current_run_readback": True}
               if study_stage_rerun is not None and not study_no_dispatch_proven else {}),
        })
        _remove_helper(operation, observed["Id"])
        operation["receipt"].update(state="failed-confirmed", error=str(error), exit_code=result.returncode)
        raise
    if result.returncode != 0:
        payload = {
            **payload,
            "state": "failed-confirmed",
            "error": "Browser helper exited before a passing public terminal proof",
            **({"study_stage_rerun_native_outcome": "unknown", "requires_current_run_readback": True}
               if study_stage_rerun is not None and payload.get("outcome") == "unknown" else {}),
        }
    control.write(root + "/result.json", payload)
    if result.returncode != 0:
        _remove_helper(operation, observed["Id"])
        operation["receipt"].update(state="failed-confirmed", error="Browser helper exit code was non-zero", exit_code=result.returncode)
        raise BuildControlError("Browser helper exited with a non-zero status")
    _remove_helper(operation, observed["Id"])
    operation["receipt"].update(state="succeeded", exit_code=0, result_schema=payload["schema"])
    operation["daemon_pending"] = False


def _assert_no_qa_controller(selected):
    """Require host /proc visibility; a sandbox PID namespace cannot prove absence."""
    proc = Path("/proc")
    if (not proc.is_dir() or b"codex-linux-sandbox" in (proc / "1/cmdline").read_bytes()):
        raise BuildControlError("Prestart QA reconciliation requires the full host /proc view")
    count = 0
    for path in proc.iterdir():
        if not path.name.isdigit() or int(path.name) == os.getpid():
            continue
        count += 1
        if count > 65536:
            raise BuildControlError("Host controller inventory exceeds its bound")
        try:
            argv = [value.decode("utf-8", "strict") for value in (path / "cmdline").read_bytes().split(b"\0") if value]
        except FileNotFoundError:
            continue
        except (OSError, UnicodeError) as error:
            raise BuildControlError("Host QA controller absence cannot be proven") from error
        if argv and Path(argv[0]).name.startswith("python") and any(
                Path(value).name == "docker_dev_browser_qa.py" for value in argv[1:]):
            source = None
            for flag in ("--source-root", "--repo-root"):
                if flag in argv and argv.index(flag) + 1 < len(argv):
                    source = argv[argv.index(flag) + 1]
                    break
            if source is None or Path(source).resolve() == selected:
                raise BuildControlError("A host QA controller still owns the selected source")


def _probe_prestart_browser_qa(control, selected, identity, args, receipt, helper_id, *, cache_project_id):
    from docker_volume_activation_reconcile import _control_bytes, _probe_helper_absence
    _assert_no_qa_controller(selected)
    root = "browser-qa/attempts/" + args.reconcile_attempt
    if any(key in receipt for key in ("browser_container_name", "browser_container_id", "exit_code")):
        raise BuildControlError("Prestart receipt contains browser launch/exit evidence")
    for name in ("terminal.json", "result.json", "public-loopback-probe.json"):
        if _control_bytes(control, root + "/" + name, optional=True) is not None:
            raise BuildControlError("Prestart QA already has execution or terminal evidence")
    current, backend_id, frontend_id, volume, frontend_inputs = _read_live_development(control, selected, identity, args.port)
    inputs = receipt["inputs"]
    if (current.get("attempt") != inputs.get("development_attempt")
            or current.get("config_sha256") != inputs.get("development_config_sha256")
            or frontend_id != inputs.get("frontend_container")
            or volume != inputs.get("frontend_volume")
            or hashlib.sha256(canonical(frontend_inputs)).hexdigest() != inputs.get("frontend_inputs_sha256")):
        raise BuildControlError("Prestart QA session services changed since admission")
    frontend = _inspect(frontend_id)
    _validate_frontend(frontend, control, identity, volume, current, args.port,
        cache_project_id=cache_project_id)
    backend = _inspect(backend_id)
    from docker_volume_dev import _validate_retained_service
    development_compose = control.read("development/attempts/" + current["attempt"] + "/compose.json")
    image = _inspect_image(backend["Image"])
    _validate_retained_service(development_compose, backend, "backend", image["Config"],
        expected_started_at=current.get("backend_started_at"))
    validate_source_labels(backend, identity)
    helper = _inspect(helper_id)
    pins = {}
    for service, observed in (("backend", backend), ("frontend", frontend), ("helper", helper)):
        if observed.get("ExecIDs") not in (None, []):
            raise BuildControlError("A selected QA/session container still has an active Docker exec")
        state = observed.get("State", {})
        if state.get("Running") is not True:
            raise BuildControlError("Prestart QA requires unchanged running session services and helper")
        pins[service] = {"id": observed["Id"], "image": observed["Image"],
            "started_at": state.get("StartedAt"), "pid": state.get("Pid"),
            "config_sha256": hashlib.sha256(canonical(observed["Config"])).hexdigest(),
            "host_config_sha256": hashlib.sha256(canonical(observed["HostConfig"])).hexdigest(),
            "mounts_sha256": hashlib.sha256(canonical(observed["Mounts"])).hexdigest()}
    browser_name = "fullmag-browser-qa-" + args.reconcile_attempt[:12]
    absence = _probe_helper_absence(browser_name)
    if absence is None:
        raise BuildControlError("Prestart QA browser name exists; no release permitted")
    listed = docker_capture("ps", "--all", "--no-trunc", "--filter",
        "label=com.docker.compose.project=" + control.project, "--format", "{{.ID}}", timeout=30)
    if set(listed.stdout.decode().split()) != {backend_id, frontend_id, helper_id}:
        raise BuildControlError("Prestart QA group has a browser or unknown container")
    return {"schema": "fullmag.browser-qa-prestart-absence.v1", "browser_state": "NOT RUN",
            "browser_name_absence_sha256": absence, "host_controllers": [], "service_pins": pins,
            "development_fence_sha256": current["development_fence_sha256"]}


def _reconcile_prestart_qa(control, selected, identity, args, receipt, helper_id, helper_log, *, cache_project_id):
    from docker_volume_activation_reconcile import _control_bytes, _wait_for_helper_exit
    root = "browser-qa/attempts/" + args.reconcile_attempt
    before = _probe_prestart_browser_qa(control, selected, identity, args, receipt, helper_id, cache_project_id=cache_project_id)
    if _probe_prestart_browser_qa(control, selected, identity, args, receipt, helper_id, cache_project_id=cache_project_id) != before:
        raise BuildControlError("Prestart QA absence/session proof changed")
    terminal = {**receipt, "state": "failed-confirmed", "browser_state": "NOT RUN",
        "error": "Host controller lost before browser launch; browser QA was not run",
        "verification": "NOT VERIFIED", "finished_at": time.time(),
        "prestart_reconciliation": {**before, "helper_id": helper_id, "helper_log": helper_log,
            "receipt_sha256": args.expected_receipt_sha256, "compose_sha256": args.expected_compose_sha256}}
    payload = canonical(terminal) + b"\n"
    path = control.path(root + "/terminal.json")
    script = ("set -eu; test \"$(cat /control/active)\" = '" + args.reconcile_attempt + "'; "
        "test \"$(sha256sum '" + control.path(root + "/receipt.json") + "' | cut -d' ' -f1)\" = '" + args.expected_receipt_sha256 + "'; "
        "test \"$(sha256sum '" + control.path(root + "/compose.json") + "' | cut -d' ' -f1)\" = '" + args.expected_compose_sha256 + "'; "
        "test ! -e '" + path + "'; umask 027; t=$(mktemp '" + control.path(root) + "/.prestart.XXXXXXXX'); "
        "trap 'rm -f -- \"$t\"' EXIT; cat > \"$t\"; sync \"$t\"; mv -T -- \"$t\" '" + path + "'; sync '" + control.path(root) + "'")
    from docker_build_control import bounded_capture
    result = bounded_capture(control.helper_args(script), data=payload, timeout=90)
    if result.returncode:
        raise ControlOutcomeUnknown("Prestart QA terminal publication was not confirmed")
    _wait_for_helper_exit(helper_id)
    if _control_bytes(control, "active", optional=True) is not None:
        raise ControlOutcomeUnknown("Prestart QA original helper did not release its lease")
    mirror_console(json.dumps({"state": "failed-confirmed", "attempt": args.reconcile_attempt,
        "browser_state": "NOT RUN", "lease_released": True, "verification": "NOT VERIFIED"}) + "\n")


def reconcile_browser_qa(control, selected, identity, args, *, cache_project_id=None):
    """Close one stopped, failed QA attempt; never infer a successful proof."""
    from docker_volume_activation_reconcile import (
        _control_bytes, _probe_helper_absence, _validate_helper,
        _validate_helper_logged, _wait_for_helper_exit,
    )
    attempt = args.reconcile_attempt
    prestart = bool(getattr(args, "reconcile_prestart", False))
    if prestart and (not isinstance(cache_project_id, str) or not cache_project_id):
        raise BuildControlError("Prestart reconciliation requires the resolver's cache project identity")
    if not re.fullmatch(r"[0-9a-f]{32}", attempt or ""):
        raise BuildControlError("QA reconciliation requires a full attempt UUID")
    for value in (args.expected_receipt_sha256, args.expected_compose_sha256):
        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
            raise BuildControlError("QA reconciliation requires exact receipt and Compose hashes")
    if prestart and args.expected_browser_id is not None:
        raise BuildControlError("Prestart reconciliation cannot consume a browser container pin")
    for value in ((args.expected_helper_id,) if prestart else (args.expected_browser_id, args.expected_helper_id)):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise BuildControlError("QA reconciliation requires full container IDs")
    root = "browser-qa/attempts/" + attempt
    active_raw = _control_bytes(control, "active", optional=True)
    retained_terminal = control.read(root + "/terminal.json", optional=True)
    already_released = active_raw is None
    if prestart and (already_released or retained_terminal is not None):
        raise BuildControlError("Prestart reconciliation requires its still-held original lease without terminal")
    if ((already_released and not isinstance(retained_terminal, Mapping))
            or (not already_released and active_raw != (attempt + "\n").encode())):
        raise BuildControlError("QA reconciliation active fence differs")
    receipt_raw = _control_bytes(control, root + "/receipt.json")
    compose_raw = _control_bytes(control, root + "/compose.json")
    if (hashlib.sha256(receipt_raw).hexdigest() != args.expected_receipt_sha256
            or hashlib.sha256(compose_raw).hexdigest() != args.expected_compose_sha256):
        raise BuildControlError("QA reconciliation evidence CAS differs")
    receipt, document = json.loads(receipt_raw), json.loads(compose_raw)
    if prestart and (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("control_namespace") != getattr(control, "namespace", None)
            or receipt.get("namespace_registry_sha256") != getattr(control, "namespace_registry_sha256", None)):
        raise BuildControlError("Prestart QA receipt schema/namespace differs")
    required = {"phase": "browser-qa", "attempt": attempt, "compose_project": control.project,
                "control_volume": control.volume, "state": "starting" if prestart else "outcome-unknown-resources-retained"}
    if any(receipt.get(key) != value for key, value in required.items()):
        raise BuildControlError("QA reconciliation receipt identity/outcome differs")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("QA reconciliation inputs are missing")
    if inputs.get("source_root") != str(selected) or inputs.get("worktree_id") != identity["worktree_id"]:
        raise BuildControlError("QA reconciliation source identity differs")
    private_group_marker = inputs.get("private_group_storage")
    if private_group_marker not in (None, "group-volume-v1"):
        raise BuildControlError("QA reconciliation private group storage profile is unsupported")
    private_group_storage = private_group_marker == "group-volume-v1"
    if private_group_storage and inputs.get("frontend_volume") != control.volume:
        raise BuildControlError("QA reconciliation frontend volume differs from its group profile")
    scenario = inputs.get("scenario", "standard")
    if scenario not in {"standard", "airbox-inspector", "saved-playback", "planar-airbox", "inspector-ack", "study-stage-rerun"}:
        raise BuildControlError("QA reconciliation scenario is unsupported")
    inspector_ack = scenario == "inspector-ack"
    study_stage_rerun = scenario == "study-stage-rerun"
    inspector_ack_sources = inputs.get("inspector_ack_source_sha256")
    study_stage_rerun_mode = inputs.get("study_stage_rerun")
    study_stage_rerun_sources = inputs.get("study_stage_rerun_source_sha256")
    study_stage_rerun_resume_evidence = None
    if inspector_ack:
        _validate_inspector_ack_hashes(inspector_ack_sources)
        if _inspector_ack_source_sha256(selected) != inspector_ack_sources:
            raise BuildControlError("QA reconciliation Inspector ACK proof sources changed")
        if (inputs.get("prepare_viewport_fixture") is not False or inputs.get("canvas_only") is not False
                or inputs.get("expect_live_field") is not None or inputs.get("expect_airbox_vectors") is not False
                or inputs.get("expect_fem_airbox_vectors", False) is not False
                or inputs.get("expect_terminal_telemetry") is not False or inputs.get("expect_run_performance") is not False
                or inputs.get("expect_ambiguous_compute_fields") is not False):
            raise BuildControlError("QA reconciliation Inspector ACK receipt includes another scenario")
    elif inspector_ack_sources is not None:
        raise BuildControlError("QA reconciliation Inspector ACK source pins have another scenario")
    if study_stage_rerun:
        if (study_stage_rerun_mode not in {"stage-b", "study", "material-stage-a", "fdm-cell-study",
                                           "fdm-cell-study-resume", "texture-stage-b", "texture-study"}
                or _study_stage_rerun_source_sha256(selected, study_stage_rerun_mode)
                != study_stage_rerun_sources):
            raise BuildControlError("QA reconciliation Study stage rerun mode/source pins differ")
        if study_stage_rerun_mode == "fdm-cell-study-resume":
            parent_attempt = inputs.get("fdm_grid_resume_parent_attempt")
            parent_record_hashes = inputs.get("fdm_grid_resume_parent_record_sha256")
            runtime_identity = {
                "source_commit": inputs.get("source_commit"),
                "runtime_terminal_sha256": inputs.get("runtime_terminal_sha256"),
                "attempt": inputs.get("development_attempt"),
                "config_sha256": inputs.get("development_config_sha256"),
                "runtime_attempt": inputs.get("runtime_attempt"),
                "runtime_phase": inputs.get("runtime_phase"),
                "development_terminal_state": inputs.get("development_terminal_state"),
            }
            study_stage_rerun_resume_evidence = _load_fdm_grid_resume_evidence(
                control, parent_attempt, selected=selected, current=runtime_identity, identity=identity,
                frontend_id=inputs.get("frontend_container"), frontend_volume=inputs.get("frontend_volume"),
                public_url=inputs.get("public_loopback_url"), browser_url=inputs.get("browser_url"),
                expected_sources=study_stage_rerun_sources, consumed_by=attempt,
            )
            if parent_record_hashes != study_stage_rerun_resume_evidence["record_sha256"]:
                raise BuildControlError("QA reconciliation FDM grid parent record pins differ")
        elif "fdm_grid_resume_parent_attempt" in inputs or "fdm_grid_resume_parent_record_sha256" in inputs:
            raise BuildControlError("QA reconciliation has unrequested FDM grid resume parent pins")
        if (inputs.get("prepare_viewport_fixture") is not False or inputs.get("canvas_only") is not False
                or inputs.get("expect_live_field") is not None or inputs.get("expect_airbox_vectors") is not False
                or inputs.get("expect_fem_airbox_vectors", False) is not False
                or inputs.get("expect_terminal_telemetry") is not False
                or inputs.get("expect_run_performance") is not False
                or inputs.get("expect_ambiguous_compute_fields") is not False
                or inputs.get("expect_planar_airbox") is not False):
            raise BuildControlError("QA reconciliation Study stage rerun receipt includes another scenario")
    elif study_stage_rerun_mode is not None or study_stage_rerun_sources is not None:
        raise BuildControlError("QA reconciliation has unrequested Study stage rerun pins")
    expect_planar_airbox_input = inputs.get("expect_planar_airbox", False)
    if type(expect_planar_airbox_input) is not bool:
        raise BuildControlError("QA reconciliation Planar Airbox expectation must be boolean")
    if expect_planar_airbox_input != (scenario == "planar-airbox"):
        raise BuildControlError("QA reconciliation Planar Airbox scenario identity differs")
    planar_airbox_harness_sha256 = None
    planar_field_evidence_sha256 = None
    if expect_planar_airbox_input:
        planar_airbox_harness_sha256 = inputs.get("planar_airbox_harness_sha256")
        planar_field_evidence_sha256 = inputs.get("planar_field_evidence_sha256")
        if (not isinstance(planar_airbox_harness_sha256, str)
                or not SHA256_RE.fullmatch(planar_airbox_harness_sha256)
                or _planar_airbox_harness_sha256(
                    selected, "apps/control-room/scripts/docker-dev-browser-qa.mjs"
                ) != planar_airbox_harness_sha256
                or not isinstance(planar_field_evidence_sha256, str)
                or not SHA256_RE.fullmatch(planar_field_evidence_sha256)
                or _planar_airbox_harness_sha256(
                    selected, "apps/control-room/scripts/lib/planar-field-evidence.mjs"
                ) != planar_field_evidence_sha256):
            raise BuildControlError("QA reconciliation Planar Airbox source pin differs")
    elif "planar_airbox_harness_sha256" in inputs or "planar_field_evidence_sha256" in inputs:
        raise BuildControlError("QA reconciliation has an unrequested Planar Airbox source pin")
    expect_fem_airbox_vectors_input = inputs.get("expect_fem_airbox_vectors", False)
    if type(expect_fem_airbox_vectors_input) is not bool:
        raise BuildControlError("QA reconciliation FEM Airbox-vector expectation must be boolean")
    expect_terminal_telemetry_input = inputs.get("expect_terminal_telemetry", False)
    if type(expect_terminal_telemetry_input) is not bool:
        raise BuildControlError("QA reconciliation terminal telemetry expectation must be boolean")
    expect_run_performance_input = inputs.get("expect_run_performance", False)
    if type(expect_run_performance_input) is not bool:
        raise BuildControlError("QA reconciliation run performance expectation must be boolean")
    terminal_telemetry_helper_sha256 = None
    if expect_terminal_telemetry_input:
        terminal_telemetry_helper_sha256 = inputs.get("terminal_telemetry_helper_sha256")
        if (not isinstance(terminal_telemetry_helper_sha256, str)
                or not SHA256_RE.fullmatch(terminal_telemetry_helper_sha256)
                or _terminal_telemetry_helper_sha256(selected) != terminal_telemetry_helper_sha256):
            raise BuildControlError("QA reconciliation terminal telemetry helper source pin differs")
    elif "terminal_telemetry_helper_sha256" in inputs:
        raise BuildControlError("QA reconciliation unrequested terminal telemetry helper source pin")
    run_performance_harness_sha256 = None
    if expect_run_performance_input:
        run_performance_harness_sha256 = inputs.get("run_performance_harness_sha256")
        if (not isinstance(run_performance_harness_sha256, str)
                or not SHA256_RE.fullmatch(run_performance_harness_sha256)
                or _run_performance_harness_sha256(selected) != run_performance_harness_sha256):
            raise BuildControlError("QA reconciliation run performance harness source pin differs")
    elif "run_performance_harness_sha256" in inputs:
        raise BuildControlError("QA reconciliation unrequested run performance harness source pin")
    if expect_fem_airbox_vectors_input and scenario != "standard":
        raise BuildControlError("QA reconciliation FEM Airbox-vector expectation has another scenario identity")
    saved_playback_item_id = None
    source_script_sha256 = None
    if scenario == "saved-playback":
        saved_playback_item_id = inputs.get("saved_playback_item_id")
        source_script_sha256 = inputs.get("source_script_sha256")
        if (not isinstance(saved_playback_item_id, str)
                or not re.fullmatch(r"[0-9]{1,20}", saved_playback_item_id)
                or not isinstance(source_script_sha256, str)
                or not SHA256_RE.fullmatch(source_script_sha256)):
            raise BuildControlError("QA reconciliation Saved Playback source identity is malformed")
        if _saved_playback_harness_sha256(selected) != source_script_sha256:
            raise BuildControlError("QA reconciliation Saved Playback harness source changed")
        if (inputs.get("prepare_viewport_fixture") is not False
                or inputs.get("canvas_only") is not False
                or inputs.get("expect_live_field") is not None
                or inputs.get("expect_airbox_vectors") is not False
                or inputs.get("expect_fem_airbox_vectors", False) is not False
                or inputs.get("expect_planar_airbox", False) is not False
                or inputs.get("expect_ambiguous_compute_fields") is not False):
            raise BuildControlError("QA reconciliation Saved Playback receipt includes another browser scenario")
    elif "saved_playback_item_id" in inputs or "source_script_sha256" in inputs:
        raise BuildControlError("QA reconciliation non-playback receipt contains Saved Playback identity")
    airbox_inspector = scenario == "airbox-inspector"
    prepare_viewport_fixture = inputs.get("prepare_viewport_fixture", False)
    if type(prepare_viewport_fixture) is not bool:
        raise BuildControlError("QA reconciliation viewport fixture input must be boolean")
    canvas_only_input = inputs.get("canvas_only", False)
    if type(canvas_only_input) is not bool:
        raise BuildControlError("QA reconciliation canvas-only input must be boolean")
    # Older receipts did not pin this option in Compose. Preserve their exact
    # recipe while interpreting the missing input as the legacy full flow.
    canvas_only_compose_pin = canvas_only_input if "canvas_only" in inputs else None
    has_live_field_input = "expect_live_field" in inputs
    has_airbox_input = "expect_airbox_vectors" in inputs
    if has_live_field_input != has_airbox_input:
        raise BuildControlError("QA reconciliation live-field expectation inputs are incomplete")
    if has_live_field_input:
        expect_live_field_input = inputs["expect_live_field"]
        expect_airbox_vectors_input = inputs["expect_airbox_vectors"]
        if (expect_live_field_input is not None
                and (not isinstance(expect_live_field_input, str)
                     or not expect_live_field_input
                     or expect_live_field_input != expect_live_field_input.strip()
                     or len(expect_live_field_input) > 512
                     or any(ord(character) < 32 or ord(character) == 127
                            for character in expect_live_field_input))):
            raise BuildControlError("QA reconciliation expected quantity id is malformed")
        if type(expect_airbox_vectors_input) is not bool:
            raise BuildControlError("QA reconciliation airbox-vector expectation must be boolean")
        if expect_live_field_input is None and expect_airbox_vectors_input:
            raise BuildControlError("QA reconciliation airbox expectation has no live-field quantity")
        if (expect_live_field_input is not None or expect_airbox_vectors_input) and not canvas_only_input:
            raise BuildControlError("QA reconciliation live-field expectation requires canvas-only scope")
        expect_live_field_compose_pin = expect_live_field_input
        expect_airbox_compose_pin = (
            expect_airbox_vectors_input if expect_live_field_input is not None else None
        )
    else:
        # Receipts predating live-field expectations retain their exact Compose recipe.
        expect_live_field_input = None
        expect_airbox_vectors_input = False
        expect_live_field_compose_pin = None
        expect_airbox_compose_pin = None
    has_ambiguous_command_input = "expect_ambiguous_compute_fields" in inputs
    if has_ambiguous_command_input:
        expect_ambiguous_command_input = inputs["expect_ambiguous_compute_fields"]
        if type(expect_ambiguous_command_input) is not bool:
            raise BuildControlError("QA reconciliation ambiguous-command expectation must be boolean")
        if expect_ambiguous_command_input and not canvas_only_input:
            raise BuildControlError("QA reconciliation ambiguous-command expectation requires canvas-only scope")
        expect_ambiguous_command_compose_pin = expect_ambiguous_command_input
    else:
        # Older receipts did not pin the optional response-loss scenario.
        expect_ambiguous_command_input = False
        expect_ambiguous_command_compose_pin = None
    expect_fem_airbox_compose_pin = True if expect_fem_airbox_vectors_input else None
    if expect_fem_airbox_vectors_input and (
        not canvas_only_input
        or prepare_viewport_fixture
        or expect_live_field_input != "m"
        or expect_airbox_vectors_input
        or expect_ambiguous_command_input
        or expect_terminal_telemetry_input
    ):
        raise BuildControlError("QA reconciliation FEM Airbox scenario does not match the primary-m canvas contract")
    if expect_terminal_telemetry_input and (
        scenario != "standard"
        or not canvas_only_input
        or prepare_viewport_fixture
        or expect_live_field_input != "m"
        or expect_airbox_vectors_input
        or expect_fem_airbox_vectors_input
        or expect_ambiguous_command_input
    ):
        raise BuildControlError("QA reconciliation terminal telemetry scenario does not match the primary-m canvas contract")
    if expect_run_performance_input and (
        scenario != "standard"
        or not canvas_only_input
        or prepare_viewport_fixture
        or expect_live_field_input is not None
        or expect_airbox_vectors_input
        or expect_fem_airbox_vectors_input
        or expect_ambiguous_command_input
        or expect_terminal_telemetry_input
    ):
        raise BuildControlError("QA reconciliation run performance scenario is outside standalone canvas-only scope")
    if expect_planar_airbox_input and (
        not canvas_only_input
        or prepare_viewport_fixture
        or expect_live_field_input != "m"
        or expect_airbox_vectors_input
        or expect_fem_airbox_vectors_input
        or expect_ambiguous_command_input
        or expect_terminal_telemetry_input
        or expect_run_performance_input
    ):
        raise BuildControlError("QA reconciliation Planar Airbox scenario differs from canvas-only m scope")
    if canvas_only_input and prepare_viewport_fixture:
        raise BuildControlError("Canvas-only browser QA receipt cannot prepare a viewport fixture")
    expected_document = _compose_document(selected, identity, inputs["browser_image"],
        inputs["frontend_volume"], args.port, inputs["browser_runtime_timeout"],
        prepare_viewport_fixture=prepare_viewport_fixture,
        canvas_only=(None if scenario == "saved-playback" or airbox_inspector or inspector_ack
                     or study_stage_rerun else canvas_only_compose_pin),
        expect_live_field=(None if scenario == "saved-playback" else expect_live_field_compose_pin),
        expect_airbox_vectors=(None if scenario == "saved-playback" else expect_airbox_compose_pin),
        expect_fem_airbox_vectors=(
            None if scenario != "standard" else expect_fem_airbox_compose_pin
        ),
        expect_terminal_telemetry=(True if expect_terminal_telemetry_input else None),
        expect_run_performance=(True if expect_run_performance_input else None),
        expect_planar_airbox=expect_planar_airbox_input,
        expect_ambiguous_compute_fields=(
            None if scenario == "saved-playback" or airbox_inspector or inspector_ack or study_stage_rerun
            else expect_ambiguous_command_compose_pin
        ),
        airbox_inspector=airbox_inspector,
        inspector_ack=inspector_ack,
        inspector_ack_source_sha256=inspector_ack_sources,
        study_stage_rerun=study_stage_rerun_mode if study_stage_rerun else None,
        study_stage_rerun_source_sha256=study_stage_rerun_sources if study_stage_rerun else None,
        study_stage_rerun_resume_evidence=study_stage_rerun_resume_evidence,
        saved_playback_item_id=saved_playback_item_id,
        source_script_sha256=source_script_sha256,
        control=control,
        private_group_storage=private_group_storage)
    if canonical(document) != canonical(expected_document):
        raise BuildControlError("QA reconciliation Compose recipe differs")
    helper_name = "fullmag-control-" + attempt
    if receipt.get("helper_container") != helper_name:
        raise BuildControlError("QA reconciliation lease helper name differs")
    retained_evidence = control.read(root + "/reconciliation-evidence.json", optional=True)
    if already_released:
        if (not isinstance(retained_evidence, Mapping)
                or retained_evidence.get("helper_id") != args.expected_helper_id
                or _probe_helper_absence(args.expected_helper_id) is None
                or _probe_helper_absence(helper_name) is None):
            raise BuildControlError("QA reconciliation release is not authenticated")
        helper_id, helper_log = args.expected_helper_id, retained_evidence.get("helper_log")
    else:
        _, helper_id = _validate_helper(control, helper_name, attempt, phase="browser-qa")
        if helper_id != args.expected_helper_id:
            raise BuildControlError("QA reconciliation lease helper incarnation differs")
        helper_log = _validate_helper_logged(helper_id)
    if prestart:
        _reconcile_prestart_qa(control, selected, identity, args, receipt, helper_id, helper_log,
            cache_project_id=cache_project_id)
        return
    browser_name = "fullmag-browser-qa-" + attempt[:12]
    if receipt.get("browser_container_name") != browser_name:
        raise BuildControlError("QA reconciliation browser name differs")
    browser_absent = _probe_helper_absence(args.expected_browser_id) is not None
    if already_released and not browser_absent:
        raise BuildControlError("Released QA reconciliation still has a browser container")
    if browser_absent:
        if not isinstance(retained_evidence, Mapping):
            raise BuildControlError("Absent QA browser has no retained reconciliation evidence")
        if _probe_helper_absence(browser_name) is None:
            raise BuildControlError("QA browser name was reused by another incarnation")
        observed = retained_evidence.get("browser_inspect") or {}
    else:
        observed = _inspect(args.expected_browser_id)
    state = observed.get("State") or {}
    if (observed.get("Name") != "/" + browser_name or observed.get("Id") != args.expected_browser_id
            or state.get("Status") != "exited" or state.get("Running") is not False
            or state.get("OOMKilled") is not False or type(state.get("ExitCode")) is not int
            or not state.get("FinishedAt")
            or observed.get("RestartCount") != 0):
        raise BuildControlError("QA reconciliation requires an exact stopped browser")
    _validate_browser_image_reference(inputs["browser_image"])
    image = _inspect_image(inputs["browser_image"])
    if image is None:
        raise BuildControlError("QA reconciliation browser image is absent")
    image_id, _ = _validate_browser_image_document(image, inputs["browser_image"])
    if receipt.get("browser_image_id") != image_id:
        raise BuildControlError("QA reconciliation browser image pin differs")
    _validate_browser_helper(observed, control, identity, inputs["frontend_volume"],
        image_id, state["ExitCode"], selected,
        canvas_only=(None if scenario == "saved-playback" or airbox_inspector or inspector_ack
                     or study_stage_rerun else canvas_only_compose_pin),
        expect_live_field=(None if scenario == "saved-playback" else expect_live_field_compose_pin),
        expect_airbox_vectors=(None if scenario == "saved-playback" else expect_airbox_compose_pin),
        expect_fem_airbox_vectors=(
            None if scenario != "standard" else expect_fem_airbox_compose_pin
        ),
        expect_terminal_telemetry=(True if expect_terminal_telemetry_input else None),
        expect_run_performance=(True if expect_run_performance_input else None),
        expect_ambiguous_compute_fields=(
            None if scenario == "saved-playback" or airbox_inspector or inspector_ack or study_stage_rerun
            else expect_ambiguous_command_compose_pin
        ),
        airbox_inspector=airbox_inspector,
        inspector_ack=inspector_ack,
        inspector_ack_source_sha256=inspector_ack_sources,
        study_stage_rerun=study_stage_rerun_mode if study_stage_rerun else None,
        study_stage_rerun_source_sha256=study_stage_rerun_sources if study_stage_rerun else None,
        study_stage_rerun_resume_evidence=study_stage_rerun_resume_evidence,
        saved_playback_item_id=saved_playback_item_id,
        source_script_sha256=source_script_sha256,
        expect_planar_airbox=expect_planar_airbox_input,
        private_group_storage=private_group_storage)
    service = document["services"]["browser-qa"]
    if (observed["Config"].get("Cmd") != service["command"]
            or observed["Config"].get("Entrypoint") != image["Config"].get("Entrypoint")):
        raise BuildControlError("QA reconciliation browser command differs")
    evidence = {"schema": "fullmag.browser-qa-reconciliation.v1", "state": "failed-confirmed",
        "attempt": attempt, "compose_project": control.project, "output_lost": True,
        "observed_exit_code": state["ExitCode"], "browser_container_id": observed["Id"],
        "receipt_sha256": args.expected_receipt_sha256, "compose_sha256": args.expected_compose_sha256,
        "helper_id": helper_id, "helper_log": helper_log, "browser_inspect": observed,
        "verification": "NOT VERIFIED",
        **({"inspector_ack_restoration": "unknown", "requires_object_readback": True} if inspector_ack else {})}
    if retained_evidence is not None:
        stable = {key: value for key, value in retained_evidence.items() if key != "reconciled_at"}
        if canonical(stable) != canonical(evidence) or type(retained_evidence.get("reconciled_at")) not in (int, float):
            raise BuildControlError("Retained QA reconciliation evidence differs")
        evidence = retained_evidence
    else:
        evidence["reconciled_at"] = time.time()
        control.write(root + "/reconciliation-evidence.json", evidence)
    if not browser_absent:
        if _inspect(observed["Id"])["State"] != state:
            raise BuildControlError("QA browser incarnation changed during reconciliation")
        docker_capture("rm", observed["Id"])
    absence = _probe_helper_absence(observed["Id"])
    if absence is None:
        raise BuildControlError("QA browser absence is not confirmed")
    terminal = {**receipt, "state": "failed-confirmed", "output_lost": True,
        "error": "Browser QA failed; output lost after client timeout", "exit_code": state["ExitCode"],
        "browser_container_id": observed["Id"], "browser_absence_sha256": absence,
        "reconciliation_evidence_sha256": hashlib.sha256(canonical(evidence) + b"\n").hexdigest(),
        "finished_at": evidence["reconciled_at"], "verification": "NOT VERIFIED"}
    if already_released:
        if (canonical(retained_terminal) != canonical(terminal)
                or _control_bytes(control, "active", optional=True) is not None):
            raise BuildControlError("Completed QA reconciliation terminal/fence differs")
        mirror_console(json.dumps({"state": "failed-confirmed", "attempt": attempt,
            "output_lost": True, "lease_released": True, "verification": "NOT VERIFIED"}) + "\n")
        return
    # Publish under the original lease, with CAS on all retained inputs. Only
    # the authenticated original helper may remove its own active marker.
    payload = canonical(terminal) + b"\n"
    terminal_path = control.path(root + "/terminal.json")
    script = (
        "set -eu; test \"$(cat /control/active)\" = '" + attempt + "'; "
        "test \"$(sha256sum '" + control.path(root + "/receipt.json") + "' | cut -d' ' -f1)\" = '" + args.expected_receipt_sha256 + "'; "
        "test \"$(sha256sum '" + control.path(root + "/compose.json") + "' | cut -d' ' -f1)\" = '" + args.expected_compose_sha256 + "'; "
        "if test -e '" + terminal_path + "'; then test \"$(sha256sum '" + terminal_path + "' | cut -d' ' -f1)\" = '" + hashlib.sha256(payload).hexdigest() + "'; exit 0; fi; umask 027; "
        "t=$(mktemp '" + control.path(root) + "/.reconcile.XXXXXXXX'); "
        "trap 'rm -f -- \"$t\"' EXIT; cat > \"$t\"; sync \"$t\"; "
        "mv -T -- \"$t\" '" + terminal_path + "'; sync '" + control.path(root) + "'"
    )
    from docker_build_control import bounded_capture
    result = bounded_capture(control.helper_args(script), data=payload, timeout=90)
    if result.returncode:
        raise ControlOutcomeUnknown("QA technical terminal publication was not confirmed")
    _wait_for_helper_exit(helper_id)
    if _control_bytes(control, "active", optional=True) is not None:
        raise ControlOutcomeUnknown("QA lease remained after authenticated helper exit")
    mirror_console(json.dumps({"state": "failed-confirmed", "attempt": attempt,
        "output_lost": True, "lease_released": True, "verification": "NOT VERIFIED"}) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--port", type=int)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--pull-timeout", type=int, default=1800)
    parser.add_argument(
        "--prepare-viewport-fixture",
        action="store_true",
        help="Opt in to preparing a disposable viewport fixture in this QA session",
    )
    parser.add_argument(
        "--canvas-only",
        action="store_true",
        help="Run only the visible canvas, session, Home round trip, and browser transport proof",
    )
    parser.add_argument(
        "--expect-live-field",
        help="Require the named live quantity to be visibly data-ready (canvas-only scope)",
    )
    parser.add_argument(
        "--expect-airbox-vectors",
        action="store_true",
        help="Also require visible FDM airbox vectors (requires --expect-live-field)",
    )
    parser.add_argument(
        "--expect-fem-airbox-vectors",
        action="store_true",
        help="Select FEM Airbox H_demag vectors and require live render-adoption evidence (canvas-only, --expect-live-field m)",
    )
    parser.add_argument(
        "--expect-planar-airbox",
        action="store_true",
        help="Prove the current default H_demag planar field against the Universe/Airbox scope (canvas-only, --expect-live-field m)",
    )
    parser.add_argument(
        "--expect-terminal-telemetry",
        action="store_true",
        help="Prove visible terminal Step and total energy against scoped API provenance before and after page reload (canvas-only, --expect-live-field m)",
    )
    parser.add_argument(
        "--expect-run-performance",
        action="store_true",
        help="Prove the visible Automatic performance panel against scoped current-run diagnostics (canvas-only)",
    )
    parser.add_argument(
        "--expect-ambiguous-compute-fields",
        action="store_true",
        help="Exercise one real Compute Fields command with its accepted response dropped (canvas-only)",
    )
    parser.add_argument("--inspector-ack", action="store_true",
                        help="Prove one task-owned reversible name PATCH pending/ACK and restoration")
    parser.add_argument(
        "--study-stage-rerun",
        choices=("stage-b", "study", "material-stage-a", "fdm-cell-study", "texture-stage-b", "texture-study"),
        help="Run one fixed P22 UI-only Study stage profile and verify public results",
    )
    parser.add_argument(
        "--resume-fdm-grid-attempt",
        help="Resume one exact failed-confirmed FDM grid browser attempt before any Study Solve",
    )
    parser.add_argument(
        "--airbox-inspector",
        action="store_true",
        help="Run the read-only live Airbox mesh Inspector proof in the managed browser service",
    )
    parser.add_argument(
        "--saved-playback-item-id",
        help="Inspect one registered saved-results item through its read-only playback resource",
    )
    parser.add_argument("--reconcile-attempt")
    parser.add_argument("--reconcile-prestart", action="store_true", help="Close an orphaned starting attempt only after proving its browser was never launched")
    parser.add_argument("--expected-receipt-sha256")
    parser.add_argument("--expected-compose-sha256")
    parser.add_argument("--expected-browser-id")
    parser.add_argument("--expected-helper-id")
    parser.add_argument(
        "--browser-image",
        default=os.environ.get("FULLMAG_BROWSER_QA_IMAGE", DEFAULT_BROWSER_IMAGE),
    )
    args = parser.parse_args(argv)
    if args.reconcile_prestart and not args.reconcile_attempt:
        raise BuildControlError("--reconcile-prestart requires --reconcile-attempt and exact evidence pins")
    if args.resume_fdm_grid_attempt is not None:
        if (not isinstance(args.resume_fdm_grid_attempt, str)
                or re.fullmatch(r"[0-9a-f]{32}", args.resume_fdm_grid_attempt) is None):
            raise BuildControlError("--resume-fdm-grid-attempt requires one 32-character lowercase attempt id")
        if args.study_stage_rerun is not None:
            raise BuildControlError("--resume-fdm-grid-attempt cannot be combined with --study-stage-rerun")
        args.study_stage_rerun = "fdm-cell-study-resume"
    if args.study_stage_rerun is not None and (
        args.reconcile_attempt or args.reconcile_prestart
        or args.prepare_viewport_fixture or args.canvas_only or args.expect_live_field is not None
        or args.expect_airbox_vectors or args.expect_fem_airbox_vectors or args.expect_planar_airbox
        or args.expect_terminal_telemetry or args.expect_run_performance or args.expect_ambiguous_compute_fields
        or args.airbox_inspector or args.inspector_ack or args.saved_playback_item_id is not None
    ):
        raise BuildControlError("--study-stage-rerun cannot be combined with another browser QA scenario")
    defaults = resolve_defaults(args.repo_root, source_root=args.source_root, port=args.port)
    args.source_root = defaults.source_root
    args.port = defaults.port
    if (
        not 1 <= args.port <= 65535
        or not 30 <= args.timeout <= 900
        or not 60 <= args.pull_timeout <= 1800
    ):
        raise BuildControlError("Browser QA port/timeout/pull-timeout is outside its bounded range")
    if args.inspector_ack and (
        args.prepare_viewport_fixture or args.canvas_only or args.expect_live_field is not None
        or args.expect_airbox_vectors or args.expect_fem_airbox_vectors or args.expect_planar_airbox
        or args.expect_terminal_telemetry or args.expect_run_performance or args.expect_ambiguous_compute_fields
        or args.airbox_inspector or args.saved_playback_item_id is not None
    ):
        raise BuildControlError("--inspector-ack cannot be combined with other browser QA scenarios")
    if args.canvas_only and args.prepare_viewport_fixture:
        raise BuildControlError("--canvas-only cannot be combined with --prepare-viewport-fixture")
    if args.expect_live_field is not None:
        if (not args.expect_live_field or args.expect_live_field != args.expect_live_field.strip()
                or len(args.expect_live_field) > 512
                or any(ord(character) < 32 or ord(character) == 127 for character in args.expect_live_field)):
            raise BuildControlError("--expect-live-field requires a bounded, non-empty quantity id")
    if (args.expect_live_field is not None or args.expect_airbox_vectors or args.expect_fem_airbox_vectors) and not args.canvas_only:
        raise BuildControlError("Focused live-field and Airbox-vector expectations require --canvas-only")
    if args.expect_airbox_vectors and args.expect_live_field is None:
        raise BuildControlError("--expect-airbox-vectors requires --expect-live-field")
    if args.expect_planar_airbox and (
        not args.canvas_only
        or args.expect_live_field != "m"
        or args.expect_airbox_vectors
        or args.expect_fem_airbox_vectors
        or args.expect_terminal_telemetry
        or args.expect_run_performance
        or args.expect_ambiguous_compute_fields
        or args.prepare_viewport_fixture
        or args.airbox_inspector
        or args.saved_playback_item_id is not None
    ):
        raise BuildControlError(
            "--expect-planar-airbox requires --canvas-only --expect-live-field m and excludes other scenarios"
        )
    if args.expect_fem_airbox_vectors and (
        args.expect_live_field != "m"
        or args.expect_airbox_vectors
        or args.expect_ambiguous_compute_fields
        or args.prepare_viewport_fixture
    ):
        raise BuildControlError(
            "--expect-fem-airbox-vectors requires --expect-live-field m and excludes FDM vectors, fixture, and command scenarios"
        )
    if args.expect_ambiguous_compute_fields and not args.canvas_only:
        raise BuildControlError("--expect-ambiguous-compute-fields requires --canvas-only")
    if args.expect_terminal_telemetry and (
        not args.canvas_only
        or args.expect_live_field != "m"
        or args.expect_airbox_vectors
        or args.expect_fem_airbox_vectors
        or args.expect_ambiguous_compute_fields
        or args.prepare_viewport_fixture
    ):
        raise BuildControlError(
            "--expect-terminal-telemetry requires --canvas-only --expect-live-field m and excludes other scenarios"
        )
    if args.expect_run_performance and (
        not args.canvas_only
        or args.prepare_viewport_fixture
        or args.expect_live_field is not None
        or args.expect_airbox_vectors
        or args.expect_fem_airbox_vectors
        or args.expect_planar_airbox
        or args.expect_terminal_telemetry
        or args.expect_ambiguous_compute_fields
        or args.airbox_inspector
        or args.saved_playback_item_id is not None
    ):
        raise BuildControlError(
            "--expect-run-performance requires standalone --canvas-only scope and excludes other scenarios"
        )
    if args.airbox_inspector and (
        args.prepare_viewport_fixture
        or args.canvas_only
        or args.expect_live_field is not None
        or args.expect_airbox_vectors
        or args.expect_fem_airbox_vectors
        or args.expect_terminal_telemetry
        or args.expect_ambiguous_compute_fields
    ):
        raise BuildControlError("--airbox-inspector cannot be combined with other browser QA scenarios")
    if args.saved_playback_item_id is not None:
        if not re.fullmatch(r"[0-9]{1,20}", args.saved_playback_item_id):
            raise BuildControlError("--saved-playback-item-id requires at most 20 decimal digits")
        if (
            args.prepare_viewport_fixture
            or args.canvas_only
            or args.expect_live_field is not None
            or args.expect_airbox_vectors
            or args.expect_fem_airbox_vectors
            or args.expect_planar_airbox
            or args.expect_terminal_telemetry
            or args.expect_ambiguous_compute_fields
            or args.airbox_inspector
        ):
            raise BuildControlError("--saved-playback-item-id cannot be combined with another browser QA scenario")
        if args.reconcile_attempt:
            raise BuildControlError("Saved Playback reconciliation uses the item id retained in its receipt")
    if not isinstance(args.browser_image, str) or not args.browser_image:
        raise BuildControlError("Browser QA requires a pinned Playwright image reference")
    _validate_browser_image_reference(args.browser_image)
    selected, layout, identity = _resolve_selected(args)
    configured = toolchain_configuration(selected, identity)
    helper_image = configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"]
    control = BuildControl(identity, helper_image)
    _validate_existing_control_volume(control)
    if args.reconcile_attempt:
        reconcile_browser_qa(control, selected, identity, args,
            cache_project_id=cache_project_id_for_layout(layout))
        return 0
    current, backend_id, frontend_id, frontend_volume, frontend_inputs = _read_live_development(
        control, selected, identity, args.port
    )
    private_group_storage = _private_group_storage_mode(current)
    _validate_frontend_volume(control, frontend_volume, frontend_inputs, current)
    frontend = _inspect(frontend_id)
    _validate_frontend(frontend, control, identity, frontend_volume, current, args.port, cache_project_id=cache_project_id_for_layout(layout))
    try:
        _validate_live_network(backend_id, frontend_id, control.project, args.port)
    except BuildControlError as error:
        raise BuildControlError(f"Live development group validation failed: {error}") from error
    public_url = f"http://127.0.0.1:{args.port}"
    browser_url = "http://frontend:8080"
    inspector_ack_sources = _inspector_ack_source_sha256(selected) if args.inspector_ack else None
    study_stage_rerun_sources = (
        _study_stage_rerun_source_sha256(selected, args.study_stage_rerun)
        if args.study_stage_rerun is not None else None
    )
    study_stage_rerun_resume_evidence = None
    if args.resume_fdm_grid_attempt is not None:
        study_stage_rerun_resume_evidence = _load_fdm_grid_resume_evidence(
            control, args.resume_fdm_grid_attempt, selected=selected, current=current, identity=identity,
            frontend_id=frontend_id, frontend_volume=frontend_volume, public_url=public_url,
            browser_url=browser_url, expected_sources=study_stage_rerun_sources,
        )
    airbox_inspector_script_sha256 = None
    source_script_sha256 = None
    if args.airbox_inspector:
        harness = selected / "apps/control-room/scripts/verify-airbox-inspector.mjs"
        if not harness.is_file():
            raise BuildControlError("Selected checkout is missing the Airbox Inspector browser harness")
        airbox_inspector_script_sha256 = hashlib.sha256(harness.read_bytes()).hexdigest()
    if args.saved_playback_item_id is not None:
        source_script_sha256 = _saved_playback_harness_sha256(selected)
    terminal_telemetry_helper_sha256 = (
        _terminal_telemetry_helper_sha256(selected) if args.expect_terminal_telemetry else None
    )
    run_performance_harness_sha256 = (
        _run_performance_harness_sha256(selected) if args.expect_run_performance else None
    )
    planar_airbox_harness_sha256 = (
        _planar_airbox_harness_sha256(selected, "apps/control-room/scripts/docker-dev-browser-qa.mjs")
        if args.expect_planar_airbox else None
    )
    planar_field_evidence_sha256 = (
        _planar_airbox_harness_sha256(selected, "apps/control-room/scripts/lib/planar-field-evidence.mjs")
        if args.expect_planar_airbox else None
    )
    document = _compose_document(
        selected,
        identity,
        args.browser_image,
        frontend_volume,
        args.port,
        args.timeout,
        prepare_viewport_fixture=args.prepare_viewport_fixture,
        canvas_only=(None if args.airbox_inspector or args.inspector_ack or args.saved_playback_item_id is not None
                     or args.study_stage_rerun is not None else args.canvas_only),
        expect_live_field=args.expect_live_field,
        expect_airbox_vectors=(args.expect_airbox_vectors if args.expect_live_field is not None else None),
        expect_fem_airbox_vectors=(True if args.expect_fem_airbox_vectors else None),
        expect_terminal_telemetry=(True if args.expect_terminal_telemetry else None),
        expect_run_performance=(True if args.expect_run_performance else None),
        expect_planar_airbox=args.expect_planar_airbox,
        expect_ambiguous_compute_fields=(
            None if args.airbox_inspector or args.inspector_ack or args.saved_playback_item_id is not None
            or args.study_stage_rerun is not None
            else args.expect_ambiguous_compute_fields
        ),
        airbox_inspector=args.airbox_inspector,
        inspector_ack=args.inspector_ack,
        inspector_ack_source_sha256=inspector_ack_sources,
        study_stage_rerun=args.study_stage_rerun,
        study_stage_rerun_source_sha256=study_stage_rerun_sources,
        study_stage_rerun_resume_evidence=study_stage_rerun_resume_evidence,
        saved_playback_item_id=args.saved_playback_item_id,
        source_script_sha256=source_script_sha256,
        control=control,
        private_group_storage=private_group_storage,
    )
    source_commit = (current.get("source_commit") or (current.get("inputs") or {}).get("source_commit"))
    inputs = {
        "schema": OPERATION_SCHEMA,
        "source_root": str(selected),
        "source_commit": source_commit,
        "compose_project": control.project,
        "worktree_id": identity["worktree_id"],
        "development_attempt": current.get("attempt"),
        "development_config_sha256": current.get("config_sha256"),
        "runtime_phase": current.get("runtime_phase", current.get("phase")),
        "runtime_attempt": current.get("runtime_attempt", current.get("attempt")),
        "runtime_terminal_sha256": current.get("runtime_terminal_sha256"),
        "development_terminal_state": current.get("development_terminal_state", current.get("state")),
        "frontend_container": frontend_id,
        "frontend_volume": frontend_volume,
        "frontend_inputs_sha256": hashlib.sha256(canonical(frontend_inputs)).hexdigest(),
        "public_loopback_url": public_url,
        "browser_url": browser_url,
        "browser_image": args.browser_image,
        "browser_image_digest": BROWSER_IMAGE_RE.fullmatch(args.browser_image).group(1),
        "playwright_version": PLAYWRIGHT_VERSION,
        "browser_runtime_timeout": args.timeout,
        "browser_image_pull_timeout": args.pull_timeout,
        "prepare_viewport_fixture": args.prepare_viewport_fixture,
        "canvas_only": args.canvas_only,
        "expect_live_field": args.expect_live_field,
        "expect_airbox_vectors": args.expect_airbox_vectors,
        "expect_terminal_telemetry": args.expect_terminal_telemetry,
        "expect_run_performance": args.expect_run_performance,
        "expect_ambiguous_compute_fields": args.expect_ambiguous_compute_fields,
        "expect_planar_airbox": args.expect_planar_airbox,
        "scenario": (
            "study-stage-rerun" if args.study_stage_rerun is not None
            else "saved-playback" if args.saved_playback_item_id is not None
            else "inspector-ack" if args.inspector_ack
            else "airbox-inspector" if args.airbox_inspector
            else "planar-airbox" if args.expect_planar_airbox
            else "standard"
        ),
        "airbox_inspector_script_sha256": airbox_inspector_script_sha256,
    }
    if args.inspector_ack:
        inputs["inspector_ack_source_sha256"] = inspector_ack_sources
    if args.study_stage_rerun is not None:
        inputs["study_stage_rerun"] = args.study_stage_rerun
        inputs["study_stage_rerun_source_sha256"] = study_stage_rerun_sources
        if study_stage_rerun_resume_evidence is not None:
            inputs["fdm_grid_resume_parent_attempt"] = study_stage_rerun_resume_evidence["prior_attempt"]
            inputs["fdm_grid_resume_parent_record_sha256"] = study_stage_rerun_resume_evidence["record_sha256"]
    if private_group_storage:
        inputs["private_group_storage"] = "group-volume-v1"
    if args.expect_fem_airbox_vectors:
        inputs["expect_fem_airbox_vectors"] = True
    if args.saved_playback_item_id is not None:
        inputs["saved_playback_item_id"] = args.saved_playback_item_id
        inputs["source_script_sha256"] = source_script_sha256
    if args.expect_terminal_telemetry:
        inputs["terminal_telemetry_helper_sha256"] = terminal_telemetry_helper_sha256
    if args.expect_run_performance:
        inputs["run_performance_harness_sha256"] = run_performance_harness_sha256
    if args.expect_planar_airbox:
        inputs["planar_airbox_harness_sha256"] = planar_airbox_harness_sha256
        inputs["planar_field_evidence_sha256"] = planar_field_evidence_sha256
    with control.operation("browser-qa", inputs) as operation:
        live_fence = control.read("development/current.json")
        if hashlib.sha256(canonical(live_fence)).hexdigest() != current["development_fence_sha256"]:
            raise BuildControlError("Development attempt changed before browser QA admission")
        browser_image_id, _ = _ensure_browser_image(
            operation, control, document, args.browser_image, args.pull_timeout
        )
        if study_stage_rerun_resume_evidence is not None:
            _consume_fdm_grid_resume_evidence(
                control, study_stage_rerun_resume_evidence,
                child_attempt=operation["receipt"]["attempt"],
            )
        _run(
            operation,
            control,
            document,
            identity,
            selected,
            frontend_volume,
            browser_image_id,
            public_url,
            browser_url,
            args.timeout,
            (None if args.airbox_inspector or args.inspector_ack or args.saved_playback_item_id is not None
             or args.study_stage_rerun is not None else args.canvas_only),
            args.expect_live_field,
            args.expect_airbox_vectors,
            args.expect_ambiguous_compute_fields,
            args.airbox_inspector,
            airbox_inspector_script_sha256,
            args.saved_playback_item_id,
            source_script_sha256,
            args.expect_fem_airbox_vectors,
            args.expect_terminal_telemetry,
            terminal_telemetry_helper_sha256,
            args.expect_run_performance,
            run_performance_harness_sha256,
            private_group_storage,
            args.expect_planar_airbox,
            planar_airbox_harness_sha256,
            planar_field_evidence_sha256,
            inspector_ack=args.inspector_ack,
            inspector_ack_source_sha256=inspector_ack_sources,
            study_stage_rerun=args.study_stage_rerun,
            study_stage_rerun_source_sha256=study_stage_rerun_sources,
            study_stage_rerun_resume_evidence=study_stage_rerun_resume_evidence,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError, json.JSONDecodeError) as error:
        mirror_console(f"docker-dev-browser-qa: {str(error)[:4096]}\n")
        raise SystemExit(2)
