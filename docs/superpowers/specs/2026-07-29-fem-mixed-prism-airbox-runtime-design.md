# Bounded FEM Mixed Prism-Airbox Runtime Gate Design

## Status

Approved for implementation on 2026-07-29. The requested design is the
minimal CPU-only precursor gate described in the independent review
remediation; it does not promote a capability.

## Goal

Prove that the exact checked-in FEM SP4 mixed prism/pyramid shared-domain
scenario crosses the existing managed CPU headless path for one executed
relaxation step without fallback, while leaving the authored scenario defaults
unchanged.

## Design

The gate has two small units:

1. A Python verifier reads the canonical scenario and requires exactly one
   literal `max_steps=50_000`. Its prepare mode replaces that single occurrence
   with `max_steps=1` in a generated temporary copy and never writes the
   canonical source.
2. A `just verify-fem-mixed-prism-airbox-runtime` recipe invokes the existing
   `fem-managed-headless cpu` route on that temporary copy and an explicit
   artifact directory. The verifier's validation mode then writes a bounded
   immutable summary after checking authored `auto`, managed CPU override
   source, effective strict FEM CPU double request, `fem_cpu_native`, no lossy
   or resolved fallback, exact mixed topology/certificate fingerprint identity,
   empty report and certificate fallback trails, `degraded=false`, one executed
   step, and finite energy/torque data.

The recipe preserves the generated source bytes beside the summary so the
executed source hash is reproducible. It uses the repository-owned managed
runtime route and does not assemble host or Docker commands independently.

## Failure semantics

Every missing or malformed field fails the validator. Zero or multiple
`max_steps=50_000` occurrences fail preparation. A stale fingerprint,
unaccepted certificate, non-empty fallback trail, degraded report, non-CPU
engine, wrong step count, or non-finite observable prevents summary creation
and returns non-zero. No fallback or capability promotion is permitted.

## Verification

Unit tests cover the exact checked-in scenario's one-occurrence rewrite without
source mutation and fail-closed preparation. Synthetic artifact tests cover the
accepted contract and mutations of authored/managed/effective device identity,
engine/fallback, certificate fingerprint/report state, step count, and finite
energy/torque. The ordinary API suite checks base and relaxation-stage overlay
propagation without real assets; the standalone real-asset helper export is an
explicit `FULLMAG_RUN_SLOW_REAL_ASSET_TESTS=1` diagnostic. The non-skipping
managed recipe is the authoritative exact-source runtime gate and remains
unexecuted until the root task runs it after this precursor lands.
