# FEM OE-T0 sparse KKT realization

- Status: executable reference realization; production qualification is bounded
- Owners: Fullmag FEM current-transport
- Last updated: 2026-08-05
- Related physics owner: `docs/physics/0980-dynamic-current-and-oersted-coupling.md`
- Related specification: `docs/specs/spin-transport-runtime-contract-v1.md`
- Operator: `fem_conservative_current_rt0_view.v1`

(problem-statement)=
## 1. Problem statement

The FEM Oersted realizations require one conservative signed current field in
the tetrahedral conductor and return path. The OE-T0 reconstruction is a
weighted `RT0/H(div)` projection with element divergence and closure constraints.
The former serial reference assembled both the weighted mass matrix and the
KKT matrix densely and rejected meshes above fixed dimensions. This note
defines the sparse FEM CPU realization that removes that memory wall without
relaxing any physical constraint. It is a numerical realization of the common
physics in `0980`; it does not redefine current sign, closure, units, or energy.

(governing-equations)=
## 2. Governing equations

Let $j_0=-\sigma\nabla V$ be the current reconstructed from the accepted
periodic-potential or coupled-lead solve. The accepted field $j$ minimizes
weighted dissipation subject to discrete charge and closure equations:

```{math}
:label: oet0-kkt
\begin{bmatrix}M & B^{\mathsf T} & C^{\mathsf T}\\
B & 0 & 0\\ C & 0 & 0\end{bmatrix}
\begin{bmatrix}j\\\lambda\\\eta\end{bmatrix}=
\begin{bmatrix}g\\q\\d\end{bmatrix},\qquad
M_{ab}=\int_{\Omega_c}\sigma^{-1}w_a\!\cdot w_b\,\mathrm dV,
\quad g_a=\int_{\Omega_c}\sigma^{-1}w_a\!\cdot j_0\,\mathrm dV.
```

$w_a$ are affine tetrahedral RT0 basis functions. $B$ contains integrated
element divergence, while $C$ contains source-cut and lead-interface flux
pairing rows. Essential insulating traces are eliminated before the solve.
Rank analysis removes only deterministic dependent rows and records their
physical residual in the certificate.

For the sparse lane, $f$ denotes the remaining free RT0 DOFs and $s$ the
active constraint rows. The MFEM operator is the symmetric indefinite block
operator

```{math}
:label: oet0-sparse-block
K_s=\begin{bmatrix}M_f&C_f^{\mathsf T}\\C_f&0\end{bmatrix},\qquad
K_s\begin{bmatrix}x_s\\\eta_s\end{bmatrix}=
\begin{bmatrix}g_f\\d_s\end{bmatrix}.
```

MINRES uses a block diagonal preconditioner with Gauss--Seidel smoothing for
$M_f$ and an identity constraint block. The returned algebraic certificate is
the scaled Euclidean residual

```{math}
:label: oet0-residual
r_s=\frac{\left\|K_s(x_s,\eta_s)^{\mathsf T}-(g_f,d_s)^{\mathsf T}\right\|_2}
{\max\{1,\|(g_f,d_s)\|_\infty\}},\qquad r_s\le 10^{-10}.
```

(symbols-and-si-units)=
### 2.1 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `j_0` | potential-derived unconstrained current density | $\mathrm{A\,m^{-2}}$ |
| `j` | accepted conservative RT0 current density | $\mathrm{A\,m^{-2}}$ |
| `\sigma` | scalar conductivity | $\mathrm{S\,m^{-1}}$, positive |
| `V` | electric potential | $\mathrm{V}$ |
| `w_a` | RT0 basis vector | $1$ in the normalized discrete basis |
| `M` | weighted RT0 mass matrix | $\mathrm{(discrete\;SI)}$ |
| `B` | integrated divergence constraint operator | $\mathrm{m^2}$ per RT0 flux DOF |
| `C` | closure/interface flux constraint operator | $1$ per flux equation |
| `\lambda` | divergence-constraint multiplier | constraint-dual units |
| `\eta` | closure-constraint multiplier | constraint-dual units |
| `g` | weighted current projection vector | $\mathrm{(discrete\;SI)}$ |
| `q` | divergence right-hand side | $\mathrm{A}$ |
| `d` | closure-pair right-hand side | $\mathrm{A}$ |
| `M_f` | free-DOF sparse weighted mass matrix | $\mathrm{(discrete\;SI)}$ |
| `C_f` | free-DOF sparse constraint matrix | $1$ per flux equation |
| `K_s` | sparse symmetric KKT operator | $\mathrm{(discrete\;SI)}$ |
| `x_s` | free RT0 solution vector | $\mathrm{RT0\;DOF}$ |
| `\eta_s` | sparse KKT constraint multiplier vector | $\mathrm{constraint\mbox{-}dual}$ |
| `r_s` | scaled KKT residual | $1$ |
| `n_f` | free RT0 degree-of-freedom count | $1$ |
| `n_s` | active constraint-row count | $1$ |
| `k_{\max}` | bounded MINRES iteration budget | $1$ |

(assumptions-and-validity)=
## 3. Assumptions and validity limits

This realization is restricted to straight, affine, nondegenerate tetrahedra,
binary64 arithmetic, scalar positive conductivity, and a complete authored
closure. It does not model displacement current, skin effect, magnetic
permeability, or a distributed MPI KKT solve. The sparse lane changes storage
from dense $O((n_f+n_s)^2)$ to assembled sparse $O(n_{\mathrm{nz}})$ plus Krylov
work; it does not make an under-resolved mesh physically accurate. A failure to
converge, an integer-index overflow, a rank inconsistency, or a residual above
the gate rejects the view.

(python-api)=
## 4. Python API and authoring boundary

No new user-authored current object or sparse toggle is introduced. The public
source remains a named `CurrentTransport` consumed by `OerstedField`; sparse
selection is a resolved FEM CPU execution detail. The stage-first authoring
boundary is shown below. The final stage registration for conservative FEM
transport is not yet exposed by the public builder, so the object-level
`to_ir()` fragments are the exact supported authoring evidence.

```python
# %% canonical authoring intent
import fullmag as fm

study = fm.study("oet0_sparse_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

drive = fm.CurrentTransport(
    name="drive",
    model="prescribed_density",
    current_density=(4.0e10, 0.0, 0.0),
)
oersted = fm.OerstedField(source="drive", model="from_current_solution")

current_ir = drive.to_ir()
oersted_ir = oersted.to_ir()
assert current_ir["name"] == "drive"
assert oersted_ir["source"] == "drive"
```

The snippet is authoring/lowering evidence, not a claim that the current
public planner can execute arbitrary closed FEM geometry. A planner must reject
an unsupported combination rather than silently selecting the sparse lane.

(problem-ir)=
### 4.1 Python-to-ProblemIR mapping

| Python parameter | Normalized value | ProblemIR destination |
|---|---|---|
| `CurrentTransport.name` | non-empty source ID | `current_transport[].name` |
| `CurrentTransport.model` | `prescribed_density` or validated Ohmic model | `current_transport[].model` |
| `CurrentTransport.current_density` | signed SI vector | `current_transport[].current_density` |
| `OerstedField.source` | named current source | `oersted[].source` |
| `OerstedField.model` | `from_current_solution` | `oersted[].model` |
| resolved FEM lane | `fem` + `cpu` + `double` | `runtime_selection.backend/device/precision` |
| sparse realization | `mfem_sparse_kkt_minres.v1` | `resolved_oersted[].current_view_solver` |

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.name` | `str` | required | $1$ | non-empty | named current source | FEM/FDM authoring | `current_transport[].name` |
| `CurrentTransport.model` | `str` | `prescribed_density` | $1$ | supported current model | charge-source model | FEM/FDM according to planner | `current_transport[].model` |
| `CurrentTransport.current_density` | `vec3` | required for prescribed_density | $\mathrm{A\,m^{-2}}$ | finite signed vector | prescribed conventional current density | authoring; execution remains planner-scoped | `current_transport[].current_density` |
| `OerstedField.source` | `str` | required | $1$ | must name one CurrentTransport | source identity | FEM/FDM authoring | `oersted[].source` |
| `OerstedField.model` | `str` | `from_current_solution` | $1$ | versioned Oersted model | field realization intent | FEM/FDM according to planner | `oersted[].model` |
| `resolved FEM sparse lane` | `enum` | automatic | $1$ | requires FEM CPU double and complete closure | resolved MFEM sparse KKT realization | FEM CPU reference only | `resolved_oersted[].current_view_solver` |

The authored IR carries intent only. The resolved IR additionally carries mesh,
topology, closure, source revision, operator version, residual, iteration count,
and a certificate digest. RT0 face records remain a runtime data-plane artifact.

(round-trip-and-failure-semantics)=
### 4.2 Round-trip and failure semantics

Canonical export preserves the named source, signed current, method, requested
device, precision, and closure. Requested intent is kept separate from resolved
execution: a request for FEM GPU never degrades to FEM CPU. Resolved execution
is published only after the RT0 certificate passes. Validation errors include
missing closure, non-tetrahedral geometry, non-positive conductivity, stale
source identity, dependent inconsistent constraints, integer-size overflow,
MINRES non-convergence, and `r_s>10^{-10}`. Unsupported combinations include
FDM selection for this operator, FEM GPU without a qualified device lane, and
MPI partitioning without a deterministic distributed contract.

(discrete-realization)=
## 5. Numerical realization

### 5.1 FDM

FDM does not consume this FEM RT0/KKT implementation. FDM charge and Oersted
operators remain governed by the cell-integrated convolution contract in
`0980-dynamic-current-and-oersted-coupling.md`.

### 5.2 FEM CPU

For $n_f\le4096$ the deterministic dense binary64 reference remains available
for small regression fixtures. Larger views allocate MFEM `SparseMatrix` objects
for $M_f$ and $C_f`, assemble the same local RT0 quadrature, and solve the same
KKT equations with preconditioned MINRES. No unconstrained projection or dense
fallback is allowed. The `7\times7\times7` Cartesian tetrahedral fixture has
more than 4096 RT0 DOFs and exercises this lane.

### 5.3 FEM GPU and hybrid

FEM GPU OE-T0 and a distributed sparse KKT realization are not qualified by
this note. The planner must keep them unsupported/semantic-only until they have
device-resident operators, a deterministic certificate, and managed runtime
evidence. A hybrid CPU/GPU fallback is forbidden in strict mode.

(implementation-mapping)=
## 6. Implementation mapping

The projection owner is `solve_weighted_rt0_projection`. It selects the sparse
lane from the RT0 global DOF count, assembles MFEM sparse matrices, runs MINRES,
and computes the same independent residual and correction-energy diagnostics as
the dense reference. The runtime test is opt-in because it is intentionally a
larger qualification workload than the fast contract gate.

| Claim | Source path | Symbol |
|---|---|---|
| weighted RT0 projection and lane selection | `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `solve_weighted_rt0_projection` |
| small-mesh dense reference | `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `solve_dense_kkt` |
| large-mesh runtime gate | `backends/fem/tests/conservative_current_view_contract.cpp` | `large_tetrahedral_projection_uses_sparse_kkt_lane` |
| source ownership regression | `backends/fem/tests/source_facade_gpu_rk_contract.cpp` | `fem_oet0_large_mesh_has_sparse_kkt_lane` |
| canonical current-view contract | `backends/fem/cpu/mfem/transport/conservative_current_view.hpp` | `class ConservativeCurrentView` |

(validation)=
## 7. Validation and qualification

The managed fast gate is:

```text
just verify-fem-oersted-oet0-cpu-contract
```

It executes serial, MPI-n1, MPI-n2, and byte-identity tests for the existing
small fixtures. The sparse large-mesh evidence is run in the same managed CPU
image with `FULLMAG_OET0_LARGE_MESH=1`; it completed on 2026-08-04 with the
conservative view contract passing. This proves executable CPU sparse behavior,
not production-scale distributed qualification. Required next gates are three
mesh refinements, a condition-number/iteration report, memory scaling, and an
independent direct Biot--Savart comparison for the resulting Oersted field.

The independent TSan gate is executed by the managed `fem-cpu-tsan` service.
This service inherits the CPU-only image but uses `seccomp:unconfined` solely
for the sanitizer process, because the WSL2 kernel's `vm.mmap_rnd_bits=32`
otherwise prevents GCC TSan from reserving its shadow range. The runner then
starts CTest through `setarch x86_64 -R`, so ASLR is disabled before the
instrumented executable is loaded. The ordinary `fem-cpu` service and all
non-TSan gates retain the default seccomp profile. The managed command
`just verify-fem-oersted-oet0-tsan-cpu-contract` completed with one instrumented
contract passing and no race report on 2026-08-05. This is runtime-sanitizer
evidence, not a distributed-MPI or production-scale claim.

(limitations)=
## 8. Limitations and deferred work

The implementation still lacks a qualified distributed/MPI sparse KKT lane,
GPU OE-T0, airbox/direct-field continuum convergence, and end-to-end Python/UI
execution for arbitrary closed FEM current sources. These are explicit
qualification blockers; the sparse CPU result must not promote FEM GPU or the
full dynamic Oersted capability.

(scientific-bibliography)=
## 9. Scientific bibliography

1. T. Schrefl, `docs/papers/mic_intro.pdf`, magnetostatic current/divergence
   and external-Zeeman conventions.
2. MFEM, [Maxwell discretization notes](https://mfem.org/maxwell-notes/),
   compatible $H(\mathrm{div})$ spaces and sparse operators.
3. R. Hiptmair, [Finite elements in computational electromagnetism](https://doi.org/10.1017/S0962492902000041),
   *Acta Numerica* 11 (2002), 237--339.
4. J. R. Schöberl, [MINRES and saddle-point finite-element systems](https://www.asc.tuwien.ac.at/~schoeberl/wiki/lva/numa/MinRes.pdf),
   preconditioned symmetric indefinite Krylov systems.

(source-code-index)=
## 10. Source-code index

| Path | Symbol | Responsibility |
|---|---|---|
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `class ConservativeCurrentView` | owns the accepted view and both projection lanes |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `solve_weighted_rt0_projection` | assemble and solve the constrained RT0 projection |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `solve_dense_kkt` | bounded small-mesh reference solve |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `main` | dispatches the optional large sparse runtime gate |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `large_tetrahedral_projection_uses_sparse_kkt_lane` | managed large-mesh sparse runtime check |
| `backends/fem/tests/source_facade_gpu_rk_contract.cpp` | `main` | runs source ownership regression |
| `backends/fem/tests/source_facade_gpu_rk_contract.cpp` | `fem_oet0_large_mesh_has_sparse_kkt_lane` | source ownership and no-dense-limit regression |
| `backends/fem/cpu/mfem/transport/conservative_current_view.hpp` | `class ConservativeCurrentView` | immutable current-view public boundary |
