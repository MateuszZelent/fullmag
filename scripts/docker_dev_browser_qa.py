"""Run the managed browser proof against one live volume DEV frontend.

The host process only resolves the selected checkout and observes Docker. The
short-lived browser service owns no build/cache/user-data writes; the durable
attempt and result are published through BuildControl into the selected control
volume.
"""
from __future__ import annotations

import argparse
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
OPERATION_SCHEMA = "fullmag.docker-dev-browser-qa.v1"
BROWSER_IMAGE_RE = re.compile(
    r"^mcr\.microsoft\.com/playwright:v1\.62\.1-noble@sha256:([0-9a-f]{64})$"
)
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_RESULT_BYTES = 2 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


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
    cache_key = hashlib.sha256(
        canonical(
            {
                "project": control.project,
                "dependencies": dependency_digest,
                "tools": toolpins_digest,
            }
        )
    ).hexdigest()
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


def _validate_frontend(
    document: dict[str, object],
    control: BuildControl,
    identity: Mapping[str, str],
    frontend_volume: str,
    current: Mapping[str, object],
    port: int,
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
    for mount in mounts:
        if not isinstance(mount, Mapping):
            raise BuildControlError("Frontend mount record is invalid")
        if mount.get("Type") == "bind" and mount.get("RW") is not False:
            raise BuildControlError("Frontend has a writable host bind")
        if mount.get("Type") == "volume" and mount.get("Name") not in {frontend_volume, control.volume}:
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
) -> dict[str, object]:
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
    if prepare_viewport_fixture:
        environment["CONTROL_ROOM_PREPARE_VIEWPORT_FIXTURE"] = "1"
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
                "working_dir": "/state/development/workspace/apps/control-room",
                "command": [
                    "node",
                    "/state/development/workspace/apps/control-room/scripts/docker-dev-browser-qa.mjs",
                ],
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
    environment = set(config.get("Env") or [])
    if {
        "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
        "CONTROL_ROOM_URL=http://frontend:8080",
        "NVIDIA_VISIBLE_DEVICES=void",
    } - environment:
        raise ControlOutcomeUnknown("Browser helper runtime environment differs")
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
    expected_script_source = _mount_path(selected / "apps/control-room/scripts")
    if (
        script_mount.get("Type") != "bind"
        or _mount_path(script_mount.get("Source")) != expected_script_source
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


def _parse_result(output: bytes, public_url: str, browser_url: str) -> dict[str, object]:
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
    if payload.get("home_round_trip") is not True:
        raise BuildControlError("Browser helper did not prove the Home round trip")
    _validate_session_result(payload.get("session"))
    workspace = payload.get("workspace")
    if (not isinstance(workspace, Mapping) or workspace.get("visible") is not True
            or workspace.get("canvas_dom_stable") is not True):
        raise BuildControlError("Browser helper did not prove a visible, stable workspace canvas")
    _validate_canvas_result(payload.get("canvas_before"), "before Home")
    _validate_canvas_result(payload.get("canvas_after"), "after Home")
    for key in ("page_errors", "console_errors", "request_failures"):
        if type(payload.get(key)) is not int or payload[key] != 0:
            raise BuildControlError(f"Browser helper reported {key}; result is not valid evidence")
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


def _run(operation: dict[str, object], control: BuildControl, document: dict[str, object], identity: Mapping[str, str], selected: Path, frontend_volume: str, browser_image_id: str, public_url: str, browser_url: str, timeout: int) -> None:
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
            timeout=timeout,
            allow_failure=True,
        )
    except ControlOutcomeUnknown:
        raise
    # Keep resources quarantined until the helper identity, result, durable
    # control-volume evidence, and explicit removal have all been observed.
    observed = _inspect(helper_name)
    _validate_browser_helper(observed, control, identity, frontend_volume, browser_image_id, result.returncode, selected)
    operation["receipt"]["browser_container_id"] = observed["Id"]
    control.write(root + "/receipt.json", operation["receipt"])
    raw = result.stdout
    control.write(root + "/runner-output.json", {
        "schema": "fullmag.docker-dev-browser-qa-runner-output.v1",
        "exit_code": result.returncode,
        "stdout": _text(result.stdout, MAX_RESULT_BYTES // 2),
        "stderr_tail": _text(result.stderr),
    })
    operation["daemon_pending"] = True
    try:
        payload = _parse_result(raw, public_url, browser_url)
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
    prepare_viewport_fixture = inputs.get("prepare_viewport_fixture", False)
    if type(prepare_viewport_fixture) is not bool:
        raise BuildControlError("QA reconciliation viewport fixture input must be boolean")
    expected_document = _compose_document(selected, identity, inputs["browser_image"],
        inputs["frontend_volume"], args.port, inputs["browser_runtime_timeout"],
        prepare_viewport_fixture=prepare_viewport_fixture)
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
        image_id, state["ExitCode"], selected)
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
    _validate_frontend(frontend, control, identity, frontend_volume, current, args.port)
    try:
        _validate_live_network(backend_id, frontend_id, control.project, args.port)
    except BuildControlError as error:
        raise BuildControlError(f"Live development group validation failed: {error}") from error
    public_url = f"http://127.0.0.1:{args.port}"
    browser_url = "http://frontend:8080"
    document = _compose_document(
        selected,
        identity,
        args.browser_image,
        frontend_volume,
        args.port,
        args.timeout,
        prepare_viewport_fixture=args.prepare_viewport_fixture,
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
    }
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
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildControlError, ControlOutcomeUnknown, OSError, ValueError, json.JSONDecodeError) as error:
        mirror_console(f"docker-dev-browser-qa: {str(error)[:4096]}\n")
        raise SystemExit(2)
