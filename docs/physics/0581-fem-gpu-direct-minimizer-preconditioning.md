# FEM GPU Direct-Minimizer Exchange-Mass Preconditioning

- Status: approved phase-1 remediation design; implementation and qualification
  remain `NOT VERIFIED`
- Owners: Fullmag FEM backend
- Last updated: 2026-09-04
- Related physics notes:
  - `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
  - `docs/physics/0560-all-in-gpu-fem-runtime.md`
  - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- Related design:
  - `docs/superpowers/specs/2026-09-04-fem-gpu-direct-minimizers-phase1-design.md`

(fem-gpu-preconditioner-problem-statement)=
## 1. Problem statement

FEM GPU nonlinear conjugate gradient (NCG) and projected-gradient
Barzilai--Borwein (PG-BB) use raw tangent gradients in the current production
default. On refined or exchange-dominated meshes, a qualified approximation to
the exchange-plus-mass inverse could reduce accepted steps, Armijo trials, and
demagnetizing solves without changing the physical energy or stopping rule.

### Current source status (2026-09-04)

The class currently named `GpuExchangeMassPreconditioner` is a
diagonal/Jacobi approximation. Its setup receives only mass and exchange
diagonals and uploads the pointwise factor $M_i/(M_i+wK_{ii})$, where the
physical direct-minimizer contract requires
$w=\lambda(2/\mu_0)$ for $K_A$ stored in joules; it
does not apply the off-diagonal entries of the sparse exchange matrix. Its `setup()` is
called by the focused contract test, not by the production NCG or PG-BB setup.
The two production call sites conditionally invoke the pointwise apply only
when the object is active and currently ignore the returned status.

The benchmark makes this boundary explicit: `exchange_mass` maps to `None` and
is rejected as having no C++ runtime realization. Therefore the current source
does not implement the full operator $(M+wK)^{-1}M$, does not provide a
fail-closed active runtime path, and does not prove fewer NCG or PG-BB steps.

### Historical no-go (2026-07-26)

The preserved historical campaign requested 75 GPU rows and promoted no
strategy. Its strengthened validator classified the matrix as `invalid`, not a
qualifying `no_go`: the fine `none` baseline did not reach tolerance, separate
CPU/GPU parity was absent, cumulative work fields and immutable workload
identity were incomplete, and `stagnation_triggered_cg8` executed zero
preconditioner iterations. This remains a production no-go for that campaign;
it is not evidence against every future implementation.

The immutable historical record remains in
`docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv`,
`docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json`,
and `.superpowers/sdd/task-11-report.md`.

### Phase 1 remediation (approved, not qualified)

The approved phase-1 design replaces the misleading diagonal realization with
two explicit families: `diagonal` for the pointwise approximation and
`exchange_mass_cg4|cg8` for a future fixed-iteration solve using the complete
device CSR. At this documentation checkpoint that full sparse implementation,
its algorithm integration, receipt, parity, and benchmark campaign do not yet
exist. Approval of the design is not runtime evidence.

Evidence status for the new phase-1 candidate is intentionally fail-closed:

- Capability: `NOT VERIFIED`
- Runtime: `NOT VERIFIED`
- CPU/GPU parity: `NOT VERIFIED`
- Physics validation: `NOT VERIFIED`
- Performance: `NOT VERIFIED`

The production default remains `none`. No public selector, automatic promotion,
or Python/ProblemIR field is introduced by this note.

(fem-gpu-preconditioner-governing-equations)=
## 2. Governing equations

Let $\mathbf{g}$ be the raw tangent energy gradient. On the active magnetic
subspace, define the intended full operator

```{math}
:label: fem-gpu-preconditioner-operator
\mathbf{P}_{\lambda}
=\operatorname{diag}(M_s M_{\mathrm{lumped}})
+\lambda\frac{2}{\mu_0}\mathbf{K}_A.
```

The intended preconditioned direction is

```{math}
:label: fem-gpu-preconditioner-direction
\mathbf{z}
=\Pi_T(\mathbf{m})\mathbf{P}_{\lambda}^{-1}
\operatorname{diag}(M_sM_{\mathrm{lumped}})\mathbf{g}.
```

The nodal tangent projector is

```{math}
:label: fem-gpu-preconditioner-tangent-projector
\Pi_T(\mathbf{m})\mathbf{v}
=\mathbf{v}
-\mathbf{m}\frac{\mathbf{m}\cdot\mathbf{v}}
{\mathbf{m}\cdot\mathbf{m}}.
```

The current CUDA source implements only the diagonal/Jacobi approximation

```{math}
:label: fem-gpu-preconditioner-diagonal-approximation
z_i
=\left[\frac{M_i}{M_i+\lambda\frac{2}{\mu_0}K_{ii}}\right]g_i,
\qquad
M_i=M_{s,i}M_{\mathrm{lumped},i},
```

before the already-required tangent projection. This equation is not the full
sparse solve whenever $\mathbf{K}_A$ has nonzero off-diagonal entries.

(fem-gpu-preconditioner-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mathbf{g}$ | raw tangent energy gradient | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{z}$ | preconditioned tangent direction input | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{v}$ | vector projected onto the nodal tangent plane | $\mathrm{A\,m^{-1}}$ |
| $\Pi_T$ | nodal tangent projector | $1$ |
| $\mathbf{P}_{\lambda}$ | exchange-plus-mass preconditioner operator | $\mathrm{A\,m^2}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_{\mathrm{lumped}}$ | lumped nodal volume | $\mathrm{m^3}$ |
| $M_i$ | active nodal mass $M_{s,i}M_{\mathrm{lumped},i}$ | $\mathrm{A\,m^2}$ |
| $\mathbf{K}_A$ | heterogeneous exchange stiffness matrix | $\mathrm{J}$ |
| $K_{ii}$ | diagonal entry of $\mathbf{K}_A$ | $\mathrm{J}$ |
| $\lambda$ | direct-minimizer step/preconditioner weight | $\mathrm{m\,A^{-1}}$ |
| $w=\lambda(2/\mu_0)$ | exchange-Hessian scale passed to the diagonal builder | $\mathrm{A\,m\,N^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $i$ | active nodal index | $1$ |

Both terms in $\mathbf{P}_{\lambda}$ have unit $\mathrm{A\,m^2}$, while
$\operatorname{diag}(M_sM_{\mathrm{lumped}})\mathbf{g}$ has unit
$\mathrm{A^2\,m}$; the result $\mathbf{z}$ is therefore in
$\mathrm{A\,m^{-1}}$.

(fem-gpu-preconditioner-assumptions-and-validity)=
## 4. Assumptions, validity, and backend lanes

The intended full operator is SPD only when active nodal masses are finite and
positive, $\lambda$ is finite and nonnegative, and $\mathbf{K}_A$ is symmetric
positive semidefinite under the selected exchange boundary/material policy.
Inactive and fixed nodes have exactly zero right-hand side, work vectors, and
result. Invalid mass, operator, CG scalar, CUDA status, or non-finite result is
a terminal strict-GPU error; diagonal substitution is not a fallback.

| Solver | Device | Source support at this checkpoint | Qualification |
|---|---|---|---|
| FDM | CPU | not applicable; FDM owns a separate relaxation implementation | not applicable |
| FDM | GPU | not applicable; FEM CSR and FEM mass semantics do not transfer to FDM | not applicable |
| FEM | CPU | existing consistent exchange-plus-mass preconditioned direct minimizers | phase-1 CPU/GPU parity `NOT VERIFIED` |
| FEM | GPU | inactive diagonal/Jacobi source candidate; full sparse fixed-CG not implemented | capability/runtime/physics/parity/performance `NOT VERIFIED` |

(fem-gpu-preconditioner-python-api)=
## 5. Python API

Preconditioner strategy is an internal resolved runtime optimization. The
public script continues to author the physical relaxation problem and never
names `diagonal` or `exchange_mass`:

```python
# %%
import fullmag as fm

study = fm.study("fem_gpu_direct_minimizer")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

# %%
film = study.geometry(
    fm.Box(size=(80e-9, 40e-9, 8e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange(enabled=True)

# %%
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolA=1.0e-4,
)
```

No new public constructor or parameter is added. Parameter types, defaults,
units, and validation for this stage-first workflow remain owned by note 0510
and the Python DSL; this note changes none of them.

The internal qualification vocabulary is not a public API:

| Internal token | Type | Default | SI unit | Validation | Meaning | Backend support | Owner |
|---|---|---|---|---|---|---|---|
| `none` | enum token | `none` | $1$ | always legal for the existing direct-minimizer lane | unpreconditioned search direction | FEM GPU NCG/PG-BB | runtime resolver |
| `diagonal` | enum token | not automatic | $1$ | explicit qualified profile only | pointwise $M_i/[M_i+\lambda(2/\mu_0)K_{ii}]$ candidate | FEM GPU NCG/PG-BB, inactive now | runtime resolver |
| `exchange_mass_cg4` | enum token | unavailable | $1$ | full sparse setup and fixed 4-iteration receipt required | bounded full-CSR candidate | FEM GPU NCG/PG-BB, planned | phase-1 design |
| `exchange_mass_cg8` | enum token | unavailable | $1$ | full sparse setup and fixed 8-iteration receipt required | bounded full-CSR candidate | FEM GPU NCG/PG-BB, planned | phase-1 design |

(fem-gpu-preconditioner-problem-ir)=
## 6. ProblemIR and planner boundary

ProblemIR impact is `none`. The script lowers the requested physical
relaxation algorithm, engine, device, precision, geometry, material, exchange,
and stop controls through the existing fields. It does not persist an internal
preconditioner token. The planner may later bind a qualified internal profile,
but requested intent and resolved execution must remain separate from executed
receipt evidence.

(fem-gpu-preconditioner-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

UI-to-Python round-trip preserves requested intent without adding an internal
optimization knob. Resolved execution must report the actual algorithm and
strategy; it cannot be reconstructed from a request or documentation.
Validation errors include stale/unqualified profiles, invalid mass or operator
data, unknown tokens, failed sparse/CUDA apply, and fixed-CG breakdown.
Unsupported combinations fail before the first step. A requested full sparse strategy may
never degrade to the diagonal approximation or CPU execution.

(fem-gpu-preconditioner-discrete-realization)=
## 8. Discrete realization and lifecycle

The approved target reuses the uploaded heterogeneous exchange CSR through
`SparseApplyPlan::apply_xyz`, with independent x/y/z CG recurrences and a
fixed iteration count of four or eight. The complete CSR, including
off-diagonal entries, participates in each apply. RHS, solution, Krylov
vectors, scalar recurrence, and failure latch remain device-resident. Setup may
upload immutable state, while hot apply performs no allocation, H2D, D2H, or
host convergence test.

Raw $\mathbf{g}$ and preconditioned $\mathbf{z}$ are separate buffers.
$\mathbf{g}$ remains the source of physical stop metrics, descent, and Armijo;
$\mathbf{z}$ is used only to construct directions. PG-BB uses
$\mathbf{d}=-\mathbf{z}$ and checks $\mathbf{d}\cdot\mathbf{g}<0$. NCG uses
preconditioned PR+ with the previous $\mathbf{g}$ and $\mathbf{z}$ and restarts
from $-\mathbf{z}$. These are target contracts, not claims about current GPU
execution.

(fem-gpu-preconditioner-full-sparse-contract)=
The full sparse fixed-CG realization remains a planned contract until later
phase-1 tasks add and verify the corresponding source.

(fem-gpu-preconditioner-implementation-mapping)=
## 9. Implementation mapping

The current pointwise implementation is owned by
`build_gpu_relaxation_diagonal` and the misleadingly named
`GpuExchangeMassPreconditioner` methods. `resolve_gpu_relaxation_preconditioner`
defaults an empty request to `none`. The NCG and PG-BB call sites show the
conditional in-place apply, while the benchmark's runtime-name map keeps the
full strategy unavailable. `SparseApplyPlan::apply_xyz` is an available
building block for the approved target, not evidence that the target is wired.

(fem-gpu-preconditioner-validation)=
## 10. Validation and promotion gate

The first numerical RED must use a small SPD matrix with nonzero off-diagonal
entries and a dense independent oracle. Later gates cover heterogeneous
$M_s$/mass/exchange, $\lambda=0$, zero RHS, inactive/fixed nodes, invalid data,
x/y/z, setup reuse, cache invalidation, status propagation, and strict rollback.

Managed verification must use repository-owned container `just` recipes. For
NCG and PG-BB separately, source/contract evidence, managed runtime evidence,
physics validation, CPU/GPU parity, performance, and Nsight remain distinct.
At this checkpoint the latter five are `NOT VERIFIED`.

An individual algorithm/strategy may be promoted only when, relative to
`none`, it satisfies all of the following for the same immutable workload:

1. at least 10% p50 time-to-tolerance improvement on at least two of three
   mesh sizes;
2. no p50 regression greater than 5% on any size;
3. no p95 regression greater than 5% on any size;
4. complete physics, parity, residency, synchronization, and fail-closed gates.

The campaign uses one warm-up and exactly five measured repeats per algorithm,
strategy, and mesh size, plus a separate Nsight capture with the same identity.
Failure to pass leaves the production default at `none`.

(fem-gpu-preconditioner-limitations)=
## 11. Limitations and deferred work

- Full sparse `exchange_mass_cg4|cg8` is not yet implemented or executable.
- Current diagonal code is inactive in normal NCG/PG-BB setup and its apply
  status is not propagated fail-closed.
- Receipt v2, snapshot v3, direct-minimizer publication identity, managed
  runtime, physics, parity, and performance evidence remain unavailable.
- TPI, L-BFGS, FP32/mixed precision, HYPRE/AMG variants, and public selection
  are outside phase 1.
- The 2026-07-26 evidence remains historical and cannot qualify new source.

(fem-gpu-preconditioner-scientific-bibliography)=
## 12. Scientific bibliography

- J. Nocedal and S. J. Wright, *Numerical Optimization*, second edition,
  Springer, 2006, [doi:10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- R. E. Bank and D. J. Rose, “Parameter selection for Newton-like methods
  applicable to nonlinear partial differential equations”, *SIAM Journal on
  Numerical Analysis* 17(6), 1980,
  [doi:10.1137/0717061](https://doi.org/10.1137/0717061).

(fem-gpu-preconditioner-source-code-index)=
## 13. Source-code index

| Claim | Path | Symbol | Responsibility | Evidence status |
|---|---|---|---|---|
| Current diagonal builder | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `build_gpu_relaxation_diagonal` | constructs $M_i+wK_{ii}$ only, with physical $w=\lambda(2/\mu_0)$ | current source |
| Current diagonal setup | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `GpuExchangeMassPreconditioner::setup` | validates and uploads mass and exchange diagonals with the supplied exchange-Hessian scale | current source; production setup absent |
| Current pointwise device apply | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `GpuExchangeMassPreconditioner::apply_device_component` | applies the uploaded diagonal inverse independently to x/y/z | current source; not a sparse solve |
| Default and qualified-profile resolver | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `resolve_gpu_relaxation_preconditioner` | defaults to `none` and rejects unqualified profiles | current source |
| PG-BB conditional pointwise apply | `backends/fem/gpu/cuda/relaxation/pgbb.cpp` | `gpu_relax_compute_current_metrics` | shows inactive/in-place current integration boundary | current source, not qualification |
| NCG conditional pointwise apply | `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` | `gpu_relax_compute_effective_field_energy_gradient_and_direction` | shows inactive/in-place current integration boundary | current source, not qualification |
| CPU exchange-mass oracle | `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` | `exchange_mass_preconditioned_gradient` | owns the existing CPU solve semantics | current source |
| Device sparse x/y/z building block | `backends/fem/gpu/cuda/sparse/sparse_apply_plan.cpp` | `SparseApplyPlan::apply_xyz` | applies an existing CSR to three device components | available primitive, not wired proof |
| Benchmark availability map | `scripts/analysis/fem_gpu_benchmark.py` | `RELAXATION_PRECONDITIONER_RUNTIME_NAMES` | keeps `exchange_mass` unavailable | current source |
| SI exchange-Hessian scale | `backends/fem/src/relaxation_operator_units.hpp` | `exchange_hessian_scale_from_step_m_per_a` | preserves $\lambda(2/\mu_0)$ when $K_A$ is represented in joules | current source |
| SI operator-unit contract | `backends/fem/tests/relaxation_operator_contract.cpp` | `void exchange_hessian_uses_si_field_scale` | checks the exchange scale and a manufactured two-node operator action | source test |
| Diagonal-only manufactured fixture | `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp` | `struct ManufacturedSpdMatrix` | diagonal-only fixture; does not distinguish pointwise apply from a full sparse solve | source test fixture; off-diagonal RED belongs to Task 2 |
| Focused GPU preconditioner contract | `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp` | `main` | exercises the current resolver and diagonal setup/apply; no sparse negative control | source test entry point; full sparse solve not proved |
| Full sparse phase-1 contract | `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md` | `DOC-ANCHOR:fem-gpu-preconditioner-full-sparse-contract` | defines target semantics without claiming runtime evidence | planned contract |

### Historical evidence index

| Path | Identity | Responsibility |
|---|---|---|
| `docs/audits/evidence/task-11/task-11-relaxation-preconditioner.csv` | immutable Task 11 campaign rows | records the 75 requested historical GPU rows |
| `docs/audits/evidence/task-11/task-11-relaxation-preconditioner-qualification.json` | immutable Task 11 qualification verdict | records the `invalid` campaign result and missing gates |
