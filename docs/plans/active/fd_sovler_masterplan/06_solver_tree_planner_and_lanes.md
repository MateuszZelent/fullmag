---
title: Frequency-domain solver tree, planner and engines
version: COMSOL-aligned v5.1 decision-complete
date: 2026-07-10
status: canonical
role: normative
---

# Solver tree, planner and engines

## 1. Scope and authority

This chapter defines the target FEM frequency-domain engine vocabulary and the
deterministic planner policy for `modal_eigen` and `driven_response`. Physics,
signs, units, scalar conventions and residual definitions remain owned by
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`. Backend
ownership remains governed by `docs/architecture/backend-golden-masterplan.md`.

An engine name identifies a numerical algorithm and its residency. It is not a
synonym for device, product status or the current C ABI compatibility lane.

## 2. Normative engine vocabulary

Every accepted solve resolves to exactly one of these engines:

| Engine | Product and contract |
|---|---|
| `dense_cartesian_reference` | Tiny CPU/double Cartesian `3N` oracle with the physical constraint/projection applied explicitly. Reference only. |
| `dense_tangent_reference` | Tiny CPU/double tangent `2N` oracle for modal or driven parity, signs and residuals. Reference only. |
| `cpu_sparse_direct` | CPU PETSc AIJ direct diagnostic for one or a few driven frequencies after legal assembly and memory admission. |
| `cpu_host_krylov` | CPU host-resident Krylov solve of an assembled or matrix-free legal operator. |
| `full_coupled_field_split` | CPU full `delta_m`/auxiliary-field block solve using nested blocks and field-split preconditioning. |
| `schur_reduced` | CPU Schur modal or driven solve admitted only by a certificate keyed to the exact problem signature. |
| `modal_reduced` | CPU reduced-order sweep admitted only by modal completeness and independent sample checks. |
| `gpu_operator_host_krylov` | GPU operator or preconditioner with host-resident Krylov state and host reductions. This is not a device-resident solver. |
| `gpu_device_krylov` | GPU driven solve with device-resident vectors, operator, preconditioner and Krylov hot loop. |
| `gpu_modal_device_krylov` | GPU modal solve with device-resident PETSc/SLEPc vectors, operators, spectral-transform solves and eigensolver hot loop. |

The engine set is closed for this plan revision. New engines require an
explicit algorithm, legality, residual, residency, fallback and ownership
contract before they can enter planner output.

## 3. Legacy ABI lanes are compatibility inputs

The current ABI tokens `validation`, `production_cpu` and `production_gpu` are
legacy compatibility lanes. They do not prove an algorithm, validation level
or residency. The compatibility adapter must feed the requested product,
problem signature and lane constraint into this planner and emit one explicit
target engine in diagnostics before solve execution.

| Legacy lane | Required target interpretation |
|---|---|
| `validation` | Resolve to exactly one of `dense_cartesian_reference` or `dense_tangent_reference` from the actual representation. |
| `production_cpu` | Constrain candidates to CPU engines. The current driven compatibility path normally resolves to `cpu_host_krylov`; a different engine requires an explicit legal planner decision. |
| `production_gpu` | Constrain candidates to GPU engines. The current driven compatibility path is `gpu_operator_host_krylov` unless the complete device-residency contract proves `gpu_device_krylov`. The token alone can never imply device residency. |

The narrow dense K0 GPU modal validation exception is not the general
`gpu_modal_device_krylov` engine and must retain its validation-only name and
scope. A legacy lane that cannot be mapped legally is rejected; it is never
reported as a partially resolved engine.

Diagnostics and artifacts record at least:

```text
requested_execution
legacy_abi_lane, when present
resolved_execution
resolved_engine
selection_reason
fallback_used
fallback_reason, when fallback_used=true
```

## 4. FrequencySolvePlan target contract

The planner output is a single immutable decision, not a set of booleans from
which the runner chooses again:

```cpp
struct FrequencySolvePlan {
    FrequencyProduct product;
    FrequencyExecutionEngine engine;
    OperatorRepresentation representation;
    ScalarRepresentation scalar_representation;
    LinearSolverFamily linear_solver;
    SpectralTransform spectral_transform;
    PreconditionerFamily preconditioner;
    ExecutionDevice resolved_device;
    ExecutionPrecision resolved_precision;
    ResidencyContract residency;
    ResidualContract residual;
    CertificateSet certificate_set;
    std::string selection_reason;
    std::optional<FallbackDecision> fallback;
};
```

`engine` is exactly one concrete token from section 2. A successful plan may
not contain `auto`, a legacy lane, multiple candidate engines, or contradictory
flags such as both full-coupled and Schur-reduced. The runner materializes this
plan and may not reselect an engine.

## 5. Ordered legality-before-heuristics planner

The planner executes these stages in order and stops on rejection:

1. Validate physics, phase, equilibrium, boundary-condition and mesh
   certificates. This includes the exact product, k domain, dynamic-demag
   requirement, shared-domain topology, gauge and operator dictionary.
2. Resolve explicit requested device, precision and solver method. Preserve
   each requested value even when it is `auto`.
3. Reject unavailable strict requests. For a non-strict request, construct and
   record only a documented fallback that solves the same physical problem.
4. Build the candidate engine set legal for the exact product and algebra.
5. Filter candidates by problem-signature certificates, scalar support,
   residency prerequisites and memory admission.
6. Apply performance heuristics only among the remaining legal candidates.
7. Emit exactly one engine and a stable selection reason, or reject with one
   primary rejection reason plus supporting diagnostics.

Legality keys include at least:

```text
(product, k-domain, dynamic-demag, magnetostatic BC, outer BC, gauge,
 assembly kind, equilibrium hash, mesh/certificate hash, material hash,
 device, precision, scalar representation, requested method)
```

The planner must never use a K0 certificate, operator or preconditioner for a
nonzero-k problem. A candidate that lacks a required key is illegal rather
than merely low priority.

## 6. Requested intent, strictness and fallback

In `strict` execution mode, every explicit device, precision and method value
is a hard constraint. Missing support rejects the request before heuristics.
In particular, strict GPU never runs CPU; strict `single` never runs `double`;
and an unavailable explicit method never resolves to `auto` or another method.

In a non-strict mode, fallback is legal only when all of the following hold:

1. the public execution policy permits fallback for that requested field;
2. the replacement solves the identical physical, BC, k-domain and observable
   contract;
3. the replacement engine passes all legality and certificate gates;
4. requested and resolved device, precision and method are both preserved;
5. diagnostics and provenance set `fallback_used=true` and give a concrete
   `fallback_reason` before execution.

Resolving an `auto` field among legal candidates is normal resolution, not a
fallback, but the requested `auto` value is still preserved. Validation,
synthetic assembly, K0 demag, open boundaries, disabled demag or post-solve
phase projection are never fallbacks for a missing production operator.

## 7. Permitted heuristics

After legality filtering, heuristics may rank candidates using problem size,
frequency count, requested spectrum, memory estimate, accepted preconditioner
contraction and measured historical telemetry for the same signature class.
Typical rankings are:

- tiny certified oracle work: a matching dense reference engine;
- one or a few CPU driven frequencies with admitted factorization memory:
  `cpu_sparse_direct`;
- scalable CPU driven response: `cpu_host_krylov`,
  `full_coupled_field_split` or certified `schur_reduced`;
- many-frequency CPU sweep with a certified basis: `modal_reduced`;
- explicit or resolved GPU driven response: `gpu_device_krylov` when the full
  residency/preconditioner contract is available, otherwise the explicitly
  host-Krylov `gpu_operator_host_krylov` when that degradation is legal;
- explicit or resolved GPU modal spectrum: `gpu_modal_device_krylov` only when
  the SLEPc/device spectral-transform contract is available.

`prefer_existing_host_krylov` is only a same-device ranking preference. It
cannot mutate a CPU request into GPU, create GPU availability, bypass strict
method intent or defeat a certificate gate.

## 8. Non-negotiable planner invariants

```text
CPU cannot become GPU from prefer_existing_host_krylov.
Forced GPU cannot be preempted by CPU sparse-direct.
Nonzero-k dynamic demag cannot select a K0 operator.
Schur requires an accepted certificate keyed to the exact problem signature.
Modal-reduced requires completeness and independent full/direct sample checks.
A device-resident engine requires zero per-iteration vector/matrix H2D or D2H.
Exactly one engine and one selection reason are emitted for every accepted plan.
```

Memory rejection is deterministic and occurs before performance ranking. A
certificate invalidated by any signature component is absent, not degraded.

## 9. Current implementation boundary

The target policy above is not yet the current runtime policy:

| Current evidence | Honest status |
|---|---|
| `frequency_solve_plan.hpp` exposes seven coarse lane names. | `dense_cartesian_reference`, `dense_tangent_reference`, `cpu_host_krylov` and `gpu_modal_device_krylov` are not yet distinct planner outputs. |
| `frequency_solve_planner.hpp` is a header-level conservative descriptor. | It is not the single authoritative runtime route and does not implement the ordered policy above. Sparse-direct can be considered before GPU intent, and `prefer_existing_host_krylov` currently contributes to `requested_gpu`; both are target contract gaps. |
| The driven C ABI exposes `validation`, `production_cpu`, `production_gpu`. | These remain compatibility lanes and current diagnostics do not consistently publish one target engine for every path. |
| The Rust frequency-response runner rejects an implemented subset and also derives a resolved method name. | This is transitional orchestration logic; target engine selection belongs to the canonical planner and must not be repeated in the runner. |
| Current FEM frequency-domain planning rejects `single`. | This is honest current behavior, not permission to change precision in non-strict execution without an explicit fallback contract. |

No implementation or validation status is promoted by this documentation
chapter. Current-vs-target engine details are maintained in
`08_backend_algorithms_and_status.md` and the capability matrix.
