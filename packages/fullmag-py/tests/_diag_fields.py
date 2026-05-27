import numpy as np
import fullmag as fm
from fullmag.meshing._gmsh_occ import _component_interface_size_targets
from fullmag.meshing._size_field_plan import (
    _resolve_per_object_mesh_options,
    _mesh_options_from_runtime_metadata,
    _build_field_stack,
)
from fullmag.meshing.asset_pipeline import (
    _shared_domain_size_field_default_hmax,
    _strip_overridden_geometry_fields,
)
from fullmag.meshing._gmsh_types import MeshOptions, AirboxOptions
from fullmag.model.discretization import PerObjectMeshRecipe, SharedMeshAssemblyPolicy

cube = fm.Box((80e-9, 80e-9, 40e-9), name="cube")
cylinder = fm.Translate(
    fm.Cylinder(radius=40e-9, height=40e-9, name="cylinder_base"),
    (150e-9, 0.0, 0.0),
    name="cylinder",
)
geometries = [cube, cylinder]
per_object_recipes = {
    "cube": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
    "cylinder": PerObjectMeshRecipe(hmax=28e-9, hmin=8e-9),
}

airbox = AirboxOptions(
    size=(360e-9, 240e-9, 160e-9),
    center=(60e-9, 0.0, 0.0),
    maximum_element_size=160e-9,
    minimum_element_size=40e-9,
    grading_ratio=1.3,
)

size_field_default_hmax = _shared_domain_size_field_default_hmax(
    fm.FEM(order=1, hmax=80e-9), airbox
)
print(f"size_field_default_hmax = {size_field_default_hmax}")

mesh_options = _mesh_options_from_runtime_metadata(
    None,
    geometries=geometries,
    default_hmax=size_field_default_hmax,
    component_aware=True,
    per_object_recipes=per_object_recipes,
)

print(f"\n=== mesh_options.size_fields BEFORE recipe overlay ({len(mesh_options.size_fields)} fields) ===")
for i, f in enumerate(mesh_options.size_fields):
    print(f"  [{i}] {f}")

_policy = SharedMeshAssemblyPolicy()
recipe_fields = _resolve_per_object_mesh_options(
    geometries,
    per_object_recipes,
    _policy,
    default_hmax=size_field_default_hmax,
    component_aware=True,
)
print(f"\n=== recipe_fields ({len(recipe_fields)} fields) ===")
for i, f in enumerate(recipe_fields):
    print(f"  [{i}] {f}")

if recipe_fields:
    existing = _strip_overridden_geometry_fields(
        list(mesh_options.size_fields), per_object_recipes
    )
    from dataclasses import replace as _dc_replace
    mesh_options = _dc_replace(mesh_options, size_fields=recipe_fields + existing)

print(f"\n=== FINAL mesh_options.size_fields ({len(mesh_options.size_fields)} fields) ===")
for i, f in enumerate(mesh_options.size_fields):
    print(f"  [{i}] {f}")

targets = _component_interface_size_targets(mesh_options)
print(f"\n=== Interface size targets from _component_interface_size_targets ===")
print(f"  targets = {targets}")
for name, val in targets.items():
    print(f"  {name}: target={val} ({val*1e9:.2f} nm), target*SCALE={val*1e6}")
