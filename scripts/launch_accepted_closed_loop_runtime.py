"""Bounded, offline launcher for the accepted closed-loop managed runtime gate."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

SCHEMA = "fullmag.accepted-closed-loop-launch.v1"
PROJECT = "/probe/project"
CAPSULE = PROJECT + "/worktrees/source"
STORE = PROJECT + "/storage"
OWNER = "fullmag.accepted-closed-loop.owner"
LOADER_ENV = ("LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH")
IMAGE_LIBRARY_PATH = "/opt/fullmag-deps/lib:"
PROOF = STORE + "/builds/proof"
KEEPER = """import json, pathlib, subprocess, sys, time
code = subprocess.run(sys.argv[1:]).returncode
if code == 0:
    sys.exit(0)
pathlib.Path('/probe/project/storage/builds/proof/keeper-status.json').write_text(
    json.dumps({'driver_exit_code': code, 'state': 'failed-held-for-owner'}) + '\\n', encoding='utf-8')
while True:
    time.sleep(60)
"""


def sha(path):
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
        return digest.hexdigest()


def path_checked(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("Absolute paths required")
    for parent in (path, *path.parents):
        if parent.exists() or parent.is_symlink():
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("Symlinks/reparse points forbidden")
    return path.resolve()


def bounded_bytes(path, limit):
    path = path_checked(path)
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError("Missing, nonregular or oversized input")
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if len(raw) > limit or len(raw) != before.st_size or file_identity(before) != file_identity(after):
            raise ValueError("Input changed during bounded read")
        return raw


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def parse_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def json_file(path, limit=4 << 20):
    return parse_json(bounded_bytes(path, limit))


def bounded_copy(source, destination, expected_sha, expected_size, limit=64 << 20):
    source, destination = path_checked(source), path_checked(destination)
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as stream, destination.open("xb") as target:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != expected_size or expected_size > limit:
            raise ValueError("Copy source size/type differs")
        while block := stream.read(min(1 << 20, limit - size + 1)):
            size += len(block)
            if size > limit:
                raise ValueError("Copy source exceeded bound")
            digest.update(block)
            target.write(block)
        after = os.fstat(stream.fileno())
        if (size != expected_size or digest.hexdigest() != expected_sha or
                file_identity(before) != file_identity(after)):
            raise ValueError("Input changed during bounded copy")
    # Reopen within the same bound to detect replacement after the copy handle.
    if hashlib.sha256(bounded_bytes(source, limit)).hexdigest() != expected_sha:
        raise ValueError("Input changed after bounded copy")

def save(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")


def docker(*args, timeout=60):
    result = subprocess.run(["docker", "--context", "desktop-linux", *args],
                            capture_output=True, text=True, timeout=timeout,
                            env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    if result.returncode:
        raise RuntimeError("Docker control failed: " + result.stderr[:8192])
    return result.stdout.strip()


def frozen_source(capsule, digest):
    # Bootstrap only the stdlib-only verifier after binding its bytes to the
    # externally pinned capsule identity. All subsequent helpers are frozen.
    manifest = json_file(capsule / "manifest.json", 32 << 20)
    keys = ("schema_version", "source_mode", "resolved_commit", "files", "deleted", "included_untracked", "excluded")
    raw = (json.dumps({key: manifest[key] for key in keys}, ensure_ascii=False,
                      separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    if hashlib.sha256(raw).hexdigest() != digest or manifest.get("source_digest") != digest:
        raise ValueError("Pinned capsule identity mismatch")
    relative = "scripts/local_runner/worker_entrypoint.py"
    entries = [entry for entry in manifest["files"] if entry.get("path") == relative]
    verifier = path_checked(capsule / "tree" / relative)
    if len(entries) != 1 or sha(verifier) != entries[0]["sha256"]:
        raise ValueError("Frozen source verifier mismatch")
    spec = importlib.util.spec_from_file_location("frozen_capsule_verifier", verifier)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_source(capsule, digest)
    return module


def loader_environment(config):
    values = {}
    environment = config.get("Env", [])
    if not isinstance(environment, list):
        raise ValueError("Invalid loader environment")
    for item in environment:
        if not isinstance(item, str) or "=" not in item:
            raise ValueError("Invalid loader environment assignment")
        key, value = item.split("=", 1)
        if key in LOADER_ENV:
            if key in values:
                raise ValueError("Duplicate loader environment assignment")
            values[key] = value
    return values


def image_admission(observed, image):
    config = observed.get("Config", {})
    loader_env = loader_environment(config)
    if (observed.get("Id") != image or observed.get("Os") != "linux" or
            observed.get("Architecture") != "amd64" or config.get("Volumes") or
            config.get("OnBuild") or config.get("Healthcheck") or
            loader_env.get("LD_PRELOAD") or loader_env.get("LD_AUDIT") or
            loader_env.get("LD_LIBRARY_PATH", "") not in ("", IMAGE_LIBRARY_PATH)):
        raise ValueError("Image Config is not admitted for the offline probe")


def inspect_owned(cid, token):
    if not re.fullmatch("[a-f0-9]{64}", cid):
        raise ValueError("Exact container ID required")
    observed = json.loads(docker("inspect", cid))[0]
    if observed.get("Id") != cid or observed.get("Config", {}).get("Labels", {}).get(OWNER) != token:
        raise ValueError("Container ownership mismatch")
    return observed


def attest(observed, image, command, mounts):
    host, config = observed["HostConfig"], observed["Config"]
    if loader_environment(config) != dict.fromkeys(LOADER_ENV, ""):
        raise ValueError("Created container loader environment is not uniquely empty")
    actual = {(item["Destination"], item["RW"]) for item in observed["Mounts"]}
    expected = {(target, not readonly) for _, target, readonly in mounts}
    # Exact sources are checked against HostConfig's supplied bind specification;
    # Desktop inspect Mounts.Source may normalize drive paths to /run/desktop/....
    bind_specs = {f"{source}:{target}:" + ("ro" if readonly else "rw") for source, target, readonly in mounts}
    if (observed["Image"] != image or config["User"] != "65532:65532" or
            config["Entrypoint"] != ["/usr/bin/env"] or config["Cmd"] != command or
            config["WorkingDir"] != PROJECT or host["NetworkMode"] != "none" or
            not host["ReadonlyRootfs"] or host.get("Privileged") or
            host.get("CapAdd") or host.get("CapDrop") != ["ALL"] or
            host["PidsLimit"] != 256 or host["NanoCpus"] != 2000000000 or
            host["Memory"] != 4 << 30 or host["MemorySwap"] != 4 << 30 or
            host.get("PortBindings") or host.get("Devices") or host.get("DeviceRequests") or
            host.get("RestartPolicy", {}).get("Name") != "no" or
            "no-new-privileges:true" not in (host.get("SecurityOpt") or []) or
            actual != expected or set(host.get("Binds") or []) != bind_specs or
            host.get("Tmpfs") != {"/tmp": "rw,nosuid,nodev,noexec,size=64m,mode=1777"} or
            any(item.get("Type") != "bind" for item in observed["Mounts"])):
        raise ValueError("Actual created container does not match bounded probe")


def launch(request_path, request_sha):
    sys.dont_write_bytecode = True
    request_path = path_checked(request_path)
    request_raw = bounded_bytes(request_path, 64 << 10)
    if hashlib.sha256(request_raw).hexdigest() != request_sha:
        raise ValueError("Request bytes differ")
    request = parse_json(request_raw)
    allowed = {"schema", "repo_root", "source_capsule", "managed_build_run_root", "output_root",
               "image", "commit", "snapshot", "source_digest", "solve_timeout_seconds",
               "driver", "project", "execution_profile", "resources"}
    if not isinstance(request, dict) or set(request) != allowed or request.get("schema") != SCHEMA:
        raise ValueError("Unsupported launch request")
    for key, pattern in (("image", "sha256:[a-f0-9]{64}"), ("commit", "[a-f0-9]{40}"),
                         ("snapshot", "[a-f0-9]{64}"), ("source_digest", "[a-f0-9]{64}")):
        if not re.fullmatch(pattern, str(request.get(key, ""))):
            raise ValueError("Full immutable identity required: " + key)
    if type(request.get("solve_timeout_seconds")) is not int or not 1 <= request["solve_timeout_seconds"] <= 3600:
        raise ValueError("Finite solve timeout required")
    build = path_checked(request["managed_build_run_root"])
    context_path = build / "trusted/context.json"
    context_raw = bounded_bytes(context_path, 4 << 20)
    context, journal = parse_json(context_raw), json_file(build / "receipt.json")
    if (journal.get("trusted_hashes", {}).get("context.json") != hashlib.sha256(context_raw).hexdigest() or
            context.get("source_digest") != request["source_digest"] or
            context.get("image_digest") != request["image"] or
            any(context.get(key) != journal.get(key) for key in ("job_id", "source_digest", "image_digest", "profile")) or
            journal.get("state") != "succeeded" or journal.get("phase") != "terminal" or
            type(journal.get("exit_code")) is not int or journal["exit_code"] != 0):
        raise ValueError("Trusted managed context does not bind the requested capsule/image")
    capsule = path_checked(request["source_capsule"])
    verifier = frozen_source(capsule, request["source_digest"])
    sys.path.insert(0, str(capsule / "tree" / "scripts"))
    import fullmag_storage as storage
    from managed_fem_runtime_package import load_package
    layout = storage.resolve_layout(path_checked(request["repo_root"]))
    root = path_checked(layout["storage_root"])
    output = path_checked(request["output_root"])
    if (not output.is_relative_to(root / "builds" / layout["worktree_id"]) or output.exists() or
            not build.is_relative_to(root) or not capsule.is_relative_to(root) or
            output.is_relative_to(build) or output.is_relative_to(capsule)):
        raise ValueError("Fresh dedicated output and canonical storage inputs required")
    _, evidence, _, _ = load_package(build, root, request["commit"], request["snapshot"],
                                     ["fullmag", "fullmag-api"])
    if (evidence["managed_package"]["source_digest"] != request["source_digest"] or
            evidence["managed_package"]["image_digest"] != request["image"]):
        raise ValueError("Package/capsule mismatch")
    manifest = json_file(capsule / "manifest.json", 32 << 20)
    driver_relative = "scripts/verify_accepted_closed_loop_runtime.py"
    driver_entries = [entry for entry in manifest["files"] if entry.get("path") == driver_relative]
    if len(driver_entries) != 1:
        raise ValueError("Managed capsule must contain the reviewed driver")
    inputs, input_sizes = {}, {}
    for name in ("driver", "project", "execution_profile", "resources"):
        entry = request[name]
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise ValueError("Exact pinned input object required")
        path = path_checked(entry["path"])
        raw = bounded_bytes(path, 64 << 20)
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise ValueError("Pinned input differs: " + name)
        if name == "driver" and (path != capsule / "tree" / driver_relative or
                                 entry["sha256"] != driver_entries[0]["sha256"] or
                                 len(raw) != driver_entries[0]["size"]):
            raise ValueError("Driver must be the exact verified capsule entry")
        inputs[name], input_sizes[name] = path, len(raw)
    image = json.loads(docker("image", "inspect", request["image"]))[0]
    image_admission(image, request["image"])
    token = uuid.uuid4().hex
    output.mkdir(parents=True, exist_ok=False)
    receipt = {"schema": SCHEMA, "state": "preflight", "request_sha256": request_sha,
               "owner": token, "container_id": None, "runtime_verified": False,
               "storage_preflight": layout, "managed_package": evidence}
    cid = None
    windows_storage = None
    storage_can_cleanup = True
    try:
        for name in ("inputs", "proof", "runs"):
            (output / name).mkdir()
        if os.name == "nt":
            storage_path = Path(__file__).resolve().with_name("accepted_closed_loop_windows_storage.py")
            storage_raw = bounded_bytes(storage_path, 256 << 10)
            storage_spec = importlib.util.spec_from_file_location("accepted_closed_loop_windows_storage", storage_path)
            windows_loop_storage = importlib.util.module_from_spec(storage_spec)
            exec(compile(storage_raw, str(storage_path), "exec"), windows_loop_storage.__dict__)
            receipt["windows_storage_adapter_sha256"] = hashlib.sha256(storage_raw).hexdigest()
            windows_storage = windows_loop_storage.prepare(
                output, root, token, request["image"], docker, path_checked, save)
            receipt["windows_storage"] = windows_storage
        for name, source in inputs.items():
            bounded_copy(source, output / "inputs" / name, request[name]["sha256"], input_sizes[name])
        marker = output / "marker.json"
        save(marker, {"schema": "fullmag_storage_v1", "project_root": PROJECT})
        job = build.name
        mounted_build = STORE + "/import/build/" + job
        mounts = [(str(capsule), CAPSULE, True), (str(build), mounted_build, True),
                  (str(output / "inputs"), "/probe/input", True),
                  (str(marker), STORE + "/.fullmag-storage.json", True),
                  (str(output / "proof"), PROOF, False),
                  (str(output / "runs"), STORE + "/runs", False)]
        command = ["-i", "PYTHONDONTWRITEBYTECODE=1", "HOME=/tmp", "TMPDIR=/tmp",
                   "PYTHONPATH=" + CAPSULE + "/tree/scripts", "OMP_NUM_THREADS=2",
                   "/usr/bin/python3", "-c", KEEPER, "/usr/bin/python3", "/probe/input/driver", "--repo-root", CAPSULE + "/tree",
                   "--source-capsule", CAPSULE, "--managed-build-run-root", mounted_build,
                   "--storage-root", STORE, "--expected-commit", request["commit"],
                   "--expected-snapshot", request["snapshot"], "--project", "/probe/input/project",
                   "--execution-profile", "/probe/input/execution_profile", "--resources", "/probe/input/resources",
                   "--project-sha256", request["project"]["sha256"], "--profile-sha256", request["execution_profile"]["sha256"],
                   "--resources-sha256", request["resources"]["sha256"],
                   "--output-root", PROOF + "/run", "--python", "/usr/bin/python3",
                   "--solve-timeout-seconds", str(request["solve_timeout_seconds"])]
        args = ["create", "--pull=never", "--name", "fullmag-b02-" + token, "--cidfile", str(output / "cid"),
                "--label", OWNER + "=" + token, "--network=none", "--read-only", "--user=65532:65532",
                "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=256",
                "--cpus=2", "--memory=4g", "--memory-swap=4g", "--restart=no", "--log-driver=none",
                "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--workdir", PROJECT,
                "--entrypoint", "/usr/bin/env"]
        # Docker must clear loader variables before the dynamic loader starts /usr/bin/env.
        for key in LOADER_ENV:
            args += ["--env", key + "="]
        for source, target, readonly in mounts:
            args += ["--volume", f"{source}:{target}:" + ("ro" if readonly else "rw")]
        save(output / "preflight.json", {**receipt, "image_inspect": image, "command": command, "mounts": mounts})
        docker(*args, request["image"], *command)
        cid = (output / "cid").read_text(encoding="ascii").strip()
        observed = inspect_owned(cid, token)
        attest(observed, request["image"], command, mounts)
        save(output / "container-created-attestation.json", observed)
        receipt.update(state="created", container_id=cid)
        verifier.verify_source(capsule, request["source_digest"])
        if hashlib.sha256(bounded_bytes(request_path, 64 << 10)).hexdigest() != request_sha:
            raise ValueError("Request changed before start")
        if windows_storage:
            windows_loop_storage.verify(windows_storage, token, request["image"], docker)
        storage_can_cleanup = False
        docker("start", cid)
        code = int(docker("wait", cid, timeout=4 * request["solve_timeout_seconds"] + 180))
        observed = inspect_owned(cid, token)
        save(output / "container-terminal-inspect.json", observed)
        if observed["State"]["Running"] or observed["State"].get("OOMKilled") or code != 0:
            raise ValueError("Owned runtime gate failed")
        verifier.verify_source(capsule, request["source_digest"])
        if windows_storage:
            driver_receipt = windows_loop_storage.export_receipt(output, request["image"], docker)
            save(output / "driver-receipt.json", parse_json(driver_receipt.encode("utf-8")))
        # Launcher success proves process completion, not the driver's scientific assertions.
        receipt.update(state="completed", driver_exit_code=code)
        return 0
    except Exception as error:
        receipt.update(state="failed", error=str(error))
        raise
    finally:
        if cid is None and (output / "cid").is_file():
            cid = (output / "cid").read_text(encoding="ascii").strip()
        receipt["container_id"] = cid
        if cid:
            try:
                observed = inspect_owned(cid, token)
                if observed["State"]["Running"]:
                    storage_can_cleanup = False
                    receipt.update(cleanup="retained-running-no-stop", state="retained")
                else:
                    docker("rm", cid)
                    receipt["cleanup"] = "removed-owned-stopped"
                    storage_can_cleanup = True
            except Exception as error:
                storage_can_cleanup = False
                receipt["cleanup"] = "retained-control-error: " + str(error)
        if windows_storage and storage_can_cleanup:
            try:
                windows_loop_storage.cleanup(windows_storage, output, token, request["image"], docker, save)
                receipt["storage_cleanup"] = "unmounted-owned; backing-images-retained"
            except Exception as error:
                receipt["storage_cleanup"] = "retained-control-error: " + str(error)
        elif windows_storage:
            receipt["storage_cleanup"] = "retained-with-container"
        save(output / "terminal-receipt.json", receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args()
    return launch(args.request, args.request_sha256)


if __name__ == "__main__":
    sys.exit(main())
