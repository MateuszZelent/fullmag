"""Explicit, group-scoped reattestation after WSL renumbers a host device.

No automatic weakening of retained identity checks. The caller pins the old
certificate and the current device. A durable intent permits resuming a partial
two-file publication; any unrelated certificate change fails closed.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from docker_build_control import BuildControlError, canonical
import linux_native_host as host


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def replacement(state, old_raw, *, engine, image, expected_sha, expected_device):
    if sha(old_raw) != expected_sha:
        raise BuildControlError("Pinned host certificate digest differs")
    old = json.loads(old_raw)
    native = host.local_volume(state)
    if (old.get("schema") != host.HOST_SCHEMA
            or old.get("storage_profile") != host.PROFILE
            or old.get("role") != "session" or old.get("owner_scope") != "docker-linux"
            or old.get("engine_id") != engine or old.get("image_id") != image
            or old.get("host_inode") != state.stat().st_ino
            or not re.fullmatch(r"[0-9a-f]{32}", old.get("owner_token", ""))
            or type(old.get("host_device")) is not int
            or type(expected_device) is not int or expected_device <= 0
            or native.get("host_device") != expected_device
            or any(old.get(key) != value for key, value in native.items() if key != "host_device")):
        raise BuildControlError("Host reattestation ownership/directory/engine/device differs")
    payload = (old["owner_token"] + ":" + image).encode("ascii")
    if (host.read_owned_regular(state / ".linux-native-sentinel") != payload
            or sha(payload) != old.get("restart_expected_sha256")
            or host.read_owned_regular(state / ".linux-native-restart") != payload
            or old.get("restart_verified") is not True):
        raise BuildControlError("Host reattestation sentinel/restart evidence differs")
    updated = {**old, "host_device": expected_device}
    return (json.dumps(updated, indent=2, ensure_ascii=False) + "\n").encode()


def publish(state, old_raw, new_raw):
    """Permit only the two exact journaled versions, including interrupted apply."""
    certificate = state / host.CERTIFICATE_NAME
    marker = state / host.OWNER_NAME
    allowed = (old_raw, new_raw)
    if any(host.read_owned_regular(path) not in allowed for path in (certificate, marker)):
        raise BuildControlError("Host certificate changed after reattestation intent")
    # Keep the certificate inode because Docker bind-mounts this file.
    host.publish_bytes(marker, new_raw)
    host.write_bound_evidence(certificate, json.loads(new_raw))
    if any(host.read_owned_regular(path) != new_raw for path in (certificate, marker)):
        raise BuildControlError("Host reattestation readback differs")


def bind_host_path(value, state):
    """Resolve Desktop aliases using the actual WSL bind-mount filesystem root."""
    match = re.fullmatch(r"/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/([A-Za-z0-9][A-Za-z0-9._-]*)/([0-9a-f]{64})", value)
    if match is None:
        return Path(value)
    local = Path("/mnt/wsl/docker-desktop-bind-mounts") / match.group(1) / match.group(2)
    if local.stat().st_dev != state.stat().st_dev:
        return None
    # This recovery is scoped to a WSL distro root filesystem. Other mount
    # layouts need an explicit filesystem-relative identity implementation.
    def field(path, name):
        result = subprocess.run(["findmnt", "-n", "-r", "-o", name, "--target", str(path)],
                                check=True, capture_output=True, text=True, timeout=10)
        text = result.stdout.strip()
        if not text.startswith("/") or "\n" in text or "\\" in text:
            raise BuildControlError("Host bind filesystem root is ambiguous")
        return text
    if field(state, "TARGET") != "/":
        raise BuildControlError("WSL device recovery requires the distro root filesystem")
    return Path(field(local, "FSROOT"))


def iteration_recovery_script(root, token, receipt_sha, terminal):
    """CAS finalization under the same lock used by the original lease owner."""
    import base64
    import shlex
    path = root + "/iteration/attempts/" + token
    payload = canonical(terminal) + b"\n"
    active_sha = sha((token + "\n").encode())
    q = shlex.quote
    encoded = base64.b64encode(payload).decode()
    return f"""set -euo pipefail
umask 027
regular() {{ test ! -L "$1"; test -f "$1"; test "$(stat -c %h "$1")" = 1; }}
test "$(readlink -f {q(root)})" = {q(root)}
regular {q(root + '/operation.lock')}
exec 9<> {q(root + '/operation.lock')}
flock -n 9
test "$(readlink -f {q(path)})" = {q(path)}
regular {q(root + '/active')}
test "$(sha256sum {q(root + '/active')} | cut -d' ' -f1)" = {q(active_sha)}
regular {q(path + '/receipt.json')}
test "$(sha256sum {q(path + '/receipt.json')} | cut -d' ' -f1)" = {q(receipt_sha)}
test ! -L {q(path + '/terminal.json')}
if test -e {q(path + '/terminal.json')}; then
  regular {q(path + '/terminal.json')}
  test "$(sha256sum {q(path + '/terminal.json')} | cut -d' ' -f1)" = {q(sha(payload))}
else
  tmp="$(mktemp {q(path + '/.reattest-terminal.XXXXXXXX')})"
  trap 'rm -f -- "$tmp"' EXIT
  printf '%s' {q(encoded)} | base64 -d > "$tmp"
  sync "$tmp"
  mv -T -- "$tmp" {q(path + '/terminal.json')}
  sync {q(path)}
  trap - EXIT
fi
# Only this recovery helper, after exclusive admission and exact-byte CAS,
# can retire the marker of the proven absent original helper.
rm -- {q(root + '/active')}
sync {q(root)}
printf 'RECONCILED\\n'
"""


def reconcile_iteration(control, pins, proof, token):
    from docker_volume_activation_reconcile import _probe_helper_absence
    from docker_build_control import bounded_capture
    active = control.read_bytes("active", optional=True)
    if active is None:
        return
    if control.namespace or not token or re.fullmatch(r"[0-9a-f]{32}", token) is None:
        raise BuildControlError("Pinned interrupted iteration required; no automatic lease recovery")
    if active != (token + "\n").encode():
        raise BuildControlError("Interrupted iteration marker differs")
    path = "iteration/attempts/" + token
    raw = control.read_bytes(path + "/receipt.json")
    receipt = json.loads(raw)
    inputs = receipt.get("inputs", {})
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "iteration" or receipt.get("attempt") != token
            or receipt.get("state") != "starting"
            or receipt.get("compose_project") != control.project
            or receipt.get("control_volume") != control.volume
            or receipt.get("helper_container") != "fullmag-control-" + token
            or any(inputs.get(key) != pins[key] for key in ("attempt","config_sha256","source_root"))):
        raise BuildControlError("Interrupted iteration receipt differs")
    state_root = Path(proof["state_root"])
    store_runs = host.storage.validate_path(state_root / "runs/docker-all/session-store/runs", state_root, "retained run directory")
    if not store_runs.is_dir() or any(store_runs.iterdir()):
        raise BuildControlError("Interrupted iteration recovery requires no retained runs")
    absence = _probe_helper_absence("fullmag-control-" + token)
    if absence is None:
        raise BuildControlError("Interrupted iteration helper still exists")
    terminal = {**receipt, "state":"failed-confirmed",
                "error":"host-interrupted-iteration-stopped-services",
                "reconciliation":{"pins":pins,"proof_sha256":sha(canonical(proof)),
                                  "helper_absence_sha256":absence}}
    # Reprobe immediately before lock acquisition. A removed container cannot
    # regain its incarnation; any subsequent launcher also needs this lock.
    if _probe_helper_absence("fullmag-control-" + token) != absence:
        raise BuildControlError("Interrupted helper absence proof changed")
    script = iteration_recovery_script("/control", token, sha(raw), terminal)
    result = bounded_capture(control.helper_args(script), timeout=90)
    if result.returncode != 0 or result.stdout.strip() != b"RECONCILED":
        raise BuildControlError("Interrupted iteration CAS withheld; evidence retained")


def run(args):
    from docker_dev_up import _selected_context
    import docker_volume_dev as dev
    import fullmag_storage as storage

    if os.name != "posix" or "microsoft" not in Path("/proc/sys/kernel/osrelease").read_text().lower():
        raise BuildControlError("Host device reattestation is restricted to Linux/WSL")
    for value, pattern in ((args.attempt, r"[0-9a-f]{32}"),
                           (args.config_sha256, r"[0-9a-f]{64}"),
                           (args.certificate_sha256, r"[0-9a-f]{64}")):
        if re.fullmatch(pattern, value) is None:
            raise BuildControlError("Host reattestation requires exact digest/attempt pins")
    _, selected, layout, _, control = _selected_context(args)
    control.prepare()
    root = "host-device-reattest/" + args.certificate_sha256
    intent_path = root + "/intent.json"
    pins = {"attempt": args.attempt, "config_sha256": args.config_sha256,
            "certificate_sha256": args.certificate_sha256,
            "expected_host_device": args.expected_host_device,
            "source_root": str(selected), "compose_project": control.project}

    def collect():
        previous = control.read("development/attempts/" + args.attempt + "/terminal.json")
        document = control.read("development/attempts/" + args.attempt + "/compose.json")
        if (previous.get("schema") != "fullmag.docker-build-operation.v1"
                or previous.get("phase") != "development" or previous.get("attempt") != args.attempt
                or previous.get("state") != "succeeded"
                or previous.get("compose_project") != control.project
                or previous.get("inputs", {}).get("source_root") != str(selected)
                or document.get("name") != control.project
                or sha(canonical(document)) != args.config_sha256):
            raise BuildControlError("Host reattestation retained group/config/source differs")
        rows = {}
        image = previous["inputs"]["image_id"]
        image_config = json.loads(dev.docker_text("image", "inspect", image))[0]["Config"]
        for service in ("backend", "frontend"):
            identifier = previous.get(service + "_container")
            if not re.fullmatch(r"[0-9a-f]{64}", identifier or ""):
                raise BuildControlError("Host reattestation lacks exact container pins")
            row = json.loads(dev.docker_text("inspect", identifier))[0]
            if row.get("Image") != image:
                raise BuildControlError("Host reattestation " + service + " image differs")
            labels = row.get("Config", {}).get("Labels", {})
            status = row.get("State", {})
            if (row.get("Id") != identifier
                    or labels.get("com.docker.compose.project") != control.project
                    or labels.get("com.docker.compose.service") != service
                    or status.get("Running") is not False or status.get("Pid") != 0
                    or status.get("Status") != "exited" or status.get("Restarting") is not False
                    or status.get("OOMKilled") is not False or status.get("Dead") is not False):
                raise BuildControlError("Host reattestation requires exact stopped services")
            dev._validate_retained_service(document, row, service, image_config)
            rows[service] = row
        state = storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Linux state")
        bind = next((m for m in rows["backend"]["Mounts"] if m["Destination"] == "/state"), {})
        if (bind.get("Type") != "bind"
                or not isinstance(bind.get("Source"), str)
                or bind_host_path(bind["Source"], state) != state):
            raise BuildControlError("Host reattestation state bind differs")
        # Refuse any other consumer of this directory or an ancestor/descendant.
        all_ids = dev.docker_text("ps", "--all", "--quiet").split()
        all_rows = json.loads(dev.docker_text("inspect", *all_ids)) if all_ids else []
        selected_ids = {row["Id"] for row in rows.values()}
        for row in all_rows:
            if row["Id"] in selected_ids:
                continue
            for mount in row.get("Mounts", []):
                if mount.get("Type") == "bind":
                    source = bind_host_path(mount["Source"], state)
                    if source is None:
                        continue
                    if source == state or state in source.parents or source in state.parents:
                        raise BuildControlError("Another container consumes retained host storage")
        engine = dev.docker_text("info", "--format", "{{.ID}}").strip()
        intent = control.read(intent_path, optional=True)
        if intent is not None:
            if intent.get("pins") != pins:
                raise BuildControlError("Host reattestation intent pins differ")
            old_raw = intent["old_certificate"].encode()
        else:
            old_raw = host.read_owned_regular(state / host.CERTIFICATE_NAME)
            if old_raw != host.read_owned_regular(state / host.OWNER_NAME):
                raise BuildControlError("Host reattestation certificate/owner differ")
        new_raw = replacement(state, old_raw, engine=engine, image=image,
                              expected_sha=args.certificate_sha256,
                              expected_device=args.expected_host_device)
        allowed = (old_raw, new_raw) if intent else (old_raw,)
        if any(host.read_owned_regular(state / name) not in allowed
               for name in (host.CERTIFICATE_NAME, host.OWNER_NAME)):
            raise BuildControlError("Host reattestation current certificate is not journaled")
        proof = {"pins": pins, "state_root": str(state), "engine_id": engine,
                 "old_certificate": old_raw.decode(), "new_certificate": new_raw.decode(),
                 "containers": {key: sha(canonical(row)) for key, row in rows.items()}}
        if intent is not None and intent != proof:
            raise BuildControlError("Host reattestation intent evidence changed")
        return state, old_raw, new_raw, proof

    state, old_raw, new_raw, proof = collect()
    if not args.apply:
        return {"state": "preview", **pins, "new_certificate_sha256": sha(new_raw)}
    reconcile_iteration(control, pins, proof, getattr(args,"interrupted_iteration",None))
    with control.operation("host-device-reattest", pins) as operation:
        again = collect()
        if again[3] != proof:
            raise BuildControlError("Host reattestation evidence changed before apply")
        control.write(intent_path, proof)
        publish(state, old_raw, new_raw)
        operation["receipt"].update(state="succeeded", old_host_device=json.loads(old_raw)["host_device"],
                                    host_device=args.expected_host_device,
                                    new_certificate_sha256=sha(new_raw), intent_path=intent_path)
    return {"state": "succeeded", **pins, "new_certificate_sha256": sha(new_raw)}
