"""Render deterministic PNG diagnostics from the SP4 CSV attempt ledger."""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
import math
from pathlib import Path
from typing import Callable, Iterable

from tests.standard_problems.mumag.sp4.fem.collect_results import FIELDNAMES


class PlotError(ValueError):
    """Raised when the immutable ledger cannot produce honest diagnostics."""


@dataclass(frozen=True)
class PlotSpec:
    title: str
    y_label: str
    reference_label: str | None = None


PLOT_SPECS = {
    "crossing_time_ps.png": PlotSpec(
        "First average mx=0 crossing",
        "First mx=0 crossing (ps)",
        "NIST reference envelope",
    ),
    "trajectory_error.png": PlotSpec(
        "Trajectory distance outside the NIST envelope",
        "Normalized RMS outside NIST envelope (-)",
    ),
    "final_torque_T.png": PlotSpec(
        "Final accepted-state torque",
        "Final maximum torque (T)",
    ),
    "wall_time_s.png": PlotSpec(
        "Application wall time",
        "Wall time (s)",
    ),
    "relaxation_torque_vs_policy.png": PlotSpec(
        "Relaxed-state torque by policy",
        "Final maximum torque (T)",
        "SP4 relaxation limit",
    ),
    "relaxation_energy_drop_J.png": PlotSpec(
        "Relaxation energy decrease by policy",
        "Initial minus final energy (J)",
    ),
}

DYNAMICS_PLOT_NAMES = (
    "crossing_time_ps.png",
    "trajectory_error.png",
    "final_torque_T.png",
    "wall_time_s.png",
)
RELAXATION_PLOT_NAMES = (
    "relaxation_torque_vs_policy.png",
    "relaxation_energy_drop_J.png",
)

_DEVICE_COLORS = {"cpu": "#1e66f5", "gpu": "#8839ef"}
_COMPONENT_COLORS = {"mx": "#d20f39", "my": "#40a02b", "mz": "#04a5e5"}


def _pyplot():
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as pyplot
    except ImportError as exc:
        raise PlotError(
            "SP4 PNG generation requires the managed Fullmag Python environment"
        ) from exc
    return pyplot


def _load_rows(ledger: Path) -> list[dict[str, str]]:
    try:
        stream = ledger.open(newline="", encoding="utf-8")
    except FileNotFoundError as exc:
        raise PlotError(f"missing ledger: {ledger}") from exc
    with stream:
        reader = csv.DictReader(stream)
        if tuple(reader.fieldnames or ()) != FIELDNAMES:
            raise PlotError("ledger schema does not match the SP4 result schema")
        rows = [row for row in reader if row.get("status") == "completed"]
    if not rows:
        raise PlotError("ledger contains no completed attempts")
    invalid_phases = sorted(
        {row.get("phase", "") for row in rows} - {"dynamics", "relaxation"}
    )
    if invalid_phases:
        raise PlotError(f"completed attempts have invalid phases: {invalid_phases}")
    return sorted(
        rows,
        key=lambda row: (
            row.get("scenario", ""),
            row.get("requested_device", ""),
            row.get("attempt_id", ""),
        ),
    )


def _number(row: dict[str, str], field: str) -> float:
    try:
        value = float(row[field])
    except (KeyError, TypeError, ValueError) as exc:
        raise PlotError(f"completed attempt {row.get('attempt_id')} lacks numeric {field}") from exc
    if not math.isfinite(value):
        raise PlotError(f"completed attempt {row.get('attempt_id')} has non-finite {field}")
    return value


def _labels(rows: list[dict[str, str]]) -> list[str]:
    return [f"{row['scenario']}\n{row['requested_device']}" for row in rows]


def _base_axes(pyplot, spec: PlotSpec, labels: list[str]):
    width = max(8.0, min(16.0, 1.35 * len(labels)))
    figure, axes = pyplot.subplots(figsize=(width, 5.6), dpi=120)
    axes.set_title(spec.title, fontsize=13, fontweight="semibold")
    axes.set_ylabel(spec.y_label)
    axes.set_xlabel("Scenario / requested device")
    axes.set_xticks(range(len(labels)), labels, rotation=28, ha="right")
    axes.grid(axis="y", color="#ccd0da", linewidth=0.8, alpha=0.75)
    axes.set_axisbelow(True)
    figure.patch.set_facecolor("white")
    axes.set_facecolor("#eff1f5")
    return figure, axes


def _device_colors(rows: list[dict[str, str]]) -> list[str]:
    return [_DEVICE_COLORS.get(row["requested_device"], "#6c6f85") for row in rows]


def _plot_crossing(rows: list[dict[str, str]], path: Path) -> None:
    pyplot = _pyplot()
    spec = PLOT_SPECS[path.name]
    figure, axes = _base_axes(pyplot, spec, _labels(rows))
    x = list(range(len(rows)))
    low = [_number(row, "nist_crossing_min_s") * 1e12 for row in rows]
    high = [_number(row, "nist_crossing_max_s") * 1e12 for row in rows]
    actual = [_number(row, "crossing_time_s") * 1e12 for row in rows]
    axes.vlines(
        x,
        low,
        high,
        color="#df8e1d",
        linewidth=8,
        alpha=0.35,
        label=spec.reference_label,
    )
    axes.scatter(
        x,
        actual,
        s=56,
        c=_device_colors(rows),
        edgecolor="white",
        linewidth=0.8,
        zorder=3,
        label="Fullmag FEM",
    )
    axes.legend(frameon=False)
    _save(pyplot, figure, path)


def _plot_trajectory(rows: list[dict[str, str]], path: Path) -> None:
    pyplot = _pyplot()
    spec = PLOT_SPECS[path.name]
    figure, axes = _base_axes(pyplot, spec, _labels(rows))
    x = list(range(len(rows)))
    for component in ("mx", "my", "mz"):
        axes.plot(
            x,
            [_number(row, f"nist_envelope_rms_{component}") for row in rows],
            marker="o",
            linewidth=1.7,
            color=_COMPONENT_COLORS[component],
            label=component,
        )
    axes.axhline(0.0, color="#df8e1d", linewidth=1.2, linestyle="--", label="inside NIST envelope")
    axes.legend(frameon=False, ncols=4)
    _save(pyplot, figure, path)


def _plot_torque(rows: list[dict[str, str]], path: Path) -> None:
    pyplot = _pyplot()
    spec = PLOT_SPECS[path.name]
    figure, axes = _base_axes(pyplot, spec, _labels(rows))
    values = [_number(row, "final_max_torque_T") for row in rows]
    if any(value < 0.0 for value in values):
        raise PlotError("final torque must not be negative")
    axes.scatter(
        range(len(rows)),
        values,
        s=56,
        c=_device_colors(rows),
        edgecolor="white",
        linewidth=0.8,
    )
    axes.set_yscale("symlog", linthresh=1e-12)
    _save(pyplot, figure, path)


def _plot_wall_time(rows: list[dict[str, str]], path: Path) -> None:
    pyplot = _pyplot()
    spec = PLOT_SPECS[path.name]
    figure, axes = _base_axes(pyplot, spec, _labels(rows))
    values = [_number(row, "wall_time_s") for row in rows]
    if any(value < 0.0 for value in values):
        raise PlotError("wall time must not be negative")
    axes.bar(range(len(rows)), values, color=_device_colors(rows), width=0.65)
    _save(pyplot, figure, path)


def _plot_relaxation_torque(rows: list[dict[str, str]], path: Path) -> None:
    pyplot = _pyplot()
    spec = PLOT_SPECS[path.name]
    figure, axes = _base_axes(pyplot, spec, _labels(rows))
    values = [_number(row, "final_max_torque_T") for row in rows]
    limits = [_number(row, "relaxation_torque_limit_T") for row in rows]
    if any(value < 0.0 for value in values):
        raise PlotError("relaxation torque must not be negative")
    if any(limit <= 0.0 for limit in limits):
        raise PlotError("relaxation torque limit must be positive")
    if not all(
        math.isclose(limit, limits[0], rel_tol=1e-12) for limit in limits[1:]
    ):
        raise PlotError("relaxation attempts use inconsistent torque limits")
    axes.scatter(
        range(len(rows)),
        values,
        s=62,
        c=_device_colors(rows),
        edgecolor="white",
        linewidth=0.8,
        zorder=3,
        label="Fullmag FEM",
    )
    axes.axhline(
        limits[0],
        color="#df8e1d",
        linewidth=1.4,
        linestyle="--",
        label=spec.reference_label,
    )
    axes.set_yscale("symlog", linthresh=1e-12)
    axes.legend(frameon=False)
    _save(pyplot, figure, path)


def _plot_relaxation_energy_drop(rows: list[dict[str, str]], path: Path) -> None:
    pyplot = _pyplot()
    spec = PLOT_SPECS[path.name]
    figure, axes = _base_axes(pyplot, spec, _labels(rows))
    values = [_number(row, "energy_drop_J") for row in rows]
    if any(value < 0.0 for value in values):
        raise PlotError("completed relaxation energy drop must not be negative")
    axes.bar(range(len(rows)), values, color=_device_colors(rows), width=0.65)
    _save(pyplot, figure, path)


def _save(pyplot, figure, path: Path) -> None:
    figure.tight_layout()
    figure.savefig(
        path,
        format="png",
        dpi=150,
        bbox_inches="tight",
        metadata={"Software": "Fullmag SP4 validation"},
    )
    pyplot.close(figure)


def plot_ledger(ledger: Path, output_dir: Path) -> tuple[Path, ...]:
    """Create the canonical diagnostic PNG set from completed ledger rows."""

    rows = _load_rows(Path(ledger))
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    renderers: dict[str, Callable[[list[dict[str, str]], Path], None]] = {
        "crossing_time_ps.png": _plot_crossing,
        "trajectory_error.png": _plot_trajectory,
        "final_torque_T.png": _plot_torque,
        "wall_time_s.png": _plot_wall_time,
        "relaxation_torque_vs_policy.png": _plot_relaxation_torque,
        "relaxation_energy_drop_J.png": _plot_relaxation_energy_drop,
    }
    dynamics = [row for row in rows if row["phase"] == "dynamics"]
    relaxation = [row for row in rows if row["phase"] == "relaxation"]
    names = (DYNAMICS_PLOT_NAMES if dynamics else ()) + (
        RELAXATION_PLOT_NAMES if relaxation else ()
    )
    paths = tuple(output_dir / name for name in names)
    for path in paths:
        phase_rows = dynamics if path.name in DYNAMICS_PLOT_NAMES else relaxation
        renderers[path.name](phase_rows, path)
    return paths


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        paths = plot_ledger(args.ledger, args.output_dir)
    except PlotError as exc:
        raise SystemExit(f"SP4 plotting failed: {exc}") from exc
    for path in paths:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
