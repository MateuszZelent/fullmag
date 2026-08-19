from __future__ import annotations

from pathlib import Path

import pytest

from fullmag.runtime import periodic_antidot_fixture_config as fixture_config


class _FakeCache:
    magnetic_state_path = Path("/cache/magnetic_m.json")
    domain_mesh_path = Path("/cache/domain_mesh.json")


def test_cache_configuration_exposes_magnetic_state_and_frozen_domain_mesh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE", "/cache/equilibrium"
    )
    monkeypatch.setenv("FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE", "response")
    monkeypatch.setattr(
        fixture_config,
        "load_periodic_antidot_equilibrium_cache",
        lambda _: _FakeCache(),
    )

    config = fixture_config.load_periodic_antidot_fixture_config()

    assert config.run_stage == "response"
    assert config.relaxed_state_path == "/cache/magnetic_m.json"
    assert config.domain_mesh_path == "/cache/domain_mesh.json"


def test_cache_and_direct_magnetic_override_are_mutually_exclusive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "FULLMAG_PERIODIC_ANTIDOT_EQUILIBRIUM_CACHE", "/cache/equilibrium"
    )
    monkeypatch.setenv(
        "FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE", "/tmp/magnetic.json"
    )

    with pytest.raises(ValueError, match="cannot be combined"):
        fixture_config.load_periodic_antidot_fixture_config()
