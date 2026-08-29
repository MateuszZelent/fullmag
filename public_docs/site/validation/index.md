---
title: Validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-root)=
# Validation

Validation is how FullMag separates executed numerical truth from source presence. A solver or lane
is qualified only when an executed gate, a recorded artifact, and an accepted tolerance all agree.
This family records the validation taxonomy, the current qualification state, and what remains open.

## Taxonomy

- **Analytical cases** — known closed-form solutions such as sinusoidal exchange modes, a uniformly
  magnetized sphere, Osborn ellipsoid demagnetization factors, and macrospin damping checkpoints.
- **µMAG standard problems** — community reference problems with published reference outputs,
  primarily NIST µMAG Standard Problem 4 for FEM relaxation and reversal dynamics.
- **CPU/GPU parity** — same-workload agreement between the CPU and GPU execution lanes of one
  backend.
- **FEM/FDM comparison** — cross-discretization agreement where a physical result can be evaluated
  in both backends.

The authoritative per-lane support and qualification matrix lives on
{doc}`qualification-status`; individual pages below describe the cases and their evidence.

## How to read the status

Each page distinguishes:

- **production / qualified** — an executed gate plus recorded artifact passed the acceptance
  tolerance;
- **scripted / runtime-open** — the gate or artifact validator exists, but the executed runtime
  evidence is not yet current;
- **not evaluated** — artifacts do not yet carry a validation decision;
- **unsupported** — the lane rejects the workload instead of silently substituting another path.

Do not promote a lane from the presence of its source, a compiled binary, or a skipped test.

```{toctree}
:maxdepth: 1

analytical-cases
mumag-standard-problems
cpu-gpu-parity
fem-fdm-comparison
qualification-status
```
## Control Room crosswalk

Validation pages are `inspection-only` in Control Room. The UI may expose runtime metadata, fields, tables, or reports for inspection, but it does not create a qualification claim. `TODO: frontend support` applies to validation workflow authoring and report publication unless a specific control is named. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Validation is not a standalone Python constructor unless the linked case page names one. Reproduce the exact case, inputs, device, precision, and receipt described by the page; use the referenced API pages for callable signatures.

## Physics and bibliography scope

The page either states the governing benchmark model or delegates it to the linked physics/numerical-methods page. Any missing derivation is a documented boundary, not an implicit equation. Bibliography and source evidence remain the authoritative references listed by the validation case.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
