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
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
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
VIEWPORT_DOM_OBSERVATIONS_NOTE = (
    "Viewport dataset and quantity label attributes are DOM observations only; "
    "they do not prove field payload presence or values."
)
LIVE_FIELD_OBSERVATION_NOTE = (
    "Quantity label data-ready and viewport datasets are DOM readiness observations only; "
    "they do not prove field payload presence or values."
)

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


def _validate_existing_control_volume(control: BuildControl) -> None:
    """Authenticate the control volume before any helper mount can create it."""
    volume = _inspect_existing_volume(control.volume, "Selected control volume")
    labels = volume.get("Labels")
    if (
        volume.get("Name") != control.volume
        or volume.get("Driver") != "local"
        or volume.get("Options")
        or not isinstance(labels, Mapping)
        or any(labels.get(key) != value for key, value in control.shared_labels.items())
    ):
        raise BuildControlError(
            "Selected control volume ownership/driver differs; browser QA retains existing data"
        )


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
    # accept its exact alias form, then prove it names the selected local dir.
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
            local_alias.is_dir()
            and expected_path.is_dir()
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


def _validate_frontend_volume(
    control: BuildControl,
    frontend_volume: str,
    frontend_inputs: Mapping[str, object],
) -> None:
    """Require the exact retained frontend volume ownership contract."""
    if frontend_inputs.get("schema") != "fullmag.docker-development-inputs.v1":
        raise BuildControlError("Frontend inputs have an unsupported schema")
    dependency_digest = frontend_inputs.get("dependency_seed_sha256")
    toolpins_digest = frontend_inputs.get("toolpins_sha256")
    if not isinstance(dependency_digest, str) or SHA256_RE.fullmatch(dependency_digest) is None:
        raise BuildControlError("Frontend inputs have an invalid dependency seed digest")
    if not isinstance(toolpins_digest, str) or SHA256_RE.fullmatch(toolpins_digest) is None:
        raise BuildControlError("Frontend inputs have an invalid tool pin digest")
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


def _validate_frontend(
    document: dict[str, object],
    control: BuildControl,
    identity: Mapping[str, str],
    frontend_volume: str,
    current: Mapping[str, object],
    port: int,
    *, cache_project_id: str | None = None,
) -> None:
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
) -> dict[str, object]:
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
    if expect_ambiguous_compute_fields is True and canvas_only is not True:
        raise BuildControlError("Ambiguous Compute Fields QA requires --canvas-only")
    if airbox_inspector and (
        prepare_viewport_fixture
        or canvas_only is not None
        or expect_live_field is not None
        or expect_airbox_vectors is not None
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
    if airbox_inspector:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "airbox-inspector"
    elif saved_playback_item_id is not None:
        environment["CONTROL_ROOM_BROWSER_QA_SCENARIO"] = "saved-playback"
        environment["CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_ITEM_ID"] = saved_playback_item_id
        environment["CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_SCRIPT_SHA256"] = source_script_sha256
    if prepare_viewport_fixture:
        environment["CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE"] = "1"
    if canvas_only is not None:
        environment["CONTROL_ROOM_BROWSER_QA_CANVAS_ONLY"] = "1" if canvas_only else "0"
    if expect_airbox_vectors is not None:
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_LIVE_FIELD"] = expect_live_field or ""
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_AIRBOX_VECTORS"] = "1" if expect_airbox_vectors else "0"
    if expect_ambiguous_compute_fields is not None:
        environment["CONTROL_ROOM_BROWSER_QA_EXPECT_AMBIGUOUS_COMPUTE_FIELDS"] = (
            "1" if expect_ambiguous_compute_fields else "0"
        )
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
                        "/state/development/workspace/apps/control-room/scripts/"
                        + ("verify-airbox-inspector.mjs" if airbox_inspector else "docker-dev-browser-qa.mjs"),
                    ]
                ),
                "volumes": [
                    {
                        "type": "volume",
                        "source": "frontend-state",
                        "target": "/state/development",
                        "read_only": True,
                        "volume": {"nocopy": True},
                    },
                    {
                        "type": "bind",
                        "source": str(selected / "apps/control-room/scripts"),
                        "target": "/state/development/workspace/apps/control-room/scripts",
                        "read_only": True,
                        "bind": {"create_host_path": False},
                    },
                ],
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
) -> None:
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
    environment = set(config.get("Env") or [])
    if {
        "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
        "CONTROL_ROOM_URL=http://frontend:8080",
        "NVIDIA_VISIBLE_DEVICES=void",
    } - environment:
        raise ControlOutcomeUnknown("Browser helper runtime environment differs")
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
    if destinations != expected:
        raise ControlOutcomeUnknown("Browser helper has an unexpected mount boundary")
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


def _validate_viewport_dom_observations(value: object) -> None:
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


def _parse_result(
    output: bytes,
    public_url: str,
    browser_url: str,
    canvas_only: bool = False,
    expect_live_field: str | None = None,
    expect_airbox_vectors: bool = False,
    expect_ambiguous_compute_fields: bool = False,
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
    if (payload.get("expect_live_field") != expect_live_field
            or type(payload.get("expect_airbox_vectors")) is not bool
            or payload["expect_airbox_vectors"] is not expect_airbox_vectors):
        raise BuildControlError("Browser helper live-field expectation differs from the admitted operation")
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
    if expect_ambiguous_compute_fields and not canvas_only:
        raise BuildControlError("Ambiguous Compute Fields result is outside canvas-only QA scope")
    expected_scope = (
        "canvas-home-ambiguous-compute-fields" if expect_ambiguous_compute_fields else
        "canvas-home-live-field-airbox" if expect_airbox_vectors else
        "canvas-home-live-field" if expect_live_field is not None else
        "canvas-home-only" if canvas_only else
        "full-browser-qa"
    )
    if payload.get("qa_scope") != expected_scope:
        raise BuildControlError("Browser helper QA scope differs from the admitted operation")
    expected_skipped = CANVAS_ONLY_SKIPPED_AREAS if canvas_only else []
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
    _validate_viewport_dom_observations(payload.get("viewport_dom_observations"))
    if expect_live_field is not None:
        _validate_live_field_observation(
            payload.get("live_field_observation"), expect_live_field, expect_airbox_vectors
        )
        _validate_canvas_screenshot(payload.get("canvas_screenshot"))
    elif payload.get("live_field_observation") is not None or payload.get("canvas_screenshot") is not None:
        raise BuildControlError("Browser helper reported an unrequested live-field observation")
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
    # Keep resources quarantined until the helper identity, result, durable
    # control-volume evidence, and explicit removal have all been observed.
    observed = _inspect(helper_name)
    _validate_browser_helper(observed, control, identity, frontend_volume, browser_image_id, result.returncode, selected,
        canvas_only=canvas_only,
        expect_live_field=expect_live_field if expect_live_field is not None else None,
        expect_airbox_vectors=expect_airbox_vectors if expect_live_field is not None else None,
        expect_ambiguous_compute_fields=(
            expect_ambiguous_compute_fields
            if not airbox_inspector and saved_playback_item_id is None
            else None
        ),
        airbox_inspector=airbox_inspector,
        saved_playback_item_id=saved_playback_item_id,
        source_script_sha256=source_script_sha256)
    operation["receipt"]["browser_container_id"] = observed["Id"]
    control.write(root + "/receipt.json", operation["receipt"])
    raw = result.stdout
    control.write(root + "/runner-output.json", {
        "schema": "fullmag.docker-dev-browser-qa-runner-output.v1",
        "exit_code": result.returncode,
        "stdout": _text(result.stdout, MAX_RESULT_BYTES),
        "stderr_tail": _text(result.stderr),
    })
    operation["daemon_pending"] = True
    try:
        if saved_playback_item_id is not None:
            if not source_script_sha256:
                raise BuildControlError("Saved Playback helper source hash is missing")
            payload = _parse_saved_playback_result(
                raw, public_url, browser_url, saved_playback_item_id, source_script_sha256,
            )
        elif airbox_inspector:
            if not airbox_inspector_script_sha256:
                raise BuildControlError("Airbox Inspector helper source hash is missing")
            payload = _parse_airbox_inspector_result(
                raw, public_url, browser_url, airbox_inspector_script_sha256
            )
        else:
            payload = _parse_result(raw, public_url, browser_url, canvas_only=canvas_only,
                expect_live_field=expect_live_field, expect_airbox_vectors=expect_airbox_vectors,
                expect_ambiguous_compute_fields=expect_ambiguous_compute_fields)
    except BuildControlError as error:
        control.write(root + "/result.json", {
            "schema": RESULT_SCHEMA,
            "state": "failed-confirmed",
            "exit_code": result.returncode,
            "stdout_tail": _text(result.stdout),
            "stderr_tail": _text(result.stderr),
            "error": str(error),
        })
        _remove_helper(operation, observed["Id"])
        operation["receipt"].update(state="failed-confirmed", error=str(error), exit_code=result.returncode)
        raise
    if result.returncode != 0:
        payload = {**payload, "state": "failed-confirmed", "error": "Browser helper exit code was non-zero"}
    control.write(root + "/result.json", payload)
    if result.returncode != 0:
        _remove_helper(operation, observed["Id"])
        operation["receipt"].update(state="failed-confirmed", error="Browser helper exit code was non-zero", exit_code=result.returncode)
        raise BuildControlError("Browser helper exited with a non-zero status")
    _remove_helper(operation, observed["Id"])
    operation["receipt"].update(state="succeeded", exit_code=0, result_schema=payload["schema"])
    operation["daemon_pending"] = False


def reconcile_browser_qa(control, selected, identity, args):
    """Close one stopped, failed QA attempt; never infer a successful proof."""
    from docker_volume_activation_reconcile import (
        _control_bytes, _probe_helper_absence, _validate_helper,
        _validate_helper_logged, _wait_for_helper_exit,
    )
    attempt = args.reconcile_attempt
    if not re.fullmatch(r"[0-9a-f]{32}", attempt or ""):
        raise BuildControlError("QA reconciliation requires a full attempt UUID")
    for value in (args.expected_receipt_sha256, args.expected_compose_sha256):
        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
            raise BuildControlError("QA reconciliation requires exact receipt and Compose hashes")
    for value in (args.expected_browser_id, args.expected_helper_id):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise BuildControlError("QA reconciliation requires full container IDs")
    root = "browser-qa/attempts/" + attempt
    active_raw = _control_bytes(control, "active", optional=True)
    retained_terminal = control.read(root + "/terminal.json", optional=True)
    already_released = active_raw is None
    if ((already_released and not isinstance(retained_terminal, Mapping))
            or (not already_released and active_raw != (attempt + "\n").encode())):
        raise BuildControlError("QA reconciliation active fence differs")
    receipt_raw = _control_bytes(control, root + "/receipt.json")
    compose_raw = _control_bytes(control, root + "/compose.json")
    if (hashlib.sha256(receipt_raw).hexdigest() != args.expected_receipt_sha256
            or hashlib.sha256(compose_raw).hexdigest() != args.expected_compose_sha256):
        raise BuildControlError("QA reconciliation evidence CAS differs")
    receipt, document = json.loads(receipt_raw), json.loads(compose_raw)
    required = {"phase": "browser-qa", "attempt": attempt, "compose_project": control.project,
                "control_volume": control.volume, "state": "outcome-unknown-resources-retained"}
    if any(receipt.get(key) != value for key, value in required.items()):
        raise BuildControlError("QA reconciliation receipt identity/outcome differs")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, Mapping):
        raise BuildControlError("QA reconciliation inputs are missing")
    if inputs.get("source_root") != str(selected) or inputs.get("worktree_id") != identity["worktree_id"]:
        raise BuildControlError("QA reconciliation source identity differs")
    scenario = inputs.get("scenario", "standard")
    if scenario not in {"standard", "airbox-inspector", "saved-playback"}:
        raise BuildControlError("QA reconciliation scenario is unsupported")
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
    if canvas_only_input and prepare_viewport_fixture:
        raise BuildControlError("Canvas-only browser QA receipt cannot prepare a viewport fixture")
    expected_document = _compose_document(selected, identity, inputs["browser_image"],
        inputs["frontend_volume"], args.port, inputs["browser_runtime_timeout"],
        prepare_viewport_fixture=prepare_viewport_fixture,
        canvas_only=(None if scenario == "saved-playback" or airbox_inspector else canvas_only_compose_pin),
        expect_live_field=(None if scenario == "saved-playback" else expect_live_field_compose_pin),
        expect_airbox_vectors=(None if scenario == "saved-playback" else expect_airbox_compose_pin),
        expect_ambiguous_compute_fields=(
            None if scenario == "saved-playback" or airbox_inspector
            else expect_ambiguous_command_compose_pin
        ),
        airbox_inspector=airbox_inspector,
        saved_playback_item_id=saved_playback_item_id,
        source_script_sha256=source_script_sha256)
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
        canvas_only=(None if scenario == "saved-playback" or airbox_inspector else canvas_only_compose_pin),
        expect_live_field=(None if scenario == "saved-playback" else expect_live_field_compose_pin),
        expect_airbox_vectors=(None if scenario == "saved-playback" else expect_airbox_compose_pin),
        expect_ambiguous_compute_fields=(
            None if scenario == "saved-playback" or airbox_inspector
            else expect_ambiguous_command_compose_pin
        ),
        airbox_inspector=airbox_inspector,
        saved_playback_item_id=saved_playback_item_id,
        source_script_sha256=source_script_sha256)
    service = document["services"]["browser-qa"]
    if (observed["Config"].get("Cmd") != service["command"]
            or observed["Config"].get("Entrypoint") != image["Config"].get("Entrypoint")):
        raise BuildControlError("QA reconciliation browser command differs")
    evidence = {"schema": "fullmag.browser-qa-reconciliation.v1", "state": "failed-confirmed",
        "attempt": attempt, "compose_project": control.project, "output_lost": True,
        "observed_exit_code": state["ExitCode"], "browser_container_id": observed["Id"],
        "receipt_sha256": args.expected_receipt_sha256, "compose_sha256": args.expected_compose_sha256,
        "helper_id": helper_id, "helper_log": helper_log, "browser_inspect": observed,
        "verification": "NOT VERIFIED"}
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
        "--expect-ambiguous-compute-fields",
        action="store_true",
        help="Exercise one real Compute Fields command with its accepted response dropped (canvas-only)",
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
    parser.add_argument("--expected-receipt-sha256")
    parser.add_argument("--expected-compose-sha256")
    parser.add_argument("--expected-browser-id")
    parser.add_argument("--expected-helper-id")
    parser.add_argument(
        "--browser-image",
        default=os.environ.get("FULLMAG_BROWSER_QA_IMAGE", DEFAULT_BROWSER_IMAGE),
    )
    args = parser.parse_args(argv)
    defaults = resolve_defaults(args.repo_root, source_root=args.source_root, port=args.port)
    args.source_root = defaults.source_root
    args.port = defaults.port
    if (
        not 1 <= args.port <= 65535
        or not 30 <= args.timeout <= 900
        or not 60 <= args.pull_timeout <= 1800
    ):
        raise BuildControlError("Browser QA port/timeout/pull-timeout is outside its bounded range")
    if args.canvas_only and args.prepare_viewport_fixture:
        raise BuildControlError("--canvas-only cannot be combined with --prepare-viewport-fixture")
    if args.expect_live_field is not None:
        if (not args.expect_live_field or args.expect_live_field != args.expect_live_field.strip()
                or len(args.expect_live_field) > 512
                or any(ord(character) < 32 or ord(character) == 127 for character in args.expect_live_field)):
            raise BuildControlError("--expect-live-field requires a bounded, non-empty quantity id")
    if (args.expect_live_field is not None or args.expect_airbox_vectors) and not args.canvas_only:
        raise BuildControlError("--expect-live-field and --expect-airbox-vectors require --canvas-only")
    if args.expect_airbox_vectors and args.expect_live_field is None:
        raise BuildControlError("--expect-airbox-vectors requires --expect-live-field")
    if args.expect_ambiguous_compute_fields and not args.canvas_only:
        raise BuildControlError("--expect-ambiguous-compute-fields requires --canvas-only")
    if args.airbox_inspector and (
        args.prepare_viewport_fixture
        or args.canvas_only
        or args.expect_live_field is not None
        or args.expect_airbox_vectors
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
        reconcile_browser_qa(control, selected, identity, args)
        return 0
    current, backend_id, frontend_id, frontend_volume, frontend_inputs = _read_live_development(
        control, selected, identity, args.port
    )
    _validate_frontend_volume(control, frontend_volume, frontend_inputs)
    frontend = _inspect(frontend_id)
    _validate_frontend(frontend, control, identity, frontend_volume, current, args.port, cache_project_id=cache_project_id_for_layout(layout))
    try:
        _validate_live_network(backend_id, frontend_id, control.project, args.port)
    except BuildControlError as error:
        raise BuildControlError(f"Live development group validation failed: {error}") from error
    public_url = f"http://127.0.0.1:{args.port}"
    browser_url = "http://frontend:8080"
    airbox_inspector_script_sha256 = None
    source_script_sha256 = None
    if args.airbox_inspector:
        harness = selected / "apps/control-room/scripts/verify-airbox-inspector.mjs"
        if not harness.is_file():
            raise BuildControlError("Selected checkout is missing the Airbox Inspector browser harness")
        airbox_inspector_script_sha256 = hashlib.sha256(harness.read_bytes()).hexdigest()
    if args.saved_playback_item_id is not None:
        source_script_sha256 = _saved_playback_harness_sha256(selected)
    document = _compose_document(
        selected,
        identity,
        args.browser_image,
        frontend_volume,
        args.port,
        args.timeout,
        prepare_viewport_fixture=args.prepare_viewport_fixture,
        canvas_only=(None if args.airbox_inspector or args.saved_playback_item_id is not None else args.canvas_only),
        expect_live_field=args.expect_live_field,
        expect_airbox_vectors=(args.expect_airbox_vectors if args.expect_live_field is not None else None),
        expect_ambiguous_compute_fields=(
            None if args.airbox_inspector or args.saved_playback_item_id is not None
            else args.expect_ambiguous_compute_fields
        ),
        airbox_inspector=args.airbox_inspector,
        saved_playback_item_id=args.saved_playback_item_id,
        source_script_sha256=source_script_sha256,
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
        "expect_ambiguous_compute_fields": args.expect_ambiguous_compute_fields,
        "scenario": (
            "saved-playback" if args.saved_playback_item_id is not None
            else "airbox-inspector" if args.airbox_inspector
            else "standard"
        ),
        "airbox_inspector_script_sha256": airbox_inspector_script_sha256,
    }
    if args.saved_playback_item_id is not None:
        inputs["saved_playback_item_id"] = args.saved_playback_item_id
        inputs["source_script_sha256"] = source_script_sha256
    with control.operation("browser-qa", inputs) as operation:
        live_fence = control.read("development/current.json")
        if hashlib.sha256(canonical(live_fence)).hexdigest() != current["development_fence_sha256"]:
            raise BuildControlError("Development attempt changed before browser QA admission")
        browser_image_id, _ = _ensure_browser_image(
            operation, control, document, args.browser_image, args.pull_timeout
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
            (None if args.airbox_inspector or args.saved_playback_item_id is not None else args.canvas_only),
            args.expect_live_field,
            args.expect_airbox_vectors,
            args.expect_ambiguous_compute_fields,
            args.airbox_inspector,
            airbox_inspector_script_sha256,
            args.saved_playback_item_id,
            source_script_sha256,
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError, json.JSONDecodeError) as error:
        mirror_console(f"docker-dev-browser-qa: {str(error)[:4096]}\n")
        raise SystemExit(2)
