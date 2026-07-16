#!/usr/bin/env python3
"""Validate a produced time-domain Γ response artifact and convergence peers."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def load(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text())
    if value.get("schema_version") != "spin_wave_response.gamma.v1":
        raise ValueError(f"{path}: unexpected schema_version")
    return value


def dominant_peak(value: dict[str, object]) -> tuple[float, float]:
    peaks = value.get("peaks")
    if not isinstance(peaks, list) or not peaks:
        raise ValueError("Γ artifact has no detected non-DC peak")
    peak = peaks[0]
    return float(peak["frequency_hz"]), float(peak["power"])


def differential_dominant_peak(
    value: dict[str, object], reference: dict[str, object]
) -> tuple[float, float]:
    time = [float(item) for item in value["time_s"]]
    reference_time = [float(item) for item in reference["time_s"]]
    if time != reference_time:
        raise ValueError("driven and zero-amplitude traces must use the same time axis")
    response = [float(item) for item in value["response_trace"]]
    reference_response = [float(item) for item in reference["response_trace"]]
    if len(response) != len(reference_response):
        raise ValueError("driven and zero-amplitude response lengths differ")
    samples = [item - background for item, background in zip(response, reference_response)]
    count = len(samples)
    mean_index = 0.5 * (count - 1)
    mean_value = sum(samples) / count
    denominator = sum((index - mean_index) ** 2 for index in range(count))
    slope = sum(
        (index - mean_index) * (sample - mean_value)
        for index, sample in enumerate(samples)
    ) / denominator
    detrended = [
        sample - (mean_value + slope * (index - mean_index))
        for index, sample in enumerate(samples)
    ]
    window = [
        0.5 - 0.5 * math.cos(2.0 * math.pi * index / (count - 1))
        for index in range(count)
    ]
    window_energy = sum(item * item for item in window)
    dt = time[1] - time[0]
    powers: list[tuple[float, float]] = []
    for frequency_index in range(1, count // 2 + 1):
        real = 0.0
        imaginary = 0.0
        for sample_index, (sample, weight) in enumerate(zip(detrended, window)):
            phase = -2.0 * math.pi * frequency_index * sample_index / count
            real += sample * weight * math.cos(phase)
            imaginary += sample * weight * math.sin(phase)
        power = (real * real + imaginary * imaginary) / (count * window_energy)
        if not (count % 2 == 0 and frequency_index == count // 2):
            power *= 2.0
        powers.append((frequency_index / (count * dt), power))
    return max(powers, key=lambda item: item[1])


def validate_single(value: dict[str, object]) -> None:
    time = [float(item) for item in value["time_s"]]
    frequency = [float(item) for item in value["frequency_hz"]]
    response = [float(item) for item in value["response_trace"]]
    source = [float(item) for item in value["source_trace"]]
    response_psd = [float(item) for item in value["response_psd"]]
    if len(time) < 4 or not (len(time) == len(response) == len(source)):
        raise ValueError("Γ traces must have equal length >= 4")
    dt = time[1] - time[0]
    tolerance = abs(dt) * 1e-9 + math.ulp(dt)
    if dt <= 0 or any(abs((b - a) - dt) > tolerance for a, b in zip(time, time[1:])):
        raise ValueError("Γ time samples are not uniform")
    if len(frequency) != len(response_psd) or frequency[-1] > 0.5 / dt * (1 + 1e-12):
        raise ValueError("Γ frequency axis violates temporal Nyquist")
    if value.get("weighting") != "Ms_times_lumped_volume":
        raise ValueError("Γ response is not magnetic-moment weighted")
    if value.get("normalization") != "one_sided_abs_fft_squared_over_N_sum_window_squared":
        raise ValueError("Γ PSD normalization is not canonical")
    if not all(math.isfinite(item) and item >= 0 for item in response_psd):
        raise ValueError("Γ PSD contains invalid power")
    dominant_peak(value)


def relative_shift(left: float, right: float) -> float:
    return abs(left - right) / max(abs(left), abs(right), 1e-300)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--half-dt", type=Path)
    parser.add_argument("--refined-mesh", type=Path)
    parser.add_argument("--double-amplitude", type=Path)
    parser.add_argument("--zero-amplitude", type=Path)
    parser.add_argument("--gpu", type=Path)
    args = parser.parse_args()
    baseline = load(args.artifact)
    validate_single(baseline)
    f0, p0 = dominant_peak(baseline)
    checks = ((args.half_dt, 0.005, "dt convergence"), (args.refined_mesh, 0.02, "mesh convergence"), (args.gpu, 0.005, "CPU/GPU peak parity"))
    for path, tolerance, label in checks:
        if path:
            peer = load(path); validate_single(peer)
            if relative_shift(f0, dominant_peak(peer)[0]) >= tolerance:
                raise ValueError(f"{label} failed")
    if args.double_amplitude:
        if not args.zero_amplitude:
            raise ValueError("--double-amplitude requires --zero-amplitude background subtraction")
        reference = load(args.zero_amplitude); validate_single(reference)
        if any(abs(float(item)) > 1e-15 for item in reference["source_trace"]):
            raise ValueError("zero-amplitude reference contains a non-zero source trace")
        peer = load(args.double_amplitude); validate_single(peer)
        f0, p0 = differential_dominant_peak(baseline, reference)
        f1, p1 = differential_dominant_peak(peer, reference)
        if relative_shift(f0, f1) >= 0.005:
            raise ValueError("small-signal peak shifted after doubling amplitude")
        amplitude_ratio = math.sqrt(p1 / p0)
        if abs(amplitude_ratio - 2.0) > 0.1:
            raise ValueError(f"small-signal response ratio {amplitude_ratio:.6g} is outside 2.0 +/- 5%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
