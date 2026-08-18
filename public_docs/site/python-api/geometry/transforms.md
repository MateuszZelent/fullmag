---
title: Transforms
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-transforms)=
# Transforms

(python-api-geometry-transforms-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Transforms rewrite a geometry's spatial placement without changing its physical role. The public
transform below is translation.

(python-api-geometry-transforms-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; transforms are geometry semantics.

(python-api-geometry-transforms-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
The translation offset is in metres.

(python-api-geometry-transforms-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The offset must be a finite length-3 vector; the optional override name must be non-empty.

(python-api-geometry-transforms-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `Translate.geometry` | `Geometry` | `required` | Geometry object | Base geometry | `base` |
| `Translate.offset` | `tuple[float,float,float]` | `required` | Finite length-3 | Translation vector | `by` |
| `Translate.name` | `str \| None` | derived | Non-empty when set | Override name | `name` |

### Complete stage-first example

```python
# %% Off-center object via translation
import fullmag as fm

nm = 1.0e-9

study = fm.study("transforms_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(
    fm.Box(100 * nm, 20 * nm, 5 * nm).translate((50 * nm, 0.0, 0.0)),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-geometry-transforms-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Translate.to_ir()` emits `kind="translate"` with `base`, `by`, and the resolved `name`.

(python-api-geometry-transforms-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
A derived name embeds the requested offset; a malformed offset fails immediately.

(python-api-geometry-transforms-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Translation realizes identically for FDM and FEM meshing paths.

(python-api-geometry-transforms-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/geometry.py` (`class Translate`).

(python-api-geometry-transforms-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-geometry-transforms-limitations)=
<!-- (limitations)= -->
## Limitations
Rotation and scale are not part of this public transform; use full CAD import for arbitrary
orientations.

(python-api-geometry-transforms-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-geometry-transforms-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Translation | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class Translate` | Spatial transform lowering | Ownership test |
