# Workflow: feature-delivery

## Purpose

Deliver a Fullmag feature without letting physics, authoring surfaces, IR, planning, runtime
selection, and backend execution drift apart.

## Steps

1. `physics-first-gate`
2. Python and UI authoring contract work
3. `ProblemIR` and validation work
4. planner, capability, and execution-selection work
5. session/run/API/provenance work
6. backend work
7. validation, smoke, and round-trip coverage
8. update `docs/physics/` with results and deferred work
9. prefer `justfile` build/run/package recipes for verification and user-facing workflow examples

## Exit criteria

- semantics remain aligned across Python, UI, IR, planning, runtime, and backend layers,
- requested and resolved execution truth is documented,
- validation and round-trip expectations are documented,
- deferred work is explicit.
