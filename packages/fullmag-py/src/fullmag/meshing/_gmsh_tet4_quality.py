"""Evaluate Gmsh quality for an explicit final Tet4 mesh in an isolated model."""

from __future__ import annotations

from dataclasses import replace
from typing import Any
from uuid import uuid4

import numpy as np
from numpy.typing import NDArray

from ._gmsh_extraction import GmshQualityExtractionError, _extract_quality_metrics
from ._gmsh_types import MeshOptions, MeshQualityReport


def _real_numeric_array(value: object, *, name: str) -> NDArray[Any]:
    try:
        array = np.asarray(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise TypeError(f"{name} must be a rectangular real numeric array") from exc
    if np.iscomplexobj(array):
        raise TypeError(f"{name} must contain real values")
    if array.dtype.kind not in "fiu":
        raise TypeError(f"{name} must contain real numeric values")
    return array


def _validate_inputs(
    nodes_si: object,
    cells: object,
    element_markers: object,
    opts: MeshOptions,
) -> tuple[NDArray[np.float64], NDArray[np.int64], NDArray[np.int32], NDArray[np.float64]]:
    if not isinstance(opts, MeshOptions):
        raise TypeError("opts must be a MeshOptions instance")
    if not isinstance(opts.per_element_quality, (bool, np.bool_)):
        raise TypeError("opts.per_element_quality must be boolean")

    raw_nodes = _real_numeric_array(nodes_si, name="nodes_si")
    if raw_nodes.ndim != 2 or raw_nodes.shape[1] != 3 or raw_nodes.shape[0] < 4:
        raise ValueError("nodes_si must have shape (N, 3) with N >= 4")
    nodes = np.asarray(raw_nodes, dtype=np.float64)
    if not np.all(np.isfinite(nodes)):
        raise ValueError("nodes_si must contain only finite values")

    raw_cells = _real_numeric_array(cells, name="cells")
    if raw_cells.ndim != 2 or raw_cells.shape[1] != 4 or raw_cells.shape[0] == 0:
        raise ValueError("cells must have non-empty shape (M, 4)")
    if raw_cells.dtype.kind not in "iu":
        raise TypeError("cells must contain integer node indices")
    if np.any(raw_cells >= nodes.shape[0]) or np.any(raw_cells < 0):
        raise ValueError("cells contains an out-of-range node index")
    tet_cells = np.asarray(raw_cells, dtype=np.int64)
    if np.any(np.diff(np.sort(tet_cells, axis=1), axis=1) == 0):
        raise ValueError("each Tet4 cell must reference four distinct nodes")

    raw_markers = _real_numeric_array(element_markers, name="element_markers")
    if raw_markers.ndim != 1 or raw_markers.size != tet_cells.shape[0]:
        raise ValueError("element_markers length must match cells")
    if raw_markers.dtype.kind not in "iu":
        raise TypeError("element_markers must contain integer markers")
    if np.any(raw_markers < 0):
        raise ValueError("element_markers must be nonnegative")
    if np.any(raw_markers > np.iinfo(np.int32).max):
        raise ValueError("element_markers exceed the supported int32 range")
    markers = np.asarray(raw_markers, dtype=np.int32)

    points = nodes[tet_cells]
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        edges = points[:, 1:, :] - points[:, :1, :]
        signed_volumes = np.einsum(
            "ij,ij->i",
            edges[:, 0, :],
            np.cross(edges[:, 1, :], edges[:, 2, :]),
        ) / 6.0
    if not np.all(np.isfinite(signed_volumes)):
        raise ValueError("Tet4 signed volumes must be finite")
    if np.any(signed_volumes <= 0.0):
        raise ValueError("Tet4 signed volumes must be strictly positive")

    return nodes, tet_cells, markers, signed_volumes


def _quality_error(
    channel: str,
    expected_count: int,
    actual_count: int | None,
    reason: str,
) -> GmshQualityExtractionError:
    return GmshQualityExtractionError(
        channel=channel,
        expected_count=expected_count,
        actual_count=actual_count,
        reason=reason,
    )


def _require_quality_values(
    values: list[float] | None,
    *,
    channel: str,
    expected_count: int,
) -> NDArray[np.float64]:
    if values is None:
        raise _quality_error(
            channel,
            expected_count,
            None,
            "the extractor omitted a required per-element quality channel",
        )
    try:
        array = np.asarray(values, dtype=np.float64).reshape(-1)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _quality_error(
            channel,
            expected_count,
            None,
            f"the extractor returned non-numeric values: {exc}",
        ) from exc
    if array.size != expected_count:
        raise _quality_error(
            channel,
            expected_count,
            int(array.size),
            "the extractor returned a channel with the wrong element count",
        )
    if not np.all(np.isfinite(array)):
        raise GmshQualityExtractionError(
            channel=channel,
            expected_count=expected_count,
            actual_count=int(array.size),
            nonfinite_indices=tuple(int(index) for index in np.flatnonzero(~np.isfinite(array))),
        )
    return array


def quality_for_tet4_arrays(
    gmsh: Any,
    nodes_si: object,
    cells: object,
    element_markers: object,
    opts: MeshOptions,
) -> tuple[MeshQualityReport, dict[int, MeshQualityReport] | None]:
    """Compute quality on final SI Tet4 arrays using a temporary Gmsh model.

    The caller owns the initialized Gmsh session and its lock. This helper
    never initializes/finalizes Gmsh or changes global options and removes only
    the scratch model it creates.
    """
    nodes, tet_cells, markers, signed_volumes = _validate_inputs(
        nodes_si,
        cells,
        element_markers,
        opts,
    )
    if not gmsh.isInitialized():
        raise RuntimeError("Gmsh must be initialized by the caller")

    existing_models = tuple(str(name) for name in gmsh.model.list())
    previous_model = str(gmsh.model.getCurrent())
    scratch_name = f"fullmag-tet4-quality-{uuid4().hex}"
    while scratch_name in existing_models:
        scratch_name = f"fullmag-tet4-quality-{uuid4().hex}"

    scratch_created = False
    try:
        scratch_created = True
        gmsh.model.add(scratch_name)
        gmsh.model.setCurrent(scratch_name)
        entity_tag = int(gmsh.model.addDiscreteEntity(3))
        node_tags = np.arange(1, nodes.shape[0] + 1, dtype=np.uint64)
        element_tags = np.arange(1, tet_cells.shape[0] + 1, dtype=np.uint64)
        gmsh.model.mesh.addNodes(
            3,
            entity_tag,
            node_tags,
            np.asarray(nodes, dtype=np.float64).reshape(-1),
        )
        gmsh.model.mesh.addElementsByType(
            entity_tag,
            4,
            element_tags,
            np.asarray(tet_cells + 1, dtype=np.uint64).reshape(-1),
        )

        gmsh_types, gmsh_tag_blocks, _connectivity_blocks = gmsh.model.mesh.getElements(dim=3)
        returned_tags = [
            int(tag)
            for block in gmsh_tag_blocks
            for tag in np.asarray(block).reshape(-1)
        ]
        expected_tags = list(range(1, tet_cells.shape[0] + 1))
        if (
            [int(kind) for kind in gmsh_types] != [4]
            or returned_tags != expected_tags
        ):
            raise _quality_error(
                "element_tags",
                len(expected_tags),
                len(returned_tags),
                "scratch Gmsh model does not contain the requested Tet4 elements in tag order",
            )

        extractor_opts = (
            opts
            if opts.per_element_quality
            else replace(opts, per_element_quality=True)
        )
        report, per_domain = _extract_quality_metrics(
            gmsh,
            extractor_opts,
            element_markers=markers,
        )

        if report.n_elements != len(expected_tags):
            raise _quality_error(
                "element_tags",
                len(expected_tags),
                int(report.n_elements),
                "quality report element count does not match the final Tet4 arrays",
            )
        if report.element_tags != expected_tags:
            actual_count = None if report.element_tags is None else len(report.element_tags)
            raise _quality_error(
                "element_tags",
                len(expected_tags),
                actual_count,
                "quality report tags are missing, reordered, or do not match the final Tet4 arrays",
            )

        sicn = _require_quality_values(
            report.element_sicn,
            channel="minSICN",
            expected_count=len(expected_tags),
        )
        _require_quality_values(
            report.element_gamma,
            channel="gamma",
            expected_count=len(expected_tags),
        )
        volumes = _require_quality_values(
            report.element_volume,
            channel="volume",
            expected_count=len(expected_tags),
        )
        if np.any(volumes <= 0.0):
            raise _quality_error(
                "volume",
                len(expected_tags),
                len(volumes),
                "Gmsh returned a nonpositive Tet4 volume",
            )
        if not np.allclose(volumes, signed_volumes, rtol=1.0e-12, atol=0.0):
            max_relative_error = float(
                np.max(np.abs(volumes - signed_volumes) / signed_volumes)
            )
            raise _quality_error(
                "volume",
                len(expected_tags),
                len(volumes),
                "Gmsh Tet4 volumes disagree with the signed SI geometry "
                f"(maximum relative error {max_relative_error:.6g})",
            )

        expected_domain_counts = {
            int(marker): int(np.count_nonzero(markers == marker))
            for marker in np.unique(markers)
        }
        if per_domain is None or set(per_domain) != set(expected_domain_counts):
            actual_markers = None if per_domain is None else len(per_domain)
            raise _quality_error(
                "element_markers",
                len(expected_domain_counts),
                actual_markers,
                "per-domain report does not match the explicit element markers",
            )
        for marker, expected_count in expected_domain_counts.items():
            if per_domain[marker].n_elements != expected_count:
                raise _quality_error(
                    "element_markers",
                    expected_count,
                    int(per_domain[marker].n_elements),
                    f"per-domain element count mismatch for marker {marker}",
                )

        result = replace(
            report,
            avg_quality=float(np.mean(sicn)),
            element_sicn=report.element_sicn if opts.per_element_quality else None,
            element_gamma=report.element_gamma if opts.per_element_quality else None,
            element_volume=report.element_volume if opts.per_element_quality else None,
        )
        return result, per_domain
    finally:
        try:
            if scratch_created and scratch_name in gmsh.model.list():
                gmsh.model.setCurrent(scratch_name)
                gmsh.model.remove()
        finally:
            if previous_model in gmsh.model.list():
                gmsh.model.setCurrent(previous_model)
