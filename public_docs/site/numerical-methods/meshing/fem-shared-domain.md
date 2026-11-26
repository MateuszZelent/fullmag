---
title: "FEM shared-domain meshing"
description: "Conforming assembly of magnetic bodies, interfaces and the exterior air domain."
summary: "A shared-domain mesh is one immutable topology containing all magnetic and air regions required by coupled FEM operators, with conforming interfaces and semantic markers."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "Shared-domain assembly policy, Gmsh OCC fragmentation, pure-prism extrusion, mixed-element untangling, typed topology extraction, manifest certificates and solver capability checks"
---

(public-docs-numerical-methods-meshing-fem-shared-domain)=
# FEM shared-domain meshing

A shared-domain mesh is one immutable topology containing all magnetic and air regions required by coupled FEM operators, with conforming interfaces and semantic markers.

::::{admonition} Implementation status
:class: important

Conforming tetrahedral OCC shared-domain builds (`conformal_occ`), strict mixed `prism6 + pyramid5 + tet4` builds (`single_geometry_geo_mixed` with deterministic `layers=2` Chebyshev-center untangling), and 100% `prism6` pure-prism builds (`pure_prism_extruded_shared_domain`, topology family `pure_prism_p2` with automatic P2 `H1_WedgeElement(2)` demagnetization potential and P1 magnetization) are implemented and verified. Generic silent fallback is forbidden in strict mode.
::::

(shared-domain-problem-statement)=
## Problem statement

Use a shared-domain build whenever an operator spans more than one geometry or requires an exterior nonmagnetic air domain. Fullmag assembles continuous geometry, per-object mesh policies, universe airbox policy, and semantic selections before generating one unified topology. Per-object preview meshes are not substitutes for the final shared domain because boolean fragmentation changes nodes, facets, and entity tags.

`SharedMeshAssemblyPolicy` is accepted by the public API as a compatibility record (`interface_hmax_factor=0.5`, `enforce_conforming=True`, `airbox_hmax_factor=3.0`). At realization time, `_validate_shared_mesh_assembly_policy` enforces fail-closed semantics: the generator currently has only one canonical realization—the default conforming policy—and rejects any non-default `SharedMeshAssemblyPolicy` with `ValueError("shared_mesh_assembly_policy_unsupported: ...")` before invoking Gmsh. Effective interface, body, and exterior sizing must be authored through explicit object (`body.mesh(...)` / `body.mesh.thin_film(...)`) and universe (`study.universe.mesh(...)`) mesh controls.

(shared-domain-governing-equations)=
## Governing equations

Let the shared computational domain be partitioned into disjoint material regions plus exterior air:

```{math}
:label: eq-shared-domain-partition-fem-shared-domain

\overline\Omega=\bigcup_{r=0}^{R}\overline\Omega_r,
\qquad \Omega_r\cap\Omega_s=\varnothing\;(r\ne s),
```

where region $r=0$ is the canonical air role and $r\in\{1,\ldots,R\}$ labels magnetic or material regions. On every conforming internal interface $\Gamma_{rs}=\partial\Omega_r\cap\partial\Omega_s$, adjacent cells share the exact same facet node set, permitting continuous $H^1$ finite-element assembly across material jumps.

The compatibility policy record carries three scalar metadata fields:

```{math}
:label: eq-shared-policy-contract

P=(f_{\Gamma},c,f_a).
```

For exchange-dominated textures, the starting mesh scale is the magnetostatic exchange length

```{math}
:label: eq-meshing-exchange-length-fem-shared-domain

\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0 M_s^2}}.
```

Across a controlled refinement sequence of characteristic sizes $h$ and $h/\rho$, observable convergence is reported via

```{math}
:label: eq-meshing-relative-change-fem-shared-domain

\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1.
```

(shared-domain-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $P$ | preserved assembly-policy record | $1$ |
| $f_{\Gamma}$ | interface size factor | $1$ |
| $c$ | conformity request | $1$ |
| $f_a$ | airbox size factor | $1$ |
| $\Omega$ | shared computational domain | $\mathrm{m^3}$ |
| $\Omega_r$ | disjoint region subdomain ($r=0$ air, $r\ge 1$ material) | $\mathrm{m^3}$ |
| $R$ | number of non-air material regions | $1$ |
| $\Gamma_{rs}$ | conforming interface between regions $r$ and $s$ | $\mathrm{m^2}$ |
| $\ell_{\mathrm{ex}}$ | magnetostatic exchange length | $\mathrm{m}$ |
| $A$ | exchange stiffness constant | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_h$ | relative mesh-refinement change in observable $Q$ | $1$ |
| $Q_h$ | physical observable evaluated at mesh size $h$ | $\text{observable-dependent}$ |
| $Q_{\mathrm{scale}}$ | documented normalization floor for zero-crossing observables | $\text{observable-dependent}$ |
| $\rho$ | mesh refinement ratio | $1$ |

(shared-domain-assumptions-and-validity)=
## Assumptions and validity

1. **Disjoint partition and semantic markers:** Every magnetic volume has an unambiguous positive semantic marker and exterior air carries canonical marker `0`. Overlapping magnetic volumes without an explicit region/imprint rule are invalid.
2. **Conforming interfaces:** Ordinary continuous FEM assembly expects shared-node facets across $\Gamma_{rs}$. Coincident duplicate surfaces are nonconforming and are flagged as errors.
3. **Positive orientation:** Every realized volume cell (`tet4`, `prism6`, `pyramid5`) must satisfy positive Jacobian orientation at all quadrature points; inverted or collapsed cells fail the build.
4. **Fail-closed compatibility record:** Equation {eq}`eq-shared-policy-contract` denotes a validated metadata tuple, not an effective meshing law. Non-default values of `SharedMeshAssemblyPolicy` fail closed in `_validate_shared_mesh_assembly_policy` rather than being silently ignored.
5. **Thin-film shared-domain routes:** Single axis-aligned thin-film boxes inside a box airbox support two strict conforming prismatic routes in addition to `conformal_occ` tetrahedral assembly:
   - `transition="pure_prism"` (`pure_prism_extruded_shared_domain`, topology family `pure_prism_p2`): three-stage extruded 100% `prism6` magnetic-plus-air mesh with zero pyramids and zero tetrahedra, automatically resolving P2 `H1_WedgeElement(2)` scalar demagnetization potential alongside P1 magnetization $\mathbf{m}_h$ on FEM CPU and FEM GPU (`cg_amg` and `cuDSS`).
   - `transition="pyramid_to_tetrahedra"` (`single_geometry_geo_mixed`, topology family `mixed_p1`): `prism6` film coupled to `tet4` air through `pyramid5` transitions, repaired for arbitrary layer counts (`layers=1,2,3`) by the deterministic Chebyshev-center mixed-tet untangler (`_untangle_same_side_mixed_tetrahedra`, reducing `same_side_two_owner_face` `6 -> 0` on a $300\times 300\times 5\;\mathrm{nm}$ film at `layers=2`).

### Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Open-boundary demag with one or many general bodies | Conforming OCC tetrahedral shared domain (`conformal_occ`) | One continuous scalar-potential domain with shared interfaces and semantic markers |
| Thin rectangular film requiring sub-percent demag accuracy on GPU | `transition="pure_prism"` (`pure_prism_p2`) | Pyramid-free 100% `prism6` shared domain unlocking automatic P2 wedge potential (`-0.60%` Aharoni error at `L=2`, `0.51 s` mesh) |
| Thin rectangular film needing P1 mixed prism-pyramid-tet airbox | `transition="pyramid_to_tetrahedra"` (`mixed_p1`) | Low-DOF P1 mixed domain with `layers=1,2,3` Chebyshev untangler; note P1 demag deficit vs P2 |
| Object-only exchange without exterior solve | Object-only FEM mesh | Exterior air region is unnecessary when no coupled exterior operator is active |
| Imported nonconforming component meshes | Remesh into shared domain or preserve owned STL shells | Ordinary continuous FEM assembly cannot assume duplicated surfaces are conforming |

(shared-domain-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows document the public signature and `ProblemIR` contract for this page.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.universe(mode=...)` | `str \| None` | `None` | $1$ | forwarded to `StudyUniverseConfig`; `auto` or `manual` | domain mode | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.mode` |
| `study.universe(size=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | `as_vector3`; explicit dimensions must be positive when realized | outer dimensions | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.size` |
| `study.universe(center=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | `as_vector3` | outer center | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.center` |
| `study.universe(padding=...)` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | `as_vector3`; non-negative per axis | directional padding | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.padding` |
| `study.universe.mesh(maximum_element_size=...)` | `float \| None` | `None` | $\mathrm{m}$ | positive finite | airbox coarse target | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_hmax` |
| `study.universe.mesh(minimum_element_size=...)` | `float \| None` | `None` | $\mathrm{m}$ | positive and no greater than numeric maximum | airbox lower clamp | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_hmin` |
| `study.universe.mesh(maximum_element_growth_rate=...)` | `float \| None` | `None` | $1$ | finite, strictly greater than `1.0`, and at most `2.5` | airbox growth target | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_growth_rate` |
| `study.universe.mesh(grading=...)` | `str \| None` | `None` | $1$ | normalized to `auto`, `geometric`, or `linear` in `StudyUniverseConfig` | airbox grading request | FEM CPU/GPU capability-gated | `runtime_metadata.study_universe.airbox_grading` |
| `SharedMeshAssemblyPolicy.interface_hmax_factor` | `float` | `0.5` | $1$ | finite real in $(0,1]$; `TypeError`/`ValueError`; non-default rejected at realization | compatibility field | FEM CPU/GPU capability-gated | `shared_mesh_policy.interface_hmax_factor` |
| `SharedMeshAssemblyPolicy.enforce_conforming` | `bool` | `True` | $1$ | boolean; `TypeError` otherwise; non-default rejected at realization | compatibility field | FEM CPU/GPU capability-gated | `shared_mesh_policy.enforce_conforming` |
| `SharedMeshAssemblyPolicy.airbox_hmax_factor` | `float` | `3.0` | $1$ | finite positive real; `TypeError`/`ValueError`; non-default rejected at realization | compatibility field | FEM CPU/GPU capability-gated | `shared_mesh_policy.airbox_hmax_factor` |

```python
# %% Study setup and canonical SharedMeshAssemblyPolicy record
import fullmag as fm
from fullmag.model import SharedMeshAssemblyPolicy

nm = 1.0e-9
compatibility_policy = SharedMeshAssemblyPolicy(
    interface_hmax_factor=0.5,
    enforce_conforming=True,
    airbox_hmax_factor=3.0,
)
compatibility_policy_ir = compatibility_policy.to_ir()

# %% Shared-domain FEM study with two magnetic bodies and explicit airbox grading
study = fm.study("shared_domain_contract")
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

# %% Interactions and relaxation stage
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", dt=5.0e-13, max_steps=1)
```

(shared-domain-problem-ir)=
## ProblemIR

`SharedMeshAssemblyPolicy.to_ir()` emits the three canonical compatibility keys (`interface_hmax_factor`, `enforce_conforming`, `airbox_hmax_factor`). `StudyUniverseConfig.to_ir()` writes `mode`, `size`, `center`, `padding`, `airbox_hmax`, `airbox_hmin`, `airbox_growth_rate`, `airbox_grading`, and—when authored—`airbox_curvature_factor` and `airbox_narrow_region_resolution` under `runtime_metadata.study_universe`. Per-object mesh intent lowers under `runtime_metadata.mesh_workflow.per_geometry[]`, including `transition_policy` (`"pyramid_to_tetrahedra"`, `"pure_prism"`, or `"reject"`).

After realization, the shared-domain build report records `requested_method`, `actual_method`, realized cell-family counts, marker maps, quality statistics, and—for certified prismatic routes—exactly one mutually exclusive certificate (`mixed_layer_topology_certificate`, `mixed_layer_topology_certificate_v2`, or `pure_prism_topology_certificate` with `schema_version = "pure_prism_topology_certificate.v1"` and `topology_fingerprint_version = "v3"`).

(shared-domain-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** Authored universe dimensions, air-mesh grading controls, object mesh policies, semantic selectors, and the canonical `SharedMeshAssemblyPolicy` record.
- **Resolved execution:** The selected build route (`conformal_occ`, `single_geometry_geo_mixed`, `pure_prism_extruded_shared_domain`, `component_aware`, or reported fallback), extracted typed CSR mesh connectivity, compact marker maps, conformity diagnostics, and topology certificate.
- **Validation errors:** Field-domain errors in `SharedMeshAssemblyPolicy.__post_init__`, non-default `SharedMeshAssemblyPolicy` rejected by `_validate_shared_mesh_assembly_policy` (`shared_mesh_assembly_policy_unsupported`), invalid universe dimensions/containment, growth rates outside $(1.0, 2.5]$, negative Jacobians, nonconforming interfaces, or mismatched certificate fingerprints.
- **Unsupported combinations:** Non-default assembly policies, uncertified mixed or pure-prism meshes in strict mode, overlapping magnetic regions without explicit ownership, or cell families unsupported by the chosen physics/device fail closed with `fallback=none` rather than silently substituting an unrequested topology.

(shared-domain-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented | Conforming OCC tetrahedral, certified `mixed_p1` (`layers=1,2,3`), and certified `pure_prism_p2` (automatic P2 wedge demag + P1 $\mathbf{m}_h$) shared-domain execution |
| FEM | GPU | implemented (capability-gated) | Tetrahedral, certified `mixed_p1` (including `layers=2` untangled), and certified `pure_prism_p2` (RTX 4080 SUPER verified with `cg_amg`, `cuDSS`, and unified CSR GPU DMI); see {ref}`numerical-methods-performance-fem-gpu-demag` |
| FDM | CPU | not applicable | Structured Cartesian FDM grids do not lower through the unstructured FEM shared-domain pipeline |
| FDM | GPU | not applicable | Structured Cartesian FDM grids do not lower through the unstructured FEM shared-domain pipeline |

### Control Room workflow

1. **Object policies:** In **Explorer**, select each magnetic object's **Mesh** node to open `ObjectMeshSpecPanel.tsx` (`ObjectMeshInspectorSpecPanel`). Enable **Use object policy** when overriding study defaults, configure sizing/sweep/refinement groups, and select **Apply Object Policy**.
2. **Universe / airbox policy:** Select **Universe / Airbox Mesh** (`AirboxMeshOverviewSpec.tsx`, `AirboxMeshSizingSpecs.tsx`) to set explicit **Size / Center** or **Padding**, element bounds, growth rate, grading, curvature factor, and narrow-region resolution, then select **Apply Airbox Policy**.
3. **Shared-domain build & inspection:** Select **Apply & Build Shared-Domain Mesh** (`mesh.build-shared-domain`) and inspect the realized manifest, effective configuration, interface conformity, and quality scopes in **Mesh Root / Shared Domain** (`MeshRootSpec.tsx`, `SharedDomainMeshSpec.tsx`). Always verify the backend-returned effective values rather than form inputs alone.

(shared-domain-implementation-mapping)=
## Implementation mapping

`SharedMeshAssemblyPolicy` owns compatibility validation and `to_ir()`; `_validate_shared_mesh_assembly_policy` enforces the canonical-default fail-closed boundary at realization time. `StudyUniverseHandle` authors the public universe; `_build_problem` and `Problem.to_ir()` lower requested metadata; `realize_fem_domain_mesh_asset_from_components_with_report` dispatches between OCC fragmentation (`generate_shared_domain_mesh_via_occ`), mixed swept builds with Chebyshev untangling (`_untangle_same_side_mixed_tetrahedra`), and pure-prism extruded shared-domain builds (`generate_pure_prism_box_airbox_mesh`). `fullmag_plan::plan` and `run_planned_problem` enforce downstream topology certificates and runtime capabilities.

(shared-domain-validation)=
## Validation

Production verification checks every realized shared-domain resource:

- geometry and mesh revisions match the active model;
- requested and realized discretization, topology, polynomial order, and layer count agree (or carry an explicit permitted fallback);
- every required region has nonzero cells, complete markers, zero inverted/degenerate elements, and zero orphan/coincident/nonmanifold facets;
- `MeshQualityReport` reports signed inverse condition number (SICN) and gamma/radius statistics (`gamma_min=0.08` and `SICN p05=0.1` are implementation report gates, not universal physical acceptance thresholds);
- a three-level mesh-refinement sequence demonstrates observable convergence per {eq}`eq-meshing-relative-change-fem-shared-domain`.

On the $300\times 300\times 5\;\mathrm{nm}$ Permalloy thin-film benchmark (RTX 4080 SUPER), `pure_prism_p2` (`transition="pure_prism"`, $h=5.0\;\mathrm{nm}$) meshes in `0.50 s` (`L=1`) and `0.51 s` (`L=2`), achieving `-0.80%` and `-0.60%` uniform demagnetization error against the analytic Aharoni energy and `-0.43%` relaxed total energy difference vs FDM (`51.88 ms/step` with `cuDSS`, `6.73 GiB` VRAM). On the same film at $h=2.5\;\mathrm{nm}$, `layers=2`, `transition="pyramid_to_tetrahedra"`, `_untangle_same_side_mixed_tetrahedra` reduces `same_side_two_owner_face` `6 -> 0` and yields a conforming GPU-executable mesh. See {ref}`numerical-methods-performance-fem-gpu-demag` for complete benchmark tables.

(shared-domain-limitations)=
## Limitations

- Non-default `SharedMeshAssemblyPolicy` values (`interface_hmax_factor != 0.5`, `enforce_conforming != True`, or `airbox_hmax_factor != 3.0`) have no validated shared-domain lowering and fail closed with `shared_mesh_assembly_policy_unsupported`.
- `pure_prism_p2` currently targets a single axis-aligned `Box` film inside a box airbox with open-boundary Poisson Robin or Dirichlet demagnetization; multi-body disconnected geometries, periodic `pure_prism_p2`, Fredkin–Koehler FEM/BEM, and Zhang–Li STT remain fail-closed on this topology.
- A geometrically valid shared-domain mesh does not replace an observable-based refinement and airbox-distance convergence study.

(shared-domain-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics with Applications* **81** (2021), 42–74, [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

## Related documentation

- [Shared-domain branch](fem/shared-domain/index.md)
- [Airbox](airbox.md)
- [Swept-prism ferromagnet mesh](fem/ferromagnet/swept-prism.md)
- [Mixed elements](fem/ferromagnet/mixed-elements.md)
- {ref}`numerical-methods-performance-fem-gpu-demag`

(shared-domain-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| shared_policy | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L1050) | [`class SharedMeshAssemblyPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L1050) | compatibility validation and lowering | source-inspected |
| shared_policy_guard | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L240) | [`_validate_shared_mesh_assembly_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L240) | fail-closed rejection of non-default assembly policies | source-inspected |
| public_study | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | public study entry point | source-inspected |
| universe_authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5691) | [`class StudyUniverseHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5691) | public shared-domain authoring | source-inspected |
| problem_lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | [`_build_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | builder-state lowering | source-inspected |
| problem_ir | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | ProblemIR and geometry-asset serialization | source-inspected |
| domain_realization | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | [`realize_fem_domain_mesh_asset_from_components_with_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | shared-domain realization and report | source-inspected |
| occ_shared | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L536) | [`generate_shared_domain_mesh_via_occ`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py#L536) | conformal OCC realization | source-inspected |
| pure_prism_mesher | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6667) | [`generate_pure_prism_box_airbox_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6667) | 100% `prism6` pure-prism shared-domain generator and certificate emitter | RTX 4080 SUPER verified |
| mixed_untangler | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2501) | [`_untangle_same_side_mixed_tetrahedra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2501) | deterministic Chebyshev-center mixed-tet conformity repair (`layers=2`) | RTX 4080 SUPER verified |
| planner | [`crates/fullmag-plan/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | [`plan`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | ProblemIR planning and compatibility | verified |
| runtime | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | [`run_planned_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | planned runtime dispatch | verified |
| ui_shared_domain | [`apps/control-room/src/modules/inspector/inspectors/mesh/SharedDomainMeshSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/SharedDomainMeshSpec.tsx#L63) | [`function MeshSharedDomainInspectorSpecPanel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/SharedDomainMeshSpec.tsx#L63) | Control Room shared-domain inspector | source-inspected |
