# GPU FDM precision policy and calibration

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-24
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`
- Related specs: `docs/specs/problem-ir-v0.md`, `docs/specs/capability-matrix-v0.md`, `docs/specs/exchange-only-full-solver-architecture-v1.md`, `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`, `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`

## 1. Problem statement

Fullmag now has a trusted CPU reference engine for the narrow `Exchange + Demag + Zeeman` FDM
slice, and a matching native CUDA `double` execution path for the same slice.
The next production milestone is to finish calibration and qualification of that CUDA path without
changing the physical meaning of the problem.

This move is not only about performance.
It must also define:

- what "single precision" and "double precision" mean in Fullmag,
- where the user selects that mode,
- how the selected precision is preserved through Python API, `ProblemIR`, planning, and backend execution,
- how GPU results are calibrated against the CPU reference and against each other.

The guiding principle is:

> Precision is an execution policy chosen by the user, not a hidden backend implementation detail.

## 2. Physical model

### 2.1 Governing equations

The continuum model is unchanged from the current FDM physics notes.
We still solve the Gilbert-form LLG equation with an effective field assembled from the active
interaction set. For the currently executable slice:

\[
\mathbf{H}_{\mathrm{eff}} =
\mathbf{H}_{\mathrm{ex}} +
\mathbf{H}_{\mathrm{demag}} +
\mathbf{H}_{\mathrm{ext}}.
\]

The Heun stepper still evolves:

\[
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma}{1 + \alpha^2}
\left(
\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+
\alpha \, \mathbf{m} \times
\left(\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}\right)
\right),
\]

Precision choice must not change these equations.
It changes only the floating-point representation and arithmetic used to evaluate the same
discrete operator.

### 2.2 Symbols and SI units

- `m`: reduced magnetization, dimensionless.
- `H_ex`: exchange field, `A/m`.
- `H_demag`: dipolar self-interaction field, `A/m`.
- `H_ext`: externally applied field, `A/m`.
- `E_ex`: exchange energy, `J`.
- `E_demag`: demagnetization energy, `J`.
- `E_ext`: external-field energy, `J`.
- `E_total`: total realized energy for the active interaction set, `J`.
- `gamma`: gyromagnetic ratio in Gilbert form, `m / (A s)`.
- `alpha`: Gilbert damping, dimensionless.
- `M_s`: saturation magnetization, `A/m`.
- `A`: exchange stiffness, `J/m`.
- `precision`: execution policy, one of `single` or `double`.

### 2.3 Assumptions and approximations

- The executable FDM discretization remains the same in CPU and GPU paths for the active term set.
- The public precision selector exposes only:
  - `double`
  - `single`
- Public `mixed` precision is out of scope for the current release.
- In `single` mode, scalar reductions may still accumulate into wider internal types if that is
  documented and deterministic. This does not create a third public precision mode.
- The CPU reference engine remains a correctness baseline and stays `double` only.

## 3. Numerical interpretation

### 3.1 FDM

The GPU backend must implement the same 6-point exchange stencil and the same Heun stepping logic
as the CPU reference engine.

The user-visible precision modes mean:

- `double`
  - state arrays are stored in `fp64`,
  - local operator evaluation uses `fp64`,
  - scalar observables are reduced in `fp64`.
- `single`
  - state arrays are stored in `fp32`,
  - local operator evaluation uses `fp32`,
  - scalar observables may be reduced in `fp64` accumulators if documented in provenance and
    validated against the `double` GPU path.

The important invariant is that `single` and `double` use the same discrete scheme, not two
different algorithms.

Adaptive CUDA RK23/DP45 error control uses the same scalar error semantics in both precisions:
the per-cell error field is reduced on device, only the final scalar maximum is copied to host,
and the max-sqrt reduction is scheduled on the backend compute stream with explicit ordering
against the remaining legacy-default-stream producers. Adaptive backup, FSAL reuse, and reject
restore D2D copies are also bound to the backend compute stream. The adaptive policy scalar
calculation is device-side: a stream-bound CUDA policy kernel converts the reduced max-error
square into the accepted/rejected predicate and candidate next timestep using the same exponent
as the selected integrator (`1/3` for RK23, `1/5` for DP45). The host still consumes the compact
policy result to drive the current control loop until the whole retry/accept controller is moved
fully onto the device.

Calibration order is mandatory:

1. CPU `double` vs GPU `double`,
2. GPU `double` vs GPU `single`.

The project must not validate `single` directly against CPU and skip GPU `double`.

### 3.2 FEM

FEM execution is not part of this milestone.
When FEM lands, precision must follow the same user-facing contract:

- precision is selected by the user,
- stored in canonical IR,
- reflected in provenance,
- calibrated against a reference path.

### 3.3 Hybrid

Hybrid execution is deferred.
When it lands, the precision policy must specify whether both coupled representations use the same
precision or whether explicit mixed-precision coupling is legal.
That is out of scope for exchange-only Phase 2.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Precision belongs to runtime/backend policy, not to the physical `Problem` definition itself.

The public selector is:

```python
fm.Simulation(problem, backend="fdm", mode="strict", precision="double")
fm.Simulation(problem, backend="fdm", mode="strict", precision="single")
```

Default:

- `precision="double"`

This default is chosen because:

- the CPU reference path is double-only,
- double precision is the calibration baseline,
- it is the safer default while the CUDA backend is still being hardened.

### 4.2 ProblemIR representation

Precision is stored in `BackendPolicyIR`, not `DynamicsIR`.

That reflects the architectural truth:

- `gamma`, integrator, and timestep belong to dynamics semantics,
- floating-point precision belongs to execution policy.

The canonical IR field is:

- `backend_policy.execution_precision`

The backend-specific executable FDM plan must also carry:

- `FdmPlanIR.precision`

so the runner and native backend do not infer or silently override precision.

### 4.3 Planner and capability-matrix impact

- `execution_precision="double"` is the only public-executable precision in the current CPU
  reference path.
- `execution_precision="single"` is legal in Python API and `ProblemIR`, but currently
  planning-only for the CPU reference runner.
- Current CUDA execution state:
  - FDM `double` is public-executable on GPU,
  - FDM `single` is public-executable on GPU after calibration,
  - public multilayer CUDA paths also accept `execution_precision="single"`;
    both the native single-grid fast path and the general `cuda-assisted`
    multilayer path execute at the requested precision, including the host-side
    multilayer demag FFT runtime used by the assisted path,
  - the native CUDA FDM transfer ABI also exposes precision-matched `f32` and
    `f64` upload/export entrypoints, so calibrated `single` execution no longer
    has to round-trip runtime magnetization and field buffers through host `f64`
    unless a higher-level caller explicitly requests `f64` artifacts.

This means the capability matrix must distinguish:

- semantic legality,
- current executable backend support,
- calibration status.

## 5. Validation strategy

### 5.1 Analytical checks

- Uniform magnetization must still give zero exchange field and zero LLG RHS in both precisions.
- The GPU exchange stencil must match the CPU reference stencil on small toy problems.
- Precision mode must not change the sign convention of precession or damping terms.

### 5.2 Cross-backend checks

Calibration must be layered.

#### Tier A: CPU `double` vs GPU `double`

Purpose:

- verify that the CUDA port preserves the reference discrete model.

Default acceptance targets for exchange-only benchmarks:

- relative `E_ex` error: `<= 1e-9`,
- magnetization L2 difference: `<= 1e-9`,
- max per-cell norm drift: `<= 1e-12`.

These are not bitwise requirements.
They are reference-equivalence tolerances allowing for different floating-point reduction order.

#### Tier B: GPU `double` vs GPU `single`

Purpose:

- qualify `single` as a production mode rather than an unchecked speed path.

Default acceptance targets:

- relative `E_ex` error: `<= 1e-4`,
- magnetization L2 difference: `<= 1e-4`,
- max per-cell norm drift: `<= 1e-6`.

These values are intentionally looser than Tier A because they validate an intentionally lower
precision mode, not an equivalent `fp64` implementation.

### 5.3 Regression tests

- unit tests for IR/planner precision propagation,
- runner rejection test for unsupported CPU `single`,
- native CUDA tests for `fp64` exchange field parity,
- native CUDA tests for `fp64` Heun parity,
- native CUDA tests for `fp32` stability and drift,
- end-to-end smoke tests that record `execution_precision` in metadata and artifacts.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend source tree and ABI
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables contract
- [x] Native CUDA tests / benchmarks scaffold
- [x] Documentation

## 7. Known limits and deferred work

- The current CPU reference runner remains `double` only.
- The native CUDA backend now exists, but the product-facing GPU qualification is not complete.
- The Rust runner now has a CUDA dispatch path, but calibration and public qualification remain in progress.
- Public `mixed` precision is intentionally deferred.
- Precision-specific performance claims must not be made before Nsight-backed profiling exists.
- Precision policy for FEM and hybrid backends is deferred until those backends exist.
- The current detailed execution handoff for Phase 2 implementation lives in:
  - `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`

## 8. References

1. `docs/physics/0200-llg-exchange-reference-engine.md`
2. `docs/specs/exchange-only-full-solver-architecture-v1.md`
3. `docs/specs/problem-ir-v0.md`
