---
title: Thermal Noise Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Thermal noise

(public-docs-python-api-interactions-thermal-noise)=
(python-api-interactions-thermal-noise-problem-statement)=
## Problem statement

Temperature and optional reproducibility seed are explicit stochastic inputs.

This page covers the Python authoring contract: construction validates the strictly positive bath temperature and optional reproducibility seed in Python, while `to_ir()` emits the canonical `ProblemIR` record before stochastic integration.

(python-api-interactions-thermal-noise-governing-equations)=
## Governing equations

Stochastic Langevin micromagnetics adds a Gaussian-distributed thermal fluctuation field $\mathbf{H}_{\mathrm{th}}(\mathbf{x}, t)$ whose variance satisfies the fluctuation-dissipation theorem proportional to bath temperature $T$ and cell/nodal volume: $\langle H_{\mathrm{th},i}(\mathbf{x}, t) H_{\mathrm{th},j}(\mathbf{x}', t')\rangle = \frac{2\alpha k_{\mathrm{B}} T}{\gamma_0 \mu_0 M_s V}\,\delta_{ij}\delta(\mathbf{x}-\mathbf{x}')\delta(t-t')$. Continuum equations and stochastic solver contracts are documented in {doc}`../../physics/interactions/thermal-noise/index`.

(python-api-interactions-thermal-noise-symbols-and-si-units)=
## Symbols and SI units

Bath `temperature` ($T$) is authored in kelvin ($\mathrm{K}$). The stochastic PRNG `seed` is a dimensionless positive integer ($1$); physical noise variance scales with $\mathrm{A^2\,m^{-2}\,s^{-1}}$ via Boltzmann's constant $k_{\mathrm{B}}$ in $\mathrm{J\,K^{-1}}$.

(python-api-interactions-thermal-noise-assumptions-and-validity)=
## Assumptions and validity

`temperature` must be finite and strictly positive ($T > 0\ \mathrm{K}$), and `seed` must be a positive integer when supplied. Zero or negative temperatures, non-finite scalars, or invalid seed types fail closed at construction.

(python-api-interactions-thermal-noise-python-api)=
## Python API

### Constructor or function

`fm.ThermalNoise(temperature, seed=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.ThermalNoise.temperature` | `float` | `required` | $\mathrm{K}$ | strictly positive | bath temperature | FEM/FDM CPU/GPU: IR; stochastic runtime qualification required | `temperature` |
| `fm.ThermalNoise.seed` | `int or None` | `None` | $1$ | positive integer when supplied | reproducibility seed | FEM/FDM CPU/GPU: IR; stochastic runtime qualification required | `seed` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.ThermalNoise(temperature=300.0, seed=7)
canonical_ir = value.to_ir()
```

In a complete simulation script, attach `fm.ThermalNoise(...)` through the study interaction/thermal configuration before dynamic stochastic integration.

(python-api-interactions-thermal-noise-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "thermal_noise", "temperature": ..., "seed": ...}` preserving bath temperature in kelvin and any explicit PRNG seed.

(python-api-interactions-thermal-noise-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves bath temperature and reproducibility seed in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-positive or non-finite temperatures and invalid seeds, while `unsupported combinations` (such as deterministic-only integrators or incompatible adaptive stepping) fail closed at planning.

(python-api-interactions-thermal-noise-discrete-realization)=
## Discrete realization

The Python contract supplies temperature and PRNG seed in `ProblemIR` only; discrete volume scaling, Stratonovich stochastic LLG integration, and device random-number generation are implemented by the solver backends.

(python-api-interactions-thermal-noise-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class ThermalNoise`). Constructor checks, defaults, and `to_ir()` keys come directly from that module.

(python-api-interactions-thermal-noise-validation)=
## Validation

Focused repository unit tests covering `ThermalNoise` validation and seed serialization include `test_thermal_noise_rejects_nonpositive_temperature` and `test_thermal_noise_serializes_seed`. Live stochastic integration and Control Room behavior require separate qualification.

(python-api-interactions-thermal-noise-limitations)=
## Limitations and Control Room

Control Room has no dedicated form editor for `fm.ThermalNoise`; author thermal fluctuation terms in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-thermal-noise-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., “Thermal Fluctuations of a Single-Domain Particle,” *Physical Review* **130**(5), 1677–1686 (1963), [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
- J. Leliaert, J. Mulkers, J. De Clercq, A. Coene, M. Dvornik, and B. Van Waeyenberge, “Adaptively time stepping the stochastic Landau-Lifshitz-Gilbert equation at nonzero temperature: Implementation and validation in MuMax3,” *AIP Advances* **7**(12) (2017), [doi:10.1063/1.5003957](https://doi.org/10.1063/1.5003957) | [Open-access AIP PDF](https://aip.scitation.org/doi/pdf/10.1063/1.5003957).

(python-api-interactions-thermal-noise-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class ThermalNoise` | public constructor and IR lowering |
