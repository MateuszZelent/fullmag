#!/usr/bin/env python3
"""Compare FDM CPU and CUDA runs of the region/material parity cases.

Each case of ``fdm_regions_parity_case.py`` runs on the CPU reference and on
CUDA fp64. The final magnetization of every lane is compared with the CPU
reference (max |dm| over cells and components), and the final-row scalars of
``artifacts/scalars.csv`` are compared where both lanes report them.

``--with-fp32`` adds the fp32 tolerance qualification: CUDA fp32 and the CPU
fp64 reference run a short horizon (``--fp32-steps``) with ``H_ex`` and
``H_eff`` saved; fields are compared at every step both lanes saved, which must
include the final step. The fp32 lane must stay within ``--fp32-max-dm``,
``--fp32-max-energy-rel`` and ``--fp32-max-field-rel`` (max |dH| over cells and
components divided by max |H| of the reference sample).
The long fp64 horizon is not used for fp32: the random texture is chaotic, so
after 2000 steps any rounding difference has grown to O(1).

Results go to ``<output>/parity.jsonl`` and a Markdown table to stdout. The
script exits non-zero when a lane fails, its ``m_final`` or a saved field is
missing, has the wrong shape or is non-finite, a compared energy is non-finite,
or a lane exceeds its tolerances.

Usage (inside the backend container, from the source root)::

    python3 scripts/benchmarks/run_fdm_regions_parity.py --output /tmp/regions-parity --with-fp32
"""

from __future__ import annotations

import argparse
import array
import csv
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

CASE_SCRIPT = Path(__file__).with_name("fdm_regions_parity_case.py")
CASES = ["two_materials", "two_materials_scaled", "grains", "uniform", "uniform_regions"]
FIELDS = ("H_ex", "H_eff")
ZARR_DTYPES = {"<f4": "f", "<f8": "d"}
PREVIEW_OFF_ENV = {
    "FULLMAG_DISABLE_PREVIEW_3D": "1",
    "FULLMAG_DISABLE_PREVIEW_2D": "1",
    "FULLMAG_DISABLE_LIVE_MAGNETIZATION": "1",
    "FULLMAG_API_PORT": "0",
}


def run(case: str, device: str, precision: str, steps: int, output: Path, fullmag_bin: str,
        save_fields: bool = False) -> dict:
    run_dir = output / (f"{case}-{device}-{precision}" + (f"-q{steps}" if save_fields else ""))
    # A stale run directory could supply artifacts from an earlier build.
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)
    env = dict(os.environ, **PREVIEW_OFF_ENV,
               FDM_REGIONS_CASE=case, FDM_REGIONS_DEVICE=device,
               FDM_REGIONS_PRECISION=precision, FDM_REGIONS_STEPS=str(steps),
               FDM_REGIONS_SAVE_FIELDS="1" if save_fields else "0")
    command = [fullmag_bin, str(CASE_SCRIPT), "--backend", "fdm", "--headless", "--json",
               "--output-dir", str(run_dir / "out")]
    started = time.perf_counter()
    completed = subprocess.run(command, env=env, capture_output=True, text=True)
    wall_s = time.perf_counter() - started
    (run_dir / "stdout.txt").write_text(completed.stdout)
    (run_dir / "stderr.txt").write_text(completed.stderr)
    artifacts = run_dir / "out" / "artifacts"
    m_final = None
    m_path = artifacts / "m_final.json"
    if m_path.is_file():
        m_final = json.loads(m_path.read_text())["values"]
    scalars = None
    scalars_path = artifacts / "scalars.csv"
    if scalars_path.is_file():
        with scalars_path.open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        if rows:
            scalars = {key: float(value) for key, value in rows[-1].items()
                       if value not in ("", None) and _is_float(value)}
    fields = None
    if save_fields:
        fields = {}
        for name in FIELDS:
            try:
                fields[name] = read_field_samples(artifacts, name)
            except (OSError, KeyError, ValueError) as error:
                fields[name] = f"unreadable: {error}"
    return {
        "case": case, "device": device, "precision": precision, "steps": steps,
        "returncode": completed.returncode, "wall_s": wall_s,
        "stderr_tail": completed.stderr[-2000:] if completed.returncode else "",
        "m_final": m_final, "scalars": scalars, "fields": fields,
        "m_final_sha256": None if m_final is None
        else hashlib.sha256(json.dumps(m_final).encode()).hexdigest(),
    }


def _is_float(value: str) -> bool:
    try:
        float(value)
    except ValueError:
        return False
    return True


def read_field_samples(artifacts: Path, name: str) -> dict[int, list[float]]:
    """Read every saved sample of one field as flat ``[x0, y0, z0, x1, ...]``, keyed by step.

    The lanes write different self-describing stores: CUDA an uncompressed zarr
    v2 ``fields/<name>.zarr`` (axes sample/component/cell, chunks ``[1, 3, c]``,
    padded tail chunk) indexed by ``samples.csv``; CPU one ``fields/<name>/
    step_*.json`` per sample with ``[x, y, z]`` triples. Their sample steps
    differ (CPU records step 1 where CUDA records step 0), so callers match
    samples by step. The shared ``results.zarr`` stage store is not used: its
    flat value order is AoS on CPU and SoA on CUDA and is not labelled.
    """
    zarr_root = artifacts / "fields" / f"{name}.zarr"
    if zarr_root.is_dir():
        return _read_zarr_field(zarr_root)
    paths = sorted((artifacts / "fields" / name).glob("step_*.json"))
    if not paths:
        raise ValueError(f"no saved samples of {name}")
    samples = {}
    for path in paths:
        document = json.loads(path.read_text())
        if document.get("component_order", "xyz") != "xyz" or \
                any(len(cell) != 3 for cell in document["values"]):
            raise ValueError(f"{path.name} is not a list of xyz triples")
        samples[int(document["step"])] = [value for cell in document["values"] for value in cell]
    return samples


def _read_zarr_field(root: Path) -> dict[int, list[float]]:
    meta = json.loads((root / ".zarray").read_text())
    attrs = json.loads((root / ".zattrs").read_text())
    if meta.get("compressor") is not None or meta.get("filters"):
        raise ValueError("compressed field storage is not supported")
    if attrs.get("axes") != ["sample", "component", "cell"] or \
            attrs.get("component_order") != ["x", "y", "z"]:
        raise ValueError(f"unexpected field axes {attrs.get('axes')}")
    _, components, cells = meta["shape"]
    _, chunk_components, chunk_cells = meta["chunks"]
    if components != 3 or chunk_components != 3:
        raise ValueError(f"expected 3 components, got {components}")
    typecode = ZARR_DTYPES[meta["dtype"]]
    separator = meta.get("dimension_separator", ".")
    with (root / attrs.get("sample_index_file", "samples.csv")).open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != meta["shape"][0]:
        raise ValueError(f"{len(rows)} indexed samples for shape {meta['shape']}")
    samples = {}
    for row in rows:
        sample = int(row["sample"])
        per_component: list[list[float]] = [[], [], []]
        for chunk in range(math.ceil(cells / chunk_cells)):
            values = array.array(typecode)
            values.frombytes((root / separator.join(map(str, (sample, 0, chunk)))).read_bytes())
            if sys.byteorder != "little":
                values.byteswap()
            if len(values) != 3 * chunk_cells:
                raise ValueError(f"chunk {sample}/{chunk} holds {len(values)} values")
            valid = min(chunk_cells, cells - chunk * chunk_cells)
            for component in range(3):
                start = component * chunk_cells
                per_component[component].extend(values[start:start + valid])
        samples[int(row["step"])] = [value for cell in zip(*per_component) for value in cell]
    return samples


def magnetization_problem(values: list | None) -> str | None:
    if values is None:
        return "m_final missing"
    if not values or any(len(cell) != 3 for cell in values):
        return "m_final is not a non-empty list of 3-vectors"
    if not all(math.isfinite(component) for cell in values for component in cell):
        return "m_final contains non-finite values"
    return None


def max_dm(reference: list, other: list) -> float:
    if len(reference) != len(other):
        raise ValueError(f"cell count differs: {len(reference)} vs {len(other)}")
    return max(abs(a - b) for ra, rb in zip(reference, other) for a, b in zip(ra, rb))


def field_rel(reference, other) -> tuple[float, list[int]]:
    """Max over common steps of max |dH| / max |H_ref|, and the steps compared.

    Both lanes must hold the same final step; raises on missing, misaligned,
    differently sized or non-finite samples.
    """
    for label, samples in (("reference", reference), ("lane", other)):
        if not isinstance(samples, dict) or not samples:
            raise ValueError(f"{label} field {samples if isinstance(samples, str) else 'missing'}")
        if not all(math.isfinite(value) for sample in samples.values() for value in sample):
            raise ValueError(f"{label} field contains non-finite values")
    if max(reference) != max(other):
        raise ValueError(f"final field step differs: {max(reference)} vs {max(other)}")
    steps = sorted(set(reference) & set(other))
    worst = 0.0
    for step in steps:
        ref_sample, sample = reference[step], other[step]
        if len(ref_sample) != len(sample):
            raise ValueError(f"field length differs at step {step}")
        scale = max(max(abs(value) for value in ref_sample), 1e-30)
        worst = max(worst, max(abs(a - b) for a, b in zip(ref_sample, sample)) / scale)
    return worst, steps


def scalar_rel(reference: dict | None, other: dict | None) -> dict:
    if not reference or not other:
        return {}
    out = {}
    for key, value in reference.items():
        if key in other and key.startswith(("E_", "e_", "energy")):
            scale = max(abs(value), 1e-30)
            out[key] = abs(other[key] - value) / scale
    return out


def compare_lane(label: str, reference: dict | None, record: dict, max_dm_tol: float,
                 max_energy_rel: float, max_field_rel: float | None = None) -> tuple[dict, list[str]]:
    """Check one lane against the CPU fp64 reference (``None`` for the reference itself)."""
    entry = {key: value for key, value in record.items() if key not in ("m_final", "fields")}
    problem = magnetization_problem(record["m_final"])
    if record["returncode"] != 0:
        return entry, [f"{label}: exit code {record['returncode']}"]
    if problem:
        return entry, [f"{label}: {problem}"]
    if reference is None or reference["returncode"] != 0 or \
            magnetization_problem(reference["m_final"]) is not None:
        # A failed reference is reported on its own entry.
        return entry, []
    failures = []
    try:
        dm = max_dm(reference["m_final"], record["m_final"])
        entry["max_dm_vs_cpu"] = dm
        if not dm <= max_dm_tol:
            failures.append(f"{label}: max |dm| {dm:.3e} > {max_dm_tol:.1e}")
    except ValueError as error:
        failures.append(f"{label}: {error}")
    rel = scalar_rel(reference["scalars"], record["scalars"])
    entry["scalar_rel_vs_cpu"] = rel
    # Python's max() skips NaN after a finite value, so every compared energy
    # and difference is checked before aggregating.
    non_finite = [
        key for key in rel
        if not (math.isfinite(reference["scalars"][key])
                and math.isfinite(record["scalars"][key])
                and math.isfinite(rel[key]))
    ]
    if non_finite:
        failures.append(f"{label}: non-finite energy {', '.join(non_finite)}")
    if not rel:
        failures.append(f"{label}: no comparable energy scalars")
    elif not non_finite and not max(rel.values()) <= max_energy_rel:
        worst = max(rel, key=rel.get)
        failures.append(f"{label}: energy rel {worst} {rel[worst]:.3e} > {max_energy_rel:.1e}")
    if max_field_rel is not None:
        entry["field_rel_vs_cpu"] = {}
        for name in FIELDS:
            try:
                value, steps = field_rel((reference["fields"] or {}).get(name),
                                         (record["fields"] or {}).get(name))
            except ValueError as error:
                failures.append(f"{label}: {name}: {error}")
                continue
            entry["field_rel_vs_cpu"][name] = value
            entry.setdefault("field_steps_compared", steps)
            if not value <= max_field_rel:
                failures.append(f"{label}: {name} rel {value:.3e} > {max_field_rel:.1e}")
    return entry, failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--steps", type=int, default=2000)
    parser.add_argument("--fullmag-bin", default="fullmag-bin")
    parser.add_argument("--max-dm", type=float, default=1e-6,
                        help="fp64 tolerance on max |dm| against the CPU reference")
    parser.add_argument("--max-energy-rel", type=float, default=1e-8,
                        help="fp64 tolerance on the relative final energy difference")
    parser.add_argument("--with-fp32", action="store_true",
                        help="add the short-horizon CUDA fp32 tolerance qualification")
    parser.add_argument("--fp32-steps", type=int, default=10,
                        help="horizon of the fp32 qualification runs")
    parser.add_argument("--fp32-max-dm", type=float, default=1e-5,
                        help="fp32 tolerance on max |dm| against the CPU fp64 reference")
    parser.add_argument("--fp32-max-energy-rel", type=float, default=1e-5,
                        help="fp32 tolerance on the relative energy difference, per term")
    parser.add_argument("--fp32-max-field-rel", type=float, default=1e-5,
                        help="fp32 tolerance on max |dH| / max |H_ref| for H_ex and H_eff")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    failures: list[str] = []
    with (args.output / "parity.jsonl").open("w") as log:
        def record_lane(label, reference, record, *tolerances):
            entry, lane_failures = compare_lane(label, reference, record, *tolerances)
            failures.extend(lane_failures)
            log.write(json.dumps(entry) + "\n")
            rows.append(entry)
            print(f"{label}: rc={record['returncode']} wall={record['wall_s']:.1f}s "
                  f"max_dm={entry.get('max_dm_vs_cpu')}", file=sys.stderr)

        for case in args.case or CASES:
            reference = run(case, "cpu", "double", args.steps, args.output, args.fullmag_bin)
            gpu = run(case, "gpu", "double", args.steps, args.output, args.fullmag_bin)
            record_lane(f"{case} cpu/double", None, reference, args.max_dm, args.max_energy_rel)
            record_lane(f"{case} gpu/double", reference, gpu, args.max_dm, args.max_energy_rel)
            if args.with_fp32:
                short_reference = run(case, "cpu", "double", args.fp32_steps, args.output,
                                      args.fullmag_bin, save_fields=True)
                single = run(case, "gpu", "single", args.fp32_steps, args.output,
                             args.fullmag_bin, save_fields=True)
                record_lane(f"{case} cpu/double q{args.fp32_steps}", None, short_reference,
                            args.fp32_max_dm, args.fp32_max_energy_rel)
                record_lane(f"{case} gpu/single q{args.fp32_steps}", short_reference, single,
                            args.fp32_max_dm, args.fp32_max_energy_rel, args.fp32_max_field_rel)
    print("| case | lane | steps | rc | wall [s] | max abs dm vs CPU | max rel energy diff "
          "| max rel H_ex / H_eff diff | m_final sha256 |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---|")
    for row in rows:
        rel = row.get("scalar_rel_vs_cpu") or {}
        worst = max(rel.values()) if rel else None
        fields = row.get("field_rel_vs_cpu") or {}
        field_text = " / ".join(f"{fields[name]:.2e}" for name in FIELDS if name in fields) or "-"
        print(f"| {row['case']} | {row['device']}/{row['precision']} | {row['steps']} | "
              f"{row['returncode']} | {row['wall_s']:.1f} | {row.get('max_dm_vs_cpu', '-')} | "
              f"{'-' if worst is None else f'{worst:.2e}'} | {field_text} | "
              f"{(row['m_final_sha256'] or '-')[:12]} |")
    for failure in failures:
        print(f"PARITY FAILURE: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
