from __future__ import annotations

import copy

import pytest

from tests.standard_problems.mumag.sp4.fem.test_mixed_mesh_topology import (
    _topology_metadata,
)
from tests.standard_problems.mumag.sp4.fem.topology_evidence import (
    TopologyEvidenceError,
    mixed_topology_certificate_values,
)


def _metadata_for(*, layers: int, device: str) -> dict[str, object]:
    metadata = copy.deepcopy(_topology_metadata())
    metadata["requested_execution"]["device"] = device
    certificate = metadata["mesh"]["mesh_build_report"][
        "mixed_layer_topology_certificate"
    ]
    certificate.update(
        {
            "requested_layer_count": layers,
            "realized_layer_count": layers,
            "magnetic_plane_coordinates_m": [
                -1.5e-9 + index * 3.0e-9 / layers
                for index in range(layers + 1)
            ],
        }
    )
    metadata["mesh"]["mesh_build_report"]["mixed_topology_provenance"][
        "requested_device"
    ] = device
    metadata["problem_meta"]["runtime_metadata"]["mesh_workflow"][
        "per_geometry"
    ][0]["through_thickness_elements"] = layers
    return metadata


@pytest.mark.parametrize("layers", [1, 2, 3])
@pytest.mark.parametrize("device", ["cpu", "gpu"])
def test_mixed_topology_evidence_accepts_qualified_layers_and_devices(
    layers: int,
    device: str,
) -> None:
    metadata = _metadata_for(layers=layers, device=device)

    values = mixed_topology_certificate_values(
        metadata["mesh"],
        required=True,
        expected_layers=layers,
        expected_device=device,
        runtime_metadata=metadata["problem_meta"]["runtime_metadata"],
    )

    assert values["mesh_certificate_status"] == "accepted"
    assert values["mesh_node_plane_count"] == layers + 1
    assert values["mesh_magnetic_prism6_count"] > 0
    assert values["mesh_magnetic_tet4_count"] == 0
    assert values["mesh_magnetic_pyramid5_count"] == 0


@pytest.mark.parametrize(
    "orphan_entities",
    [
        pytest.param(None, id="missing"),
        pytest.param([{"dimension": 2, "tag": 9}], id="nonempty"),
    ],
)
def test_mixed_topology_evidence_fails_closed_without_explicit_empty_orphans(
    orphan_entities: list[dict[str, int]] | None,
) -> None:
    metadata = _metadata_for(layers=1, device="cpu")
    report = metadata["mesh"]["mesh_build_report"]
    if orphan_entities is None:
        report.pop("orphan_entities")
    else:
        report["orphan_entities"] = orphan_entities

    with pytest.raises(TopologyEvidenceError, match="must prove no orphan entities"):
        mixed_topology_certificate_values(
            metadata["mesh"],
            required=True,
            expected_layers=1,
            expected_device="cpu",
            runtime_metadata=metadata["problem_meta"]["runtime_metadata"],
        )


@pytest.mark.parametrize("layers", [0, 4])
def test_mixed_topology_evidence_rejects_unqualified_expected_layers(
    layers: int,
) -> None:
    metadata = _metadata_for(layers=1, device="cpu")

    with pytest.raises(
        TopologyEvidenceError,
        match="expected layers must be one of 1, 2, or 3",
    ):
        mixed_topology_certificate_values(
            metadata["mesh"],
            required=True,
            expected_layers=layers,
            expected_device="cpu",
            runtime_metadata=metadata["problem_meta"]["runtime_metadata"],
        )


def test_mixed_topology_evidence_rejects_unqualified_expected_device() -> None:
    metadata = _metadata_for(layers=1, device="cpu")

    with pytest.raises(
        TopologyEvidenceError,
        match="expected device must be cpu or gpu",
    ):
        mixed_topology_certificate_values(
            metadata["mesh"],
            required=True,
            expected_layers=1,
            expected_device="auto",
            runtime_metadata=metadata["problem_meta"]["runtime_metadata"],
        )
