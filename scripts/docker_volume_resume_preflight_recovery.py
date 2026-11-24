"""Confirm one pre-daemon layout refusal without taking its live owner's lease."""
from __future__ import annotations
import argparse
import copy
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid
from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, toolchain_configuration
from docker_volume_reconcile import (digest, fingerprint, read_raw, require, write_immutable,
    validate_incarnation, validate_original_owner, claim_script)
from docker_volume_development_interrupted import _docker_timestamp_ns, validate_gate_container_mounts, _compose_state_root
from docker_volume_activation_reconcile import _validate_helper_logged

SCHEMA = "fullmag.docker-resume-preflight-failure.v1"
ATTEMPT = "60f7397f1d774a90a63d3fc16c5689e3"
BASE = "09064b744fb045bea6ffff853dd25c1f"
ORIGINAL = "e7a328af9ee23b58e3b0a01a8d725acc801666524c160c0b5c3f793c00deb84d"
RAW_COMPOSE = "f6ecdd7ff5b37e92467f5a99c09da3eb16b3ded1f7dc88ff0be6b95782dadbed"
COMPOSE = "0b2bae70f17f628a22b7b6ff841c17f08d56f3a0c6ce5de9c3de9341f0e5742b"
ERROR = "Single-volume group cannot fall back to legacy volume allocation; resume its pinned layout"
ROOT = "resume/attempts/" + ATTEMPT
BASE_ROOT = "development/attempts/" + BASE
SERVICES = ("backend", "frontend")
APPROVED_IDS = {
    "lease": "cb86b48ab9fb40f025b8559cba3ca39142bfcf7e9a6f28eb6d2bd3ce1d9f4f6b",
    "backend": "dc444bca873f3bb223575063173bbb2670b32e37327882b770c93a97980e7d07",
    "frontend": "725a55ad76e770d414991ef47741195ecb5efd97310a7c7a233a9d960c163c47",
}
ABSENT = (
    "runtime-control/runtime-services/OWNER.json", "runtime-control/runtime-services/LAUNCH.json",
    "runtime-control/runtime-services/OWNER.lock", "runtime-control/runtime-service/process-tree.json",
    "runtime-control/runtime-service/docker-all.json",
)
CONTROLLERS = (
    "docker_volume_resume_preflight_recovery.py", "docker_volume_resume_protected.py",
    "docker_volume_reconcile.py", "docker_build_control.py", "docker_volume_dev.py",
    "docker_volume_development_interrupted.py", "docker_volume_activation_reconcile.py",
    "docker_volume_succeeded_guest_abandon.py", "docker_volume_succeeded_namespace_guest.py",
)
SHA = re.compile(r"[0-9a-f]{64}")
FIELDS = {"schema", "attempt", "base_attempt", "source_root", "source_revision", "compose_project",
    "control_volume", "engine_id", "unknown_receipt_sha256", "compose_sha256", "controller_inputs",
    "control_pins", "containers", "protected_store", "empty_ledger_relative"}


def validate_request(r):
    require(isinstance(r, dict) and set(r) == FIELDS and r["schema"] == SCHEMA,
            "Exact pre-daemon resume request required")
    require(r["attempt"] == ATTEMPT and r["base_attempt"] == BASE
            and r["unknown_receipt_sha256"] == ORIGINAL and r["compose_sha256"] == COMPOSE,
            "This confirmation supports only the approved layout-refusal attempt")
    require(isinstance(r["source_root"], str) and Path(r["source_root"]).is_absolute()
            and str(Path(r["source_root"])) == r["source_root"]
            and ".." not in Path(r["source_root"]).parts, "Canonical source root required")
    require(isinstance(r["source_revision"], str) and re.fullmatch(r"[0-9a-f]{40}", r["source_revision"]),
            "Full source revision required")
    for key in ("compose_project", "control_volume", "engine_id"):
        require(isinstance(r[key], str) and 0 < len(r[key]) < 512 and not any(c.isspace() for c in r[key]), "Invalid identity: " + key)
    require(set(r["controller_inputs"]) == set(CONTROLLERS)
            and all(isinstance(v, str) and SHA.fullmatch(v) for v in r["controller_inputs"].values()), "Exact controller pins required")
    required = {BASE_ROOT + "/" + name for name in ("receipt.json", "terminal.json", "compose.json",
        "backend-cache.json", "group-ledger.json", "frontend-seed.json", "cache-maintenance-compose.json")}
    required |= {ROOT + "/build.log", "active", "resume/current.json", "resume/verified.json", *ABSENT}
    require(isinstance(r["control_pins"], dict) and set(r["control_pins"]) == required, "Exact control pin set required")
    for path, sha in r["control_pins"].items():
        BuildControl.path(path)
        require(sha is None or isinstance(sha, str) and SHA.fullmatch(sha), "Invalid control CAS")
        require(sha is not None or path in {*ABSENT, "resume/current.json", "resume/verified.json"}, "Required control evidence missing")
    require(all(r["control_pins"][path] is None for path in ABSENT)
            and r["control_pins"][BASE_ROOT + "/compose.json"] == RAW_COMPOSE
            and r["control_pins"]["active"] == digest((ATTEMPT + "\n").encode()), "Native absence or active/Compose differs")
    require(r["empty_ledger_relative"] == "private/ledger/ledger", "Exact new ledger root required")
    require(isinstance(r["protected_store"], dict) and r["protected_store"], "Archived protected inventory is mandatory")
    require(isinstance(r["containers"], dict) and set(r["containers"]) == {"lease", *SERVICES}, "Exact three incarnations required")
    for name, pin in r["containers"].items():
        fields = {"id", "image", "started_at", "fingerprint"} | ({"finished_at", "exit_code"} if name != "lease" else set())
        require(isinstance(pin, dict) and set(pin) == fields, "Invalid incarnation pin")
        require(pin["id"] == APPROVED_IDS[name] and SHA.fullmatch(pin["fingerprint"])
                and re.fullmatch(r"sha256:[0-9a-f]{64}", pin["image"]), "Invalid container digest")
        _docker_timestamp_ns(pin["started_at"])
        if name != "lease":
            require(type(pin["exit_code"]) is int and pin["exit_code"] == (2 if name == "backend" else 1), "Unexpected stopped exit")
            require(_docker_timestamp_ns(pin["started_at"]) < _docker_timestamp_ns(pin["finished_at"])
                    < _docker_timestamp_ns(r["containers"]["lease"]["started_at"]), "Application was started by this resume")
    require(len({pin["id"] for pin in r["containers"].values()}) == 3, "Container identities overlap")
    return r


def _pin(control, path, expected):
    raw = read_raw(control, path, optional=True)
    require((digest(raw) if raw is not None else None) == expected, "Control CAS changed: " + path)
    return raw


def _inspect(identifier):
    rows = json.loads(docker_capture("inspect", identifier).stdout)
    require(isinstance(rows, list) and len(rows) == 1, "Ambiguous Docker identity")
    return rows[0]


def validate_documents(original, base, document, r, control):
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
        and original.get("attempt") == ATTEMPT and original.get("phase") == "resume"
        and original.get("state") == "outcome-unknown-resources-retained" and original.get("error") == ERROR
        and original.get("compose_project") == control.project == r["compose_project"]
        and original.get("control_volume") == control.volume == r["control_volume"]
        and original.get("helper_container") == "fullmag-control-" + ATTEMPT,
        "Original operation is not the exact pre-daemon layout refusal")
    inputs = original.get("inputs", {})
    require(inputs.get("attempt") == BASE and inputs.get("config_sha256") == COMPOSE
        and inputs.get("source_root") == r["source_root"], "Resume inputs changed")
    require(base.get("attempt") == BASE and base.get("phase") == "development"
        and base.get("state") == "failed-confirmed" and base.get("compose_project") == control.project,
        "Base development is not the pinned failed build")
    require(digest(canonical(document)) == COMPOSE, "Canonical Compose identity changed")
    require(document.get("name") == control.project and set(document.get("services", {})) == set(SERVICES), "Compose group differs")
    require(document["services"]["backend"].get("environment", {}).get("FULLMAG_STARTUP_ENABLED") != "1", "Startup Solve is forbidden")
    for name in SERVICES:
        pin = r["containers"][name]
        require(base.get(name + "_container") == pin["id"] and base.get(name + "_started_at") == pin["started_at"]
            and document["services"][name]["image"] == pin["image"], "Stopped application differs from base")


def failure_result(original_raw, request_sha):
    result = copy.deepcopy(json.loads(original_raw))
    result.update(state="failed-confirmed", build_data_qualification="NOT VERIFIED",
        reconciliation={"schema": SCHEMA, "request_sha256": request_sha,
            "unknown_receipt_sha256": ORIGINAL, "services_started": False, "solve_replayed": False})
    return canonical(result) + b"\n"


# fdinfo reports the flock attached to this inherited open file description,
# not merely another process's contention on the same pathname.
LOCK_PROBE = r"""test -f /control/operation.lock; test ! -L /control/operation.lock
 test "$(readlink /proc/1/fd/9)" = /control/operation.lock
 test "$(stat -Lc '%d:%i' /proc/1/fd/9)" = "$(stat -Lc '%d:%i' /control/operation.lock)"
 test "$(stat -Lc %h /control/operation.lock)" = 1
 awk '$1 == "lock:" && $3 == "FLOCK" && $4 == "ADVISORY" && $5 == "WRITE" {n++} END {exit n != 1}' /proc/1/fdinfo/9
 exec 8</control/operation.lock
 if flock -n 8; then exit 72; else test "$?" = 1; fi
 printf 'OWNER_LOCKED\n'
"""


def _native_absence(control, r):
    checks = []
    for path in ABSENT:
        full = shlex.quote(control.path(path))
        checks.append("test ! -e " + full + "; test ! -L " + full)
    ledger = shlex.quote(control.path(r["empty_ledger_relative"]))
    checks.append("test -d " + ledger + "; test ! -L " + ledger
        + "; test -z \"$(find " + ledger + " -mindepth 1 -print -quit)\"")
    script = "; ".join(checks) + "; printf 'NATIVE_ABSENT\\n'"
    out = docker_capture("exec", r["containers"]["lease"]["id"], "/bin/bash", "-euo", "pipefail", "-c", script)
    require(out.stdout.strip() == b"NATIVE_ABSENT", "New native runtime or ledger is present")


def _consumers(control, r, observer_id=None):
    ids = docker_capture("ps", "--no-trunc", "--format", "{{.ID}}").stdout.decode().split()
    require(len(ids) <= 4096, "Container inventory exceeds bound")
    rows = json.loads(docker_capture("inspect", *ids).stdout) if ids else []
    allowed = {r["containers"]["lease"]["id"], observer_id}
    from docker_volume_development_interrupted import _compose_state_root
    document = json.loads(_pin(control, BASE_ROOT + "/compose.json", RAW_COMPOSE))
    state = str(_compose_state_root(document))
    for row in rows:
        if row.get("Id") in allowed:
            continue
        same_group = row.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") == control.project
        consumes = any(m.get("Name") == control.volume or m.get("Type") == "bind" and
            (str(m.get("Source", "")) == state or str(m.get("Source", "")).startswith(state + "/")
             or state.startswith(str(m.get("Source", "")) + "/")) for m in row.get("Mounts", []))
        require(not same_group and not consumes, "Another live group/storage consumer exists")


def preview(control, source, r, request_sha, *, observer_id=None):
    from docker_volume_resume_protected import read_archived_protected
    validate_request(r)
    require(not control.namespace and str(source) == r["source_root"]
        and control.project == r["compose_project"] and control.volume == r["control_volume"], "Selected group differs")
    require(docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip() == r["engine_id"], "Engine changed")
    require(subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"]).decode().strip() == r["source_revision"], "Source revision changed")
    for name, sha in r["controller_inputs"].items():
        require(digest((source / "scripts" / name).read_bytes()) == sha, "Controller changed: " + name)
    original = read_raw(control, ROOT + "/unknown-receipt.json", optional=True)
    if original is None:
        original = read_raw(control, ROOT + "/receipt.json")
    require(digest(original) == ORIGINAL, "Original receipt changed")
    result = failure_result(original, request_sha)
    result_sha = digest(result)
    terminal = read_raw(control, ROOT + "/terminal.json", optional=True)
    require(terminal is None or terminal == result, "Another terminal exists")
    for path, sha in r["control_pins"].items():
        if path in ("active", "resume/current.json"):
            continue
        _pin(control, path, sha)
    current = read_raw(control, ROOT + "/receipt.json")
    require(current in (original, result), "Unknown partial receipt")
    phase = read_raw(control, "resume/current.json", optional=True)
    require((digest(phase) if phase else None) in {r["control_pins"]["resume/current.json"], result_sha}, "Current pointer changed")
    if current == result or phase == result or terminal is not None:
        journal = ROOT + "/reconciliation/" + result_sha
        require(read_raw(control, journal + "/result.json") == result
            and read_raw(control, journal + "/prepared.json") == prepared(request_sha, result_sha), "Partial apply lacks exact prepared journal")
    original_doc = json.loads(original)
    base = json.loads(_pin(control, BASE_ROOT + "/terminal.json", r["control_pins"][BASE_ROOT + "/terminal.json"]))
    document = json.loads(_pin(control, BASE_ROOT + "/compose.json", RAW_COMPOSE))
    validate_documents(original_doc, base, document, r, control)
    protected = read_archived_protected(control, r)
    require(isinstance(protected, dict) and protected, "Archived inventory validation returned no proof")
    if terminal is not None:
        require(current == result and phase == result, "Terminal precedes its other publication pointers")
        return original, result, protected, True
    _pin(control, "active", r["control_pins"]["active"])
    lease = r["containers"]["lease"]
    require(control._inspect_operation_helper({"receipt": original_doc}, expected_id=lease["id"]) == lease["id"], "Original helper differs")
    helper = _inspect(lease["id"])
    validate_incarnation(helper, lease, control.project)
    validate_original_owner(helper, original_doc, control, lease["image"])
    _validate_helper_logged(lease["id"])
    locked = docker_capture("exec", lease["id"], "/bin/bash", "-euo", "pipefail", "-c", LOCK_PROBE)
    require(locked.stdout.strip() == b"OWNER_LOCKED", "Original helper does not own fd9 flock")
    for name in SERVICES:
        pin = r["containers"][name]
        row = _inspect(pin["id"])
        validate_incarnation(row, pin, control.project, running=False)
        s = row["State"]
        require(s.get("Status") == "exited" and s.get("Pid") == 0 and s.get("FinishedAt") == pin["finished_at"]
            and s.get("ExitCode") == pin["exit_code"] and not s.get("Error")
            and all(s.get(key) is False for key in ("Paused", "Restarting", "OOMKilled", "Dead")), "Application is not unchanged stopped base")
        validate_gate_container_mounts(row, name, document, _compose_state_root(document))
    _native_absence(control, r)
    _consumers(control, r, observer_id)
    return original, result, protected, False


def commit_checks(control, r, result_sha):
    """Additional CAS for this failure-only branch, run by the owning observer."""
    validate_request(r)
    require(SHA.fullmatch(result_sha), "Invalid deterministic result hash")
    checks = ["exec 8</control/operation.lock; if flock -n 8; then exit 72; fi"]
    for relative, expected in r["control_pins"].items():
        path = shlex.quote(control.path(relative))
        checks.append("test ! -L " + path + "; test \"$(readlink -m " + path + ")\" = " + path)
        if expected is None:
            if relative == "resume/current.json":
                checks.append("if test -e " + path + "; then test -f " + path + "; test \"$(sha256sum " + path + " | cut -d' ' -f1)\" = '" + result_sha + "'; fi")
            else:
                checks.append("test ! -e " + path)
        else:
            allowed = "test \"$observed\" = '" + expected + "'"
            if relative == "resume/current.json":
                allowed += " || test \"$observed\" = '" + result_sha + "'"
            checks.append("test -f " + path + "; test $(stat -c %h " + path + ") = 1; observed=$(sha256sum " + path + " | cut -d' ' -f1); { " + allowed + "; }")
    ledger = shlex.quote(control.path(r["empty_ledger_relative"]))
    checks.append("test -d " + ledger + "; test ! -L " + ledger + "; test \"$(readlink -f " + ledger + ")\" = " + ledger
                  + "; test -z \"$(find " + ledger + " -mindepth 1 -print -quit)\"")
    return "; ".join(checks) + "; "


def prepared(request_sha, result_sha):
    return canonical({"schema": SCHEMA, "request_sha256": request_sha,
        "unknown_receipt_sha256": ORIGINAL, "result_sha256": result_sha}) + b"\n"


def confirm_release(control, r):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        active = read_raw(control, "active", optional=True)
        require(active in (None, (ATTEMPT + "\n").encode()), "Active owner changed")
        rows = docker_capture("ps", "--no-trunc", "--format", "{{.ID}}").stdout.decode().split()
        if active is None and r["containers"]["lease"]["id"] not in rows:
            return
        time.sleep(.25)
    raise BuildControlError("Terminal committed; original helper release remains unconfirmed")


def reconcile(control, source, request_raw, request_sha, *, apply=False):
    require(digest(request_raw) == request_sha, "Request CAS differs")
    r = validate_request(json.loads(request_raw))
    original, result, protected, complete = preview(control, source, r, request_sha)
    if complete:
        if apply:
            confirm_release(control, r)
        return {"state": "failed-confirmed", "replay": True, "services_started": False}
    if not apply:
        return {"state": "validated-only", "result_sha256": digest(result), "protected": protected, "services_started": False}
    current = read_raw(control, ROOT + "/receipt.json")
    script = claim_script(control, ROOT, r, digest(current), phase="resume", publish_verified=False, result_sha256=digest(result))
    name = "fullmag-resume-preflight-observer-" + uuid.uuid4().hex
    observer = subprocess.Popen(control.helper_args(script, name=name), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        require(control._line(observer) == "READY", "Observer lease not acquired")
        actual = _inspect(name)
        validate_original_owner(actual, {"helper_container": name}, control, r["containers"]["lease"]["image"])
        require(actual.get("Config", {}).get("Cmd") == ["-euo", "pipefail", "-c", script]
            and actual.get("State", {}).get("Running") is True, "Observer command differs")
        require(preview(control, source, r, request_sha, observer_id=actual["Id"])[0] == original, "Observation changed")
        write_immutable(control, ROOT + "/unknown-receipt.json", original)
        journal = ROOT + "/reconciliation/" + digest(result)
        write_immutable(control, journal + "/result.json", result)
        write_immutable(control, journal + "/prepared.json", prepared(request_sha, digest(result)))
        require(observer.poll() is None, "Observer lease disappeared")
        observer.stdin.write(b"BEGIN\n"); observer.stdin.flush()
        require(control._line(observer) == "OBSERVING", "Observer BEGIN outcome unknown")
        require(preview(control, source, r, request_sha, observer_id=actual["Id"])[0] == original, "Final observation changed")
        observer.stdin.write(("COMMIT " + digest(result) + "\n").encode()); observer.stdin.flush(); observer.stdin.close()
        require(control._line(observer) == "COMMITTED" and observer.wait(timeout=30) == 0, "Commit outcome unknown; replay exact request")
    finally:
        if observer.stdin and not observer.stdin.closed:
            observer.stdin.close()
    for path in (ROOT + "/receipt.json", "resume/current.json", ROOT + "/terminal.json"):
        require(read_raw(control, path) == result, "Final publication differs")
    confirm_release(control, r)
    return {"state": "failed-confirmed", "services_started": False, "result_sha256": digest(result)}


def build_request(control, source, attempt, base_attempt, protected_store=None):
    from docker_volume_resume_protected import describe_archived_protected
    require(attempt == ATTEMPT and base_attempt == BASE, "Only approved attempt/base supported")
    original_raw = read_raw(control, ROOT + "/receipt.json")
    require(digest(original_raw) == ORIGINAL, "Original receipt changed")
    original = json.loads(original_raw)
    base = json.loads(read_raw(control, BASE_ROOT + "/terminal.json"))
    containers = {}
    for name in ("lease", *SERVICES):
        identifier = original["helper_container"] if name == "lease" else base[name + "_container"]
        row = _inspect(identifier)
        containers[name] = {"id": row["Id"], "image": row["Image"], "started_at": row["State"]["StartedAt"], "fingerprint": fingerprint(row)}
        if name != "lease":
            containers[name].update(finished_at=row["State"]["FinishedAt"], exit_code=row["State"]["ExitCode"])
    paths = [BASE_ROOT + "/" + name for name in ("receipt.json", "terminal.json", "compose.json", "backend-cache.json",
        "group-ledger.json", "frontend-seed.json", "cache-maintenance-compose.json")]
    paths += [ROOT + "/build.log", "active", "resume/current.json", "resume/verified.json", *ABSENT]
    pins = {}
    for path in paths:
        raw = read_raw(control, path, optional=True); pins[path] = digest(raw) if raw is not None else None
    r = dict(schema=SCHEMA, attempt=attempt, base_attempt=base_attempt, source_root=str(source),
        source_revision=subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"]).decode().strip(),
        compose_project=control.project, control_volume=control.volume,
        engine_id=docker_capture("info", "--format", "{{.ID}}").stdout.decode().strip(),
        unknown_receipt_sha256=ORIGINAL, compose_sha256=COMPOSE, control_pins=pins, containers=containers,
        controller_inputs={name: digest((source / "scripts" / name).read_bytes()) for name in CONTROLLERS},
        protected_store=protected_store if protected_store is not None else describe_archived_protected(control),
        empty_ledger_relative="private/ledger/ledger")
    return validate_request(r)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True); parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True); parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from docker_dev import _select_source, _compose_identity
    source, layout = _select_source(Path(args.source_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout); cfg = toolchain_configuration(source, identity)
    control = BuildControl(identity, cfg["services"]["fem-gpu-toolchain"]["build"]["args"]["FULLMAG_CUDA_BASE_IMAGE"])
    require(SHA.fullmatch(args.request_sha256), "Invalid request hash")
    print(json.dumps(reconcile(control, source, read_raw(control, args.request), args.request_sha256, apply=args.apply)))


if __name__ == "__main__":
    main()
