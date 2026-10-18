"""Frozen offline coordinator image provisioning; never starts its queue."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import sys
import uuid

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_runner.boris_toolchain import canonical, sha, load, member
from fullmag_storage import resolve_layout, validate_path, file_lock

MAX_FILES = 4096
MAX_BYTES = 64*1024**2
MAX_LOG = 8*1024**2
BASE_REFERENCE = "python@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93"
ENTRYPOINT = ["python3", "-m", "local_runner.container_main"]
DOCKERIGNORE = b"**\n!Dockerfile\n!context.json\n!fullmag_storage.py\n!capture_source_snapshot_identity.py\n!local_runner/\n!local_runner/*.py\n!local_runner/ui_dist/\n!local_runner/ui_dist/**\n"


def frozen_dockerfile(source):
    expected = ("ARG BASE_IMAGE="+BASE_REFERENCE+"\nFROM ${BASE_IMAGE}\n").encode()
    normalized = source.replace(b"\r\n", b"\n")
    if not normalized.startswith(expected) or b"# syntax" in normalized or b"#syntax" in normalized:
        raise ValueError("coordinator reviewed pinned Dockerfile required")
    return normalized.replace(b"FROM ${BASE_IMAGE}\n", b"FROM ${BASE_IMAGE}\nCOPY context.json /opt/runner/source-proof.json\n", 1)


def git(repo, *args, **kwargs):
    return subprocess.check_output(["git", "--no-optional-locks", "-C", str(repo), *args], timeout=60, **kwargs)


def selected(name):
    return (name in ("fullmag_storage.py", "capture_source_snapshot_identity.py", "local_runner/Dockerfile.coordinator") or
            re.fullmatch(r"local_runner/[^/]+\.py", name) is not None or
            name.startswith("local_runner/ui_dist/"))


def snapshot_members(scripts):
    names = ["fullmag_storage.py", "capture_source_snapshot_identity.py", "local_runner/Dockerfile.coordinator"]
    directory = scripts/"local_runner"
    if directory.is_symlink() or (directory/"ui_dist").is_symlink():
        raise ValueError("coordinator source directory symlink")
    names.extend(p.relative_to(scripts).as_posix() for p in directory.glob("*.py"))
    for base, dirs, files in os.walk(directory/"ui_dist", followlinks=False):
        if any((Path(base)/name).is_symlink() for name in dirs):
            raise ValueError("coordinator UI directory symlink")
        names.extend((Path(base)/name).relative_to(scripts).as_posix() for name in files)
    names = sorted(set(names))
    if not any(name.startswith("local_runner/ui_dist/") for name in names) or len(names) > MAX_FILES:
        raise ValueError("coordinator COPY source membership invalid")
    for name in names:
        member(scripts, name)
    return names


def base_inspect(reference, expected_id=None):
    values = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", reference], timeout=30))
    if len(values) != 1:
        raise ValueError("coordinator base image missing")
    value = values[0]
    if (not re.fullmatch(r"sha256:[a-f0-9]{64}", value.get("Id", "")) or
            (expected_id is not None and value["Id"] != expected_id) or
            (reference == BASE_REFERENCE and BASE_REFERENCE not in value.get("RepoDigests", [])) or
            not value.get("RootFS", {}).get("Layers") or value.get("Config", {}).get("Volumes") or
            value.get("Os") != "linux" or value.get("Architecture") != "amd64"):
        raise ValueError("coordinator pinned base image identity mismatch")
    result = {key:value[key] for key in ("Id", "RootFS", "Architecture", "Os")}
    result["Config"] = {key:value.get("Config", {})[key] for key in ("Entrypoint", "Cmd", "User", "WorkingDir") if key in value.get("Config", {})}
    return result


def capture(repo, mode, ref=None, allow_dirty=False, include_untracked=()):
    if mode not in ("snapshot", "commit") or (mode == "commit") != bool(ref):
        raise ValueError("explicit snapshot or full commit selection required")
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    resolved = head
    if mode == "commit":
        if not re.fullmatch(r"[a-f0-9]{40}", ref):
            raise ValueError("full immutable commit SHA required")
        resolved = git(repo, "rev-parse", ref+"^{commit}").decode().strip()
        if resolved != ref or include_untracked or allow_dirty:
            raise ValueError("commit selection cannot include snapshot options")
    tree = {}
    for row in git(repo, "ls-tree", "-r", "-z", resolved, "--", "scripts").split(b"\0"):
        if not row:
            continue
        metadata, path = row.split(b"\t", 1); mode_bits, kind, oid = metadata.split()
        name = path.decode()[len("scripts/"):]
        if not selected(name):
            continue
        if kind != b"blob" or mode_bits not in (b"100644", b"100755"):
            raise ValueError("coordinator Git source link unsupported")
        tree[name] = (mode_bits.decode(), oid.decode())
    scripts = repo/"scripts"
    status = git(repo, "status", "--porcelain", "--untracked-files=all").decode()
    if mode == "snapshot" and status and not allow_dirty:
        raise ValueError("dirty snapshot requires explicit allow-dirty")
    names = snapshot_members(scripts) if mode == "snapshot" else sorted(tree)
    allowed = set(include_untracked)
    if any(not name.startswith("scripts/") or not selected(name[len("scripts/"):]) for name in allowed):
        raise ValueError("untracked admission outside coordinator COPY inputs")
    if mode == "snapshot" and any(name not in tree and "scripts/"+name not in allowed for name in names):
        raise ValueError("coordinator untracked input needs explicit admission")
    captured = []; total = 0
    for name in names:
        if mode == "snapshot":
            path = member(scripts, name)
            remaining = MAX_BYTES-total
            if path.stat().st_size > remaining:
                raise ValueError("coordinator source bytes exceed bound")
            with path.open("rb") as stream:
                data = stream.read(remaining+1)
            total += len(data)
            file_mode = tree.get(name, ("100644", None))[0]
        else:
            size = int(git(repo, "cat-file", "-s", tree[name][1]))
            if total+size > MAX_BYTES:
                raise ValueError("coordinator source bytes exceed bound")
            data = git(repo, "cat-file", "blob", tree[name][1]); total += len(data); file_mode = tree[name][0]
        if total > MAX_BYTES or len(captured) >= MAX_FILES:
            raise ValueError("coordinator source bounds exceeded")
        captured.append((name, data, file_mode))
    required = {"fullmag_storage.py", "capture_source_snapshot_identity.py", "local_runner/Dockerfile.coordinator", "local_runner/container_main.py"}
    if not required.issubset(names) or not any(n.startswith("local_runner/ui_dist/") for n in names):
        raise ValueError("coordinator required COPY input missing")
    if mode == "snapshot":
        for name, data, _ in captured:
            if sha(member(scripts, name)) != hashlib.sha256(data).hexdigest():
                raise ValueError("coordinator source changed during capture")
        if snapshot_members(scripts) != names or git(repo, "rev-parse", "HEAD").decode().strip() != head:
            raise ValueError("coordinator source membership or HEAD changed")
    return captured, dict(source_mode=mode, resolved_commit=resolved, head_at_capture=head, dirty_snapshot=bool(status) if mode == "snapshot" else False, include_untracked=sorted(allowed))


def validate_context(context):
    if context.is_symlink():
        raise ValueError("coordinator context symlink")
    value = load(member(context, "context.json"))
    files = value.get("files", [])
    names = [e["path"] for e in files]
    if value.get("schema") != "fullmag.runner.coordinator-image-context.v1" or names != sorted(set(names)) or not 1 <= len(files) <= MAX_FILES+2:
        raise ValueError("coordinator context manifest invalid")
    required = {"Dockerfile", ".dockerignore", "fullmag_storage.py", "capture_source_snapshot_identity.py", "local_runner/container_main.py"}
    if (not required.issubset(names) or not any(n.startswith("local_runner/ui_dist/") for n in names) or
            any(n not in ("Dockerfile", ".dockerignore") and not selected(n) for n in names) or
            value.get("base_reference") != BASE_REFERENCE):
        raise ValueError("coordinator manifest COPY/base contract invalid")
    total = 0
    for entry in files:
        path = member(context, entry["path"]); size = entry["size"];
        if type(size) is not int or size < 0:
            raise ValueError("coordinator size invalid")
        total += size
        if type(size) is not int or size < 0 or total > MAX_BYTES or path.stat().st_size != size or sha(path) != entry["sha256"] or entry["mode"] not in ("100644", "100755"):
            raise ValueError("coordinator frozen byte/mode identity mismatch")
    actual = []
    for base, dirs, members in os.walk(context, followlinks=False):
        if any((Path(base)/name).is_symlink() for name in dirs):
            raise ValueError("coordinator context directory symlink")
        actual.extend((Path(base)/name).relative_to(context).as_posix() for name in members)
    if sorted(actual) != sorted([*names, "context.json"]):
        raise ValueError("coordinator context unexpected member")
    if sha(Path(__file__)) != value.get("producer_sha256") or (context/".dockerignore").read_bytes() != DOCKERIGNORE:
        raise ValueError("coordinator reviewed producer drift")
    if (context/"Dockerfile").read_bytes() != frozen_dockerfile(Path(__file__).with_name("Dockerfile.coordinator").read_bytes()):
        raise ValueError("coordinator reviewed Dockerfile drift")
    return value


def prepare_context(repo, mode, ref=None, allow_dirty=False, include_untracked=()):
    layout = resolve_layout(repo, "windows-native"); storage = Path(layout["storage_root"])
    captured, provenance = capture(repo, mode, ref, allow_dirty, include_untracked)
    inspection = base_inspect(BASE_REFERENCE)
    context = validate_path(storage/"tmp"/("coordinator-image-"+uuid.uuid4().hex), storage)
    context.mkdir(parents=True)
    modes = {".dockerignore":"100644"}
    for name, data, file_mode in captured:
        if name == "local_runner/Dockerfile.coordinator":
            data = frozen_dockerfile(data)
        name = "Dockerfile" if name == "local_runner/Dockerfile.coordinator" else name
        modes[name] = file_mode
        target = context/name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        target.chmod(0o755 if file_mode == "100755" else 0o644)
    (context/".dockerignore").write_bytes(DOCKERIGNORE)
    files = [dict(path=p.relative_to(context).as_posix(), size=p.stat().st_size, sha256=sha(p), mode=modes[p.relative_to(context).as_posix()]) for p in context.rglob("*") if p.is_file()]
    files.sort(key=lambda e:e["path"])
    value = dict(schema="fullmag.runner.coordinator-image-context.v1", worktree_id=layout["worktree_id"], files=files,
                 base_reference=BASE_REFERENCE, base_inspect=inspection, producer_sha256=sha(Path(__file__)),
                 provenance=provenance, qualification="CONTEXT_ONLY_NOT_DEPLOYED")
    (context/"context.json").write_bytes(canonical(value)); validate_context(context)
    print(json.dumps(dict(context=str(context), context_sha256=sha(context/"context.json"), qualification=value["qualification"])))
    return context


def bounded_build(command, log):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    expired = threading.Event()
    def timeout():
        expired.set(); process.kill()
    timer = threading.Timer(900, timeout); timer.start()
    total = 0
    try:
        with log.open("xb") as output:
            while True:
                block = process.stdout.read1(65536)
                if not block:
                    break
                if total+len(block) > MAX_LOG:
                    raise ValueError("coordinator image build log bound exceeded")
                output.write(block); total += len(block)
        code = process.wait(timeout=30)
        if expired.is_set():
            raise ValueError("coordinator image build timeout")
        return code
    finally:
        timer.cancel()
        if process.poll() is None:
            process.kill(); process.wait(timeout=30)
        process.stdout.close()


READBACK = """import hashlib,json,pathlib
p=pathlib.Path('/opt/runner/source-proof.json');v=json.loads(p.read_text());out={}
for e in v['files']:
 n=e['path']
 if n in ('Dockerfile','.dockerignore'):continue
 f=pathlib.Path('/opt/runner/scripts')/n
 assert f.is_file() and not f.is_symlink() and f.stat().st_size==e['size']
 h=hashlib.sha256(f.read_bytes()).hexdigest();assert h==e['sha256'];out[n]=h
root=pathlib.Path('/opt/runner/scripts');actual=[]
for f in root.rglob('*'):
 assert not f.is_symlink()
 if f.is_file():actual.append(f.relative_to(root).as_posix())
assert sorted(actual)==sorted(out)
print(json.dumps(dict(proof_sha256=hashlib.sha256(p.read_bytes()).hexdigest(),files=out)))
"""


def provision_base(repo):
    """Explicit network download of only the reviewed immutable Python base."""
    layout = resolve_layout(repo, "windows-native"); storage = Path(layout["storage_root"])
    frozen_dockerfile(Path(__file__).with_name("Dockerfile.coordinator").read_bytes())
    destination = validate_path(Path(layout["build_root"])/("coordinator-base-provision-"+uuid.uuid4().hex), storage)
    destination.mkdir(parents=True)
    command = ["docker", "--context", "desktop-linux", "image", "pull", BASE_REFERENCE]
    receipt = dict(schema="fullmag.runner.coordinator-base-provision.v1", worktree_id=layout["worktree_id"], status="RUNNING", base_reference=BASE_REFERENCE, command=command, producer_sha256=sha(Path(__file__)), dockerfile_sha256=sha(Path(__file__).with_name("Dockerfile.coordinator")), native_compilation_executed=False, docker_image_build_executed=False, operator_changed=False)
    try:
        (storage/"locks").mkdir(parents=True, exist_ok=True)
        with file_lock(storage/"locks"/"coordinator-base-provision.lock", "coordinator pinned base download"):
            code = bounded_build(command, destination/"pull.log")
            receipt.update(exit_code=code, log_sha256=sha(destination/"pull.log"), log_bytes=(destination/"pull.log").stat().st_size)
            if code != 0:
                raise ValueError("coordinator pinned base download failed")
            inspection = base_inspect(BASE_REFERENCE)
            receipt.update(status="SUCCEEDED_PINNED_BASE_ONLY", verified_repo_digest=BASE_REFERENCE, image_inspect=inspection, qualification="COORDINATOR_IMAGE_NOT_BUILT")
    except BaseException as error:
        receipt.update(status="FAILED", error=str(error)); raise
    finally:
        receipt["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        temporary = destination/"terminal-receipt.tmp"; temporary.write_bytes(canonical(receipt)); temporary.replace(destination/"terminal-receipt.json")
        print(json.dumps(dict(receipt=str(destination/"terminal-receipt.json"), status=receipt["status"])))


def build_image(repo, context, tag, context_sha256):
    layout = resolve_layout(repo, "windows-native"); storage = Path(layout["storage_root"])
    context = validate_path(context, storage/"tmp", "coordinator image context")
    if not context.name.startswith("coordinator-image-") or not re.fullmatch(r"fullmag/build-runner:[a-z0-9][a-z0-9_.-]{0,100}", tag):
        raise ValueError("private coordinator context/tag required")
    destination = validate_path(Path(layout["build_root"])/("coordinator-image-build-"+uuid.uuid4().hex), storage); destination.mkdir(parents=True)
    receipt = dict(schema="fullmag.runner.coordinator-image-build.v1", worktree_id=layout["worktree_id"], context=str(context), status="RUNNING", native_compilation_executed=False, operator_changed=False, qualification="NOT VERIFIED")
    try:
        (storage/"locks").mkdir(parents=True, exist_ok=True)
        with file_lock(storage/"locks"/(context.name+".lock"), "coordinator image provisioning"):
            if not re.fullmatch(r"[a-f0-9]{64}", context_sha256) or sha(member(context, "context.json")) != context_sha256:
                raise ValueError("coordinator explicit context lock mismatch")
            value = validate_context(context)
            if value["worktree_id"] != layout["worktree_id"]:
                raise ValueError("coordinator context owner mismatch")
            base = base_inspect(BASE_REFERENCE, value["base_inspect"]["Id"])
            if base != value["base_inspect"]:
                raise ValueError("coordinator frozen base drift")
            alias = "fullmag/coordinator-base:"+uuid.uuid4().hex
            subprocess.run(["docker", "--context", "desktop-linux", "image", "tag", base["Id"], alias], check=True, timeout=30)
            if base_inspect(alias, base["Id"]) != base:
                raise ValueError("coordinator verified base alias drift")
            iid = destination/"image-id.txt"
            command = ["docker", "--context", "desktop-linux", "build", "--network", "none", "--pull=false", "--build-arg", "BASE_IMAGE="+alias, "--iidfile", str(iid), "-t", tag, "-f", str(context/"Dockerfile"), str(context)]
            receipt.update(context_sha256=sha(context/"context.json"), provenance=value["provenance"], base_image_id=base["Id"], base_alias=alias, command=command)
            code = bounded_build(command, destination/"build.log"); receipt["exit_code"] = code
            receipt.update(build_log_sha256=sha(destination/"build.log"), build_log_bytes=(destination/"build.log").stat().st_size)
            if code != 0:
                raise ValueError("coordinator image build failed")
            identity = iid.read_text().strip()
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
                raise ValueError("coordinator built image ID missing")
            actual = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", identity], timeout=30))
            if len(actual) != 1 or actual[0].get("Id") != identity or actual[0].get("Config", {}).get("Entrypoint") != ENTRYPOINT or actual[0]["RootFS"]["Layers"][:len(base["RootFS"]["Layers"])] != base["RootFS"]["Layers"]:
                raise ValueError("coordinator built image identity/entrypoint/base layers mismatch")
            receipt["image_inspect"] = dict(Id=actual[0]["Id"], RootFS=actual[0]["RootFS"], Entrypoint=actual[0]["Config"]["Entrypoint"])
            if base_inspect(alias, base["Id"]) != base:
                raise ValueError("coordinator verified base alias drift")
            validate_context(context)
            if sha(context/"context.json") != context_sha256:
                raise ValueError("coordinator context lock changed during build")
            raw = subprocess.check_output(["docker", "--context", "desktop-linux", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "256m", "--cpus", "1", "--entrypoint", "python3", identity, "-B", "-c", READBACK], timeout=60)
            if len(raw) > 1024**2:
                raise ValueError("coordinator source readback response bound")
            proof = json.loads(raw)
            expected = {e["path"]:e["sha256"] for e in value["files"] if e["path"] not in ("Dockerfile", ".dockerignore")}
            if proof != dict(proof_sha256=sha(context/"context.json"), files=expected):
                raise ValueError("coordinator actual source readback mismatch")
            (destination/"source-readback.json").write_bytes(canonical(proof))
            receipt.update(status="SUCCEEDED_IMAGE_ONLY", image_id=identity, source_readback_sha256=sha(destination/"source-readback.json"), qualification="COORDINATOR_DEPLOYMENT_NOT_VERIFIED")
    except BaseException as error:
        receipt.update(status="FAILED", error=str(error)); raise
    finally:
        receipt["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        temporary = destination/"terminal-receipt.tmp"; temporary.write_bytes(canonical(receipt)); temporary.replace(destination/"terminal-receipt.json")
        print(json.dumps(dict(receipt=str(destination/"terminal-receipt.json"), status=receipt["status"], image_id=receipt.get("image_id"))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare-image-context", "build-image", "provision-base"))
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source", choices=("snapshot", "commit"))
    parser.add_argument("--ref")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--include-untracked", action="append", default=[])
    parser.add_argument("--context", type=Path)
    parser.add_argument("--tag")
    parser.add_argument("--context-sha256")
    args = parser.parse_args()
    if args.operation == "provision-base":
        provision_base(args.repo_root)
    elif args.operation == "prepare-image-context":
        if not args.source:parser.error("prepare requires explicit source mode")
        prepare_context(args.repo_root, args.source, args.ref, args.allow_dirty, tuple(args.include_untracked))
    else:
        if not args.context or not args.tag or not args.context_sha256:parser.error("build requires context, SHA256 lock and tag")
        build_image(args.repo_root, args.context, args.tag, args.context_sha256)


if __name__ == "__main__":
    main()
