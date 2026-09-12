"""Measure bimeron size, topology, and energy from a run artifact directory.

The analyzer intentionally consumes final/explicit state artifacts and the
solver accepted-step trace.  It never infers a frozen-spin mask from a plot
or from the requested radius.  A missing runtime metric is reported as
``not_emitted`` instead of being silently replaced by an all-DOF metric.
"""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence


MU0 = 4.0 * math.pi * 1e-7


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _find_nested(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        if key in value:
            return value[key]
        for child in value.values():
            found = _find_nested(child, key)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_nested(child, key)
            if found is not None:
                return found
    return None


def _state_values(path: Path) -> list[tuple[float, float, float]]:
    """Load JSON, Zarr, or HDF5 magnetization state through the public I/O."""

    try:
        # The managed Python environment already carries the canonical state
        # reader; this also handles .zarr.zip and h5 without duplicating their
        # dataset-discovery rules here.
        import fullmag  # type: ignore

        loaded = fullmag.load_magnetization(path, format="auto", dataset="m", sample=-1)
        return [tuple(float(component) for component in row) for row in loaded.values]
    except Exception as first_error:
        if path.suffix.lower() not in {".json", ".js"}:
            raise RuntimeError(f"cannot load magnetization state {path}: {first_error}") from first_error
        payload = json.loads(path.read_text(encoding="utf-8"))
        raw = payload.get("values", payload.get("magnetization")) if isinstance(payload, dict) else payload
        if not isinstance(raw, list):
            raise ValueError(f"{path} has no vector values")
        if raw and isinstance(raw[0], (int, float)):
            if len(raw) % 3:
                raise ValueError(f"{path} has a flat vector buffer with non-multiple-of-three length")
            raw = [raw[index : index + 3] for index in range(0, len(raw), 3)]
        return [
            (float(row[0]), float(row[1]), float(row[2]))
            for row in raw
            if isinstance(row, (list, tuple)) and len(row) == 3
        ]


def _stage_roots(root: Path) -> list[Path]:
    stages = root / "stages"
    if not stages.is_dir():
        return []
    return sorted(
        (candidate for candidate in stages.iterdir() if candidate.is_dir() and candidate.name.startswith("stage_")),
        key=lambda candidate: candidate.name,
    )


def _stage_roots_for(root: Path, workspace_root: Path | None) -> list[Path]:
    roots = _stage_roots(root)
    if workspace_root is not None:
        for candidate in _stage_roots(workspace_root):
            if candidate not in roots:
                roots.append(candidate)
    return roots


def _state_candidate(root: Path, stem: str, workspace_root: Path | None = None) -> Path | None:
    candidates = [
        root / "states" / stem,
        root / "states" / f"{stem}.json",
        root / "states" / f"{stem}.zarr.zip",
        root / "states" / f"{stem}.zarr",
        root / stem,
        root / f"{stem}.json",
        root / f"{stem}.zarr.zip",
        root / f"{stem}.zarr",
    ]
    for candidate in candidates:
        if candidate.is_file() or candidate.is_dir():
            return candidate
    matches = sorted((root / "states").glob(f"{stem}*")) if (root / "states").is_dir() else []
    if matches:
        return matches[0]
    # A native flat sequence keeps the final field in the stage directory and
    # the named checkpoints in ``root/states``.  Search newest stage first so
    # ``final`` follows the actual last executed stage.
    for stage_root in reversed(_stage_roots_for(root, workspace_root)):
        for candidate in (
            stage_root / stem,
            stage_root / f"{stem}.json",
            stage_root / f"{stem}.zarr.zip",
            stage_root / f"{stem}.zarr",
            stage_root / "m_final.json" if stem == "m_final" else stage_root / "__missing__",
        ):
            if candidate.is_file() or candidate.is_dir():
                return candidate
    return None


def _trace_rows_direct(root: Path) -> list[dict[str, Any]]:
    trace = root / "solver" / "accepted_steps.v1.json"
    if trace.is_file():
        payload = json.loads(trace.read_text(encoding="utf-8"))
        rows = payload.get("steps", []) if isinstance(payload, dict) else []
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    csv_path = root / "scalars.csv"
    if not csv_path.is_file():
        return []
    with csv_path.open(newline="", encoding="utf-8") as stream:
        return [dict(row) for row in csv.DictReader(stream)]


def _stage_id(stage_root: Path) -> str:
    metadata_path = stage_root / "metadata.json"
    if metadata_path.is_file():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            value = _find_nested(metadata, "active_stage_id")
            if isinstance(value, str) and value:
                return value
        except (OSError, json.JSONDecodeError):
            pass
    return stage_root.name


def _trace_rows(root: Path, workspace_root: Path | None = None) -> list[dict[str, Any]]:
    direct = _trace_rows_direct(root)
    if direct:
        return direct
    # The managed CLI writes one solver trace per executable stage.  Synthetic
    # save-state stages have no rows and are naturally skipped here.
    rows: list[dict[str, Any]] = []
    step_offset = 0
    time_offset = 0.0
    for stage_root in _stage_roots_for(root, workspace_root):
        stage_rows = _trace_rows_direct(stage_root)
        if not stage_rows:
            continue
        stage_id = _stage_id(stage_root)
        for raw in stage_rows:
            row = dict(raw)
            row["_stage_id"] = stage_id
            local_step = _row_value(row, "step")
            local_time = _row_value(row, "time", "t")
            if local_step is not None:
                row["step"] = int(local_step) + step_offset
            if local_time is not None:
                row["time"] = local_time + time_offset
            rows.append(row)
        last = rows[-1]
        last_step = _row_value(last, "step")
        last_time = _row_value(last, "time", "t")
        if last_step is not None:
            step_offset = int(last_step)
        if last_time is not None:
            time_offset = last_time
    return rows


def _metadata_for_root(root: Path, workspace_root: Path | None = None) -> tuple[dict[str, Any], Path | None]:
    metadata_path = root / "metadata.json"
    if metadata_path.is_file():
        return json.loads(metadata_path.read_text(encoding="utf-8")), metadata_path
    for stage_root in reversed(_stage_roots_for(root, workspace_root)):
        candidate = stage_root / "metadata.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8")), candidate
    return {}, None


def _last_row(rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    return dict(rows[-1]) if rows else {}


def _row_value(row: dict[str, Any], *names: str) -> float | None:
    for name in names:
        if name in row:
            value = _number(row[name])
            if value is not None:
                return value
    return None


def _grid_from_metadata(root: Path, fallback_cell_nm: float = 0.5) -> tuple[int, int, int, float, float, float]:
    metadata_path = root / "metadata.json"
    metadata: Any = {}
    if metadata_path.is_file():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    execution_plan = _find_nested(metadata, "execution_plan") or {}
    plan = execution_plan.get("backend_plan") if isinstance(execution_plan, dict) else None
    if not isinstance(plan, dict):
        plan = _find_nested(metadata, "backend_plan") or _find_nested(metadata, "plan") or {}
    grid = plan.get("grid") if isinstance(plan, dict) else None
    if not isinstance(grid, dict):
        grid = _find_nested(metadata, "grid") or {}
    artifact_layout = metadata.get("artifact_layout") if isinstance(metadata, dict) else None
    if not isinstance(artifact_layout, dict):
        artifact_layout = _find_nested(metadata, "artifact_layout") or {}
    cells = grid.get("cells") if isinstance(grid, dict) else None
    if not (isinstance(cells, list) and len(cells) == 3):
        cells = artifact_layout.get("grid_cells") if isinstance(artifact_layout, dict) else None
    cell = None
    if isinstance(plan, dict):
        cell = plan.get("cell_size") or plan.get("cell_size_m")
    if not (isinstance(cell, list) and len(cell) == 3) and isinstance(execution_plan, dict):
        cell = execution_plan.get("cell_size") or execution_plan.get("cell_size_m")
    if not (isinstance(cell, list) and len(cell) == 3) and isinstance(artifact_layout, dict):
        cell = artifact_layout.get("cell_size") or artifact_layout.get("cell_size_m")
    if isinstance(cell, list) and len(cell) == 3 and isinstance(cells, list) and len(cells) == 3:
        try:
            counts = tuple(int(value) for value in cells)
            sizes = tuple(float(value) for value in cell)
            if all(value > 0 for value in counts + sizes):
                return (*counts, *sizes)
        except (TypeError, ValueError):
            pass
    # The experiment geometry is fixed at 500 x 40 x 0.5 nm.  Metadata from
    # older runners may omit the resolved grid, so derive it from the case.
    h = fallback_cell_nm * 1e-9
    return round(500e-9 / h), round(40e-9 / h), round(0.5e-9 / h), h, h, h


def _plane(values: Sequence[Sequence[float]], nx: int, ny: int, nz: int) -> list[tuple[float, float, float]]:
    expected = nx * ny * nz
    if len(values) != expected:
        raise ValueError(f"state has {len(values)} vectors, expected {expected} for grid {nx}x{ny}x{nz}")
    result: list[tuple[float, float, float]] = []
    for iy in range(ny):
        for ix in range(nx):
            vectors = [values[(iz * ny + iy) * nx + ix] for iz in range(nz)]
            vector = tuple(sum(v[k] for v in vectors) / nz for k in range(3))
            norm = math.sqrt(sum(component * component for component in vector))
            result.append(tuple(component / norm for component in vector) if norm > 0.0 else (1.0, 0.0, 0.0))
    return result


def _solid_angle(a: Sequence[float], b: Sequence[float], c: Sequence[float]) -> float:
    triple = (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )
    denominator = 1.0 + sum(a[k] * b[k] for k in range(3)) + sum(b[k] * c[k] for k in range(3)) + sum(c[k] * a[k] for k in range(3))
    return 2.0 * math.atan2(triple, denominator)


def _polygon_area(points: Sequence[tuple[float, float]]) -> float:
    if len(points) < 3:
        return 0.0
    return 0.5 * abs(
        sum(
            points[index][0] * points[(index + 1) % len(points)][1]
            - points[(index + 1) % len(points)][0] * points[index][1]
            for index in range(len(points))
        )
    )


def _clip_triangle_to_negative(
    vertices: Sequence[tuple[float, float, float]]
) -> list[tuple[float, float]]:
    """Clip one linear triangle to ``m_x <= 0`` for contour area."""

    clipped: list[tuple[float, float]] = []
    previous = vertices[-1]
    previous_inside = previous[2] <= 0.0
    for current in vertices:
        current_inside = current[2] <= 0.0
        if current_inside != previous_inside:
            denominator = previous[2] - current[2]
            fraction = previous[2] / denominator if denominator else 0.5
            clipped.append(
                (
                    previous[0] + fraction * (current[0] - previous[0]),
                    previous[1] + fraction * (current[1] - previous[1]),
                )
            )
        if current_inside:
            clipped.append((current[0], current[1]))
        previous = current
        previous_inside = current_inside
    return clipped


def _interpolated_negative_area(
    plane: Sequence[Sequence[float]], nx: int, ny: int, hx: float, hy: float
) -> float:
    """Estimate the closed ``m_x=0`` area with piecewise-linear triangles.

    Magnetization samples live at cell centres.  Each adjacent centre quad is
    split into two triangles and clipped at the zero contour.  The periodic x
    seam is unwrapped while measuring so a contour crossing that seam does not
    acquire a spurious long edge.
    """

    area = 0.0
    for iy in range(ny - 1):
        for ix in range(nx):
            jx = (ix + 1) % nx
            x0 = ix * hx
            x1 = (ix + 1) * hx
            y0 = iy * hy
            y1 = (iy + 1) * hy
            p00 = (x0, y0, float(plane[iy * nx + ix][0]))
            p10 = (x1, y0, float(plane[iy * nx + jx][0]))
            p01 = (x0, y1, float(plane[(iy + 1) * nx + ix][0]))
            p11 = (x1, y1, float(plane[(iy + 1) * nx + jx][0]))
            area += _polygon_area(_clip_triangle_to_negative((p00, p10, p11)))
            area += _polygon_area(_clip_triangle_to_negative((p00, p11, p01)))
    return area


def _component_shape(
    component: set[tuple[int, int]], nx: int, ny: int, hx: float, hy: float
) -> dict[str, Any]:
    if not component:
        return {
            "component_centroid_nm": None,
            "component_bbox_nm": None,
            "component_semi_axes_nm": None,
            "component_aspect_ratio": None,
        }
    points = [
        ((ix + 0.5) * hx - 0.5 * nx * hx, (iy + 0.5) * hy - 0.5 * ny * hy)
        for ix, iy in component
    ]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    span_x = max(xs) - min(xs) + hx
    span_y = max(ys) - min(ys) + hy
    semi_x = 0.5 * span_x
    semi_y = 0.5 * span_y
    return {
        "component_centroid_nm": [
            sum(xs) / len(xs) * 1e9,
            sum(ys) / len(ys) * 1e9,
        ],
        "component_bbox_nm": [
            [min(xs) * 1e9 - 0.5 * hx * 1e9, min(ys) * 1e9 - 0.5 * hy * 1e9],
            [max(xs) * 1e9 + 0.5 * hx * 1e9, max(ys) * 1e9 + 0.5 * hy * 1e9],
        ],
        "component_semi_axes_nm": [semi_x * 1e9, semi_y * 1e9],
        "component_aspect_ratio": max(semi_x, semi_y) / min(semi_x, semi_y)
        if min(semi_x, semi_y) > 0.0
        else None,
    }


def _measure(values: Sequence[Sequence[float]], *, nx: int, ny: int, nz: int, cell: tuple[float, float, float]) -> dict[str, Any]:
    plane = _plane(values, nx, ny, nz)
    hx, hy, _ = cell
    centre_ix = nx // 2
    centre_iy = ny // 2

    def at(ix: int, iy: int) -> tuple[float, float, float]:
        return plane[iy * nx + ix]

    negative = [vector[0] < 0.0 for vector in plane]
    negative_indices = [
        (ix, iy)
        for iy in range(ny)
        for ix in range(nx)
        if negative[iy * nx + ix]
    ]
    seed = min(
        negative_indices,
        key=lambda item: abs(item[0] - centre_ix) + abs(item[1] - centre_iy),
        default=None,
    )

    component: set[tuple[int, int]] = set()
    if seed is not None:
        pending = [seed]
        while pending:
            ix, iy = pending.pop()
            key = (ix, iy)
            if key in component or not negative[iy * nx + ix]:
                continue
            component.add(key)
            pending.extend(
                [
                    ((ix - 1) % nx, iy),
                    ((ix + 1) % nx, iy),
                    (ix, iy - 1),
                    (ix, iy + 1),
                ]
            )
            pending[:] = [(x, y) for x, y in pending if 0 <= y < ny]

    area_cell_count = len(component) * hx * hy
    area_interpolated = _interpolated_negative_area(plane, nx, ny, hx, hy)
    area = area_interpolated if area_interpolated > 0.0 else area_cell_count
    mz_values = [(at(ix, iy)[2], ix, iy) for iy in range(ny) for ix in range(nx)]
    min_mz, min_ix, min_iy = min(mz_values, key=lambda value: value[0]) if mz_values else (float("nan"), 0, 0)
    max_mz, max_ix, max_iy = max(mz_values, key=lambda value: value[0]) if mz_values else (float("nan"), 0, 0)
    min_xy = ((min_ix + 0.5) * hx - 0.5 * nx * hx, (min_iy + 0.5) * hy - 0.5 * ny * hy)
    max_xy = ((max_ix + 0.5) * hx - 0.5 * nx * hx, (max_iy + 0.5) * hy - 0.5 * ny * hy)
    core_distance = math.hypot(max_xy[0] - min_xy[0], max_xy[1] - min_xy[1])

    charge = 0.0
    for iy in range(ny - 1):
        for ix in range(nx):
            jx = (ix + 1) % nx
            p00, p10, p01, p11 = at(ix, iy), at(jx, iy), at(ix, iy + 1), at(jx, iy + 1)
            charge += _solid_angle(p00, p10, p11) + _solid_angle(p00, p11, p01)
    charge /= 4.0 * math.pi
    shape = _component_shape(component, nx, ny, hx, hy)
    return {
        "R_area_m": math.sqrt(area / math.pi) if area > 0.0 else None,
        "R_area_nm": math.sqrt(area / math.pi) * 1e9 if area > 0.0 else None,
        "area_m2": area,
        "area_interpolated_m2": area_interpolated,
        "R_area_interpolated_nm": math.sqrt(area_interpolated / math.pi) * 1e9 if area_interpolated > 0.0 else None,
        "area_method": "piecewise_linear_mx_zero_contour" if area_interpolated > 0.0 else "negative_cell_count",
        "area_cell_count_m2": area_cell_count,
        "area_cell_count": len(component),
        "R_core_m": core_distance / 2.0 if core_distance > 0.0 else None,
        "R_core_nm": core_distance * 0.5e9 if core_distance > 0.0 else None,
        "mz_min": min_mz,
        "mz_max": max_mz,
        "mz_min_position_nm": [min_xy[0] * 1e9, min_xy[1] * 1e9],
        "mz_max_position_nm": [max_xy[0] * 1e9, max_xy[1] * 1e9],
        "topological_charge": charge,
        "measurement_grid": {"nx": nx, "ny": ny, "nz": nz, "cell_nm": [hx * 1e9, hy * 1e9, cell[2] * 1e9]},
        **shape,
    }


def _energy_from_row(row: dict[str, Any]) -> dict[str, float | None]:
    return {
        "E_ex_J": _row_value(row, "e_ex", "E_ex"),
        "E_demag_J": _row_value(row, "e_demag", "E_demag"),
        "E_ext_J": _row_value(row, "e_ext", "E_ext"),
        "E_ani_J": _row_value(row, "e_ani", "E_ani"),
        "E_rotated_dmi_J": _row_value(row, "e_rotated_dmi", "E_rotated_dmi"),
        "E_dmi_J": _row_value(row, "e_dmi", "E_dmi"),
        "E_total_J": _row_value(row, "e_total", "E_total"),
    }


def _stage_energy(
    rows: Sequence[dict[str, Any]], background_energy_j: float | None
) -> dict[str, dict[str, float | None]]:
    result: dict[str, dict[str, float | None]] = {}
    for row in rows:
        stage_id = row.get("_stage_id")
        if not isinstance(stage_id, str) or not stage_id:
            continue
        energy = _energy_from_row(row)
        terminal = energy.get("E_total_J")
        energy["delta_E_to_background_J"] = (
            terminal - background_energy_j
            if terminal is not None and background_energy_j is not None
            else None
        )
        result[stage_id] = energy
    return result


def _frozen_metrics(row: dict[str, Any]) -> dict[str, Any]:
    names = {
        "frozen_reference_max_drift": ("frozen_reference_max_drift",),
        "active_dof_count": ("active_dof_count",),
        "frozen_dof_count": ("frozen_dof_count",),
        "free_dof_count": ("free_dof_count",),
    }
    result: dict[str, Any] = {}
    for key, candidates in names.items():
        value = _row_value(row, *candidates)
        result[key] = int(value) if key.endswith("count") and value is not None else value
    # frozen-spins.v1 defines the runtime's max_torque_Apm reduction over
    # free DOFs. Keep older aliases and preserve the source/units explicitly.
    torque_candidates = (
        ("max_torque_free_Apm", "Apm"),
        ("max_torque_free", "Apm"),
        ("max_torque_free_T", "T"),
        ("max_torque_Apm", "Apm"),
    )
    result["free_torque_metric"] = None
    result["free_torque_metric_units"] = None
    result["free_torque_metric_source"] = None
    for name, units in torque_candidates:
        value = _row_value(row, name)
        if value is not None:
            result["free_torque_metric"] = value
            result["free_torque_metric_units"] = units
            result["free_torque_metric_source"] = name
            break
    result["free_torque_metric_status"] = (
        "emitted" if result["free_torque_metric"] is not None else "not_emitted"
    )
    return result


def _resolved_frozen_metrics(
    root: Path, workspace_root: Path | None, current: dict[str, Any]
) -> dict[str, Any]:
    """Fill missing counts from the runtime's resolved frozen-mask plan.

    Native solver traces currently publish the terminal energy but may omit
    constraint counters.  The stage metadata is authoritative for a static
    selector and contains the resolved mask counts, so use it only for those
    missing counters; torque and reference-drift fields remain explicitly
    ``not_emitted`` when the solver did not publish them.
    """

    counts_complete = all(
        current.get(key) is not None
        for key in ("active_dof_count", "frozen_dof_count", "free_dof_count")
    )
    metadata_paths: list[Path] = []
    direct = root / "metadata.json"
    if direct.is_file():
        metadata_paths.append(direct)
    for stage_root in _stage_roots_for(root, workspace_root):
        candidate = stage_root / "metadata.json"
        if candidate.is_file():
            metadata_paths.append(candidate)
    for path in reversed(metadata_paths):
        try:
            metadata = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        resolved = _find_nested(metadata, "frozen_spins")
        if not isinstance(resolved, dict):
            continue
        if not counts_complete:
            for key in ("active_dof_count", "frozen_dof_count", "free_dof_count"):
                value = _number(resolved.get(key))
                if value is not None and current.get(key) is None:
                    current[key] = int(value)
        certificate = resolved.get("certificate")
        if isinstance(certificate, dict):
            for source_key, output_key in (
                ("mask_sha256", "frozen_mask_sha256"),
                ("resolved_reference_sha256", "frozen_reference_sha256"),
                ("grid_or_mesh_fingerprint", "grid_or_mesh_fingerprint"),
                ("evaluator_id", "frozen_mask_evaluator"),
            ):
                value = certificate.get(source_key)
                if value is not None:
                    current[output_key] = value
            fingerprints = certificate.get("authored_fingerprints")
            if isinstance(fingerprints, list) and fingerprints:
                first = fingerprints[0]
                if isinstance(first, dict) and first.get("selector_sha256"):
                    current["frozen_selector_sha256"] = first["selector_sha256"]
            bounds = certificate.get("bounds_m")
            if isinstance(bounds, list):
                current["frozen_bounds_m"] = bounds
        mask = resolved.get("frozen_mask")
        if isinstance(mask, list):
            current["frozen_cell_indices"] = [
                index for index, is_frozen in enumerate(mask) if bool(is_frozen)
            ]
            current["frozen_mask_cell_count"] = len(mask)
        current["frozen_runtime_source"] = "resolved_frozen_spins_plan"
        return current
    return current


def _runtime_provenance(metadata: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in (
        "requested_execution",
        "execution_provenance",
        "build_identity",
        "status",
        "completion",
    ):
        value = metadata.get(key)
        if value is None:
            value = _find_nested(metadata, key)
        if value is not None:
            result[key] = value
    return result


def analyze_case(
    root: Path,
    *,
    workspace_root: Path | None = None,
    fallback_cell_nm: float = 0.5,
    background_energy_j: float | None = None,
) -> dict[str, Any]:
    root = root.resolve()
    workspace_root = workspace_root.resolve() if workspace_root is not None else None
    metadata, metadata_path = _metadata_for_root(root, workspace_root)
    experiment = (
        _find_nested(metadata, "bimeron_frozen_size")
        or _find_nested(metadata, "bimeron_frozen_size_background")
        or {}
    )
    protocol = experiment.get("protocol", {}) if isinstance(experiment, dict) else {}
    cell_nm = _number(protocol.get("cell_nm")) if isinstance(protocol, dict) else None
    nx, ny, nz, hx, hy, hz = _grid_from_metadata(root, cell_nm or fallback_cell_nm)
    rows = _trace_rows(root, workspace_root)
    final_row = _last_row(rows)
    energy = _energy_from_row(final_row)
    terminal_energy = energy.get("E_total_J")
    if background_energy_j is not None and terminal_energy is not None:
        energy["delta_E_to_background_J"] = terminal_energy - background_energy_j
    else:
        energy["delta_E_to_background_J"] = None
    stage_energy = _stage_energy(rows, background_energy_j)
    profile_stage_id = "constrained_hold"
    profile_energy = stage_energy.get(profile_stage_id)
    if profile_energy is None:
        profile_stage_id = "constrained_relax"
        profile_energy = stage_energy.get(profile_stage_id)
    if profile_energy is None and stage_energy:
        profile_stage_id, profile_energy = next(reversed(stage_energy.items()))
    if profile_energy is None:
        profile_stage_id = "terminal"
        profile_energy = dict(energy)

    states: dict[str, Any] = {}
    for label, stem in (
        ("initial", "initial_m"),
        ("constrained_relaxed", "constrained_relaxed_m"),
        ("constrained_held", "constrained_held_m"),
        ("released", "released_m"),
        ("background_relaxed", "background_relaxed_m"),
        ("final", "m_final"),
    ):
        path = _state_candidate(root, stem, workspace_root)
        if path is None:
            continue
        try:
            values = _state_values(path)
            states[label] = {"path": str(path), "measurement": _measure(values, nx=nx, ny=ny, nz=nz, cell=(hx, hy, hz))}
        except Exception as error:
            states[label] = {"path": str(path), "measurement_error": str(error)}

    frozen_runtime = _resolved_frozen_metrics(
        root, workspace_root, _frozen_metrics(final_row)
    )
    summary = {
        "schema_version": "bimeron_frozen_size.analysis.v1",
        "artifact_root": str(root),
        "protocol": protocol,
        "accepted_step_count": len(rows),
        "terminal_step": final_row.get("step"),
        "terminal_time_s": _row_value(final_row, "time", "t"),
        "energy": energy,
        "stage_energy": stage_energy,
        "profile_energy": {**profile_energy, "stage_id": profile_stage_id},
        "runtime_provenance": _runtime_provenance(metadata),
        "frozen_runtime": frozen_runtime,
        "states": states,
        "source_metadata_present": metadata_path is not None,
        "status": "measured" if terminal_energy is not None and states else "incomplete",
    }
    return summary


def background_energy(root: Path, workspace_root: Path | None = None) -> float | None:
    rows = _trace_rows(root, workspace_root)
    return _energy_from_row(_last_row(rows)).get("E_total_J")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="one explicit Fullmag output directory")
    parser.add_argument("--background", type=Path, help="independent +x background artifact directory")
    parser.add_argument("--workspace", type=Path, help="managed session directory containing stage solver artifacts")
    parser.add_argument("--background-workspace", type=Path, help="managed session directory for the background run")
    parser.add_argument("--output", type=Path, help="write analysis JSON to this path")
    args = parser.parse_args()
    background = background_energy(args.background, args.background_workspace) if args.background else None
    summary = analyze_case(args.root, workspace_root=args.workspace, background_energy_j=background)
    encoded = json.dumps(summary, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    return 0 if summary["status"] == "measured" else 2


if __name__ == "__main__":
    raise SystemExit(main())
