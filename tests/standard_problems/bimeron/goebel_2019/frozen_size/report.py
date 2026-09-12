"""Render a Markdown report from a frozen-spin size-sweep summary.

The report keeps measured, diagnostic, and accepted points separate.  It
never interpolates across a failed or non-converged case and always labels the
profile energy as the constrained-hold measurement.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

MU0_T_M_PER_A = 4.0 * math.pi * 1.0e-7


def _load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _measurement(result: dict[str, Any], state: str) -> dict[str, Any]:
    states = result.get("states")
    if not isinstance(states, dict):
        return {}
    payload = states.get(state)
    if not isinstance(payload, dict):
        return {}
    value = payload.get("measurement")
    return value if isinstance(value, dict) else {}


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
    if status != "passed":
        failures = verification.get("failures")
        if isinstance(failures, list) and any("gpu" in str(item) or "runtime" in str(item) for item in failures):
            return "execution_not_verified"
        return "failed"
    protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
    held = _measurement(result, "constrained_held")
    target = _number(protocol.get("target_radius_nm"))
    measured = _number(held.get("R_area_nm"))
    cell = _number(protocol.get("cell_nm")) or 0.5
    if target is not None and measured is not None:
        tolerance = max(0.5 * cell, 0.02 * target)
        if abs(measured - target) > tolerance:
            return "radius_mismatch"
    charge = _number(held.get("topological_charge"))
    if charge is None or abs(charge) < 0.8:
        return "topology_changed"
    frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
    if not frozen.get("frozen_mask_sha256") or not frozen.get("frozen_reference_sha256"):
        return "execution_not_verified"
    return "accepted"


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


def render_report(summary: dict[str, Any]) -> str:
    results = [value for value in summary.get("results", []) if isinstance(value, dict)]
    rows: list[tuple[dict[str, Any], dict[str, Any], str]] = []
    for result in results:
        verification = _verification(result)
        rows.append((result, verification, _classification(result, verification)))
    rows.sort(key=lambda item: _number((item[0].get("protocol") or {}).get("target_radius_nm")) or float("inf"))

    lines = [
        "# Frozen-spin bimeron size profile",
        "",
        "This report is generated from `profile_summary.json`. The profile energy is the last measured energy of `constrained_hold`; `energy` in each case is the terminal value after release when release is enabled.",
        "",
        f"- Sweep schema: `{summary.get('schema_version', 'unknown')}`",
        f"- Cases: {len(rows)}",
        f"- Background: `{(summary.get('background') or {}).get('analysis', 'not recorded')}`",
        "- Physical lane: FDM, requested GPU, FP64, strict mode; inspect each runtime receipt before interpreting a point.",
        "",
        "## Size-to-energy table",
        "",
        "| R target (nm) | R area hold (nm) | R core release (nm) | Q hold | E profile (J) | ΔE to background (J) | frozen DOF | max free torque (T) | verification | classification |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for result, verification, classification in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        profile = result.get("profile_energy") if isinstance(result.get("profile_energy"), dict) else {}
        held = _measurement(result, "constrained_held")
        released = _measurement(result, "released")
        frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
        lines.append(
            "| {target} | {area} | {core} | {q} | {energy} | {delta} | {frozen_count} | {free_torque} | {status} | {classification} |".format(
                target=_fmt(protocol.get("target_radius_nm")),
                area=_fmt(held.get("R_area_nm")),
                core=_fmt(released.get("R_core_nm")),
                q=_fmt(held.get("topological_charge")),
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

    lines.extend(["", "## Frozen-mask identity", "", "| R target (nm) | protocol | frozen DOF | free DOF | mask SHA-256 | reference SHA-256 | selector SHA-256 |", "|---:|---|---:|---:|---|---|---|"])
    for result, _verification_value, _classification_value in rows:
        protocol = result.get("protocol") if isinstance(result.get("protocol"), dict) else {}
        frozen = result.get("frozen_runtime") if isinstance(result.get("frozen_runtime"), dict) else {}
        lines.append(
            "| {target} | {protocol} | {frozen_count} | {free_count} | `{mask}` | `{reference}` | `{selector}` |".format(
                target=_fmt(protocol.get("target_radius_nm")),
                protocol=protocol.get("protocol", "—"),
                frozen_count=frozen.get("frozen_dof_count", "—"),
                free_count=frozen.get("free_dof_count", "—"),
                mask=frozen.get("frozen_mask_sha256", "not emitted"),
                reference=frozen.get("frozen_reference_sha256", "not emitted"),
                selector=frozen.get("frozen_selector_sha256", "not emitted"),
            )
        )

    lines.extend(["", "## Interpretation and gaps", ""])
    classifications = {classification for _result, _verification_value, classification in rows}
    if "accepted" in classifications:
        lines.append("Accepted points are listed individually; no smooth curve is fitted across other classifications.")
    else:
        lines.append("No point is classified as an accepted minimum curve point. The current pilot is diagnostic until the solver reaches its convergence criterion.")
    lines.append("The constrained profile is conditional on the protocol, pin size, seed wall width, grid, PBC, demagnetization realization, and captured reference; it is not a global minimum or a free energy at finite temperature.")
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
    args = parser.parse_args()
    report = render_report(_load(args.summary))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
