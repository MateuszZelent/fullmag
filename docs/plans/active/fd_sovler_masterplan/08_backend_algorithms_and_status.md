---
title: Frequency-domain backend algorithm contracts and status
version: COMSOL-aligned v5.1 decision-complete
date: 2026-07-10
status: canonical
role: normative
---

# Backend algorithm contracts and status

## 1. Authority and status vocabulary

The common algebra is the `FrequencyOperatorDictionary.v1` contract in
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`:

```text
modal:  L q = lambda B q, lambda = i omega
driven: D(omega) q = (i omega B - L) q = b
```

Each backend may use complex scalars or the documented real split, but must
publish the scalar representation and certify the residual of the original
full operator. Transformed, preconditioned, Schur or reduced residuals are
additional diagnostics and cannot replace the full residual.

Status rows use three independent fields:

```text
implementation_state: absent | source_visible | executable | partial_production_executable
validation_state: unvalidated | algebra_validated | runtime_evidenced | scope_validated
validated_scope: exact problem, device, precision, algebra and runtime boundary
```

`production_executable` is not equivalent to `production_qualified`. This
documentation task inspected source and current parallel documentation only;
it did not rerun any runtime evidence.

## 2. Common P1 shared-domain assembly contract

Production FEM assembly is P1 MFEM assembly over the accepted magnetic/shared
airbox domain. It produces the exact tangent magnetic blocks and, when dynamic
demag is requested, scalar-potential coupling and Poisson blocks required by
the selected BC/gauge tuple. Production assembly must publish
`assembly_kind=mfem_weak_form_shared_domain`; dense row-major payloads and
`synthetic_algebraic_oracle` remain reference inputs.

For a complex implementation, PETSc/SLEPc consumes the canonical complex
operator directly. For a real PETSc build, the implementation uses the general
real split

```text
[D_R -D_I; D_I D_R] [q_R; q_I] = [b_R; b_I]
```

and the corresponding generalized real representation for modal solve. It
must not assume the special `[K,+omega*M;-omega*M,K]` form unless `K=-L` and
`M=B` have been established for the exact operator.

K0 and nonzero-k assembly are separate legal products. Nonzero-k dynamic demag
requires the Floquet scalar/magnetic equivalence classes and complex Bloch
operator; it may not reuse a K0 matrix.

## 3. CPU reference and direct engines

| Engine | Matrix/scalar contract | Solver and transform | Preconditioner | Required residual | Failure and fallback |
|---|---|---|---|---|---|
| `dense_cartesian_reference` | Explicit CPU/double Cartesian operator, including constraints/projection and any auxiliary blocks. Tiny bounded dimension only. | Dense generalized eigensolve or dense direct harmonic solve; no production spectral shortcut. | None or exact dense factorization. | Original Cartesian equation plus tangent-leakage/constraint residual and cross-oracle parity. | Reject outside the bounded oracle size. Never a production fallback. |
| `dense_tangent_reference` | Explicit CPU/double tangent operator, complex or documented real split. | Dense generalized eigensolve or dense direct driven solve. | None or exact dense factorization. | Original tangent operator residual; full block residual when scalar potential is present. | Reject outside the bounded oracle size. Never replaces unavailable production physics. |
| `cpu_sparse_direct` | Per-frequency PETSc AIJ matrix for the legal complex or general real-split driven system. | `KSPPREONLY` plus `PCLU`; factorization package and ordering are diagnostics. No eigen use. | LU factorization is the solve, not an iterative preconditioner. | Recompute `||D(omega)q-b||` from the original operator and publish block residuals where applicable. | Strict explicit direct rejects if PETSc/factorization/memory is unavailable. Non-strict auto may replan to another legal CPU engine with recorded fallback. |

Current status:

| Engine/slice | implementation_state | validation_state | validated_scope |
|---|---|---|---|
| Cartesian dense reference | `source_visible` | `unvalidated` | No distinct end-to-end target engine token is proven by current planner/ABI. |
| Tangent dense reference | `executable` | `scope_validated` | Tiny CPU/double modal and block-real driven reference fixtures only; not large-object production. |
| PETSc AIJ sparse direct helper | `source_visible` | `algebra_validated` | Isolated dense-input-to-AIJ real-split helper using `KSPPREONLY/PCLU` and true-residual recomputation; current production dispatch does not select it as an end-to-end engine. |

## 4. CPU selected-spectrum modal engines

### 4.1 Full descriptor selected spectrum

The scalable full modal path constructs the legal P1 MFEM descriptor and gives
PETSc/SLEPc either assembled sparse blocks or matrix-free actions. SLEPc uses a
generalized non-Hermitian problem with Krylov-Schur or Arnoldi. Interior-window
selection uses shift-invert or another explicitly named transform with
`sigma=i*omega_target` in the canonical complex representation, or its exact
real-split equivalent. A real-axis target is forbidden unless a separately
derived real-frequency pencil is named and validated.

The shifted KSP and PC are part of the engine contract. PETSc/hypre provide the
linear solve and preconditioning; the selected transform, tolerances,
factorization or iterative policy, and convergence reason are diagnostics.
Every accepted mode is remapped through `lambda=i*omega`, normalized according
to the public policy and checked against the original full descriptor.

### 4.2 Schur MatShell selected spectrum

The Schur modal engine exposes a SLEPc `MatShell` action

```text
S(lambda) q = A_qq(lambda)q
              - A_qphi solve(A_phiphi, A_phiq q)
```

with the exact BC/gauge-constrained Poisson inverse. It is legal only with an
accepted `SchurCertificate` keyed by the full problem signature, including
equilibrium, mesh, materials, k, BC/gauge, assembly and scalar representation.
Krylov-Schur/Arnoldi and the spectral transform follow the same target rules as
the full descriptor path. Each mode reconstructs `phi` and publishes magnetic,
Poisson/gauge and complete descriptor residuals. A Schur residual alone cannot
accept a mode.

Current status:

| Slice | implementation_state | validation_state | validated_scope |
|---|---|---|---|
| CPU SLEPc selected spectrum | `partial_production_executable` | `runtime_evidenced` | No production-qualified scope. Current evidence is limited to selected-spectrum CPU no-demag/Full2x2 Floquet and gamma-equivalent slices plus tiny/macrospin adapters. Real shared-domain dynamic-demag qualification and the target imaginary-axis transform remain open. |
| Poisson-airbox Schur `MatShell` | `source_visible` | `algebra_validated` | Synthetic/algebraic K0 certificate fixtures with reconstructed full and Poisson residuals. This is not real shared-domain P1 production assembly. |

## 5. CPU driven Krylov engines

### 5.1 `cpu_host_krylov`

This is the generic CPU host-resident driven engine. It applies the accepted
assembled or matrix-free `D(omega)` and runs host GMRES/FGMRES. The operator,
preconditioner, restart, tolerances and stopping reason are explicit. The
engine recomputes the original unpreconditioned residual at controlled cadence
and at completion. Preconditioner pilot heuristics may choose only among legal
preconditioners; they may not change product, device, precision or method.

### 5.2 `full_coupled_field_split`

The production algorithm uses PETSc `MatNest` or equivalent nested `MatShell`
blocks for the full magnetic/scalar system and PETSc KSP GMRES/FGMRES with
`PCFIELDSPLIT`. The magnetic block uses an accepted tangent operator
preconditioner; the scalar block uses the BC/gauge-correct PETSc/hypre Poisson
solve. The preconditioner may be block triangular or Schur-based, but the
solved operator remains full coupled. Acceptance requires total, magnetic,
scalar-potential and gauge residuals from the original full system.

### 5.3 Certified `schur_reduced` driven solve

The driven Schur engine uses a PETSc `MatShell` for the frequency-dependent
reduced action and a certified Poisson inverse. Its certificate is keyed to the
same exact problem signature as modal Schur. It reconstructs `phi` at every
accepted frequency and verifies the original full driven residual. If the
certificate is missing, invalidated or fails a runtime quality bound, explicit
strict Schur rejects. A non-strict auto request may replan to the legal full
coupled engine and must record the fallback before solve execution.

Current status:

| Engine/slice | implementation_state | validation_state | validated_scope |
|---|---|---|---|
| `cpu_host_krylov` compatibility path | `partial_production_executable` | `runtime_evidenced` | No production-qualified scope. Current evidence covers only the listed gamma/free-boundary, k0 static-periodic, no-demag nonzero-k phase-projection and narrow K0 periodic-airbox provider slices. It is a custom host GMRES path, not the target PETSc engine for every algebra. |
| Full-coupled field-split helper | `source_visible` | `algebra_validated` | Bounded dense prototype with a cached dense scalar-block inverse and iterative residual diagnostics; no production PETSc `MatNest/PCFIELDSPLIT` integration. |
| Driven Schur/provider paths | `partial_production_executable` | `runtime_evidenced` | No production-qualified scope. Narrow K0 periodic-airbox matrix-free provider/Schur response evidence only. It does not prove general full assembly, nonzero-k demag-k or selected-spectrum modal support. |

## 6. Modal, rational and recycling sweep engine

`modal_reduced` starts from modes produced by a qualified full or certified
Schur modal engine for the same problem signature. The basis certificate
contains the frequency interval, mode count, normalization, left/right basis
requirements for non-Hermitian damping, maximum eigen residual, completeness
test and cache key. The driven sweep projects the physical RHS once, solves the
reduced complex system, and reconstructs requested observables.

Rational Krylov or recycling may enrich the basis, but each accepted sweep must
pass independently selected full/direct sample solves and declared response
error tolerances. A failed completeness or sample check invalidates the basis.
Strict explicit `modal_reduced` rejects; a permitted non-strict fallback
replans to a legal full driven engine and records the basis failure. It never
silently continues with an uncertified basis.

Current status:

| implementation_state | validation_state | validated_scope |
|---|---|---|
| `source_visible` | `algebra_validated` | Diagonal validation helper, completeness-policy types and sparse-direct sample hooks. No integrated production modal/rational/recycling sweep engine. |

## 7. GPU library-first engines

The primary production path uses the established solver stack:

| Layer | Driven `gpu_device_krylov` | Modal `gpu_modal_device_krylov` |
|---|---|---|
| Operator | MFEM/libCEED/CUDA matrix-free apply, including the exact dynamic-demag operator required by the problem. | The same device operator contract for `L`, `B` and any full coupled descriptor blocks. |
| PETSc objects | CUDA vectors and device-capable `MatShell`/`MatNest`; no host shadow as the iteration source of truth. | CUDA PETSc vectors/matrices consumed by SLEPc. |
| Auxiliary solve | hypre device Poisson or shifted preconditioner with accepted BC/gauge and contraction evidence. | hypre/PETSc device shifted solve used by the SLEPc spectral transform. |
| Iteration | PETSc KSP GMRES/FGMRES with device-resident vector algebra. | SLEPc Krylov-Schur/Arnoldi with the exact complex or real-split spectral target. |
| Acceptance | Original driven full/block residual and device-residency telemetry. | Original descriptor/block residual for every accepted mode and device-residency telemetry. |

Host orchestration, launch decisions, progress publication and bounded scalar
reductions are allowed. Setup H2D and final/output-cadence D2H are allowed and
counted. A device-resident claim forbids per-iteration vector or matrix H2D/D2H
migration, host dot/norm/axpy, host Arnoldi/Hessenberg updates, and host
preconditioner state. Required diagnostics include:

```text
krylov_vector_location=device
operator_buffer_location=device
preconditioner_buffer_location=device
per_iteration_h2d_transfer_count=0
per_iteration_d2h_transfer_count=0
```

A custom CUDA Krylov or eigensolver loop is considered only after a recorded
benchmark and profiler report shows that the PETSc/SLEPc/hypre/libCEED path
cannot meet the numerical or residency contract. Convenience or an existing
callback loop is not sufficient justification.

## 8. Honest GPU distinction and current status

`gpu_operator_host_krylov` is an explicit compatibility engine: operator and
possibly Poisson/preconditioner work may run on GPU, while Krylov vectors,
orthogonalization, Hessenberg state, dot/norm/axpy and convergence control stay
on host. Host/device vector movement at operator callback boundaries is legal
for this engine only when reported. It must never set
`gpu_device_resident_solver=true`.

| Engine/slice | implementation_state | validation_state | validated_scope |
|---|---|---|---|
| `gpu_operator_host_krylov` driven compatibility path | `partial_production_executable` | `runtime_evidenced` | No production-qualified scope. Current evidence covers narrow gamma/free-boundary, k0 static-periodic, no-demag nonzero-k phase-projection and K0 periodic-airbox provider slices. The source reports host Krylov residency; it is not `gpu_device_krylov`. |
| GPU persistent operator context | `executable` | `runtime_evidenced` | No production-qualified engine scope. Static device buffers and CUDA local/exchange/DMI operator application exist for supported driven slices; this proves operator residency only. |
| `gpu_device_krylov` contract skeleton | `source_visible` | `unvalidated` | Descriptor, callback, transfer and residual gates exist, but `production_loop_available=false`; no PETSc device KSP engine is integrated. |
| Narrow K0 GPU modal exceptions | `executable` | `scope_validated` | Dense K0 no-demag macrospin/Kittel and bounded dense Poisson algebra fixtures only, with explicit non-scalable/validation labels. They do not implement general `gpu_modal_device_krylov`. |
| `gpu_modal_device_krylov` | `absent` | `unvalidated` | No general PETSc/SLEPc device-resident modal engine for real shared-domain meshes, dynamic demag or nonzero-k Floquet. |

Nonzero-k numerical FEM dynamic demag remains a contract gap. Neither a K0
operator nor a no-demag phase-projection slice may satisfy that request.

## 9. Task 4 contract-gap correlation

The planner and engine targets consume, but do not close, the end-to-end gaps
recorded by Task 4:

| Task 4 gap | Consequence for this chapter |
|---|---|
| `EquilibriumArtifact.v6 -> LinearizationState.v6` and `periodic_mesh_certificate.v6` are not consumed end to end. | Target legality requires their hashes/certificates; current isolated native descriptors cannot be treated as accepted planner input. |
| Modal plan/native request lacks complete requested device, precision, method and magnetostatic-BC fields; current common artifact writing may hardcode CPU/double. | General CPU/GPU modal engine resolution and requested/resolved provenance remain contract gaps even where a narrow solver adapter executes. |
| Nonzero-k numerical dynamic demag and general Floquet-airbox modal/GPU support are missing. | Planner must reject those signatures and cannot select a K0, no-demag or driven-response engine as a substitute. |
| Production driven materialization does not yet integrate the physical-field-to-tangent-RHS conversion helper. | No driven engine is production-qualified for the target physical RHS contract merely because its linear solve converges. |
| Current host/device pointers and legacy lanes do not prove vector, operator, preconditioner and Krylov residency. | `production_gpu` resolves honestly to `gpu_operator_host_krylov` unless independent transfer telemetry proves a device engine. |
| Hardened engine, residual, BC/gauge, hash, readiness and residency fields are not consistently published through artifacts/OpenAPI/UI. | Planner acceptance and solver convergence are insufficient for product qualification until the selected engine and full evidence envelope are inspectable. |

These are current implementation boundaries. This task does not edit code,
the capability matrix, ABI, artifacts or runtime behavior.

## 10. Backend ownership

Production numerical implementations live under:

```text
backends/fem/cpu/frequency_domain/
  engines/
  operators/
  preconditioners/
  modal/
  validation/

backends/fem/gpu/cuda/frequency_domain/
  engines/
  operators/
  preconditioners/
  residency/
  modal/
```

Backend-neutral descriptors, planner input/output types, certificates and
diagnostic schemas may live under `backends/fem/include/frequency_domain/` and
shared implementation support under `backends/fem/src/frequency_domain/`, but
those shared directories do not own a CPU or GPU production engine.

`crates/fullmag-runner` owns orchestration, ABI request/result lifetime,
cancellation, progress, artifacts and provenance. It consumes the single
selected engine; it does not own MFEM assembly, PETSc/SLEPc setup, hypre
preconditioners, CPU solver loops, GPU Krylov state or numerical fallback
selection.

Current ownership is transitional: the large
`backends/fem/src/frequency_domain/driven_response_solver.cpp` still contains
production routing and numerical behavior, and the runner still performs some
method rejection/resolution. Their existence is current code truth, not the
target ownership boundary. Moving behavior must be a later behavior-preserving
implementation task, not part of this documentation change.

## 11. Promotion gate

An engine can be called production-qualified only for an exact
`(product,k-domain,demag,device,precision,engine,assembly,BC/gauge)` scope after
it has:

1. deterministic planner legality and strict/fallback tests;
2. original full/block residual certification;
3. reference parity and mesh/order convergence where applicable;
4. requested/resolved engine, scalar, transform and residency provenance;
5. managed runtime evidence for the exact lane;
6. performance and memory evidence at the intended scale;
7. for GPU device engines, zero per-iteration vector/matrix migration evidence.

Source visibility, isolated contract tests, an operator callback on GPU or a
successful compatibility lane does not satisfy this gate.
