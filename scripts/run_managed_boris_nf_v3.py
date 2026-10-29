"""Managed common-case v3 inputs/runtime.v4; immutable native BORIS build reuse only."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import time
import uuid

import fullmag_storage as storage
import boris_nf_common_case_v3 as common
import run_managed_boris_nf as legacy
import run_managed_boris_nf_v2 as v2
from local_runner import boris_cpu as boris
from local_runner.runtime_use import runtime_package_use, register_runtime_reference_root

SCHEMA = "fullmag.boris.managed_run.v3"
IDENTITY_SCHEMA = "fullmag.boris.runtime.v4"
NEW_TOOLS = ("scripts/boris_nf_common_case_v3.py", "scripts/run_managed_boris_nf_v3.py")
TOOL_NAMES = sorted((*v2.TOOL_NAMES,*NEW_TOOLS))


def tool_names(repo):
    v2.tool_names(repo)
    return TOOL_NAMES


def check_tools(repo, root, receipt):
    manifest = legacy.read_json(root/"tools/manifest.json")
    names = tool_names(repo)
    if (set(manifest) != {"schema","solver_capsule_attribution","files"}
            or manifest["schema"] != v2.TOOLS_SCHEMA or manifest["solver_capsule_attribution"] is not False
            or receipt.get("tools_manifest_sha256") != legacy.digest(root/"tools/manifest.json")
            or manifest["files"] != LOADED_TOOL_HASHES or sorted(manifest["files"]) != names
            or v2.tool_hashes(root/"tools",names) != manifest["files"]
            or v2.tool_hashes(repo,names) != manifest["files"]):
        raise ValueError("BORIS common loaded/current/retained tools differ")
    if (any(storage.is_link(p) for p in (root/"tools").rglob("*"))
            or {p.relative_to(root/"tools").as_posix() for p in (root/"tools").rglob("*") if p.is_file()} != set(names)|{"manifest.json"}):
        raise ValueError("BORIS common retained tools membership/link differs")
    return manifest


def capture_tools(repo, root):
    names = tool_names(repo); expected = v2.tool_hashes(repo,names)
    if expected != LOADED_TOOL_HASHES:
        raise ValueError("BORIS common source changed after host tool import")
    tools = root/"tools"; tools.mkdir()
    for name in names:
        with (repo/name).open("rb") as stream:
            data = stream.read(v2.MAX_TOOL_BYTES+1)
        if hashlib.sha256(data).hexdigest() != expected[name]:
            raise ValueError("BORIS common tool changed during capture")
        target = tools/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
    storage.atomic_json(tools/"manifest.json",dict(schema=v2.TOOLS_SCHEMA,solver_capsule_attribution=False,files=expected))
    receipt = dict(tools_manifest_sha256=legacy.digest(tools/"manifest.json"))
    check_tools(repo,root,receipt)
    return receipt


def scientific_spec(image, source, outputs, root):
    spec = v2.scientific_spec(image,source,outputs,root/"input",root/"export")
    service = spec["services"]["boris"]
    service["command"] = ["python3","-B","/tools/scripts/boris_nf_common_case_v3.py","_worker"]
    service["environment"]["PYTHONPATH"] = "/tools/scripts:/opt/fullmag-boris/source:/opt/fullmag-boris-python"
    service["volumes"].append(dict(type="bind",source=str((root/"tools").resolve()),target="/tools",read_only=True))
    return spec


def previous_capacity(repo, case_key, family, previous_id):
    index = common.CASE_KEYS.index(case_key)
    if index == 0:
        if previous_id is not None:
            raise ValueError("BORIS common r0 must not inherit a capacity result")
        return None
    previous_id = legacy.identifier(previous_id)
    layout = storage.resolve_layout(repo,"windows-native")
    root = legacy.runtime_root(layout,previous_id)
    receipt = legacy.read_json(root/"receipt.json")
    if (receipt.get("schema") != SCHEMA or receipt.get("case_key") != common.CASE_KEYS[index-1]
            or receipt.get("family_binding") != family or receipt.get("state") != "runtime_succeeded_identity_verified"):
        raise ValueError("BORIS common previous capacity has a different native/worker/parameter/geometry/resource family")
    value = legacy.read_json(root/"export/runtime.json")
    entries = verify_runtime_identity(value,repo,root/"export")
    return dict(runtime_id=previous_id,case_key=receipt["case_key"],runtime_receipt_sha256=legacy.digest(root/"receipt.json"),
        runtime_identity_sha256=legacy.digest(root/"export/runtime.json"),outputs_sha256=common.canonical_hash(entries),
        family_binding_sha256=common.canonical_hash(family),scope="successful prior capacity/raw completion; not physics qualification")


def worker_input(receipt):
    return dict(schema="fullmag.boris_nf_common.input.v3",case_key=receipt["case_key"],binding=receipt["binding"],
        tools_manifest_sha256=receipt["tools_manifest_sha256"],family_binding=receipt["family_binding"],
        previous_capacity=receipt["previous_capacity"])


def checked_run(repo, runtime_id):
    layout = storage.resolve_layout(repo,"windows-native"); root = legacy.runtime_root(layout,runtime_id)
    receipt = legacy.read_json(root/"receipt.json")
    if (receipt.get("schema") != SCHEMA or receipt.get("runtime_id") != root.name
            or receipt.get("qualification") != "NOT VERIFIED" or receipt.get("physics_qualified") is not False
            or receipt.get("runtime_job_id") != receipt.get("build_job_id")):
        raise ValueError("BORIS common versioned runtime receipt differs")
    base_keys = {"schema","state","qualification","physics_qualified","runtime_id","build_job_id","runtime_job_id",
        "case_key","case_sha256","binding","family_binding","previous_capacity","tools_manifest_sha256",
        "runtime_support","runtime_support_sha256","input_hashes","compose_sha256","compose_project","container_id"}
    terminal_keys = {"outputs","probe","capacity_gate","container_attestation_sha256","container_attestation_schema"}
    if (receipt.get("state") not in ("launched_resources_retained","runtime_succeeded_identity_verified")
            or set(receipt) != base_keys | (terminal_keys if receipt["state"] == "runtime_succeeded_identity_verified" else set())):
        raise ValueError("BORIS common closed receipt membership/state differs")
    check_tools(repo,root,receipt)
    _,outputs,source,binding = v2.resolve_native_build(repo,receipt["build_job_id"])
    if binding != receipt.get("binding"):
        raise ValueError("BORIS common native binding changed")
    common.verify_source_contract(binding["boris_build_proof"])
    family = common.family_binding(binding,receipt["tools_manifest_sha256"],legacy.digest(root/"tools"/NEW_TOOLS[0]))
    descriptor,script,scenario = common.fixed_inputs(receipt["case_key"])
    previous = receipt.get("previous_capacity")
    prior_id = previous.get("runtime_id") if isinstance(previous,dict) else None
    if (receipt.get("family_binding") != family or receipt.get("case_sha256") != common.canonical_hash(descriptor)
            or previous != previous_capacity(repo,receipt["case_key"],family,prior_id)):
        raise ValueError("BORIS common actual capacity/input family differs")
    v2.check_runtime_support(root,outputs,binding,receipt)
    if ((root/"input/scenario.py").read_bytes() != script or (root/"input/scenario.json").read_bytes() != scenario
            or legacy.read_json(root/"input/run_input.json") != worker_input(receipt)
            or receipt.get("input_hashes") != {n:legacy.digest(root/"input"/n) for n in v2.INPUT_NAMES}):
        raise ValueError("BORIS common captured closed input differs")
    spec = scientific_spec(binding["image_digest"],source,outputs,root)
    if (receipt.get("compose_sha256") != legacy.digest(root/"compose.json") or legacy.read_json(root/"compose.json") != spec
            or receipt.get("compose_project") != "fullmag-boris-common-v3-"+root.name):
        raise ValueError("BORIS common fixed spec differs")
    return root,receipt,v2.attest(receipt["container_id"],spec,receipt["compose_project"])


def verified_outputs(root, receipt, observed):
    state = observed["State"]
    if (state.get("Status") != "exited" or state.get("Running") is not False or type(state.get("ExitCode")) is not int
            or state["ExitCode"] != 0 or state.get("OOMKilled") is not False or state.get("Error")):
        raise ValueError("BORIS common owned container is not successful terminal")
    binding = receipt["binding"]; proof = binding["boris_build_proof"]
    entries,probe,_ = common.validate_outputs(root/"export",common.case_descriptor(receipt["case_key"]),proof)
    expected = {"binary_sha256","binary_version","external_python_version","embedded_python_version","solver_exit_code",
        "solver_exit_protocol","device","precision_abi","numpy_version","matplotlib_version"}
    if (set(probe) != expected or any(not isinstance(probe.get(k),str) or not probe[k] for k in
            ("binary_version","external_python_version","embedded_python_version","numpy_version","matplotlib_version"))
            or "BORIS" not in probe["binary_version"] or probe.get("device") != "cpu"
            or probe.get("binary_sha256") != proof["binary_sha256"]
            or probe.get("precision_abi") != boris.abi_binding(dict(job_id=receipt["build_job_id"],source_digest=binding["source_digest"],
                image_digest=binding["image_digest"]),proof["compile_flags_sha256"],proof["cuda_flags_sha256"],boris.ABI_FACTS)):
        raise ValueError("BORIS common actual version/import/CPU double ABI probe differs")
    manifests = [json.loads(line) for line in legacy.docker("logs",receipt["container_id"]).splitlines()
                 if line.startswith('{"schema": "'+common.CLOSURE_SCHEMA+'"')]
    if manifests != [dict(schema=common.CLOSURE_SCHEMA,outputs=entries)]:
        raise ValueError("BORIS common actual worker output closure differs")
    return entries,probe


def capacity_gate(observed):
    host,state = observed["HostConfig"],observed["State"]
    if (host.get("Memory") != (2 << 30) or host.get("NanoCpus") != 2_000_000_000
            or state.get("Status") != "exited" or state.get("Running") is not False
            or type(state.get("ExitCode")) is not int or state["ExitCode"] != 0
            or state.get("OOMKilled") is not False or state.get("Error")):
        raise ValueError("BORIS common actual terminal capacity gate failed")
    return dict(actual_memory_limit_bytes=host["Memory"],actual_nanocpus=host["NanoCpus"],
        actual_pids_limit=host["PidsLimit"],actual_terminal_state=state,
        scope="actual complete raw run in attested limits; not peak-memory measurement or physics qualification")


def identity(root, receipt, probe, receipt_sha=None):
    binding = receipt["binding"]; proof = binding["boris_build_proof"]
    return dict(schema_version=IDENTITY_SCHEMA,identity_complete=True,managed_run_schema=SCHEMA,
        runtime_id=root.name,runtime_receipt_sha256=receipt_sha or legacy.digest(root/"receipt.json"),
        build_job_id=receipt["build_job_id"],case_key=receipt["case_key"],case_sha256=receipt["case_sha256"],
        family_binding_sha256=common.canonical_hash(receipt["family_binding"]),previous_capacity=receipt["previous_capacity"],
        tools_manifest_sha256=receipt["tools_manifest_sha256"],runtime_support_sha256=receipt["runtime_support_sha256"],
        native_source_digest=binding["source_digest"],solver_capsule_attribution=False,
        binary_sha256=proof["binary_sha256"],source_manifest_sha256=binding["source_manifest_sha256"],image_digest=binding["image_digest"],
        binary_version=probe["binary_version"],python_version=probe["embedded_python_version"],device_requested="cpu",device_detected="cpu",
        precision="double",qualification="NOT VERIFIED",physics_qualified=False,
        device_residency_evidence="attested CPU-only container; COMPILECUDA=0; actual -g -1; pinned binary64 ABI witness")


def verify_runtime_identity(value, repo, artifact_root):
    if repo is None or artifact_root is None or value.get("schema_version") != IDENTITY_SCHEMA:
        raise ValueError("BORIS common runtime.v4 requires explicit trusted owner context")
    repo = Path(repo).resolve(); root,receipt,observed = checked_run(repo,value.get("runtime_id"))
    if Path(artifact_root).resolve() != root/"export" or receipt.get("state") != "runtime_succeeded_identity_verified":
        raise ValueError("BORIS common output owner is not verified terminal")
    entries,probe = verified_outputs(root,receipt,observed)
    expected = common.artifact_summary(root/"export",common.case_descriptor(receipt["case_key"]),value,entries)
    if (receipt.get("outputs") != entries or receipt.get("probe") != probe or value != identity(root,receipt,probe)
            or receipt.get("capacity_gate") != capacity_gate(observed)
            or receipt.get("container_attestation_schema") != v2.ATTESTATION_SCHEMA
            or receipt.get("container_attestation_sha256") != v2.attestation_digest(observed)
            or legacy.read_json(root/"export/runtime.json") != value
            or boris.canonical(legacy.read_json(root/"export/summary.json")) != boris.canonical(expected)):
        raise ValueError("BORIS common terminal receipt/raw closure/identity/summary differs")
    check_tools(repo,root,receipt)
    return entries


def _publish(repo, runtime_id):
    layout = storage.resolve_layout(repo,"windows-native"); root = legacy.runtime_root(layout,runtime_id)
    with storage.file_lock(root/"observe-common-v3.lock","BORIS common publication"):
        root,receipt,observed = checked_run(repo,runtime_id)
        if receipt.get("state") == "runtime_succeeded_identity_verified":
            return observe(repo,runtime_id)
        if receipt.get("state") != "launched_resources_retained":
            raise ValueError("BORIS common receipt is not publishable")
        v2.require_window(layout)
        entries,probe = verified_outputs(root,receipt,observed)
        final = dict(receipt,state="runtime_succeeded_identity_verified",outputs=entries,probe=probe,capacity_gate=capacity_gate(observed),
            container_attestation_sha256=v2.attestation_digest(observed),container_attestation_schema=v2.ATTESTATION_SCHEMA)
        raw = (json.dumps(final,ensure_ascii=False,indent=2,allow_nan=False)+"\n").encode()
        if len(raw)>4<<20:
            raise ValueError("BORIS common terminal receipt exceeds bound")
        value = identity(root,final,probe,hashlib.sha256(raw).hexdigest())
        summary = common.artifact_summary(root/"export",common.case_descriptor(receipt["case_key"]),value,entries)
        checked_run(repo,runtime_id)
        storage.atomic_json(root/"export/runtime.json",value); storage.atomic_json(root/"export/summary.json",summary)
        v2.require_window(layout); check_tools(repo,root,receipt)
        legacy.commit_receipt(root,raw)
        return root/"export/summary.json"


def observe(repo, runtime_id):
    layout = storage.resolve_layout(repo,"windows-native"); root = legacy.runtime_root(layout,runtime_id)
    receipt = legacy.read_json(root/"receipt.json")
    if receipt.get("schema") != SCHEMA or receipt.get("state") != "runtime_succeeded_identity_verified":
        raise ValueError("BORIS common observe is verify-only for its own terminal version")
    verify_runtime_identity(legacy.read_json(root/"export/runtime.json"),repo,root/"export")
    return root/"export/summary.json"


def run(repo, job_id, case_key, previous_runtime_id=None):
    repo = Path(repo).resolve(); job_id = legacy.identifier(job_id)
    descriptor,script,scenario = common.fixed_inputs(case_key)
    if case_key == "r0":
        if previous_runtime_id is not None:
            raise ValueError("BORIS common r0 must not inherit capacity")
    else:
        previous_runtime_id = legacy.identifier(previous_runtime_id)
    layout = storage.resolve_layout(repo,"windows-native"); v2.require_window(layout)
    with runtime_package_use(layout), storage.file_lock(Path(layout["storage_root"])/"locks/fullmag-native-windows-heavy.lock","BORIS common runtime"), storage.build_lock(layout):
        v2.require_window(layout)
        layout,outputs,source,binding = v2.resolve_native_build(repo,job_id)
        common.verify_source_contract(binding["boris_build_proof"])
        for name in ("scripts/run_managed_boris_nf.py","scripts/local_runner/boris_cpu.py"):
            if legacy.digest(repo/name) != legacy.digest(source/name):
                raise ValueError("BORIS common reused native helper differs from immutable native capsule")
        image = json.loads(legacy.docker("image","inspect",binding["image_digest"]))[0]
        if (image.get("Id") != binding["image_digest"] or image.get("Config",{}).get("Volumes")
                or [e for e in image["Config"].get("Env",[]) if e.startswith("PYTHONPATH=")] != ["PYTHONPATH=/opt/fullmag-boris-python"]):
            raise ValueError("BORIS common immutable image/private dependency path differs")
        root = legacy.runtime_root(layout,uuid.uuid4().hex); root.mkdir(parents=True,exist_ok=False)
        receipt = capture_tools(repo,root)
        family = common.family_binding(binding,receipt["tools_manifest_sha256"],legacy.digest(root/"tools"/NEW_TOOLS[0]))
        previous = previous_capacity(repo,case_key,family,previous_runtime_id)
        (root/"input").mkdir(); (root/"export").mkdir()
        receipt.update(schema=SCHEMA,state="starting",qualification="NOT VERIFIED",physics_qualified=False,
            runtime_id=root.name,build_job_id=job_id,runtime_job_id=job_id,case_key=case_key,
            case_sha256=common.canonical_hash(descriptor),binding=binding,family_binding=family,previous_capacity=previous)
        (root/"input/scenario.py").write_bytes(script); (root/"input/scenario.json").write_bytes(scenario)
        storage.atomic_json(root/"input/run_input.json",worker_input(receipt))
        receipt.update(v2.capture_runtime_support(root,outputs,binding))
        spec = scientific_spec(binding["image_digest"],source,outputs,root)
        storage.atomic_json(root/"compose.json",spec)
        receipt.update(input_hashes={n:legacy.digest(root/"input"/n) for n in v2.INPUT_NAMES},
            compose_sha256=legacy.digest(root/"compose.json"),compose_project="fullmag-boris-common-v3-"+root.name)
        storage.atomic_json(root/"receipt.json",receipt)
        register_runtime_reference_root(layout,root)
        container = None
        try:
            v2.require_window(layout); check_tools(repo,root,receipt); v2.check_runtime_support(root,outputs,binding,receipt)
            legacy.docker("compose","-p",receipt["compose_project"],"-f",root/"compose.json","create")
            container = legacy.docker("compose","-p",receipt["compose_project"],"-f",root/"compose.json","ps","-a","-q","boris")
            receipt.update(container_id=container,state="created_unattested_resources_retained"); storage.atomic_json(root/"receipt.json",receipt)
            v2.attest(container,spec,receipt["compose_project"])
            if common.fixed_inputs(case_key)[1:] != (script,scenario):
                raise ValueError("BORIS common generated input changed before dispatch")
            receipt["state"]="launched_resources_retained"; storage.atomic_json(root/"receipt.json",receipt)
            checked_run(repo,root.name); v2.require_window(layout)
            legacy.docker("start",container)
            deadline = time.monotonic()+common.RUNTIME_TIMEOUT_SECONDS
            while time.monotonic()<deadline:
                observed = v2.attest(container,spec,receipt["compose_project"])
                if observed["State"].get("Status")=="exited" and observed["State"].get("Running") is False:
                    return _publish(repo,root.name)
                v2.require_window(layout,container); time.sleep(1)
            raise ValueError("BORIS common runtime exceeded fixed 240 second bound")
        except BaseException as error:
            if container:
                observed = v2.attest(container,spec,receipt["compose_project"])
                if observed["State"].get("Running") is True:
                    legacy.docker("stop","--time","10",container)
                    observed = v2.attest(container,spec,receipt["compose_project"])
                if observed["State"].get("Running") is not False or observed["State"].get("Status") not in ("created","exited"):
                    raise ValueError("BORIS common exact owned container stop unconfirmed") from error
            current = legacy.read_json(root/"receipt.json")
            if current.get("state") != "runtime_succeeded_identity_verified":
                storage.atomic_json(root/"receipt.json",dict(current,state="failed_resources_retained",error=str(error)))
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root",required=True,type=Path)
    actions = parser.add_subparsers(dest="action",required=True)
    p = actions.add_parser("run"); p.add_argument("--job-id",required=True); p.add_argument("--case",choices=common.CASE_KEYS,required=True)
    p.add_argument("--previous-runtime-id",default="")
    p = actions.add_parser("observe"); p.add_argument("--runtime-id",required=True)
    args = parser.parse_args()
    print(run(args.repo_root,args.job_id,args.case,args.previous_runtime_id or None) if args.action=="run" else observe(args.repo_root,args.runtime_id))


# Capture imported host-tool bytes before dispatch; every later boundary rechecks them.
LOADED_TOOL_HASHES = dict(v2.tool_hashes(Path(v2.__file__).resolve().parents[1],list(v2.TOOL_NAMES)),
    **{NEW_TOOLS[0]:legacy.digest(Path(common.__file__)),NEW_TOOLS[1]:legacy.digest(Path(__file__))})

if __name__ == "__main__": main()
