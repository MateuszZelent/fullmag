"""Thin re-export façade — all implementation lives in _gmsh_* submodules.

This module preserves the original ``from .gmsh_bridge import X`` contract
for every public and private symbol that was previously defined here.
"""

from __future__ import annotations

# ── Data classes, constants & configuration ──────────────────────────
from ._gmsh_types import (  # noqa: F401  — re-exports
    ALGO_2D_AUTOMATIC,
    ALGO_2D_BAMG,
    ALGO_2D_DELAUNAY,
    ALGO_2D_FRONTAL_DELAUNAY,
    ALGO_2D_FRONTAL_QUADS,
    ALGO_2D_MESHADAPT,
    ALGO_3D_DELAUNAY,
    ALGO_3D_FRONTAL,
    ALGO_3D_HXT,
    ALGO_3D_MMG3D,
    MESH_SIZE_CALIBRATIONS,
    MESH_SIZE_PRESETS,
    AirboxOptions,
    ComponentDescriptor,
    MeshData,
    MeshOptions,
    MeshQualityReport,
    MeshStatisticsReport,
    MeshStatisticsScope,
    SharedDomainMeshResult,
    SizeFieldData,
    resolve_mesh_size_controls,
)

# ── Gmsh wrapper infrastructure ─────────────────────────────────────
from ._gmsh_infra import (  # noqa: F401
    _GmshProgressLogger,
    _configure_gmsh_threads,
    _import_gmsh,
    _import_meshio,
    _normalize_gmsh_log_line,
    _normalize_scale_xyz,
    _peel_translate_chain,
    _resolve_gmsh_thread_count,
    _scale_mesh_nodes,
    _source_hmax_from_scale,
)

# ── Mesh data extraction ────────────────────────────────────────────
from ._gmsh_extraction import (  # noqa: F401
    _extract_gmsh_connectivity,
    _extract_mesh_data,
    _extract_quality_metrics,
    _first_cell_block,
    _read_mesh_file,
    extract_per_domain_quality,
)

# ── Size-field & mesh-option application ─────────────────────────────
from ._gmsh_fields import (  # noqa: F401
    _add_boundary_layer_field,
    _add_bounds_surface_threshold_field,
    _add_component_surface_threshold_field,
    _add_component_volume_constant_field,
    _add_narrow_region_field,
    _add_surface_threshold_field,
    _apply_mesh_options,
    _apply_post_mesh_options,
    _component_surface_tags_for_geometry,
    _component_volume_tags_for_geometry,
    _configure_mesh_size_fields,
    _match_surfaces_within_bounds,
)

# ── Airbox domain creation ──────────────────────────────────────────
from ._gmsh_airbox import (  # noqa: F401
    _add_airbox_and_fragment,
    _add_airbox_geo,
    _create_occ_geometry,
    _extract_airbox_mesh_data,
    add_air_box,
)

# ── Mesh generators ─────────────────────────────────────────────────
from ._gmsh_generators import (  # noqa: F401
    _add_geometry_to_occ,
    _build_stl_volume_model,
    _build_stl_volume_model_for_component,
    _generate_csg_mesh,
    _mesh_cad_file,
    _mesh_stl_surface,
    generate_box_mesh,
    generate_cylinder_mesh,
    generate_difference_mesh,
    generate_mesh,
    generate_mesh_from_file,
    generate_shared_domain_mesh_from_components,
)

# ── Adaptive remeshing ──────────────────────────────────────────────
from ._gmsh_remesh import (  # noqa: F401
    _apply_postview_background_mesh,
    _remesh_box,
    _remesh_csg,
    _remesh_cylinder,
    _remesh_imported,
    remesh_with_size_field,
)
