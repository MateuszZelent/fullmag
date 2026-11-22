"""Export a shielded, wave-port Palace CPW case without running a solve.

Configuration is pinned to the Palace input schema and verified against the
CPW and lossy wave-port examples at the same revision. The ports and enclosure
are independent assumptions. These artifacts are external solver inputs.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from rf_cpw_reference import MATERIAL_NAMES, make_case

PALACE_REVISION = "be4b5d36ffe77933d4dbf86209d2bf21a2059fe3"
PALACE_SOURCE = f"https://github.com/awslabs/palace/blob/{PALACE_REVISION}"
_PORT_IN = 101
_PORT_OUT = 102
_SHIELD = 103
_OUTWARD_FACES = np.array(((1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1)))


def material_boundaries(case):
    """Find exterior faces with outward normals and mutually exclusive tags."""
    original = case.tetrahedra[:, _OUTWARD_FACES].reshape(-1, 3)
    _, first, counts = np.unique(np.sort(original, axis=1), axis=0,
                                 return_index=True, return_counts=True)
    if np.any(counts > 2):
        raise ValueError("Volume mesh has a nonmanifold face")
    triangles = original[first[counts == 1]]
    xyz = case.points_m[triangles]
    on_input = (xyz[:, :, 0] == case.axes_m[0][0]).all(axis=1)
    on_output = (xyz[:, :, 0] == case.axes_m[0][-1]).all(axis=1)
    on_shield = np.any(np.stack([
        (xyz[:, :, axis] == case.axes_m[axis][side]).all(axis=1)
        for axis in (1, 2) for side in (0, -1)
    ]), axis=0)
    membership = np.column_stack((on_input, on_output, on_shield))
    if not np.all(membership.sum(axis=1) == 1) or not membership.any(axis=0).all():
        raise ValueError("Every exterior face must belong to exactly one port or shield")
    tags = np.asarray([_PORT_IN, _PORT_OUT, _SHIELD])[membership.argmax(axis=1)]
    return triangles, tags


def _probe_line(sample_step_nm):
    if sample_step_nm not in (20.0, 5.0, 2.5):
        raise ValueError("Supported sample spacing is 20, 5 or 2.5 nm")
    count = int(3200 / sample_step_nm) + 1
    y = np.linspace(-1600e-9, 1600e-9, count)
    return np.column_stack((np.zeros(count), y, np.full(count, -7.5e-9)))


def _materials(case):
    materials = []
    for material in range(len(MATERIAL_NAMES)):
        region = case.material_id == material
        sigma = np.unique(case.conductivity_spm[region])
        epsilon = np.unique(case.relative_permittivity[region])
        if len(sigma) != 1 or len(epsilon) != 1:
            raise ValueError("Each Palace volume tag must have homogeneous material coefficients")
        materials.append({
            "Attributes": [material + 1],
            "Permeability": 1.0,
            "Permittivity": float(epsilon[0]),
            "Conductivity": float(sigma[0]),
        })
    return materials


def _config(case, mode, probes):
    return {
        "Problem": {"Type": "Driven", "Output": "results", "Verbose": 2},
        "Model": {"Mesh": "cpw.msh", "L0": 1.0},
        "Domains": {
            "Materials": _materials(case),
            "Postprocessing": {"Probe": [
                {"Index": i, "Center": xyz.tolist()}
                for i, xyz in enumerate(probes, start=1)
            ]},
        },
        "Boundaries": {
            "PEC": {"Attributes": [_SHIELD]},
            "WavePort": [
                {"Index": 1, "Attributes": [_PORT_IN], "Mode": mode, "Excitation": 1},
                {"Index": 2, "Attributes": [_PORT_OUT], "Mode": mode},
            ],
        },
        "Solver": {
            "Order": 2,
            "Device": "CPU",
            "Driven": {"Samples": [
                {"Type": "Point", "Freq": [case.frequency_hz / 1e9], "SaveStep": 1}
            ]},
            "Linear": {"Type": "Default", "KSPType": "GMRES", "Tol": 1e-9},
        },
    }


def write_case(case, output, *, mode, sample_step_nm=20):
    """Write an exclusive output directory with the volume mesh and provenance."""
    import meshio

    if type(mode) is not int or mode < 1:
        raise ValueError("Choose a positive one-based wave-port mode index")
    probes = _probe_line(sample_step_nm)
    triangles, boundary_tags = material_boundaries(case)
    config = _config(case, mode, probes)
    material_tags = case.material_id.astype(np.int32) + 1
    # The distinct source region tags must remain volume tags in Gmsh.
    field_data = {name: [i + 1, 3] for i, name in enumerate(MATERIAL_NAMES)}
    field_data.update({"input": [_PORT_IN, 2], "output": [_PORT_OUT, 2], "shield": [_SHIELD, 2]})
    mesh = meshio.Mesh(
        case.points_m,
        [("tetra", case.tetrahedra), ("triangle", triangles)],
        cell_data={"gmsh:physical": [material_tags, boundary_tags],
                   "gmsh:geometrical": [material_tags, boundary_tags]},
        field_data=field_data,
    )
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "status": "inputs_only",
        "solver": "Palace",
        "palace_revision": PALACE_REVISION,
        "reference_sources": {
            "config_schema": f"{PALACE_SOURCE}/scripts/schema/config-schema.json",
            "wave_port": f"{PALACE_SOURCE}/palace/models/waveportoperator.cpp",
            "lossy_volume_test": f"{PALACE_SOURCE}/test/unit/test-waveportimpedance.cpp",
            "waveguide_example": f"{PALACE_SOURCE}/examples/cpw/cpw_wave_uniform.json",
        },
        "cpw": case.cpw,
        "frequency_hz": case.frequency_hz,
        "refinement": case.refinement,
        "port_model": "shielded_wave_port",
        "reference_limit": (
            "Declared PEC transverse enclosure and modal port termination. Model differs "
            "from the ECE case and the original CST port is unknown. Mode identity and "
            "enclosure sensitivity require numerical qualification."
        ),
        "port_1_excitation": "1 W time-averaged incident power in the requested mode",
        "port_2_termination": "matched to the requested Palace mode",
        "mode_index": mode,
        "peak_phasor_convention": "Re(F exp(+i omega t))",
        "probe_output": "Order by Palace Probe.Index. Convert B to H using permeability "
                        "at each probe. Preserve complex components and report normalization.",
        "boundary_triangle_counts": {str(tag): int(np.count_nonzero(boundary_tags == tag))
                                     for tag in (_PORT_IN, _PORT_OUT, _SHIELD)},
        "volume_tetrahedra": len(case.tetrahedra),
    }
    with TemporaryDirectory(prefix=".palace-input-", dir=output.parent) as temporary:
        stage = Path(temporary) / "deck"
        stage.mkdir()
        meshio.write(stage / "cpw.msh", mesh, file_format="gmsh22", binary=True)
        np.savetxt(stage / "probes_xyz_m.csv", probes, delimiter=",",
                   header="x_m,y_m,z_m", comments="", fmt="%.17g")
        (stage / "palace.json").write_text(json.dumps(config, indent=2) + "\n")
        files = ("cpw.msh", "probes_xyz_m.csv", "palace.json")
        manifest["sha256"] = {name: sha256((stage / name).read_bytes()).hexdigest()
                              for name in files}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        if output.exists():
            raise FileExistsError(f"Output already exists: {output}")
        stage.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpw", type=int, choices=(1, 2), default=2)
    parser.add_argument("--mode", type=int, required=True)
    parser.add_argument("--refinement", type=int, choices=(0, 1, 2), default=0)
    parser.add_argument("--box-half-width-nm", type=float, default=3000.0)
    parser.add_argument("--sample-step-nm", type=float, choices=(20, 5, 2.5), default=20)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        case = make_case(cpw=args.cpw, refinement=args.refinement,
                         box_half_width_nm=args.box_half_width_nm)
        manifest = write_case(case, args.output, mode=args.mode,
                              sample_step_nm=args.sample_step_nm)
    except (ValueError, FileExistsError) as error:
        parser.error(str(error))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
