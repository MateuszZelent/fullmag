# Implementation Status and Next Plans Under the v2 Reset

- Status: active
- Last updated: 2026-03-23
- Parent target architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Related active plans:
  - `docs/plans/active/frontend-architecture.md`
  - `docs/plans/completed/phase-0-1-implementation-plan.md`
  - `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`
  - `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`

## 1. Why this document exists

The repository now has a real executable solver slice, but it still does not match the
target application shell described by the v2 reset.

This document keeps the project honest by recording:

1. what is implemented today,
2. what is only target architecture,
3. which active plans still matter,
4. what order the next work must follow.

## 2. Verified current implementation state

### 2.1 What is real in code today

The following are implemented:

- embedded Python authoring API,
- analytic geometries:
  - `Box`
  - `Cylinder`
- initial magnetization:
  - `uniform`
  - `random(seed)`
- typed `ProblemIR`,
- typed `ExecutionPlanIR`,
- Box-to-FDM planning,
- reference CPU/FDM exchange-only engine,
- runner and artifact writing,
- public executable narrow slice through Python runtime,
- precision contract:
  - `single`
  - `double`
  carried in Python API, `ProblemIR`, planning, and provenance.

### 2.2 Current honest executable subset

The current public executable subset is still:

> `Box + one ferromagnet + Exchange + LLG(heun) + fdm/strict + CPU reference`

This is a useful scientific baseline.
It is not yet the target application shell.

### 2.3 What is still missing relative to the v2 target

The following are not yet implemented:

- Rust-owned public `fullmag script.py` host,
- Python helper bridge invoked by the Rust host,
- `Study` as a canonical public model layer,
- `StudyIR`,
- session manager,
- session/run API,
- live browser control room,
- GPU/CUDA FDM backend,
- FEM execution,
- remote session model.

## 3. Current architectural gap versus the v2 target

The biggest remaining mismatches are:

1. **launcher ownership**
   - current code: Python package owns the public `fullmag` entrypoint
   - target: Rust host owns `fullmag script.py` and calls Python as a helper

2. **public model shape**
   - current code: `Problem(..., dynamics=..., outputs=...)`
   - target: `Model + Study + Runtime`, with compatibility shim from the old shape

3. **runtime spine**
   - current code: direct run path with artifacts
   - target: session-owned execution with event stream and run API

4. **frontend role**
   - current code: landing page
   - target: `/runs/[id]` as the first real product screen

## 4. Decision on currently active plans

### 4.1 `completed/phase-0-1-implementation-plan.md`

Archive it in `completed/` and treat it as a historical baseline document.

It still matters because it records the first executable solver slice that all later runtime
and GPU work must preserve semantically.

It no longer defines the product shell.

### 4.2 `frontend-architecture.md`

Keep active as the implementation plan for the run-first control room.

It is subordinate to the v2 application reset and must not become a second architecture source.

### 4.3 `phase-2-gpu-fdm-calibrated-rollout.md`

Keep active as the next major backend effort.

But GPU FDM must now be understood as work that lands under the v2 shell:

- Rust-owned launcher,
- session model,
- shared artifacts and provenance,
- browser control room.

### 4.4 `phase-2-gpu-fdm-implementation-playbook.md`

Keep active as the detailed handoff for CUDA work, but subordinate it to the v2 reset.

It must not assume the old Python-owned public launcher model.

## 5. New sequencing under the v2 reset

The project should now move in this order:

1. **docs and source-of-truth cleanup**
   - align all plan files to the v2 concept
   - stop treating older architecture docs as competing truths

2. **runtime shell contract**
   - Rust host for `fullmag script.py`
   - Python helper bridge
   - session model
   - session/run API contract

3. **public model migration**
   - add `Study`
   - add compatibility shim from the old `dynamics/outputs` shape
   - prepare `StudyIR`

4. **control-room shell**
   - `/runs/[id]`
   - event stream
   - artifact adapters
   - browser opener

5. **backend deepening**
   - calibrated GPU FDM
   - FEM after the shell contract is stable

## 6. What stays non-negotiable

These rules remain unchanged:

- Python is still the only public authoring language.
- Rust still owns validation, planning, execution, artifacts, and provenance.
- Physics notes remain mandatory before physics or numerics implementation.
- Current CPU `double` exchange-only FDM remains the trusted semantic baseline.
- GPU `double` parity is required before GPU `single` becomes public-executable.

## 7. Honest answer on Phase 2 status

Phase 2 GPU FDM/CUDA is still not complete.

What exists:

- precision policy,
- CPU reference baseline,
- narrow public CPU execution path,
- rollout and playbook docs.

What does not exist yet:

- production CUDA backend,
- Rust-to-CUDA runner dispatch,
- GPU calibration harness,
- GPU-backed `fullmag script.py` product path,
- session-owned live runtime shell.

## 8. Completed plans archive

`docs/plans/completed/` should remain mostly empty until a plan stops steering current work.

Archiving too early would hide active design constraints and recreate the same documentation drift
that the v2 reset is trying to remove.
