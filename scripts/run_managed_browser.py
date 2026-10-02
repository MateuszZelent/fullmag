"""Start a receipt-verified CPU release in an isolated browser workspace.

No build, dependency installation, shared runtime replacement or solver start.
The exact Compose container and retained state are recorded for later shutdown.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

import fullmag_storage as storage
from local_runner.build_executor import validate_build_receipt
from local_runner.worker_entrypoint import verify_source
from verify_saved_fem_archive_roundtrip import check_stamp

PROFILE = "managed-browser-cpu"
SYSTEM_MOUNT_TARGETS = {"/etc/hosts", "/etc/hostname", "/etc/resolv.conf"}


def require_session_filesystem(kind):
    # Keep this allowlist aligned with fullmag-session's writer classifier.
    # A successful browser/health check does not qualify persistence on 9p.
    if kind.lower().lstrip("0") not in {"ef53", "58465342", "9123683e", "1021994", "794c7630"}:
        raise ValueError(f"Session persistence filesystem 0x{kind} is unsupported; "
                         "container retained, durable storage adapter required")


def host_path(value):
    raw = str(value).replace("\\", "/")
    if os.name == "nt":
        alias = re.fullmatch(r"/(?:run/desktop/mnt/host|host_mnt)/([A-Za-z])/(.*)", raw)
        if alias:
            raw = alias.group(1) + ":/" + alias.group(2)
    return Path(raw).resolve()


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_json(path):
    if storage.is_link(Path(path)) or not Path(path).is_file():
        raise ValueError("Managed document must be a regular file")
    if Path(path).stat().st_size > 4 * 1024**2:
        raise ValueError("Oversized managed document")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validate_managed_build(root, expected_commit):
    journal = read_json(storage.validate_path(root / "receipt.json", root))
    context = read_json(storage.validate_path(root / "trusted/context.json", root))
    if journal.get("phase") != "terminal" or journal.get("state") != "succeeded" \
            or journal.get("exit_code") != 0 or journal.get("profile") != "fem-cpu-release":
        raise ValueError("Managed CPU release must be terminal and successful")
    if root.name != context.get("job_id") or any(journal.get(k) != context.get(k)
            for k in ("job_id", "source_digest", "profile", "image_digest")):
        raise ValueError("Coordinator and build identities differ")
    hashes = journal.get("trusted_hashes", {})
    if set(hashes) != {"context.json", "build_entrypoint.py", "worker_entrypoint.py"}:
        raise ValueError("Incomplete trusted build documents")
    for name, value in hashes.items():
        path = storage.validate_path(root / "trusted" / name, root / "trusted")
        if digest(path) != value:
            raise ValueError("Trusted build document hash mismatch")
    native = context.get("native_source_identity", {})
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit) \
            or native.get("head_commit_full") != expected_commit \
            or native.get("source_snapshot_dirty") is not False:
        raise ValueError("Expected clean commit differs from build")
    job = {"job_id": context["job_id"], "source_digest": context["source_digest"],
           "profile": context["profile"], "payload": {"native_source_identity": native}}
    built = validate_build_receipt(root / "artifacts", job, journal)
    return context, built


def compose_spec(image, source, package, state, port):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("Immutable build image digest required")
    if not 1024 <= port <= 65535:
        raise ValueError("Invalid loopback browser port")
    mounts = [{"type": "bind", "source": str(path.resolve()), "target": target,
               "read_only": readonly}
              for path, target, readonly in ((source, "/source", True),
                  (package, "/package", True), (state, "/state", False))]
    # The capsule cannot acquire mountpoint directories. Create only symlinks
    # in private state; all source members still resolve into the read-only bind.
    entry = ('set -eu; [ ! -L /state/workspace ] || exit 2; '
             'mkdir -p /state/workspace; '
             'for path in /source/* /source/.[!.]*; do '
             '[ -e "$path" ] || continue; name="${path##*/}"; '
             '[ "$name" != ".fullmag" ] || exit 2; '
             'target="/state/workspace/$name"; '
             'if [ -L "$target" ]; then '
             '[ "$(readlink "$target")" = "$path" ] || exit 2; '
             'else [ ! -e "$target" ] || exit 2; ln -s "$path" "$target"; fi; done; '
             '[ ! -L /state/workspace/.fullmag ] || exit 2; '
             'mkdir -p /state/workspace/.fullmag; '
             'cd /state/workspace; exec /package/bin/fullmag-api')
    return {"services": {"browser": {
        "image": image, "pull_policy": "never", "init": True,
        "network_mode": "bridge",
        "entrypoint": [], "command": ["bash", "-c", entry.replace("$", "$$")],
        "working_dir": "/source", "read_only": True,
        "user": "65532:65532", "cpus": 4, "mem_limit": "2g", "pids_limit": 128,
        "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
        "ports": [f"127.0.0.1:{port}:8081"], "volumes": mounts,
        "tmpfs": ["/tmp:rw,nosuid,nodev,size=256m"],
        "environment": {
            "FULLMAG_REPO_ROOT": "/state/workspace", "FULLMAG_STATE_ROOT": "/state/workspace/.fullmag",
            "FULLMAG_WEB_STATIC_DIR": "/package/web", "FULLMAG_API_PORT": "8081",
            "FULLMAG_RUNTIME_ROOT": "/package", "FULLMAG_PYTHON": "/usr/bin/python3",
            "PYTHONPATH": "/source/packages/fullmag-py/src:/package",
            "PYTHONDONTWRITEBYTECODE": "1", "LD_LIBRARY_PATH": "/package/lib:/opt/fullmag-deps/lib",
            "PATH": "/package/bin:/usr/local/bin:/usr/bin:/bin",
            "FULLMAG_FEM_MESH_CACHE_DIR": "/state/workspace/.fullmag/mesh-cache",
            "FULLMAG_DISABLE_MANAGED_FEM_GPU_RUNTIME": "1",
            "FULLMAG_FORCE_LOCAL_FEM_CPU": "1", "FULLMAG_FDM_EXECUTION": "cpu",
            "FULLMAG_FEM_EXECUTION": "cpu", "FULLMAG_FEM_MFEM_DEVICE": "cpu",
            "FULLMAG_FEM_REQUIRE_GPU": "0", "FULLMAG_FEM_REQUIRE_CEED": "0",
            "OMP_NUM_THREADS": "4", "FULLMAG_CPU_THREADS": "4"}}}}


def docker(*args):
    result = subprocess.run(["docker", "--context", "desktop-linux", *args],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Docker operation failed")
    return result.stdout.strip()


def run(repo, job_id, commit, port):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise ValueError("Full managed job ID required")
    layout = storage.resolve_layout(repo, PROFILE)
    base = Path(layout["storage_root"])
    build = storage.validate_path(Path(layout["runs_root"]) / job_id, base)
    context, built = validate_managed_build(build, commit)
    source_mounts = [m for m in read_json(build / "receipt.json").get("mounts", [])
                     if len(m) == 4 and m[0] == "bind" and m[2] == "/source" and m[3] is False]
    if len(source_mounts) != 1:
        raise ValueError("Managed source capsule mount is missing or ambiguous")
    capsule = storage.validate_path(host_path(source_mounts[0][1]), base)
    manifest = verify_source(capsule, context["source_digest"])
    if manifest.get("resolved_commit") != commit or manifest.get("source_mode") != "commit":
        raise ValueError("Managed capsule commit differs from build")
    source = capsule / "tree"
    package = storage.validate_path(build / "artifacts/outputs/.fullmag/local", build)
    if not (source / "packages/fullmag-py/src/fullmag").is_dir():
        raise ValueError("Retained managed source is missing")
    image = json.loads(docker("image", "inspect", context["image_digest"]))[0]
    if image.get("Id") != context["image_digest"] or image.get("Config", {}).get("Volumes"):
        raise ValueError("Image identity or anonymous volumes invalid")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    storage.initialize(layout)
    root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex,
                                 Path(layout["build_storage_root"]))
    root.mkdir(parents=True, exist_ok=False)
    state = root / "state"
    state.mkdir()
    project = "fullmag-browser-" + root.name
    spec = compose_spec(context["image_digest"], source, package, state, port)
    spec_path = root / "compose.json"
    storage.atomic_json(spec_path, spec)
    receipt = {"schema": "fullmag.managed-browser.v1", "state": "starting",
               "qualification": "NOT VERIFIED", "profile": PROFILE,
               "compose_project": project,
               "managed_job_id": job_id, "native_source_identity": built["native_source_identity"],
               "image_digest": context["image_digest"], "url": f"http://localhost:{port}/workspace",
               "run_root": str(root), "build_receipt_sha256": digest(build / "artifacts/build-receipt.json"),
               "launcher_sha256": digest(__file__), "compose_sha256": digest(spec_path),
               "solver_started": False, "unit_tests_compiled": False}
    receipt_path = root / "receipt.json"
    storage.atomic_json(receipt_path, receipt)
    try:
        args = ["compose", "-f", str(spec_path), "--project-name", project]
        docker(*args, "config", "--quiet")
        docker(*args, "up", "--detach", "--no-build", "--pull", "never")
        container = docker(*args, "ps", "--quiet", "browser")
        receipt["container_id"] = container
        observed = json.loads(docker("inspect", container))[0]
        expected_mounts = {(m["target"], str(Path(m["source"]).resolve()).lower(),
                            not m["read_only"]) for m in spec["services"]["browser"]["volumes"]}
        actual_mounts = {(m["Destination"], str(host_path(m["Source"])).lower(), m["RW"])
                         for m in observed["Mounts"] if m["Type"] == "bind"
                         and m["Destination"] not in SYSTEM_MOUNT_TARGETS}
        if observed["Image"] != context["image_digest"] or actual_mounts != expected_mounts \
                or any(m["Type"] == "volume" for m in observed["Mounts"]):
            raise ValueError("Running container image or mount attestation mismatch")
        bindings = observed["HostConfig"]["PortBindings"]
        if bindings != {"8081/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}:
            raise ValueError("Running container loopback binding mismatch")
        host_config = observed["HostConfig"]
        if not host_config.get("ReadonlyRootfs") or host_config.get("Privileged") \
                or set(host_config.get("CapDrop", [])) != {"ALL"} \
                or "no-new-privileges:true" not in host_config.get("SecurityOpt", []) \
                or observed["Config"].get("User") != "65532:65532" \
                or host_config.get("Memory") != 2 * 1024**3 \
                or host_config.get("NanoCpus") != 4 * 10**9 \
                or host_config.get("PidsLimit") != 128:
            raise ValueError("Running container isolation mismatch")
        if host_config.get("NetworkMode") != "bridge":
            raise ValueError("Running container network mode mismatch")
        receipt["attestation"] = {"image_and_mounts": "PASS", "loopback_binding": "PASS"}
        filesystem = docker("exec", container, "stat", "-f", "-c", "%t", "/state")
        receipt["session_filesystem_magic"] = filesystem
        require_session_filesystem(filesystem)
        receipt["session_filesystem"] = "SUPPORTED_TYPE_NOT_QUALIFIED"
        for _ in range(45):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(1)
        else:
            raise ValueError("API health observation timed out; container retained")
        # Docker logs sends the startup stamp on stderr, so read both streams.
        logs = subprocess.run(["docker", "--context", "desktop-linux", "logs", container],
                              capture_output=True, text=True, timeout=30)
        if logs.returncode:
            raise ValueError("Cannot read running API startup identity")
        check_stamp(logs.stdout + logs.stderr, commit,
                    context["native_source_identity"]["source_snapshot_sha256"])
        (root / "startup.log").write_text(logs.stdout + logs.stderr, encoding="utf-8")
        receipt["startup_identity"] = "PASS"
        verify_source(capsule, context["source_digest"])
        receipt["source_capsule_recheck"] = "PASS"
        receipt["launch_state"] = "succeeded"
        receipt["state"] = "running"
        receipt["health"] = "PASS"
    except Exception as error:
        receipt["state"] = "failed_observation_resources_retained"
        receipt["error"] = str(error)
        raise
    finally:
        storage.atomic_json(receipt_path, receipt)
        print(json.dumps({"receipt": str(receipt_path), **receipt}, indent=2))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--port", type=int, default=3104)
    args = parser.parse_args()
    raise SystemExit(run(args.repo_root, args.job_id, args.commit, args.port))
