---
title: Thermal Noise Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-thermal-noise)=
# Thermal Noise Python API

This is the canonical Python authoring page for the Brown stochastic thermal
effective field. The public object configures a stochastic field contribution;
it does not create a deterministic energy density and does not guarantee that
every requested solver/device lane is executable.

(thermal-noise-api-problem-statement)=
## 1. Public contract

The API has two equivalent authoring surfaces:

1. `fullmag.ThermalNoise(temperature, seed=...)` is the explicit term used in
   `Problem.energy`.
2. `fullmag.thermal_noise(temperature, seed=...)` and
   `StudyBuilder.thermal_noise(...)` configure the same term through the flat
   or fluent script builder.

`Problem.temperature` is a top-level compatibility field for the same Brown
temperature. It is not a second thermal source. If both forms are present,
their temperatures must agree within `1e-6 K`.

(thermal-noise-api-governing-equations)=
## 2. Physical law represented by the API

The native lanes sample a Cartesian field according to

```{math}
:label: eq-python-thermal-field
\mathbf H_{\mathrm{therm},i}^{\,n}
=\sigma_i^{\,n}\boldsymbol\xi_i^{\,n},
\qquad
\boldsymbol\xi_i^{\,n}\sim\mathcal N(\mathbf0,\mathbf I_3).
```

The standard deviation serialized by the interaction is resolved by the
selected numerical lane as

```{math}
:label: eq-python-thermal-sigma
\sigma_i^{\,n}
=\sqrt{
\frac{2\alpha_i k_{\mathrm B}T}
{\gamma_{\mu0}\mu_0M_{s,i}V_i\Delta t_n}}.
```

The API field is added to the total effective field and is not associated with
a standalone `E_therm`. `\gamma_{\mu0}` is the bare gyromagnetic input; the
Gilbert-reduced ratio `\bar\gamma=\gamma_{\mu0}/(1+\alpha^2)` belongs to the
LLG RHS convention and must not be inserted again into this formula.

(thermal-noise-api-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $T$ | `ThermalNoise.temperature` and Brown temperature | $\mathrm{K}$ |
| $\alpha_i$ | scalar or resolved Gilbert damping | $1$ |
| $\gamma_{\mu0}$ | bare gyromagnetic input | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | FDM cell or FEM nodal volume | $\mathrm{m^3}$ |
| $\Delta t_n$ | timestep of the accepted stochastic interval | $\mathrm{s}$ |
| $\sigma_i^{\,n}$ | one-component thermal-field standard deviation | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{therm}}$ | sampled thermal effective field | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\xi_i^{\,n}$ | standard-normal vector | $1$ |
| $k_{\mathrm B}$ | Boltzmann constant | $\mathrm{J\,K^{-1}}$ |
| $\bar\gamma$ | Gilbert-reduced ratio used by the LLG RHS where applicable | $\mathrm{m\,A^{-1}\,s^{-1}}$ |

(thermal-noise-api-assumptions-and-validity)=
## 4. Assumptions and validity

The explicit object requires `temperature > 0`. `seed=None` requests system
entropy; a supplied seed must be a positive integer. The object performs
validation and IR serialization only. Constructing it does not run a solver,
allocate a mesh, or prove stochastic statistics.

The top-level `Problem.temperature` field accepts `None`, zero, or a positive
value. `None` and zero disable the native field; a negative value raises
`ValueError`. This intentional distinction allows a fully constructed
`Problem` to carry an explicit disabled temperature while keeping the
interaction object itself physically enabled.

Current public limitations include:

- no temperature field or temperature-dependent material law;
- no standalone thermal energy output;
- adaptive FDM Brown dynamics rejected until accepted-step SDE replay is
  qualified;
- public multilayer FDM thermal execution rejected;
- strict FEM GPU thermal planning rejected with `CAP-THERM-GPU-001`;
- direct FDM `H_therm` output rejected by the current observable contract;
- constructor/serialization does not establish CPU/GPU trajectory parity.

(thermal-noise-api-python-api)=
## 5. Python API and copyable examples

```python
# %% Explicit interaction term
import fullmag as fm

thermal = fm.ThermalNoise(temperature=300.0, seed=123)
assert thermal.to_ir() == {
    "kind": "thermal_noise",
    "temperature": 300.0,
    "seed": 123,
}

# %% System-entropy request
entropy_term = fm.ThermalNoise(temperature=4.2)
assert entropy_term.to_ir() == {
    "kind": "thermal_noise",
    "temperature": 4.2,
}

# %% Flat script authoring
fm.engine("fdm")
fm.device("cpu")
fm.thermal_noise(temperature=300.0, seed=123)

# %% Fluent script authoring
study = fm.study("thermal-demo")
study.thermal_noise(temperature=300.0, seed=123)
```

The explicit constructor is useful when building `Problem.energy`; the flat
and fluent calls store the same canonical object in script-local state. None
of these cells silently executes a simulation.

| Public name | Type | Default | SI unit | Validation domain / error | Physical meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fullmag.ThermalNoise` | frozen dataclass | — | — | one term at most per `Problem` | explicit Brown thermal interaction | FDM/FEM planner-dependent | `energy_terms[]` with `kind=thermal_noise` |
| `ThermalNoise.temperature` | `float` | required | $\mathrm{K}$ | strictly positive; `ValueError` otherwise | uniform temperature used by the term | all source lanes subject to gates | `energy_terms[].temperature` |
| `ThermalNoise.seed` | `int\mid None` | `None` | $1$ | `None` = system entropy; integer must be positive; zero/negative raises `ValueError` | requested deterministic replay policy | FDM CPU/GPU and FEM CPU; FEM GPU rejected by planner | `energy_terms[].seed` when fixed |
| `Problem.temperature` | `float\mid None` | `None` | $\mathrm{K}$ | `None`/zero disables; negative raises `ValueError`; disagreement with term raises `ValueError` | top-level compatibility temperature | planner-dependent | top-level `temperature` |
| `fullmag.thermal_noise` | function | — | $\mathrm{K}$ | delegates constructor validation; replaces script-local thermal term | flat authoring convenience | same as explicit term | `energy_terms[]` plus top-level script lowering |
| `StudyBuilder.thermal_noise` | method | — | $\mathrm{K}$ | delegates to `fullmag.thermal_noise`; returns builder | fluent authoring convenience | same as explicit term | same canonical lowering |

The interaction has no public `alpha`, `M_s`, `V`, `dt`, or `gamma` arguments.
Those values belong to material, mesh, dynamics, and runtime planner contracts;
adding them to `ThermalNoise` would create a second physical model instead of
describing the current implementation.

(thermal-noise-api-problem-ir)=
## 6. Python-to-ProblemIR mapping

Explicit construction lowers through `ThermalNoise.to_ir()`:

```json
{"kind": "thermal_noise", "temperature": 300.0, "seed": 123}
```

With `seed=None`, the optional member is omitted:

```json
{"kind": "thermal_noise", "temperature": 4.2}
```

`Problem.temperature` serializes independently when it is not `None`:

```json
{"temperature": 300.0,
 "energy_terms": [{"kind": "thermal_noise", "temperature": 300.0,
                   "seed": 123}]}
```

The planner resolves an optional seed to an explicit policy record:

```json
{"temperature": 300.0,
 "thermal_seed_config": {"policy": "fixed", "seed": 123}}
```

| Python authoring | Canonical lowering | Planner normalization |
|---|---|---|
| `ThermalNoise(T)` | `energy_terms[].kind=thermal_noise`, `.temperature=T` | `system_entropy` policy when no seed is supplied |
| `ThermalNoise(T, seed=S)` | adds `.seed=S` | `fixed` policy with `seed=S` |
| `Problem.temperature=T` | top-level `temperature=T` | planner uses it when the term has no separate temperature source |
| `fm.thermal_noise(T, seed=S)` | script state creates the same term | canonical script rewrite preserves `T` and `S` |
| `study.thermal_noise(T, seed=S)` | delegates to flat state | no alternate IR vocabulary |

Requested intent and resolved execution remain distinct. The IR carries the
authored interaction; the execution plan carries the resolved seed policy,
backend/device/precision, mesh-volume realization, and capability decision.

(thermal-noise-api-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Canonical script rewriting preserves a fixed call as
`fm.thermal_noise(temperature=300, seed=123)`. An omitted seed remains omitted
and therefore remains a system-entropy request. The round-trip contract checks
both the top-level temperature and the `thermal_noise` energy term.

The validation errors and unsupported combinations below are intentional
fail-closed planner results, not implicit CPU fallbacks.

| Input | Validation owner | Result |
|---|---|---|
| `ThermalNoise(temperature=300, seed=123)` | Python constructor | accepted and serializes fixed seed |
| `ThermalNoise(temperature=300)` | Python constructor | accepted and serializes system-entropy intent |
| `ThermalNoise(temperature=0)` | Python constructor | rejected: interaction temperature must be positive |
| `top-level temperature=0` | top-level compatibility field | accepted as disabled thermal state |
| two thermal terms | `Problem`, FDM planner, FEM planner | rejected; they are not summed |
| term `T` and `Problem.temperature` disagree by more than `1e-6 K` | Python and planners | rejected as a conflict |
| `seed=0` or a negative seed | Python and planners | rejected; zero is not a fixed replay value |
| adaptive FDM timestep plus thermal noise | FDM planner | rejected until SDE replay is qualified |
| strict FEM GPU request plus thermal noise | FEM planner | rejected with `CAP-THERM-GPU-001` |

(thermal-noise-api-discrete-realization)=
## 8. Solver and device realizations

### 8.1 FDM / CPU

The CPU engine derives the cell volume as `dx*dy*dz`, computes the Brown
standard deviation from the current `thermal_dt`, and adds three normally
distributed components to active cells. Its counter key contains the global
seed, step, cell index, and stream. The SplitMix64/Box–Muller implementation
is a CPU reference realization and is independent of thread decomposition for
the same key.

### 8.2 FDM / GPU

The CUDA FDM implementation has separate FP64 and FP32 kernels. The FP64 lane
uses `curand_normal_double`, while FP32 uses `curand_normal`; both use a
per-cell Philox state initialized from seed, cell index, and step. The current
`dt` and the cell volume enter the amplitude calculation. Precision-specific
streams must not be described as bitwise-equivalent to the CPU stream.

### 8.3 FEM / CPU

The native FEM CPU realization uses the per-node material fields and resolved
node volumes. Its sampler owns the raw draw, scaled field, accepted interval
index, seed handling, magnetic mask, and retry reuse. It reports a source-level
`sampling_correct` contract but not a statistically validated production lane.

### 8.4 FEM / GPU

The repository contains a CUDA node-wise thermal kernel and an RK wrapper, but
the public FEM planner rejects strict GPU ThermalNoise before dispatch. The
source must therefore be treated as planned/unsupported public execution,
not as a hidden fallback or a parity claim.

(thermal-noise-api-implementation-mapping)=
## 9. Implementation mapping

| API/IR concern | Stable source owner | Responsibility |
|---|---|---|
| explicit term | `packages/fullmag-py/src/fullmag/model/energy.py` — `class ThermalNoise` | constructor validation and term serialization |
| `Problem` consistency | `packages/fullmag-py/src/fullmag/model/problem.py` — `class Problem` | top-level temperature and duplicate/conflict checks |
| flat API state | `packages/fullmag-py/src/fullmag/world.py` — `class _WorldState` | script-local storage for the canonical term |
| fluent API | `packages/fullmag-py/src/fullmag/world.py` — `class StudyBuilder` | delegates to flat API |
| IR term and policy | `crates/fullmag-ir/src/study.rs` — `EnergyTermIR`, `ThermalSeedConfig` | serialized term and resolved seed vocabulary |
| FDM planning | `crates/fullmag-plan/src/fdm.rs` — `plan_fdm` | temperature/seed lowering and fail-closed gates |
| FEM planning | `crates/fullmag-plan/src/fem.rs` — `plan_fem` | CPU resolution and FEM GPU rejection |

(thermal-noise-api-validation)=
## 10. Validation

Python tests cover constructor validation, `Problem.temperature` consistency,
duplicate terms, IR fragments, and script round-trip. Planner tests cover fixed
seed lowering, adaptive FDM rejection, multilayer rejection, duplicate and
conflicting declarations, and strict FEM GPU rejection. Native FDM tests check
seed propagation, current timestep, bare-gamma convention, and CUDA kernel
keys. Native FEM tests check sigma, node-volume fallback, nonmagnetic zeroing,
accepted-interval reuse, and additive field semantics.

These are contract and source tests. They do not by themselves prove
equilibrium statistics, weak convergence, device execution, or cross-precision
trajectory parity.

(thermal-noise-api-limitations)=
## 11. Limitations

- `ThermalNoise` is an effective-field authoring term, not a material model.
- Temperature is scalar and uniform in the current public API.
- The native field law uses the current timestep, but adaptive stochastic
  semantics are intentionally planner-gated.
- FEM GPU source is not public-executable until `CAP-THERM-GPU-001` is closed.
- A fixed seed provides deterministic intent only within a lane's RNG contract;
  it does not synchronize CPU, FP32 CUDA, FP64 CUDA, and FEM streams.

(thermal-noise-api-scientific-bibliography)=
## 12. Scientific bibliography

1. W. F. Brown Jr., “Thermal fluctuations of a single-domain particle,”
   *Physical Review*, 130, 1677 (1963),
   [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
2. J. L. García-Palacios and F. J. Lázaro, “Langevin-dynamics study of the
   dynamical properties of small magnetic particles,” *Physical Review B*, 58,
   14937 (1998),
   [doi:10.1103/PhysRevB.58.14937](https://doi.org/10.1103/PhysRevB.58.14937).

(thermal-noise-api-source-code-index)=
## 13. Source-code index

The adjacent `thermal-noise.source-map.json` is the machine-readable map for
this page. Stable path-plus-symbol identities are authoritative; line ranges
may be generated for a pinned revision but are not the citation identity.

| Claim | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Constructor | `packages/fullmag-py/src/fullmag/model/energy.py` | `class ThermalNoise` | public parameter validation and IR |
| Problem validation | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | temperature consistency and duplicate rejection |
| Flat function state | `packages/fullmag-py/src/fullmag/world.py` | `class _WorldState` | script-local canonical authoring |
| Fluent function | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | fluent delegation |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM normalization and legality |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM normalization and GPU gate |
| Python validation tests | `packages/fullmag-py/tests/test_stno_temperature.py` | `test_conflict_temperature_raises` | top-level/term consistency |
| Python IR tests | `packages/fullmag-py/tests/test_stno_roundtrip.py` | `test_thermal_noise_in_energy_terms` | canonical IR term |
| script round-trip | `packages/fullmag-py/tests/test_script_builder_roundtrip.py` | `test_flat_thermal_noise_roundtrip_preserves_temperature_and_seed` | source rewrite preservation |
