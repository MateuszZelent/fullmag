#!/usr/bin/env python3
"""Check exact DG0 object moments against an independent five-tetrahedron oracle.

Run in the selected Docker DEV backend, using its published FEM library. This
does not compile a test binary. It explicitly requests the MFEM CPU lane and
does not qualify GPU execution or time integration. The shared vertices of the
four exterior tetrahedra include all vertices of an unselected central tetra.
The exact selected-element mean is 1/2; the induced-node-set mean is 9/14.
"""
from __future__ import annotations

import argparse
import ctypes as ct
import hashlib
import json
import math
import os
import re
import sys
from pathlib import Path

archive = Path(__file__).with_suffix(".zarr") / "provenance"
if archive.is_dir():
    sys.path.insert(0, str(archive))
import fdm_cuda_analytic_abi_checks as abi


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="new self-contained evidence Zarr on WSL")
    args = parser.parse_args()
    if args.output is not None:
        if args.output.suffix != ".zarr" or args.output.exists() or args.output.with_suffix(".py").exists():
            raise ValueError("Evidence requires a new <stem>.zarr and adjacent <stem>.py")
    header = Path(os.environ.get("FULLMAG_FEM_HEADER", "")) if os.environ.get("FULLMAG_FEM_HEADER") else (
        archive / "fullmag_fem.h" if (archive / "fullmag_fem.h").is_file()
        else Path(__file__).resolve().parents[2] / "native/include/fullmag_fem.h")
    abi.HEADER = header
    text = abi.strip_comments(header.read_text())
    def constant(name):
        macro = re.search(r"^#define " + re.escape(name) + r" ([0-9]+)u?$", text, re.M)
        return int(macro.group(1)) if macro else abi.enum_value(text, name)
    types = {}
    for name in ("fullmag_fem_mesh_desc", "fullmag_fem_material_desc",
                 "fullmag_fem_solver_config", "fullmag_fem_field_refresh_policy",
                 "fullmag_fem_relax_stop", "fullmag_fem_sot_envelope_desc",
                 "fullmag_fem_plan_desc"):
        types[name] = abi.parse_struct(text, name, types)
    library = Path(os.environ["FULLMAG_FEM_LIB"]).resolve(strict=True)
    lib = ct.CDLL(str(library))
    class BuildInfo(ct.Structure):
        _fields_ = [("abi_version", ct.c_uint32), ("struct_size", ct.c_uint32),
                    ("mfem_version", ct.c_char * 32), ("hypre_version", ct.c_char * 32)]
    lib.fullmag_fem_get_runtime_build_info_v2.argtypes = [ct.POINTER(BuildInfo)]
    lib.fullmag_fem_get_runtime_build_info_v2.restype = ct.c_int
    build = BuildInfo(2, ct.sizeof(BuildInfo))
    status = lib.fullmag_fem_get_runtime_build_info_v2(ct.byref(build))
    mfem_version = build.mfem_version.decode("ascii", "strict")
    hypre_version = build.hypre_version.decode("ascii", "strict")
    if status != 0 or not mfem_version or not hypre_version:
        raise RuntimeError(("MFEM/HYPRE build identity is unavailable", status,
                            mfem_version, hypre_version))
    abi.SCALARS["char"] = ct.c_char
    device_type = abi.parse_struct(text, "fullmag_fem_device_info", types)
    lib.fullmag_fem_backend_get_device_info.argtypes = [ct.c_void_p, ct.POINTER(device_type)]
    lib.fullmag_fem_backend_get_device_info.restype = ct.c_int
    plan_type = types["fullmag_fem_plan_desc"]
    lib.fullmag_fem_backend_create.argtypes = [ct.POINTER(plan_type)]
    lib.fullmag_fem_backend_create.restype = ct.c_void_p
    lib.fullmag_fem_backend_destroy.argtypes = [ct.c_void_p]
    lib.fullmag_fem_backend_last_error.argtypes = [ct.c_void_p]
    lib.fullmag_fem_backend_last_error.restype = ct.c_char_p
    reductions = ("fullmag_fem_backend_average_m_for_elements_f64",
                  "fullmag_fem_backend_average_m_for_nodes_f64")
    for name in reductions:
        function = getattr(lib, name)
        function.argtypes = [ct.c_void_p, ct.POINTER(ct.c_uint32), ct.c_uint64,
                             ct.POINTER(ct.c_double), ct.c_uint64]
        function.restype = ct.c_int

    # Geometry and coefficients are independent of the native reduction.
    edge = 8e-9
    vertices = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1),
                (1, 1, 1), (-1, 0, 0), (0, -1, 0), (0, 0, -1)]
    cells = [(0, 1, 2, 3), (1, 2, 3, 4), (0, 3, 2, 5),
             (0, 1, 3, 6), (0, 2, 1, 7)]
    boundary = [(1, 2, 4), (1, 3, 4), (2, 3, 4), (0, 3, 5),
                (0, 2, 5), (3, 2, 5), (0, 1, 6), (0, 3, 6),
                (1, 3, 6), (0, 2, 7), (0, 1, 7), (2, 1, 7)]
    buffers = []
    def array(values, scalar):
        value = (scalar * len(values))(*values)
        buffers.append(value)
        return ct.cast(value, ct.c_void_p)
    def mesh_array(name, values, scalar=ct.c_uint32):
        setattr(plan.mesh, name, array(values, scalar))
        setattr(plan.mesh, name + "_len", len(values))

    plan = plan_type()
    mesh_version = re.search(r"^#define FULLMAG_FEM_MESH_DESC_ABI_VERSION ([0-9]+)u?$", text, re.M)
    if mesh_version is None:
        raise RuntimeError("Mesh ABI version is absent from the exact header")
    plan.mesh.abi_version = int(mesh_version.group(1))
    plan.mesh.struct_size = ct.sizeof(types["fullmag_fem_mesh_desc"])
    mesh_array("nodes_xyz", [edge * x for v in vertices for x in v], ct.c_double)
    mesh_array("cell_types", [constant("FULLMAG_FEM_CELL_TET4")] * 5)
    mesh_array("cell_offsets", list(range(0, 21, 4)))
    mesh_array("cell_nodes", [x for cell in cells for x in cell])
    mesh_array("cell_global_ordinals", list(range(5)), ct.c_uint64)
    mesh_array("cell_markers", [1] * 5)
    mesh_array("facet_types", [constant("FULLMAG_FEM_FACET_TRI3")] * 12)
    mesh_array("facet_roles", [constant("FULLMAG_FEM_FACET_ROLE_EXTERIOR")] * 12)
    mesh_array("facet_offsets", list(range(0, 37, 3)))
    mesh_array("facet_nodes", [x for face in boundary for x in face])
    mesh_array("facet_global_ordinals", list(range(12)), ct.c_uint64)
    mesh_array("facet_markers", [1] * 12)
    plan.material.saturation_magnetisation = 8e5
    plan.material.exchange_stiffness = 1.3e-11
    plan.material.damping = 0.1
    plan.material.gyromagnetic_ratio = 2.211e5
    plan.fe_order = 1
    plan.hmax = edge
    plan.precision = abi.enum_value(text, "FULLMAG_FEM_PRECISION_DOUBLE")
    plan.integrator = abi.enum_value(text, "FULLMAG_FEM_INTEGRATOR_RK23_BS")
    plan.enable_exchange = 1
    plan.initial_magnetization_xyz = array([x for i in range(8)
        for x in ((1.0 if i < 4 else -1.0), 0.0, 0.0)], ct.c_double)
    plan.initial_magnetization_len = 24
    plan.ms_element_field = array([8e5, 4e5, 4e5, 4e5, 4e5], ct.c_double)
    plan.ms_element_field_len = 5
    plan.use_consistent_mass = 1
    plan.dt_seconds = 1e-18
    plan.eager_initial_effective_field = 1
    plan.gpu_device_index = -1
    device = ct.create_string_buffer(b"cpu")
    plan.mfem_device_string = ct.cast(device, ct.c_void_p)
    handle = lib.fullmag_fem_backend_create(ct.byref(plan))
    if not handle:
        raise RuntimeError("MFEM CPU DG0 create refused: "
                           + repr(lib.fullmag_fem_backend_last_error(None)))
    measurements = {}
    try:
        actual_device = device_type()
        status = lib.fullmag_fem_backend_get_device_info(handle, ct.byref(actual_device))
        if status != 0 or actual_device.is_gpu_enabled:
            raise RuntimeError(("Requested MFEM CPU lane was not confirmed", status,
                                actual_device.is_gpu_enabled))
        for label, function_name, indices, expected in (
            ("selected", reductions[0], [1, 2, 3, 4], 0.5),
            ("duplicates", reductions[0], [4, 3, 2, 1, 1, 4], 0.5),
            ("central", reductions[0], [0], 1.0),
            ("all", reductions[0], list(range(5)), 9 / 14),
            ("legacy_nodes", reductions[1], list(range(8)), 9 / 14),
        ):
            selected = (ct.c_uint32 * len(indices))(*indices)
            result = (ct.c_double * 3)()
            status = getattr(lib, function_name)(handle, selected, len(indices), result, 3)
            values = list(result)
            if status != 0 or not all(math.isfinite(v) for v in values) or any(
                    abs(v - e) > 1e-12 for v, e in zip(values, [expected, 0, 0])):
                raise AssertionError((label, status, values, expected,
                                      lib.fullmag_fem_backend_last_error(handle)))
            measurements[label] = {"measured": values, "expected_mx": expected}
        # Independent exact-rational P1 oracle on the dimensionless geometry:
        # M_e = (Ms_e / 400k) V_e (1 + delta_ij)/20,
        # K_e = V_e grad(N_i).grad(N_j). Solving M d = K m gives the
        # coefficients below. Restore SI with -2 A/(mu0 Ms_base edge^2).
        coefficients = [900 / 47, 90 / 47, 90 / 47, 90 / 47,
                        -840 / 47, -1480 / 47, -1480 / 47, -1480 / 47]
        scale = -2 * plan.material.exchange_stiffness / (4e-7 * math.pi * 4e5 * edge**2)
        expected_field = [v for d in coefficients for v in (scale * d, 0.0, 0.0)]
        field = (ct.c_double * 24)()
        lib.fullmag_fem_backend_copy_field_f64.argtypes = [ct.c_void_p, ct.c_int,
                                                          ct.POINTER(ct.c_double), ct.c_uint64]
        lib.fullmag_fem_backend_copy_field_f64.restype = ct.c_int
        status = lib.fullmag_fem_backend_copy_field_f64(handle,
            abi.enum_value(text, "FULLMAG_FEM_OBSERVABLE_H_EX"), field, 24)
        field_error = max(abs(a - b) for a, b in zip(field, expected_field)) / max(map(abs, expected_field))
        if status != 0 or not all(math.isfinite(v) for v in field) or field_error > 1e-8:
            raise AssertionError(("DG0 consistent-mass exchange field", status,
                                  list(field), expected_field, field_error))
        measurements["exchange_field"] = {"measured_apm": list(field),
            "expected_apm": expected_field, "max_relative_error": field_error,
            "tolerance": 1e-8}
    finally:
        lib.fullmag_fem_backend_destroy(handle)
    report = {"schema": "fullmag.fem-dg0-analytic-abi.v1", "state": "passed",
        "mfem_version": mfem_version, "hypre_version": hypre_version,
        "lane": "fem_cpu", "scope": "MFEM initialization and initial-state object averages and exchange field",
        "device": actual_device.name.decode("utf-8", "strict"),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "library": str(library), "library_sha256": hashlib.sha256(library.read_bytes()).hexdigest(),
        "header_sha256": hashlib.sha256(header.read_bytes()).hexdigest(),
        "mesh_abi_version": plan.mesh.abi_version, "checks": measurements,
        "inputs": {"edge_m": edge, "vertices_in_edges": vertices, "cells": cells,
            "exterior_facets": boundary, "ms_element_apm": [8e5, 4e5, 4e5, 4e5, 4e5],
            "initial_m": [[1 if i < 4 else -1, 0, 0] for i in range(8)],
            "aex_jpm": plan.material.exchange_stiffness, "consistent_mass": True}}
    if args.output is not None:
        args.output.mkdir(parents=True, exist_ok=False)
        evidence = args.output / "provenance"
        evidence.mkdir()
        (args.output / ".zgroup").write_text('{"zarr_format":2}\n')
        (args.output / ".zattrs").write_text(json.dumps(report, sort_keys=True) + "\n")
        (evidence / "report.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
        (evidence / "fullmag_fem.h").write_bytes(header.read_bytes())
        (evidence / "fdm_cuda_analytic_abi_checks.py").write_bytes(Path(abi.__file__).read_bytes())
        args.output.with_suffix(".py").write_bytes(Path(__file__).read_bytes())
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
