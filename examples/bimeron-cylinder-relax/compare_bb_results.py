#!/usr/bin/env python3
"""Compare accepted states from the five-step CPU/GPU multilayer PG-BB probes.

Usage:
  python3 compare_bb_results.py --gpu OUTPUT_DIR --report REPORT.json
  python3 compare_bb_results.py --cpu CPU_OUTPUT --gpu GPU_OUTPUT --report REPORT.json

OUTPUT_DIR may be the run root or its project/ directory. The helper reads raw,
uncompressed Zarr v2 <f8 arrays and metadata; it never invokes Fullmag or edits runs.
Without --cpu it emits a GPU-only validation, never a synthetic parity result.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np

STEPS = list(range(6))
FIELDS = ("m", "H_demag", "H_eff", "H_rotated_dmi")
COMMON = [8, 8, 4]
MATERIALS = {
    "film": (580_000.0, 15e-12, 663_920.0, [1.0, 0.0, 0.0], 0.004),
    "upper": (1_000_000.0, 10e-12, 0.0, None, 0.0),
}
FIELD_ABS, FIELD_REL, M_ABS = 1e-5, 1e-7, 1e-8
ENERGY_REL, TORQUE_ABS, TORQUE_REL = 1e-8, 1e-12, 1e-7


class DataError(RuntimeError):
    pass


def key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def check(log: list[dict[str, Any]], name: str, passed: bool | None, details: Any = None) -> None:
    item = {"name": name, "passed": passed}
    if details is not None:
        item["details"] = details
    log.append(item)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DataError(f"cannot read {path}: {exc}") from exc


def project_dir(input_path: Path) -> Path:
    path = input_path.expanduser().resolve()
    if not path.exists():
        raise DataError(f"input does not exist: {path}")
    if path.is_file():
        path = path.parent
    if (path / "main.autosave.json").is_file():
        return path
    candidates = list({p.parent for p in path.rglob("main.autosave.json")})
    if not candidates:
        raise DataError(f"no main.autosave.json below {path}")
    score = lambda p: 2 * (p / "main.zarr").is_dir() + (
        p.parent / "native" / "metadata.json"
    ).is_file()
    best_score = max(score(p) for p in candidates)
    best = [p for p in candidates if score(p) == best_score]
    if len(best) != 1:
        raise DataError(f"ambiguous project output below {path}: {best}")
    return best[0]


def stage_for(project: Path) -> tuple[dict[str, Any], Path]:
    autosave = read_json(project / "main.autosave.json")
    matches = [s for s in autosave.get("stages", []) if s.get("stage_id") == "bb_probe"]
    if len(matches) != 1:
        raise DataError(f"expected one bb_probe in main.autosave.json, found {len(matches)}")
    desc = matches[0]
    if desc.get("complete") is False:
        raise DataError("bb_probe stage is incomplete")
    root = project / "main.zarr" / "stages"
    found = []
    for path in root.iterdir():
        manifest = path / "manifest.json"
        if path.is_dir() and manifest.is_file() and read_json(manifest).get("stage_id") == "bb_probe":
            found.append(path)
    if len(found) == 1:
        return desc, found[0]
    fallback = root / f"stage_{int(desc.get('stage_index', 0)):04d}_bb_probe"
    if fallback.is_dir():
        return desc, fallback
    raise DataError(f"cannot locate staged bb_probe array group under {root}")


def metadata_for(project: Path) -> tuple[Path, dict[str, Any]]:
    for path in (
        project.parent / "native" / "metadata.json",
        project / "native" / "metadata.json",
        project.parent / "metadata.json",
    ):
        if path.is_file():
            return path, read_json(path)
    raise DataError("native/metadata.json is required for grid, layers, materials, and completion")


def stage_index(project: Path, stage_id: str, stage_index_value: Any) -> list[dict[str, Any]]:
    path = project / "main.zarr" / "continuous" / "index.jsonl"
    if not path.is_file():
        raise DataError(f"missing continuous index: {path}")
    result = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("stage_id") == stage_id or (
                row.get("stage_id") is None
                and stage_index_value is not None
                and row.get("stage_index") == stage_index_value
            ):
                result.append(row)
    except (OSError, json.JSONDecodeError) as exc:
        raise DataError(f"cannot parse continuous index {path}: {exc}") from exc
    return result


def coord_step(row: dict[str, Any]) -> int:
    coord = row.get("coordinate")
    if not isinstance(coord, dict):
        raise DataError("continuous-index record has no coordinate")
    kind = key(coord.get("kind", ""))
    if kind and kind != "acceptedstep":
        raise DataError(f"expected accepted_step coordinate, got {coord}")
    value = coord.get("accepted_step", coord.get("step"))
    try:
        step = int(value)
    except (TypeError, ValueError) as exc:
        raise DataError(f"invalid accepted step coordinate: {coord}") from exc
    if str(value).strip() not in (str(step), f"{step}.0"):
        raise DataError(f"non-integral accepted step coordinate: {coord}")
    return step


def indexed_records(records: list[dict[str, Any]], quantity: str | None = None) -> list[dict[str, Any]]:
    selected = []
    for row in records:
        sample_kind = key(row.get("sample_kind", ""))
        payload = str(row.get("payload_ref", ""))
        if quantity is None:
            if sample_kind != "table" and "table" not in key(payload):
                continue
        else:
            names = [row.get(name) for name in (
                "quantity", "quantity_id", "field_quantity", "field_name", "observable", "name"
            )]
            found = {key(name) for name in names if name}
            path_parts = {key(part) for part in payload.split("/")}
            if key(quantity) not in found | path_parts and key(quantity) not in sample_kind:
                continue
            if "field" not in sample_kind and key(quantity) not in found | path_parts:
                continue
        selected.append(row)
    return sorted(selected, key=lambda row: int(row.get("target_sample_index", 0)))


def indexed_steps(records: list[dict[str, Any]], quantity: str | None = None) -> list[int]:
    return [coord_step(row) for row in indexed_records(records, quantity)]


def zarr_rows(group: Path) -> np.ndarray:
    meta_path = group / ".zarray"
    if not meta_path.is_file():
        raise DataError(f"missing Zarr metadata {meta_path}")
    meta = read_json(meta_path)
    shape, chunks = meta.get("shape"), meta.get("chunks")
    if (
        meta.get("zarr_format") != 2
        or meta.get("dtype") != "<f8"
        or meta.get("order") != "C"
        or meta.get("compressor") is not None
        or meta.get("filters") not in (None, [])
    ):
        raise DataError(f"{group}: expected raw uncompressed C-order Zarr v2 <f8")
    if not isinstance(shape, list) or not isinstance(chunks, list) or len(shape) != 2:
        raise DataError(f"{group}: expected shape[samples,width], got {shape}/{chunks}")
    if shape[0] != 6 or shape[1] <= 0 or chunks != [1, shape[1]]:
        raise DataError(f"{group}: expected six rows and chunks [1,width], got {shape}/{chunks}")
    sep = meta.get("dimension_separator", ".")
    if sep not in (".", "/"):
        raise DataError(f"{group}: unsupported dimension separator {sep!r}")
    rows = []
    for i in STEPS:
        chunk = group / str(i) / "0" if sep == "/" else group / f"{i}.0"
        if not chunk.is_file():
            raise DataError(f"missing raw row chunk {chunk}")
        payload = chunk.read_bytes()
        if len(payload) != shape[1] * 8:
            raise DataError(f"{chunk}: wrong raw row byte length {len(payload)}")
        rows.append(np.frombuffer(payload, dtype="<f8").copy())
    data = np.vstack(rows)
    if not np.all(np.isfinite(data)):
        raise DataError(f"{group}: non-finite values")
    return data


def field_group(stage: Path, quantity: str) -> Path:
    root = stage / "fields"
    if not root.is_dir():
        raise DataError(f"missing field Zarr group {root}")
    q = key(quantity)
    groups = [
        z.parent for z in root.rglob(".zarray")
        if q in [key(part) for part in z.parent.relative_to(root).parts]
        or any(key(part).endswith(q) for part in z.parent.relative_to(root).parts)
    ]
    if len(groups) != 1:
        raise DataError(f"expected one staged {quantity} array, found {groups}")
    return groups[0]


def table_quantities(stage: Path) -> list[str]:
    attrs = stage / "table" / ".zattrs"
    meta = read_json(attrs) if attrs.is_file() else {}
    values = meta.get("quantities", meta.get("columns"))
    if not values:
        values = read_json(stage / "manifest.json").get("table_quantities")
    if not isinstance(values, list) or not values:
        raise DataError("table quantity names are missing")
    return [str(value) for value in values]


def col_index(names: list[str], candidates: tuple[str, ...]) -> int:
    normalized = [key(name) for name in names]
    for candidate in candidates:
        if key(candidate) in normalized:
            return normalized.index(key(candidate))
    raise DataError(f"missing table column {candidates}; got {names}")


def geometry(metadata: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[np.ndarray]]:
    layout = metadata.get("artifact_layout", {})
    plan = metadata.get("execution_plan", {}).get("backend_plan", {})
    ll, pl = layout.get("layers"), plan.get("layers")
    if not isinstance(ll, list) or not isinstance(pl, list) or len(ll) != len(pl) or not ll:
        raise DataError("artifact_layout/backend_plan multilayer metadata is missing or inconsistent")
    common = layout.get("common_cells", plan.get("common_cells"))
    if not isinstance(common, list) or len(common) != 3:
        raise DataError(f"invalid common_cells {common!r}")
    by_id = {str(layer.get("object_id")): layer for layer in pl if layer.get("object_id")}
    layers, masks, offset = [], [], 0
    for item in sorted(ll, key=lambda x: int(x.get("value_offset", 0))):
        oid = str(item.get("object_id", ""))
        p = by_id.get(oid) or next(
            (v for v in pl if v.get("layer_id") == item.get("layer_id")), None
        )
        if p is None:
            raise DataError(f"no execution-plan layer matches {oid or item.get('layer_id')}")
        grid = item.get("native_grid", p.get("native_grid"))
        count = math.prod(map(int, grid))
        start = int(item.get("value_offset", offset))
        width = int(item.get("value_count", count))
        if start != offset or width != count:
            raise DataError(f"invalid native-layer offset/count for {oid}: {start}/{width}")
        raw_mask = p.get("native_active_mask")
        mask = np.asarray(raw_mask, dtype=bool) if isinstance(raw_mask, list) else np.array([], dtype=bool)
        if mask.size and (mask.size != count or any(x not in (True, False, 0, 1) for x in raw_mask)):
            raise DataError(f"invalid active mask for {oid}")
        material = p.get("material") if isinstance(p.get("material"), dict) else {}
        layer = {
            "object_id": oid,
            "layer_id": str(item.get("layer_id", p.get("layer_id", ""))),
            "magnet_name": str(item.get("magnet_name", p.get("magnet_name", ""))),
            "offset": start,
            "count": width,
            "native_grid": list(map(int, grid)),
            "native_origin": p.get("native_origin", item.get("native_origin")),
            "native_cell_size": p.get("native_cell_size", item.get("native_cell_size")),
            "convolution_grid": p.get("convolution_grid"),
            "convolution_origin": p.get("convolution_origin"),
            "convolution_cell_size": p.get("convolution_cell_size"),
            "transfer_kind": p.get("transfer_kind"),
            "active_cell_count": item.get("active_cell_count"),
            "inactive_cell_count": item.get("inactive_cell_count"),
            "material": material,
            "rotated_interfacial_dmi": p.get("rotated_interfacial_dmi"),
        }
        layers.append(layer)
        masks.append(mask)
        offset += width
    signature = {"common_cells": list(map(int, common)), "layers": layers}
    return signature, layers, masks


def identify_layer(layers: list[dict[str, Any]], which: str) -> dict[str, Any]:
    aliases = {"film": {"film", "lowerfilm"}, "upper": {"upper", "uppercylinder"}}
    for layer in layers:
        names = {key(layer.get("object_id")), key(layer.get("layer_id")), key(layer.get("magnet_name"))}
        if names & aliases[which]:
            return layer
    raise DataError(f"could not identify {which} layer in metadata")


def verify_materials(log: list[dict[str, Any]], layers: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    found = {}
    for which, (ms, aex, ku, axis, dmi) in MATERIALS.items():
        layer = identify_layer(layers, which)
        found[which] = layer
        material = layer["material"]
        expected = {
            "saturation_magnetisation": ms,
            "exchange_stiffness": aex,
            "uniaxial_anisotropy_ku1": ku,
        }
        if axis is not None:
            expected["anisotropy_axis"] = axis
        for name, value in expected.items():
            actual = material.get(name)
            if name == "anisotropy_axis":
                ok = isinstance(actual, list) and np.allclose(actual, value, rtol=0, atol=1e-14)
            else:
                try:
                    actual = float(actual)
                    ok = math.isfinite(actual) and abs(actual - value) <= 1e-18 + 1e-12 * abs(value)
                except (TypeError, ValueError):
                    ok = False
            check(log, f"material.{which}.{name}", bool(ok), {"actual": actual, "expected": value})
        try:
            actual_dmi = float(layer["rotated_interfacial_dmi"])
            ok = math.isfinite(actual_dmi) and actual_dmi == dmi
        except (TypeError, ValueError):
            actual_dmi, ok = None, False
        check(
            log,
            f"material.{which}.rotated_interfacial_dmi",
            ok,
            {"actual": actual_dmi, "expected": dmi},
        )
    return found["film"], found["upper"]


def run_probe(input_path: Path, device: str) -> dict[str, Any]:
    project = project_dir(input_path)
    desc, stage = stage_for(project)
    metadata_path, metadata = metadata_for(project)
    checks: list[dict[str, Any]] = []
    records = stage_index(project, "bb_probe", desc.get("stage_index"))

    check(
        checks,
        "autosave.fields_declared",
        set(FIELDS).issubset(set(map(str, desc.get("field_quantities", [])))),
        {"declared": desc.get("field_quantities"), "required": FIELDS},
    )
    check(
        checks,
        "index.table_steps",
        indexed_steps(records) == STEPS,
        {"actual": indexed_steps(records), "expected": STEPS},
    )
    index_mapping = {}
    for q in FIELDS:
        field_records = indexed_records(records, q)
        actual = [coord_step(row) for row in field_records]
        check(checks, f"index.{q}_steps", actual == STEPS, {"actual": actual, "expected": STEPS})
        mismatches = []
        for local_row, row in enumerate(field_records):
            payload = str(row.get("payload_ref", ""))
            suffix = re.search(r"/(\d+)$", payload)
            referenced_row = int(suffix.group(1)) if suffix else None
            stage_row = row.get("stage_sample_index")
            # stage_sample_index is the preserved stage-wide field ordinal;
            # payload_ref must resolve the independent per-quantity array row.
            if referenced_row != local_row:
                mismatches.append({
                    "accepted_step": actual[local_row],
                    "local_zarr_row": local_row,
                    "stage_sample_index": stage_row,
                    "payload_ref": payload,
                    "payload_ref_row": referenced_row,
                })
        index_mapping[q] = mismatches
        check(checks, f"index.{q}_payload_rows", not mismatches, {
            "status": "payload references resolve per-quantity rows; stage_sample_index remains stage-wide",
            "mismatches": mismatches,
        })

    table = zarr_rows(stage / "table")
    columns = table_quantities(stage)
    if table.shape[1] != len(columns):
        raise DataError(f"table width {table.shape[1]} does not match {len(columns)} quantities")
    ti = col_index(columns, ("step", "accepted_step"))
    ei = col_index(columns, ("e_total", "E_total", "total_energy"))
    qi = col_index(columns, ("max_torque_T", "max_torque_t"))
    steps = table[:, ti]
    energy, torque = table[:, ei], table[:, qi]
    check(checks, "table.step_values", np.array_equal(steps, np.asarray(STEPS, dtype=float)), steps.tolist())

    fields = {q: zarr_rows(field_group(stage, q)) for q in FIELDS}
    sig, layers, explicit_masks = geometry(metadata)
    cells = sum(layer["count"] for layer in layers)
    for q, data in fields.items():
        check(checks, f"field.{q}.native_width", data.shape[1] == cells * 3,
              {"shape": list(data.shape), "expected_width": cells * 3})
    check(checks, "grid.common_cells_8x8x4", sig["common_cells"] == COMMON,
          {"actual": sig["common_cells"], "expected": COMMON})
    film, upper = verify_materials(checks, layers)

    m = fields["m"].reshape(6, cells, 3)
    masks = []
    for i, layer in enumerate(layers):
        start, end = layer["offset"], layer["offset"] + layer["count"]
        inferred = np.linalg.norm(m[0, start:end], axis=1) > 1e-12
        mask = explicit_masks[i]
        if mask.size:
            check(checks, f"mask.{layer['object_id']}.matches_m0", np.array_equal(mask, inferred),
                  {"metadata_active": int(mask.sum()), "m0_nonzero": int(inferred.sum())})
            source = "native_active_mask"
        else:
            mask, source = inferred, "inferred from nonzero m at step 0"
        active_count = layer.get("active_cell_count")
        if active_count is not None:
            check(checks, f"mask.{layer['object_id']}.active_count",
                  int(mask.sum()) == int(active_count),
                  {"mask_active": int(mask.sum()), "metadata_active": int(active_count)})
        layer["mask_source"] = source
        layer["active_mask_sha256"] = hashlib.sha256(np.packbits(mask.astype(np.uint8))).hexdigest()
        masks.append(mask)
    active = np.concatenate(masks)
    norms = np.linalg.norm(m, axis=2)
    active_error = np.abs(norms[:, active] - 1)
    check(checks, "m.active_unit_length", bool(np.all(active_error <= 1e-8)),
          {"max_abs_error": float(active_error.max(initial=0)), "tolerance": 1e-8})
    inactive = m[:, ~active]
    check(checks, "m.inactive_zero", bool(np.all(inactive == 0)),
          {"max_abs": float(np.abs(inactive).max(initial=0))})

    dmi = fields["H_rotated_dmi"].reshape(6, cells, 3)
    film_slice = slice(film["offset"], film["offset"] + film["count"])
    upper_slice = slice(upper["offset"], upper["offset"] + upper["count"])
    check(checks, "H_rotated_dmi.upper_exact_zero", bool(np.all(dmi[:, upper_slice] == 0)),
          {"max_abs_upper": float(np.abs(dmi[:, upper_slice]).max(initial=0))})
    film_max = np.abs(dmi[:, film_slice]).max(axis=(1, 2))
    check(checks, "H_rotated_dmi.film_nonzero", bool(np.all(film_max > 0)),
          {"max_abs_by_step": film_max.tolist()})

    delta_e = np.diff(energy)
    e_tol = np.array([
        128 * np.finfo(float).eps * max(abs(energy[i]), abs(energy[i + 1]), 1e-300)
        for i in range(5)
    ])
    check(checks, "energy.nonincreasing", bool(np.all(delta_e <= e_tol)),
          {"e_total": energy.tolist(), "delta": delta_e.tolist(), "roundoff_tol": e_tol.tolist()})

    completion = metadata.get("completion")
    if not isinstance(completion, dict) or "converged" not in completion:
        raise DataError("metadata completion/converged is missing")
    reason = key(completion.get("reason", ""))
    check(checks, "completion.reason_present", bool(reason), completion)
    status = key(metadata.get("status", completion.get("status", "")))
    check(checks, "completion.status", status in {"completed", "complete", "succeeded"},
          {"status": metadata.get("status"), "completion": completion})
    if reason in {"maxsteps", "maximumsteps", "steplimit"}:
        check(checks, "completion.max_steps_not_converged", not bool(completion["converged"]),
              {"reason": completion.get("reason"), "converged": completion["converged"]})
    elif completion["converged"]:
        threshold = completion.get("threshold")
        valid = (
            any(word in reason for word in ("torque", "tolerance", "converg"))
            and threshold is not None
            and float(torque[-1]) <= float(threshold)
        )
        check(checks, "completion.convergence_supported", valid,
              {"reason": completion.get("reason"), "last_torque_T": float(torque[-1]), "threshold": threshold})
    metric = key(completion.get("metric_name", completion.get("metric", "")))
    if metric in {"steps", "iterations", "acceptedsteps"} and completion.get("metric_value") is not None:
        check(checks, "completion.five_updates", float(completion["metric_value"]) == 5,
              {"metric": metric, "value": completion["metric_value"]})

    # BB has no physical clock: require explicit zero t/dt evidence from a table or solver_steps.csv.
    clock = []
    aliases = [key(v) for v in columns]
    tcol = next((i for i, n in enumerate(aliases) if n in {"time", "times", "ts"}), None)
    dtcol = next((i for i, n in enumerate(aliases) if n in {"dt", "dts", "solverdt"}), None)
    if tcol is not None and dtcol is not None:
        clock.append({"source": "table", "steps": STEPS, "time": table[:, tcol].tolist(), "dt": table[:, dtcol].tolist()})
    csv_paths = (
        project.parent / "native" / "scalars.csv",
        project.parent / "native" / "solver_steps.csv",
        project / "native" / "scalars.csv",
        project / "native" / "solver_steps.csv",
        project.parent / "scalars.csv",
        project.parent / "solver_steps.csv",
    )
    csv_path = next((p for p in csv_paths if p.is_file()), None)
    if csv_path:
        with csv_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        if rows:
            headers = {key(name): name for name in rows[0]}
            step_col = next((headers[k] for k in ("step", "acceptedstep") if k in headers), None)
            time_col = next((headers[k] for k in ("ts", "times", "time") if k in headers), None)
            dt_col = next((headers[k] for k in ("dts", "dt", "solverdt") if k in headers), None)
            if step_col and time_col and dt_col:
                selected = sorted(
                    (row for row in rows if int(float(row[step_col])) in STEPS),
                    key=lambda row: int(float(row[step_col])),
                )
                clock.append({
                    "source": str(csv_path),
                    "steps": [int(float(row[step_col])) for row in selected],
                    "time": [float(row[time_col]) for row in selected],
                    "dt": [float(row[dt_col]) for row in selected],
                })
    clock_ok = bool(clock) and all(
        row["steps"] == STEPS and all(v == 0 for v in row["time"] + row["dt"])
        for row in clock
    )
    check(checks, "clock.zero_time_and_dt", clock_ok, clock or "no table/CSV time and dt columns")

    request = metadata.get("requested_execution", {})
    if not isinstance(request, dict):
        request = {}
    if not request:
        request = metadata.get("execution_plan", {}).get("common", {})
    actual_device = key(request.get("device", request.get("resolved_device", "")))
    check(checks, f"execution.device_{device}",
          actual_device == key(device) if actual_device else None,
          {"actual": request.get("device", request.get("resolved_device")), "expected": device})
    precision = key(request.get("precision", ""))
    check(checks, "execution.double_precision",
          precision in {"double", "fp64", "f64", "float64"} if precision else None,
          {"precision": request.get("precision")})
    mode = key(request.get("mode", request.get("execution_mode", "")))
    check(checks, "execution.strict_mode", mode == "strict" if mode else None,
          {"mode": request.get("mode", request.get("execution_mode"))})
    provenance = metadata.get("execution_provenance", {})
    if device == "gpu":
        engine = str(provenance.get("execution_engine", ""))
        minimizer = str(provenance.get("resolved_energy_minimizer", ""))
        fft = provenance.get("fdm_fft_execution", {})
        resolution = provenance.get("execution_resolution", {})
        check(checks, "gpu.native_cuda_multilayer_engine",
              engine.startswith("cuda_native_multilayer"), {"engine": engine})
        check(checks, "gpu.projected_gradient_bb_realization",
              key(minimizer) == "projectedgradientbb", {"minimizer": minimizer})
        check(checks, "gpu.no_fallback",
              provenance.get("lossy_fallback_used") is False
              and resolution.get("fallback_occurred") is False,
              {"lossy_fallback_used": provenance.get("lossy_fallback_used"),
               "fallback_occurred": resolution.get("fallback_occurred")})
        check(checks, "gpu.cufft_executed",
              key(fft.get("executed_backend", "")) == "cufft",
              {"fft": fft, "device_name": provenance.get("device_name")})

    build = metadata.get("build_identity")
    build_id = {
        k: build[k] for k in ("git_commit", "source_snapshot_sha256", "package_version", "package_digest")
        if isinstance(build, dict) and build.get(k) is not None
    }
    check(checks, "build_identity.available", bool(build_id) if build_id else None, build_id or build)

    summary = {
        "input": str(input_path),
        "project": str(project),
        "stage": str(stage),
        "metadata": str(metadata_path),
        "problem_name": metadata.get("problem_name"),
        "problem_ir_source_hash_informational_only": metadata.get("source_hash"),
        "build_identity": build_id,
        "execution_request": request,
        "execution_provenance": {
            k: provenance.get(k) for k in (
                "execution_engine", "precision", "device_name", "compute_capability",
                "fft_backend", "demag_operator_kind", "resolved_energy_minimizer",
                "energy_minimizer_realization", "resolved_demag_realization",
                "lossy_fallback_used", "fdm_fft_execution", "fdm_multilayer_stage_telemetry",
                "fdm_multilayer_transfer_telemetry",
            ) if provenance.get(k) is not None
        },
        "common_cells": sig["common_cells"],
        "geometry_material_signature": sig,
        "layers": [
            {
                **{k: v for k, v in layer.items() if k != "material"},
                "material": layer["material"],
            }
            for layer in layers
        ],
        "shapes": {"table": list(table.shape), **{q: list(v.shape) for q, v in fields.items()}},
        "table_quantities": columns,
        "energy_j": energy.tolist(),
        "max_torque_T": torque.tolist(),
        "completion": completion,
        "clock_evidence": clock,
        "field_index_row_mapping_diagnostics": index_mapping,
        "checks": checks,
    }
    return {
        "summary": summary,
        "signature": sig,
        "fields": fields,
        "table": {"energy": energy, "torque": torque},
        "masks": masks,
    }


def parity(cpu: np.ndarray, gpu: np.ndarray, absolute: float, relative: float) -> dict[str, Any]:
    diff = np.abs(cpu - gpu)
    error = float(diff.max(initial=0))
    scale = float(np.abs(gpu).max(initial=0))
    return {
        "max_abs": error,
        "max_rel_to_gpu_max": error / max(scale, 1e-300),
        "gpu_max_abs": scale,
        "passed": error <= absolute + relative * scale,
    }


def recover_lambda(run: dict[str, Any], label: str, checks: list[dict[str, Any]]) -> dict[str, Any]:
    m = run["fields"]["m"].reshape(6, -1, 3)
    h = run["fields"]["H_eff"].reshape(6, -1, 3)
    active = np.concatenate(run["masks"])
    transitions = []
    for step in range(5):
        current, following, field = m[step], m[step + 1], h[step]
        tangent = field - np.sum(field * current, axis=1, keepdims=True) * current
        g = -tangent
        g2 = np.sum(g * g, axis=1)
        dot_m = np.sum(current * following, axis=1)
        floor = max(float(g2[active].max(initial=0)) * 1e-12, 1e-300)
        valid = active & (g2 > floor) & (dot_m > 0)
        if not valid.any():
            check(checks, f"lambda.{label}.{step}.recoverable", False, "no nondegenerate active cells")
            continue
        values = -np.sum(g[valid] * following[valid], axis=1) / (g2[valid] * dot_m[valid])
        values = values[np.isfinite(values)]
        if not values.size:
            check(checks, f"lambda.{label}.{step}.finite", False)
            continue
        lam = float(np.median(values))
        predicted = current[active] - lam * g[active]
        lengths = np.linalg.norm(predicted, axis=1)
        good = lengths > 0
        predicted[good] /= lengths[good, None]
        residual = np.linalg.norm(predicted - following[active], axis=1)
        maximum = float(residual.max(initial=0))
        p05, p95 = np.quantile(values, [0.05, 0.95])
        variation = float((p95 - p05) / max(abs(lam), 1e-300))
        in_range = 1e-15 <= lam <= 1e-3
        common = maximum <= 1e-6
        check(checks, f"lambda.{label}.{step}.range", in_range, {"lambda": lam, "range": [1e-15, 1e-3]})
        check(checks, f"lambda.{label}.{step}.common_retraction", common,
              {"max_residual": maximum, "p95_residual": float(np.quantile(residual, 0.95)),
               "cell_lambda_p05_p95_relative_span": variation, "cells": int(values.size)})
        transitions.append({
            "from": step, "to": step + 1, "lambda_m_per_a": lam,
            "cell_lambda_p05": float(p05), "cell_lambda_p95": float(p95),
            "relative_cell_lambda_span": variation, "max_retraction_residual": maximum,
            "p95_retraction_residual": float(np.quantile(residual, 0.95)),
            "nondegenerate_cells": int(values.size),
        })
    values = [row["lambda_m_per_a"] for row in transitions]
    changed = len(values) == 5 and max(values) - min(values) > 1e-9 * max(max(map(abs, values)), 1e-300)
    check(checks, f"lambda.{label}.changes_between_updates", changed, {"values": values})
    return {
        "formula": "g=-P_m(H_eff); lambda=-dot(g,m_next)/(dot(g,g)*dot(m,m_next))",
        "allowed_lambda_m_per_a": [1e-15, 1e-3],
        "changed_between_updates": changed,
        "transitions": transitions,
    }


def safe_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): safe_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe_json(v) for v in value]
    if isinstance(value, np.ndarray):
        return safe_json(value.tolist())
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        x = float(value)
        return x if math.isfinite(x) else None
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpu", type=Path, help="optional CPU probe output for parity")
    parser.add_argument("--gpu", required=True, type=Path, help="GPU probe output")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--require-resident", action="store_true",
                        help="require resident GPU BB provenance and exact scalar-only trial receipts")
    args = parser.parse_args()

    report: dict[str, Any] = {
        "schema_version": "fullmag.projected_gradient_bb_comparison.v1",
        "steps": STEPS,
        "tolerances": {
            "m_abs": M_ABS, "field_abs": FIELD_ABS, "field_relative": FIELD_REL,
            "energy_relative": ENERGY_REL, "torque_abs": TORQUE_ABS, "torque_relative": TORQUE_REL,
            "lambda_m_per_a": [1e-15, 1e-3],
        },
        "mode": "cpu_gpu_parity" if args.cpu else "gpu_only",
        "inputs": {"cpu": str(args.cpu) if args.cpu else None, "gpu": str(args.gpu)},
        "runs": {}, "checks": [], "failures": [], "unavailable": [],
        "overall_pass": False,
    }
    loaded = {}
    input_runs = ([('cpu', args.cpu)] if args.cpu else []) + [('gpu', args.gpu)]
    for label, path in input_runs:
        try:
            run = run_probe(path, label)
            loaded[label] = run
            report["runs"][label] = run["summary"]
            for item in run["summary"]["checks"]:
                report["checks"].append({"scope": label, **item})
                if item["passed"] is False:
                    report["failures"].append(f"{label}:{item['name']}")
                elif item["passed"] is None:
                    report["unavailable"].append(f"{label}:{item['name']}")
        except Exception as exc:
            report["runs"][label] = {"input": str(path), "error": str(exc)}
            report["failures"].append(f"{label}:load:{exc}")

    global_checks: list[dict[str, Any]] = []
    if args.require_resident and "gpu" in loaded:
        provenance = loaded["gpu"]["summary"]["execution_provenance"]
        telemetry = provenance.get("fdm_multilayer_transfer_telemetry", {})
        check(global_checks, "gpu.resident_bb_vectors",
              telemetry.get("data_residency") == "device_resident_bb_vectors_with_observed_host_snapshots",
              telemetry)
        check(global_checks, "gpu.no_trial_vector_h2d",
              telemetry.get("h2d_bytes") == telemetry.get("setup_h2d_bytes")
              and telemetry.get("h2d_transfer_count") == telemetry.get("setup_h2d_transfer_count")
              and telemetry.get("setup_h2d_bytes", 0) > 0, telemetry)
        check(global_checks, "gpu.no_warm_vector_transfers",
              all(telemetry.get(name) == 0 for name in (
                  "warm_step_h2d_bytes", "warm_step_d2h_bytes",
                  "warm_step_h2d_transfer_count", "warm_step_d2h_transfer_count")), telemetry)
        layer_count = int(telemetry.get("layer_count", 0))
        scalar_count = int(telemetry.get("d2h_transfer_count", 0)) - int(telemetry.get("observed_snapshot_d2h_transfer_count", 0))
        scalar_bytes = int(telemetry.get("d2h_bytes", 0)) - int(telemetry.get("observed_snapshot_d2h_bytes", 0))
        check(global_checks, "gpu.exact_packed_scalar_receipts",
              layer_count > 0 and scalar_count >= len(STEPS)
              and scalar_bytes == scalar_count * layer_count * 20 * 8,
              {"layer_count": layer_count, "evaluations": scalar_count, "scalar_bytes": scalar_bytes})
    lambda_report = {
        label: recover_lambda(run, label, global_checks)
        for label, run in loaded.items()
    }
    if lambda_report:
        report["lambda_recovery"] = lambda_report
    if len(loaded) == 2:
        cpu, gpu = loaded["cpu"], loaded["gpu"]
        same = cpu["signature"] == gpu["signature"]
        check(global_checks, "identity.geometry_materials_masks_common_grid", same, {
            "cpu_common_cells": cpu["signature"]["common_cells"],
            "gpu_common_cells": gpu["signature"]["common_cells"],
            "cpu_signature_sha256": hashlib.sha256(json.dumps(cpu["signature"], sort_keys=True).encode()).hexdigest(),
            "gpu_signature_sha256": hashlib.sha256(json.dumps(gpu["signature"], sort_keys=True).encode()).hexdigest(),
        })
        cb, gb = cpu["summary"]["build_identity"], gpu["summary"]["build_identity"]
        build_keys = [k for k in ("git_commit", "source_snapshot_sha256", "package_version", "package_digest")
                      if k in cb and k in gb]
        if build_keys:
            check(global_checks, "identity.package_build", all(cb[k] == gb[k] for k in build_keys),
                  {"keys": build_keys, "cpu": {k: cb[k] for k in build_keys}, "gpu": {k: gb[k] for k in build_keys}})
        else:
            check(global_checks, "identity.package_build", None, {"cpu": cb, "gpu": gb})

        parity_report = {}
        for quantity in FIELDS:
            left, right = cpu["fields"][quantity], gpu["fields"][quantity]
            if left.shape != right.shape:
                check(global_checks, f"parity.{quantity}", False, {"cpu": list(left.shape), "gpu": list(right.shape)})
                continue
            atol, rtol = (M_ABS, 0.0) if quantity == "m" else (FIELD_ABS, FIELD_REL)
            rows = [dict(step=step, **parity(left[step], right[step], atol, rtol)) for step in STEPS]
            check(global_checks, f"parity.{quantity}", all(row["passed"] for row in rows), {"per_step": rows})
            parity_report[quantity] = rows

        for name, atol, rtol in (
            ("energy", 1e-300, ENERGY_REL), ("torque", TORQUE_ABS, TORQUE_REL)
        ):
            left, right = cpu["table"][name], gpu["table"][name]
            rows = [dict(step=step, **parity(np.array([left[step]]), np.array([right[step]]), atol, rtol))
                    for step in STEPS]
            check(global_checks, f"parity.{name}", all(row["passed"] for row in rows), {"per_step": rows})
            parity_report[name] = rows

        cl = [row["lambda_m_per_a"] for row in lambda_report["cpu"]["transitions"]]
        gl = [row["lambda_m_per_a"] for row in lambda_report["gpu"]["transitions"]]
        if len(cl) == len(gl) == 5:
            differences = [
                abs(a - b) / max(abs(b), 1e-300) for a, b in zip(cl, gl)
            ]
            check(global_checks, "lambda.cpu_gpu_parity", max(differences) <= 1e-5,
                  {"relative_differences": differences, "tolerance": 1e-5})
        else:
            check(global_checks, "lambda.cpu_gpu_parity", None,
                  {"cpu_transitions": len(cl), "gpu_transitions": len(gl)})
        report["parity"] = parity_report
        report["lambda_recovery"] = lambda_report

    for item in global_checks:
        report["checks"].append({"scope": "cpu_gpu", **item})
        if item["passed"] is False:
            report["failures"].append(f"cpu_gpu:{item['name']}")
        elif item["passed"] is None:
            report["unavailable"].append(f"cpu_gpu:{item['name']}")
    report["overall_pass"] = not report["failures"]
    report["overall_status"] = (
        "fail" if report["failures"] else
        "pass_with_diagnostics" if report["unavailable"] else "pass"
    )

    path = args.report.expanduser()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(safe_json(report), indent=2, sort_keys=True, allow_nan=False) + "\n",
                        encoding="utf-8")
    except OSError as exc:
        print(f"cannot write report {path}: {exc}", file=sys.stderr)
        return 2
    status = "FAIL" if report["failures"] else (
        "PASS WITH DIAGNOSTICS" if report["unavailable"] else "PASS"
    )
    print(f"{status}: {len(report['checks'])} checks, {len(report['failures'])} failures, "
          f"{len(report['unavailable'])} diagnostics; report={path}")
    return 0 if report["overall_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
