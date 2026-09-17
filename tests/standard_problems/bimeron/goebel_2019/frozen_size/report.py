"""Render a Markdown report from a frozen-spin size-sweep summary.

The report keeps measured, diagnostic, and accepted points separate.  It
never interpolates across a failed or non-converged case and pairs the profile
energy with the state from the same constrained stage.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys
from typing import Any

MU0_T_M_PER_A = 4.0 * math.pi * 1.0e-7


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def free_reference_from_analysis(path: Path) -> dict[str, Any]:
    """Extract one measured free-relaxation control for a profile report."""

    analysis = _load(path)
    profile = analysis.get("profile_energy")
    profile = profile if isinstance(profile, dict) else {}
    states = analysis.get("states")
    states = states if isinstance(states, dict) else {}
    state = states.get("constrained_held")
    state = state if isinstance(state, dict) else {}
    measurement = state.get("measurement")
    measurement = measurement if isinstance(measurement, dict) else {}
    energy = _number(profile.get("E_total_J"))
    area = _number(measurement.get("R_area_nm"))
    core = _number(measurement.get("R_core_nm"))
    charge = _number(measurement.get("topological_charge"))
    if energy is None or area is None:
        raise ValueError(
            f"{path} does not contain finite free-control energy and R_area"
        )
    return {
        "path": str(path.resolve()),
        "status": analysis.get("status", "unknown"),
        "R_area_nm": area,
        "R_core_nm": core,
        "Q": charge,
        "E_total_J": energy,
    }


def _free_reference(summary: dict[str, Any]) -> dict[str, Any] | None:
    value = summary.get("free_reference")
    if not isinstance(value, dict):
        return None
    area = _number(value.get("R_area_nm"))
    energy = _number(value.get("E_total_J"))
    if area is None or energy is None:
        return None
    reference = dict(value)
    reference["R_area_nm"] = area
    reference["E_total_J"] = energy
    reference["R_core_nm"] = _number(value.get("R_core_nm"))
    reference["Q"] = _number(value.get("Q"))
    background = summary.get("background")
    background_energy = (
        _number(background.get("energy_J"))
        if isinstance(background, dict)
        else None
    )
    reference["delta_E_to_background_J"] = (
        energy - background_energy if background_energy is not None else None
    )
    return reference


def _measurement(result: dict[str, Any], state: str) -> dict[str, Any]:
    states = result.get("states")
    if not isinstance(states, dict):
        return {}
    payload = states.get(state)
    if not isinstance(payload, dict):
        return {}
    value = payload.get("measurement")
    return value if isinstance(value, dict) else {}


def _profile_state(result: dict[str, Any]) -> str:
    label = result.get("profile_state_label")
    if label in {"constrained_relaxed", "constrained_held", "final"}:
        return str(label)
    profile = result.get("profile_energy")
    if isinstance(profile, dict) and profile.get("stage_id") == "constrained_relax":
        return "constrained_relaxed"
    if isinstance(profile, dict) and profile.get("stage_id") == "constrained_hold":
        return "constrained_held"
    return "final"


def _verification(result: dict[str, Any]) -> dict[str, Any]:
    artifact_root = result.get("artifact_root")
    if not artifact_root:
        return {"status": "not_run", "failures": [], "warnings": []}
    path = Path(str(artifact_root)) / "verification.json"
    if not path.is_file():
        return {"status": "not_run", "failures": [], "warnings": []}
    try:
        value = _load(path)
    except (OSError, json.JSONDecodeError, ValueError):
        return {"status": "invalid", "failures": ["verification_json_invalid"], "warnings": []}
    return value


def _classification(result: dict[str, Any], verification: dict[str, Any]) -> str:
    status = str(verification.get("status", "not_run"))
    if status == "not_converged":
        return "not_converged"
    protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
    protocol_name = str(protocol.get("protocol", ""))
    # Older P2/P3 verification files used R_area as the acceptance coordinate.
    # Reclassify a radius-only failure when the core coordinate already meets
    # the protocol tolerance, so historical artifacts remain interpretable.
    if status != "passed" and protocol_name in {"p2", "p3"}:
        failures = verification.get("failures")
        if isinstance(failures, list) and "radius_mismatch" in failures:
            observation = _radius_observation(result)
            remaining = [item for item in failures if item != "radius_mismatch"]
            if (
                not remaining
                and observation.get("error_nm") is not None
                and observation.get("tolerance_nm") is not None
                and float(observation["error_nm"]) <= float(observation["tolerance_nm"]) + 1.0e-9
            ):
                status = "passed"
    if status != "passed":
        failures = verification.get("failures")
        if isinstance(failures, list) and any("gpu" in str(item) or "runtime" in str(item) for item in failures):
            return "execution_not_verified"
        return "failed"
    observation = _radius_observation(result)
    if (
        observation.get("error_nm") is not None
        and observation.get("tolerance_nm") is not None
        and float(observation["error_nm"]) > float(observation["tolerance_nm"]) + 1.0e-9
    ):
        return "radius_mismatch"
    if protocol_name in {"p2", "p3"} and (
        _number(observation.get("area_error_nm")) is not None
        and observation.get("tolerance_nm") is not None
        and float(observation["area_error_nm"]) > float(observation["tolerance_nm"]) + 1.0e-9
    ):
        pin_bias = True
    else:
        pin_bias = False
    held = _measurement(result, _profile_state(result))
    charge = _number(held.get("topological_charge"))
    if charge is None or abs(charge) < 0.8:
        return "topology_changed"
    frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
    if not frozen.get("frozen_mask_sha256") or not frozen.get("frozen_reference_sha256"):
        return "execution_not_verified"
    if pin_bias:
        return "pin_bias"
    return "accepted"


def _radius_observation(result: dict[str, Any]) -> dict[str, Any]:
    """Return the protocol coordinate and both radius diagnostics."""

    protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
    measurement = _measurement(result, _profile_state(result))
    protocol_name = str(protocol.get("protocol", ""))
    target = _number(protocol.get("target_radius_nm"))
    area = _number(measurement.get("R_area_nm"))
    core = _number(measurement.get("R_core_nm"))
    cell = _number(protocol.get("cell_nm")) or 0.5
    coordinate_name = "R_core" if protocol_name in {"p2", "p3"} else "R_area"
    coordinate = core if coordinate_name == "R_core" else area
    if coordinate is None and coordinate_name == "R_core":
        coordinate = area
    tolerance = max(0.5 * cell, 0.02 * target) if target is not None else None
    return {
        "protocol": protocol_name,
        "target_nm": target,
        "coordinate_name": coordinate_name,
        "coordinate_nm": coordinate,
        "area_nm": area,
        "core_nm": core,
        "area_error_nm": abs(area - target) if area is not None and target is not None else None,
        "core_error_nm": abs(core - target) if core is not None and target is not None else None,
        "error_nm": abs(coordinate - target) if coordinate is not None and target is not None else None,
        "tolerance_nm": tolerance,
        "area_uncertainty_nm": _number(measurement.get("R_area_uncertainty_nm")),
        "core_uncertainty_nm": _number(measurement.get("R_core_uncertainty_nm")),
    }


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _fmt(value: Any, digits: int = 6) -> str:
    number = _number(value)
    if number is None:
        return "—"
    return f"{number:.{digits}g}"


def _fmt_energy(value: Any) -> str:
    number = _number(value)
    return "—" if number is None else f"{number:.6e}"


def _free_torque_t(frozen: dict[str, Any]) -> float | None:
    value = _number(frozen.get("free_torque_metric"))
    if value is None:
        return None
    if frozen.get("free_torque_metric_units") != "T":
        value *= MU0_T_M_PER_A
    return value


def _plot_rows(summary: dict[str, Any]) -> list[dict[str, Any]]:
    """Collect finite profile observations for static scientific figures."""

    rows: list[dict[str, Any]] = []
    for result in summary.get("results", []):
        if not isinstance(result, dict):
            continue
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
        measurement = _measurement(result, _profile_state(result))
        verification = _verification(result)
        classification = _classification(result, verification)
        radius = _radius_observation(result)
        target = radius["target_nm"]
        measured = radius["area_nm"]
        controlled = radius["coordinate_nm"]
        energy = _number(profile.get("E_total_J"))
        delta = _number(profile.get("delta_E_to_background_J"))
        if energy is None:
            continue
        if measured is None:
            measured = target
        if controlled is None:
            controlled = measured
        if measured is None:
            continue
        rows.append(
            {
                "protocol": str(protocol.get("protocol", "unknown")),
                "cell_nm": _number(protocol.get("cell_nm")),
                "target_nm": target,
                "measured_nm": measured,
                "controlled_nm": controlled,
                "controlled_uncertainty_nm": (
                    radius["core_uncertainty_nm"]
                    if radius["coordinate_name"] == "R_core"
                    else radius["area_uncertainty_nm"]
                ),
                "coordinate_name": radius["coordinate_name"],
                "area_nm": radius["area_nm"],
                "core_nm": radius["core_nm"],
                "area_error_nm": radius["area_error_nm"],
                "core_error_nm": radius["core_error_nm"],
                "measured_uncertainty_nm": radius["area_uncertainty_nm"],
                "energy_J": energy,
                "delta_J": delta,
                "classification": classification,
            }
        )
    return rows


def _load_state_array(path: Path) -> Any | None:
    """Load one magnetization checkpoint through the public state reader."""

    try:
        import numpy as np

        source_root = Path(__file__).resolve().parents[5]
        package_root = source_root / "packages" / "fullmag-py" / "src"
        if str(package_root) not in sys.path and package_root.is_dir():
            sys.path.insert(0, str(package_root))
        import fullmag  # type: ignore

        loaded = fullmag.load_magnetization(path, format="auto", dataset="m", sample=-1)
        return np.asarray(loaded.values, dtype=float)
    except Exception:
        return None


def _map_candidates(summary: dict[str, Any]) -> list[dict[str, Any]]:
    """Choose at most three measured states spanning the available radii."""

    candidates: list[dict[str, Any]] = []
    for result in summary.get("results", []):
        if not isinstance(result, dict):
            continue
        state = _profile_state(result)
        states = result.get("states") if isinstance(result.get("states"), dict) else {}
        payload = states.get(state) if isinstance(states.get(state), dict) else {}
        path = payload.get("path")
        measurement = payload.get("measurement") if isinstance(payload, dict) else {}
        radius = _number(measurement.get("R_area_nm")) if isinstance(measurement, dict) else None
        if not path or radius is None:
            continue
        candidates.append({"result": result, "state": state, "path": Path(str(path)), "radius_nm": radius})
    candidates.sort(key=lambda item: item["radius_nm"])
    if len(candidates) <= 3:
        return candidates
    return [candidates[0], candidates[len(candidates) // 2], candidates[-1]]


def write_plots(summary: dict[str, Any], output_root: Path) -> dict[str, Any]:
    """Write report figures without fitting through failed or missing points.

    The primary energy figures show the measured area radius against the full
    profile energy.  Additional figures use the protocol-controlled radius:
    R_area for P-ring and R_core for P2/P3.  A separate excess-energy figure is
    emitted only when a converged background makes ``Delta E`` finite.  Marker
    fill carries the accepted/diagnostic distinction while color identifies
    the constraint protocol.
    """

    output_root = output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.lines import Line2D
    except ImportError as error:
        return {
            "status": "unavailable",
            "reason": f"matplotlib_unavailable: {error}",
            "files": [],
        }

    rows = _plot_rows(summary)
    protocols = sorted({row["protocol"] for row in rows})
    palette = {protocol: color for protocol, color in zip(protocols, plt.get_cmap("tab10").colors)}
    free_reference = _free_reference(summary)
    files: list[dict[str, str]] = []

    def _scatter(
        ax: Any,
        values: list[dict[str, Any]],
        y_key: str,
        *,
        y_label: str,
        title: str,
        x_key: str = "measured_nm",
        x_label: str = r"$R_{\mathrm{area}}$ (radius, nm)",
        xerr_key: str | None = None,
    ) -> None:
        for protocol in protocols:
            entries = [row for row in values if row["protocol"] == protocol]
            if not entries:
                continue
            color = palette[protocol]
            accepted = [row for row in entries if row["classification"] == "accepted"]
            diagnostic = [row for row in entries if row["classification"] != "accepted"]
            for subset, filled in ((accepted, True), (diagnostic, False)):
                if not subset:
                    continue
                ax.scatter(
                    [row[x_key] for row in subset],
                    [row[y_key] for row in subset],
                    s=42,
                    marker="o",
                    color=color,
                    facecolors=color if filled else "none",
                    edgecolors=color,
                    linewidths=1.2,
                    zorder=3,
                )
                if xerr_key is not None:
                    for row in subset:
                        uncertainty = _number(row.get(xerr_key))
                        if uncertainty is None or uncertainty <= 0.0:
                            continue
                        ax.errorbar(
                            row[x_key],
                            row[y_key],
                            xerr=uncertainty,
                            fmt="none",
                            ecolor=color,
                            elinewidth=0.9,
                            capsize=2.5,
                            alpha=0.65,
                            zorder=2,
                        )
        protocol_handles = [
            Line2D([0], [0], marker="o", linestyle="none", markersize=6,
                   markerfacecolor=palette[protocol], markeredgecolor=palette[protocol],
                   label=protocol)
            for protocol in protocols
        ]
        status_handles = [
            Line2D([0], [0], marker="o", linestyle="none", markersize=6,
                   markerfacecolor="black", markeredgecolor="black", label="accepted"),
            Line2D([0], [0], marker="o", linestyle="none", markersize=6,
                   markerfacecolor="none", markeredgecolor="black", label="diagnostic / failed"),
        ]
        if protocol_handles:
            legend_protocol = ax.legend(handles=protocol_handles, title="protocol", loc="best")
            ax.add_artist(legend_protocol)
        if protocols:
            ax.legend(handles=status_handles, title="classification", loc="lower right")
        ax.set_xlabel(x_label)
        ax.set_ylabel(y_label)
        ax.set_title(title)
        ax.grid(True, alpha=0.25, linewidth=0.7)
        ax.margins(x=0.08, y=0.12)

    fig, ax = plt.subplots(figsize=(7.2, 4.4), constrained_layout=True)
    _scatter(
        ax,
        rows,
        "energy_J",
        y_label=r"$E_{\mathrm{total}}$ (J)",
        title="Frozen-spin bimeron profile energy",
        xerr_key="measured_uncertainty_nm",
    )
    if free_reference is not None:
        ax.axvline(
            free_reference["R_area_nm"],
            linestyle=":",
            linewidth=0.9,
            color="0.25",
            zorder=1,
        )
        ax.scatter(
            [free_reference["R_area_nm"]],
            [free_reference["E_total_J"]],
            marker="*",
            s=120,
            color="black",
            zorder=5,
        )
        ax.annotate(
            "free control",
            (free_reference["R_area_nm"], free_reference["E_total_J"]),
            xytext=(6, 7),
            textcoords="offset points",
            fontsize=8,
        )
    if rows:
        minimum = min(rows, key=lambda row: row["energy_J"])
        ax.annotate(
            "lowest sampled",
            (minimum["measured_nm"], minimum["energy_J"]),
            xytext=(18, 22),
            textcoords="offset points",
            fontsize=8,
            color="0.2",
            arrowprops={"arrowstyle": "->", "color": "0.35", "linewidth": 0.8},
        )
        cell_values = [row["cell_nm"] for row in rows if row.get("cell_nm") is not None]
        if cell_values:
            ax.text(
                0.02,
                0.03,
                f"measured $R_{{\\mathrm{{area}}}}$; in-plane cell = {cell_values[0]:g} nm",
                transform=ax.transAxes,
                fontsize=8,
                color="0.25",
                ha="left",
                va="bottom",
            )
        diameter_axis = ax.secondary_xaxis(
            "top",
            functions=(lambda radius: 2.0 * radius, lambda diameter: 0.5 * diameter),
        )
        diameter_axis.set_xlabel(r"$2R_{\mathrm{area}}$ (diameter, nm)")
        diameter_axis.tick_params(axis="x", which="both", labelsize=9)
    if not rows:
        ax.text(0.5, 0.5, "No finite profile observations", transform=ax.transAxes,
                ha="center", va="center")
    total_path = output_root / "profile_energy_total.png"
    fig.savefig(total_path, dpi=180)
    plt.close(fig)
    files.append({"kind": "energy_total", "path": total_path.name})

    delta_rows = [row for row in rows if row["delta_J"] is not None]
    if delta_rows:
        fig, ax = plt.subplots(figsize=(7.2, 4.4), constrained_layout=True)
        _scatter(
            ax,
            delta_rows,
            "delta_J",
            y_label=r"$\Delta E$ (J)",
            title="Frozen-spin bimeron excess energy",
            xerr_key="measured_uncertainty_nm",
        )
        if free_reference is not None and free_reference["delta_E_to_background_J"] is not None:
            ax.scatter(
                [free_reference["R_area_nm"]],
                [free_reference["delta_E_to_background_J"]],
                marker="*",
                s=120,
                color="black",
                zorder=5,
            )
            ax.annotate(
                "free control",
                (free_reference["R_area_nm"], free_reference["delta_E_to_background_J"]),
                xytext=(6, 7),
                textcoords="offset points",
                fontsize=8,
            )
        delta_path = output_root / "profile_delta_energy.png"
        fig.savefig(delta_path, dpi=180)
        plt.close(fig)
        files.append({"kind": "energy_excess", "path": delta_path.name})

    controlled_rows = [row for row in rows if row["controlled_nm"] is not None]
    if controlled_rows:
        fig, ax = plt.subplots(figsize=(7.2, 4.4), constrained_layout=True)
        _scatter(
            ax,
            controlled_rows,
            "energy_J",
            x_key="controlled_nm",
            x_label=r"$R_{\mathrm{protocol}}$ (radius, nm)",
            y_label=r"$E_{\mathrm{total}}$ (J)",
            title="Frozen-spin energy by protocol-controlled radius",
        )
        controlled_path = output_root / "profile_energy_controlled.png"
        fig.savefig(controlled_path, dpi=180)
        plt.close(fig)
        files.append({"kind": "energy_controlled", "path": controlled_path.name})

    controlled_delta_rows = [row for row in controlled_rows if row["delta_J"] is not None]
    if controlled_delta_rows:
        fig, ax = plt.subplots(figsize=(7.2, 4.4), constrained_layout=True)
        _scatter(
            ax,
            controlled_delta_rows,
            "delta_J",
            x_key="controlled_nm",
            x_label=r"$R_{\mathrm{protocol}}$ (radius, nm)",
            y_label=r"$\Delta E$ (J)",
            title="Frozen-spin excess energy by controlled radius",
        )
        controlled_delta_path = output_root / "profile_delta_energy_controlled.png"
        fig.savefig(controlled_delta_path, dpi=180)
        plt.close(fig)
        files.append({"kind": "energy_excess_controlled", "path": controlled_delta_path.name})

    radius_rows = [row for row in rows if row["target_nm"] is not None]
    if radius_rows:
        fig, ax = plt.subplots(figsize=(6.4, 4.8), constrained_layout=True)
        for protocol in protocols:
            entries = [row for row in radius_rows if row["protocol"] == protocol]
            if not entries:
                continue
            color = palette[protocol]
            for row in entries:
                accepted = row["classification"] == "accepted"
                ax.errorbar(
                    row["target_nm"],
                    row["measured_nm"],
                    yerr=row["measured_uncertainty_nm"],
                    fmt="o",
                    color=color,
                    markerfacecolor=color if accepted else "none",
                    markeredgecolor=color,
                    markersize=6,
                    capsize=3,
                    linewidth=1.0,
                )
        low = min(min(row["target_nm"], row["measured_nm"]) for row in radius_rows)
        high = max(max(row["target_nm"], row["measured_nm"]) for row in radius_rows)
        span = max(high - low, 1.0)
        ax.plot([low - 0.05 * span, high + 0.05 * span],
                [low - 0.05 * span, high + 0.05 * span],
                linestyle="--", color="0.45", linewidth=0.9, label="ideal R_measured = R_target")
        ax.set_xlabel(r"$R_{\mathrm{target}}$ (nm)")
        ax.set_ylabel(r"$R_{\mathrm{area}}$ measured (nm)")
        ax.set_title("Frozen-spin radius retention")
        ax.grid(True, alpha=0.25, linewidth=0.7)
        ax.legend(loc="best")
        ax.set_xlim(low - 0.08 * span, high + 0.08 * span)
        ax.set_ylim(low - 0.08 * span, high + 0.08 * span)
        radius_path = output_root / "profile_radius_retention.png"
        fig.savefig(radius_path, dpi=180)
        plt.close(fig)
        files.append({"kind": "radius_retention", "path": radius_path.name})

        fig, ax = plt.subplots(figsize=(6.4, 4.8), constrained_layout=True)
        for protocol in protocols:
            entries = [row for row in radius_rows if row["protocol"] == protocol]
            if not entries:
                continue
            color = palette[protocol]
            for row in entries:
                accepted = row["classification"] == "accepted"
                ax.errorbar(
                    row["target_nm"],
                    row["controlled_nm"],
                    yerr=row["controlled_uncertainty_nm"],
                    fmt="o",
                    color=color,
                    markerfacecolor=color if accepted else "none",
                    markeredgecolor=color,
                    markersize=6,
                    capsize=3,
                    linewidth=1.0,
                )
        low = min(min(row["target_nm"], row["controlled_nm"]) for row in radius_rows)
        high = max(max(row["target_nm"], row["controlled_nm"]) for row in radius_rows)
        span = max(high - low, 1.0)
        ax.plot([low - 0.05 * span, high + 0.05 * span],
                [low - 0.05 * span, high + 0.05 * span],
                linestyle="--", color="0.45", linewidth=0.9, label="ideal R_measured = R_target")
        ax.set_xlabel(r"$R_{\mathrm{target}}$ (nm)")
        ax.set_ylabel(r"$R_{\mathrm{protocol}}$ measured (nm)")
        ax.set_title("Protocol-controlled radius retention")
        ax.grid(True, alpha=0.25, linewidth=0.7)
        ax.legend(loc="best")
        ax.set_xlim(low - 0.08 * span, high + 0.08 * span)
        ax.set_ylim(low - 0.08 * span, high + 0.08 * span)
        controlled_radius_path = output_root / "profile_radius_controlled.png"
        fig.savefig(controlled_radius_path, dpi=180)
        plt.close(fig)
        files.append({"kind": "radius_controlled", "path": controlled_radius_path.name})

    # State maps are deliberately separate per case: a montage would hide
    # missing states and make a frozen mask from one R look like another.
    for candidate in _map_candidates(summary):
        result = candidate["result"]
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        measurement = _measurement(result, candidate["state"])
        grid = measurement.get("measurement_grid") if isinstance(measurement.get("measurement_grid"), dict) else {}
        try:
            nx = int(grid["nx"])
            ny = int(grid["ny"])
            nz = int(grid.get("nz", 1))
            cell_x = float(grid.get("cell_nm", [0.5, 0.5, 0.5])[0])
            cell_y = float(grid.get("cell_nm", [0.5, 0.5, 0.5])[1])
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        if min(nx, ny, nz) <= 0:
            continue
        values = _load_state_array(candidate["path"])
        if values is None or values.ndim != 2 or values.shape[1] != 3 or values.shape[0] != nx * ny * nz:
            continue
        try:
            import numpy as np

            layer = values.reshape((nz, ny, nx, 3))[nz // 2]
            mx = layer[:, :, 0]
            mz = layer[:, :, 2]
            x_edges = (np.arange(nx + 1) - nx / 2.0) * cell_x
            y_edges = (np.arange(ny + 1) - ny / 2.0) * cell_y
            x_centres = (x_edges[:-1] + x_edges[1:]) * 0.5
            y_centres = (y_edges[:-1] + y_edges[1:]) * 0.5
        except (ImportError, ValueError):
            continue
        frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
        frozen_indices = frozen.get("frozen_cell_indices") if isinstance(frozen.get("frozen_cell_indices"), list) else []
        frozen_points: list[tuple[float, float]] = []
        for index in frozen_indices:
            try:
                flat = int(index)
                if 0 <= flat < nx * ny * nz:
                    flat_2d = flat % (nx * ny)
                    frozen_points.append((float(x_centres[flat_2d % nx]), float(y_centres[flat_2d // nx])))
            except (TypeError, ValueError, IndexError):
                continue
        extent_nm = max(_number(protocol.get("target_radius_nm")) or candidate["radius_nm"], candidate["radius_nm"]) + 8.0
        extent_nm = min(extent_nm, float(nx * cell_x) / 2.0)
        fig, axes = plt.subplots(1, 2, figsize=(10.0, 4.0), constrained_layout=True, sharex=True, sharey=True)
        for axis, component, label, cmap in (
            (axes[0], mx, "$m_x$", "coolwarm"),
            (axes[1], mz, "$m_z$", "PuOr"),
        ):
            image = axis.pcolormesh(x_edges, y_edges, component, shading="auto", cmap=cmap, vmin=-1.0, vmax=1.0)
            axis.contour(x_centres, y_centres, mx, levels=[0.0], colors="black", linewidths=0.9)
            if frozen_points:
                axis.scatter(
                    [point[0] for point in frozen_points],
                    [point[1] for point in frozen_points],
                    marker="s",
                    s=18,
                    facecolors="none",
                    edgecolors="black",
                    linewidths=0.8,
                    label="frozen cells",
                )
            axis.set_xlim(-extent_nm, extent_nm)
            axis.set_ylim(float(y_edges[0]), float(y_edges[-1]))
            axis.set_xlabel("x (nm)")
            axis.set_title(label)
            axis.grid(True, alpha=0.15, linewidth=0.5)
            fig.colorbar(image, ax=axis, fraction=0.046, pad=0.04)
        axes[0].set_ylabel("y (nm)")
        if frozen_points:
            axes[1].legend(loc="upper right", fontsize=8)
        case_id = str(protocol.get("case_id", f"R{candidate['radius_nm']:g}nm"))
        map_path = output_root / f"profile_map_{case_id}.png"
        fig.suptitle(f"Frozen-spin state: {case_id} ({candidate['state']})")
        fig.savefig(map_path, dpi=180)
        plt.close(fig)
        files.append({"kind": "magnetization_map", "path": map_path.name, "case_id": case_id})

    return {
        "status": "written",
        "observation_count": len(rows),
        "files": files,
        "interpolation": "none",
    }


def render_report(summary: dict[str, Any]) -> str:
    results = [value for value in summary.get("results", []) if isinstance(value, dict)]
    rows: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    for result in results:
        verification = _verification(result)
        rows.append((result, verification, _classification(result, verification)))
    rows.sort(key=lambda item: _number((item[0].get("protocol") or {}).get("target_radius_nm")) or float("inf"))

    background = summary.get("background") if isinstance(summary.get("background"), dict) else {}
    free_reference = _free_reference(summary)
    lines = [
        "# Frozen-spin bimeron size profile",
        "",
        "This report is generated from `profile_summary.json`. The profile energy is paired with the state from its constrained stage; `energy` in each case is the terminal value after release when release is enabled.",
        "",
        f"- Sweep schema: `{summary.get('schema_version', 'unknown')}`",
        f"- Cases: {len(rows)}",
        f"- Background: `{(summary.get('background') or {}).get('analysis', 'not recorded')}`",
        f"- Source: `{(summary.get('source') or {}).get('git_head', 'unknown')}`; branch `{(summary.get('source') or {}).get('branch_id', 'unknown')}`",
        "- Physical lane: FDM, requested GPU, FP64, strict mode; inspect each runtime receipt before interpreting a point.",
        "- The reported free torque is sampled from the last constrained stage; release torque is retained separately in the case analysis.",
        "",
    ]
    if background.get("status") != "usable":
        lines.append(
            "- Background reference is unavailable for subtraction: "
            f"`{background.get('reason', 'not_provided')}`. ΔE values are omitted until the +x run converges."
        )
    plots = summary.get("plots") if isinstance(summary.get("plots"), dict) else {}
    plot_files = plots.get("files") if isinstance(plots.get("files"), list) else []
    if plot_files:
        lines.extend(["", "## Plots", ""])
        for plot in plot_files:
            if not isinstance(plot, dict) or not plot.get("path"):
                continue
            kind = str(plot.get("kind", "plot"))
            label = {
                "energy_total": "Profile energy E_total versus measured R_area",
                "energy_excess": "Excess energy Delta E versus measured R_area",
                "energy_controlled": "Profile energy E_total versus protocol-controlled radius",
                "energy_excess_controlled": "Excess energy Delta E versus protocol-controlled radius",
                "radius_retention": "Target versus measured R_area",
                "radius_controlled": "Target versus protocol-controlled radius",
                "magnetization_map": "Magnetization map with frozen cells and mx=0 contour",
            }.get(kind, kind)
            lines.append(f"![{label}]({plot['path']})")
            lines.append("")
        lines.append(
            "Markers are filled only for accepted points; open markers are diagnostic or failed. "
            "No line is fitted through missing or non-converged points."
        )
    elif plots.get("status") == "unavailable":
        lines.extend(["", f"- Plot generation unavailable: `{plots.get('reason', 'unknown')}`."])
    if free_reference is not None:
        lines.extend(
            [
                "",
                "## Free-relaxation control",
                "",
                "The free bimeron is a one-time control for the material and is shown as a reference marker; it is not a repeated profile point for every target R.",
                "",
                "| R area (nm) | R core (nm) | Q | E total (J) | ΔE to background (J) | status |",
                "|---:|---:|---:|---:|---:|---|",
                "| {area} | {core} | {charge} | {energy} | {delta} | {status} |".format(
                    area=_fmt(free_reference.get("R_area_nm")),
                    core=_fmt(free_reference.get("R_core_nm")),
                    charge=_fmt(free_reference.get("Q")),
                    energy=_fmt_energy(free_reference.get("E_total_J")),
                    delta=_fmt_energy(free_reference.get("delta_E_to_background_J")),
                    status=free_reference.get("status", "unknown"),
                ),
                f"Source: `{free_reference.get('path', 'not recorded')}`",
            ]
        )
    lines.extend(
        [
            "",
            "## Size-to-energy table",
            "",
            "| R target (nm) | coordinate | R coordinate profile (nm) | R area profile (nm) | R area hold (nm) | R core hold/release (nm) | Q profile | E profile (J) | ΔE to background (J) | frozen DOF | max free torque (T) | verification | classification |",
            "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
        ]
    )
    for result, verification, classification in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
        profile_state = _profile_state(result)
        profile_measurement = _measurement(result, profile_state)
        held = _measurement(result, "constrained_held")
        released = _measurement(result, "released")
        radius = _radius_observation(result)
        frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
        core_release = _number(released.get("R_core_nm"))
        if core_release is None:
            core_release = _number(held.get("R_core_nm"))
        lines.append(
            "| {target} | {coordinate} | {coordinate_value} | {profile_area} | {hold_area} | {core} | {q} | {energy} | {delta} | {frozen_count} | {free_torque} | {status} | {classification} |".format(
                target=_fmt(protocol.get("target_radius_nm")),
                coordinate=radius["coordinate_name"],
                coordinate_value=_fmt(radius["coordinate_nm"]),
                profile_area=_fmt(profile_measurement.get("R_area_nm")),
                hold_area=_fmt(held.get("R_area_nm")),
                core=_fmt(core_release),
                q=_fmt(profile_measurement.get("topological_charge")),
                energy=_fmt_energy(profile.get("E_total_J")),
                delta=_fmt_energy(profile.get("delta_E_to_background_J")),
                frozen_count=frozen.get("frozen_dof_count", "—"),
                free_torque=_fmt(_free_torque_t(frozen)),
                status=verification.get("status", "not_run"),
                classification=classification,
            )
        )

    lines.extend(
        [
            "",
            "## Energy components",
            "",
            "| R target (nm) | E exchange (J) | E rotated DMI (J) | E anisotropy (J) | E demag (J) | E total (J) |",
            "|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for result, _verification_value, _classification_value in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
        lines.append(
            "| {target} | {exchange} | {dmi} | {ani} | {demag} | {total} |".format(
                target=_fmt(protocol.get("target_radius_nm")),
                exchange=_fmt_energy(profile.get("E_ex_J")),
                dmi=_fmt_energy(profile.get("E_rotated_dmi_J")),
                ani=_fmt_energy(profile.get("E_ani_J")),
                demag=_fmt_energy(profile.get("E_demag_J")),
                total=_fmt_energy(profile.get("E_total_J")),
            )
        )

    lines.extend(["", "## Frozen-mask identity", "", "| R target (nm) | protocol | frozen cells | active cells | free DOF | mask SHA-256 | reference SHA-256 | selector SHA-256 |", "|---:|---|---:|---:|---:|---|---|---|"])
    for result, _verification_value, _classification_value in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
        lines.append(
            "| {target} | {protocol} | {frozen_count} | {active_count} | {free_count} | `{mask}` | `{reference}` | `{selector}` |".format(
                target=_fmt(protocol.get("target_radius_nm")),
                protocol=protocol.get("protocol", "—"),
                frozen_count=frozen.get("frozen_cell_count", frozen.get("frozen_dof_count", "—")),
                active_count=frozen.get("frozen_mask_domain_cell_count", frozen.get("active_dof_count", "—")),
                free_count=frozen.get("free_dof_count", "—"),
                mask=frozen.get("frozen_mask_sha256", "not emitted"),
                reference=frozen.get("frozen_reference_sha256", "not emitted"),
                selector=frozen.get("frozen_selector_sha256", "not emitted"),
            )
        )

    spread_rows = summary.get("diagnostics", {}).get("protocol_energy_spread", []) if isinstance(summary.get("diagnostics"), dict) else []
    if isinstance(spread_rows, list) and spread_rows:
        lines.extend(
            [
                "",
                "## Protocol energy spread (diagnostic)",
                "",
                "P2, P3, and P-ring impose different constraints. Their energy spread is reported as protocol bias and is not used as a rejection tolerance.",
                "",
                "| R target (nm) | protocols | spread (J) | spread / |E| | spread / |ΔE| |",
                "|---:|---|---:|---:|---:|",
            ]
        )
        for spread in spread_rows:
            protocols = ", ".join(str(value) for value in spread.get("protocols", []))
            lines.append(
                "| {target} | {protocols} | {spread} | {relative_total} | {relative_excess} |".format(
                    target=_fmt(spread.get("target_radius_nm")),
                    protocols=protocols or "—",
                    spread=_fmt_energy(spread.get("spread_J")),
                    relative_total=_fmt(spread.get("spread_relative_to_total")),
                    relative_excess=_fmt(spread.get("spread_relative_to_excess")),
                )
            )

    lines.extend(
        [
            "",
            "## Measurement uncertainty and final-window diagnostics",
            "",
            "| R target (nm) | coordinate | coordinate error (nm) | coordinate tolerance (nm) | R area uncertainty (nm) | R core uncertainty (nm) | energy-window / E_total | energy-window / delta_E | energy-balance relative residual |",
            "|---:|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for result, verification, _classification_value in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile_measurement = _measurement(result, _profile_state(result))
        radius = _radius_observation(result)
        lines.append(
            "| {target} | {coordinate} | {radius_error} | {radius_tolerance} | {area_uncertainty} | {core_uncertainty} | {window} | {window_excess} | {balance} |".format(
                target=_fmt(protocol.get("target_radius_nm")),
                coordinate=radius["coordinate_name"],
                radius_error=_fmt(radius["error_nm"]),
                radius_tolerance=_fmt(radius["tolerance_nm"]),
                area_uncertainty=_fmt(profile_measurement.get("R_area_uncertainty_nm")),
                core_uncertainty=_fmt(profile_measurement.get("R_core_uncertainty_nm")),
                window=_fmt(verification.get("energy_window_relative_span")),
                window_excess=_fmt(verification.get("energy_window_relative_to_excess")),
                balance=_fmt(verification.get("energy_balance_relative")),
            )
        )

    pin_bias_rows = [
        (result, verification)
        for result, verification, classification in rows
        if classification == "pin_bias"
    ]
    if pin_bias_rows:
        lines.extend(
            [
                "",
                "## Pin-bias diagnostics",
                "",
                "For P2/P3 the core coordinate satisfies the requested radius while the area radius records the finite frozen-pin footprint. These points remain usable for the conditional profile and are marked as `pin_bias` until the pin geometry is refined.",
                "",
                "| R target (nm) | protocol | R core (nm) | R area (nm) | area error (nm) | E profile (J) |",
                "|---:|---|---:|---:|---:|---:|",
            ]
        )
        for result, verification in pin_bias_rows:
            protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
            radius = _radius_observation(result)
            profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
            lines.append(
                "| {target} | {protocol} | {core} | {area} | {area_error} | {energy} |".format(
                    target=_fmt(radius["target_nm"]),
                    protocol=protocol.get("protocol", "—"),
                    core=_fmt(radius["core_nm"]),
                    area=_fmt(radius["area_nm"]),
                    area_error=_fmt(radius["area_error_nm"]),
                    energy=_fmt_energy(profile.get("E_total_J")),
                )
            )

    lines.extend(["", "## Interpretation and gaps", ""])
    classifications = {classification for _result, _verification_value, classification in rows}
    if "accepted" in classifications:
        lines.append("Accepted points are listed individually; no smooth curve is fitted across other classifications.")
    else:
        lines.append("No point is classified as an accepted minimum curve point. The current pilot is diagnostic until the solver reaches its convergence criterion.")
    lines.append("The constrained profile is conditional on the protocol, pin size, seed wall width, grid, PBC, demagnetization realization, and captured reference; it is not a global minimum or a free energy at finite temperature.")
    lines.append("For P2/P3, the accepted radius coordinate is R_core; deviations in R_area are retained as pin-bias diagnostics. P-ring uses R_area as its coordinate.")
    for result, verification, _classification_value in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        warnings = verification.get("warnings")
        if isinstance(warnings, list) and warnings:
            lines.append(f"- `{protocol.get('case_id', 'case')}`: " + "; ".join(str(value) for value in warnings))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summary", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--free-reference",
        type=Path,
        help="optional analysis.json from the one-time free bimeron control",
    )
    args = parser.parse_args()
    summary = _load(args.summary)
    if args.free_reference is not None:
        summary["free_reference"] = free_reference_from_analysis(args.free_reference)
    if args.output:
        summary["plots"] = write_plots(summary, args.output.parent)
    report = render_report(summary)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
