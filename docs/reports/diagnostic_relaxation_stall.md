# Diagnostic Report: Relaxation Stall in Nanoflower FDM Simulation

**Date:** 2025-07-12  
**Scope:** `examples/nanoflower_fdm.py` — FDM/CUDA/RK23 path  
**Symptom:** Total energy flat, magnetization frozen — spins do not relax  

---

## 1  Executive Summary

The relaxation stall has **one primary root cause** and **two contributing bugs**.

| # | Severity | Bug | Effect |
|---|----------|-----|--------|
| **P0** | Critical | CUDA RK23 adaptive stepping does not grow `dt` between calls; outer Rust loop always passes the user-supplied `dt = 1e-15 s` | Each step moves \|dm\| ≈ 1.8 × 10⁻⁶; after 50 000 steps total rotation ≈ 5° out of ~180° needed — system appears frozen |
| **P1** | High | `solver(max_error=...)` is silently dropped — never reaches CUDA backend | User has no way to control adaptive tolerance from Python |
| **P2** | Medium | FEM `llg_rhs_from_field()` ignores `precession_enabled` flag | Overdamped relaxation broken for FEM path (does not affect this FDM case) |
| **P3** | Low | FEM `llg_rhs_from_vectors()` calls `observe_vectors()` per RK stage | ~8× overhead on every RHS evaluation in FEM (does not affect FDM) |

---

## 2  Reproduction

```python
# examples/nanoflower_fdm.py (simplified)
fm.engine("fdm"); fm.device("cuda:0"); fm.cell(2.5e-9, 2.5e-9, 2.5e-9)
flower = fm.geometry(fm.ImportedGeometry(source="nanoflower.stl", units="nm"))
flower.Ms, flower.Aex, flower.alpha = 752e3, 15.5e-12, 0.1
flower.m = fm.random(seed=7)

fm.b_ext(0.1, theta=0, phi=0)          # 0.1 T along +z
fm.solver(dt=1e-15, max_error=1e-6, integrator="rk23", g=2.115)
fm.relax(tol=1e-6, max_steps=50_000, algorithm="llg_overdamped")
```

---

## 3  Full Execution Path

```
Python world.py  →  IR JSON  →  fullmag-plan (Planner)
  →  fullmag-runner/multilayer_cuda.rs
       build_native_stacked_cuda_plan()   — builds FdmPlanIR
       execute_native_stacked_cuda_multilayer()
         →  NativeFdmBackend::create()    — crates/fullmag-runner/src/native_fdm.rs
              →  fullmag_fdm_backend_create()  — native/backends/fdm/src/api.cpp
                   →  Context struct       — native/backends/fdm/include/context.hpp
         while time < until_seconds:
           backend.step(dt_step)
             →  launch_rk23_step_fp64()    — native/backends/fdm/src/llg_rk23_fp64.cu
```

---

## 4  Bug P0 — Fixed dt Passed Every Step (Critical)

### 4.1  The Outer Loop

In `multilayer_cuda.rs:585`:

```rust
let dt = native.combined_plan.fixed_timestep.unwrap_or(1e-13);
```

User set `dt = 1e-15`, so `dt = 1e-15`. The stepping loop (`multilayer_cuda.rs:614`):

```rust
let dt_step = dt.min(until_seconds - current_time);
let stats = backend.step(dt_step);          // always 1e-15
```

There is **no mechanism to carry the adapted dt from one call to the next**. Every call passes `dt = 1e-15`.

### 4.2 The CUDA RK23 Kernel

In `llg_rk23_fp64.cu:193-298`, `launch_rk23_step_fp64(ctx, dt, stats)`:

- Receives `dt` from Rust caller (always `1e-15`)
- On **accepted** step (`error ≤ max_error`): does NOT compute a new `dt` — simply `return`s
- On **rejected** step: shrinks `dt` via `dt_new = headroom * dt * (tol/err)^(1/3)`
- The `Context` struct has **no `last_accepted_dt` field** — adapted dt cannot survive between calls

Result: the CUDA integrator works as **fixed-step RK3** — the embedded error estimate is unused for step growth.

### 4.3  Numerical Impact

Using the nanoflower parameters:

$$\gamma = \frac{\mu_0 \cdot g \cdot \mu_B}{\hbar} = \frac{4\pi \times 10^{-7} \cdot 2.115 \cdot 9.274 \times 10^{-24}}{1.054 \times 10^{-34}} \approx 2.337 \times 10^5 \text{ m/(A·s)}$$

$$H_\text{ext} = \frac{B}{\mu_0} = \frac{0.1}{4\pi \times 10^{-7}} \approx 7.958 \times 10^4 \text{ A/m}$$

For LLG overdamped (pure damping, `α = 0.1`):

$$\left|\frac{dm}{dt}\right|_\text{max} = \frac{\gamma \cdot \alpha}{1 + \alpha^2} \cdot |m \times H_\text{eff}| \approx \frac{2.337 \times 10^5 \cdot 0.1}{1.01} \cdot 7.958 \times 10^4 \approx 1.84 \times 10^9 \text{ s}^{-1}$$

$$|\Delta m|_\text{per step} = |dm/dt| \cdot dt = 1.84 \times 10^9 \times 10^{-15} \approx 1.84 \times 10^{-6}$$

Steps to rotate 1 radian at this rate:

$$N_{1\text{rad}} = \frac{1}{|\Delta m|} \approx 543\,000 \text{ steps}$$

With `max_steps = 50 000` and `until_seconds = dt × max_steps = 5 \times 10^{-11} s`:

$$\theta_\text{total} \approx \frac{50\,000}{543\,000} \approx 0.09 \text{ rad} \approx 5.3°$$

**The system needs ~180° of rotation to align with H_ext. It achieves ~5°. Relaxation appears frozen.**

### 4.4  Fix Proposal

Two complementary fixes:

**A. Add dt growth on accepted steps in CUDA RK23:**

In `llg_rk23_fp64.cu`, after the acceptance branch, compute the optimal next dt:

```cpp
if (error <= ctx.adaptive_max_error || dt <= ctx.adaptive_dt_min) {
    // Accept step — compute optimal dt for caller
    double dt_opt = ctx.adaptive_headroom * dt * pow(ctx.adaptive_max_error / fmax(error, 1e-30), 1.0/3.0);
    dt_opt = fmin(dt_opt, ctx.adaptive_dt_max);
    dt_opt = fmax(dt_opt, ctx.adaptive_dt_min);
    ctx.last_accepted_dt = dt_opt;    // ← NEW field in Context
    // ... existing diagnostics ...
    stats->dt_seconds = dt;
    return;
}
```

Add to `Context`:

```cpp
double last_accepted_dt = 0.0;
```

**B. Use `last_accepted_dt` in Rust outer loop:**

In `multilayer_cuda.rs`, replace the fixed-dt loop:

```rust
let mut dt = native.combined_plan.fixed_timestep.unwrap_or(1e-13);
// ...
while ... {
    let dt_step = dt.min(until_seconds - current_time);
    let stats = backend.step(dt_step)?;
    // Update dt from backend's adaptive estimate (if available)
    if stats.dt > 0.0 {
        dt = stats.dt;  // or a separate field for suggested_next_dt
    }
    // ...
}
```

Alternatively, expose `last_accepted_dt` via the FFI stats struct or a separate query.

---

## 5  Bug P1 — `solver(max_error=...)` Silently Dropped (High)

### 5.1  Evidence

In `world.py:750-752`, `solver()` stores the value:

```python
if max_error is not None:
    _state._max_error = max_error
```

But `_build_problem()` (lines 918-926) never reads it:

```python
llg_kwargs: dict[str, Any] = {}
if s._dt is not None:
    llg_kwargs["fixed_timestep"] = s._dt
if s._integrator is not None:
    llg_kwargs["integrator"] = s._integrator
if s._gamma is not None and not math.isclose(s._gamma, DEFAULT_GAMMA):
    llg_kwargs["gamma"] = s._gamma
dynamics = LLG(**llg_kwargs)
# ← max_error NOT passed; adaptive_timestep NOT constructed
```

The `LLG` dataclass (`model/dynamics.py:83-88`) supports `adaptive_timestep: AdaptiveTimestep | None`:

```python
@dataclass(frozen=True, slots=True)
class LLG:
    gamma: float = DEFAULT_GAMMA
    integrator: str = "auto"
    fixed_timestep: float | None = None
    adaptive_timestep: AdaptiveTimestep | None = None
```

But `_build_problem()` never creates an `AdaptiveTimestep`.

In the Rust runner (`native_fdm.rs:181-184`), adaptive params are hardcoded to `0.0`:

```rust
adaptive_max_error: 0.0,   // 0 → backend default 1e-5
adaptive_dt_min:    0.0,   // 0 → backend default 1e-18
adaptive_dt_max:    0.0,   // 0 → backend default 1e-10
adaptive_headroom:  0.0,   // 0 → backend default 0.8
```

### 5.2  Fix Proposal

In `_build_problem()`, thread `_max_error` through:

```python
if s._max_error is not None and s._integrator in ("rk23", "rk45"):
    llg_kwargs["adaptive_timestep"] = AdaptiveTimestep(atol=s._max_error)
```

Then propagate `AdaptiveTimestep` fields through `LLG.to_ir()` → `ProblemIR` → planner → `FdmPlanIR` → `native_fdm.rs` → `fullmag_fdm_plan_desc`.

---

## 6  Bug P2 — FEM Missing `precession_enabled` (Medium)

In `crates/fullmag-engine/src/fem.rs:1110-1116`:

```rust
pub fn llg_rhs_from_field(
    &self, magnetization: &[Vector3], h_eff: &[Vector3],
    out: &mut [Vector3],
) {
    // Always uses full LLG — precession_enabled never checked
    let gamma_bar = self.gamma / (1.0 + self.alpha * self.alpha);
    for i in 0..magnetization.len() {
        let m = magnetization[i];
        let h = h_eff[i];
        let cross = m.cross(h);
        let damping = m.cross(cross);
        out[i] = scale(-gamma_bar, add(cross, scale(self.alpha, damping)));
    }
}
```

When `algorithm = "llg_overdamped"`, `execute_fem()` sets `precession_enabled = false`. But `llg_rhs_from_field()` ignores this flag entirely — the precession term `m × H` is always included.

**Impact:** FEM overdamped relaxation includes unphysical precession, causing oscillation instead of pure damping descent. Not triggered by nanoflower (FDM), but affects all FEM relaxation runs.

**Fix:** Add precession check:

```rust
let cross = m.cross(h);
let damping = m.cross(cross);
if self.precession_enabled {
    out[i] = scale(-gamma_bar, add(cross, scale(self.alpha, damping)));
} else {
    out[i] = scale(-gamma_bar * self.alpha, damping);
}
```

---

## 7  Bug P3 — FEM `observe_vectors` per RK Stage (Low)

In `fem.rs:1095-1096`:

```rust
fn llg_rhs_from_vectors(&mut self, magnetization: &[Vector3]) -> Vec<Vector3> {
    let obs = self.observe_vectors(magnetization);  // computes ALL fields + energies
    ...
}
```

`observe_vectors()` computes exchange field, demag field, Zeeman field, all energies, and max norms — far more than the RHS needs (`h_eff` only). For RK4 this means 4× overhead, for DP45 up to 6×.

**Fix:** Extract a lightweight `compute_effective_field()` method that only computes `h_eff`, and call `observe_vectors()` only at the end of an accepted step for diagnostics.

---

## 8  Verification of User's Original Claims

| # | User Claim | Verdict | Notes |
|---|-----------|---------|-------|
| 1 | "Zero effective field / zero torque" | **Partially incorrect** for nanoflower | `m = random(seed=7)` ⊥ `H_ext = (0,0,H_z)` → large torque. However, the effect is the same: negligible rotation due to tiny dt |
| 2 | `EffectiveFieldTerms::default()` has `demag: false` | **True but irrelevant** | Nanoflower script adds `Demag()` explicitly via `energy: list = [Exchange(), Demag()]` in `_build_problem()`. The default struct is only used in CPU engine paths that construct `LlgConfig::new()` without specifying terms |
| 3 | `α = 0` causes zero damping torque | **Not the case** | `flower.alpha = 0.1` in script; properly flows through IR → planner → CUDA Context |
| 4 | FEM `observe_vectors` overhead | **Confirmed** | Real bug, ~8× wasted compute per step. Does not affect nanoflower (FDM) |
| 5 | FEM missing `precession_enabled` | **Confirmed** | Real bug, breaks overdamped relaxation for FEM. Does not affect nanoflower (FDM CUDA has correct `disable_precession` plumbing) |

---

## 9  Quick Fix: Workaround for Nanoflower

The nanoflower simulation will work if the user increases the timestep:

```python
fm.solver(dt=1e-12, integrator="rk23", g=2.115)
fm.relax(tol=1e-6, max_steps=500_000)
```

With `dt = 1e-12`:
- `|Δm|/step ≈ 1.84 × 10⁻³` → rotation per step is 1000× larger
- `until_seconds = 1e-12 × 500 000 = 5 × 10⁻⁷ s` → 0.5 μs of simulated time
- Steps for 1 rad ≈ 543 → full relaxation within ~2000 steps readily
- Adaptive rejection (`error > 1e-5`) will automatically shrink dt if stability requires it

---

## 10  Recommended Fix Priority

1. **P0 — Fix adaptive dt growth in CUDA RK23** (most impactful)
   - Add `last_accepted_dt` to `Context`
   - Compute optimal next dt on acceptance
   - Thread it back through stats or a separate query
   - Rust outer loop uses `last_accepted_dt` as starting dt for next call

2. **P1 — Thread `max_error` from Python to CUDA**
   - `world.py:_build_problem()` → `AdaptiveTimestep(atol=...)` → `LLG.to_ir()` → IR → planner → `FdmPlanIR` → `native_fdm.rs` → `fullmag_fdm_plan_desc.adaptive_max_error`

3. **P2 — FEM `precession_enabled`** — single-line fix in `fem.rs`

4. **P3 — FEM RHS overhead** — refactor `llg_rhs_from_vectors` to skip diagnostics

---

## 11  Files Referenced

| File | Lines | What |
|------|-------|------|
| `packages/fullmag-py/src/fullmag/world.py` | 720-770, 890-940, 998-1060 | `solver()` stores `max_error`; `_build_problem()` never reads it; `relax()` computes `until_seconds` |
| `packages/fullmag-py/src/fullmag/model/dynamics.py` | 1-130 | `LLG` dataclass with `adaptive_timestep` field, `AdaptiveTimestep` class |
| `crates/fullmag-runner/src/multilayer_cuda.rs` | 434-570, 575-740 | `build_native_stacked_cuda_plan()`, `execute_native_stacked_cuda_multilayer()` — fixed dt in loop |
| `crates/fullmag-runner/src/native_fdm.rs` | 40-190, 206-240 | `NativeFdmBackend::create()` — adaptive params all 0.0; `step()` |
| `native/backends/fdm/src/llg_rk23_fp64.cu` | 190-310 | `launch_rk23_step_fp64()` — no dt growth on acceptance |
| `native/backends/fdm/include/context.hpp` | 42-100 | `Context` struct — no `last_accepted_dt` field |
| `native/backends/fdm/src/api.cpp` | 125-140 | `adaptive_*` defaults when plan passes 0.0 |
| `crates/fullmag-engine/src/fem.rs` | 1090-1120 | FEM `llg_rhs_from_field` missing precession check |
| `crates/fullmag-engine/src/lib.rs` | 205-270, 275-300 | `AdaptiveStepConfig`, `LlgConfig`, `EffectiveFieldTerms::default()` |
| `crates/fullmag-cli/src/main.rs` | 2611-2635 | `resolve_script_until_seconds()` — `dt * max_steps` |
| `crates/fullmag-runner/src/relaxation.rs` | 1-75 | `relaxation_converged()`, `approximate_max_torque()` |
