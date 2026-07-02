#!/usr/bin/env python3
"""Render FEM frequency-domain eigen artifacts to lightweight SVG previews."""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import struct
from pathlib import Path


VIEWS = ("real", "imag", "complex", "abs", "phase")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def finite_number(value: object, fallback: float = 0.0) -> float:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return fallback


def decode_complex_xyz(
    data: bytes,
    source: Path,
) -> list[tuple[tuple[float, float, float], tuple[float, float, float]]]:
    if len(data) % 48 != 0:
        raise SystemExit(f"{source} size must be a multiple of 48 bytes")
    values = struct.unpack("<" + "d" * (len(data) // 8), data)
    samples = []
    for index in range(0, len(values), 6):
        samples.append(
            (
                (values[index], values[index + 2], values[index + 4]),
                (values[index + 1], values[index + 3], values[index + 5]),
            )
        )
    return samples


def read_complex_xyz(path: Path) -> list[tuple[tuple[float, float, float], tuple[float, float, float]]]:
    return decode_complex_xyz(path.read_bytes(), path)


def vector_norm(values: tuple[float, float, float]) -> float:
    return math.sqrt(sum(component * component for component in values))


def scalar_for_view(
    sample: tuple[tuple[float, float, float], tuple[float, float, float]],
    view: str,
) -> float:
    real, imag = sample
    if view == "real":
        return vector_norm(real)
    if view == "imag":
        return vector_norm(imag)
    if view in {"complex", "abs"}:
        return math.sqrt(vector_norm(real) ** 2 + vector_norm(imag) ** 2)
    if view == "phase":
        return math.atan2(sum(imag), sum(real))
    raise ValueError(f"unsupported view: {view}")


def color(value: float, low: float, high: float, *, cyclic: bool = False) -> str:
    if cyclic:
        normalized = (value + math.pi) / (2.0 * math.pi)
    elif high > low:
        normalized = (value - low) / (high - low)
    else:
        normalized = 0.5
    normalized = min(1.0, max(0.0, normalized))
    hue = 240.0 * (1.0 - normalized)
    return f"hsl({hue:.1f} 82% 48%)"


def write_spectrum_svg(path: Path, modes: list[dict]) -> None:
    width = 760
    height = 320
    margin = 44
    max_frequency = max((mode_frequency_hz(mode) for mode in modes), default=1.0)
    max_frequency = max(max_frequency, 1.0)
    bars = []
    for index, mode in enumerate(modes):
        frequency_hz = mode_frequency_hz(mode)
        x = margin + index * max(1.0, (width - 2 * margin) / max(len(modes), 1))
        bar_width = max(8.0, (width - 2 * margin) / max(len(modes), 1) * 0.55)
        bar_height = (height - 2 * margin) * frequency_hz / max_frequency
        y = height - margin - bar_height
        label = html.escape(str(mode.get("raw_mode_index", index)))
        bars.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{bar_width:.2f}" '
            f'height="{bar_height:.2f}" fill="#2f6f9f" />'
        )
        bars.append(
            f'<text x="{x + bar_width / 2:.2f}" y="{height - 16}" text-anchor="middle" '
            f'font-size="11">{label}</text>'
        )
    ghz = max_frequency / 1.0e9
    svg = "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
            '<rect width="100%" height="100%" fill="#f8faf8" />',
            '<text x="24" y="28" font-size="18" font-family="sans-serif">Eigen spectrum</text>',
            f'<text x="24" y="48" font-size="12" font-family="sans-serif">max {ghz:.6g} GHz</text>',
            f'<line x1="{margin}" y1="{height - margin}" x2="{width - margin}" y2="{height - margin}" stroke="#1f2933" />',
            f'<line x1="{margin}" y1="{margin}" x2="{margin}" y2="{height - margin}" stroke="#1f2933" />',
            *bars,
            "</svg>",
        ]
    )
    path.write_text(svg, encoding="utf-8")


def write_mode_svg(path: Path, values: list[float], view: str, title: str) -> None:
    width = 760
    height = 180
    margin = 36
    low = -math.pi if view == "phase" else min(values, default=0.0)
    high = math.pi if view == "phase" else max(values, default=1.0)
    count = max(len(values), 1)
    cell_width = max(2.0, (width - 2 * margin) / count)
    cells = []
    for index, value in enumerate(values):
        x = margin + index * cell_width
        cells.append(
            f'<rect x="{x:.2f}" y="70" width="{cell_width + 0.5:.2f}" height="54" '
            f'fill="{color(value, low, high, cyclic=view == "phase")}" />'
        )
    svg = "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
            '<rect width="100%" height="100%" fill="#f8faf8" />',
            f'<text x="24" y="30" font-size="18" font-family="sans-serif">{html.escape(title)}</text>',
            f'<text x="24" y="50" font-size="12" font-family="sans-serif">view={view}, samples={len(values)}, range=[{low:.6g}, {high:.6g}]</text>',
            *cells,
            "</svg>",
        ]
    )
    path.write_text(svg, encoding="utf-8")


def phase_rotated_value(
    sample: tuple[tuple[float, float, float], tuple[float, float, float]],
    phase_rad: float,
) -> float:
    real, imag = sample
    rotated = tuple(
        real[component] * math.cos(phase_rad) - imag[component] * math.sin(phase_rad)
        for component in range(3)
    )
    return vector_norm(rotated)


def write_mode_animation_svg(
    path: Path,
    samples: list[tuple[tuple[float, float, float], tuple[float, float, float]]],
    title: str,
    *,
    frame_count: int = 12,
) -> None:
    width = 760
    height = 190
    margin = 36
    count = max(len(samples), 1)
    cell_width = max(2.0, (width - 2 * margin) / count)
    phases = [2.0 * math.pi * frame / frame_count for frame in range(frame_count)]
    frames = [
        [phase_rotated_value(sample, phase_rad) for sample in samples]
        for phase_rad in phases
    ]
    all_values = [value for frame in frames for value in frame]
    low = min(all_values, default=0.0)
    high = max(all_values, default=1.0)
    cells = []
    for index in range(len(samples)):
        values = [frame[index] for frame in frames]
        colors = ";".join(color(value, low, high) for value in values)
        x = margin + index * cell_width
        cells.append(
            f'<rect x="{x:.2f}" y="76" width="{cell_width + 0.5:.2f}" height="54" '
            f'fill="{color(values[0], low, high)}">'
            f'<animate attributeName="fill" dur="1.2s" repeatCount="indefinite" '
            f'values="{colors};{colors.split(";")[0]}" />'
            "</rect>"
        )
    svg = "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
            '<rect width="100%" height="100%" fill="#f8faf8" />',
            f'<text x="24" y="30" font-size="18" font-family="sans-serif">{html.escape(title)}</text>',
            f'<text x="24" y="50" font-size="12" font-family="sans-serif">phase-rotated animation, samples={len(samples)}, frames={frame_count}</text>',
            *cells,
            "</svg>",
        ]
    )
    path.write_text(svg, encoding="utf-8")


def spectrum_modes(root: Path) -> list[dict]:
    spectrum = load_json(root / "eigen" / "spectrum.v2.json")
    modes = []
    for sample in spectrum.get("samples", []):
        if not isinstance(sample, dict):
            continue
        sample_index = int(sample.get("sample_index", 0))
        for mode in sample.get("modes", []):
            if isinstance(mode, dict):
                copied = dict(mode)
                copied["sample_index"] = sample_index
                modes.append(copied)
    return modes


def selected_modes(modes: list[dict], requested: set[int] | None) -> list[dict]:
    if requested is None:
        return modes[: min(len(modes), 4)]
    return [mode for mode in modes if int(mode.get("raw_mode_index", -1)) in requested]


def mode_frequency_hz(mode: dict) -> float:
    return finite_number(
        mode.get("frequency_hz")
        or mode.get("frequency_real_hz")
        or mode.get("frequency_Hz")
    )


def validate_rendered_png(
    path: Path,
    *,
    min_width: int = 640,
    min_height: int = 360,
    min_color_span: float = 1.0e-3,
) -> None:
    if not path.is_file():
        raise SystemExit(f"missing PNG: {path}")
    if not path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
        raise SystemExit(f"{path} is not a PNG file")
    try:
        import matplotlib.image as mpimg
        import numpy as np
    except Exception as exc:  # pragma: no cover - environment-specific dependency failure
        raise SystemExit(f"matplotlib image support is required to validate {path}: {exc}") from exc

    pixels = np.asarray(mpimg.imread(path))
    if pixels.ndim not in {2, 3} or pixels.size == 0:
        raise SystemExit(f"{path} does not contain a readable image")
    height, width = pixels.shape[:2]
    if width < min_width or height < min_height:
        raise SystemExit(f"{path} is too small: {width}x{height}, expected at least {min_width}x{min_height}")
    if not np.isfinite(pixels).all():
        raise SystemExit(f"{path} contains non-finite pixel values")
    if pixels.ndim == 3 and pixels.shape[2] >= 4 and float(np.max(pixels[:, :, 3])) <= 0.0:
        raise SystemExit(f"{path} is fully transparent")

    color_pixels = pixels[:, :, :3] if pixels.ndim == 3 else pixels
    color_span = float(np.max(color_pixels) - np.min(color_pixels))
    if color_span < min_color_span:
        raise SystemExit(
            f"{path} appears blank: color span {color_span:.6g} < {min_color_span:.6g}"
        )


def csv_float(row: dict[str, str], key: str) -> float | None:
    value = row.get(key, "").strip()
    if not value:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def analytic_dispersion_points(
    rows: list[dict[str, str]],
) -> list[tuple[float, float, str, str]]:
    points = []
    for row in rows:
        path_value = csv_float(row, "path_s_rad_per_m")
        analytic_frequency = csv_float(row, "analytic_frequency_hz")
        if path_value is None or analytic_frequency is None:
            continue
        points.append(
            (
                path_value / 1.0e6,
                analytic_frequency / 1.0e9,
                row.get("label", ""),
                row.get("validation_geometry", ""),
            )
        )
    return points


def relative_error_values(rows: list[dict[str, str]]) -> list[float]:
    return [
        value
        for row in rows
        for value in [csv_float(row, "relative_error")]
        if value is not None
    ]


def write_dispersion_png(root: Path, output_png: Path) -> None:
    dispersion_path = root / "eigen" / "dispersion.csv"
    if not dispersion_path.is_file():
        raise SystemExit(f"missing dispersion CSV: {dispersion_path}")
    rows = list(csv.DictReader(dispersion_path.read_text(encoding="utf-8").splitlines()))
    if not rows:
        raise SystemExit(f"{dispersion_path} does not contain any dispersion rows")

    path_s = [float(row["path_s_rad_per_m"]) / 1.0e6 for row in rows]
    frequencies_ghz = [float(row["frequency_hz"]) / 1.0e9 for row in rows]
    labels = [row.get("label", "") for row in rows]
    analytic_points = analytic_dispersion_points(rows)
    relative_errors = relative_error_values(rows)

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as exc:  # pragma: no cover - environment-specific dependency failure
        raise SystemExit(f"matplotlib is required to write {output_png}: {exc}") from exc

    output_png.parent.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(figsize=(12, 7), dpi=150)
    ax.plot(
        path_s,
        frequencies_ghz,
        color="#2563eb",
        linewidth=2.4,
        marker="o",
        markersize=7,
        label="solver branch",
    )
    if analytic_points:
        ax.plot(
            [point[0] for point in analytic_points],
            [point[1] for point in analytic_points],
            color="#dc2626",
            linestyle="--",
            linewidth=2.0,
            marker="x",
            markersize=7,
            label="analytic reference",
        )
    ax.fill_between(
        path_s,
        [min(frequencies_ghz) - 0.05] * len(path_s),
        frequencies_ghz,
        color="#bfdbfe",
        alpha=0.35,
    )
    for x_value, frequency, label in zip(path_s, frequencies_ghz, labels):
        if label:
            ax.annotate(
                label,
                (x_value, frequency),
                xytext=(0, 8),
                textcoords="offset points",
                ha="center",
                va="bottom",
                fontsize=11,
                fontweight="bold",
            )
    ax.set_title(
        (
            "FEM modal DE/BV dispersion - analytic reference overlay"
            if analytic_points
            else "FEM modal k-path dispersion - reference Full2x2 Floquet artifact"
        ),
        fontsize=13,
    )
    ax.set_xlabel("k-path distance (10^6 rad/m)", fontsize=11)
    ax.set_ylabel("frequency (GHz)", fontsize=11)
    if analytic_points:
        ax.legend(loc="best", frameon=True)
    ax.grid(True, which="major", color="#cbd5e1", linewidth=0.8, alpha=0.8)
    ax.grid(True, which="minor", color="#e2e8f0", linewidth=0.5, alpha=0.7)
    ax.minorticks_on()
    y_margin = max((max(frequencies_ghz) - min(frequencies_ghz)) * 0.25, 0.03)
    ax.set_ylim(min(frequencies_ghz) - y_margin, max(frequencies_ghz) + y_margin)
    fig.text(
        0.012,
        0.02,
        (
            f"source: {dispersion_path} | samples={len(rows)} | "
            + (
                f"analytic overlay, max rel. error={max(relative_errors):.3e}"
                if relative_errors
                else "reference CPU, no demag, lowest branch"
            )
        ),
        fontsize=8.5,
        color="#475569",
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(output_png)
    plt.close(fig)
    validate_rendered_png(output_png)


def mode_metadata_path(root: Path, sample_index: int, raw_mode: int) -> Path:
    return root / "eigen" / "modes" / f"sample_{sample_index:04d}" / f"mode_{raw_mode:04d}.json"


def resolve_mode_payload_path(root: Path, sample_index: int, raw_mode: int) -> Path:
    metadata_path = mode_metadata_path(root, sample_index, raw_mode)
    metadata = load_json(metadata_path) if metadata_path.is_file() else {}
    for key in ("zarr_chunk_path", "compatibility_binary_payload_path"):
        relative_path = metadata.get(key)
        if isinstance(relative_path, str) and relative_path:
            candidate = root / relative_path
            if candidate.is_file():
                return candidate
    return (
        root
        / "eigen"
        / "mode_fields"
        / f"sample_{sample_index:04d}"
        / f"mode_{raw_mode:04d}"
        / "vector.bin"
    )


def render(root: Path, output_dir: Path, mode_indices: set[int] | None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    modes = spectrum_modes(root)
    write_spectrum_svg(output_dir / "spectrum.svg", modes)

    print("mode,frequency_GHz,residual")
    for mode in modes:
        raw_mode = int(mode.get("raw_mode_index", 0))
        frequency_ghz = mode_frequency_hz(mode) / 1.0e9
        residual = finite_number(mode.get("residual_norm"), float("nan"))
        print(f"{raw_mode},{frequency_ghz:.9g},{residual:.9g}")

    for mode in selected_modes(modes, mode_indices):
        sample_index = int(mode.get("sample_index", 0))
        raw_mode = int(mode.get("raw_mode_index", 0))
        payload_path = resolve_mode_payload_path(root, sample_index, raw_mode)
        samples = read_complex_xyz(payload_path)
        for view in VIEWS:
            values = [scalar_for_view(sample, view) for sample in samples]
            write_mode_svg(
                output_dir / f"mode_sample_{sample_index:04d}_mode_{raw_mode:04d}_{view}.svg",
                values,
                view,
                f"Mode {raw_mode} sample {sample_index}",
            )
        write_mode_animation_svg(
            output_dir / f"mode_sample_{sample_index:04d}_mode_{raw_mode:04d}_animation.svg",
            samples,
            f"Mode {raw_mode} sample {sample_index}",
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_root", type=Path)
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument(
        "--modes",
        default=None,
        help="Comma-separated raw mode indices to render. Defaults to the first four modes.",
    )
    parser.add_argument(
        "--dispersion-png",
        type=Path,
        default=None,
        help="Optional PNG path for the k-path dispersion curve.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    mode_indices = (
        None
        if args.modes is None
        else {int(part.strip()) for part in args.modes.split(",") if part.strip()}
    )
    output_dir = args.output_dir or (args.artifact_root / "eigen" / "plots")
    render(args.artifact_root, output_dir, mode_indices)
    if args.dispersion_png is not None:
        write_dispersion_png(args.artifact_root, args.dispersion_png)
    print(f"wrote plots to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
