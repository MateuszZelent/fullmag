---
title: "Swept-prism ferromagnet mesh"
description: "Exact layered prism meshing (`pure_prism_p2` and `mixed_p1`) for supported sweepable thin films."
summary: "The strict route produces native `prism6` layers via either pyramid-free 100% `prism6` pure-prism P2 (`transition=\"pure_prism\"`) or mixed `prism6 + pyramid5 + tet4` (`transition=\"pyramid_to_tetrahedra\"`), rejecting topology, layer, and transition mismatches."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "GeometryMeshHandle.thin_film, PerObjectMeshRecipe, generate_pure_prism_box_airbox_mesh, PurePrismTopologyCertificateV1IR, unified CSR GPU DMI, RTX 4080 SUPER A/B audit"
---

(public-docs-numerical-methods-meshing-fem-ferromagnet-swept-prism)=
# Swept-prism ferromagnet mesh

(swept-prism-problem-statement)=
## Physical problem

The strict swept-prism route extrudes a triangular source face into native `prism6` layers without splitting prisms into tetrahedra. Fullmag provides two certified shared-domain realizations for single axis-aligned rectangular thin films inside a box airbox:

1. **Pure-prism P2 (`transition="pure_prism"`, topology family `pure_prism_p2`):** A three-stage extruded **100% `prism6`** magnetic-plus-air shared domain containing zero pyramids and zero tetrahedra ($L \ge 1$). Because MFEM pyramids are absent, the nonperiodic scalar demagnetization potential resolves automatically in conforming **P2 `H1_WedgeElement(2)`** space $W_h^2$ while keeping nodal **P1 magnetization** $\mathbf{m}_h \in (V_h^1)^3$ on both FEM CPU and FEM GPU (`cg_amg` and `cuDSS`).
2. **Mixed P1 (`transition="pyramid_to_tetrahedra"`, topology family `mixed_p1`):** A `prism6` magnetic film coupled through `pyramid5` transitions to `tet4` exterior air (`layers=1,2,3`), repaired at `layers >= 2` by the deterministic Chebyshev-center untangler (see [Mixed-element FEM meshes](mixed-elements.md)).

(swept-prism-governing-equations)=
## Governing equations

An exact swept-prism magnetic body realizes $N_{\mathrm{planes}} = n + 1$ planar node sheets and exclusively `prism6` volume cells:

```{math}
:label: eq-swept-prism-layer-planes
N_{\mathrm{planes}}=n+1,\qquad t_c=\mathrm{prism6}\ \text{in the swept body}.
```

In `pure_prism_p2` (`transition="pure_prism"`), the shared domain $D = \Omega_m \cup \Omega_{\mathrm{air}}$ is extruded in three consecutive stages (lower graded air slabs, $n = L \ge 1$ uniform film layers alongside lateral air, and upper graded air slabs) from one conforming 2D triangular base mesh with lateral distance-graded target size:

```{math}
:label: eq-swept-prism-lateral-size
h_{\mathrm{2D}}(u,v)=\min\!\bigl(h_{\mathrm{air}},\;h_{\mathrm{inplane}}+(g_{\mathrm{lat}}-1)\,d_{\mathrm{film}}(u,v)\bigr).
```

(swept-prism-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $n$ | Requested element-layer count | $1$ |
| $N_{\mathrm{planes}}$ | Resolved node-plane count | $1$ |
| $t_c$ | Swept-body cell family | $1$ |
| $c$ | Volume-cell ordinal | $1$ |
| $h_{\mathrm{2D}}$ | Graded 2D lateral base element target size | $\mathrm{m}$ |
| $h_{\mathrm{air}}$ | Maximum outer airbox lateral element size | $\mathrm{m}$ |
| $h_{\mathrm{inplane}}$ | Target in-plane element size on the magnetic film | $\mathrm{m}$ |
| $g_{\mathrm{lat}}$ | Lateral element growth rate | $1$ |
| $d_{\mathrm{film}}$ | In-plane distance from the magnetic film footprint | $\mathrm{m}$ |

(swept-prism-assumptions-and-validity)=
## Assumptions and validity

- The shared-domain `pure_prism_p2` route targets a single axis-aligned `Box` film inside a box airbox with `order=1` magnetization, fixed through-thickness distribution, triangular source faces, `exact_layers=True`, and integer `layers >= 1`, certified by `PurePrismTopologyCertificateV1IR` (`schema_version = "pure_prism_topology_certificate.v1"`, `topology_fingerprint_version = "v3"`, zero pyramids, zero tetrahedra, `lower_air_layer_count >= 1`, `upper_air_layer_count >= 1`, `nonconforming_face_count == 0`, `prism6 scaled_jacobian_p05 >= 0.1`, `fallbacks_triggered == []`).
- Accepted physics scope on `pure_prism_p2` (FEM CPU and FEM GPU, double precision): exchange, open-boundary Poisson Robin or Dirichlet demagnetization (`cg_amg` or `cuDSS`), uniform Zeeman and regional field drives, uniform or nodal-P1 uniaxial and cubic anisotropy, and unified CSR GPU DMI (interfacial, rotated interfacial, and bulk) across relaxation (`PGBB`, `NCG`, `LLG overdamped`) and explicit dynamics (`Heun`, `RK4`, `RK23`, `RK45`).
- Non-qualified extensions stay strictly fail-closed (`fallback=none`): eigenmodes (uncertified `prism6` fails with `fem_pure_prism_p2_certificate_required`; certified `pure_prism_p2` fails with `fem_pure_prism_p2_scope_rejected` / `unsupported_study`), periodic `pure_prism_p2`, Fredkin–Koehler FEM/BEM, Zhang–Li STT, Oersted, thermal Brown, magnetoelastic, and element-DG0 `Ms`.
- For `transition="pyramid_to_tetrahedra"`, Control Room enables authoring when layered-prism capabilities are executable and `supported_layer_counts == [1, 2, 3]`.

(swept-prism-python-api)=
## Python API

```python
# %% Study, GPU device, and shared airbox universe
import fullmag as fm

nm = 1e-9
study = fm.study("strict_pure_prism_p2")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(900 * nm, 900 * nm, 600 * nm), center=(0.0, 0.0, 0.0))
study.universe.mesh(
    maximum_element_size=110 * nm,
    minimum_element_size=10 * nm,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)

# %% Pure-prism P2 thin-film policy (100% prism6, L=2, automatic P2 demag potential)
film = study.geometry(fm.Box(size=(300 * nm, 300 * nm, 5 * nm), name="film"), name="film")
film.mesh.thin_film(
    maximum_element_size=5 * nm,
    minimum_element_size=5 * nm,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pure_prism",
    order=1,
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, gpu_strategy="cudss")
study.stages.add_relax(stage_id="equilibrium", algorithm="projected_gradient_bb", tolT=1e-7)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hmax` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive finite number or `auto`; overridden by `maximum_element_size` | Compatibility maximum-size alias | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `maximum_element_size` |
| `hmin` | `float \| None` | `None` | $\mathrm{m}$ | positive; overridden by `minimum_element_size`; resolved minimum must not exceed numeric maximum | Compatibility minimum-size alias | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `minimum_element_size` |
| `maximum_element_size` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive finite number or `auto`; takes precedence over `hmax` | In-plane size ceiling | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `maximum_element_size` |
| `minimum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; takes precedence over `hmin`; must not exceed numeric maximum | Lower size bound | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `minimum_element_size` |
| `order` | `int \| None` | `None` | $1$ | prismatic topology accepts only `None` or `1` and lowers to P1 magnetization (`pure_prism_p2` auto-resolves P2 demag potential) | FEM magnetization polynomial order | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `order` |
| `curvature_factor` | `float \| None` | `None` | $1$ | float-convertible; downstream recipe requires a positive value when set | Curvature-refinement strength | FEM CPU/GPU capability-gated; FDM N/A | `curvature_factor` |
| `narrow_region_resolution` | `float \| None` | `None` | $1$ | float-convertible; downstream recipe requires a positive value when set | Narrow-region refinement strength | FEM CPU/GPU capability-gated; FDM N/A | `narrow_region_resolution` |
| `layers` | `int` | `1` | $1$ | bool rejected; integer `>= 1` (`>= 1` for `pure_prism`, `1..=3` for `mixed_p1`) | Requested element-layer count | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `through_thickness_elements` |
| `topology` | `Literal["tetrahedral", "prismatic"] \| None` | `None` | $1$ | one of `None`, `tetrahedral`, `prismatic` | Thin-film topology | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `topology` |
| `exact_layers` | `bool \| None` | `None` | $1$ | Boolean; only valid with prismatic topology; strict prismatic rejects `False` outside extended mode | Strict layer-count intent | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `exact_layer_count` |
| `transition` | `Literal["pyramid_to_tetrahedra", "pure_prism", "reject"] \| None` | `None` | $1$ | only valid with prismatic topology; resolves to `pyramid_to_tetrahedra` when omitted or accepts `pure_prism` | Shared-domain transition (`mixed_p1` vs pyramid-free `pure_prism_p2`) | FEM CPU/GPU verified (`pure_prism_p2`, `mixed_p1`); FDM N/A | `transition_policy` |
| `interface_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; used unless `surface_maximum_element_size` is set | Interface size ceiling | FEM CPU/GPU capability-gated; FDM N/A | `interface_hmax` |
| `surface_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; takes precedence over `interface_maximum_element_size` | Surface alias for interface size | FEM CPU/GPU capability-gated; FDM N/A | `interface_hmax` |
| `interface_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; used unless `surface_thickness` is set | Interface refinement-shell thickness | FEM CPU/GPU capability-gated; FDM N/A | `interface_thickness` |
| `surface_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; takes precedence over `interface_thickness` | Surface alias for interface shell | FEM CPU/GPU capability-gated; FDM N/A | `interface_thickness` |
| `transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | number at least 0 or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; used unless surface alias is set | Interface-to-core transition distance | FEM CPU/GPU capability-gated; FDM N/A | `transition_distance` |
| `surface_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | number at least 0 or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; takes precedence over `transition_distance` | Surface alias for transition distance | FEM CPU/GPU capability-gated; FDM N/A | `transition_distance` |
| `edge_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; must be paired with `edge_thickness` | Edge size ceiling | FEM CPU/GPU capability-gated; FDM N/A | `edge_hmax` |
| `edge_thickness` | `float \| None` | `None` | $\mathrm{m}$ | positive; paired with `edge_maximum_element_size`; for Box geometry smaller than half the shorter in-plane dimension | Edge refinement-shell thickness | FEM CPU/GPU capability-gated; FDM N/A | `edge_thickness` |
| `edge_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive number or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; requires the edge pair | Edge-to-core transition distance | FEM CPU/GPU capability-gated; FDM N/A | `edge_transition_distance` |
| `corner_maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; paired with `corner_extent`; when edge size is set must not exceed `edge_maximum_element_size` | Corner size ceiling | FEM CPU/GPU capability-gated; FDM N/A | `corner_hmax` |
| `corner_extent` | `float \| None` | `None` | $\mathrm{m}$ | positive; paired with `corner_maximum_element_size`; for Box geometry smaller than half the shorter in-plane dimension | Corner refinement extent | FEM CPU/GPU capability-gated; FDM N/A | `corner_extent` |
| `corner_transition_distance` | `float \| str \| None` | `None` | $\mathrm{m}$ | positive number or `airbox_boundary`, `airbox-boundary`, `auto_boundary`; sentinels normalize to `airbox_boundary`; requires the corner pair | Corner-to-core transition distance | FEM CPU/GPU capability-gated; FDM N/A | `corner_transition_distance` |

(swept-prism-problem-ir)=
## ProblemIR

For `topology="prismatic"`, `GeometryMeshHandle.thin_film()` lowers to `mesh_strategy="swept_prism"`, `through_thickness_elements=layers`, `through_thickness_distribution="fixed"`, `through_thickness_symmetric=False`, `sweep_face_meshing="triangular"`, `topology="prismatic"`, `sweep_direction="auto"`, `element_family="prism"`, `transition_policy="pure_prism"` (or `"pyramid_to_tetrahedra"` when omitted/selected), `exact_layer_count=True`, and `order=1`.

In Rust IR, `FemTransitionPolicyIR::PurePrism` serializes as `"pure_prism"` and `FemMeshTopologyFamilyIR::PurePrismP2` serializes as `"pure_prism_p2"` inside `FemMixedTopologyProvenanceIR` (`capability_status = "implemented"`). `PurePrismTopologyCertificateV1IR` (`schema_version = "pure_prism_topology_certificate.v1"`, `topology_fingerprint_version = "v3"`, 44 fields) is attached under `build_report.pure_prism_topology_certificate` and `mesh.pure_prism_topology_certificate`, strictly mutually exclusive with V1/V2 mixed-layer certificates.

(swept-prism-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **Requested intent:** Public `thin_film()` call (`transition="pure_prism"` or `transition="pyramid_to_tetrahedra"`) and `gpu_strategy` preserved verbatim through `world.py`, authoring validation, and `script_builder.py`.
- **Resolved execution:** `fullmag-plan` rebinds `pure_prism_topology_certificate` post-packing via `mixed_topology_fingerprint_v3()` (`validate_pure_prism_topology_certificate_against_mesh`) and publishes `resolved_topology = "pure_prism_p2"`; native C++ resolves `potential_order = 2` (`H1_WedgeElement(2)`) and unified CSR GPU DMI channels (`dmi_csr.{interfacial,bulk}`).
- **Validation errors:** Missing certificates (`fem_pure_prism_p2_certificate_required`), mismatched `v3` fingerprints, simultaneous V1/V2/`pure_prism` certificates, degraded/fallback-bearing build reports, nonconforming or inverted faces, `layers < 1`, non-P1 magnetization order, or `hex` combined with `pure_prism`.
- **Unsupported combinations:** Eigenmodes (`fem_pure_prism_p2_scope_rejected` / `unsupported_study`), periodic `pure_prism_p2`, Fredkin–Koehler FEM/BEM, Zhang–Li STT, Oersted, thermal Brown, magnetoelastic, element-DG0 `Ms`, and `swept_hex` fail closed (`fallback=none`) without falling back to `mixed_p1`, `tet4`, or CPU.

(swept-prism-discrete-realization)=
## Discrete realization

`generate_pure_prism_box_airbox_mesh` performs three consecutive GEO extrusions from one conforming 2D triangular base mesh with `recombine=True`, emitting 100% `prism6` cells (`1` magnetic, `2 -> 0` air, `material_interface:10`, `exterior:<outer_boundary_marker>`). `generate_swept_mesh` dispatches body-only prism sweeps. On GPU, `build_gpu_dmi_csr_from_mfem` and `fullmag_cuda_dmi_csr_field_energy` evaluate zero-atomic row-wise CSR SpMV DMI across `prism6`, `tet4`, and mixed meshes, while `validate_supported_physics_topology` enforces exact native capability boundaries.

| Solver | Device | Status | Reason |
| --- | --- | --- | --- |
| FEM | CPU | implemented | Verified `pure_prism_p2` (automatic P2 `H1_WedgeElement(2)` demag + P1 $\mathbf{m}_h$) and `mixed_p1` (`layers=1,2,3`) across relaxation and RK dynamics |
| FEM | GPU | implemented (RTX 4080 SUPER verified) | Verified `pure_prism_p2` (`cg_amg` and `cuDSS`), `mixed_p1`, and unified CSR GPU DMI (`dmi_csr_*`, `0` memcheck errors); see {ref}`numerical-methods-performance-fem-gpu-demag` |
| FDM | CPU | not applicable | FEM meshing. |
| FDM | GPU | not applicable | FEM meshing. |

(swept-prism-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle.thin_film` owns public authoring and lowering; `PerObjectMeshRecipe` owns policy validation; `generate_pure_prism_box_airbox_mesh` and `generate_swept_mesh` own shared-domain pure-prism and body-only prism generation; `PurePrismTopologyCertificateV1IR` and `validate_pure_prism_topology_certificate_against_mesh` enforce `v3` certificates; `reject_unsupported_mixed_topology` enforces planner scope including eigen guards; `validate_supported_physics_topology`, `build_gpu_dmi_csr_from_mfem`, and `fullmag_cuda_dmi_csr_field_energy` own native FEM CPU/GPU execution; `resolveObjectMeshTopologyCapabilities` implements the Control Room capability gate.

(swept-prism-validation)=
## Validation

Verified on **NVIDIA GeForce RTX 4080 SUPER** (16 GiB VRAM, `sm_89`, CUDA `12.6`, `cuDSS 0.8.0.10`, MFEM `4.10.0`, `hot_loop_gather_scatter_bytes = 0`) on the $300 \times 300 \times 5\;\mathrm{nm}$ Permalloy thin film ($M_s = 800\;\mathrm{kA/m}$, $A_{\mathrm{ex}} = 13\;\mathrm{pJ/m}$, $\ell_{\mathrm{ex}} \approx 5.69\;\mathrm{nm}$, analytic Aharoni $E_{\mathrm{demag}} = 4.632850 \times 10^{-18}\;\mathrm{J}$, full PGBB relaxation `tolT = 1e-7 T`):

| Configuration ($300 \times 300 \times 5\;\mathrm{nm}$) | P2 Demag DOFs | Mesh time | Uniform $E_{\mathrm{demag}}$ vs Aharoni | Relaxed $E_{\mathrm{total}}$ vs FDM / MuMax3 | Step time | `cuDSS` VRAM |
| --- | --- | --- | --- | --- | --- | --- |
| `pure_prism_p2`, `L=1`, $h=5.0\;\mathrm{nm}$, `cuDSS` | `594,239` | **`0.50 s`** (`246×` vs `tet P2`) | **`-0.80%`** ($4.595727 \times 10^{-18}\;\mathrm{J}$) | `-0.50%` / `+0.22%` ($3.094433 \times 10^{-18}\;\mathrm{J}$) | **`38.53 ms`** (`144.8×` vs `cg_amg`) | **`5.14 GiB`** (`5.52 GB`) |
| `pure_prism_p2`, `L=2`, $h=5.0\;\mathrm{nm}$, `cuDSS` | `709,253` (`5.76×` fewer than `tet P2`) | **`0.51 s`** | **`-0.60%`** ($4.605080 \times 10^{-18}\;\mathrm{J}$) | **`-0.43%` / `+0.30%`** ($3.096700 \times 10^{-18}\;\mathrm{J}$) | **`51.88 ms`** | **`6.73 GiB`** (`7.23 GB`) |
| `pure_prism_p2`, `L=1`, $h=2.5\;\mathrm{nm}$, `cudss` / `auto` | `2,208,719` | `2.53 s` | *(16 GB `cuDSS` preflight blocks `21.18 GiB > 9.10 GiB`; `auto` -> `cg_amg`)* | — | — | est. `21.18 GiB` |

- **Native contract suites:** `fem_pure_prism_p2_gpu_contract` (CPU vs GPU `cg_amg` and `cuDSS`, RK4 `<= 1e-10`, PGBB `<= 1e-9` with exchange + P2 Poisson–Robin + interfacial/bulk DMI), `fem_cuda_csr_dmi_prism_contract` (`0` errors under `compute-sanitizer --tool memcheck`, **`1,953×–4,812×`** vs CPU MFEM on `prism6_120x120x2`), Rust `fullmag-ir`/`fullmag-api`/`fullmag-plan`/`fullmag-runner`, and Python `test_pure_prism_shared_domain_meshing.py` + `test_mixed_element_meshing.py` all pass.
- See {ref}`numerical-methods-performance-fem-gpu-demag` for the full comparative table against `tet P2`, `mixed prism P1`, `fullmag FDM`, and `MuMax3`.

(swept-prism-limitations)=
## Limitations

- **16 GB VRAM scaling boundary at $h = 2.5\;\mathrm{nm}$:** Because columnar extrusion carries in-plane mesh density vertically through the lower and upper air slabs, refining a $300 \times 300 \times 5\;\mathrm{nm}$ film to $h = 2.5\;\mathrm{nm}$ (`L=1`) creates `2,208,719` P2 DOFs with an estimated `21.18 GiB` `cuDSS` factor (`2.8×` smaller than `tet P2`'s `59.4 GiB`, but exceeding the `9.10 GiB` free budget on a 16 GB GPU). Forced `gpu_strategy="cudss"` cleanly aborts during VRAM preflight without OOM, while `gpu_strategy="auto"` falls back to `cg_amg`. On 16 GB GPUs for Permalloy ($\ell_{\mathrm{ex}} \approx 5.69\;\mathrm{nm}$), $h \approx 5.0\;\mathrm{nm}$ is the recommended `pure_prism_p2` + `cuDSS` operating point.
- `pure_prism_p2` currently targets a single axis-aligned `Box` in an open box airbox; non-rectangular footprints, multi-body disconnected geometries, periodic `pure_prism_p2`, eigenmodes, Fredkin–Koehler FEM/BEM, and Zhang–Li STT remain fail-closed.

(swept-prism-scientific-bibliography)=
## Scientific bibliography

- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics with Applications* **81** (2021), 42–74, [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

## Related documentation

- [Mixed-element FEM meshes](mixed-elements.md)
- [Thin-film tetrahedral ferromagnet mesh](thin-film-tetrahedral.md)
- [Swept and layered FEM meshes](../../swept-meshes.md)
- {ref}`numerical-methods-performance-fem-gpu-demag`

(swept-prism-source-code-index)=
## Source-code index

| Path | Stable symbol | Responsibility |
| --- | --- | --- |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2334) | [`thin_film`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2334) | Public prismatic authoring (`pyramid_to_tetrahedra` and `pure_prism`) and lowering |
| [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | [`class PerObjectMeshRecipe`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) | Policy validation |
| [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6667) | [`generate_pure_prism_box_airbox_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L6667) | 3-stage extruded 100% `prism6` shared-domain generator and `pure_prism_topology_certificate.v1` emitter |
| [`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L7578) | [`generate_swept_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py#L7578) | Body-only native swept dispatch |
| [`crates/fullmag-ir/src/mesh_assets.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mesh_assets.rs#L2561) | [`PurePrismTopologyCertificateV1IR`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mesh_assets.rs#L2561) | 44-field pure-prism certificate schema |
| [`crates/fullmag-ir/src/mixed_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) | [`validate_pure_prism_topology_certificate_against_mesh`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/mixed_certificate.rs#L1855) | Post-packing `v3` fingerprint, Jacobian, and conformity re-verification |
| [`crates/fullmag-plan/src/mesh.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/mesh.rs#L2354) | [`reject_unsupported_mixed_topology`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/mesh.rs#L2354) | Planner scope and `pure_prism_p2` eigen certificate guard |
| [`backends/fem/core/fem_mesh.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/fem_mesh.cpp#L765) | [`validate_supported_physics_topology`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/core/fem_mesh.cpp#L765) | Native CPU/CUDA admission of `pure_prism_p2` and `mixed_p1` with CSR DMI |
| [`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp#L138) | [`build_gpu_dmi_csr_from_mfem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp#L138) | Skew-symmetric edge-vector CSR DMI assembly across `prism6`, `tet4`, and mixed meshes |
| [`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu#L331) | [`fullmag_cuda_dmi_csr_field_energy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu#L331) | Deterministic zero-atomic CSR GPU DMI field and energy kernel |
| [`apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts#L138) | [`resolveObjectMeshTopologyCapabilities`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts#L138) | Capability gate |
| [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/tests/test_mixed_element_meshing.py#L1228) | [`test_body_only_box_prism_mesh_has_exact_requested_layers`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/tests/test_mixed_element_meshing.py#L1228) | Exact layers |
