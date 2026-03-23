# Capability matrix v0

## Purpose

The capability matrix answers two questions before execution:

1. Is a Python-authored `ProblemIR` legal for the requested backend and mode?
2. If it is legal, what planning path should be selected?

## Current bootstrap policy

- `strict` means backend-neutral semantics only.
- `extended` is reserved for future backend-specific features.
- `hybrid` is explicit and requires both hybrid mode and hybrid backend.

## Bootstrap matrix

| Feature | FDM | FEM | Hybrid | Modes | Notes |
|---------|-----|-----|--------|-------|-------|
| Imported geometry reference | planned | planned | planned | strict, extended, hybrid | Shared semantics only |
| Material constants (`Ms`, `A`, `alpha`, `Ku1`, `anisU`) | planned | planned | planned | strict, extended, hybrid | Serialized in canonical IR |
| Ferromagnet + uniform `m0` | planned | planned | planned | strict, extended, hybrid | Shared bootstrap surface |
| `Exchange` | planned | planned | planned | strict, extended, hybrid | Shared term; internal CPU/FDM reference operator exists, public lowering still pending |
| `Demag` | planned | planned | planned | strict, extended, hybrid | Planned, not numerically implemented |
| `InterfacialDMI` | planned | planned | planned | strict, extended, hybrid | Planned, not numerically implemented |
| `Zeeman` | planned | planned | planned | strict, extended, hybrid | Planned, not numerically implemented |
| `LLG` | planned | planned | planned | strict, extended, hybrid | Shared semantics defined; internal Heun-based CPU/FDM reference stepper exists, public lowering still pending |
| Field/scalar outputs | planned | planned | planned | strict, extended, hybrid | Canonical output naming only |
| FDM hints | planned | n/a | planned | strict, extended | Shared hints, backend-specific use later |
| FEM hints | n/a | planned | planned | strict, extended | Shared hints, backend-specific use later |
| Hybrid hints | n/a | n/a | planned | hybrid | Requires hybrid mode and backend |

## Early planner rules

- `backend="auto"` resolves to `fdm` for `strict` and `extended` during bootstrap planning.
- `backend="auto"` does not resolve hybrid implicitly.
- Hybrid planning is a deliberate opt-in, not a fallback.
