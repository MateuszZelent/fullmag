# Phase 0-1 Implementation Plan: Historical CPU/FDM Baseline

- Status: archived historical baseline under the v2 reset
- Last updated: 2026-03-23
- Parent target architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Parent solver architecture: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Audit note: `docs/plans/active/implementation-status-and-next-plans-2026-03-23.md`

## 1. Why this file still exists

This plan no longer defines the target product shell.

It remains active because it records the first executable solver slice that the new application
shell must preserve:

> `Box + one ferromagnet + Exchange + LLG(heun) + fdm/strict + CPU double reference`

The v2 reset builds on this slice.
It does not discard it.

## 2. What Phase 0-1 delivered

Phase 0-1 delivered the first honest executable baseline:

- embedded Python authoring API,
- analytic geometry support for the narrow FDM path,
- initial magnetization policies needed for exchange-only tests,
- typed `ProblemIR`,
- typed `ExecutionPlanIR`,
- public CPU/FDM execution through Python runtime,
- canonical observable names for the narrow subset,
- artifacts and provenance for the current bootstrap path.

This baseline is still the semantic reference for later work.

## 3. What remains reusable from this plan

The following contracts remain valid and should not be weakened:

1. the narrow executable subset is explicit and honestly bounded,
2. unsupported combinations fail explicitly,
3. output names stay canonical and backend-neutral,
4. CPU `double` remains the semantic calibration baseline,
5. physics-first documentation gates remain mandatory.

## 4. What is now outdated in this plan

The original Phase 0-1 execution model assumed an older application shape.

These assumptions are now outdated under the v2 reset:

- the public launcher being Python-owned,
- the public model being only `Problem + Runtime`,
- no dedicated `Study` layer,
- no session spine,
- no run-first browser control room as part of the normal product flow.

Those topics are now governed by the v2 target architecture and the active runtime/frontend plans.

## 5. How to use this file now

Use this document for:

- the historical definition of the first executable solver slice,
- CPU/FDM baseline constraints that GPU/FDM must preserve,
- reference acceptance scope for exchange-only FDM.

Do not use this document for:

- current launcher ownership decisions,
- session/run API design,
- browser-control-room decisions,
- the top-level application hierarchy.

## 6. Successor plans

Work that used to be implied by this document is now split as follows:

- application reset and target product model:
  - `docs/specs/fullmag-application-architecture-v2.md`
- current-state audit and sequencing:
  - `docs/plans/active/implementation-status-and-next-plans-2026-03-23.md`
- runtime shell and control room:
  - `docs/plans/active/frontend-architecture.md`
- calibrated CUDA/FDM rollout:
  - `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`
- detailed CUDA/FDM handoff:
  - `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`

## 7. Frozen baseline acceptance statement

Phase 0-1 should be treated as successful only in this limited sense:

- the repository has one honest public executable path,
- that path is scientifically narrow but real,
- all later runtime-shell and GPU work must preserve its semantics unless a physics note and spec
  explicitly change them.
