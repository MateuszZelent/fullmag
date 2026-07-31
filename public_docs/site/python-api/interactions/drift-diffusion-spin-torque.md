---
title: Drift-diffusion spin torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: public_docs/site/physics/interactions/drift-diffusion-spin-torque/index.md
---

(public-docs-python-api-interactions-drift-diffusion-spin-torque)=
# Drift-diffusion spin torque Python API

DriftDiffusionSpinTorque is currently a semantic-only public object. It validates a
compact request and lowers it to a spin-torque module fragment; it is not executable on
FDM CPU, FDM GPU, FEM CPU, or FEM GPU.

(api-ddst-problem-statement)=
## Physical problem

The object names a future self-consistent spin-transport torque. It must not be confused
with the currently executable prescribed-current Slonczewski or Zhang-Li classes.

(api-ddst-governing-equations)=
## Governing equations

The intended transport and torque forms are owned by the physics page:

```{math}
:label: eq-api-ddst-transport
\frac{\partial\mathbf s}{\partial t}
=-\nabla\cdot\mathbf J_s-\frac{\mathbf s}{\tau_{\mathrm{sf}}}
-\frac{\mathbf s\times\mathbf m}{\tau_{\mathrm{ex}}}
+\mathbf q_{\mathrm{src}}.
```

```{math}
:label: eq-api-ddst-torque
\boldsymbol{\tau}_{\mathrm{DD}}
=-\frac{1}{\tau_{\mathrm{ex}}}\mathbf s\times\mathbf m.
```

(api-ddst-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf s$ | spin accumulation | $\mathrm{A\,s\,m^{-3}}$ |
| $\mathbf J_s$ | spin-current tensor | $\mathrm{A\,m^{-2}}$ |
| $\tau_{\mathrm{sf}}$ | spin-flip time | $\mathrm{s}$ |
| $\tau_{\mathrm{ex}}$ | exchange-transfer time | $\mathrm{s}$ |
| $\boldsymbol{\tau}_{\mathrm{DD}}$ | intended torque density | $\mathrm{A\,s\,m^{-3}\,s^{-1}}$ |
| $\lambda_{\mathrm{sf}}$ | spin-diffusion length | $\mathrm{m}$ |
| $\mathbf J$ | charge-current density input | $\mathrm{A\,m^{-2}}$ |
| $P$ | degree parameter | $1$ |
| $\beta$ | non-adiabatic parameter | $1$ |
| $\mathbf p$ | spin-polarization vector | $1$ |
| $\mathbf m$ | reduced magnetization | $1$ |

(api-ddst-assumptions-and-validity)=
## Assumptions and validity

The current object exposes no transport coefficients, interface conditions, or solver
policy. Only constructor validation and IR serialization are implemented. A stage-first
simulation example is therefore not possible without inventing an unsupported registration
method; the copyable block below intentionally inspects the object only.

(api-ddst-python-api)=
## Complete constructor


| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | three finite values; exclusive with source | prescribed current vector | semantic only | current_density |
| current_source | str or None | None | $1$ | non-empty; exclusive with density | symbolic current provider | semantic only | current_source |
| spin_polarization | Sequence[float] | (0,0,1) | $1$ | three finite values; no normalization | polarization vector | semantic only | spin_polarization |
| degree | float | 0.4 | $1$ | 0 < degree <= 1 | efficiency P | semantic only | degree |
| beta | float | 0.0 | $1$ | beta >= 0 | non-adiabatic coefficient | semantic only | beta |
| spin_diffusion_length_m | float | 5e-9 | $\mathrm{m}$ | strictly positive | diffusion length | semantic only | spin_diffusion_length_m |

(api-ddst-problem-ir)=
## ProblemIR lowering

For a density-bound request, to_ir_module emits:

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

The unused current binding is omitted. Values are converted to JSON lists and finite
scalars are preserved in SI units.

(api-ddst-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the validated semantic object and its chosen current binding. Resolved
execution is unsupported in the current planner. Python rejects both-or-neither current
bindings, empty source names, wrong-length or non-finite vectors, degree outside (0,1],
negative beta, and non-positive diffusion length. Strict planning must report unsupported
capability; it must not substitute another torque model.
Validation errors and unsupported combinations are explicit. Resolved execution is absent
rather than silently substituted with another torque model.

(api-ddst-discrete-realization)=
## Discrete realization

All four lanes are unsupported. There is no transport state, spin-current operator, weak
form, CUDA kernel, device residency contract, or runtime qualification for this object.
The absence is intentional in the capability matrix and is not CPU/GPU parity.

(api-ddst-implementation-mapping)=
## Implementation mapping

The source class owns validation and to_ir_module owns canonical fragment emission. The
current executable subset is defined in the spin-torque module source documentation and
does not include DriftDiffusionSpinTorque.

(api-ddst-validation)=
## Validation

The focused spin-torque tests cover constructor lowering and diffusion-length emission.
Future implementation requires transport conservation, boundary-condition, torque-sign,
mesh/timestep/linear-solver, refinement, and matched CPU/GPU runtime tests.

(api-ddst-limitations)=
## Limitations

No public stage registration, transport closure, interface model, output quantity,
planner capability, or runtime realization exists. This page documents the present
semantic contract and its explicit unsupported boundary.

(api-ddst-scientific-bibliography)=
## Scientific bibliography

- Zhang, Levy, and Fert, Physical Review Letters 88, 236601 (2002),
  DOI 10.1103/PhysRevLett.88.236601.
- Petitjean, Luc, and Waintal, Physical Review Letters 109, 117204 (2012),
  DOI 10.1103/PhysRevLett.109.117204.

(api-ddst-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Constructor | packages/fullmag-py/src/fullmag/model/spin_torque.py | class DriftDiffusionSpinTorque | public state and validation | Python | test_stno_spin_torque.py |
| Current binding | packages/fullmag-py/src/fullmag/model/spin_torque.py | _resolve_current_binding | exclusive current inputs | Python | constructor tests |
| Degree validation | packages/fullmag-py/src/fullmag/model/spin_torque.py | _validated_degree | P range | Python | constructor tests |
| Beta validation | packages/fullmag-py/src/fullmag/model/spin_torque.py | _validated_beta | beta lower bound | Python | constructor tests |
| IR module | packages/fullmag-py/src/fullmag/model/spin_torque.py | to_ir_module | canonical payload | Python | test_drift_diffusion_to_ir_module |
