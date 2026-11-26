---
title: "Shared-domain assembly and conformity"
description: "Boolean fragmentation, region partition, shared interfaces, mixed-tet untangling, and conformity certificates."
summary: "A conforming shared mesh represents each physical interface once, with common facet nodes referenced by adjacent regions. This is the default contract for coupled FEM operators in Fullmag."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "OCC shared assembly, pure-prism certificate mutual exclusion, Chebyshev mixed-tet untangler, typed facet adjacency, region/facet roles and shared-domain certificate"
---

(public-docs-numerical-methods-meshing-fem-shared-domain-assembly-and-conformity)=
# Shared-domain assembly and conformity

A conforming shared mesh represents each physical interface once, with common facet nodes referenced by adjacent regions. This is the default contract for coupled FEM operators in Fullmag.

::::{admonition} Implementation status
:class: important

Conforming OCC tetrahedral shared-domain assembly, deterministic Chebyshev-center mixed-tet untangling (`layers=1,2,3`), and mutually exclusive pure-prism P2 topology certification (`PurePrismTopologyCertificateV1IR`) are implemented. Nonconforming mortar/contact coupling is not implied by ordinary mesh import or coincident surfaces.
::::

(assembly-problem-statement)=
## Problem statement

When multiple magnetic bodies touch or a magnet is embedded inside an exterior airbox, Fullmag requires a true topological partition—not overlapping meshes and not independently meshed surfaces sharing coordinates. The OCC route constructs magnetic and air volumes, runs `occ.fragment`, assigns physical groups, extracts typed cells and facets, reconstructs cell-to-facet adjacency, and verifies manifold conformity. For layered prismatic films, conformity is additionally certified either through the mixed-tet Chebyshev untangler (`pyramid_to_tetrahedra`) or through pyramid-free 3-stage columnar extrusion (`pure_prism`).

(assembly-governing-equations)=
## Governing equations

The shared assembly domain is the disjoint union of airbox and magnetic component volumes:

```{math}
:label: eq-assembly-fragment-contract

\Omega=\Omega_a\cup\bigcup_i\Omega_i.
```

For an internal facet $F=\partial K_r\cap\partial K_s$, conforming topology means both adjacent cells reference the identical global node set for $F$ (adjacency degree `2` for an interior manifold facet, `1` for an exterior facet, `0` for an invalid orphan facet, and `> 2` for an invalid nonmanifold facet).

When Gmsh Delaunay triangulation in thin lateral air slabs emits pairs of inverted `tet4` elements whose shared faces fail the two-owner opposite-side conformity test ($d_0 d_1 > 0$), `_untangle_same_side_mixed_tetrahedra` relocates each movable interior non-apex vertex $v$ incident to the inverted set $I$ to the Chebyshev center $(\mathbf{x}^*, r^*)$ of its consistently oriented tetrahedral star $\mathcal{S}(v)$:

```{math}
:label: eq-chebyshev-untangle-lp

\max_{\mathbf{x}\in\mathbb{R}^3,\; r\in\mathbb{R}} r
\quad\text{subject to}\quad
\hat{\mathbf{u}}_t^{\mathrm{in}}\cdot(\mathbf{x}-\mathbf{p}_{a,t})\ge r
\quad\forall t\in\mathcal{S}(v),
```

where $\hat{\mathbf{u}}_t^{\mathrm{in}}$ points toward $v$ for non-inverted $t\notin I$ and opposite to it for inverted $t\in I$. Whenever $r^*>0$ strictly reduces `same_side_two_owner_face` while preserving positive incident determinants $|\det|>\tau_{\det}$, the node is relocated and the affected inverted tetrahedra in $I\cap\mathcal{S}(v)$ are locally reoriented.

Exchange-length scaling follows

```{math}
:label: eq-meshing-exchange-length-fem-shared-domain-assembly-and-conformity

\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0 M_s^2}}.
```

(assembly-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $\Omega$ | shared computational domain | $\mathrm{m^3}$ |
| $\Omega_a$ | airbox volume | $\mathrm{m^3}$ |
| $\Omega_i$ | magnetic component volume | $\mathrm{m^3}$ |
| $\mathbf{x}$ | candidate relocated interior vertex position | $\mathrm{m}$ |
| $r$ | inscribed Chebyshev margin radius of vertex star | $\mathrm{m}$ |
| $\hat{\mathbf{u}}_t^{\mathrm{in}}$ | inward unit normal of opposite face of star tetrahedron $t$ | $1$ |
| $\mathbf{p}_{a,t}$ | reference vertex on opposite face of star tetrahedron $t$ | $\mathrm{m}$ |
| $\mathcal{S}(v)$ | tetrahedral star incident to interior vertex $v$ | $1$ |
| $\ell_{\mathrm{ex}}$ | magnetostatic exchange length | $\mathrm{m}$ |
| $A$ | exchange stiffness constant | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |

(assembly-assumptions-and-validity)=
## Assumptions and validity

- Conformity on general multi-body geometries follows `occ.fragment` realization, not merely the value of `SharedMeshAssemblyPolicy` (whose non-default values fail closed in `_validate_shared_mesh_assembly_policy`).
- Boolean fragmentation can split one authored surface into multiple entities; semantic ownership must be retained through physical groups and facet-role derivation (`_derive_facet_roles`).
- **Mutual-exclusion certificate invariant:** In `ProblemIR` and `MeshAssetIR`, `pure_prism_topology_certificate` (`PurePrismTopologyCertificateV1IR`, `schema_version = "pure_prism_topology_certificate.v1"`, `topology_fingerprint_version = "v3"`, zero pyramids, zero tetrahedra, `nonconforming_face_count == 0`, `prism6 scaled_jacobian_p05 >= 0.1`) is strictly mutually exclusive with `mixed_layer_topology_certificate` (V1) and `mixed_layer_topology_certificate_v2` (V2). Simultaneous presence of two certificate families is rejected at deserialization/planning.

### Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Magnet embedded in airbox | Conforming fragment-and-mesh (`conformal_occ`) | Required by ordinary continuous scalar-potential assembly |
| Two magnets separated by air | One shared exterior domain | Cross-demagnetizing field is represented continuously |
| Two touching material regions | Shared interface + distinct region markers | Material coefficients jump cleanly while topology remains conforming |
| Layered thin-film box (accurate P2 demag) | `transition="pure_prism"` (`PurePrismTopologyCertificateV1IR`) | Pyramid-free 100% `prism6` shared domain with `nonconforming_face_count == 0` |
| Layered thin-film box (mixed P1, `layers=1..3`) | `transition="pyramid_to_tetrahedra"` + Chebyshev untangler | Eliminates `same_side_two_owner_face` overlaps before certification |

(assembly-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows document the public signature and `ProblemIR` contract for shared-domain universe authoring.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.universe(mode=...)` | `str \| None` | `None` | $1$ | forwarded to `StudyUniverseConfig`; omitted retains current/default mode | domain mode | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.mode` |
| `study.universe(size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | coerced with `as_vector3`; explicit dimensions must be positive when realized | outer dimensions | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.size` |
| `study.universe(center=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | coerced with `as_vector3` | outer center | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.center` |
| `study.universe(padding=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | coerced with `as_vector3`; non-negative per axis | directional padding | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.padding` |
| `study.universe.mesh(cell_size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | positive 3-vector; mutually exclusive with FEM controls | structured-grid cell size branch | FDM only; not applicable to this FEM assembly page | `runtime_metadata.common_fdm_cell_size` |
| `study.universe.mesh(hmax=...) / study.universe.mesh(maximum_element_size=...)` | `float \| None` | `None` | $\mathrm{m}$ | positive; canonical maximum size wins over alias | airbox coarse target | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_hmax` |
| `study.universe.mesh(hmin=...) / study.universe.mesh(minimum_element_size=...)` | `float \| None` | `None` | $\mathrm{m}$ | positive and no greater than numeric maximum; canonical minimum size wins over alias | airbox lower clamp | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_hmin` |
| `study.universe.mesh(growth_rate=...) / study.universe.mesh(maximum_element_growth_rate=...)` | `float \| None` | `None` | $1$ | finite, strictly greater than `1.0`, and at most `2.5`; canonical growth rate wins over alias | airbox growth target | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_growth_rate` |
| `study.universe.mesh(grading=...)` | `str \| None` | `None` | $1$ | normalized to `auto`, `geometric`, or `linear` in `StudyUniverseConfig` | airbox grading request | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_grading` |

`generate_shared_domain_mesh_via_occ(...)` is internal; public authoring splits universe geometry (`study.universe(...)`) from air-mesh controls (`study.universe.mesh(...)`).

```python
# %% Study and manual shared-domain universe
import fullmag as fm

nm = 1.0e-9
study = fm.study("assembly_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(700 * nm, 500 * nm, 260 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=90 * nm,
    minimum_element_size=12 * nm,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# %% Two magnetic bodies sharing one conforming exterior domain
left = study.geometry(
    fm.Box(size=(180 * nm, 80 * nm, 10 * nm), name="left_geom").translate((-120 * nm, 0.0, 0.0)),
    name="left",
)
right = study.geometry(
    fm.Box(size=(180 * nm, 80 * nm, 10 * nm), name="right_geom").translate((120 * nm, 0.0, 0.0)),
    name="right",
)
for body, direction in ((left, (1.0, 0.0, 0.0)), (right, (0.0, 1.0, 0.0))):
    body.mesh(
        mesh_strategy="free_tetrahedral",
        minimum_element_size=4 * nm,
        maximum_element_size=8 * nm,
        interface_maximum_element_size=6 * nm,
        interface_thickness=15 * nm,
        transition_distance="airbox_boundary",
        transition_growth=1.4,
        order=1,
        compute_quality=True,
    )
    body.Ms = 800.0e3
    body.Aex = 13.0e-12
    body.alpha = 0.02
    body.m = fm.texture.uniform(*direction)

# %% Coupled interactions and stage
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", dt=5.0e-13, max_steps=1)
```

(assembly-problem-ir)=
## ProblemIR

Geometry, universe airbox, and object policies lower as requested intent. OCC component volume tags, interface surface tags, derived facet roles (`outer`, `interface`, `periodic`, `provisional`), final typed CSR cell blocks, and mutually exclusive topology certificates (`mixed_layer_topology_certificate`, `mixed_layer_topology_certificate_v2`, or `pure_prism_topology_certificate`) are realized provenance artifacts stored in the mesh asset and build report.

(assembly-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** Authored geometries, universe airbox, regions, and mesh policies.
- **Resolved execution:** OCC volume/interface tags, extracted typed topology, facet-adjacency diagnostics, Chebyshev untangling records (when mixed `tet4` cavities require repair), and topology certificates re-verified post-packing by `validate_pure_prism_topology_certificate_against_mesh` (for `pure_prism_p2`) or mixed-certificate validators.
- **Validation errors:** Empty geometry, missing airbox, invalid region identity/owner, non-contained conformal region, orphan (`degree == 0`) or nonmanifold (`degree > 2`) facets, duplicate coincident nonconforming faces, unresolved `same_side_two_owner_face`, or simultaneous V1/V2/`pure_prism` certificates.
- **Unsupported combinations:** Nonconforming duplicate surfaces, uncertified mixed/pure-prism topologies, or conflicting certificates fail closed before solver execution rather than proceeding as conformal success.

(assembly-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented | Conforming OCC tetrahedral, Chebyshev-untangled `mixed_p1`, and `pure_prism_p2` shared domains |
| FEM | GPU | implemented (capability-gated) | Consumes certified conforming shared-domain meshes (`tet4`, `mixed_p1` including untangled `layers=2`, and `pure_prism_p2`) |
| FDM | CPU | not applicable | Structured Cartesian FDM grids do not perform OCC boolean fragmentation |
| FDM | GPU | not applicable | Structured Cartesian FDM grids do not perform OCC boolean fragmentation |

### Control Room workflow

Apply every object mesh policy and the Universe airbox policy, then invoke **Apply & Build Shared-Domain Mesh** (`mesh.build-shared-domain`). In **Shared Domain / Mesh Root** (`SharedDomainMeshSpec.tsx`, `MeshRootSpec.tsx`), inspect region inventory, interface inventory, facet-role counts, orphan/nonmanifold conformity diagnostics, and scoped quality distributions before running a solver.

(assembly-implementation-mapping)=
## Implementation mapping

`StudyUniverseHandle` and `GeometryMeshHandle` own authored intent; `_build_problem` and `Problem.to_ir()` lower metadata and assets; `generate_shared_domain_mesh_via_occ` owns OCC fragmentation; `_derive_facet_roles` and `collect_orphan_entity_diagnostics` derive facet roles and conformity diagnostics; `_untangle_same_side_mixed_tetrahedra` and `_chebyshev_center_3d` repair inverted same-side mixed-tet cavities; `PurePrismTopologyCertificateV1IR` and `validate_pure_prism_topology_certificate_against_mesh` enforce pure-prism mutual exclusion and `v3` fingerprints; `realize_fem_domain_mesh_asset_from_components_with_report`, `_build_shared_domain_build_report`, `fullmag_plan::plan`, and `run_planned_problem` materialize and enforce the final shared-domain artifact.

(assembly-validation)=
## Validation

Require complete cell-to-facet adjacency, one geometric interface role per intended pair, zero orphan/nonmanifold/duplicate coincident facets, positive cell Jacobians, and complete region ownership. On the $300\times 300\times 5\;\mathrm{nm}$, $h=2.5\;\mathrm{nm}$, `layers=2` mixed-prism benchmark that previously emitted 6 overlapping `same_side_two_owner_face` faces, `_untangle_same_side_mixed_tetrahedra` deterministically relocates interior node `53465` (`reoriented_tets = 2`, Chebyshev margin `4.452e-4`), reducing `same_side_two_owner_face` `6 -> 0` and certifying conforming `layers=1,2,3` meshes (`p05={'prism6': 0.8616, 'pyramid5': 0.4622, 'tet4': 0.1842}`) for GPU `cuDSS` execution. Unit tests verify both the SciPy HiGHS LP solver path, the pure-NumPy fallback, and fail-closed rejection when no positive Chebyshev margin exists.

(assembly-limitations)=
## Limitations

- This page covers conforming shared-domain assembly; general nonconforming mortar/contact coupling is not supported.
- A valid single-object preview mesh can still fail conformity after shared boolean fragmentation; always certify the final shared-domain realization.

(assembly-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

## Related documentation

- [Build modes and fallbacks](build-modes-and-fallbacks.md)
- [Selectors and attributes](selectors-and-attributes.md)
- [Mixed elements](../ferromagnet/mixed-elements.md)

(assembly-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| occ_shared | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L536) | [`generate_shared_domain_mesh_via_occ`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L536) | OCC fragment and shared extraction | source-inspected |
| mixed_untangler | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2501) | [`_untangle_same_side_mixed_tetrahedra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2501) | vectorized `same_side_two_owner_face` repair and local `tet4` reorientation | verified |
| chebyshev_lp | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2248) | [`_chebyshev_center_3d`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2248) | 4-variable Chebyshev-center star LP solver (SciPy HiGHS + NumPy fallback) | verified |
| pure_prism_cert_schema | [`crates/fullmag-ir/src/mesh_assets.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mesh_assets.rs#L2561) | [`PurePrismTopologyCertificateV1IR`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mesh_assets.rs#L2561) | 44-field pure-prism certificate schema mutually exclusive with V1/V2 mixed certificates | verified |
| pure_prism_cert_validator | [`crates/fullmag-ir/src/mixed_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) | [`validate_pure_prism_topology_certificate_against_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) | post-packing `v3` fingerprint, Jacobian, and conformity re-verification | verified |
| facet_roles | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py#L667) | [`_derive_facet_roles`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py#L667) | cell-to-facet adjacency and semantic role derivation | source-inspected |
| orphan_diag | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py#L154) | [`collect_orphan_entity_diagnostics`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py#L154) | orphan and unmatched entity diagnostics | source-inspected |
| public_study | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | public study entry point | source-inspected |
| universe_authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5691) | [`class StudyUniverseHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5691) | public universe authoring | source-inspected |
| mesh_authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | public object-mesh authoring | source-inspected |
| problem_lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | [`_build_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | builder-state lowering | source-inspected |
| problem_ir | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | ProblemIR and geometry-asset serialization | source-inspected |
| domain_realization | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | [`realize_fem_domain_mesh_asset_from_components_with_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | shared-domain realization and report | verified |
| build_report | [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L30) | [`_build_shared_domain_build_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py#L30) | realized method/fallback provenance | source-inspected |
| planner | [`crates/fullmag-plan/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | [`plan`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | ProblemIR planning and compatibility | verified |
| runtime | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | [`run_planned_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | planned runtime dispatch | verified |
