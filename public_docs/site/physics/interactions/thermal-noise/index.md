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

This page is the public physical and authoring contract for the interaction. It separates authored
semantics, planner resolution, executable backend lanes, and scientific qualification.

```{figure} /_static/diagrams/thermal-brown-stochastic-llg.svg
:alt: Two-panel diagram of Brown thermal noise in Fullmag: Panel (a) shows the discrete stochastic field formula with bare gamma_{mu0}, accepted-interval raw-draw reuse across rejected adaptive RK retries, FSAL invalidation, and lane constraints; Panel (b) plots the exact Boltzmann equilibrium density P(theta) proportional to sin(theta) exp(xi cos(theta)) against ensemble 95% confidence intervals and contrasts statistical validation against invalid bitwise CPU/GPU comparison.
:width: 100%
:name: fig-thermal-brown-stochastic-llg
:figclass: fm-physics-figure

Discrete Brown stochastic field contract and Boltzmann equilibrium validation. Panel (a) shows the
fluctuation-dissipation standard deviation $\sigma_i^n$ using Fullmag's bare gyromagnetic ratio
$\gamma_{\mu 0}$ (so $1/(1+\alpha^2)$ is applied once by LLG), the accepted-interval raw Gaussian
draw reuse and $\Delta t^{-1/2}$ rescaling contract across rejected steps (Leliaert *et al.* 2017;
implemented in FEM CPU), FSAL invalidation, and recommended fixed-step Heun versus rejected `ABM3`
and adaptive stepping on FDM. Panel (b) plots the
analytical single-spin Boltzmann density $P_{\mathrm{eq}}(\theta)\propto\sin\theta\exp(\xi\cos\theta)$
for $\xi=2.0$ alongside ensemble 95% confidence intervals (Brown 1963; Leliaert *et al.* 2017),
highlighting why cross-device qualification requires statistical moments rather than bitwise sample
identity.
```

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
measure (with nonmagnetic nodes zeroed). There is no standalone $E_{\mathrm{th}}$.

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
how the draw is scaled when the accepted interval changes. In Fullmag's FEM CPU reference sampler,
rejected adaptive attempts reuse the interval's raw draw $\boldsymbol\xi_i^n$ and rescale only
$\sigma_i^n(\Delta t_{\mathrm{retry}})$, while FSAL reuse is disabled across accepted-step
boundaries. A deterministic ODE convergence test does not qualify an SDE implementation.

(physics-thermal-noise-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `ThermalNoise(T, seed)` | partial/reference executable | sampling law not yet full equilibrium qualification | fixed-step Heun recommended (fixed-step `rk4`/`rk23`/`rk45` accepted without SDE qualification; `ABM3` and `adaptive_timestep` rejected); use `H_eff` |
| FDM | GPU | same canonical IR | partial | executed-device variance and replay evidence required | fixed-step Heun recommended (`ABM3` and `adaptive_timestep` rejected; other fixed-step RK methods lack SDE qualification); cuRAND/precision/runtime identity are part of provenance |
| FEM | CPU | same canonical IR | partial/reference executable | nodal-volume and accepted-step statistics required | `mt19937_64` raw-draw reuse across retries; FSAL disabled |
| FEM | GPU | authoring accepted | unsupported in strict public planning | none | rejected pending `CAP-THERM-GPU-001`; kernel source alone is not an executable lane |

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

# %% Brown thermal field and fixed-step Heun physical-time stage
study.exchange()
study.thermal_noise(temperature=300.0, seed=123)
study.solver(integrator="heun", fix_dt=1.0e-15)
study.stages.add_run(stage_id="thermalize", until=1.0e-12)
```

Use a physical-time stage, not deterministic energy minimization. A direct `H_therm` output is
rejected in the current FDM CPU/GPU observable contract; `H_eff` is the safer portable field
observable at the audited revision. For exact constructor arguments on `fm.ThermalNoise`, see
{doc}`/python-api/interactions/thermal-noise`.

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

(physics-thermal-noise-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored `temperature` in kelvin, optional positive `seed` (or
explicit entropy policy when omitted), and execution request. Resolved execution records the
selected solver, device, precision, integrator, RNG policy, and capability decision. Validation errors
reject non-positive or non-finite temperatures, `seed=0`, conflicting `Problem.temperature`
values, and duplicate `ThermalNoise` terms before runtime. Unsupported combinations (such as
strict FEM GPU pending `CAP-THERM-GPU-001`, `ABM3` or `adaptive_timestep` with thermal noise on
FDM, `H_therm` field exports on FDM, or multilayer FDM thermal execution) fail closed and are
never silently omitted or replaced by deterministic evolution.

(physics-thermal-noise-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization (`packages/fullmag-py/src/fullmag/model/energy.py`,
`world.py`), `ProblemIR` owns canonical intent, planners (`crates/fullmag-plan/src/fdm.rs`,
`fem.rs`) enforce temperature/seed consistency, integrator legality, and lane gates, and backend
solvers own stochastic field sampling, raw-draw caching, and FSAL invalidation. Control Room
parameter exposure is tracked in {doc}`/frontend/capability-register`; do not infer UI controls
from backend or Python availability.

(physics-thermal-noise-limitations)=
## Limitations and recommended extensions

The model does not provide longitudinal thermal fluctuations, temperature-dependent material
laws, heat transport, or LLB dynamics near $T_C$. These require separate coupled physics
contracts.

(physics-thermal-noise-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., "Thermal Fluctuations of a Single-Domain Particle," *Physical Review*
   **130**(5), 1677–1686 (1963),
   [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
2. J. L. García-Palacios and F. J. Lázaro, "Langevin-dynamics study of the dynamical properties
   of small magnetic particles," *Physical Review B* **58**(22), 14937–14958 (1998),
   [doi:10.1103/PhysRevB.58.14937](https://doi.org/10.1103/PhysRevB.58.14937).
3. J. Leliaert, J. Mulkers, J. De Clercq, A. Coene, M. Dvornik, and B. Van Waeyenberge,
   "Adaptively time stepping the stochastic Landau-Lifshitz-Gilbert equation at nonzero
   temperature: Implementation and validation in MuMax3," *AIP Advances* **7**(12) (2017),
   [doi:10.1063/1.5003957](https://doi.org/10.1063/1.5003957)
   (CC-BY OA, [arXiv:1709.01682](https://arxiv.org/abs/1709.01682)).
4. J. Leliaert, M. Dvornik, J. Mulkers, J. De Clercq, M. V. Milošević, and B. Van Waeyenberge,
   "Fast micromagnetic simulations on GPU—recent advances made with MuMax3," *Journal of Physics D:
   Applied Physics* **51**(12), 123002 (2018),
   [doi:10.1088/1361-6463/aaab1c](https://doi.org/10.1088/1361-6463/aaab1c)
   (CC-BY OA).

(physics-thermal-noise-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class ThermalNoise` | public temperature/seed contract |
| `packages/fullmag-py/src/fullmag/world.py` | `thermal_noise` | stage-first registration |
| `crates/fullmag-plan/src/fdm.rs` | `thermal planning` | FDM lane and seed policy |
| `crates/fullmag-plan/src/fem.rs` | `thermal planning` | FEM lane and capability rejection |
| `crates/fullmag-engine/src` | `Brown field sampling` | CPU reference routines |
| `backends/fdm/gpu/cuda/interactions` | `thermal field kernels` | FDM GPU sampling |
| `backends/fem/cpu/mfem` | `thermal sampler` | FEM CPU nodal realization |
| `backends/fem/gpu/cuda` | `thermal source` | non-promoting source evidence |
