---
title: µMAG Standard Problems
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-mumag-standard-problems)=
# µMAG Standard Problems

µMAG standard problems are community reference benchmarks with published reference outputs.
FullMag's primary standard-problem target is **NIST µMAG Standard Problem 4** (SP4), solved with
the strict FEM backend in double precision.

## Problem definition

SP4 is a $500 \times 125 \times 3\ \mathrm{nm}$ permalloy film with saturation magnetization
$M_s = 800\,000\ \mathrm{A\,m^{-1}}$, exchange stiffness $A_{\mathrm{ex}} = 1.3 \times
10^{-11}\ \mathrm{J\,m^{-1}}$, and damping $\alpha = 0.02$. An S-shaped magnetization state is
relaxed, then one of two applied fields drives a dynamic reversal:

- field 1: $\mathbf{B} = (-24.6, 4.3, 0)\ \mathrm{mT}$;
- field 2: $\mathbf{B} = (-35.5, -6.3, 0)\ \mathrm{mT}$.

The canonical observable is the volume-weighted average of the reduced magnetization; the first
zero-crossing of $\bar m_x$ is compared against the NIST reference corpus (NIST is authoritative,
MuMax3/OOMMF endpoint values are supplementary regression metrics only).

## FullMag setup

- Meshes: magnetic element sizes $3.0$, $2.0$ and $1.5\ \mathrm{nm}$; airboxes $700^3\ \mathrm{nm}$
  and $1000 \times 500 \times 500\ \mathrm{nm}$ with `airbox_hmax = 20 nm`.
- Lanes: strict FEM CPU and strict FEM GPU in double precision; GPU demagnetization must resolve to
  `device_hypre_poisson`, never `hybrid_cpu_poisson`.
- Observables use native $M_s \times V$ lumped-volume averages from `scalars.csv`; unweighted node
  averages are not accepted as the NIST observable.
- Uninterrupted trajectories are sampled every $1\ \mathrm{ps}$; replay runs start from the same
  S-state and stop at the bracketing zero-crossing.

The public stage scenario is
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`, and the managed
gate is:

```console
just verify-fem-standard-problem-4
```

## Current status

Relaxed S-state and reversal-run artifacts exist for FEM CPU and FEM GPU
(coarse/baseline). The time-domain `qualification` record currently reports
`not_evaluated` / `unvalidated` for the adaptive RK runs: artifact creation alone is not evidence
of validation, and the dedicated NIST/convergence/CPU-GPU/no-fallback gate has not yet been
closed. Do not treat this page as a claim that SP4 is physics-validated.

SP4 acceptance requires, per lane: NIST trajectory agreement, mesh and airbox convergence,
CPU/GPU parity within the documented tolerances, and no silent fallback. Status advances only
when the full managed gate passes.
