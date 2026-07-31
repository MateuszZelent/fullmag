"""Canonical public-documentation information architecture manifest."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import argparse
import sys
from typing import Iterable


PUBLIC_DOCS_ROOT = Path(__file__).resolve().parents[1] / "public_docs" / "site"
VALID_STATUSES = frozenset({"implemented", "partial", "semantic-only", "unsupported", "planned"})
VALID_DOC_KINDS = frozenset({"scaffold", "reference"})
LEGACY_NAVIGATION_PATHS = frozenset(
    {
        "physics/conventions.md",
        "physics/geometry-and-materials.md",
    }
)

INTERACTION_SLUGS = (
    "exchange",
    "demagnetization",
    "zeeman",
    "anisotropy",
    "dmi",
    "thermal-noise",
    "magnetoelastic",
    "oersted-field",
    "spin-transfer-torque",
    "spin-orbit-torque",
    "drift-diffusion-spin-torque",
    "inter-region-couplings",
)
PYTHON_API_INTERACTION_SLUGS = (
    "exchange",
    "demagnetization",
    "zeeman",
    "uniaxial-anisotropy",
    "cubic-anisotropy",
    "interfacial-dmi",
    "bulk-dmi",
    "thermal-noise",
    "magnetoelastic",
    "oersted-field",
    "spin-transfer-torque",
    "spin-orbit-torque",
    "drift-diffusion-spin-torque",
    "inter-region-couplings",
)
DEMAGNETIZATION_SUBPAGES = (
    "mathematical-formulation",
    "boundary-conditions",
    "fdm-convolution",
    "fem-poisson-airbox",
    "fem-bem",
    "periodic-demag",
    "validation",
)
DEMAGNETIZATION_REFERENCE_PAGES = frozenset(
    {
        "physics/interactions/demagnetization/index.md",
        *(f"physics/interactions/demagnetization/{page}.md" for page in DEMAGNETIZATION_SUBPAGES),
    }
)
PHYSICS_REFERENCE_PAGES = frozenset(
    {
        *DEMAGNETIZATION_REFERENCE_PAGES,
        "physics/foundations/index.md",
        *(f"physics/foundations/{page}.md" for page in ("conventions-and-units", "micromagnetic-energy", "effective-field", "llg-equation", "boundary-conditions", "observables")),
        "physics/interactions/anisotropy/uniaxial.md",
        "physics/interactions/anisotropy/cubic.md",
        "physics/interactions/anisotropy/index.md",
        "physics/interactions/dmi/index.md",
        "physics/interactions/dmi/boundary-conditions.md",
        "physics/interactions/dmi/bulk.md",
        "physics/interactions/dmi/interfacial.md",
        "physics/interactions/dmi/validation.md",
        "physics/interactions/thermal-noise/index.md",
        "physics/interactions/zeeman/index.md",
        "physics/interactions/oersted-field/index.md",
        "physics/interactions/magnetoelastic/index.md",
        "physics/interactions/spin-transfer-torque/index.md",
        "physics/interactions/spin-orbit-torque/index.md",
        "physics/interactions/drift-diffusion-spin-torque/index.md",
        "physics/interactions/inter-region-couplings/index.md",
    }
)
NUMERICAL_METHODS_REFERENCE_PAGES = frozenset(
    {
        "numerical-methods/index.md",
        *(
            f"numerical-methods/{section}/{page}.md"
            for section, pages in {
                "time-integration": ("index", "explicit-runge-kutta", "adaptive-stepping", "tangent-plane-methods"),
                "relaxation": ("index", "llg-relaxation", "projected-gradient", "stopping-criteria"),
                "demag-solvers": ("index", "fdm-convolution"),
            }.items()
            for page in pages
        ),
    }
)
PHYSICS_REFERENCE_STATUSES = {
    "physics/interactions/drift-diffusion-spin-torque/index.md": "semantic-only",
}
DMI_SUBPAGES = (
    "interfacial",
    "bulk",
    "boundary-conditions",
    "validation",
)
ANISOTROPY_SUBPAGES = ("uniaxial", "cubic")

_CANONICAL_INTERACTION_PATHS = {
    "exchange": "physics/interactions/exchange/index.md",
    "demagnetization": "physics/interactions/demagnetization/index.md",
    "zeeman": "physics/interactions/zeeman/index.md",
    "uniaxial-anisotropy": "physics/interactions/anisotropy/uniaxial.md",
    "cubic-anisotropy": "physics/interactions/anisotropy/cubic.md",
    "interfacial-dmi": "physics/interactions/dmi/interfacial.md",
    "bulk-dmi": "physics/interactions/dmi/bulk.md",
    "thermal-noise": "physics/interactions/thermal-noise/index.md",
    "magnetoelastic": "physics/interactions/magnetoelastic/index.md",
    "oersted-field": "physics/interactions/oersted-field/index.md",
    "spin-transfer-torque": "physics/interactions/spin-transfer-torque/index.md",
    "spin-orbit-torque": "physics/interactions/spin-orbit-torque/index.md",
    "drift-diffusion-spin-torque": "physics/interactions/drift-diffusion-spin-torque/index.md",
    "inter-region-couplings": "physics/interactions/inter-region-couplings/index.md",
}
LEGACY_INTERACTION_REDIRECTS = {
    f"physics/solvers/{solver}/{backend}/interactions/{slug}.md": target
    for solver in ("fdm", "fem")
    for backend in ("cpu", "gpu")
    for slug, target in _CANONICAL_INTERACTION_PATHS.items()
}
LEGACY_NAVIGATION_REDIRECTS = {
    "physics/solvers/index.md": "physics/interactions/index.md",
    **{
        f"physics/solvers/{solver}/index.md": "physics/interactions/index.md"
        for solver in ("fdm", "fem")
    },
    **{
        f"physics/solvers/{solver}/{backend}/index.md": "physics/interactions/index.md"
        for solver in ("fdm", "fem")
        for backend in ("cpu", "gpu")
    },
    **{
        f"physics/solvers/{solver}/{backend}/interactions/index.md":
            "physics/interactions/index.md"
        for solver in ("fdm", "fem")
        for backend in ("cpu", "gpu")
    },
}
LEGACY_REDIRECTS = {
    **LEGACY_INTERACTION_REDIRECTS,
    **LEGACY_NAVIGATION_REDIRECTS,
    "physics/exchange-demag-zeeman.md": "physics/interactions/index.md",
}

_TITLES = {
    "api": "API",
    "cpu": "CPU",
    "cpw": "CPW",
    "dmi": "DMI",
    "fdm": "FDM",
    "fem": "FEM",
    "floquet": "Floquet",
    "ir": "IR",
    "llg": "LLG",
    "mumag": "µMAG",
    "oersted": "Oersted",
    "rf": "RF",
}
_INTERACTION_TITLES = {
    "exchange": "Exchange",
    "demagnetization": "Demagnetization",
    "zeeman": "Zeeman",
    "anisotropy": "Anisotropy",
    "dmi": "DMI",
    "uniaxial-anisotropy": "Uniaxial Anisotropy",
    "cubic-anisotropy": "Cubic Anisotropy",
    "interfacial-dmi": "Interfacial DMI",
    "bulk-dmi": "Bulk DMI",
    "thermal-noise": "Thermal Noise",
    "magnetoelastic": "Magnetoelastic",
    "oersted-field": "Oersted Field",
    "spin-transfer-torque": "Spin-Transfer Torque",
    "spin-orbit-torque": "Spin-Orbit Torque",
    "drift-diffusion-spin-torque": "Drift-Diffusion Spin Torque",
    "inter-region-couplings": "Inter-Region Couplings",
}
REFERENCE_PAGE_TITLES = {
    "physics/foundations/index.md": "Physics foundations",
    "physics/foundations/conventions-and-units.md": "Conventions and units",
    "physics/foundations/micromagnetic-energy.md": "Micromagnetic energy",
    "physics/foundations/effective-field.md": "Effective field",
    "physics/foundations/llg-equation.md": "Landau–Lifshitz–Gilbert equation",
    "physics/foundations/boundary-conditions.md": "Boundary conditions",
    "physics/foundations/observables.md": "Observables",
    "physics/interactions/dmi/index.md": "Dzyaloshinskii–Moriya interaction",
    "physics/interactions/dmi/boundary-conditions.md": "DMI boundary conditions",
    "physics/interactions/dmi/validation.md": "DMI validation",
    "physics/interactions/magnetoelastic/index.md": "Magnetoelastic interaction",
    "physics/interactions/spin-transfer-torque/index.md": "Spin-transfer torque",
    "physics/interactions/spin-orbit-torque/index.md": "Spin-orbit torque",
    "physics/interactions/drift-diffusion-spin-torque/index.md": "Drift-diffusion spin torque",
    "physics/interactions/inter-region-couplings/index.md": "Inter-region couplings",
    "physics/interactions/anisotropy/uniaxial.md": "Uniaxial anisotropy",
    "physics/interactions/anisotropy/cubic.md": "Cubic anisotropy",
    "physics/interactions/dmi/bulk.md": "Bulk Dzyaloshinskii–Moriya interaction",
    "physics/interactions/dmi/interfacial.md": "Interfacial Dzyaloshinskii–Moriya interaction",
    "physics/interactions/thermal-noise/index.md": "Thermal Brown noise",
    "physics/interactions/oersted-field/index.md": "Oersted field",
    "python-api/interactions/exchange.md": "Exchange Python API",
    "python-api/interactions/oersted-field.md": "Oersted field Python API",
    "python-api/interactions/spin-transfer-torque.md": "Spin-Transfer Torque Python API",
    "python-api/interactions/spin-orbit-torque.md": "Spin-Orbit Torque Python API",
    "python-api/interactions/magnetoelastic.md": "Magnetoelastic Python API",
    "physics/interactions/zeeman/index.md": "Zeeman interaction",
    "python-api/interactions/bulk-dmi.md": "Bulk DMI Python API",
    "python-api/interactions/zeeman.md": "Zeeman Python API",
    "python-api/interactions/uniaxial-anisotropy.md": "Uniaxial anisotropy Python API",
    "python-api/interactions/cubic-anisotropy.md": "Cubic anisotropy Python API",
    "python-api/interactions/interfacial-dmi.md": "Interfacial DMI Python API",
    "python-api/interactions/thermal-noise.md": "Thermal Noise Python API",
    "python-api/interactions/drift-diffusion-spin-torque.md": "Drift-diffusion spin torque Python API",
    "python-api/interactions/inter-region-couplings.md": "Inter-region couplings Python API",
}
REFERENCE_PAGE_LABELS = {
    "physics/interactions/zeeman/index.md": "public-docs-physics-interactions-zeeman",
    "physics/interactions/magnetoelastic/index.md": "public-docs-physics-interactions-magnetoelastic",
    "physics/interactions/spin-transfer-torque/index.md": "public-docs-physics-interactions-stt",
    "physics/interactions/spin-orbit-torque/index.md": "public-docs-physics-interactions-sot",
    "physics/interactions/drift-diffusion-spin-torque/index.md": "public-docs-physics-interactions-drift-diffusion-stt",
    "physics/interactions/inter-region-couplings/index.md": "public-docs-physics-interactions-inter-region-couplings",
    "python-api/interactions/oersted-field.md": "oersted-api-problem-statement",
    "python-api/interactions/spin-transfer-torque.md": "stt-api-problem-statement",
    "python-api/interactions/spin-orbit-torque.md": "sot-api-problem-statement",
    "python-api/interactions/magnetoelastic.md": "magnetoelastic-api-problem-statement",
}


@dataclass(frozen=True)
class PageSpec:
    path: str
    title: str
    label: str
    status: str
    doc_kind: str
    scope: str
    children: tuple[str, ...] = ()
    navigation_maxdepth: int = 1


def _title(slug: str) -> str:
    return " ".join(_TITLES.get(part, part.capitalize()) for part in slug.split("-"))


def _page_title(path: str, fallback: str) -> str:
    return REFERENCE_PAGE_TITLES.get(path, fallback)


def _label(path: str) -> str:
    return REFERENCE_PAGE_LABELS.get(
        path,
        "public-docs-" + path.removesuffix(".md").replace("/", "-").replace("index", "root"),
    )


def _scaffold(
    path: str,
    title: str,
    scope: str,
    children: tuple[str, ...] = (),
    navigation_maxdepth: int = 1,
    status: str = "planned",
) -> PageSpec:
    return PageSpec(
        path,
        title,
        _label(path),
        status,
        "scaffold",
        scope,
        children,
        navigation_maxdepth,
    )


def _reference(
    path: str,
    title: str,
    scope: str,
    children: tuple[str, ...] = (),
    navigation_maxdepth: int = 1,
    status: str = "partial",
) -> PageSpec:
    return PageSpec(
        path,
        title,
        _label(path),
        status,
        "reference",
        scope,
        children,
        navigation_maxdepth,
    )


PYTHON_API_REFERENCE_PAGES = {
    "python-api/problem/problem.md",
    "python-api/problem/problem-ir.md",
    "python-api/geometry/primitives.md",
    "python-api/materials/material.md",
    "python-api/materials/spatial-parameter-fields.md",
    "python-api/magnets-and-textures/ferromagnet.md",
    "python-api/magnets-and-textures/uniform-texture.md",
    "python-api/discretization/discretization-hints.md",
    "python-api/discretization/fdm.md",
    "python-api/discretization/fem.md",
    "python-api/dynamics/llg.md",
    "python-api/studies/time-evolution.md",
    "python-api/outputs/fields-and-scalars.md",
    "python-api/interactions/demagnetization.md",
    "python-api/interactions/bulk-dmi.md",
    "python-api/interactions/zeeman.md",
    "python-api/interactions/uniaxial-anisotropy.md",
    "python-api/interactions/cubic-anisotropy.md",
    "python-api/interactions/interfacial-dmi.md",
    "python-api/interactions/thermal-noise.md",
    "python-api/interactions/exchange.md",
    "python-api/interactions/oersted-field.md",
    "python-api/interactions/spin-transfer-torque.md",
    "python-api/interactions/spin-orbit-torque.md",
    "python-api/interactions/magnetoelastic.md",
    "python-api/interactions/drift-diffusion-spin-torque.md",
    "python-api/interactions/inter-region-couplings.md",
}


def _section(
    directory: str,
    title: str,
    pages: tuple[str, ...],
    scope: str,
) -> tuple[PageSpec, ...]:
    children = tuple(f"{directory}/{page}.md" for page in pages)
    index_path = f"{directory}/index.md"
    index_title = _page_title(index_path, title)
    index_reference = index_path in PHYSICS_REFERENCE_PAGES or index_path in PYTHON_API_REFERENCE_PAGES or index_path in NUMERICAL_METHODS_REFERENCE_PAGES
    return (
        (
            _reference(
                index_path,
                index_title,
                scope,
                children,
                status=PHYSICS_REFERENCE_STATUSES.get(index_path, "partial"),
            )
            if index_reference
            else _scaffold(index_path, index_title, scope, children)
        ),
        *(
            (_reference if f"{directory}/{page}.md" in PHYSICS_REFERENCE_PAGES or f"{directory}/{page}.md" in PYTHON_API_REFERENCE_PAGES or f"{directory}/{page}.md" in NUMERICAL_METHODS_REFERENCE_PAGES else _scaffold)(
                f"{directory}/{page}.md",
                _page_title(f"{directory}/{page}.md", _title(page)),
                f"the {title.lower()} reference for {_title(page)}",
            )
            for page in pages
        ),
    )


def _interaction_subtree(
    slug: str,
    title: str,
    subpages: tuple[str, ...] = (),
) -> tuple[PageSpec, ...]:
    directory = f"physics/interactions/{slug}"
    children = tuple(f"{directory}/{subpage}.md" for subpage in subpages)
    return (
        (_reference if f"{directory}/index.md" in PHYSICS_REFERENCE_PAGES else _scaffold)(
            f"{directory}/index.md",
            _page_title(f"{directory}/index.md", title),
            f"the canonical {title} interaction reference",
            children,
            status=(
                PHYSICS_REFERENCE_STATUSES.get(f"{directory}/index.md", "partial")
                if f"{directory}/index.md" in PHYSICS_REFERENCE_PAGES
                else "planned"
            ),
        ),
        *(
            (_reference if f"{directory}/{subpage}.md" in PHYSICS_REFERENCE_PAGES else _scaffold)(
                f"{directory}/{subpage}.md",
                _page_title(f"{directory}/{subpage}.md", _title(subpage)),
                f"the {title} reference for {_title(subpage)}",
            )
            for subpage in subpages
        ),
    )


PAGE_SPECS: tuple[PageSpec, ...] = (
    _reference(
        "index.md",
        "FullMag public documentation",
        "the FullMag public documentation portal",
        (
            "getting-started/index.md",
            "python-api/index.md",
            "physics/index.md",
            "numerical-methods/index.md",
            "validation/index.md",
            "architecture/index.md",
        ),
        4,
    ),
    _scaffold(
        "getting-started/index.md",
        "Getting started",
        "the getting-started documentation family",
        (
            "getting-started/installation.md",
            "getting-started/first-fdm-simulation.md",
            "getting-started/first-fem-simulation.md",
            "getting-started/choosing-a-solver.md",
        ),
    ),
    _scaffold("getting-started/installation.md", "Installation", "installation guidance"),
    _scaffold("getting-started/first-fdm-simulation.md", "First FDM Simulation", "the first FDM simulation guide"),
    _scaffold("getting-started/first-fem-simulation.md", "First FEM Simulation", "the first FEM simulation guide"),
    _scaffold("getting-started/choosing-a-solver.md", "Choosing a Solver", "solver-selection guidance"),
    _scaffold(
        "python-api/index.md",
        "Python API",
        "the Python API documentation family",
        (
            "python-api/problem/index.md",
            "python-api/geometry/index.md",
            "python-api/materials/index.md",
            "python-api/magnets-and-textures/index.md",
            "python-api/interactions/index.md",
            "python-api/current-and-excitations/index.md",
            "python-api/boundary-conditions/index.md",
            "python-api/discretization/index.md",
            "python-api/dynamics/index.md",
            "python-api/studies/index.md",
            "python-api/outputs/index.md",
            "python-api/runtime/index.md",
        ),
    ),
    *_section("python-api/problem", "Problem", ("problem", "validation", "problem-ir", "round-trip"), "the Python API Problem reference"),
    *_section("python-api/geometry", "Geometry", ("primitives", "transforms", "boolean-operations", "imported-geometry", "regions", "universe-and-domain", "auxiliary-geometry"), "the Python API geometry reference"),
    *_section("python-api/materials", "Materials", ("material", "spatial-parameter-fields", "elastic-materials", "magnetostriction-laws"), "the Python API materials reference"),
    *_section("python-api/magnets-and-textures", "Magnets and Textures", ("ferromagnet", "initial-magnetization", "uniform-texture", "preset-textures"), "the Python API magnets and textures reference"),
    _scaffold(
        "python-api/interactions/index.md",
        "Interactions",
        "the Python API interaction reference",
        tuple(
            f"python-api/interactions/{slug}.md"
            for slug in PYTHON_API_INTERACTION_SLUGS
        ),
    ),
    *(
        (_reference if f"python-api/interactions/{slug}.md" in PYTHON_API_REFERENCE_PAGES else _scaffold)(
            f"python-api/interactions/{slug}.md",
            _page_title(f"python-api/interactions/{slug}.md", _INTERACTION_TITLES[slug]),
            f"the Python API reference for {_INTERACTION_TITLES[slug]}",
        )
        for slug in PYTHON_API_INTERACTION_SLUGS
    ),
    *_section("python-api/current-and-excitations", "Current and Excitations", ("current-transport", "prescribed-current", "regional-field-drive", "rf-drive", "microstrip-antenna", "cpw-antenna"), "the Python API current and excitations reference"),
    *_section("python-api/boundary-conditions", "Boundary Conditions", ("periodic-boundary-conditions", "floquet-boundary-conditions", "mechanical-boundary-conditions"), "the Python API boundary-conditions reference"),
    *_section("python-api/discretization", "Discretization", ("discretization-hints", "fdm", "fem", "hybrid", "mesh-controls", "per-object-meshing"), "the Python API discretization reference"),
    *_section("python-api/dynamics", "Dynamics", ("llg", "integrators", "adaptive-timestep", "field-refresh"), "the Python API dynamics reference"),
    *_section("python-api/studies", "Studies", ("time-evolution", "relaxation", "hysteresis", "eigenmodes", "frequency-response"), "the Python API studies reference"),
    *_section("python-api/outputs", "Outputs", ("fields-and-scalars", "quantities", "modes-and-spectra", "dispersion-and-response", "snapshots", "autosave"), "the Python API outputs reference"),
    *_section("python-api/runtime", "Runtime", ("runtime-selection", "backend-policy", "simulation", "results", "artifacts", "provenance"), "the Python API runtime reference"),
    _reference(
        "physics/index.md",
        "Physics reference",
        "the physics documentation family",
        (
            "physics/foundations/index.md",
            "physics/interactions/index.md",
            "physics/conventions.md",
            "physics/geometry-and-materials.md",
        ),
    ),
    *_section("physics/foundations", "Physics foundations", ("conventions-and-units", "micromagnetic-energy", "effective-field", "llg-equation", "boundary-conditions", "observables"), "the physics foundations reference"),
    _scaffold(
        "physics/interactions/index.md",
        "Physical Interactions",
        "the canonical physical-interaction documentation family",
        tuple(f"physics/interactions/{slug}/index.md" for slug in INTERACTION_SLUGS),
    ),
    PageSpec(
        "physics/interactions/exchange/index.md",
        "Exchange interaction",
        "public-docs-physics-exchange",
        "partial",
        "reference",
        "the canonical Exchange physics reference",
    ),
    *_interaction_subtree(
        "demagnetization", "Demagnetization", DEMAGNETIZATION_SUBPAGES
    ),
    *_interaction_subtree("anisotropy", "Anisotropy", ANISOTROPY_SUBPAGES),
    *_interaction_subtree("dmi", "DMI", DMI_SUBPAGES),
    *(
            (_reference if f"physics/interactions/{slug}/index.md" in PHYSICS_REFERENCE_PAGES else _scaffold)(
            f"physics/interactions/{slug}/index.md",
            _page_title(f"physics/interactions/{slug}/index.md", _INTERACTION_TITLES[slug]),
            f"the canonical {_INTERACTION_TITLES[slug]} interaction reference",
            status=(
                PHYSICS_REFERENCE_STATUSES.get(f"physics/interactions/{slug}/index.md", "partial")
                if f"physics/interactions/{slug}/index.md" in PHYSICS_REFERENCE_PAGES
                else "planned"
            ),
        )
        for slug in INTERACTION_SLUGS
        if slug not in {"exchange", "demagnetization", "anisotropy", "dmi"}
    ),
    _reference(
        "numerical-methods/index.md",
        "Numerical Methods",
        "the numerical-methods documentation family",
        (
            "numerical-methods/time-integration/index.md",
            "numerical-methods/relaxation/index.md",
            "numerical-methods/demag-solvers/index.md",
            "numerical-methods/eigensolvers/index.md",
            "numerical-methods/frequency-domain/index.md",
            "numerical-methods/meshing/index.md",
            "numerical-methods/interpolation-and-state-transfer/index.md",
        ),
        status="partial",
    ),
    *_section("numerical-methods/time-integration", "Time Integration", ("explicit-runge-kutta", "adaptive-stepping", "tangent-plane-methods"), "the time-integration methods reference"),
    *_section("numerical-methods/relaxation", "Relaxation", ("llg-relaxation", "projected-gradient", "stopping-criteria"), "the relaxation methods reference"),
    *_section("numerical-methods/demag-solvers", "Demag Solvers", ("fdm-convolution", "fem-poisson-airbox", "fem-bem", "periodic-demag"), "the demagnetization-solvers reference"),
    *_section("numerical-methods/eigensolvers", "Eigensolvers", ("linearized-llg", "modal-validation"), "the eigensolvers reference"),
    *_section("numerical-methods/frequency-domain", "Frequency Domain", ("response-solver", "floquet-response"), "the frequency-domain methods reference"),
    *_section("numerical-methods/meshing", "Meshing", ("fdm-grids", "fem-shared-domain", "airbox", "swept-meshes", "refinement"), "the meshing methods reference"),
    *_section("numerical-methods/interpolation-and-state-transfer", "Interpolation and State Transfer", ("fem-to-fdm", "fdm-to-fem"), "the interpolation and state-transfer reference"),
    _scaffold(
        "validation/index.md",
        "Validation",
        "the validation documentation family",
        (
            "validation/analytical-cases.md",
            "validation/mumag-standard-problems.md",
            "validation/cpu-gpu-parity.md",
            "validation/fem-fdm-comparison.md",
            "validation/qualification-status.md",
        ),
    ),
    _scaffold("validation/analytical-cases.md", "Analytical Cases", "analytical validation cases"),
    _scaffold("validation/mumag-standard-problems.md", "µMAG Standard Problems", "µMAG standard-problem validation"),
    _scaffold("validation/cpu-gpu-parity.md", "CPU GPU Parity", "CPU/GPU parity validation"),
    _scaffold("validation/fem-fdm-comparison.md", "FEM FDM Comparison", "FEM/FDM comparison validation"),
    _scaffold("validation/qualification-status.md", "Qualification Status", "qualification status"),
    _reference(
        "architecture/index.md",
        "FullMag architecture",
        "the public architecture documentation family",
        (
            "architecture/product.md",
            "architecture/semantic-model.md",
            "architecture/runtime.md",
            "architecture/planner-and-capabilities.md",
            "architecture/provenance.md",
        ),
    ),
    _reference("architecture/product.md", "Product architecture", "the public product architecture reference"),
    _reference("architecture/semantic-model.md", "Canonical semantic model", "the canonical semantic-model reference"),
    _reference("architecture/runtime.md", "Runtime and provenance", "the runtime and provenance reference"),
    _scaffold("architecture/planner-and-capabilities.md", "Planner and Capabilities", "the planner and capabilities reference"),
    _scaffold("architecture/provenance.md", "Provenance", "the provenance reference"),
)


def _relative_child(parent_path: str, child_path: str) -> str:
    parent = PurePosixPath(parent_path).parent
    return str(PurePosixPath(child_path).relative_to(parent).with_suffix(""))


def _expected_direct_children(index: PageSpec, specs: Iterable[PageSpec]) -> tuple[str, ...]:
    parent = PurePosixPath(index.path).parent
    expected = []
    for spec in specs:
        if spec.path == index.path:
            continue
        try:
            relative = PurePosixPath(spec.path).relative_to(parent)
        except ValueError:
            continue
        if len(relative.parts) == 1 or (
            len(relative.parts) == 2 and relative.name == "index.md"
        ):
            expected.append(spec.path)
    expected.extend(
        path
        for path in LEGACY_NAVIGATION_PATHS
        if PurePosixPath(path).parent == parent
    )
    return tuple(expected)


def validate_tree(specs: Iterable[PageSpec]) -> list[str]:
    specs = tuple(specs)
    errors: list[str] = []
    paths = [spec.path for spec in specs]
    labels = [spec.label for spec in specs]
    if len(paths) != len(set(paths)):
        errors.append("manifest paths must be unique")
    if len(labels) != len(set(labels)):
        errors.append("manifest labels must be unique")
    known_paths = set(paths)
    for spec in specs:
        if spec.status not in VALID_STATUSES:
            errors.append(f"{spec.path}: unrecognized status {spec.status!r}")
        if spec.doc_kind not in VALID_DOC_KINDS:
            errors.append(f"{spec.path}: unrecognized doc_kind {spec.doc_kind!r}")
        if spec.navigation_maxdepth < 1:
            errors.append(f"{spec.path}: navigation_maxdepth must be positive")
        if len(spec.children) != len(set(spec.children)):
            errors.append(f"{spec.path}: child navigation contains duplicates")
        for child in spec.children:
            if child not in known_paths and child not in LEGACY_NAVIGATION_PATHS:
                errors.append(f"{spec.path}: child {child!r} is not declared")
        if not spec.path.endswith("index.md") and spec.children:
            errors.append(f"{spec.path}: terminal pages cannot have children")
    return errors


def render_page(spec: PageSpec, root: Path) -> str:
    if spec.doc_kind != "scaffold":
        raise ValueError(f"{spec.path}: only scaffolds have a canonical rendered body")
    rendered = (
        f"---\n"
        f"title: {spec.title}\n"
        f"status: {spec.status}\n"
        f"doc_kind: scaffold\n"
        f"audience: user\n"
        f"owner: fullmag-public-docs\n"
        f"---\n\n"
        f"({spec.label})=\n"
        f"# {spec.title}\n\n"
        f"This page reserves the public documentation location for {spec.scope}.\n"
    )
    if spec.children:
        navigation = "\n".join(_relative_child(spec.path, child) for child in spec.children)
        rendered += (
            f"\n```{{toctree}}\n:maxdepth: {spec.navigation_maxdepth}\n\n"
            f"{navigation}\n```\n"
        )
    return rendered


def write_pages(specs: Iterable[PageSpec], root: Path) -> None:
    for spec in specs:
        path = root / spec.path
        if spec.doc_kind == "reference":
            if not path.is_file():
                raise FileNotFoundError(f"{path}: reference page is missing")
            continue
        rendered = render_page(spec, root)
        if path.exists():
            if path.read_text() != rendered:
                raise FileExistsError(f"{path}: existing scaffold would need replacement")
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered)


def _front_matter(path: Path) -> dict[str, str] | None:
    lines = path.read_text().splitlines()
    if not lines or lines[0] != "---":
        return None
    metadata: dict[str, str] = {}
    for line in lines[1:]:
        if line == "---":
            return metadata
        if ":" not in line:
            return None
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip()
    return None


def _myst_toctree_entries(text: str) -> tuple[str, ...]:
    """Return explicit entries from fenced MyST ``toctree`` directives."""
    entries: list[str] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        if lines[index].strip() != "```{toctree}":
            index += 1
            continue
        index += 1
        while index < len(lines) and lines[index].strip() != "```":
            entry = lines[index].strip()
            if entry and not entry.startswith(":"):
                entries.append(entry)
            index += 1
        index += 1
    return tuple(entries)


def check_pages(specs: Iterable[PageSpec], root: Path) -> list[str]:
    errors = validate_tree(specs)
    for spec in specs:
        path = root / spec.path
        if not path.is_file():
            errors.append(f"missing page: {spec.path}")
            continue
        if spec.doc_kind == "scaffold":
            if path.read_text() != render_page(spec, root):
                errors.append(f"scaffold does not match manifest: {spec.path}")
            continue
        metadata = _front_matter(path)
        if metadata is None:
            errors.append(f"reference has invalid front matter: {spec.path}")
            continue
        for key, expected in {
            "title": spec.title,
            "status": spec.status,
            "doc_kind": spec.doc_kind,
        }.items():
            if metadata.get(key) != expected:
                errors.append(f"reference metadata {key!r} does not match manifest: {spec.path}")
        text = path.read_text()
        if f"({spec.label})=" not in text:
            errors.append(f"reference label does not match manifest: {spec.path}")
        if spec.children:
            expected_navigation = tuple(
                _relative_child(spec.path, child) for child in spec.children
            )
            if expected_navigation != _myst_toctree_entries(text):
                errors.append(f"reference navigation does not match manifest: {spec.path}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--write", action="store_true")
    parser.add_argument("--root", type=Path, default=PUBLIC_DOCS_ROOT)
    args = parser.parse_args(argv)
    if args.write:
        try:
            write_pages(PAGE_SPECS, args.root)
        except (FileExistsError, FileNotFoundError) as error:
            print(error, file=sys.stderr)
            return 1
        return 0
    errors = check_pages(PAGE_SPECS, args.root)
    for error in errors:
        print(error, file=sys.stderr)
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
