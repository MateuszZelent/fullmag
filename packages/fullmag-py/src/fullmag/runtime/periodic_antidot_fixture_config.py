"""Canonical, allowlisted controls for the periodic-antidot fixture."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class PeriodicAntidotFixtureConfig:
    run_stage: str = "combined"
    relaxed_state_path: str = ""
    preconditioner: str = "block_jacobi"
    restart_iterations: int = 512


def load_periodic_antidot_fixture_config() -> PeriodicAntidotFixtureConfig:
    run_stage = os.environ.get("FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE", "combined").strip().lower()
    if run_stage not in {"combined", "relax", "response"}:
        raise ValueError(
            "FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE must be one of: combined, relax, response"
        )
    relaxed_state_path = os.environ.get(
        "FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE", ""
    ).strip()
    if run_stage == "response" and not relaxed_state_path:
        raise ValueError(
            "FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE is required when "
            "FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=response"
        )
    return PeriodicAntidotFixtureConfig(
        run_stage=run_stage,
        relaxed_state_path=relaxed_state_path,
    )
