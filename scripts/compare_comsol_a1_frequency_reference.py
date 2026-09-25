#!/usr/bin/env python3
"""Compare A1 spectra at identical k, without claiming physical band tracking.

The COMSOL handoff supplies real, locally sorted frequencies only. This tool
does not certify the reference provenance, mode fields, or scientific gate.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from typing import Any


PERIOD_M = 200e-9
SAMPLES = 61
REFERENCE_MODES = 24
REFERENCE_COLUMNS = (
    "jpath", "kx_rad_per_um", "ky_rad_per_um", "frequency_order", "frequency_GHz"
)


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _k(sample: int) -> tuple[float, float]:
    scale = math.pi / PERIOD_M
    if sample <= 20:
        return scale * sample / 20, 0.0
    if sample <= 40:
        return scale, scale * (sample - 20) / 20
    return scale * (60 - sample) / 20, scale * (60 - sample) / 20


def _number(row: dict[str, str], key: str) -> float:
    try:
        value = float(row[key])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"missing or invalid {key}") from error
    if not math.isfinite(value):
        raise ValueError(f"non-finite {key}")
    return value


def _index(row: dict[str, str], key: str) -> int:
    raw = row.get(key)
    if not isinstance(raw, str) or not raw.isascii() or not raw.isdecimal():
        raise ValueError(f"invalid {key}")
    return int(raw)


def read_reference(path: Path) -> dict[int, list[float]]:
    """Validate the complete frequency handoff and return values in Hz."""
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if tuple(reader.fieldnames or ()) != REFERENCE_COLUMNS:
            raise ValueError("unexpected COMSOL reference columns")
        groups: dict[int, dict[int, float]] = {}
        for row in reader:
            sample = _index(row, "jpath")
            order = _index(row, "frequency_order")
            if sample >= SAMPLES or not 1 <= order <= REFERENCE_MODES:
                raise ValueError("COMSOL sample or frequency_order is out of range")
            expected_x, expected_y = _k(sample)
            x = _number(row, "kx_rad_per_um") * 1e6
            y = _number(row, "ky_rad_per_um") * 1e6
            if abs(x - expected_x) > 1e-3 or abs(y - expected_y) > 1e-3:
                raise ValueError(f"COMSOL wave vector disagrees with sample {sample}")
            frequency = _number(row, "frequency_GHz") * 1e9
            if frequency <= 0:
                raise ValueError("COMSOL frequency must be positive")
            group = groups.setdefault(sample, {})
            if order in group:
                raise ValueError(f"duplicate COMSOL frequency order {sample}/{order}")
            group[order] = frequency
    if set(groups) != set(range(SAMPLES)):
        raise ValueError("COMSOL reference requires all 61 samples")
    result: dict[int, list[float]] = {}
    for sample, group in groups.items():
        if set(group) != set(range(1, REFERENCE_MODES + 1)):
            raise ValueError(f"COMSOL sample {sample} must contain 24 modes")
        values = [group[order] for order in range(1, REFERENCE_MODES + 1)]
        if values != sorted(values):
            raise ValueError(f"COMSOL sample {sample} is not frequency-sorted")
        result[sample] = values
    if result[0] != result[60]:
        raise ValueError("duplicate Gamma reference spectra disagree")
    return result


def _read_numeric(path: Path, reference: dict[int, list[float]]) -> dict[int, list[dict[str, Any]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        fields = set(reader.fieldnames or ())
        frequency_key = "frequency_real_hz" if "frequency_real_hz" in fields else "frequency_hz"
        required = {"sample_index", "raw_mode_index", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", frequency_key}
        if not required <= fields:
            raise ValueError(f"Fullmag dispersion is missing columns {sorted(required - fields)}")
        result: dict[int, list[dict[str, Any]]] = {}
        keys: set[tuple[int, int]] = set()
        for row in reader:
            sample = _index(row, "sample_index")
            raw_mode = _index(row, "raw_mode_index")
            if sample not in reference:
                raise ValueError(f"Fullmag sample {sample} is outside the reference path")
            key = (sample, raw_mode)
            if key in keys:
                raise ValueError(f"duplicate Fullmag sample/raw mode {key}")
            keys.add(key)
            expected_x, expected_y = _k(sample)
            x, y, z = (_number(row, name) for name in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
            if abs(x - expected_x) > 1e-3 or abs(y - expected_y) > 1e-3 or abs(z) > 1e-3:
                raise ValueError(f"Fullmag wave vector disagrees with sample {sample}")
            frequency = _number(row, frequency_key)
            if frequency <= 0:
                raise ValueError("Fullmag frequency must be positive")
            residual = _number(row, "residual_norm") if "residual_norm" in fields else None
            result.setdefault(sample, []).append({
                "raw_mode_index": raw_mode,
                "frequency_hz": frequency,
                "residual_norm": residual,
            })
    if not result:
        raise ValueError("Fullmag dispersion contains no frequency rows")
    return result


def _match_ordered(numeric: list[dict[str, Any]], reference: list[float]) -> list[tuple[int, int]]:
    """Minimum relative-log-error monotone subset assignment at one k."""
    count = len(numeric)
    if count > len(reference):
        raise ValueError("Fullmag has more modes than the COMSOL reference at one k")
    cost = [[math.inf] * (len(reference) + 1) for _ in range(count + 1)]
    choice = [[False] * (len(reference) + 1) for _ in range(count + 1)]
    for j in range(len(reference) + 1):
        cost[0][j] = 0.0
    for i in range(1, count + 1):
        for j in range(1, len(reference) + 1):
            skip = cost[i][j - 1]
            match = cost[i - 1][j - 1] + abs(math.log(numeric[i - 1]["frequency_hz"] / reference[j - 1]))
            if match < skip:
                cost[i][j] = match
                choice[i][j] = True
            else:
                cost[i][j] = skip
    pairs: list[tuple[int, int]] = []
    i, j = count, len(reference)
    while i:
        if not j:
            raise ValueError("mode assignment failed")
        if choice[i][j]:
            pairs.append((i - 1, j - 1))
            i -= 1
        j -= 1
    return list(reversed(pairs))


def compare_frequencies(reference: dict[int, list[float]], numeric_path: Path) -> dict[str, Any]:
    """Create a provisional, frequency-only comparison for available samples."""
    numeric = _read_numeric(numeric_path, reference)
    samples: list[dict[str, Any]] = []
    for sample in sorted(numeric):
        modes = sorted(numeric[sample], key=lambda mode: mode["frequency_hz"])
        matches = []
        for index, reference_index in _match_ordered(modes, reference[sample]):
            mode = modes[index]
            f_ref = reference[sample][reference_index]
            matches.append({
                **mode,
                "comsol_frequency_order": reference_index + 1,
                "comsol_frequency_hz": f_ref,
                "difference_hz": mode["frequency_hz"] - f_ref,
                "relative_difference": (mode["frequency_hz"] - f_ref) / f_ref,
            })
        samples.append({
            "sample_index": sample,
            "k_vector_rad_per_m": [*_k(sample), 0.0],
            "matches": matches,
            "missing_comsol_modes": REFERENCE_MODES - len(modes),
        })
    return {
        "schema_version": "fullmag.comsol-a1-frequency-comparison.v1",
        "status": "frequency_only_unqualified",
        "limitations": [
            "COMSOL provenance, mesh, airbox, equilibrium, imaginary frequencies and complex mode fields are unavailable",
            "frequency_order is local sorting, not a tracked physical band",
            "subset matching is an optimal frequency assignment, not mode identity proof",
        ],
        "sample_count": len(samples),
        "samples": samples,
    }


def _verify_managed_a1(case_dir: Path) -> dict[str, Any]:
    if case_dir.name != "a1":
        raise ValueError("expected the managed A1 case directory")
    result = json.loads((case_dir.parent / "run-result.json").read_text(encoding="utf-8"))
    if (result.get("schema") != "fullmag.comsol-dispersion-benchmark.result.v1"
            or result.get("status") not in {"completed_unqualified", "completed_qualified"}
            or result.get("return_code") != 0):
        raise ValueError("a completed managed COMSOL-aligned Fullmag run is required")
    cases = [item for item in result.get("cases", []) if isinstance(item, dict) and item.get("case") == "a1"]
    if len(cases) != 1:
        raise ValueError("managed run has no completed A1 case")
    expected_digest = cases[0].get("required_artifact_hashes", {}).get("eigen/dispersion.csv", {}).get("sha256")
    if not isinstance(expected_digest, str) or expected_digest != _hash(case_dir / "eigen/dispersion.csv"):
        raise ValueError("Fullmag A1 dispersion does not match its managed artifact hash")
    metadata = json.loads((case_dir / "metadata.json").read_text(encoding="utf-8"))
    benchmark = metadata.get("problem_meta", {}).get("runtime_metadata", {}).get("comsol_nonzero_k_dispersion", {})
    if benchmark.get("schema_version") != "fullmag.comsol_nonzero_k_benchmark.v1" or benchmark.get("benchmark_id") != "comsol-py-antidot-square-v1" or benchmark.get("case_id") != "a1":
        raise ValueError("Fullmag metadata is not the A1 benchmark")
    geometry = benchmark.get("geometry", {})
    material = benchmark.get("material", {})
    for actual, expected, label in (
        (geometry.get("lattice_period_m"), PERIOD_M, "lattice period"),
        (geometry.get("hole_radius_m"), 50e-9, "hole radius"),
        (geometry.get("film_size_m", [None, None, None])[-1], 10e-9, "film thickness"),
        (geometry.get("air_padding_each_side_m"), 2e-6, "air padding"),
        (material.get("Ms_A_per_m"), 8e5, "Ms"),
        (material.get("Aex_J_per_m"), 13e-12, "Aex"),
        (material.get("gamma_m_per_A_s"), 2.211e5, "gamma"),
    ):
        if not isinstance(actual, (int, float)) or not math.isclose(actual, expected, rel_tol=1e-12):
            raise ValueError(f"Fullmag A1 {label} does not match the declared COMSOL model")
    return result


def plot_comparison(reference: dict[int, list[float]], report: dict[str, Any], output: Path) -> None:
    """Show exported COMSOL points and available numeric Fullmag points."""
    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import pyplot as plt

    figure, axis = plt.subplots(figsize=(10, 5.5), constrained_layout=True)
    axis.scatter(
        [sample for sample in range(SAMPLES) for _ in reference[sample]],
        [frequency / 1e9 for sample in range(SAMPLES) for frequency in reference[sample]],
        s=9, alpha=0.35, color="#2a69aa", label="COMSOL A1: częstotliwości eksportowane",
    )
    axis.scatter(
        [sample["sample_index"] for sample in report["samples"] for _ in sample["matches"]],
        [item["frequency_hz"] / 1e9 for sample in report["samples"] for item in sample["matches"]],
        s=28, marker="x", linewidths=1.1, color="#c73726", label="Fullmag A1: dostępne mody",
    )
    axis.set_xticks((0, 20, 40, 60), ("Γ", "X", "M", "Γ"))
    axis.set_xlim(-0.5, 60.5)
    axis.set_xlabel("Wektor falowy na ścieżce Γ–X–M–Γ")
    axis.set_ylabel("Częstotliwość (GHz)")
    axis.set_title("A1 — porównanie częstotliwości (wstępne, niekwalifikowane)")
    axis.grid(alpha=0.2)
    axis.legend(loc="upper right", fontsize=8)
    output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output, dpi=180)
    plt.close(figure)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--case-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--plot", type=Path, help="optional provisional scatter plot PNG")
    args = parser.parse_args()
    if args.output.exists() or (args.plot is not None and args.plot.exists()):
        parser.error("output already exists; preserve previous comparison evidence")
    managed = _verify_managed_a1(args.case_dir)
    reference = read_reference(args.reference)
    report = compare_frequencies(reference, args.case_dir / "eigen/dispersion.csv")
    report["reference_sha256"] = _hash(args.reference)
    report["numeric_dispersion_sha256"] = _hash(args.case_dir / "eigen/dispersion.csv")
    report["fullmag_run_source"] = managed.get("source")
    report["fullmag_run_qualification"] = managed.get("qualification")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.plot is not None:
        plot_comparison(reference, report, args.plot)
    print(f"COMSOL A1 frequency-only comparison: {report['sample_count']} samples; {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
