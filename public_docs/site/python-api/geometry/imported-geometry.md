---
title: Imported Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-imported-geometry)=
# Imported Geometry

(python-api-geometry-imported-geometry-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Imported geometry loads an external CAD/mesh source into the public geometry model.

(python-api-geometry-imported-geometry-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced.

(python-api-geometry-imported-geometry-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Unit conversion is explicit: `units` selects the source length unit and `scale` applies an
additional dimensionless (or per-axis) factor.

(python-api-geometry-imported-geometry-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The source must be non-empty; scale factors must be positive.

(python-api-geometry-imported-geometry-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `ImportedGeometry.source` | `str` | `required` | Non-empty path | Source file | `source` |
| `ImportedGeometry.scale` | `float \| tuple` | `1.0` | Positive scalar or per-axis | Scale factor | `scale` |
| `ImportedGeometry.units` | `ImportedGeometryUnits \| None` | `None` | Supported unit | Source length unit | normalized scale |
| `ImportedGeometry.name` | `str \| None` | derived | Non-empty when set | Geometry name | `name` |
| `ImportedGeometry.volume` | `str` | `"full"` | Supported volume mode | Volume selection | `volume` |

### Complete stage-first context

Imported geometry is supplied to the same `study.geometry(...)` entrypoint as primitives.

```python
# %% Import a mesh/CAD source
import fullmag as fm

study = fm.study("imported_geometry_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

film = study.geometry(fm.ImportedGeometry("film.stl", units="nm"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-geometry-imported-geometry-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`ImportedGeometry.to_ir()` emits `kind="imported_geometry"`, `source`, inferred `format`,
resolved `scale`, and optional `volume`.

(python-api-geometry-imported-geometry-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Invalid scale and unknown units fail immediately; later mesh build reports the realized mesh.

(python-api-geometry-imported-geometry-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The descriptor is backend-neutral. Realization depends on the inferred format and selected mesh
workflow: an FDM path may voxelize a supported volume, while FEM may consume or remesh supported
geometry/mesh assets.

(python-api-geometry-imported-geometry-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/geometry.py` (`class ImportedGeometry`).

(python-api-geometry-imported-geometry-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-geometry-imported-geometry-limitations)=
<!-- (limitations)= -->
## Limitations
Serialization records unknown suffixes as `format="unknown"`; support is decided later by asset
preparation and mesh building. Successful construction is therefore not proof that either backend
can realize the source.

(python-api-geometry-imported-geometry-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-geometry-imported-geometry-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Import lowering | `packages/fullmag-py/src/fullmag/model/geometry.py` | `class ImportedGeometry` | Source/scale/unit lowering | Ownership test |
