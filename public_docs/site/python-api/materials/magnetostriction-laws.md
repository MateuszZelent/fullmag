---
title: Magnetostriction Laws
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-materials-magnetostriction-laws)=
# Magnetostriction Laws

(python-api-materials-magnetostriction-laws-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Magnetostriction laws define the coupling between magnetization and mechanical strain.

(python-api-materials-magnetostriction-laws-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Coupling mathematics belongs to {doc}`../../physics/interactions/magnetoelastic/index`.

(python-api-materials-magnetostriction-laws-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Cubic coupling constants $B_1$, $B_2$ are in pascals; isotropic
$\lambda_s$ is dimensionless saturation magnetostriction.

(python-api-materials-magnetostriction-laws-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The law kind selects the required constants; missing required constants fail immediately.

(python-api-materials-magnetostriction-laws-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `MagnetostrictionLaw.name` | `str` | `required` | $1$ | Non-empty | Law name | `name` |
| `MagnetostrictionLaw.kind` | `str` | `"cubic"` | $1$ | `cubic` or `isotropic` | Law family | `kind` |
| `MagnetostrictionLaw.B1` / `B2` | `float \| None` | `None` | $\mathrm{Pa}$ | Required for cubic | Cubic constants | `b1`, `b2` |
| `MagnetostrictionLaw.lambda_s` | `float \| None` | `None` | $1$ | Required for isotropic | Saturation magnetostriction | `lambda_s` |

### Stage-first boundary and object-level lowering

The fluent `study` builder does not currently expose a magnetostriction-law attachment method. The
stage-first study below establishes the surrounding magnetic authoring context and inspects the
standalone law IR fragment; it does **not** activate magnetoelastic coupling.

```python
# %% Cubic magnetostriction law
import fullmag as fm

nm = 1.0e-9

study = fm.study("magnetostriction_laws_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

nm = 1.0e-9

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

law = fm.MagnetostrictionLaw(name="py_ms", kind="cubic", B1=3.0e6, B2=3.0e6)
law_ir = law.to_ir()
assert law_ir["kind"] == "cubic"
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-materials-magnetostriction-laws-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`MagnetostrictionLaw.to_ir()` emits `kind`, `name`, and either `b1`/`b2` or `lambda_s`.

(python-api-materials-magnetostriction-laws-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Unknown kinds and missing required constants fail immediately.

(python-api-materials-magnetostriction-laws-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Coupling is consumed by the magnetoelastic operator realization.

(python-api-materials-magnetostriction-laws-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/mechanics.py` (`class MagnetostrictionLaw`).

(python-api-materials-magnetostriction-laws-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-materials-magnetostriction-laws-limitations)=
<!-- (limitations)= -->
## Limitations
A law alone does not create a coupled problem. `Problem` can carry magnetostriction laws, but the
current fluent stage-first builder has no public attachment hook; this page does not imply that the
example executes magnetoelastic coupling.

(python-api-materials-magnetostriction-laws-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Constitutive references belong to the magnetoelastic page.

(python-api-materials-magnetostriction-laws-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Magnetostriction law | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MagnetostrictionLaw` | Coupling lowering | Ownership test |
