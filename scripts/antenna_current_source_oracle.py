"""Independent V/H oracle for the fixed current-source inspection example.

Validation support, not a FEM solver or a field-basis publisher. Input pins
must come from the executed problem; bundle/request/integrity checks remain
the caller's responsibility. This module does not qualify any backend.
"""
from __future__ import annotations

import hashlib
import json
import math

FIXTURE_INPUT_SHA256 = "a7f2c4f5326cfe5fca253ba99e4e7d47f8b6162d765211abecf68aecaffabb74"
PROBE_POSITIONS = {(0.0, 0.0, 2.0), (1.0, 0.0, 2.0),
                   (0.0, 1.0, 2.0), (0.0, 0.0, 3.0)}


def finite(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return float(value)


def fixture_input_digest(inputs):
    """Pin original device/probe meshes, full current definition and port mode."""
    if not isinstance(inputs, dict) or set(inputs) != {
            "device_mesh", "probe_mesh", "current_definition", "port_mode"}:
        raise ValueError("missing fixed-fixture input documents")
    payload = json.dumps(inputs, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(payload).hexdigest()


def prism_field(position_m, *, y_min_m, current_density_apm2, subdivisions):
    """Integrate a uniform x-directed current in [-1,2] x [y,y+1] x [0,1].

    The x integral is exact; a tensor-product composite Simpson rule covers
    y/z. Targets must lie strictly above or below the source's z slab.
    This is a three-dimensional volume integral, not a filament model.
    """
    if len(position_m) != 3:
        raise ValueError("position must have three components")
    x, y, z = (finite(v, "position") for v in position_m)
    lower = finite(y_min_m, "y_min_m")
    density = finite(current_density_apm2, "current_density_apm2")
    if 0.0 <= z <= 1.0:
        raise ValueError("target must be outside the source z slab")
    if type(subdivisions) is not int or subdivisions not in (8, 16, 32, 64, 128, 256):
        raise ValueError("unsupported bounded Simpson subdivision count")
    n = subdivisions
    hy, hz = [], []
    for i in range(n + 1):
        dy = y - (lower + i / n)
        wi = 1 if i in (0, n) else 4 if i % 2 else 2
        for k in range(n + 1):
            dz = z - k / n
            wk = 1 if k in (0, n) else 4 if k % 2 else 2
            s2 = dy * dy + dz * dz
            a, b = x + 1.0, x - 2.0
            kernel = (a / math.sqrt(a * a + s2) - b / math.sqrt(b * b + s2)) / s2
            hy.append(-wi * wk * dz * kernel)
            hz.append(wi * wk * dy * kernel)
    scale = density / (4 * math.pi * 9 * n * n)
    result = (0.0, scale * math.fsum(hy), scale * math.fsum(hz))
    if not all(math.isfinite(v) for v in result):
        raise ValueError("field exceeds finite oracle range")
    return result


def fixture_field(position_m):
    """Sum signal/return prisms, rejecting exhaustion of the refinement gate.

    Successive-level differences are convergence evidence, not certified
    quadrature-error bounds, and say nothing about omitted external wiring.
    """
    previous = None
    for n in (8, 16, 32, 64, 128, 256):
        signal = prism_field(position_m, y_min_m=0.0, current_density_apm2=1.0, subdivisions=n)
        returning = prism_field(position_m, y_min_m=2.0, current_density_apm2=-1.0, subdivisions=n)
        current = tuple(math.fsum(pair) for pair in zip(signal, returning))
        if previous is not None and math.dist(previous, current) <= 1e-10:
            return current
        previous = current
    raise ValueError("fixed-fixture field quadrature did not converge")


def compare_fixture(inputs, device_ids, potential_v, positions_m, field_apm, *,
                    voltage_tolerance_v, field_absolute_tolerance_apm, field_relative_tolerance):
    """Compare full fixed-fixture V/H samples after authoritative bundle checks.

    Caller passes the actual executed inputs, not the expected fixture or a
    self-authored digest. Potential comparison removes each branch's own gauge.
    Field comparison uses vector norms, including the identically zero H_x.
    """
    if fixture_input_digest(inputs) != FIXTURE_INPUT_SHA256:
        raise ValueError("executed geometry/material/current/port differs from fixed fixture")
    vtol = finite(voltage_tolerance_v, "voltage tolerance")
    atol = finite(field_absolute_tolerance_apm, "field absolute tolerance")
    rtol = finite(field_relative_tolerance, "field relative tolerance")
    if vtol <= 0.0 or atol <= 0.0 or rtol < 0.0:
        raise ValueError("invalid comparison tolerances")
    if len(device_ids) != 16 or len(potential_v) != 16 or any(type(v) is not int for v in device_ids) \
            or set(device_ids) != set(range(1, 17)):
        raise ValueError("device sample IDs/cardinality differ from fixed fixture")
    values = {i: finite(v, "potential") for i, v in zip(device_ids, potential_v)}
    maximum_v_error = 0.0
    for offset, slope in ((0, -0.25), (8, 0.25)):
        left = {offset + i for i in (1, 4, 5, 8)}
        gauge = math.fsum(values[i] for i in left) / 4
        for i in range(offset + 1, offset + 9):
            expected = 0.0 if i in left else slope
            error = abs((values[i] - gauge) - expected)
            if not math.isfinite(error) or error > vtol:
                raise ValueError(f"device potential mismatch at stable ID {i}")
            maximum_v_error = max(maximum_v_error, error)
    if len(positions_m) != 4 or len(field_apm) != 4 \
            or any(len(p) != 3 for p in positions_m) or any(len(h) != 3 for h in field_apm):
        raise ValueError("probe samples must contain four xyz vectors")
    positions = [tuple(finite(v, "position") for v in p) for p in positions_m]
    if set(positions) != PROBE_POSITIONS:
        raise ValueError("probe position membership differs from fixed fixture")
    maximum_h_error = 0.0
    for position, measured in zip(positions, field_apm):
        expected = fixture_field(position)
        measured = tuple(finite(v, "field") for v in measured)
        error = math.dist(expected, measured)
        gate = atol + rtol * math.hypot(*expected)
        if not math.isfinite(gate) or not math.isfinite(error) or error > gate:
            raise ValueError(f"magnetic field vector mismatch at {position}")
        maximum_h_error = max(maximum_h_error, error)
    return {"scope": "fixed_modeled_domain_V_H_comparison_only", "qualification": "NOT VERIFIED",
            "physics_qualified": False, "device_sample_count": 16, "field_sample_count": 4,
            "max_voltage_error_v": maximum_v_error, "max_field_vector_error_apm": maximum_h_error,
            "fixture_input_sha256": FIXTURE_INPUT_SHA256}
