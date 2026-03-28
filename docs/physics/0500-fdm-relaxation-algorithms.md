
# Relaxation algorithms for FDM micromagnetics

- Status: implemented
- Owners: Fullmag core
- Last updated: 2026-03-27
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

Fullmag currently still uses the runner's pseudo-time and output cadence during
`llg_overdamped` relaxation, so reported stage time is an execution-control
quantity rather than a physically meaningful evolution time.

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

**Stop criteria** (implemented in `relaxation_converged`):
1. $\tau_{\max} \le \epsilon_\tau$ (torque tolerance),
2. optionally $|E_{n} - E_{n-1}| \le \epsilon_E$ (energy tolerance),
3. hard cap on iteration count.

#### 3.1.2 Algorithm B — Projected Gradient + Barzilai–Borwein

This algorithm performs steepest descent on the product manifold
$(\mathbb{S}^2)^N$ with adaptive step sizes selected by the
Barzilai–Borwein (BB) method [Barzilai & Borwein, 1988].

**Per-iteration procedure** (implemented in `execute_projected_gradient_bb`):

1.  **Compute effective field and tangent gradient**:

    $$
    \boldsymbol{H}_{\mathrm{eff}} = \boldsymbol{H}_{\mathrm{ex}} + \boldsymbol{H}_{\mathrm{demag}} + \boldsymbol{H}_{\mathrm{ext}},
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
| Energy tolerance | $\|E_n - E_{n-1}\| \le \epsilon_E$ | Optional | None |
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
- [x] Tests / benchmarks (8 regression tests)
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
