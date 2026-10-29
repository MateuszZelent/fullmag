"""Pinned BORIS payload/prefix supplier. No compilation, apt, or solver entry point."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import zipfile

ASSET_IMAGE = "sha256:545279e00703d60dcaf33d455461ba90e0dea7ec5647e96392bbc9246c21b6a6"
ORIGIN = "sha256:e360637ea8b00e280efdca7648ee022e6dd16150b10130b734425bb8a65b5aa0"
PINS = {"source_manifest.json": "ec08ad80f8225df2d6d0f44ac51ed5685357f0a57b2bb749f5a4e39260c29ac3", "toolchain/context.json": "d40a205653c6626d4fade491523de06bfb210a61a027d623e84dc98c609cc295", "toolchain/bundle/packages.lock.json": "8da46421ac443e529b6204493475f159d15329712aadbdd127326c90716095d8", "toolchain/wheel-bundle/manifest.json": "93c00e46e23b2efe0c15aafb0e4ef1fe0dcd2620887684bd27476b5326842d2c"}
CURRENT_LIBRARIES = {"/usr/lib/x86_64-linux-gnu/libfftw3.so.3.5.8": "34610b14cb5199a78d9554bef4ef90f8fc53c11d56dd13c5011892a307f71e6d", "/usr/lib/x86_64-linux-gnu/libX11.so.6.4.0": "e23ed094eaf0a74a822a6d9d14eee628ab9f7ec08aecbf20ffd803f019ff6e98"}
DEB_DECODER_PINS = {
    "/usr/bin/dpkg-deb": "790ee7a7bca1bdf8ef7f733df05becd9767dd4749b390845c887c4db5e8b54d1",
    "/usr/lib/x86_64-linux-gnu/libzstd.so.1": "5df4f4df42d76270bb6981fabc7c1fdccd8ad28a23d84d67f73203fb3f537667",
}
MAX_DEB_BYTES = 128 * 1024**2
MAX_DEB_TAR_BYTES = 64 * 1024**2
MAX_FILES = 40000
MAX_BYTES = 2 * 1024**3


def require(ok, message):
    if not ok:
        raise ValueError("BORIS prefix: " + message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024**2), b""):
            digest.update(block)
    return digest.hexdigest()


def member(root, name):
    relative = PurePosixPath(name)
    require(bool(name) and not relative.is_absolute() and relative.as_posix() == name and ".." not in relative.parts and "\\" not in name and ":" not in name, "unsafe member")
    path = root / name
    require(not any(p.is_symlink() for p in (path, *path.parents) if p == root or root in p.parents), "member symlink")
    return path


def load(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 8*1024**2, "JSON bound/type")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "duplicate JSON key")
            value[key] = item
        return value
    return json.loads(path.read_bytes(), object_pairs_hook=unique)


def inventory(root):
    rows = []
    total = 0
    for path in sorted(root.rglob("*")):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            require(path.resolve().is_relative_to(root.resolve()) and path.resolve().exists(), "escaping/dangling link")
            rows.append(dict(path=name, link=os.readlink(path)))
        elif path.is_dir():
            continue
        else:
            require(path.is_file(), "special file")
            total += path.stat().st_size
            rows.append(dict(path=name, size=path.stat().st_size, sha256=sha(path)))
        require(len(rows) <= MAX_FILES and total <= MAX_BYTES, "inventory bound")
    return rows


def verified_tool(root):
    context = load(member(root, "context.json"))
    require(context["base_image_id"] == ORIGIN and set(context["context_source_sha256"]) == {"boris_toolchain.py", "Dockerfile"}, "retained context")
    for name, digest in context["context_source_sha256"].items():
        require(sha(member(root, name)) == digest, "retained helper pin")
    raw = member(root, "boris_toolchain.py").read_bytes()
    namespace = {"__name__": "boris_prefix_retained_tool", "__file__": str(root/"boris_toolchain.py")}
    exec(compile(raw, namespace["__file__"], "exec"), namespace)
    from types import SimpleNamespace
    return SimpleNamespace(**namespace)


def verify_payload(root):
    for name, digest in PINS.items():
        require(sha(member(root, name)) == digest, "payload pin: " + name)
    tool = verified_tool(root/"toolchain")
    lock, freeze, selected = tool.validate_bundle(root/"toolchain/bundle", ORIGIN)
    wheels, wheel_files = tool.validate_wheels(root/"toolchain/wheel-bundle", ORIGIN)
    manifest = load(root/"source_manifest.json")
    require(set(manifest) == {"schema_version", "upstream_commit", "files", "source_tree_sha256"} and manifest["schema_version"] == "fullmag.boris.image_source.v1" and manifest["upstream_commit"] == "048503d2ca6475e91b073eb1762ecf9d3634c3e1", "source identity")
    rows = manifest["files"]
    require(len(rows) == 1133 and sum(row["size"] for row in rows) == 26427761 and hashlib.sha256(canonical(rows)).hexdigest() == manifest["source_tree_sha256"] == "0d0d924321c6b0d664f3e862a7a73d7c31a1c4c14d2a7f973b6238e2a58161a6", "source tree pin")
    require([r["path"] for r in rows] == sorted(set(r["path"] for r in rows)), "source membership order")
    actual = inventory(root/"source")
    require(not any("link" in r for r in actual), "source links")
    require([{k: r[k] for k in ("path", "size", "sha256")} for r in rows] == actual, "source bytes/membership")
    return tool, lock, freeze, selected, wheels, wheel_files


def copy_payload(target):
    """Run only in the exact retained image under the controller's bounded helper."""
    target = Path(target)
    require(target.is_absolute() and not target.exists() and not target.is_symlink(), "fresh absolute staging required")
    # Build a view before copying; no global/private installed stack is transported.
    source = Path("/opt/fullmag-boris")
    context = Path("/opt/fullmag-boris-toolchain")
    for name, digest in PINS.items():
        original = source/name if not name.startswith("toolchain/") else context/name.removeprefix("toolchain/")
        require(sha(member(original.parent, original.name)) == digest, "retained payload pin")
    tool = verified_tool(context)
    _, freeze, _ = tool.validate_bundle(context/"bundle", ORIGIN)
    _, wheel_files = tool.validate_wheels(context/"wheel-bundle", ORIGIN)
    manifest = load(source/"source_manifest.json")
    require(inventory(source/"source") == [{k: r[k] for k in ("path", "size", "sha256")} for r in manifest["files"]], "retained complete source inventory")
    entries = [(source/"source_manifest.json", "source_manifest.json")]
    entries += [(member(source/"source", r["path"]), "source/"+r["path"]) for r in manifest["files"]]
    names = {"context.json", "boris_toolchain.py", "Dockerfile", "bundle/download-source-freeze.json"}
    names.update("bundle/"+r["path"] for r in freeze["files"])
    names.update("wheel-bundle/"+r["path"] for r in wheel_files)
    entries += [(member(context, name), "toolchain/"+name) for name in sorted(names)]
    require(len(entries) <= MAX_FILES and len(set(name for _, name in entries)) == len(entries), "copy membership")
    require(sum(p.stat().st_size for p, _ in entries) <= MAX_BYTES, "copy byte bound")
    target.mkdir(parents=False)
    for original, name in entries:
        require(original.is_file() and not original.is_symlink(), "copy regular file required")
        destination = member(target, name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with original.open("rb") as incoming, destination.open("xb") as outgoing:
            for block in iter(lambda: incoming.read(1024**2), b""):
                outgoing.write(block)
        destination.chmod(0o644)
        require(sha(destination) == sha(original), "copy drift")
    verify_payload(target)
    rows = inventory(target)
    receipt = dict(schema="fullmag.boris.prefix-payload.v1", retained_asset_image_id=ASSET_IMAGE, files=rows, files_sha256=hashlib.sha256(canonical(rows)).hexdigest(), native_compilation_executed=False, solver_executed=False)
    (target/"payload-receipt.json").write_bytes(canonical(receipt))
    return receipt


def tbb_packages(lock, selected):
    packages = {p["name"]: p for p in selected}
    pending = ["libtbb-dev"]
    closure = set()
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        require(name in packages, "TBB package absent from validated closure")
        closure.add(name)
        for row in lock["dependency_graph"]:
            if row["package"] == name:
                provider = row["selected_provider"]
                if provider["owner"] == "bundle":
                    pending.append(provider["provider"])
                else:
                    require(provider["owner"] == "base", "dependency provider")
    return [packages[name] for name in sorted(closure)]


def deb_data(path, decode_zstd=None):
    """Validate exactly three ar members; decode only the filesystem tar stream."""
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_DEB_BYTES, "deb byte bound/type")
    with path.open("rb") as stream:
        raw = stream.read(MAX_DEB_BYTES + 1)
    require(len(raw) <= MAX_DEB_BYTES, "deb byte bound")
    require(raw.startswith(b"!<arch>\n"), "deb ar signature")
    offset = 8
    members = {}
    while offset < len(raw):
        header = raw[offset:offset+60]
        require(len(header) == 60 and header[58:] == b"`\n", "deb ar header")
        name = header[:16].decode("ascii").strip().rstrip("/")
        require(name not in members and re.fullmatch(r"[a-zA-Z0-9_.-]+", name), "deb ar name")
        size = int(header[48:58])
        require(0 <= size <= len(raw)-offset-60, "deb ar size")
        members[name] = raw[offset+60:offset+60+size]
        if size % 2:
            require(raw[offset+60+size:offset+61+size] == b"\n", "deb ar padding")
        offset += 60+size+(size%2)
    require(offset == len(raw) and members.get("debian-binary") == b"2.0\n", "deb format")
    data = [n for n in members if n in ("data.tar.xz", "data.tar.gz", "data.tar.zst", "data.tar")]
    controls = [n for n in members if n in ("control.tar.xz", "control.tar.gz", "control.tar.zst", "control.tar")]
    require(len(data) == len(controls) == 1
            and list(members) == ["debian-binary", controls[0], data[0]], "deb members")
    if data[0] == "data.tar.zst":
        require(callable(decode_zstd), "zstd data requires the pinned bounded decoder")
        original_sha256 = hashlib.sha256(raw).hexdigest()
        result = decode_zstd(path)
        require(isinstance(result, subprocess.CompletedProcess) and result.returncode == 0
                and isinstance(result.stdout, bytes), "zstd decoder exit/bytes proof")
        require(len(result.stdout) <= MAX_DEB_TAR_BYTES, "decoded tar byte bound")
        require(sha(path) == original_sha256, "deb changed during decode")
        return result.stdout
    return members[data[0]]


def unpack_debs(paths, target, decode_zstd=None):
    require(not target.exists(), "fresh SDK required")
    target.mkdir()
    seen = set()
    links = []
    total = 0
    count = 0
    for path in paths:
        with tarfile.open(fileobj=io.BytesIO(deb_data(path, decode_zstd)), mode="r:*") as archive:
            for entry in archive:
                count += 1
                require(count <= MAX_FILES and entry.size >= 0, "deb member count/size bound")
                name = entry.name.removeprefix("./").rstrip("/")
                if not name and entry.isdir():
                    continue
                destination = member(target, name)
                require(entry.isdir() or entry.isfile() or entry.issym(), "deb special/hardlink member")
                require(not entry.mode & 0o7000, "deb privileged mode")
                if entry.isdir():
                    require(name not in seen, "deb directory/file collision")
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                require(name not in seen and not destination.exists(), "deb file collision")
                seen.add(name)
                total += entry.size
                require(len(seen) <= MAX_FILES and total <= 256*1024**2, "deb expansion bound")
                destination.parent.mkdir(parents=True, exist_ok=True)
                if entry.issym():
                    link = PurePosixPath(entry.linkname)
                    require(not link.is_absolute() and "\\" not in entry.linkname and ":" not in entry.linkname, "deb absolute/unsafe link")
                    require((destination.parent/entry.linkname).resolve().is_relative_to(target.resolve()), "deb link escape")
                    links.append((destination, entry.linkname))
                else:
                    stream = archive.extractfile(entry)
                    require(stream is not None, "deb data missing")
                    with destination.open("xb") as output:
                        for block in iter(lambda: stream.read(1024**2), b""):
                            output.write(block)
                    require(destination.stat().st_size == entry.size, "deb truncated member")
                    destination.chmod(0o755 if entry.mode & 0o111 else 0o644)
    for destination, link in links:
        require(not destination.exists() and not destination.is_symlink(), "deb link collision")
        destination.symlink_to(link)
    return inventory(target)


def unpack_wheels(tool, context, target, wheels):
    require(not target.exists(), "fresh Python prefix required")
    tool.wheel_members(context/"wheel-bundle", wheels["packages"])
    target.mkdir()
    for package in wheels["packages"]:
        with zipfile.ZipFile(tool.member(context/"wheel-bundle", "wheels/"+package["filename"])) as archive:
            for entry in archive.infolist():
                destination = member(target, entry.filename.rstrip("/"))
                if entry.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as incoming, destination.open("xb") as outgoing:
                        for block in iter(lambda: incoming.read(1024**2), b""):
                            outgoing.write(block)
                    destination.chmod(0o644)
    return inventory(target)


def baseline_code():
    return """import hashlib,json,struct,sys,sysconfig
from pathlib import Path
if sys.argv[1]:sys.path.insert(0,sys.argv[1])
import numpy
exe=Path(sys.executable).resolve(); module=Path(numpy.__file__).resolve()
print(json.dumps(dict(python=dict(version=sys.version,executable=str(exe),sha256=hashlib.sha256(exe.read_bytes()).hexdigest(),cache_tag=sys.implementation.cache_tag,soabi=sysconfig.get_config_var('SOABI'),ext_suffix=sysconfig.get_config_var('EXT_SUFFIX'),pointer_bits=struct.calcsize('P')*8),numpy=dict(version=numpy.__version__,path=str(module),sha256=hashlib.sha256(module.read_bytes()).hexdigest()))))
"""


def require_baseline(before, after):
    require(before == after, "current Python ABI / NumPy baseline drift")


def elf_metadata(text):
    require("ELF64" in text and "Advanced Micro Devices X86-64" in text, "ELF architecture")
    needed = re.findall(r"\(NEEDED\).*?\[([^\]]+)\]", text)
    soname = re.findall(r"\(SONAME\).*?\[([^\]]+)\]", text)
    require(len(soname) == 1 and all(re.fullmatch(r"[a-zA-Z0-9_.+-]+", n) for n in needed+soname), "ELF SONAME/NEEDED")
    require(not re.search(r"\((?:RPATH|RUNPATH)\)", text), "unexpected ELF search path")
    return dict(soname=soname[0], needed=sorted(needed))


def version_requirements(text):
    result = {}
    section = None
    provider = None
    for line in text.splitlines():
        if line.startswith("Version "):
            section = "needs" if line.startswith("Version needs section") else None
        if section == "needs":
            match = re.search(r"File: (\S+)", line)
            if match:
                provider = match.group(1)
                result.setdefault(provider, set())
            match = re.search(r"Name: (\S+)", line)
            if match:
                require(provider is not None, "version provider missing")
                result[provider].add(match.group(1))
    return result


def version_definitions(text):
    result = set()
    active = False
    for line in text.splitlines():
        if line.startswith("Version "):
            active = line.startswith("Version definition section")
        if active:
            match = re.search(r"Name: (\S+)", line)
            if match:
                result.add(match.group(1))
    return result


def prepare_prefix(prefix, run_probe, *, artifacts, environment):
    """Future execution only in the admitted existing backend, before native build."""
    import sys
    prefix, artifacts = Path(prefix), Path(artifacts)
    require(prefix.is_absolute() and prefix.resolve() == prefix and prefix.is_dir(), "canonical prefix required")
    require(artifacts.is_absolute() and artifacts.resolve() == artifacts and artifacts.is_dir() and not artifacts.is_relative_to(prefix), "canonical artifacts outside prefix required")
    payload_hash = sha(prefix/"payload-receipt.json")
    payload = load(prefix/"payload-receipt.json")
    require(payload["schema"] == "fullmag.boris.prefix-payload.v1" and payload["retained_asset_image_id"] == ASSET_IMAGE, "payload receipt")
    rows = [r for r in inventory(prefix) if r["path"] != "payload-receipt.json"]
    require(rows == payload["files"] and hashlib.sha256(canonical(rows)).hexdigest() == payload["files_sha256"], "payload inventory drift")
    tool, lock, _, selected, wheels, _ = verify_payload(prefix)
    child = dict(environment, PYTHONDONTWRITEBYTECODE="1", MPLBACKEND="Agg", MPLCONFIGDIR=str(artifacts/"matplotlib"))
    child.pop("PYTHONPATH", None)
    child.pop("LD_LIBRARY_PATH", None)
    child.pop("LD_PRELOAD", None)
    child.pop("LD_AUDIT", None)
    child.pop("PYTHONHOME", None)
    def probe(command, timeout=30, env=None):
        outcome = run_probe(command, workspace=prefix, artifacts=artifacts, environment=child if env is None else env, timeout=timeout, text=True, check=True)
        return outcome.stdout
    baseline = json.loads(probe([sys.executable, "-B", "-c", baseline_code(), ""]))
    require(baseline["python"]["version"].split()[0] == "3.10.12" and baseline["python"]["pointer_bits"] == 64 and baseline["numpy"]["version"] == "2.2.6", "baseline version/ABI")
    current = {name: sha(Path(name)) for name in CURRENT_LIBRARIES}
    require(current == CURRENT_LIBRARIES, "current FFTW/X11 bytes differ")
    sdk_before = sha(Path("/opt/fullmag-deps/share/fullmag/dependency-versions.json"))
    packages = tbb_packages(lock, selected)
    decoder_pins = {name: sha(Path(name)) for name in DEB_DECODER_PINS}
    require(decoder_pins == DEB_DECODER_PINS, "deb decoder binary/library differs")
    def decode_zstd(path):
        # stdout is binary tar, counted by the existing shared 64 MiB stage
        # writer. No extraction flags, installation or maintainer scripts.
        return run_probe(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(path)],
            workspace=prefix, artifacts=artifacts, environment=child,
            timeout=30, text=False, check=True)
    sdk_rows = unpack_debs([tool.member(prefix/"toolchain/bundle", p["filename"]) for p in packages],
                           prefix/"sdk", decode_zstd)
    require({name: sha(Path(name)) for name in DEB_DECODER_PINS} == decoder_pins, "deb decoder drift")
    python_rows = unpack_wheels(tool, prefix/"toolchain", prefix/"python", wheels)
    lib = prefix/"sdk/usr/lib/x86_64-linux-gnu"
    include = prefix/"sdk/usr/include"
    require((lib/"libtbb.so").is_file() and (include/"oneapi/tbb.h").is_file(), "TBB SDK layout")
    private_env = dict(child, PYTHONPATH=str(prefix/"python"), LD_LIBRARY_PATH=str(lib))
    require_baseline(baseline, json.loads(probe([sys.executable, "-B", "-c", baseline_code(), str(prefix/"python")], env=private_env)))
    includes = probe(["python3-config", "--includes"]).split()
    require(any(p.startswith("-I") and (Path(p[2:])/"Python.h").is_file() for p in includes), "Python.h missing")
    embed = probe(["python3-config", "--embed", "--ldflags"]).split()
    require("-lpython3.10" in embed and any(p.startswith("-L") and (Path(p[2:])/"libpython3.10.so").is_file() for p in embed), "Python embed library missing")
    programs = {name: probe([name, "--version"]) for name in ("g++", "readelf")}
    for name, expected in (("libfftw3.so", next(iter(CURRENT_LIBRARIES))), ("libX11.so", list(CURRENT_LIBRARIES)[1])):
        linked = Path(probe(["g++", "-print-file-name="+name]).strip())
        require(linked.is_file() and sha(linked) == CURRENT_LIBRARIES[expected], "current linker identity")
    imports_code = """import importlib,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]); expected=json.loads(sys.argv[2]); rows=[]
for item in expected:
 module=importlib.import_module(item['name']); version=getattr(module,'__version__',getattr(module,'version',None)); path=Path(module.__file__).resolve()
 if version!=item['version'] or not path.is_relative_to(Path(sys.argv[1])):raise ValueError('private module identity')
 rows.append(dict(name=item['name'],version=version,path=str(path)))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
figure,axes=plt.subplots(); axes.plot([0,1],[0,1]); target=Path(sys.argv[3]); figure.savefig(target); plt.close(figure)
if not target.read_bytes().startswith(b'\\x89PNG\\r\\n\\x1a\\n'):raise ValueError('Agg PNG signature')
print(json.dumps(rows))
"""
    expected = tool.load(prefix/"toolchain/wheel-bundle/preflight-receipt.json")["modules"]
    plot = artifacts/"prefix-preflight.png"
    modules = json.loads(probe([sys.executable, "-B", "-c", imports_code, str(prefix/"python"), json.dumps(expected), str(plot)], 120, private_env))
    # Loader resolution and version requirements are checked for every private ELF.
    closure = {}
    private_elf = [p for p in (prefix/"sdk").rglob("*") if p.is_file() and not p.is_symlink() and p.open("rb").read(4) == b"\x7fELF"]
    require(1 <= len(private_elf) <= 64, "private ELF closure count bound")
    metadata_by_path = {path: elf_metadata(probe(["readelf", "-h", "-d", str(path)])) for path in private_elf}
    sonames = {metadata["soname"]: path for path, metadata in metadata_by_path.items()}
    require(len(sonames) == len(private_elf), "private SONAME collision")
    for path, metadata in metadata_by_path.items():
        listing = probe(["/lib64/ld-linux-x86-64.so.2", "--library-path", str(lib), "--list", str(path)], env=private_env)
        require("not found" not in listing, "unresolved ELF dependency")
        resolved = dict(re.findall(r"^\s*(\S+) => (/\S+) \(0x[0-9a-f]+\)", listing, re.M))
        for loader in re.findall(r"^\s*(/\S+) \(0x[0-9a-f]+\)", listing, re.M):
            resolved[Path(loader).name] = loader
        for name in set(resolved).intersection(sonames):
            require(Path(resolved[name]).resolve() == sonames[name].resolve(), "private ELF resolved outside pinned SDK")
        for needed in metadata["needed"]:
            require(needed in resolved, "missing loader provider: " + needed)
        versions = version_requirements(probe(["readelf", "--version-info", str(path)]))
        providers = {}
        for name, provider in resolved.items():
            real = Path(provider).resolve()
            require(real.is_file() and (real.is_relative_to(prefix/"sdk") or real.is_relative_to(Path("/usr/lib")) or real.is_relative_to(Path("/lib")) or real.is_relative_to(Path("/usr/local/lib"))), "loader provider outside allowed roots")
            if name in versions:
                definitions = version_definitions(probe(["readelf", "--version-info", str(real)]))
                require(versions[name].issubset(definitions), "required ELF symbol versions unavailable")
            providers[name] = dict(path=str(real), sha256=sha(real))
        require(set(versions).issubset(resolved), "version provider unresolved")
        closure[path.relative_to(prefix).as_posix()] = dict(**metadata, sha256=sha(path), providers=providers, required_versions={k: sorted(v) for k,v in versions.items()})
    require(any(v["soname"].startswith("libtbb.so.") for v in closure.values()), "TBB runtime missing")
    require_baseline(baseline, json.loads(probe([sys.executable, "-B", "-c", baseline_code(), str(prefix/"python")], env=private_env)))
    require({name: sha(Path(name)) for name in CURRENT_LIBRARIES} == current and sha(Path("/opt/fullmag-deps/share/fullmag/dependency-versions.json")) == sdk_before, "current SDK/library drift")
    verify_payload(prefix)
    require(sha(prefix/"payload-receipt.json") == payload_hash, "payload receipt drift")
    require(inventory(prefix/"sdk") == sdk_rows and inventory(prefix/"python") == python_rows, "private prefix drift")
    require({name: sha(Path(name)) for name in DEB_DECODER_PINS} == decoder_pins, "deb decoder drift")
    rows = inventory(prefix)
    receipt = dict(schema="fullmag.boris.private-prefix.v1", status="DEPENDENCY_PREFLIGHT_ONLY", source_root=str(prefix/"source"), source_manifest=str(prefix/"source_manifest.json"), sdk_include_dir=str(include), sdk_library_dir=str(lib), python_prefix=str(prefix/"python"), retained_asset_image_id=ASSET_IMAGE, payload_receipt_sha256=payload_hash, supplier_sha256=sha(Path(__file__)), files=rows, files_sha256=hashlib.sha256(canonical(rows)).hexdigest(), current_baseline=baseline, current_libraries=current, deb_decoder=dict(command=["/usr/bin/dpkg-deb", "--fsys-tarfile"], files=decoder_pins, decoded_tar_byte_limit=MAX_DEB_TAR_BYTES, stage_shared_log_byte_limit=64*1024**2), fullmag_sdk_manifest_sha256=sdk_before, packages=[dict(name=p["name"], version=p["version"], sha256=p["sha256"]) for p in packages], tbb_elf_closure=closure, modules=modules, python_includes=includes, python_embed_flags=embed, programs=programs, plot_sha256=sha(plot), native_compilation_executed=False, boris_runtime_executed=False, benchmark_executed=False, physics_qualified=False)
    (prefix/"receipt.json").write_bytes(canonical(receipt))
    return receipt
