"""Artifact-backed STNO analysis and report helpers.

This module turns real solver artifacts into a compact STNO summary:

- averaged magnetization traces from ``scalars.csv``,
- PSD / peak frequency / linewidth,
- a simple steady-state score and detection window,
- optional vortex-core trajectory metrics from ``fields/m`` snapshots.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import csv
import json
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag.analysis.fitting import fit_lorentzian_linewidth, linewidth_halfmax
from fullmag.analysis.spectrum import peak_frequency, psd_from_trace
from fullmag.analysis.vortex_fit import compute_orbit_metrics, track_vortex_core_subpixel


ArrayF64 = NDArray[np.float64]

_SCALAR_ALIASES = {
    "time_s": "time",
    "mx_avg": "mx",
    "my_avg": "my",
    "mz_avg": "mz",
    "e_total_j": "E_total",
}


@dataclass(frozen=True, slots=True)
class StnoSteadyStateMetrics:
    start_time_s: float
    end_time_s: float
    score: float
    amplitude_target: float
    relative_error_mean: float


@dataclass(frozen=True, slots=True)
class StnoSpectrumMetrics:
    signal: str
    peak_frequency_hz: float
    linewidth_fwhm_hz: float
    q_factor: float
    fit_method: str
    fit_r2: float | None
    discard_transient_s: float


@dataclass(frozen=True, slots=True)
class StnoOrbitSummary:
    mean_radius_m: float
    ellipticity: float
    gyration_frequency_hz: float | None
    sample_count: int


@dataclass(frozen=True, slots=True)
class StnoArtifactReport:
    artifact_dir: str
    sample_count: int
    duration_s: float
    scalar_channels: tuple[str, ...]
    spectrum: StnoSpectrumMetrics
    steady_state: StnoSteadyStateMetrics
    orbit: StnoOrbitSummary | None
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["scalar_channels"] = list(self.scalar_channels)
        payload["notes"] = list(self.notes)
        return payload


def load_scalar_artifacts(artifact_dir: str | Path) -> dict[str, ArrayF64]:
    """Load scalar artifact columns from ``scalars.csv`` as NumPy arrays."""

    artifact_path = Path(artifact_dir)
    csv_path = artifact_path / "scalars.csv"
    if not csv_path.is_file():
        raise FileNotFoundError(f"missing scalar artifact file: {csv_path}")

    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"scalar artifact file has no header: {csv_path}")
        columns: dict[str, list[float]] = {name: [] for name in reader.fieldnames}
        for row in reader:
            for name in reader.fieldnames:
                raw = row.get(name)
                if raw is None or not raw.strip():
                    columns[name].append(float("nan"))
                else:
                    columns[name].append(float(raw))

    payload = {
        name: np.asarray(values, dtype=np.float64)
        for name, values in columns.items()
    }
    for alias, canonical in _SCALAR_ALIASES.items():
        if alias not in payload and canonical in payload:
            payload[alias] = payload[canonical]
    return payload


def analyze_stno_artifacts(
    artifact_dir: str | Path,
    *,
    discard_transient_s: float | None = None,
    fmin_hz: float = 1.0e7,
    fmax_hz: float | None = None,
    linewidth_method: str = "lorentzian",
    include_core_track: bool = True,
) -> StnoArtifactReport:
    """Analyze real STNO artifacts written by the solver."""

    artifact_path = Path(artifact_dir)
    scalars = load_scalar_artifacts(artifact_path)
    time_s = _required_scalar(scalars, "time_s")
    mx_avg = _required_scalar(scalars, "mx_avg")
    my_avg = _required_scalar(scalars, "my_avg")
    mz_avg = _required_scalar(scalars, "mz_avg")

    if len(time_s) < 8:
        raise ValueError("stno analysis requires at least 8 scalar samples")

    duration_s = float(time_s[-1] - time_s[0])
    if discard_transient_s is None:
        discard_transient_s = _default_discard_transient(duration_s)

    dominant_signal = _choose_dominant_signal(
        mx_avg,
        my_avg,
        time_s=time_s,
        discard_transient_s=discard_transient_s,
    )
    signal = mx_avg if dominant_signal == "mx_avg" else my_avg
    freqs_hz, psd = psd_from_trace(
        time_s,
        signal,
        window="hann",
        discard_transient=discard_transient_s,
    )
    peak_hz = peak_frequency(freqs_hz, psd, fmin=fmin_hz, fmax=fmax_hz)
    spectrum = _spectrum_metrics(
        dominant_signal,
        freqs_hz,
        psd,
        discard_transient_s=discard_transient_s,
        peak_hz=peak_hz,
        fmin_hz=fmin_hz,
        fmax_hz=fmax_hz,
        linewidth_method=linewidth_method,
    )
    steady_state = _steady_state_metrics(
        time_s,
        mx_avg,
        my_avg,
        discard_transient_s=discard_transient_s,
    )

    notes: list[str] = []
    orbit = None
    if include_core_track:
        try:
            orbit = _analyze_vortex_orbit(
                artifact_path,
                steady_state_start_s=steady_state.start_time_s,
            )
        except FileNotFoundError:
            notes.append("fields/m snapshots not found; orbit metrics skipped")
        except ValueError as error:
            notes.append(f"orbit metrics skipped: {error}")

    return StnoArtifactReport(
        artifact_dir=str(artifact_path),
        sample_count=len(time_s),
        duration_s=duration_s,
        scalar_channels=tuple(sorted(name for name in scalars if name in {"time", "mx", "my", "mz", "E_total", "max_dm_dt"})),
        spectrum=spectrum,
        steady_state=steady_state,
        orbit=orbit,
        notes=tuple(notes),
    )


def write_stno_report(
    artifact_dir: str | Path,
    *,
    report: StnoArtifactReport | None = None,
    basename: str = "stno_summary",
) -> tuple[Path, Path]:
    """Write JSON and Markdown STNO summaries into the artifact directory."""

    artifact_path = Path(artifact_dir)
    effective_report = report if report is not None else analyze_stno_artifacts(artifact_path)
    json_path = artifact_path / f"{basename}.json"
    markdown_path = artifact_path / f"{basename}.md"

    json_path.write_text(
        json.dumps(effective_report.to_dict(), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    markdown_path.write_text(
        _markdown_report(effective_report),
        encoding="utf-8",
    )
    return json_path, markdown_path


def _required_scalar(scalars: dict[str, ArrayF64], name: str) -> ArrayF64:
    if name in scalars:
        return scalars[name]
    canonical = _SCALAR_ALIASES.get(name)
    if canonical is not None and canonical in scalars:
        return scalars[canonical]
    raise KeyError(f"required scalar channel is missing: {name}")


def _default_discard_transient(duration_s: float) -> float:
    if duration_s <= 0.0:
        return 0.0
    return min(1.0e-8, 0.25 * duration_s)


def _choose_dominant_signal(
    mx_avg: ArrayF64,
    my_avg: ArrayF64,
    *,
    time_s: ArrayF64,
    discard_transient_s: float,
) -> str:
    mask = time_s >= discard_transient_s
    if not np.any(mask):
        mask = np.ones_like(time_s, dtype=bool)
    mx_var = float(np.var(mx_avg[mask]))
    my_var = float(np.var(my_avg[mask]))
    return "mx_avg" if mx_var >= my_var else "my_avg"


def _spectrum_metrics(
    signal_name: str,
    freqs_hz: ArrayF64,
    psd: ArrayF64,
    *,
    discard_transient_s: float,
    peak_hz: float,
    fmin_hz: float,
    fmax_hz: float | None,
    linewidth_method: str,
) -> StnoSpectrumMetrics:
    if linewidth_method == "lorentzian":
        fit = fit_lorentzian_linewidth(
            freqs_hz,
            psd,
            f_center=peak_hz,
            fmin=fmin_hz,
            fmax=fmax_hz,
        )
        linewidth_hz = float(fit.fwhm_hz)
        q_factor = float(fit.q_factor)
        fit_method = fit.method
        fit_r2 = fit.fit_r2
    elif linewidth_method == "halfmax":
        fit = linewidth_halfmax(
            freqs_hz,
            psd,
            f_center=peak_hz,
            fmin=fmin_hz,
            fmax=fmax_hz,
        )
        linewidth_hz = float(fit["fwhm"])
        q_factor = float(peak_hz / linewidth_hz) if linewidth_hz > 0.0 else 0.0
        fit_method = "halfmax"
        fit_r2 = None
    else:
        raise ValueError(
            "linewidth_method must be 'lorentzian' or 'halfmax', "
            f"got {linewidth_method!r}"
        )

    return StnoSpectrumMetrics(
        signal=signal_name,
        peak_frequency_hz=float(peak_hz),
        linewidth_fwhm_hz=linewidth_hz,
        q_factor=q_factor,
        fit_method=fit_method,
        fit_r2=fit_r2,
        discard_transient_s=float(discard_transient_s),
    )


def _steady_state_metrics(
    time_s: ArrayF64,
    mx_avg: ArrayF64,
    my_avg: ArrayF64,
    *,
    discard_transient_s: float,
) -> StnoSteadyStateMetrics:
    mask = time_s >= discard_transient_s
    if np.count_nonzero(mask) < 8:
        mask = np.ones_like(time_s, dtype=bool)
    tail_t = time_s[mask]
    mx_tail = mx_avg[mask]
    my_tail = my_avg[mask]
    amp = np.sqrt(
        (mx_tail - float(np.mean(mx_tail))) ** 2
        + (my_tail - float(np.mean(my_tail))) ** 2
    )
    if len(amp) < 4:
        return StnoSteadyStateMetrics(
            start_time_s=float(tail_t[0]),
            end_time_s=float(tail_t[-1]),
            score=0.0,
            amplitude_target=float(np.mean(amp)) if len(amp) else 0.0,
            relative_error_mean=1.0,
        )

    window = max(5, len(amp) // 40)
    smooth = _moving_average(amp, window)
    tail_count = max(window * 3, len(smooth) // 5)
    target = float(np.median(smooth[-tail_count:]))
    if target <= 1.0e-30:
        return StnoSteadyStateMetrics(
            start_time_s=float(tail_t[0]),
            end_time_s=float(tail_t[-1]),
            score=0.0,
            amplitude_target=0.0,
            relative_error_mean=1.0,
        )

    relative_error = np.abs(smooth - target) / target
    bad = relative_error > 0.12
    future_bad_counts = np.cumsum(bad[::-1], dtype=np.int64)[::-1]
    future_lengths = np.arange(len(relative_error), 0, -1, dtype=np.float64)
    future_bad_fraction = future_bad_counts / future_lengths
    candidate = np.where(future_bad_fraction <= 0.10)[0]
    start_index = int(candidate[0]) if len(candidate) else max(0, len(tail_t) - tail_count)
    error_mean = float(np.mean(relative_error[start_index:]))
    score = float(np.clip(1.0 - (error_mean / 0.12), 0.0, 1.0))
    return StnoSteadyStateMetrics(
        start_time_s=float(tail_t[start_index]),
        end_time_s=float(tail_t[-1]),
        score=score,
        amplitude_target=target,
        relative_error_mean=error_mean,
    )


def _moving_average(values: ArrayF64, window: int) -> ArrayF64:
    if window <= 1:
        return values.astype(np.float64, copy=True)
    kernel = np.ones(window, dtype=np.float64) / float(window)
    return np.convolve(values, kernel, mode="same")


def _analyze_vortex_orbit(
    artifact_dir: Path,
    *,
    steady_state_start_s: float,
) -> StnoOrbitSummary:
    snapshot_paths = sorted(
        (artifact_dir / "fields" / "m").glob("step_*.json"),
        key=lambda path: path.name,
    )
    if not snapshot_paths:
        raise FileNotFoundError("no fields/m snapshots were found")

    times: list[float] = []
    xc_track: list[float] = []
    yc_track: list[float] = []
    prev_pos: tuple[float, float] | None = None
    for snapshot_path in snapshot_paths:
        payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
        values = np.asarray(payload.get("values"), dtype=np.float64)
        if values.ndim != 2 or values.shape[1] != 3:
            raise ValueError(f"field snapshot is not a vector field: {snapshot_path}")
        x, y, _z = _snapshot_coordinates(payload)
        mz = values[:, 2]
        if len(mz) != len(x):
            raise ValueError(
                f"field snapshot coordinate layout does not match values length: {snapshot_path}"
            )
        result = track_vortex_core_subpixel(
            mz,
            x,
            y,
            method="continuity_regularized" if prev_pos is not None else "quadratic_subpixel",
            prev_pos=prev_pos,
            max_jump=_max_snapshot_jump(payload),
        )
        prev_pos = (result.x, result.y)
        times.append(float(payload.get("time", 0.0)))
        xc_track.append(result.x)
        yc_track.append(result.y)

    time_s = np.asarray(times, dtype=np.float64)
    xc = np.asarray(xc_track, dtype=np.float64)
    yc = np.asarray(yc_track, dtype=np.float64)
    mask = time_s >= steady_state_start_s
    if np.count_nonzero(mask) >= 3:
        time_s = time_s[mask]
        xc = xc[mask]
        yc = yc[mask]
    metrics = compute_orbit_metrics(xc, yc, time_s)
    return StnoOrbitSummary(
        mean_radius_m=float(metrics.mean_radius),
        ellipticity=float(metrics.ellipticity),
        gyration_frequency_hz=(
            float(metrics.angular_frequency_hz)
            if metrics.angular_frequency_hz is not None
            else None
        ),
        sample_count=len(time_s),
    )


def _snapshot_coordinates(payload: dict[str, Any]) -> tuple[ArrayF64, ArrayF64, ArrayF64]:
    layout = payload.get("layout")
    if not isinstance(layout, dict):
        raise ValueError("field snapshot layout is missing")
    backend = layout.get("backend")
    if backend != "fdm":
        raise ValueError(f"vortex tracking currently supports FDM snapshots only, got {backend!r}")

    cells = layout.get("grid_cells")
    cell_size = layout.get("cell_size")
    if not (isinstance(cells, list) and len(cells) == 3):
        raise ValueError("fdm snapshot layout is missing grid_cells")
    if not (isinstance(cell_size, list) and len(cell_size) == 3):
        raise ValueError("fdm snapshot layout is missing cell_size")

    nx, ny, nz = (int(cells[0]), int(cells[1]), int(cells[2]))
    dx, dy, dz = (float(cell_size[0]), float(cell_size[1]), float(cell_size[2]))
    if "origin" in layout and isinstance(layout["origin"], list) and len(layout["origin"]) == 3:
        origin = [float(layout["origin"][0]), float(layout["origin"][1]), float(layout["origin"][2])]
    else:
        origin = [
            -0.5 * nx * dx,
            -0.5 * ny * dy,
            -0.5 * nz * dz,
        ]

    ix = np.tile(np.arange(nx, dtype=np.float64), ny * nz)
    iy = np.tile(np.repeat(np.arange(ny, dtype=np.float64), nx), nz)
    iz = np.repeat(np.arange(nz, dtype=np.float64), nx * ny)

    x = origin[0] + (ix + 0.5) * dx
    y = origin[1] + (iy + 0.5) * dy
    z = origin[2] + (iz + 0.5) * dz

    return x, y, z


def _max_snapshot_jump(payload: dict[str, Any]) -> float | None:
    layout = payload.get("layout")
    if not isinstance(layout, dict):
        return None
    cell_size = layout.get("cell_size")
    if not (isinstance(cell_size, list) and len(cell_size) >= 2):
        return None
    return 5.0 * max(float(cell_size[0]), float(cell_size[1]))


def _markdown_report(report: StnoArtifactReport) -> str:
    lines = [
        "# STNO Summary",
        "",
        f"- Artifact dir: `{report.artifact_dir}`",
        f"- Scalar samples: {report.sample_count}",
        f"- Duration: {report.duration_s:.6e} s",
        f"- Signal: `{report.spectrum.signal}`",
        f"- Peak frequency: {report.spectrum.peak_frequency_hz:.6e} Hz",
        f"- Linewidth FWHM: {report.spectrum.linewidth_fwhm_hz:.6e} Hz",
        f"- Q factor: {report.spectrum.q_factor:.6e}",
        f"- Steady-state score: {report.steady_state.score:.3f}",
        f"- Steady-state window: [{report.steady_state.start_time_s:.6e}, {report.steady_state.end_time_s:.6e}] s",
    ]
    if report.orbit is not None:
        lines.extend(
            [
                f"- Mean orbit radius: {report.orbit.mean_radius_m:.6e} m",
                f"- Orbit ellipticity: {report.orbit.ellipticity:.6e}",
                f"- Orbit samples: {report.orbit.sample_count}",
            ]
        )
        if report.orbit.gyration_frequency_hz is not None:
            lines.append(
                f"- Orbit gyration frequency: {report.orbit.gyration_frequency_hz:.6e} Hz"
            )
    if report.notes:
        lines.extend(["", "## Notes", ""])
        for note in report.notes:
            lines.append(f"- {note}")
    return "\n".join(lines) + "\n"


__all__ = [
    "StnoArtifactReport",
    "StnoOrbitSummary",
    "StnoSpectrumMetrics",
    "StnoSteadyStateMetrics",
    "analyze_stno_artifacts",
    "load_scalar_artifacts",
    "write_stno_report",
]
