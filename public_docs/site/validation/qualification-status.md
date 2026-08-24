---
title: Qualification Status
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/capability-matrix-v0.json
---

(public-docs-validation-qualification-status)=
# Qualification Status

Qualification is per workload, per lane, and evidence-backed. The table below is the current
availability and validation status for the **relaxation** workload. Other workloads, including
time-domain reversal, spectral response, and GPU strict residency, have independent gates and must
not inherit relaxation status.

## Relaxation algorithm and lane matrix

| Algorithm | FDM CPU | FDM CUDA | FEM CPU | FEM CUDA | Validation |
|---|---|---|---|---|---|
| `llg_overdamped` | `reference_executable` | `development_executable` | `development_executable` | `development_executable` | unvalidated |
| `projected_gradient_bb` | `reference_executable` | `development_executable` | `development_executable` | `development_executable` | unvalidated |
| `nonlinear_cg` | `reference_executable` | `development_executable` | `development_executable` | `development_executable` | unvalidated |
| `tangent_plane_implicit` | unsupported | unsupported | `development_executable` (`extended`) | unsupported | unvalidated |

Unsupported heterogeneous CUDA material payloads and unsupported adaptive/tableau combinations fail
capability checks. No lane may silently substitute Heun, CPU execution, another minimizer, or a
looser physical model.

## Evidence basis

The authoritative capability matrix was updated on 2026-08-20 after a fail-closed relaxation audit.
It records no current validated relaxation workload because exact source-bound managed receipts are
missing. The older 2026-07-11 report's production labels and benchmark counts are historical and
must not promote a lane. Source and contract tests remain useful regression evidence, but they are
not substitutes for managed runtime, device, parity, or scientific receipts. The public method pages
under {doc}`../numerical-methods/relaxation/index` document the per-algorithm contracts.

## Per-interaction support matrices

Physics and numerical terminal pages own their four-lane FDM/FEM CPU/GPU support and qualification
matrices. Those are the authoritative support status for an interaction; do not use the relaxation
table above to claim an interaction is validated outside relaxation. Start from:

- {doc}`../physics/interactions/index` - canonical interaction pages;
- {doc}`../numerical-methods/index` - method and solver-lane realizations.

## Not yet qualified

- Fresh source-bound relaxation receipts for every legal FDM/FEM CPU/GPU algorithm lane.
- Time-domain NIST SP4 reversal.
- GPU strict-residency and hosted CPU/GPU field parity rerun in the CUDA-visible runtime.
- Full FDM-to-FEM cross-backend comparison matrix.

These remain open until their dedicated gates pass with recorded artifacts.
