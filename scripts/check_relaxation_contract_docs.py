#!/usr/bin/env python3
"""Reject stale relaxation claims in canonical public documentation."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


MARKDOWN_PATHS = (
    Path("docs/physics/0500-fdm-relaxation-algorithms.md"),
    Path("docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md"),
    Path("docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md"),
    Path("docs/architecture/backend-golden-masterplan.md"),
    Path("docs/specs/problem-ir-v0.md"),
    Path("docs/specs/problem-ir-compatibility-v1.md"),
    Path("docs/specs/capability-matrix-v0.md"),
    Path("docs/specs/resource-first-control-room-api-v2.md"),
)
CAPABILITY_JSON_PATH = Path("docs/specs/capability-matrix-v0.json")

TPI = r"(?:tangent-plane implicit|tangent_plane_implicit|\btpi\b)"


def _normalized(text: str) -> str:
    return " ".join(text.lower().replace("`", "").split())


def _line_errors(path: Path, text: str) -> list[str]:
    errors: list[str] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        normalized = _normalized(line)
        location = f"{path}:{line_number}"
        if re.search(r"(?:lambda|\\lambda).*(?:dimensionless|unitless|pseudo[- ]?time.*(?:seconds?|\bs\b))", normalized):
            errors.append(f"{location}: step-unit: direct-minimizer step must be m/A")
        if re.search(r"default[^\n]*(?:torque|epsilon_tau)[^\n]*(?:1e-6|10\^\{-?6\}|7\.9)", normalized):
            errors.append(f"{location}: default-torque: public default must be 1e-4 A/m")
        if re.search(r"max[_ ]?torque.*(?:reconstruct|estimate).*(?:dm/dt|rhs)", normalized):
            errors.append(f"{location}: torque-observable: exact field torque must not be reconstructed from RHS")
        if re.search(r"(?:projected.gradient|pg-bb|pgbb|nonlinear.cg|ncg|direct.minimizer).*(?:uses?|routes?|integrat).*(?:rk\d*|runge)", normalized):
            if not re.search(r"(?:does not|do not|no |without|reject|bypass)", normalized):
                errors.append(f"{location}: direct-rk: direct minimizers own no RK integrator")
    return errors


def _section_errors(path: Path, text: str) -> list[str]:
    errors: list[str] = []
    blocks = [_normalized(block) for block in re.split(r"\n\s*\n", text) if block.strip()]
    whole = _normalized(text)

    for index, block in enumerate(blocks, 1):
        if not re.search(TPI, block):
            continue
        if "production-executable relaxation set" in block or re.search(
            rf"{TPI}.{{0,160}}(?:(?:is|as) strict[- ]production|gpu[- ]executable|gpu executable)",
            block,
        ):
            errors.append(
                f"{path}:section-{index}: tpi-capability: TPI is CPU/MFEM development-only"
            )
        if re.search(r"automatic(?: runtime)? selection", block) and re.search(
            r"falls? back|fallback", block
        ) and "extended" not in block:
            errors.append(
                f"{path}:section-{index}: hidden-fallback: automatic TPI CPU resolution is legal only in extended mode"
            )

    assertions = {
        "canonical-defaults": r"(?:defaults?|default[^.]{0,100}|domyślne[^.]{0,100})(?=[^.]{0,180}1e-4)(?=[^.]{0,180}a/m)(?=[^.]{0,180}50000)",
        "step-unit": r"(?:direct minimizer|direct-minimizer|pg-bb|pgbb|ncg|line-search step).{0,240}m/a",
    }
    for contract, pattern in assertions.items():
        if not re.search(pattern, whole):
            errors.append(f"{path}: {contract}: missing explicit canonical section statement")
    torque_policy = any(
        all(token in block for token in ("max_torque_apm", "a/m", "max_torque_t", "max_rhs_norm_per_s", "1/s"))
        and (" in t" in block or "`t`" in block or " w t" in block)
        for block in blocks
    )
    if not torque_policy:
        errors.append(f"{path}: torque-observable: missing explicit canonical section statement")
    tpi_blocks = [block for block in blocks if re.search(TPI, block)]
    tpi_policy = any(
        "strict" in block
        and ("reject" in block or "odrzuc" in block)
        and "gpu" in block
        and "extended" in block
        and "cpu/mfem" in block
        and ("development" in block or "rozwoj" in block)
        for block in tpi_blocks
    )
    if not tpi_policy:
        errors.append(f"{path}: tpi-policy: missing explicit canonical section statement")
    return errors


def _capability_json_errors(path: Path, text: str) -> list[str]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        return [f"{path}: capability-json: invalid JSON: {error}"]
    features = {
        feature.get("id"): feature
        for feature in payload.get("features", [])
        if isinstance(feature, dict)
    }
    required = {
        "relaxation_llg_overdamped",
        "relaxation_projected_gradient_bb",
        "relaxation_nonlinear_cg",
        "relaxation_tangent_plane_implicit",
    }
    missing = sorted(required - features.keys())
    if missing:
        return [f"{path}: capability-json: missing features: {', '.join(missing)}"]

    errors: list[str] = []
    llg = _normalized(str(features["relaxation_llg_overdamped"].get("notes", "")))
    if not all(token in llg for token in ("1e-4 a/m", "50000", "max_torque_apm", "max_rhs_norm_per_s")):
        errors.append(f"{path}: capability-json: LLG defaults/observables are incomplete")
    for feature_id in ("relaxation_projected_gradient_bb", "relaxation_nonlinear_cg"):
        notes = _normalized(str(features[feature_id].get("notes", "")))
        if "m/a" not in notes or not re.search(r"(?:no|owns no).{0,40}rk", notes):
            errors.append(f"{path}: capability-json: {feature_id} must state m/A and no RK")
    tpi = features["relaxation_tangent_plane_implicit"]
    lanes = tpi.get("lanes", {})
    notes = _normalized(str(tpi.get("notes", "")))
    if lanes.get("fem_cpu_public") != "development_executable" or lanes.get("fem_gpu_public") != "unsupported":
        errors.append(f"{path}: capability-json: TPI lanes must be CPU development/GPU unsupported")
    if not all(token in notes for token in ("strict", "forced gpu", "reject", "extended", "cpu/mfem")):
        errors.append(f"{path}: capability-json: TPI strict/extended/GPU policy is incomplete")
    return errors


def check_relaxation_contract_docs(repo_root: Path) -> list[str]:
    errors: list[str] = []
    for relative in MARKDOWN_PATHS:
        path = repo_root / relative
        if not path.is_file():
            errors.append(f"{relative}: missing relaxation contract document")
            continue
        text = path.read_text(encoding="utf-8")
        errors.extend(_line_errors(relative, text))
        errors.extend(_section_errors(relative, text))

    capability_path = repo_root / CAPABILITY_JSON_PATH
    if not capability_path.is_file():
        errors.append(f"{CAPABILITY_JSON_PATH}: missing relaxation capability JSON")
    else:
        errors.extend(
            _capability_json_errors(
                CAPABILITY_JSON_PATH,
                capability_path.read_text(encoding="utf-8"),
            )
        )
    return errors


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    errors = check_relaxation_contract_docs(repo_root)
    if errors:
        print("Relaxation documentation contract violations:")
        for error in errors:
            print(f"- {error}")
        return 1
    print("Relaxation documentation contract is canonical.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
