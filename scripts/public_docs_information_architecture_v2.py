"""Owner-oriented public-documentation information architecture.

This module extends the historical FullMag documentation manifest without changing the
canonical ownership of physics pages.  It adds three first-class user-facing branches:
Frontend, Backend, and Python API.  Meshing is then split consistently into FDM and FEM,
with FEM further divided into shared-domain, ferromagnet, and airbox concerns.
"""

from __future__ import annotations

from dataclasses import replace

import public_docs_information_architecture as legacy
from public_docs_information_architecture import (  # re-exported for existing tooling/tests
    INTERACTION_SLUGS,
    LEGACY_REDIRECTS,
    PAGE_SPECS as LEGACY_PAGE_SPECS,
    PUBLIC_DOCS_ROOT,
    PageSpec,
    check_pages,
    render_page,
    validate_tree,
    write_pages,
)


def _label(path: str) -> str:
    return "public-docs-" + path.removesuffix(".md").replace("/", "-").replace("index", "root")


def _reference(
    path: str,
    title: str,
    scope: str,
    children: tuple[str, ...] = (),
    navigation_maxdepth: int = 1,
    status: str = "partial",
) -> PageSpec:
    return PageSpec(
        path=path,
        title=title,
        label=_label(path),
        status=status,
        doc_kind="reference",
        scope=scope,
        children=children,
        navigation_maxdepth=navigation_maxdepth,
    )


ROOT_CHILDREN = (
    "getting-started/index.md",
    "frontend/index.md",
    "python-api/index.md",
    "backend/index.md",
    "physics/index.md",
    "validation/index.md",
)

PYTHON_API_CHILDREN = (
    "python-api/problem/index.md",
    "python-api/geometry/index.md",
    "python-api/materials/index.md",
    "python-api/magnets-and-textures/index.md",
    "python-api/interactions/index.md",
    "python-api/current-and-excitations/index.md",
    "python-api/boundary-conditions/index.md",
    "python-api/meshing/index.md",
    "python-api/dynamics/index.md",
    "python-api/studies/index.md",
    "python-api/outputs/index.md",
    "python-api/runtime/index.md",
    "python-api/discretization/index.md",
)

FRONTEND_SPECS = (
    _reference(
        "frontend/index.md",
        "Frontend",
        "the FullMag browser frontend and Control Room documentation family",
        (
            "frontend/control-room/index.md",
            "frontend/viewport/index.md",
            "frontend/workflows/index.md",
        ),
        4,
    ),
    _reference(
        "frontend/control-room/index.md",
        "Control Room",
        "the Control Room authoring and inspection interface",
        (
            "frontend/control-room/model-tree.md",
            "frontend/control-room/inspector.md",
            "frontend/control-room/meshing/index.md",
        ),
        3,
    ),
    _reference(
        "frontend/control-room/model-tree.md",
        "Model Tree",
        "the semantic model-tree ownership and selection workflow",
    ),
    _reference(
        "frontend/control-room/inspector.md",
        "Inspector And Draft Transactions",
        "the Inspector draft, apply, revert, and stale-resource lifecycle",
    ),
    _reference(
        "frontend/control-room/meshing/index.md",
        "Meshing In Control Room",
        "the frontend meshing workflow for FDM and FEM",
        (
            "frontend/control-room/meshing/fdm.md",
            "frontend/control-room/meshing/fem/index.md",
        ),
        3,
    ),
    _reference(
        "frontend/control-room/meshing/fdm.md",
        "FDM Grid Inspector",
        "the read-only FDM grid, mask, and region-membership frontend",
    ),
    _reference(
        "frontend/control-room/meshing/fem/index.md",
        "FEM Mesh Controls",
        "the Control Room FEM mesh authoring and diagnostics family",
        (
            "frontend/control-room/meshing/fem/object-mesh.md",
            "frontend/control-room/meshing/fem/airbox-mesh.md",
            "frontend/control-room/meshing/fem/region-mesh.md",
            "frontend/control-room/meshing/fem/build-and-quality.md",
        ),
        2,
    ),
    _reference(
        "frontend/control-room/meshing/fem/object-mesh.md",
        "Ferromagnet Mesh Panel",
        "object-owned FEM mesh policy controls",
    ),
    _reference(
        "frontend/control-room/meshing/fem/airbox-mesh.md",
        "Airbox Mesh Panel",
        "universe and airbox FEM mesh policy controls",
    ),
    _reference(
        "frontend/control-room/meshing/fem/region-mesh.md",
        "Region Mesh Panel",
        "region-owned FEM refinement and quality controls",
    ),
    _reference(
        "frontend/control-room/meshing/fem/build-and-quality.md",
        "Mesh Build And Quality Workflow",
        "mesh-build commands, stale-state semantics, reports, and quality views",
    ),
    _reference(
        "frontend/viewport/index.md",
        "Viewport And Mesh Visualization",
        "frontend visualization of geometry, solver meshes, airbox, regions, and quality",
    ),
    _reference(
        "frontend/workflows/index.md",
        "Frontend Workflows",
        "end-to-end authoring, build, execution, and inspection workflows",
    ),
)

BACKEND_SPECS = (
    _reference(
        "backend/index.md",
        "Backend",
        "the numerical backend, runtime, and execution-contract documentation family",
        (
            "backend/meshing/index.md",
            "numerical-methods/index.md",
            "architecture/index.md",
        ),
        5,
    ),
    _reference(
        "backend/meshing/index.md",
        "Backend Meshing",
        "backend grid and mesh generation, extraction, and qualification",
        (
            "backend/meshing/fdm/index.md",
            "backend/meshing/fem/index.md",
            "backend/meshing/state-transfer.md",
        ),
        4,
    ),
    _reference(
        "backend/meshing/fdm/index.md",
        "FDM Meshing Backend",
        "structured FDM grid realization",
        (
            "backend/meshing/fdm/cartesian-grids.md",
            "backend/meshing/fdm/multilayer-grids.md",
            "backend/meshing/fdm/boundary-corrections.md",
        ),
        2,
    ),
    _reference(
        "backend/meshing/fdm/cartesian-grids.md",
        "Cartesian Grids",
        "cell-centred Cartesian grid construction and masks",
    ),
    _reference(
        "backend/meshing/fdm/multilayer-grids.md",
        "Multilayer And Common Grids",
        "per-magnet native grids and common convolution grids",
    ),
    _reference(
        "backend/meshing/fdm/boundary-corrections.md",
        "FDM Boundary Corrections",
        "binary, volume-fraction, and embedded-boundary grid policies",
    ),
    _reference(
        "backend/meshing/fem/index.md",
        "FEM Meshing Backend",
        "conforming FEM mesh generation and extraction",
        (
            "backend/meshing/fem/shared-domain/index.md",
            "backend/meshing/fem/ferromagnet/index.md",
            "backend/meshing/fem/airbox/index.md",
            "backend/meshing/fem/quality-and-provenance.md",
        ),
        3,
    ),
    _reference(
        "backend/meshing/fem/shared-domain/index.md",
        "FEM Shared Domain",
        "shared magnetic and nonmagnetic domain construction",
        (
            "backend/meshing/fem/shared-domain/assembly.md",
            "backend/meshing/fem/shared-domain/attributes-and-interfaces.md",
            "backend/meshing/fem/shared-domain/periodic-pairs.md",
        ),
        2,
    ),
    _reference(
        "backend/meshing/fem/shared-domain/assembly.md",
        "Shared-Domain Assembly",
        "CAD fragmentation, conformity, and build-mode selection",
    ),
    _reference(
        "backend/meshing/fem/shared-domain/attributes-and-interfaces.md",
        "Attributes And Interfaces",
        "region attributes, boundary markers, interfaces, and magnetic submeshes",
    ),
    _reference(
        "backend/meshing/fem/shared-domain/periodic-pairs.md",
        "Periodic Pairing",
        "periodic and Floquet face-pair topology",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/index.md",
        "Ferromagnet Meshes",
        "FEM meshing of magnetic bodies",
        (
            "backend/meshing/fem/ferromagnet/free-tetrahedral.md",
            "backend/meshing/fem/ferromagnet/thin-film-tetrahedral.md",
            "backend/meshing/fem/ferromagnet/swept-prism.md",
            "backend/meshing/fem/ferromagnet/swept-hex.md",
            "backend/meshing/fem/ferromagnet/boundary-layers.md",
            "backend/meshing/fem/ferromagnet/imported-mesh.md",
            "backend/meshing/fem/ferromagnet/refinement.md",
        ),
        2,
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/free-tetrahedral.md",
        "Free Tetrahedral Mesh",
        "general unstructured tetrahedral meshing of magnetic bodies",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/thin-film-tetrahedral.md",
        "Thin-Film Tetrahedral Mesh",
        "thickness-aware tetrahedral meshing",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/swept-prism.md",
        "Swept Prism Mesh",
        "exact layered prism meshing and pyramid-to-tetrahedron transition",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/swept-hex.md",
        "Swept Hexahedral Mesh",
        "represented swept-hexahedral topology and its capability boundary",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/boundary-layers.md",
        "Boundary-Layer Meshes",
        "selector-driven boundary-layer generation",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/imported-mesh.md",
        "Imported FEM Mesh",
        "prebuilt mesh ingestion and semantic validation",
    ),
    _reference(
        "backend/meshing/fem/ferromagnet/refinement.md",
        "Ferromagnet Refinement",
        "bulk, interface, edge, corner, and region refinement",
    ),
    _reference(
        "backend/meshing/fem/airbox/index.md",
        "Airbox Mesh",
        "nonmagnetic exterior-domain meshing",
        (
            "backend/meshing/fem/airbox/geometry.md",
            "backend/meshing/fem/airbox/grading.md",
            "backend/meshing/fem/airbox/boundary-conditions.md",
        ),
        2,
    ),
    _reference(
        "backend/meshing/fem/airbox/geometry.md",
        "Airbox Geometry",
        "box and sphere exterior geometry, padding, size, and centre",
    ),
    _reference(
        "backend/meshing/fem/airbox/grading.md",
        "Airbox Grading",
        "near-body, transition, and far-field size policies",
    ),
    _reference(
        "backend/meshing/fem/airbox/boundary-conditions.md",
        "Airbox Boundary Markers And Closure",
        "outer markers and compatibility with Dirichlet, Robin, periodic, and Floquet operators",
    ),
    _reference(
        "backend/meshing/fem/quality-and-provenance.md",
        "FEM Mesh Quality And Provenance",
        "quality gates, requested-versus-realized evidence, and mesh identity",
    ),
    _reference(
        "backend/meshing/state-transfer.md",
        "Mesh State Transfer",
        "FEM/FDM continuation and interpolation between spatial representations",
    ),
)

PYTHON_MESHING_SPECS = (
    _reference(
        "python-api/meshing/index.md",
        "Meshing",
        "the public Python meshing API family",
        (
            "python-api/meshing/fdm/index.md",
            "python-api/meshing/fem/index.md",
            "python-api/meshing/shared-controls.md",
        ),
        4,
    ),
    _reference(
        "python-api/meshing/shared-controls.md",
        "Shared Mesh Controls",
        "mesh-size calibration, presets, common aliases, and precedence",
    ),
    _reference(
        "python-api/meshing/fdm/index.md",
        "FDM Meshing",
        "the Python API for structured FDM grids",
        (
            "python-api/meshing/fdm/grids.md",
            "python-api/meshing/fdm/multilayer-convolution.md",
            "python-api/meshing/fdm/boundary-corrections.md",
        ),
        2,
    ),
    _reference(
        "python-api/meshing/fdm/grids.md",
        "FDM Grid API",
        "default and per-magnet Cartesian grid authoring",
    ),
    _reference(
        "python-api/meshing/fdm/multilayer-convolution.md",
        "FDM Multilayer Grid API",
        "common-grid and multilayer demagnetization authoring",
    ),
    _reference(
        "python-api/meshing/fdm/boundary-corrections.md",
        "FDM Boundary-Correction API",
        "boundary correction parameters and validation",
    ),
    _reference(
        "python-api/meshing/fem/index.md",
        "FEM Meshing",
        "the Python API for FEM mesh authoring",
        (
            "python-api/meshing/fem/study-defaults.md",
            "python-api/meshing/fem/ferromagnet/index.md",
            "python-api/meshing/fem/airbox/index.md",
            "python-api/meshing/fem/build-and-reports.md",
        ),
        3,
    ),
    _reference(
        "python-api/meshing/fem/study-defaults.md",
        "FEM Study Defaults",
        "study-level FEM order, element-size target, and imported-mesh defaults",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/index.md",
        "Ferromagnet Meshing API",
        "object-owned FEM meshing",
        (
            "python-api/meshing/fem/ferromagnet/tetrahedral.md",
            "python-api/meshing/fem/ferromagnet/thin-film.md",
            "python-api/meshing/fem/ferromagnet/swept-prism.md",
            "python-api/meshing/fem/ferromagnet/swept-hex.md",
            "python-api/meshing/fem/ferromagnet/boundary-layers.md",
            "python-api/meshing/fem/ferromagnet/imported-mesh.md",
            "python-api/meshing/fem/ferromagnet/refinement.md",
        ),
        2,
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/tetrahedral.md",
        "Tetrahedral Mesh API",
        "free and ordinary tetrahedral object-mesh authoring",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/thin-film.md",
        "Thin-Film Mesh API",
        "thin-film helper and through-thickness controls",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/swept-prism.md",
        "Swept-Prism Mesh API",
        "strict layered-prism authoring",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/swept-hex.md",
        "Swept-Hex Mesh API",
        "represented swept-hexahedral authoring and capability limits",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/boundary-layers.md",
        "Boundary-Layer Mesh API",
        "boundary-layer controls and selectors",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/imported-mesh.md",
        "Imported-Mesh API",
        "study and object mesh-source authoring",
    ),
    _reference(
        "python-api/meshing/fem/ferromagnet/refinement.md",
        "Refinement API",
        "bulk, interface, edge, corner, region, and operation-sequence controls",
    ),
    _reference(
        "python-api/meshing/fem/airbox/index.md",
        "Airbox Meshing API",
        "universe-owned airbox geometry and mesh authoring",
        (
            "python-api/meshing/fem/airbox/geometry.md",
            "python-api/meshing/fem/airbox/grading.md",
        ),
        2,
    ),
    _reference(
        "python-api/meshing/fem/airbox/geometry.md",
        "Airbox Geometry API",
        "domain mode, padding, explicit size, and centre",
    ),
    _reference(
        "python-api/meshing/fem/airbox/grading.md",
        "Airbox Grading API",
        "airbox hmin, hmax, growth, curvature, and narrow-region controls",
    ),
    _reference(
        "python-api/meshing/fem/build-and-reports.md",
        "FEM Mesh Build And Reports API",
        "mesh materialization, invalidation, reports, quality, and provenance",
    ),
)

_REPLACEMENTS = {
    "index.md": replace(
        next(spec for spec in LEGACY_PAGE_SPECS if spec.path == "index.md"),
        title="FullMag documentation",
        children=ROOT_CHILDREN,
        navigation_maxdepth=5,
    ),
    "python-api/index.md": replace(
        next(spec for spec in LEGACY_PAGE_SPECS if spec.path == "python-api/index.md"),
        children=PYTHON_API_CHILDREN,
        navigation_maxdepth=4,
    ),
}

PAGE_SPECS: tuple[PageSpec, ...] = (
    *( _REPLACEMENTS.get(spec.path, spec) for spec in LEGACY_PAGE_SPECS ),
    *FRONTEND_SPECS,
    *BACKEND_SPECS,
    *PYTHON_MESHING_SPECS,
)


__all__ = [
    "INTERACTION_SLUGS",
    "LEGACY_REDIRECTS",
    "PAGE_SPECS",
    "PUBLIC_DOCS_ROOT",
    "PageSpec",
    "check_pages",
    "render_page",
    "validate_tree",
    "write_pages",
]
