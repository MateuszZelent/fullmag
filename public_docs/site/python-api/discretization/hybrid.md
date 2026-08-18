---
title: Hybrid
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-hybrid)=
# Hybrid

(python-api-discretization-hybrid-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Hybrid discretization pairs FDM and FEM domains in one problem via `DiscretizationHints`.

(python-api-discretization-hybrid-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; hybrid is a discretization-selection policy.

(python-api-discretization-hybrid-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All fields are policy identifiers.

(python-api-discretization-hybrid-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The hybrid demag selector must be non-empty; hybrid backend and mode must be selected together.

(python-api-discretization-hybrid-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `Hybrid.demag` | `str` | `required` | Non-empty | Hybrid demag strategy | `demag` |
| `DiscretizationHints.fdm` / `fem` / `hybrid` | `FDM \| FEM \| Hybrid \| None` | `None` | Valid per-lane objects | Composite hints | `discretization_hints` |

### Complete stage-first context

Hybrid problems select both backend families; the planner enforces the hybrid mode coupling.

```python
# %% Hybrid discretization hints
import fullmag as fm

study = fm.study("hybrid_discretization_api_example")
study.engine("hybrid")
study.device("auto", precision="double")
study.mode("hybrid")

nm = 1.0e-9
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

hints = fm.DiscretizationHints(hybrid=fm.Hybrid(demag="open"))
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-discretization-hybrid-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`DiscretizationHints.to_ir()` emits `fdm`, `fem`, and `hybrid` blocks; only the selected lanes are
non-null.

(python-api-discretization-hybrid-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Empty hybrid demag and hybrid/non-hybrid mismatch fail immediately.

(python-api-discretization-hybrid-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The planner resolves the FDM/FEM boundary and reports the derived discretization provenance.

(python-api-discretization-hybrid-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/discretization.py` (`Hybrid`,
`DiscretizationHints`).

(python-api-discretization-hybrid-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-discretization-hybrid-limitations)=
<!-- (limitations)= -->
## Limitations
Hybrid execution support is planner-resolved; the policy does not by itself prove executability.

(python-api-discretization-hybrid-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-discretization-hybrid-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Hybrid hints | `packages/fullmag-py/src/fullmag/model/discretization.py` | `Hybrid`, `DiscretizationHints` | Hybrid lowering | Ownership test |
