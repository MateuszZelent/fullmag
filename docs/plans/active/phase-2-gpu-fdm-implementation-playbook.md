# Phase 2 GPU FDM Implementation Playbook

- Status: active
- Priority: P0
- Last updated: 2026-03-23
- Parent target architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Parent rollout plan: `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`
- Parent solver architecture: `docs/specs/exchange-only-full-solver-architecture-v1.md`

## 1. Purpose

This playbook is the detailed handoff for implementing the CUDA/FDM backend without drifting away
from the new application concept.

It should be read as:

> implement GPU FDM under the Rust-owned `fullmag script.py` product model, not beside it.

## 2. Verified starting point

Real today:

- Python authoring API,
- typed `ProblemIR`,
- Box-to-FDM planning,
- public CPU/FDM reference execution,
- bootstrap artifacts,
- precision contract in Python and Rust.

Not real yet:

- Rust-owned public launcher,
- Python helper bridge called by Rust,
- `Study` public layer,
- session manager and session API,
- GPU/CUDA backend,
- live control room.

Implementation must not pretend these missing pieces already exist.

## 3. Frozen decisions for Phase 2

### 3.1 Public launcher target

The public product launcher target is:

```text
fullmag script.py
```

owned by the Rust host binary.

If CUDA work touches CLI/runtime integration, do not strengthen the old Python-owned public
launcher model.

### 3.2 Python integration model

Rust should load user-authored problems through a spawned Python helper in the active environment.

Do not make embedded CPython the primary path for this implementation cycle.

### 3.3 Public API stability

Do not redesign the public authoring surface for Phase 2.

The target model is:

- `Model + Study + Runtime`
- preferred canonical shape: `Problem(..., study=TimeEvolution(...))`
- compatibility shim from `Problem(..., dynamics=..., outputs=...)`

CUDA work must not hard-code assumptions that block the `Study` migration.

### 3.4 Keep the CPU reference path

The CPU reference engine remains:

- buildable,
- testable,
- usable as fallback,
- usable as calibration baseline.

Do not delete, bypass, or weaken it.

### 3.5 Rust owns artifacts and session-facing state

The native backend is a numerical backend, not an artifact writer and not a session authority.

Rust still owns:

- output schedules,
- artifact naming,
- provenance,
- step stats serialization,
- session/run state,
- API exposure.

### 3.6 Native tree decision

Use the existing native backend tree.

Do not create a second parallel root for CUDA/FDM.

### 3.7 Runtime engine selector

Keep an explicit internal FDM execution selector such as:

```text
FULLMAG_FDM_EXECUTION=auto|cpu|cuda
```

It is runtime control, not part of the physics API.

### 3.8 Host-visible numeric exports

Even when device state is `fp32`, host-visible exported fields and scalar diagnostics should remain
`f64` at the Rust boundary.

That keeps:

- artifact writing stable,
- compare logic simpler,
- provenance separate from device storage details.

## 4. Implementation order

### WP0 - runtime boundary preparation

Prepare the code so CUDA can land without entrenching the wrong product model:

- isolate runner dispatch,
- keep artifact writing outside the backend,
- define the FDM ABI boundary,
- make sure no new code assumes the Python package owns the public launcher forever.

### WP1 - native backend skeleton

Implement:

- backend context creation,
- precision-aware initialization,
- upload/download of field state,
- smoke tests for context lifecycle and state round-trip.

### WP2 - exchange-only GPU `double`

Implement:

- `m` and `H_ex` device storage,
- exchange field kernel,
- exchange energy computation,
- deterministic parity checks against CPU reference.

### WP3 - Heun GPU `double`

Implement:

- RHS evaluation,
- predictor/corrector logic,
- renormalization,
- runner dispatch path into CUDA,
- same observable naming and artifact semantics as CPU.

### WP4 - GPU `single`

Implement only after WP3 passes:

- `fp32` state path,
- precision-aware dispatch,
- qualification against GPU `double`,
- metadata and provenance for precision.

### WP5 - calibration harness

Implement:

- repeatable parity cases,
- CPU vs GPU comparison commands,
- GPU `single` vs GPU `double` comparison commands,
- documented tolerances.

### WP6 - shell integration hardening

When the runtime shell lands, verify the CUDA backend plugs into:

- Rust-owned launcher,
- session manager,
- session events,
- run API,
- control-room artifact access.

## 5. Acceptance gates

### Gate A

The native backend skeleton exists and can round-trip state.

### Gate B

GPU `double` exchange matches CPU `double` under agreed tolerances.

### Gate C

GPU `double` full Heun stepping matches CPU `double` for the narrow executable slice.

### Gate D

GPU `single` is qualified against GPU `double`.

### Gate E

CUDA execution still preserves Rust-owned artifacts, provenance, and session-facing behavior.

## 6. Explicitly out of scope

Do not mix these into this implementation cycle:

- FEM execution,
- hybrid execution,
- demag,
- DMI,
- anisotropy,
- Zeeman,
- new integrators,
- adaptive timestep control,
- editor UX,
- multi-GPU,
- MPI,
- remote scheduler work.

## 7. Final guardrail

If any Phase 2 task requires changing:

- public launcher ownership,
- the session spine,
- the browser role,
- the `Model + Study + Runtime` split,

stop and update the target application spec first.
