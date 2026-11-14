#!/usr/bin/env python3
"""Source-only input generation inside the explicitly owned Task4 CI temporary tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

# Source data of a tiny numerical regression, never an imported scientific result.
AUTHOR_SOURCE = r"""import fullmag as fm
from pathlib import Path
from dataclasses import replace
from fullmag.model.problem import BackendTarget, DeviceTarget
geometry = fm.MicrostripAntennaLayout(name="loop", length_m=2e-6, thickness_m=0.2e-6,
    conductivity_s_per_m=5.8e7, stations=[fm.MicrostripWidthStation(0,0.3e-6),
    fm.MicrostripWidthStation(0.5,0.1e-6),fm.MicrostripWidthStation(1,0.3e-6)],
    return_width_m=1e-6, return_offset_m=0.4e-6, closed_loop=True,
    inlet_connection_length_m=0.2e-6,inlet_connection_width_m=0.4e-6,
    inlet_connection_offset_v_m=0.,inlet_connection_part_id="inlet",inlet_connection_conductivity_s_per_m=3e7,
    outlet_connection_length_m=0.2e-6,outlet_connection_width_m=0.4e-6,
    outlet_connection_offset_v_m=0.,outlet_connection_part_id="outlet",outlet_connection_conductivity_s_per_m=3e7)
probe = fm.Box(size=(0.1e-6,0.1e-6,0.1e-6),name="probe").translate((3e-6,0.,0.))
closure = fm.StructuredCurrentClosure("loop",[fm.StructuredCurrentSourceCut("cut","circuit",
    fm.RegionRef("object","inlet"),fm.StructuredCutPlane("z",-0.3e-6,coordinate_frame="object"),
    fm.ImpressedPotentialJump("drive",0.25))],schema_version="structured_current_closure.v2")
transport = fm.CurrentTransport(name="charge",model="ohmic_poisson",domain=[fm.RegionRef("object")],
    materials=[fm.ChargeTransportMaterialAssignment(fm.RegionRef("object",part),fm.ChargeTransportMaterial(sigma))
        for part,sigma in ((geometry.signal_part_id,geometry.conductivity_s_per_m),
        (geometry.return_part_id,geometry.conductivity_s_per_m),("inlet",3e7),("outlet",3e7))],
    boundaries=[],gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(relative_tolerance=1e-12,operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    structured_current_closure=closure)
port = fm.AntennaPortMode(id="port",source_object_id="object",current_transport_id="charge",
    schema_version="antenna_port_mode.v3",normalization=fm.AntennaSourceCutRt0("cut"),
    branches=[fm.AntennaPortBranch(geometry.signal_part_id,"signal-in","signal-out",1.),
        fm.AntennaPortBranch(geometry.return_part_id,"return-in","return-out",-1.)])
stage = fm.AntennaFieldSolveStage(id="solve",source_object_id="object",current_transport_id="charge",
    port_mode_ids=["port"],field_sampling_domain=fm.FieldTarget.object("probe"),
    target_refs=[fm.FieldTarget.object("probe")],outputs=[fm.AntennaNamedOutput("inspection","H_ant_basis")])
__CHILD_BINDING__
problem = fm.Problem(name="task4_ci_microstrip",magnets=[],energy=[],study=fm.FieldOnly(),
    auxiliary_geometries=[geometry,probe],auxiliary_geometry_roles={geometry.geometry_name:"antenna",probe.geometry_name:"geometry"},
    auxiliary_geometry_object_ids={geometry.geometry_name:"object",probe.geometry_name:"probe"},
    current_modules=[transport],antenna_port_modes=[port],antenna_field_solve_stages=[stage],
    discretization=fm.DiscretizationHints(fem=fm.FEM(maximum_element_size=0.15e-6,order=1)),
    runtime=fm.RuntimeSelection(backend_target=BackendTarget.FEM,device_target=DeviceTarget.CPU),
    runtime_metadata={"script_api_surface":"study","mesh_workflow":{"per_geometry":__MESH_POLICY__}})
"""


def generate(destination, source_root, document=None, locator=None):
    if os.environ.get("FULLMAG_DTQ_MANAGED_CI") != "1":
        raise RuntimeError("source fixture generation requires approved managed CI")
    temporary = Path(os.environ["FULLMAG_DTQ_TEST_TEMP_ROOT"]).resolve(strict=True)
    destination = destination.absolute()
    parent = destination.parent.resolve(strict=True)
    if not parent.is_relative_to(temporary) or destination.exists() or destination.is_symlink():
        raise RuntimeError("fixture destination must be a new owned directory below managed test storage")
    destination.mkdir()
    source = destination / "source"
    source.mkdir()
    binding = ""
    if document is not None:
        if locator is None:
            raise RuntimeError("child requires its exact parent locator")
        payload = document.read_bytes()
        (source / "source.json").write_bytes(payload)
        values = json.loads(locator.read_text())
        values.pop("kind", None)
        binding = ("stage = replace(stage, retained_current_source=fm.AntennaRetainedCurrentSource(**"
            + repr(values) + "), retained_source_preparation=fm.AntennaSourcePreparationAsset(Path(__file__).parent / 'source.json', '"
            + hashlib.sha256(payload).hexdigest() + "'))")
    script = source / "main.py"
    fullmag = source_root / "packages/fullmag-py/src/fullmag"
    sys.path.insert(0, str(fullmag.parent))
    policy = ("[{\"geometry\":probe.geometry_name,\"mode\":\"custom\",\"order\":1,"
              "\"hmax\":0.15e-6,\"source\":str(Path(__file__).parent / 'probe.npz')}" )
    if document is None:
        policy += (",{\"geometry\":geometry.geometry_name,\"mode\":\"custom\",\"order\":1,"
                   "\"hmax\":0.15e-6,\"source\":str(Path(__file__).parent / 'raw-source.npz')}")
    policy += "]"
    script.write_text(AUTHOR_SOURCE.replace("__CHILD_BINDING__", binding).replace("__MESH_POLICY__", policy))
    # Input-only meshing precedes readonly capture. The captured script reads pinned NPZ,
    # never invokes Gmsh or writes a cache. No current, certificate or H is made here.
    import numpy as np
    from fullmag.meshing._gmsh_types import MeshData
    probe = MeshData.from_legacy_tet4(nodes=np.asarray([[3e-6,0.,0.],[3.1e-6,0.,0.],
        [3e-6,0.1e-6,0.],[3e-6,0.,0.1e-6]]),elements=np.asarray([[0,1,2,3]]),
        element_markers=np.asarray([1]),boundary_faces=np.asarray([[0,2,1],[0,1,3],[0,3,2],[1,2,3]]),
        boundary_markers=np.ones(4,dtype=np.int32))
    probe.validate_strict(require_positive_orientation=True)
    probe.save(source / "probe.npz")
    if document is None:
        authored = runpy.run_path(str(script))
        from fullmag.meshing._antenna_coincident_cut import realize_antenna_coincident_loop_mesh
        raw = realize_antenna_coincident_loop_mesh(authored["closure"],geometry=authored["geometry"],
            object_id="object",hmax_m=0.15e-6)
        raw.validate_strict(require_positive_orientation=True)
        raw.save(source / "raw-source.npz")
    env = os.environ.copy()
    env["PYTHONPATH"] = str(fullmag.parent)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["FULLMAG_FEM_MESH_CACHE_DIR"] = ""
    command = [sys.executable,"-B",str(fullmag / "runtime/accepted_source_capture.py"),
        "--script",str(script),"--fullmag-root",str(fullmag),"--backend","fem","--mode","strict","--precision","double"]
    def capture(args):
        result = subprocess.run(command + args, env=env, check=False, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(f"canonical capture refused (exit {result.returncode}): {result.stderr}")
        return json.loads(result.stdout)
    inventory = capture(["--phase","inventory"])["capture"]
    exported = capture(["--phase","export","--expected-inventory",inventory["inventory_sha256"]])
    config = exported["config"]
    # One explicit static action; no runtime worker or scientific stage is launched.
    config["stages"] = []
    config["study_pipeline"] = {"version":"study_pipeline.v1","nodes":[{"node_kind":"primitive",
        "id":"inspection","label":"CI inspection","stage_kind":"antenna_field_solve",
        "payload":{"stage_id":"solve","port_mode_id":"port"}}]}
    files = []
    pins = exported["capture"]
    assets = destination / "captured"
    assets.mkdir()
    for index, record in enumerate(pins["records"]):
        original = Path(record.pop("absolute_path"))
        payload = original.read_bytes()
        if len(payload) != record["byte_count"] or hashlib.sha256(payload).hexdigest() != record["sha256"]:
            raise RuntimeError("captured source changed before fixture copy")
        relative = f"captured/{index:05d}.bin"
        (destination / relative).write_bytes(payload)
        files.append({"asset_id":record["asset_id"],"sha256":record["sha256"],"path":relative})
    result = {"schema_version":"fullmag.dtq.generated_input.v1","config":config,"capture":pins,"files":files}
    (destination / "input.json").write_text(json.dumps(result,separators=(",",":"),allow_nan=False))
    print(destination / "input.json")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--destination",type=Path,required=True)
    p.add_argument("--source-root",type=Path,required=True)
    p.add_argument("--document",type=Path)
    p.add_argument("--locator",type=Path)
    args=p.parse_args()
    generate(args.destination,args.source_root.resolve(strict=True),args.document,args.locator)


if __name__ == "__main__":
    main()
