---
title: Thermal Noise Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Thermal noise

(public-docs-python-api-interactions-thermal-noise)=
(python-api-interactions-thermal-noise-problem-statement)=
## Problem statement

`fm.ThermalNoise` and the stage-first helper `study.thermal_noise(temperature, *, seed=None)` author explicit stochastic Brown-field fluctuations with a strictly positive bath temperature and optional reproducibility seed.

This page covers the Python authoring contract: construction validates bath temperature and optional PRNG seed in Python, while `to_ir()` emits the canonical `ProblemIR` record before stochastic integration.

(python-api-interactions-thermal-noise-governing-equations)=
## Governing equations

Stochastic Langevin micromagnetics adds a Gaussian-distributed thermal fluctuation field $\mathbf{H}_{\mathrm{th}}(\mathbf{x}, t)$ whose variance satisfies the fluctuation-dissipation theorem proportional to bath temperature $T$ and cell/nodal volume: $\langle H_{\mathrm{th},i}(\mathbf{x}, t) H_{\mathrm{th},j}(\mathbf{x}', t')\rangle = \frac{2\alpha k_{\mathrm{B}} T}{\gamma_0 \mu_0 M_s V}\,\delta_{ij}\delta(\mathbf{x}-\mathbf{x}')\delta(t-t')$. Continuum equations and stochastic solver contracts are documented in {doc}`../../physics/interactions/thermal-noise/index`.

(python-api-interactions-thermal-noise-symbols-and-si-units)=
## Symbols and SI units

Bath `temperature` ($T$) is authored in kelvin ($\mathrm{K}$). The stochastic PRNG `seed` is a dimensionless positive integer ($1$); physical noise variance scales with $\mathrm{A^2\,m^{-2}\,s^{-1}}$ via Boltzmann's constant $k_{\mathrm{B}}$ in $\mathrm{J\,K^{-1}}$.

(python-api-interactions-thermal-noise-assumptions-and-validity)=
## Assumptions and validity

`temperature` must be finite and strictly positive ($T > 0\ \mathrm{K}$), validated via `require_positive(self.temperature, "temperature")`, and `seed` must be a strictly positive integer when supplied (`seed > 0`; pass `None` to draw from system entropy). Zero or negative temperatures, non-finite scalars, or non-positive seeds fail closed at construction.

(python-api-interactions-thermal-noise-python-api)=
## Python API

### Constructor and study helper

- `fm.ThermalNoise(temperature, seed=None)`
- `study.thermal_noise(temperature, *, seed=None)` (also flat `fm.thermal_noise(temperature, *, seed=None)`)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.ThermalNoise.temperature` | `float` | `required` | $\mathrm{K}$ | finite and strictly positive via `require_positive` | bath temperature | FEM/FDM CPU/GPU: IR; fixed-step stochastic integrator required | `temperature` |
| `fm.ThermalNoise.seed` | `int \| None` | `None` | $1$ | strictly positive integer when supplied (`None` uses system entropy) | reproducibility PRNG seed | FEM/FDM CPU/GPU: IR; fixed-step stochastic integrator required | `seed` |

### Stage-first example

```python
# %% Stage-first finite-temperature stochastic LLG dynamics
import fullmag as fm

study = fm.study("thermal_noise_brown_dynamics")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(5.0e-9, 5.0e-9, 5.0e-9))

film = study.geometry(fm.Box(size=(50.0e-9, 50.0e-9, 5.0e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.05
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.thermal_noise(300.0, seed=7)
study.solver(integrator="heun", fix_dt=1.0e-14)
study.stages.add_run(stage_id="langevin_run", until=1.0e-11)

# %% Canonical ThermalNoise IR inspection
noise_ir = fm.ThermalNoise(temperature=300.0, seed=7).to_ir()
assert noise_ir == {"kind": "thermal_noise", "temperature": 300.0, "seed": 7}
```

(python-api-interactions-thermal-noise-problem-ir)=
## ProblemIR

`fm.ThermalNoise(temperature, seed=...).to_ir()` emits `{"kind": "thermal_noise", "temperature": ...}` and includes `"seed": ...` whenever `seed` is not `None`.

(python-api-interactions-thermal-noise-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves bath temperature and reproducibility seed in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-positive or non-finite temperatures and non-positive seeds at Python construction, while `unsupported combinations` (such as incompatible integrators or stochastic stepping modes lacking backend qualification) fail closed at planning.

(python-api-interactions-thermal-noise-discrete-realization)=
## Discrete realization

The Python contract supplies temperature and PRNG seed in `ProblemIR` only; discrete volume scaling, Stratonovich stochastic LLG integration (such as fixed-step Heun), and device random-number generation are implemented by the solver backends. See {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels` for integrator and device-kernel architecture.

| Solver | Device | Stochastic thermal field status | Notes |
|---|---|---|---|
| `FDM` | `CPU` | Supported (fixed-step stochastic Heun) | Cell-volume scaling $V = \Delta x\,\Delta y\,\Delta z$ |
| `FDM` | `GPU` | Supported on qualified stochastic CUDA paths | Device PRNG with explicit seed reproducibility |
| `FEM` | `CPU` | IR lowered; planner checks stochastic capability | Nodal lumped-volume scaling; fails closed if unsupported |
| `FEM` | `GPU` | IR lowered; planner checks stochastic capability | Fails closed if stochastic FEM GPU lane is unavailable |

(python-api-interactions-thermal-noise-implementation-mapping)=
## Implementation mapping

- Typed interaction class: `packages/fullmag-py/src/fullmag/model/energy.py` (`class ThermalNoise`).
- Stage-first study helper: `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `thermal_noise`).

(python-api-interactions-thermal-noise-validation)=
## Validation

Focused repository unit tests covering `ThermalNoise` validation and seed serialization include `test_thermal_noise_rejects_nonpositive_temperature` and `test_thermal_noise_serializes_seed`. Live stochastic integration and Control Room behavior require separate qualification.

(python-api-interactions-thermal-noise-limitations)=
## Limitations and Control Room

Control Room exposes physics module status via `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` and `PhysicsModuleSpec.tsx` and has no dedicated form editor for `fm.ThermalNoise`; author thermal fluctuation terms in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-thermal-noise-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., “Thermal Fluctuations of a Single-Domain Particle,” *Physical Review* **130**(5), 1677–1686 (1963), [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
- J. Leliaert, J. Mulkers, J. De Clercq, A. Coene, M. Dvornik, and B. Van Waeyenberge, “Adaptively time stepping the stochastic Landau-Lifshitz-Gilbert equation at nonzero temperature: Implementation and validation in MuMax3,” *AIP Advances* **7**(12) (2017), [doi:10.1063/1.5003957](https://doi.org/10.1063/1.5003957) | [Open-access AIP PDF](https://aip.scitation.org/doi/pdf/10.1063/1.5003957).

(python-api-interactions-thermal-noise-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L610) | `class ThermalNoise` | public constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | `class StudyBuilder` | `study.thermal_noise(...)` stage-first study facade |
