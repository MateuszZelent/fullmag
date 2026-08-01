"""Fail-closed evidence checks for the bounded SP4 mixed-P1 mesh lane."""

from __future__ import annotations

import math
from typing import Any, cast

from fullmag.meshing._gmsh_types import MixedLayerTopologyCertificate


class TopologyEvidenceError(ValueError):
    """Raised when mixed-P1 topology evidence is absent or inconsistent."""


_EMPTY_LEDGER_VALUES = {
    "mesh_certificate_status": None,
    "mesh_node_plane_count": None,
    "mesh_magnetic_prism6_count": None,
    "mesh_magnetic_tet4_count": None,
    "mesh_magnetic_pyramid5_count": None,
}


def mixed_topology_certificate_values(
    mesh: dict[str, Any],
    *,
    required: bool,
    expected_layers: int | None = None,
    expected_device: str | None = None,
    runtime_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate and summarize one bounded mixed-P1 topology certificate."""

    if required:
        if isinstance(expected_layers, bool) or expected_layers not in {1, 2, 3}:
            raise TopologyEvidenceError(
                "mixed topology expected layers must be one of 1, 2, or 3"
            )
        if expected_device not in {"cpu", "gpu"}:
            raise TopologyEvidenceError(
                "mixed topology expected device must be cpu or gpu"
            )

    report = mesh.get("mesh_build_report")
    certificate = (
        report.get("mixed_layer_topology_certificate")
        if isinstance(report, dict)
        else None
    )
    if not isinstance(certificate, dict):
        if required:
            raise TopologyEvidenceError(
                "mixed layer topology certificate metadata missing"
            )
        return dict(_EMPTY_LEDGER_VALUES)

    planes = certificate.get("magnetic_plane_coordinates_m")
    counts_by_marker = certificate.get("cell_family_counts_by_marker")
    magnetic_counts = (
        counts_by_marker.get("1") if isinstance(counts_by_marker, dict) else None
    )
    if not isinstance(planes, list) or not isinstance(magnetic_counts, dict):
        if required:
            raise TopologyEvidenceError(
                "mixed layer topology certificate evidence is malformed"
            )
        return dict(_EMPTY_LEDGER_VALUES)

    values = {
        "mesh_certificate_status": certificate.get("certificate_status"),
        "mesh_node_plane_count": len(planes),
        "mesh_magnetic_prism6_count": magnetic_counts.get("prism6", 0),
        "mesh_magnetic_tet4_count": magnetic_counts.get("tet4", 0),
        "mesh_magnetic_pyramid5_count": magnetic_counts.get("pyramid5", 0),
    }
    if not required:
        return values

    report = cast(dict[str, Any], report)
    qualified_layers = cast(int, expected_layers)
    qualified_device = cast(str, expected_device)
    if report.get("build_mode") != "single_geometry_geo_mixed":
        raise TopologyEvidenceError(
            "topology evidence requires single_geometry_geo_mixed build evidence"
        )
    if report.get("fallbacks_triggered") != []:
        raise TopologyEvidenceError("mesh build report fallbacks must be empty")
    if report.get("degraded") is not False:
        raise TopologyEvidenceError("mesh build report must prove degraded=false")
    if report.get("orphan_entities") != []:
        raise TopologyEvidenceError(
            "mesh build report must prove no orphan entities"
        )
    try:
        parsed = MixedLayerTopologyCertificate.from_dict(certificate)
    except (TypeError, ValueError) as exc:
        raise TopologyEvidenceError(
            f"invalid mixed layer topology certificate: {exc}"
        ) from exc

    if parsed.topology_fingerprint != mesh.get("topology_fingerprint"):
        raise TopologyEvidenceError(
            "mixed layer topology certificate fingerprint differs from mesh"
        )
    if (
        parsed.requested_layer_count != qualified_layers
        or parsed.realized_layer_count != qualified_layers
    ):
        raise TopologyEvidenceError(
            "mixed topology evidence requires requested and realized "
            f"layers={qualified_layers}"
        )
    if len(parsed.magnetic_plane_coordinates_m) != qualified_layers + 1:
        raise TopologyEvidenceError(
            "mixed topology evidence requires exactly "
            f"{qualified_layers + 1} magnetic node planes for layers={qualified_layers}"
        )
    parsed_magnetic_counts = parsed.cell_family_counts_by_marker.get("1", {})
    if (
        set(parsed_magnetic_counts) != {"prism6"}
        or parsed_magnetic_counts.get("prism6", 0) <= 0
    ):
        raise TopologyEvidenceError(
            "mixed topology evidence requires prism6-only magnetic cells"
        )
    counts_by_marker = parsed.cell_family_counts_by_marker
    counts_by_part = parsed.cell_family_counts_by_part
    if set(counts_by_marker) != {"0", "1"}:
        raise TopologyEvidenceError(
            "mixed topology evidence requires exactly markers 0 and 1"
        )
    if set(counts_by_part) != {"magnetic", "transition_air", "far_air"}:
        raise TopologyEvidenceError(
            "mixed topology evidence requires magnetic, transition_air, and far_air mesh parts"
        )
    if counts_by_part["magnetic"] != parsed_magnetic_counts:
        raise TopologyEvidenceError(
            "mixed topology marker and mesh-part counts differ"
        )
    far_air_counts = counts_by_part["far_air"]
    if set(far_air_counts) != {"tet4"} or far_air_counts.get("tet4", 0) <= 0:
        raise TopologyEvidenceError(
            "mixed topology far_air must contain tet4 only"
        )
    transition_air_counts = counts_by_part["transition_air"]
    if set(transition_air_counts) != {"pyramid5", "tet4"} or any(
        transition_air_counts.get(family, 0) <= 0
        for family in ("pyramid5", "tet4")
    ):
        raise TopologyEvidenceError(
            "mixed topology transition_air must contain pyramid5 and tet4 only"
        )
    expected_air_counts = {
        "pyramid5": transition_air_counts["pyramid5"],
        "tet4": transition_air_counts["tet4"] + far_air_counts["tet4"],
    }
    if counts_by_marker["0"] != expected_air_counts:
        raise TopologyEvidenceError(
            "mixed topology marker and mesh-part counts differ"
        )
    required_families = {"prism6", "pyramid5", "tet4"}
    if set(parsed.scaled_jacobian_p05_by_family) != required_families:
        raise TopologyEvidenceError(
            "mixed topology p05 must cover prism6, pyramid5, and tet4"
        )
    element_count = mesh.get("element_count")
    certificate_element_count = sum(
        count
        for families in counts_by_marker.values()
        for count in families.values()
    )
    if (
        isinstance(element_count, bool)
        or not isinstance(element_count, int)
        or element_count != certificate_element_count
    ):
        raise TopologyEvidenceError(
            "mesh element_count differs from certificate"
        )
    if not isinstance(runtime_metadata, dict):
        raise TopologyEvidenceError(
            "mixed topology runtime metadata is malformed"
        )
    mesh_workflow = runtime_metadata.get("mesh_workflow")
    per_geometry = (
        mesh_workflow.get("per_geometry")
        if isinstance(mesh_workflow, dict)
        else None
    )
    if (
        not isinstance(per_geometry, list)
        or len(per_geometry) != 1
        or not isinstance(per_geometry[0], dict)
        or per_geometry[0].get("through_thickness_elements") != qualified_layers
    ):
        raise TopologyEvidenceError(
            "mixed topology authored layer count differs from expected layers"
        )
    domain_frame = runtime_metadata.get("domain_frame")
    if not isinstance(domain_frame, dict):
        raise TopologyEvidenceError(
            "mixed topology domain frame metadata is missing"
        )
    magnetic_min = domain_frame.get("object_bounds_min")
    magnetic_max = domain_frame.get("object_bounds_max")
    universe = domain_frame.get("declared_universe")
    if (
        not isinstance(magnetic_min, (list, tuple))
        or not isinstance(magnetic_max, (list, tuple))
        or len(magnetic_min) != 3
        or len(magnetic_max) != 3
        or not isinstance(universe, dict)
    ):
        raise TopologyEvidenceError(
            "mixed topology authored bounds metadata is missing"
        )
    universe_size = universe.get("size")
    universe_center = universe.get("center")
    if (
        not isinstance(universe_size, (list, tuple))
        or not isinstance(universe_center, (list, tuple))
        or len(universe_size) != 3
        or len(universe_center) != 3
    ):
        raise TopologyEvidenceError(
            "mixed topology authored airbox metadata is missing"
        )
    try:
        magnetic_min_values = tuple(float(value) for value in magnetic_min)
        magnetic_max_values = tuple(float(value) for value in magnetic_max)
        universe_size_values = tuple(float(value) for value in universe_size)
        universe_center_values = tuple(float(value) for value in universe_center)
    except (TypeError, ValueError) as exc:
        raise TopologyEvidenceError(
            "mixed topology authored bounds metadata is malformed"
        ) from exc
    airbox_min = tuple(
        center - 0.5 * size
        for center, size in zip(
            universe_center_values, universe_size_values, strict=True
        )
    )
    airbox_max = tuple(
        center + 0.5 * size
        for center, size in zip(
            universe_center_values, universe_size_values, strict=True
        )
    )

    def bounds_match(
        actual: tuple[float, ...], expected: tuple[float, ...]
    ) -> bool:
        return all(
            math.isclose(left, right, rel_tol=1.0e-8, abs_tol=1.0e-18)
            for left, right in zip(actual, expected, strict=True)
        )

    if not bounds_match(
        parsed.magnetic_bounds_min_m, magnetic_min_values
    ) or not bounds_match(parsed.magnetic_bounds_max_m, magnetic_max_values):
        raise TopologyEvidenceError(
            "mixed topology magnetic bounds differ from runtime metadata"
        )
    if not bounds_match(parsed.airbox_bounds_min_m, airbox_min) or not bounds_match(
        parsed.airbox_bounds_max_m, airbox_max
    ):
        raise TopologyEvidenceError(
            "mixed topology airbox bounds differ from runtime metadata"
        )
    magnetic_volume = math.prod(
        maximum - minimum
        for minimum, maximum in zip(
            magnetic_min_values, magnetic_max_values, strict=True
        )
    )
    shared_domain_volume = math.prod(universe_size_values)
    air_volume = shared_domain_volume - magnetic_volume
    if not all(
        math.isclose(value, magnetic_volume, rel_tol=1.0e-8, abs_tol=0.0)
        for value in (
            parsed.magnetic_volume_m3,
            parsed.expected_magnetic_volume_m3,
        )
    ):
        raise TopologyEvidenceError(
            "mixed topology magnetic volume differs from runtime metadata"
        )
    if not all(
        math.isclose(value, shared_domain_volume, rel_tol=1.0e-8, abs_tol=0.0)
        for value in (
            parsed.shared_domain_volume_m3,
            parsed.expected_shared_domain_volume_m3,
        )
    ) or not math.isclose(
        parsed.air_volume_m3, air_volume, rel_tol=1.0e-8, abs_tol=0.0
    ):
        raise TopologyEvidenceError(
            "mixed topology shared-domain volume differs from runtime metadata"
        )
    provenance = report.get("mixed_topology_provenance")
    if not isinstance(provenance, dict):
        raise TopologyEvidenceError(
            "mixed topology provenance missing from mesh build report"
        )
    expected_provenance = {
        "requested_topology": "mixed_p1",
        "resolved_topology": "mixed_p1",
        "accepted_certificate_fingerprint": parsed.topology_fingerprint,
        "requested_device": qualified_device,
        "precision": "double",
        "capability_status": "implemented",
    }
    for name, expected in expected_provenance.items():
        if provenance.get(name) != expected:
            raise TopologyEvidenceError(
                f"mixed topology provenance {name} must be {expected!r}"
            )
    return {
        "mesh_certificate_status": parsed.certificate_status,
        "mesh_node_plane_count": len(parsed.magnetic_plane_coordinates_m),
        "mesh_magnetic_prism6_count": parsed_magnetic_counts.get("prism6", 0),
        "mesh_magnetic_tet4_count": parsed_magnetic_counts.get("tet4", 0),
        "mesh_magnetic_pyramid5_count": parsed_magnetic_counts.get(
            "pyramid5", 0
        ),
    }
