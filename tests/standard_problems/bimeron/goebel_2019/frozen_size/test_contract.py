from __future__ import annotations

import json
from pathlib import Path

import fullmag as fm
import pytest

from tests.standard_problems.bimeron.goebel_2019.frozen_size.common import (
    contour_minimum_radius_m,
    contour_radius_from_preset,
    preset_radius_for_contour,
)


SCRIPT = Path(__file__).with_name("scenario_fdm.py")


def _load(monkeypatch: pytest.MonkeyPatch, *, protocol: str, target_nm: str = "5"):
    monkeypatch.setenv("FULLMAG_BIMERON_PROTOCOL", protocol)
    monkeypatch.setenv("FULLMAG_BIMERON_TARGET_R_NM", target_nm)
    monkeypatch.setenv("FULLMAG_BIMERON_RELEASE", "0")
    return fm.load_problem_from_script(SCRIPT, lightweight_assets=True)


def test_contour_inverse_matches_source_profile() -> None:
    for target_nm in (2.75, 3.0, 5.0, 10.0):
        target = target_nm * 1e-9
        preset = preset_radius_for_contour(target, 3e-9)
        assert contour_radius_from_preset(preset, 3e-9) == pytest.approx(target, rel=1e-12)
    with pytest.raises(ValueError, match="contour minimum"):
        preset_radius_for_contour(contour_minimum_radius_m(3e-9) * 0.99, 3e-9)


@pytest.mark.parametrize("protocol", ["p0", "p2", "p3", "ring"])
def test_scenario_preserves_goebel_parameters_and_declares_protocol(monkeypatch: pytest.MonkeyPatch, protocol: str) -> None:
    loaded = _load(monkeypatch, protocol=protocol)
    assert [stage.stage_id for stage in loaded.stages] == [
        "save_state-1",
        "constrained_relax",
        "save_state-2",
        "constrained_hold",
        "save_state-3",
    ]
    assert loaded.problem.runtime_metadata["bimeron_frozen_size"]["same_rDMI_parameters"] is True
    assert loaded.problem.runtime_metadata["bimeron_frozen_size"]["protocol"]["protocol"] == protocol

    relax = next(stage for stage in loaded.stages if stage.stage_id == "constrained_relax")
    hold = next(stage for stage in loaded.stages if stage.stage_id == "constrained_hold")
    assert hold.default_until_seconds == pytest.approx(loaded.problem.runtime_metadata["bimeron_frozen_size"]["protocol"]["hold_time_s"])
    if protocol == "p0":
        assert not relax.problem.magnetization_constraints
        assert not hold.problem.magnetization_constraints
    else:
        assert len(relax.problem.magnetization_constraints) == 1
        assert len(hold.problem.magnetization_constraints) == 1
        assert relax.problem.magnetization_constraints[0].membership == "static"
        assert hold.problem.magnetization_constraints[0].activation["stage_ids"] == [
            "constrained_relax",
            "constrained_hold",
        ]
        selector = relax.problem.magnetization_constraints[0].selector.to_ir()
        assert selector["kind"] in {"or", "and"}

    ir = hold.problem.to_ir(
        requested_backend="fdm",
        execution_mode="strict",
        execution_precision="double",
        script_source=loaded.script_source,
        source_root=loaded.source_path.parent,
        include_geometry_assets=False,
    )
    assert ir["pbc"]["axes"] == ["periodic", "open", "open"]
    assert ir["pbc"]["demag"] == "truncated_images"
    assert any(term.get("kind") == "rotated_interfacial_dmi" for term in ir["energy_terms"])
    runtime_selection = ir["problem_meta"]["runtime_metadata"]["runtime_selection"]
    assert runtime_selection["backend"] == "fdm"
    assert runtime_selection["execution_mode"] == "strict"
    assert runtime_selection["execution_precision"] == "double"


def test_release_stage_is_unconstrained_and_keeps_reference_stages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FULLMAG_BIMERON_PROTOCOL", "p3")
    monkeypatch.setenv("FULLMAG_BIMERON_RELEASE", "1")
    loaded = fm.load_problem_from_script(SCRIPT, lightweight_assets=True)
    release = next(stage for stage in loaded.stages if stage.stage_id == "released_relax")
    # The public flat-stage builder carries prior declarations forward.  The
    # stage-scoped activation list makes this declaration inactive during the
    # release stage, which is the runtime free-relaxation contract.
    assert len(release.problem.magnetization_constraints) == 1
    assert release.problem.magnetization_constraints[0].activation["stage_ids"] == [
        "constrained_relax",
        "constrained_hold",
    ]
    assert len(loaded.stages) == 7


def test_frozen_selector_is_serializable_and_has_no_dynamic_membership(monkeypatch: pytest.MonkeyPatch) -> None:
    loaded = _load(monkeypatch, protocol="p3")
    constraint = next(stage for stage in loaded.stages if stage.stage_id == "constrained_relax").problem.magnetization_constraints[0]
    payload = constraint.to_ir()
    assert payload["membership"] == {"kind": "static"}
    assert payload["reference"] == {"kind": "capture_current_at_activation"}
    assert json.dumps(payload, allow_nan=False)
