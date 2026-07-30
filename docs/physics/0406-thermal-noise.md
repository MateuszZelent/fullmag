# Thermal Brown noise

- Status: canonical interaction note for the public stochastic thermal-field contract
- Last updated: 2026-07-30
- Public owner: `public_docs/site/physics/interactions/thermal-noise/index.md`
- Python owner: `public_docs/site/python-api/interactions/thermal-noise.md`

## 1. Scope and ownership

Fullmag represents thermal noise as an additive Brown stochastic effective field
in the LLG field assembly. It is not a deterministic conservative energy term,
and the current public contract does not expose a standalone thermal energy
observable. The canonical semantic term is `EnergyTermIR::ThermalNoise`, while
the planner also retains temperature and the resolved seed policy on the
execution plan.

This note separates the common law from the four numerical lanes. The common
law is the discrete standard deviation used by the current implementations;
the stochastic-calculus and statistical-qualification claims remain separate
from source-level implementation claims.

## 2. Implemented discrete law

For a magnetic degree of freedom `i`, the sampled field is

```{math}
:label: eq-thermal-field
\mathbf H_{\mathrm{therm},i}^{\,n}
=\sigma_i^{\,n}\,\boldsymbol\xi_i^{\,n},
\qquad
\boldsymbol\xi_i^{\,n}\sim\mathcal N(\mathbf 0,\mathbf I_3),
```

where the implemented standard deviation is

```{math}
:label: eq-thermal-sigma
\sigma_i^{\,n}
=
\sqrt{
\frac{2\,\alpha_i\,k_{\mathrm B}\,T}
{\gamma_{\mu0}\,\mu_0\,M_{s,i}\,V_i\,\Delta t_n}}
.
```

The field is assembled additively:

```{math}
:label: eq-thermal-effective-field
\mathbf H_{\mathrm{eff},i}^{\,n}
=\mathbf H_{\mathrm{det},i}^{\,n}
+\mathbf H_{\mathrm{therm},i}^{\,n},
```

and the surrounding LLG integrator converts the resulting field into the
magnetization derivative. The thermal module does not apply the LLG torque,
the gyromagnetic factor, damping, or an additional `\mu_0` conversion after
the field has been sampled.

`\gamma_{\mu0}` is the bare gyromagnetic input used by the Brown sampler. It
must not be replaced by

```{math}
:label: eq-thermal-gamma-bar
\bar\gamma=\frac{\gamma_{\mu0}}{1+\alpha^2}
```

inside the Brown denominator. The Gilbert reduction is applied by the LLG RHS
where that lane implements it; applying the reduction both in the field
amplitude and in the RHS changes the realized variance.

The discrete volume is solver-dependent:

```{math}
:label: eq-thermal-fdm-volume
V_i=V_{\mathrm{cell}}=\Delta x\,\Delta y\,\Delta z
\qquad\text{for a uniform FDM cell},
```

whereas the FEM CPU and FEM GPU source contracts use a nodal volume `V_i`.
The FEM CPU sampler uses the resolved per-node volume when available and a
magnetic-node average fallback only when the mesh does not provide nodal
volumes. The strict FEM GPU dispatch requires device-resident node volumes.

The variance implied by the source law is

```{math}
:label: eq-thermal-variance
\operatorname{Var}\!\left[H_{\mathrm{therm},i,k}^{\,n}\right]
=\sigma_i^{2,n}
=
\frac{2\,\alpha_i\,k_{\mathrm B}\,T}
{\gamma_{\mu0}\,\mu_0\,M_{s,i}\,V_i\,\Delta t_n}
```

for Cartesian component `k` when the component draw is standard normal. This
is the implemented one-step variance law, not by itself a proof of weak
convergence, equilibrium sampling, or a qualified stochastic integrator.

There is no current deterministic thermal energy term:

```{math}
:label: eq-thermal-no-energy
E_{\mathrm{therm}}\ \text{is not defined by the public interaction contract};
\qquad
\mathbf H_{\mathrm{therm}}\ \text{is a stochastic field drive only}.
```

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
| $\bar\gamma$ | Gilbert-reduced gyromagnetic ratio used only where the LLG RHS requires it | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}$} |
| $M_{s,i}$ | saturation magnetization at degree of freedom $i$ | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | cell volume or FEM nodal volume | $\mathrm{m^3}$ |
| $\Delta t_n$ | timestep used for the sampled accepted interval | $\mathrm{s}$ |
| $i$ | FDM cell or FEM node index | $1$ |
| $n$ | accepted stochastic interval index | $1$ |
| $k$ | Cartesian component index | $1$ |
| $\mathcal A$ | active magnetic FDM-cell set or FEM magnetic-node mask | $1$ |
| $\Delta x,\Delta y,\Delta z$ | FDM cell dimensions | $\mathrm{m}$ |
| $E_{\mathrm{therm}}$ | deliberately absent standalone deterministic thermal energy | $\mathrm{J}$ |

The unit in the `\mu_0` row is written as `\mathrm{N\,A^{-2}}`; the field
amplitude returned by the source is in `\mathrm{A\,m^{-1}}`, not tesla.

## 4. Assumptions, validity, and non-claims

The current contract assumes a quasistatic material parameter set over each
accepted interval, positive temperature, positive damping, positive
gyromagnetic input, positive saturation magnetization, positive degree-of-
freedom volume, and positive timestep. The native field routines return zero
when the required positive factors are not available. The public Python
`ThermalNoise` object is stricter and rejects non-positive temperatures;
`Problem.temperature=0` is instead allowed as an explicit disabled state.

The implementation does not claim that all of the following have been
qualified: stochastic weak order, equilibrium Boltzmann statistics, a
temperature-dependent material law, high-temperature longitudinal dynamics,
adaptive-step SDE convergence, or CPU/GPU trajectory identity. In particular,
LLG plus Brown noise is not a substitute for an LLB model near a material's
Curie regime.

The sampled field has no FEM boundary condition, weak boundary integral,
Poisson operator, or mesh-interface term. A magnetic mask controls whether a
degree of freedom receives a draw; nonmagnetic FEM nodes and inactive FDM
cells are zeroed or skipped by their respective source paths.

## 5. Backend and qualification matrix

| Solver family | Execution backend | Status | Implemented realization and qualification boundary |
|---|---|---|---|
| FDM | CPU | partial | Double-precision counter-based Brown field with active-cell handling; source and planner contracts exist, but this page does not claim a completed stochastic qualification suite. |
| FDM | GPU | partial | CUDA FP64 and FP32 fused effective-field kernels use cuRAND and the resolved `dt`, seed, and step; executed-device variance and parity evidence remain separate gates. |
| FEM | CPU | partial | Native MFEM CPU nodal Brown sampler with per-node material/volume fields, accepted-interval raw-draw reuse, and additive field composition; status is `sampling_correct`, not `statistically_validated`. |
| FEM | GPU | unsupported | Device kernel source exists, but strict public planning rejects the lane with `CAP-THERM-GPU-001`; no CPU fallback is implied. |

The matrix is a support statement, not a promise that source presence equals
runtime qualification. Requested solver/device/precision and resolved planner
outcome remain separate provenance values.

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

The `# %%` markers make the example directly usable as notebook cells. The
example serializes the authoring contract; it does not silently claim that a
solver run or statistical test has been executed.

| Python parameter or entry point | Type | Default | SI unit | Validation domain and failure | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `ThermalNoise.temperature` | `float` | required | $\mathrm{K}$ | strictly $T>0$; non-positive values raise `ValueError` | temperature used by the Brown law | FDM/FEM subject to planner lane | `energy_terms[].temperature` |
| `ThermalNoise.seed` | `int\mid None` | `None` | $1$ | `None` means system entropy; supplied value must be positive; zero or negative raises `ValueError` | requested stochastic replay policy | FDM CPU/GPU; FEM CPU; FEM GPU is planner-rejected | `energy_terms[].seed` when supplied |
| `Problem.temperature` | `float\mid None` | `None` | $\mathrm{K}$ | `None` disables; zero is allowed; negative values raise `ValueError` | top-level Brown temperature compatibility field | planner-dependent | `temperature` |
| `fullmag.thermal_noise(temperature, seed=...)` | function | — | $\mathrm{K}$ / $1$ | delegates to `ThermalNoise`; stores one script-local term | flat API authoring convenience | same as `ThermalNoise` | `energy_terms[]` and script-local top-level temperature |
| `StudyBuilder.thermal_noise(temperature, seed=...)` | method | — | $\mathrm{K}$ / $1$ | delegates to the flat function and returns the builder | fluent authoring convenience | same as `ThermalNoise` | same canonical lowering |
| `SaveField("H_therm")` or thermal snapshot output | `str` | not requested | $\mathrm{A\,m^{-1}}$ | current FDM observables reject direct materialization; request `H_eff` or remove it; FEM output availability is lane-specific | requested sampled thermal field output | not a universally executable output | `study.sampling.outputs[]`, then planner validation |

`seed=None` is not the same as `seed=0`: Python omits the seed field for
`None`, while zero is rejected before lowering. A fixed seed requests replay,
but it does not by itself establish that two different solver/device lanes
produce identical trajectories.

## 7. ProblemIR, normalization, and failure semantics

The explicit object lowers to the following canonical term fragment:

```json
{"kind": "thermal_noise", "temperature": 300.0, "seed": 123}
```

When no fixed seed is supplied, the serialized term is:

```json
{"kind": "thermal_noise", "temperature": 300.0}
```

`Problem.temperature` is a separate top-level IR field. When both the term and
the top-level field are authored, the Python and planner validators require
agreement within `1e-6 K`; they do not add the values. The planner resolves
the stochastic policy into `ThermalSeedConfig`:

```json
{"temperature": 300.0,
 "thermal_seed_config": {"policy": "fixed", "seed": 123}}
```

For an omitted seed, the resolved policy is `system_entropy` and the seed value
is absent. Requested Python intent (term, temperature, optional seed, backend,
device, precision) must remain distinct from resolved execution (planner
lane, seed policy, precision, mesh volumes, and qualification evidence).

The following combinations fail closed:

| Combination | Current result |
|---|---|
| Two `ThermalNoise` terms | Python and both native planners reject duplicate declarations. |
| Term temperature disagrees with `Problem.temperature` | Python and planners reject the conflict. |
| `seed=0` | Python rejects it; native planners reject it rather than silently treating it as fixed replay. |
| FDM adaptive timestep with Brown noise | planner rejects it until the accepted-step SDE replay contract is qualified; fixed-step Heun is the documented executable choice. |
| Public multilayer FDM with thermal temperature | planner rejects it because staged CPU/GPU multilayer RHS coverage is not implemented. |
| Strict FEM GPU with thermal term | planner rejects it with `CAP-THERM-GPU-001`; no hidden CPU fallback. |
| Direct FDM `H_therm` output | planner rejects direct materialization in the current CPU/CUDA observable contract. |
| FEM relaxation with Brown temperature | current relaxation validation rejects thermal noise where a conservative equilibrium contract is required. |

## 8. Solver family: FDM

### 8.1 Execution backend: CPU — Thermal noise interaction

The FDM CPU implementation uses `V_i=\Delta x\Delta y\Delta z` and one scalar
`\alpha`, `M_s`, `\gamma_{\mu0}`, and `T` for the current single-grid
problem. It computes `\sigma` once for the field update and adds three normal
components to the effective-field vector only for active cells. The native
engine uses a counter key containing the resolved global seed, accepted step,
cell index, and stream index. SplitMix64 turns that key into uniform values and
Box–Muller transforms produce normal components. The contract is independent
of thread count and decomposition for the same resolved key.

The CPU implementation has both AoS and SoA/fused local-term paths. The
planner supplies the resolved temperature and seed through the native plan.
Adaptive timestep with Brown noise is rejected before execution, so the
documented public FDM stochastic lane is fixed-step rather than an unqualified
adaptive SDE lane. Multilayer FDM is rejected separately.

### 8.2 Execution backend: GPU — Thermal noise interaction

The CUDA FDM path contains separate FP64 and FP32 fused effective-field kernels.
The FP64 path calls `curand_normal_double`; the FP32 path calls
`curand_normal`. Both use `thermal_sigma`, the resolved seed, and the step
counter to initialize a per-cell cuRAND state and add three components to
`H_eff`. The launch path computes `V=dx\,dy\,dz`, uses the current timestep,
and transfers the planner-resolved seed into the CUDA context.

The two precision paths are different numerical realizations. A fixed seed is
necessary for reproducible intent, but it does not make FP32, FP64, and CPU
normal streams bitwise identical. Device identity, executed-device evidence,
variance checks, and cross-lane parity are required before a production
qualification claim.

## 9. Solver family: FEM

### 9.1 Execution backend: CPU — Thermal noise interaction

The FEM CPU path computes a node-specific standard deviation with the exact
Brown formula. `V_i` comes from the mesh node-volume array when present. If the
array is absent, the sampler computes the total volume of magnetic tetrahedra
and divides it by the number of magnetic nodes; this is an implementation
fallback, not an exact dual-volume reconstruction.

The sampler owns a three-component raw-normal buffer and a scaled thermal-field
buffer. For one accepted interval it draws the raw vector once. If a retry
uses another `\Delta t` while the accepted interval index is unchanged, it
reuses the raw vector and recomputes only the scale `\sigma\propto
\Delta t^{-1/2}`. Nonmagnetic nodes are zeroed. The field-add module then adds
the buffer to `H_eff`; it does not draw random numbers or recompute `\sigma`.

The current native status is `sampling_correct`, not `statistically_validated`.
The source-level contract and local deterministic tests do not establish
Boltzmann equilibrium, stochastic weak convergence, or production runtime
qualification.

### 9.2 Execution backend: GPU — Thermal noise interaction

The FEM CUDA source contains a device kernel with per-node `M_s`, `\alpha`,
node volumes, magnetic mask, deterministic normal generation, and block-maximum
`\sigma` diagnostics. Its wrapper is
`gpu_rk_compute_thermal_field_contribution`. The current strict public planner
rejects the lane before execution because the capability is pending
`CAP-THERM-GPU-001`. Consequently, the kernel source is an implementation
artifact and not evidence that public FEM GPU ThermalNoise is executable.

## 10. Implementation mapping

The implementation is intentionally split by responsibility. The aggregate
FEM source imports plan fields; it does not own the sigma formula, sampler
cache, or `H_eff` addition. This prevents a future page from attributing all
thermal behavior to one ambiguous “thermal” file.

| Responsibility | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| Brown amplitude | `thermal_field_add_into_step` | `launch_effective_field_fp64` / FP32 counterpart | `thermal_brown_sigma` | `thermal_field_blocks_kernel` |
| Random draw | SplitMix64 + Box–Muller counter | cuRAND Philox state | `refresh_thermal_brown_field` and `std::mt19937_64` | deterministic device normal helper in kernel |
| Field composition | CPU effective-field path | fused CUDA effective-field kernel | `add_thermal_brown_field` | RK thermal-field wrapper/kernel |
| Public planner gate | `plan_fdm` | `plan_fdm` plus runtime qualification | `plan_fem` | `plan_fem` rejects `CAP-THERM-GPU-001` |

## 11. Validation

The current validation evidence is layered:

1. Python unit tests cover constructor validation, seed handling,
   `Problem.temperature` consistency, duplicate terms, IR serialization, and
   script round-trip.
2. FDM native source-contract tests cover ABI seed propagation, current `dt`,
   the bare-`\gamma_{\mu0}` convention, and the CPU/CUDA kernel key contract.
3. FEM native contract tests cover sigma, invalid-input zero behavior,
   buffer ownership, volume fallback, nonmagnetic zeroing, accepted-interval
   raw-draw reuse, and additive `H_eff` semantics.
4. Planner tests cover duplicate/conflicting terms, seed policy, adaptive FDM
   rejection, multilayer rejection, and strict FEM GPU rejection.

These checks do not replace active stochastic runtime evidence. Before changing
the qualification status, record the executed runtime/device identity, variance
versus `T`, `V`, `M_s`, `\alpha`, and `\Delta t`, a macrospin equilibrium or
Boltzmann acceptance artifact, deterministic replay evidence, and a CPU/GPU
comparison under an explicitly matched numerical law.

## 12. Limitations and deferred qualification

- No standalone thermal energy is reported.
- Temperature is a uniform scalar; temperature fields and temperature-dependent
  material laws are outside this interaction contract.
- `LLG+Brown` does not model longitudinal magnetization fluctuations near
  Curie temperature; an LLB contract would be a separate interaction/dynamics
  decision.
- Adaptive stochastic integration is not public-executable until accepted-step
  replay and stage semantics are qualified.
- FEM CPU retry reuse is implemented, but its statistical interpretation is not
  a general proof for every adaptive stochastic scheme.
- FEM GPU remains fail-closed in the public planner.
- CPU, CUDA FP64, CUDA FP32, and FEM implementations do not promise identical
  random sequences or trajectories.

(scientific-bibliography)=
## 13. Scientific bibliography

1. W. F. Brown Jr., “Thermal fluctuations of a single-domain particle,”
   *Physical Review*, 130, 1677 (1963),
   [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
2. J. L. García-Palacios and F. J. Lázaro, “Langevin-dynamics study of the
   dynamical properties of small magnetic particles,” *Physical Review B*, 58,
   14937 (1998),
   [doi:10.1103/PhysRevB.58.14937](https://doi.org/10.1103/PhysRevB.58.14937).

(source-code-index)=
## 14. Source-code index

The adjacent `index.source-map.json` is the machine-readable source map. Its
stable identity is repository-relative path plus symbol; line links must be
generated from the immutable revision under review and never replace the
symbol identity.

| Claim | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Public term and IR serialization | `packages/fullmag-py/src/fullmag/model/energy.py` | `class ThermalNoise` | validates temperature/seed and emits `thermal_noise` |
| Problem-level consistency | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | validates top-level temperature, duplicates, and conflicts |
| Flat authoring | `packages/fullmag-py/src/fullmag/world.py` | `thermal_noise` | stores the canonical script-local term |
| IR term | `crates/fullmag-ir/src/study.rs` | `EnergyTermIR` | serializes temperature and optional seed |
| Seed provenance | `crates/fullmag-ir/src/study.rs` | `ThermalSeedConfig` | stores fixed/system-entropy policy |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | resolves temperature/seed and fail-closed combinations |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | resolves CPU policy and rejects strict FEM GPU |
| FDM CPU amplitude/RNG | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `thermal_field_add_into_step` | cell-volume Brown field and counter-based draw |
| FDM FP64 | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | CUDA FP64 thermal composition |
| FDM FP32 | `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | CUDA FP32 thermal composition |
| FEM CPU sigma | `backends/fem/cpu/mfem/interactions/thermal_brown_sigma.cpp` | `thermal_brown_sigma` | nodal Brown standard deviation |
| FEM CPU sampler | `backends/fem/cpu/mfem/interactions/thermal_brown_sampler.cpp` | `refresh_thermal_brown_field` | volumes, RNG, cache, retry, mask |
| FEM CPU field addition | `backends/fem/cpu/mfem/interactions/thermal_brown_field.cpp` | `add_thermal_brown_field` | additive `H_eff` composition |
| FEM GPU source | `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.cu` | `thermal_field_blocks_kernel` | device source kernel, not public support |
| FEM GPU gate | `backends/fem/gpu/cuda/integrators/rk/rk_thermal_field.cu` | `gpu_rk_compute_thermal_field_contribution` | device dispatch and fail-closed checks |
| FEM contract tests | `backends/fem/tests/thermal_brown_contract.cpp` | `thermal_brown_gamma_convention_is_documented` | source and physical contract regression |
