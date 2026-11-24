# FEM GPU. Factor-once direct solve of the Poisson demag system (cuDSS, proof of concept)

Status `proof of concept / experimental opt-in / unqualified`. Branch `codex/poc-fem-gpu-cudss-direct-20261124`. The
realization is off unless the runtime environment requests it; without the request every run follows the existing
CG/AMG path unchanged.

(problem-statement)=
## Scope

This note covers one numerical realization of the strict FEM GPU Poisson demag owner `device_hypre_poisson`: the
linear system is solved by a sparse Cholesky factorization computed once per operator, instead of preconditioned
conjugate gradients at every evaluation. The demag model, its boundary conditions and the P1 discretization belong
to the [canonical Poisson description](fem_demag_poisson.md); the public solver policy belongs to
[note 0532](0532-fem-demag-solver-policy-and-runtime-threading.md). The motivation is measured in
`docs/audits/2026-11-24-fem-gpu-cudss-direct-poc.md`: at 49 176 nodes, 98.5 % of a Heun step is the hypre PCG
call, which is paced by host-side launches and synchronizations while the GPU stays under 1 % busy.

| Realization | Scope of this note | Evidence |
|---|---|---|
| FEM CPU | Not changed; MFEM/hypre CG with the existing preconditioners | Source unchanged |
| FEM GPU | Opt-in cuDSS factor-once solve in `device_hypre_poisson` | Runtime A/B measurements in the validation section |
| FDM CPU | Not applicable | FDM computes demag by FFT convolution, not by this Poisson system |
| FDM GPU | Not applicable | FDM computes demag by FFT convolution, not by this Poisson system |

(governing-equations)=
## Equations

The Poisson demag owner solves one linear system per field evaluation:

```{math}
:label: eq-direct-system
K\phi = b
```

The matrix does not change during a run: it depends on the mesh and the boundary conditions only, while the right-hand
side follows the magnetization. The realization factors a symmetric permutation of the matrix once and then applies
two triangular solves per evaluation:

```{math}
:label: eq-direct-factorization
P K P^{\mathsf T} = L L^{\mathsf T},\qquad
L y = P b,\qquad
L^{\mathsf T}\left(P\tilde{\phi}\right) = y
```

Every computed solution is certified with the existing independent residual check, the same one that certifies CG
results today:

```{math}
:label: eq-direct-residual
r = b - K\tilde{\phi},\qquad
\rho = \frac{\lVert r\rVert_2}{\lVert b\rVert_2} \le \tau_{\mathrm{rel}}
```

(symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
|---|---|---|
| $K$ | Poisson system matrix: P1 stiffness plus Robin boundary mass, after essential-condition elimination | $\mathrm{m}$ |
| $\phi$ | Exact vector of nodal scalar-potential coefficients | $\mathrm{A}$ |
| $\tilde{\phi}$ | Computed vector of nodal scalar-potential coefficients | $\mathrm{A}$ |
| $b$ | Right-hand side vector built from the magnetization | $\mathrm{A\,m}$ |
| $P$ | Fill-reducing symmetric permutation chosen in the analysis phase | $1$ |
| $L$ | Lower-triangular Cholesky factor of the permuted matrix | $\mathrm{m^{1/2}}$ |
| $y$ | Intermediate vector of the forward substitution | $\mathrm{A\,m^{1/2}}$ |
| $r$ | Algebraic residual of the computed solution | $\mathrm{A\,m}$ |
| $\rho$ | Relative Euclidean residual | $1$ |
| $\tau_{\mathrm{rel}}$ | Relative residual tolerance from the solver policy | $1$ |

(assumptions-and-validity)=
## Assumptions and validity

- The matrix $K$ must be symmetric positive definite. That holds for the Robin and Dirichlet realizations, where the
  boundary term or the eliminated rows remove the constant null space. A pure Neumann matrix is singular; its
  factorization reports a nonzero `CUDSS_DATA_INFO` and the run stops with an error instead of producing a field.
- Real double precision only, one GPU, one process. The periodic reduced operator and the FEM/BEM realization are
  outside this proof of concept and are rejected at setup.
- The factor memory grows faster than the mesh; the measured sizes are in the validation section. There is no
  automatic fallback to CG when the factor does not fit; the setup fails with the CUDA or cuDSS error.
- Cholesky with any symmetric permutation is backward stable for symmetric positive definite matrices, so the
  computed $\tilde{\phi}$ is the exact solution of a nearby system; the residual check of
  {eq}`eq-direct-residual` measures that directly for every solve.

(python-api)=
## Python API

The public API does not change. The study below is the executed measurement case
(`scripts/benchmarks/fem_memory_transfer_case.py` at `FEM_CASE_HMAX=2.5e-9`); it requests CG/AMG as before. The
experimental realization is selected only by the environment of the process that runs the study:
`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss`. That variable is a runtime override for this proof of concept, not a
public parameter, and it is not part of `ProblemIR`.

```python
# %% Study, engine, device and mode
import fullmag as fm

study = fm.study("fem_gpu_poisson_direct_poc")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="auto", size=(600e-9, 600e-9, 120e-9), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=40e-9)
study.interactive(False)

# %% Geometry, material and mesh
body = study.geometry(fm.Box(size=(200e-9, 200e-9, 20e-9)), name="magnet")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.random(seed=7)
body.mesh(maximum_element_size=2.5e-9, order=1)

# %% Interactions and the public demag solver policy (requested intent)
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG")
study.b_ext(0.0, 0.0, 10e-3)
study.build_domain_mesh()

# %% Dynamics
study.solver(fix_dt=2e-14, integrator="heun")
study.run(20 * 2e-14)
```

The policy parameters below keep their meaning. With the override active they still form the requested intent, and
$\tau_{\mathrm{rel}}$ and `max_iterations` still bound the certified result.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| FemLinearSolverPolicy.solver | str | CG | 1 | CG or GMRES | Outer iterative method of the requested intent | FEM CPU/GPU | fem.demag_solver_policy.solver |
| FemLinearSolverPolicy.preconditioner | str | AMG | 1 | AMG, JACOBI or NONE | Preconditioner of the requested intent; unused under the cuDSS override | FEM CPU/GPU | fem.demag_solver_policy.preconditioner |
| FemLinearSolverPolicy.rtol | float | 1e-8 | 1 | positive finite value | Relative residual tolerance that certifies every solve | FEM CPU/GPU | fem.demag_solver_policy.rtol |
| FemLinearSolverPolicy.atol | float \| None | None | $\mathrm{A\,m}$ | None or positive finite value | Optional absolute residual tolerance | FEM CPU/GPU | fem.demag_solver_policy.atol |
| FemLinearSolverPolicy.max_iterations | int | 500 | 1 | at least 1 | Iteration limit; the direct solve reports one iteration | FEM CPU/GPU | fem.demag_solver_policy.max_iterations |
| FemLinearSolverPolicy.print_level | int | 0 | 1 | non-negative | Linear-solver diagnostics level | FEM CPU/GPU | fem.demag_solver_policy.print_level |

(problem-ir)=
## ProblemIR

The canonical fragment comes from `fm.FemLinearSolverPolicy(solver="CG", preconditioner="AMG").to_ir()` and lands in
`FemHintsIR.demag_solver_policy`, then in the resolved `FemPlanIR.demag_solver_policy`:

```json
{"solver": "CG", "preconditioner": "AMG", "rtol": 1e-08, "max_iterations": 500, "print_level": 0}
```

The override adds nothing to `ProblemIR` and nothing to the plan. Two runs of the same script with and without the
variable have identical `ProblemIR` and plan; they differ only in the native realization.

(round-trip-and-failure-semantics)=
## Round trip and failure semantics

- **Requested intent** is the public policy above, exported and re-imported unchanged by the script round trip.
- **Resolved execution** is the native realization. With the override, setup prints one receipt line to standard
  error (`fullmag: FEM GPU Poisson demag uses the cuDSS direct solve ...` with rows, factor nonzeros, device bytes and
  phase times), every solve reports one iteration, and the AMG coarse-relax getter reports no AMG. This proof of
  concept does not yet add a dedicated provenance field; that is listed under limitations.
- **Validation errors**: a factorization with `CUDSS_DATA_INFO` different from zero (matrix not positive definite), a
  cuDSS or CUDA status other than success, a non-square or empty matrix, a missing diagonal entry, or a residual that
  fails {eq}`eq-direct-residual` stop the run with a message naming the step.
- **Unsupported combinations**: the override with the periodic reduced operator, with FEM/BEM, with FEM CPU or with
  FDM is rejected or not applicable; a build without cuDSS rejects the override at setup.

(discrete-realization)=
## Discrete realization and residency

1. Setup reads the boundary-conditioned host matrix (`poisson_bc_op`), keeps the lower triangle, sorts each row by
   column and uploads it once as 32-bit CSR.
2. cuDSS analysis chooses $P$ and the symbolic structure of $L$; the factorization computes $L$ in device memory. Both
   run once per operator. The factor device bytes are added to the Poisson workspace accounting.
3. Each evaluation runs only the solve phase on the hypre stream, inside the same event fences that order the CG
   solve today. The right-hand side and the solution are the existing device buffers; nothing is copied to the host.
4. The existing independent residual check (RHS norm, matvec, AXPY, residual norm) then certifies the result against
   $\tau_{\mathrm{rel}}$.

The hypre PCG and AMG objects are not created under the override, which also removes the AMG hierarchy from device
memory.

(implementation-mapping)=
## Implementation mapping

- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::demag_gpu_direct_solver_requested` reads the override.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::create_demag_cudss_direct_solver` builds the sorted
  lower CSR, runs analysis and factorization, checks the factorization status and measures device bytes.
- `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp::solve_demag_cudss_direct` runs the solve phase on a
  given stream with the device right-hand side and solution.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::initialize_demag_poisson_hypre_device_solver` selects
  the realization at setup.
- `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp::compute_device_demag_for_device_stage_impl` applies it.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::validate_demag_poisson_hypre_device_solve` certifies
  the residual.

(validation)=
## Validation

**Plan.** The same build runs both realizations, selected only by the environment variable.

1. Default path unchanged: the baseline `m_final` of the new build must be bit-identical to the baseline runs of the
   previous build at the same mesh.
2. For every solve, the certified relative residual of the direct solve must satisfy {eq}`eq-direct-residual`.
3. Trajectory agreement: the difference of `m_final` between the two realizations must stay at the scale of the CG
   tolerance (at most $10^{-8}$ in any component after the measured steps).
4. Timing: mean step time over steps 2 to N−1 at 14 911, 49 176 and 89 732 nodes, with interleaved runs.
5. Memory: device peak and host peak with both realizations.

**Results.** Recorded in `docs/audits/2026-11-24-fem-gpu-cudss-direct-poc.md` after the runs.

(limitations)=
## Limitations

- Proof of concept: no managed qualification, no standard-problem comparison, no Windows or multi-GPU evidence.
- The resolved realization is visible in the receipt line and the iteration count, not in a dedicated provenance
  field; a production version must record it next to the requested policy.
- No size-based selection and no VRAM preflight for the factor; very large meshes still need CG/AMG.
- The periodic reduced operator and FEM/BEM are excluded.

(scientific-bibliography)=
## Bibliography

- A. George, "Nested dissection of a regular finite element mesh", SIAM J. Numer. Anal. 10 (1973) 345–363,
  [doi:10.1137/0710032](https://doi.org/10.1137/0710032).
- T. A. Davis, *Direct Methods for Sparse Linear Systems*, SIAM (2006),
  [doi:10.1137/1.9780898718881](https://doi.org/10.1137/1.9780898718881).
- N. J. Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed., SIAM (2002), chapter 10 (Cholesky
  factorization), [doi:10.1137/1.9780898718027](https://doi.org/10.1137/1.9780898718027).
- [NVIDIA cuDSS documentation](https://docs.nvidia.com/cuda/cudss/), version 0.8.0.10 as installed in the `fem-gpu`
  image (`docker/fem-gpu/Dockerfile`).
- Note 0532 and the canonical Poisson description own the public policy and the shared physics; note 0913 documents
  the CG/AMG coarse-level residency that this realization replaces under the override.

(source-code-index)=
## Source-code index

| Path | Symbol | Responsibility | Lane and evidence |
|---|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `demag_gpu_direct_solver_requested` | Reads the opt-in override | FEM GPU; proof of concept |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `create_demag_cudss_direct_solver` | Lower CSR, analysis, factorization, status and memory | FEM GPU; proof of concept |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `solve_demag_cudss_direct` | Solve phase on the hypre stream | FEM GPU; proof of concept |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | Realization selection at setup | FEM GPU; existing owner |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `compute_device_demag_for_device_stage_impl` | Applies the solve between the stream fences | FEM GPU; existing owner |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `validate_demag_poisson_hypre_device_solve` | Independent residual certification | FEM GPU; existing check |
| `backends/fem/gpu/cuda/demag_poisson/operators.cpp` | `build_p1_demag_operators` | Builds the Poisson operators | FEM GPU; existing owner |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Public policy, defaults and validation | FEM CPU/GPU; unchanged |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FemHintsIR` | Optional FEM policy in canonical ProblemIR | FEM; unchanged |
| `crates/fullmag-ir/src/plan.rs` | `FemPlanIR` | Resolved policy passed to native execution | FEM; unchanged |
