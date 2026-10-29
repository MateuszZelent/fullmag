"""Reconcile one unknown idle iteration; never restart or reacquire its lease."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
import uuid
from docker_worker_cgroup import CGROUP_FAILURE_SCHEMA
from docker_build_control import (BuildControl, BuildControlError, MAX_DOCUMENT_BYTES,
    bounded_capture, canonical, control_read_script, docker_capture, toolchain_configuration)

SCHEMA = "fullmag.docker-iteration-reconciliation.v1"
FAILED_BUILD_SCHEMA = "fullmag.docker-iteration-failed-build-reconciliation.v1"
PRESTART_SCHEMA = "fullmag.docker-iteration-prestart-reconciliation.v1"
TERMINAL_PRESTART_SCHEMA = "fullmag.docker-terminal-prestart-reconciliation.v1"
FRONTEND_FROZEN_SCHEMA = "fullmag.docker-resume-frontend-frozen-reconciliation.v1"
ACTIVATION_PREFLIGHT_SCHEMA = "fullmag.docker-activation-preflight-reconciliation.v1"
TOOLCHAIN_CANCELED_SCHEMA = "fullmag.docker-toolchain-canceled-reconciliation.v1"
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_raw(control, relative, optional=False):
    path = control.path(relative)
    script = control_read_script(path)
    result = bounded_capture(control.helper_args(script), data=b"")
    if optional and result.returncode == 44:
        return None
    if result.returncode or len(result.stdout) > MAX_DOCUMENT_BYTES:
        raise BuildControlError("Retained document cannot be read within its bound")
    return result.stdout


def require(value, message):
    if not value:
        raise BuildControlError(message)


def fingerprint(actual):
    mounts = actual.get("Mounts")
    require(isinstance(mounts, list), "Container mounts must be an explicit list")
    destinations = set()
    for mount in mounts:
        require(isinstance(mount, dict), "Invalid container mount record")
        destination = mount.get("Destination")
        require(isinstance(destination, str) and destination.startswith("/")
                and not destination.startswith("//") and "\x00" not in destination
                and str(PurePosixPath(destination)) == destination
                and ".." not in PurePosixPath(destination).parts
                and destination not in destinations, "Invalid or duplicate container mount destination")
        destinations.add(destination)
    material = {key: actual[key] for key in ("Id", "Image", "Config", "HostConfig")}
    # Docker's Mounts array order is not stable; retain every field of each unique mount.
    material["Mounts"] = sorted(mounts, key=lambda mount: mount["Destination"])
    return digest(canonical(material))


def validate_request(request):
    if isinstance(request, dict) and request.get("schema") == FRONTEND_FROZEN_SCHEMA:
        from docker_volume_frontend_frozen_recovery import validate_shape
        return validate_shape(request)
    terminal_prestart = isinstance(request, dict) and request.get("schema") == TERMINAL_PRESTART_SCHEMA
    prestart = isinstance(request, dict) and request.get("schema") in (PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA)
    cgroup = isinstance(request, dict) and request.get("schema") == CGROUP_FAILURE_SCHEMA
    failed = isinstance(request, dict) and request.get("schema") in (FAILED_BUILD_SCHEMA, PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA, CGROUP_FAILURE_SCHEMA)
    expected = {"schema", "attempt", "compose_project", "source_root", "port", "config_sha256",
        "unknown_receipt_sha256", "controller_sha256", "containers", "package_documents"}
    if failed:
        expected = (expected - {"package_documents"}) | {"failure"}
    if cgroup:
        expected.add("package_documents")
    if prestart:
        expected.add("prestart_helper_sha256")
    if terminal_prestart:
        expected.update({"history_baseline", "observation", "prior_publication"})
    require(isinstance(request, dict) and set(request) == expected and request["schema"] in (SCHEMA, FAILED_BUILD_SCHEMA, PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA, CGROUP_FAILURE_SCHEMA),
            "Reconciliation request schema/keys differ")
    require(isinstance(request["attempt"], str) and TOKEN.fullmatch(request["attempt"]), "Invalid iteration attempt")
    for key in ("config_sha256", "unknown_receipt_sha256", "controller_sha256"):
        require(isinstance(request[key], str) and SHA.fullmatch(request[key]), "Invalid digest: " + key)
    require(isinstance(request["port"], int) and not isinstance(request["port"], bool)
            and 1024 <= request["port"] <= 65535, "Invalid frontend port")
    require(isinstance(request["containers"], dict) and set(request["containers"]) == {"lease", "backend", "frontend"},
            "All three exact container pins are required")
    for name, pin in request["containers"].items():
        require(isinstance(pin, dict) and set(pin) == {"id", "image", "started_at", "fingerprint"}, "Invalid container pin")
        require(isinstance(pin["id"], str) and SHA.fullmatch(pin["id"])
                and isinstance(pin["image"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", pin["image"])
                and isinstance(pin["fingerprint"], str) and SHA.fullmatch(pin["fingerprint"])
                and isinstance(pin["started_at"], str) and bool(pin["started_at"]), "Incomplete container pin: " + name)
    require(len({pin["id"] for pin in request["containers"].values()}) == 3,
            "Lease/backend/frontend must be distinct containers")
    if cgroup:
        from docker_worker_cgroup import validate_failure_pin
        validate_failure_pin(request["failure"], request["attempt"])
    if terminal_prestart:
        import docker_volume_terminal_prestart_recovery as terminal
        require(isinstance(request["prestart_helper_sha256"], str) and SHA.fullmatch(request["prestart_helper_sha256"]),
                "Invalid terminal prestart helper digest")
        terminal.validate_failure_pin(request["failure"])
        terminal.validate_history_baseline(request["history_baseline"])
        terminal.validate_publication_pin(request["prior_publication"])
        terminal.validate_observation(request["observation"])
        return
    if prestart:
        from docker_volume_prestart_recovery import validate_failure_pin
        require(isinstance(request["prestart_helper_sha256"], str) and SHA.fullmatch(request["prestart_helper_sha256"]), "Invalid prestart helper digest")
        validate_failure_pin(request["failure"])
        return
    if failed and not cgroup:
        proof = request["failure"]
        require(isinstance(proof, dict) and set(proof) == {
            "checkpoint_sha256", "drain_sha256", "log_sha256", "finished_at", "exit_code"},
            "Exact failed-build proof required")
        for key in ("checkpoint_sha256", "drain_sha256", "log_sha256"):
            require(isinstance(proof[key], str) and SHA.fullmatch(proof[key]), "Invalid failed-build digest")
        require(type(proof["exit_code"]) is int and proof["exit_code"] == 2
                and isinstance(proof["finished_at"], str) and bool(proof["finished_at"]),
                "Only a pinned terminal Make failure is supported")
        return
    require(isinstance(request["package_documents"], dict)
            and set(request["package_documents"]) == {"receipt", "provenance"}
            and all(isinstance(v, str) and SHA.fullmatch(v) for v in request["package_documents"].values()),
            "Exact built package receipt/provenance pins are required")


def validate_incarnation(actual, pin, project, *, running=True):
    require(actual.get("Id") == pin["id"] and actual.get("Image") == pin["image"]
            and actual.get("State", {}).get("StartedAt") == pin["started_at"]
            and actual.get("State", {}).get("Running") is running
            and actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") == project
            and fingerprint(actual) == pin["fingerprint"], "Retained container incarnation/configuration differs")


def inspect_pins(request, *, frontend_running=True):
    result = {}
    for name, pin in request["containers"].items():
        records = json.loads(docker_capture("inspect", pin["id"]).stdout)
        require(len(records) == 1, "Ambiguous container inspection")
        validate_incarnation(records[0], pin, request["compose_project"], running=(False if name != "lease" and request["schema"] in (PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA) else
                False if name == "frontend" and request["schema"] == FRONTEND_FROZEN_SCHEMA else
                frontend_running if name == "frontend" else not (name == "backend" and request["schema"] == FAILED_BUILD_SCHEMA)))
        result[name] = records[0]
    return result



def validate_original_owner(actual, original, control, helper_image_id):
    require(actual.get("Name") == "/" + original["helper_container"]
            and actual.get("Image") == helper_image_id
            and actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == "build-control"
            and actual.get("Config", {}).get("User") == "65532:65532"
            and actual.get("HostConfig", {}).get("NetworkMode") == "none"
            and actual.get("HostConfig", {}).get("ReadonlyRootfs") is True
            and actual.get("HostConfig", {}).get("Privileged") is False,
            "Pinned lease is not the original isolated build-control helper")
    mounts = actual.get("Mounts", [])
    require(len(mounts) == 1 and mounts[0].get("Type") == "volume"
            and mounts[0].get("Destination") == "/control" and mounts[0].get("Name") == control.volume
            and mounts[0].get("RW") is True, "Original lease control-volume mount differs")


def validate_partial_journal(control, journal_root, current_raw, original_sha, request_sha):
    current_sha = digest(current_raw)
    if current_sha == original_sha:
        return
    # Never replace a previous retry's proof: the current receipt selects its own immutable entry.
    prepared = control.read(journal_root + "/" + current_sha + "/prepared.json")
    require(prepared.get("request_sha256") == request_sha
            and prepared.get("unknown_receipt_sha256") == original_sha
            and prepared.get("result_sha256") == current_sha,
            "Partial finalization has no exact immutable prepared journal")


def write_immutable(control, relative, raw):
    existing = read_raw(control, relative, optional=True)
    if existing is not None:
        require(existing == raw, "Immutable reconciliation journal changed")
        return
    control.write_bytes(relative, raw)


def validate_package(request):
    import fullmag_docker_runtime as runtime
    raw = docker_capture("exec", request["containers"]["backend"]["id"], "/usr/local/bin/python3", "-B", "-c",
                         runtime._BACKEND_BUILD_DOCUMENTS_SCRIPT)
    observed = json.loads(raw.stdout)
    for name in ("receipt", "provenance"):
        require(observed[name]["sha256"] == request["package_documents"][name]
                and observed[name]["value"].get("state") == "succeeded", "Built package document differs: " + name)
    require(observed["provenance"]["value"].get("build_receipt_sha256") == observed["receipt"]["sha256"],
            "Package provenance is not bound to its receipt")
    return observed


def validate_failed_build_state(actual, failure, log):
    state = actual.get("State", {})
    require(state.get("Status") == "exited" and state.get("Running") is False
            and state.get("OOMKilled") is False and state.get("Dead") is False
            and state.get("Restarting") is False and state.get("ExitCode") == failure["exit_code"]
            and state.get("FinishedAt") == failure["finished_at"]
            and not state.get("Error"), "Backend failure is not terminal or differs from its pin")
    require(digest(log) == failure["log_sha256"], "Failed build log CAS differs")
    text = log.decode("utf-8", "strict")
    require(re.search(r"^backend-dev: phase=make state=complete exit_code=2 duration_ms=[0-9]+$", text, re.M)
            and text.rstrip().endswith("backend-dev: canonical Make target failed with exit code 2"),
            "Log does not end at the canonical failed Make boundary")


def validate_failed_build(control, root, request, original, actual, state):
    import docker_volume_dev as dev
    from docker_volume_stop_unadmitted import _read_terminal_process_receipt
    if request["schema"] == FRONTEND_FROZEN_SCHEMA:
        from docker_volume_frontend_frozen_recovery import validate_failure
        return validate_failure(control, root, request, original, actual, state)
    if request["schema"] == TERMINAL_PRESTART_SCHEMA:
        from docker_volume_terminal_prestart_recovery import validate_failure
        return validate_failure(control, root, request, original, actual, state)
    if request["schema"] == PRESTART_SCHEMA:
        from docker_volume_prestart_recovery import validate_failure
        return validate_failure(control, root, request, original, actual, state)
    if request["schema"] == CGROUP_FAILURE_SCHEMA:
        from docker_worker_cgroup import validate_failure
        return validate_failure(control, root, request, original, actual, state)
    proof = request["failure"]
    checkpoint_raw = read_raw(control, root + "/saved-authoring-checkpoint.json")
    drain_raw = read_raw(control, root + "/backend-drain.json")
    require(digest(checkpoint_raw) == proof["checkpoint_sha256"]
            and digest(drain_raw) == proof["drain_sha256"], "Retained checkpoint/drain CAS differs")
    checkpoint, drain = json.loads(checkpoint_raw), json.loads(drain_raw)
    require(checkpoint.get("archive") == original.get("saved_authoring_restore_required")
            and isinstance(checkpoint.get("archive"), dict), "Saved authoring restore obligation differs")
    dev._saved_authoring_read_archive(checkpoint, state)
    current_raw, current = _read_terminal_process_receipt(actual["backend"], control)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drain.get("backend_container_id") == request["containers"]["backend"]["id"]
            and digest(current_raw) == drain.get("process_receipt_sha256")
            and current == drain.get("process_receipt") and current.get("state") == "drained",
            "Runtime process receipt changed after the pre-build drain")
    output = docker_capture("logs", "--since", request["containers"]["backend"]["started_at"],
                            request["containers"]["backend"]["id"])
    log = output.stdout + output.stderr
    require(len(log) <= MAX_DOCUMENT_BYTES, "Failed build log exceeds observation bound")
    validate_failed_build_state(actual["backend"], proof, log)
    require(read_raw(control, root + "/backend-build-receipt.json", optional=True) is None,
            "Build publication already crossed the failure-only boundary")
    return {"checkpoint_sha256": digest(checkpoint_raw), "drain_sha256": digest(drain_raw),
            "log_sha256": digest(log), "exit_code": proof["exit_code"],
            "finished_at": proof["finished_at"]}


def claim_script(control, root, request, current_receipt_sha, *, phase="iteration", publish_verified=True):
    attempt = request["attempt"]
    path = control.path(root)
    marker = "__RESULT_SHA__"
    commit = commit_script(control, root, request, root + "/reconciliation/" + marker,
                           marker, current_receipt_sha, phase=phase, publish_verified=publish_verified)
    # All interpolated paths are control.path-validated. The only dynamic value is a strict hex digest.
    commit = commit.replace("'", '"').replace(marker, "${result_sha}")
    # One daemon helper owns the observer flock from READY through the final terminal publication.
    # EOF before BEGIN is safe: no _finish operation has started. After BEGIN every unknown outcome retains the lock.
    return ("umask 027; "
        f"test ! -L '{path}/reconcile-observer.lock'; "
        f"if test -e '{path}/reconcile-observer.lock'; then test -f '{path}/reconcile-observer.lock'; "
        f"test $(stat -c %h '{path}/reconcile-observer.lock') = 1; fi; "
        f"exec 9>'{path}/reconcile-observer.lock'; flock -n 9; "
        f"test \"$(cat /control/active)\" = '{attempt}'; "
        f"test \"$(sha256sum '{path}/receipt.json' | cut -d' ' -f1)\" = '{current_receipt_sha}'; "
        f"test ! -e '{path}/terminal.json'; "
        "exec 8<>/control/operation.lock; if flock -n 8; then exit 72; fi; "
        "trap '' PIPE; "
        "retain_unknown() { printf 'RETAINED\\n' || true; while :; do sleep 1; done; }; "
        "printf 'READY\\n'; "
        "if ! IFS=' ' read -r decision extra; then exit 0; fi; "
        "test \"$decision\" = BEGIN; test -z \"$extra\"; "
        "printf 'OBSERVING\\n' || true; "
        "if ! IFS=' ' read -r decision result_sha extra; then retain_unknown; fi; "
        "if test \"$decision\" != COMMIT || test -n \"$extra\" "
        "|| ! [[ \"$result_sha\" =~ ^[0-9a-f]{64}$ ]]; then retain_unknown; fi; "
        + commit + "; printf 'COMMITTED\\n'")


def commit_script(control, root, request, journal_relative, result_sha, current_receipt_sha, *, phase="iteration", publish_verified=True):
    path = control.path(root)
    journal = control.path(journal_relative)
    original = request["unknown_receipt_sha256"]
    activation = (phase == "activation" and publish_verified is False
                  and request.get("schema") == ACTIVATION_PREFLIGHT_SCHEMA)
    toolchain = (phase == "toolchain" and publish_verified is False
                 and request.get("schema") == TOOLCHAIN_CANCELED_SCHEMA)
    frozen = phase == "resume" and not publish_verified and request.get("schema") == FRONTEND_FROZEN_SCHEMA
    require(activation or toolchain or frozen or (phase, publish_verified) in (("iteration", True), ("iteration", False), ("boris-reference", False)), "Closed reconciliation phase required")
    require(phase != "iteration" or publish_verified
            or request.get("schema") in (FAILED_BUILD_SCHEMA, PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA, CGROUP_FAILURE_SCHEMA), "Failure-only publication requires its explicit schema")
    require(not publish_verified or request.get("schema") not in (FAILED_BUILD_SCHEMA, PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA, CGROUP_FAILURE_SCHEMA, FRONTEND_FROZEN_SCHEMA),
            "A failed iteration cannot publish a verified success")
    phase = control.path(phase)
    targets = f"'{path}/receipt.json' '{phase}/current.json' " + (f"'{phase}/verified.json' " if publish_verified else "") + f"'{path}/terminal.json'"
    marker_commit = ""
    if activation:
        require(SHA.fullmatch(request.get("started_marker_sha256", "")) is not None,
                "Exact started marker digest required")
        marker = control.path(request["marker_relative"])
        prepared_marker = journal + "/marker.json"
        require(SHA.fullmatch(request.get("prepared_marker_sha256", "")) is not None,
                "Exact prepared marker digest required")
        marker_commit = (
            f"test -f '{marker}'; test ! -L '{marker}'; test $(stat -c %h '{marker}') = 1; "
            f"m=$(sha256sum '{marker}' | cut -d' ' -f1); "
            f"expected='{request['prepared_marker_sha256']}'; "
            f"test \"$(sha256sum '{prepared_marker}' | cut -d' ' -f1)\" = \"$expected\"; "
            f"test \"$m\" = '{request['started_marker_sha256']}' || test \"$m\" = \"$expected\"; "
            f"parent=$(dirname '{marker}'); test \"$(readlink -f \"$parent\")\" = \"$parent\"; "
            "t=$(mktemp \"$parent/.reconcile.XXXXXXXX\"); "
            f"cat '{prepared_marker}' > \"$t\"; sync \"$t\"; mv -T -- \"$t\" '{marker}'; sync \"$parent\"; "
        )
    if toolchain:
        # Failure-only CAS preserves the last verified image and permits exact partial replay.
        marker_commit = "exec 8<>/control/operation.lock; if flock -n 8; then exit 72; fi; "
        for relative, expected, allow_result in (
            ("toolchain/current.json", request["phase_current_sha256"], True),
            ("toolchain/verified.json", request["verified_sha256"], False),
            (root + "/compose.json", request["compose_sha256"], False),
            (root + "/build.log", request["build_log_sha256"], False),
        ):
            require(expected is None or SHA.fullmatch(expected), "Invalid toolchain document pin")
            target = control.path(relative)
            marker_commit += f"test ! -L '{target}'; "
            check = (f"test -f '{target}'; test $(stat -c %h '{target}') = 1; "
                     f"s=$(sha256sum '{target}' | cut -d' ' -f1); ")
            if expected is None:
                if allow_result:
                    marker_commit += (f"if test -e '{target}'; then " + check
                                      + f"test \"$s\" = '{result_sha}'; fi; ")
                else:
                    marker_commit += f"test ! -e '{target}'; "
            else:
                marker_commit += check + f"test \"$s\" = '{expected}'"
                if allow_result:
                    marker_commit += f" || test \"$s\" = '{result_sha}'"
                marker_commit += "; "
    # Each write is atomic; a prepared journal admits only the original or exact prepared receipt.
    return ("umask 027; "
        f"test ! -L '{path}/reconcile-commit.lock'; "
        f"if test -e '{path}/reconcile-commit.lock'; then test -f '{path}/reconcile-commit.lock'; "
        f"test $(stat -c %h '{path}/reconcile-commit.lock') = 1; fi; "
        f"exec 7>'{path}/reconcile-commit.lock'; flock -n 7; "
        f"test \"$(cat /control/active)\" = '{request['attempt']}'; "
        f"test \"$(sha256sum '{path}/unknown-receipt.json' | cut -d' ' -f1)\" = '{original}'; "
        f"test \"$(sha256sum '{journal}/result.json' | cut -d' ' -f1)\" = '{result_sha}'; "
        f"s=$(sha256sum '{path}/receipt.json' | cut -d' ' -f1); "
        f"test \"$s\" = '{current_receipt_sha}'; "
        f"test ! -e '{path}/terminal.json'; "
        + marker_commit +
        f"for p in {targets}; do "
        "test ! -L \"$p\"; parent=$(dirname \"$p\"); test \"$(readlink -f \"$parent\")\" = \"$parent\"; "
        "t=$(mktemp \"$parent/.reconcile.XXXXXXXX\"); "
        f"cat '{journal}/result.json' > \"$t\"; sync \"$t\"; mv -T -- \"$t\" \"$p\"; sync \"$parent\"; done")


def reconcile(args):
    from docker_dev import _require_native_windows, _select_source, _compose_identity
    import docker_backend_volume_cache as cache_adapter
    import docker_volume_dev as dev
    from windows_folder_host import read_owned_regular
    import fullmag_storage as storage
    from docker_dev_host import require_host
    require_host()
    selected, layout = _select_source(Path(args.source_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    control.prepare()
    request_raw = read_raw(control, args.request)
    require(SHA.fullmatch(args.request_sha256) and digest(request_raw) == args.request_sha256, "Request CAS differs")
    request = json.loads(request_raw)
    if isinstance(request, dict) and request.get("schema") == ACTIVATION_PREFLIGHT_SCHEMA:
        from docker_activation_preflight_runtime import reconcile_preflight
        return reconcile_preflight(args, control, selected, request, request_raw)
    frontend_frozen = isinstance(request, dict) and request.get("schema") == FRONTEND_FROZEN_SCHEMA
    terminal_prestart = isinstance(request, dict) and request.get("schema") == TERMINAL_PRESTART_SCHEMA
    prestart = isinstance(request, dict) and request.get("schema") in (PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA)
    cgroup = isinstance(request, dict) and request.get("schema") == CGROUP_FAILURE_SCHEMA
    typed_failure = frontend_frozen or prestart or cgroup or (isinstance(request, dict) and request.get("schema") == FAILED_BUILD_SCHEMA)
    require(typed_failure or not getattr(args, "preview", False), "Preview is scoped to a typed failure reconciliation")
    if not typed_failure:
        _require_native_windows()
    if isinstance(request, dict) and request.get("schema") == "fullmag.boris.preproducer-reconciliation.v1":
        from docker_boris_volume import reconcile_preproducer
        return reconcile_preproducer(args, control, selected, request, request_raw)
    validate_request(request)
    failed_build = frontend_frozen or request["schema"] in (FAILED_BUILD_SCHEMA, PRESTART_SCHEMA, TERMINAL_PRESTART_SCHEMA, CGROUP_FAILURE_SCHEMA)
    require(request["source_root"] == str(selected) and request["compose_project"] == control.project
            and request["port"] == args.port, "Selected checkout/group/port differs")
    require(digest(Path(__file__).read_bytes()) == request["controller_sha256"], "Controller code differs from reviewed request")
    phase = "resume" if frontend_frozen else "iteration"
    root = phase + "/attempts/" + request["attempt"]
    journal_root = root + "/reconciliation"
    current_raw = read_raw(control, root + "/receipt.json")
    saved = read_raw(control, root + "/unknown-receipt.json", optional=True)
    original_raw = saved if saved is not None else current_raw
    require(digest(original_raw) == request["unknown_receipt_sha256"], "Unknown receipt CAS differs")
    original = json.loads(original_raw)
    require(original.get("schema") == "fullmag.docker-build-operation.v1" and original.get("phase") == phase
            and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("attempt") == request["attempt"] and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume, "Only the exact unknown iteration is admissible")
    require(failed_build or not original.get("saved_authoring_restore_required"),
            "Saved-authoring success requires its completion gate; retained for dedicated recovery")
    require(prestart or original.get("backend_started_at") == request["containers"]["backend"]["started_at"], "Recorded backend start differs")
    require(original.get("helper_container") == "fullmag-control-" + request["attempt"], "Recorded lease owner differs")
    base_attempt = original.get("inputs", {}).get("attempt")
    require(isinstance(base_attempt, str) and TOKEN.fullmatch(base_attempt), "Missing original development attempt")
    document = control.read(("development/attempts/" + base_attempt if frontend_frozen else root) + "/compose.json")
    require(digest(canonical(document)) == request["config_sha256"] and document.get("name") == control.project
            and original.get("inputs", {}).get("config_sha256") == request["config_sha256"], "Compose CAS differs")
    require(frontend_frozen or (original["inputs"].get("image_id") == request["containers"]["backend"]["image"]
            and original["inputs"].get("source_root") == str(selected)), "Original source/image differs")
    base_attempt = original["inputs"].get("attempt")
    require(isinstance(base_attempt, str) and TOKEN.fullmatch(base_attempt), "Missing original development attempt")
    base = "development/attempts/" + base_attempt
    previous = control.read(base + "/terminal.json")
    if frontend_frozen:
        from docker_volume_frontend_frozen_recovery import validate_base
        validate_base(control, request, original, previous, document, selected)
    elif terminal_prestart:
        from docker_volume_terminal_prestart_recovery import prior_publication
        require(previous.get("state") in {"failed-confirmed", "succeeded"}
                and previous.get("attempt") == base_attempt
                and previous.get("compose_project") == control.project
                and previous.get("state_root") == original.get("state_root")
                and previous.get("backend_volumes") == original.get("backend_volumes")
                and previous.get("frontend_volume") == original.get("frontend_volume")
                and digest(read_raw(control, base + "/terminal.json")) == request["failure"]["previous_receipt_sha256"]
                and digest(canonical(control.read(base + "/compose.json"))) == request["config_sha256"],
                "Original terminal development resources differ")
        prior_publication(control, request, original)
    else:
        require(previous.get("state") == "succeeded" and previous.get("attempt") == base_attempt
                and previous.get("compose_project") == control.project
                and previous.get("state_root") == original.get("state_root")
                and previous.get("backend_volumes") == original.get("backend_volumes")
                and previous.get("frontend_volume") == original.get("frontend_volume")
                and previous.get("config_sha256") == request["config_sha256"]
                and previous.get("backend_container") == request["containers"]["backend"]["id"]
                and previous.get("frontend_container") == request["containers"]["frontend"]["id"],
                "Original development resources differ")
    image = request["containers"]["backend"]["image"]
    environment = document["services"]["backend"]["environment"]
    require(environment.get("FULLMAG_STARTUP_ENABLED") != "1", "Reconciliation never repeats startup Solve")
    ports = document["services"]["frontend"].get("ports", [])
    require(len(ports) == 1 and str(ports[0].get("published")) == str(args.port)
            and ports[0].get("host_ip") == "127.0.0.1", "Pinned frontend loopback port differs")
    dev._operator_probe_record_from_retained(original, document)
    cache = control.read(base + "/backend-cache.json")
    state = storage.validate_path(Path(original["state_root"]), layout["runtime_root"], "retained Windows sessions")
    if typed_failure:
        certificate_path = dev._certificate_path(state)
        certificate = dev._retained_certificate(state, document)
        ledger_profile = None  # Failure-only reconciliation never calls _finish.
    else:
        certificate_path = state / "windows-folder-host.json"
        certificate = json.loads(read_owned_regular(certificate_path))
        require(json.loads(read_owned_regular(state / ".fullmag-windows-folder-owner.json")) == certificate,
                "Windows storage certificate/owner differs")
        ledger_profile = {"profile": "host-ledger-v1", "image_id": image, "environment": environment,
            "mount_root": environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"],
            "project_id": environment["FULLMAG_HOST_LEDGER_PROJECT_ID"],
            "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"],
            "host_receipt": control.read(base + "/host-ledger.json"),
            "maintenance_document": control.read(base + "/ledger-maintenance-compose.json")}
    image_config = json.loads(docker_capture("image", "inspect", image).stdout)[0]["Config"]
    actual = inspect_pins(request)
    helper_image_id = json.loads(docker_capture("image", "inspect", control.image).stdout)[0]["Id"]
    validate_original_owner(actual["lease"], original, control, helper_image_id)
    ids = {name: request["containers"][name]["id"] for name in ("backend", "frontend")}
    for name in ids:
        dev._validate_retained_service(document, actual[name], name, image_config,
                                      expected_started_at=request["containers"][name]["started_at"])
    cache_adapter.validate_container(actual["backend"], cache)
    dev._assert_private_restart_network(actual, ids, control.project)
    if failed_build:
        validate_failed_build(control, root, request, original, actual, state)
    else:
        validate_package(request)
    validate_partial_journal(control, journal_root, current_raw,
                             request["unknown_receipt_sha256"], args.request_sha256)
    observer_script = claim_script(control, root, request, digest(current_raw), phase=phase, publish_verified=not failed_build)
    if typed_failure and getattr(args, "preview", False):
        print(json.dumps({"state": "validated-only", "attempt": request["attempt"], "schema": request["schema"]}))
        return
    claim_name = "fullmag-iteration-observer-" + uuid.uuid4().hex
    claim = subprocess.Popen(control.helper_args(observer_script, name=claim_name),
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    admitted = False
    observation_error = None
    observer_record = None
    begin_requested = False
    try:
        require(control._line(claim) == "READY", "Concurrent or changed observer; no lease takeover")
        admitted = True
        observer_inspection = json.loads(docker_capture("inspect", claim_name).stdout)
        require(len(observer_inspection) == 1, "Ambiguous observer helper")
        observer_actual = observer_inspection[0]
        validate_original_owner(observer_actual, {"helper_container": claim_name}, control, helper_image_id)
        require(SHA.fullmatch(observer_actual.get("Id", ""))
                and observer_actual.get("State", {}).get("Running") is True
                and bool(observer_actual.get("State", {}).get("StartedAt")), "Observer helper is not confirmed live")
        observer_record = {"container_name": claim_name, "container_id": observer_actual["Id"],
            "image_id": observer_actual["Image"], "started_at": observer_actual["State"]["StartedAt"],
            "fingerprint": fingerprint(observer_actual), "request_sha256": args.request_sha256,
            "phase": "BEGIN-requested", "outcome": "pending-observation"}
        inspect_pins(request)
        if saved is None:
            control.write_bytes(root + "/unknown-receipt.json", original_raw)
        result = copy.deepcopy(original)
        if not failed_build:
            result.pop("error", None)
        result.pop("finished_at", None)
        result.update(state="reconciling-publication", reconciliation={"schema": SCHEMA,
            "request": args.request, "request_sha256": args.request_sha256,
            "unknown_receipt_sha256": request["unknown_receipt_sha256"], "controller_sha256": request["controller_sha256"],
            "observer_container": claim_name, "observer": observer_record,
            "evidence": request["failure"] if failed_build else request["package_documents"]})
        operation = {"receipt": result, "root": root, "daemon_pending": False}
        git_common = Path(next(m["source"] for m in document["services"]["backend"]["volumes"]
                               if m["target"] == "/opt/fullmag/source-git"))
        # Persist the exact observer incarnation before a daemon-side _finish operation can outlive this client.
        control.write(journal_root + "/observers/" + observer_record["container_id"] + ".json", observer_record)
        begin_requested = True
        claim.stdin.write(b"BEGIN\n")
        claim.stdin.flush()
        require(control._line(claim) == "OBSERVING", "Observer BEGIN outcome unknown; resources retained")
        if failed_build:
            actual = inspect_pins(request)
            result["frontend_frozen_failure_proof" if frontend_frozen else "cgroup_failure_proof" if cgroup else "terminal_prestart_failure_proof" if terminal_prestart
                   else "prestart_failure_proof" if prestart else "failed_build_proof"] = validate_failed_build(control, root, request, original, actual, state)
            if frontend_frozen:
                proof = result["frontend_frozen_failure_proof"]
                result.update(app_source=proof["app_source"], helper_source=proof["helper_source"],
                              helper_transition_manifest_sha256=proof["transition_manifest_sha256"])
            result.update(state="failed-confirmed", backend_container=ids["backend"],
                          frontend_container=ids["frontend"])
        else:
            dev._finish(control, operation, document, ids["backend"], ids["frontend"], selected, state,
                certificate_path, certificate, cache, {"image_id": environment["FULLMAG_TOOLCHAIN_IMAGE_ID"]},
                image, git_common, ledger_profile, args.port)
            require(result.get("state") == "succeeded", "Existing finish gates did not succeed")
            validate_package(request)
        inspect_pins(request)
        require(claim.poll() is None, "Observer exclusion lease disappeared")
        result["finished_at"] = time.time()
        result["filesystem_after"] = control.space()
        result_raw = canonical(result) + b"\n"
        transaction_root = journal_root + "/" + digest(result_raw)
        write_immutable(control, transaction_root + "/result.json", result_raw)
        write_immutable(control, transaction_root + "/prepared.json", canonical({"schema": SCHEMA,
            "request_sha256": args.request_sha256, "unknown_receipt_sha256": request["unknown_receipt_sha256"],
            "result_sha256": digest(result_raw)}) + b"\n")
        # Commit is performed by the SAME daemon helper that owns the observer lock.
        # Sending a complete line hands off execution, never ownership of that lock.
        claim.stdin.write(("COMMIT " + digest(result_raw) + "\n").encode("ascii"))
        claim.stdin.flush()
        claim.stdin.close()
        require(control._line(claim) == "COMMITTED", "Finalization outcome unknown; original owner/journal retained")
        require(read_raw(control, root + "/terminal.json") == result_raw, "Terminal publication differs")
        if cgroup:
            require(digest(read_raw(control, "iteration/verified.json")) == request["failure"]["verified_sha256"],
                    "Failure-only publication changed the last verified iteration")
        # The old helper alone removes active after seeing terminal; we never unlink it.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status = bounded_capture(control.helper_args("test ! -e /control/active"), data=b"")
            if status.returncode == 0:
                break
            time.sleep(.25)
        else:
            raise BuildControlError("Terminal exists but original lease release is not confirmed")
        print(json.dumps({key: result[key] for key in ("state", "attempt", "compose_project", "backend_container")}, indent=2))
    except BaseException as error:
        observation_error = error
        if admitted:
            control.write(journal_root + "/last-observation-error.json", {"schema": SCHEMA,
                "request_sha256": args.request_sha256, "error": str(error), "observed_at": time.time(),
                "observer": observer_record, "begin_may_have_started": begin_requested,
                "state": "observer-outcome-unknown-retained" if begin_requested else "failed-before-BEGIN",
                "requires_dedicated_observer_recovery": begin_requested,
                "action": "retain original owner/active, exact observer, and partial journal; inspect terminal before any dedicated recovery"})
        raise
    finally:
        if claim.stdin is not None and not claim.stdin.closed:
            claim.stdin.close()
        # Reap only this observer client; never stop the original helper or application services.
        try:
            claim.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if observation_error is not None:
                observation_error.add_note("Observer helper outcome unknown; daemon resources retained")
            else:
                raise BuildControlError("Observer helper outcome unknown; daemon resources retained")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--preview", action="store_true", help="Read-only validation of a typed failure reconciliation")
    reconcile(parser.parse_args())


if __name__ == "__main__":
    main()
