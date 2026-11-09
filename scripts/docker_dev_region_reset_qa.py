"""Fixed S46 regional Study browser-QA source, receipt and result contracts.

This module only validates evidence and builds fixed source pins. It never
dispatches API requests or launches a browser.
"""
from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import math
from pathlib import Path
from pathlib import PurePosixPath
import re
from urllib.parse import quote

from docker_build_control import BuildControlError, canonical


RESULT_SCHEMA = "fullmag.docker-dev-region-reset-result.v1"
MODES = (
    "s46-local-export",
    "s46-independent-export",
    "s46-local-import",
    "s46-independent-import",
)
_MODE_SET = frozenset(MODES)
_TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_SAFE_PYTHON_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}\.py$")
_MAX_SOURCE_BYTES = 65_536
_MAX_RESULT_BYTES = 2 * 1024 * 1024
_MAX_CONTROL_RECORD_BYTES = 2 * 1024 * 1024
_MAX_REQUESTS = 2_400
_MAX_PATHS = 160
_EMPTY_404_PATHS = frozenset({
    "/v2/sessions/current",
    "/v2/sessions/current/status",
    "/v2/sessions/current/simulation/runs/current",
    "/v2/sessions/current/simulation/stages/execution",
    "/v2/sessions/current/simulation/solver/status",
    "/v2/sessions/current/simulation/preparation",
})
_SOURCE_PATHS = {
    "runner": "apps/control-room/scripts/check-study-region-reset-browser.mjs",
    "loopback_proxy": "apps/control-room/scripts/lib/browser-qa-loopback-proxy.mjs",
    "region_reset_helper": "apps/control-room/scripts/lib/study-region-reset-browser-qa.mjs",
    "texture_helper": "apps/control-room/scripts/lib/study-texture-browser-qa.mjs",
    "fixture": "",
    "stage_inspector_frame": "apps/control-room/src/modules/inspector/panels/stages/StageInspectorFrame.tsx",
    "texture_editor": "apps/control-room/src/modules/inspector/panels/stages/StageTextureAssignmentsEditor.tsx",
    "stage_authoring_model": "apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts",
    "stage_inspector_router": "apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx",
    "study_inspector_panel": "apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx",
    "tree_view": "apps/control-room/src/modules/explorer/ExplorerTreeView.tsx",
    "study_command_adapter": "apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts",
    "study_command_contributions": "apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts",
    "study_stage_helpers": "apps/control-room/scripts/check-study-stage-rerun-browser.mjs",
    "build_study_commands": "apps/control-room/src/kernel/runtime/buildStudyCommands.ts",
    "geometry_lifecycle_commands": "apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts",
    "grid_confirm": "apps/control-room/src/modules/overlay/mesh-build/FdmGridBuildConfirmContent.tsx",
    "shell_commands": "apps/control-room/src/kernel/layout/shellCommands.ts",
    "script_project_activation": "apps/control-room/src/kernel/persistence/ScriptProjectActivation.ts",
    "api_instance_pin": "apps/control-room/src/kernel/api/apiInstancePin.ts",
    "tab_route_sync": "apps/control-room/src/kernel/layout/TabRouteSync.tsx",
    "tab_routes": "apps/control-room/src/kernel/layout/tabRoutes.ts",
    "start_screen": "apps/control-room/src/modules/start/StartScreen.tsx",
    "start_screen_state": "apps/control-room/src/modules/start/model/startScreenState.ts",
    "start_screen_host_adapter": "apps/control-room/src/modules/start/model/startScreenHostAdapter.ts",
    "start_commands": "apps/control-room/src/modules/start/model/startCommands.ts",
    "start_rail": "apps/control-room/src/modules/start/rail/StartRail.tsx",
    "import_section": "apps/control-room/src/modules/start/sections/ImportSection.tsx",
    "python_import": "apps/control-room/src/modules/start/model/pythonImport.ts",
    "create_project_action": "apps/control-room/src/modules/start/ui/CreateProjectAction.tsx",
    "api_client": "apps/control-room/src/kernel/api/ControlRoomApi.ts",
}


def source_paths(mode: str) -> dict[str, str]:
    """Return the exact repository-relative source map for one S46 profile."""
    if mode not in _MODE_SET:
        raise BuildControlError("Region reset QA requires one of the four fixed S46 modes")
    paths = dict(_SOURCE_PATHS)
    paths["fixture"] = (
        "examples/interactive_study/fdm_cpu_three_relax_region_ui_baseline.py"
        if mode.startswith("s46-local-")
        else "examples/interactive_study/fdm_cpu_three_relax_region_reset.py"
    )
    return paths


def _check_hash_map(value, mode: str) -> dict[str, str]:
    expected = set(source_paths(mode))
    if (not isinstance(value, Mapping) or set(value) != expected
            or any(not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None
                   for digest in value.values())):
        raise BuildControlError("Region reset QA source pins are malformed")
    return dict(value)


def _source_identity(mode: str) -> tuple[str, str]:
    if mode not in _MODE_SET:
        raise BuildControlError("Region reset QA requires one of the four fixed S46 modes")
    variant = "local" if mode.startswith("s46-local-") else "independent"
    phase = "import" if mode.endswith("-import") else "export"
    return variant, phase


def _require_safe_script(source_text, source_name) -> tuple[str, str]:
    if not isinstance(source_name, str) or _SAFE_PYTHON_NAME_RE.fullmatch(source_name) is None:
        raise BuildControlError("Region reset QA parent source name is not a safe Python filename")
    if not isinstance(source_text, str) or not source_text:
        raise BuildControlError("Region reset QA parent source text is missing")
    try:
        raw = source_text.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise BuildControlError("Region reset QA parent source text is not valid UTF-8") from error
    if len(raw) > _MAX_SOURCE_BYTES or b"\0" in raw:
        raise BuildControlError("Region reset QA parent source text exceeds its byte bound or contains NUL")
    return source_text, hashlib.sha256(raw).hexdigest()


def _read_canonical_record(control, path: str, *, maximum: int = _MAX_CONTROL_RECORD_BYTES):
    """Read one bounded control-volume JSON record and require its stored bytes."""
    raw = control.read_bytes(path, maximum=maximum)
    if not isinstance(raw, bytes):
        raise BuildControlError("Region reset lineage record is not stored as bytes: " + path)
    try:
        value = json.loads(raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Region reset lineage record is not valid JSON: " + path) from error
    if raw != canonical(value) + b"\n" or not isinstance(value, Mapping):
        raise BuildControlError("Region reset lineage record is not canonical JSON: " + path)
    return raw, value


def _timestamp(value, label: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise BuildControlError("Region reset lineage has an invalid " + label)
    return float(value)


def _state_root(value, attempt: str, label: str) -> PurePosixPath:
    if not isinstance(value, str) or len(value) > 4096 or not value.startswith("/"):
        raise BuildControlError("Region reset lineage has an invalid " + label)
    path = PurePosixPath(value)
    if (str(path) != value or ".." in path.parts or path.name != attempt
            or path.name in {"", "."}):
        raise BuildControlError("Region reset lineage has a noncanonical " + label)
    return path


def _validate_development_identity(record: Mapping, *, control, source_root: str,
                                   project_id: str, worktree_id: str,
                                   checkout_kind: str, source_commit: str,
                                   label: str) -> Mapping:
    inputs = record.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("Region reset " + label + " has no source identity")
    if (record.get("schema") != "fullmag.docker-build-operation.v1"
            or record.get("phase") != "development"
            or record.get("compose_project") != control.project
            or record.get("control_volume") != control.volume
            or record.get("control_namespace", "") != getattr(control, "namespace", "")
            or inputs.get("source_root") != source_root
            or inputs.get("source_project_id") != project_id
            or inputs.get("source_worktree_id") != worktree_id
            or inputs.get("source_checkout_kind") != checkout_kind
            or (record.get("source_commit") or inputs.get("source_commit")) != source_commit):
        raise BuildControlError("Region reset " + label + " source/group identity differs")
    return inputs


def _group_ledger_profile(control, record: Mapping, compose: Mapping,
                          ledger_record: Mapping, *, generation: str | None,
                          label: str) -> Mapping:
    """Validate the actual Compose mount and ledger receipt for one DEV attempt."""
    from docker_group_ledger import (
        GroupLedgerError, HOST_ID_ENV, PROFILE, PRIVATE_GROUP_STORAGE_ENV, VOLUME_PREFIX,
        retained_profile, volume_key,
    )
    from docker_volume_fresh_runtime import _expected_private_ledger_subpath

    inputs = record.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("Region reset " + label + " has no ledger source identity")
    image_id = inputs.get("image_id")
    if (not isinstance(image_id, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is None
            or compose.get("name") != control.project):
        raise BuildControlError("Region reset " + label + " has no pinned group-ledger image/project")
    try:
        profile = retained_profile(compose, image_id)
    except (GroupLedgerError, KeyError, TypeError, ValueError) as error:
        raise BuildControlError("Region reset " + label + " Compose group-ledger profile is malformed") from error
    expected_record_keys = {
        "schema", "profile", "daemon_id_sha256", "compose_project", "volume_name", "host_id",
    }
    if (not isinstance(ledger_record, Mapping) or set(ledger_record) != expected_record_keys
            or ledger_record.get("schema") != "fullmag.docker-group-ledger.v1"
            or ledger_record.get("profile") != PROFILE
            or ledger_record.get("compose_project") != control.project
            or ledger_record.get("daemon_id_sha256") != profile["environment"].get("FULLMAG_DOCKER_HOST_ID")
            or ledger_record.get("volume_name") != profile.get("volume_name")
            or ledger_record.get("host_id") != profile.get("environment", {}).get(HOST_ID_ENV)):
        raise BuildControlError("Region reset " + label + " group-ledger record differs from Compose")

    subpath = profile.get("ledger_subpath", "")
    if subpath:
        # Private group storage uses the stable control volume; archive inode and
        # owner checks come from pinned_group_archive, not a guessed volume key.
        if (profile.get("volume_name") != control.volume
                or subpath != _expected_private_ledger_subpath(control)
                or profile.get("environment", {}).get(PRIVATE_GROUP_STORAGE_ENV) is None):
            raise BuildControlError("Region reset " + label + " private group-ledger mount differs")
    elif generation is not None:
        try:
            expected_volume = VOLUME_PREFIX + volume_key(
                ledger_record["daemon_id_sha256"], control.project, generation,
            )
        except GroupLedgerError as error:
            raise BuildControlError("Region reset fresh group-ledger generation is malformed") from error
        if profile.get("volume_name") != expected_volume:
            raise BuildControlError("Region reset current group ledger does not use the archived generation")
    return profile


def _validate_direct_fresh_state_lineage(
        control, *, previous_attempt: str, source_root: str, project_id: str,
        worktree_id: str, checkout_kind: str, source_commit: str) -> dict[str, object]:
    """Prove exactly P→R→N from current control-volume records.

    R is the current pinned successful fresh-state recreation. Its old DEV
    input must be P, and current/verified development authority N must be the
    successful new-state successor started after R.
    """
    from docker_volume_fresh_runtime import _archive_mapping, pinned_group_archive

    previous_root = f"development/attempts/{previous_attempt}"
    previous_raw, previous = _read_canonical_record(control, previous_root + "/terminal.json")
    previous_receipt_raw, previous_receipt = _read_canonical_record(
        control, previous_root + "/receipt.json",
    )
    if (previous_raw != previous_receipt_raw or previous != previous_receipt
            or previous.get("attempt") != previous_attempt
            or previous.get("state") != "succeeded"):
        raise BuildControlError("Region reset export parent is not the exact succeeded predecessor DEV")
    _validate_development_identity(
        previous, control=control, source_root=source_root, project_id=project_id,
        worktree_id=worktree_id, checkout_kind=checkout_kind,
        source_commit=source_commit, label="parent DEV",
    )
    previous_state = _state_root(previous.get("state_root"), previous_attempt, "parent state root")
    previous_finished = _timestamp(previous.get("finished_at"), "parent DEV finish time")
    previous_backend = previous.get("backend_container")
    previous_frontend = previous.get("frontend_container")
    container_re = re.compile(r"^[0-9a-f]{64}$")
    previous_containers = [previous_backend, previous_frontend]
    if (any(not isinstance(item, str) or container_re.fullmatch(item) is None
            for item in previous_containers)
            or len(set(previous_containers)) != 2):
        raise BuildControlError("Region reset export parent has no exact old service identities")

    previous_compose_raw, previous_compose = _read_canonical_record(
        control, previous_root + "/compose.json",
    )
    previous_ledger_raw, previous_ledger = _read_canonical_record(
        control, previous_root + "/group-ledger.json",
    )
    previous_profile = _group_ledger_profile(
        control, previous, previous_compose, previous_ledger, generation=None,
        label="parent DEV",
    )
    compose_sha = hashlib.sha256(canonical(previous_compose)).hexdigest()
    if previous.get("config_sha256") != compose_sha:
        raise BuildControlError("Region reset parent DEV Compose hash differs from its terminal")

    generation_raw, generation = _read_canonical_record(control, "group-ledger-generation.json")
    try:
        archive_from_pin = pinned_group_archive(control, generation)
    except (KeyError, TypeError, ValueError) as error:
        raise BuildControlError("Region reset fresh-state archive generation is invalid") from error
    recreation_attempt = generation.get("generation") if isinstance(generation, Mapping) else None
    if not isinstance(recreation_attempt, str) or _TOKEN_RE.fullmatch(recreation_attempt) is None:
        raise BuildControlError("Region reset fresh-state recreation attempt is malformed")
    recreation_root = "recreate-services/attempts/" + recreation_attempt
    recreation_raw, recreation = _read_canonical_record(control, recreation_root + "/terminal.json")
    recreation_receipt_raw, recreation_receipt = _read_canonical_record(
        control, recreation_root + "/receipt.json",
    )
    current_recreate_raw, current_recreate = _read_canonical_record(control, "recreate-services/current.json")
    verified_recreate_raw, verified_recreate = _read_canonical_record(control, "recreate-services/verified.json")
    if (recreation_raw != recreation_receipt_raw or recreation != recreation_receipt
            or recreation_raw != current_recreate_raw or recreation_raw != verified_recreate_raw
            or recreation != current_recreate or recreation != verified_recreate):
        raise BuildControlError("Region reset fresh-state recreation is not the current verified recreation")

    archive_path = recreation_root + "/runtime-control-archive-terminal.json"
    archive_raw, archive = _read_canonical_record(control, archive_path)
    archive_intent_raw, archive_intent = _read_canonical_record(
        control, recreation_root + "/runtime-control-archive-intent.json",
    )
    retained_raw, retained = _read_canonical_record(control, recreation_root + "/retained-containers.json")
    helper_binding_path = recreation_root + "/helper-source-binding.json"
    helper_binding_raw, helper_binding = _read_canonical_record(control, helper_binding_path)
    from docker_helper_source import HelperSourceError, validate_binding_record
    try:
        validate_binding_record(dict(helper_binding))
    except HelperSourceError as error:
        raise BuildControlError("Region reset recreation helper-source binding is invalid") from error
    if archive != archive_from_pin:
        raise BuildControlError("Region reset pinned archive differs from its canonical stored record")
    private_ledger = archive.get("preserved_group_ledger_subpath") is not None
    expected_mapping = _archive_mapping(recreation_attempt, private_ledger=private_ledger)
    expected_removed_map = {"backend": previous_backend, "frontend": previous_frontend}
    recreation_inputs = recreation.get("inputs")
    archive_hash = hashlib.sha256(canonical(archive)).hexdigest()
    if (recreation.get("schema") != "fullmag.docker-build-operation.v1"
            or recreation.get("phase") != "recreate-services"
            or recreation.get("state") != "succeeded"
            or recreation.get("attempt") != recreation_attempt
            or recreation.get("fresh_state") is not True
            or recreation.get("compose_project") != control.project
            or recreation.get("control_volume") != control.volume
            or recreation.get("control_namespace", "") != getattr(control, "namespace", "")
            or not isinstance(recreation_inputs, Mapping)
            or recreation_inputs.get("attempt") != previous_attempt
            or recreation_inputs.get("config_sha256") != compose_sha
            or recreation_inputs.get("helper_source") != helper_binding
            or recreation.get("helper_source") != helper_binding
            or helper_binding.get("root") != source_root
            or helper_binding.get("app_source_root") != source_root
            or helper_binding.get("commit") != source_commit
            or recreation.get("previous_state_root") != str(previous_state)
            or recreation.get("removed_containers") != previous_containers
            or recreation.get("runtime_control_archive") != archive
            or archive.get("schema") != "fullmag.docker-fresh-runtime-archive-terminal.v1"
            or archive.get("operation_attempt") != recreation_attempt
            or archive.get("compose_project") != control.project
            or archive.get("control_volume") != control.volume
            or archive.get("control_namespace", "") != getattr(control, "namespace", "")
            or archive.get("preserved_group_ledger_volume") != previous_profile.get("volume_name")
            or archive.get("mapping") != expected_mapping
            or generation.get("archive_terminal_path") != archive_path
            or generation.get("archive_terminal_sha256") != archive_hash
            or generation.get("preserved_volume") != previous_profile.get("volume_name")):
        raise BuildControlError("Region reset fresh-state receipt is not the exact archive of its parent DEV")
    if (not isinstance(archive_intent, Mapping)
            or archive.get("intent_sha256") != hashlib.sha256(archive_intent_raw).hexdigest()
            or archive_intent.get("schema") != "fullmag.docker-fresh-runtime-archive-intent.v1"
            or archive_intent.get("operation_attempt") != recreation_attempt
            or archive_intent.get("compose_project") != control.project
            or archive_intent.get("control_volume") != control.volume
            or archive_intent.get("control_namespace", "") != getattr(control, "namespace", "")
            or archive_intent.get("source_root") != source_root
            or archive_intent.get("previous_state_root") != str(previous_state)
            or archive_intent.get("removed_containers") != expected_removed_map
            or archive_intent.get("mapping") != expected_mapping):
        raise BuildControlError("Region reset fresh-state archive intent does not bind its exact predecessor")
    if (not isinstance(retained, Mapping)
            or any(not isinstance(retained.get(role), Mapping)
                   or retained[role].get("Id") != identifier
                   for role, identifier in expected_removed_map.items())):
        raise BuildControlError("Region reset fresh-state removal receipt differs from the parent services")
    recreation_started = _timestamp(recreation.get("started_at"), "recreation start time")
    recreation_finished = _timestamp(recreation.get("finished_at"), "recreation finish time")
    if not previous_finished <= recreation_started < recreation_finished:
        raise BuildControlError("Region reset fresh-state recreation did not directly follow its parent DEV")

    current_raw, current = _read_canonical_record(control, "development/current.json")
    verified_raw, verified = _read_canonical_record(control, "development/verified.json")
    if current_raw != verified_raw or current != verified:
        raise BuildControlError("Region reset current and verified DEV authority differ")
    current_attempt = current.get("attempt")
    if (not isinstance(current_attempt, str) or _TOKEN_RE.fullmatch(current_attempt) is None
            or current_attempt in {previous_attempt, recreation_attempt}
            or current.get("state") != "succeeded"):
        raise BuildControlError("Region reset current DEV is not a fresh succeeded successor")
    current_root = "development/attempts/" + current_attempt
    current_terminal_raw, current_terminal = _read_canonical_record(
        control, current_root + "/terminal.json",
    )
    current_receipt_raw, current_receipt = _read_canonical_record(
        control, current_root + "/receipt.json",
    )
    if (current_terminal_raw != current_raw or current_receipt_raw != current_raw
            or current_terminal != current or current_receipt != current):
        raise BuildControlError("Region reset current DEV is not its exact immutable terminal")
    _validate_development_identity(
        current, control=control, source_root=source_root, project_id=project_id,
        worktree_id=worktree_id, checkout_kind=checkout_kind,
        source_commit=source_commit, label="current fresh-state DEV",
    )
    current_state = _state_root(current.get("state_root"), current_attempt, "current state root")
    if current_state.parent != previous_state.parent or current_state == previous_state:
        raise BuildControlError("Region reset current DEV does not use the parent's fresh state root")
    current_started = _timestamp(current.get("started_at"), "current DEV start time")
    if not recreation_finished < current_started:
        raise BuildControlError("Region reset current DEV did not start after its exact fresh-state archive")
    current_compose_raw, current_compose = _read_canonical_record(control, current_root + "/compose.json")
    current_ledger_raw, current_ledger = _read_canonical_record(control, current_root + "/group-ledger.json")
    current_profile = _group_ledger_profile(
        control, current, current_compose, current_ledger, generation=recreation_attempt,
        label="current fresh-state DEV",
    )
    if (current.get("config_sha256") != hashlib.sha256(canonical(current_compose)).hexdigest()
            or current_profile.get("profile") != previous_profile.get("profile")
            or current_profile.get("ledger_subpath", "") != previous_profile.get("ledger_subpath", "")
            or current_profile.get("environment", {}).get("FULLMAG_DOCKER_HOST_ID")
                != previous_profile.get("environment", {}).get("FULLMAG_DOCKER_HOST_ID")
            or current_profile.get("environment", {}).get("FULLMAG_GROUP_LEDGER_HOST_ID")
                != previous_profile.get("environment", {}).get("FULLMAG_GROUP_LEDGER_HOST_ID")):
        raise BuildControlError("Region reset fresh-state DEV Compose or ledger profile differs")

    return {
        "previous_development_attempt": previous_attempt,
        "previous_development_terminal_sha256": hashlib.sha256(previous_raw).hexdigest(),
        "previous_state_root": str(previous_state),
        "previous_group_ledger_sha256": hashlib.sha256(previous_ledger_raw).hexdigest(),
        "recreation_attempt": recreation_attempt,
        "generation_sha256": hashlib.sha256(generation_raw).hexdigest(),
        "recreation_terminal_sha256": hashlib.sha256(recreation_raw).hexdigest(),
        "archive_terminal_sha256": hashlib.sha256(archive_raw).hexdigest(),
        "archive_intent_sha256": hashlib.sha256(archive_intent_raw).hexdigest(),
        "retained_containers_sha256": hashlib.sha256(retained_raw).hexdigest(),
        "helper_source_binding_sha256": hashlib.sha256(helper_binding_raw).hexdigest(),
        "current_development_attempt": current_attempt,
        "current_development_terminal_sha256": hashlib.sha256(current_raw).hexdigest(),
        "current_state_root": str(current_state),
        "current_compose_sha256": hashlib.sha256(current_compose_raw).hexdigest(),
        "current_group_ledger_sha256": hashlib.sha256(current_ledger_raw).hexdigest(),
    }


_FRESH_STATE_EVIDENCE_KEYS = frozenset({
    "previous_development_attempt", "previous_development_terminal_sha256",
    "previous_state_root", "previous_group_ledger_sha256", "recreation_attempt",
    "generation_sha256", "recreation_terminal_sha256", "archive_terminal_sha256",
    "archive_intent_sha256", "retained_containers_sha256", "helper_source_binding_sha256",
    "current_development_attempt",
    "current_development_terminal_sha256", "current_state_root", "current_compose_sha256",
    "current_group_ledger_sha256",
})


def _validate_fresh_state_evidence(value, parent_attempt: str) -> dict[str, object]:
    if not isinstance(value, Mapping) or set(value) != _FRESH_STATE_EVIDENCE_KEYS:
        raise BuildControlError("Region reset fresh-state lineage fields are malformed")
    for field in ("previous_development_attempt", "recreation_attempt", "current_development_attempt"):
        if not isinstance(value.get(field), str) or _TOKEN_RE.fullmatch(value[field]) is None:
            raise BuildControlError("Region reset fresh-state lineage attempt is malformed")
    if (value["previous_development_attempt"] != parent_attempt
            or value["recreation_attempt"] in {parent_attempt, value["current_development_attempt"]}
            or value["current_development_attempt"] == parent_attempt):
        raise BuildControlError("Region reset fresh-state lineage attempts are not a direct P→R→N chain")
    digest_fields = _FRESH_STATE_EVIDENCE_KEYS - {
        "previous_development_attempt", "recreation_attempt", "current_development_attempt",
        "previous_state_root", "current_state_root",
    }
    if any(not isinstance(value.get(field), str) or _SHA256_RE.fullmatch(value[field]) is None
           for field in digest_fields):
        raise BuildControlError("Region reset fresh-state record hashes are malformed")
    previous_state = _state_root(value.get("previous_state_root"), parent_attempt, "parent state root")
    current_state = _state_root(
        value.get("current_state_root"), value["current_development_attempt"], "current state root",
    )
    if previous_state == current_state or previous_state.parent != current_state.parent:
        raise BuildControlError("Region reset fresh-state roots do not identify one direct successor")
    return {key: value[key] for key in sorted(_FRESH_STATE_EVIDENCE_KEYS)}


def validate_parent_evidence(value, mode: str) -> dict[str, object]:
    """Validate the authenticated, source-bearing export receipt for an import."""
    variant, phase = _source_identity(mode)
    if phase != "import":
        raise BuildControlError("Region reset parent evidence is allowed only for an import profile")
    if not isinstance(value, Mapping) or set(value) != {
        "prior_attempt", "record_sha256", "mode", "script_sha256", "source_text",
        "source_name", "parent_development_attempt", "source_commit", "fresh_state",
    }:
        raise BuildControlError("Region reset parent evidence fields are malformed")
    export_mode = f"s46-{variant}-export"
    if value.get("mode") != export_mode:
        raise BuildControlError("Region reset import parent belongs to another export variant")
    if (not isinstance(value.get("prior_attempt"), str)
            or _TOKEN_RE.fullmatch(value["prior_attempt"]) is None
            or not isinstance(value.get("parent_development_attempt"), str)
            or _TOKEN_RE.fullmatch(value["parent_development_attempt"]) is None
            or not isinstance(value.get("source_commit"), str)
            or _COMMIT_RE.fullmatch(value["source_commit"]) is None):
        raise BuildControlError("Region reset parent attempt or source commit pin is malformed")
    fresh_state = _validate_fresh_state_evidence(
        value.get("fresh_state"), value["parent_development_attempt"],
    )
    hashes = value.get("record_sha256")
    if (not isinstance(hashes, Mapping) or set(hashes) != {"terminal", "result"}
            or any(not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None
                   for digest in hashes.values())):
        raise BuildControlError("Region reset parent record digests are malformed")
    _, source_sha = _require_safe_script(value.get("source_text"), value.get("source_name"))
    if value.get("script_sha256") != source_sha:
        raise BuildControlError("Region reset parent exported source digest differs from its exact UTF-8 bytes")
    return {
        "prior_attempt": value["prior_attempt"],
        "record_sha256": {"terminal": hashes["terminal"], "result": hashes["result"]},
        "mode": export_mode,
        "script_sha256": source_sha,
        "source_text": value["source_text"],
        "source_name": value["source_name"],
        "parent_development_attempt": value["parent_development_attempt"],
        "source_commit": value["source_commit"],
        "fresh_state": fresh_state,
    }


def load_parent_evidence(control, token: str, *, source_root: Path, mode: str,
                         expected_sources: Mapping[str, str]) -> dict[str, object]:
    """Load a succeeded same-group export and pin its raw durable records."""
    variant, phase = _source_identity(mode)
    if phase != "import":
        raise BuildControlError("Region reset parent receipt is required only for an import profile")
    if not isinstance(token, str) or _TOKEN_RE.fullmatch(token) is None:
        raise BuildControlError("Region reset import requires a lowercase 32-character parent attempt")
    expected_sources = _check_hash_map(expected_sources, mode)
    try:
        resolved_root = source_root.resolve(strict=True)
    except (AttributeError, OSError, RuntimeError) as error:
        raise BuildControlError("Region reset parent source root is unavailable") from error
    expected_export = f"s46-{variant}-export"
    root = f"browser-qa/attempts/{token}"
    terminal_raw = control.read_bytes(root + "/terminal.json", maximum=512 * 1024)
    result_raw = control.read_bytes(root + "/result.json", maximum=_MAX_RESULT_BYTES)
    try:
        terminal = json.loads(terminal_raw)
        result = json.loads(result_raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError("Region reset parent terminal/result records are not valid JSON") from error
    if terminal_raw != canonical(terminal) + b"\n" or result_raw != canonical(result) + b"\n":
        raise BuildControlError("Region reset parent records are not in the canonical control-volume encoding")

    worktree_id = (getattr(control, "identity", {}) or {}).get("worktree_id")
    project_id = (getattr(control, "identity", {}) or {}).get("project_id")
    checkout_kind = (getattr(control, "identity", {}) or {}).get("checkout_kind")
    if (not isinstance(terminal, Mapping)
            or terminal.get("schema") != "fullmag.docker-build-operation.v1"
            or terminal.get("phase") != "browser-qa"
            or terminal.get("state") != "succeeded"
            or terminal.get("attempt") != token
            or terminal.get("compose_project") != control.project
            or terminal.get("control_volume") != control.volume
            or terminal.get("control_namespace", "") != getattr(control, "namespace", "")):
        raise BuildControlError("Region reset parent is not a succeeded browser-QA attempt in this group")
    terminal_inputs = terminal.get("inputs")
    if (not isinstance(terminal_inputs, Mapping)
            or terminal_inputs.get("scenario") != "study-stage-rerun"
            or terminal_inputs.get("study_stage_rerun") != expected_export
            or terminal_inputs.get("study_stage_rerun_source_sha256") != expected_sources
            or terminal_inputs.get("source_root") != str(resolved_root)
            or terminal_inputs.get("worktree_id") != worktree_id
            or not isinstance(terminal_inputs.get("development_attempt"), str)
            or _TOKEN_RE.fullmatch(terminal_inputs["development_attempt"]) is None
            or not isinstance(terminal_inputs.get("source_commit"), str)
            or _COMMIT_RE.fullmatch(terminal_inputs["source_commit"]) is None):
        raise BuildControlError("Region reset parent terminal is not pinned to this source/profile/predecessor")
    if (not isinstance(result, Mapping)
            or result.get("schema") != RESULT_SCHEMA
            or result.get("scenario") != "study-stage-rerun"
            or result.get("mode") != expected_export
            or result.get("state") != "passed"
            or result.get("outcome") != "exported"
            or result.get("source_hashes_before") != expected_sources
            or result.get("source_hashes_after") != expected_sources):
        raise BuildControlError("Region reset parent browser result is not a matching passed export")
    parent_import = result.get("import")
    if (not isinstance(parent_import, Mapping)
            or set(parent_import) != {"project_id", "source_sha256", "session_id", "scene_revision", "fidelity"}
            or not isinstance(parent_import.get("project_id"), str) or not parent_import["project_id"]
            or parent_import.get("source_sha256") != expected_sources["fixture"]
            or not isinstance(parent_import.get("session_id"), str) or not parent_import["session_id"]
            or type(parent_import.get("scene_revision")) is not int or parent_import["scene_revision"] < 0
            or parent_import.get("fidelity") != "verified"):
        raise BuildControlError("Region reset parent fixture import fidelity/source proof is incomplete")
    exported = result.get("export")
    if not isinstance(exported, Mapping) or set(exported) != {
        "source_text", "source_name", "script_sha256", "scene_revision",
    }:
        raise BuildControlError("Region reset parent export payload is malformed")
    text, source_sha = _require_safe_script(exported.get("source_text"), exported.get("source_name"))
    if (exported.get("script_sha256") != source_sha
            or type(exported.get("scene_revision")) is not int or exported["scene_revision"] < 0):
        raise BuildControlError("Region reset parent source digest or scene revision is invalid")
    parent_development_attempt = terminal_inputs["development_attempt"]
    source_commit = terminal_inputs["source_commit"]
    fresh_state = _validate_direct_fresh_state_lineage(
        control, previous_attempt=parent_development_attempt,
        source_root=str(resolved_root), project_id=project_id, worktree_id=worktree_id,
        checkout_kind=checkout_kind, source_commit=source_commit,
    )
    evidence = {
        "prior_attempt": token,
        "record_sha256": {
            "terminal": hashlib.sha256(terminal_raw).hexdigest(),
            "result": hashlib.sha256(result_raw).hexdigest(),
        },
        "mode": expected_export,
        "script_sha256": source_sha,
        "source_text": text,
        "source_name": exported["source_name"],
        "parent_development_attempt": parent_development_attempt,
        "source_commit": source_commit,
        "fresh_state": fresh_state,
    }
    return validate_parent_evidence(evidence, mode)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildControlError(message)


def _safe_int(value) -> bool:
    return type(value) is int and 0 <= value <= 9_007_199_254_740_991


def _nonempty(value, limit: int = 512) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit and "\0" not in value


def _validate_result_identities(run: Mapping[str, object], expected_stages: list[str]) -> None:
    results = run.get("results")
    _require(isinstance(results, list) and len(results) == len(expected_stages),
             "Region reset run omitted exact accepted result identities")
    observed_stages = []
    for item in results:
        _require(isinstance(item, Mapping), "Region reset run result identity is malformed")
        source = item.get("source")
        _require(isinstance(source, Mapping), "Region reset run result source identity is missing")
        _require(source.get("run_id") == run.get("run_id")
                 and all(_nonempty(source.get(key)) for key in ("task_id", "step_id", "case_id", "attempt_id"))
                 and _safe_int(source.get("ownership_epoch")),
                 "Region reset result belongs to another run or has incomplete source identity")
        stage_id = item.get("authored_stage_id")
        _require(_nonempty(stage_id) and stage_id in expected_stages,
                 "Region reset result identity names an unexpected authored stage")
        observed_stages.append(stage_id)
        _require(_nonempty(item.get("project_id")) and _nonempty(item.get("study_id"))
                 and _nonempty(item.get("artifact_id"))
                 and isinstance(item.get("artifact_sha256"), str)
                 and _SHA256_RE.fullmatch(item["artifact_sha256"]) is not None
                 and _nonempty(item.get("codec_id")) and _nonempty(item.get("codec_version"))
                 and _nonempty(item.get("accepted_at")),
                 "Region reset accepted result identity is incomplete")
    _require(observed_stages == expected_stages,
             "Region reset run result identities do not match the selected ordered stages")


def _validate_run(run, expected_stages: list[str], expected_target: dict[str, str], label: str) -> None:
    _require(isinstance(run, Mapping) and set(run) == {
        "run_id", "command_id", "execution_binding", "status", "stage_ids", "results",
    }, f"Region reset {label} run receipt is malformed")
    _require(_nonempty(run.get("run_id")) and _nonempty(run.get("command_id"))
             and run.get("status") == "completed" and run.get("stage_ids") == expected_stages,
             f"Region reset {label} run/status/stage identity differs")
    binding = run.get("execution_binding")
    _require(isinstance(binding, Mapping)
             and set(binding).issubset({"requested_target", "run_id", "step_id"})
             and binding.get("run_id") == run.get("run_id")
             and binding.get("requested_target") == expected_target,
             f"Region reset {label} accepted command is not bound to its exact target and run")
    if expected_target["kind"] == "study":
        _require(binding.get("step_id") is None,
                 f"Region reset {label} study command was unexpectedly resolved to a stage")
    else:
        _require(binding.get("step_id") == expected_target["stage_id"],
                 f"Region reset {label} command was not bound to relax-b")
    _validate_result_identities(run, expected_stages)


def _validate_edit(edit, kind: str, expected_revision: int | None = None,
                   expected_session_scope: str | None = None) -> int:
    fields = {"kind", "stage_id", "before_revision", "after_revision", "request_sha256",
              "committed_scene_sha256", "session_scope"}
    if kind == "region-reset":
        fields.update({"object_id", "region_id"})
    _require(isinstance(edit, Mapping) and set(edit) == fields
             and edit.get("kind") == kind and edit.get("stage_id") == "relax-b",
             "Region reset committed scene edit receipt is unexpected")
    if kind == "region-reset":
        _require(edit.get("object_id") == "film" and edit.get("region_id") == "left-half",
                 "Region reset edit does not target the exact film/left-half assignment")
    before, after = edit.get("before_revision"), edit.get("after_revision")
    _require(_safe_int(before) and _safe_int(after) and after == before + 1
             and (expected_revision is None or before == expected_revision),
             "Region reset scene edit revision did not advance exactly once")
    _require(isinstance(edit.get("request_sha256"), str)
             and _SHA256_RE.fullmatch(edit["request_sha256"]) is not None
             and isinstance(edit.get("committed_scene_sha256"), str)
             and _SHA256_RE.fullmatch(edit["committed_scene_sha256"]) is not None,
             "Region reset edit request/committed-scene digest is malformed")
    _require(isinstance(edit.get("session_scope"), str)
             and re.fullmatch(r"session=[^&]{1,512}&epoch=[^&]{1,512}&request_scope_epoch=[^&]{1,512}",
                              edit["session_scope"]) is not None
             and (expected_session_scope is None or edit["session_scope"] == expected_session_scope),
             "Region reset edit session scope is malformed")
    return after


def _validate_requests(value, mode: str) -> None:
    _require(isinstance(value, Mapping) and len(value) <= _MAX_PATHS,
             "Region reset request observations exceed their path budget")
    total = 0
    writes: dict[str, int] = {}
    for key, count in value.items():
        _require(isinstance(key, str) and re.fullmatch(r"(?:GET|HEAD|POST|PUT|PATCH|DELETE) /v2/[A-Za-z0-9_./{}-]{1,256}", key) is not None
                 and _safe_int(count) and count <= 160,
                 "Region reset request observation is malformed or exceeds its per-path budget")
        total += count
        _require(total <= _MAX_REQUESTS, "Region reset request observations exceed their total budget")
        method, path = key.split(" ", 1)
        if method not in {"GET", "HEAD"} and count:
            writes[key] = count
    is_import = mode.endswith("-import")
    transactions = 2 if is_import or mode == "s46-independent-export" else 3
    commands = 3 if is_import else 2
    expected = {
        "POST /v2/persistence/projects/from-script": 1,
        "POST /v2/sessions": 1,
        "POST /v2/sessions/current/model/transactions": transactions,
        "POST /v2/sessions/current/simulation/commands": commands,
    }
    sync_key = "POST /v2/sessions/current/model/syncs"
    if is_import:
        _require(value.get(sync_key, 0) == 0, "Region reset import unexpectedly synchronized/exported the scene")
    else:
        expected[sync_key] = 1
    auxiliary_bounds = {
        "PATCH /v2/sessions/current/visualization/state": 4,
        "POST /v2/sessions/current/visualization/client-acks": 16,
    }
    for key, maximum in auxiliary_bounds.items():
        count = value.get(key, 0)
        _require(_safe_int(count) and count <= maximum,
                 "Region reset UI camera/client-ACK request exceeded its fixed route budget")
        writes.pop(key, None)
    _require(writes == expected, "Region reset browser helper observed an extra, missing, or repeated write")


def _validate_expected_404s(report: Mapping[str, object]) -> None:
    empty = report.get("expected_empty_404")
    console = report.get("expected_console_404")
    _require(isinstance(empty, list) and len(empty) <= 12
             and all(path in _EMPTY_404_PATHS for path in empty),
             "Region reset expected empty-workspace 404 observations are malformed")
    expected_console = "Failed to load resource: the server responded with a status of 404 (Not Found)"
    _require(isinstance(console, list) and len(console) <= len(empty)
             and all(message == expected_console for message in console),
             "Region reset expected console 404 observations are not correlated/bounded")
    errors = report.get("errors")
    _require(isinstance(errors, Mapping) and set(errors) == {"page", "console", "http"}
             and all(errors.get(key) == [] for key in ("page", "console", "http")),
             "Region reset browser reported unexpected page, console, or HTTP errors")


def _finite_number(value) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, ValueError):
        return False


def _validate_auxiliary_writes(report: Mapping[str, object], expected_scope: str) -> None:
    rows = report.get("auxiliary_writes")
    _require(isinstance(rows, list) and len(rows) <= 20,
             "Region reset auxiliary UI writes are missing or over budget")
    observed = {
        "PATCH /v2/sessions/current/visualization/state": 0,
        "POST /v2/sessions/current/visualization/client-acks": 0,
    }
    for row in rows:
        _require(isinstance(row, Mapping) and set(row) == {
            "method", "path", "body", "session_scope", "api_instance_id", "status",
        }, "Region reset auxiliary UI write receipt is malformed")
        key = f"{row.get('method')} {row.get('path')}"
        _require(key in observed and row.get("session_scope") == expected_scope
                 and row.get("api_instance_id") == report.get("api_instance_id")
                 and type(row.get("status")) is int and 200 <= row["status"] < 300,
                 "Region reset auxiliary UI write has wrong path, session, API, or HTTP ACK")
        observed[key] += 1
        body = row.get("body")
        if key == "PATCH /v2/sessions/current/visualization/state":
            _require(isinstance(body, Mapping) and set(body) == {"camera"}
                     and isinstance(body.get("camera"), Mapping)
                     and set(body["camera"]) == {
                         "fov_degrees", "orthographic_scale", "position", "projection", "target", "up",
                     }, "Region reset camera autosave payload is malformed")
            camera = body["camera"]
            _require(camera.get("projection") in {"orthographic", "perspective"}
                     and _finite_number(camera.get("fov_degrees"))
                     and 0 < camera["fov_degrees"] < 180
                     and (camera.get("orthographic_scale") is None
                          or _finite_number(camera["orthographic_scale"])
                          and camera["orthographic_scale"] > 0)
                     and all(isinstance(camera.get(name), list) and len(camera[name]) == 3
                             and all(_finite_number(component) for component in camera[name])
                             for name in ("position", "target", "up")),
                     "Region reset camera autosave values are invalid")
        else:
            allowed = {"client_id", "client_label", "effective_render_mode", "error",
                       "revision", "status", "viewport_id"}
            _require(isinstance(body, Mapping) and set(body).issubset(allowed)
                     and isinstance(body.get("client_id"), str) and 0 < len(body["client_id"]) <= 256
                     and _safe_int(body.get("revision"))
                     and body.get("status") in {"applied", "rendered"}
                     and all(name not in body or isinstance(body[name], str) and len(body[name]) <= 512
                             for name in ("client_label", "effective_render_mode", "error", "viewport_id")),
                     "Region reset client ACK payload is malformed or reports failed rendering")
    requests = report.get("request_counts")
    _require(isinstance(requests, Mapping)
             and observed["PATCH /v2/sessions/current/visualization/state"]
             == requests.get("PATCH /v2/sessions/current/visualization/state", 0)
             and observed["POST /v2/sessions/current/visualization/client-acks"]
             == requests.get("POST /v2/sessions/current/visualization/client-acks", 0),
             "Region reset auxiliary UI write rows differ from request counts")


def _validate_cleanup(report: Mapping[str, object]) -> None:
    errors = report.get("cleanup_errors")
    cancellations = report.get("cleanup_cancellations")
    _require(errors == [] and isinstance(cancellations, list) and len(cancellations) <= 32,
             "Region reset browser cleanup reported an error or exceeded its cancellation bound")
    for cancellation in cancellations:
        _require(isinstance(cancellation, Mapping)
                 and set(cancellation) == {"method", "path", "failure"}
                 and cancellation.get("method") in {"GET", "HEAD"}
                 and isinstance(cancellation.get("path"), str)
                 and cancellation["path"].startswith("/")
                 and len(cancellation["path"]) <= 512
                 and cancellation.get("failure") == "net::ERR_ABORTED",
                 "Region reset cleanup cancellation is not a bounded GET/HEAD abort")


def _validate_health_read_observations(report: Mapping[str, object]) -> None:
    """Accept only bounded health-read aborts backed by a positive probe."""
    cancellations = report.get("read_cancellations")
    successes = report.get("successful_read_responses")
    api_instance_id = report.get("api_instance_id")
    _require(isinstance(cancellations, list) and len(cancellations) <= 4
             and isinstance(successes, list) and len(successes) <= 16,
             "Region reset health-read observations are missing or exceed their fixed budgets")
    _require(_nonempty(api_instance_id),
             "Region reset health-read observations have no pinned API instance")
    expected_method = "GET"
    expected_path = "/v2/platform/health"
    for cancellation in cancellations:
        _require(isinstance(cancellation, Mapping)
                 and set(cancellation) == {"method", "path", "failure", "phase", "api_instance_id"}
                 and cancellation.get("method") == expected_method
                 and cancellation.get("path") == expected_path
                 and cancellation.get("failure") == "net::ERR_ABORTED"
                 and cancellation.get("phase") in {"preflight", "import", "reload"}
                 and cancellation.get("api_instance_id") == api_instance_id,
                 "Region reset health-read cancellation is outside its exact route/phase/API contract")
    for response in successes:
        _require(isinstance(response, Mapping)
                 and set(response) == {"method", "path", "status", "api_instance_id"}
                 and response.get("method") == expected_method
                 and response.get("path") == expected_path
                 and type(response.get("status")) is int and response["status"] == 200
                 and response.get("api_instance_id") == api_instance_id,
                 "Region reset successful health-read response is malformed or belongs to another API")
    request_counts = report.get("request_counts")
    observed = (request_counts.get("GET " + expected_path, 0)
                if isinstance(request_counts, Mapping) else None)
    _require(_safe_int(observed)
             and len(cancellations) + len(successes) <= observed,
             "Region reset health-read receipts exceed the observed GET request count")
    positive_keys = {
        (response["method"], response["path"], response["api_instance_id"])
        for response in successes
    }
    _require(all((cancellation["method"], cancellation["path"], cancellation["api_instance_id"])
                 in positive_keys for cancellation in cancellations),
             "Region reset health-read cancellation lacks a matching successful probe")


def parse_result(output: bytes, public_url: str, browser_url: str,
                 expected_sources: Mapping[str, str], mode: str,
                 parent_evidence: Mapping[str, object] | None = None) -> dict[str, object]:
    """Parse and strictly validate one successful S46 browser report."""
    variant, phase = _source_identity(mode)
    expected_sources = _check_hash_map(expected_sources, mode)
    if phase == "import":
        parent_evidence = validate_parent_evidence(parent_evidence, mode)
    elif parent_evidence is not None:
        raise BuildControlError("Region reset export cannot carry import parent evidence")
    _require(isinstance(output, bytes) and len(output) <= _MAX_RESULT_BYTES,
             "Region reset browser result exceeds its evidence budget")
    payload = None
    for line in reversed(output.decode("utf-8", "replace").splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    _require(isinstance(payload, Mapping)
             and payload.get("schema") == RESULT_SCHEMA
             and payload.get("scenario") == "study-stage-rerun"
             and payload.get("mode") == mode,
             "Region reset helper reported another scenario or mode")
    _require(payload.get("state") == "passed"
             and payload.get("phase") == "complete"
             and payload.get("outcome") == ("completed" if phase == "import" else "exported")
             and payload.get("failure") is None,
             "Region reset helper did not prove the selected successful terminal outcome")
    _require(payload.get("public_url") == public_url and payload.get("probe_url") == browser_url
             and payload.get("source_hashes_before") == expected_sources
             and payload.get("source_hashes_after") == expected_sources,
             "Region reset helper URL or immutable selected-source pins differ")
    _require(_nonempty(payload.get("api_instance_id"))
             and isinstance(payload.get("session"), Mapping)
             and set(payload["session"]) == {"session_id", "session_epoch", "request_scope_epoch"}
             and all(_nonempty(payload["session"].get(key)) for key in
                     ("session_id", "session_epoch", "request_scope_epoch")),
             "Region reset helper omitted exact API/session scope identity")
    session = payload["session"]
    expected_scope = "session=" + quote(session["session_id"], safe="-_.!~*'()") + "&epoch=" + quote(
        session["session_epoch"], safe="-_.!~*'()") + "&request_scope_epoch=" + quote(
        session["request_scope_epoch"], safe="-_.!~*'()")
    expected_commands = 2 if phase == "import" else 1
    _require(payload.get("command_count") == expected_commands
             and payload.get("command_attempt_count") == expected_commands
             and payload.get("grid_command_count") == 1,
             "Region reset helper solver/grid command counts differ from the fixed UI flow")
    _validate_requests(payload.get("request_counts"), mode)
    _validate_auxiliary_writes(payload, expected_scope)
    _require(payload.get("violations") == [], "Region reset helper reported a forbidden or unrelated write")
    _validate_expected_404s(payload)
    _validate_cleanup(payload)
    _validate_health_read_observations(payload)

    expected_edit_kinds = (["enable"] if phase == "import" else
                           ["region-reset", "disable"] if variant == "local" else ["disable"])
    edits = payload.get("edits")
    _require(isinstance(edits, list) and len(edits) == len(expected_edit_kinds),
             "Region reset helper omitted an exact committed edit receipt")
    last_revision = None
    for edit, kind in zip(edits, expected_edit_kinds, strict=True):
        last_revision = _validate_edit(edit, kind, last_revision, expected_scope)

    imported = payload.get("import")
    source_sha = parent_evidence["script_sha256"] if phase == "import" else expected_sources["fixture"]
    _require(isinstance(imported, Mapping)
             and set(imported) == {"project_id", "source_sha256", "session_id", "scene_revision", "fidelity"}
             and _nonempty(imported.get("project_id"))
             and imported.get("source_sha256") == source_sha
             and imported.get("session_id") == payload["session"]["session_id"]
             and _safe_int(imported.get("scene_revision"))
             and imported.get("fidelity") == "verified",
             "Region reset UI import identity, source digest, or typed-scene fidelity differs")

    if phase == "export":
        _require(payload.get("parent_evidence") is None and "study" not in payload
                 and "stage_only" not in payload,
                 "Region reset export report contains import-only evidence")
        _validate_run(payload.get("baseline"), ["relax-a", "relax-b", "relax-c"],
                      {"kind": "study"}, "baseline")
        baseline_projects = {result["project_id"] for result in payload["baseline"]["results"]}
        _require(baseline_projects == {imported["project_id"]},
                 "Region reset baseline result belongs to another imported project")
        exported = payload.get("export")
        _require(isinstance(exported, Mapping) and set(exported) == {
            "source_text", "source_name", "script_sha256", "scene_revision",
        }, "Region reset canonical export receipt is malformed")
        _, exported_sha = _require_safe_script(exported.get("source_text"), exported.get("source_name"))
        expected_name = f"p22-s46-{variant}.py"
        _require(exported.get("source_name") == expected_name
                 and exported.get("script_sha256") == exported_sha
                 and _safe_int(exported.get("scene_revision"))
                 and exported.get("scene_revision") == last_revision,
                 "Region reset canonical export filename, bytes, digest, or scene revision differs")
        _require(imported["scene_revision"] <= exported["scene_revision"],
                 "Region reset export scene revision precedes the UI import")
        _require(edits[0]["before_revision"] == imported["scene_revision"],
                 "Region reset export edit does not begin at the imported scene revision")
        expected_last_run = payload["baseline"]["run_id"]
    else:
        _require(payload.get("parent_evidence") == parent_evidence and "baseline" not in payload
                 and "export" not in payload,
                 "Region reset import report did not echo the exact authenticated parent evidence")
        _require(edits[0]["before_revision"] == imported["scene_revision"],
                 "Region reset import edit does not begin at the imported scene revision")
        study = payload.get("study")
        stage_only = payload.get("stage_only")
        _validate_run(study, ["relax-a", "relax-c"], {"kind": "study"}, "A/C study")
        _validate_run(stage_only, ["relax-b"], {"kind": "stage_id", "stage_id": "relax-b"}, "B-only")
        _require(study["run_id"] != stage_only["run_id"]
                 and study["command_id"] != stage_only["command_id"],
                 "Region reset import reused a run or accepted command between study and B-only execution")
        study_project = {result["project_id"] for result in study["results"]}
        stage_project = {result["project_id"] for result in stage_only["results"]}
        study_ids = {result["study_id"] for result in study["results"]}
        stage_ids = {result["study_id"] for result in stage_only["results"]}
        _require(len(study_project) == len(stage_project) == 1 and study_project == stage_project
                 and study_project == {imported["project_id"]}
                 and len(study_ids) == len(stage_ids) == 1 and study_ids == stage_ids,
                 "Region reset study/B result identities changed project or Study history")
        expected_last_run = stage_only["run_id"]

    reload_proof = payload.get("reload")
    _require(isinstance(reload_proof, Mapping)
             and set(reload_proof) == {"method", "response_status", "identity_preserved", "run_id"}
             and reload_proof.get("method") == "page.reload"
             and reload_proof.get("response_status") == 200
             and reload_proof.get("identity_preserved") is True
             and reload_proof.get("run_id") == expected_last_run,
             "Region reset reload did not preserve the exact terminal run and session")
    canvas = payload.get("canvas")
    _require(isinstance(canvas, Mapping)
             and canvas.get("context_type") == "WebGL2RenderingContext"
             and canvas.get("context_lost") is False
             and _safe_int(canvas.get("drawing_buffer_width")) and canvas["drawing_buffer_width"] > 0
             and _safe_int(canvas.get("drawing_buffer_height")) and canvas["drawing_buffer_height"] > 0,
             "Region reset reload canvas/WebGL2 proof is incomplete")
    return dict(payload)
