# Periodic Boundary Conditions (PBC)

- Status: draft
- Owners: fullmag team
- Last updated: 2026-06-30
- Related ADRs: —
- Related specs: fullmag-application-architecture-v2, session-run-api-v1
- Related reports: docs/reports/11.04.2026/PBC/raport-diagnostyczny-pbc-fem-fdm-fullmag-2026-04-11.mdx,
  docs/reports/11.04.2026/PBC/raport-wdrozeniowy-pbc-fem-fdm-fullmag-2026-04-11.mdx

## 1. Problem statement

Micromagnetic simulation of thin films, nanowires, magnonic crystals, and other
extended structures requires periodic boundary conditions (PBC) to model
effectively infinite repetitions of a finite unit cell.  PBC removes edge
artefacts from local operators (exchange, DMI) and introduces long-range
periodic dipolar coupling via image summation in the demagnetization kernel.

Fullmag currently has **no** unified PBC system.  Several limited lanes are
implemented, but they must not be collapsed into a blanket "PBC works" claim:
FDM has axis-wise periodic local operators and truncated-image demag support;
native FEM has k=0 static reductions for selected CPU/MFEM static/time-domain
paths, but the static demag path remains diagnostic/source-visible for
magnonic-crystal workloads until the M5 equilibrium gate proves full
magnetostatic PBC; FEM eigen has periodic/Floquet phase reduction for magnetic
operators without dynamic demag; driven FEM frequency response has only the
gamma/free and k=0 static-periodic magnetic slice without demag.

This note covers the physics, numerics, and IR design for two functional lines:

- **Line A — Real-space zero-phase periodicity** for relaxation, statics, and LLG
  time-domain solvers (FDM and FEM).
- **Line B — Bloch/Floquet phase periodicity** for eigenmode and frequency-domain
  solvers (FEM eigen, later FDM spin-wave).

## 2. Physical model

### 2.1 Governing equations

#### Zero-phase periodicity (Line A)

For a unit cell of extent $\mathbf{L} = (L_x, L_y, L_z)$ with periodic axes $P \subseteq \{x,y,z\}$,
the magnetization satisfies:

$$\mathbf{m}(\mathbf{r} + n_i L_i \hat{e}_i) = \mathbf{m}(\mathbf{r}), \quad \forall\, i \in P,\; n_i \in \mathbb{Z}$$

**Local operators (exchange, DMI):**  Finite-difference stencils wrap around:
the neighbor of cell $(N_i - 1)$ along axis $i \in P$ is cell $0$, and vice versa.

**Demagnetization (dipolar):**  The total demagnetizing field includes
contributions from all periodic images.  The effective demagnetization tensor
becomes:

$$\tilde{N}_{\alpha\beta}(\Delta\mathbf{r}) = \sum_{\mathbf{n} \in \mathbb{Z}^{|P|}}
  N^{\text{open}}_{\alpha\beta}(\Delta\mathbf{r} + \mathbf{n} \cdot \mathbf{L})$$

where $\mathbf{n}$ ranges over image indices along periodic axes, and
$N^{\text{open}}_{\alpha\beta}$ is the standard Newell demagnetization tensor
for a single prism pair.

In practice the sum is truncated to $|n_i| \le I_i$ images per axis (the
"truncated images" or "MuMax-style" approach):

$$\tilde{N}_{\alpha\beta}(\Delta\mathbf{r}) \approx
  \sum_{|n_i| \le I_i,\; i \in P}
  N^{\text{open}}_{\alpha\beta}(\Delta\mathbf{r} + \mathbf{n} \cdot \mathbf{L})$$

#### Bloch/Floquet periodicity (Line B)

For spin-wave calculations at wavevector $\mathbf{k}$ Fullmag uses the
canonical convention from `0710-periodic-and-floquet-boundary-conditions.md`:

$$\delta\mathbf{m}(\mathbf{r} + n_i L_i \hat{e}_i) = \delta\mathbf{m}(\mathbf{r})\, e^{-i \mathbf{k} \cdot (n_i L_i \hat{e}_i)}, \quad \forall\, i \in P$$

The linearized LLG eigenvalue problem is assembled within one unit cell and
periodic DOFs are identified via a phase-reduction matrix $\mathbf{P}$:

$$A_{\text{red}} = \mathbf{P}^\dagger A\, \mathbf{P}, \qquad
  M_{\text{red}} = \mathbf{P}^\dagger M\, \mathbf{P}$$

where $P_{ij} = \delta_{ij}$ for interior DOFs and $P_{ij} = e^{-i\mathbf{k}\cdot\Delta\mathbf{r}_{ij}}$
for periodic node pairs $(i,j)$.

Zero-phase periodicity is the special case $\mathbf{k} = \mathbf{0}$,
where $P_{ij} = 1$ for all periodic pairs.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}$ | Unit magnetization vector | — |
| $M_s$ | Saturation magnetization | A/m |
| $A$ | Exchange stiffness | J/m |
| $D$ | DMI constant | J/m² |
| $L_i$ | Unit cell extent along axis $i$ | m |
| $N_{\alpha\beta}$ | Demagnetization tensor component | — |
| $I_i$ | Number of periodic images per axis $i$ | — |
| $\mathbf{k}$ | Bloch wavevector | 1/m |
| $\Delta\mathbf{r}$ | Displacement between periodic node pair | m |
| $\mu_0$ | Vacuum permeability | T·m/A |

### 2.3 Assumptions and approximations

1. The unit cell is orthorhombic (axis-aligned in FDM; mesh-defined in FEM).
2. Periodic axes are independent: any subset of $\{x,y,z\}$ can be periodic.
3. Truncated-images demag converges adequately for $I_i \ge 5$; convergence
   depends on aspect ratio and must be validated per problem.
4. Exchange stiffness $A$ is uniform within a region.  Inter-region exchange
   across periodic seams uses the same inter-region exchange rules as
   non-periodic interfaces.
5. DMI at periodic boundaries uses the same finite-difference derivative
   formulation with wrapped neighbors.
6. For FEM Floquet, mesh quality at periodic boundaries is assumed adequate
   (matching node pairs provided by mesher).

## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.0 Grid identity and certificate

PBC changes the operator realization but not the resolved Cartesian grid.  The planner therefore
publishes exactly one `FdmGridCertificateIR` for the grid used by local operators and demagnetizing
images.  Its `origin_m`, `counts`, `cell_m`, `extent_m`, active-cell count, memory estimate and
`grid_fingerprint` (including active-mask/region topology) are validated before execution.  In particular, the period used by image
summation is the certified extent `L_i = N_i d_i`, never a value recomputed from a requested hint.
Changing a periodic axis, image count, or any grid realization input invalidates the plan/runtime
identity and requires a new certificate; no competing PBC certificate may be substituted.

#### 3.1.1 Neighbor policy

Replace all clamped-neighbor indexing with a helper function:

```rust
fn neighbor_index(i: usize, n: usize, delta: i32, periodic: bool) -> usize {
    if periodic {
        ((i as i32 + delta).rem_euclid(n as i32)) as usize
    } else {
        // clamp (existing Neumann behavior)
        (i as i32 + delta).clamp(0, n as i32 - 1) as usize
    }
}
```

A per-axis boundary policy struct encapsulates this:

```rust
#[derive(Debug, Clone, Copy)]
pub enum AxisBoundary { Open, Periodic }

#[derive(Debug, Clone, Copy)]
pub struct FdmBoundaryPolicy {
    pub x: AxisBoundary,
    pub y: AxisBoundary,
    pub z: AxisBoundary,
}
```

#### 3.1.2 Exchange

Current: `x.saturating_sub(1)` / `(x+1).min(nx-1)` → clamped Neumann.
Periodic: `neighbor_index(x, nx, -1, true)` / `neighbor_index(x, nx, +1, true)` → wrap-around.
No other change to the Laplacian stencil formula.

#### 3.1.3 DMI (interfacial and bulk)

Same neighbor policy substitution.  For interfacial DMI the 2D in-plane
derivatives already use `xp`/`xm`/`yp`/`ym`; these become wrapped via the
same helper.  For bulk DMI the full 3D curl stencil wraps on all periodic axes.

#### 3.1.4 Demag (FFT convolution)

**Open boundary (current):** padded size $p_i = 2 N_i$ on all axes, single
Newell kernel in frequency domain.

**Periodic axis:** no padding needed on that axis ($p_i = N_i$), but the
real-space Newell kernel must be replaced with the truncated-images kernel:

$$\tilde{N}_{\alpha\beta}[\Delta r] =
  \sum_{|n_i| \le I_i,\; i \in P}
  N^{\text{open}}_{\alpha\beta}[\Delta r + n_i \cdot N_i \cdot \Delta x_i]$$

**Mixed axes:** each axis independently gets $p_i = N_i$ (periodic) or
$p_i = 2 N_i$ (open).  The kernel-building loop iterates over image
indices only for periodic axes.

#### 3.1.5 CUDA backend

Same neighbor policy and demag padding changes via C ABI.  The CUDA exchange
kernel receives a `periodic_axes` mask (`uint3`) and uses modular arithmetic
for wrap-around:

```c
int xp = periodic_x ? ((x + 1) % nx) : min(x + 1, nx - 1);
int xm = periodic_x ? ((x - 1 + nx) % nx) : max(x - 1, 0);
```

Demag kernel changes mirror the Rust reference: mixed padding, truncated-images
kernel precomputed on host and uploaded.

### 3.2 FEM

#### 3.2.1 Static / time-domain (Line A — zero-phase)

The native FEM CPU/MFEM static/time-domain lane has a limited k=0 periodic
reduction for supported operators.  The contract is still explicit and gated:
the mesh must provide `periodic_node_pairs`, material classes across merged
nodes must be compatible, and unsupported GPU or demag variants must reject
instead of silently falling back to isolated geometry.  The reduction is:

1. Build a DOF reduction map from `periodic_node_pairs`: for each pair
   $(a, b)$, merge DOF $b$ into DOF $a$.
2. Assemble reduced operators: $A_{\text{red}} = P^T A P$, $M_{\text{red}} = P^T M P$.
3. Solve the reduced system.
4. Expand solution back to full DOF set by copying merged values.

This is the $\mathbf{k}=\mathbf{0}$ special case of the Floquet phase
reduction already implemented in `fem_eigen.rs`.

#### 3.2.2 Eigenmode / frequency-domain (Line B — Bloch/Floquet)

FEM eigen has periodic/Floquet magnetic-operator reduction in `fem_eigen.rs`.
Driven frequency response has a separate production CPU lane: gamma/free and
k=0 static-periodic magnetic response are executable when complete periodic
node-pair metadata is present, but nonzero-k Floquet response and dynamic demag
remain gated.  Remaining work includes:
- `KSampling::Path` orchestration for production dispersion sweeps.
- Mode tracking across $k$-points.
- Artifact output enrichment (band diagrams, spatial mode profiles).
- Phase-aware driven response and dynamic magnetostatic constraints.

#### 3.2.3 FEM demag

The MFEM-native Poisson solver uses Robin/Dirichlet open-boundary conditions on
open airbox faces.  Static/time-domain k=0 demag PBC has a limited
shared-domain-airbox implementation using periodic node classes and
`P^T A P` scalar-potential reduction.  Periodic seam faces must be excluded
from Robin mass assembly through `periodic_boundary_pairs`.
Pairing or projecting only `m` is not sufficient: if `phi` or `H_demag`
remains discontinuous across the seam, the result is finite isolated-airbox
demag with periodic magnetization projection, not physical magnetostatic PBC.

This does **not** imply full frequency-domain or Floquet demag.  Driven
frequency-response demag, nonzero-k Floquet magnetostatics, fully periodic 3D
demag, and strict FEM GPU periodic demag remain unsupported until separately
qualified.

### 3.3 Hybrid

Hybrid FDM/FEM PBC is not addressed in this stage.  The planner will reject
hybrid + periodic combinations.

## 4. API, IR, and planner impact

### 4.1 Python API surface

```python
import fullmag as fm

world = fm.World(cell_size=(3e-9, 3e-9, 3e-9))
world.set_pbc(x=True, y=True, z=False)          # periodic axes
world.set_pbc_images(x=10, y=10)                 # demag image count (optional)
# or equivalently:
world.set_pbc(x=True, y=True, z=False, images=(10, 10, 0))
```

For FEM spin-wave studies, the existing `spin_wave_bc="periodic"` /
`spin_wave_bc="floquet"` + `k_sampling=...` API is already in place.

The Python DSL lowers `set_pbc(...)` into `FdmPeriodicityIR` fields at
IR construction time.

### 4.2 ProblemIR representation

New types added to `fullmag-ir`:

```rust
/// Per-axis boundary policy for FDM PBC.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AxisBoundary {
    #[default]
    Open,
    Periodic,
}

/// FDM periodicity configuration, carried in FdmPlanIR.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmPeriodicityIR {
    pub axes: [AxisBoundary; 3],              // [x, y, z]
    pub demag: FdmDemagPeriodicityIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_counts: Option<[u32; 3]>,       // per-axis image count for TruncatedImages
}

/// Demag periodicity semantics for FDM.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FdmDemagPeriodicityIR {
    #[default]
    Open,
    TruncatedImages,
}
```

`FdmPlanIR` gains a new optional field:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub periodicity: Option<FdmPeriodicityIR>,
```

The planner keeps this requested policy separate from the runtime resolution.
Every executable FDM lane consumes the canonical resolved boundary enum:

```rust
enum ResolvedFdmDemagBoundaryIR {
    Open,
    PeriodicTruncatedImages { image_counts: [u32; 3] },
}
```

When demagnetization is enabled, `axes` containing any periodic axis together
with `demag = "open"` is rejected before allocation.  This request would make
the local exchange/DMI stencils periodic while leaving the dipolar kernel open,
and historically CPU and CUDA interpreted it differently.  `truncated_images`
resolves image counts once (defaulting to 10 on periodic axes and zero on open
axes); both CPU and CUDA consume that same value.  A no-demag plan may retain
periodic local operators and resolves its unused demag boundary to `open`.

`MeshPeriodicBoundaryPairIR` is enriched with:

```rust
pub translation: Option<[f64; 3]>,
pub tolerance: Option<f64>,
```

### 4.3 Planner and capability-matrix impact

**Planner validation rules:**

| Requested | Resolved | Rule |
|---|---|---|
| FDM + periodic axes + demag | `demag != Open` | Error if `demag == Open` and any axis is periodic |
| FDM + periodic + Floquet | — | Error: Floquet not valid for FDM time-domain |
| FEM static + periodic | requires `periodic_node_pairs` | Error if pairs missing |
| FEM eigen + periodic | existing validation | Already implemented |
| FEM static/time-domain + periodic demag | diagnostic/source-visible CPU/MFEM k=0 shared-domain-airbox slice until M5 acceptance | Requires `ProblemIR.pbc.demag = "periodic_airbox_k0"`, `periodic_node_pairs`, `periodic_boundary_pairs`, complete magnetic plus airbox pair coverage, and at least one open axis |
| FEM frequency response + periodic demag | — | Error: unsupported until dynamic magnetostatic response exists |
| Hybrid + periodic | — | Error: unsupported |

**Capability matrix additions:**

- `FdmBackendCapability.supports_periodic_exchange: bool`
- `FdmBackendCapability.supports_periodic_demag: bool`
- `FemBackendCapability.supports_periodic_time_domain: bool` (new)

## 5. Validation strategy

### 5.1 Analytical checks

1. **Uniform state energy:** A uniformly magnetized infinite film with PBC
   in-plane must have zero exchange energy and zero DMI energy.  Demag energy
   of a thin film $E_{\text{demag}} = \frac{1}{2}\mu_0 M_s^2 V$ (shape
   anisotropy limit for $I \to \infty$).

2. **Spin spiral:** A 1D spin spiral $\mathbf{m}(x) = (\cos(qx), \sin(qx), 0)$
   with wavelength $\lambda = L_x$ (commensurate with unit cell) should have
   zero net exchange torque at the periodic boundary.

3. **Dispersion relation:** FDM exchange-only spin-wave frequency
   $\omega(k) = \gamma \frac{2A}{\mu_0 M_s}(k_x^2 + k_y^2 + k_z^2)$ must match
   the analytic quadratic dispersion in the long-wavelength limit.

### 5.2 Cross-backend checks

1. **MuMax3 vs Fullmag FDM:** Compare relaxed states and total energies for a
   standard problem (e.g., µMAG SP4) with 1D and 2D PBC.
2. **Fullmag FDM CPU vs CUDA:** Bit-level parity for exchange/DMI fields with
   PBC (same as existing open-boundary parity tests).
3. **FEM eigen Floquet:** Dispersion curves vs TetraX for a known magnonic
   crystal.

### 5.3 Regression tests

1. Unit test: `neighbor_index()` correctness for all boundary/delta combinations.
2. Unit test: FDM exchange field for 1D periodic chain (3 cells) matches
   analytic Laplacian.
3. Unit test: FDM interfacial DMI with periodic BC matches analytic curl on
   periodic domain.
4. Integration test: Truncated-images kernel converges as image count increases.
5. Planner test: Reject FDM periodic + Open demag combination.
6. Planner test: Reject hybrid + periodic combination.
7. Python round-trip: `set_pbc(...)` → IR → plan → check periodic fields.

## 6. Completeness checklist

- [x] Python API (`pbc()` function in world.py, Problem.pbc field)
- [x] ProblemIR (`FdmPeriodicityIR`, `AxisBoundary`, `FdmDemagPeriodicityIR`)
- [x] Planner (wires `problem.pbc` → `FdmPlanIR.periodicity`)
- [ ] Capability matrix (`supports_periodic_exchange`, `supports_periodic_demag`)
- [x] FDM backend — exchange (neighbor policy wrap-around via `neighbor_index()`)
- [x] FDM backend — interfacial DMI (periodic neighbors)
- [x] FDM backend — bulk DMI (periodic neighbors)
- [x] FDM backend — demag (truncated-images kernel, mixed padding)
- [x] FDM backend — Zhang-Li STT (periodic upwind neighbors)
- [x] FEM backend — static/time-domain zero-phase reduction (limited CPU/MFEM slice)
- [x] FEM backend — eigenmode Floquet (limited magnetic operators; dynamic demag gated)
- [ ] Hybrid backend (not applicable this stage)
- [ ] Outputs / observables (energy must account for periodic images)
- [ ] Tests / benchmarks
- [x] Documentation (this note)

## 7. Known limits and deferred work

1. **FEM static/time-domain PBC** is limited to the CPU/MFEM k=0
   static-reduction diagnostic/source-visible slice until the M5 equilibrium
   gate passes for the target workload. Missing pair metadata, incompatible
   periodic classes, and unsupported GPU paths must reject.
2. **FEM periodic demag** is limited to static/time-domain k=0
   shared-domain-airbox reduction, and acceptance requires periodic `m`,
   gauge-adjusted `phi`, periodic `H_demag`, balanced seam flux, no artificial
   side-edge magnetic charge, and primitive-vs-supercell agreement. Frequency-
   domain demag, nonzero-k Floquet magnetostatics, fully periodic 3D demag,
   and GPU periodic demag remain deferred.
3. **Infinite-series demag** (`Infinite1D`, `Infinite2D`, `Infinite3D` via Ewald
   summation) is not implemented; only truncated images are provided.
4. **CUDA PBC** mirrors Rust reference semantics but requires separate kernel
   modifications to `native_exchange_fp64.cu` and `native_demag_fp64.cu`.
5. **Hybrid FDM/FEM PBC** is explicitly rejected by the planner.
6. **Non-orthorhombic unit cells** for FDM PBC are not supported (FDM is
   inherently Cartesian).
7. **Inter-region exchange across periodic seams** may need special handling
   when region masks differ at opposite boundaries.

## 8. References

1. Newell, A. J., Williams, W., & Dunlop, D. J. (1993). A generalization of the demagnetizing
   tensor for nonuniform magnetization. *J. Geophys. Res.*, 98(B6), 9551–9555.
2. Vansteenkiste, A. et al. (2014). The design and verification of MuMax3.
   *AIP Advances*, 4(10), 107133.
3. Exl, L. et al. (2014). LaBonte's method revisited: An effective steepest descent method for
   micromagnetic energy minimization. *J. Appl. Phys.*, 115(17), 17D118.
4. Leliaert, J. et al. (2019). Fast micromagnetic simulations on GPU — recent advances made with
   mumax3. *J. Phys. D: Appl. Phys.*, 51(12), 123002.
5. COMSOL Micromagnetics Module Reference (periodic/Floquet boundary conditions).
