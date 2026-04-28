from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress

from ._gmsh_types import MeshData, MeshOptions, MeshQualityReport
from ._gmsh_infra import _import_meshio


def _first_cell_block(mesh: Any, allowed: set[str], allow_empty: bool = False) -> NDArray[np.int32]:
    for cell_block in mesh.cells:
        if cell_block.type in allowed:
            return np.asarray(cell_block.data, dtype=np.int32)
    if allow_empty:
        width = 3 if "triangle" in allowed else 4
        return np.zeros((0, width), dtype=np.int32)
    raise ValueError(f"mesh does not contain required cell types: {sorted(allowed)}")


def _read_mesh_file(path: Path) -> MeshData:
    meshio = _import_meshio()
    mesh = meshio.read(path)
    tetra = _first_cell_block(mesh, {"tetra"})
    triangles = _first_cell_block(mesh, {"triangle"}, allow_empty=True)
    nodes = np.asarray(mesh.points[:, :3], dtype=np.float64)
    elements = np.asarray(tetra, dtype=np.int32)
    boundary_faces = np.asarray(triangles, dtype=np.int32)
    element_markers = np.ones(elements.shape[0], dtype=np.int32)
    boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)
    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
    )


def _extract_mesh_data(
    gmsh: Any,
    quality: MeshQualityReport | None = None,
    has_physical_groups: bool = False,
    per_domain_quality: dict[int, MeshQualityReport] | None = None,
) -> MeshData:
    emit_progress("Gmsh: extracting mesh data")
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    if len(node_tags) == 0:
        raise ValueError("gmsh produced an empty node set")

    node_index = {int(tag): idx for idx, tag in enumerate(node_tags)}
    nodes = np.asarray(coords, dtype=np.float64).reshape(-1, 3)

    if has_physical_groups:
        # ── Region-aware extraction via physical groups ──
        elements_list: list[list[int]] = []
        markers_list: list[int] = []
        for _dim, phys_tag in gmsh.model.getPhysicalGroups(dim=3):
            entities = gmsh.model.getEntitiesForPhysicalGroup(3, phys_tag)
            for entity in entities:
                elem_types, _elem_tags, node_ids = gmsh.model.mesh.getElements(3, entity)
                for etype, nids in zip(elem_types, node_ids):
                    _, _, _, num_nodes, _, npn = gmsh.model.mesh.getElementProperties(int(etype))
                    if npn < 4:
                        continue
                    flat = [node_index[int(t)] for t in nids]
                    for start in range(0, len(flat), num_nodes):
                        elements_list.append(flat[start : start + 4])
                        markers_list.append(phys_tag)

        bfaces_list: list[list[int]] = []
        bmarkers_list: list[int] = []
        for _dim, phys_tag in gmsh.model.getPhysicalGroups(dim=2):
            entities = gmsh.model.getEntitiesForPhysicalGroup(2, phys_tag)
            for entity in entities:
                elem_types, _elem_tags, node_ids = gmsh.model.mesh.getElements(2, entity)
                for etype, nids in zip(elem_types, node_ids):
                    _, _, _, num_nodes, _, npn = gmsh.model.mesh.getElementProperties(int(etype))
                    if npn < 3:
                        continue
                    flat = [node_index[int(t)] for t in nids]
                    for start in range(0, len(flat), num_nodes):
                        bfaces_list.append(flat[start : start + 3])
                        bmarkers_list.append(phys_tag)

        elements = (
            np.asarray(elements_list, dtype=np.int32)
            if elements_list
            else np.zeros((0, 4), dtype=np.int32)
        )
        element_markers = (
            np.asarray(markers_list, dtype=np.int32)
            if markers_list
            else np.zeros(0, dtype=np.int32)
        )
        boundary_faces = (
            np.asarray(bfaces_list, dtype=np.int32)
            if bfaces_list
            else np.zeros((0, 3), dtype=np.int32)
        )
        boundary_markers = (
            np.asarray(bmarkers_list, dtype=np.int32)
            if bmarkers_list
            else np.zeros(0, dtype=np.int32)
        )
    else:
        # ── Legacy single-region path ──
        element_blocks = gmsh.model.mesh.getElements(dim=3)
        elements = _extract_gmsh_connectivity(
            gmsh, element_blocks, node_index, nodes_per_element=4
        )

        boundary_blocks = gmsh.model.mesh.getElements(dim=2)
        boundary_faces = _extract_gmsh_connectivity(
            gmsh, boundary_blocks, node_index, nodes_per_element=3
        )

        element_markers = np.ones(elements.shape[0], dtype=np.int32)
        boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)

    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
        quality=quality,
        per_domain_quality=per_domain_quality,
    )


def extract_per_domain_quality(
    element_markers: NDArray[np.int32],
    sicn_values: NDArray[np.float64],
    gamma_values: NDArray[np.float64],
    volume_values: NDArray[np.float64],
) -> dict[int, MeshQualityReport]:
    """Compute quality metrics grouped per domain (element marker).

    Args:
        element_markers: Per-element domain marker array.
        sicn_values: Per-element SICN quality values.
        gamma_values: Per-element gamma quality values.
        volume_values: Per-element volume values.

    Returns:
        Mapping from marker integer to :class:`MeshQualityReport`.
    """
    result: dict[int, MeshQualityReport] = {}
    for marker in np.unique(element_markers):
        mask = element_markers == marker
        s = sicn_values[mask]
        g = gamma_values[mask]
        v = volume_values[mask]
        if s.size == 0:
            continue
        sicn_hist, _ = np.histogram(s, bins=20, range=(-1.0, 1.0))
        gamma_hist, _ = np.histogram(g, bins=20, range=(0.0, 1.0))
        result[int(marker)] = MeshQualityReport(
            n_elements=int(mask.sum()),
            sicn_min=float(np.min(s)),
            sicn_max=float(np.max(s)),
            sicn_mean=float(np.mean(s)),
            sicn_p5=float(np.percentile(s, 5)),
            sicn_histogram=sicn_hist.tolist(),
            gamma_min=float(np.min(g)),
            gamma_mean=float(np.mean(g)),
            gamma_histogram=gamma_hist.tolist(),
            volume_min=float(np.min(v)),
            volume_max=float(np.max(v)),
            volume_mean=float(np.mean(v)),
            volume_std=float(np.std(v)),
            avg_quality=float(np.mean(s)),
        )
    return result


def _extract_quality_metrics(
    gmsh: Any,
    opts: MeshOptions,
    element_markers: NDArray[np.int32] | None = None,
) -> MeshQualityReport:
    """Extract per-element quality metrics from the current Gmsh mesh."""
    emit_progress("Gmsh: extracting quality metrics")

    # Collect all 3D element tags
    elem_types, elem_tags_blocks, _ = gmsh.model.mesh.getElements(dim=3)
    all_tags: list[int] = []
    for block in elem_tags_blocks:
        all_tags.extend(int(t) for t in block)

    if not all_tags:
        return MeshQualityReport(
            n_elements=0,
            sicn_min=0.0, sicn_max=0.0, sicn_mean=0.0, sicn_p5=0.0,
            sicn_histogram=[0] * 20,
            gamma_min=0.0, gamma_mean=0.0,
            gamma_histogram=[0] * 20,
            volume_min=0.0, volume_max=0.0, volume_mean=0.0, volume_std=0.0,
            avg_quality=0.0,
        )

    sicn = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "minSICN"))
    gamma = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "gamma"))
    vols = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "volume"))
    avg_q = gmsh.option.getNumber("Mesh.AvgQuality")
    resolved_markers = (
        np.asarray(element_markers, dtype=np.int32)
        if element_markers is not None and len(element_markers) == len(all_tags)
        else _extract_element_markers_for_tags(gmsh, all_tags)
    )

    sicn_hist, _ = np.histogram(sicn, bins=20, range=(-1.0, 1.0))
    gamma_hist, _ = np.histogram(gamma, bins=20, range=(0.0, 1.0))

    return MeshQualityReport(
        n_elements=len(all_tags),
        sicn_min=float(np.min(sicn)),
        sicn_max=float(np.max(sicn)),
        sicn_mean=float(np.mean(sicn)),
        sicn_p5=float(np.percentile(sicn, 5)),
        sicn_histogram=sicn_hist.tolist(),
        gamma_min=float(np.min(gamma)),
        gamma_mean=float(np.mean(gamma)),
        gamma_histogram=gamma_hist.tolist(),
        volume_min=float(np.min(vols)),
        volume_max=float(np.max(vols)),
        volume_mean=float(np.mean(vols)),
        volume_std=float(np.std(vols)),
        avg_quality=float(avg_q),
        element_sicn=sicn.tolist() if opts.per_element_quality else None,
        element_gamma=gamma.tolist() if opts.per_element_quality else None,
    ), (
        extract_per_domain_quality(
            resolved_markers,
            sicn,
            gamma,
            vols,
        )
        if resolved_markers is not None and len(resolved_markers) == len(all_tags)
        else None
    )


def _extract_element_markers_for_tags(
    gmsh: Any,
    all_tags: list[int],
) -> NDArray[np.int32] | None:
    """Return physical-group markers aligned to ``all_tags`` order."""
    if not all_tags:
        return np.zeros(0, dtype=np.int32)
    tag_to_marker: dict[int, int] = {}
    try:
        physical_groups = gmsh.model.getPhysicalGroups(dim=3)
    except Exception:
        physical_groups = []
    if not physical_groups:
        return None
    for _dim, phys_tag in physical_groups:
        try:
            entities = gmsh.model.getEntitiesForPhysicalGroup(3, phys_tag)
        except Exception:
            continue
        for entity in entities:
            try:
                _types, tag_blocks, _node_blocks = gmsh.model.mesh.getElements(3, entity)
            except Exception:
                continue
            for block in tag_blocks:
                for tag in block:
                    tag_to_marker[int(tag)] = int(phys_tag)
    if not tag_to_marker:
        return None
    return np.asarray([tag_to_marker.get(tag, 1) for tag in all_tags], dtype=np.int32)


def _extract_gmsh_connectivity(
    gmsh: Any,
    element_blocks: tuple[list[int], list[np.ndarray], list[np.ndarray]],
    node_index: dict[int, int],
    nodes_per_element: int,
) -> NDArray[np.int32]:
    element_types, _, node_tags_blocks = element_blocks
    rows: list[list[int]] = []
    for element_type, tags in zip(element_types, node_tags_blocks):
        _, _, _, num_nodes, _, num_primary_nodes = gmsh.model.mesh.getElementProperties(
            int(element_type)
        )
        if num_primary_nodes < nodes_per_element:
            raise ValueError(
                f"gmsh element type {element_type} exposes only {num_primary_nodes} "
                f"primary nodes, expected at least {nodes_per_element}"
            )
        flat = [node_index[int(tag)] for tag in tags]
        if len(flat) % num_nodes != 0:
            raise ValueError(
                f"gmsh connectivity for element type {element_type} has {len(flat)} "
                f"entries, not divisible by {num_nodes}"
            )
        for start in range(0, len(flat), num_nodes):
            element_nodes = flat[start : start + num_nodes]
            rows.append(element_nodes[:nodes_per_element])
    if not rows:
        return np.zeros((0, nodes_per_element), dtype=np.int32)
    return np.asarray(rows, dtype=np.int32)


# ---------------------------------------------------------------------------
# Adaptive remeshing with PostView background size field
# ---------------------------------------------------------------------------
