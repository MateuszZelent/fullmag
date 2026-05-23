# FSAL Optimization for Dormand–Prince 5(4) — FDM

- Status: implemented
- Created: 2026-03-27
- Affects: CPU FDM/FEM engine, CUDA FDM backend, IR `IntegratorChoice::Rk45`
- Related: 0480-fdm-higher-order-and-adaptive-time-integrators.md

## 1. Problem Statement

Each Dormand–Prince 5(4) (DP45) step requires 7 right-hand-side (RHS)
evaluations: 6 intermediate stages plus 1 extra to form the embedded
4th-order error estimate. Each RHS evaluation triggers a full
effective-field assembly including the dominant $\mathcal{O}(N\log N)$
FFT-based demagnetization, making RHS cost the simulation bottleneck.

## 2. FSAL Property

The DP45 Butcher tableau has the **First Same As Last** property:

$$
b_i = a_{7,i} \quad \forall\, i \in \{1,\ldots,6\}
$$

This means the 5th-order solution
$\mathbf{y}_{n+1} = \mathbf{y}_n + h \sum_i b_i \mathbf{K}_i$
coincides with the intermediate state used to evaluate $\mathbf{K}_7 =
F(\mathbf{y}_{n+1})$.

**Consequence**: On an accepted step, $\mathbf{K}_7$ equals $F(\mathbf{y}_{n+1})$,
which is exactly $\mathbf{K}_1$ for step $n+1$.

## 3. Protocol

```
if fsal_buffer_valid:
    K₁ ← k_fsal          # no RHS evaluation
else:
    K₁ ← F(yₙ, tₙ)       # full RHS evaluation

K₂ through K₆: standard DP tableau stages

y₅ ← normalize(yₙ + h·Σ bᵢKᵢ)    # 5th-order solution
K₇ ← F(y₅, tₙ + h)                # stage 7

error ← h · ‖Σ eᵢKᵢ‖∞            # embedded 4th-order error

if error ≤ tolerance:
    yₙ₊₁ ← y₅
    k_fsal ← K₇                   # store for next step
    fsal_buffer_valid ← true
else:
    fsal_buffer_valid ← false      # reject, K₇ is wasted
    h ← shrink(h, error)
```

## 4. Cost Reduction

| Metric | Without FSAL | With FSAL |
|--------|-------------|-----------|
| RHS/accepted step | 7 | 6 |
| RHS/rejected step | 7 | 7 |
| Saving on accepted | — | **14.3%** |

## 5. Sphere Projection

After each stage, the magnetization is re-normalized to $|\mathbf{m}| = 1$,
preserving the constraint manifold $S^2$ inherent to the LLG equation.
FSAL remains valid because the stored $\mathbf{K}_7$ was evaluated at
the projected, accepted state.

## 6. FSAL Invalidation Conditions

The FSAL buffer **must be invalidated** when:
- A step is rejected (error > tolerance)
- Thermal noise is active (stochastic RHS changes between steps)
- External field changes discontinuously between steps
- The simulation is re-initialized or magnetization is uploaded

## 7. Implementation

### CPU (Rust `fullmag-engine`)
- `ExchangeLlgState.k_fsal: Option<Vec<Vector3>>` stores the FSAL buffer
- `rk45_step()` checks `fsal_valid` flag before computing $K_1$
- On rejection: `fsal_valid = false`, buffer is stale

### CUDA (`native/backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu`)
- `DeviceVectorField k_fsal` in `Context` (SoA layout)
- `ctx.fsal_valid` flag controls reuse
- `copy_field_d2d()` for $K_{fsal} \to K_1$ transfer (device-to-device)

## 8. Validation

Validated by checking that:
1. CPU DP45+FSAL produces identical results to DP45 without FSAL
2. All 43 engine unit tests pass
3. Energy conservation and $|\mathbf{m}| = 1$ constraint maintained
