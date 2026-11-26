# FEM GPU pure-prism P2 thin-film discretization, unified CSR DMI, and layered conformity repair

- Status: `verified` (Docker DEV GPU CTest, `compute-sanitizer --tool memcheck`, Rust/Python suites, and 300×300×5 nm Permalloy Aharoni + CSR GPU DMI A/B benchmarks verified on RTX 4080 SUPER; see `docs/audits/2026-11-26-fem-prism-p2-gpu-ab.md`)
- Owners: Fullmag FEM GPU & Meshing
- Last updated: 2026-11-26
- Related physics:
  - `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
  - `docs/physics/0406-rotated-interfacial-dmi.md`
  - `docs/physics/0431-fem-demag-mixed-order-potential.md`
  - `docs/physics/0810-periodic-exchange-and-dmi-equivalence-classes.md`
  - `docs/physics/0997-fem-gpu-poisson-direct-cudss.md`
  - `docs/physics/fem_dmi.md`
- Related audits:
  - `docs/audits/2026-11-24-fem-gpu-cudss-film-validation.md`
  - `docs/audits/2026-11-26-fem-prism-p2-gpu-ab.md`
- Related specs and plans:
  - `docs/superpowers/specs/2026-11-26-fem-prism-p2-gpu-design.md`
  - `docs/superpowers/plans/2026-11-26-fem-prism-p2-gpu-plan.md`

(problem-statement)=
## 1. Problem statement

Thin-film micromagnetic FEM simulations face a sharp discretization trade-off
documented in `docs/audits/2026-11-24-fem-gpu-cudss-film-validation.md`:

- An all-tetrahedral mesh with P2 scalar potential (`tet P2`) resolves thin-film
  demagnetization within `-0.63%` of the analytic Aharoni energy, but inflates the
  3D mesh and P2 Cholesky factor far beyond single-GPU VRAM budgets
  (`4.08M` P2 DOFs / `59.4 GiB` cuDSS factor on a 300×300×5 nm Permalloy film).
- A mixed `prism6 + pyramid5 + tet4` domain (`mixed_p1`) slashes DOF counts, but
  MFEM pyramids force the scalar potential down to P1, incurring a `-30.11%`
  uniform demagnetization deficit (`-19.36%` in relaxed total energy) on the
  same 300×300×5 nm film.
- Legacy GPU DMI kernels (`dmi_kernels.cu`) hardcoded flat 4-node tetrahedral
  connectivity (`gpu.mesh_geometry`), forcing GPU DMI to fail closed on both
  `mixed_p1` and `pure_prism_p2`.
- For `layers >= 2` on `transition="pyramid_to_tetrahedra"`, Gmsh Delaunay
  triangulation in thin lateral transition air slabs can emit pairs of inverted
  `tet4` elements whose vertex order is reversed to yield positive individual
  determinants while creating `same_side_two_owner_face` overlaps.

This page specifies the unified numerical realization solving all three issues:

1. **Pure-prism P2 shared-domain discretization (`transition="pure_prism"`,
   topology family `pure_prism_p2`):** an extruded 100% `prism6` magnetic-plus-air
   mesh with zero pyramids and zero tetrahedra, automatically resolving P1
   magnetization $\mathbf m_h \in (V_h^1)^3$ coupled to conforming P2
   `H1_WedgeElement(2)` scalar potential $u_h \in W_h^2$ on both FEM CPU and FEM
   GPU (`cg_amg` and `cuDSS`).
2. **Unified preassembled CSR GPU DMI (`dmi_csr_*`):** exact skew-symmetric
   nodal edge-vector reduction covering bulk, conventional interfacial, and
   rotated interfacial (Göbel) DMI, spatially varying $D(\mathbf x)$, and
   periodic equivalence classes across `tet4`, `prism6`, and mixed `H1` P1
   meshes with zero global `atomicAdd` contention.
3. **Deterministic Chebyshev-center untangling (`_untangle_same_side_mixed_tetrahedra`):**
   vectorized `same_side_two_owner_face` detection and interior-node kernel
   relocation with local `tet4` reorientation for `transition="pyramid_to_tetrahedra"`
   at arbitrary layer counts $L \ge 1$.

(governing-equations)=
## 2. Governing equations and discrete operators

### 2.1 Pure-prism P1/P2 shared-domain discretization

Let the shared domain $D = \Omega_m \cup \Omega_{\mathrm{air}}$ be partitioned
exclusively into conforming `prism6` wedges obtained by three consecutive
extrusions along the thin-film axis (lower graded air slabs, $L \ge 1$ uniform
magnetic film layers alongside lateral air, and upper graded air slabs) from a
conforming 2D triangular base mesh with lateral distance-graded target size:

```{math}
:label: eq-pure-prism-lateral-size

h_{\mathrm{2D}}(u,v)
= \min\!\bigl(h_{\mathrm{air}},\; h_{\mathrm{inplane}} + (g_{\mathrm{lat}} - 1)\,d_{\mathrm{film}}(u,v)\bigr).
```

Because $D$ contains zero `pyramid5` cells, the nonperiodic Poisson demag space
resolves automatically to conforming P2 wedges $W_h^2 = H^1_{\mathrm{wedge},2}(D)$
while magnetization remains nodal P1 in $(V_h^1)^3$ (`docs/physics/0431-fem-demag-mixed-order-potential.md`).

### 2.2 Unified skew-symmetric CSR DMI theorem

For every magnetic element $e \in \mathcal E_m$ (`tet4`, `prism6`, or mixed
magnetic `H1` P1 elements), let $\tilde{\phi}_{e,i} = s_{e,i}\phi_{e,i}$ denote
the oriented nodal basis functions, $Q_e$ the MFEM quadrature rule of order
$2 p_e$, and $D_e$ the element-averaged DMI coefficient matching the CPU MFEM
weak-residual reference. Define the skew-symmetric geometric edge vector

```{math}
:label: eq-csr-dmi-edge-gradient

\mathbf g_{ij}
= \sum_{e \in \mathcal E_m} D_e \sum_{q \in Q_e} w_q J_e(q)\,
  \bigl(\tilde{\phi}_{e,i}(q)\,\nabla\tilde{\phi}_{e,j}(q)
      - \tilde{\phi}_{e,j}(q)\,\nabla\tilde{\phi}_{e,i}(q)\bigr),
\qquad \mathbf g_{ii} = \mathbf 0,\quad \mathbf g_{ji} = -\mathbf g_{ij}.
```

Exact algebraic reduction of `dmi_weak_residual.cpp` shows that all three DMI
interactions assemble into a single skew-symmetric edge-vector CSR coupling
$\mathbf d_{ij} = -\mathbf d_{ji}$ ($\mathbf d_{ii} = \mathbf 0$):

```{math}
:label: eq-csr-dmi-edge-vectors

\mathbf d_{ij}^{\mathrm{bulk}} = +\mathbf g_{ij}^{\mathrm{bulk}},
\qquad
\mathbf d_{ij}^{\mathrm{int}} = \mathbf g_{ij}^{\mathrm{int}} \times \hat{\mathbf n},
\qquad
\mathbf d_{ij}^{\mathrm{rot}} = \bigl(0,\; -g_{ij,x}^{\mathrm{rot}},\; -g_{ij,y}^{\mathrm{rot}}\bigr),
```

with combined interfacial channel
$\mathbf d_{ij}^{\mathrm{interfacial}} = \mathbf d_{ij}^{\mathrm{int}} + \mathbf d_{ij}^{\mathrm{rot}}$.
The exact weak residual, lumped-mass effective field, and quadratic energy are:

```{math}
:label: eq-csr-dmi-residual-field-energy

\mathbf R_i = \sum_{j \in \mathcal N(i)} \mathbf d_{ij} \times \mathbf m_j,
\qquad
\mathbf H_i^{\mathrm{DMI}} = -\frac{\mathbf R_i}{\mu_0 M_{s,i} M_i},
\qquad
E_{\mathrm{DMI}}(\mathbf m) = \frac{1}{2}\sum_{i=0}^{N-1}\mathbf m_i \cdot \mathbf R_i.
```

Because $\mathbf d_{ji} = -\mathbf d_{ij}$, the underlying $3N \times 3N$
bilinear form $K_{(i,\alpha),(j,\beta)} = \varepsilon_{\alpha\gamma\beta} d_{ij,\gamma}$
is strictly symmetric ($K = K^{\mathsf T}$). Consequently, for direct-minimizer
Armijo line searches (PGBB and NCG) between $\mathbf m_0$ and $\mathbf m_1$ with
$\mathbf s = \mathbf m_1 + \mathbf m_0$ and $\mathbf q = \mathbf m_1 - \mathbf m_0$,
the exact polarized energy increment is evaluated without catastrophic
cancellation using compensated double-double arithmetic (`gpu_relax_dd`) and an
operand-level `DBL_EPSILON` roundoff bound:

```{math}
:label: eq-csr-dmi-polarized-increment

E_{\mathrm{DMI}}(\mathbf m_1) - E_{\mathrm{DMI}}(\mathbf m_0)
= \frac{1}{2}\sum_{i=0}^{N-1}\mathbf s_i \cdot
  \sum_{j \in \mathcal N(i)} \bigl(\mathbf d_{ij} \times \mathbf q_j\bigr).
```

Under periodic equivalence classes $c = \pi(i)$ (`docs/physics/0810`), class
reduction $P^{\mathsf T} D P$ collapses off-diagonal edges via

```{math}
:label: eq-csr-dmi-periodic-reduction

\mathbf d_{c,c'}^{\mathrm{red}}
= \sum_{i \in c}\sum_{j \in c'} \mathbf d_{ij},
\qquad
M_c^{\mathrm{red}} = \sum_{i \in c} M_i,
```

which preserves $\mathbf d_{c,c}^{\mathrm{red}} = \mathbf 0$ and
$\mathbf d_{c',c}^{\mathrm{red}} = -\mathbf d_{c,c'}^{\mathrm{red}}$ identically.

### 2.3 Deterministic Chebyshev-center untangling for mixed `tet4` cavities

When Gmsh emits inverted `tet4` elements whose shared faces fail the two-owner
opposite-side conformity test ($d_0 d_1 > 0$), each movable interior non-apex
vertex $v$ ($\dim = 3$, $v \notin \mathcal A_{\mathrm{pyr}}$) incident to the
inverted set $I$ is relocated to the Chebyshev center $(\mathbf x^*, r^*)$ of
its consistently oriented star $\mathcal S(v)$:

```{math}
:label: eq-chebyshev-untangle-lp

\max_{\mathbf x \in \mathbb R^3,\; r \in \mathbb R} r
\quad\text{subject to}\quad
\hat{\mathbf u}_t^{\mathrm{in}} \cdot (\mathbf x - \mathbf p_{a,t}) \ge r
\quad \forall t \in \mathcal S(v),
```

where $\hat{\mathbf u}_t^{\mathrm{in}}$ points toward the current vertex for
non-inverted $t \notin I$ and opposite to it for inverted $t \in I$. Whenever
$r^* > 0$ strictly reduces `same_side_two_owner_face` while maintaining all
incident $|\det| > \tau_{\det}$, the node is moved and the affected inverted
tetrahedra in $I \cap \mathcal S(v)$ have two local vertices swapped to restore
positive Jacobian orientation.

(symbols-and-si-units)=
## 3. Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $h_{\mathrm{2D}}$ | graded 2D lateral element target size in outer prism frame | $\mathrm{m}$ |
| $h_{\mathrm{air}}$ | maximum outer airbox element size | $\mathrm{m}$ |
| $h_{\mathrm{inplane}}$ | target in-plane element size on the magnetic film | $\mathrm{m}$ |
| $g_{\mathrm{lat}}$ | lateral element growth rate | $1$ |
| $d_{\mathrm{film}}$ | in-plane distance from magnetic film footprint | $\mathrm{m}$ |
| $\mathcal E_m$ | set of magnetic mesh elements | $1$ |
| $D_e$ | element-averaged DMI constant | $\mathrm{J\,m^{-2}}$ |
| $Q_e$ | element quadrature rule | $1$ |
| $w_q$ | quadrature weight | $1$ |
| $J_e(q)$ | element transformation Jacobian weight | $\mathrm{m^3}$ |
| $\tilde{\phi}_{e,i}$ | oriented scalar P1 basis function | $1$ |
| $\mathbf g_{ij}$ | skew-symmetric nodal edge gradient vector | $\mathrm{J\,m^{-1}}$ |
| $\mathbf d_{ij}$ | assembled skew-symmetric nodal DMI edge vector | $\mathrm{J\,m^{-1}}$ |
| $\hat{\mathbf n}$ | unit interface normal for conventional interfacial DMI | $1$ |
| $\mathbf m_j$ | reduced magnetization vector | $1$ |
| $\mathbf R_i$ | nodal DMI weak residual | $\mathrm{J}$ |
| $\mathbf H_i^{\mathrm{DMI}}$ | projected nodal DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | nodal saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_i$ | lumped scalar mass weight | $\mathrm{m^3}$ |
| $E_{\mathrm{DMI}}$ | total discrete DMI energy | $\mathrm{J}$ |
| $\mathbf s_i$ | chord sum magnetization | $1$ |
| $\mathbf q_j$ | chord difference magnetization | $1$ |
| $\mathbf d_{c,c'}^{\mathrm{red}}$ | periodic class-reduced DMI edge vector | $\mathrm{J\,m^{-1}}$ |
| $M_c^{\mathrm{red}}$ | periodic class-summed lumped mass | $\mathrm{m^3}$ |
| $\mathbf x$ | candidate relocated interior vertex position | $\mathrm{m}$ |
| $r$ | inscribed Chebyshev margin radius of vertex star | $\mathrm{m}$ |
| $\hat{\mathbf u}_t^{\mathrm{in}}$ | inward unit normal of opposite face of star tetrahedron | $1$ |
| $\mathbf p_{a,t}$ | reference vertex on opposite face of star tetrahedron | $\mathrm{m}$ |
| $\mathcal S(v)$ | tetrahedral star incident to interior vertex | $1$ |

(assumptions-and-validity)=
## 4. Assumptions and validity

- `pure_prism_p2` requires a single conforming `prism6`-only shared magnetic-plus-air
  domain certified by `PurePrismTopologyCertificateV1IR` (`schema_version = "pure_prism_topology_certificate.v1"`,
  `topology_fingerprint_version = "v3"`, zero pyramids, zero tetrahedra, exact
  layer count $L \ge 1$, `lower_air_layer_count >= 1`, `upper_air_layer_count >= 1`,
  `nonconforming_face_count == 0`, `prism6 scaled_jacobian_p05 >= 0.1`,
  `fallbacks_triggered == []`).
- Accepted physics scope on `pure_prism_p2` (CPU and GPU, double precision, P1
  magnetization state, P2 scalar potential): exchange, open-boundary Poisson
  Robin or Dirichlet demagnetization (`cg_amg` or `cuDSS`), uniform Zeeman and
  regional field drives, uniform or nodal-P1 uniaxial and cubic anisotropy, and
  interfacial, rotated interfacial, and bulk DMI across relaxation (`PGBB`, `NCG`,
  `LLG overdamped`) and explicit dynamics (`Heun`, `RK4`, `RK23`, `RK45`).
- Non-qualified extensions remain strictly fail-closed (`fallback=none`):
  Fredkin-Koehler FEM/BEM, periodic `pure_prism_p2`, Zhang-Li STT (which stays
  the sole consumer of flat tetrahedral `gpu.mesh_geometry`), Oersted, thermal
  Brown, magnetoelastic, and element-DG0 `Ms`.
- Legacy `dmi_kernels.{hpp,cu}` symbols remain intact solely for standalone `tet4`
  oracle unit tests (`relaxation_energy_derivative_contract.cpp`); all GPU
  runtime RK and relaxation paths execute unified CSR DMI.

(python-api)=
## 5. Python API

`GeometryMeshHandle.thin_film` adds `transition="pure_prism"` alongside the
unchanged default `transition="pyramid_to_tetrahedra"`:

| Python parameter | Type | Default | SI unit | Validation domain | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `GeometryMeshHandle.thin_film.transition` | `str \| None` | `None` | $1$ | `pyramid_to_tetrahedra` or `pure_prism` for conforming shared-domain prismatic films | Selects mixed pyramid/tetra airbox vs pyramid-free 100% prism6 P2-capable shared domain | FEM CPU/GPU | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_policy` |
| `GeometryMeshHandle.thin_film.layers` | `int` | `1` | $1$ | integer `>= 1` for `pure_prism` (`1..=3` for `mixed_p1`) | Exact through-thickness prism6 layers in the magnetic film | FEM CPU/GPU | `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].through_thickness_elements` |
| `FemLinearSolverPolicy.gpu_strategy` | `str` | `auto` | $1$ | `auto`, `cg_amg`, or `cudss` | GPU Poisson linear solver strategy paired with `pure_prism_p2` | FEM GPU | `fem.demag_solver_policy.gpu_strategy` |

```python
# %% Study, engine, device, and mode
import fullmag as fm

study = fm.study("relax_film_300x300x5_pure_prism_p2")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

# %% Shared airbox universe and magnetic film
study.universe(mode="manual", size=(900e-9, 900e-9, 600e-9), center=(0.0, 0.0, 0.0))
study.universe.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=110e-9,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)
film = study.geometry(fm.Box(size=(300e-9, 300e-9, 5e-9), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=2.5e-9,
    maximum_element_size=2.5e-9,
    layers=2,
    topology="prismatic",
    exact_layers=True,
    transition="pure_prism",
    order=1,
)

# %% Interactions and GPU solver policy
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, gpu_strategy="cudss")

# %% Relaxation stage
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", tolT=1e-8)
```

(problem-ir)=
## 6. ProblemIR and typed certificate representation

- `FemTransitionPolicyIR::PurePrism` serializes as `"pure_prism"` under
  `problem_meta.runtime_metadata.mesh_workflow.per_geometry[].transition_policy`.
- `FemMeshTopologyFamilyIR::PurePrismP2` serializes as `"pure_prism_p2"` inside
  `FemMixedTopologyProvenanceIR` (`requested_topology`, `resolved_topology`,
  `accepted_certificate_fingerprint`, `requested_device`, `precision`,
  `capability_status = "implemented"`).
- `PurePrismTopologyCertificateV1IR` (`schema_version = "pure_prism_topology_certificate.v1"`,
  `#[serde(deny_unknown_fields)]`, 44 fields) is stored under
  `build_report.pure_prism_topology_certificate` and `mesh.pure_prism_topology_certificate`,
  strictly mutually exclusive with `mixed_layer_topology_certificate` (V1) and
  `mixed_layer_topology_certificate_v2` (V2).

(round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

- **Requested intent:** Python DSL (`world.py`), scene authoring
  (`crates/fullmag-authoring/src/validation.rs`), and script builder
  (`script_builder.py`) preserve `topology="prismatic"`, `transition="pure_prism"`,
  `layers >= 1`, and `gpu_strategy` verbatim without silently downgrading to
  `pyramid_to_tetrahedra` or `tet4`.
- **Resolved execution:** `fullmag-plan` rebinds `pure_prism_topology_certificate`
  post-packing via `mixed_topology_fingerprint_v3()` (`topology_fingerprint_version = "v3"`)
  and publishes `FemMixedTopologyProvenanceIR` with `resolved_topology = "pure_prism_p2"`
  and `capability_status = "implemented"`; the native C++ backend resolves
  `potential_order = 2` (`H1_WedgeElement(2)`) and CSR GPU DMI channels
  (`dmi_csr.{interfacial,bulk}`).
- **Validation errors:** Missing certificates (`fem_pure_prism_p2_certificate_required`),
  mismatched `v3` fingerprints, simultaneous V1/V2/`pure_prism` certificates,
  degraded or fallback-bearing build reports, nonconforming/inverted faces, or
  `hex` combined with `transition="pure_prism"` raise explicit fail-closed
  validation errors before native execution.
- **Unsupported combinations:** Fredkin-Koehler FEM/BEM, periodic `pure_prism_p2`,
  Zhang-Li STT, Oersted, thermal Brown, magnetoelastic, element-DG0 `Ms`, or
  `pure_prism` metadata attached to a `tet4` mesh fail closed with `fallback=none`
  and never silently fall back from GPU to CPU or from `pure_prism_p2` to `mixed_p1`.

(discrete-realization)=
## 8. Discrete realization and residency

- **Pure-prism meshing:** Three consecutive GEO extrusions from one conforming
  2D triangular base mesh (inner rectangle + `MathEval` distance-graded outer
  frame) with `recombine=True` emit exclusively `prism6` cells (Gmsh physical
  tag `1` `"magnetic"` and tag `2` `"air"` mapped to semantic marker `0`),
  `material_interface:10`, and `exterior:<outer_boundary_marker>`.
- **CSR GPU DMI residency:** `build_gpu_dmi_csr_from_mfem` assembles sorted
  off-diagonal CSR edge vectors $(\mathbf d_{ij})$ once during context bootstrap
  (`context_upload_mfem_dmi_to_gpu_state`) and uploads them to
  `FemGpuState::dmi_csr` (`interfacial` and `bulk` channels, plus optional
  `periodic_reduced` $P^\top D P$). `gpu_state_requires_tetrahedral_mesh_geometry`
  returns `ctx.stt.zhang_li_enabled` exclusively.
- **Zero-atomic deterministic kernels:** `dmi_csr_kernels.cu` evaluates
  row-wise SpMV (`1 thread = 1 row`) with `template <bool ComputeEnergy>`,
  passing `energy_block_sums = nullptr` on intermediate RK stages, using
  deadlock-free predicated `cub::BlockReduce` (zero early `return;` before
  `BlockReduce`), handling `nnz == 0` and `magnetic_node_mask == nullptr`, and
  evaluating Armijo chord differences via `gpu_relax_dd` double-double arithmetic
  into `gpu.reductions.scalar_workspace` and `gpu.rk.k[1].x`.

(implementation-mapping)=
## 9. Implementation mapping

- Meshing & untangling: `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`,
  `_gmsh_types.py`, `_mesh_targets.py`, `persistence.py`, `asset_pipeline.py`,
  `world.py`, `model/discretization.py`, `runtime/script_builder.py`.
- CSR GPU DMI: `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_{state,operator,kernels}.{hpp,cpp,cu}`,
  `backends/fem/gpu/cuda/state/gpu_state.{hpp,cpp}`,
  `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`,
  `backends/fem/gpu/cuda/integrators/rk/{rk_plan.cpp,rk_dmi_fields.cu,rk_dmi_energy_reductions.cu}`,
  `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`.
- Capability unlock & certificates: `backends/fem/core/fem_mesh.cpp`,
  `crates/fullmag-ir/src/{mesh_policy.rs,plan.rs,mesh_assets.rs,mixed_certificate.rs}`,
  `crates/fullmag-authoring/src/validation.rs`,
  `crates/fullmag-api/src/schemas/mesh.rs`,
  `crates/fullmag-plan/src/mesh.rs`,
  `crates/fullmag-runner/src/lib.rs`,
  `packages/fullmag-py/src/fullmag/model/problem.py`.

(validation)=
## 10. Validation

Full managed Docker DEV verification and RTX 4080 SUPER A/B benchmarks are
archived in `docs/audits/2026-11-26-fem-prism-p2-gpu-ab.md`:

- **Native C++/CUDA, Rust, Python, and static gates (Docker DEV, `c401f28b90`):**
  - Non-MFEM CI profile (`-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF`):
    **8/8 PASS** (`0.07 s`).
  - `fem_cuda_csr_dmi_prism_contract`: **PASS** (`1.02 s`) and
    `compute-sanitizer --tool memcheck`: **0 errors**.
  - `fem_pure_prism_p2_gpu_contract`: **PASS** (subprocess-isolated CPU MFEM
    vs GPU `cg_amg` and `cuDSS` on RK4 `<= 1e-10` and 3 PGBB steps `<= 1e-9`
    with exchange, P2 Poisson-Robin demag, interfacial DMI, and bulk DMI).
  - `fem_dmi_weak_residual`, `fem_dmi_contract`, `fem_gpu_state_runtime_contract`,
    `fem_source_facade_gpu_state_contract`, `fem_relaxation_energy_derivative_contract`,
    and all Wave 1 assertions in `fem_mesh_contract` / `fem_gpu_rk_plan` /
    source-facade contracts: **PASS**.
  - Rust: `fullmag-ir` **290/290 PASS**, `fullmag-api` **2/2 PASS**,
    `fullmag-plan` **12/12 PASS**, `fullmag-runner` **9/9 PASS** (default and
    `--features fem-gpu`).
  - Python Wave 1: **103/103 PASS** (`test_pure_prism_shared_domain_meshing.py`
    10/10, `test_mixed_p1_preflight.py` 19/19, `test_script_builder_roundtrip.py`
    67/67, and `test_mixed_element_meshing.py` untangler/`layers=1..3`/legacy
    slice 7/7).
- **Flagship 300×300×5 nm Permalloy thin-film A/B benchmark (RTX 4080 SUPER,
  analytic Aharoni $4.632850 \times 10^{-18}\;\mathrm{J}$, FDM relaxed
  $3.109921 \times 10^{-18}\;\mathrm{J}$, MuMax3 $3.08758 \times 10^{-18}\;\mathrm{J}$):**
  - `pure_prism_p2`, $L=1$, $h=5.0\;\mathrm{nm}$, GPU `cuDSS`: mesh `0.50 s`
    (`594,239` P2 DOFs, `5.52 GB` / `5.14 GiB` device bytes, `9.48 GB` VRAM
    free), uniform $4.595727 \times 10^{-18}\;\mathrm{J}$ (**`-0.80%`** vs
    Aharoni), full PGBB relax (`7,807` steps, `tolT = 1e-7 T`)
    $3.094433 \times 10^{-18}\;\mathrm{J}$ (**`-0.50%`** vs FDM, **`+0.22%`**
    vs MuMax3), **`38.53 ms/step`** (**`144.8×` faster** than `cg_amg`
    `5,579.74 ms/step` on the same mesh).
  - `pure_prism_p2`, $L=2$, $h=5.0\;\mathrm{nm}$, GPU `cuDSS`: mesh `0.51 s`
    (`709,253` P2 DOFs, `5.76×` fewer than `tet P2`, `7.23 GB` / `6.73 GiB`
    device bytes, `7.59 GB` VRAM free), uniform $4.605080 \times 10^{-18}\;\mathrm{J}$
    (**`-0.60%`** vs Aharoni), full PGBB relax (`8,153` steps)
    $3.096700 \times 10^{-18}\;\mathrm{J}$ (**`-0.43%`** vs FDM, **`+0.30%`**
    vs MuMax3; $E_{\mathrm{ex}}$ `-0.06%` vs FDM), **`51.88 ms/step`**.
- **Mixed `layers=2` conformity repair (`300×300×5 nm`, $h=2.5\;\mathrm{nm}$):**
  `_untangle_same_side_mixed_tetrahedra` reduces `same_side_two_owner_face`
  `6 -> 0` (node `53465`, `reoriented_tets = 2`, margin `4.452e-04`),
  producing a certified conforming mesh (`54,016` nodes, `159,714` cells,
  `p05(prism6) = 0.8616`) executing on GPU `cuDSS` (`180 MB`, `7.52 ms/step`).
- **Unified CSR GPU DMI parity and throughput (15 configurations across `tet4`,
  periodic 2D `tet4`, `prism6 60×60×2`, `prism6 120×120×2`, `mixed 30×30×2`):**
  field parity $h_{\mathrm{rel}} \le 1.12 \times 10^{-15}$ and energy parity
  $E_{\mathrm{rel}} \le 4.76 \times 10^{-14}$ vs CPU MFEM; **`1.67–2.51×` faster**
  than legacy `tet4` GPU DMI with energy (**`3.33–4.80×`** on field-only RK
  stages) and **`1,953–4,812×` faster** than CPU MFEM on `prism6_120x120x2`
  (`0.035–0.091 ms` field-only vs `168.5–190.8 ms` CPU).

(limitations)=
## 11. Limitations

- `pure_prism_p2` currently targets a single axis-aligned `Box` geometry inside
  a box airbox with open-boundary Poisson Robin/Dirichlet demagnetization;
  multi-body disconnected geometries and non-rectangular footprints remain
  outside this realization.
- Periodic `pure_prism_p2` (P2 wedge periodic edge/face DOF equivalence classes)
  is not yet qualified and fails closed.
- Zhang-Li STT on GPU still requires tetrahedral `gpu.mesh_geometry` and remains
  fail-closed on `pure_prism_p2` and `mixed_p1`.
- Because columnar extrusion propagates in-plane density vertically through the
  air slabs, very fine in-plane grids such as $h = 2.5\;\mathrm{nm}$ on
  `300×300×5 nm` (`2.21M` P2 DOFs, `21.18 GiB` cuDSS estimate) exceed a 16 GB
  GPU's `cuDSS` budget (`> 9.10 GiB` available) and cleanly trigger either the
  VRAM preflight error (forced `cudss`) or fallback to `cg_amg` (`auto`); for
  Permalloy ($l_{\mathrm{ex}} \approx 5.69\;\mathrm{nm}$) on 16 GB GPUs,
  $h \approx 5.0\;\mathrm{nm}$ is the recommended `pure_prism_p2` + `cuDSS`
  operating point (`< 0.6–0.8%` Aharoni error, `< 7 GiB` VRAM, `38–52 ms/step`).

(scientific-bibliography)=
## 12. Scientific bibliography

1. A. Aharoni, "Demagnetizing factors for rectangular ferromagnetic prisms,"
   *Journal of Applied Physics* **83**, 3432–3434 (1998).
2. A. Bogdanov and U. Rößler, "Chiral symmetry breaking in magnetic thin films
   and multilayers," *Physical Review Letters* **87**, 037203 (2001).
3. B. Göbel, A. Mook, J. Henk, I. Mertig, and O. A. Tretiakov, "Magnetic
   bimerons as skyrmion analogues in in-plane magnets," *Physical Review B*
   **99**, 060407(R) (2019).
4. R. Anderson et al., "MFEM: A modular finite element methods library,"
   *Computers & Mathematics with Applications* **81**, 42–74 (2021).

(source-code-index)=
## 13. Source-code index

| Component | Source path | Symbol | Responsibility |
|---|---|---|---|
| Pure-prism shared-domain mesher (`pure-prism-mesher`) | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_pure_prism_box_airbox_mesh` | 3-stage extruded 100% `prism6` shared-domain generator and `pure_prism_topology_certificate.v1` emitter |
| Pure-prism pipeline routing (`pure-prism-asset-pipeline`) | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `_realize_fem_domain_mesh_asset_from_components_impl` | Routes `transition="pure_prism"` single-box films and attaches certificate |
| Mixed tet untangler (`mixed-tet-untangle`) | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_untangle_same_side_mixed_tetrahedra` | Vectorized `same_side_two_owner_face` detector, relocation, and local `tet4` reorientation |
| Chebyshev star solver (`mixed-tet-chebyshev`) | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_chebyshev_center_3d` | Solves 4-variable Chebyshev-center LP via SciPy HiGHS with pure-NumPy fallback |
| CSR DMI MFEM assembler (`dmi-csr-assembler`) | `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.cpp` | `build_gpu_dmi_csr_from_mfem` | Assembles skew-symmetric edge-vector CSR DMI channels and periodic $P^\top D P$ |
| CSR DMI CUDA kernels (`dmi-csr-kernels`) | `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.cu` | `fullmag_cuda_dmi_csr_field_energy` | Deterministic row-wise SpMV, CUB block energy, and `gpu_relax_dd` chord differences |
| Weak-residual sign reference (`dmi-weak-residual`) | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_interfacial_residual` | Canonical weak-residual sign reference for interfacial, rotated, and bulk DMI |
| RK intermediate DMI fields (`rk-dmi-fields`) | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu` | `gpu_rk_compute_dmi_field_contributions` | Intermediate-stage CSR GPU DMI fields with `energy_block_sums = nullptr` |
| RK final DMI energy (`rk-dmi-energy`) | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu` | `gpu_rk_reduce_final_dmi_energy_terms` | Final step CSR GPU DMI energy reduction via CUB |
| Direct minimizer increment (`direct-energy-increment`) | `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp` | `direct_difference` | Compensated double-double CSR DMI chord increment and roundoff scale for Armijo |
| Native FEM topology gate (`fem-mesh-gate`) | `backends/fem/core/fem_mesh.cpp` | `validate_supported_physics_topology` | Admits `pure_prism_p2` and `mixed_p1` on CPU/CUDA with CSR DMI; keeps Zhang-Li/FEM-BEM fail-closed |
| Rust IR certificate validator (`ir-pure-prism-certificate`) | `crates/fullmag-ir/src/mixed_certificate.rs` | `validate_pure_prism_topology_certificate_against_mesh` | Re-verifies `v3` fingerprint, `prism6` parts, planes, volumes, Jacobians, and conformity |
| CSR DMI CUDA contract (`csr-dmi-contract-test`) | `backends/fem/tests/cuda_csr_dmi_prism_contract.cpp` | `make_multilayer_prism6_mesh` | Machine-precision GPU vs CPU parity across `tet4`, `prism6`, `mixed`, and periodic meshes |
| Pure-prism P2 GPU E2E contract (`pure-prism-gpu-contract-test`) | `backends/fem/tests/fem_pure_prism_p2_gpu_contract.cpp` | `build_conforming_pure_prism_shared_domain` | End-to-end `pure_prism_p2` GPU RK4 & PGBB parity vs CPU under `CG+AMG` and `cuDSS` |
