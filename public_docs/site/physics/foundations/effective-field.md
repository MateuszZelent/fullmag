---
title: Effective field
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
source_of_truth: backends/fem/cpu/mfem/interactions/effective_field.cpp and backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu
---

(public-docs-physics-foundations-effective-field)=
(foundation-effective-field-problem-statement)=
# Effective field

Field-form interactions are composed into H_eff in A/m. The LLG RHS consumes that field;
direct torque terms remain RHS quantities and are not reinterpreted as fields.

(foundation-effective-field-governing-equations)=
## Governing equations

```{math}
:label: eq-foundation-effective-field-sum
\mathbf{H}_{\mathrm{eff}}=\sum_{k\in\mathcal{K}_{\mathrm{field}}}\mathbf{H}_k.
```

```{math}
:label: eq-foundation-effective-field-variation
\delta E_k[\mathbf{m};\boldsymbol{\eta}]
=-\mu_0\int_{\Omega_m}M_s\,\mathbf{H}_k\cdot\boldsymbol{\eta}\,\mathrm{d}V.
```

```{math}
:label: eq-foundation-effective-field-direct-torque
\left.\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\right|_{\mathrm{total}}
=\left.\frac{\mathrm{d}\mathbf{m}}{\mathrm{d}t}\right|_{\mathrm{LLG}(\mathbf{H}_{\mathrm{eff}})}
+\boldsymbol{\tau}_{\mathrm{direct}}.
```

(foundation-effective-field-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf{H}_{\mathrm{eff}}$ | composed field-form effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_k$ | field contribution of interaction k | $\mathrm{A\,m^{-1}}$ |
| $\mathcal{K}_{\mathrm{field}}$ | enabled field-form interaction set | $1$ |
| $\boldsymbol{\tau}_{\mathrm{direct}}$ | direct RHS torque | $\mathrm{s^{-1}}$ |
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\eta}$ | tangent variation | $1$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |

(foundation-effective-field-assumptions-and-validity)=
## Assumptions and validity

Each interaction owns its sign and energy convention. The variational identity is evaluated
on magnetic degrees of freedom. FEM and FDM can differ in quadrature, mass projection,
boundary treatment, precision, and memory placement.

(foundation-effective-field-python-api)=
## Python API

Canonical interaction pages own term constructors. This stage-first capture shows the public
execution boundary without inventing a top-level Problem constructor.

```python
# %%
import fullmag as fm
from fullmag.model.energy import Exchange, Zeeman

nm = 1.0e-9
study = fm.study("effective_field_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
exchange_ir = Exchange().to_ir()
zeeman_ir = Zeeman(B=(0.0, 0.0, 1.0e-3)).to_ir()
study.stages.add_relax(stage_id="equilibrium", dt=5.0e-13, max_steps=1)
```

Exchange has no constructor parameters. Zeeman.B is a three-component finite induction
vector at the Python boundary.

| Python entry point | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| Zeeman.B | Sequence[float] | required | $\mathrm{T}$ | exactly three finite components | external induction vector | FDM/FEM authoring; executable lane is planner-gated | energy_terms[].B |

(foundation-effective-field-problem-ir)=
## ProblemIR

Exchange.to_ir() and Zeeman.to_ir() produce typed energy-term fragments. A complete
ProblemIR additionally contains geometry, materials, magnets, study, and backend policy;
lowering creates that complete object.

(foundation-effective-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves field source and target. Resolved execution records realization,
precision, and device. Validation errors reject malformed vectors or incompatible terms.
Unsupported combinations fail closed and are not converted to another field path.

(foundation-effective-field-discrete-realization)=
## Discrete realization

| Lane | Composition owner | Status |
|---|---|---|
| FDM CPU | cell fields and CPU dispatch | partial; numerical qualification is separate |
| FDM GPU | device buffers and CUDA dispatch | partial; executed-device evidence is required |
| FEM CPU | compute_effective_fields_for_magnetization | partial; weak/discrete details are lane-specific |
| FEM GPU | gpu_rk_accumulate_effective_field | partial; build presence is not runtime proof |

(foundation-effective-field-implementation-mapping)=
## Implementation mapping

Python energy objects own authoring and to_ir serialization. FEM CPU and FEM GPU have
separate effective-field composition functions; LLG kernels consume the composed field.

(foundation-effective-field-validation)=
## Validation

The source map checks every stable symbol and equation mapping. The example is parsed as
Python. Field-energy derivative tests and executed GPU parity remain separate evidence.

(foundation-effective-field-limitations)=
## Limitations

This overview does not claim every interaction is executable on every lane. Direct torque
equations and qualification evidence remain on canonical interaction pages.

(foundation-effective-field-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, 1963.
   [WorldCat record](https://search.worldcat.org/title/536451).
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(foundation-effective-field-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| Python exchange authoring | packages/fullmag-py/src/fullmag/model/energy.py | class Exchange | serializes exchange term | all authoring lanes | source-backed |
| Python Zeeman authoring | packages/fullmag-py/src/fullmag/model/energy.py | class Zeeman | validates and serializes B | all authoring lanes | source-backed |
| canonical container | crates/fullmag-ir/src/lib.rs | ProblemIR | stores energy terms | all lanes | source-backed |
| FEM CPU composition | backends/fem/cpu/mfem/interactions/effective_field.cpp | compute_effective_fields_for_magnetization | composes CPU fields | FEM CPU | source-backed |
| FEM GPU composition | backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu | gpu_rk_accumulate_effective_field | accumulates GPU fields | FEM GPU | source-backed |
| FEM CPU RHS | backends/fem/cpu/mfem/integrators/llg_rhs.cpp | llg_rhs_aos | consumes composed field | FEM CPU | source-backed |
| FEM GPU RHS | backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu | fullmag_cuda_llg_rhs_fused | consumes composed field | FEM GPU | source-backed |
