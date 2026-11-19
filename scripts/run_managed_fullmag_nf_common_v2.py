"""Run the fixed Fullmag N/F matrix using a terminal native package and separate tools.

The worker imports only stdlib and the pinned public reference/DSL. Host admission
reuses existing owners. No build, arbitrary command, port or persistence claim.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import uuid

PROFILE = "managed-transport-oracles-ram-cpu"
SCHEMA = "fullmag.managed-fullmag-nf.v2"
OUTPUT_SCHEMA = "fullmag.managed-fullmag-nf.outputs.v2"
TOOLS = ("run_managed_fullmag_nf_common_v2.py", "run_fullmag_m2_nf_common_case_v3.py", "boris_nf_common_case_v3.py", "verify_boris_nf_interface.py")
REFERENCE = TOOLS[1]
LANE = {"backend": "fdm", "device": "cpu", "precision": "double", "mode": "strict"}
SHAPES = (("r0", (4, 100, 2, 2)), ("r1", (4, 200, 4, 4)), ("r2", (4, 400, 8, 8)))
TOLERANCES = (1.0e-8, 1.0e-10)
MAX_JSON = 4 << 20
MAX_MEMBER = 64 << 20
MAX_TOTAL = 256 << 20
RUN_SECONDS = 2100


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


_LOADED_SOURCE_SHA256 = sha(Path(__file__))


def member(root, name, limit=MAX_MEMBER, *, empty=False):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError("Invalid N/F relative member")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("N/F members must remain inside their owned root")
    path = Path(root)
    root_info = path.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode) or getattr(root_info, "st_file_attributes", 0) & 0x400:
        raise ValueError("N/F root must be a real directory")
    for part in parts:
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("N/F member contains a link or reparse point")
    if not stat.S_ISREG(info.st_mode) or not (0 if empty else 1) <= info.st_size <= limit:
        raise ValueError("N/F member missing, empty or oversized")
    return path


def read(root, name, limit=MAX_JSON):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("Duplicate N/F JSON key")
            value[key] = item
        return value
    with member(root, name, limit).open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("N/F JSON grew beyond its byte budget")
    value = json.loads(raw.decode("utf-8"),
        object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite N/F JSON")))
    if not isinstance(value, dict):
        raise ValueError("N/F JSON must be an object")
    return value


def write(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def cases():
    from boris_nf_common_case_v3 import case_descriptor
    return [{"name": name, "shape": list(shape), "cell_m": case_descriptor(name)["geometry"]["cell_m"],
             "common_case": case_descriptor(name), "tolerance": tolerance,
             "key": f"{name}__tol-{tolerance:.0e}"}
            for name, shape in SHAPES for tolerance in TOLERANCES]


def closure(root):
    result, total = {}, 0
    for path in sorted(Path(root).rglob("*")):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("N/F output contains a link or reparse point")
        if stat.S_ISDIR(info.st_mode):
            continue
        name = path.relative_to(root).as_posix()
        member(root, name, empty=name.endswith("/fullmag.stderr.log"))
        total += info.st_size
        result[name] = {"size": info.st_size, "sha256": sha(path)}
        if len(result) > 512 or total > MAX_TOTAL:
            raise ValueError("N/F output closure exceeds its fixed bound")
    return result


def check_tools(root, contract):
    if (contract.get("schema") != SCHEMA or contract.get("solver_capsule_attribution") is not False
            or contract.get("cases") != cases() or contract.get("lane") != LANE
            or set(contract.get("tools_sha256", {})) != set(TOOLS)):
        raise ValueError("N/F tool/input contract differs")
    if {path.name for path in Path(root).iterdir()} != set(TOOLS) | {"manifest.json"}:
        raise ValueError("N/F tool directory membership differs")
    if {name: sha(member(root, name, MAX_JSON)) for name in TOOLS} != contract["tools_sha256"]:
        raise ValueError("N/F runtime tool bytes changed")


def check_public_source(source, contract):
    files = contract.get("public_dsl_sha256")
    if not isinstance(files, dict) or not files or any(
            not name.startswith("packages/fullmag-py/") for name in files):
        raise ValueError("N/F public DSL closure missing")
    if {name: sha(member(source, name)) for name in files} != files:
        raise ValueError("N/F frozen public DSL changed")
    binary = Path("/package/bin/fullmag-bin")
    if sha(binary) != contract["binary_sha256"]:
        raise ValueError("N/F native binary differs")


def validate_case(root, case, contract, reference):
    request = read(root, "request.json")
    ir = read(root, "problem_ir.json")
    metadata = read(root, "metadata.json", MAX_MEMBER)
    raw = read(root, "transport/spin_transport_accepted.json", MAX_MEMBER)
    normalized = read(root, "transport/fullmag_m2_nf_reference.json", MAX_MEMBER)
    expected_request = reference.build_fullmag_nf_problem(reference.Resolution(
        *case["shape"], tuple(case["cell_m"]), solver_tolerance=case["tolerance"]), include_geometry_assets=True)
    if request.get("common_case") != case["common_case"] or request.get("transport") != expected_request["transport"] or ir != expected_request["problem_ir"]:
        raise ValueError("common-case authored IR/parameters/BC differ from the fixed public request")
    shape = case["shape"]
    expected_mesh = {"shape": [shape[0], shape[1], shape[2] + shape[3]],
        "origin_m": [-shape[0] * case["cell_m"][0] / 2.0, -shape[1] * case["cell_m"][1] / 2.0,
                     -(shape[2] + shape[3]) * case["cell_m"][2] / 2.0],
        "step_m": case["cell_m"]}
    registration = reference.mesh_registration(reference.Resolution(*shape, tuple(case["cell_m"])))
    resolution = metadata.get("execution_provenance", {}).get("execution_resolution", {})
    provenance = metadata.get("execution_provenance", {})
    identity = request.get("runtime_identity", {})
    native = contract["native_source_identity"]
    build = metadata.get("build_identity", {})
    if (request.get("schema_version") != "fullmag.boris_fullmag_she_nf.request.v3"
            or request.get("problem_ir") != ir or request.get("execution") != {
                "discretization": "fdm", **{key: LANE[key] for key in ("device", "precision", "mode")}}
            or request.get("mesh") != expected_mesh or request.get("sample_registration") != registration
            or normalized.get("mesh") != expected_mesh
            or request.get("transport", {}).get("solver", {}).get("linear_relative_tolerance") != case["tolerance"]
            or metadata.get("status") != "completed" or provenance.get("execution_engine") != "cpu_reference"
            or provenance.get("precision") != "double" or resolution.get("resolved_execution") != LANE
            or resolution.get("effective_request") != LANE or resolution.get("fallback_occurred") is not False
            or resolution.get("fallback_reason") is not None
            or build.get("git_commit") != native["head_commit_full"]
            or build.get("source_snapshot_sha256") != native["source_snapshot_sha256"]
            or build.get("worktree_state") != ("dirty" if native["source_snapshot_dirty"] else "clean")
            or identity.get("launcher") != "/package/bin/fullmag-bin"
            or identity.get("launcher_sha256") != contract["binary_sha256"]
            or identity.get("native_binary_sha256") != contract["binary_sha256"]
            or raw.get("schema") != "fullmag.fdm.spin_transport.accepted.v1"
            or normalized.get("runtime_identity") != identity):
        raise ValueError("N/F request/actual execution/native identity differs")
    # Native metadata and raw m share the resolved plan; the accepted transport
    # format has no independent grid header, so bind every array to that plan.
    layout = metadata.get("artifact_layout", {})
    plan = metadata.get("execution_plan", {}).get("backend_plan", {})
    expected_mask = [False] * (shape[0] * shape[1] * shape[2]) + [True] * (shape[0] * shape[1] * shape[3])
    if (layout.get("backend") != "fdm" or plan.get("kind") != "fdm"
            or layout.get("grid_cells") != expected_mesh["shape"] or plan.get("grid", {}).get("cells") != expected_mesh["shape"]
            or layout.get("active_mask") != expected_mask or plan.get("active_mask") != expected_mask
            or any(type(value) is not bool for value in layout.get("active_mask", []) + plan.get("active_mask", []))):
        raise ValueError("N/F actual magnetic/transport grid differs")
    for actual in (layout, plan):
        for key, expected in (("origin_m", expected_mesh["origin_m"]), ("cell_size", expected_mesh["step_m"])):
            values = actual.get(key)
            if (not isinstance(values, list) or len(values) != 3 or any(type(value) not in (int, float)
                    or not math.isfinite(value) or not math.isclose(value, target, rel_tol=1e-12, abs_tol=1e-18)
                    for value, target in zip(values, expected))):
                raise ValueError("N/F actual grid origin/step differs")
    modules = provenance.get("transport_modules")
    if not isinstance(modules, list) or len(modules) != 1 or any(modules[0].get(key) != value for key, value in (
            ("resolved_discretization", "fdm"), ("resolved_device", "cpu"),
            ("resolved_precision", "double"), ("resolved_execution_mode", "strict"),
            ("operator_version", request["transport"]["solver"]["operator_version"]))):
        raise ValueError("N/F actual transport realization differs")
    fixed = reference.validate_fixed_m_outputs(root,
        reference.Resolution(*shape, tuple(case["cell_m"]), solver_tolerance=case["tolerance"]))
    if read(root, "fixed_m.json") != fixed:
        raise ValueError("N/F fixed-M proof differs from retained raw fields")
    actual_modules = raw.get("evaluation", {}).get("modules")
    if not isinstance(actual_modules, list) or len(actual_modules) != 1 or not isinstance(actual_modules[0], dict):
        raise ValueError("N/F accepted transport module is missing")
    module = actual_modules[0]
    if (module.get("module_id") != "spin" or module.get("current_source_id") != "charge"
            or module.get("runtime_owner") != "fdm_cpu_rust_coupled_transport_reference_v1"
            or module.get("transport_realization") != "rust_reference_v1" or module.get("fallback_used") is not False):
        raise ValueError("N/F accepted transport owner differs")
    for name, width in (("potential_volts", 1), ("spin_potential_volts", 3),
            ("current_density_apm2", 3), ("spin_current_tensor_apm2", 9), ("transport_torque_per_s", 3)):
        values = module.get(name)
        if (not isinstance(values, list) or len(values) != math.prod(expected_mesh["shape"])
                or normalized.get(name) != values or any(
                    not isinstance(row, list) or len(row) != width or any(
                        type(value) not in (int, float) or not math.isfinite(value) for value in row)
                    for row in ([[value] for value in values] if width == 1 else values))):
            raise ValueError("N/F accepted field differs from the actual grid or normalized values: " + name)
    transports = plan.get("spin_transport_plans")
    if not isinstance(transports, list) or len(transports) != 1:
        raise ValueError("common-case native plan has no unique transport descriptor")
    descriptor = transports[0].get("fdm_cpu_double_reciprocal", {})
    if descriptor.get("descriptor_schema") != "fullmag.fdm.coupled_spin_transport_descriptor.v2" or descriptor.get("magnetic_active_mask") != expected_mask or any(type(v) is not bool for v in descriptor.get("magnetic_active_mask", [])):
        raise ValueError("common-case requires actual M2 magnetic-active-mask v2")
    reciprocal = descriptor.get("reciprocal_materials")
    if not isinstance(reciprocal, list) or len(reciprocal) != len(expected_mask):
        raise ValueError("common-case native reciprocal material table differs")
    for magnetic, material in zip(expected_mask, reciprocal):
        if (material.get("polarization_p") != (-0.4 if magnetic else 0.0)
                or material.get("theta_sh") != (0.0 if magnetic else -0.1)
                or material.get("sigma_Spm") != 5.8e7 or material.get("sigma_spin_Spm") != 5.8e7):
            raise ValueError("common-case native signed constitutive coefficients differ")
    charge_boundaries = descriptor.get("charge_boundaries")
    expected_charge = {"x_min":{"kind":"voltage","potential_V":0.0},
        "x_max":{"kind":"voltage","potential_V":case["common_case"]["boundary"]["voltage_v"]},
        **{face:{"kind":"insulating"} for face in ("y_min","y_max","z_min","z_max")}}
    if not isinstance(charge_boundaries,list) or len(charge_boundaries)!=6 or {v.get("face"):v.get("condition") for v in charge_boundaries}!=expected_charge:
        raise ValueError("common-case actual native Voltage pairing differs")
    interfaces = descriptor.get("interfaces")
    plane = shape[0] * shape[1]
    if (not isinstance(interfaces,list) or len(interfaces)!=plane
            or {v.get("from_cell") for v in interfaces} != set(range(plane*(shape[2]-1),plane*shape[2]))
            or any(v.get("to_cell")!=v.get("from_cell",-plane)+plane or any(
                v.get("law",{}).get(name)!=value for name,value in (("kind","mixing_conductance"),
                    ("g_up_Spm2",0.0),("g_down_Spm2",5e14),("g_r_Spm2",1.5e15),("g_i_Spm2",0.0))) for v in interfaces)):
        raise ValueError("common-case actual native signed interface channels/grid differ")
    actual_boundaries = descriptor.get("spin_boundaries")
    if not isinstance(actual_boundaries, list) or len(actual_boundaries) != 6:
        raise ValueError("common-case native spin-boundary inventory differs")
    expected_conditions = {"x_min":"homogeneous_spin_potential_gradient", "x_max":"homogeneous_spin_potential_gradient",
                           "y_min":"spin_insulating", "y_max":"spin_insulating",
                           "z_min":"spin_insulating", "z_max":"spin_insulating"}
    if {entry.get("face"):entry.get("condition",{}).get("kind") for entry in actual_boundaries} != expected_conditions:
        raise ValueError("common-case native spin boundary is not the full common BVP")
    field_gates = reference.validate_common_fields(module, resolution=reference.Resolution(*shape, tuple(case["cell_m"]), solver_tolerance=case["tolerance"]))
    currents = module["current_density_apm2"]
    actual_mean_j = [sum(row[axis] for row in currents) / len(currents) for axis in range(3)]
    return {"key": case["key"], "tolerance": case["tolerance"], "request_sha256": sha(member(root, "request.json")),
        "problem_ir_sha256": sha(member(root, "problem_ir.json")),
        "metadata_sha256": sha(member(root, "metadata.json")), "fixed_m": fixed,
        "sample_registration": registration, "common_case": case["common_case"],
        "field_gates": field_gates, "actual_volume_mean_current_apm2": actual_mean_j}


def execute():
    tools, source, export = Path("/tools"), Path("/source"), Path("/export")
    contract = read(tools, "manifest.json")
    check_tools(tools, contract)
    check_public_source(source, contract)
    sys.path[:0] = [str(tools), str(source / "packages/fullmag-py/src")]
    import run_fullmag_m2_nf_common_case_v3 as reference
    work, results = Path("/ram/workspace"), Path("/ram/results")
    (work / ".fullmag").mkdir(parents=True)
    results.mkdir()
    os.chdir(work)
    verified = []
    try:
        for case in cases():
            directory = results / case["key"]
            reference.run_fullmag_nf_reference(Path("/package/bin/fullmag-bin"),
                reference.Resolution(*case["shape"], tuple(case["cell_m"]), solver_tolerance=case["tolerance"]), directory)
            verified.append(validate_case(directory, case, contract, reference))
        check_public_source(source, contract)
        check_tools(tools, contract)
    finally:
        # Retain bounded real diagnostics also when the public reference fails.
        closure(results)
        shutil.copytree(results, export / "result")
    write(export / "summary.json", {"schema": OUTPUT_SCHEMA, "cases": verified,
        "physics_qualified": False, "durable_session_storage_qualified": False})
    print(json.dumps({"schema": OUTPUT_SCHEMA, "outputs": closure(export)}, sort_keys=True), flush=True)


def host_policy(repo):
    paths = {Path(__file__).resolve()}
    for module in tuple(sys.modules.values()):
        value = getattr(module, "__file__", None)
        if value and str(value).endswith(".py"):
            path = Path(value).resolve()
            if path.is_relative_to(repo):
                paths.add(path)
    result = {path.relative_to(repo).as_posix(): sha(member(repo, path.relative_to(repo).as_posix()))
              for path in sorted(paths)}
    for module in tuple(sys.modules.values()):
        value, loaded = getattr(module, "__file__", None), getattr(module, "_LOADED_SOURCE_SHA256", None)
        if value and loaded is not None and Path(value).resolve() in paths:
            if sha(Path(value).resolve()) != loaded:
                raise ValueError("N/F loaded source differs from its current file")
    return result


def nf_spec(image, source, package, inputs, export, tools):
    import run_managed_antenna_ram as ram
    spec = ram.scientific_spec(image, source, package, inputs, export)
    service = spec["services"]["antenna"]
    service["volumes"].append({"type": "bind", "source": str(tools.resolve()), "target": "/tools", "read_only": True})
    service["command"] = ["python3", "-I", "-B", "/tools/run_managed_fullmag_nf_common_v2.py", "execute"]
    return spec


def require_pin(result, expected):
    root = Path(result["run_root"])
    if (sha(member(root, "receipt.json", MAX_JSON)) != expected["receipt_sha256"]
            or closure(root / "export") != expected["outputs"]):
        raise ValueError("N/F admitted result bytes changed")


def run(repo, binding):
    if sys.platform != "win32":
        raise ValueError("Managed N/F host admission is Windows-only")
    for key, size in (("job_id", 32), ("commit", 40), ("source_digest", 64), ("native_snapshot_sha256", 64)):
        if not isinstance(binding.get(key), str) or re.fullmatch(f"[a-f0-9]{{{size}}}", binding[key]) is None:
            raise ValueError("Full managed N/F build pin required: " + key)
    if set(binding) != {"job_id", "commit", "source_digest", "native_snapshot_sha256"}:
        raise ValueError("Unknown managed N/F build input")
    import fullmag_storage as storage
    import run_managed_antenna_ram as ram
    from run_managed_antenna_http_ram import require_browser_window
    from run_managed_browser import docker
    from verify_saved_fem_archive_roundtrip import check_stamp
    from local_runner.runtime_use import runtime_package_use
    import run_fullmag_m2_nf_common_case_v3 as reference
    repo = Path(repo).resolve()
    for name, expected in _INITIAL_HOST_POLICY.items():
        if sha(member(repo, name)) != expected:
            raise ValueError("N/F host tools changed after import: " + name)
    layout = storage.resolve_layout(repo, PROFILE)
    require_browser_window(layout)
    with runtime_package_use(layout), storage.file_lock(Path(layout["storage_root"]) / "locks/fullmag-native-windows-heavy.lock", "fixed Fullmag N/F matrix"), storage.build_lock(layout):
        require_browser_window(layout)
        _, build, context, built, capsule, package = ram.resolved_build(repo,
            binding["job_id"], binding["commit"], binding["source_digest"], binding["native_snapshot_sha256"])
        source = capsule / "tree"
        manifest = ram.verify_source(capsule, binding["source_digest"])
        public_files = {entry["path"]: entry["sha256"] for entry in manifest["files"]
                        if entry["path"].startswith("packages/fullmag-py/")}
        if not public_files or any(sha(member(repo, name)) != digest for name, digest in public_files.items()):
            raise ValueError("host public DSL differs from the frozen native capsule public DSL")
        image = json.loads(docker("image", "inspect", context["image_digest"]))[0]
        if image.get("Id") != context["image_digest"] or image.get("Config", {}).get("Volumes"):
            raise ValueError("N/F installed build image differs or has anonymous volumes")
        storage.initialize(layout)
        root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex, Path(layout["build_storage_root"]))
        root.mkdir(parents=True, exist_ok=False)
        for name in ("input", "tools", "export"):
            (root / name).mkdir()
        for name in TOOLS:
            shutil.copyfile(member(repo / "scripts", name, MAX_JSON), root / "tools" / name)
        contract = {"schema": SCHEMA, "solver_capsule_attribution": False, "cases": cases(), "lane": LANE,
            "tools_sha256": {name: sha(root / "tools" / name) for name in TOOLS},
            "public_dsl_sha256": public_files, "binary_sha256": sha(package / "bin/fullmag-bin"),
            "native_source_identity": built["native_source_identity"]}
        write(root / "tools/manifest.json", contract)
        check_tools(root / "tools", contract)
        policy = host_policy(repo)
        spec = nf_spec(context["image_digest"], source, package, root / "input", root / "export", root / "tools")
        storage.atomic_json(root / "compose.json", spec)
        project = "fullmag-nf-" + root.name
        receipt = {"schema": SCHEMA, "run_root": str(root), "state": "starting", "binding": binding,
            "native_source_identity": built["native_source_identity"], "image_digest": context["image_digest"],
            "binary_sha256": contract["binary_sha256"], "build_receipt_sha256": sha(build / "artifacts/build-receipt.json"),
            "tool_manifest_sha256": sha(root / "tools/manifest.json"), "tools_sha256": contract["tools_sha256"],
            "host_policy_sha256": policy, "solver_capsule_attribution": False, "lane": LANE,
            "compose_project": project, "compose_sha256": sha(root / "compose.json"),
            "qualification": "NOT VERIFIED", "scenario_qualification": "SCENARIO_NOT_QUALIFIED",
            "physics_qualified": False, "unit_tests_compiled": False,
            "session_storage": "disposable_tmpfs", "durable_session_storage_qualified": False}
        storage.atomic_json(root / "receipt.json", receipt)
        container = None
        try:
            args = ["compose", "-f", str(root / "compose.json"), "--project-name", project]
            docker(*args, "config", "--quiet")
            docker(*args, "up", "--detach", "--no-build", "--pull", "never")
            container = docker(*args, "ps", "--all", "--quiet", "antenna").strip()
            if re.fullmatch("[a-f0-9]{64}", container) is None:
                raise ValueError("Full owned N/F container ID required")
            receipt["container_id"] = container
            deadline = time.monotonic() + RUN_SECONDS
            while True:
                state = ram.attest(container, spec, project)["State"]
                if state.get("Status") == "exited" and state.get("Running") is False:
                    break
                require_browser_window(layout, container)
                if time.monotonic() >= deadline:
                    raise ValueError("Fixed N/F runtime exceeded its bound")
                time.sleep(1)
            receipt.update(worker_exit_code=state.get("ExitCode"), oom_killed=state.get("OOMKilled"))
            if type(state.get("ExitCode")) is not int or state["ExitCode"] != 0 or state.get("OOMKilled") is not False or state.get("Error"):
                raise ValueError("N/F worker failed; retained diagnostics are not solver proof")
            storage.atomic_json(root / "container-terminal-state.json", state)
            logs = docker("logs", container)
            (root / "container-terminal.log").write_text(logs, encoding="utf-8")
            output = [json.loads(line) for line in logs.splitlines() if line.startswith('{"outputs":')]
            outputs = closure(root / "export")
            if output != [{"schema": OUTPUT_SCHEMA, "outputs": outputs}]:
                raise ValueError("N/F retained outputs differ from the attested worker closure")
            summary = read(root / "export", "summary.json")
            verified = []
            for case in cases():
                directory = root / "export/result" / case["key"]
                verified.append(validate_case(directory, case, contract, reference))
                check_stamp(member(directory, "fullmag.stderr.log", empty=True).read_text(encoding="utf-8"),
                    binding["commit"], binding["native_snapshot_sha256"], dirty=built["native_source_identity"]["source_snapshot_dirty"])
            if summary != {"schema": OUTPUT_SCHEMA, "cases": verified, "physics_qualified": False, "durable_session_storage_qualified": False}:
                raise ValueError("N/F worker observations differ from independent host readback")
            _, checked_build, checked_context, checked_built, checked_capsule, checked_package = ram.resolved_build(
                repo, binding["job_id"], binding["commit"], binding["source_digest"], binding["native_snapshot_sha256"])
            if (checked_build != build or checked_capsule != capsule or checked_package != package
                    or checked_context["image_digest"] != receipt["image_digest"]
                    or checked_built["native_source_identity"] != receipt["native_source_identity"]
                    or sha(build / "artifacts/build-receipt.json") != receipt["build_receipt_sha256"]):
                raise ValueError("N/F managed native build binding changed")
            ram.verify_source(capsule, binding["source_digest"])
            if any(sha(member(repo, name)) != digest for name, digest in public_files.items()):
                raise ValueError("host public DSL changed during independent readback")
            check_tools(root / "tools", read(root / "tools", "manifest.json"))
            if (host_policy(repo) != policy or sha(package / "bin/fullmag-bin") != contract["binary_sha256"]
                    or sha(root / "tools/manifest.json") != receipt["tool_manifest_sha256"]):
                raise ValueError("N/F loaded host policy or retained input/native bytes changed")
            receipt.update(state="solver_succeeded_identity_verified", outputs=outputs, cases=verified)
        except BaseException as error:
            receipt.update(state="failed_resources_retained", error=str(error))
            raise
        finally:
            try:
                if container:
                    observed = ram.attest(container, spec, project)
                    if observed["State"].get("Running"):
                        docker("stop", "--time", "10", container)
                    (root / "container-terminal.log").write_text(docker("logs", container), encoding="utf-8")
                    storage.atomic_json(root / "container-terminal-state.json", ram.attest(container, spec, project)["State"])
            except BaseException as cleanup_error:
                receipt.update(state="failed_resources_retained", cleanup_error=str(cleanup_error))
                raise
            finally:
                storage.atomic_json(root / "receipt.json", receipt)
        return {"run_root": str(root), "receipt": receipt,
                "pin": {"receipt_sha256": sha(root / "receipt.json"), "outputs": receipt["outputs"]},
                "host_policy_sha256": policy}


_INITIAL_HOST_POLICY = host_policy(Path(__file__).resolve().parents[1]) if __name__ != "__main__" else {}


if __name__ == "__main__":
    if sys.argv[1:] != ["execute"]:
        raise SystemExit("Only the fixed in-container execute action is supported; use the public matrix recipe")
    execute()
