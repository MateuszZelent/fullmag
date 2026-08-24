---
title: Universe and Domain
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-universe-and-domain)=
# Universe and Domain

(python-api-geometry-universe-and-domain-problem-statement)=
<!-- (problem-statement)= -->
## Contract
The universe defines the enclosing domain and airbox policy that contains the magnetic objects.

(python-api-geometry-universe-and-domain-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; universe config is meshing context.

(python-api-geometry-universe-and-domain-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Size, center, and padding are in metres.

(python-api-geometry-universe-and-domain-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Manual universe mode requires an explicit size. `size`, `center`, and `padding` must be length-3
sequences convertible to `float`; the shared `as_vector3` helper does not currently reject
`NaN` or infinity in `center`.

(python-api-geometry-universe-and-domain-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `study.universe(mode, size, center, padding)` | `StudyUniverseConfig` | auto | Explicit size in manual mode | Universe policy | `runtime_metadata.study_universe` / `domain_frame` |
| `study.universe.mesh(...)` | method | per backend | FEM element controls or FDM cell size | Universe meshing | mesh workflow |

### Complete stage-first example

```python
# %% Manual universe with FEM-style airbox
import fullmag as fm

nm = 1.0e-9

study = fm.study("universe_domain_api_example")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(1200 * nm, 600 * nm, 550 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10 * nm,
    maximum_element_size=110 * nm,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(minimum_element_size=3 * nm, maximum_element_size=3 * nm, layers=1, topology="prismatic")
study.demag(realization="poisson_robin")
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
```

(python-api-geometry-universe-and-domain-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Universe config surfaces as `runtime_metadata.study_universe` and the derived `domain_frame`;
mesh workflow metadata is recorded separately.

(python-api-geometry-universe-and-domain-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Missing size in manual mode and vectors with the wrong length or non-convertible components fail
immediately. Non-finite `center` components are not rejected by the Python constructor; later
asset/planner behavior must not be presented as constructor validation. FDM/FEM restrictions are
reported by the planner.

(python-api-geometry-universe-and-domain-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
FDM and FEM realize the universe with distinct meshing paths while consuming one config.

(python-api-geometry-universe-and-domain-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/world.py` (`_configure_study_universe`).

(python-api-geometry-universe-and-domain-validation)=
<!-- (validation)= -->
## Validation
Ownership and universe-validation tests cover the config surface.

(python-api-geometry-universe-and-domain-limitations)=
<!-- (limitations)= -->
## Limitations
Universe config is backend-aware; not every FDM cell policy and FEM element policy is
interchangeable.

(python-api-geometry-universe-and-domain-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-geometry-universe-and-domain-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Universe config | `packages/fullmag-py/src/fullmag/world.py` | `_configure_study_universe` | Universe lowering | Universe-validation tests |
