---
title: Thermal Brown noise
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-thermal-noise-root)=
# Thermal Brown noise

This is the canonical physics owner for Fullmag's Brown stochastic thermal
effective field. It describes the common physical law once, then separates the
FDM/FEM and CPU/GPU realizations. It does not describe thermal noise as a
deterministic energy term: the current public interaction contributes a random
field to the effective-field assembly.

(thermal-noise-problem-statement)=
## 1. Physical problem and ownership

For a magnetic degree of freedom, Brown thermal noise is sampled during the
LLG evolution and added to the effective field. The source law is a discrete
one-step standard-deviation contract. A source-level implementation, a
planner-accepted execution, and a statistically qualified stochastic method
are separate claims; this page records them separately.

(thermal-noise-governing-equations)=
## 2. Governing equations

For degree of freedom `i` and accepted stochastic interval `n`, the sampled
field is

```{math}
:label: eq-thermal-field
\mathbf H_{\mathrm{therm},i}^{\,n}
=\sigma_i^{\,n}\,\boldsymbol\xi_i^{\,n},
\qquad
\boldsymbol\xi_i^{\,n}\sim\mathcal N(\mathbf 0,\mathbf I_3),
```

with the standard deviation implemented by the current lanes:

```{math}
:label: eq-thermal-sigma
\sigma_i^{\,n}
=
\sqrt{
\frac{2\,\alpha_i\,k_{\mathrm B}\,T}
{\gamma_{\mu0}\,\mu_0\,M_{s,i}\,V_i\,\Delta t_n}}
.
```

The thermal field is assembled as an additive effective-field term:

```{math}
:label: eq-thermal-effective-field
\mathbf H_{\mathrm{eff},i}^{\,n}
=\mathbf H_{\mathrm{det},i}^{\,n}
+\mathbf H_{\mathrm{therm},i}^{\,n}.
```

The surrounding LLG integrator converts `\mathbf H_{\mathrm{eff}}` into the
magnetization derivative. The thermal module does not apply a second torque,
gyromagnetic factor, damping factor, or `\mu_0` conversion after sampling.

The Brown denominator uses the bare gyromagnetic input
`\gamma_{\mu0}`. It must not be replaced there by the Gilbert-reduced ratio

```{math}
:label: eq-thermal-gamma-bar
\bar\gamma=\frac{\gamma_{\mu0}}{1+\alpha^2}.
```

The LLG RHS applies its own Gilbert convention where required by that lane.
Applying the reduction both inside the Brown amplitude and again in the RHS
would change the realized variance.

The volume is solver-dependent. For a uniform FDM cell,

```{math}
:label: eq-thermal-fdm-volume
V_i=V_{\mathrm{cell}}=\Delta x\,\Delta y\,\Delta z.
```

FEM source paths use a nodal volume `V_i`; the FEM CPU sampler uses resolved
per-node volumes when available and a magnetic-node average fallback otherwise.
The strict FEM GPU dispatch requires device-resident node volumes.

For a Cartesian component `k`, the source law implies

```{math}
:label: eq-thermal-variance
\operatorname{Var}\!\left[H_{\mathrm{therm},i,k}^{\,n}\right]
=\sigma_i^{2,n}
=
\frac{2\,\alpha_i\,k_{\mathrm B}\,T}
{\gamma_{\mu0}\,\mu_0\,M_{s,i}\,V_i\,\Delta t_n}.
```

This is the implemented one-step variance law. It is not, by itself, a proof
of stochastic weak convergence, equilibrium sampling, or a qualified
integrator for every time-stepping scheme.

There is no deterministic thermal energy contribution:

```{math}
:label: eq-thermal-no-energy
E_{\mathrm{therm}}\ \text{is not defined by the public interaction contract};
\qquad
\mathbf H_{\mathrm{therm}}\ \text{is a stochastic field drive only}.
```

(thermal-noise-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---|
| $\mathbf H_{\mathrm{therm},i}^{\,n}$ | sampled thermal effective field at degree of freedom $i$ and accepted interval $n$ | $\mathrm{A\,m^{-1}}$ |
| $\sigma_i^{\,n}$ | standard deviation of one Cartesian thermal-field component | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\xi_i^{\,n}$ | three-component standard-normal draw | $1$ |
| $\mathbf H_{\mathrm{eff},i}^{\,n}$ | total effective field passed to the LLG RHS | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{det},i}^{\,n}$ | deterministic effective-field sum before Brown noise | $\mathrm{A\,m^{-1}}$ |
| $\alpha_i$ | Gilbert damping parameter, scalar or resolved field | $1$ |
| $k_{\mathrm B}$ | Boltzmann constant, $1.380649\times10^{-23}$ | $\mathrm{J\,K^{-1}}$ |
| $T$ | absolute temperature | $\mathrm{K}$ |
| $\gamma_{\mu0}$ | bare gyromagnetic input used in the Brown denominator | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\bar\gamma$ | Gilbert-reduced ratio used only where the LLG RHS requires it | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | saturation magnetization at degree of freedom $i$ | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | FDM cell volume or FEM nodal volume | $\mathrm{m^3}$ |
| $\Delta t_n$ | timestep used for the sampled accepted interval | $\mathrm{s}$ |
| $i$ | FDM cell or FEM node index | $1$ |
| $n$ | accepted stochastic interval index | $1$ |
| $k$ | Cartesian component index | $1$ |
| $\mathcal A$ | active FDM-cell set or FEM magnetic-node mask | $1$ |
| $\Delta x$ | FDM cell dimensions | $\mathrm{m}$ |
| $\Delta y$ | FDM cell dimensions | $\mathrm{m}$ |
| $\Delta z$ | FDM cell dimensions | $\mathrm{m}$ |
| $E_{\mathrm{therm}}$ | deliberately absent standalone deterministic thermal energy | $\mathrm{J}$ |

(thermal-noise-assumptions-and-validity)=
## 4. Assumptions and validity

The current contract assumes a quasistatic material parameter set over each
accepted interval, positive temperature, positive damping, positive
gyromagnetic input, positive saturation magnetization, positive degree-of-
freedom volume, and positive timestep. Native field routines return zero when
the required positive factors are unavailable. The Python interaction object
requires `T>0`, while `Problem.temperature=0` is allowed as an explicit
disabled state.

The implementation does not claim stochastic weak order, Boltzmann equilibrium,
temperature-dependent material laws, high-temperature longitudinal dynamics,
adaptive-step SDE convergence, or CPU/GPU trajectory identity. LLG plus Brown
noise is not an LLB model near a material's Curie regime.

The sampled field has no FEM weak boundary condition, boundary integral,
Poisson operator, or mesh-interface term. A magnetic mask controls whether a
degree of freedom receives a draw; nonmagnetic FEM nodes and inactive FDM cells
are zeroed or skipped by their respective source paths.

## 5. Backend and qualification matrix

| Solver family | Execution backend | Status | Implemented realization and qualification boundary |
|---|---|---|---|
| FDM | CPU | partial | Double-precision counter-based Brown field with active-cell handling; source and planner contracts exist, but statistical qualification is not claimed here. |
| FDM | GPU | partial | CUDA FP64 and FP32 fused effective-field kernels use cuRAND and resolved `dt`, seed, and step; executed-device variance and parity evidence remain separate gates. |
| FEM | CPU | partial | Native MFEM CPU nodal Brown sampler with per-node material/volume fields, accepted-interval raw-draw reuse, and additive field composition; `sampling_correct`, not `statistically_validated`. |
| FEM | GPU | unsupported | Device kernel source exists, but strict public planning rejects the lane with `CAP-THERM-GPU-001`; no CPU fallback is implied. |

The matrix is a support statement, not a claim that source presence equals
runtime qualification. Requested solver/device/precision and resolved planner
outcome remain separate provenance values.

(thermal-noise-python-api)=
## 6. Python API

The canonical public object is `fullmag.ThermalNoise`. The flat scripting API
and `StudyBuilder` convenience method configure the same canonical object.

```python
# %% Construct and inspect the canonical interaction
import fullmag as fm

thermal = fm.ThermalNoise(temperature=300.0, seed=123)
print(thermal.to_ir())

# %% Configure the flat authoring surface
fm.engine("fdm")
fm.device("cpu")
fm.thermal_noise(temperature=300.0, seed=123)
```

The `# %%` markers make the example directly usable as notebook cells. It
serializes authoring intent; it does not claim that a solver run or statistical
test has been executed.

| Python parameter or entry point | Type | Default | SI unit | Validation domain and failure | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `ThermalNoise.temperature` | `float` | required | $\mathrm{K}$ | strictly $T>0$; non-positive values raise `ValueError` | temperature used by Brown law | FDM/FEM subject to planner lane | `energy_terms[].temperature` |
| `ThermalNoise.seed` | `int\mid None` | `None` | $1$ | `None` = system entropy; supplied value positive; zero/negative raises `ValueError` | requested stochastic replay policy | FDM CPU/GPU; FEM CPU; FEM GPU rejected | `energy_terms[].seed when supplied` |
| `Problem.temperature` | `float\mid None` | `None` | $\mathrm{K}$ | `None` disables; zero allowed; negative raises `ValueError` | top-level Brown temperature compatibility field | planner-dependent | `temperature` |
| `fullmag.thermal_noise(temperature, seed=...)` | function | — | $\mathrm{K}$ / $1$ | delegates to `ThermalNoise`; stores one script-local term | flat authoring convenience | same as `ThermalNoise` | `energy_terms[]` and script-local top-level temperature |
| `StudyBuilder.thermal_noise(temperature, seed=...)` | method | — | $\mathrm{K}$ / $1$ | delegates to flat function and returns builder | fluent authoring convenience | same as `ThermalNoise` | same canonical lowering |
| `SaveField("H_therm")` or thermal snapshot output | `str` | not requested | $\mathrm{A\,m^{-1}}$ | current FDM observables reject direct materialization; request `H_eff` or remove it; FEM output is lane-specific | requested sampled thermal field output | not universally executable | `study.sampling.outputs[]`, then planner validation |

`seed=None` is not the same as `seed=0`: Python omits the seed field for
`None`, while zero is rejected before lowering. A fixed seed requests replay,
but does not establish identical trajectories between solver/device lanes.

(thermal-noise-problem-ir)=
## 7. ProblemIR and normalization

The explicit object lowers to this canonical term fragment:

```json
{"kind": "thermal_noise", "temperature": 300.0, "seed": 123}
```

With no fixed seed:

```json
{"kind": "thermal_noise", "temperature": 300.0}
```

`Problem.temperature` is a separate top-level IR field. When both the term and
the top-level field are authored, Python and planner validators require
agreement within `1e-6 K`; they do not add the values. The planner resolves the
stochastic policy into `ThermalSeedConfig`:

```json
{"temperature": 300.0,
 "thermal_seed_config": {"policy": "fixed", "seed": 123}}
```

For an omitted seed, the resolved policy is `system_entropy` and the seed is
absent. Requested Python intent (term, temperature, optional seed, backend,
device, precision) remains distinct from resolved execution (planner lane,
seed policy, mesh volumes, and qualification evidence).

| Python authoring | Normalized IR | Resolution |
|---|---|---|
| `ThermalNoise(T)` | `energy_terms[].kind=thermal_noise`, `.temperature=T` | `system_entropy` seed policy |
| `ThermalNoise(T, seed=S)` | adds `.seed=S` | `fixed` policy with `seed=S` |
| `Problem.temperature=T` | top-level `temperature=T` | planner uses it when no conflicting term source exists |
| `fm.thermal_noise(T, seed=S)` | script state creates same term | canonical rewrite preserves `T` and `S` |

(thermal-noise-round-trip-and-failure-semantics)=
## 8. Round-trip and failure semantics

Canonical script rewriting preserves a fixed call as
`fm.thermal_noise(temperature=300, seed=123)`. An omitted seed remains omitted
and therefore remains a system-entropy request. The round-trip contract checks
both top-level temperature and the thermal energy term.

The validation errors and unsupported combinations below are intentional
fail-closed planner results, not implicit CPU fallbacks.

Requested intent is preserved separately from resolved execution: the authored
temperature, optional seed, solver, device, and precision are not rewritten as
though they were already qualified runtime facts.

| Input | Validation owner | Result |
|---|---|---|
| `ThermalNoise(temperature=300, seed=123)` | Python constructor | accepted and serializes fixed seed |
| `ThermalNoise(temperature=300)` | Python constructor | accepted and serializes system-entropy intent |
| `ThermalNoise(temperature=0)` | Python constructor | rejected: interaction temperature must be positive |
| `top-level temperature=0` | top-level compatibility field | accepted as disabled thermal state |
| two thermal terms | `Problem`, FDM planner, FEM planner | rejected; terms are not summed |
| term and `Problem.temperature` disagree by more than `1e-6 K` | Python and planners | rejected as conflict |
| `seed=0` or negative seed | Python and planners | rejected; zero is not fixed replay |
| adaptive FDM timestep plus thermal noise | FDM planner | rejected until SDE replay is qualified |
| strict FEM GPU plus thermal term | FEM planner | rejected with `CAP-THERM-GPU-001` |

The validation errors and unsupported combinations above are intentional
fail-closed planner results; they are not silent CPU fallbacks.

(thermal-noise-discrete-realization)=
## 9. Hierarchical solver realizations

### 9.1 Physical domain: micromagnetics / solver family: FDM / execution backend: CPU / interaction: thermal noise

The FDM CPU implementation uses `V_i=\Delta x\Delta y\Delta z` and one scalar
`\alpha`, `M_s`, `\gamma_{\mu0}`, and `T` for the current single-grid
problem. It computes `\sigma` for the field update and adds three normal
components only for active cells. The native engine uses a counter key made of
the resolved global seed, accepted step, cell index, and stream. SplitMix64
turns that key into uniforms and Box–Muller produces normal components.

Adaptive timestep with Brown noise is rejected before execution, so the public
FDM stochastic lane is fixed-step rather than an unqualified adaptive SDE lane.
Multilayer FDM is rejected separately.

### 9.2 Physical domain: micromagnetics / solver family: FDM / execution backend: GPU / interaction: thermal noise

The CUDA FDM path contains separate FP64 and FP32 fused effective-field kernels.
FP64 calls `curand_normal_double`; FP32 calls `curand_normal`. Both use
`thermal_sigma`, the resolved seed, and the step counter to initialize a
per-cell cuRAND state and add three components to `H_eff`. The launch path
computes `V=dx\,dy\,dz`, uses the current timestep, and propagates the resolved
seed into the CUDA context.

The precision paths are distinct numerical realizations. A fixed seed is
necessary for reproducible intent, but it does not make FP32, FP64, and CPU
normal streams bitwise identical. Device identity and executed-device evidence
are required for qualification.

### 9.3 Physical domain: micromagnetics / solver family: FEM / execution backend: CPU / interaction: thermal noise

The FEM CPU path computes a node-specific standard deviation from the Brown
formula. `V_i` comes from the mesh node-volume array when present. If absent,
the sampler computes total magnetic tetrahedral volume and divides by the
number of magnetic nodes; this is an implementation fallback, not an exact
dual-volume reconstruction.

The sampler owns a raw-normal buffer and scaled thermal-field buffer. For one
accepted interval it draws the raw vector once. A retry with another
`\Delta t` reuses that vector and recomputes only the scale
`\sigma\propto\Delta t^{-1/2}`. Nonmagnetic nodes are zeroed. The field-add
module then adds the buffer to `H_eff` without drawing or recomputing sigma.
The status is `sampling_correct`, not `statistically_validated`.

### 9.4 Physical domain: micromagnetics / solver family: FEM / execution backend: GPU / interaction: thermal noise

The repository contains a CUDA node-wise thermal kernel with per-node `M_s`,
`\alpha`, volumes, magnetic mask, deterministic normal generation, and block
maximum-sigma diagnostics. Its wrapper is
`gpu_rk_compute_thermal_field_contribution`. The strict public planner rejects
the lane before dispatch with `CAP-THERM-GPU-001`; kernel source is therefore
not evidence of public FEM GPU execution or parity.

(thermal-noise-implementation-mapping)=
## 10. Implementation mapping

| Responsibility | Repository path | Stable symbol | Lane |
|---|---|---|---|
| Public term and serialization | `packages/fullmag-py/src/fullmag/model/energy.py` | `class ThermalNoise` | Python/common |
| Problem consistency | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Python/common |
| Flat authoring state | `packages/fullmag-py/src/fullmag/world.py` | `class _WorldState` | Python/common |
| Fluent authoring | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Python/common |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM CPU/GPU |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM CPU/GPU |
| FDM CPU amplitude/RNG | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `thermal_field_add_into_step` | FDM CPU |
| FDM FP64 field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | FDM GPU |
| FDM FP32 field | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | FDM GPU |
| FEM CPU sigma | `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp` | `thermal_brown_sigma` | FEM CPU |
| FEM CPU sampler | `backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp` | `refresh_thermal_brown_field` | FEM CPU |
| FEM CPU addition | `backends/fem/cpu/mfem/interactions/thermal_brown_field.cpp` | `add_thermal_brown_field` | FEM CPU |
| FEM GPU source | `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu` | `thermal_field_blocks_kernel` | FEM GPU source, planner-unsupported |
| FEM GPU gate | `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu` | `gpu_rk_compute_thermal_field_contribution` | FEM GPU |

(thermal-noise-validation)=
## 11. Validation

Python tests cover constructor validation, `Problem.temperature` consistency,
duplicate terms, IR fragments, and script round-trip. Planner tests cover
fixed-seed lowering, adaptive FDM rejection, multilayer rejection, duplicate
and conflicting declarations, and strict FEM GPU rejection. Native FDM tests
cover seed propagation, current timestep, bare-gamma convention, and CUDA
kernel keys. Native FEM tests cover sigma, volume fallback, nonmagnetic
zeroing, accepted-interval reuse, and additive field semantics.

These are contract and source tests. They do not prove equilibrium statistics,
weak convergence, executed-device behavior, or cross-precision trajectory
parity.

(thermal-noise-limitations)=
## 12. Limitations

- `ThermalNoise` is an effective-field authoring term, not a material model.
- Temperature is scalar and uniform in the current public API.
- Adaptive stochastic semantics are planner-gated.
- FEM GPU is not public-executable until `CAP-THERM-GPU-001` is closed.
- A fixed seed provides deterministic intent only within a lane's RNG contract;
  it does not synchronize CPU, FP32 CUDA, FP64 CUDA, and FEM streams.

(thermal-noise-scientific-bibliography)=
## 13. Scientific bibliography

1. W. F. Brown Jr., “Thermal fluctuations of a single-domain particle,”
   *Physical Review*, 130, 1677 (1963),
   [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
2. J. L. García-Palacios and F. J. Lázaro, “Langevin-dynamics study of the
   dynamical properties of small magnetic particles,” *Physical Review B*, 58,
   14937 (1998),
   [doi:10.1103/PhysRevB.58.14937](https://doi.org/10.1103/PhysRevB.58.14937).

(thermal-noise-source-code-index)=
## 14. Source-code index

The adjacent `index.source-map.json` is the machine-readable source map. Its
stable identity is repository-relative path plus symbol; generated line links
must be pinned to an immutable revision and never replace the symbol identity.

| Claim | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Public term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class ThermalNoise` | validates temperature/seed and emits IR |
| Problem validation | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | validates top-level temperature and conflicts |
| Flat authoring state | `packages/fullmag-py/src/fullmag/world.py` | `class _WorldState` | stores canonical script-local term |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | resolves seed and fail-closed combinations |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | resolves CPU policy and rejects strict GPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `thermal_field_add_into_step` | cell-volume Brown field and counter-based draw |
| FDM FP64 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | CUDA FP64 composition |
| FDM FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | CUDA FP32 composition |
| FEM CPU sigma | `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp` | `thermal_brown_sigma` | nodal standard deviation |
| FEM CPU sampler | `backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp` | `refresh_thermal_brown_field` | volume, RNG, cache, retry, mask |
| FEM CPU field | `backends/fem/cpu/mfem/interactions/thermal_brown_field.cpp` | `add_thermal_brown_field` | additive `H_eff` composition |
| FEM GPU source | `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu` | `thermal_field_blocks_kernel` | source kernel, not public support |
| FEM GPU gate | `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu` | `gpu_rk_compute_thermal_field_contribution` | dispatch and fail-closed checks |
