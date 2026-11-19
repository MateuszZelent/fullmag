"""Regression: scoped thin-film airbox examples must reach the exact-layer route.

Scoped thin-film fields on a single Box with a shared-domain airbox are meshed
only by the exact-cell layered GEO route, which plans air z-layers with
geometric grading (note 0104).  Examples that kept the legacy ``"linear"``
universe grading were rejected during SceneDocument lowering with
``thin_film_scoped_fields_require_exact_cell_geometric_airbox`` before any
solver could run.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

import fullmag as fm
from fullmag.meshing._gmsh_swept import (
    _has_component_scoped_size_fields,
    _supports_scoped_layer_partitioned_box,
)
from fullmag.meshing._gmsh_types import MIXED_SHARED_GMSH_VERSION
from fullmag.meshing.asset_pipeline import (
    _mesh_options_from_runtime_metadata,
    _study_universe_airbox_options,
)
from fullmag.model.geometry import Box


EXAMPLES_ROOT = Path(__file__).resolve().parents[3] / "examples"

SCOPED_THIN_FILM_AIRBOX_EXAMPLES = (
    "fem_eigen_k0_poisson_airbox_production.py",
    "fem_eigen_k0_kittel_periodic_airbox.py",
    "fem_eigen_k0_kittel_periodic_airbox_gpu.py",
    "fem_frequency_response_gpu_floquet_airbox_unsupported_smoke.py",
    "fem_frequency_response_shared_domain_static_periodic_smoke.py",
)

# The K0 modal fixtures whose lowering is also realized with the qualified
# Gmsh build, so the test proves the layered route itself, not just its guard.
REALIZED_K0_EXAMPLES = (
    "fem_eigen_k0_poisson_airbox_production.py",
    "fem_eigen_k0_kittel_periodic_airbox.py",
)


def _load_problem(example: str):
    return fm.load_problem_from_script(
        EXAMPLES_ROOT / example,
        lightweight_assets=True,
    ).problem


def _qualified_gmsh_available() -> bool:
    if importlib.util.find_spec("gmsh") is None:
        return False
    import gmsh

    return str(getattr(gmsh, "__version__", "")) == MIXED_SHARED_GMSH_VERSION


@pytest.mark.parametrize("example", SCOPED_THIN_FILM_AIRBOX_EXAMPLES)
def test_example_universe_airbox_supports_scoped_layer_partitions(example: str) -> None:
    problem = _load_problem(example)
    geometries = [magnet.geometry for magnet in problem.magnets]
    assert len(geometries) == 1 and isinstance(geometries[0], Box)

    airbox = _study_universe_airbox_options(
        geometries,
        problem.runtime_metadata.get("study_universe"),
    )
    assert airbox is not None
    assert airbox.maximum_element_size is not None

    mesh_options = _mesh_options_from_runtime_metadata(
        problem.runtime_metadata.get("mesh_workflow"),
        geometries=geometries,
        default_hmax=float(airbox.maximum_element_size),
        component_aware=True,
    )
    # The examples deliberately request scoped thin-film refinement, so the
    # exact-layer guard applies to them.
    assert mesh_options.mesh_strategy == "thin_film_tetrahedral"
    assert _has_component_scoped_size_fields(mesh_options)

    assert airbox.grading_mode == "geometric"
    assert _supports_scoped_layer_partitioned_box(geometries[0], airbox=airbox)


@pytest.mark.skipif(
    not _qualified_gmsh_available(),
    reason=f"requires the qualified Gmsh {MIXED_SHARED_GMSH_VERSION}",
)
@pytest.mark.parametrize("example", REALIZED_K0_EXAMPLES)
def test_k0_airbox_example_lowers_through_exact_layer_route(example: str) -> None:
    ir = _load_problem(example).to_ir()

    domain_asset = ir["geometry_assets"]["fem_domain_mesh_asset"]
    report = domain_asset["build_report"]
    assert report["build_mode"] == "single_geometry_geo_layered_box"
    assert report["degraded"] is False
    assert report["fallbacks_triggered"] == []
    thin_film = [
        status for status in report["operation_statuses"] if status["kind"] == "thin_film"
    ]
    assert len(thin_film) == 1
    assert thin_film[0]["status"] == "applied"
    assert thin_film[0]["actual_method"] == "geo_layer_partitioned_tetrahedral"
    assert domain_asset["mesh"]["periodic_mesh_certificate"]
