# Permalloy Film FEM Demag Benchmark

- Status: implemented
- Owners: Fullmag FEM/runtime
- Last updated: 2026-05-17
- Related notes:
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`

## 1. Problem statement

Fullmag needs a reproducible FEM benchmark that isolates a realistic thin-film
Poisson demag workload without curved geometry, anisotropy, DMI, transport, or
spin-torque terms. The benchmark problem is a rectangular Permalloy film:

- size: `1000 nm x 500 nm x 10 nm`
- material: `Ms = 800 kA/m`, `A = 13 pJ/m`, `alpha = 0.02`
- external field: `B_ext = (0.1 T, 0, 0)` along the long axis
- object mesh target: about `10 nm`, with one swept layer through thickness
- stage: overdamped LLG relaxation, at most 100 accepted/reported steps

The benchmark measures existing native FEM demag telemetry and does not change
the physical model.

## 2. Physical model

### 2.1 Governing equations

The effective field includes exchange, open-boundary FEM Poisson demag, and
Zeeman terms:

```text
H_eff = H_ex + H_demag + H_ext
H_ex = 2 A / (mu0 Ms) * Laplacian(m)
H_demag = -grad(u)
div(grad(u)) = div(M)
B_ext = mu0 H_ext
```

Relaxation uses the existing public `llg_overdamped` semantics.

### 2.2 Symbols and SI units

- `m`: reduced magnetization `[dimensionless]`
- `M = Ms m`: magnetization `[A/m]`
- `Ms`: saturation magnetization `[A/m]`
- `A`: exchange stiffness `[J/m]`
- `alpha`: Gilbert damping `[dimensionless]`
- `B_ext`: applied flux density `[T]`
- `H_eff`, `H_ex`, `H_demag`, `H_ext`: fields `[A/m]`
- `u`: scalar magnetic potential `[A]`
- `rtol`: linear solver relative tolerance `[dimensionless]`

### 2.3 Assumptions and approximations

- The film is a simple centered box with no anisotropy, DMI, STT, thermal noise,
  defects, holes, or multilayer interfaces.
- The FEM airbox Poisson model uses the existing `poisson_robin` realization.
- The solver policy is a numerical backend hint: CG + AMG, `rtol=1e-6`,
  `print_level=1`.
- The single through-thickness layer is a deliberate performance benchmark
  choice for a 10 nm film, not a convergence claim for all films.

## 3. Numerical interpretation

### 3.1 FDM

No FDM benchmark row is defined by this note. FDM may be added later as a
cross-backend physical reference, but this benchmark targets FEM demag timing.

### 3.2 FEM

The magnetic object uses a swept-prism mesh with one through-thickness layer.
The final solver mesh is the shared FEM domain assembled from the film and a
coarser airbox. Native FEM/MFEM/hypre timing is measured through the existing
opt-in profiler and native log lines:

```text
demag_total
demag_assemble
demag_solver_apply / solve
demag_recover
demag_energy
```

### 3.3 Hybrid

No hybrid semantics are introduced.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The benchmark is authored as a normal Python DSL example:

- `study.engine("fem")`
- `study.device(...)`
- `study.demag(realization="poisson_robin")`
- `fm.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-6, print_level=1)`
- `study.stages.add_relax(algorithm="llg_overdamped", max_steps=100)`

### 4.2 ProblemIR representation

No new IR fields are required. Existing geometry, material, Zeeman, demag,
FEM mesh hints, solver policy, runtime device, and stage semantics cover the
problem.

### 4.3 Planner and capability-matrix impact

No capability changes are required. CPU and GPU rows must preserve requested
execution and report resolved engine/fallback status in the generated report.

## 5. Validation strategy

### 5.1 Analytical checks

This is a performance benchmark, not an analytical validation case. Basic
physical sanity is that the applied field and initial magnetization are aligned
with the long axis and relaxation should not require large reorientation.

### 5.2 Cross-backend checks

The benchmark runner compares native FEM CPU thread counts and the GPU request.
The GPU row must explicitly state whether it resolved to GPU or fell back.

### 5.3 Regression tests

Parser tests cover:

- runtime thread metadata,
- demag call timing extraction,
- duplicated stage-line de-duplication,
- rejected adaptive steps,
- GPU fallback status,
- Markdown report ranking.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [ ] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- The benchmark does not prove mesh convergence.
- GPU timing is only meaningful when the resolved engine is GPU; fallback rows
  remain useful for deployment diagnostics but not GPU speed comparison.
- Future reports may add CSV output and plotted scaling curves.

## 8. References

- Fullmag native FEM demag telemetry notes listed above.
