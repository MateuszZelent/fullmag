---
title: FEM FDM Comparison
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-fem-fdm-comparison)=
# FEM/FDM comparison

FEM and FDM are two realizations of one physical problem, so FullMag expects them to agree on
physics where a shared observable exists. The public contract separates what is genuinely compared
from what is still an individual-realization check.

## Shared physical contract

Both backends lower the same `ProblemIR`: the same LLG equation, the same energy effective-field
definition, and the same interaction parameters. A comparison is meaningful only when the occupied
geometry, material and observable are identical and only the discretization differs.

## Periodic demagnetization supercell check

The periodic airbox demagnetization validation compares the primitive periodic-cell magnetostatic
energy against a central-cell periodic-supercell reference. The recorded primitive-vs-central-cell
energy relative error is `2.4168e-3` against a `2.0e-2` tolerance, with lateral seam metrics at
`0.0` and `robin_periodic_seam_face_count = 0` (`tests/fem_demag_validation/periodic_airbox_validation.py`).
This is a FEM-side periodic consistency check, not yet a full FDM↔FEM cross-backend matrix.

## State transfer between backends

Backend continuation transfers Cartesian cell-centred FDM magnetization onto a FEM mesh, and FEM
nodal fields back onto FDM cell centres, with trilinear/P1 interpolation and explicit
outside-domain semantics. The transfer pages are:
{doc}`../numerical-methods/interpolation-and-state-transfer/fdm-to-fem` and
{doc}`../numerical-methods/interpolation-and-state-transfer/fem-to-fdm`.

## Current status

A complete FDM↔FEM differential comparison matrix (same standard problem, same tolerance, both
backends, recorded artifacts) is not yet published. Do not infer FDM/FEM parity from the presence
of both solvers, from state-transfer support, or from individual-lane checks above.
## Control Room crosswalk

Validation pages are `inspection-only` in Control Room. The UI may expose runtime metadata, fields, tables, or reports for inspection, but it does not create a qualification claim. `TODO: frontend support` applies to validation workflow authoring and report publication unless a specific control is named. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Validation is not a standalone Python constructor unless the linked case page names one. Reproduce the exact case, inputs, device, precision, and receipt described by the page; use the referenced API pages for callable signatures.

## Physics and bibliography scope

The page either states the governing benchmark model or delegates it to the linked physics/numerical-methods page. Any missing derivation is a documented boundary, not an implicit equation. Bibliography and source evidence remain the authoritative references listed by the validation case.
## Source-code index

- No standalone implementation function is introduced by this validation page. Source evidence is the exact API, managed recipe, runtime manifest, and receipt named by the validation case.

