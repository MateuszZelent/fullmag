#!/usr/bin/env python3
"""Bounded CUDA regional interaction checks; run in the selected DEV backend.

The two cells have Ms=400/800 kA/m. Check the variational identity with these
local weights. Additional analytical checks are recorded separately. Planner-
owned Newell spectra and the public API route have separate admission gates. This does not qualify the public
Python/API route, arbitrary geometry or long fp32 trajectories.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes as ct
import hashlib
import json
import math
import os
from pathlib import Path

import fdm_cuda_analytic_abi_checks as abi

MU0 = 4e-7 * math.pi
MS = [4e5, 8e5]
ALPHA = [0.1, 0.4]
EDGE = 2e-9
VOLUME = EDGE**3


def normalized(vector):
    norm = math.sqrt(sum(v*v for v in vector))
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError("invalid vector norm")
    return [v/norm for v in vector]


def constant_field_solution(alpha, field_am, time_s, gamma=2.211e5):
    """Gilbert LLG in a constant +z field, initially m=+x (note llg_conventions)."""
    phase = gamma * field_am * time_s / (1 + alpha*alpha)
    transverse = 1 / math.cosh(alpha * phase)
    return [transverse*math.cos(phase), transverse*math.sin(phase), math.tanh(alpha*phase)]


def check_gradient(m, ms, volume, field, energy, *, epsilon, tolerance):
    if len(m) != len(ms) or len(field) != len(m) or volume <= 0:
        raise ValueError("invalid material/field extents")
    if any(len(row) != 3 or not all(math.isfinite(v) for v in row) for row in [*m, *field]):
        raise ValueError("nonfinite or incomplete vectors")
    if any(not math.isfinite(v) or v <= 0 for v in ms):
        raise ValueError("invalid local Ms")
    if any(abs(sum(x*x for x in row)-1) > 1e-12 for row in m):
        raise ValueError("reference magnetization is not normalized")
    probes = []
    informative = False
    for cell, state in enumerate(m):
        scale = MU0 * ms[cell] * volume * math.sqrt(sum(h*h for h in field[cell]))
        for axis in range(3):
            tangent = [float(i == axis) - state[axis]*state[i] for i in range(3)]
            if sum(v*v for v in tangent) < 1e-24:
                continue
            tangent = normalized(tangent)
            plus, minus = [row[:] for row in m], [row[:] for row in m]
            plus[cell] = normalized([x + epsilon*d for x, d in zip(state, tangent)])
            minus[cell] = normalized([x - epsilon*d for x, d in zip(state, tangent)])
            ep, em = energy(plus), energy(minus)
            if not math.isfinite(ep) or not math.isfinite(em):
                raise ValueError("nonfinite energy")
            numerical = (ep-em)/(2*epsilon)
            predicted = -MU0 * ms[cell] * volume * sum(h*d for h, d in zip(field[cell], tangent))
            denominator = max(abs(numerical), abs(predicted), scale)
            error = abs(numerical-predicted)/denominator if denominator else 0.0
            informative |= abs(predicted) > 1e-8*scale and scale > 0
            probes.append({"cell": cell, "axis": axis, "numerical_j": numerical,
                           "predicted_j": predicted, "relative_error": error})
    if not informative:
        raise ValueError("uninformative zero-gradient measurement")
    maximum = max(p["relative_error"] for p in probes)
    if maximum > tolerance:
        raise AssertionError(json.dumps({"max_relative_error": maximum,
            "tolerance": tolerance, "probes": probes}))
    return {"max_relative_error": maximum, "tolerance": tolerance, "epsilon": epsilon, "probes": probes}


class NativeFdm:
    def __init__(self, library, header):
        self.library, self.header = library, header
        abi.HEADER = header
        self.text = abi.strip_comments(header.read_text())
        self.types = {}
        for name in ("fullmag_fdm_grid_desc", "fullmag_fdm_material_desc",
                     "fullmag_fdm_plan_desc", "fullmag_fdm_step_stats",
                     "fullmag_fdm_time_policy_desc_v2", "fullmag_fdm_plan_desc_v2"):
            self.types[name] = abi.parse_struct(self.text, name, self.types)
        self.plan_type = self.types["fullmag_fdm_plan_desc"]
        self.stats_type = self.types["fullmag_fdm_step_stats"]
        self.lib = ct.CDLL(str(library))
        self.bind("fullmag_fdm_backend_create", [ct.POINTER(self.plan_type)], ct.c_void_p)
        self.bind("fullmag_fdm_backend_create_time_policy_v2",
                  [ct.POINTER(self.types["fullmag_fdm_plan_desc_v2"])], ct.c_void_p)
        self.bind("fullmag_fdm_backend_destroy", [ct.c_void_p], None)
        self.bind("fullmag_fdm_backend_last_error", [ct.c_void_p], ct.c_char_p)
        self.bind("fullmag_fdm_backend_snapshot_stats", [ct.c_void_p, ct.POINTER(self.stats_type)], ct.c_int)
        self.bind("fullmag_fdm_backend_step", [ct.c_void_p, ct.c_double, ct.POINTER(self.stats_type)], ct.c_int)
        self.bind("fullmag_fdm_backend_copy_field_f64", [ct.c_void_p, ct.c_int, ct.POINTER(ct.c_double), ct.c_uint64], ct.c_int)
        if not self.lib.fullmag_fdm_is_available():
            raise RuntimeError("CUDA is unavailable; qualification cannot pass by skipping")

    def bind(self, name, arguments, result):
        function = getattr(self.lib, name)
        function.argtypes, function.restype = arguments, result

    def enum(self, name):
        return abi.enum_value(self.text, "FULLMAG_FDM_" + name)

    @contextmanager
    def backend(self, m, precision, *, settings=None, arrays=None, aex=0, integrator="RK4", exchange_faces=None):
        plan = self.plan_type()
        plan.grid.nx, plan.grid.ny, plan.grid.nz = 2, 1, 1
        plan.grid.dx = plan.grid.dy = plan.grid.dz = EDGE
        plan.material.saturation_magnetisation = 6e5
        plan.material.exchange_stiffness = aex
        plan.material.damping = 0.7
        plan.material.gyromagnetic_ratio = 2.211e5
        plan.precision = self.enum("PRECISION_" + precision.upper())
        plan.integrator = self.enum("INTEGRATOR_" + integrator)
        buffers = []
        def pointer(values):
            value = (ct.c_double * len(values))(*values)
            buffers.append(value)
            return ct.cast(value, ct.c_void_p)
        plan.ms_field, plan.ms_field_len = pointer(MS), 2
        plan.alpha_field, plan.alpha_field_len = pointer(ALPHA), 2
        plan.initial_magnetization_xyz = pointer([x for row in m for x in row])
        plan.initial_magnetization_len = 6
        fields = {name for name, _ in plan._fields_}
        for name, value in (settings or {}).items():
            if name not in fields:
                raise ValueError("Unknown native descriptor field: " + name)
            if isinstance(value, (list, tuple)):
                target = getattr(plan, name)
                if len(target) != len(value):
                    raise ValueError("Wrong native vector extent: " + name)
                target[:] = value
            else:
                setattr(plan, name, value)
        for name, value in (arrays or {}).items():
            if name not in fields:
                raise ValueError("Unknown native pointer field: " + name)
            setattr(plan, name, pointer(value))
            if name + "_len" in fields:
                setattr(plan, name + "_len", len(value))
        if exchange_faces is None:
            handle = self.lib.fullmag_fdm_backend_create(ct.byref(plan))
        else:
            extended = self.types["fullmag_fdm_plan_desc_v2"]()
            extended.abi_version, extended.struct_size, extended.base = 2, ct.sizeof(extended), plan
            extended.exchange_operator_mode, extended.exchange_face_len = self.enum("EXCHANGE_OPERATOR_FACES"), 2
            extended.exchange_face_x_plus = pointer(exchange_faces)
            extended.exchange_face_y_plus = pointer([0., 0.])
            extended.exchange_face_z_plus = pointer([0., 0.])
            handle = self.lib.fullmag_fdm_backend_create_time_policy_v2(ct.byref(extended))
        try:
            if not handle or self.lib.fullmag_fdm_backend_last_error(handle):
                raise RuntimeError(("native create", self.lib.fullmag_fdm_backend_last_error(handle)))
            yield handle, plan
        finally:
            if handle:
                self.lib.fullmag_fdm_backend_destroy(handle)

    def field(self, handle, name):
        out = (ct.c_double * 6)()
        status = self.lib.fullmag_fdm_backend_copy_field_f64(handle, self.enum("OBSERVABLE_"+name), out, 6)
        if status or not all(math.isfinite(v) for v in out):
            raise RuntimeError(("native field", name, status))
        return [list(out[:3]), list(out[3:])]

    def evaluate(self, m, precision, **config):
        with self.backend(m, precision, **config) as (handle, _):
            stats = self.stats_type()
            status = self.lib.fullmag_fdm_backend_snapshot_stats(handle, ct.byref(stats))
            if status or not math.isfinite(stats.total_energy_joules):
                raise RuntimeError(("native energy", status))
            return stats.total_energy_joules, self.field(handle, "H_EFF")


def main():
    library = Path(abi.library_path()).resolve(strict=True)
    header = Path(os.environ.get("FULLMAG_FDM_HEADER") or Path(__file__).resolve().parents[2]/"native/include/fullmag_fdm.h")
    native = NativeFdm(library, header)
    m = [normalized([1, 2, 3]), normalized([-2, 3, 1])]
    axis = normalized([1, 2, -1])
    external = [1.2e4, -0.8e4, 0.3e4]
    strain = [1e-3, -0.5e-3, 0.2e-3, 0.4e-3, -0.3e-3, 0.2e-3]
    cases = {
        "zeeman": {"settings": {"has_external_field": 1, "external_field_am": external}},
        "uniaxial": {"settings": {"has_uniaxial_anisotropy": 1,
            "uniaxial_anisotropy_constant": 3e4, "uniaxial_anisotropy_k2": 5e3, "anisotropy_axis": axis},
            "arrays": {"ku1_field": [3e4, 5e4], "ku2_field": [5e3, 9e3]}},
        "cubic": {"settings": {"has_cubic_anisotropy": 1, "cubic_Kc1": 2e4,
            "cubic_Kc2": -4e3, "cubic_Kc3": 1e3, "cubic_axis1": [1, 0, 0], "cubic_axis2": [0, 1, 0]},
            "arrays": {"kc1_field": [2e4, 4e4], "kc2_field": [-4e3, -6e3], "kc3_field": [1e3, 2e3]}},
        "mel": {"settings": {"has_magnetoelastic": 1, "mel_b1": -3.4e6,
            "mel_b2": 7.8e6, "mel_strain": strain}},
        "demag": {"settings": {"enable_demag": 1}},
        "exchange": {"aex": 13e-12, "settings": {"enable_exchange": 1}},
        "exchange_local_a": {"aex": 13e-12, "settings": {"enable_exchange": 1},
            "arrays": {"a_field": [10e-12, 20e-12]},
            "exchange_faces": [2*10e-12*20e-12/(10e-12+20e-12), 0.]},
        "idmi_exchange": {"aex": 13e-12, "settings": {"enable_exchange": 1,
            "has_interfacial_dmi": 1, "dmi_D_interfacial": 1.2e-3}},
        "bulk_dmi_exchange": {"aex": 13e-12, "settings": {"enable_exchange": 1,
            "has_bulk_dmi": 1, "dmi_D_bulk": 1.2e-3}},
    }
    results = {}
    for precision in ("double", "single"):
        epsilon, gradient_tolerance = (1e-5, 1e-7) if precision == "double" else (1e-3, 3e-3)
        for name, config in cases.items():
            try:
                energy, field = native.evaluate(m, precision, **config)
            except RuntimeError as error:
                if name == "demag" and "requires validated Newell tensor spectra" in str(error):
                    results[name+"_"+precision] = {"state": "expected_refusal",
                        "reason": str(error), "physics_qualification": "NOT VERIFIED; requires planner-owned spectra"}
                    continue
                raise RuntimeError((name, precision, str(error))) from error
            try:
                measured = check_gradient(m, MS, VOLUME, field,
                    lambda state: native.evaluate(state, precision, **config)[0],
                    epsilon=epsilon, tolerance=gradient_tolerance)
            except (ValueError, AssertionError) as error:
                raise AssertionError((name, precision, str(error))) from error
            results[name+"_"+precision] = {"energy_j": energy, "field_apm": field, "gradient": measured}
            if name in {"zeeman", "uniaxial", "cubic", "mel"}:
                # Notes 0402/0403/0700: compare energy differences, so the
                # arbitrary magnetization-independent MEL offset cancels.
                def polynomial(states):
                    total = 0.
                    for i, (x,y,z) in enumerate(states):
                        if name == "zeeman":
                            density = -MU0*MS[i]*sum(v*h for v,h in zip((x,y,z), external))
                        elif name == "uniaxial":
                            q = sum(v*u for v,u in zip((x,y,z), axis))
                            density = -[3e4,5e4][i]*q*q - [5e3,9e3][i]*q**4
                        elif name == "cubic":
                            s = x*x*y*y + y*y*z*z + z*z*x*x
                            density = [2e4,4e4][i]*s + [-4e3,-6e3][i]*x*x*y*y*z*z + [1e3,2e3][i]*s*s
                        else:
                            e11,e22,e33,g23,g13,g12 = strain
                            density = -3.4e6*(e11*x*x + e22*y*y + e33*z*z) + 7.8e6*(g23*y*z + g13*x*z + g12*x*y)
                        total += VOLUME*density
                    return total
                reference = [[1.,0.,0.], [0.,1.,0.]]
                expected = polynomial(m)-polynomial(reference)
                measured_delta = energy-native.evaluate(reference, precision, **config)[0]
                energy_tolerance = 1e-12 if precision == "double" else 1e-6
                relative_error = abs(measured_delta-expected)/max(abs(expected), VOLUME)
                if relative_error > energy_tolerance:
                    raise AssertionError(("analytic energy", name, precision, measured_delta, expected, relative_error))
                results[name+"_"+precision]["analytic_energy_difference"] = {
                    "expected_j": expected, "measured_j": measured_delta,
                    "relative_error": relative_error, "tolerance": energy_tolerance,
                    "reference_m": reference}
        # An independent time-domain solution catches a shared field/energy
        # implementation error and use of the scalar alpha instead of alpha_i.
        for integrator in ("HEUN", "RK4", "RK23", "DP45", "ABM3"):
            with native.backend([[1., 0., 0.], [1., 0., 0.]], precision,
                    settings={"has_external_field": 1, "external_field_am": [0., 0., 2e4]},
                    integrator=integrator) as (handle, _):
                stats = native.stats_type()
                for _ in range(100):
                    if native.lib.fullmag_fdm_backend_step(handle, 1e-14, ct.byref(stats)):
                        raise RuntimeError(("LLG step", precision, integrator,
                            native.lib.fullmag_fdm_backend_last_error(handle)))
                actual = native.field(handle, "M")
                if not math.isfinite(stats.time_seconds) or stats.time_seconds <= 0 or stats.step != 100:
                    raise AssertionError("LLG accepted time/step counter is invalid")
                expected = [constant_field_solution(a, 2e4, stats.time_seconds) for a in ALPHA]
                error = max(abs(x-y) for row, ref in zip(actual, expected) for x,y in zip(row,ref))
                llg_tolerance = 5e-8 if precision == "double" else 1e-5
                if error > llg_tolerance:
                    raise AssertionError(("LLG", precision, integrator, error, llg_tolerance, actual, expected))
                results["llg_"+integrator.lower()+"_"+precision] = {
                    "accepted_steps": stats.step, "accepted_time_s": stats.time_seconds,
                    "actual_m": actual, "expected_m": expected, "max_absolute_error": error,
                    "tolerance": llg_tolerance, "alpha": ALPHA, "scalar_alpha": 0.7,
                    "h_ext_apm": [0., 0., 2e4], "requested_step_s": 1e-14}
    report = {"schema": "fullmag.fdm-regional-interaction-abi.v1", "state": "passed",
        "scope": "two-cell native CUDA variational and energy oracles; constant-field LLG with local Ms/alpha",
        "library_sha256": hashlib.sha256(library.read_bytes()).hexdigest(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "header_sha256": hashlib.sha256(header.read_bytes()).hexdigest(),
        "ms_apm": MS, "initial_m": m, "edge_m": EDGE, "cases": cases, "checks": results}
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
