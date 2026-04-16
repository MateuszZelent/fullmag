# FEM demag without transfer-grid: Poisson-only execution contract

- Status: implemented
- Owners: Fullmag FEM/runtime
- Last updated: 2026-04-16
- Related ADRs: `docs/adr/` (execution-selection + canonical IR contract)
- Related specs: `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

The legacy FEM `transfer_grid` demagnetization realization is removed from the
public and executable Fullmag contract.

For FEM demag, Fullmag now supports only Poisson realizations:

- `poisson_robin`
- `poisson_dirichlet`
- `auto` (planner-resolved Poisson variant only)

`transfer_grid` is no longer valid in Python API, `ProblemIR`, planner
resolution, runner execution, native FEM FFI/C++, or capability reporting.

## 2. Physical model

### 2.1 Governing equations

The demagnetizing field is derived from scalar potential `u`:

- `H_demag = -grad(u)`
- `div(grad(u)) = div(M)` in the FEM shared domain

Boundary conditions:

- Dirichlet: fixed potential on the outer air boundary
- Robin: open-boundary approximation on the outer air boundary

### 2.2 Symbols and SI units

- `M` magnetization `[A/m]`
- `H_demag` demagnetizing field `[A/m]`
- `u` scalar potential `[A]`
- `mu0` vacuum permeability `[N/A^2]`

All user-visible units remain SI.

### 2.3 Assumptions and approximations

- FEM demag assumes a conforming shared-domain mesh containing magnetic region
  plus air region.
- `auto` no longer means “switch to transfer-grid without air”; it means
  “planner resolves Poisson variant on shared-domain mesh”.

## 3. Numerical interpretation

### 3.1 FDM

Unchanged. FDM demag remains tensor-FFT Newell in FDM backends only.

### 3.2 FEM

Removed path:

- FEM -> rasterization to Cartesian grid -> FDM tensor FFT -> sampled back to FEM

Active paths:

- FEM Poisson Robin
- FEM Poisson Dirichlet

### 3.3 Hybrid

No hybrid fallback from FEM demag to FDM transfer-grid is allowed.

## 4. API, IR, and planner impact

### 4.1 Python API surface

- `Demag(realization="transfer_grid")` is rejected with a migration error.
- `Demag(realization=None)` and `Demag(realization="auto")` remain valid.
- Legacy aliases for Poisson (`airbox_*`, `poisson_airbox`) still normalize to
  canonical Poisson names.

Migration message:

`FEM transfer_grid został usunięty. Zbuduj shared_domain_mesh_with_air i użyj Poisson Robin/Dirichlet.`

### 4.2 ProblemIR representation

- Removed:
  - `RequestedFemDemagIR::TransferGrid`
  - `ResolvedFemDemagIR::TransferGrid`
  - `FemPlanIR.demag_transfer_cell_size`
  - provenance id `fem_transfer_grid_tensor_fft_newell`

### 4.3 Planner and capability-matrix impact

- FEM + demag requires shared-domain mesh with air.
- Missing shared-domain mesh with air is a planning error.
- `auto` resolves only to `poisson_robin` or `poisson_dirichlet`.
- Capability matrix removes `demag_transfer_grid` and `transfer_grid`.

## 5. Runtime/session/artifact/provenance impact

- Requested demag realization and resolved demag realization stay explicit in
  provenance.
- No FEM runtime path may create or depend on FDM backend state.
- FEM artifacts and runtime labels no longer emit transfer-grid provenance.

## 6. Validation strategy

### 6.1 Analytical checks

- Poisson demag field sanity on canonical uniform states.

### 6.2 Cross-backend checks

- FEM Poisson results remain comparable to validated reference workloads.
- No equivalence target is kept for removed transfer-grid path.

### 6.3 Regression tests

- Planner: `auto -> poisson_robin` on shared-domain mesh.
- Planner: missing air/shared-domain mesh with FEM demag -> explicit `PlanError`.
- API: `transfer_grid` input -> migration error.
- Build/runtime: FEM native path does not require or link FDM artifacts.

## 7. Completeness checklist

- [x] Physics note
- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FEM runtime + native backend
- [x] FFI/build dependency cleanup
- [x] Tests
- [x] Documentation

## 8. Known limits and deferred work

- Poisson quality/performance tuning remains an active optimization track.
- Further open-boundary improvements (beyond current Robin/Dirichlet options)
  are deferred and must not re-introduce hidden FEM->FDM coupling.

## 9. References

- `docs/reports/16.04.2026/transfergrid_removal_plan.mdx`
