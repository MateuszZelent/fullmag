"""Managed Compose orchestration for one backend's CPU delegation gate."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

from docker_build_control import BuildControlError, canonical, compose_capture, docker_capture

PROFILE = "docker-backend-v1"
ROOT = "/opt/fullmag/worker-cgroup"


def docker_text(*args, timeout=90, combined=False):
    result = docker_capture(*args, timeout=timeout)
    return (result.stdout + (result.stderr if combined else b"")).decode("utf-8", "replace")

_REQUEST = """import json,os,pathlib,stat
p=pathlib.Path('/opt/fullmag/runtime-control/worker-cgroup/request.json')
try:
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_size>16384: raise RuntimeError('invalid cgroup request file')
  d=json.loads(os.read(fd,16385))
 finally: os.close(fd)
 pid=d.get('pid')
 if type(pid) is not int or pid<1: raise RuntimeError('invalid cgroup request PID')
 try:
  v=pathlib.Path('/proc/'+str(pid)+'/stat').read_text()
  current=v[v.rfind(')')+2:].split()[19]
  if current!=d.get('process_start_token'): d={}
 except FileNotFoundError: d={}
 print(json.dumps(d))
except FileNotFoundError: print('{}')
"""

_READY = """import json,os,stat
try:
 fd=os.open('/opt/fullmag/runtime-control/worker-cgroup/ready.json',os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_size>16384: raise RuntimeError('invalid cgroup receipt file')
  d=json.loads(os.read(fd,16385))
 finally: os.close(fd)
 print(json.dumps(d if isinstance(d,dict) else {}))
except FileNotFoundError: print('{}')
"""


def configure_backend(document):
    environment = document["services"]["backend"]["environment"]
    environment["FULLMAG_WORKER_CGROUP_PROFILE"] = PROFILE
    environment["FULLMAG_WORKER_CGROUP_ROOT"] = ROOT


def ensure_delegation(control, operation, document, backend_id, image, selected):
    environment = document["services"]["backend"]["environment"]
    if environment.get("FULLMAG_WORKER_CGROUP_PROFILE") is None:
        return
    if environment.get("FULLMAG_WORKER_CGROUP_PROFILE") != PROFILE:
        raise BuildControlError("Unexpected backend cgroup delegation profile")
    deadline = time.monotonic() + 300
    while True:
        observed = json.loads(docker_text("inspect", backend_id))[0]
        labels = observed.get("Config", {}).get("Labels", {})
        if (observed.get("Id") != backend_id or observed.get("Image") != image
                or labels.get("com.docker.compose.project") != control.project
                or labels.get("com.docker.compose.service") != "backend"
                or observed.get("HostConfig", {}).get("Privileged") is not False
                or observed.get("HostConfig", {}).get("CapAdd") not in (None, [])
                or observed.get("Config", {}).get("User") != "65532:65532"):
            raise BuildControlError("Backend identity/privileges differ before cgroup delegation")
        if not observed.get("State", {}).get("Running"):
            raise BuildControlError("Backend exited before its cgroup delegation gate")
        request = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-I", "-B", "-c", _REQUEST))
        if request:
            if (request.get("schema") != "fullmag.worker-cgroup-request.v1"
                    or request.get("compose_project") != control.project
                    or request.get("container_id") not in (None, backend_id)):
                raise BuildControlError("Backend cgroup request differs from the selected group")
            break
        if time.monotonic() >= deadline:
            raise BuildControlError("Backend did not publish its worker cgroup request")
        time.sleep(1)
    # A replay of a succeeded gate validates the exact request and root again
    # in the image-owned backend module; it must not recreate host children.
    previous = operation["receipt"].get("worker_cgroup")
    if isinstance(previous, dict) and previous.get("nonce") == request.get("nonce"):
        if (any(previous.get(key) != request.get(key) for key in
                ("compose_project", "pid", "process_start_token", "boot_id"))
                or previous.get("container_id") != backend_id or previous.get("image_id") != image
                or previous.get("state") != "ready" or previous.get("root") != ROOT):
            raise BuildControlError("Retained worker cgroup receipt differs from the current backend gate")
        return
    # A launcher re-run against an unchanged, still-running incarnation finds
    # the receipt its earlier helper already produced for this live request.
    # The request was just re-proven live (PID + start token), so this is the
    # current delegation, not a stale proof from an earlier container start.
    retained = json.loads(docker_text("exec", backend_id, "/usr/local/bin/python3", "-I", "-B", "-c", _READY))
    if retained and retained.get("nonce") == request.get("nonce"):
        if (any(retained.get(key) != request.get(key) for key in
                ("compose_project", "pid", "process_start_token", "boot_id"))
                or retained.get("schema") != "fullmag.worker-cgroup-ready.v1"
                or retained.get("container_id") != backend_id or retained.get("image_id") != image
                or retained.get("state") != "ready" or retained.get("root") != ROOT):
            raise BuildControlError("Retained in-container worker cgroup receipt differs from the live gate")
        operation["receipt"]["worker_cgroup"] = retained
        operation["receipt"]["worker_cgroup_helper"] = {"state": "reused-live-incarnation"}
        return
    helper_path = Path(selected) / "scripts/lib/docker_worker_cgroup.py"
    helper_bytes = helper_path.read_bytes()
    if len(helper_bytes) > 128 * 1024 or helper_path.is_symlink():
        raise BuildControlError("Worker cgroup helper is not a bounded source file")
    helper_sha = hashlib.sha256(helper_bytes).hexdigest()
    helper_relative = operation["root"] + "/docker_worker_cgroup.py"
    control.write_bytes(helper_relative, helper_bytes)
    helper_name = "fullmag-cgroup-" + operation["receipt"]["attempt"]
    service = {
        "image": image, "pull_policy": "never", "user": "0:0",
        "privileged": True, "pid": "host", "cgroup": "host", "read_only": True,
        "network_mode": "none", "restart": "no",
        "entrypoint": ["/usr/local/bin/python3", "-I", "-B", "/fullmag-build-control/" + helper_relative],
        "environment": {
            "FULLMAG_CGROUP_PROJECT": control.project,
            "FULLMAG_CGROUP_CONTAINER_ID": backend_id,
            "FULLMAG_CGROUP_IMAGE_ID": image,
            "FULLMAG_CGROUP_NONCE": request["nonce"],
            "FULLMAG_CGROUP_BACKEND_PID": str(observed["State"]["Pid"]),
        },
        "volumes": [
            {"type": "volume", "source": "build-control", "target": "/fullmag-build-control", "read_only": True,
             "volume": {"nocopy": True, **({"subpath": control.subpath()} if control.namespace else {})}},
            {"type": "volume", "source": "build-control", "target": "/control",
             "volume": {"nocopy": True, "subpath": control.subpath("runtime-control/worker-cgroup")}},
        ],
        "logging": {"driver": "local", "options": {"max-size": "10m", "max-file": "3"}},
    }
    spec = {"name": control.project, "services": {"worker-cgroup-maintenance": service},
            "volumes": {"build-control": {"name": control.volume, "external": True}}}
    control.write(operation["root"] + "/worker-cgroup-compose.json", spec)
    operation["receipt"]["worker_cgroup_helper"] = {"name": helper_name, "sha256": helper_sha, "state": "starting"}
    output = compose_capture(spec, "run", "--name", helper_name, "--no-deps", "worker-cgroup-maintenance", timeout=180)
    helper = json.loads(docker_text("inspect", helper_name))[0]
    if (helper.get("Image") != image or helper.get("State", {}).get("Running")
            or helper.get("HostConfig", {}).get("CgroupnsMode") != "host"
            or helper.get("HostConfig", {}).get("PidMode") != "host"
            or helper.get("State", {}).get("ExitCode") != 0
            or helper.get("HostConfig", {}).get("CgroupnsMode") != "host"
            or helper.get("HostConfig", {}).get("PidMode") != "host"
            or helper.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") != control.project
            or helper.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") != "worker-cgroup-maintenance"):
        raise BuildControlError("Worker cgroup helper identity/outcome differs")
    if hashlib.sha256(helper_path.read_bytes()).hexdigest() != helper_sha:
        raise BuildControlError("Worker cgroup helper source changed during delegation")
    lines = [json.loads(line) for line in output.decode().splitlines() if line.lstrip().startswith("{")]
    proofs = [line for line in lines if line.get("schema") == "fullmag.worker-cgroup-ready.v1"]
    if len(proofs) != 1:
        raise BuildControlError("Worker cgroup helper did not publish one receipt")
    proof = proofs[0]
    if (proof.get("nonce") != request.get("nonce") or proof.get("container_id") != backend_id
            or proof.get("image_id") != image or proof.get("state") != "ready"
            or proof.get("compose_project") != control.project):
        raise BuildControlError("Worker cgroup receipt identity differs")
    control.write(operation["root"] + "/worker-cgroup.json", proof)
    control.write(operation["root"] + "/worker-cgroup-log.json", {"log": docker_text("logs", helper_name, combined=True)})
    operation["receipt"]["worker_cgroup"] = proof
    operation["receipt"]["worker_cgroup_helper"]["state"] = "succeeded"
    docker_capture("rm", helper["Id"])


CGROUP_FAILURE_SCHEMA = "fullmag.docker-iteration-cgroup-failure-reconciliation.v1"


def validate_failure_pin(proof, attempt):
    """Closed post-build failure proof; no success or delegation repair is implied."""
    import re
    fields = {"checkpoint_relative", "original_checkpoint_relative", "checkpoint_sha256", "drain_sha256", "helper_source_sha256",
              "helper_compose_sha256", "helper_log_sha256", "cgroup_request_sha256",
              "verified_sha256", "recovery_helper_sha256", "helper"}
    if not isinstance(proof, dict) or set(proof) != fields:
        raise BuildControlError("Exact cgroup failure proof fields required")
    if any(not isinstance(proof[key], str) or re.fullmatch(r"[0-9a-f]{64}", proof[key]) is None
           for key in fields - {"checkpoint_relative", "original_checkpoint_relative", "helper"}):
        raise BuildControlError("Invalid cgroup failure evidence digest")
    for key in ("checkpoint_relative", "original_checkpoint_relative"):
        relative = proof[key]
        if not isinstance(relative, str) or not relative.startswith("verification/") or ".." in Path(relative).parts or "\x00" in relative or str(Path(relative)) != relative:
            raise BuildControlError("Cgroup recovery requires control-volume verification checkpoints")
    pin = proof["helper"]
    if not isinstance(pin, dict) or set(pin) != {"id", "name", "image", "started_at", "finished_at", "exit_code", "fingerprint"}:
        raise BuildControlError("Exact failed cgroup helper incarnation required")
    if (pin["name"] != "fullmag-cgroup-" + attempt or pin["exit_code"] != 1 or type(pin["exit_code"]) is not int
            or any(not isinstance(pin[key], str) or not pin[key] for key in ("started_at", "finished_at", "id", "image", "fingerprint"))
            or re.fullmatch(r"[0-9a-f]{64}", pin.get("id", "")) is None
            or re.fullmatch(r"sha256:[0-9a-f]{64}", pin.get("image", "")) is None
            or re.fullmatch(r"[0-9a-f]{64}", pin.get("fingerprint", "")) is None):
        raise BuildControlError("Invalid failed cgroup helper pin")


def validate_failure(control, root, request, original, actual, state):
    """Observe one terminal helper failure while the original lease stays live.

    This never enters _finish, changes cgroups, moves processes, or deletes a
    helper. The published result may only confirm the failed iteration.
    """
    import docker_volume_dev as dev
    import docker_volume_reconcile as reconciliation
    proof = request["failure"]
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != proof["recovery_helper_sha256"]:
        raise BuildControlError("Cgroup failure adapter differs from reviewed request")
    validate_failure_pin(proof, request["attempt"])
    require, digest, read_raw = reconciliation.require, reconciliation.digest, reconciliation.read_raw
    require(original.get("worker_cgroup_helper") == {"name": proof["helper"]["name"],
        "sha256": proof["helper_source_sha256"], "state": "starting"}
        and original.get("worker_cgroup") is None, "Original cgroup failure boundary differs")
    helper = json.loads(docker_capture("inspect", proof["helper"]["id"]).stdout)
    require(len(helper) == 1, "Ambiguous failed cgroup helper")
    helper = helper[0]
    reconciliation.validate_incarnation(helper, proof["helper"], control.project, running=False)
    hs, hc, hh = helper["State"], helper["Config"], helper["HostConfig"]
    require(helper.get("Name") == "/" + proof["helper"]["name"]
        and helper["Image"] == actual["backend"]["Image"] == proof["helper"]["image"]
        and hs.get("Status") == "exited" and hs.get("ExitCode") == 1
        and hs.get("FinishedAt") == proof["helper"]["finished_at"]
        and hs.get("OOMKilled") is False and hs.get("Dead") is False and hs.get("Restarting") is False
        and not hs.get("Error") and helper.get("RestartCount") == 0
        and hc.get("Labels", {}).get("com.docker.compose.service") == "worker-cgroup-maintenance"
        and hc.get("User") == "0:0" and hh.get("Privileged") is True
        and hh.get("NetworkMode") == "none" and hh.get("ReadonlyRootfs") is True
        and hh.get("PidMode") == "host" and hh.get("CgroupnsMode") == "host",
        "Failed cgroup helper identity, privileges or terminal outcome differs")
    source = read_raw(control, root + "/docker_worker_cgroup.py")
    spec_raw = read_raw(control, root + "/worker-cgroup-compose.json")
    require(digest(source) == proof["helper_source_sha256"]
        and digest(spec_raw) == proof["helper_compose_sha256"], "Captured cgroup helper source/configuration differs")
    spec = json.loads(spec_raw)
    expected_entry = ["/usr/local/bin/python3", "-I", "-B", "/fullmag-build-control/" + root + "/docker_worker_cgroup.py"]
    require(spec.get("name") == control.project and hc.get("Entrypoint") == expected_entry,
        "Failed helper did not execute the captured gate")
    log = docker_capture("logs", proof["helper"]["id"])
    log = log.stdout + log.stderr
    require(len(log) <= 128 * 1024 and digest(log) == proof["helper_log_sha256"], "Failed cgroup helper log differs")
    text = log.decode("utf-8", "strict")
    require("cgroup.subtree_control" in text and 'write_text("+cpu\\n")' in text
        and text.rstrip().endswith("OSError: [Errno 16] Device or resource busy"),
        "Helper did not fail at the pinned CPU-enable EBUSY boundary")
    backend = request["containers"]["backend"]["id"]
    current_request = json.loads(docker_text("exec", backend, "/usr/local/bin/python3", "-I", "-B", "-c", _REQUEST))
    ready = json.loads(docker_text("exec", backend, "/usr/local/bin/python3", "-I", "-B", "-c", _READY))
    require(digest(canonical(current_request)) == proof["cgroup_request_sha256"]
        and current_request.get("schema") == "fullmag.worker-cgroup-request.v1"
        and current_request.get("compose_project") == control.project
        and current_request.get("container_id") in (None, backend)
        and bool(current_request.get("nonce")) and ready.get("nonce") != current_request["nonce"],
        "Cgroup request changed or a current ready receipt already exists")
    expected_env = spec["services"]["worker-cgroup-maintenance"]["environment"]
    actual_env = dict(entry.split("=", 1) for entry in hc.get("Env", []))
    require(all(actual_env.get(key) == value for key, value in expected_env.items())
        and expected_env.get("FULLMAG_CGROUP_PROJECT") == control.project
        and expected_env.get("FULLMAG_CGROUP_CONTAINER_ID") == backend
        and expected_env.get("FULLMAG_CGROUP_IMAGE_ID") == actual["backend"]["Image"]
        and expected_env.get("FULLMAG_CGROUP_NONCE") == current_request["nonce"]
        and expected_env.get("FULLMAG_CGROUP_BACKEND_PID") == str(actual["backend"]["State"]["Pid"]),
        "Failed helper is not bound to the live backend cgroup request")
    checkpoint_raw = read_raw(control, proof["checkpoint_relative"])
    require(digest(checkpoint_raw) == proof["checkpoint_sha256"], "Fresh authoring checkpoint differs")
    checkpoint = json.loads(checkpoint_raw)
    dev._saved_authoring_validate_request(checkpoint, project=control.project,
        attempt=original["inputs"]["attempt"], config_sha256=request["config_sha256"], selected=Path(request["source_root"]))
    dev._saved_authoring_validate_services(checkpoint, actual)
    old_raw = read_raw(control, root + "/saved-authoring-checkpoint.json")
    old = json.loads(old_raw)
    input_raw = read_raw(control, proof["original_checkpoint_relative"])
    require(digest(input_raw) == original["inputs"].get("saved_authoring_checkpoint_sha256")
        and json.loads(input_raw) == old
        and checkpoint["archive"] == old["archive"] == original.get("saved_authoring_restore_required")
        and checkpoint.get("retained_run_catalogs") == old.get("retained_run_catalogs"),
        "Saved authoring obligation or retained history differs")
    drain_raw = read_raw(control, root + "/backend-drain.json")
    require(digest(drain_raw) == proof["drain_sha256"], "Original native drain differs")
    drain = json.loads(drain_raw)
    require(drain.get("schema") == "fullmag.docker-idle-restart-drain.v1"
        and drain.get("backend_container_id") == backend, "Original drain identity differs")
    old_probe = control.read(root + "/saved-authoring-final-preflight.json")
    dev._saved_authoring_validate_drain(old_probe, drain["process_receipt"])
    package = reconciliation.validate_package(request)
    require(digest(read_raw(control, root + "/backend-build-receipt.json")) == request["package_documents"]["receipt"]
        and package["provenance"]["sha256"] == checkpoint["package"]["provenance_sha256"]
        and package["provenance"]["value"].get("source_snapshot_sha256") == checkpoint["package"]["source_snapshot_sha256"],
        "Completed compilation does not match the current package/checkpoint")
    require(digest(read_raw(control, "iteration/verified.json")) == proof["verified_sha256"],
        "Last verified iteration changed; failure-only recovery must preserve it")
    raw, scene = dev._saved_authoring_read_archive(checkpoint, state)
    certificate = dev._retained_certificate(state, control.read(root + "/compose.json"))
    probe = dev._saved_authoring_probe(backend, checkpoint, raw, scene, certificate)
    return {"schema": CGROUP_FAILURE_SCHEMA, "checkpoint_sha256": proof["checkpoint_sha256"],
        "helper_id": proof["helper"]["id"], "helper_log_sha256": digest(log),
        "cgroup_request_sha256": proof["cgroup_request_sha256"], "session_id": checkpoint["session"]["session_id"],
        "probe_sha256": digest(canonical(probe)), "compilation": "succeeded", "iteration": "failed",
        "partial_cgroup_state": "preserved_unknown", "delegation_repaired": False, "new_solve": False}
