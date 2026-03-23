# Phase 2 Plan: Calibrated GPU FDM Rollout

- Status: active
- Priority: P0
- Last updated: 2026-03-23
- Parent target architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Parent solver architecture: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related plans:
  - `docs/plans/active/implementation-status-and-next-plans-2026-03-23.md`
  - `docs/plans/active/frontend-architecture.md`
  - `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`
- Related physics notes:
  - `docs/physics/0200-llg-exchange-reference-engine.md`
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`

## 1. Purpose

The next backend priority remains clear:

> deliver a calibrated CUDA/FDM backend that preserves the semantics of the current CPU reference
> slice and fits inside the v2 application shell.

This plan exists to make that rollout explicit and honest.

## 2. Current status checkpoint

GPU FDM is not complete.

What exists:

- public CPU reference execution for the narrow exchange-only FDM slice,
- precision policy in Python API, `ProblemIR`, planning, and metadata,
- documentation for GPU precision and calibration.

What does not exist yet:

- production CUDA backend,
- Rust dispatch into CUDA,
- GPU parity and calibration harness,
- GPU-backed session/run shell,
- GPU-backed control-room flow.

## 3. v2-aligned public contract

The product-facing target is still:

```text
fullmag script.py
```

with Rust as the launcher host and Python used through a helper bridge.

The preferred canonical problem shape is moving toward:

```python
Problem(..., study=TimeEvolution(...))
Simulation(problem, backend="fdm", mode="strict", precision="double")
```

Compatibility with the older `Problem(..., dynamics=..., outputs=...)` shape may remain during the
transition, but Phase 2 must not deepen dependence on that older model.

## 4. Non-negotiable rules

1. CUDA must implement the same discrete exchange-only LLG model as the CPU reference.
2. GPU `double` parity is required before GPU `single` becomes public-executable.
3. Precision remains user-visible and explicit.
4. Python API and `ProblemIR` stay backend-neutral.
5. Rust continues to own validation, planning, session state, artifact writing, and provenance.
6. CUDA work must fit under the session/run/control-room model rather than bypassing it.
7. CPU `double` remains in-repo and testable as the calibration baseline.

## 5. Delivery stages

### Stage 2A - freeze runtime-shell compatibility

Before deep CUDA work lands, the runtime contract must be treated as fixed:

- Rust-owned public launcher target,
- Python helper bridge target,
- session-owned execution model,
- runner-owned artifacts and provenance.

This stage is mostly architectural and documentation-driven.

### Stage 2B - native CUDA backend skeleton

Deliver:

- concrete FDM native backend under the existing native backend tree,
- stable FDM ABI,
- context creation and teardown,
- precision-aware backend initialization,
- smoke tests that round-trip state through the backend.

### Stage 2C - GPU `double` exchange operator

Deliver:

- device layout for `m` and `H_ex`,
- exchange field kernel,
- exchange energy computation,
- deterministic parity tests against the CPU reference.

### Stage 2D - GPU `double` Heun stepping

Deliver:

- LLG RHS kernels,
- predictor/corrector stepping,
- renormalization,
- Rust runner dispatch into CUDA,
- identical observable and artifact semantics relative to CPU.

### Stage 2E - GPU `single`

Deliver only after Stage 2D passes:

- `fp32` state path,
- precision-aware context creation,
- qualification against GPU `double`,
- metadata and provenance proving the chosen execution precision.

### Stage 2F - calibration and regression harness

Deliver:

- repeatable CPU/GPU parity cases,
- GPU `single` vs GPU `double` cases,
- stable tolerance policy,
- CI or documented commands for recurring calibration.

### Stage 2G - performance qualification

Deliver:

- profiler-backed kernel studies,
- throughput comparison between CPU `double`, GPU `double`, and GPU `single`,
- evidence that the CUDA path is worth shipping as the product backend.

## 6. Relationship to the application shell

Phase 2 is not a license to ship a backend that only works through an internal path.

The target product flow remains:

1. Rust host receives `fullmag script.py`,
2. Python helper returns `ProblemIR`,
3. Rust validates, plans, and creates a session,
4. runner dispatch selects CPU or CUDA FDM,
5. browser control room and artifacts observe the same run contract.

If shell pieces land after some CUDA internals, the CUDA implementation must still preserve this
shape and must not hard-code an older Python-owned entrypoint model.

## 7. Acceptance criteria

Phase 2 is complete only when all of these are true:

1. GPU `double` runs the narrow FDM slice with parity against CPU `double`,
2. GPU `single` is qualified against GPU `double`,
3. artifact semantics and provenance match the CPU path,
4. the CUDA backend fits under the Rust-owned launcher and session model,
5. the control-room path can observe CUDA-backed runs through the same session/run contract,
6. capability and status docs still honestly distinguish implemented versus planned behavior.

## 8. Explicit non-goals

Do not mix these into Phase 2:

- FEM execution,
- hybrid execution,
- new physics terms,
- new integrators,
- multi-GPU,
- MPI,
- editor-first browser work,
- remote cluster stack.
