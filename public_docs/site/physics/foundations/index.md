---
title: Physics foundations
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/units.md
---

(public-docs-physics-foundations-root)=
# Physics foundations

These pages define the shared physical contract that every FullMag interaction, solver
backend, and observable must satisfy. They are not interaction-specific; instead they
establish the conventions, equations, and quantities that the interaction pages build upon.

Start with {doc}`conventions-and-units` for the SI unit table and solver-field naming, then
read {doc}`micromagnetic-energy` for the total energy and variational principle, and
{doc}`effective-field` for the field vs. torque distinction (illustrated in
{numref}`fig-effective-field-and-direct-torque-composition`). The {doc}`llg-equation` page
defines the equation of motion ({numref}`fig-llg-precession-damping-sphere`).
{doc}`boundary-conditions` covers the boundary-condition types shared across interactions
({numref}`fig-micromagnetic-boundary-conditions-overview`). {doc}`observables` documents the
output, legality, and volume-reduction system ({numref}`fig-observables-materialization-pipeline`).

## Summary of foundational contracts

| Foundation Page | Core Mathematical Contract | Associated Overview Figure |
|---|---|---|
| {doc}`conventions-and-units` | Reduced magnetization $\mathbf{m}=\mathbf{M}/M_s$, $\gamma_{\mu_0}$, SI units | {numref}`fig-fullmag-object-interaction-architecture` — Object & `ProblemIR` flow |
| {doc}`micromagnetic-energy` | Total energy $E[\mathbf{m}] = \sum_{k\in\mathcal{K}} E_k[\mathbf{m}]$ and variational law | {numref}`fig-effective-field-and-direct-torque-composition` — Energy-to-field variation |
| {doc}`effective-field` | Conservative $\mathbf{H}_{\mathrm{eff}}=\sum\mathbf{H}_k$ vs. direct $\boldsymbol{\tau}_{\mathrm{direct}}$ | {numref}`fig-effective-field-and-direct-torque-composition` — Field vs. direct torque |
| {doc}`llg-equation` | Explicit LLG dynamics, $s_{\mathrm{prec}}\in\{0,1\}$, dissipation & RK sphere projection | {numref}`fig-llg-precession-damping-sphere` — Precession & damping on $\mathbb{S}^2$ |
| {doc}`boundary-conditions` | Free Neumann, chiral DMI, FDM/FEM periodic ($P^T A P$), Floquet, frozen spins, absorbing layers, airbox & mechanical BCs | {numref}`fig-micromagnetic-boundary-conditions-overview` — Boundary-condition regimes |
| {doc}`observables` | Accepted-step sampling, 56-entry quantity catalog, planar monitors, legality gate, airbox-excluding reductions | {numref}`fig-observables-materialization-pipeline` — Sampling & legality gate |

For solver- and device-level acceleration architecture across CPU and CUDA lanes (including cuFFT, `cuDSS`, FSAL, preconditioning, and fused kernels), see {ref}`numerical-methods-performance`.

```{toctree}
:maxdepth: 1

conventions-and-units
micromagnetic-energy
effective-field
llg-equation
boundary-conditions
observables
```
