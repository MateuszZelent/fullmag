---
applyTo: "**"
description: "Use when implementing or discussing any physics, numerics, backend term, validation, mesh logic, or solver feature in Fullmag. docs/physics documentation is mandatory before coding."
---

> **Canonical source: [`AGENTS.md`](../../AGENTS.md)** — this file adds context-scoped detail.

# Physics-first implementation instructions

- Before implementing a physics or numerical feature, ensure there is a corresponding note in `docs/physics/`.
- The note must describe equations, symbols, SI units, assumptions, backend interpretation, API/IR impact, and validation strategy.
- If the feature differs across FDM, FEM, and hybrid semantics, those differences must be explicit.
- Missing physics documentation is a blocker.
- After implementation, update the same note with validation status and deferred work.
