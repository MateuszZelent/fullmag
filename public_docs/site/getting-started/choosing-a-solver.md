---
title: Choosing a Solver
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-choosing-a-solver)=
# Choosing a Solver

FullMag exposes one canonical physical model (`ProblemIR`) across four primary execution lanes:
**FDM CPU**, **FDM GPU (CUDA)**, **FEM CPU**, and **FEM GPU (CUDA)**. You request the numerical
engine with `study.engine("fdm")` or `study.engine("fem")` and the device/precision with
`study.device("cpu" | "gpu", precision="double" | "single")`. Physical parameters retain identical
SI meanings across engines, while discretization, demagnetization closures, linear solvers, and
stage support are validated strictly for the resolved lane.

## Quick selection guide

| Workload / requirement | Recommended engine & lane | Key technical reason | Deep reference |
|---|---|---|---|
| Rectangular films, nanowires, racetracks, disks, or disconnected multilayers | **FDM** (CPU or CUDA GPU) | Native Cartesian `cell_size` resolution with open-boundary Newell FFT demagnetization; single-layer CUDA uses batched `D2Z`/`Z2D` (FP64) & `R2C`/`C2R` (FP32) half-spectrum cuFFT and device-resident `native_cuda_pgbb` relaxation | {ref}`numerical-methods-performance-fdm-core` |
| Coupled 3D charge/spin drift-diffusion (`M1`/`M2` SHE, prescribed STT/SOT) on regular grids | **FDM GPU** (bounded) or **FDM CPU** | CUDA M1 uses 6–7 level cooperative AMG-PCG or opt-in `cuDSS` Cholesky for charge, binary-search lookup & multi-block CUB closure for spin, and fused FP64 RK45 prescribed spin torques | {ref}`numerical-methods-performance-fdm-transport` |
| Curved, oblique, multi-region, or CAD-imported 3D geometries | **FEM** (CPU or CUDA GPU) | Boundary-conforming tetrahedral or swept-prism meshes with MFEM/hypre operators and Poisson airbox or Fredkin–Koehler FEM/BEM demagnetization | {doc}`../numerical-methods/demag-solvers/fem-poisson-airbox` |
| High-aspect-ratio thin films on FEM without staircase geometry | **FEM GPU** (`pure_prism_p2` + `cuDSS`) | `transition="pure_prism"` yields 100% `prism6` meshes with automatic P2 demag potential at 5.76× fewer DOFs than tetrahedral P2 and VRAM-guarded factor-once `cuDSS` Cholesky | {ref}`numerical-methods-performance-fem-gpu-demag` |
| Stiff exchange-dominated FEM relaxation | **FEM GPU** (`projected_gradient_bb`) | Cooperative CUDA PCG `bb_exchange_mass` preconditioning (default under `policy="auto"` when exchange is active) matches CPU step counts while cutting wall time 2.8×–6.1× vs unpreconditioned GPU PG-BB | {ref}`numerical-methods-performance-fem-gpu-kernels` |
| Linearized-LLG eigenmodes, spin-wave dispersion $\omega(k)$, or driven FMR frequency response | **FEM** (CPU PETSc/SLEPc/MUMPS or GPU `cuDSS`) | Exact augmented `(q, phi)` MUMPS/FGMRES shift-invert on CPU, qualified open-airbox FEM GPU `cuDSS` eigensolve (plus bounded single-$k$ GPU Floquet), and factor-once 2×2 pre-scaled GPU `cuDSS` driven response (`method="gpu_sparse_direct"`) | {ref}`numerical-methods-performance-fem-spectral-multiphysics` |
| Full-wave RF antenna excitation with resistive gap ports | **CPU FIT reference** / **FEM multiphysics** | Frequency-domain FIT cotree-tree gauge sparse reference (CPU FP64) and Wave 2 sparse FEM Oersted/charge/spin solvers (MUMPS, HYPRE AMS/AMG, opt-in `cuDSS`) | {ref}`numerical-methods-performance-fem-spectral-multiphysics` |

## Finite difference (FDM)

FDM represents magnetic bodies on cell-centred Cartesian grids and computes demagnetization through
cell-averaged Newell tensors with zero-padded FFT convolution.

Choose FDM when:

- the geometry fits a regular grid (cuboids, thin films, periodic arrays, multilayer stacks),
- you want open-boundary magnetostatics without constructing an exterior airbox mesh,
- you run long time-domain dynamics or direct relaxation on large regular grids where GPU
  half-spectrum `D2Z`/`Z2D` (FP64) or `R2C`/`C2R` (FP32) cuFFT and device-resident PG-BB
  (`native_cuda_pgbb`) deliver strong throughput and 12%–23% lower VRAM than complex-to-complex FFTs,
- you use explicit finite-image periodic boundaries or multilayer convolution.

Canonical FDM pages: {doc}`../numerical-methods/demag-solvers/fdm-convolution`,
{doc}`../python-api/discretization/fdm`, {ref}`numerical-methods-performance-fdm-core`, and
{ref}`numerical-methods-performance-fdm-transport`.

## Finite element (FEM)

FEM discretizes the magnetic bodies and optional exterior airbox with conforming tetrahedral,
swept-prism (`pure_prism_p2`), or mixed elements, solving magnetostatics via scalar-potential
Poisson airbox (open Robin or 1D/2D periodic) or open-boundary Fredkin–Koehler FEM/BEM.

Choose FEM when:

- curved boundaries, oblique interfaces, or STL/CAD imports would suffer staircase errors on a
  Cartesian grid,
- you need conforming multi-region meshes or locally graded resolution around vortex/skyrmion cores
  and narrow gaps,
- you run linearized-LLG eigenmodes, Brillouin-zone dispersion sweeps, or harmonic driven frequency
  response (the public modal and driven-response contracts are FEM),
- you want GPU-accelerated direct sparse solves (`FemLinearSolverPolicy.gpu_strategy="auto"` using
  VRAM-guarded `cuDSS` for open Poisson, 1D/2D PBC Poisson, and atomic `(u1, u2)` FEM/BEM pairs,
  with explicit fail-closed fallback to `CG`/`AMG` + FSAL `k0` reuse + linear potential predictor).

Canonical FEM pages: {doc}`../numerical-methods/demag-solvers/fem-poisson-airbox`,
{doc}`../numerical-methods/demag-solvers/fem-bem`, {doc}`../python-api/discretization/fem`,
{ref}`numerical-methods-performance-fem-gpu-demag`,
{ref}`numerical-methods-performance-fem-gpu-kernels`, and
{ref}`numerical-methods-performance-fem-spectral-multiphysics`.

## CPU versus GPU and VRAM preflight

Both FDM and FEM expose CPU and CUDA GPU execution lanes inside the Docker Compose DEV runtime
(`just docker-dev` / `just docker-dev-toolchain` with NVIDIA GPU access). Device selection is
always recorded as **requested intent** separately from **resolved execution** in provenance:

- **CPU lanes**: Portable, deterministic reference lanes (`Rayon`-parallel persistent SoA on FDM
  CPU; MFEM/HYPRE/PETSc/SLEPc/MUMPS on FEM CPU). Note that the main FEM CPU magnetic solver runs
  on `MPI_COMM_SELF` (`legacy_sparse`), while Wave 2 FEM multiphysics (`OE-F1`, `OE-F2`, charge,
  `M1`/`M2`) uses 3-tier sparse/parallel solvers.
- **GPU lanes**: Single-device CUDA execution (`gpu_count > 1` is currently rejected). Before
  allocating large buffers or direct factors, FullMag performs fail-closed device-memory preflight:
  - **FDM GPU**: Exact cuFFT workspace preflight (`cufftMakePlanMany` work-area query against
    live `cudaMemGetInfo`, failing cleanly with `fdm_gpu_workspace_oom_preflight` and zero leaks).
  - **FEM GPU**: `cuDSS` factor memory estimation against the device budget (`auto` falls back
    transparently to `CG`/`AMG` with `linear_solver_fallback_reason`; explicit `gpu_strategy="cudss"`
    fails closed rather than substituting Krylov).
- **Auto crossover policy**: Availability-first selection is used rather than an unqualified
  mesh-size crossover heuristic; always pin `"cpu"` or `"gpu"` explicitly in `strict` benchmarks.

## Support and qualification matrix

Each terminal physics, numerical-method, and performance page publishes its own four-lane matrix
(`FDM CPU`, `FDM GPU`, `FEM CPU`, `FEM GPU`) with explicit unsupported, bounded, or unqualified
states and evidence citations. Consult:

- {doc}`../validation/qualification-status` for the platform-wide qualification ledger,
- {ref}`numerical-methods-performance` for the master hardware-acceleration speedup & parity matrix
  (including documented `NO-GO` and deferred optimizations),
- {doc}`../physics/interactions/demagnetization/index`,
  {doc}`../numerical-methods/demag-solvers/fdm-convolution`, and
  {doc}`../numerical-methods/demag-solvers/fem-poisson-airbox` for lane-level contracts.

Do not infer a solver is production-qualified from its name or source presence. Requested intent
and resolved execution remain separate, and `strict` mode rejects unsupported combinations instead
of silently substituting another backend, device, precision, or solver.

