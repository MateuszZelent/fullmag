
# Relaxation algorithms for FDM micromagnetics

- Status: implemented
- Owners: Fullmag core
- Last updated: 2026-04-15
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`
  - `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`
  - `docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md`
  - `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`

## 1. Problem statement

This note specifies the relaxation (energy-minimization) algorithms available in
the Fullmag FDM backend.  Three algorithms are implemented and executable:

1. **Overdamped LLG** — reuses the time-integration pipeline in a
   precession-disabled damping-only mode to drive the system toward
   equilibrium.
2. **Projected Gradient with Barzilai–Borwein step selection (BB)** — direct
   energy minimization on the sphere product manifold using alternating
   BB1/BB2 step sizes and Armijo backtracking.
3. **Nonlinear Conjugate Gradient (NCG)** — Polak–Ribière+ conjugate gradient
   with tangent-space vector transport, periodic restarts, and Armijo
   backtracking.

The goal of relaxation is to compute a low-energy or metastable state satisfying
the zero-torque equilibrium condition

$$
\boldsymbol{m}_i \times \boldsymbol{H}_{\mathrm{eff},i} = \boldsymbol{0}
\quad \forall\, i,
$$

subject to the pointwise unit-length constraint $|\boldsymbol{m}_i| = 1$.

## 2. Physical model

### 2.1 Constrained minimization problem

Given the discrete total micromagnetic energy functional

$$
E[\boldsymbol{m}]
= E_{\mathrm{ex}}[\boldsymbol{m}]
+ E_{\mathrm{demag}}[\boldsymbol{m}]
+ E_{\mathrm{ext}}[\boldsymbol{m}]
+ \cdots,
$$

where each contribution is evaluated over the FDM grid with $N$ active cells,
we seek a local minimizer on the product of unit spheres:

$$
\min_{\boldsymbol{m} \in (\mathbb{S}^2)^N} E[\boldsymbol{m}].
$$

### 2.2 Tangent-space gradient and torque

The **tangent-space gradient** at cell $i$ is the orthogonal projection of the
negative effective field onto the tangent plane of the sphere at $\boldsymbol{m}_i$:

$$
\boldsymbol{g}_i
= -P_{\boldsymbol{m}_i}\, \boldsymbol{H}_{\mathrm{eff},i}
= -\bigl(
    \boldsymbol{H}_{\mathrm{eff},i}
  - (\boldsymbol{m}_i \cdot \boldsymbol{H}_{\mathrm{eff},i})\,\boldsymbol{m}_i
\bigr),
$$

where $P_{\boldsymbol{m}_i} = I - \boldsymbol{m}_i \boldsymbol{m}_i^\top$ is
the orthogonal projector.  This is the Riemannian gradient of $E$ on
$(\mathbb{S}^2)^N$.

The **torque residual** is

$$
\boldsymbol{\tau}_i
= \boldsymbol{m}_i \times \boldsymbol{H}_{\mathrm{eff},i}.
$$

The two are related by $\|\boldsymbol{g}_i\| = \|\boldsymbol{\tau}_i\|$, since
$P_{\boldsymbol{m}}$ and $\boldsymbol{m} \times (\cdot)$ have the same image
when restricted to the tangent plane.

The **maximum torque** across the mesh,

$$
\tau_{\max}
= \max_{i} \|\boldsymbol{m}_i \times \boldsymbol{H}_{\mathrm{eff},i}\|,
$$

is the primary convergence indicator.  At a stationary point $\tau_{\max} = 0$.

### 2.3 Retraction (sphere projection)

All three algorithms require mapping a tangent vector back to the sphere.  We
use the simplest retraction: **cellwise normalization**,

$$
\mathcal{R}_{\boldsymbol{m}_i}(\boldsymbol{v}_i)
= \frac{\boldsymbol{m}_i + \boldsymbol{v}_i}
       {\|\boldsymbol{m}_i + \boldsymbol{v}_i\|}.
$$

This is a first-order retraction.  An alternative is the
**Cayley transform** used by Boris Computational Spintronics (see
§3.1.2, *Comparison with Boris*),
which is an exact norm-preserving rotation.  For the small step sizes enforced by
our Armijo backtracking, the normalization retraction introduces negligible
angular error.

### 2.4 Symbols and SI units

| Symbol | Description | SI unit |
|---|---|---|
| $E$ | Total micromagnetic energy | J |
| $E_{\mathrm{ex}}$, $E_{\mathrm{demag}}$, $E_{\mathrm{ext}}$ | Exchange, demagnetization, and external (Zeeman) energy contributions | J |
| $\boldsymbol{m}_i$ | Reduced (unit) magnetization at cell $i$ | 1 (dimensionless) |
| $\boldsymbol{H}_{\mathrm{eff},i}$ | Effective field at cell $i$ | A/m |
| $\boldsymbol{g}_i$ | Tangent-space energy gradient at cell $i$ | A/m |
| $\boldsymbol{\tau}_i$ | Torque residual at cell $i$ | A/m |
| $\tau_{\max}$ | Maximum torque over all cells | A/m |
| $\lambda$ | Step length (pseudo-time step or line-search parameter) | dimensionless |
| $\boldsymbol{s}_n = \boldsymbol{m}_n - \boldsymbol{m}_{n-1}$ | Magnetization difference between consecutive iterates | 1 |
| $\boldsymbol{y}_n = \boldsymbol{g}_n - \boldsymbol{g}_{n-1}$ | Gradient difference between consecutive iterates | A/m |
| $\alpha$ | Gilbert damping parameter | 1 |
| $\gamma$ | Gyromagnetic ratio $\gamma = \mu_0 |\gamma_e|$ | m/(A·s) |
| $M_s$ | Saturation magnetization | A/m |
| $P_{\boldsymbol{m}}$ | Tangent-space projector $I - \boldsymbol{m}\boldsymbol{m}^\top$ | 1 |
| $\beta_n$ | Conjugate gradient update coefficient | 1 |
| $\boldsymbol{p}_n$ | Search direction (CG) | A/m |
| $c_1$ | Armijo sufficient decrease parameter | 1 |
| $N$ | Number of active cells in the FDM grid | 1 |

### 2.5 Assumptions and approximations

1. **Deterministic relaxation only** — thermal noise is not included.
2. **Zero-temperature magnetostatics** — the system is at $T = 0\,\text{K}$.
3. **Retraction via normalization** — first-order accurate; Cayley transform
   deferred to a future GPU-optimized implementation.
4. **Single-material uniform parameters** — $M_s$, $A_{\mathrm{ex}}$, $\alpha$
   are constant over the mesh. Multi-region support deferred.

## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.1 Algorithm A — Overdamped LLG

The public FDM `llg_overdamped` path follows the `mumax3` `Relax()` pattern:
it reuses the standard time-integration pipeline, but **disables the
precession term during relaxation**. The executable equation is therefore the
pure-damping projection of Gilbert LLG:

$$
\frac{\partial \boldsymbol{m}}{\partial t}
= -\frac{\gamma}{1 + \alpha^2}
\left[
    \alpha\,\boldsymbol{m} \times (\boldsymbol{m} \times \boldsymbol{H}_{\mathrm{eff}})
\right].
$$

This removes the orbiting/overshoot behavior associated with time evolution and
makes `relax()` behave as an energy descent rather than a damped precessional
run. The material damping $\alpha$ still scales the descent rate, but the user
does **not** need to inflate $\alpha$ merely to suppress visible precession.

Public API semantics for this path are intentionally mumax-like:

1. `relax(..., algorithm="llg_overdamped", solver="auto")` maps to RK23.
2. `dt="auto"` means no fixed timestep (adaptive/default step policy).
3. Numeric `dt` means fixed timestep.
4. Solver/time-step controls are valid only for `llg_overdamped`.
   Direct minimizers (`projected_gradient_bb`, `nonlinear_cg`) reject
   `solver`/`dt`/`max_error` as non-applicable controls.

Fullmag currently still uses the runner's pseudo-time and output cadence during
`llg_overdamped` relaxation, so reported stage time is an execution-control
quantity rather than a physically meaningful evolution time.

For stage materialization and interactive control, the pseudo-time budget must
be derived consistently as

$$
t_{\mathrm{budget}} = N_{\mathrm{steps}} \, \Delta t_{\mathrm{seed}},
$$

where $\Delta t_{\mathrm{seed}}$ is taken from:

1. `fixed_timestep` when present,
2. otherwise `adaptive_timestep.dt_initial` when present,
3. otherwise the fallback seed `1\times10^{-13}\,\mathrm{s}`.

This seed-time rule is only a runtime-control convention. It must not be
confused with a physical stopping criterion, and it must not override the
canonical convergence test based on torque and optional 50-step energy plateau.

**Convergence criterion**: the runner monitors the approximate maximum torque
derived from the pure-damping right-hand side:

$$
\tau_{\max}
\approx
\frac{1 + \alpha^2}{\gamma \alpha}
\max_i \left\|\frac{d\boldsymbol{m}_i}{dt}\right\|.
$$

This estimate is exact for the continuous pure-damping LLG form above. The
discrete-time integrator still introduces the usual $O(\Delta t)$ step error.
Here $\gamma$ is the reduced `gamma_mu0` in `m/(A s)`; using the electron
gyromagnetic ratio in `rad/(T s)` would make the reconstructed torque wrong by
the missing $\mu_0$ factor.

Shared product semantics for stop contracts and demag refresh cadence now live
in `0530-shared-relaxation-stop-and-field-refresh-semantics.md`. The FDM note
below describes the executable algorithm details on top of that shared contract.

**Stop criteria** (implemented in runtime convergence checks):
1. $\tau_{\max} \le \epsilon_\tau$ (torque tolerance),
2. optionally $\max(E)-\min(E) \le \epsilon_E$ over the last 50 accepted
   relaxation steps (energy plateau tolerance),
3. hard cap on iteration count.

The canonical public unit for `torque_tolerance` is **A/m** because the
residual is defined as $\max_i |m_i \times H_{\mathrm{eff},i}|$.
`max_torque_T = \mu_0 \, \tau_{\max}` may be reported as an auxiliary derived
observable for mumax-style comparison, but it is not the control variable used
for Fullmag relaxation stop checks.

#### 3.1.2 Algorithm B — Projected Gradient + Barzilai–Borwein

This algorithm performs steepest descent on the product manifold
$(\mathbb{S}^2)^N$ with adaptive step sizes selected by the
Barzilai–Borwein (BB) method [Barzilai & Borwein, 1988].

**Per-iteration procedure** (implemented in `execute_projected_gradient_bb`):

1.  **Compute effective field and tangent gradient**:

    $$
    \boldsymbol{H}_{\mathrm{eff}} =
    \boldsymbol{H}_{\mathrm{ex}} +
    \boldsymbol{H}_{\mathrm{demag}} +
    \boldsymbol{H}_{\mathrm{ext}} +
    \boldsymbol{H}_{\mathrm{ani}} +
    \boldsymbol{H}_{\mathrm{mel}},
    \qquad
    \boldsymbol{g}_i = -P_{\boldsymbol{m}_i}\,\boldsymbol{H}_{\mathrm{eff},i}.
    $$

2.  **Check convergence**: if $\tau_{\max} \le \epsilon_\tau$, stop.
    Also check $\|\boldsymbol{g}\|^2 < 10^{-30}$ as a gradient-floor guard.

3.  **Armijo backtracking line search**: starting from $\lambda_{\mathrm{trial}} = \lambda$, find $\lambda_k$ such that

    $$
    E\!\left[\mathcal{R}_{\boldsymbol{m}}(-\lambda_k \boldsymbol{g})\right]
    \le
    E[\boldsymbol{m}] - c_1 \lambda_k \|\boldsymbol{g}\|^2,
    $$

    where $c_1 = 10^{-4}$ (Armijo parameter).
    If the condition fails, halve $\lambda_k$ and repeat (up to 20 backtracks).
    The CPU FDM line-search energy includes exchange, demag, external field,
    uniaxial/cubic anisotropy, prescribed-strain magnetoelastic energy, and
    interfacial/bulk DMI energy when those terms are active. The DMI scalar
    terms use the same cell-centered centered-derivative reduction as the native
    CUDA scalar stats contract. Oersted remains a field observable in the
    current public contract and does not publish a separate conservative scalar
    energy term for direct-minimizer line search.

    For LLG time-stepping, full CPU step reports publish anisotropy and DMI
    scalar terms alongside exchange, demag, external and total energy.
    Scalar-only scheduled CPU rows and scalar-only live updates may reuse that
    `StepReport` plus the current magnetization averages instead of recomputing
    full observables for the row. CPU FDM live execution should refresh full
    observables only when a heavy field payload or non-scalar preview is due.
    Scheduled and final CPU artifact snapshots for the magnetization field
    itself (`m` or `m.x/y/z`) may read the current state directly and pair
    scheduled rows with `StepReport` scalars. `H_ext` snapshots may use the
    direct external-field accessor, preserving uniform field, per-node field,
    component projection, and inactive-mask semantics without full observables.
    Scheduled `H_ex` snapshots may use the direct exchange-field accessor, and
    scheduled `H_demag` snapshots may use the direct demag-field accessor.
    Under the current CPU reference artifact contract, scheduled `H_OE`
    snapshots expose `problem.terms.per_node_field` with zero fallback and may
    use that direct source without assembling full observables; this does not
    redefine the cylindrical-conductor Oersted field contract. Scheduled
    `H_eff` snapshots may use a field-only observable effective-field accessor,
    preserving the current observable artifact contract separately from the
    broader stepping helper; scheduled `torque` snapshots may derive from that
    observable effective field. Within one direct output pass, base vector
    fields may be cached so sibling component snapshots and `torque` reuse the
    same observable `H_eff` assembly instead of recomputing the field per output
    name. Final output passes should use the last `StepReport` for scalar-only
    final rows when it matches the final state time, and should treat an
    existing scalar row at the current final time as authoritative instead of
    reassembling full observables just to duplicate that row. Standalone and
    interactive CPU preview snapshots should use the same direct field boundary
    for `m`, `H_ex`, `H_demag`, `H_ext`, `H_eff`, and `torque`, including
    shared `H_eff` assembly for cached `H_eff`/`torque` preview fields, with
    full observables reserved for quantities that have no direct accessor.
    Interactive CPU step-stat snapshots after a completed step should reuse the
    last `StepReport` when it matches the current state time.

4.  **Accept step**: $\boldsymbol{m}^{(n+1)} = \mathcal{R}_{\boldsymbol{m}^{(n)}}(-\lambda_k \boldsymbol{g}^{(n)})$.

5.  **Compute BB step size for next iteration**:

    $$
    \boldsymbol{s}_n = \boldsymbol{m}^{(n+1)} - \boldsymbol{m}^{(n)},
    \qquad
    \boldsymbol{y}_n = \boldsymbol{g}^{(n+1)} - \boldsymbol{g}^{(n)}.
    $$

    To improve numerical stability on large meshes (following Boris), both
    differences are scaled by $10^{-6}$ before computing the inner products —
    this cancels in the BB quotients.

    The two BB formulas are:

    $$
    \lambda_{\mathrm{BB1}} = \frac{\langle \boldsymbol{s}_n, \boldsymbol{s}_n \rangle}
                                   {\langle \boldsymbol{s}_n, \boldsymbol{y}_n \rangle},
    \qquad
    \lambda_{\mathrm{BB2}} = \frac{\langle \boldsymbol{s}_n, \boldsymbol{y}_n \rangle}
                                   {\langle \boldsymbol{y}_n, \boldsymbol{y}_n \rangle}.
    $$

    These are **alternated** between odd and even iterations.  Each is accepted
    only if the quotient is positive (meaningful curvature):
    - BB1 requires $\langle \boldsymbol{s}, \boldsymbol{y} \rangle > 0$;
    - BB2 requires $\langle \boldsymbol{s}, \boldsymbol{y} \rangle \cdot \langle \boldsymbol{y}, \boldsymbol{y} \rangle > 0$.

    If the preferred BB formula fails its sign check, the other is tried as
    fallback.  If both fail, a **reset mechanism** (following Boris) activates:
    the step counter $k_{\mathrm{reset}}$ is incremented and the step is set to

    $$
    \lambda = \min(k_{\mathrm{reset}} \cdot \lambda_{\min},\; \lambda_{\max}).
    $$

    The counter resets to zero after the next successful BB computation.

    All BB step sizes are clamped to $[\lambda_{\min}, \lambda_{\max}] = [10^{-15}, 10^{-3}]$.

**Comparison with Boris Computational Spintronics** (Lepadatu, 2020):

Boris uses the same BB alternation but differs in two ways:

| Aspect | Fullmag | Boris |
|--------|---------|-------|
| Gradient | Tangent projection $-P_{\boldsymbol{m}} \boldsymbol{H}_{\mathrm{eff}}$ | Torque $\boldsymbol{m} \times \tfrac{\gamma}{2}(\boldsymbol{m} \times \boldsymbol{H}_{\mathrm{eff}})$ |
| Update formula | Retraction: $\text{normalize}(\boldsymbol{m} - \lambda\boldsymbol{g})$ | Cayley transform (implicit midpoint) |
| Line search | Armijo backtracking | None (unconditional step) |

The gradient definitions differ by a constant factor $\gamma/2$ (see §2.2),
which is absorbed into the step size.  The Cayley transform preserves
$|\boldsymbol{m}|=1$ exactly but is algebraically equivalent to our retraction
for small steps.  Our Armijo backtracking is an improvement that guarantees
monotone energy decrease.

#### 3.1.3 Algorithm C — Nonlinear Conjugate Gradient (Polak–Ribière+)

This algorithm extends steepest descent by maintaining a conjugate search
direction, achieving superlinear convergence near minima.

**Per-iteration procedure** (implemented in `execute_nonlinear_cg`):

1.  **Compute tangent gradient** $\boldsymbol{g}_n$ as in Algorithm B.

2.  **Check convergence**: $\tau_{\max} \le \epsilon_\tau$ or $\|\boldsymbol{g}\|^2 < 10^{-30}$.

3.  **Ensure descent direction**: if $\langle \boldsymbol{p}_n, \boldsymbol{g}_n \rangle \ge 0$, reset to steepest descent:
    $\boldsymbol{p}_n \leftarrow -\boldsymbol{g}_n$.

4.  **Armijo backtracking line search** along $\boldsymbol{p}_n$:

    $$
    E\!\left[\mathcal{R}_{\boldsymbol{m}}(\lambda \boldsymbol{p}_n)\right]
    \le
    E[\boldsymbol{m}] + c_1\,\lambda\,\langle \boldsymbol{p}_n, \boldsymbol{g}_n \rangle,
    $$

    with $c_1 = 10^{-4}$, maximum 30 backtracks.  Initial step:
    $\lambda_0 = \min(10^{-6},\; 1/\|\boldsymbol{p}_n\|)$.
    The energy functional is the same CPU FDM scalar functional used by
    Algorithm B.

5.  **Compute new gradient** $\boldsymbol{g}_{n+1}$ at the accepted point.

6.  **Vector transport**: transport the old gradient and search direction from
    the tangent space at $\boldsymbol{m}^{(n)}$ to the tangent space at
    $\boldsymbol{m}^{(n+1)}$ via orthogonal projection:

    $$
    \mathcal{T}_{n \to n+1}\,\boldsymbol{v}
    = P_{\boldsymbol{m}^{(n+1)}}\,\boldsymbol{v}
    = \boldsymbol{v} - (\boldsymbol{m}^{(n+1)} \cdot \boldsymbol{v})\,\boldsymbol{m}^{(n+1)}.
    $$

    This is a first-order vector transport (projection transport).

7.  **Polak–Ribière+ update coefficient**:

    $$
    \beta_{n+1}
    = \max\!\left(0,\;
        \frac{\langle \boldsymbol{g}_{n+1},\;
              \boldsymbol{g}_{n+1} - \mathcal{T}_{n \to n+1}\,\boldsymbol{g}_n \rangle}
             {\langle \boldsymbol{g}_n, \boldsymbol{g}_n \rangle}
      \right).
    $$

    The $\max(0, \cdot)$ clamp is the "+" modification that provides an
    automatic restart when conjugacy is lost ($\beta < 0$), which is critical
    for nonlinear problems on manifolds.

8.  **Periodic restart**: every 50 iterations, force $\beta = 0$ (steepest
    descent restart) to prevent accumulation of rounding errors in the search
    direction.

9.  **New search direction**:

    $$
    \boldsymbol{p}_{n+1}
    = -\boldsymbol{g}_{n+1}
    + \beta_{n+1}\,\mathcal{T}_{n \to n+1}\,\boldsymbol{p}_n.
    $$

10. **Descent check**: if $\langle \boldsymbol{p}_{n+1}, \boldsymbol{g}_{n+1} \rangle \ge 0$, reset to steepest descent.

**Comparison with OOMMF** (`Oxs_CGEvolve`, from Donahue & Porter):

| Aspect | Fullmag NCG | OOMMF `Oxs_CGEvolve` |
|--------|-------------|---------------------|
| β formula | Polak–Ribière+ (default; auto-restart) | Fletcher–Reeves (default; configurable) |
| Line search | Armijo backtracking (sufficient decrease) | Cubic interpolation (bracket + secant + cubic) |
| Update | Retraction (cellwise normalize) | Rodrigues rotation (exact) |
| Transport | Projection transport | Projection transport |
| Restart | Every 50 iterations + PR+ auto-restart | Powell restart criterion |

Our PR+ is generally more robust for nonlinear manifolds.  OOMMF's cubic
interpolation line search converges in fewer iterations for smooth energy
landscapes but is more complex and harder to port to GPU.

#### 3.1.4 Algorithm D — Manifold L-BFGS (deferred)

Once BB and NCG are stable and GPU-ported, a limited-memory BFGS variant
on the manifold will further improve convergence near minima.  Deferred because:

- line-search requirements are stricter (Wolfe conditions),
- state/history memory is $O(kN)$ for $k$ history vectors,
- cautious Hessian updates needed on the manifold.

#### 3.1.5 Convergence criteria

All three algorithms use the same convergence criteria (with different
implementations of the torque check):

| Criterion | Formula | Required? | Default |
|-----------|---------|-----------|---------|
| Torque tolerance | $\tau_{\max} \le \epsilon_\tau$ | Yes | $10^{-4}$ A/m |
| Energy tolerance | $\max(E)-\min(E) \le \epsilon_E$ over the last 50 accepted relaxation steps | Optional | None |
| Max iterations | $n \ge n_{\max}$ | Yes (hard cap) | 50000 |

For LLG overdamped, the torque is estimated from the RHS norm (see §3.1.1).
For BB and NCG, the torque is computed directly as $\|\boldsymbol{m}_i \times \boldsymbol{H}_{\mathrm{eff},i}\|$.

#### 3.1.6 Implementation parameters

The following internal parameters are currently hardcoded.  All values are
chosen to be robust across a wide range of problems; future versions may
expose them via `RelaxationControlIR`.

| Parameter | BB value | NCG value | Rationale |
|-----------|----------|-----------|-----------|
| $\lambda_0$ (initial step) | $10^{-6}$ | $\min(10^{-6}, 1/\|\boldsymbol{p}\|)$ | Conservative start |
| $\lambda_{\min}$ | $10^{-15}$ | — | Floor for BB step |
| $\lambda_{\max}$ | $10^{-3}$ | — | Ceiling for BB step |
| $c_1$ (Armijo parameter) | $10^{-4}$ | $10^{-4}$ | Standard value [Nocedal & Wright] |
| Max backtracks | 20 | 30 | NCG gets more attempts due to CG direction quality |
| Gradient floor | $10^{-30}$ | $10^{-30}$ | Numerical zero |
| BB scaling factor | $10^{-6}$ | — | Prevents overflow in accumulated inner products |
| Restart interval | — | 50 | Prevents CG direction drift |
| BB alternation | BB1 ↔ BB2 per iteration | — | [Barzilai & Borwein, 1988] |

#### 3.1.7 GPU architecture notes

All FDM relaxation algorithms reuse the same GPU kernels for:

- effective field assembly (exchange, demag FFT, Zeeman),
- energy reduction,
- torque reduction.

Additional GPU operations needed for BB/NCG:

- tangent-gradient kernel ($g_i = -P_{m_i} H_{\mathrm{eff},i}$),
- BB scalar reductions ($\langle s, s \rangle$, $\langle s, y \rangle$, $\langle y, y \rangle$),
- line-search energy evaluation,
- NCG direction update and vector transport.

The dominant cost remains the demagnetization FFT, so algorithms that require
fewer trial evaluations (NCG > BB > overdamped LLG) are preferred at scale.

### 3.2 FEM

See `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`.

FEM relaxation will use the same algorithmic structure but with:
- FEM field assembly replacing FDM stencils,
- mass-weighted inner products $\langle u, v \rangle_M$ replacing pointwise sums,
- `TangentPlaneImplicit` as an additional FEM-specific method.

### 3.3 Hybrid

Deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

```python
fm.Relaxation(
    algorithm="projected_gradient_bb",   # or "llg_overdamped", "nonlinear_cg"
    torque_tolerance=1e-4,               # A/m
    energy_tolerance=1e-10,              # J (optional)
    max_steps=50000,
)
```

Available algorithm strings:
- `"llg_overdamped"` — Algorithm A
- `"projected_gradient_bb"` — Algorithm B
- `"nonlinear_cg"` — Algorithm C
- `"tangent_plane_implicit"` — FEM-only, not yet executable

### 4.2 ProblemIR representation

```rust
pub enum RelaxationAlgorithmIR {
    LlgOverdamped,
    ProjectedGradientBb,
    NonlinearCg,
    TangentPlaneImplicit,
}
```

The relaxation study is represented as:

```rust
StudyIR::Relaxation {
    algorithm: RelaxationAlgorithmIR,
    dynamics: DynamicsIR,
    torque_tolerance: f64,
    energy_tolerance: Option<f64>,
    max_steps: u64,
    sampling: SamplingIR,
}
```

### 4.3 Planner and capability-matrix impact

The planner gate (`fullmag-plan/src/lib.rs`) allows:
- `LlgOverdamped` → all FDM backends
- `ProjectedGradientBb` → all FDM backends
- `NonlinearCg` → all FDM backends
- `TangentPlaneImplicit` → **rejected** (FEM-only, not yet implemented)

The runner (`fullmag-runner/src/cpu_reference.rs`) dispatches:
- LLG overdamped → existing Heun time-stepping loop
- BB / NCG → direct minimization path (bypasses time stepping)

CPU FDM run provenance records direct minimization explicitly. BB and NCG runs populate
`requested_energy_minimizer`, `resolved_energy_minimizer`, and
`energy_minimizer_realization = "cpu_soa_tangent_gradient"`; LLG time-integration
relaxation leaves those fields unset and reports the resolved integrator instead.

## 5. Validation strategy

### 5.1 Analytical checks

1. **Energy monotonicity**: for BB and NCG (with Armijo), energy must not
   increase between consecutive accepted steps.  Verified by
   `bb_relaxation_decreases_energy_on_random_initial` and
   `ncg_relaxation_decreases_energy_on_random_initial`.

2. **Torque-to-zero on equilibrium**: a uniform magnetization aligned with
   the applied field must have $\tau_{\max} = 0$.  Verified by
   `bb_relaxation_stops_on_uniform_state` and
   `ncg_relaxation_stops_on_uniform_state`.

3. **$\boldsymbol{m} \parallel \boldsymbol{H}_{\mathrm{eff}}$ at equilibrium**:
   verified implicitly via the torque tolerance check.

### 5.2 Cross-algorithm checks

All three algorithms must converge to the same equilibrium (within tolerance)
from the same random initial state.  Verified by
`all_algorithms_converge_to_similar_equilibrium` (20% relative energy
tolerance, accounting for different convergence paths and the coarse
torque tolerance $\epsilon_\tau = 10^{-4}$).

### 5.3 Regression tests

| Test | Algorithm | Assertion |
|------|-----------|-----------|
| `bb_relaxation_stops_on_uniform_state` | BB | Completes on equilibrium input |
| `ncg_relaxation_stops_on_uniform_state` | NCG | Completes on equilibrium input |
| `bb_relaxation_decreases_energy_on_random_initial` | BB | $E_{\mathrm{final}} \le E_{\mathrm{initial}}$ |
| `ncg_relaxation_decreases_energy_on_random_initial` | NCG | $E_{\mathrm{final}} \le E_{\mathrm{initial}}$ |
| `projected_gradient_bb_soa_matches_aos_reference_path` | BB | SoA direct minimizer matches the old AoS reference path |
| `nonlinear_cg_soa_matches_aos_reference_path` | NCG | SoA direct minimizer matches the old AoS reference path |
| `total_energy_helpers_include_local_conservative_terms` | BB/NCG energy helper | Direct-minimizer energy helper matches full observable energy for anisotropy and prescribed-strain magnetoelastic terms |
| `dmi_scalar_energy_matches_native_centered_density_contract` | BB/NCG energy helper | Direct-minimizer energy helper and full observables match the native centered-density DMI scalar contract |
| `step_report_carries_anisotropy_energy_for_cpu_scalar_rows` | LLG | Full CPU step reports carry anisotropy energy for scalar rows |
| `scalar_only_due_outputs_use_step_report_without_reobserving_state` | LLG output scheduling | Scalar-only scheduled rows reuse the step report without a full observables pass |
| `magnetization_only_due_outputs_read_state_without_reobserving_state` | LLG output scheduling | Scheduled `m`/`m.x/y/z` artifact snapshots read current state without full observables |
| `final_magnetization_only_outputs_read_state_without_reobserving_state` | LLG output scheduling | Final `m`/`m.x/y/z` artifact snapshots read current state without full observables when no scalar row is due |
| `external_field_due_outputs_read_problem_field_without_reobserving_state` | LLG output scheduling | Scheduled `H_ext`/`H_ext.x/y/z` artifact snapshots use the direct external-field accessor without full observables |
| `oersted_field_due_outputs_read_per_node_field_without_reobserving_state` | LLG output scheduling | Scheduled `H_OE`/`H_OE.x/y/z` artifact snapshots use the current per-node field artifact source without full observables |
| `exchange_field_due_outputs_read_problem_field_without_reobserving_state` | LLG output scheduling | Scheduled `H_ex`/`H_ex.x/y/z` artifact snapshots use the direct exchange-field accessor without full observables |
| `demag_field_due_outputs_read_problem_field_without_reobserving_state` | LLG output scheduling | Scheduled `H_demag`/`H_demag.x/y/z` artifact snapshots use the direct demag-field accessor without full observables |
| `effective_field_due_outputs_read_observable_field_without_reobserving_state` | LLG output scheduling | Scheduled `H_eff`/`H_eff.x/y/z` artifact snapshots use the field-only observable effective-field accessor without full observables |
| `torque_due_outputs_read_observable_effective_field_without_reobserving_state` | LLG output scheduling | Scheduled `torque`/`torque.x/y/z` artifact snapshots derive from the observable effective field without full observables |
| `effective_field_and_torque_due_outputs_share_direct_effective_field_cache` | LLG output scheduling | A direct output pass reuses one observable effective-field assembly across `H_eff` siblings and `torque` snapshots |
| `default_final_scalar_trace_uses_last_step_report_without_reobserving_state` | LLG output finalization | Default final scalar trace uses the last `StepReport` instead of reobserving the final state |
| `final_outputs_do_not_duplicate_current_time_scalar_row_or_reobserve_state` | LLG/direct output finalization | Final output pass skips duplicate scalar rows and full observables when a current-time scalar row already exists |
| `snapshot_preview_m_uses_direct_state_without_reobserving_state` | CPU preview snapshot | Magnetization preview snapshots read current state without full observables |
| `snapshot_vector_fields_share_direct_effective_field_cache_without_reobserving_state` | CPU cached preview snapshot | Cached `H_eff` and `torque` preview fields share one direct effective-field assembly without full observables |
| `cpu_interactive_snapshot_preview_m_uses_direct_state_without_reobserving_state` | Interactive CPU preview snapshot | Interactive magnetization preview snapshots read current state without full observables |
| `cpu_interactive_snapshot_vector_fields_share_direct_effective_field_cache_without_reobserving_state` | Interactive CPU cached preview snapshot | Interactive cached `H_eff` and `torque` preview fields share one direct effective-field assembly without full observables |
| `cpu_interactive_snapshot_step_stats_uses_last_step_report_without_reobserving_state` | Interactive CPU scalar snapshot | Interactive step-stat snapshots reuse the last matching `StepReport` without full observables |
| `all_algorithms_converge_to_similar_equilibrium` | All 3 | $|E_i - E_{\mathrm{LLG}}|/|E_{\mathrm{LLG}}| < 20\%$ |
| `llg_overdamped_relaxation_stops_before_time_limit_on_uniform_state` | LLG | Stops early on equilibrium |
| `uniform_relaxation_produces_stable_energy` | LLG | Energy stable on equilibrium |
| `random_initial_relaxes_with_decreasing_energy` | LLG | Exchange energy decreases |

## 6. Completeness checklist

- [x] Python API (`fm.Relaxation(algorithm=...)`)
- [x] ProblemIR (`RelaxationAlgorithmIR` enum)
- [x] Planner (gate allows BB and NCG)
- [x] Capability matrix (FDM: all 3 algorithms)
- [x] FDM backend — LLG overdamped
- [x] FDM backend — Projected Gradient BB
- [x] FDM backend — Nonlinear CG
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables (energy, torque, magnetization)
- [x] Tests / benchmarks (direct-relaxation regression and SoA/AoS parity tests)
- [x] Documentation (this note)

## 7. Known limits and deferred work

1. **No thermal relaxation** — simulated annealing or Langevin noise is not
   supported.
2. **No saddle-search methods** — NEB, string methods, or dimer are not
   implemented.
3. **No manifold L-BFGS** — deferred to a future iteration.
4. **Hardcoded internal parameters** — $\lambda_{\min}$, $\lambda_{\max}$,
   $c_1$, restart interval are not exposed via IR.
5. **Retraction via normalization** — Cayley transform deferred to GPU
   implementation.
6. **Single-material only** — multi-region relaxation requires spatially
   varying $M_s$ support.
7. **No GPU implementation** — BB and NCG currently run on CPU only.
8. **No intermediate output recording** — BB/NCG report only final state,
   not per-iteration traces.
9. **NCG line search is Armijo only** — cubic interpolation would reduce
   iteration count.

## 8. References

1. Barzilai, J. & Borwein, J. M. (1988). Two-point step size gradient methods.
   *IMA J. Numer. Anal.*, 8(1), 141–148.
   doi:[10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141)

2. Exl, L. et al. (2014). LaBonte's method revisited: An effective steepest
   descent method for micromagnetic energy minimization.
   *J. Appl. Phys.*, 115, 17D118.
   doi:[10.1063/1.4862839](https://doi.org/10.1063/1.4862839)

3. Lepadatu, S. (2020). Boris computational spintronics — High performance
   multi-mesh magnetic and spin transport modeling software.
   *J. Appl. Phys.*, 128, 243902.
   doi:[10.1063/5.0024382](https://doi.org/10.1063/5.0024382)

4. Donahue, M. J. & Porter, D. G. OOMMF User's Guide, Version 1.0.
   NISTIR 6376. National Institute of Standards and Technology.

5. Nocedal, J. & Wright, S. J. (2006). *Numerical Optimization* (2nd ed.).
   Springer. ISBN 978-0-387-30303-1.

6. Absil, P.-A., Mahony, R. & Sepulchre, R. (2008). *Optimization Algorithms
   on Matrix Manifolds*. Princeton University Press.

7. Polak, E. & Ribière, G. (1969). Note sur la convergence de méthodes de
   directions conjuguées. *RIRO*, 3(16), 35–43.
