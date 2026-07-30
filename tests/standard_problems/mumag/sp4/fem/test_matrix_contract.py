from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from tests.standard_problems.mumag.sp4.common.contract import (
    CONTRACT,
    PRODUCTION_RELAXATION_ALGORITHMS,
)
from tests.standard_problems.mumag.sp4.fem.matrix_contract import (
    STAGE1_LAYERS,
    STAGE2_AIRBOX,
    STAGE3_DEVICE,
    SP4MatrixRunSpec,
    SP4MeshVariant,
    matrix_specs,
)


MEDIUM = next(mesh for mesh in CONTRACT.meshes if mesh.id == "medium")
BASELINE = next(
    airbox for airbox in CONTRACT.airboxes if airbox.id == "baseline"
)
EXPANDED = next(airbox for airbox in CONTRACT.airboxes if airbox.id == "expanded")


@pytest.mark.parametrize(
    ("topology_variant", "layers"),
    [
        ("all_tet", 1),
        ("mixed_p1", None),
        ("mixed_p1", 0),
        ("mixed_p1", 4),
        ("mixed_p1", True),
    ],
)
def test_matrix_contract_rejects_all_tet_with_layers_and_mixed_without_layers(
    topology_variant,
    layers,
) -> None:
    with pytest.raises(ValueError):
        SP4MeshVariant(topology_variant, layers, MEDIUM, BASELINE)


def test_mesh_variant_is_immutable_and_all_tet_uses_layers_none() -> None:
    variant = SP4MeshVariant("all_tet", None, MEDIUM, BASELINE)

    assert variant.layer_key == "layers-none"
    with pytest.raises(FrozenInstanceError):
        variant.layers = 1


def test_stage1_enumerates_exactly_nine_cpu_medium_baseline_relaxations() -> None:
    specs = matrix_specs(STAGE1_LAYERS)

    assert len(specs) == 9
    assert [
        (spec.layers, spec.relaxation_algorithm) for spec in specs
    ] == [
        (layers, algorithm)
        for layers in (1, 2, 3)
        for algorithm in PRODUCTION_RELAXATION_ALGORITHMS
    ]
    assert all(spec.stage_id == STAGE1_LAYERS for spec in specs)
    assert all(spec.phase == "relax" for spec in specs)
    assert all(spec.topology_variant == "mixed_p1" for spec in specs)
    assert all(spec.device == "cpu" for spec in specs)
    assert all(spec.mesh == MEDIUM for spec in specs)
    assert all(spec.airbox == BASELINE for spec in specs)


def test_stage2_reuses_only_identity_equal_stage1_baseline_and_adds_three_expanded_runs(
) -> None:
    stage1_baseline = tuple(
        spec for spec in matrix_specs(STAGE1_LAYERS) if spec.layers == 1
    )
    specs = matrix_specs(STAGE2_AIRBOX)

    assert specs[:3] == stage1_baseline
    assert len(specs) == 6
    additions = specs[3:]
    assert {spec.relaxation_algorithm for spec in additions} == set(
        PRODUCTION_RELAXATION_ALGORITHMS
    )
    assert all(spec.stage_id == STAGE2_AIRBOX for spec in additions)
    assert all(spec.topology_variant == "mixed_p1" for spec in additions)
    assert all(spec.layers == 1 for spec in additions)
    assert all(spec.device == "cpu" for spec in additions)
    assert all(spec.mesh == MEDIUM for spec in additions)
    assert all(spec.airbox == EXPANDED for spec in additions)


def test_stage3_reuses_cpu_and_adds_exactly_three_gpu_layer1_relaxations() -> None:
    stage1_baseline = tuple(
        spec for spec in matrix_specs(STAGE1_LAYERS) if spec.layers == 1
    )
    specs = matrix_specs(STAGE3_DEVICE)

    assert specs[:3] == stage1_baseline
    assert len(specs) == 6
    additions = specs[3:]
    assert {spec.relaxation_algorithm for spec in additions} == set(
        PRODUCTION_RELAXATION_ALGORITHMS
    )
    assert all(spec.stage_id == STAGE3_DEVICE for spec in additions)
    assert all(spec.topology_variant == "mixed_p1" for spec in additions)
    assert all(spec.layers == 1 for spec in additions)
    assert all(spec.device == "gpu" for spec in additions)
    assert all(spec.mesh == MEDIUM for spec in additions)
    assert all(spec.airbox == BASELINE for spec in additions)


def test_relaxation_run_ids_and_paths_are_unique_and_encode_every_run_axis() -> None:
    all_specs = tuple(
        spec
        for stage_id in (STAGE1_LAYERS, STAGE2_AIRBOX, STAGE3_DEVICE)
        for spec in matrix_specs(stage_id)
    )
    by_run_id: dict[str, SP4MatrixRunSpec] = {}
    by_path: dict[Path, SP4MatrixRunSpec] = {}
    for spec in all_specs:
        if spec.run_id in by_run_id:
            assert by_run_id[spec.run_id] == spec
        else:
            by_run_id[spec.run_id] = spec
        if spec.artifact_path in by_path:
            assert by_path[spec.artifact_path] == spec
        else:
            by_path[spec.artifact_path] = spec

    assert len(by_run_id) == len(by_path) == 15
    sample = next(
        spec
        for spec in all_specs
        if spec.layers == 1
        and spec.device == "cpu"
        and spec.airbox.id == "baseline"
        and spec.relaxation_algorithm == "projected_gradient_bb"
    )
    assert sample.run_id == (
        "relax__mixed_p1__layers-1__cpu__medium__baseline__projected_gradient_bb"
    )
    assert sample.artifact_path == Path(
        "relaxations/mixed_p1/layers-1/cpu/medium/baseline/"
        "projected_gradient_bb/artifacts"
    )


def test_all_tet_run_identity_uses_explicit_layers_none_key() -> None:
    spec = SP4MatrixRunSpec(
        stage_id="comparator",
        phase="relax",
        topology_variant="all_tet",
        layers=None,
        mesh=MEDIUM,
        airbox=BASELINE,
        device="cpu",
        relaxation_algorithm="nonlinear_cg",
    )

    assert "all_tet" in spec.run_id
    assert "layers-none" in spec.run_id
    assert spec.artifact_path == Path(
        "relaxations/all_tet/layers-none/cpu/medium/baseline/"
        "nonlinear_cg/artifacts"
    )


def test_unknown_matrix_stage_fails_closed() -> None:
    with pytest.raises(ValueError, match="unsupported SP4 matrix stage"):
        matrix_specs("stage4")
