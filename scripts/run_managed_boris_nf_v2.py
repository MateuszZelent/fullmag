"""Versioned host tools for a receipt-verified BORIS binary; no native builds."""
from __future__ import annotations
import argparse
import getpass
import hashlib
import json
from pathlib import Path
import re
import time
import uuid

import fullmag_storage as storage
import run_managed_boris_nf as legacy
from local_runner import boris_cpu as boris
from local_runner.build_executor import capsule_path, validate_build_receipt, is_blocking_fullmag_container
from local_runner.container_client import request
from local_runner.worker_entrypoint import verify_source
from local_runner.runtime_use import runtime_package_use, register_runtime_reference_root

SCHEMA = "fullmag.boris.managed_run.v2"
IDENTITY_SCHEMA = "fullmag.boris.runtime.v3"
ATTESTATION_SCHEMA = "fullmag.boris.container-attestation.v1"
TOOLS_SCHEMA = "fullmag.boris.runtime-tools.v1"
PYTHONPATH = "/source/scripts:/opt/fullmag-boris/source:/opt/fullmag-boris-python"
TRUSTED = legacy.TRUSTED
SOURCE_FILES = legacy.SOURCE_FILES
identifier, digest, read_json = legacy.identifier, legacy.digest, legacy.read_json
MAX_TOOL_BYTES = 4 << 20
MAX_TOOLS_BYTES = 32 << 20
WRAPPER_MEMBER = "EmbeddedPythonWrapper.py"
WRAPPER_SHA256 = "cffd4fe3c61b9a294277635b43aef561cebaed18e8abb0c731d92093702d6f22"
WRAPPER_SIZE = 2261
WRAPPER_ADAPTED_SHA256 = "3555e0be9c22c0c168210fcf9cefa3eedc15d32563292cf0c48eb6e287dbe409"
WRAPPER_ADAPTED_SIZE = 2297
WRAPPER_ADAPTER = "fullmag.boris.stdout-flush-noop.v1"
WRAPPER_ANCHOR = b"        BPython.sys_stdout_redirect(text)\r\n"
WRAPPER_INSERTION = b"    def flush(self):\r\n        pass\r\n"
INPUT_NAMES = ("scenario.py", "scenario.json", "run_input.json", WRAPPER_MEMBER)
TOOL_NAMES = (
    'scripts/boris_nf_interface_smoke.py',
    'scripts/compare_boris_fullmag_she_nf.py',
    'scripts/fullmag_storage.py',
    'scripts/local_runner/__init__.py',
    'scripts/local_runner/archive_receipt.py',
    'scripts/local_runner/boris_cpu.py',
    'scripts/local_runner/boris_toolchain.py',
    'scripts/local_runner/boris_transition.py',
    'scripts/local_runner/build_entrypoint.py',
    'scripts/local_runner/build_executor.py',
    'scripts/local_runner/build_source.py',
    'scripts/local_runner/container_api.py',
    'scripts/local_runner/container_client.py',
    'scripts/local_runner/container_main.py',
    'scripts/local_runner/coordinator.py',
    'scripts/local_runner/coordinator_image.py',
    'scripts/local_runner/coordinator_lifecycle.py',
    'scripts/local_runner/coordinator_replacement.py',
    'scripts/local_runner/dispatch.py',
    'scripts/local_runner/doctor.py',
    'scripts/local_runner/observability.py',
    'scripts/local_runner/queue.py',
    'scripts/local_runner/retention.py',
    'scripts/local_runner/retention_executor.py',
    'scripts/local_runner/retention_persistence.py',
    'scripts/local_runner/retention_service.py',
    'scripts/local_runner/runtime_references.py',
    'scripts/local_runner/runtime_retention.py',
    'scripts/local_runner/runtime_use.py',
    'scripts/local_runner/service.py',
    'scripts/local_runner/source.py',
    'scripts/local_runner/source_compaction.py',
    'scripts/local_runner/source_store.py',
    'scripts/local_runner/source_store_lock.py',
    'scripts/local_runner/storage_maintenance.py',
    'scripts/local_runner/unix_docker.py',
    'scripts/local_runner/worker.py',
    'scripts/local_runner/worker_entrypoint.py',
    'scripts/run_boris_nf_interface.py',
    'scripts/run_managed_boris_nf.py',
    'scripts/run_managed_boris_nf_v2.py',
    'scripts/verify_boris_nf_interface.py',
    'scripts/verify_saved_fem_archive_roundtrip.py',
)


def tool_names(repo):
    expected = {name for name in TOOL_NAMES if name.startswith("scripts/local_runner/")}
    actual = {p.relative_to(repo).as_posix() for p in (repo/"scripts/local_runner").glob("*.py")}
    if actual != expected:
        raise ValueError("BORIS declared runner tool closure differs")
    return list(TOOL_NAMES)


def tool_hashes(root, names):
    if not isinstance(names, list) or names != sorted(set(names)) or not 1 <= len(names) <= 64:
        raise ValueError("BORIS tools membership differs")
    result = {}; total = 0
    for name in names:
        if not isinstance(name, str) or not name.startswith("scripts/") or "\\" in name or ":" in name or any(p in ("", ".", "..") for p in name.split("/")):
            raise ValueError("BORIS tool path escapes")
        raw = root/name
        if any(storage.is_link(p) for p in (raw, *raw.parents) if p != root.parent):
            raise ValueError("BORIS tool link refused")
        path = storage.validate_path(raw, root)
        with path.open("rb") as stream:
            data = stream.read(MAX_TOOL_BYTES + 1)
        total += len(data)
        if not data or len(data) > MAX_TOOL_BYTES or total > MAX_TOOLS_BYTES:
            raise ValueError("BORIS tools byte bound exceeded")
        result[name] = hashlib.sha256(data).hexdigest()
    return result


def check_tools(repo, root, receipt):
    manifest = read_json(root/"tools/manifest.json")
    if (manifest.get("schema") != TOOLS_SCHEMA or manifest.get("solver_capsule_attribution") is not False
            or receipt.get("tools_manifest_sha256") != digest(root/"tools/manifest.json")
            or set(manifest) != {"schema", "solver_capsule_attribution", "files"}):
        raise ValueError("BORIS tools manifest binding differs")
    files = manifest["files"]; names = tool_names(repo)
    if not isinstance(files, dict) or sorted(files) != names or tool_hashes(root/"tools", names) != files or tool_hashes(repo, names) != files:
        raise ValueError("BORIS current or retained tools drift")
    if any(storage.is_link(p) for p in (root/"tools").rglob("*")):
        raise ValueError("Unexpected BORIS tool link")
    actual = {p.relative_to(root/"tools").as_posix() for p in (root/"tools").rglob("*") if p.is_file()}
    if actual != set(names) | {"manifest.json"}:
        raise ValueError("Unexpected BORIS retained tool member")
    return manifest


def capture_tools(repo, root):
    names = tool_names(repo); expected = tool_hashes(repo, names)
    tools = root/"tools"; tools.mkdir()
    for name in names:
        source = repo/name; target = tools/name; target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as stream:
            data = stream.read(MAX_TOOL_BYTES + 1)
        if hashlib.sha256(data).hexdigest() != expected[name]:
            raise ValueError("BORIS tool changed during capture")
        target.write_bytes(data)
    manifest = dict(schema=TOOLS_SCHEMA, solver_capsule_attribution=False, files=expected)
    storage.atomic_json(tools/"manifest.json", manifest)
    receipt = dict(tools_manifest_sha256=digest(tools/"manifest.json"))
    check_tools(repo, root, receipt)
    return receipt


def resolve_native_build(repo, job_id):
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
    # Native provenance is verified independently of the separately captured host tools.
    hashes={name:digest(capsule/"tree"/name) for name in SOURCE_FILES}
    outputs=storage.validate_path(root/"artifacts/outputs/boris",root)
    binding=dict(job_id=job_id,actor=actor,source_digest=job["source_digest"],
        image_digest=context["image_digest"],upstream_commit=boris.PIN,
        coordinator_receipt_sha256=digest(root/"receipt.json"),build_receipt_sha256=digest(root/"artifacts/build-receipt.json"),
        context_sha256=digest(root/"trusted/context.json"),trusted_hashes=journal["trusted_hashes"],
        native_source_identity=context["native_source_identity"],
        native_capsule_scripts_sha256=hashes,source_manifest_sha256=digest(outputs/"source_manifest.json"),
        boris_build_proof=built["boris_build_proof"])
    # Both reads must observe the same immutable terminal record.
    if request(layout,owner=actor,method="GET",path="/jobs/"+job_id)!=job:
        raise ValueError("Managed BORIS job changed during admission")
    return layout,outputs,capsule/"tree",binding


def adapt_wrapper(raw, original_source):
    entries = [e for e in original_source.get("files", []) if e.get("path") == WRAPPER_MEMBER]
    expected = dict(path=WRAPPER_MEMBER, mode="100644", size=WRAPPER_SIZE, sha256=WRAPPER_SHA256)
    if (original_source.get("upstream_commit") != boris.PIN or entries != [expected]
            or len(raw) != WRAPPER_SIZE or hashlib.sha256(raw).hexdigest() != WRAPPER_SHA256
            or raw.count(WRAPPER_ANCHOR) != 1):
        raise ValueError("BORIS pinned original wrapper differs")
    # GRAPHICS=0 writes synchronously through std::cout << text << std::endl;
    # there is no Python-side output buffer for flush() to drain.
    adapted = raw.replace(WRAPPER_ANCHOR, WRAPPER_ANCHOR+WRAPPER_INSERTION)
    if len(adapted) != WRAPPER_ADAPTED_SIZE or hashlib.sha256(adapted).hexdigest() != WRAPPER_ADAPTED_SHA256:
        raise ValueError("BORIS explicit stdout support adapter differs")
    return adapted


def runtime_support(outputs, binding):
    build_root = outputs.parents[2]
    if build_root.name != binding["job_id"]:
        raise ValueError("BORIS wrapper cache owner differs")
    relative = "execution/boris-cpu-source/"+WRAPPER_MEMBER
    raw_path = build_root/relative
    if any(storage.is_link(p) for p in (raw_path, *raw_path.parents)):
        raise ValueError("BORIS wrapper source link refused")
    path = storage.validate_path(raw_path, build_root)
    if not path.is_file() or path.stat().st_size != WRAPPER_SIZE:
        raise ValueError("BORIS wrapper source type/size differs")
    with path.open("rb") as stream:
        raw = stream.read(WRAPPER_SIZE+1)
    proof = binding["boris_build_proof"]
    adapted = adapt_wrapper(raw, proof["original_source"])
    descriptor = dict(schema="fullmag.boris.embedded-wrapper-support.v1", adapter=WRAPPER_ADAPTER,
        native_build_job_id=binding["job_id"], native_binary_sha256=proof["binary_sha256"],
        image_digest=binding["image_digest"], source_cache_relative=relative,
        source_manifest_sha256=binding["source_manifest_sha256"],
        original=dict(path=WRAPPER_MEMBER, sha256=WRAPPER_SHA256, size=WRAPPER_SIZE, upstream_commit=boris.PIN),
        adapted=dict(path=WRAPPER_MEMBER, sha256=WRAPPER_ADAPTED_SHA256, size=WRAPPER_ADAPTED_SIZE),
        insertion_sha256=hashlib.sha256(WRAPPER_INSERTION).hexdigest(),
        container_path="/boris/"+WRAPPER_MEMBER, native_build_modified=False)
    return adapted, descriptor


def capture_runtime_support(root, outputs, binding):
    adapted, descriptor = runtime_support(outputs, binding)
    with (root/"input"/WRAPPER_MEMBER).open("xb") as stream:
        stream.write(adapted)
    return dict(runtime_support=descriptor,
                runtime_support_sha256=hashlib.sha256(boris.canonical(descriptor)).hexdigest())


def check_runtime_support(root, outputs, binding, receipt):
    members = list((root/"input").iterdir())
    if ({p.name for p in members} != set(INPUT_NAMES)
            or any(storage.is_link(p) or not p.is_file() for p in members)):
        raise ValueError("BORIS closed four-member input differs")
    expected, descriptor = runtime_support(outputs, binding)
    path = root/"input"/WRAPPER_MEMBER
    if storage.is_link(path):
        raise ValueError("BORIS retained wrapper link refused")
    with path.open("rb") as stream:
        actual = stream.read(WRAPPER_ADAPTED_SIZE+1)
    if (actual != expected or receipt.get("runtime_support") != descriptor
            or receipt.get("runtime_support_sha256") != hashlib.sha256(boris.canonical(descriptor)).hexdigest()):
        raise ValueError("BORIS runtime support provenance/bytes differ")


def scientific_spec(image,source,outputs,inputs,export):
    if not re.fullmatch("sha256:[a-f0-9]{64}",image):raise ValueError("Immutable installed BORIS image required")
    return {"services":{"boris":dict(image=image,pull_policy="never",init=True,
        network_mode="none",runtime="runc",entrypoint=[],command=["python3","-B","/source/scripts/run_managed_boris_nf.py","_worker"],
        working_dir="/tmp",read_only=True,user="65532:65532",cpus=2,mem_limit="2g",pids_limit=128,
        cap_drop=["ALL"],security_opt=["no-new-privileges:true"],
        volumes=[dict(type="bind",source=str(p.resolve()),target=t,read_only=r) for p,t,r in
                 ((source,"/source",True),(inputs,"/input",True),(export,"/export",False),
                  *((outputs/name,"/boris/"+name,True) for name in boris.OUTPUTS),
                  (inputs/WRAPPER_MEMBER,"/boris/"+WRAPPER_MEMBER,True))],
        tmpfs=["/tmp:rw,nosuid,nodev,size=256m"],environment=dict(
            PYTHONPATH=PYTHONPATH,PYTHONDONTWRITEBYTECODE="1",
            MPLCONFIGDIR="/tmp/matplotlib",HOME="/tmp",OMP_NUM_THREADS="2",LD_PRELOAD="",PYTHONHOME="",
            PATH="/usr/local/bin:/usr/bin:/bin",NVIDIA_VISIBLE_DEVICES="void",NVIDIA_DRIVER_CAPABILITIES=""))}}


def attest(container, spec, project):
    if re.fullmatch("[0-9a-f]{64}", container) is None:
        raise ValueError("Exact BORIS container ID required")
    observed = legacy.attest(container, spec, project)
    if observed.get("Id") != container:
        raise ValueError("BORIS actual container ID differs")
    return observed



def attestation_digest(observed):
    # Docker reports Mounts in map iteration order; retain every mount field.
    material = {key: observed[key] for key in
                ("Id", "Image", "Config", "HostConfig", "Mounts", "State")}
    material["Mounts"] = sorted(material["Mounts"], key=boris.canonical)
    return hashlib.sha256(boris.canonical(dict(schema=ATTESTATION_SCHEMA, container=material))).hexdigest()


def require_window(layout, own=None):
    health = request(layout, getpass.getuser(), "GET", "/health", timeout=3)
    if (health.get("service") != "fullmag-build-runner" or health.get("ok") is not True
            or health.get("accepting_jobs") is not False or health.get("worker_alive") is not False
            or health.get("stop_requested") is not True or health.get("worker_error") is not None
            or health.get("active_jobs") != [] or health.get("legacy_jobs") != []
            or health.get("retention_busy") is not False or health.get("replacement_pending") is not False
            or health.get("coordinator", {}).get("state") not in ("paused", "stopped")):
        raise ValueError("BORIS V2 requires an existing idle/paused operator window")
    ids = legacy.docker("ps", "-q", "--no-trunc").split()
    running = json.loads(legacy.docker("inspect", *ids)) if ids else []
    if any(c.get("Id") != own and is_blocking_fullmag_container(c,
           storage_root=layout["storage_root"], build_storage_root=layout["build_storage_root"]) for c in running):
        raise ValueError("A foreign compute or unknown Fullmag container blocks BORIS")


def checked_run(repo, runtime_id):
    layout = storage.resolve_layout(repo, "windows-native")
    root = legacy.runtime_root(layout, runtime_id); receipt = read_json(root/"receipt.json")
    if (receipt.get("schema") != SCHEMA or receipt.get("runtime_id") != root.name
            or receipt.get("qualification") != "NOT VERIFIED" or receipt.get("physics_qualified") is not False
            or receipt.get("runtime_job_id") != receipt.get("build_job_id")):
        raise ValueError("BORIS V2 receipt differs; V1 is never reinterpreted")
    check_tools(repo, root, receipt)
    _, outputs, source, binding = resolve_native_build(repo, receipt["build_job_id"])
    if binding != receipt.get("binding"):
        raise ValueError("BORIS native binding changed")
    check_runtime_support(root, outputs, binding, receipt)
    _, script, scenario = legacy.fixed_inputs(receipt["resolution"])
    if (root/"input/scenario.py").read_bytes() != script or (root/"input/scenario.json").read_bytes() != scenario:
        raise ValueError("BORIS V2 scenario changed")
    if read_json(root/"input/run_input.json") != dict(resolution=receipt["resolution"], binding=binding):
        raise ValueError("BORIS V2 frozen worker input changed")
    if receipt.get("input_hashes") != {n:digest(root/"input"/n) for n in INPUT_NAMES}:
        raise ValueError("BORIS V2 input hashes changed")
    spec = scientific_spec(binding["image_digest"], source, outputs, root/"input", root/"export")
    if (receipt.get("compose_sha256") != digest(root/"compose.json") or read_json(root/"compose.json") != spec
            or receipt.get("compose_project") != "fullmag-boris-v2-"+root.name):
        raise ValueError("BORIS V2 spec differs")
    return root, receipt, attest(receipt["container_id"], spec, receipt["compose_project"])


def identity(root, receipt, probe, receipt_sha=None):
    binding = receipt["binding"]; proof = binding["boris_build_proof"]
    return dict(schema_version=IDENTITY_SCHEMA, identity_complete=True,
        managed_run_schema=SCHEMA, tools_manifest_sha256=receipt["tools_manifest_sha256"],
        runtime_support_sha256=receipt["runtime_support_sha256"],
        native_source_digest=binding["source_digest"], solver_capsule_attribution=False,
        build_job_id=receipt["build_job_id"], runtime_id=root.name,
        runtime_receipt_sha256=receipt_sha or digest(root/"receipt.json"),
        binary_sha256=proof["binary_sha256"], source_manifest_sha256=binding["source_manifest_sha256"],
        image_digest=binding["image_digest"], binary_version=probe["binary_version"],
        python_version=probe["embedded_python_version"], device_requested="cpu", device_detected="cpu",
        precision="double", qualification="NOT VERIFIED",
        device_residency_evidence="attested CPU-only managed container; COMPILECUDA=0; actual -g -1; binary64 ABI witness")


def _publish(repo, runtime_id):
    layout = storage.resolve_layout(repo, "windows-native"); root = legacy.runtime_root(layout, runtime_id)
    with storage.file_lock(root/"observe-v2.lock", "BORIS V2 publication"):
        root, receipt, observed = checked_run(repo, runtime_id)
        if receipt.get("state") == "runtime_succeeded_identity_verified":
            verify_runtime_identity(read_json(root/"export/runtime.json"), repo, root/"export")
            return root/"export/summary.json"
        if receipt.get("state") != "launched_resources_retained":
            raise ValueError("BORIS V2 receipt is not publishable")
        layout = storage.resolve_layout(repo, "windows-native")
        require_window(layout)
        entries, probe = legacy.verified_outputs(root, receipt, observed)
        # No old checked_run/spec/observer is used for this version.
        final = dict(receipt, state="runtime_succeeded_identity_verified", outputs=entries, probe=probe,
                     container_attestation_sha256=attestation_digest(observed),
                     container_attestation_schema=ATTESTATION_SCHEMA)
        raw = (json.dumps(final, indent=2, ensure_ascii=False, allow_nan=False)+"\n").encode()
        if len(raw) > 4 << 20: raise ValueError("BORIS V2 final receipt exceeds bound")
        value = identity(root, final, probe, hashlib.sha256(raw).hexdigest())
        from run_boris_nf_interface import _artifact_summary
        summary = _artifact_summary(root/"export", legacy.fixed_inputs(receipt["resolution"])[0], value, retained_outputs=entries)
        check_tools(repo, root, receipt)
        _, outputs, _, current_binding = resolve_native_build(repo, receipt["build_job_id"])
        if current_binding != receipt["binding"]:
            raise ValueError("BORIS native chain changed during publication")
        check_runtime_support(root, outputs, current_binding, receipt)
        storage.atomic_json(root/"export/runtime.json", value)
        storage.atomic_json(root/"export/summary.json", summary)
        require_window(layout)
        legacy.commit_receipt(root, raw)
        return root/"export/summary.json"


def observe(repo, runtime_id):
    layout = storage.resolve_layout(repo, "windows-native")
    root = legacy.runtime_root(layout, runtime_id)
    receipt = read_json(root/"receipt.json")
    if receipt.get("schema") != SCHEMA or receipt.get("state") != "runtime_succeeded_identity_verified":
        raise ValueError("BORIS V2 external observe is verify-only for terminal success")
    verify_runtime_identity(read_json(root/"export/runtime.json"), repo, root/"export")
    return root/"export/summary.json"


def verify_runtime_identity(value, repo, artifact_root):
    if repo is None or artifact_root is None or value.get("schema_version") != IDENTITY_SCHEMA:
        raise ValueError("BORIS V3 identity requires explicit trusted context")
    root, receipt, observed = checked_run(Path(repo), value.get("runtime_id"))
    if Path(artifact_root).resolve() != root/"export" or receipt.get("state") != "runtime_succeeded_identity_verified":
        raise ValueError("BORIS V3 output owner is not verified terminal")
    entries, probe = legacy.verified_outputs(root, receipt, observed)
    if (receipt.get("container_attestation_schema") != ATTESTATION_SCHEMA
            or receipt.get("outputs") != entries or receipt.get("probe") != probe
            or receipt.get("container_attestation_sha256") != attestation_digest(observed)
            or value != identity(root, receipt, probe)):
        raise ValueError("BORIS V3 terminal closure differs")
    from run_boris_nf_interface import _artifact_summary
    expected = _artifact_summary(root/"export", legacy.fixed_inputs(receipt["resolution"])[0], value, retained_outputs=entries)
    if read_json(root/"export/runtime.json") != value or boris.canonical(read_json(root/"export/summary.json")) != boris.canonical(expected):
        raise ValueError("BORIS V3 diagnostics differ")
    check_tools(Path(repo), root, receipt)
    _, outputs, _, current_binding = resolve_native_build(Path(repo), receipt["build_job_id"])
    if current_binding != receipt["binding"]:
        raise ValueError("BORIS V3 native chain changed during verification")
    check_runtime_support(root, outputs, current_binding, receipt)
    return entries


def run(repo, job_id, resolution):
    repo = Path(repo).resolve(); layout = storage.resolve_layout(repo, "windows-native")
    require_window(layout)
    with runtime_package_use(layout), storage.file_lock(Path(layout["storage_root"])/"locks/fullmag-native-windows-heavy.lock", "BORIS V2 runtime"), storage.build_lock(layout):
        require_window(layout)
        layout, outputs, source, binding = resolve_native_build(repo, job_id)
        # Shared validators must be the frozen reviewed versions used for this native build.
        for name in ("scripts/run_managed_boris_nf.py", "scripts/local_runner/boris_cpu.py"):
            if digest(repo/name) != digest(source/name):
                raise ValueError("BORIS reused helper differs from the verified native capsule")
        image = json.loads(legacy.docker("image", "inspect", binding["image_digest"]))[0]
        if (image.get("Id") != binding["image_digest"] or image.get("Config", {}).get("Volumes")
                or [e for e in image["Config"].get("Env", []) if e.startswith("PYTHONPATH=")] != ["PYTHONPATH=/opt/fullmag-boris-python"]):
            raise ValueError("BORIS immutable image/private wheel path differs")
        _, script, scenario = legacy.fixed_inputs(resolution)
        root = legacy.runtime_root(layout, uuid.uuid4().hex); root.mkdir(parents=True, exist_ok=False)
        receipt = capture_tools(repo, root)
        (root/"input").mkdir(); (root/"export").mkdir()
        (root/"input/scenario.py").write_bytes(script); (root/"input/scenario.json").write_bytes(scenario)
        storage.atomic_json(root/"input/run_input.json", dict(resolution=resolution, binding=binding))
        receipt.update(capture_runtime_support(root, outputs, binding))
        spec = scientific_spec(binding["image_digest"], source, outputs, root/"input", root/"export")
        storage.atomic_json(root/"compose.json", spec)
        receipt.update(schema=SCHEMA, state="starting", qualification="NOT VERIFIED", physics_qualified=False,
                       runtime_id=root.name, build_job_id=job_id, runtime_job_id=job_id, resolution=resolution, binding=binding,
                       input_hashes={n:digest(root/"input"/n) for n in INPUT_NAMES},
                       compose_sha256=digest(root/"compose.json"), compose_project="fullmag-boris-v2-"+root.name)
        storage.atomic_json(root/"receipt.json", receipt)
        # Register before dispatch; unknown versioned consumers remain protective.
        register_runtime_reference_root(layout, root)
        container = None
        try:
            require_window(layout); check_tools(repo, root, receipt)
            check_runtime_support(root, outputs, binding, receipt)
            legacy.docker("compose", "-p", receipt["compose_project"], "-f", root/"compose.json", "create")
            container = legacy.docker("compose", "-p", receipt["compose_project"], "-f", root/"compose.json", "ps", "-a", "-q", "boris")
            receipt["container_id"] = container
            receipt["state"] = "created_unattested_resources_retained"
            storage.atomic_json(root/"receipt.json", receipt)
            attest(container, spec, receipt["compose_project"])
            # Preserve the fixed worker/scenario bytes of the old verified capsule.
            if legacy.fixed_inputs(resolution)[1:] != (script, scenario):
                raise ValueError("BORIS scenario changed before dispatch")
            receipt["state"] = "launched_resources_retained"; storage.atomic_json(root/"receipt.json", receipt)
            require_window(layout); check_tools(repo, root, receipt)
            check_runtime_support(root, outputs, binding, receipt)
            legacy.docker("start", container)
            deadline = time.monotonic()+240
            while time.monotonic() < deadline:
                observed = attest(container, spec, receipt["compose_project"])
                if observed["State"].get("Status") == "exited" and observed["State"].get("Running") is False:
                    return _publish(repo, root.name)
                require_window(layout, container)
                time.sleep(1)
            raise ValueError("BORIS V2 exceeded its fixed 240 second bound")
        except BaseException as error:
            if container:
                observed = attest(container, spec, receipt["compose_project"])
                if observed["State"].get("Running") is True:
                    legacy.docker("stop", "--time", "10", container)
                    observed = attest(container, spec, receipt["compose_project"])
                if observed["State"].get("Running") is not False or observed["State"].get("Status") not in ("created", "exited"):
                    raise ValueError("BORIS exact owned container stop unconfirmed") from error
            current = read_json(root/"receipt.json")
            if current.get("state") != "runtime_succeeded_identity_verified":
                storage.atomic_json(root/"receipt.json", dict(current, state="failed_resources_retained", error=str(error)))
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    actions = parser.add_subparsers(dest="action", required=True)
    p = actions.add_parser("run"); p.add_argument("--job-id", required=True); p.add_argument("--resolution", choices=legacy.RESOLUTIONS, required=True)
    p = actions.add_parser("observe"); p.add_argument("--runtime-id", required=True)
    args = parser.parse_args()
    print(run(args.repo_root, args.job_id, args.resolution) if args.action == "run" else observe(args.repo_root, args.runtime_id))

if __name__ == "__main__": main()
