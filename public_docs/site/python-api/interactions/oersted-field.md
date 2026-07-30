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
{doc}\`../../physics/interactions/oersted-field\`. This page owns constructor signatures,
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

\`\`\`{math}
:label: eq-oersted-api-field
\mathbf H_{\mathrm{eff}}(\mathbf x,t)
=\mathbf H_{\mathrm{det}}(\mathbf x,t)+\mathbf H_{\mathrm{oe}}(\mathbf x,t).
\`\`\`

The direct cylinder request is represented by

\`\`\`{math}
:label: eq-oersted-api-ir-cylinder
\mathrm{IR}_{\mathrm{oe,cyl}}
=\{\texttt{kind}:\texttt{"oersted_cylinder"},\n+\texttt{current}:I_0,\n+\texttt{radius}:R,\n+\texttt{center}:\mathbf c,\n+\texttt{axis}:\hat{\mathbf a}\}.
\`\`\`

The source-bound request is represented by

\`\`\`{math}
:label: eq-oersted-api-ir-source
\mathrm{IR}_{\mathrm{oe,src}}
=\{\texttt{kind}:\texttt{"oersted_field"},\n+\texttt{model}:\texttt{"from_current_solution"},\n+\texttt{source}:s\}.
\`\`\`

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
| $I_0$ | analytic-cylinder current amplitude | $\mathrm{A}$ |
| $R$ | analytic-cylinder radius | $\mathrm{m}$ |
| $\mathbf c$ | cylinder centre | $\mathrm{m}$ |
| $\hat{\mathbf a}$ | cylinder current-flow axis | $1$ |
| $s$ | name of the current source module | $1$ |
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

\`\`\`python
# %% Direct analytic-cylinder object
import fullmag as fm

term = fm.OerstedCylinder(
    current=5.0e-3,
    radius=50.0e-9,
    center=(0.0, 0.0, 0.0),
    axis=(0.0, 0.0, 1.0),
    time_dependence=fm.Sinusoidal(
        frequency_hz=1.0e9,
        phase_rad=0.0,
        offset=0.25,
    ),
)
assert term.to_ir()["kind"] == "oersted_cylinder"
print(term.to_ir())
\`\`\`

The signed current controls field chirality. The Python constructor requires a positive radius,
accepts exactly three values for center and axis, and stores the values as tuples. It does not
normalize the axis in Python; ProblemIR and the selected native lane own that legality and
normalization boundary.

### OerstedField

OerstedField binds to a named CurrentTransport:

\`\`\`python
# %% Source-bound object
import fullmag as fm

source = fm.CurrentTransport(
    name="drive",
    model="prescribed_density",
    current_density=(0.0, 0.0, 5.0e10),
    solve_region="pillar",
)
term = fm.OerstedField(
    model="from_current_solution",
    source=source.name,
)
assert term.to_ir() == {
    "kind": "oersted_field",
    "model": "from_current_solution",
    "source": "drive",
}
print(source.to_ir())
print(term.to_ir())
\`\`\`

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
