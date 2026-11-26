---
title: Validation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-root)=
# Validation

Validation is how FullMag separates executed numerical truth from source presence. A solver,
interaction, or execution lane is qualified only when an executed gate, a recorded artifact bound
to the active source revision and device identity, and an accepted tolerance all agree. Neither
source presence, nor compilation, nor skipped tests, nor superseded historical snapshots can promote
a lane.

## Validation tracks

FullMag organizes numerical verification into five complementary tracks:

| Track | Scope | Representative benchmarks and gates | Reference page |
|---|---|---|---|
| **Analytical cases** | Closed-form continuum and algebraic oracles independent of external micromagnetic codes | Aharoni (1998) exact rectangular prism demagnetization ($300\times 300\times 5\;\mathrm{nm}$ Permalloy), exchange sinusoidal Laplacian mode, uniformly magnetized sphere, Osborn ellipsoid demagnetization factors, macrospin LLG/STT/DMI/thermal contracts, modal Kittel and Kalinikos–Slavin dispersion ({doc}`../numerical-methods/eigensolvers/modal-validation`), and research-only quasistatic / full-wave FIT surface gap-port contracts | {doc}`analytical-cases` |
| **µMAG standard problems** | Community micromagnetic benchmarks and external-solver dispersion harnesses | NIST µMAG Standard Problem 4 (strict FEM and FDM relaxation and dynamic reversal), bounded µMAG Standard Problem 5 FDM CPU/CUDA FP64 fixed-step `converged_demag` qualification, and the COMSOL-aligned nonzero-$k$ spin-wave dispersion harness | {doc}`mumag-standard-problems` |
| **CPU/GPU parity** | Same-discretization agreement and strict device residency across CPU and GPU lanes | November 2026 RTX 4080 SUPER (SM 8.9) and RTX 5050 A/B parity campaigns covering FDM CUDA core (PR #561), FDM STT/SHE/M1 (PR #562), FEM GPU core demag and time-stepping (PR #550 / #564), FEM `pure_prism_p2` and unified CSR DMI (PR #577), FEM Wave 3 PGBB/kernels/driven response (PR #578), FEM Wave 2 multiphysics (PR #567), and guarded GPU modal eigensolvers (PR #539 / #558) | {doc}`cpu-gpu-parity` |
| **FEM/FDM comparison** | Cross-discretization physics agreement and backend state transfer | $300\times 300\times 5\;\mathrm{nm}$ Permalloy thin-film cross-backend comparison (Aharoni, FullMag FDM GPU, MuMax3 3.12, FEM `tet P2`, `mixed prism P1`, and `pure_prism_p2`), 4-lane µMAG SP4 relaxation comparison, periodic airbox supercell consistency, and conservative FDM $\leftrightarrow$ FEM state transfer | {doc}`fem-fdm-comparison` |
| **Qualification governance** | Authoritative fail-closed 4-lane `(FDM CPU / FDM GPU / FEM CPU / FEM GPU)` support and release-readiness ledger | Capability matrix synchronization, universal relaxation gate (`FM-RELAX-017`) versus per-feature A/B receipts, `frozen_spins.v1` contract and runtime evidence, and explicit open gaps | {doc}`qualification-status` |

## Evidence levels and status governance

Every validation page applies the same fail-closed evidence ladder:

- **qualified / production_executable** — an executed managed gate plus recorded source- and
  device-bound artifact passed its acceptance tolerance with zero silent fallback;
- **bounded / partial_production_executable** — executable and verified only for the explicitly
  documented workload tuple (for example, fixed-step FP64 SP5 `converged_demag` or bounded single-grid
  M1 charge), with wider scopes failing closed;
- **reference_executable / development_executable** — executable on the named reference or
  development lane (or backed by targeted A/B verification receipts), but not yet closed under a
  universal cross-lane release matrix;
- **source-backed / implemented / unvalidated** — API, IR, planner, or native contract tests exist
  in source, while full managed runtime or scientific convergence evidence remains open;
- **unsupported** — the lane rejects the workload before execution instead of silently substituting
  CPU execution, a looser tolerance, or a different physical model.

Do not promote a lane from the presence of source code, a compiled binary, a skipped test, or a
superseded historical snapshot.

## Related performance benchmarks

Hardware speedups, memory footprints, solver architectures (`cuFFT` D2Z/R2C, device-resident
`native_cuda_pgbb`, `cuDSS` direct Poisson/FEM-BEM/PBC/driven-response/modal solvers,
`bb_exchange_mass`, fused short-range CUDA kernels, and Wave 2 multiphysics sparse solvers) are
documented alongside their mathematical formulations in {ref}`numerical-methods-performance`.

```{toctree}
:maxdepth: 1

analytical-cases
mumag-standard-problems
cpu-gpu-parity
fem-fdm-comparison
qualification-status
```
