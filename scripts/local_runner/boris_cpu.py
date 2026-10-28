"""Fixed BORIS CPU build contract; no caller-selected commands or source mounts."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import uuid
import datetime

PROFILE = "boris-cpu-v1"
PIN = "048503d2ca6475e91b073eb1762ecf9d3634c3e1"
SOURCE_ROOT = Path("/opt/fullmag-boris/source")
SOURCE_MANIFEST = Path("/opt/fullmag-boris/source_manifest.json")
MAX_SOURCE_BYTES = 256 * 1024 * 1024
MAX_FILES = 20000
OUTPUTS = ("BorisLin", "source_manifest.json", "compile_flags.h", "cuda_flags.h",
           "cpu_abi_witness.cpp", "cpu_abi_witness", "cpu_abi_witness.json")
REQUIRED_STAGES = ("boris-cpu-link", "boris-binary-inspect",
                   "boris-cpu-abi-compile", "boris-cpu-abi-link", "boris-cpu-abi-observe")


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def digest(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("BORIS member is not a regular file")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_member(root, name):
    if not isinstance(name, str) or not name or "\\" in name or "\0" in name or ":" in name:
        raise ValueError("invalid BORIS source path")
    parts = PurePosixPath(name)
    if parts.is_absolute() or any(p in ("", ".", "..") for p in name.split("/")):
        raise ValueError("escaping BORIS source path")
    path = root.joinpath(*parts.parts)
    if any(p.is_symlink() for p in (path, *path.parents) if p != root.parent):
        raise ValueError("BORIS source symlink")
    return path


def verify_source(root, manifest):
    if set(manifest) != {"schema_version", "upstream_commit", "files", "source_tree_sha256"}:
        raise ValueError("invalid BORIS source manifest fields")
    files = manifest["files"]
    if manifest["schema_version"] != "fullmag.boris.image_source.v1" or manifest["upstream_commit"] != PIN:
        raise ValueError("BORIS upstream pin mismatch")
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("BORIS source count exceeds bound")
    if hashlib.sha256(canonical(files)).hexdigest() != manifest["source_tree_sha256"]:
        raise ValueError("BORIS source tree identity mismatch")
    total = 0
    names = []
    for entry in files:
        if set(entry) != {"path", "size", "sha256", "mode"} or type(entry["size"]) is not int or entry["size"] < 0:
            raise ValueError("invalid BORIS source entry")
        if entry["mode"] not in ("100644", "100755"):
            raise ValueError("unsupported BORIS source mode")
        path = safe_member(root, entry["path"])
        names.append(entry["path"])
        total += entry["size"]
        if total > MAX_SOURCE_BYTES or path.stat().st_size != entry["size"] or digest(path) != entry["sha256"]:
            raise ValueError("BORIS source byte identity mismatch or bound exceeded")
    if names != sorted(set(names)):
        raise ValueError("BORIS source order/uniqueness mismatch")
    actual = []
    for base, directories, files_here in os.walk(root, followlinks=False):
        if any((Path(base)/n).is_symlink() for n in directories):
            raise ValueError("BORIS source directory symlink")
        actual.extend((Path(base)/n).relative_to(root).as_posix() for n in files_here)
    if sorted(actual) != names:
        raise ValueError("BORIS source membership mismatch")
    return manifest


def overlay_flags(raw, name, expected, replacement):
    pattern = rb"(?m)^#define[ \t]+" + name.encode() + rb"[ \t]+" + str(expected).encode() + rb"[ \t]*\r?$"
    changed, count = re.subn(pattern, ("#define " + name + " " + str(replacement)).encode(), raw)
    if count != 1:
        raise ValueError("BORIS CPU overlay flag drift: " + name)
    return changed


def cuda_toolchain_argument(value):
    # BorisCUDALib contains shared source headers; guarded CUDA.cpp translation
    # units also exist in CPU builds. Reject toolchain/libs, not source names.
    text=value.lower().replace("\\","/")
    return (Path(text).name == "nvcc" or "/cuda/" in text or "/cuda-" in text
            or any(text.startswith("-l"+name) for name in ("cuda","cufft","nvidia","nvml")))


def compile_commands(cpp_names, *, compiler, includes, objects):
    commands = []
    for ordinal, name in enumerate(cpp_names):
        if re.fullmatch(r"Boris/[A-Za-z0-9_]+\.cpp", name) is None:
            raise ValueError("unexpected BORIS C++ source name")
        commands.append([compiler, "-c", "-Ofast", "-std=c++17", "-IBorisLib", "-IBorisCUDALib",
                         "-fopenmp", *includes, name, "-o", str(objects/f"{ordinal:05d}.o")])
    return commands


def load_manifest(path):
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 1024*1024:
        raise ValueError("BORIS image source manifest exceeds bound")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate BORIS manifest key")
            value[key] = item
        return value
    return json.loads(path.read_bytes().decode("utf-8"), object_pairs_hook=unique)



TYPE_SOURCE_SHA256 = {
    "Boris/MeshBase.h": "dae9c79545f49b1704038a9152f331a4c5addb7b43a60a613710928440a36636",
    "BorisLib/Types_VAL.h": "1602c65945d070272f47b0aacfddb754523b12deb64bf6c71fb9097859cd5bfe",
}
ABI_FACTS = {"char_bit": 8, "double_bytes": 8, "radix": 2, "digits": 53, "max_exponent": 1024}
ABI_SOURCE = r'''#include <climits>
#include <iostream>
#include <limits>
#include <type_traits>
#include <utility>
#include "MeshBase.h"
template<class T> using Scalar = std::remove_cv_t<std::remove_reference_t<T>>;
static_assert(std::is_same_v<Scalar<decltype(std::declval<MeshBase>().V[0])>, double>);
static_assert(std::is_same_v<Scalar<decltype(std::declval<MeshBase>().E[0].x)>, double>);
static_assert(std::is_same_v<Scalar<decltype(std::declval<MeshBase>().S[0].x)>, double>);
static_assert(std::is_same_v<Scalar<decltype(std::declval<DBL3>().x)>, double>);
static_assert(CHAR_BIT == 8 && sizeof(double) == 8);
static_assert(std::numeric_limits<double>::radix == 2);
static_assert(std::numeric_limits<double>::digits == 53);
static_assert(std::numeric_limits<double>::max_exponent == 1024);
int main() {
    std::cout << "{\"char_bit\":" << CHAR_BIT
              << ",\"double_bytes\":" << sizeof(double)
              << ",\"radix\":" << std::numeric_limits<double>::radix
              << ",\"digits\":" << std::numeric_limits<double>::digits
              << ",\"max_exponent\":" << std::numeric_limits<double>::max_exponent << "}\n";
}
'''.encode("utf-8")


def abi_observation(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= 4096:
        raise ValueError("BORIS ABI observation exceeds bound")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate BORIS ABI fact")
            result[key] = value
        return result
    facts = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    if not isinstance(facts, dict) or facts != ABI_FACTS or any(type(v) is not int for v in facts.values()):
        raise ValueError("BORIS CPU ABI is not binary64")
    return facts



def read_abi_log(path):
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 4096:
        raise ValueError("BORIS ABI observation exceeds bound")
    with path.open("rb") as stream:
        return abi_observation(stream.read(4097))


def abi_binding(receipt, cpu_hash, cuda_hash, facts):
    return dict(schema_version="fullmag.boris.cpu_abi.v1", job_id=receipt["job_id"],
                capsule_digest=receipt["source_digest"], image_digest=receipt["image_digest"],
                compile_flags_sha256=cpu_hash, cuda_flags_sha256=cuda_hash,
                type_source_sha256=TYPE_SOURCE_SHA256, facts=facts)


def run_build(workspace, artifacts, receipt, run_stage, *, run_probe=None, reference_root=None):
    """Called only from the operator-pinned trusted entrypoint for PROFILE."""
    source_root = SOURCE_ROOT if reference_root is None else Path(reference_root)/"source"
    source_manifest = SOURCE_MANIFEST if reference_root is None else Path(reference_root)/"source_manifest.json"
    manifest = verify_source(source_root, load_manifest(source_manifest))
    for name, expected in TYPE_SOURCE_SHA256.items():
        if digest(source_root/name) != expected:
            raise ValueError("BORIS CPU type source drift")
    source = workspace/"boris-cpu-source"
    shutil.copytree(source_root, source, copy_function=shutil.copyfile)
    old_cpu = (source/"Boris/CompileFlags.h").read_bytes()
    cpu = overlay_flags(old_cpu, "COMPILECUDA", 1, 0)
    # Keep embedding for the existing public BORIS smoke scripts.
    for name, value in (("GRAPHICS",0),("PYTHON_EMBEDDING",1)):
        overlay_flags(cpu, name, value, value)
    old_cuda = (source/"BorisCUDALib/cuBLib_Flags.h").read_bytes()
    cuda = overlay_flags(old_cuda, "SINGLEPRECISION", 1, 0)
    cuda = overlay_flags(cuda, "COMPILE_NVML_CODE", 0, 0)
    (source/"Boris/CompileFlags.h").write_bytes(cpu)
    (source/"BorisCUDALib/cuBLib_Flags.h").write_bytes(cuda)
    compiler = shutil.which("g++")
    config = shutil.which("python3-config")
    inspector = shutil.which("readelf")
    if not compiler or not config or not inspector:
        raise ValueError("BORIS CPU requires installed g++, Python embed dev and readelf in pinned image")
    def probe_output(command):
        if run_probe is None:
            return subprocess.check_output(command, timeout=30)
        return run_probe(command, workspace=source, artifacts=artifacts,
                         environment=dict(os.environ), timeout=30, check=True).stdout
    def flags(option):
        result = (subprocess.run([config, *option], capture_output=True, text=True, check=True, timeout=30)
                  if run_probe is None else run_probe([config, *option], workspace=source, artifacts=artifacts,
                      environment=dict(os.environ), timeout=30, text=True, check=True))
        values = result.stdout.split()
        if any(cuda_toolchain_argument(value) for value in values):
            raise ValueError("BORIS Python toolchain unexpectedly includes CUDA")
        return values
    objects = workspace/"boris-cpu-objects"
    objects.mkdir()
    cpp = [e["path"] for e in manifest["files"] if re.fullmatch(r"Boris/[A-Za-z0-9_]+\.cpp",e["path"])]
    if not cpp:
        raise ValueError("BORIS C++ source list empty")
    includes=flags(["--includes"])
    private_library = None
    if reference_root is not None:
        reference_root = Path(reference_root)
        private_include = reference_root/"sdk/usr/include"
        private_library = reference_root/"sdk/usr/lib/x86_64-linux-gnu"
        if (not private_include.is_dir() or not private_library.is_dir()
                or not (private_library/"libtbb.so").is_file()):
            raise ValueError("BORIS admitted private dependency prefix is incomplete")
        includes = ["-I"+str(private_include), *includes]
    if not any(arg.startswith("-I") and (Path(arg[2:])/"Python.h").is_file() for arg in includes):
        raise ValueError("BORIS pinned image lacks Python development headers")
    for library in ("libfftw3.so","libX11.so","libtbb.so"):
        observed=probe_output([compiler,"-print-file-name="+library]).decode().strip()
        installed=str(private_library/library) if private_library is not None and library=="libtbb.so" else observed
        if installed==library or not Path(installed).is_file():
            raise ValueError("BORIS pinned image lacks installed development library: "+library)
    commands = compile_commands(cpp, compiler=compiler, includes=includes, objects=objects)
    receipt["toolchain"] = {"g++": probe_output([compiler,"--version"]).decode("utf-8")[:4096],
                            "python": probe_output(["python3","--version"]).decode("utf-8")[:4096],
                            "python_config":config,"readelf":inspector}
    environment = dict(os.environ)
    # Compiler/library search is image-owned, never inherited from job overrides.
    for name in ("CPATH","CPLUS_INCLUDE_PATH","LIBRARY_PATH","LD_PRELOAD"):
        environment.pop(name,None)
    if reference_root is not None:
        environment["LD_LIBRARY_PATH"] = str(private_library)+(os.pathsep+environment["LD_LIBRARY_PATH"] if environment.get("LD_LIBRARY_PATH") else "")
        environment["PYTHONPATH"] = str(reference_root/"python")
    def stage(name, command):
        record = run_stage(name,command,workspace=source,artifacts=artifacts,environment=environment)
        receipt["stages"].append(record)
        if record["exit_code"] != 0:
            raise ValueError("BORIS managed stage failed: " + name)
    for ordinal, command in enumerate(commands):
        stage(f"boris-cpu-compile-{ordinal:05d}", command)
    link_flags = ["-fopenmp", *flags(["--embed","--ldflags"]), "-ltbb", "-lfftw3", "-lX11"]
    if private_library is not None:
        link_flags.insert(0,"-L"+str(private_library))
    witness_source = source/"Boris/FullmagCpuAbiWitness.cpp"
    witness_source.write_bytes(ABI_SOURCE)
    witness_compile = compile_commands(["Boris/FullmagCpuAbiWitness.cpp"], compiler=compiler,
                                       includes=includes, objects=objects/"abi")[0]
    (objects/"abi").mkdir()
    witness_binary = source/"cpu_abi_witness"
    stage("boris-cpu-abi-compile", witness_compile)
    stage("boris-cpu-abi-link", [compiler, witness_compile[-1], *link_flags, "-o", str(witness_binary)])
    if not 0 < witness_binary.stat().st_size <= 16*1024*1024:
        raise ValueError("BORIS ABI executable exceeds bound")
    stage("boris-cpu-abi-observe", [str(witness_binary)])
    facts = read_abi_log(artifacts/"logs/boris-cpu-abi-observe.stdout.log")
    binary = source/"BorisLin"
    stage("boris-cpu-link", [compiler,*[c[-1] for c in commands],*link_flags,"-o",str(binary)])
    stage("boris-binary-inspect", [inspector,"-d",str(binary)])
    dynamic = (artifacts/"logs"/"boris-binary-inspect.stdout.log").read_text(encoding="utf-8")
    if re.search(r"NEEDED.*(?:cuda|cufft|nvidia|nvml)",dynamic,re.I):
        raise ValueError("BORIS CPU binary depends on CUDA/NVML")
    destination = artifacts/"outputs"/"boris"
    destination.mkdir(parents=True)
    shutil.copyfile(binary,destination/"BorisLin")
    (destination/"BorisLin").chmod(0o755)
    (destination/"compile_flags.h").write_bytes(cpu)
    (destination/"cuda_flags.h").write_bytes(cuda)
    (destination/"cpu_abi_witness.cpp").write_bytes(ABI_SOURCE)
    shutil.copyfile(witness_binary,destination/"cpu_abi_witness")
    (destination/"cpu_abi_witness").chmod(0o755)
    observed = abi_binding(receipt,digest(destination/"compile_flags.h"),digest(destination/"cuda_flags.h"),facts)
    (destination/"cpu_abi_witness.json").write_bytes(canonical(observed))
    proof = {"schema_version":"fullmag.boris.source.v2","upstream_commit":PIN,
             "original_source":manifest,"binary_sha256":digest(destination/"BorisLin"),
             "compile_flags_sha256":digest(destination/"compile_flags.h"),
             "cuda_flags_sha256":digest(destination/"cuda_flags.h"),
             "overlay_original_sha256":[hashlib.sha256(old_cpu).hexdigest(),hashlib.sha256(old_cuda).hexdigest()],
             "profile":PROFILE,"job_id":receipt["job_id"],"capsule_digest":receipt["source_digest"],
             "image_digest":receipt["image_digest"],"compile_source_count":len(cpp),
             "precision_claim":"cpu_double_requires_runtime_verification","qualification":"NOT VERIFIED",
             "cpu_abi_sha256":{name:digest(destination/name) for name in OUTPUTS if name.startswith("cpu_abi_")}}
    (destination/"source_manifest.json").write_bytes(canonical(proof))
    receipt["boris_build_proof"] = proof


def validate_outputs(artifacts, receipt):
    """Coordinator-side binding; ordinary Fullmag receipt admission is untouched."""
    root = artifacts/"outputs"/"boris"
    value = load_manifest(root/"source_manifest.json")
    if value != receipt.get("boris_build_proof") or value.get("schema_version") != "fullmag.boris.source.v2":
        raise ValueError("BORIS source receipt mismatch")
    for name, expected in (("upstream_commit",PIN),("profile",PROFILE),("qualification","NOT VERIFIED")):
        if value.get(name) != expected:
            raise ValueError("BORIS receipt pin mismatch")
    for key in ("job_id","image_digest"):
        if value.get(key) != receipt.get(key):
            raise ValueError("BORIS receipt owner mismatch")
    if value.get("capsule_digest") != receipt.get("source_digest"):
        raise ValueError("BORIS capsule mismatch")
    for filename, key in (("BorisLin","binary_sha256"),("compile_flags.h","compile_flags_sha256"),("cuda_flags.h","cuda_flags_sha256")):
        if digest(root/filename) != value.get(key):
            raise ValueError("BORIS output hash mismatch")
    cpu=(root/"compile_flags.h").read_bytes();cuda=(root/"cuda_flags.h").read_bytes()
    for name in ("COMPILECUDA","GRAPHICS"):
        overlay_flags(cpu,name,0,0)
    overlay_flags(cpu,"PYTHON_EMBEDDING",1,1)
    for name in ("SINGLEPRECISION","COMPILE_NVML_CODE"):
        overlay_flags(cuda,name,0,0)
    original=value.get("original_source")
    if not isinstance(original,dict) or original.get("schema_version")!="fullmag.boris.image_source.v1" or original.get("upstream_commit")!=PIN:
        raise ValueError("BORIS original source identity absent")
    files=original.get("files")
    if not isinstance(files,list) or not 1<=len(files)<=MAX_FILES or hashlib.sha256(canonical(files)).hexdigest()!=original.get("source_tree_sha256"):
        raise ValueError("BORIS original source manifest mismatch")
    names=[e.get("path") for e in files]
    if any(not isinstance(name,str) for name in names) or names!=sorted(set(names)):
        raise ValueError("BORIS original source order mismatch")
    cpp=[name for name in names if re.fullmatch(r"Boris/[A-Za-z0-9_]+\.cpp",name)]
    count=value.get("compile_source_count")
    if type(count) is not int or not 1 <= count <= MAX_FILES:
        raise ValueError("BORIS compile source count invalid")
    if count!=len(cpp):
        raise ValueError("BORIS compile count does not match pinned source")
    required = [*REQUIRED_STAGES,*[f"boris-cpu-compile-{i:05d}" for i in range(count)]]
    stages=receipt.get("stages",[])
    if any(sum(s.get("name")==name and s.get("exit_code")==0 for s in stages)!=1 for name in required):
        raise ValueError("BORIS required stages missing/duplicated")
    for ordinal,name in enumerate(cpp):
        record=next(s for s in stages if s.get("name")==f"boris-cpu-compile-{ordinal:05d}")
        command=record.get("command",[])
        if name not in command or "-Ofast" not in command or "-std=c++17" not in command or "-fopenmp" not in command:
            raise ValueError("BORIS compile command/source mismatch")
        if any(cuda_toolchain_argument(arg) for arg in command):
            raise ValueError("BORIS CPU command contains CUDA")
    validate_abi_outputs(root, artifacts, receipt, value, cpp)
    dynamic=(artifacts/"logs"/"boris-binary-inspect.stdout.log").read_text(encoding="utf-8")
    if re.search(r"NEEDED.*(?:cuda|cufft|nvidia|nvml)",dynamic,re.I):
        raise ValueError("BORIS output depends on CUDA/NVML")



def validate_abi_outputs(root, artifacts, receipt, proof, cpp):
    for name, bound in (("cpu_abi_witness.cpp",8192),("cpu_abi_witness",16*1024*1024),("cpu_abi_witness.json",4096)):
        path = root/name
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= bound:
            raise ValueError("BORIS ABI artifact exceeds bound")
        if digest(path) != proof.get("cpu_abi_sha256",{}).get(name):
            raise ValueError("BORIS ABI artifact hash mismatch")
    if (root/"cpu_abi_witness.cpp").read_bytes() != ABI_SOURCE:
        raise ValueError("BORIS ABI witness source mismatch")
    observed = load_manifest(root/"cpu_abi_witness.json")
    facts = read_abi_log(artifacts/"logs/boris-cpu-abi-observe.stdout.log")
    if observed != abi_binding(receipt,proof["compile_flags_sha256"],proof["cuda_flags_sha256"],facts):
        raise ValueError("BORIS ABI observation owner/flags mismatch")
    sources = {entry["path"]:entry["sha256"] for entry in proof["original_source"]["files"]}
    if any(sources.get(name) != expected for name,expected in TYPE_SOURCE_SHA256.items()):
        raise ValueError("BORIS ABI type source pin mismatch")
    stages = receipt["stages"]
    def command(name):
        matches=[s for s in stages if s.get("name")==name]
        if len(matches)!=1 or matches[0].get("exit_code")!=0:
            raise ValueError("BORIS ABI stage missing or duplicated")
        result=matches[0].get("command")
        if not isinstance(result,list) or not result or any(not isinstance(v,str) for v in result):
            raise ValueError("BORIS ABI command invalid")
        return result
    witness = command("boris-cpu-abi-compile")
    if len(witness)<4 or witness[-3:-1] != ["Boris/FullmagCpuAbiWitness.cpp","-o"]:
        raise ValueError("BORIS ABI compile source mismatch")
    for ordinal,name in enumerate(cpp):
        actual=command(f"boris-cpu-compile-{ordinal:05d}")
        if actual[-3:-1] != [name,"-o"] or actual[:-3] != witness[:-3]:
            raise ValueError("BORIS ABI compiler/flags differ from solver")
    solver_link=command("boris-cpu-link")
    abi_link=command("boris-cpu-abi-link")
    if (len(solver_link)<len(cpp)+4 or solver_link[0]!=witness[0] or solver_link[-2]!="-o" or len(abi_link)<4
            or abi_link[:2]!=[witness[0],witness[-1]] or abi_link[-2]!="-o"
            or solver_link[len(cpp)+1:-2] != abi_link[2:-2]
            or command("boris-cpu-abi-observe") != [abi_link[-1]]):
        raise ValueError("BORIS ABI linker/run differ from solver")


def image_inspect(image):
    value = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", image], timeout=30))
    if len(value) != 1 or value[0].get("Id") != image or not value[0].get("RootFS", {}).get("Layers"):
        raise ValueError("installed immutable toolchain image mismatch")
    return {key: value[0][key] for key in ("Id", "RootFS", "Config", "Architecture", "Os")}


def validate_context(context):
    value = load_manifest(safe_member(context, "source_context.json"))
    if value.get("schema") != "fullmag.boris.source-context.v1" or value.get("upstream_commit") != PIN:
        raise ValueError("BORIS source context identity mismatch")
    files = value.get("files", [])
    names = [e["path"] for e in files]
    if names != sorted(set(names)) or not 1 <= len(files) <= MAX_FILES+10 or sum(e["size"] for e in files) > MAX_SOURCE_BYTES+2*1024**2:
        raise ValueError("BORIS context membership bound")
    for entry in files:
        path = safe_member(context, entry["path"])
        if path.stat().st_size != entry["size"] or digest(path) != entry["sha256"]:
            raise ValueError("BORIS image context byte drift")
    actual = []
    for base, directories, members in os.walk(context, followlinks=False):
        if any((Path(base)/name).is_symlink() for name in directories):
            raise ValueError("BORIS context directory symlink")
        actual.extend((Path(base)/name).relative_to(context).as_posix() for name in members)
    if sorted(actual) != sorted([*names, "source_context.json"]):
        raise ValueError("BORIS context unexpected member")
    verify_source(context/"source", load_manifest(context/"source_manifest.json"))
    proof = load_manifest(context/"toolchain_proof.json")
    if proof.get("qualification") != "TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED" or not proof.get("gxx") or not proof.get("readelf") or not proof.get("linker_paths"):
        raise ValueError("BORIS toolchain runtime proof incomplete")
    if value.get("producer_sha256") != digest(Path(__file__)) or digest(context/"boris_cpu.py") != digest(Path(__file__)):
        raise ValueError("BORIS source producer drift")
    toolchain_context = load_manifest(context/"toolchain_context.json")
    if proof.get("context_sha256") != digest(context/"toolchain_context.json"):
        raise ValueError("BORIS toolchain context proof mismatch")
    container = load_manifest(context/"toolchain_container.json")
    if container.get("Image") != value.get("toolchain_image") or container.get("State", {}).get("ExitCode") != 0:
        raise ValueError("BORIS toolchain terminal image binding mismatch")
    if digest(context/"Dockerfile") != digest(Path(__file__).with_name("Dockerfile.boris-cpu")):
        raise ValueError("BORIS source Dockerfile differs from reviewed producer")
    inspection = load_manifest(context/"toolchain_inspect.json")
    if inspection.get("Id") != value.get("toolchain_image") or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["toolchain_image"]):
        raise ValueError("BORIS toolchain inspect binding mismatch")
    return value


def admit_toolchain(repo_storage, image, proof_path, toolchain_context, container_id):
    from fullmag_storage import validate_path
    from local_runner import boris_toolchain as toolchain
    context = validate_path(toolchain_context, repo_storage/"tmp", "BORIS toolchain context")
    manifest = toolchain.load(toolchain.member(context, "context.json"))
    if manifest.get("schema") != "fullmag.boris.toolchain-context.v1":
        raise ValueError("BORIS toolchain context schema mismatch")
    base = manifest["base_image_id"]
    _, _, selected = toolchain.validate_bundle(context/"bundle", base)
    toolchain.validate_wheels(context/"wheel-bundle", base)
    if selected != manifest["selected_packages"]:
        raise ValueError("BORIS toolchain dependency closure drift")
    for name, expected in manifest["context_source_sha256"].items():
        if digest(toolchain.member(context, name)) != expected:
            raise ValueError("BORIS toolchain source freeze drift")
    proof = load_manifest(proof_path)
    if (proof.get("context_sha256") != digest(context/"context.json") or
            proof.get("lock_sha256") != digest(context/"bundle/packages.lock.json") or
            proof.get("wheel_manifest_sha256") != digest(context/"wheel-bundle/manifest.json") or
            manifest["download_freeze_sha256"] != digest(context/"bundle/download-source-freeze.json")):
        raise ValueError("BORIS toolchain preflight freeze mismatch")
    if re.fullmatch(r"[a-f0-9]{64}", container_id) is None:
        raise ValueError("exact terminal toolchain container ID required")
    values = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "container", "inspect", container_id], timeout=30))
    if len(values) != 1:
        raise ValueError("toolchain preflight container missing")
    container = values[0]
    state, host, config = container["State"], container["HostConfig"], container["Config"]
    if (container.get("Id") != container_id or container.get("Image") != image or state.get("Status") != "exited" or
            state.get("ExitCode") != 0 or state.get("OOMKilled") or state.get("Running") or
            config.get("User") != "65532:65532" or not host.get("ReadonlyRootfs") or
            host.get("NetworkMode") != "none" or host.get("Privileged") or host.get("DeviceRequests") or
            container.get("Path") != "python3" or container.get("Args") != ["-B", "/opt/fullmag-boris-toolchain/boris_toolchain.py", "runtime-preflight", "--output-dir", "/proof/results"]):
        raise ValueError("actual toolchain preflight container is not qualified")
    mounts = container.get("Mounts", [])
    if len(mounts) != 1 or mounts[0].get("Type") != "bind" or mounts[0].get("Destination") != "/proof":
        raise ValueError("toolchain proof mount mismatch")
    # Docker Desktop may spell a Windows bind as /host_mnt/<drive>/... .
    source = mounts[0]["Source"].replace("\\", "/")
    if source.startswith("/host_mnt/") or source.startswith("/run/desktop/mnt/host/"):
        prefix = "/host_mnt/" if source.startswith("/host_mnt/") else "/run/desktop/mnt/host/"
        source = source[len(prefix):]; source = source[0]+":"+source[1:]
    mounted_proof = validate_path(Path(source)/"results/runtime-preflight.json", repo_storage)
    if mounted_proof.resolve() != proof_path.resolve() or digest(mounted_proof) != digest(proof_path):
        raise ValueError("toolchain proof is not the actual mounted output")
    return manifest, container


def clean_blob_ids(root, names):
    # hash-object applies the same clean filters used by Git status. The image
    # retains exact checkout bytes, including a declared CRLF checkout policy.
    if any("\n" in name or "\r" in name for name in names):
        raise ValueError("BORIS source path has line delimiters")
    result = subprocess.run(["git", "-c", "safe.directory="+str(root), "--no-optional-locks", "-C", str(root), "hash-object", "--stdin-paths"],
                            input=("\n".join(names)+"\n").encode(), capture_output=True, check=True, timeout=120)
    ids = result.stdout.decode().splitlines()
    if len(ids) != len(names) or any(not re.fullmatch(r"[a-f0-9]{40}", oid) for oid in ids):
        raise ValueError("BORIS clean-filter object identities missing")
    return dict(zip(names, ids))


def prepare_context(repo, boris_source, image, toolchain_proof, toolchain_context, toolchain_container):
    from fullmag_storage import resolve_layout, validate_path
    if re.fullmatch(r"sha256:[a-f0-9]{64}", image) is None or boris_source.is_symlink():
        raise ValueError("immutable installed toolchain image and regular checkout required")
    layout = resolve_layout(repo, "windows-native")
    storage = Path(layout["storage_root"])
    root = validate_path(boris_source, storage).resolve(strict=True)
    proof_path = validate_path(toolchain_proof, storage)
    proof = load_manifest(proof_path)
    if proof.get("qualification") != "TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED":
        raise ValueError("actual toolchain runtime proof required")
    toolchain_manifest, container = admit_toolchain(storage, image, proof_path, toolchain_context, toolchain_container)
    inspection = image_inspect(image)
    def git(*args):
        return subprocess.check_output(["git", "-c", "safe.directory="+str(root), "--no-optional-locks", "-C", str(root), *args])
    if git("rev-parse", "HEAD").decode().strip() != PIN or git("status", "--porcelain", "--untracked-files=all").strip():
        raise ValueError("BORIS source must be clean exact pinned checkout")
    tree = [item for item in git("ls-tree", "-r", "-z", "HEAD").split(b"\0") if item]
    if not 1 <= len(tree) <= MAX_FILES:
        raise ValueError("BORIS Git source count exceeds bound")
    clean_ids = clean_blob_ids(root, [item.split(b"\t", 1)[1].decode("utf-8") for item in tree])
    entries = []; captured = []; total = 0
    for item in tree:
        if not item:
            continue
        metadata, name = item.split(b"\t", 1); mode, kind, oid = metadata.split()
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError("BORIS source gitlink/symlink unsupported")
        name = name.decode("utf-8"); path = safe_member(root, name)
        size = path.stat().st_size; total += size
        if total > MAX_SOURCE_BYTES or len(entries) >= MAX_FILES:
            raise ValueError("BORIS context source bound exceeded")
        data = path.read_bytes()
        if len(data) != size or clean_ids[name] != oid.decode():
            raise ValueError("BORIS source changed during capture")
        captured.append((name, data, mode))
        entries.append(dict(path=name, size=size, sha256=hashlib.sha256(data).hexdigest(), mode=mode.decode()))
    # Detect byte changes after clean-filter admission before any snapshot write.
    for name, data, mode in captured:
        if digest(safe_member(root, name)) != hashlib.sha256(data).hexdigest():
            raise ValueError("BORIS checkout changed during capture")
    if git("status", "--porcelain", "--untracked-files=all").strip():
        raise ValueError("BORIS checkout became dirty during capture")
    entries.sort(key=lambda e: e["path"])
    source_manifest = dict(schema_version="fullmag.boris.image_source.v1", upstream_commit=PIN, files=entries,
                           source_tree_sha256=hashlib.sha256(canonical(entries)).hexdigest())
    context = validate_path(storage/"tmp"/("boris-cpu-image-"+uuid.uuid4().hex), storage)
    context.mkdir(parents=True)
    for name, data, mode in captured:
        target = context/"source"/name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        target.chmod(0o755 if mode == b"100755" else 0o644)
    (context/"source_manifest.json").write_bytes(canonical(source_manifest))
    (context/"toolchain_inspect.json").write_bytes(canonical(inspection))
    (context/"toolchain_proof.json").write_bytes(proof_path.read_bytes())
    (context/"toolchain_context.json").write_bytes((toolchain_context/"context.json").read_bytes())
    (context/"toolchain_container.json").write_bytes(canonical(container))
    shutil.copyfile(Path(__file__), context/"boris_cpu.py")
    shutil.copyfile(Path(__file__).with_name("Dockerfile.boris-cpu"), context/"Dockerfile")
    (context/".dockerignore").write_bytes(b"**\n!Dockerfile\n!boris_cpu.py\n!source_manifest.json\n!source_context.json\n!toolchain_proof.json\n!toolchain_inspect.json\n!toolchain_context.json\n!toolchain_container.json\n!source/\n!source/**\n")
    files = [dict(path=path.relative_to(context).as_posix(), size=path.stat().st_size, sha256=digest(path)) for path in context.rglob("*") if path.is_file()]
    files.sort(key=lambda e: e["path"])
    value = dict(schema="fullmag.boris.source-context.v1", upstream_commit=PIN, toolchain_image=image,
                 worktree_id=layout["worktree_id"], files=files, producer_sha256=digest(Path(__file__)),
                 source_tree_sha256=source_manifest["source_tree_sha256"], qualification="SOURCE_CONTEXT_ONLY_NOT_SOLVER_VERIFIED")
    (context/"source_context.json").write_bytes(canonical(value))
    validate_context(context)
    print(json.dumps(dict(context=str(context), context_sha256=digest(context/"source_context.json"), qualification=value["qualification"])))
    return context


def build_image(repo, context, tag):
    from fullmag_storage import resolve_layout, validate_path, file_lock
    layout = resolve_layout(repo, "windows-native"); storage = Path(layout["storage_root"])
    context = validate_path(context, storage/"tmp", "BORIS source image context")
    if not context.name.startswith("boris-cpu-image-") or not re.fullmatch(r"fullmag/boris-cpu:[a-z0-9][a-z0-9_.-]{0,100}", tag):
        raise ValueError("private BORIS source context and tag required")
    destination = validate_path(Path(layout["build_root"])/("boris-source-image-"+uuid.uuid4().hex), storage)
    destination.mkdir(parents=True)
    receipt = dict(schema="fullmag.boris.source-image-build.v1", status="RUNNING", worktree_id=layout["worktree_id"],
                   context=str(context), native_compilation_executed=False, operator_changed=False, qualification="NOT VERIFIED")
    try:
        with file_lock(storage/"locks"/(context.name+".lock"), "BORIS source image provisioning"):
            value = validate_context(context)
            if value["worktree_id"] != layout["worktree_id"]:
                raise ValueError("BORIS context owner mismatch")
            image = value["toolchain_image"]; inspected = image_inspect(image)
            if inspected != load_manifest(context/"toolchain_inspect.json"):
                raise ValueError("BORIS installed toolchain identity drift")
            alias = "fullmag/boris-cpu-base:"+uuid.uuid4().hex
            subprocess.run(["docker", "--context", "desktop-linux", "image", "tag", image, alias], check=True, timeout=30)
            actual_alias = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", alias], timeout=30))
            if len(actual_alias) != 1 or actual_alias[0]["Id"] != image:
                raise ValueError("BORIS private local base alias drift")
            iid = destination/"image-id.txt"
            command = ["docker", "--context", "desktop-linux", "build", "--network", "none", "--pull=false", "--build-arg", "TOOLCHAIN_IMAGE="+alias, "--iidfile", str(iid), "-t", tag, "-f", str(context/"Dockerfile"), str(context)]
            receipt.update(toolchain_image=image, base_alias=alias, tag=tag, command=command,
                           context_sha256=digest(context/"source_context.json"), source_tree_sha256=value["source_tree_sha256"])
            with (destination/"build.log").open("xb") as output:
                result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
            receipt["exit_code"] = result.returncode
            if result.returncode != 0:
                raise ValueError("BORIS source image build failed: "+str(destination/"build.log"))
            identity = iid.read_text().strip()
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
                raise ValueError("BORIS source image ID missing")
            actual = image_inspect(identity)
            base_layers = inspected["RootFS"]["Layers"]
            if actual["Config"].get("User") != "65532:65532" or actual["RootFS"]["Layers"][:len(base_layers)] != base_layers:
                raise ValueError("BORIS source image user or toolchain layers mismatch")
            alias_after = json.loads(subprocess.check_output(["docker", "--context", "desktop-linux", "image", "inspect", alias], timeout=30))
            if len(alias_after) != 1 or alias_after[0]["Id"] != image:
                raise ValueError("BORIS base alias changed during build")
            validate_context(context)
            receipt.update(status="SUCCEEDED_SOURCE_IMAGE_ONLY", image_id=identity, qualification="BORIS_BUILD_AND_RUNTIME_NOT_VERIFIED")
    except BaseException as error:
        receipt.update(status="FAILED", error=str(error))
        raise
    finally:
        receipt["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        temporary = destination/"terminal-receipt.tmp"
        temporary.write_bytes(canonical(receipt)); temporary.replace(destination/"terminal-receipt.json")
        print(json.dumps(dict(receipt=str(destination/"terminal-receipt.json"), status=receipt["status"], image_id=receipt.get("image_id"))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare-image-context", "build-image", "validate-image-source"))
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--boris-source", type=Path)
    parser.add_argument("--toolchain-image")
    parser.add_argument("--toolchain-proof", type=Path)
    parser.add_argument("--toolchain-context", type=Path)
    parser.add_argument("--toolchain-container")
    parser.add_argument("--context", type=Path)
    parser.add_argument("--tag")
    args = parser.parse_args()
    if args.operation == "prepare-image-context":
        if not all((args.repo_root, args.boris_source, args.toolchain_image, args.toolchain_proof, args.toolchain_context, args.toolchain_container)):
            parser.error("prepare requires repo-root, boris-source, toolchain-image, toolchain-proof, toolchain-context and toolchain-container")
        prepare_context(args.repo_root, args.boris_source, args.toolchain_image, args.toolchain_proof, args.toolchain_context, args.toolchain_container)
    elif args.operation == "build-image":
        if not all((args.repo_root, args.context, args.tag)):
            parser.error("build requires repo-root, context and private tag")
        build_image(args.repo_root, args.context, args.tag)
    else:
        verify_source(SOURCE_ROOT, load_manifest(SOURCE_MANIFEST))


if __name__ == "__main__":
    import sys
    if __package__ in (None, ""):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    main()
