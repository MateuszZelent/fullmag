"""Managed Compose orchestration for one backend's CPU delegation gate."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

from docker_build_control import BuildControlError, canonical, compose_capture, docker_capture, docker_text

PROFILE = "docker-backend-v1"
ROOT = "/opt/fullmag/worker-cgroup"

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
        "privileged": True, "pid": "host", "read_only": True,
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
             "volume": {"nocopy": True}},
            {"type": "volume", "source": "build-control", "target": "/control",
             "volume": {"nocopy": True, "subpath": "runtime-control/worker-cgroup"}},
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
            or helper.get("State", {}).get("ExitCode") != 0
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
