---
title: Qualification Status
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-qualification-status)=
# Qualification Status

Qualification is per workload, per lane, and evidence-backed. The table below is the current
production status for the **relaxation** workload; other workloads (time-domain reversal, spectral
response, GPU strict residency) have their own gates and must not inherit relaxation status.

## Relaxation algorithm and lane matrix

| Algorithm | FDM CPU | FDM CUDA | FEM CPU | FEM CUDA | Status |
|---|---|---|---|---|---|
| `llg_overdamped` | qualified | qualified | qualified | qualified | production |
| `projected_gradient_bb` | qualified | qualified for supported payloads | qualified, demag `rtol<=1e-12` | qualified, demag `rtol<=1e-12` | production |
| `nonlinear_cg` | qualified | qualified for supported payloads | qualified, demag `rtol<=1e-12` | qualified, demag `rtol<=1e-12` | production |
| `tangent_plane_implicit` | unsupported | unsupported | development-only (`extended`) | unsupported | development-only, fail-closed elsewhere |

Unsupported heterogeneous CUDA material payloads and unsupported adaptive/tableau combinations fail
capability checks; no lane silently substitutes Heun, CPU execution, another minimizer, or a looser
physical model.

## Evidence basis

The relaxation promotion is backed by the managed production benchmark (`39` comparison pairs,
`21/21` required coverage), managed native source/operator/energy-derivative contracts, and
CPU/GPU consistency `6/6` rows / `3/3` pairs. The public method pages under
{doc}`../numerical-methods/relaxation/index` document the per-algorithm contracts this matrix
summarizes.

## Per-interaction support matrices

Physics and numerical terminal pages own their four-lane FDM/FEM CPU/GPU support and qualification
matrices. Those are the authoritative support status for an interaction; do not use the relaxation
table above to claim an interaction is validated outside relaxation. Start from:

- {doc}`../physics/interactions/index` — canonical interaction pages;
- {doc}`../numerical-methods/index` — method and solver-lane realizations.

## Not yet qualified

- Time-domain NIST SP4 reversal (artifact `not_evaluated` / `unvalidated`).
- GPU strict-residency and hosted CPU/GPU field parity rerun in the CUDA-visible runtime.
- Full FDM↔FEM cross-backend comparison matrix.

These remain open until their dedicated gates pass with recorded artifacts.
