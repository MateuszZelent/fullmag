"""Numerical comparison metrics for SP4 trajectories and vector maps."""

from __future__ import annotations

import numpy as np

from .references import ReferenceDataError, Trajectory


def _finite(array, name):
    value = np.asarray(array, dtype=float)
    if not np.all(np.isfinite(value)):
        raise ReferenceDataError(f"non-finite {name}")
    return value


def find_first_zero_crossing(trajectory: Trajectory) -> float:
    t, x = trajectory.time_s, trajectory.m[:, 0]
    for index in range(len(x)):
        if x[index] == 0 and (index == 0 or x[index - 1] > 0):
            return float(t[index])
        if index and x[index - 1] > 0 and x[index] < 0:
            fraction = x[index - 1] / (x[index - 1] - x[index])
            return float(t[index - 1] + fraction * (t[index] - t[index - 1]))
    raise ReferenceDataError("trajectory has no positive-to-nonpositive mx crossing")


def interpolate_trajectory(trajectory: Trajectory, time_s) -> np.ndarray:
    query = _finite(time_s, "interpolation time")
    if np.any(query < trajectory.time_s[0]) or np.any(query > trajectory.time_s[-1]):
        raise ReferenceDataError("interpolation would extrapolate")
    return np.column_stack([np.interp(query, trajectory.time_s, trajectory.m[:, i]) for i in range(3)])


def reference_envelope_metrics(candidate: Trajectory, references: list[Trajectory], grid_s=None) -> dict:
    if not references:
        raise ReferenceDataError("reference ensemble is empty")
    grid = candidate.time_s if grid_s is None else _finite(grid_s, "metric grid")
    values = np.stack([interpolate_trajectory(reference, grid) for reference in references])
    actual = interpolate_trajectory(candidate, grid)
    low, high = values.min(axis=0), values.max(axis=0)
    distance = np.maximum(low - actual, 0) + np.maximum(actual - high, 0)
    scale = np.maximum(high - low, 0.02)
    normalized = distance / scale
    primary = values[0]
    return {
        "normalized_rms": np.sqrt(np.mean(normalized**2, axis=0)).tolist(),
        "normalized_p99": np.percentile(normalized, 99, axis=0).tolist(),
        "rmse": np.sqrt(np.mean((actual - primary) ** 2, axis=0)).tolist(),
        "maximum_error": np.max(np.abs(actual - primary), axis=0).tolist(),
        "endpoint_error": np.abs(actual[-1] - primary[-1]).tolist(),
    }


def trajectory_pair_metrics(left: Trajectory, right: Trajectory) -> dict:
    start = max(left.time_s[0], right.time_s[0])
    stop = min(left.time_s[-1], right.time_s[-1])
    if stop <= start:
        raise ReferenceDataError("trajectories do not overlap")
    grid = left.time_s[(left.time_s >= start) & (left.time_s <= stop)]
    a, b = interpolate_trajectory(left, grid), interpolate_trajectory(right, grid)
    return {
        "trajectory_rmse": np.sqrt(np.mean((a - b) ** 2, axis=0)).tolist(),
        "endpoint_delta": np.abs(a[-1] - b[-1]).tolist(),
        "crossing_delta_s": abs(find_first_zero_crossing(left) - find_first_zero_crossing(right)),
    }


convergence_metrics = trajectory_pair_metrics
parity_metrics = trajectory_pair_metrics


def interpolate_crossing_field(before_m, after_m, before_mx: float, after_mx: float):
    if not before_mx > 0 or not after_mx <= 0:
        raise ReferenceDataError("fields do not bracket mx crossing")
    fraction = before_mx / (before_mx - after_mx)
    field = (1 - fraction) * _finite(before_m, "before field") + fraction * _finite(after_m, "after field")
    norms = np.linalg.norm(field, axis=-1, keepdims=True)
    if np.any(norms == 0):
        raise ReferenceDataError("cannot normalize zero magnetization")
    return field / norms


def vector_field_metrics(candidate, reference) -> dict:
    a, b = _finite(candidate, "candidate field"), _finite(reference, "reference field")
    if a.shape != b.shape or a.shape[-1] != 3:
        raise ReferenceDataError("vector-field shapes differ")
    dots = np.sum(a * b, axis=-1)
    denom = np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1)
    if np.any(denom == 0):
        raise ReferenceDataError("zero vector in field comparison")
    return {"correlation": float(np.mean(dots / denom)), "component_rmse": np.sqrt(np.mean((a - b) ** 2, axis=tuple(range(a.ndim - 1)))).tolist()}
