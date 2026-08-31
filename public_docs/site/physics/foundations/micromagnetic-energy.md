---
title: Micromagnetic energy
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
source_of_truth: packages/fullmag-py/src/fullmag/model/energy.py and packages/fullmag-py/src/fullmag/world.py
---

(public-docs-physics-foundations-micromagnetic-energy)=
(foundation-energy-problem-statement)=
# Micromagnetic energy

Fullmag represents physical contributions as typed energy terms. This page owns the shared
variational contract and composition rule; interaction-specific equations and parameters
remain on their canonical owner pages.

(foundation-energy-governing-equations)=
## Governing equations

```{math}
:label: eq-foundation-energy-sum
E[\mathbf{m}]=\sum_{k\in\mathcal{K}}E_k[\mathbf{m}].
```

```{math}
:label: eq-foundation-energy-variation
\delta E_k[\mathbf{m};\boldsymbol{\eta}]
=-\mu_0\int_{\Omega_m}M_s\,\mathbf{H}_k\cdot\boldsymbol{\eta}\,\mathrm{d}V.
```

(foundation-energy-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $E$ | total magnetic energy | $\mathrm{J}$ |
| $E_k$ | energy of term k | $\mathrm{J}$ |
| $\mathcal{K}$ | enabled energy-term index set | $1$ |
| $\mathbf{m}$ | reduced magnetization | $1$ |
| $\mathbf{H}_k$ | field derived from term k | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\eta}$ | tangent variation | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |

(foundation-energy-assumptions-and-validity)=
## Assumptions and validity

The sum includes only explicitly enabled terms. Each interaction owns its sign, units,
discretization, and boundary law. FEM and FDM reductions can use different weights and
quadrature, so the composition equation alone is not a parity claim.

(foundation-energy-python-api)=
## Python API

Canonical term constructors are documented on their interaction owner pages. These exact
object-level boundaries can be inspected without inventing a top-level Problem constructor.

```python
# %%
import fullmag as fm
from fullmag.model.energy import Exchange, Zeeman

nm = 1.0e-9
study = fm.study("energy_reference")
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

The local foundation API owns no additional constructor parameters. Use interaction pages
for complete argument tables, support matrices, and rejection semantics.

(foundation-energy-problem-ir)=
## ProblemIR

Exchange.to_ir() produces {"kind":"exchange"} and Zeeman.to_ir() produces
{"kind":"zeeman","B":[0.0,0.0,0.001]}. Lowering inserts these fragments into
ProblemIR.energy_terms and preserves requested values before planner resolution.

(foundation-energy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves selected term kinds and authored parameters. Resolved execution
records realization, solver, device, and precision. Validation errors reject malformed
parameters and incompatible combinations. Unsupported combinations fail closed and are not
silently dropped from the energy sum.

(foundation-energy-discrete-realization)=
## Discrete realization

| Lane | Energy and field realization | Status |
|---|---|---|
| FDM CPU | cell-based term evaluation and reductions | partial; term evidence applies |
| FDM GPU | device term kernels and reductions | partial; device evidence applies |
| FEM CPU | mesh-weighted weak/discrete terms | partial; quadrature applies |
| FEM GPU | device FEM term kernels and reductions | partial; compiled code is not parity proof |

(foundation-energy-implementation-mapping)=
## Implementation mapping

energy.py owns typed terms and to_ir serialization. _build_problem assembles enabled
objects, and ProblemIR owns the typed energy_terms field. Native backends own term evaluation.

(foundation-energy-validation)=
## Validation

The source map checks all listed Python and Rust symbols. The example is parsed by the
public-example guard. Energy-derivative and cross-backend parity evidence remains
interaction-specific.

(foundation-energy-limitations)=
## Limitations

This page deliberately does not duplicate authoritative interaction formulas or claim every
term kind is executable on every lane.

(foundation-energy-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, 1963.
   [WorldCat record](https://search.worldcat.org/title/536451).
2. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* 92, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(foundation-energy-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| exchange authoring | packages/fullmag-py/src/fullmag/model/energy.py | class Exchange | serializes exchange term | all authoring lanes | source-backed |
| demag authoring | packages/fullmag-py/src/fullmag/model/energy.py | class Demag | validates realization choices | planner-gated | source-backed |
| Zeeman authoring | packages/fullmag-py/src/fullmag/model/energy.py | class Zeeman | serializes external field | planner-gated | source-backed |
| uniaxial authoring | packages/fullmag-py/src/fullmag/model/energy.py | class UniaxialAnisotropy | serializes coefficients | planner-gated | source-backed |
| cubic authoring | packages/fullmag-py/src/fullmag/model/energy.py | class CubicAnisotropy | serializes coefficients | planner-gated | source-backed |
| interfacial DMI authoring | packages/fullmag-py/src/fullmag/model/energy.py | class InterfacialDMI | serializes D and normal | planner-gated | source-backed |
| bulk DMI authoring | packages/fullmag-py/src/fullmag/model/energy.py | class BulkDMI | serializes D | planner-gated | source-backed |
| term assembly | packages/fullmag-py/src/fullmag/world.py | _build_problem | assembles enabled terms | all lanes | source-backed |
| canonical term container | crates/fullmag-ir/src/lib.rs | ProblemIR | stores energy_terms | all lanes | source-backed |
