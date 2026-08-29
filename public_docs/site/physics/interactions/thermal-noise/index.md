---
title: Thermal Brown noise
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-thermal-noise-root)=
# Thermal Brown noise

Thermal Brown noise is a stochastic effective-field source used during LLG dynamics. It is not a
deterministic energy term and must be qualified statistically rather than by trajectory equality
alone.

(physics-thermal-noise-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-thermal-noise-governing-equations)=
## Governing equations

For magnetic degree of freedom $i$ and accepted stochastic interval $n$,

```{math}
:label: eq-public-thermal-noise-thermal-field
\mathbf H_{\mathrm{th},i}^{\,n}
=
\sigma_i^n\boldsymbol\xi_i^n,
\qquad
\boldsymbol\xi_i^n\sim\mathcal N(\mathbf 0,\mathbf I_3),
```

with the implemented one-step amplitude

```{math}
:label: eq-public-thermal-noise-thermal-amplitude
\sigma_i^n
=
\sqrt{
\frac{2\alpha_i k_{\mathrm B}T}
{\gamma_{\mu0}\mu_0M_{s,i}V_i\Delta t_n}
}.
```

The bare gyromagnetic input $\gamma_{\mu0}$ belongs in this denominator. The surrounding LLG
implementation applies its Gilbert convention once; the thermal module must not apply an
additional $1/(1+\alpha^2)$ reduction.

```{math}
:label: eq-public-thermal-noise-thermal-covariance
\left\langle
H_{\mathrm{th},i,a}^{\,n}H_{\mathrm{th},j,b}^{\,m}
\right\rangle
=
(\sigma_i^n)^2\delta_{ij}\delta_{ab}\delta_{nm}.
```

For FDM, $V_i=\Delta x\Delta y\Delta z$. FEM uses a documented nodal volume or mass-lumping
measure. There is no standalone $E_{\mathrm{th}}$.

(physics-thermal-noise-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $T$ | temperature | $\mathrm K$ |
| $\alpha$ | Gilbert damping | $1$ |
| $k_{\mathrm B}$ | Boltzmann constant | $\mathrm{J\,K^{-1}}$ |
| $\gamma_{\mu0}$ | bare gyromagnetic input used by Fullmag | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $V_i$ | cell or nodal volume | $\mathrm{m^3}$ |
| $\Delta t_n$ | stochastic interval | $\mathrm s$ |
| $\mathbf H_{\mathrm{th}}$ | sampled thermal field | $\mathrm{A\,m^{-1}}$ |

(physics-thermal-noise-assumptions-and-validity)=
## Stochastic integration contract

A fixed seed defines requested replay policy, not universal cross-device bitwise identity.
Adaptive integrators must specify whether rejected trials reuse the same raw Gaussian draw and
how the draw is scaled when the accepted interval changes. A deterministic ODE convergence test
does not qualify an SDE implementation.

(physics-thermal-noise-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `ThermalNoise(T, seed)` | partial/reference executable | sampling law not yet full equilibrium qualification | counter-based/random stream and active-cell policy |
| FDM | GPU | same canonical IR | partial | executed-device variance and replay evidence required | cuRAND/precision/runtime identity are part of provenance |
| FEM | CPU | same canonical IR | partial/reference executable | nodal-volume and accepted-step statistics required | raw-draw reuse policy must be explicit |
| FEM | GPU | authoring accepted | unsupported in strict public planning | none | kernel source alone is not an executable lane |

(physics-thermal-noise-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("thermal_noise_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.thermal_noise(temperature=300.0, seed=123)
study.solver(integrator="heun", fix_dt=1.0e-15)
study.stages.add_run(stage_id="thermalize", until=1.0e-12)
```

Use a physical-time stage, not deterministic energy minimization. A direct `H_therm` output is
lane-dependent; `H_eff` is the safer portable field observable at the audited revision.

(physics-thermal-noise-problem-ir)=
## ProblemIR

```json
{"kind": "thermal_noise", "temperature": 300.0, "seed": 123}
```

Omitting `seed` requests system entropy. `seed=0` is not the same state and is rejected.

(physics-thermal-noise-validation)=
## Validation boundary and code hardening

`ThermalNoise.temperature` is required positive. The current Python annotation says `seed:
int | None`, but runtime type enforcement is incomplete: positive non-integer values and booleans
can pass the constructor's `seed <= 0` check. Replace this with an explicit positive-integer
validator and document the exact accepted range. Planner checks remain responsible for lane,
volume, timestep, material fields, and random-state availability.

## Required numerical validation

- component mean compatible with zero;
- variance proportional to $T$, $\alpha$, $1/V$, and $1/\Delta t$;
- vanishing cross-component and cross-cell covariance;
- fixed-seed replay within one explicitly defined lane;
- rejected-step raw-draw reuse tests;
- macrospin equilibrium distribution and detailed-balance checks;
- timestep refinement under the selected stochastic interpretation;
- CPU/GPU statistical equivalence using confidence intervals, not sample equality.

(physics-thermal-noise-limitations)=
## Limitations and recommended extensions

The model does not provide longitudinal thermal fluctuations, temperature-dependent material
laws, heat transport, or LLB dynamics near $T_C$. These require separate coupled physics
contracts.

(physics-thermal-noise-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown, *Physical Review* **130**, 1677–1686 (1963),
   DOI: 10.1103/PhysRev.130.1677.
2. J. L. García-Palacios and F. J. Lázaro, *Physical Review B* **58**, 14937 (1998).

(physics-thermal-noise-source-code-index)=

## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-thermal-noise-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `ThermalNoise` | public temperature/seed contract |
| `packages/fullmag-py/src/fullmag/world.py` | `thermal_noise` | stage-first registration |
| `crates/fullmag-plan/src/fdm.rs` | `thermal planning` | FDM lane and seed policy |
| `crates/fullmag-plan/src/fem.rs` | `thermal planning` | FEM lane and capability rejection |
| `crates/fullmag-engine/src` | `Brown field sampling` | CPU reference routines |
| `backends/fdm/gpu/cuda/interactions` | `thermal field kernels` | FDM GPU sampling |
| `backends/fem/cpu/mfem` | `thermal sampler` | FEM CPU nodal realization |
| `backends/fem/gpu/cuda` | `thermal source` | non-promoting source evidence |

(physics-thermal-noise-round-trip-and-failure-semantics)=
