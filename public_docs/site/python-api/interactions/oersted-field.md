---
title: Oersted field Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0870-oersted-field.md
---

(oersted-api-problem-statement)=
# Oersted field Python API

This page is the complete Python authoring reference for Oersted field sources. The physical
equations, assumptions, and FDM/FEM realization comparison are owned by
{doc}`../../physics/interactions/oersted-field/index`. This page owns constructor signatures,
parameter validation, Python-to-ProblemIR normalization, output requests, and failure semantics.

The API has two distinct requested intents:

1. OerstedCylinder describes an analytic infinite straight cylinder directly.
2. OerstedField(model="from_current_solution", source=...) binds the field to a named
   CurrentTransport module. The planner later resolves that request to an analytic cylinder or a
   regularized midpoint Biot-Savart field.

(oersted-api-governing-equations)=
## Governing equations exposed by the API

The Python objects do not implement a second physical law. They lower to the canonical equations
on the physics page. The API-facing field contribution is

```{math}
:label: eq-oersted-api-field
\mathbf H_{\mathrm{eff}}(\mathbf x,t)
=\mathbf H_{\mathrm{det}}(\mathbf x,t)+\mathbf H_{\mathrm{oe}}(\mathbf x,t).
```

The direct cylinder request is represented by

```{math}
:label: eq-oersted-api-ir-cylinder
\mathrm{IR}_{\mathrm{oe,cyl}}
=\left\{
\begin{aligned}
&\texttt{kind}:\texttt{"oersted_cylinder"},\\
&\texttt{current}:I_0,\\
&\texttt{radius}:R,\\
&\texttt{center}:\mathbf c,\\
&\texttt{axis}:\hat{\mathbf a}
\end{aligned}
\right\}.
```

The source-bound request is represented by

```{math}
:label: eq-oersted-api-ir-source
\mathrm{IR}_{\mathrm{oe,src}}
=\left\{
\begin{aligned}
&\texttt{kind}:\texttt{"oersted_field"},\\
&\texttt{model}:\texttt{"from_current_solution"},\\
&\texttt{source}:s
\end{aligned}
\right\}.
```

These records contain requested semantics only. CPU/GPU, precision, source discretization,
realized field values, and qualification evidence are resolved after lowering.

(oersted-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf H_{\mathrm{eff}}$ | total effective field passed to the LLG right-hand side | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{det}}$ | deterministic field sum before Oersted contribution | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{oe}}$ | Oersted field contribution | $\mathrm{A\,m^{-1}}$ |
| $\mathrm{IR}_{\mathrm{oe,cyl}}$ | canonical ProblemIR cylinder fragment | $1$ |
| $\mathrm{IR}_{\mathrm{oe,src}}$ | canonical ProblemIR source-bound fragment | $1$ |
| $\mathrm{IR}_{\mathrm{cyl}}$ | direct OerstedCylinder ProblemIR record | $1$ |
| $\mathrm{IR}_{\mathrm{src}}$ | source-bound OerstedField ProblemIR record | $1$ |
| $I_0$ | analytic-cylinder current amplitude | $\mathrm{A}$ |
| $R$ | analytic-cylinder radius | $\mathrm{m}$ |
| $\mathbf c$ | cylinder centre | $\mathrm{m}$ |
| $\hat{\mathbf a}$ | cylinder current-flow axis | $1$ |
| $s$ | name of the current source module | $1$ |
| $s_{\mathrm{name}}$ | serialized current-source name in the IR reference | $1$ |
| $\mathbf J$ | prescribed current density in CurrentTransport | $\mathrm{A\,m^{-2}}$ |

(oersted-api-assumptions-and-validity)=
## Assumptions and validity limits

- The API uses SI values. It does not convert current, length, current density, frequency, or
  time from another unit system.
- Python construction proves object representability, not solver executability.
- ProblemIR validation is stricter than the shape-only Python vector helper: current and vectors
  must be finite, and the cylinder axis must be non-zero.
- Only one executable Oersted term is currently supported in one ProblemIR.
- OerstedField requires a named CurrentTransport source and a source solve_region at planning
  time. The current executable source model is prescribed_density.
- Ohmic-Poisson, PiecewiseLinear, and SincPulse remain representable data where their constructors
  allow them, but the current Oersted planner rejects those combinations.
- H_oe is a field output in A/m. No E_oe scalar is introduced by these constructors.

(oersted-api-python-api)=
## Complete Python API reference

### OerstedCylinder

OerstedCylinder is a frozen dataclass. Its constructor is:


The signed current controls field chirality. The Python constructor requires a positive radius,
accepts exactly three values for center and axis, and stores the values as tuples. It does not
normalize the axis in Python; ProblemIR and the selected native lane own that legality and
normalization boundary.

### OerstedField

OerstedField binds to a named CurrentTransport:


The Python object stores only the source name. It does not copy current density, geometry, mesh,
or a computed field into the energy term. Problem validation checks that the source name refers to
a CurrentTransport in the same Problem.

### Time-dependence objects

The available public envelope constructors lower as follows:

| Python object | Canonical kind | Validation | Oersted planner status |
|---|---|---|---|
| Constant() | constant | no parameters | executable on supported CPU/GPU realizations subject to lane gates |
| Sinusoidal(frequency_hz, phase_rad=0, offset=0) | sinusoidal | frequency finite and positive; phase and offset finite | executable on CPU cylinder paths; CUDA Oersted cylinder rejects it |
| Pulse(t_on, t_off) | pulse | both finite; t_off greater than t_on | executable on CPU cylinder paths; CUDA Oersted cylinder rejects it |
| PiecewiseLinear(points) | piecewise_linear | at least two finite pairs; strictly increasing times | Python-representable; rejected by Oersted planner |
| SincPulse(cutoff_hz, t0=0, amplitude=1) | sinc_pulse | cutoff positive; t0 non-negative and finite; amplitude finite | Python-representable; rejected by Oersted planner |

The half-open pulse convention is fixed: the source is active at t_on and inactive at t_off.

(oersted-api-parameter-reference)=
### Exhaustive parameter table

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| OerstedCylinder.current | float | required | $\mathrm{A}$ | Python converts to float; ProblemIR requires finite | signed current amplitude and chirality | FDM/FEM CPU/GPU subject to lane gates | energy_terms[].current |
| OerstedCylinder.radius | float | required | $\mathrm{m}$ | finite and strictly positive in Python | cylinder radius | FDM/FEM CPU/GPU | energy_terms[].radius |
| OerstedCylinder.center | Sequence[float] | (0, 0, 0) | $\mathrm{m}$ per component | exactly three values in Python; finite values required by IR | cross-section centre | FEM CPU/GPU; FDM CPU; CUDA geometry constraints apply | energy_terms[].center |
| OerstedCylinder.axis | Sequence[float] | (0, 0, 1) | $1$ | exactly three values in Python; finite and non-zero in IR; CUDA requires exact +z | current-flow axis | FEM CPU/GPU; FDM CPU/GPU with CUDA gate | energy_terms[].axis |
| OerstedCylinder.time_dependence | TimeDependence or None | None | $1$ | supported envelope object; planner rejects PWL/Sinc and CUDA non-Constant | current envelope | CPU supports Constant/Sinusoidal/Pulse; CUDA currently Constant only | energy_terms[].time_dependence |
| OerstedField.model | str | from_current_solution | $1$ | only from_current_solution | source-bound realization selector | FDM/FEM lanes subject to source resolution | energy_terms[].model |
| OerstedField.source | str | required | $1$ | non-empty; must name a CurrentTransport in Problem.current_modules | current source binding | FDM/FEM lanes subject to source resolution | energy_terms[].source |
| Constant() | constructor | — | $1$ | no parameters; lowers to constant envelope | unit current envelope | FDM/FEM CPU/GPU, subject to realization | energy_terms[].time_dependence.kind |
| Sinusoidal.frequency_hz | float | required | $\mathrm{Hz}$ | finite and strictly positive | sinusoidal frequency | FDM/FEM CPU; CUDA rejected for Oersted cylinder | ...time_dependence.frequency_hz |
| Sinusoidal.phase_rad | float | 0 | $\mathrm{rad}$ | finite | phase at t=0 | FDM/FEM CPU; CUDA rejected for Oersted cylinder | ...time_dependence.phase_rad |
| Sinusoidal.offset | float | 0 | $1$ | finite | dimensionless DC offset in envelope | FDM/FEM CPU; CUDA rejected for Oersted cylinder | ...time_dependence.offset |
| Pulse.t_on | float | required | $\mathrm{s}$ | finite and strictly less than t_off | activation edge, included | FDM/FEM CPU; CUDA rejected for Oersted cylinder | ...time_dependence.t_on |
| Pulse.t_off | float | required | $\mathrm{s}$ | finite and strictly greater than t_on | deactivation edge, excluded | FDM/FEM CPU; CUDA rejected for Oersted cylinder | ...time_dependence.t_off |
| PiecewiseLinear.points | Sequence[Sequence[float]] | required | $\mathrm{s}$ / $1$ per pair | at least two finite pairs; times strictly increasing; planner rejects for Oersted | piecewise envelope authored but not executable here | Python representation only for this interaction | ...time_dependence.points |
| SincPulse.cutoff_hz | float | required | $\mathrm{Hz}$ | finite and positive | normalized sinc cutoff | Python representation only for this interaction | ...time_dependence.cutoff_hz |
| SincPulse.t0 | float | 0 | $\mathrm{s}$ | finite and non-negative | sinc centre time | Python representation only for this interaction | ...time_dependence.t0 |
| SincPulse.amplitude | float | 1 | $1$ | finite | sinc amplitude | Python representation only for this interaction | ...time_dependence.amplitude |
| CurrentTransport.name | str | required | $1$ | non-empty | named source referenced by OerstedField.source | common source API; planner checks lane | current_modules[].name |
| CurrentTransport.model | str | prescribed_density | $1$ | prescribed_density or ohmic_poisson | current transport model | prescribed density is executable Oersted source; Ohmic is semantic-only | current_modules[].model |
| CurrentTransport.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | exactly three values when supplied; required for prescribed density; forbidden for Ohmic | uniform source current density | FDM/FEM source-bound path subject to geometry and parallelism | current_modules[].current_density |
| CurrentTransport.solve_region | str or None | None | $1$ | non-empty when supplied; required by from_current_solution | geometry or region used as current source | FDM/FEM source-bound path | current_modules[].solve_region |
| CurrentTransport.conductivity_s_per_m | float or None | None | $\mathrm{S\,m^{-1}}$ | finite and positive when supplied | conductivity metadata for transport | not used by prescribed-density Oersted lowering | current_modules[].conductivity_s_per_m |
| SaveField("H_oe", every=...) | field request | — | $\mathrm{A\,m^{-1}}$ | requires one Oersted term and a lane that materializes H_oe | sampled realized Oersted field | planner/lane-dependent | study.sampling.outputs[] |

(oersted-api-problem-ir)=
## Canonical ProblemIR lowering

The stage-first study workflow is the executable path. This page publishes the source-binding
and interaction contract as parameter tables and IR; it does not show a disconnected constructor
cell or claim that a native solver has started.


For this example the interaction fragment is exactly:

```json
{
  "kind": "oersted_field",
  "model": "from_current_solution",
  "source": "drive"
}
```

The source module is a separate IR object and remains separate deliberately:

```json
{
  "kind": "current_transport",
  "name": "drive",
  "model": "prescribed_density",
  "current_density": [0.0, 0.0, 5.0e10],
  "solve_region": "pillar"
}
```

| Python authoring value | Canonical IR destination | Normalization and consequence |
|---|---|---|
| `OerstedField(source="drive")` | `energy_terms[].kind`, `.model`, `.source` | preserves the named source binding; it does not embed a computed field |
| `CurrentTransport.name` | `current_modules[].name` | provides the reference key used by the Oersted term |
| `CurrentTransport.model` | `current_modules[].model` | preserves `prescribed_density` or `ohmic_poisson` |
| `CurrentTransport.current_density` | `current_modules[].current_density` | serializes a three-component SI vector in A/m² |
| `CurrentTransport.solve_region` | `current_modules[].solve_region` | identifies the source region needed by planning |
| `CurrentTransport.conductivity_s_per_m` | `current_modules[].conductivity_s_per_m` | optional SI conductivity metadata; it is not invented for prescribed density |
| `OerstedCylinder(...)` | `energy_terms[].kind`, `.current`, `.radius`, `.center`, `.axis` | keeps the analytic request backend-neutral; native discretization is resolved later |
| `time_dependence` | `energy_terms[].time_dependence` | serializes the envelope kind and its resolved parameters |
| `SaveField("H_oe", every=...)` | `study.sampling.outputs[]` | requests materialization of the realized Oersted field, not merely the source current |

(oersted-api-round-trip-and-failure-semantics)=
## Round-trip, planning, and failure semantics

Requested intent consists of the Python class, SI values, source name, current-transport model,
time envelope, output request, and any authored geometry/region identifiers. Resolved execution is
separate: it contains the selected FDM or FEM lane, CPU or GPU device, precision, mesh, analytic or
midpoint realization, source-cell count, output materialization, and qualification evidence. A
canonical export must preserve requested intent even when the planner rejects the requested lane;
it must not rewrite `OerstedField` into `OerstedCylinder` or silently select a CPU fallback.

Validation errors happen before native execution. The relevant classes are:

| Stage | Failure | Required behavior |
|---|---|---|
| Python constructor | empty source, unsupported model, non-positive radius, malformed vector, or invalid envelope | raise a deterministic `TypeError` or `ValueError`; do not create a plausible partial object |
| Problem construction | duplicate current-module names or a term referring to an absent source | reject the inconsistent object graph |
| ProblemIR validation | non-finite current/vector, zero axis, more than one Oersted term, or an absent source record | fail closed in `validate_oersted_energy_terms` |
| Planner | missing source `solve_region`, non-cylindrical exact-cylinder geometry, transverse current component, unsupported envelope, or FDM active-source limit | return an explicit unsupported/error decision with the reason |
| Runtime | missing native field materialization or failed device transfer | fail the run and preserve provenance; never report a CPU result as GPU execution |

The Python constructor can represent values whose selected lane cannot execute. These unsupported
combinations are reported by planning rather than silently rewritten. The planner reports
unsupported combinations explicitly. In particular,
`ohmic_poisson` is a valid current-transport model at the Python/IR boundary but is not currently
an executable Oersted source in the planner. `PiecewiseLinear` and `SincPulse` follow the same
representable-but-not-currently-plannable distinction. This is intentional: serialization preserves
the user's model, while planning reports the exact capability gap.

(oersted-api-discrete-realization)=
## Discrete realization and backend matrix

The analytic cylinder and source-bound field are one physical contract with four distinct numerical
realizations. The Python API does not duplicate the equations for each device.

### FDM CPU

The FDM CPU lane adds the analytic cylinder field at cell centres through the implementation
identified by `oersted_field_add_into`. For a source-bound request, the planner may either reduce a
uniform cylindrical current to the analytic closed form or construct a regularized midpoint
Biot–Savart field over source cells. The cell-centre geometry, active-source selection, and source
volume therefore affect the discrete values. This lane is the scalar/reference realization, not a
promise that every generalized source has a continuum-exact solution.

### FDM GPU

The CUDA lane precomputes a unit-current basis through `context_precompute_oersted_field` and then
scales or uploads that basis during execution. The native CUDA analytic-cylinder gate currently
requires the axis `[0, 0, 1]`, and the CUDA cylinder path accepts only `None` or `Constant()` time
dependence. A generalized midpoint path is subject to its active-source-cell limit and to
executed-device parity evidence. A compiled CUDA kernel is not itself proof of GPU qualification.

### FEM CPU

The FEM CPU lane can build an analytic-cylinder nodal basis through
`initialize_oersted_cylinder_field`, dispatch it through `add_oersted_field`, or add an already
resolved generalized field through `add_explicit_oersted_field`. The latter must not rescale a
generalized field as though it were an analytic cylinder. Source-element centroids and equivalent
volumes define the regularized midpoint approximation for the generalized path.

### FEM GPU

The FEM CUDA lane accumulates the realized field at Runge–Kutta stage time through
`gpu_rk_accumulate_oersted_field`. Host-side planning and field construction remain distinct from
device execution; field values, snapshots, transfer identity, and parity must be recorded before
the lane is called qualified. The common Python/IR representation is the same as FEM CPU, but the
native accumulation and evidence boundary are not.

| Solver | CPU | GPU |
|---|---|---|
| FDM | analytic cylinder and regularized midpoint cell-centre reference paths; generalized convergence remains partial | CUDA unit-current basis and generalized upload paths; axis/envelope gates and executed-device parity remain explicit |
| FEM | MFEM nodal analytic basis plus explicit generalized field path; midpoint quadrature uses element volume regularization | CUDA stage accumulation of the resolved field; native device evidence is required |

(oersted-api-implementation-mapping)=
## Implementation mapping

The source identity is a repository path plus a stable declaration symbol. This is deliberately
dynamic: documentation remains valid when code is inserted and line numbers move. The source-code
index at the end of this page repeats every claim used above.

| API or claim | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| analytic-cylinder constructor and IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedCylinder` | validates constructor data and serializes the analytic request |
| source-bound constructor and IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedField` | validates model/source and serializes the source binding |
| current envelope | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Sinusoidal` | validates and serializes sinusoidal time dependence |
| current source | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | validates source model, density, region, and conductivity |
| ProblemIR gate | `crates/fullmag-ir/src/validation.rs` | `validate_oersted_energy_terms` | validates finite values, axis, source identity, and term count |
| common planner | `crates/fullmag-plan/src/oersted.rs` | `resolve_oersted_term` | dispatches analytic and source-bound requests |
| FEM planner | `crates/fullmag-plan/src/oersted.rs` | `resolve_fem_oersted_term` | selects FEM analytic or generalized realization |
| FDM planner | `crates/fullmag-plan/src/oersted.rs` | `resolve_fdm_oersted_term` | selects FDM analytic or generalized realization |
| FEM midpoint quadrature | `crates/fullmag-plan/src/oersted.rs` | `midpoint_biot_savart_field` | tet4 centroid quadrature and equivalent-volume regularization |
| FDM midpoint quadrature | `crates/fullmag-plan/src/oersted.rs` | `midpoint_biot_savart_grid_field` | cell-centre quadrature and active-source limit |
| FDM CPU execution | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `oersted_field_add_into` | adds the analytic/reference FDM field |
| FDM CUDA execution | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_precompute_oersted_field` | builds and uploads the CUDA unit-current basis |
| FEM CPU cylinder | `backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp` | `initialize_oersted_cylinder_field` | constructs the nodal analytic basis |
| FEM CPU dispatch | `backends/fem/cpu/mfem/interactions/oersted.cpp` | `add_oersted_field` | dispatches the realized field in the FEM CPU path |
| FEM CPU explicit field | `backends/fem/cpu/mfem/interactions/oersted_explicit.cpp` | `add_explicit_oersted_field` | adds a generalized resolved field without cylinder rescaling |
| FEM CUDA execution | `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu` | `gpu_rk_accumulate_oersted_field` | accumulates the stage-time field on device |
| conservative relaxation gate | `crates/fullmag-plan/src/validate.rs` | `validate_conservative_relaxation` | rejects unqualified Oersted field-energy use |

(oersted-api-validation)=
## Validation evidence and required checks

The API contract is checked at four different levels:

1. Every copyable Python block is parsed and executed with the repository Python package. The
   assertions verify the exact Oersted term, current module, and `H_oe` output record.
2. The adjacent source map verifies required sections, labelled equations, SI symbol rows,
   exhaustive parameter rows, unique source declarations, and path-plus-symbol mappings.
3. Planner and IR tests verify invalid source references, finite-value rules, axis legality,
   exact-cylinder reduction preconditions, unsupported envelopes, and active-source limits.
4. Native FDM/FEM tests and managed runtime checks determine field, energy, derivative, transfer,
   and CPU/GPU qualification. Constructor lowering, source inspection, or a compiled CUDA kernel
   alone is not field-parity evidence.

The current page status is `partial` because source implementations exist in all four lanes, while
executed-device parity and generalized-source convergence evidence are tracked separately. The
status is not upgraded by documentation alone.

(oersted-api-limitations)=
## Limitations

- The current Python/IR contract exposes Oersted field sources; it does not expose a separate
  electric-field or Joule-heating interaction through these classes.
- `CurrentTransport(model="ohmic_poisson")` is representable but not currently executable as an
  Oersted source-bound plan.
- Exact analytic-cylinder reduction requires the geometry and current-density conditions enforced
  by the planner; otherwise the result is a regularized discrete approximation or an explicit
  unsupported decision.
- CUDA axis and envelope restrictions are lane-specific and must not be inferred from CPU support.
- Conservative relaxation remains fail-closed until field-energy parity is qualified.
- A Python-to-IR round trip does not prove mesh convergence, native runtime completion, or
  executed-device identity.

(oersted-api-scientific-bibliography)=
## Scientific bibliography

1. J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1999, chapters 5 and 6.
2. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
3. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376,
   [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).
4. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
5. Fullmag canonical physical owner: {doc}`../../physics/interactions/oersted-field/index`.

(oersted-api-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Lane | Evidence status |
|---|---|---|---|---|
| analytic-cylinder constructor and IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedCylinder` | Python/IR | source mapped |
| source-bound constructor and IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedField` | Python/IR | source mapped |
| sinusoidal envelope | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Sinusoidal` | Python/IR | source mapped |
| current transport | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | Python/IR | source mapped |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_oersted_energy_terms` | IR | source mapped |
| common planner | `crates/fullmag-plan/src/oersted.rs` | `resolve_oersted_term` | planner | source mapped |
| FEM planner | `crates/fullmag-plan/src/oersted.rs` | `resolve_fem_oersted_term` | FEM | source mapped |
| FDM planner | `crates/fullmag-plan/src/oersted.rs` | `resolve_fdm_oersted_term` | FDM | source mapped |
| FEM midpoint quadrature | `crates/fullmag-plan/src/oersted.rs` | `midpoint_biot_savart_field` | FEM | source mapped |
| FDM midpoint quadrature | `crates/fullmag-plan/src/oersted.rs` | `midpoint_biot_savart_grid_field` | FDM | source mapped |
| FDM CPU field addition | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `oersted_field_add_into` | FDM CPU | source mapped |
| FDM CUDA basis | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_precompute_oersted_field` | FDM GPU | source mapped |
| FEM CPU cylinder basis | `backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp` | `initialize_oersted_cylinder_field` | FEM CPU | source mapped |
| FEM CPU dispatch | `backends/fem/cpu/mfem/interactions/oersted.cpp` | `add_oersted_field` | FEM CPU | source mapped |
| FEM CPU explicit field | `backends/fem/cpu/mfem/interactions/oersted_explicit.cpp` | `add_explicit_oersted_field` | FEM CPU | source mapped |
| FEM CUDA accumulation | `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.cu` | `gpu_rk_accumulate_oersted_field` | FEM GPU | source mapped |
| relaxation gate | `crates/fullmag-plan/src/validate.rs` | `validate_conservative_relaxation` | planner | source mapped |
