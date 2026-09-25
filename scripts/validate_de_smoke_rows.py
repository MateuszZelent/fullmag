"""Strict numerical-row preflight for DE-SMOKE; not a scientific certificate.

T4, field/profile identity and convergence remain separate requirements even
when this check passes. Frequencies are never replaced by a reference model.
"""
from __future__ import annotations
import csv
import math
from pathlib import Path

SAMPLING = {"two": (0.0, 2e6), "five": (0.0, 1e6, 2e6, 3e6, 5e6), "k2": (2e6,)}


def validate_rows(path: Path, sampling: str):
    if sampling not in SAMPLING:
        raise ValueError("unsupported DE-SMOKE sampling")
    expected = SAMPLING[sampling]
    rows = []
    seen = set()
    seen_branch = set()
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            indices = {}
            for key in ("sample_index", "raw_mode_index", "branch_id"):
                text = row.get(key, "")
                if not isinstance(text, str) or not text.isascii() or not text.isdecimal():
                    raise ValueError(f"invalid {key}")
                indices[key] = int(text)
            sample = indices["sample_index"]
            if sample >= len(expected):
                raise ValueError("sample index outside the requested path")
            values = {}
            for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz", "residual_norm"):
                try:
                    values[key] = float(row[key])
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError(f"missing or invalid {key}") from error
                if not math.isfinite(values[key]):
                    raise ValueError(f"nonfinite {key}")
            if values["kx_rad_per_m"] != 0 or values["kz_rad_per_m"] != 0:
                raise ValueError("wavevector is outside the DE direction")
            if not math.isclose(values["ky_rad_per_m"], expected[sample], rel_tol=1e-12, abs_tol=1e-12):
                raise ValueError("wavevector does not match its sample index")
            if not 8.5e9 <= values["frequency_hz"] <= 12e9:
                raise ValueError("frequency outside the frozen DE-SMOKE window")
            # The CSV carries the absolute residual. The 1e-8 scientific
            # threshold belongs to the separately exported relative residual.
            if values["residual_norm"] < 0:
                raise ValueError("absolute residual must be nonnegative")
            key = (sample, indices["raw_mode_index"])
            branch_key = (sample, indices["branch_id"])
            if key in seen or branch_key in seen_branch:
                raise ValueError("duplicate mode or branch in a sample")
            seen.add(key)
            seen_branch.add(branch_key)
            rows.append({**indices, **values})
    if {r["sample_index"] for r in rows} != set(range(len(expected))):
        raise ValueError("missing DE-SMOKE samples")
    return {"schema": "fullmag.de-smoke-row-preflight.v1", "status": "pass",
            "qualification": "NOT VERIFIED", "sampling": sampling,
            "mode_rows": len(rows), "sample_count": len(expected),
            "max_absolute_residual_norm": max(r["residual_norm"] for r in rows),
            "pending_requirements": ["native original-pencil residual and numeric-source attestation",
                "T4 demag operator comparison", "complex fields, Bloch phase and mesh identity",
                "explicit n0 branch identification and analytical comparison",
                "mesh, airbox and mode-count convergence"]}
