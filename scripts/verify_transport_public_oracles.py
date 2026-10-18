#!/usr/bin/env python3
"""Public Python transport oracles; preparation never claims runtime qualification."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import struct
from pathlib import Path

from fullmag.runtime.loader import load_problem_from_script

UNITS = {"V_electric": "V", "J_charge": "A/m^2",
         "spin_potential": "V", "spin_current_tensor": "A/m^2", "torque_stt": "1/s"}


def source(case: str, nx: int) -> str:
    fem = case.startswith("fem")
    charge_bar = case == "fdm-charge-bar"
    length, width, height = ((16e-9, 3e-9, 4e-9) if charge_bar else
                             ((1.0, 0.1, 0.1) if fem else (5.0, 1.0, 1.0)))
    sigma = 5.8e7 if charge_bar else (4.0 if fem else 1.0)
    sigma_s = 4.0
    lamb = 0.2 if fem else 1.3
    v_left, v_right = ((0.0, 0.16) if charge_bar else ((1.0, 0.0) if fem else (0.0, 0.0)))
    mu_left = (0.0, 0.0, 0.0) if charge_bar else (1.0, 0.0, 0.0)
    engine = "fem" if fem else "fdm"
    charge_operator = "fem_charge_conforming_h1_p1.transparent.v1" if fem else "fv_charge_harmonic_v1"
    spin_operator = "fem_charge_spin_conforming_h1_p1.transparent.v1" if fem else "fv_spin_upwind_v1"
    spin_max_iterations = 10000 if fem else 500
    grid = (f"study.objects.mesh.defaults(order=1, hmax={length / nx!r})" if fem else
            f"study.cell({length / nx!r}, {width!r}, {height!r})")
    return f'''# %% Canonical stage-first transport validation fixture.
import fullmag as fm
study = fm.study("{case}-{nx}")
study.engine("{engine}")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=({length!r}, {width!r}, {height!r}),
               center=({length / 2!r}, {width / 2!r}, {height / 2!r}))
{grid}
study.solver(integrator="heun", fix_dt=1e-15)
body = study.geometry(fm.Box(size=({length!r}, {width!r}, {height!r}),
                            name="bar_shape").translate(({length / 2!r}, {width / 2!r}, {height / 2!r})),
                      name="bar")
body.Ms = 8e5
body.Aex = 1.3e-11
body.alpha = 0.0
body.m = fm.texture.uniform(0.0, 0.0, 1.0)
region = fm.RegionRef("bar")
left = fm.SurfaceRef("bar", "x_min", (-1.0, 0.0, 0.0))
right = fm.SurfaceRef("bar", "x_max", (1.0, 0.0, 0.0))
sides = [fm.SurfaceRef("bar", face, normal) for face, normal in (
    ("y_min", (0.0, -1.0, 0.0)), ("y_max", (0.0, 1.0, 0.0)),
    ("z_min", (0.0, 0.0, -1.0)), ("z_max", (0.0, 0.0, 1.0)))]
# %% Charge and spin are authored explicitly, never inferred from object type.
study.current_transport(name="charge", model="ohmic_poisson", coupling="one_way",
    domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(region, fm.ChargeTransportMaterial({sigma!r}))],
    boundaries=[fm.VoltageElectrode("left", [left], potential_V={v_left!r}),
                fm.VoltageElectrode("right", [right], potential_V={v_right!r}),
                fm.ChargeInsulating("sides", sides)],
    gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(relative_tolerance=1e-12, absolute_tolerance=0.0,
        operator_version="{charge_operator}"))
study.spin_transport(fm.SpinDriftDiffusion(id="spin", current_source_id="charge",
    domain=[region],
    materials=[fm.SpinTransportMaterialAssignment(region,
        fm.SpinTransportMaterial(sigma_s_Spm={sigma_s!r}, polarization_p=0.0,
            theta_sh=0.0, lambda_sf_m={lamb!r}))],
    boundaries=[fm.SpecifiedSpinPotential("spin_left", [left], spin_potential_V={mu_left!r}),
                fm.SpecifiedSpinPotential("spin_right", [right], spin_potential_V=(0.0, 0.0, 0.0)),
                fm.SpinInsulating("spin_sides", sides)],
    solver=fm.SpinSolverPolicy(relative_tolerance=1e-12, absolute_tolerance=0.0,
        max_iterations={spin_max_iterations}, operator_version="{spin_operator}"),
    requested_execution=fm.TransportExecution(discretization="{engine}", device="cpu",
        precision="double", execution_mode="strict")))
for quantity in ("V_electric", "J_charge", "spin_potential", "spin_current_tensor", "torque_stt"):
    study.save(quantity, every=1e-15)
study.stages.add_run(1e-15, stage_id="transport_oracle")
'''


def tagged_json_digest(value: object) -> str:
    digest = hashlib.sha256(b"fullmag:transport-tagged-json:v1")
    def encode(value: object) -> None:
        if value is None:
            digest.update(b"N")
        elif isinstance(value, bool):
            digest.update(b"T" if value else b"F")
        elif isinstance(value, (int, float)):
            if isinstance(value, int) and abs(value) > 2**53:
                raise ValueError("transport identity integer exceeds exact f64 range")
            number = finite_scalar(value, "identity_number")
            digest.update(b"D" + struct.pack("<d", 0.0 if number == 0.0 else number))
        elif isinstance(value, str):
            encoded = value.encode("utf-8")
            digest.update(b"S" + struct.pack("<Q", len(encoded)) + encoded)
        elif isinstance(value, list):
            digest.update(b"A" + struct.pack("<Q", len(value)))
            for entry in value:
                encode(entry)
        elif isinstance(value, dict) and all(isinstance(key, str) for key in value):
            digest.update(b"O" + struct.pack("<Q", len(value)))
            for key in sorted(value):
                encode(key)
                encode(value[key])
        else:
            raise ValueError("unsupported transport identity value")
    encode(value)
    return "sha256:" + digest.hexdigest()


def validate_fem_identity(ir: dict, module: dict, expected_ir: dict) -> dict:
    from fullmag.meshing.persistence import mesh_data_from_ir
    identity = module.get("transport_identity", {})
    if (identity.get("schema") != "fullmag.fem.steady_transport_identity.v1"
            or identity.get("digest_codec") != "fullmag.transport_tagged_json.v1"
            or identity.get("mesh_topology_codec") != "fullmag.fem_mesh_topology_fingerprint.v3"):
        raise ValueError("missing mandatory actual FEM transport identity v1")
    mesh = ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
    topology = mesh_data_from_ir(mesh).topology_fingerprint_v3()
    request = identity["request"]
    descriptor = module["descriptor"]
    for name, value in (("request", request), ("descriptor", descriptor), ("result", module["result"])):
        if identity.get(name + "_sha256") != tagged_json_digest(value):
            raise ValueError(f"FEM {name} identity digest differs")
    for name in ("current_modules", "spin_transport_modules", "materials", "magnets", "backend_policy",
                 "geometry", "object_regions", "regions", "physics_graph", "study", "validation_profile"):
        if ir.get(name) != expected_ir.get(name):
            raise ValueError(f"materialized IR differs from fixed public sinh authoring: {name}")
    nodes = finite_rows(mesh["nodes"], len(mesh["nodes"]), 3, "mesh_nodes")
    cell_count = len(mesh["cells"]["types"])
    if cell_count == 0 or any(kind != "tet4" for kind in mesh["cells"]["types"]):
        raise ValueError("bounded public FEM sinh oracle requires nonempty tet4 cells")
    # Dirichlet IDs are MFEM boundary attributes, not nodal indices.
    marker_faces = {}
    facets = mesh["facets"]
    for index, marker in enumerate(mesh["boundary_markers"]):
        face = [nodes[node] for node in facets["nodes"][facets["offsets"][index]:facets["offsets"][index + 1]]]
        side = 0.0 if all(point[0] == 0.0 for point in face) else (
            1.0 if all(point[0] == 1.0 for point in face) else None)
        marker_faces.setdefault(marker, set()).add(side)
    boundary_values = []
    for marker, sides in sorted(marker_faces.items()):
        if len(sides) != 1:
            raise ValueError("boundary attribute crosses distinct physical sides")
        side = next(iter(sides))
        if side is not None:
            boundary_values.append([marker, 1.0 - side])
    if {value for _, value in boundary_values} != {0.0, 1.0}:
        raise ValueError("FEM mesh lacks both physical electrode marker groups")
    expected = {
        "module_id": "spin", "current_source_id": "charge", "mesh_name": mesh["mesh_name"],
        "mesh_topology_sha256": topology, "node_carrier": "ordered_mesh_nodes_u32.v1",
        "node_count": len(nodes), "cell_count": cell_count, "execution": "fem_cpu_double",
        "interface": "transparent_conforming_h1", "gauge": "boundary_reference",
        "constitutive_model": "one_way", "constitutive_version": "transport_constitutive.one_way.fullmag.v1",
        "operator_version": "fem_charge_spin_conforming_h1_p1.transparent.v1",
        "physical_residual_version": "transport_balance_integrated_l2.v1",
        "charge_conductivity_Spm_per_element": [4.0] * cell_count,
        "magnetization": [[0.0, 0.0, 1.0]] * len(nodes), "sigma_s_Spm": 4.0,
        "sigma_parallel_Spm": None, "sigma_perpendicular_Spm": None, "sigma_ahe_Spm": None,
        "polarization_p": 0.0, "theta_sh": 0.0, "lambda_sf_m": 0.2,
        "lambda_j_m": None, "lambda_phi_m": None,
        "gamma_e_per_Ts": 2.211e5 / (4e-7 * math.pi), "saturation_magnetization_Apm": 8e5,
        "relative_tolerance": 1e-12, "absolute_tolerance": 0.0, "maximum_iterations": 10000,
        "charge_dirichlet": boundary_values,
        "spin_dirichlet": [[marker, [value, 0.0, 0.0]] for marker, value in boundary_values],
    }
    if not expected["charge_dirichlet"] or any(not 0 <= p[0] <= 1 or not 0 <= p[1] <= 0.1
                                                or not 0 <= p[2] <= 0.1 for p in nodes):
        raise ValueError("FEM mesh does not cover the fixed physical bar")
    if request != expected:
        raise ValueError("actual prepared FEM request differs from fixed public physical oracle")
    charge = ir["current_modules"][0]
    charge_definition = {key: charge[key] for key in ("domain", "materials", "boundaries", "gauge", "solver")}
    if descriptor.get("descriptor_schema") != "fullmag.fem.spin_transport_descriptor.v1":
        raise ValueError("FEM descriptor is not the fixed transparent M1 schema")
    if descriptor.get("charge_definition") != charge_definition or descriptor.get("spin_solver") != ir["spin_transport_modules"][0]["solver"]:
        raise ValueError("FEM descriptor charge/spin intent differs from canonical IR")
    for name in ("charge_domain", "spin_domain"):
        if descriptor.get(name) != {"regions": [{"object_id": "bar"}], "element_mask": [True] * cell_count}:
            raise ValueError("FEM descriptor domain differs from complete physical bar")
    if descriptor.get("interfaces") != [] or descriptor.get("reciprocal_material") is not None or descriptor.get("torque_target") is not None:
        raise ValueError("FEM descriptor contains unqualified interfaces/reciprocity/torque")
    side_markers = sorted(marker for marker, sides in marker_faces.items() if sides == {None})
    for name, boundary_id in (("charge_insulating_boundaries", "sides"), ("spin_insulating_boundaries", "spin_sides")):
        if descriptor.get(name) != [{"id": boundary_id, "boundary_attributes": side_markers}]:
            raise ValueError("FEM insulation markers differ from physical transverse faces")
    for name in ("constitutive_version", "operator_version", "physical_residual_version"):
        if module["result"].get(name) != request[name]:
            raise ValueError(f"FEM result {name} differs from actual request")
    if module.get("requested_execution") != {"discretization": "fem", "device": "cpu",
                                               "precision": "double", "execution_mode": "strict"}:
        raise ValueError("FEM requested execution differs from explicit strict CPU double")
    if module["result"].get("resolved_execution") != "fem_cpu_double":
        raise ValueError("FEM result execution differs from CPU double")
    return {"request_sha256": identity["request_sha256"], "mesh_topology_sha256": topology,
            "descriptor_sha256": identity["descriptor_sha256"], "result_sha256": identity["result_sha256"],
            "operator_version": request["operator_version"], "constitutive_version": request["constitutive_version"],
            "physical_residual_version": request["physical_residual_version"],
            "lane": module["requested_execution"], "node_carrier": request["node_carrier"],
            "scope": "fixed FEM CPU M1 finite-lambda sinh"}


def finite_scalar(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}: expected finite numeric scalar")
    return float(value)


def finite_rows(value: object, count: int, components: int, name: str) -> list[list[float]]:
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"{name}: wrong point count")
    result = []
    for row in value:
        values = row if isinstance(row, list) else [row]
        if len(values) != components or any(isinstance(x, bool) or not isinstance(x, (int, float))
                                            or not math.isfinite(x) for x in values):
            raise ValueError(f"{name}: malformed components")
        result.append([float(x) for x in values])
    return result


def load_module(path: Path, engine: str) -> dict:
    document = json.loads(path.read_text(encoding="utf-8"))
    schema = ("fullmag.fem.steady_spin_transport.v2" if engine == "fem"
              else "fullmag.fdm.spin_transport.accepted.v1")
    if document.get("schema") != schema:
        raise ValueError("transport artifact schema mismatch")
    if engine == "fem":
        modules = document.get("modules")
    else:
        modules = document.get("evaluation", {}).get("modules")
    if not isinstance(modules, list) or len(modules) != 1 or modules[0].get("module_id") != "spin":
        raise ValueError("no unique requested spin module")
    module = modules[0]
    if engine == "fdm":
        if module.get("fallback_used") is not False:
            raise ValueError("missing explicit no-fallback transport provenance")
    else:
        execution = module.get("resolved_execution", {})
        if execution != {"discretization": "fem", "device": "cpu", "precision": "double"}:
            raise ValueError("FEM oracle requires resolved CPU double")
    return module


def check_fdm(case: str, nx: int, module: dict) -> dict:
    potential = finite_rows(module.get("potential_volts"), nx, 1, "V_electric")
    current = finite_rows(module.get("current_density_apm2"), nx, 3, "J_charge")
    spin = finite_rows(module.get("spin_potential_volts"), nx, 3, "spin_potential")
    finite_rows(module.get("spin_current_tensor_apm2"), nx, 9, "spin_current_tensor")
    finite_rows(module.get("transport_torque_per_s"), nx, 3, "torque_stt")
    telemetry = module.get("telemetry")
    if not isinstance(telemetry, dict):
        raise ValueError("missing accepted telemetry")
    for name in ("charge_residual_l2", "charge_net_boundary_current_a",
                 "charge_max_abs_divergence_a_per_m3", "spin_initial_residual_l2",
                 "spin_final_residual_l2", "spin_scaled_residual", "spin_relative_balance_closure"):
        finite_scalar(telemetry.get(name), name)
    for name in ("scaled_charge_residual", "relative_charge_current_update",
                 "relative_spin_potential_update", "transport_outer_error_ratio",
                 "charge_balance_relative", "spin_balance_relative"):
        if name in telemetry:
            finite_scalar(telemetry[name], name)
    if case == "fdm-charge-bar":
        desired_j = -5.8e7 * 0.16 / 16e-9
        voltage_error = max(abs(v[0] - 0.16 * (i + 0.5) / nx) for i, v in enumerate(potential))
        current_error = max(abs(j[0] - desired_j) for j in current)
        passed = voltage_error <= 5e-12 and current_error <= abs(desired_j) * 1e-10
        passed = passed and all(j[1:] == [0.0, 0.0] for j in current)
        return {"passed": passed, "max_voltage_error_V": voltage_error,
                "max_current_error_Apm2": current_error,
                "voltage_tolerance_V": 5e-12, "current_relative_tolerance": 1e-10}
    exact = [math.sinh((5.0 - (i + 0.5) * 5.0 / nx) / 1.3) / math.sinh(5.0 / 1.3)
             for i in range(nx)]
    rms = math.sqrt(sum((v[0] - e) ** 2 for v, e in zip(spin, exact)) / nx)
    residual = finite_scalar(telemetry.get("spin_scaled_residual"), "spin_scaled_residual")
    return {"passed": 0.0 <= residual < 1e-10 and all(v[1:] == [0.0, 0.0] for v in spin),
            "spin_rms_error_V": rms, "spin_scaled_residual": residual}


def check_fem(ir: dict, module: dict, *, managed_binding: dict | None = None) -> dict:
    mesh = ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
    nodes = finite_rows(mesh["nodes"], len(mesh["nodes"]), 3, "mesh_nodes")
    if not nodes:
        raise ValueError("empty FEM mesh")
    result = module["result"]
    spin = finite_rows(result.get("spin_potential_xyz_v"), len(nodes), 3, "spin_potential")
    potential = finite_rows(result.get("electric_potential_v"), len(nodes), 1, "V_electric")
    finite_rows(result.get("spin_current_tensor_row_major_qia_apm2"), len(nodes), 9, "spin_current_tensor")
    finite_rows(result.get("charge_current_density_xyz_apm2"), len(nodes), 3, "J_charge")
    error = max(abs(v[0] - math.sinh((1.0 - point[0]) / 0.2) / math.sinh(5.0))
                for point, v in zip(nodes, spin))
    voltage_error = max(abs(v[0] - (1.0 - p[0])) for p, v in zip(nodes, potential))
    finite_rows(result.get("torque_xyz_per_s"), len(nodes), 3, "torque_stt")
    for name in ("charge_relative_residual", "spin_relative_residual",
                 "net_boundary_current_a", "torque_l2_per_s"):
        finite_scalar(result.get(name), name)
    vectors = {}
    for name in ("boundary_spin_flux_a", "reaction_integral_a", "angular_momentum_balance_apm2",
                 "current_density_volume_average_apm2", "torque_volume_average_per_s"):
        vectors[name] = finite_rows([result.get(name)], 1, 3, name)[0]
    residual = result["spin_relative_residual"]
    flux, reaction, balance = (vectors[k][0] for k in
                              ("boundary_spin_flux_a", "reaction_integral_a", "angular_momentum_balance_apm2"))
    balance_limit = 0.05 * max(abs(flux) + abs(reaction), 1e-14)
    # Identity validation and a re-attested managed receipt are required by the public entrypoint.
    # Nodal count and a caller-supplied IR alone cannot prove mesh or execution ownership.
    numeric_passed = (error < 1e-3 and voltage_error < 2e-10 and 0.0 <= residual < 1e-10
                      and abs(balance) < balance_limit)
    return {"passed": managed_binding is not None and numeric_passed,
            "diagnostic_numeric_passed": numeric_passed,
            "max_spin_error_V": error, "max_voltage_error_V": voltage_error,
            "voltage_tolerance_V": 2e-10,
            "spin_relative_residual": residual, "balance": balance, "balance_limit": balance_limit,
            "identity_gap": None if managed_binding is not None else
                            "missing verified actual mesh/request/result identity and re-attested managed receipt",
            "scope": "FEM CPU M1 finite-lambda sinh only; no M2 affine qualification"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--case", choices=("fdm-charge-bar", "fdm-spin-sinh", "fem-spin-sinh"), required=True)
    parser.add_argument("--fullmag", type=Path, help="already verified managed executable; never builds")
    parser.add_argument("--check-fem-artifact", type=Path,
                        help="existing managed FEM steady artifact; no solve")
    parser.add_argument("--mesh-problem-ir", type=Path,
                        help="matching canonical IR materialized for that managed FEM run")
    parser.add_argument("--managed-run-root", type=Path,
                        help="fixed managed transport run; re-attest container/source/package/output binding")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--materialize-assets", action="store_true",
                        help="prepare full geometry assets; FEM requires managed Gmsh Python")
    args = parser.parse_args()
    root = args.output_dir.resolve()
    if root.exists():
        print(json.dumps({"status": "not_verified", "error": "output directory must be fresh and not exist"}))
        return 1
    root.mkdir(parents=True, exist_ok=False)
    resolutions = [8] if args.case == "fdm-charge-bar" else ([64] if args.case.startswith("fem") else [20, 40, 80])
    report = {"schema": "fullmag.transport_public_oracles.v1", "case": args.case,
              "status": "prepared_not_run", "units": UNITS, "cases": [],
              "gaps": ["FEM M2 affine disabled spin-flip cannot be authored: lambda_sf_m must be finite"]}
    if args.fullmag:
        report["binary_sha256"] = hashlib.sha256(args.fullmag.read_bytes()).hexdigest()
    try:
        if args.check_fem_artifact or args.mesh_problem_ir:
            if args.case != "fem-spin-sinh" or not args.check_fem_artifact or not args.mesh_problem_ir or args.fullmag:
                raise ValueError("FEM readback needs case fem-spin-sinh and both artifact/mesh IR, without fullmag")
            ir = json.loads(args.mesh_problem_ir.read_text(encoding="utf-8"))
            module = load_module(args.check_fem_artifact, "fem")
            if not args.managed_run_root:
                raise ValueError("FEM qualification requires fixed managed-run-root; arbitrary IR/artifact is diagnostic only")
            run = args.managed_run_root.resolve()
            if (args.check_fem_artifact.resolve() != run / "export/result/transport/fem_steady_spin_transport.json"
                    or args.mesh_problem_ir.resolve() != run / "export/problem_ir.json"):
                raise ValueError("FEM input paths do not belong to the requested managed run")
            from run_managed_transport_oracles import observe
            receipt = observe(args.repo_root.resolve(), run)
            if receipt.get("state") != "solver_succeeded_identity_verified":
                raise ValueError("managed scientific execution has not completed successfully")
            binding = receipt["transport_identity"]
            if binding.get("result_sha256") != tagged_json_digest(module["result"]):
                raise ValueError("managed receipt result identity differs from readback")
            oracle = check_fem(ir, module, managed_binding=binding)
            report["cases"] = [{"oracle": oracle,
                "artifact_sha256": hashlib.sha256(args.check_fem_artifact.read_bytes()).hexdigest(),
                "problem_ir_sha256": hashlib.sha256(args.mesh_problem_ir.read_bytes()).hexdigest()}]
            report["status"] = "runtime_oracle_pass" if oracle["passed"] else "runtime_oracle_fail"
            report["managed_receipt_sha256"] = hashlib.sha256((run / "receipt.json").read_bytes()).hexdigest()
            report["runtime_identity"] = binding
            (root / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(report))
            return 0 if oracle["passed"] else 1
        if args.case.startswith("fem") and args.fullmag:
            raise ValueError("FEM execution must use just fem-managed-headless cpu; "
                             "direct host native invocation is forbidden")
        for nx in resolutions:
            directory = root / str(nx)
            directory.mkdir(exist_ok=False)
            script = directory / "problem.py"
            script.write_text(source(args.case, nx), encoding="utf-8")
            loaded = load_problem_from_script(script, lightweight_assets=not args.materialize_assets)
            problem = loaded.pipeline_base_problem()
            engine = "fem" if args.case.startswith("fem") else "fdm"
            import fullmag as fm
            ir = problem.to_ir(requested_backend=fm.BackendTarget(engine),
                               execution_mode=fm.ExecutionMode.STRICT,
                               execution_precision=fm.ExecutionPrecision.DOUBLE,
                               include_geometry_assets=args.materialize_assets or bool(args.fullmag),
                               entrypoint_kind="direct")
            path = directory / "problem_ir.json"
            path.write_text(json.dumps(ir, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            entry = {"nx": nx, "authoring": "lowered", "stage_count": len(loaded.stages),
                     "problem_ir_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            if engine == "fem":
                entry.pop("nx")
                entry["requested_hmax_m"] = 1.0 / nx
            report["cases"].append(entry)
            if args.fullmag:
                artifacts = directory / "artifacts"
                if artifacts.exists() and any(artifacts.iterdir()):
                    raise ValueError("output artifacts already exist; choose a fresh output directory")
                command = [str(args.fullmag.resolve()), "run-problem-json-direct", str(path),
                           "--until", "1e-15", "--output-dir", str(artifacts)]
                completed = subprocess.run(command, capture_output=True, text=True, timeout=300)
                (directory / "stdout.log").write_text(completed.stdout, encoding="utf-8")
                (directory / "stderr.log").write_text(completed.stderr, encoding="utf-8")
                entry.update(command=command, exit_code=completed.returncode)
                if completed.returncode:
                    raise ValueError("public runtime failed; inspect captured stderr")
                artifact = artifacts / "transport" / ("fem_steady_spin_transport.json" if engine == "fem"
                                                       else "spin_transport_accepted.json")
                module = load_module(artifact, engine)
                entry["artifact_sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
                entry["oracle"] = check_fem(ir, module) if engine == "fem" else check_fdm(args.case, nx, module)
        if args.fullmag:
            passed = all(entry["oracle"]["passed"] for entry in report["cases"])
            if args.case == "fdm-spin-sinh":
                errors = [entry["oracle"]["spin_rms_error_V"] for entry in report["cases"]]
                ratios = [errors[0] / errors[1], errors[1] / errors[2]]
                report["error_ratios"] = ratios
                passed = passed and all(ratio > 3.7 for ratio in ratios)
            report["status"] = "runtime_oracle_pass" if passed else "runtime_oracle_fail"
    except Exception as error:
        report["status"] = "not_verified"
        report["error"] = str(error)
    (root / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
    return 0 if report["status"] in ("prepared_not_run", "runtime_oracle_pass") else 1


if __name__ == "__main__":
    raise SystemExit(main())
