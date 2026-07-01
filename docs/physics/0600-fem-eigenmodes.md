# FEM eigenmodes — linearised spin-wave analysis

- Status: active
- Owners: core-physics
- Last updated: 2026-04-01
- Related ADRs: none
- Related specs: `docs/plans/active/fullmag_fem_eigenmodes_plan_update_2026-03-30.md`

---

## 1. Problem statement

### What is being modelled?

Small-amplitude spin-wave eigenmodes of a magnetised ferromagnet described by the
Landau–Lifshitz–Gilbert (LLG) equation.  Around a static equilibrium state
$\mathbf{m}_0(\mathbf{r})$ the LLG equation may be linearised to a
generalised eigenvalue problem whose solutions give

- a discrete spectrum of resonance frequencies $\{f_n\}$,
- spatially resolved mode profiles $\{{\boldsymbol\xi}_n(\mathbf{r})\}$.

### Why is it needed?

Spin-wave spectroscopy (FMR, BLS, STFMR) is among the most widely used
experimental techniques for characterising magnonic devices.  The eigenmode
solver provides the theoretical counterpart: resonance frequencies and mode
shapes without running a full time-domain simulation.

### Scope

- Single-magnet FEM geometry.
- Real-symmetric (Hermitian) linearisation neglecting damping (or with
  damping ignored by policy — see § 2.3).
- k-vector parameterisation for dispersion curves via a single
  homogeneous Bloch phase factor applied to the trial functions.
- CPU reference solver only (MVP-1).  GPU path deferred to MVP-2.

---

## 2. Physical model

### 2.1 Governing equations

The time-domain LLG equation for a normalised magnetisation
$\mathbf{m} = \mathbf{M} / M_\mathrm{s}$ (with $|\mathbf{m}| = 1$) is

$$
\frac{\partial \mathbf{m}}{\partial t}
= -\gamma \mu_0 \mathbf{m} \times \mathbf{H}_\mathrm{eff}
  + \alpha\, \mathbf{m} \times \frac{\partial \mathbf{m}}{\partial t},
$$

where $\mathbf{H}_\mathrm{eff} = \mathbf{H}_\mathrm{ex}
+ \mathbf{H}_\mathrm{demag} + \mathbf{H}_\mathrm{ext} + \ldots$

#### Linearisation around equilibrium

Decompose $\mathbf{m} = \mathbf{m}_0 + \delta\mathbf{m}$ with
$|\delta\mathbf{m}| \ll 1$ and $\delta\mathbf{m} \perp \mathbf{m}_0$.
Working in the **tangent plane** at each node (basis vectors $\mathbf{e}_1$,
$\mathbf{e}_2$ with $\mathbf{e}_1 \times \mathbf{e}_2 = \mathbf{m}_0$),
the linearised LLG (no damping) reads

$$
\frac{\partial}{\partial t}\begin{pmatrix} u \\ v \end{pmatrix}
= \Omega
  \begin{pmatrix} -v \\ u \end{pmatrix},
\qquad
\delta\mathbf{m} = u\,\mathbf{e}_1 + v\,\mathbf{e}_2,
$$

where $\Omega = \gamma \mu_0 H_\mathrm{eff}^\parallel$ is the local
precession frequency associated with the component of
$\mathbf{H}_\mathrm{eff}$ parallel to $\mathbf{m}_0$.

#### Scalar approximation (current CPU reference)

The current CPU reference solver uses a **scalar projection** of the
linearised operator.  For each active FEM node the effective field
$\mathbf{H}_\mathrm{eff}$ is projected onto $\mathbf{m}_0$, yielding a
scalar shift $h_\parallel(i)$.  The resulting stiffness matrix is

$$
K_{ij} = \underbrace{A_{ij}^{\mathrm{ex}}}_{\text{exchange stiffness}}
         + \underbrace{M_{ij}\,h_\parallel^{\{ij\}}}_{\text{Zeeman/demag shift}},
$$

with a consistent FEM mass matrix $M_{ij}$.  The eigenvalue problem is

$$
K\,\mathbf{u} = \lambda\, M\,\mathbf{u},
\qquad f_n = \frac{\gamma \mu_0 \sqrt{\lambda_n}}{2\pi}.
$$

This is a real symmetric generalised eigenvalue problem solved via
Cholesky factorisation and full dense diagonalisation (nalgebra
`SymmetricEigen`).

> **Limitation:** the scalar projection yields correct frequencies only when
> the equilibrium is spatially uniform or nearly so.  A full 2×2-block
> complex operator (Herring–Kittel form) is needed for non-uniform
> equilibria; this is deferred to a future milestone.

#### Full 2×2 Herring–Kittel operator

For non-uniform equilibria (vortices, skyrmions, domain walls) the scalar
projection is qualitatively wrong because it discards the coupling between
the two tangent-plane components of $\delta\mathbf{m}$.

The full linearised LLG (undamped) in the local tangent basis
$(\mathbf{e}_1, \mathbf{e}_2)$ yields a $2N \times 2N$ generalised
eigenvalue problem of the form

$$
\begin{pmatrix}
\mathbf{K}_{11} & \mathbf{K}_{12} \\
\mathbf{K}_{21} & \mathbf{K}_{22}
\end{pmatrix}
\begin{pmatrix} \mathbf{u}_1 \\ \mathbf{u}_2 \end{pmatrix}
= \lambda
\begin{pmatrix}
\mathbf{M} & \mathbf{0} \\
\mathbf{0} & \mathbf{M}
\end{pmatrix}
\begin{pmatrix} \mathbf{u}_1 \\ \mathbf{u}_2 \end{pmatrix},
$$

where $\delta\mathbf{m}_i = u_{1,i}\,\mathbf{e}_{1,i}
+ u_{2,i}\,\mathbf{e}_{2,i}$ and $\mathbf{M}$ is the consistent FEM
mass matrix.

The $2 \times 2$ block structure arises because the effective-field
Hessian $\partial \mathbf{H}_\mathrm{eff}/\partial \mathbf{m}$ is, in
general, a tensor that couples the two tangent-plane directions.  The
block entries for each pair of active nodes $(i, j)$ are

$$
K_{\alpha\beta,ij}
= \langle e_{\alpha,i},\,
    \mathcal{H}_\mathrm{eff}^{\prime}\, e_{\beta,j} \rangle_{ij}
$$

where $\alpha, \beta \in \{1, 2\}$ index tangent directions and
$\mathcal{H}_\mathrm{eff}^{\prime}$ is the effective-field linearisation
operator acting on the FEM space.

Specifically, at each element the contributions are:

- **Exchange:** $A_{ij}^{\mathrm{ex}} \delta_{\alpha\beta}$ — the
  exchange stiffness is isotropic in the tangent plane, so the exchange
  contribution to the off-diagonal blocks $K_{12}$ and $K_{21}$ vanishes.

- **Parallel field shift:** $M_{ij}\, h_\parallel^{\{ij\}}\,
  \delta_{\alpha\beta}$ — the projection of $\mathbf{H}_\mathrm{eff}$
  parallel to $\mathbf{m}_0$ contributes identically to both diagonal
  blocks, the same as in the scalar operator.

- **Perpendicular effective-field Hessian:** the cross-coupling terms
  arise from the non-diagonal part of $\partial\mathbf{H}_\mathrm{eff}
  / \partial\mathbf{m}$ projected into the tangent plane.  For the demag
  field this produces non-zero $K_{12}$ and $K_{21}$ blocks.

When the equilibrium is spatially uniform, $K_{12} = K_{21} = 0$ and both
diagonal blocks are identical, reducing to the scalar operator (with a
factor-of-two eigenvalue degeneracy).

The operator is real-symmetric when damping is ignored.  Dense symmetric
eigenvalue decomposition (`SymmetricEigen` on the $2N \times 2N$ system)
remains applicable, with $O((2N)^3)$ cost.

Implementation: the operator kind is selected by `EigenOperatorIR`:
- `LinearizedLlg` — the scalar projection (MVP, faster, $N \times N$).
- `Full2x2` — the 2×2 block operator ($2N \times 2N$, needed for
  non-uniform equilibria).

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|--------|---------|---------|
| $\gamma$ | gyromagnetic ratio | rad s⁻¹ T⁻¹ |
| $\mu_0$ | magnetic permeability of free space | 4π × 10⁻⁷ T m A⁻¹ |
| $M_\mathrm{s}$ | saturation magnetisation | A m⁻¹ |
| $A$ | exchange stiffness | J m⁻¹ |
| $\alpha$ | Gilbert damping constant | dimensionless |
| $\mathbf{H}_\mathrm{eff}$ | effective field | A m⁻¹ |
| $\lambda_n$ | eigenvalue of the scalar operator | A m⁻¹ |
| $f_n$ | resonance frequency | Hz |
| $\boldsymbol\xi_n$ | mode eigenvector (normalised) | dimensionless |
| $\mathbf{k}$ | Bloch wave vector | m⁻¹ |

### 2.3 Assumptions and approximations

1. **Small amplitude**: the mode amplitude $|\delta\mathbf{m}| \ll 1$.
2. **Scalar operator**: the full $2\times2$ Herring–Kittel block structure
   is reduced to a scalar effective-field projection.
3. **Damping policy**:
   - `ignore` (default): damping is set to zero before diagonalisation.
     Eigenvalues are real; only the precession frequency is meaningful.
   - `include`: Gilbert damping is included; eigenvalues become complex
     $\lambda = \omega^2 (1 - i\alpha\omega)^{-1}$, but the scalar
     approximation still yields an effective line-width estimate.
     **Not yet supported** in the CPU reference — included as future work.
4. **Equilibrium source**: the linearisation point $\mathbf{m}_0$ may be
   - provided externally (`provided`),
   - relaxed from the initial state during the eigen run (`relaxed_initial_state`),
   - loaded from a saved relaxation artefact (`artifact`).
5. **Boundary conditions**: Neumann boundary conditions on the exchange
   operator are inherited from `FemPlanIR`.

---

## 3. Numerical interpretation

### 3.1 FDM

FDM does not yet have a native eigensolver.  The qualitative counterpart
is to excite the FDM time-domain simulation with a broadband (sinc or
Gaussian) pulse and extract resonance frequencies from the FFT of the
time-trace of the spatially averaged magnetisation.  This approach is
available via the standard `TimeEvolution` study.

The analytic crosscheck for both FDM and FEM in uniform external field is
the Kittel formula (see § 5.1).

### 3.2 FEM

The CPU reference path:

1. **Equilibrium materialisation** (`materialize_equilibrium`):
   Build a `FemLlgProblem` with the same material and field parameters.
   If `equilibrium = RelaxedInitialState`, run overdamped LLG to
   convergence (torque tolerance 10⁻⁵ or energy tolerance 10⁻¹²).

2. **Tangent-plane projection** (`project_mode_to_tangent_basis`):
   For each active FEM node compute orthonormal tangent vectors
   $(\mathbf{e}_1, \mathbf{e}_2)$ from the equilibrium direction, then
   project the raw reduced eigenvector back to the full spatial field.

3. **Operator assembly** (`assemble_projected_scalar_operator`):
   Assemble $K$ and $M$ from element stiffness arrays and the local shift
   $h_\parallel(i)$.

4. **Reference Cholesky generalised eigen solve**:
   $K = L L^\top$ (Cholesky of $M$),
   $L^{-1} K L^{-\top} \tilde{\mathbf{u}} = \lambda \tilde{\mathbf{u}}$,
   solved by `nalgebra::SymmetricEigen` (dense, $O(N^3)$).

5. **Mode normalisation**: either unit-L2 mass norm or
   unit-max-amplitude, controlled by `EigenNormalizationIR`.

6. **Artefact serialisation**: spectrum, per-mode spatial fields (real,
   imag, amplitude, phase), dispersion CSV.

### 3.3 Hybrid

Not applicable for the eigenmodes study at this stage.

---

## 4. API, IR, and planner impact

### 4.1 Python API surface

```python
import fullmag as fm

# Minimal eigenmode study
study = fm.Eigenmodes(
    num_modes=10,
    operator=fm.EigenOperator.LinearisedLlg(include_demag=True),
    equilibrium=fm.EquilibriumSource.RelaxedInitialState(),
    target=fm.EigenTarget.Lowest(),
    normalization=fm.EigenNormalization.UnitL2(),
    damping_policy=fm.EigenDampingPolicy.Ignore(),
    outputs=[
        fm.EigenSpectrum("eigenfrequency"),
        fm.EigenMode("mode", indices=[0, 1, 2]),
    ],
)

problem = fm.Problem(
    geometry=...,
    materials=...,
    study=study,
    backend=fm.Backend.Fem(order=1),
)
```

The `Eigenmodes` class serialises to `StudyIR::Eigenmodes` in the IR layer.

For production-sized objects, the public API must support frequency-window
selection rather than only `"lowest"` or `"nearest"`:

```python
study.stages.add_eigenmodes(
    count=20,
    target="frequency_window",
    frequency_min=100e6,
    frequency_max=5e9,
)
```

`frequency_min` and `frequency_max` are SI frequencies in Hz.  `count` is the
maximum number of modes to return from the requested interval.  This is the
canonical user-facing model for large FEM eigenmode studies because users
usually care about a measurement band, device band, or FMR band, not about a
global dense ordering of every eigenpair.

Frequency-window artifacts must preserve this cap as
`requested_mode_count`.  If the solver stops because the cap was reached, the
published `mode_count` must equal `requested_mode_count` and the completeness
metadata must report `truncated_by_requested_count` with
`additional_modes_may_exist=true`; otherwise the window is not cap-truncated
and must use a different completeness status.  For k-path dispersion,
`mode_count` is the public maximum mode count per k sample after applying the
requested output filter, not the number of internal modes retained for branch
tracking.

### 4.2 ProblemIR representation

`StudyIR::Eigenmodes` fields (defined in `fullmag-ir/src/lib.rs`):

| Field | Type | Description |
|-------|------|-------------|
| `dynamics` | `DynamicsIR` | LLG parameters (gyromagnetic ratio, integrator for equilibrium) |
| `operator` | `EigenOperatorConfigIR` | `kind=LinearizedLlg`, `include_demag` |
| `count` | `u32` | Maximum number of modes to return; for `FrequencyWindow` this is the accepted-mode cap inside the requested interval |
| `target` | `EigenTargetIR` | `Lowest`, `Nearest { frequency_hz }`, or production target `FrequencyWindow { frequency_min_hz, frequency_max_hz }` |
| `equilibrium` | `EquilibriumSourceIR` | `Provided`, `RelaxedInitialState`, `Artifact { path }` |
| `k_sampling` | `Option<KSamplingIR>` | For dispersion: `Single { k_vector: [f64; 3] }` |
| `normalization` | `EigenNormalizationIR` | `UnitL2` or `UnitMaxAmplitude` |
| `damping_policy` | `EigenDampingPolicyIR` | `Ignore` or `Include` (Include NYI) |
| `sampling` | `SamplingIR` | Output specification |

The planner lowers this to `BackendPlanIR::FemEigen(FemEigenPlanIR)`.

### 4.3 Planner and capability-matrix impact

- Only `Backend::Fem` supports `StudyIR::Eigenmodes`.
- The FDM capability entry for `eigenmodes` should be `NotImplemented`.
- `fullmag-plan` produces a `FemEigenPlanIR` that includes the
  pre-computed mesh, material parameters, field settings, and
  equilibrium magnetisation (when `RelaxedInitialState` is requested
  the planner embeds the initial guess; the runner performs the
  actual relaxation).
- Production planning for `FrequencyWindow` must preserve the requested window,
  mode cap, tolerance, and resolved backend policy in provenance.  It must not
  silently degrade to `Lowest` or publish out-of-window guard modes as user
  results.

---

## 5. Validation strategy

### 5.1 Analytical checks

**Kittel formula (uniform precession, no demag):**

$$
f_\mathrm{Kittel} = \frac{\gamma \mu_0}{2\pi}\, H_0
$$

For Permalloy ($\gamma = 2.211 \times 10^5$ rad s⁻¹ T⁻¹) with external
field $\mu_0 H_0 = 50$ mT the expected frequency is approximately $f \approx
8$ GHz.  The lowest FEM eigenfrequency from a coarse mesh must fall within
a factor of 10 of this value (test `fem_eigen_lowest_mode_order_of_magnitude`).

**Herring–Kittel dispersion (k ≠ 0, no demag):**

$$
\omega(k) = \gamma\mu_0 \sqrt{H_0 + \frac{2A}{\mu_0 M_\mathrm{s}} k^2}
$$

For $k = 0$ this reduces to the Kittel formula.  The k-vector series
(`KSamplingIR::Single`) allows probing individual points on this curve.

### 5.2 Cross-backend checks

- FEM eigen (exchange + Zeeman, no demag) vs. analytic Kittel: order-of-magnitude agreement.
- FEM eigen with demag should yield lower frequencies than without demag
  for the same geometry (demagnetisation field reduces the effective
  internal field for in-plane equilibrium).
- Mesh-convergence: frequencies should not decrease monotonically beyond
  the exchange-length scale (test `fem_eigen_frequency_is_stable_across_resolutions`).

### 5.3 Regression tests

| Test name | EIG task | Description |
|-----------|----------|-------------|
| `fem_eigen_smoke_completes_without_errors` | EIG-035 | Run to completion, check artefacts |
| `fem_eigen_lowest_mode_order_of_magnitude` | EIG-031 | Kittel frequency OOM check |
| `fem_eigen_modes_are_non_trivial` | EIG-033 | Non-zero mode amplitudes, sorted frequencies |
| `fem_eigen_frequency_is_stable_across_resolutions` | EIG-032 | Exchange-scaling consistency |
| `fem_eigen_demag_lowers_frequency` | EIG-034 | Demag reduces uniform-mode frequency |

---

## 6. Completeness checklist

- [x] Python API (`Eigenmodes`, `EigenOperator`, `EigenTarget`, etc.)
- [x] `StudyIR::Eigenmodes` (IR)
- [x] `FemEigenPlanIR` (backend plan IR)
- [x] Planner: `ProblemIR` → `FemEigenPlanIR`
- [x] Capability matrix: FEM eigen enabled, FDM eigen disabled
- [ ] FDM backend eigensolver (deferred — MVP-2)
- [x] FEM CPU reference solver (`fem_eigen.rs`)
- [ ] FEM GPU / native ABI eigensolver (deferred — MVP-2)
- [x] Outputs: `EigenSpectrum`, `EigenMode`, `DispersionCurve` artefacts
- [x] Quantity registry: `mode_amplitude`, `mode_real`, `mode_imag`, `mode_phase`
- [x] Polarisation classification (`classify_polarization` heuristic)
- [x] Tests: smoke, analytic OOM, non-trivial modes, resolution stability
- [x] Analyse UI: `AnalyzeViewport`, `ModeSpectrumPlot`, `EigenModeInspector`, `DispersionBranchPlot`
- [x] Physics documentation (this file)

---

## 7. Known limits and deferred work

1. **Full 2×2 operator**: implemented via `EigenOperatorIR::Full2x2`.
   The scalar projection (`LinearizedLlg`) remains the default for
   performance; the 2×2 path is needed for non-uniform equilibria
   (vortices, skyrmions, domain walls).
2. **Damping**: `EigenDampingPolicyIR::Include` is defined in the IR and
   supported.  When damping is included with the full 2×2 operator, the
   system becomes non-Hermitian and requires a general eigenvalue solver
   (`Dgeev`/`Zgeev`).  Complex eigenvalues encode mode linewidth.
3. **Production sparse/window eigensolver**: the dense `SymmetricEigen` path
   scales as $O(N^3)$ and is limited to small validation meshes.  Large objects
   require PETSc/SLEPc-class sparse or matrix-free eigensolvers: Krylov-Schur,
   Arnoldi, LOBPCG, Jacobi-Davidson, shift-invert, or FEAST/contour interval
   solve depending on the requested target.  Frequency-window queries such as
   100 MHz..5 GHz must be solved as spectral-window problems, not by computing
   a large prefix of the global dense spectrum and filtering afterward.
4. **k-vector sampling**: only `KSamplingIR::Single` is currently supported.
   Automatic BZ path generation for dispersion curves is deferred.
5. **Multi-magnet**: only single-magnet geometries are supported.
6. **FDM eigensolver**: no native FDM path exists; broadband time-domain
   FFT analysis is the current workaround.

---

## 8. References

1. Herring, C. & Kittel, C. (1951). *On the theory of spin waves in ferromagnetic
   media.* Phys. Rev. **81**, 869.
2. Kalinikos, B.A. & Slavin, A.N. (1986). *Theory of dipole-exchange spin wave
   spectrum for ferromagnetic films with mixed exchange boundary conditions.*
   J. Phys. C **19**, 7013.
3. d'Aquino, M. et al. (2009). *A novel formulation for the numerical computation
   of magnetization modes in complex micromagnetic systems.* J. Comput. Phys. **228**, 6130.
4. Venkat, G. et al. (2013). *Proposals for a micromagnetic standard problem for
   ferromagnetic resonance simulations.* IEEE Trans. Magn. **49**, 524.
