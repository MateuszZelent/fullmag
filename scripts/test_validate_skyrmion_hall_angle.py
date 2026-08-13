from __future__ import annotations

import copy
import math

import pytest

from scripts.validate_skyrmion_hall_angle import HallArtifactError, validate_hall_artifact


def _provenance() -> dict[str, str]:
    return {
        "scene_revision": "scene-1",
        "field_revision": "field-1",
        "mesh_revision": "mesh-1",
        "mesh_generation_id": "mesh-gen-1",
        "domain_generation_id": "domain-1",
        "global_node_mapping_id": "node-map-1",
        "cache_key_digest": "cache-1",
    }


def _artifact() -> dict[str, object]:
    provenance = _provenance()
    return {
        "schema_version": "skyrmion_hall_angle.v1",
        "trajectory": {
            "time_s": [0.0, 1.0e-10, 2.0e-10],
            "x_m": [0.0, 1.0e-8, 2.0e-8],
            "y_m": [0.0, 5.773502691896258e-9, 1.1547005383792516e-8],
            "q": [-1.0, -1.0, -1.0],
            "edge_distance_m": [40e-9, 40e-9, 40e-9],
            "provenance": dict(provenance),
        },
        "hall_angle": {
            "v_parallel_m_per_s": 100.0,
            "v_perp_m_per_s": 100.0 * math.tan(math.pi / 6.0),
            "angle_rad": math.pi / 6.0,
            "angle_deg": 30.0,
            "accepted_interval": {"start_index": 0, "end_index": 2, "sample_count": 3},
            "residuals_m": [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]],
            "velocity_covariance_m2_per_s2": [[1e-4, 0.0], [0.0, 1e-4]],
            "mean_signed_current_a_per_m2": 1.0e12,
            "provenance": provenance,
        },
    }


def test_accepts_complete_hall_artifact() -> None:
    validate_hall_artifact(_artifact())


@pytest.mark.parametrize(
    ("path", "value", "message"),
    [
        (("trajectory", "q"), [-1.0, -0.4, -1.0], "topology_lost"),
        (("trajectory", "edge_distance_m"), [40e-9, 1e-9, 40e-9], "edge_contaminated"),
        (("hall_angle", "angle_deg"), 29.0, "angle_deg"),
        (("hall_angle", "provenance", "field_revision"), "stale", "provenance"),
    ],
)
def test_rejects_inconsistent_or_stale_artifact(path: tuple[str, ...], value: object, message: str) -> None:
    artifact = copy.deepcopy(_artifact())
    target: object = artifact
    for key in path[:-1]:
        target = target[key]  # type: ignore[index]
    target[path[-1]] = value  # type: ignore[index]
    with pytest.raises(HallArtifactError, match=message):
        validate_hall_artifact(artifact)


def test_rejected_artifact_is_fail_closed() -> None:
    artifact = _artifact()
    artifact["hall_angle"] = {
        "reason_code": "no_stationary_window",
        "v_parallel_m_per_s": None,
        "v_perp_m_per_s": None,
        "angle_rad": None,
        "angle_deg": None,
    }
    validate_hall_artifact(artifact)
