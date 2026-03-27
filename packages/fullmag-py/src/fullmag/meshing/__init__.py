"""Geometry asset, meshing, and voxelization helpers for backend lowering."""

from .asset_pipeline import realize_fdm_grid_asset, realize_fem_mesh_asset
from .gmsh_bridge import (
    MeshData,
    MeshOptions,
    MeshQualityReport,
    SizeFieldData,
    generate_box_mesh,
    generate_cylinder_mesh,
    generate_difference_mesh,
    generate_mesh,
    generate_mesh_from_file,
    remesh_with_size_field,
)
from .quality import MeshValidationReport, validate_mesh
from .surface_assets import SurfaceAsset, export_geometry_to_stl, load_surface_asset
from .voxelization import VoxelMaskData, voxelize_geometry

__all__ = [
    "MeshData",
    "MeshOptions",
    "MeshQualityReport",
    "MeshValidationReport",
    "SizeFieldData",
    "SurfaceAsset",
    "VoxelMaskData",
    "export_geometry_to_stl",
    "generate_box_mesh",
    "generate_cylinder_mesh",
    "generate_mesh",
    "generate_mesh_from_file",
    "load_surface_asset",
    "realize_fdm_grid_asset",
    "realize_fem_mesh_asset",
    "remesh_with_size_field",
    "validate_mesh",
    "voxelize_geometry",
]
