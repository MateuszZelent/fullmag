"""Canonical, allowlisted controls for the periodic-antidot fixture."""

from __future__ import annotations

import os
from dataclasses import dataclass

from .periodic_antidot_equilibrium_cache import (
    load_periodic_antidot_equilibrium_cache,
)


@dataclass(frozen=True)
class PeriodicAntidotFixtureConfig:
    run_stage: str = "combined"
    relaxed_state_path: str = ""
    domain_mesh_path: str = ""
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
    domain_mesh_path = ""
    equilibrium_cache_path = os.environ.get(
        "FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE", ""
    ).strip()
    if equilibrium_cache_path:
        if relaxed_state_path:
            raise ValueError(
                "FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE cannot be combined with "
                "FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE"
            )
        cache = load_periodic_antidot_equilibrium_cache(equilibrium_cache_path)
        relaxed_state_path = str(cache.magnetic_state_path)
        domain_mesh_path = str(cache.domain_mesh_path)
    if run_stage == "response" and not relaxed_state_path:
        raise ValueError(
            "FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE is required when "
            "FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=response"
        )
    return PeriodicAntidotFixtureConfig(
        run_stage=run_stage,
        relaxed_state_path=relaxed_state_path,
        domain_mesh_path=domain_mesh_path,
    )
