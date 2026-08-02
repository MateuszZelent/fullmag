#!/usr/bin/env python3
"""Compare the source-derived 1D direct-SHE limits of BORIS and Fullmag.

This is deliberately a reduced oracle.  It does not invoke ``BorisLin`` or
claim CPU/CUDA executable parity.  The BORIS side is the uniform-film limit
of ``NHNeumann_Sdiff`` and ``Transport_Spin_Display``; the Fullmag side is the
M1 constitutive law with ``mu_s`` defined as the full channel splitting.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable


BORIS_MUB_E_V_PER_T = 5.788381608e-05
SOURCE_FILES = (
    "makefile",
    "BorisLib/Funcs_Math_base.h",
    "Boris/STransport_Spin.cpp",
    "Boris/Transport_Spin.cpp",
    "Boris/Transport_Spin_Display.cpp",
    "Boris/TransportCUDA.cu",
    "Boris/TransportBase.h",
)


def _require_positive(name: str, value: float) -> float:
    if not math.isfinite(value) or value <= 0.0:
        raise ValueError(f"{name} must be finite and positive")
    return value


def _source_hashes() -> dict[str, str]:
    root = Path(__file__).resolve().parents[1] / "external_solvers" / "BORIS"
    hashes: dict[str, str] = {}
    for relative in SOURCE_FILES:
        path = root / relative
        if not path.is_file():
            raise ValueError(f"missing BORIS source file: {path}")
        hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def _max_relative_error(left: list[float], right: list[float]) -> float:
    scale = max(max(abs(value) for value in left), max(abs(value) for value in right), 1.0e-300)
    return max(abs(a - b) for a, b in zip(left, right, strict=True)) / scale


def compare_direct_she_1d(
    *,
    length_m: float = 8.0e-9,
    lambda_sf_m: float = 1.5e-9,
    electric_field_v_per_m: float = 2.0e5,
    sigma_spm: float = 6.7e6,
    sha: float = 0.19,
    theta_sh: float = 0.19,
    samples: int = 129,
    tolerance: float = 1.0e-13,
) -> dict[str, object]:
    """Return a machine-readable reduced direct-SHE comparison.

    For a uniform film with ``E = E_x e_x`` and spin flow along ``z``, BORIS
    imposes ``d_n S_y = SHA * sigma * MUB_E * E_x / De``.  Its adapter gives
    ``V_s = De * S / (sigma * MUB_E)``, hence ``d_n V_s = SHA * E_x``.  Fullmag
    uses ``Q_zy = -sigma_s*d_z(mu_s)/2 + theta_SH*sigma*E_x`` with zero normal
    spin flux.  With ``sigma_s=sigma``, ``theta_SH=SHA`` and the explicit
    full-splitting mapping ``mu_s=2*V_s``, the two profiles and normalized
    fluxes are identical.
    """

    _require_positive("length_m", length_m)
    _require_positive("lambda_sf_m", lambda_sf_m)
    _require_positive("sigma_spm", sigma_spm)
    _require_positive("samples", float(samples))
    if samples < 3 or samples % 2 == 0:
        raise ValueError("samples must be an odd integer >= 3")
    if not math.isfinite(electric_field_v_per_m) or not math.isfinite(sha) or not math.isfinite(theta_sh):
        raise ValueError("electric_field_v_per_m, sha, and theta_sh must be finite")
    if not math.isfinite(tolerance) or tolerance <= 0.0:
        raise ValueError("tolerance must be finite and positive")

    half_length = 0.5 * length_m
    denominator = math.cosh(half_length / lambda_sf_m)
    coordinates = [
        -half_length + length_m * index / (samples - 1)
        for index in range(samples)
    ]
    # BORIS source-side spin voltage after S -> V_s conversion.  The
    # conversion cancels De, sigma and MUB_E in this uniform limit, but the
    # constant is retained below to make the adapter auditable.
    boris_vs = [
        sha * electric_field_v_per_m * lambda_sf_m * math.sinh(z / lambda_sf_m) / denominator
        for z in coordinates
    ]
    boris_vs_gradient = [
        sha * electric_field_v_per_m * math.cosh(z / lambda_sf_m) / denominator
        for z in coordinates
    ]
    # Fullmag's public mu_s is the full V+ - V- splitting, so it is twice the
    # BORIS channel voltage under the explicit adapter used by this gate.
    fullmag_mu_s = [
        2.0 * theta_sh * electric_field_v_per_m * lambda_sf_m * math.sinh(z / lambda_sf_m) / denominator
        for z in coordinates
    ]
    fullmag_mu_s_gradient = [
        2.0 * theta_sh * electric_field_v_per_m * math.cosh(z / lambda_sf_m) / denominator
        for z in coordinates
    ]
    mapped_boris_mu_s = [2.0 * value for value in boris_vs]
    # Compare charge-equivalent fluxes: BORIS's flux is divided by sigma*MUB_E;
    # Fullmag's is divided by sigma_s=sigma.
    boris_normalized_flux = [
        sha * electric_field_v_per_m - gradient
        for gradient in boris_vs_gradient
    ]
    fullmag_normalized_flux = [
        -0.5 * gradient + theta_sh * electric_field_v_per_m
        for gradient in fullmag_mu_s_gradient
    ]

    profile_error = _max_relative_error(mapped_boris_mu_s, fullmag_mu_s)
    flux_error = _max_relative_error(boris_normalized_flux, fullmag_normalized_flux)
    passed = profile_error <= tolerance and flux_error <= tolerance
    return {
        "schema_version": "boris_fullmag_she_1d.v1",
        "status": "pass" if passed else "fail",
        "reference_kind": "source-derived-reduced-oracle",
        "boris_executable_invoked": False,
        "boris_version_marker": "BVERSION 380 (makefile); local pre-release snapshot",
        "boris_mub_e_v_per_t": BORIS_MUB_E_V_PER_T,
        "mapping": "mu_s = 2 V_s",
        "boris_adapter": "V_s = De*S/(sigma*MUB_E)",
        "iSHA_mode": "0 (direct one-way gate)",
        "length_m": length_m,
        "lambda_sf_m": lambda_sf_m,
        "electric_field_v_per_m": electric_field_v_per_m,
        "sigma_spm": sigma_spm,
        "sha": sha,
        "theta_sh": theta_sh,
        "samples": samples,
        "boris_spin_voltage_top_minus_bottom_v": boris_vs[-1] - boris_vs[0],
        "fullmag_spin_voltage_top_minus_bottom_v": fullmag_mu_s[-1] - fullmag_mu_s[0],
        "max_profile_relative_error": profile_error,
        "max_normalized_flux_error": flux_error,
        "source_sha256": _source_hashes(),
    }


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a short status line")
    parser.add_argument("--theta-sh", type=float, default=0.19)
    parser.add_argument("--sha", type=float, default=0.19)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        result = compare_direct_she_1d(theta_sh=args.theta_sh, sha=args.sha)
    except ValueError as error:
        print(f"FAIL: {error}")
        return 1
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(
            f"{result['status'].upper()}: reduced BORIS/Fullmag 1D direct-SHE "
            f"profile_error={result['max_profile_relative_error']:.3e} "
            f"flux_error={result['max_normalized_flux_error']:.3e}"
        )
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
