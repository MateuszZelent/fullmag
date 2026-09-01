from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path("public_docs/site/numerical-methods/meshing")
SOURCE_REVISION = "4360b9353af3e1209499b9932c1f6abad7067178"
BEGIN = "<!-- FULLMAG_MESHING_V3_BEGIN -->"
END = "<!-- FULLMAG_MESHING_V3_END -->"

spec_path = Path(__file__).with_name("_tmp_meshing_docs_v3_specs_20260824.py")
module_spec = importlib.util.spec_from_file_location("meshing_docs_v3_specs", spec_path)
if module_spec is None or module_spec.loader is None:
    raise RuntimeError(f"cannot load {spec_path}")
S = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(S)


def slugify(path: str) -> str:
    slug = path.removesuffix(".md").replace("/", "-")
    slug = re.sub(r"[^a-zA-Z0-9-]+", "-", slug).strip("-").lower()
    return slug or "index"


def indent(lines: list[str], prefix: str = "    ") -> str:
    return "\n".join(prefix + line if line else prefix.rstrip() for line in lines)


def example_code(kind: str, path: str) -> str:
    slug = slugify(path).replace("-", "_")
    common_material = """film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)"""
    stage = """study.exchange()
study.demag(realization=\"poisson_robin\" if study.engine_name == \"fem\" else \"fft\")
study.stages.add_relax(
    stage_id=\"equilibrium\",
    algorithm=\"llg_overdamped\",
    tolA=1.0e-4,
    max_steps=20_000,
)"""

    if kind == "general":
        return """import fullmag as fm

nm = 1.0e-9


def make_fdm_study() -> object:
    study = fm.study("meshing_fdm_reference")
    study.engine("fdm")
    study.device("cpu", precision="double")
    study.mode("strict")
    film = study.geometry(
        fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
        name="film",
    )
    study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 4 * nm))
    film.Ms = 800.0e3
    film.Aex = 13.0e-12
    film.alpha = 0.02
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()
    study.demag(realization="fft")
    study.stages.add_relax(stage_id="equilibrium", tolA=1.0e-4, max_steps=20_000)
    return study


def make_fem_study() -> object:
    study = fm.study("meshing_fem_reference")
    study.engine("fem")
    study.device("cpu", precision="double")
    study.mode("strict")
    study.universe(mode="manual", size=(700 * nm, 500 * nm, 250 * nm))
    study.universe.mesh(
        minimum_element_size=12 * nm,
        maximum_element_size=80 * nm,
        maximum_element_growth_rate=1.5,
        grading="geometric",
    )
    film = study.geometry(
        fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
        name="film",
    )
    film.mesh(
        mesh_strategy="free_tetrahedral",
        minimum_element_size=3 * nm,
        maximum_element_size=7 * nm,
        order=1,
        compute_quality=True,
        per_element_quality=True,
    )
    film.Ms = 800.0e3
    film.Aex = 13.0e-12
    film.alpha = 0.02
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)
    study.exchange()
    study.demag(realization="poisson_robin")
    study.build_domain_mesh()
    study.stages.add_relax(stage_id="equilibrium", tolA=1.0e-4, max_steps=20_000)
    return study

fdm_study = make_fdm_study()
fem_study = make_fem_study()"""

    if kind in {"fdm", "fdm_boundary", "fdm_multi", "fdm_periodic"}:
        extra = """fdm_contract = fm.FDM(
    default_cell=(4 * nm, 4 * nm, 4 * nm),
    boundary_correction="none",
)
"""
        geometry = """film = study.geometry(
    fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
    name="film",
)
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 4 * nm))"""
        if kind == "fdm_boundary":
            extra = """fdm_contract = fm.FDM(
    default_cell=(4 * nm, 4 * nm, 4 * nm),
    boundary_correction="full",
    boundary_phi_floor=0.05,
    boundary_delta_min=0.25 * nm,
)
"""
        elif kind == "fdm_multi":
            extra = """fdm_contract = fm.FDM(
    per_magnet={
        "lower": fm.FDMGrid(cell=(4 * nm, 4 * nm, 2 * nm)),
        "upper": fm.FDMGrid(cell=(5 * nm, 5 * nm, 2 * nm)),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cell_size=(4 * nm, 4 * nm, 2 * nm),
        explain=True,
    ),
)
"""
            geometry = """lower = study.geometry(
    fm.Box(size=(320 * nm, 160 * nm, 4 * nm), center=(0.0, 0.0, -5 * nm), name="lower"),
    name="lower",
)
upper = study.geometry(
    fm.Box(size=(260 * nm, 120 * nm, 4 * nm), center=(0.0, 0.0, 5 * nm), name="upper"),
    name="upper",
)
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 2 * nm))
film = lower"""
        elif kind == "fdm_periodic":
            extra = """fdm_contract = fm.FDM(
    default_cell=(4 * nm, 4 * nm, 4 * nm),
    demag=fm.FDMDemag(strategy="single_grid", explain=True),
)
periodic_contract = {
    "axes": (True, False, False),
    "image_counts": (8, 0, 0),
    "bloch_wavevector_rad_per_m": (0.0, 0.0, 0.0),
}
"""
        return f"""import fullmag as fm

nm = 1.0e-9
study = fm.study("{slug}_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

{extra.rstrip()}

{geometry}
{common_material}
study.exchange()
study.demag(realization="fft")
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    tolA=1.0e-4,
    max_steps=20_000,
)

# The immutable run artifact must contain the resolved FDM contract,
# allocated dimensions, origin, masks and demag-grid realization.
print(fdm_contract.to_ir())"""

    if kind == "refinement":
        return """import fullmag as fm

nm = 1.0e-9
mesh_sizes = (8 * nm, 6 * nm, 4 * nm)
studies = []

for hmax in mesh_sizes:
    study = fm.study(f"fem_refinement_{hmax / nm:.0f}nm")
    study.engine("fem")
    study.device("cpu", precision="double")
    study.mode("strict")
    study.universe(mode="manual", size=(700 * nm, 500 * nm, 250 * nm))
    study.universe.mesh(
        minimum_element_size=12 * nm,
        maximum_element_size=80 * nm,
        maximum_element_growth_rate=1.5,
        grading="geometric",
    )
    film = study.geometry(
        fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
        name="film",
    )
    film.mesh(
        mesh_strategy="free_tetrahedral",
        minimum_element_size=0.5 * hmax,
        maximum_element_size=hmax,
        order=1,
        compute_quality=True,
        per_element_quality=True,
    )
    film.Ms = 800.0e3
    film.Aex = 13.0e-12
    film.alpha = 0.02
    film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)
    study.exchange()
    study.demag(realization="poisson_robin")
    study.build_domain_mesh()
    study.stages.add_relax(
        stage_id="equilibrium",
        algorithm="llg_overdamped",
        tolA=1.0e-4,
        max_steps=20_000,
    )
    studies.append(study)

# Compare immutable artifacts for energy, field and texture norms; do not
# overwrite one run while changing hmax.
assert len(studies) == 3"""

    if kind in {"airbox", "airbox_geometry", "airbox_grading", "boundary_closure", "periodic_airbox"}:
        shape = 'shape="bbox",' if kind != "airbox_geometry" else 'shape="sphere",'
        closure = "poisson_robin"
        extra = ""
        if kind == "periodic_airbox":
            extra = """
periodic_airbox_contract = {
    "axes": (True, True, False),
    "pair_ids": ("x_pair", "y_pair"),
    "wavevector_rad_per_m": (0.0, 0.0, 0.0),
    "gauge": "mean_zero_augmented",
}
"""
            closure = "poisson_periodic_k0"
        return f"""import fullmag as fm

nm = 1.0e-9
study = fm.study("{slug}_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(700 * nm, 500 * nm, 250 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
    {shape}
)
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
{extra.rstrip()}

film = study.geometry(
    fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
    name="film",
)
film.mesh(
    mesh_strategy="free_tetrahedral",
    minimum_element_size=3 * nm,
    maximum_element_size=7 * nm,
    interface_maximum_element_size=5 * nm,
    interface_thickness=12 * nm,
    order=1,
    compute_quality=True,
    per_element_quality=True,
)
{common_material}
study.exchange()
study.demag(realization="{closure}")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    tolA=1.0e-4,
    max_steps=20_000,
)"""

    if kind in {"shared", "fallbacks"}:
        extra = ""
        if kind == "fallbacks":
            extra = """
requested_recipe = fm.PerObjectMeshRecipe(
    mesh_strategy="swept_prism",
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    sweep_face_meshing="triangular",
    topology="prismatic",
    element_family="prism",
    transition_policy="pyramid_to_tetrahedra",
    exact_layer_count=True,
    order=1,
)
print(requested_recipe.to_ir())
"""
        return f"""import fullmag as fm

nm = 1.0e-9
study = fm.study("{slug}_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(900 * nm, 600 * nm, 300 * nm))
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=100 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
{extra.rstrip()}

left = study.geometry(
    fm.Box(size=(240 * nm, 120 * nm, 8 * nm), center=(-140 * nm, 0.0, 0.0), name="left"),
    name="left",
)
right = study.geometry(
    fm.Box(size=(240 * nm, 120 * nm, 8 * nm), center=(140 * nm, 0.0, 0.0), name="right"),
    name="right",
)
for film in (left, right):
    film.mesh(
        mesh_strategy="free_tetrahedral",
        minimum_element_size=3 * nm,
        maximum_element_size=8 * nm,
        interface_maximum_element_size=5 * nm,
        order=1,
        compute_quality=True,
        per_element_quality=True,
    )
    film.Ms = 800.0e3
    film.Aex = 13.0e-12
    film.alpha = 0.02
    film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    tolA=1.0e-4,
    max_steps=20_000,
)"""

    if kind == "swept_hex":
        return """import fullmag as fm

nm = 1.0e-9
requested = fm.PerObjectMeshRecipe(
    mesh_strategy="swept_hex",
    through_thickness_elements=2,
    through_thickness_distribution="fixed",
    sweep_face_meshing="quadrilateral",
    sweep_direction="z",
    topology="prismatic",
    element_family="hex",
    transition_policy="reject",
    exact_layer_count=True,
    order=1,
)
print(requested.to_ir())

# Current production documentation treats this as an authoring contract,
# not as proof of executable backend support.  Use a qualified fallback only
# when the study permits it explicitly.
study = fm.study("swept_hex_capability_probe")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(
    fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="capability_probe", tolA=1.0e-4, max_steps=1)
# Do not dispatch until the capability matrix reports swept_hex/hex8 support."""

    mesh_args: list[str]
    if kind == "swept_prism":
        mesh_args = [
            'mesh_strategy="swept_prism"',
            'topology="prismatic"',
            'through_thickness_elements=2',
            'through_thickness_distribution="fixed"',
            'through_thickness_symmetric=False',
            'sweep_face_meshing="triangular"',
            'sweep_direction="z"',
            'element_family="prism"',
            'transition_policy="pyramid_to_tetrahedra"',
            'exact_layer_count=True',
            'minimum_element_size=3 * nm',
            'maximum_element_size=7 * nm',
            'order=1',
            'compute_quality=True',
            'per_element_quality=True',
        ]
    elif kind == "swept":
        mesh_args = [
            'mesh_strategy="swept_prism"',
            'through_thickness_elements=2',
            'through_thickness_distribution="fixed"',
            'sweep_face_meshing="triangular"',
            'element_family="prism"',
            'transition_policy="pyramid_to_tetrahedra"',
            'exact_layer_count=True',
            'maximum_element_size=7 * nm',
            'order=1',
            'compute_quality=True',
        ]
    elif kind == "fem_thin_tet":
        mesh_args = [
            'mesh_strategy="thin_film_tetrahedral"',
            'through_thickness_elements=3',
            'sweep_direction="z"',
            'minimum_element_size=2 * nm',
            'maximum_element_size=7 * nm',
            'order=1',
            'compute_quality=True',
            'per_element_quality=True',
        ]
    elif kind == "boundary_layer":
        mesh_args = [
            'mesh_strategy="free_tetrahedral"',
            'minimum_element_size=2 * nm',
            'maximum_element_size=8 * nm',
            'boundary_layer_count=3',
            'boundary_layer_thickness=1.0 * nm',
            'boundary_layer_stretching=1.35',
            'boundary_layer_target_surface_selectors=("top", "bottom")',
            'order=1',
            'compute_quality=True',
            'per_element_quality=True',
        ]
    elif kind == "imported":
        mesh_args = [
            'mesh_strategy="imported"',
            'source="meshes/device.msh"',
            'coordinate_scale=1.0',
            'order=1',
            'compute_quality=True',
            'per_element_quality=True',
        ]
    elif kind == "mixed":
        mesh_args = [
            'mesh_strategy="swept_prism"',
            'through_thickness_elements=2',
            'through_thickness_distribution="fixed"',
            'sweep_face_meshing="triangular"',
            'element_family="prism"',
            'transition_policy="pyramid_to_tetrahedra"',
            'exact_layer_count=True',
            'minimum_element_size=3 * nm',
            'maximum_element_size=8 * nm',
            'order=1',
            'compute_quality=True',
            'per_element_quality=True',
        ]
    elif kind == "selectors":
        mesh_args = [
            'mesh_strategy="swept_prism"',
            'sweep_source="normal:+z,min-z"',
            'sweep_destination="normal:+z,max-z"',
            'through_thickness_elements=2',
            'sweep_face_meshing="triangular"',
            'element_family="prism"',
            'transition_policy="pyramid_to_tetrahedra"',
            'exact_layer_count=True',
            'maximum_element_size=7 * nm',
            'order=1',
            'compute_quality=True',
        ]
    else:
        mesh_args = [
            'mesh_strategy="free_tetrahedral"',
            'minimum_element_size=3 * nm',
            'maximum_element_size=7 * nm',
            'maximum_element_growth_rate=1.35',
            'curvature_factor=0.3',
            'narrow_region_resolution=2.0',
            'order=1',
            'compute_quality=True',
            'per_element_quality=True',
        ]

    return f"""import fullmag as fm

nm = 1.0e-9
study = fm.study("{slug}_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 500 * nm, 250 * nm))
study.universe.mesh(
    minimum_element_size=12 * nm,
    maximum_element_size=80 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(320 * nm, 160 * nm, 8 * nm), name="film"),
    name="film",
)
film.mesh(
{indent([arg + ',' for arg in mesh_args], '    ')}
)
{common_material}
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    tolA=1.0e-4,
    max_steps=20_000,
)"""


def interaction_rows(path: str) -> list[tuple[str, str, str]]:
    if path.startswith("fdm/") or path == "fdm-grids.md":
        return [
            ("Exchange/DMI", "Cell spacing and seam/boundary policy determine the finite-difference stencil.", "Refine every direction carrying texture gradients; validate boundary correction separately."),
            ("Demagnetization", "Cell geometry, padding, periodic images and common-grid transfer define the FFT operator.", "Keep the kernel/grid fingerprint in run provenance."),
            ("Dynamics/eigenmodes", "Nyquist limits and spatial sampling bound the trustworthy mode spectrum.", "Compare frequency, linewidth and phase-invariant mode overlap under refinement."),
        ]
    if "airbox" in path:
        return [
            ("Exchange/DMI", "Solved only in magnetic regions; magnetic boundary resolution is shared with the air interface.", "Do not coarsen the first air cells abruptly relative to magnetic boundary cells."),
            ("Demagnetization", "The airbox carries scalar-potential DOFs and outer-boundary closure.", "Separate magnet-mesh, air-mesh, boundary-distance and algebraic convergence."),
            ("Dynamics/eigenmodes", "Dynamic demag uses the same geometric/marker contract when supported.", "Verify that frequency and mode shape are insensitive to airbox changes."),
        ]
    if "swept" in path or "mixed-elements" in path or "boundary-layers" in path:
        return [
            ("Exchange/DMI", "Layer planes and anisotropic cell mappings control normal derivatives and boundary terms.", "Refine in-plane size and layer count independently."),
            ("Demagnetization", "Mixed magnetic cells must couple conformingly to surrounding air/tetrahedra.", "Verify prism/pyramid/tet facet coverage and operator family support."),
            ("Dynamics/eigenmodes", "Through-thickness sampling determines accessible perpendicular standing modes.", "Track modes by overlap, not only by sorted index."),
        ]
    return [
        ("Exchange/DMI", "Finite-element gradients and boundary terms are assembled on the realized cell/facet topology.", "Resolve magnetic length scales and retain material/interface markers."),
        ("Demagnetization", "Magnetic surfaces and shared air interfaces source the scalar-potential solve.", "Verify conforming interfaces, outer markers and airbox convergence."),
        ("Dynamics/eigenmodes", "Mass/stiffness matrices and mesh conditioning affect spectra and time integration.", "Compare energy, frequency, linewidth and mass-weighted field norms."),
    ]


def render(path: str, page: dict[str, object]) -> str:
    groups = page.get("groups", [])
    params: list[tuple[str, str, str, str, str]] = []
    seen: set[str] = set()
    for group in groups:
        for item in S.GROUPS[str(group)]:
            if item[0] not in seen:
                seen.add(item[0])
                params.append(item)

    lines: list[str] = [
        BEGIN,
        "",
        "## Detailed scientific and implementation reference",
        "",
        f"This section is the production reference for **{page['title']}**. {page['scope']}",
        "It distinguishes authored intent, normalized/effective configuration, realized mesh data and",
        "solver admission.  The realized mesh resource and its revision-locked reports are authoritative.",
        "",
        "::::{admonition} Scientific-use invariant",
        ":class: important",
        "A successful mesh build is not evidence of spatial convergence.  Record the complete realized",
        "topology, markers, quality tails, fallback state and a convergence sequence for the observable",
        "used in the scientific conclusion.",
        "::::",
        "",
        "### Governing relations and numerical interpretation",
        "",
    ]

    for index, (name, latex, explanation) in enumerate(page["equations"], start=1):
        lines += [
            f"#### {index}. {name}",
            "",
            "```{math}",
            str(latex),
            "```",
            "",
            str(explanation),
            "",
        ]

    lines += [
        "### Parameter-by-parameter semantics",
        "",
        "Values are authored in SI units unless stated otherwise.  A default shown here is an authoring",
        "or direct-Python default; backend normalization can still produce a different effective value,",
        "which must be displayed in the build plan and realization report.",
        "",
        "| Parameter | Unit | Default | Validation | Numerical consequence |",
        "| --- | --- | --- | --- | --- |",
    ]
    for name, unit, default, validation, effect in params:
        safe = [str(value).replace("|", "\\|") for value in (name, unit, default, validation, effect)]
        lines.append("| " + " | ".join(safe) + " |")

    lines += [
        "",
        "### End-to-end Python workflow",
        "",
        "The example is stage-first and keeps geometry, discretization, interactions and execution stage",
        "in one reproducible study.  For capability-gated routes, inspect the capability/resource report",
        "before dispatch rather than assuming that an accepted Python object implies executable support.",
        "",
        "```python",
        example_code(str(page["example"]), path),
        "```",
        "",
        "### Control Room: exact procedure",
        "",
    ]
    for number, step in enumerate(page["ui"], start=1):
        lines.append(f"{number}. {step}")

    lines += [
        "",
        "After **Apply**, the form represents authored intent.  After **Build Mesh**, use the read-only",
        "resource tabs—Summary, Quality, Topology, Regions, Interfaces and History—to inspect effective",
        "and realized values.  A dirty geometry/object policy invalidates the previous mesh revision.",
        "",
        "### Consequences for exchange, demagnetization and dynamics",
        "",
        "| Physics/analysis | Mesh dependency | Required verification |",
        "| --- | --- | --- |",
    ]
    for physics, dependency, verification in interaction_rows(path):
        lines.append(f"| {physics} | {dependency} | {verification} |")

    lines += [
        "",
        "### Verification and convergence protocol",
        "",
        "Use this controlled sequence:",
        "",
        "1. Freeze geometry, materials, initial state, interaction realizations, timestep/frequency sampling",
        "   and solver tolerances.",
        "2. Record the requested and effective mesh configuration before the build.",
        "3. Build at least three ordered resolutions while changing only one mesh-control family.",
        "4. Verify cell/facet topology, markers, Jacobians, worst-tail quality and fallback status for every run.",
        "5. Compare the scientific observable and a spatial field norm; for eigenmodes use phase-invariant",
        "   mass-weighted overlap and branch tracking.",
        "6. Repeat the independent airbox/periodic/algebraic convergence study when those errors are present.",
        "",
        "#### Page-specific acceptance criteria",
        "",
    ]
    for item in page["accept"]:
        lines.append(f"- {item}")

    lines += [
        "",
        "A publication or benchmark record should include node/cell counts by family and region, minimum",
        "and percentile quality, realized size statistics, software revision, capability IDs, fallback state",
        "and the final observable-change tolerance.",
        "",
        "### Diagnostics and failure modes",
        "",
    ]
    for item in page["fail"]:
        lines.append(f"- **Reject or investigate:** {item}")

    lines += [
        "",
        "Blocking conditions include inverted or degenerate cells, incomplete marker coverage, unmatched",
        "interfaces, unsupported realized cell families, stale geometry/mesh revisions and any unreported",
        "requested-to-realized substitution.  These are not cosmetic warnings.",
        "",
        "### Implementation traceability",
        "",
        "| Responsibility | Source file | Stable owner / contract |",
        "| --- | --- | --- |",
    ]
    for responsibility, source, owner in page["impl"]:
        url = f"https://github.com/MateuszZelent/fullmag/blob/{SOURCE_REVISION}/{source}"
        lines.append(f"| {responsibility} | [`{source}`]({url}) | `{owner}` |")

    lines += [
        "",
        "### Reproducibility metadata to export",
        "",
        "- geometry, material, object-policy, universe-policy and mesh revision IDs;",
        "- requested, effective and realized strategy/topology/order/layer values;",
        "- node, cell and facet counts by family, region and semantic role;",
        "- bounds, cell/element-size statistics, Jacobian and quality distributions;",
        "- selector matches, marker maps, periodic pair maps and interface adjacency;",
        "- Gmsh/backend/device/precision versions and deterministic-build status;",
        "- fallback/degradation reason codes and the capability snapshot used for admission;",
        "- the convergence table for the scientific observable.",
        "",
        "### Numerical references",
        "",
    ]
    for ref in page["refs"]:
        lines.append(f"- {ref}")
    lines += ["", END, ""]
    return "\n".join(lines)


def update_frontmatter(text: str) -> str:
    text = re.sub(
        r"(?m)^reviewed_revision:\s*.*$",
        f"reviewed_revision: {SOURCE_REVISION}",
        text,
        count=1,
    )
    text = re.sub(r"(?m)^last_updated:\s*.*$", "last_updated: 2026-08-24", text, count=1)
    return text


def remove_existing_v3(text: str) -> str:
    return re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S)


def insert_reference(text: str, block: str) -> str:
    candidates = []
    for heading in ("\n## Related documentation", "\n## References", "\n## Documentation tree"):
        pos = text.find(heading)
        if pos >= 0:
            candidates.append(pos)
    if candidates:
        pos = min(candidates)
        return text[:pos].rstrip() + "\n\n" + block + "\n" + text[pos:].lstrip("\n")
    return text.rstrip() + "\n\n" + block


def replace_toctree(path: str, text: str) -> str:
    if path not in S.TOCTREES:
        return text
    text = re.sub(r"\n## Documentation tree\n.*\Z", "", text, flags=re.S)
    entries = "\n".join(S.TOCTREES[path])
    return text.rstrip() + "\n\n## Documentation tree\n\n```{toctree}\n:maxdepth: 2\n\n" + entries + "\n```\n"


def normalize_math_labels(path: str, text: str) -> str:
    slug = slugify(path)
    mapping: dict[str, str] = {}
    counter = 0
    out: list[str] = []
    for line in text.splitlines():
        match = re.match(r"^(\s*):label:\s*([^\s]+)\s*$", line)
        if match:
            counter += 1
            old = match.group(2)
            new = f"eq-fullmag-meshing-{slug}-{counter}"
            mapping.setdefault(old, new)
            out.append(f"{match.group(1)}:label: {new}")
        else:
            out.append(line)
    result = "\n".join(out)
    for old, new in mapping.items():
        result = result.replace(f"{{eq}}`{old}`", f"{{eq}}`{new}`")
    return result


def normalize_duplicate_anchors(files: dict[str, str]) -> dict[str, str]:
    seen: set[str] = set()
    result: dict[str, str] = {}
    for path in sorted(files):
        slug = slugify(path)
        counter = 0
        lines: list[str] = []
        for line in files[path].splitlines():
            match = re.match(r"^\(([^)]+)\)=\s*$", line)
            if not match:
                lines.append(line)
                continue
            anchor = match.group(1)
            if anchor in seen:
                counter += 1
                anchor = f"{anchor}-v3-{slug}-{counter}"
                line = f"({anchor})="
            seen.add(anchor)
            lines.append(line)
        result[path] = "\n".join(lines).rstrip() + "\n"
    return result


def main() -> None:
    expected = set(S.PAGES)
    actual = {str(path.relative_to(ROOT)) for path in ROOT.rglob("*.md")}
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise SystemExit(f"meshing page set mismatch: missing={missing}, extra={extra}")

    rendered: dict[str, str] = {}
    for path in sorted(expected):
        target = ROOT / path
        text = target.read_text(encoding="utf-8")
        text = update_frontmatter(remove_existing_v3(text))
        text = insert_reference(text, render(path, S.PAGES[path]))
        text = replace_toctree(path, text)
        text = normalize_math_labels(path, text)
        rendered[path] = text.rstrip() + "\n"

    rendered = normalize_duplicate_anchors(rendered)

    all_labels: list[str] = []
    all_anchors: list[str] = []
    for path, text in rendered.items():
        all_labels.extend(re.findall(r"(?m)^\s*:label:\s*([^\s]+)\s*$", text))
        all_anchors.extend(re.findall(r"(?m)^\(([^)]+)\)=\s*$", text))
        line_count = len(text.splitlines())
        if line_count < 300:
            raise SystemExit(f"{path}: only {line_count} lines after v3 generation")
        for required in (
            BEGIN,
            "### Parameter-by-parameter semantics",
            "### End-to-end Python workflow",
            "### Control Room: exact procedure",
            "### Implementation traceability",
            END,
        ):
            if required not in text:
                raise SystemExit(f"{path}: missing required section {required!r}")

    duplicate_labels = sorted({item for item in all_labels if all_labels.count(item) > 1})
    duplicate_anchors = sorted({item for item in all_anchors if all_anchors.count(item) > 1})
    if duplicate_labels or duplicate_anchors:
        raise SystemExit(
            f"duplicate MyST identifiers remain: labels={duplicate_labels}, anchors={duplicate_anchors}"
        )

    for path, text in rendered.items():
        (ROOT / path).write_text(text, encoding="utf-8")

    total_lines = sum(len(text.splitlines()) for text in rendered.values())
    print(f"meshing-v3: wrote {len(rendered)} pages and {total_lines} Markdown lines")


if __name__ == "__main__":
    main()
