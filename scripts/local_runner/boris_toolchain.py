"""Prepare an offline, receipt-bound BORIS CPU dependency context."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import uuid
import zipfile
import stat
import importlib
import sys
import datetime

REQUESTED = ("libfftw3-dev", "libx11-dev", "libtbb-dev")
MAX_BYTES = 1024**3
MAX_FILES = 4096
HASH = re.compile(r"[a-f0-9]{64}")


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            result.update(block)
    return result.hexdigest()


def load(path):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate JSON key")
            value[key] = item
        return value
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 8*1024**2:
        raise ValueError("JSON input bound or symlink")
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)


def member(root, name):
    if not isinstance(name, str) or "\\" in name or ":" in name:
        raise ValueError("invalid bundle member")
    relative = PurePosixPath(name)
    if relative.is_absolute() or relative.as_posix() != name or any(p in ("", ".", "..") for p in relative.parts):
        raise ValueError("escaping bundle member")
    path = root
    for part in relative.parts:
        path = path/part
        if path.is_symlink():
            raise ValueError("bundle symlink")
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("bundle file missing or escaped")
    return path


def check_file(root, entry, key="path"):
    path = member(root, entry[key])
    size = entry.get("size", path.stat().st_size)
    if type(size) is not int or not 0 <= size <= MAX_BYTES or path.stat().st_size != size:
        raise ValueError("bundle file size mismatch")
    expected = entry.get("sha256")
    if not isinstance(expected, str) or not HASH.fullmatch(expected) or sha(path) != expected:
        raise ValueError("bundle file hash mismatch")
    return path


def dependency_selection(lock, base):
    packages = {p["name"]: p for p in lock["downloaded_packages"]}
    if len(packages) != len(lock["downloaded_packages"]) or not 1 <= len(packages) <= 500:
        raise ValueError("duplicate or excessive package list")
    installed = {p["name"].split(":")[0]: p["version"] for p in base}
    graph = lock["dependency_graph"]
    selected = set()
    pending = list(REQUESTED)
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in packages or name in installed:
            raise ValueError("requested dependency missing or upgrades base")
        selected.add(name)
        package = packages[name]
        for field in ("depends", "pre_depends"):
            requirements = [v.strip() for v in package[field].split(",") if v.strip()]
            records = [r for r in graph if r["package"] == name and r["field"] == field]
            if sorted(r["requirement"] for r in records) != sorted(requirements):
                raise ValueError("incomplete dependency graph")
            for record in records:
                provider = record["selected_provider"]
                owner, target = provider["owner"], provider["provider"]
                if owner == "bundle":
                    if target not in packages or packages[target]["version"] != provider["version"]:
                        raise ValueError("bundle dependency version mismatch")
                    pending.append(target)
                elif owner != "base" or installed.get(target) != provider["version"]:
                    raise ValueError("base dependency version mismatch")
    if any(name.startswith("python") or "matplotlib" in name or "numpy" in name for name in selected):
        raise ValueError("apt Python stack is forbidden")
    return [packages[name] for name in sorted(selected)]


def validate_bundle(root, image):
    if root.is_symlink() or not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("immutable base image required")
    lock = load(member(root, "packages.lock.json"))
    receipt = load(member(root, "terminal-receipt.json"))
    freeze = load(member(root, "download-source-freeze.json"))
    if (lock.get("schema") != "fullmag.boris.dependency-bundle.v1" or
            lock.get("base_image_id") != image or lock.get("architecture") != "amd64" or
            lock.get("apt_no_upgrade") is not True or lock.get("apt_no_install_recommends") is not True):
        raise ValueError("dependency bundle policy mismatch")
    if (receipt.get("status") != "PREPARED_DOWNLOAD_ONLY" or
            receipt.get("lock_sha256") != sha(root/"packages.lock.json") or
            any(receipt.get(k) is not False for k in ("installation_executed", "image_build_executed", "solver_executed", "operator_changed"))):
        raise ValueError("terminal download receipt mismatch")
    freeze_path = member(root, "download-source-freeze.json")
    if freeze_path.stat().st_size > 8*1024**2:
        raise ValueError("freeze exceeds bound")
    files = freeze.get("files", [])
    names = [f["path"] for f in files]
    if freeze.get("status") != "FROZEN_DOWNLOAD_ONLY" or len(names) != len(set(names)) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("download freeze invalid")
    if sum(f["size"] for f in files) > MAX_BYTES:
        raise ValueError("download freeze exceeds bound")
    for entry in files:
        check_file(root, entry)
    if not {"packages.lock.json", "terminal-receipt.json"}.issubset(names):
        raise ValueError("receipt is not frozen")
    base_path = check_file(root, dict(path="metadata/base-inventory.json", sha256=lock["base_inventory_sha256"]))
    base = load(base_path)
    for entry in lock["downloaded_packages"]:
        check_file(root, entry, "filename")
        metadata = entry["index_metadata"]
        if not metadata or any(m.get("SHA256") != entry["sha256"] or m.get("Version") != entry["version"] or m.get("Package") != entry["name"] for m in metadata):
            raise ValueError("package index identity mismatch")
    for entry in lock["indices"]:
        check_file(root, entry)
    for entry in lock["sources"]:
        check_file(root, entry, "copy")
    selected = dependency_selection(lock, base)
    return lock, freeze, selected


def wheel_members(root, packages):
    seen = set()
    total = 0
    count = 0
    for package in packages:
        path = check_file(root, dict(package, path="wheels/"+package["filename"]))
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                name = entry.filename.rstrip("/")
                relative = PurePosixPath(name)
                if (not name or relative.is_absolute() or relative.as_posix() != name or
                        "\\" in name or ":" in name or ".." in relative.parts or
                        stat.S_ISLNK(entry.external_attr >> 16) or
                        relative.parts[0].lower().startswith("numpy")):
                    raise ValueError("unsafe wheel member")
                if entry.is_dir():
                    continue
                if name in seen or any(parent.as_posix() in seen for parent in relative.parents if parent.as_posix() != ".") or any(existing.startswith(name+"/") for existing in seen):
                    raise ValueError("wheel member collision")
                seen.add(name)
                total += entry.file_size
                count += 1
                if total > 256*1024**2 or count > 20000:
                    raise ValueError("wheel expansion bound exceeded")
    return seen


def validate_wheels(root, image):
    manifest = load(member(root, "manifest.json"))
    terminal = load(member(root, "terminal-receipt.json"))
    proof = load(member(root, "preflight-receipt.json"))
    if (manifest.get("schema") != "fullmag.boris.python-wheel-bundle.v1" or
            manifest.get("base_image_id") != image or
            manifest.get("baseline_numpy") != dict(version="2.2.6", path="/usr/local/lib/python3.10/dist-packages/numpy/__init__.py") or
            manifest.get("marker_environment", {}).get("python_full_version") != "3.10.12" or
            terminal.get("status") != "SUCCEEDED_SCOPED_PREFLIGHT" or terminal.get("container_exit_code") != 0 or
            proof.get("status") != "PASSED_IMPORT_AND_AGG_PLOT_ONLY" or proof.get("base_image_id") != image or
            proof.get("manifest_sha256") != sha(root/"manifest.json") or
            proof.get("numpy_before") != proof.get("numpy_after")):
        raise ValueError("wheel receipt identity mismatch")
    files = []
    for name, expected in terminal["artifacts"].items():
        path = check_file(root, dict(path=name, sha256=expected))
        files.append(dict(path=name, size=path.stat().st_size, sha256=expected))
    if not {"manifest.json", "preflight-receipt.json"}.issubset(terminal["artifacts"]):
        raise ValueError("wheel receipt binding missing")
    packages = manifest["packages"]
    names = [p["name"] for p in packages]
    if len(names) != len(set(names)) or not 1 <= len(names) <= 32 or "numpy" in names or "matplotlib" not in names:
        raise ValueError("wheel package set invalid")
    for package in packages:
        for name, expected in (("wheels/"+package["filename"], package["sha256"]),
                               (package["name"]+"-release.json", package["release_json_sha256"]),
                               (package["name"]+"-METADATA.txt", package["metadata_sha256"])):
            path = check_file(root, dict(path=name, sha256=expected))
            files.append(dict(path=name, size=path.stat().st_size, sha256=expected))
    wheel_members(root, packages)
    if sum(f["size"] for f in files) > 128*1024**2:
        raise ValueError("wheel bundle bound exceeded")
    for name in ("terminal-receipt.json",):
        path = member(root, name)
        files.append(dict(path=name, size=path.stat().st_size, sha256=sha(path)))
    return manifest, files


def prepare_context(repo, bundle, image, wheels):
    from fullmag_storage import resolve_layout, validate_path
    layout = resolve_layout(repo, "windows-native")
    storage = Path(layout["storage_root"])
    bundle = validate_path(bundle, storage)
    lock, freeze, selected = validate_bundle(bundle, image)
    wheels = validate_path(wheels, storage)
    wheel_manifest, wheel_files = validate_wheels(wheels, image)
    # All bytes and bounds are admitted before creating or copying the snapshot.
    context = validate_path(storage/"tmp"/("boris-toolchain-"+uuid.uuid4().hex), storage)
    context.mkdir(parents=True)
    for entry in freeze["files"]:
        source = check_file(bundle, entry)
        target = context/"bundle"/entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        check_file(context/"bundle", entry)
    shutil.copyfile(bundle/"download-source-freeze.json", context/"bundle/download-source-freeze.json")
    for entry in wheel_files:
        source = check_file(wheels, entry)
        target = context/"wheel-bundle"/entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        check_file(context/"wheel-bundle", entry)
    manifest = dict(schema="fullmag.boris.toolchain-context.v1", base_image_id=image,
                    lock_sha256=sha(context/"bundle/packages.lock.json"), selected_packages=selected,
                    qualification="CONTEXT_PREPARED_NOT_RUNTIME_VERIFIED", wheel_manifest_sha256=sha(wheels/"manifest.json"), download_freeze_sha256=sha(context/"bundle/download-source-freeze.json"))
    manifest["context_source_sha256"] = {"boris_toolchain.py": sha(Path(__file__)), "Dockerfile": sha(Path(__file__).with_name("Dockerfile.boris-toolchain"))}
    (context/"context.json").write_bytes(canonical(manifest))
    shutil.copyfile(Path(__file__), context/"boris_toolchain.py")
    shutil.copyfile(Path(__file__).with_name("Dockerfile.boris-toolchain"), context/"Dockerfile")
    (context/".dockerignore").write_bytes(b"**\n!Dockerfile\n!context.json\n!boris_toolchain.py\n!bundle/\n!bundle/**\n!wheel-bundle/\n!wheel-bundle/**\n")
    return context


def admit_simulation(output, selected):
    if re.search(r"^Remv |^Inst \S+ \[", output, re.M):
        raise ValueError("apt simulation removes or upgrades packages")
    actual = re.findall(r"^Inst (\S+) \((\S+)", output, re.M)
    expected = [(p["name"], p["version"]) for p in selected]
    if sorted(actual) != sorted(expected):
        raise ValueError("apt simulation differs from locked closure")


def install_apt(context):
    manifest = load(context/"context.json")
    bundle = context/"bundle"
    lock, _, selected = validate_bundle(bundle, manifest["base_image_id"])
    if selected != manifest["selected_packages"] or sha(bundle/"packages.lock.json") != manifest["lock_sha256"]:
        raise ValueError("context lock mismatch")
    before = subprocess.check_output(["dpkg-query", "-W", "-f", "${binary:Package}\t${Version}\t${Architecture}\t${db:Status-Status}\t${Provides}\n"], timeout=30).decode()
    # Compare installed package identity, not filesystem timestamps.
    installed = sorted((line.split("\t")[0], line.split("\t")[1]) for line in before.splitlines() if line.split("\t")[3] == "installed")
    base = sorted((p["name"], p["version"]) for p in load(bundle/"metadata/base-inventory.json"))
    if installed != base:
        raise ValueError("actual base inventory mismatch")
    source_parts = context/"empty-apt-sources"
    source_parts.mkdir(exist_ok=True)
    source_list = context/"empty-apt-sources.list"
    source_list.write_bytes(b"")
    command = ["apt-get", "-o", "Dir::Etc::sourcelist="+str(source_list),
               "-o", "Dir::Etc::sourceparts="+str(source_parts),
               "-o", "Dir::Cache::archives="+str(bundle/"apt/cache/archives")+"/",
               "--no-download", "--no-upgrade", "--no-install-recommends", "--no-remove"]
    inputs = [str(member(bundle, p["filename"])) for p in selected]
    simulation = subprocess.check_output([*command, "--simulate", "install", *inputs], timeout=120, env=dict(os.environ, LC_ALL="C", DEBIAN_FRONTEND="noninteractive")).decode()
    admit_simulation(simulation, selected)
    subprocess.run([*command, "-y", "install", *inputs], check=True, timeout=300, env=dict(os.environ, LC_ALL="C", DEBIAN_FRONTEND="noninteractive"))
    (context/"apt-install-proof.json").write_bytes(canonical(dict(lock_sha256=manifest["lock_sha256"], simulation=simulation, qualification="NOT_VERIFIED")))


def install_wheels(context):
    manifest = load(context/"context.json")
    root = context/"wheel-bundle"
    wheels, _ = validate_wheels(root, manifest["base_image_id"])
    if sha(root/"manifest.json") != manifest["wheel_manifest_sha256"]:
        raise ValueError("context wheel identity mismatch")
    target = Path("/opt/fullmag-boris-python")
    if target.exists():
        raise ValueError("private wheel destination already exists")
    target.mkdir()
    for package in wheels["packages"]:
        with zipfile.ZipFile(member(root, "wheels/"+package["filename"])) as archive:
            for entry in archive.infolist():
                destination = target/entry.filename
                if entry.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as source, destination.open("xb") as output:
                        shutil.copyfileobj(source, output)
                    destination.chmod(0o644)


def runtime_preflight(context, output):
    if output.exists():
        raise ValueError("preflight output must be a fresh private directory")
    manifest = load(context/"context.json")
    for name, expected in manifest.get("context_source_sha256", {}).items():
        if sha(member(context, name)) != expected:
            raise ValueError("preflight helper source drift")
    if sha(context/"bundle/download-source-freeze.json") != manifest["download_freeze_sha256"]:
        raise ValueError("preflight frozen receipt identity mismatch")
    if sha(context/"bundle/packages.lock.json") != manifest["lock_sha256"] or sha(context/"wheel-bundle/manifest.json") != manifest["wheel_manifest_sha256"]:
        raise ValueError("preflight source context identity mismatch")
    linker_paths = {}
    modules = []
    # Admission must use actual imports; a download manifest is never a runtime proof.
    for name in ("g++", "readelf", "python3-config"):
        if not shutil.which(name):
            raise ValueError("missing toolchain program: " + name)
    includes = subprocess.check_output(["python3-config", "--includes"], timeout=30).decode().split()
    if not any(v.startswith("-I") and (Path(v[2:])/"Python.h").is_file() for v in includes):
        raise ValueError("missing Python embed headers")
    embed_flags = subprocess.check_output(["python3-config", "--embed", "--ldflags"], timeout=30).decode().strip()
    for library in ("libfftw3.so", "libX11.so", "libtbb.so"):
        path = subprocess.check_output(["g++", "-print-file-name=" + library], timeout=30).decode().strip()
        if path == library or not Path(path).is_file():
            raise ValueError("missing linker library: " + library)
        linker_paths[library] = path
    import numpy
    proof = load(context/"wheel-bundle/preflight-receipt.json")
    actual_numpy = dict(version=numpy.__version__, path=numpy.__file__, sha256=sha(Path(numpy.__file__)))
    if actual_numpy != proof["numpy_before"] or sys.version.split()[0] != "3.10.12":
        raise ValueError("base NumPy changed")
    for expected in proof["modules"]:
        module = importlib.import_module(expected["name"])
        version = getattr(module, "__version__", getattr(module, "version", None))
        if version != expected["version"] or not Path(module.__file__).resolve().is_relative_to(Path("/opt/fullmag-boris-python")):
            raise ValueError("private Python module identity mismatch")
        modules.append(dict(name=expected["name"], version=version, path=module.__file__))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    figure, axes = plt.subplots()
    axes.plot([0, 1], [0, 1])
    output.mkdir(parents=True)
    target = output/"preflight.png"
    figure.savefig(target)
    plt.close(figure)
    if not target.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Matplotlib export failed")
    (output/"runtime-preflight.json").write_bytes(canonical(dict(context_sha256=sha(context/"context.json"), lock_sha256=manifest["lock_sha256"], wheel_manifest_sha256=manifest["wheel_manifest_sha256"], numpy=actual_numpy, modules=modules, python=sys.version, python_includes=includes, python_embed_flags=embed_flags, readelf=subprocess.check_output(["readelf", "--version"], timeout=30).decode(), gxx=subprocess.check_output(["g++", "--version"], timeout=30).decode(), linker_paths=linker_paths, plot_sha256=sha(target), qualification="TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED")))



def build_image(repo, context, tag):
    # Image provisioning is separate from the queued native BORIS compilation.
    from fullmag_storage import resolve_layout, validate_path, file_lock
    layout = resolve_layout(repo, "windows-native")
    storage = Path(layout["storage_root"])
    context = validate_path(context, storage/"tmp", "BORIS toolchain context")
    if not context.name.startswith("boris-toolchain-") or not re.fullmatch(r"fullmag/boris-toolchain:[a-z0-9][a-z0-9_.-]{0,100}", tag):
        raise ValueError("private BORIS toolchain context/tag required")
    manifest = load(member(context, "context.json"))
    image = manifest["base_image_id"]
    lock, _, selected = validate_bundle(context/"bundle", image)
    validate_wheels(context/"wheel-bundle", image)
    if (selected != manifest["selected_packages"] or
            sha(context/"bundle/packages.lock.json") != manifest["lock_sha256"] or
            sha(context/"bundle/download-source-freeze.json") != manifest["download_freeze_sha256"] or
            sha(context/"wheel-bundle/manifest.json") != manifest["wheel_manifest_sha256"]):
        raise ValueError("image context identity mismatch")
    expected_sources = {"boris_toolchain.py": sha(Path(__file__)),
                        "Dockerfile": sha(Path(__file__).with_name("Dockerfile.boris-toolchain"))}
    if manifest.get("context_source_sha256") != expected_sources:
        raise ValueError("image context must use current reviewed helper and Dockerfile")
    for name, expected in expected_sources.items():
        if sha(member(context, name)) != expected:
            raise ValueError("image build source drift")
    inspected = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", image], timeout=30))
    if len(inspected) != 1 or inspected[0]["Id"] != image:
        raise ValueError("installed immutable base image mismatch")
    # BuildKit FROM resolves a local image name, not a bare image-config ID.
    # A task-private alias is verified against the immutable image on both sides.
    base_alias = "fullmag/boris-toolchain-base:"+uuid.uuid4().hex
    subprocess.run(["docker", "--context", "desktop-linux", "image", "tag", image, base_alias], check=True, timeout=30)
    alias = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", base_alias], timeout=30))
    if len(alias) != 1 or alias[0]["Id"] != image:
        raise ValueError("private base alias identity mismatch")
    destination = validate_path(Path(layout["build_root"])/("boris-image-"+uuid.uuid4().hex), storage)
    destination.mkdir(parents=True)
    iid = destination/"image-id.txt"
    command = ["docker", "--context", "desktop-linux", "build", "--network", "none", "--pull=false",
               "--build-arg", "BASE_IMAGE="+base_alias, "--iidfile", str(iid), "-t", tag,
               "-f", str(context/"Dockerfile"), str(context)]
    receipt = dict(schema="fullmag.boris.toolchain-image-build.v1", worktree_id=layout["worktree_id"],
                   context=str(context), context_sha256=sha(context/"context.json"),
                   sources_sha256=expected_sources, base_image_id=image, base_alias=base_alias, tag=tag, command=command,
                   started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   status="RUNNING", native_compilation_executed=False, operator_changed=False,
                   qualification="NOT VERIFIED")
    try:
        with file_lock(storage/"locks"/(context.name+".lock"), "BORIS toolchain image provisioning"):
            with (destination/"build.log").open("xb") as output:
                result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
            receipt["exit_code"] = result.returncode
            if result.returncode != 0:
                raise ValueError("offline BORIS toolchain image build failed; inspect "+str(destination/"build.log"))
            identity = iid.read_text().strip()
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
                raise ValueError("built image ID missing")
            actual = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", identity], timeout=30))
            if len(actual) != 1 or actual[0]["Id"] != identity or actual[0]["Config"].get("User") != "65532:65532":
                raise ValueError("built image identity/runtime user mismatch")
            after_alias = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", base_alias], timeout=30))
            base_layers = inspected[0]["RootFS"]["Layers"]
            if after_alias[0]["Id"] != image or actual[0]["RootFS"]["Layers"][:len(base_layers)] != base_layers:
                raise ValueError("built image does not retain the pinned base layers")
            receipt.update(status="SUCCEEDED_IMAGE_ONLY", image_id=identity,
                           qualification="NONROOT_RUNTIME_PREFLIGHT_AND_BORIS_NOT_VERIFIED")
    except BaseException as error:
        receipt.update(status="FAILED", error=str(error))
        raise
    finally:
        receipt["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (destination/"terminal-receipt.json").write_bytes(canonical(receipt))
        print(json.dumps(dict(receipt=str(destination/"terminal-receipt.json"), status=receipt["status"], image_id=receipt.get("image_id"))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare-image-context", "install-apt", "install-wheels", "runtime-preflight", "build-image"))
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--base-image")
    parser.add_argument("--wheel-bundle", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--tag")
    parser.add_argument("--context", type=Path, default=Path("/opt/fullmag-boris-toolchain"))
    args = parser.parse_args()
    if args.operation == "prepare-image-context":
        if not all((args.repo_root, args.bundle, args.base_image, args.wheel_bundle)):
            parser.error("prepare requires repo-root, bundle, wheel-bundle and base-image")
        print(json.dumps(dict(context=str(prepare_context(args.repo_root, args.bundle, args.base_image, args.wheel_bundle)), qualification="CONTEXT_PREPARED_NOT_RUNTIME_VERIFIED")))
    elif args.operation == "build-image":
        if not all((args.repo_root, args.tag)):
            parser.error("build-image requires repo-root, context and private tag")
        build_image(args.repo_root, args.context, args.tag)
    elif args.operation == "install-apt":
        install_apt(args.context)
    elif args.operation == "install-wheels":
        install_wheels(args.context)
    else:
        if args.output_dir is None:
            parser.error("runtime-preflight requires fresh output-dir")
        runtime_preflight(args.context, args.output_dir)


if __name__ == "__main__":
    import sys
    if __package__ in (None, ""):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    main()
