---
title: Drift-diffusion spin torque
status: semantic-only
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-drift-diffusion-stt)=
# Drift-diffusion spin torque

:::{admonition} Current status
:class: warning

DriftDiffusionSpinTorque is a semantic-only Python object. It validates and serializes
the requested model, but the current planner has no executable backend lane for it. This
page therefore separates the intended transport equations from the implemented Python
contract and does not claim a running drift-diffusion solver.
:::

The interaction belongs under spin-transfer torque because the transport solution supplies
a torque to the magnetization equation. It is not the same approximation as prescribed
current Slonczewski or Zhang-Li torque: those models consume an already prescribed current
and do not solve the spin-accumulation transport problem.

(ddst-problem-statement)=
## Physical problem

A drift-diffusion model couples charge/spin transport, spin-flip relaxation, exchange
precession, interface conditions, and LLG dynamics. The transport state is spatially
resolved and normally depends on geometry, conductivity, spin diffusion, interface
polarization, and boundary conditions. Fullmag currently exposes only a compact semantic
request containing the current binding, polarization, efficiency, non-adiabatic parameter,
and spin-diffusion length. The remaining transport coefficients are not public constructor
parameters and must not be invented in documentation.

(ddst-governing-equations)=
## Governing equations

The following equations describe the intended continuum contract; they are not evidence
that a backend currently assembles or solves them. Let $\mathbf s$ denote the spin
accumulation and $\mathbf J_s$ the spin-current tensor. A minimal steady/time-dependent
transport balance is

```{math}
:label: eq-ddst-transport
\frac{\partial\mathbf s}{\partial t}
=-\nabla\cdot\mathbf J_s
-\frac{\mathbf s}{\tau_{\mathrm{sf}}}
-\frac{\mathbf s\times\mathbf m}{\tau_{\mathrm{ex}}}
+\mathbf q_{\mathrm{src}}.
```

The exchange-transfer torque density is represented by

```{math}
:label: eq-ddst-torque
\boldsymbol{\tau}_{\mathrm{DD}}
=-\frac{1}{\tau_{\mathrm{ex}}}\mathbf s\times\mathbf m.
```

For a reduced one-parameter diffusion closure, the spin accumulation length satisfies

```{math}
:label: eq-ddst-length
\lambda_{\mathrm{sf}}=\sqrt{D_{\mathrm{s}}\tau_{\mathrm{sf}}},
```

where $D_{\mathrm{s}}$ is a spin-diffusion coefficient. That coefficient, the relaxation
times, source term, and boundary conditions are not represented by the current public
constructor. The equations are therefore a model specification for future lowering, not
a claim of a resolved numerical approximation.

(ddst-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf s$ | spin-accumulation state | $\mathrm{A\,s\,m^{-3}}$ |
| $\mathbf J_s$ | spin-current tensor | $\mathrm{A\,m^{-2}}$ |
| $\tau_{\mathrm{sf}}$ | spin-flip relaxation time | $\mathrm{s}$ |
| $\tau_{\mathrm{ex}}$ | exchange-transfer time | $\mathrm{s}$ |
| $\mathbf q_{\mathrm{src}}$ | spin-source density | $\mathrm{A\,s\,m^{-3}\,s^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\boldsymbol{\tau}_{\mathrm{DD}}$ | intended drift-diffusion torque density | $\mathrm{A\,s\,m^{-3}\,s^{-1}}$ |
| $\lambda_{\mathrm{sf}}$ | spin-diffusion length | $\mathrm{m}$ |
| $D_{\mathrm{s}}$ | spin-diffusion coefficient | $\mathrm{m^2\,s^{-1}}$ |
| $\nabla$ | spatial differential operator | $\mathrm{m^{-1}}$ |
| $\mathbf r$ | spatial position | $\mathrm{m}$ |
| $P$ | spin-polarization efficiency, Python degree | $1$ |
| $\beta$ | non-adiabatic transport parameter | $1$ |
| $\mathbf p$ | authored spin-polarization vector | $1$ |
| $\mathbf J$ | authored charge-current density vector | $\mathrm{A\,m^{-2}}$ |

(ddst-assumptions-and-validity)=
## Assumptions and validity

- The equations above are the intended continuum model, not an implemented solver.
  Transport closure, interface conditions, and source normalization remain unresolved in
  the public runtime.
- current_density is a finite three-component vector in A m^-2. current_source is a
  non-empty symbolic current binding. Exactly one of these two bindings is required.
- spin_polarization is a finite three-component vector. The current Python validator
  checks shape and finiteness but does not normalize it or enforce unit length.
- degree satisfies $0<P\leq1$. beta satisfies $\beta\geq0$. The spin-diffusion length is
  strictly positive.
- No claim is made about a particular interface resistance, spin Hall source, charge
  continuity equation, or boundary operator because those inputs are not in the current
  public object.
- Python construction and IR serialization cannot qualify a numerical transport model.

(ddst-python-api)=
## Python API

The current public object is DriftDiffusionSpinTorque. It is an object-level semantic
fragment because the stage builder does not expose an executable drift-diffusion torque
registration method.

```python
# %% Drift-diffusion semantic request; no solver is launched.
import json
from fullmag.model.spin_torque import DriftDiffusionSpinTorque

dd = DriftDiffusionSpinTorque(
    current_density=(0.0, 0.0, 1.0e10),
    spin_polarization=(0.0, 0.0, 1.0),
    degree=0.4,
    beta=0.01,
    spin_diffusion_length_m=5.0e-9,
)
print(json.dumps(dd.to_ir_module(), indent=2))
```

To bind transport to an external current module, replace current_density with a non-empty
current_source name. Supplying both is rejected.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | exactly three finite components; exclusive with source | prescribed charge-current vector | semantic only | spin_torques[].current_density |
| current_source | str or None | None | $1$ | non-empty; exclusive with density | symbolic current provider | semantic only | spin_torques[].current_source |
| spin_polarization | Sequence[float] | (0,0,1) | $1$ | three finite components; not normalized | polarization direction/data | semantic only | spin_torques[].spin_polarization |
| degree | float | 0.4 | $1$ | $0<P\leq1$ | polarization efficiency | semantic only | spin_torques[].degree |
| beta | float | 0.0 | $1$ | $\beta\geq0$ | non-adiabatic coefficient | semantic only | spin_torques[].beta |
| spin_diffusion_length_m | float | $5e-9$ | $\mathrm{m}$ | strictly positive and finite | spin-diffusion length | semantic only | spin_torques[].spin_diffusion_length_m |

(ddst-problem-ir)=
## ProblemIR lowering

The Python object emits a module fragment with kind drift_diffusion. With the example
above, the canonical payload is

```json
{
  "kind": "drift_diffusion",
  "spin_polarization": [0.0, 0.0, 1.0],
  "degree": 0.4,
  "beta": 0.01,
  "spin_diffusion_length_m": 5e-09,
  "current_density": [0.0, 0.0, 10000000000.0]
}
```

The mapping preserves finite scalar values in SI units and converts vectors to JSON lists.
It omits the unused current binding:

| Python field | IR field | Normalization |
|---|---|---|
| current_density | current_density | tuple/list of three finite floats |
| current_source | current_source | non-empty string; mutually exclusive |
| spin_polarization | spin_polarization | three finite floats, no normalization |
| degree | degree | float in (0, 1] |
| beta | beta | float at least zero |
| spin_diffusion_length_m | spin_diffusion_length_m | positive float |
| object kind | kind | drift_diffusion |

(ddst-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the validated semantic module and its original current binding. Resolved
execution currently contains no executable drift-diffusion realization; strict planning
must therefore report unsupported capability rather than synthesize a prescribed-current
torque.

Python raises when both or neither current bindings are supplied, the source name is empty,
a vector does not have three finite components, degree is outside (0,1], beta is negative,
or the diffusion length is not strictly positive. The object is not a solver result and
cannot be used as evidence of transport convergence. Validation errors and unsupported
combinations are reported before execution. Resolved execution is currently absent.
Unsupported combinations are rejected rather than silently substituted.

(ddst-discrete-realization)=
## Discrete realization

### FDM CPU

Unsupported. No drift-diffusion transport state, spin-current discretization, or torque
assembly is materialized in the FDM CPU lane.

### FDM GPU

Unsupported. No device transport solve, boundary exchange, or spin-accumulation reduction
is materialized. The semantic object is not a CUDA kernel qualification.

### FEM CPU

Unsupported. No weak form, trace/interface operator, spin-transport finite-element space,
or coupled linear/nonlinear solve is currently owned by the FEM CPU runtime.

### FEM GPU

Unsupported. No device FEM transport operator, residency contract, precision policy, or
runtime evidence exists for this interaction.

The four lanes are intentionally marked unsupported rather than described as equivalent.

(ddst-implementation-mapping)=
## Implementation mapping

DriftDiffusionSpinTorque validates the compact semantic request and emits the
drift_diffusion module payload. The current spin-torque module documentation identifies
SlonczewskiSTT, ZhangLiSTT, and SpinOrbitTorque as the executable subset; this object is
outside that subset. No backend source symbol is cited as an implementation because no
backend realization exists.

(ddst-validation)=
## Validation

Current tests cover constructor validation and the drift_diffusion IR kind and length.
Future implementation tests must add charge/spin continuity, interface boundary conditions,
spin-current conservation, torque sign, mesh refinement, timestep/linear-solver tolerance,
and FDM/FEM CPU/GPU parity. Device claims require an executed managed runtime and device
identity; source presence or serialization is not qualification.

(ddst-limitations)=
## Limitations

The public object lacks conductivity, spin-flip time, exchange time, spin-source amplitude,
interface resistance, spin-mixing conductance, transport boundary conditions, and a stage
registration hook. It is therefore a semantic contract for future implementation, not a
runnable drift-diffusion simulation.

(ddst-scientific-bibliography)=
## Scientific bibliography

1. S. Zhang, P. M. Levy, and A. Fert, “Mechanisms of spin-polarized current-driven
   magnetization switching,” Physical Review Letters 88, 236601 (2002),
   [doi:10.1103/PhysRevLett.88.236601](https://doi.org/10.1103/PhysRevLett.88.236601).
2. C. Petitjean, D. Luc, and X. Waintal, “Unified drift-diffusion theory for transverse
   spin currents,” Physical Review Letters 109, 117204 (2012),
   [doi:10.1103/PhysRevLett.109.117204](https://doi.org/10.1103/PhysRevLett.109.117204).

(ddst-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Semantic constructor | packages/fullmag-py/src/fullmag/model/spin_torque.py | class DriftDiffusionSpinTorque | parameter validation and object state | Python | test_stno_spin_torque.py |
| Polarization validation | packages/fullmag-py/src/fullmag/model/spin_torque.py | _validated_degree | range for P | Python | constructor tests |
| Non-adiabatic validation | packages/fullmag-py/src/fullmag/model/spin_torque.py | _validated_beta | beta lower bound | Python | constructor tests |
| Current binding | packages/fullmag-py/src/fullmag/model/spin_torque.py | _resolve_current_binding | mutually exclusive required input | Python | constructor tests |
| Canonical module fragment | packages/fullmag-py/src/fullmag/model/spin_torque.py | to_ir_module | drift_diffusion payload | Python | test_drift_diffusion_to_ir_module |
