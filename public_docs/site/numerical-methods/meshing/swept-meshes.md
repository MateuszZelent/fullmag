---
title: "Swept and layered FEM meshes"
description: "Layered prism/hex meshing, thickness distributions, transition elements and strict realization certificates."
summary: "Swept meshing extrudes a source surface through a thickness or along a sweep direction. Fullmag supports pure-prism P2 and mixed prism-pyramid-tet shared domains with strict realization certificates while keeping swept-hex fail-closed."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "SweptMeshControls, PerObjectMeshRecipe validation, Gmsh swept & pure-prism generators, Chebyshev untangler, mixed-element extraction and capability matrix"
---

(public-docs-numerical-methods-meshing-swept-meshes)=
# Swept and layered FEM meshes

Swept meshing extrudes a source surface through a thickness or along a sweep direction. In Fullmag, requested layers and topology are strict scientific intent certified by typed realization reports; three outcomes are strictly distinguished—exact layered `prism6` (pure-prism P2 or mixed P1), thickness-aware tetrahedra, and unsupported/fallback topology—and are never conflated.

::::{admonition} Implementation status
:class: important

Two strict `prism6` thin-film shared-domain realizations are implemented and verified on FEM CPU and FEM GPU:
- **`pure_prism_p2` (`transition="pure_prism"`):** 100% `prism6` magnetic-plus-air extruded domain ($L \ge 1$) with automatic P2 `H1_WedgeElement(2)` scalar demagnetization potential and P1 magnetization $\mathbf{m}_h$, certified by `PurePrismTopologyCertificateV1IR` (`v3`).
- **`mixed_p1` (`transition="pyramid_to_tetrahedra"`):** `prism6` film with `pyramid5` transitions to `tet4` air (`layers=1,2,3`), repaired at `layers >= 2` by the deterministic Chebyshev-center untangler (`_untangle_same_side_mixed_tetrahedra`).

`swept_hex` remains schema-only and fail-closed (`status: unsupported`).
::::

(swept-problem-statement)=
## Problem statement

Thin-film and layered micromagnetic structures require controlled through-thickness discretization without exploding isotropic tetrahedral counts. Swept meshing realizes layered `prism6` cells only for source-supported geometry and strategy combinations; the dispatcher never silently substitutes tetrahedra for an unmet strict prism request.

(swept-governing-equations)=
## Governing equations

An exact layered sweep satisfies the requested through-thickness element count

```{math}
:label: eq-swept-layer-contract

N_z=n_{\mathrm{layers}}.
```

Let $s\in[0,1]$ parameterize thickness from source to destination. Uniform layer planes lie at

```{math}
:label: eq-swept-uniform-planes-swept-meshes

s_j=\frac{j}{N_z},\qquad j=0,\ldots,N_z.
```

For geometric element thicknesses $d_j=d_0 q^j$ with ratio $q>0$ and total thickness $t$,

```{math}
:label: eq-swept-geometric-layers-swept-meshes

d_0=t\frac{1-q}{1-q^{N_z}}\quad(q\ne 1),
\qquad d_0=\frac{t}{N_z}\quad(q=1).
```

For `pure_prism_p2` (`transition="pure_prism"`), the shared magnetic-plus-air domain is extruded in three consecutive stages (lower graded air slabs, $L=N_z$ uniform film layers plus lateral air, and upper graded air slabs) from a conforming 2D triangular base mesh with lateral distance-graded target size

```{math}
:label: eq-swept-pure-prism-lateral-size

h_{\mathrm{2D}}(u,v)=\min\!\bigl(h_{\mathrm{air}},\;h_{\mathrm{inplane}}+(g_{\mathrm{lat}}-1)\,d_{\mathrm{film}}(u,v)\bigr).
```

Because the domain contains zero `pyramid5` cells, MFEM resolves the nonperiodic scalar demagnetization potential automatically in conforming P2 wedge space $W_h^2 = H^1_{\mathrm{wedge},2}(D)$ while retaining nodal P1 magnetization $\mathbf{m}_h \in (V_h^1)^3$.

Exchange-length scaling and observable convergence follow

```{math}
:label: eq-meshing-exchange-length-swept-meshes

\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0 M_s^2}},
```

```{math}
:label: eq-meshing-relative-change-swept-meshes

\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1.
```

(swept-symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
| --- | --- | --- |
| $N_z$ | realized through-thickness layer count | $1$ |
| $n_{\mathrm{layers}}$ | requested layer count | $1$ |
| $s_j$ | normalized thickness coordinate of layer plane $j$ | $1$ |
| $d_j$ | thickness of swept layer $j$ | $\mathrm{m}$ |
| $d_0$ | first swept layer thickness | $\mathrm{m}$ |
| $q$ | geometric through-thickness ratio | $1$ |
| $t$ | total swept film thickness | $\mathrm{m}$ |
| $h_{\mathrm{2D}}$ | graded 2D lateral base element target size | $\mathrm{m}$ |
| $h_{\mathrm{air}}$ | outer airbox maximum lateral element size | $\mathrm{m}$ |
| $h_{\mathrm{inplane}}$ | target in-plane element size on the magnetic film | $\mathrm{m}$ |
| $g_{\mathrm{lat}}$ | lateral element growth rate | $1$ |
| $d_{\mathrm{film}}$ | in-plane distance from the magnetic film footprint | $\mathrm{m}$ |
| $\ell_{\mathrm{ex}}$ | magnetostatic exchange length | $\mathrm{m}$ |
| $A$ | exchange stiffness constant | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\varepsilon_h$ | relative mesh-refinement change in observable $Q$ | $1$ |
| $Q_h$ | physical observable at characteristic size $h$ | $\text{observable-dependent}$ |
| $Q_{\mathrm{scale}}$ | normalization floor for zero-crossing observables | $\text{observable-dependent}$ |
| $\rho$ | mesh refinement ratio | $1$ |

(swept-assumptions-and-validity)=
## Assumptions and validity

- Equation {eq}`eq-swept-layer-contract` is verified post-build by the realization certificate ($N_z+1$ node planes, plane coordinates within tolerance, positive Jacobians, complete markers, and zero unreported tetrahedral replacement).
- Body-only native prism extrusion accepts axis-aligned `Box` (and canonical-Z cylinders); shared-domain `pure_prism` and `pyramid_to_tetrahedra` routes target a single axis-aligned `Box` inside a box airbox.
- Explicit `swept_hex` raises `ValueError` before Gmsh starts and never silently realizes prisms or tetrahedra.
- In thin-film 3D workflows, Gmsh surface algorithm `8` is sanitized to algorithm `6` for stability.

### Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Thin rectangular film needing accurate GPU demagnetization (`< 1%` Aharoni) | `swept_prism` + `transition="pure_prism"` (`pure_prism_p2`) | 100% `prism6` shared domain unlocking automatic P2 `H1_WedgeElement(2)` potential + P1 $\mathbf{m}_h$ (`0.50–0.51 s` mesh, `-0.60%` Aharoni at `L=2`) |
| Thin rectangular film needing minimal P1 DOF count | `swept_prism` + `transition="pyramid_to_tetrahedra"` (`mixed_p1`) | Low-VRAM P1 mixed mesh with `layers=1,2,3` Chebyshev untangler; note P1 demag deficit (`-26%..-33%` Aharoni on 5 nm film) |
| Thin body without exact prism requirement | `thin_film_tetrahedral` | Thickness-aware tetrahedral sizing without exact layer-plane certification |
| Quadrilateral source / hexahedral sweep | `swept_hex` — currently unsupported | Schema-only; fails closed until qualified |

(swept-python-api)=
## Python API

### Complete public signature and IR matrix

The following rows document the public signature and `ProblemIR` contract for swept policy fields on `GeometryMeshHandle`.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mesh_strategy` | `str \| None` | `None` | $1$ | stored without standalone vocabulary validation; typed prism/hex intent requires `swept_prism`/`swept_hex` | generator family | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].mesh_strategy` |
| `topology` | `Literal["tetrahedral", "prismatic"] \| None` | `None` | $1$ | exact vocabulary; tetrahedral topology contradicts explicit swept element intent | topology request | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].topology` |
| `through_thickness_elements` | `int \| None` | `None` | $1$ | non-Boolean integer at least `1`; required for layered intent (`>= 1` for `pure_prism`, `1..=3` for `mixed_p1`) | requested layers | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].through_thickness_elements` |
| `through_thickness_distribution` | `Literal["fixed", "linear", "exponential"] \| None` | `None` | $1$ | must be `fixed`, `linear`, or `exponential`; exact layer count requires `fixed` | layer spacing | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].through_thickness_distribution` |
| `through_thickness_element_ratio` | `float \| None` | `None` | $1$ | finite positive; exact layer count permits `1.0` | grading ratio | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].through_thickness_element_ratio` |
| `through_thickness_symmetric` | `bool \| None` | `None` (stored state `False`) | $1$ | non-None value must be Boolean; exact layer count rejects `True` | mirrored grading | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].through_thickness_symmetric` |
| `sweep_face_meshing` | `Literal["triangular", "quadrilateral"] \| None` | `None` | $1$ | prism requires triangular; hex requires quadrilateral | source-face topology | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].sweep_face_meshing` |
| `sweep_direction` | `Literal["auto", "x", "y", "z"] \| None` | `None` | $1$ | exact vocabulary; required for layered intent | sweep axis | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].sweep_direction` |
| `element_family` | `Literal["prism", "hex"] \| None` | `None` | $1$ | exact vocabulary and strategy/face consistency checks | volume family | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].element_family` |
| `transition_policy` | `Literal["pyramid_to_tetrahedra", "pure_prism", "reject"] \| None` | `None` | $1$ | prismatic shared route requires `pyramid_to_tetrahedra` or `pure_prism`; hex rejects both | shared-domain transition | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].transition_policy` |
| `exact_layer_count` | `bool \| None` | `None` | $1$ | Boolean; strict prismatic route requires `True` | layer-count certificate requirement | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].exact_layer_count` |
| `order` | `int \| None` | `None` | $1$ | prismatic magnetization intent supports only `1`; `pure_prism_p2` automatically resolves P2 scalar potential | FEM order request | FEM CPU/GPU capability-gated | `mesh_workflow.per_geometry[].order` |

`generate_swept_mesh(...)` and `generate_pure_prism_box_airbox_mesh(...)` are internal realization entry points; public stage scripts author equivalent policy through `film.mesh(...)` or `film.mesh.thin_film(...)`.

```python
# %% Study, GPU device, and shared airbox universe
import fullmag as fm

nm = 1.0e-9
study = fm.study("swept_pure_prism_p2_contract")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(900.0 * nm, 900.0 * nm, 600.0 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=110.0 * nm,
    minimum_element_size=10.0 * nm,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)

# %% Pure-prism P2 thin-film mesh policy (100% prism6, L=2, automatic P2 demag potential)
film = study.geometry(fm.Box(size=(300 * nm, 300 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)
film.mesh.thin_film(
    minimum_element_size=5.0 * nm,
    maximum_element_size=5.0 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pure_prism",
    order=1,
)

# %% Interactions, GPU cuDSS demag policy, and PG-BB relaxation stage
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, gpu_strategy="cudss")
study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1e-7)
```

(swept-problem-ir)=
## ProblemIR

Public swept controls lower to `runtime_metadata.mesh_workflow.per_geometry[]` (`transition_policy` serializes as `FemTransitionPolicyIR::PurePrism` = `"pure_prism"`, `"pyramid_to_tetrahedra"`, or `"reject"`). At realization time, `MeshRealizationReport` separates requested and resolved topology, layer count, axis, order, and fallbacks. Certified builds emit either `PurePrismTopologyCertificateV1IR` (`schema_version = "pure_prism_topology_certificate.v1"`, `topology_fingerprint_version = "v3"`, 44 fields) or a mixed-layer certificate (V1/V2), strictly mutually exclusive, while `FemMixedTopologyProvenanceIR` records `resolved_topology = "pure_prism_p2"` (or `"mixed_p1"`) and `capability_status = "implemented"`.

(swept-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** The swept policy tuple (`mesh_strategy`, `topology`, `through_thickness_elements`, `transition_policy`, `exact_layer_count`, `order`).
- **Resolved execution:** The build mode (`pure_prism_extruded_shared_domain` or `single_geometry_geo_mixed`), typed CSR cells, topology certificate, and native P2 wedge potential resolution (`H1_WedgeElement(2)` on `pure_prism_p2`).
- **Validation errors:** Explicit `swept_hex`, non-box prism input, non-Z cylinder input, nonuniform distribution with `exact_layer_count=True`, `hex` combined with `pure_prism` or `pyramid_to_tetrahedra`, missing/mismatched `v3` certificates, or degraded/fallback-bearing build reports.
- **Unsupported combinations:** Periodic `pure_prism_p2`, Fredkin–Koehler FEM/BEM, Zhang–Li STT, Oersted, thermal Brown, magnetoelastic, eigenmodes on `pure_prism_p2` (`fem_pure_prism_p2_scope_rejected`), and element-DG0 `Ms` fail closed (`fallback=none`) without downgrading to `mixed_p1`, `tet4`, or CPU.

(swept-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Reason / Limit |
| --- | --- | --- | --- |
| FEM | CPU | implemented | `pure_prism_p2` (100% `prism6`, P2 demag + P1 $\mathbf{m}_h$) and `mixed_p1` (`layers=1,2,3` with Chebyshev untangler); `swept_hex` unsupported |
| FEM | GPU | implemented (RTX 4080 SUPER verified) | `pure_prism_p2` (`cg_amg` and `cuDSS`), `mixed_p1` (`layers=1,2,3`), and unified CSR GPU DMI (`dmi_csr_*`); `swept_hex` unsupported; see {ref}`numerical-methods-performance-fem-gpu-demag` |
| FDM | CPU | not applicable | Structured Cartesian FDM cells do not use swept FEM extrusion |
| FDM | GPU | not applicable | Structured Cartesian FDM cells do not use swept FEM extrusion |

### Control Room workflow

In `ObjectMeshSpecPanel.tsx` (`ObjectMeshInspectorSpecPanel`), open **Thin-Film Sweep Strategy** and select **Swept prism** when enabled by `resolveObjectMeshTopologyCapabilities`. Inspect the post-build realization certificate in **Quality** and **History** (`MeshQualitySpec.tsx`, `MeshBuildHistorySpec.tsx`): verify $N_z+1$ planes, exact cell-family counts, positive Jacobians, markers, and zero fallback triggers. **Swept hex** stays disabled until qualified.

(swept-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle` and `PerObjectMeshRecipe` own swept authoring and schema validation; `_build_problem` and `Problem.to_ir()` lower metadata; `generate_swept_mesh` owns body-only dispatch; `generate_pure_prism_box_airbox_mesh` owns 3-stage `pure_prism_p2` extrusion and `pure_prism_topology_certificate.v1` emission; `_untangle_same_side_mixed_tetrahedra` repairs `layers >= 2` mixed-tet cavities; `MeshRealizationReport`, `realize_fem_domain_mesh_asset_from_components_with_report`, `fullmag_plan::plan`, and `run_planned_problem` enforce certificates and execution gates.

(swept-validation)=
## Validation

RTX 4080 SUPER verification on the flagship $300\times 300\times 5\;\mathrm{nm}$ Permalloy film ($M_s = 800\;\mathrm{kA/m}$, $A_{\mathrm{ex}} = 13\;\mathrm{pJ/m}$, $\ell_{\mathrm{ex}} \approx 5.69\;\mathrm{nm}$, analytic Aharoni $E_{\mathrm{demag}} = 4.632850 \times 10^{-18}\;\mathrm{J}$, PGBB `tolT = 1e-7 T`):

- **`pure_prism_p2`, $h=5.0\;\mathrm{nm}$, `L=1`, GPU `cuDSS`:** mesh `0.50 s` (`246×` faster than `tet P2` `123 s`), `594,239` P2 DOFs, uniform Aharoni error **`-0.80%`**, relaxed $E_{\mathrm{total}} = 3.094433 \times 10^{-18}\;\mathrm{J}$ (`-0.50%` vs FDM, `+0.22%` vs MuMax3), **`38.53 ms/step`** (`144.8×` vs `cg_amg`), `5.14 GiB` VRAM.
- **`pure_prism_p2`, $h=5.0\;\mathrm{nm}$, `L=2`, GPU `cuDSS`:** mesh `0.51 s`, `709,253` P2 DOFs (`5.76×` fewer than `tet P2`), uniform Aharoni error **`-0.60%`**, relaxed $E_{\mathrm{total}} = 3.096700 \times 10^{-18}\;\mathrm{J}$ (**`-0.43%` vs FDM**, **`+0.30%` vs MuMax3**), **`51.88 ms/step`**, `6.73 GiB` VRAM.
- **Mixed `layers=2` untangler (`transition="pyramid_to_tetrahedra"`, $h=2.5\;\mathrm{nm}$):** `_untangle_same_side_mixed_tetrahedra` reduces `same_side_two_owner_face` **`6 -> 0`** (node `53465`, `reoriented_tets = 2`, margin `4.452e-4`), certifying conforming `layers=1,2,3` execution on GPU `cuDSS` (`180 MB`, `7.52 ms/step`).
- **Unified CSR GPU DMI (`dmi_csr_*`):** machine-precision parity vs CPU MFEM ($h_{\mathrm{rel}} \le 1.12 \times 10^{-15}$) and `1,953×–4,812×` speedup on `prism6_120x120x2`.

See {ref}`numerical-methods-performance-fem-gpu-demag` for the full A/B benchmark breakdown.

(swept-limitations)=
## Limitations

- Columnar extrusion in `pure_prism_p2` propagates in-plane density vertically through upper/lower air slabs: on a 16 GB GPU at $h=2.5\;\mathrm{nm}$ (`2.21M` P2 DOFs, estimated `21.18 GiB` `cuDSS` factor `> 9.10 GiB` budget), forced `cuDSS` cleanly fails preflight without OOM and `auto` falls back to `cg_amg`. For Permalloy on 16 GB GPUs, $h \approx 5.0\;\mathrm{nm}$ ($< \ell_{\mathrm{ex}}$) is the recommended `pure_prism_p2` + `cuDSS` operating point.
- `pure_prism_p2` currently requires a single axis-aligned `Box` in an open box airbox; non-rectangular footprints, multi-body disconnected geometries, periodic `pure_prism_p2`, eigenmodes, and `swept_hex` remain unsupported/fail-closed.

(swept-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics with Applications* **81** (2021), 42–74, [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

## Related documentation

- [Swept prism](fem/ferromagnet/swept-prism.md)
- [Swept hex](fem/ferromagnet/swept-hex.md)
- [Mixed elements](fem/ferromagnet/mixed-elements.md)
- {ref}`numerical-methods-performance-fem-gpu-demag`

(swept-source-code-index)=
## Source-code index

| ID | Path | Symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| swept_mesh | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L7578) | [`generate_swept_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L7578) | layered mesh dispatch and failure semantics | verified |
| pure_prism_mesher | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6667) | [`generate_pure_prism_box_airbox_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6667) | 100% `prism6` pure-prism P2 generator and certificate emitter | RTX 4080 SUPER verified |
| mixed_untangler | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2501) | [`_untangle_same_side_mixed_tetrahedra`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L2501) | Chebyshev-center mixed-tet conformity repair (`layers=2`) | RTX 4080 SUPER verified |
| public_study | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | [`study`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7610) | public study entry point | source-inspected |
| mesh_authoring | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | [`class GeometryMeshHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L1679) | swept-policy authoring and validation | source-inspected |
| problem_lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | [`_build_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L10324) | builder-state lowering | source-inspected |
| problem_ir | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | ProblemIR mesh-workflow serialization | source-inspected |
| realization_report | [`packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L1049) | [`class MeshRealizationReport`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py#L1049) | requested/resolved topology contract | source-inspected |
| domain_realization | [`packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | [`realize_fem_domain_mesh_asset_from_components_with_report`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py#L4283) | shared-domain realization and report | verified |
| planner | [`crates/fullmag-plan/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | [`plan`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/lib.rs#L183) | ProblemIR planning and compatibility | verified |
| runtime | [`crates/fullmag-runner/src/lib.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | [`run_planned_problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/lib.rs#L3784) | planned runtime dispatch | verified |
