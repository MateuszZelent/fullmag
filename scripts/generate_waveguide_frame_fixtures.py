"""Prepare shared wire fixtures, using an independent Decimal geometry oracle.

This is contract evidence only; it does not execute the Rust implementation.
"""
from decimal import Decimal, localcontext
import json
import argparse
import math
from pathlib import Path
import sys

sys.dont_write_bytecode = True
TOL = Decimal("1e-12")

def norm(v):
    return sum(x*x for x in v).sqrt()

def dot(a, b):
    return sum(x*y for x, y in zip(a, b))

def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

def decimal_oracle(frame, k):
    with localcontext() as ctx:
        ctx.prec = 100
        axes = [[Decimal.from_float(float(x)) for x in frame[name]]
                for name in ("e_u", "e_v", "axis_unit")]
        lengths = [norm(a) for a in axes]
        if any(abs(n-1) > TOL for n in lengths):
            return {"frame_valid": False, "k_valid": False}
        axes = [[x/n for x in a] for a, n in zip(axes, lengths)]
        if any(abs(dot(axes[i], axes[j])) > TOL for i, j in ((0,1),(0,2),(1,2))):
            return {"frame_valid": False, "k_valid": False}
        if abs(dot(cross(axes[0], axes[1]), axes[2])-1) > TOL:
            return {"frame_valid": False, "k_valid": False}
        kd = [Decimal.from_float(float(x)) for x in k]
        if not any(kd):
            return {"frame_valid": True, "k_valid": True, "expected_signed_k_rad_per_m": 0.0}
        scalar = dot(kd, axes[2])
        reconstructed = [scalar*x for x in axes[2]]
        error = norm([x-y for x,y in zip(kd, reconstructed)])/norm(kd)
        max_float = Decimal.from_float(sys.float_info.max)
        if error > TOL or abs(scalar) > max_float:
            return {"frame_valid": True, "k_valid": False}
        return {"frame_valid": True, "k_valid": True,
                "expected_signed_k_rad_per_m": float(scalar)}

def main():
    base = {"origin_m": [0.,0.,0.], "e_u": [1.,0.,0.],
            "e_v": [0.,1.,0.], "axis_unit": [0.,0.,1.]}
    a,b,c = 1/math.sqrt(2),1/math.sqrt(6),1/math.sqrt(3)
    diagonal = dict(base, e_u=[a,-a,0.], e_v=[b,b,-2*b], axis_unit=[c,c,c])
    cases = []
    def add(name, k, frame=None):
        frame = frame or base
        cases.append(dict(name=name, frame=frame, k_vector=k,
                          **decimal_oracle(frame, k)))
    add("gamma", [0.,0.,0.])
    add("positive", [0.,0.,1e7])
    add("negative", [0.,0.,-1e7])
    add("axis_reversal", [0.,0.,1e7], dict(base, e_v=[0.,-1.,0.], axis_unit=[0.,0.,-1.]))
    add("left_handed", [0.,0.,1.], dict(base, axis_unit=[0.,0.,-1.]))
    add("zero_axis", [0.,0.,1.], dict(base, axis_unit=[0.,0.,0.]))
    add("nonunit_axis", [0.,0.,1.], dict(base, axis_unit=[0.,0.,1.001]))
    add("parallel_axes", [0.,0.,1.], dict(base, e_v=[1.,0.,0.]))
    add("near_unit_scales", [0.,0.,1e7], dict(base, e_u=[1+5e-13,0.,0.],
                                             e_v=[0.,1-5e-13,0.], axis_unit=[0.,0.,1+5e-13]))
    add("tiny_transverse", [1e-310,0.,0.])
    add("tiny_collinear", [0.,0.,5*math.ulp(0.)])
    add("subnormal_diagonal", [math.ulp(0.)]*3, diagonal)
    add("large_collinear", [sys.float_info.max*.5]*3, diagonal)
    add("scalar_overflow", [sys.float_info.max*.6]*3, diagonal)
    add("rotated_signed", [-2e7]*3, diagonal)
    add("relative_transverse_within_tolerance", [5e-13,0.,1.])
    add("relative_transverse_outside_tolerance", [2e-12,0.,1.])
    add("large_origin", [0.,0.,1.], dict(base, origin_m=[1e308,-1e308,1e308]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="explicitly replace the checked-in fixture")
    args = parser.parse_args()
    target = (Path(__file__).resolve().parent.parent / "crates/fullmag-ir/tests/fixtures/waveguide_frame_cases.v1.json")
    encoded = (json.dumps({"schema": "fullmag.waveguide-frame-cases.v1",
                          "geometry_tolerance": 1e-12,
                          "oracle": "independent_decimal_100_digits",
                          "cases": cases}, indent=2, allow_nan=False)+"\n").encode("utf-8")
    if args.write:
        target.write_bytes(encoded)
    elif not target.is_file() or target.read_bytes().replace(b"\r\n", b"\n") != encoded:
        raise SystemExit("shared frame fixtures differ from the independent Decimal oracle")
    print(json.dumps({"fixture_count": len(cases), "fixture_check": "PASS",
                      "rust_execution": "NOT VERIFIED"}))

if __name__ == "__main__":
    main()
