# Workflow: feature-delivery

## Purpose

Deliver a Fullmag feature without letting physics, authoring surfaces, IR, planning, runtime
selection, and backend execution drift apart.

## Steps

1. Run `physics-first-gate` when physics or numerics semantics change.
2. Update or add the relevant architecture/spec note when product architecture changes.
3. Run `resource-first-api-check` when the live API, control room, OpenAPI contract, or frontend
   data flow changes.
4. Python and UI authoring contract work
5. `ProblemIR` and validation work
6. planner, capability, and execution-selection work
7. session/run/API/provenance work
8. backend work
9. validation, smoke, and round-trip coverage
10. update `docs/physics/` with results and deferred work
11. prefer `justfile` build/run/package recipes for verification and user-facing workflow examples

## Exit criteria

- semantics remain aligned across Python, UI, IR, planning, runtime, and backend layers,
- control-room/API changes preserve the resource-first contract,
- requested and resolved execution truth is documented,
- validation and round-trip expectations are documented,
- deferred work is explicit.
