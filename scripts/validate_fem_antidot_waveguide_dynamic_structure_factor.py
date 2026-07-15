#!/usr/bin/env python3
"""Validate finite-k dynamic-structure-factor artifacts and qualification peers."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def load(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text())
    if value.get("schema_version") != "dynamic_structure_factor.1d.v1":
        raise ValueError(f"{path}: unexpected schema_version")
    return value


def peak(value: dict[str, object]) -> tuple[float, float, float]:
    nk = int(value["wavevector_count"]); nf = int(value["frequency_count"])
    power = [float(item) for item in value["power"]]
    if len(power) != nk * nf:
        raise ValueError("finite-k power shape does not match declared axes")
    index = max(range(nk, len(power)), key=power.__getitem__)
    fi, ki = divmod(index, nk)
    return float(value["k_rad_per_m"][ki]), float(value["frequency_hz"][fi]), power[index]


def validate_single(value: dict[str, object]) -> None:
    x = [float(item) for item in value["x_m"]]; time = [float(item) for item in value["time_s"]]
    if len(x) < 4 or len(time) < 4:
        raise ValueError("finite-k axes require at least four samples")
    dx = x[1] - x[0]; dt = time[1] - time[0]
    if dx <= 0 or dt <= 0:
        raise ValueError("finite-k axes must be increasing")
    if any(abs((b-a)-dx) > abs(dx)*1e-9 + math.ulp(dx) for a,b in zip(x,x[1:])):
        raise ValueError("finite-k x axis is not uniform")
    if any(abs((b-a)-dt) > abs(dt)*1e-9 + math.ulp(dt) for a,b in zip(time,time[1:])):
        raise ValueError("finite-k time axis is not uniform")
    if value.get("phase_convention") != "exp[-i(k*x-2*pi*f*t)]":
        raise ValueError("finite-k phase convention is not canonical")
    if value.get("normalization") != "one_sided_abs_fft2_squared_over_Nx_Nt_Ux_Ut":
        raise ValueError("finite-k normalization is not canonical")
    k = [float(item) for item in value["k_rad_per_m"]]
    if max(abs(item) for item in k) > math.pi/dx*(1+1e-12):
        raise ValueError("finite-k wavevector axis violates spatial Nyquist")
    if any(bool(item) for item in value.get("invalid_probe_mask", [])):
        raise ValueError("finite-k artifact contains invalid cross-section probes")
    if not value.get("mesh_probe_signature"):
        raise ValueError("finite-k artifact lacks mesh/probe signature")
    peak(value)


def relative_shift(left: float, right: float) -> float:
    return abs(left-right)/max(abs(left),abs(right),1e-300)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--half-dx", type=Path)
    parser.add_argument("--half-dt", type=Path)
    parser.add_argument("--double-length", type=Path)
    parser.add_argument("--gpu", type=Path)
    parser.add_argument("--without-absorber-reflection", type=float)
    parser.add_argument("--with-absorber-reflection", type=float)
    args = parser.parse_args()
    baseline = load(args.artifact); validate_single(baseline)
    k0, f0, _ = peak(baseline)
    for path, tolerance, label in ((args.half_dx,0.02,"dx convergence"),(args.half_dt,0.01,"dt convergence"),(args.double_length,0.02,"length convergence"),(args.gpu,0.02,"CPU/GPU branch parity")):
        if path:
            peer=load(path); validate_single(peer); k1,f1,_=peak(peer)
            if relative_shift(k0,k1)>=tolerance or relative_shift(f0,f1)>=tolerance:
                raise ValueError(f"{label} failed")
    if (args.without_absorber_reflection is None) != (args.with_absorber_reflection is None):
        raise ValueError("both absorber reflection amplitudes are required")
    if args.without_absorber_reflection is not None:
        if args.without_absorber_reflection <= 0 or args.with_absorber_reflection < 0:
            raise ValueError("reflection amplitudes must be non-negative and baseline positive")
        attenuation_db = 20*math.log10(max(args.with_absorber_reflection,1e-300)/args.without_absorber_reflection)
        if attenuation_db > -20:
            raise ValueError(f"absorber reflection attenuation {attenuation_db:.3f} dB does not reach -20 dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
