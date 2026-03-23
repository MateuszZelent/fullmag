# Phase 2 Plan: Calibrated GPU FDM Rollout

- Status: active
- Priority: P0
- Last updated: 2026-03-23
- Parent architecture spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related bootstrap plan: `docs/plans/active/phase-0-1-implementation-plan.md`
- Related physics notes:
  - `docs/physics/0200-llg-exchange-reference-engine.md`
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`

## 1. Why this plan exists

The repository now has a real public CPU execution path for exchange-only FDM.
That was the correct first milestone, but it is no longer the bottleneck.

The bottleneck is now clear:

> Fullmag needs a calibrated, production-oriented CUDA FDM backend with explicit user-selected
> precision and trustworthy equivalence to the CPU reference.

This plan exists to make that migration explicit, sequenced, and testable.

## 2. Non-negotiable rules

1. The CUDA backend must implement the same discrete exchange-only LLG model as the CPU reference.
2. GPU `double` parity is required before GPU `single` can be promoted to public-executable.
3. Precision is a user-visible execution policy, not a hidden backend detail.
4. Python API and `ProblemIR` remain backend-neutral; no CUDA arrays or grid internals leak out.
5. CPU reference stays in the repo and remains the calibration baseline.
6. Artifact semantics and provenance must be identical across CPU and GPU paths.

## 3. Public contract for Phase 2

### 3.1 User-facing runtime contract

The public runtime selector becomes:

```python
fm.Simulation(problem, backend="fdm", mode="strict", precision="double")
fm.Simulation(problem, backend="fdm", mode="strict", precision="single")
```

Semantics:

- `double`
  - public-executable on CPU now,
  - first public-executable precision on GPU.
- `single`
  - canonical in Python API and `ProblemIR` now,
  - promoted to GPU public-executable only after calibration against GPU `double`.

### 3.2 IR and planner contract

- `BackendPolicyIR.execution_precision` is canonical.
- `FdmPlanIR.precision` is the executable backend contract.
- Planner must never invent or silently override precision.
- The current CPU runner must reject `single` honestly.
- The future CUDA runner must accept both `double` and `single`.

### 3.3 Artifact and provenance contract

All runs, CPU and GPU, must record:

- `execution_precision`,
- resolved backend,
- device name,
- compute capability,
- driver version,
- toolkit version,
- backend revision,
- output schedule,
- observable names and units.

## 4. Delivery strategy

This rollout is intentionally staged.
We do not jump directly from CPU reference to "fast single-precision CUDA solver".

### Stage 2A — Precision plumbing and policy freeze

Purpose:

- define precision before CUDA kernels land.

Deliverables:

- `ExecutionPrecision` enum in Python API and Rust IR,
- planner propagation into `FdmPlanIR`,
- CPU reference restricted to `double`,
- physics note for precision and calibration,
- updated architecture/spec docs.

Completion target:

- already in progress during this planning update.

### Stage 2B — Native CUDA backend skeleton

Purpose:

- create the stable native boundary before kernel complexity grows.

Deliverables:

- `native/fdm-cuda/`
- CMake project with pinned toolkit assumptions,
- `include/fullmag_fdm.h`,
- `src/api.cpp`,
- `src/context.cpp`,
- `src/context.cu`,
- `src/error.cpp`,
- standalone smoke binary or tests that load a context and round-trip magnetization.

Required design choice:

- the native implementation is templated internally by scalar type,
- the C ABI stays stable and non-templated.

### Stage 2C — GPU `double` exchange operator

Purpose:

- port the exchange field itself before time stepping.

Deliverables:

- SoA device layout for `m` and `H_ex`,
- GPU kernel for 6-point Laplacian with Neumann boundary handling,
- `fdm_exchange_field()` implementation,
- `fdm_exchange_energy()` implementation,
- parity tests against CPU reference on small deterministic problems.

Acceptance gate:

- CPU `double` vs GPU `double` exchange field parity under Tier A tolerances.

### Stage 2D — GPU `double` Heun stepping

Purpose:

- complete the first production execution loop on CUDA in the safest precision mode.

Deliverables:

- device kernels for LLG RHS,
- predictor and corrector buffers,
- renormalization kernel,
- `fdm_heun_step()` implementation,
- runner dispatch path from Rust into CUDA backend,
- identical artifact production to CPU path.

Acceptance gate:

- `Simulation.run()` on FDM uses CUDA when available and configured,
- CPU `double` vs GPU `double` full-run parity under Tier A tolerances.

### Stage 2E — GPU `single` mode

Purpose:

- add the performance-oriented mode only after the reference CUDA path is correct.

Deliverables:

- `fp32` state buffers and kernels,
- precision-aware context creation,
- scalar reduction policy documented and provenanced,
- GPU `single` vs GPU `double` validation suite.

Acceptance gate:

- Tier B calibration passes,
- output/provenance clearly records `execution_precision="single"`.

### Stage 2F — Calibration and regression harness

Purpose:

- make correctness permanent rather than one-off.

Deliverables:

- reusable benchmark cases,
- CPU/GPU parity runner,
- GPU precision-comparison runner,
- stored baseline tolerances,
- CI commands for non-GPU and GPU lanes.

### Stage 2G — Performance qualification

Purpose:

- confirm that the CUDA path is worth shipping.

Deliverables:

- Nsight Systems trace for a representative run,
- Nsight Compute study for exchange and Heun kernels,
- occupancy and bandwidth report,
- comparison of CPU double, GPU double, and GPU single throughput.

No performance claim is official until this stage exists.

## 5. Native backend architecture

### 5.1 Directory layout

```text
native/
  fdm-cuda/
    include/
      fullmag_fdm.h
    src/
      api.cpp
      context.hpp
      context.cpp
      context.cu
      exchange.cuh
      exchange_fp64.cu
      exchange_fp32.cu
      llg_fp64.cu
      llg_fp32.cu
      reductions_fp64.cu
      reductions_fp32.cu
      error.cpp
    tests/
      smoke_context.cpp
      exchange_parity.cu
      heun_parity.cu
    CMakeLists.txt
```

### 5.2 Device data layout

Required layout for Phase 2:

- `mx`, `my`, `mz`
- `hex`, `hey`, `hez`
- `k1x`, `k1y`, `k1z`
- `tmpx`, `tmpy`, `tmpz`

Rationale:

- SoA is friendlier for coalesced access in stencil kernels,
- it aligns with future extension to additional field terms,
- it avoids repeated pack/unpack cost in hot loops.

### 5.3 Precision strategy

Internal native code should be templated on scalar type:

- `float`
- `double`

Public C ABI should expose an enum:

```c
typedef enum {
    FULLMAG_PRECISION_SINGLE = 1,
    FULLMAG_PRECISION_DOUBLE = 2
} fullmag_precision;
```

`fdm_create()` must therefore accept:

- grid shape,
- cell size,
- material constants,
- `gamma`,
- precision enum.

### 5.4 Stable C ABI

Target shape:

```c
typedef struct FdmContext FdmContext;

FdmContext* fdm_create(
    int nx, int ny, int nz,
    double dx, double dy, double dz,
    double Ms, double A, double alpha, double gamma,
    fullmag_precision precision
);

void fdm_destroy(FdmContext* ctx);

int fdm_set_magnetization(FdmContext* ctx, const double* m, int count);
int fdm_get_magnetization(const FdmContext* ctx, double* m, int count);
int fdm_get_exchange_field(const FdmContext* ctx, double* h, int count);
int fdm_heun_step(FdmContext* ctx, double dt);
double fdm_exchange_energy(const FdmContext* ctx);
```

Notes:

- host-side transfer buffers use `double` in the ABI for stability and simplicity,
- internal conversion to `float` is allowed only when precision mode is `single`,
- ABI error codes must map cleanly to Rust `RunError`.

## 6. Rust runner integration

### 6.1 New module split

`crates/fullmag-runner` should be split before Phase 2 grows further:

- `src/lib.rs`
- `src/cpu_reference.rs`
- `src/gpu_fdm.rs`
- `src/artifacts.rs`
- `src/outputs.rs`

Reason:

- current runner is still under the 1000-line limit,
- Phase 2 would otherwise push it into a monolith.

### 6.2 Dispatch policy

The runner must make dispatch explicit.

Required policy:

1. planner emits a backend plan including precision,
2. runner checks whether CUDA backend is compiled and available,
3. if GPU requested/available and plan is legal, dispatch to CUDA,
4. otherwise:
   - use CPU reference only for `double`,
   - reject `single` honestly.

Metadata must state which path actually ran:

- `cpu_reference_fdm`
- `cuda_fdm`

## 7. Calibration matrix

### 7.1 Benchmark set

At minimum:

1. uniform magnetization on small 3D box,
2. single flipped cell in 1D-like strip,
3. random seeded strip used by `exchange_relax.py`,
4. refinement study on at least two grid resolutions.

### 7.2 Tier A: CPU `double` vs GPU `double`

Acceptance targets:

- `E_ex` relative error `<= 1e-9`,
- magnetization L2 difference `<= 1e-9`,
- per-cell norm drift `<= 1e-12`.

### 7.3 Tier B: GPU `double` vs GPU `single`

Acceptance targets:

- `E_ex` relative error `<= 1e-4`,
- magnetization L2 difference `<= 1e-4`,
- per-cell norm drift `<= 1e-6`.

### 7.4 Artifact parity

CPU and GPU runs must produce the same logical artifact set:

- `metadata.json`
- `scalars.csv`
- `m_initial.json`
- `m_final.json`
- `fields/m/`
- `fields/H_ex/`

Permitted differences:

- device/toolkit/driver provenance,
- small floating-point numerical differences within the calibration tolerances.

## 8. Build, packaging, and deployment policy

### 8.1 Toolkit policy

- pin to one CUDA major line for the release,
- initial recommendation: CUDA 12.x,
- do not target "latest driver only".

### 8.2 Architecture targets

Initial production target set:

- `sm_80`
- `sm_86`
- `sm_89`
- `sm_90`

Add PTX only as a forward-compatibility aid, not as the primary tested path.

### 8.3 Driver support policy

- define and test a minimum supported driver,
- test also on a current/newer driver lane,
- fail clearly at runtime when driver or compute capability is unsupported.

## 9. Explicit non-goals for this plan

- FEM execution
- demag
- DMI
- Zeeman
- anisotropy
- multi-GPU
- MPI
- adaptive timestepping
- public mixed-precision mode

## 10. Acceptance criteria

- [ ] `ExecutionPrecision` is part of Python API, `ProblemIR`, planner output, and provenance
- [ ] CUDA native backend builds as `libfullmag_fdm.so`
- [ ] GPU `double` exchange field matches CPU `double` within Tier A tolerances
- [ ] GPU `double` Heun stepping matches CPU `double` within Tier A tolerances
- [ ] Rust runner dispatches to CUDA FDM when available
- [ ] `Simulation.run()` preserves user precision selection in metadata
- [ ] GPU `single` matches GPU `double` within Tier B tolerances
- [ ] CPU and GPU publish identical logical artifact sets
- [ ] Nsight-backed performance report exists
- [ ] calibration results are documented in `docs/physics/`

## 11. Immediate implementation order

1. Finish precision policy plumbing and docs.
2. Split `fullmag-runner` into CPU/GPU/artifact modules before CUDA code lands.
3. Create `native/fdm-cuda/` skeleton and C ABI.
4. Land GPU `double` exchange field parity.
5. Land GPU `double` Heun stepping.
6. Wire Rust runner dispatch and artifact parity.
7. Land GPU `single`.
8. Add CI/profiling/performance baselines.
