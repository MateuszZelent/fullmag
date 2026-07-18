"""Deterministic non-interactive figures for the SP4 qualification report."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .references import Trajectory


def _pyplot():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as exc:
        raise RuntimeError("SP4 report generation requires matplotlib") from exc
    return plt


def write_trajectory_plot(path: Path, candidate: Trajectory, references: list[Trajectory], title: str) -> None:
    plt = _pyplot()
    path.parent.mkdir(parents=True, exist_ok=True)
    figure, axes = plt.subplots(3, 1, figsize=(8, 8), sharex=True, constrained_layout=True)
    labels = ("mx", "my", "mz")
    for component, axis in enumerate(axes):
        for index, reference in enumerate(references):
            axis.plot(reference.time_s * 1e12, reference.m[:, component], color="0.65", linewidth=0.8, alpha=0.8, label="NIST references" if index == 0 else None)
        axis.plot(candidate.time_s * 1e12, candidate.m[:, component], color="#1f77b4", linewidth=1.2, label="Fullmag FEM")
        axis.set_ylabel(labels[component])
        axis.grid(True, alpha=0.25)
    axes[0].legend(loc="best")
    axes[-1].set_xlabel("time (ps)")
    figure.suptitle(title)
    figure.savefig(path, dpi=160)
    plt.close(figure)


def write_vector_map_plot(path: Path, candidate: np.ndarray, reference: np.ndarray, title: str) -> None:
    plt = _pyplot()
    path.parent.mkdir(parents=True, exist_ok=True)
    figure, axes = plt.subplots(3, 3, figsize=(12, 8), constrained_layout=True)
    labels = ("mx", "my", "mz")
    for component in range(3):
        images = (candidate[..., component], reference[..., component], candidate[..., component] - reference[..., component])
        names = ("Fullmag FEM", "NIST OOMMF", "difference")
        for column, (values, name) in enumerate(zip(images, names)):
            limit = 1.0 if column < 2 else max(float(np.max(np.abs(values))), 1e-12)
            image = axes[component, column].imshow(values.T, origin="lower", aspect="auto", cmap="coolwarm", vmin=-limit, vmax=limit)
            axes[component, column].set_title(f"{labels[component]} — {name}")
            figure.colorbar(image, ax=axes[component, column], fraction=0.046)
    figure.suptitle(title)
    figure.savefig(path, dpi=160)
    plt.close(figure)
