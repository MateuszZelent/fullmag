# FEM GPU NCG and demag optimization design

**Date:** 2026-07-20

**Status:** approved; dependency-upgrade amendment approved in conversation

**Scope:** native FEM GPU relaxation and CUDA/HYPRE demagnetizing-field runtime

## 1. Decision

Implement the correctness-and-performance variant as one ordered change set:

1. upgrade the managed FEM stack from MFEM 4.7/HYPRE 2.32.0 to MFEM 4.9/
   HYPRE 3.1.0 and establish a no-solver-change baseline;
2. repair the GPU nonlinear-CG line search so it uses the canonical direct
   energy increment and demag refinement contract;
3. reuse the exact accepted endpoint evaluation once as the next NCG current
   evaluation;
4. build the HYPRE AMG hierarchy once per compatible demag context instead of
   resetting it for every fresh right-hand side;
5. replace the strict-GPU device-wide CUDA barrier with explicitly ordered
   Fullmag/HYPRE stream interoperation;
6. expose enough bounded telemetry to prove solve count, setup reuse, fresh
   zero guesses, cache validity, and synchronization behavior.

Correctness gates precede performance claims. The implementation must not gain
speed by weakening the Poisson tolerance, changing the physical objective, or
silently accepting an unproved stream-ordering assumption.

## 2. Baseline and motivation

The supplied steady-state profiler samples average approximately:

| Quantity | Observed value |
|---|---:|
| total step time | 704.2 ms |
| demag time | 595.2 ms |
| demag share | 84.5% |
| solver apply time | 593.5 ms |
| demag solves per step | 2 |
| total Krylov iterations per step | 73-75 |

The principal cost is therefore two high-accuracy Poisson solves per accepted
NCG step. The accepted trial already leaves the canonical GPU magnetization,
fields, effective field, and energy at the accepted endpoint, but the next step
currently evaluates that same endpoint again. Independently, the fresh-RHS
path resets the HYPRE solver and preconditioner, discarding the AMG hierarchy.

Removing one repeated solve predicts roughly 407 ms per steady step from this
profile before secondary effects, or about 1.7x speedup. This is a prediction,
not validation; the managed production benchmark decides the result.

The reported effective OpenMP thread count of one is not itself a defect in the
GPU lane. Host thread count is not the target of this work.

### 2.1 Managed dependency upgrade amendment

The previous managed image pinned MFEM 4.7 and HYPRE 2.32.0 even though the
optimization work began after MFEM 4.9 and HYPRE 3.1.0 were stable releases.
No repository architecture decision or validation record justifies keeping the
older pair. Building a new private stream adapter against the older HYPRE ABI
would create avoidable debt.

The dependency upgrade is therefore a prerequisite work package, not evidence
that the solver optimization is complete. It must be isolated and measured
before solver behavior changes:

1. pin `MFEM_REF=v4.9` and `HYPRE_REF=v3.1.0` in the managed FEM image;
2. rebuild the image and runtime bundle without changing Fullmag numerical
   code;
3. run compile, demag, time-domain, frequency-domain, relaxation, and CPU/GPU
   parity gates;
4. record the same NCG GPU baseline fields used by the supplied profile;
5. continue to solver changes only after the new pair is production-executable;
6. if the upstream pair cannot satisfy existing contracts, revert the two pins
   together and report the exact incompatibility rather than carrying a mixed
   or partially upgraded stack.

The upgrade may change upstream defaults. Fullmag must continue to set every
production solver tolerance, iteration limit, preconditioner choice, and AMG
parameter explicitly so numerical behavior does not depend on a library
default. The current libCEED and CUDA-base versions remain unchanged in this
work package.

## 3. Canonical constraints

The implementation must preserve these existing contracts:

- direct minimizers use the canonical physical energy and tangent-projected
  gradient;
- a distinct trial endpoint receives a fresh zero-initial demag solve at the
  production tolerance, currently no weaker than `rtol = 1e-12`;
- Armijo acceptance uses the canonical direct energy increment, including the
  polarized demag contribution and refinement path needed to avoid subtracting
  two large, nearly equal endpoint totals;
- an accepted endpoint may be reused only when it is the exact same state and
  solver/evaluation signature, not an approximate or differently refined
  evaluation;
- CPU and GPU realizations share signs, units, energy definitions, convergence
  observables, and lifecycle semantics;
- strict GPU execution must remain device-resident and fail closed rather than
  silently fall back to a host solver or an unproved synchronization path;
- public Python, ProblemIR, planner, OpenAPI, and capability semantics do not
  change in this optimization.

The relevant physics notes must be updated before native implementation:

- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`;
- `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`;
- `docs/physics/0560-all-in-gpu-fem-runtime.md`;
- `docs/physics/0580-canonical-relaxation-equilibrium-contract.md` only if the
  implementation exposes a genuine change or missing clarification in the
  canonical equilibrium contract.

## 4. Architecture

### 4.1 GPU NCG direct-increment repair

The existing projected-gradient implementation already contains the closest
GPU direct-minimizer machinery for trial-state energy increments and demag
refinement. Extract only the backend-internal common primitives required by
both projected-gradient and nonlinear-CG into the GPU relaxation subsystem.

The shared internal operation must:

1. retain the base state and the base demag field needed by the polarized
   demag increment;
2. construct and normalize the trial magnetization on device;
3. evaluate local and nonlocal energy increments with the canonical signs and
   SI scaling;
4. perform a fresh zero-initial trial demag solve;
5. refine only according to the documented direct-increment policy;
6. return an acceptance record containing the exact trial signature, energy,
   effective field validity, demag solve count, and refinement count;
7. leave the accepted state and its fields canonical, or restore the base state
   and fields completely on rejection.

NCG retains its existing direction construction, tangent projection, PR+
update, descent restart, and backtracking policy. Only the endpoint evaluation
and acceptance quantity are unified with the canonical direct-minimizer
contract. No new physics state belongs in the global FEM `Context` or
`mfem_bridge.cpp`.

### 4.2 One-shot accepted-endpoint reuse

Add a bounded one-shot accepted-evaluation token to the GPU relaxation state.
The numerical arrays remain in their existing device buffers; the token is
metadata proving that those arrays describe the current canonical state.

The token contains at least:

- validity and one-shot consumption state;
- stage generation and accepted-step generation;
- magnetization/state generation;
- applied-drive revision;
- interaction/material configuration revision;
- energy value and evaluation/refinement classification;
- demag solver signature: mode, linear solver, preconditioner, tolerance,
  maximum iterations, and fresh-zero policy;
- device residency/source identity for `m`, `H_demag`, and `H_eff`.

At the beginning of the next NCG step, an exact signature match consumes the
token and skips the duplicate current-state field, demag, and energy
evaluation. The gradient is formed from the already canonical `H_eff`. A token
miss follows the current fresh evaluation path.

The token is invalidated by any operation that can change or overwrite the
state or its interpretation, including:

- stage begin/end, state upload, reset, or storage reallocation;
- mesh, material, interaction, drive, or solver-policy changes;
- snapshot/evaluation paths that may overwrite field buffers;
- a residency or source transition;
- an externally requested effective-field evaluation;
- trial rejection or incomplete rollback;
- any evaluation whose refinement/signature differs from the reusable
  canonical accepted endpoint.

The token is NCG-internal in the first implementation. It must not become a
general implicit field cache until other algorithms receive their own proof and
tests.

The expected no-backtrack solve accounting is:

- first NCG step: one current-state solve plus one trial solve;
- each subsequent accepted step: consume the prior endpoint plus one trial
  solve;
- each additional backtrack: one additional fresh trial solve.

### 4.3 Persistent HYPRE solver and AMG setup

The demag matrix and preconditioner configuration are invariant for the
lifetime of a compatible FEM GPU context. Initialization must therefore:

1. create the HYPRE solver and selected preconditioner;
2. bind the invariant operator once;
3. create compatible parallel right-hand-side and solution vectors;
4. call the explicit HYPRE/MFEM setup operation once after all required vectors
   exist;
5. record the setup count and setup duration.

For every fresh RHS solve, the runtime must only:

1. assemble/write the new RHS;
2. zero the solution vector on device;
3. select the zero-initial-iterate contract;
4. apply the already configured solver;
5. recover the device result.

It must not reset or recreate the solver or preconditioner on each RHS. Any
operator or setup-affecting configuration change creates a new compatible
context or performs an explicit counted rebuild. A fresh zero guess and a
reused AMG hierarchy are separate concepts and must remain separately visible
in telemetry.

This reuse applies to every caller of the shared CUDA demag solver, including
frequency-domain use, so frequency-domain managed gates must prove no
regression.

### 4.4 Exact Fullmag/HYPRE CUDA stream ordering

Deleting the current `cudaDeviceSynchronize()` without proving HYPRE stream
ownership is unsafe. Fullmag uses a nonblocking compute stream, while the
pinned HYPRE runtime may execute on a distinct stream. Default/NULL-stream
semantics are not an acceptable proof of ordering.

Introduce an isolated, version-pinned HYPRE 3.1.0 stream interop adapter in the
CUDA demag subsystem after inspecting the headers produced by the upgraded
managed build. It borrows, never owns, the exact stream used by that HYPRE
build and provides this ordering:

1. record `fullmag_ready` on the Fullmag compute stream;
2. make the exact HYPRE stream wait for `fullmag_ready`;
3. invoke HYPRE `Mult`;
4. record `hypre_done` on the exact HYPRE stream;
5. make the Fullmag compute stream wait for `hypre_done`;
6. continue result recovery and downstream kernels on the Fullmag stream.

The adapter is compiled only for MFEM 4.9/HYPRE 3.1.0 and
must fail closed during strict GPU initialization when it cannot prove access
to the exact runtime stream. It must not infer the stream from CUDA default
stream behavior.

An audited device-wide compatibility barrier may remain only in an explicitly
non-strict diagnostic compatibility path. Such a path must report the barrier
and cannot claim the strict all-in-GPU synchronization contract. The old raw
barrier must not remain invisible to transfer/synchronization telemetry.

If the pinned managed build exposes no versionable way to borrow the exact
HYPRE stream, implementation stops at the proof gate: retain an audited barrier
and report this subgoal as blocked rather than deleting it speculatively.

### 4.5 Telemetry

Extend the existing bounded solver-profiler/provenance state without adding
disabled-path allocations or logging. Required counters and last-step fields
are:

- demag solve count and Krylov iteration total;
- HYPRE setup count, rebuild reason, and setup duration;
- fresh-zero-guess and warm-start counts;
- accepted-endpoint cache hits, misses, invalidations, and miss reason;
- direct-increment refinement count;
- exact-stream event waits and audited global/device synchronization count;
- solver/evaluation signature used by the sample.

`setup_reused = true` means no setup occurred during the measured step; it must
not be hardcoded. `GPU sync` must distinguish an event dependency from a
device-wide host barrier. Existing boundedness and disabled-by-default profiler
contracts remain unchanged.

## 5. Failure and rollback semantics

- Every rejected NCG trial restores magnetization, demag field, effective
  field, energy state, direction-related state, and cache metadata before the
  next backtrack.
- A failed demag solve cannot publish an endpoint token.
- A failed refinement cannot fall back to an unrefined acceptance decision.
- A token mismatch is a cache miss, not a fatal solver error; the current state
  is evaluated freshly.
- A HYPRE stream-interop mismatch in strict GPU mode is a fatal capability/
  initialization error with explicit provenance, not a silent barrier or CPU
  fallback.
- A setup-affecting operator change invalidates the old solver instance and
  performs one explicit counted rebuild before the next apply.

## 6. Tests and verification

Implementation follows red-green-refactor. Source-contract tests that
currently encode contradictory CUDA synchronization expectations must first be
replaced by one canonical contract.

### 6.1 Focused correctness tests

- direct energy increment matches a high-accuracy endpoint-energy oracle on
  nontrivial trial states without cancellation-driven false acceptance;
- polarized demag increment has the canonical sign and scaling;
- refinement is invoked at the documented threshold and its result controls
  acceptance;
- NCG accept/reject and rollback preserve all canonical device buffers;
- PR+ direction update and descent restart remain unchanged;
- endpoint token hits only for an exact signature and is consumed once;
- every listed invalidation cause forces a fresh current evaluation;
- failed/rejected trials never publish reusable endpoint metadata;
- no-backtrack solve counts are `2, 1, 1, ...`, while backtracks add exactly one
  fresh solve each;
- first and subsequent fresh solves are independent of prior solution-vector
  contents;
- HYPRE setup count is one per compatible context and increments only on an
  explicit setup-affecting rebuild;
- CG/AMG remains the production policy and supported CG/GMRES plus AMG/Jacobi
  combinations retain their declared behavior.

### 6.2 CUDA ordering tests

- a source contract forbids an unaudited raw `cudaDeviceSynchronize()` in the
  strict path and requires the versioned stream adapter;
- an integration test launches independent work on a separate stream and proves
  a demag solve does not globally serialize it;
- producer-before-HYPRE and HYPRE-before-consumer ordering are tested with data
  dependencies, not timing alone;
- the audited global-sync counter remains zero in strict mode;
- CUDA error recovery reports the exact failing interop phase.

### 6.3 Managed native gates

Native verification uses repository container-backed `just` recipes. The final
evidence set includes at least:

```text
just rebuild-fem-runtime
just verify-fem-demag-poisson-contract
just verify-fem-time-domain-native-contract
just verify-fem-frequency-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just verify-fem-relaxation-production-benchmark
just verify-fem-gpu-demag-performance-benchmark
```

The implementation plan must inspect the current `justfile` before assigning
exact focused commands and may add a narrowly scoped managed recipe only where
the existing recipes cannot prove stream interoperation or setup reuse.

### 6.4 Physics qualification boundary

Runtime and benchmark gates do not by themselves establish full NIST SP4
qualification. This change must preserve existing SP4 trajectory evidence,
including the first `mx = 0` snapshot and current mesh/airbox studies, but no
new claim of complete production validation is permitted without the full
canonical convergence evidence.

## 7. Performance acceptance

All measurements use the same mesh, airbox, material, drive, algorithm,
tolerances, convergence settings, precision, GPU, and managed runtime image.
Warm-up and steady-state windows are reported separately.

The change is performance-complete only when:

1. steady accepted NCG steps without backtracking use one demag solve after the
   first step;
2. the AMG hierarchy is set up once per compatible context;
3. strict GPU execution records zero device-wide synchronization barriers in
   the optimized demag path;
4. the supplied SP4-like NCG workload improves median steady step time by at
   least 1.5x, with the original profile suggesting approximately 1.7x;
5. numerical outcomes, acceptance decisions, torque trajectory, stop reason,
   and artifacts remain within the existing CPU/GPU and production tolerances;
6. no supported relaxation algorithm or demag policy regresses by more than
   10% in its relevant managed benchmark without an identified and approved
   explanation.

If structural targets pass but the 1.5x target does not, profile the remaining
device kernels and transfer/synchronization timeline. Do not lower field
quality, tolerance, mesh quality, or output fidelity to manufacture the target.

## 8. Non-goals

This work does not include:

- weakening Poisson tolerances or convergence criteria;
- changing precision or qualifying FEM GPU single precision;
- upgrading CUDA, libCEED, PETSc/SLEPc, or the managed base image beyond the
  approved MFEM 4.9/HYPRE 3.1.0 pair;
- changing public solver-selection, ProblemIR, Python, OpenAPI, or UI contracts;
- moving physics into `Context` or `mfem_bridge.cpp`;
- optimizing the FDM backend;
- modifying the user's SP4 scenario edit or the dirty external-solver submodule;
- claiming complete SP4 validation from runtime performance evidence.

## 9. Completion criteria

The task is complete only when the implementation, focused tests, physics-note
updates, profiler semantics, managed native gates, and before/after benchmark
evidence all agree. The final report must distinguish:

- implemented source behavior;
- production-executable managed runtime evidence;
- measured performance improvement;
- physics validation that was actually run;
- any qualification work that remains open.
