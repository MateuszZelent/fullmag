---
title: FEM FDM Comparison
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/validation/fem_cpu_validation_matrix.md, docs/specs/capability-matrix-v0.json
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

The recorded artifact is supporting historical evidence for the diagnostic FEM periodic-airbox
slice. It does not promote periodic FEM demagnetization or any cross-backend lane to production
qualification.

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
