"""Fixed receipt-verified BORIS CPU N/F runtime; no builds or installations."""
from __future__ import annotations
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

import fullmag_storage as storage
from local_runner import boris_cpu as boris
from local_runner.build_executor import capsule_path, validate_build_receipt
from local_runner.container_client import request
from local_runner.worker_entrypoint import verify_source

SCHEMA = "fullmag.boris.managed_run.v1"
RUNTIME_SCHEMA = "fullmag.boris.runtime.v2"
TRUSTED = {"context.json", "build_entrypoint.py", "worker_entrypoint.py", "boris_cpu.py"}
RESOLUTIONS = ("coarse", "medium", "fine")
HEADLESS_EXIT_PROTOCOL = "fullmag.boris.pinned-headless-exit.v1"
HEADLESS_EXIT_UPSTREAM = "048503d2ca6475e91b073eb1762ecf9d3634c3e1"
HEADLESS_EXIT_SOURCE_MEMBER = "Boris/Commands_PythonScripting.cpp"
HEADLESS_EXIT_SOURCE_SHA256 = "d7e1eaf2e141cbc0c66cf1a7f0a391470760e709d301c880e43457ec504def47"
RAW_FIELDS = tuple(f"{prefix}_{name}.ovf" for prefix, names in (
    ("n", ("V","S","Jc","Jsx","Jsy","Jsz")),
    ("f", ("V","S","Jc","Jsx","Jsy","Jsz","Ts","Tsi"))) for name in names)
RAW_FIELDS = (*RAW_FIELDS, "f_M_before.ovf", "f_M_after.ovf")
RAW_OUTPUTS = (*RAW_FIELDS, "boris_native_samples.json", "solver.stdout.log", "solver.stderr.log", "runtime_probe.json")
SOURCE_FILES = ("scripts/run_managed_boris_nf.py", "scripts/run_boris_nf_interface.py",
    "scripts/verify_boris_nf_interface.py", "scripts/compare_boris_fullmag_she_nf.py",
    "scripts/boris_nf_interface_smoke.py", "scripts/fullmag_storage.py",
    "scripts/verify_saved_fem_archive_roundtrip.py")


SYSTEM_MOUNT_TARGETS = {"/etc/hosts", "/etc/hostname", "/etc/resolv.conf"}


def host_path(value):
    raw = str(value).replace("\\", "/")
    if os.name == "nt":
        alias = re.fullmatch(r"/(?:run/desktop/mnt/host|host_mnt)/([A-Za-z])/(.*)", raw)
        if alias:
            raw = alias.group(1) + ":/" + alias.group(2)
    return Path(raw).resolve()


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024*1024), b""):
            result.update(block)
    return result.hexdigest()


def docker(*args):
    result = subprocess.run(["docker", "--context", "desktop-linux", *args],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Docker operation failed")
    return result.stdout.strip()


def read_json(path, bound=4*1024*1024, *, expected_sha256=None):
    path=Path(path)
    if storage.is_link(path) or not path.is_file():
        raise ValueError("Managed BORIS JSON must be a regular file")
    with path.open("rb") as stream:
        raw=stream.read(bound+1)
    if not 0<len(raw)<=bound:
        raise ValueError("Managed BORIS JSON exceeds bound")
    if expected_sha256 is not None:
        import hashlib
        if hashlib.sha256(raw).hexdigest() != expected_sha256:
            raise ValueError("Managed BORIS JSON bytes differ from retained output closure")
    def unique(pairs):
        result={}
        for key,value in pairs:
            if key in result:raise ValueError("Duplicate managed BORIS JSON key")
            result[key]=value
        return result
    value=json.loads(raw.decode("utf-8"),object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite managed JSON")))
    if not isinstance(value,dict):raise ValueError("Managed BORIS JSON must be an object")
    return value


def identifier(value):
    if not isinstance(value,str) or re.fullmatch("[a-f0-9]{32}",value) is None:
        raise ValueError("Full managed BORIS ID required")
    return value


def source_hashes(repo, source):
    names=sorted((*SOURCE_FILES,*(p.relative_to(repo).as_posix() for p in (repo/"scripts/local_runner").glob("*.py"))))
    result={}
    for name in names:
        host=storage.validate_path(repo/name,repo)
        frozen=storage.validate_path(source/name,source)
        if storage.is_link(host) or storage.is_link(frozen) or digest(host)!=digest(frozen):
            raise ValueError("Host BORIS contract differs from capsule: "+name)
        result[name]=digest(frozen)
    return result


def resolved_boris_build(repo, job_id):
    repo=Path(repo).resolve();job_id=identifier(job_id)
    layout=storage.resolve_layout(repo,"windows-native")
    actor=getpass.getuser()
    job=request(layout,owner=actor,method="GET",path="/jobs/"+job_id)
    if type(job.get("exit_code")) is not int:raise ValueError("BORIS job exit code must be integer")
    for key,expected in (("job_id",job_id),("owner",actor),("operation","build"),
                         ("profile",boris.PROFILE),("state","succeeded"),("exit_code",0)):
        if job.get(key)!=expected:raise ValueError("Managed BORIS terminal job differs: "+key)
    if job.get("worktree_id")!=layout.get("worktree_id"):
        raise ValueError("BORIS job belongs to a different worktree")
    base=Path(layout["storage_root"])
    capsule=capsule_path(base,job)
    root=storage.validate_path(base/"runs"/job["worktree_id"]/job_id,base)
    journal=read_json(storage.validate_path(root/"receipt.json",root))
    context=read_json(storage.validate_path(root/"trusted/context.json",root))
    if journal.get("phase")!="terminal" or journal.get("state")!="succeeded" or type(journal.get("exit_code")) is not int or journal.get("exit_code")!=0:
        raise ValueError("BORIS build receipt is not successful terminal")
    if journal.get("owner")!=actor or set(journal.get("trusted_hashes",{}))!=TRUSTED:
        raise ValueError("BORIS trusted actor/documents differ")
    for key in ("job_id","source_digest","profile"):
        if journal.get(key)!=job.get(key) or context.get(key)!=job.get(key):
            raise ValueError("BORIS coordinator/context/API binding differs")
    if context.get("image_digest")!=journal.get("image_digest"):
        raise ValueError("BORIS context image differs")
    for name,expected in journal["trusted_hashes"].items():
        if digest(storage.validate_path(root/"trusted"/name,root))!=expected:
            raise ValueError("BORIS trusted document changed")
    if context.get("native_source_identity")!=job["payload"].get("native_source_identity"):
        raise ValueError("BORIS capsule native provenance differs")
    verify_source(capsule,job["source_digest"])
    built=validate_build_receipt(root/"artifacts",job,journal)
    hashes=source_hashes(repo,capsule/"tree")
    outputs=storage.validate_path(root/"artifacts/outputs/boris",root)
    binding=dict(job_id=job_id,actor=actor,source_digest=job["source_digest"],
        image_digest=context["image_digest"],upstream_commit=boris.PIN,
        coordinator_receipt_sha256=digest(root/"receipt.json"),build_receipt_sha256=digest(root/"artifacts/build-receipt.json"),
        context_sha256=digest(root/"trusted/context.json"),trusted_hashes=journal["trusted_hashes"],
        source_files_sha256=hashes,source_manifest_sha256=digest(outputs/"source_manifest.json"),
        boris_build_proof=built["boris_build_proof"])
    # Both reads must observe the same immutable terminal record.
    if request(layout,owner=actor,method="GET",path="/jobs/"+job_id)!=job:
        raise ValueError("Managed BORIS job changed during admission")
    return layout,outputs,capsule/"tree",binding


def fixed_inputs(resolution):
    if resolution not in RESOLUTIONS:raise ValueError("Unsupported fixed BORIS resolution")
    from run_boris_nf_interface import _resolution_config
    from boris_nf_interface_smoke import render_boris_script, scenario_manifest
    config=_resolution_config(resolution,Path("/export"))
    # The embedded interpreter, not the external launcher, produces this identity.
    prefix='import sys,json\nprint("BORIS_EMBEDDED_IDENTITY:"+json.dumps({"python_version":sys.version}),flush=True)\n'
    return config, (prefix+render_boris_script(config, execution_output_dir="/export")).encode("utf-8"),boris.canonical(scenario_manifest(config))


def scientific_spec(image,source,outputs,inputs,export):
    if not re.fullmatch("sha256:[a-f0-9]{64}",image):raise ValueError("Immutable installed BORIS image required")
    return {"services":{"boris":dict(image=image,pull_policy="never",init=True,
        network_mode="none",runtime="runc",entrypoint=[],command=["python3","-B","/source/scripts/run_managed_boris_nf.py","_worker"],
        working_dir="/tmp",read_only=True,user="65532:65532",cpus=2,mem_limit="2g",pids_limit=128,
        cap_drop=["ALL"],security_opt=["no-new-privileges:true"],
        volumes=[dict(type="bind",source=str(p.resolve()),target=t,read_only=r) for p,t,r in
                 ((source,"/source",True),(outputs,"/boris",True),(inputs,"/input",True),(export,"/export",False))],
        tmpfs=["/tmp:rw,nosuid,nodev,size=256m"],environment=dict(
            PYTHONPATH="/source/scripts:/opt/fullmag-boris/source",PYTHONDONTWRITEBYTECODE="1",
            MPLCONFIGDIR="/tmp/matplotlib",HOME="/tmp",OMP_NUM_THREADS="2",LD_PRELOAD="",PYTHONHOME="",
            PATH="/usr/local/bin:/usr/bin:/bin",NVIDIA_VISIBLE_DEVICES="void",NVIDIA_DRIVER_CAPABILITIES=""))}}


def attest(container,spec,project):
    observed=json.loads(docker("inspect",container))[0];service=spec["services"]["boris"]
    runtime=observed["Config"];host=observed["HostConfig"]
    expected={(m["target"],str(Path(m["source"]).resolve()).lower(),not m["read_only"]) for m in service["volumes"]}
    actual={(m["Destination"],str(host_path(m["Source"])).lower(),m["RW"]) for m in observed["Mounts"]
            if m["Type"]=="bind" and m["Destination"] not in SYSTEM_MOUNT_TARGETS}
    env=runtime.get("Env",[])
    if (observed["Image"]!=service["image"] or actual!=expected or any(m["Type"]=="volume" for m in observed["Mounts"])
        or runtime.get("Cmd")!=service["command"] or runtime.get("Entrypoint") not in ([],None)
        or runtime.get("WorkingDir")!="/tmp" or runtime.get("User")!="65532:65532"
        or runtime.get("Labels",{}).get("com.docker.compose.project")!=project
        or runtime.get("Labels",{}).get("com.docker.compose.service")!="boris"
        or any([x for x in env if x.split("=",1)[0]==k]!=[k+"="+v] for k,v in service["environment"].items())
        or host.get("Runtime")!="runc" or host.get("NetworkMode")!="none" or host.get("PortBindings") or host.get("DeviceRequests") or host.get("Devices") or host.get("DeviceCgroupRules")
        or host.get("Privileged") or not host.get("ReadonlyRootfs") or set(host.get("CapDrop",[]))!={"ALL"}
        or "no-new-privileges:true" not in host.get("SecurityOpt",[]) or host.get("PidMode") or host.get("IpcMode")=="host"
        or host.get("Memory")!=2*1024**3 or host.get("NanoCpus")!=2*10**9 or host.get("PidsLimit")!=128
        or host.get("Tmpfs")!={"/tmp":"rw,nosuid,nodev,size=256m"}):
        raise ValueError("Managed BORIS container identity/isolation differs")
    return observed


def output_closure(root):
    allowed=set(RAW_OUTPUTS)|{"summary.json","runtime.json","validation.json"}
    if any(storage.is_link(p) or not p.is_file() or p.name not in allowed for p in root.iterdir()):
        raise ValueError("BORIS output membership differs")
    entries=[];total=0
    for name in RAW_OUTPUTS:
        p=storage.validate_path(root/name,root)
        minimum_size = 0 if name == "solver.stderr.log" else 1
        if not p.is_file() or storage.is_link(p) or not minimum_size<=p.stat().st_size<=64*1024**2:
            raise ValueError("BORIS required output missing or oversized")
        total+=p.stat().st_size
        if total>256*1024**2:raise ValueError("BORIS aggregate output exceeds bound")
        entries.append(dict(path=name,size=p.stat().st_size,sha256=digest(p)))
    return entries


def require_fixed_m_members(proof, entries):
    """Bind parsed M samples to the same immutable raw closure members."""
    members = {entry["path"]: entry["sha256"] for entry in entries}
    if any(members.get(name) != proof[key] for name, key in (
        ("f_M_before.ovf", "M_before_sha256"), ("f_M_after.ovf", "M_after_sha256")
    )):
        raise ValueError("BORIS fixed-M parsed bytes differ from retained output closure")


def verified_headless_outputs(root, scenario, proof):
    probe = read_json(root / "runtime_probe.json", 4096)
    raw_exit = probe.get("solver_exit_code")
    if (probe.get("solver_exit_protocol") != HEADLESS_EXIT_PROTOCOL
            or type(raw_exit) is not int or raw_exit not in (0, -15)):
        raise ValueError("BORIS pinned headless exit protocol differs")
    original = proof.get("original_source", {})
    files = original.get("files") if isinstance(original, dict) else None
    normal_exit = [entry.get("sha256") for entry in files
                   if isinstance(entry, dict) and entry.get("path") == HEADLESS_EXIT_SOURCE_MEMBER] if isinstance(files, list) else []
    if (boris.PIN != HEADLESS_EXIT_UPSTREAM or not isinstance(original, dict)
            or original.get("upstream_commit") != HEADLESS_EXIT_UPSTREAM
            or normal_exit != [HEADLESS_EXIT_SOURCE_SHA256]):
        raise ValueError("BORIS headless exit requires the pinned normal-exit source")
    entries = output_closure(root)
    stdout = (root / "solver.stdout.log").read_text(encoding="utf-8")
    marker = "BORIS_NF_STAGE_COMPLETE"
    if [line for line in stdout.splitlines() if marker in line] != [marker]:
        raise ValueError("BORIS final stage marker is missing, malformed or duplicated")
    embedded = [json.loads(line.split(":", 1)[1]) for line in stdout.splitlines()
                if line.startswith("BORIS_EMBEDDED_IDENTITY:")]
    if (embedded != [{"python_version": probe.get("embedded_python_version")}]
            or not isinstance(probe.get("embedded_python_version"), str)
            or not probe["embedded_python_version"]):
        raise ValueError("BORIS embedded interpreter probe differs")
    native = read_json(root / "boris_native_samples.json")
    if (native.get("schema_version") != "fullmag.boris_she_nf.native.v2"
            or native.get("stage_complete") is not True or native.get("scenario") != scenario):
        raise ValueError("BORIS native stage/scenario differs")
    from verify_boris_nf_interface import validate_fixed_m
    fixed_m = validate_fixed_m(root, scenario, native)
    require_fixed_m_members(fixed_m, entries)
    return entries, probe


def _worker():
    # Fixed Linux image paths only; no user binary/script/argv selections.
    if os.name != "posix" or Path(__file__).resolve()!=Path("/source/scripts/run_managed_boris_nf.py"):
        raise ValueError("BORIS worker may run only at fixed managed image path")
    inputs=read_json(Path("/input/run_input.json"));resolution=inputs["resolution"]
    _,script,scenario=fixed_inputs(resolution)
    if Path("/input/scenario.py").read_bytes()!=script or Path("/input/scenario.json").read_bytes()!=scenario:
        raise ValueError("BORIS fixed input differs")
    proof=boris.load_manifest(Path("/boris/source_manifest.json"))
    if proof!=inputs["binding"]["boris_build_proof"] or digest(Path("/boris/BorisLin"))!=proof["binary_sha256"]:
        raise ValueError("BORIS worker binary/build proof differs")
    boris.verify_source(boris.SOURCE_ROOT,boris.load_manifest(boris.SOURCE_MANIFEST))
    if boris.load_manifest(boris.SOURCE_MANIFEST)!=proof["original_source"]:
        raise ValueError("BORIS installed image source differs")
    import numpy,matplotlib  # Actual runtime dependency preflight, never installs.
    version=subprocess.run(["/boris/BorisLin","-version"],capture_output=True,text=True,timeout=15,check=True)
    if "BORIS" not in version.stdout+version.stderr:raise ValueError("BORIS version probe missing")
    with Path("/export/solver.stdout.log").open("x") as out,Path("/export/solver.stderr.log").open("x") as err:
        completed=subprocess.run(["/boris/BorisLin","-s","/input/scenario.py","-g","-1"],
            stdout=out,stderr=err,timeout=180,check=False)
    if Path("/export/solver.stdout.log").stat().st_size>64*1024**2:raise ValueError("BORIS solver log exceeds bound")
    stdout=Path("/export/solver.stdout.log").read_text(encoding="utf-8")
    embedded=[json.loads(line.split(":",1)[1]) for line in stdout.splitlines() if line.startswith("BORIS_EMBEDDED_IDENTITY:")]
    embedded_python = embedded[0].get("python_version") if len(embedded)==1 and isinstance(embedded[0],dict) else None
    if digest(Path("/boris/BorisLin"))!=proof["binary_sha256"]:raise ValueError("BORIS binary changed during run")
    storage.atomic_json(Path("/export/runtime_probe.json"),dict(binary_sha256=proof["binary_sha256"],
        binary_version=(version.stdout+version.stderr).strip(),external_python_version=sys.version,
        embedded_python_version=embedded_python,solver_exit_code=completed.returncode,
        solver_exit_protocol=HEADLESS_EXIT_PROTOCOL,
        device="cpu",precision_abi=boris.load_manifest(Path("/boris/cpu_abi_witness.json")),
        numpy_version=numpy.__version__,matplotlib_version=matplotlib.__version__))
    entries, _ = verified_headless_outputs(Path("/export"), json.loads(scenario), proof)
    print(json.dumps(dict(schema="fullmag.boris.output_closure.v1",outputs=entries)),flush=True)


def runtime_root(layout,runtime_id):
    base=Path(layout["storage_root"])
    return storage.validate_path(Path(layout["runs_root"])/"boris-runtime"/identifier(runtime_id),base)


def start(repo,job_id,resolution):
    _,script,scenario=fixed_inputs(resolution)
    layout,outputs,source,binding=resolved_boris_build(repo,job_id)
    image=json.loads(docker("image","inspect",binding["image_digest"]))[0]
    if image.get("Id")!=binding["image_digest"] or image.get("Config",{}).get("Volumes"):
        raise ValueError("BORIS installed image identity/volumes differ")
    root=runtime_root(layout,uuid.uuid4().hex);root.mkdir(parents=True,exist_ok=False)
    (root/"input").mkdir();(root/"export").mkdir()
    (root/"input/scenario.py").write_bytes(script);(root/"input/scenario.json").write_bytes(scenario)
    storage.atomic_json(root/"input/run_input.json",dict(resolution=resolution,binding=binding))
    spec=scientific_spec(binding["image_digest"],source,outputs,root/"input",root/"export")
    storage.atomic_json(root/"compose.json",spec)
    receipt=dict(schema=SCHEMA,state="starting",qualification="NOT VERIFIED",physics_qualified=False,
        runtime_id=root.name,build_job_id=job_id,resolution=resolution,binding=binding,
        input_hashes={name:digest(root/"input"/name) for name in ("scenario.py","scenario.json","run_input.json")},
        compose_sha256=digest(root/"compose.json"),compose_project="fullmag-boris-"+root.name)
    storage.atomic_json(root/"receipt.json",receipt)
    try:
        docker("compose","-p",receipt["compose_project"],"-f",root/"compose.json","up","-d")
        container=docker("compose","-p",receipt["compose_project"],"-f",root/"compose.json","ps","-a","-q","boris").strip()
        if not container:raise ValueError("Managed BORIS container missing")
        receipt["container_id"]=container
        attest(container,spec,receipt["compose_project"])
        receipt["state"]="launched_resources_retained"
    except Exception as error:
        receipt.update(state="failed_resources_retained",error=str(error));raise
    finally:storage.atomic_json(root/"receipt.json",receipt)
    return root


def checked_run(repo,runtime_id):
    layout=storage.resolve_layout(repo,"windows-native");root=runtime_root(layout,runtime_id)
    receipt=read_json(root/"receipt.json")
    if receipt.get("schema")!=SCHEMA or receipt.get("runtime_id")!=root.name or receipt.get("qualification")!="NOT VERIFIED" or receipt.get("physics_qualified") is not False:
        raise ValueError("Managed BORIS runtime receipt differs")
    _,outputs,source,binding=resolved_boris_build(repo,receipt["build_job_id"])
    if receipt.get("binding")!=binding:raise ValueError("Managed BORIS build chain changed")
    _,script,scenario=fixed_inputs(receipt["resolution"])
    if (root/"input/scenario.py").read_bytes()!=script or (root/"input/scenario.json").read_bytes()!=scenario:
        raise ValueError("Managed BORIS scenario changed")
    if read_json(root/"input/run_input.json")!={"resolution":receipt["resolution"],"binding":binding}:
        raise ValueError("Managed BORIS worker inputs differ")
    if receipt.get("input_hashes")!={name:digest(root/"input"/name) for name in ("scenario.py","scenario.json","run_input.json")}:
        raise ValueError("Managed BORIS input hashes differ")
    spec=scientific_spec(binding["image_digest"],source,outputs,root/"input",root/"export")
    if receipt.get("compose_sha256")!=digest(root/"compose.json") or read_json(root/"compose.json")!=spec or receipt.get("compose_project")!="fullmag-boris-"+root.name:
        raise ValueError("Managed BORIS retained spec differs")
    observed=attest(receipt["container_id"],spec,receipt["compose_project"])
    return root,receipt,observed


def verified_outputs(root,receipt,observed):
    state=observed["State"]
    if state.get("Status")!="exited" or state.get("Running") is not False or type(state.get("ExitCode")) is not int or state.get("ExitCode")!=0 or state.get("OOMKilled") is not False or state.get("Error"):
        raise ValueError("BORIS container is not successful terminal")
    proof=receipt["binding"]["boris_build_proof"]
    scenario=json.loads(fixed_inputs(receipt["resolution"])[2])
    entries, probe = verified_headless_outputs(root/"export", scenario, proof)
    expected_probe={"binary_sha256","binary_version","external_python_version","embedded_python_version",
        "solver_exit_code","solver_exit_protocol","device","precision_abi","numpy_version","matplotlib_version"}
    if set(probe)!=expected_probe or any(not isinstance(probe.get(k),str) or not probe[k] for k in
        ("binary_version","external_python_version","embedded_python_version","numpy_version","matplotlib_version")) or "BORIS" not in probe["binary_version"]:
        raise ValueError("BORIS actual runtime version/import probe incomplete")
    if (probe.get("binary_sha256")!=proof["binary_sha256"] or probe.get("device")!="cpu" or type(probe.get("solver_exit_code")) is not int
        or not isinstance(probe.get("embedded_python_version"),str) or not probe["embedded_python_version"]
        or probe.get("precision_abi")!=boris.abi_binding(dict(job_id=receipt["build_job_id"],source_digest=receipt["binding"]["source_digest"],image_digest=receipt["binding"]["image_digest"]),proof["compile_flags_sha256"],proof["cuda_flags_sha256"],boris.ABI_FACTS)):
        raise ValueError("BORIS actual runtime probe differs")
    logs=docker("logs",receipt["container_id"])
    manifests=[]
    for line in logs.splitlines():
        if line.startswith('{"schema": "fullmag.boris.output_closure.v1"'):
            manifests.append(json.loads(line))
    if manifests!=[dict(schema="fullmag.boris.output_closure.v1",outputs=entries)]:
        raise ValueError("BORIS outputs differ from actual container manifest")
    return entries,probe



def attestation_digest(observed):
    import hashlib
    return hashlib.sha256(boris.canonical({key:observed[key] for key in
        ("Id","Image","Config","HostConfig","Mounts","State")})).hexdigest()


def identity_from_receipt(root,receipt,probe,*,receipt_sha256=None):
    binding=receipt["binding"];proof=binding["boris_build_proof"]
    return dict(schema_version=RUNTIME_SCHEMA,identity_complete=True,build_job_id=receipt["build_job_id"],
        runtime_id=root.name,runtime_receipt_sha256=receipt_sha256 or digest(root/"receipt.json"),binary_sha256=proof["binary_sha256"],
        source_manifest_sha256=binding["source_manifest_sha256"],image_digest=binding["image_digest"],
        binary_version=probe["binary_version"],python_version=probe["embedded_python_version"],
        device_requested="cpu",device_detected="cpu",precision="double",qualification="NOT VERIFIED",
        device_residency_evidence="attested CPU-only managed container; COMPILECUDA=0; actual -g -1; binary64 ABI witness")


def commit_receipt(root,raw):
    temporary=root/(".receipt-"+uuid.uuid4().hex+".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,root/"receipt.json")
    finally:
        if temporary.exists():temporary.unlink()


def observe(repo,runtime_id):
    layout=storage.resolve_layout(repo,"windows-native")
    root=runtime_root(layout,runtime_id)
    lock=storage.validate_path(root/"observe.lock",root)
    with storage.file_lock(lock,"boris-observe:"+runtime_id):
        return _observe_locked(repo,runtime_id)


def _observe_locked(repo,runtime_id):
    root,receipt,observed=checked_run(repo,runtime_id)
    if receipt.get("state")=="runtime_succeeded_identity_verified":
        verify_runtime_identity(read_json(root/"export/runtime.json"),repo,root/"export")
        return root/"export/summary.json"
    if receipt.get("state")=="failed_resources_retained":
        raise ValueError("BORIS failed receipt is immutable; inspect retained diagnostics")
    if observed["State"].get("Running") is True or observed["State"].get("Status")=="created":
        return dict(state="pending",runtime_id=runtime_id)
    try:
        entries,probe=verified_outputs(root,receipt,observed)
        if resolved_boris_build(repo,receipt["build_job_id"])[3]!=receipt["binding"]:
            raise ValueError("BORIS build changed during output verification")
        final=dict(receipt,state="runtime_succeeded_identity_verified",outputs=entries,probe=probe,
                   container_attestation_sha256=attestation_digest(observed))
        final.pop("error",None)
        raw=(json.dumps(final,indent=2,ensure_ascii=False,allow_nan=False)+"\n").encode("utf-8")
        if len(raw)>4*1024*1024:raise ValueError("BORIS final receipt exceeds bound")
        import hashlib
        identity=identity_from_receipt(root,final,probe,receipt_sha256=hashlib.sha256(raw).hexdigest())
        from run_boris_nf_interface import _artifact_summary
        summary=_artifact_summary(root/"export",fixed_inputs(receipt["resolution"])[0],identity,retained_outputs=entries)
    except Exception as error:
        storage.atomic_json(root/"receipt.json",dict(receipt,state="failed_resources_retained",error=str(error)))
        raise
    try:
        storage.atomic_json(root/"export/runtime.json",identity)
        storage.atomic_json(root/"export/summary.json",summary)
        # The exact precomputed receipt is the sole terminal publication commit.
        commit_receipt(root,raw)
    except Exception as error:
        # A post-replace error cannot undo or relabel committed success.
        if (root/"receipt.json").read_bytes()!=raw:
            storage.atomic_json(root/"receipt.json",dict(receipt,state="publication_failed_resources_retained",error=str(error)))
        raise
    return root/"export/summary.json"


def verify_runtime_identity(identity,repo,artifact_root):
    if repo is None or artifact_root is None:raise ValueError("BORIS runtime v2 requires explicit trusted repo/artifact context")
    root,receipt,observed=checked_run(Path(repo),identity.get("runtime_id"))
    if Path(artifact_root).resolve()!=root/"export" or receipt.get("state")!="runtime_succeeded_identity_verified":
        raise ValueError("BORIS artifact is not the canonical verified managed output")
    entries,probe=verified_outputs(root,receipt,observed)
    if (receipt.get("outputs")!=entries or receipt.get("probe")!=probe
        or receipt.get("container_attestation_sha256")!=attestation_digest(observed)
        or identity!=identity_from_receipt(root,receipt,probe)):
        raise ValueError("BORIS runtime identity/retained closure differs")
    from run_boris_nf_interface import _artifact_summary
    expected=_artifact_summary(root/"export",fixed_inputs(receipt["resolution"])[0],identity,retained_outputs=entries)
    if boris.canonical(read_json(root/"export/summary.json"))!=boris.canonical(expected) or read_json(root/"export/runtime.json")!=identity:
        raise ValueError("BORIS summary differs from independently recomputed diagnostics")
    if resolved_boris_build(repo,receipt["build_job_id"])[3]!=receipt["binding"]:
        raise ValueError("BORIS build changed during public verification")
    return entries


def main():
    if sys.argv[1:]==["_worker"]:
        _worker();return
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--repo-root",type=Path,required=True)
    sub=parser.add_subparsers(dest="action",required=True)
    p=sub.add_parser("start");p.add_argument("--job-id",required=True);p.add_argument("--resolution",choices=RESOLUTIONS,required=True)
    sub.add_parser("observe").add_argument("--runtime-id",required=True)
    args=parser.parse_args()
    print(start(args.repo_root,args.job_id,args.resolution) if args.action=="start" else observe(args.repo_root,args.runtime_id))

if __name__=="__main__":main()
