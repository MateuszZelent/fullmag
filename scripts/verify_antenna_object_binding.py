"""Real Python-to-production-CLI ownership checks, without a solver or unit build."""
from __future__ import annotations

import argparse
import copy
from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def authored_ir(*, renamed=False, antenna_declaration=False):
    import fullmag as fm
    from fullmag import world

    world.begin_script_capture()
    world.set_script_capture_lightweight_assets(True)
    try:
        study = fm.study("antenna-object-binding")
        study.engine("auto" if antenna_declaration else "fdm")
        study.device("cpu", precision="double")
        study.objects.mesh.defaults(cell_size=(10e-9, 10e-9, 10e-9))
        study.disable_demag()
        film = study.geometry(fm.Box(100e-9, 20e-9, 10e-9), name="film", object_id="magnetic-id")
        film.Ms, film.Aex, film.alpha = 800e3, 13e-12, 0.01
        film.m = fm.texture.uniform(1, 0, 0)
        shape = fm.Box(20e-9, 40e-9, 5e-9)
        study.antenna_object(shape, name="Renamed source" if renamed else "Readable source", object_id="antenna-id")
        study.antenna_object(fm.Box(30e-9, 40e-9, 5e-9), name="Second source", object_id="second-id")
        study.geometry_object(fm.Box(10e-9, 10e-9, 5e-9), name="Electrode", type="electrode", object_id="electrode-id")
        problem = world.capture_workspace_problem()
        if problem is None:
            raise AssertionError("public authoring did not produce a Problem")
        if antenna_declaration:
            owner = "antenna-id"
            region = fm.RegionRef(owner)
            boundaries = tuple(fm.VoltageElectrode(name, (fm.SurfaceRef(owner, side, normal),), potential_V=value)
                for name, side, normal, value in (
                    ("signal_in", "left", (-1., 0., 0.), 0.1),
                    ("signal_out", "right", (1., 0., 0.), 0.),
                    ("return_in", "bottom", (0., 0., -1.), 0.1),
                    ("return_out", "top", (0., 0., 1.), 0.)))
            transport = fm.CurrentTransport(name="charge", model="ohmic_poisson", domain=(region,),
                materials=(fm.ChargeTransportMaterialAssignment(region, fm.ChargeTransportMaterial(sigma_Spm=5.8e7)),),
                boundaries=boundaries, gauge=fm.ChargePotentialGauge("dirichlet_reference"),
                solver=fm.ChargeSolverPolicy(operator_version="fem_charge_conforming_h1_p1.transparent.v1"))
            port = fm.AntennaPortMode(id="port", source_object_id=owner, current_transport_id="charge",
                branches=(fm.AntennaPortBranch(id="signal", inlet_terminal_ref="signal_in", outlet_terminal_ref="signal_out", signed_weight=1.),
                          fm.AntennaPortBranch(id="return", inlet_terminal_ref="return_in", outlet_terminal_ref="return_out", signed_weight=-1.)))
            stage = fm.AntennaFieldSolveStage(id="solve", source_object_id=owner, current_transport_id="charge",
                port_mode_ids=("port",), conservative_current_view_ref="unresolved-declaration:rt0",
                field_sampling_domain=fm.FieldTarget.global_domain(), target_refs=(fm.FieldTarget.object("magnetic-id"),),
                outputs=(fm.AntennaNamedOutput("basis", "H_ant_basis"),))
            # Only validate authored declarations. The unresolved view is not a
            # computed RT0 result and this check must never launch the stage.
            problem = replace(problem, current_modules=(transport,), antenna_port_modes=(port,),
                              antenna_field_solve_stages=(stage,))
        ir = problem.to_ir(include_geometry_assets=False)
        if ir.get("geometry_assets") is not None:
            raise AssertionError("identity check must not materialize mesh assets")
        return ir
    finally:
        world.finish_script_capture()


def cases():
    base = authored_ir()
    yield "public-two-antennas-magnet-electrode", base, True, None
    yield "public-rename-retains-immutable-id", authored_ir(renamed=True), True, None
    legacy = copy.deepcopy(base)
    del legacy["physics_graph"]["objects"]
    yield "legacy-absent-table", legacy, True, None
    empty = copy.deepcopy(base)
    empty["physics_graph"]["objects"] = []
    yield "explicit-empty-table-without-consumers", empty, True, None
    declared = authored_ir(antenna_declaration=True)
    yield "antenna-declaration-explicit-id", declared, True, None
    yield "antenna-declaration-after-rename", authored_ir(renamed=True, antenna_declaration=True), True, None
    undeclared = copy.deepcopy(declared)
    undeclared["physics_graph"]["objects"] = []
    yield "empty-table-cannot-bind-antenna-consumer", undeclared, False, "source_object_id must reference"
    alias = copy.deepcopy(declared)
    alias["antenna_port_modes"][0]["source_object_id"] = "Readable source"
    alias["antenna_field_solve_stages"][0]["source_object_id"] = "Readable source"
    yield "display-name-is-not-auxiliary-id", alias, False, "source_object_id must reference"

    def changed(label, mutate):
        ir = copy.deepcopy(base)
        mutate(ir["physics_graph"]["objects"], ir)
        return label, ir, False, "physics_graph"

    for field in ("object_id", "name", "geometry_id"):
        yield changed("empty-" + field, lambda objects, ir, field=field: objects[0].update({field: "  "}))
    yield changed("wrong-object-schema", lambda objects, ir: objects[0].update(schema_version="physics_object.v0"))
    yield changed("unknown-presentation-type", lambda objects, ir: objects[0].update(type="imaginary"))
    yield changed("unknown-object-field", lambda objects, ir: objects[0].update(unknown="invalid"))
    yield changed("duplicate-object-id", lambda objects, ir: objects[1].update(object_id=objects[0]["object_id"]))
    yield changed("duplicate-geometry-owner", lambda objects, ir: objects[1].update(geometry_id=objects[0]["geometry_id"]))
    yield changed("missing-geometry", lambda objects, ir: objects[0].update(geometry_id="missing"))
    yield changed("magnetic-id-collision", lambda objects, ir: objects[0].update(object_id="magnetic-id"))
    yield changed("magnetic-name-collision", lambda objects, ir: objects[0].update(object_id="film"))
    yield changed("magnetic-geometry-collision", lambda objects, ir: objects[0].update(geometry_id=ir["regions"][0]["geometry"]))
    ambiguous = changed("ambiguous-geometry-entry", lambda objects, ir: ir["geometry"]["entries"].append(
        copy.deepcopy(next(entry for entry in ir["geometry"]["entries"] if entry["name"] == objects[0]["geometry_id"]))))
    # The existing typed geometry decoder may reject this before owner lookup.
    yield ambiguous[:3] + ("geometry",)
    yield changed("null-object-table", lambda objects, ir: ir["physics_graph"].update(objects=None))
    yield changed("nonarray-object-table", lambda objects, ir: ir["physics_graph"].update(objects={}))
    yield changed("wrong-graph-schema", lambda objects, ir: ir["physics_graph"].update(schema_version="physics_graph.v0"))


def verify(executable: Path, storage_root: Path):
    results = []
    with tempfile.TemporaryDirectory(prefix="antenna-object-binding-", dir=storage_root) as temporary:
        for label, ir, accepted, diagnostic in cases():
            path = Path(temporary) / (label + ".json")
            path.write_text(json.dumps(ir, allow_nan=False), encoding="utf-8")
            result = subprocess.run([str(executable), "validate-json", str(path)],
                                    text=True, capture_output=True, timeout=60)
            output = result.stdout + result.stderr
            passed = ((result.returncode == 0) == accepted
                      and (diagnostic is None or diagnostic in output)
                      and (not accepted or "IR validation passed" in output))
            results.append({"case": label, "passed": passed, "expected_acceptance": accepted,
                            "exit_code": result.returncode, "output": output})
    return {"status": "passed" if all(row["passed"] for row in results) else "failed",
            "qualification": "production CLI IR validation only; no dedicated antenna plan, solve or live resource proof",
            "executable": str(executable), "executable_sha256": sha256(executable.read_bytes()).hexdigest(),
            "checks": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--storage-root", type=Path, required=True)
    args = parser.parse_args()
    if not args.storage_root.is_absolute() or not args.storage_root.is_dir():
        parser.error("--storage-root must be an existing absolute configured storage directory")
    if not args.executable.is_absolute() or not args.executable.is_file():
        parser.error("--executable must be an absolute path to the verified production CLI")
    sys.path.insert(0, str(args.repo_root / "packages/fullmag-py/src"))
    report = verify(args.executable.resolve(strict=True), args.storage_root.resolve(strict=True))
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
