#!/usr/bin/env python3
"""Analytic checks of native FDM CUDA terms through the public C ABI (ctypes).

Loads the built ``libfullmag_fdm.so`` (no compilation) and mirrors the
``fullmag_fdm_plan_desc`` layout from ``native/include/fullmag_fdm.h``. Checks:

1. Magnetoelastic energy: one cell, MEL only, B1 != 0, e11 != 0. Rotating m
   from x to y must change E_total by B1 e11 V, and ``eden_total`` must equal
   B1 e11 for m along x.
2. Magnetoelastic field: H_y = -2 B2 e12 m_x / (mu0 Ms_i) with tensor shear
   e12, in two cells with Ms = 800 / 400 kA/m (the second field is twice the
   first).
3. A GPU transport binding attached after creation is rejected with the
   heterogeneous-material gate when the backend holds cellwise alpha or Ms,
   and not on a uniform backend.
4. T1 boundary-corrected exchange (note 0550): a three-cell chain whose free
   ends lie on the outer cell faces (delta = dx/2). The exact Neumann field of
   the end cell equals the clamped stencil (T0 and the uncorrected kernel);
   T1 is not qualified and must be rejected at backend creation.
5. T0 exchange energy density (note 0400): with a cell at 0 < phi < phi_floor,
   sum(eden_ex) * V must equal the scalar exchange energy.

Prints measured values as JSON and exits non-zero on a failed check. Run inside
the Docker DEV backend container from the source root::

    python3 scripts/benchmarks/fdm_cuda_analytic_abi_checks.py

``FULLMAG_FDM_HEADER`` overrides the header path when the script runs from a
copy outside the source tree.
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HEADER = Path(os.environ.get("FULLMAG_FDM_HEADER") or
              Path(__file__).resolve().parents[2] / "native" / "include" / "fullmag_fdm.h")
MU0 = 4.0e-7 * math.pi
GATE = "fdm_cuda_heterogeneous_material_unsupported:gpu_transport"
SCALARS = {
    "double": ctypes.c_double, "int": ctypes.c_int, "uint64_t": ctypes.c_uint64,
    "uint32_t": ctypes.c_uint32, "int32_t": ctypes.c_int32, "uint8_t": ctypes.c_uint8,
}


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", re.sub(r"//[^\n]*", "", text), flags=re.S)


def parse_struct(text: str, name: str, known: dict) -> type:
    match = re.search(r"typedef struct\s*\{([^{}]*)\}\s*" + name + r"\s*;", text)
    if match is None:
        raise SystemExit(f"struct {name} not found in {HEADER}")
    fields = []
    for decl in match.group(1).split(";"):
        decl = " ".join(decl.split())
        if not decl:
            continue
        m = re.fullmatch(r"(?:const )?([A-Za-z_][\w]*)\s*(\*?)\s*([A-Za-z_]\w*)(?:\[(\d+)\])?", decl)
        if m is None:
            raise SystemExit(f"unparsed field in {name}: {decl!r}")
        ctype_name, pointer, field, count = m.groups()
        if pointer:
            ctype = ctypes.c_void_p
        elif ctype_name in SCALARS:
            ctype = SCALARS[ctype_name]
        elif ctype_name in known:
            ctype = known[ctype_name]
        elif re.search(r"typedef enum\s*\{[^{}]*\}\s*" + ctype_name + r"\s*;", text):
            ctype = ctypes.c_int
        else:
            raise SystemExit(f"unknown type {ctype_name} in {name}")
        fields.append((field, ctype * int(count) if count else ctype))
    return type(name, (ctypes.Structure,), {"_fields_": fields})


def enum_value(text: str, name: str) -> int:
    match = re.search(r"\b" + name + r"\s*=\s*(\d+)", text)
    if match is None:
        raise SystemExit(f"enum value {name} not found")
    return int(match.group(1))


def library_path() -> str:
    explicit = os.environ.get("FULLMAG_FDM_LIB")
    if explicit:
        return explicit
    binary = shutil.which("fullmag-bin")
    if binary:
        listing = subprocess.run(["ldd", binary], capture_output=True, text=True).stdout
        for line in listing.splitlines():
            if "libfullmag_fdm.so" in line and "=>" in line:
                return line.split("=>")[1].split("(")[0].strip()
    return "libfullmag_fdm.so"


def main() -> int:
    text = strip_comments(HEADER.read_text(encoding="utf-8"))
    known: dict = {}
    for name in ("fullmag_fdm_grid_desc", "fullmag_fdm_material_desc"):
        known[name] = parse_struct(text, name, known)
    plan_t = parse_struct(text, "fullmag_fdm_plan_desc", known)
    stats_t = parse_struct(text, "fullmag_fdm_step_stats", known)
    lib_path = library_path()
    lib = ctypes.CDLL(lib_path)
    lib.fullmag_fdm_backend_create.restype = ctypes.c_void_p
    lib.fullmag_fdm_backend_create.argtypes = [ctypes.POINTER(plan_t)]
    lib.fullmag_fdm_backend_last_error.restype = ctypes.c_char_p
    lib.fullmag_fdm_backend_last_error.argtypes = [ctypes.c_void_p]
    lib.fullmag_fdm_backend_destroy.argtypes = [ctypes.c_void_p]
    lib.fullmag_fdm_backend_snapshot_stats.argtypes = [ctypes.c_void_p, ctypes.POINTER(stats_t)]
    lib.fullmag_fdm_backend_copy_field_f64.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_double), ctypes.c_uint64]
    lib.fullmag_fdm_backend_copy_scalar_field_f64.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_double), ctypes.c_uint64]
    lib.fullmag_fdm_context_bind_gpu_transport_v1.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    if lib.fullmag_fdm_is_available() == 0:
        print("SKIP: CUDA device unavailable")
        return 0
    precisions = {"double": enum_value(text, "FULLMAG_FDM_PRECISION_DOUBLE"),
                  "single": enum_value(text, "FULLMAG_FDM_PRECISION_SINGLE")}
    obs_h_eff = enum_value(text, "FULLMAG_FDM_OBSERVABLE_H_EFF")
    obs_eden_total = enum_value(text, "FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL")
    err_invalid = int(re.search(r"#define FULLMAG_FDM_ERR_INVALID\s+(-?\d+)", text).group(1))
    dx = 2e-9
    volume = dx ** 3
    keep: list = []

    def array(values, ctype=ctypes.c_double):
        buffer = (ctype * len(values))(*values)
        keep.append(buffer)
        return ctypes.cast(buffer, ctypes.c_void_p)

    def create(cells, m_xyz, precision="double", ms=800e3, ms_field=None, alpha_field=None,
               b1=0.0, b2=0.0, strain=(0.0,) * 6, mel=True):
        plan = plan_t()
        plan.grid.nx, plan.grid.ny, plan.grid.nz = cells, 1, 1
        plan.grid.dx = plan.grid.dy = plan.grid.dz = dx
        plan.material.saturation_magnetisation = ms
        plan.material.exchange_stiffness = 13e-12
        plan.material.damping = 0.1
        plan.material.gyromagnetic_ratio = 2.211e5
        plan.precision = precisions[precision]
        plan.has_magnetoelastic = 1 if mel else 0
        plan.mel_b1, plan.mel_b2 = b1, b2
        for index, value in enumerate(strain):
            plan.mel_strain[index] = value
        plan.initial_magnetization_xyz = array(m_xyz)
        plan.initial_magnetization_len = len(m_xyz)
        if ms_field is not None:
            plan.ms_field, plan.ms_field_len = array(ms_field), len(ms_field)
        if alpha_field is not None:
            plan.alpha_field, plan.alpha_field_len = array(alpha_field), len(alpha_field)
        handle = lib.fullmag_fdm_backend_create(ctypes.byref(plan))
        error = lib.fullmag_fdm_backend_last_error(handle) if handle else b"null handle"
        if not handle or error:
            raise SystemExit(f"backend create failed: {error!r}")
        return handle

    def total_energy(handle):
        stats = stats_t()
        if lib.fullmag_fdm_backend_snapshot_stats(handle, ctypes.byref(stats)) != 0:
            raise SystemExit(f"snapshot_stats failed: {lib.fullmag_fdm_backend_last_error(handle)!r}")
        return stats.total_energy_joules

    def field(handle, observable, length, scalar=False):
        out = (ctypes.c_double * length)()
        copy = lib.fullmag_fdm_backend_copy_scalar_field_f64 if scalar             else lib.fullmag_fdm_backend_copy_field_f64
        if copy(handle, observable, out, length) != 0:
            raise SystemExit(f"copy_field failed: {lib.fullmag_fdm_backend_last_error(handle)!r}")
        return list(out)

    results: dict = {"library": lib_path}
    failures: list[str] = []

    # 1. MEL energy, one cell, B1 e11 only.
    b1, e11 = -3.4e6, 1.0e-3
    expected_delta = b1 * e11 * volume
    for precision, tol in (("double", 1e-12), ("single", 1e-6)):
        along_x = create(1, [1.0, 0.0, 0.0], precision, b1=b1, strain=(e11, 0, 0, 0, 0, 0))
        along_y = create(1, [0.0, 1.0, 0.0], precision, b1=b1, strain=(e11, 0, 0, 0, 0, 0))
        e_x, e_y = total_energy(along_x), total_energy(along_y)
        eden = field(along_x, obs_eden_total, 1, scalar=True)[0]
        for handle in (along_x, along_y):
            lib.fullmag_fdm_backend_destroy(handle)
        rel = abs((e_x - e_y) - expected_delta) / abs(expected_delta)
        eden_rel = abs(eden - b1 * e11) / abs(b1 * e11)
        results[f"mel_energy_{precision}"] = {
            "E_x_J": e_x, "E_y_J": e_y, "delta_J": e_x - e_y, "expected_delta_J": expected_delta,
            "delta_rel_error": rel, "eden_total_x_J_per_m3": eden, "expected_eden_J_per_m3": b1 * e11,
            "eden_rel_error": eden_rel}
        if not (rel <= tol and eden_rel <= tol):
            failures.append(f"MEL energy {precision}: delta rel {rel:.3e}, eden rel {eden_rel:.3e}")

    # 2. MEL shear field with local Ms (tensor e12 = Voigt 2e12 / 2).
    b2, voigt_2e12 = 7.8e6, 2.0e-4
    ms_field = [800e3, 400e3]
    handle = create(2, [1.0, 0.0, 0.0] * 2, b2=b2, strain=(0, 0, 0, 0, 0, voigt_2e12),
                    ms_field=ms_field)
    h = field(handle, obs_h_eff, 6)
    lib.fullmag_fdm_backend_destroy(handle)
    h_y = [h[1], h[4]]  # copy layout is AoS xyz per cell
    expected = [-2.0 * b2 * (voigt_2e12 / 2.0) / (MU0 * ms) for ms in ms_field]
    rels = [abs(a - b) / abs(b) for a, b in zip(h_y, expected)]
    results["mel_shear_field_double"] = {"H_y_A_per_m": h_y, "expected_A_per_m": expected,
                                         "rel_error": rels, "ratio": h_y[1] / h_y[0]}
    if not all(rel <= 1e-12 for rel in rels):
        failures.append(f"MEL shear field rel errors {rels}")

    # 3. Late GPU transport binding with cellwise material.
    binding = (ctypes.c_uint8 * 4096)()
    gate_results = {}
    for label, kwargs in (("alpha_field", {"alpha_field": [0.1, 0.3]}),
                          ("ms_field", {"ms_field": [800e3, 400e3]}),
                          ("uniform", {})):
        handle = create(2, [1.0, 0.0, 0.0] * 2, mel=False, **kwargs)
        status = lib.fullmag_fdm_context_bind_gpu_transport_v1(handle, ctypes.byref(binding))
        error = (lib.fullmag_fdm_backend_last_error(handle) or b"").decode()
        lib.fullmag_fdm_backend_destroy(handle)
        gate_results[label] = {"status": status, "error": error}
        named = GATE in error
        if label == "uniform":
            if status == 0 or named:
                failures.append(f"uniform backend: status {status}, error {error!r}")
        elif status != err_invalid or not named:
            failures.append(f"{label}: status {status}, error {error!r}")
    results["late_transport_binding"] = gate_results

    # Boundary-correction backends: a three-cell x chain, exchange only.
    tiers = {name: enum_value(text, f"FULLMAG_FDM_BOUNDARY_{name.upper()}")
             for name in ("none", "volume", "full")}
    obs_h_ex = enum_value(text, "FULLMAG_FDM_OBSERVABLE_H_EX")
    obs_eden_ex = enum_value(text, "FULLMAG_FDM_OBSERVABLE_EDEN_EX")
    exchange, ms = 13e-12, 800e3

    def create_boundary(tier, m_xyz, phi):
        plan = plan_t()
        plan.grid.nx, plan.grid.ny, plan.grid.nz = 3, 1, 1
        plan.grid.dx = plan.grid.dy = plan.grid.dz = dx
        plan.material.saturation_magnetisation = ms
        plan.material.exchange_stiffness = exchange
        plan.material.damping = 0.1
        plan.material.gyromagnetic_ratio = 2.211e5
        plan.precision = precisions["double"]
        plan.enable_exchange = 1
        plan.initial_magnetization_xyz = array(m_xyz)
        plan.initial_magnetization_len = len(m_xyz)
        plan.boundary_correction = tiers[tier]
        if tier != "none":
            plan.volume_fraction, plan.volume_fraction_len = array(phi), 3
            plan.face_link_xp, plan.face_link_xm = array([1.0, 1.0, 0.0]), array([0.0, 1.0, 1.0])
            for name in ("face_link_yp", "face_link_ym", "face_link_zp", "face_link_zm"):
                setattr(plan, name, array([0.0] * 3))
            # Free ends on the outer cell faces: delta = dx/2; dx means no crossing.
            plan.delta_xp, plan.delta_xm = array([dx, dx, dx / 2]), array([dx / 2, dx, dx])
            for name in ("delta_yp", "delta_ym", "delta_zp", "delta_zm"):
                setattr(plan, name, array([dx / 2] * 3))
        handle = lib.fullmag_fdm_backend_create(ctypes.byref(plan))
        error = (lib.fullmag_fdm_backend_last_error(handle) or b"").decode() if handle \
            else "null handle"
        if handle and error:
            lib.fullmag_fdm_backend_destroy(handle)
            handle = None
        return handle, error

    # 4. T1 at a grid-aligned free face. m = (+x, -x, +x): the end-cell field is
    #    c (m_1 - m_0) 2A/(mu0 Ms) with c = 1/dx^2 for the exact Neumann problem.
    m_flip = [1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    exact_end = 2.0 * exchange / (MU0 * ms) * (-2.0) / dx ** 2
    t1 = {"exact_end_cell_Hx_A_per_m": exact_end}
    for tier in ("none", "volume", "full"):
        handle, error = create_boundary(tier, m_flip, [1.0] * 3)
        if handle is None:
            t1[tier] = {"created": False, "error": error}
            continue
        h_x = field(handle, obs_h_ex, 9)[0]
        lib.fullmag_fdm_backend_destroy(handle)
        t1[tier] = {"created": True, "end_cell_Hx_A_per_m": h_x, "ratio_to_exact": h_x / exact_end}
    results["t1_aligned_free_face"] = t1
    for tier in ("none", "volume"):
        entry = t1[tier]
        if not entry["created"] or abs(entry["ratio_to_exact"] - 1.0) > 1e-12:
            failures.append(f"{tier} end-cell exchange field: {entry}")
    if t1["full"]["created"] or "fdm_boundary_correction_t1_unqualified" not in t1["full"]["error"]:
        failures.append(f"T1 must be rejected at creation: {t1['full']}")

    # 5. T0 energy density with phi_2 = 0.02 < phi_floor = 0.05.
    phi = [1.0, 1.0, 0.02]
    handle, error = create_boundary("volume", [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0], phi)
    if handle is None:
        raise SystemExit(f"T0 backend create failed: {error!r}")
    eden = field(handle, obs_eden_ex, 3, scalar=True)
    stats = stats_t()
    if lib.fullmag_fdm_backend_snapshot_stats(handle, ctypes.byref(stats)) != 0:
        raise SystemExit(f"snapshot_stats failed: {lib.fullmag_fdm_backend_last_error(handle)!r}")
    lib.fullmag_fdm_backend_destroy(handle)
    summed = sum(eden) * volume
    rel = abs(summed - stats.exchange_energy_joules) / abs(stats.exchange_energy_joules)
    results["t0_partial_cell_energy_density"] = {
        "phi": phi, "eden_ex_J_per_m3": eden, "sum_eden_V_J": summed,
        "E_ex_J": stats.exchange_energy_joules, "rel_error": rel}
    if rel > 1e-12:
        failures.append(f"T0 sum(eden_ex) V vs E_ex rel {rel:.3e}")

    print(json.dumps(results, indent=2))
    for failure in failures:
        print(f"ANALYTIC FAILURE: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
