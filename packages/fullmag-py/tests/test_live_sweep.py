"""Parameter sweeps across several live groups (ADR 0068 F6, spec §8)."""
from __future__ import annotations

import socket

import pytest

from live_session_fake import FakeLiveSession

import fullmag as fm
from fullmag.live.sweep import SweepError


def _point(H: float) -> float:
    fm.engine("fdm")
    fm.cell(5e-9, 5e-9, 10e-9)
    layer = fm.geometry(fm.Box(100e-9, 50e-9, 10e-9), name="layer")
    layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.5
    layer.m = fm.texture.uniform(1, 0, 0)
    fm.b_ext(H, 0, 0)
    fm.relax(dt=1e-13, max_steps=100)
    return H * 2


def _free_port_url() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{probe.getsockname()[1]}"


def test_sweep_spreads_points_over_groups_in_order(monkeypatch) -> None:
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    with FakeLiveSession() as first, FakeLiveSession() as second:
        results = fm.sweep(_point, groups=[first.url, second.url], H=[0.01, 0.02, 0.03, 0.04])
        assert [result.value for result in results] == [0.02, 0.04, 0.06, 0.08]
        assert [result.point for result in results] == [{"H": h} for h in (0.01, 0.02, 0.03, 0.04)]
        relaxes = len(first.command_bodies("relax")) + len(second.command_bodies("relax"))
        assert relaxes == 4
        assert {result.group for result in results} <= {first.url, second.url}
        # Every point starts from a reset world: its first transaction replaces the scene.
        replaces = [
            t for fake in (first, second) for t in fake.transactions
            if t["kind"] == "replace_scene" and "magnetization_apply" not in t
        ]
        assert len(replaces) == 4


def test_sweep_reports_failed_points(monkeypatch) -> None:
    monkeypatch.delenv("FULLMAG_URL", raising=False)

    def flaky(H: float) -> float:
        if H > 0.015:
            raise ValueError("boom")
        return _point(H)

    with FakeLiveSession() as only:
        with pytest.raises(SweepError) as caught:
            fm.sweep(flaky, groups=[only.url], H=[0.01, 0.02])
        assert [result.ok for result in caught.value.results] == [True, False]
        results = fm.sweep(flaky, groups=[only.url], H=[0.01, 0.02], raise_on_error=False)
        assert isinstance(results[1].error, ValueError)


def test_sweep_survives_an_unreachable_group(monkeypatch) -> None:
    monkeypatch.delenv("FULLMAG_URL", raising=False)
    with FakeLiveSession() as good:
        results = fm.sweep(_point, groups=[_free_port_url(), good.url], H=[0.01, 0.02])
        assert all(result.group == good.url for result in results)


def test_sweep_validates_arguments() -> None:
    with pytest.raises(ValueError, match="equal length"):
        fm.sweep(_point, groups=["http://127.0.0.1:1"], H=[1, 2], T=[1])
    with pytest.raises(ValueError, match="distinct"):
        fm.sweep(_point, groups=["http://127.0.0.1:1", "http://127.0.0.1:1"], H=[1])
