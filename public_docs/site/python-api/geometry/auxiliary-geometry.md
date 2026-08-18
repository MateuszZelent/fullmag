---
title: Auxiliary Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-geometry-auxiliary-geometry)=
# Auxiliary Geometry

(python-api-geometry-auxiliary-geometry-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Auxiliary geometry registers non-magnetic domain objects such as conductors, electrodes, or
antenna masks with an explicit physical role.

(python-api-geometry-auxiliary-geometry-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; auxiliary geometry carries the domain objects other field
sources operate on.

(python-api-geometry-auxiliary-geometry-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Physical units belong to the consuming field sources.

(python-api-geometry-auxiliary-geometry-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The object type must be one of the supported roles and geometry names must be unique.

(python-api-geometry-auxiliary-geometry-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `study.geometry_object(shape, name, type=...)` | method | `type="geometry"` | `geometry`, `conductor`, `electrode`, or `antenna` | Non-magnetic object role | `geometry.entries` |
| `study.conductor(shape, name)` | method | conductor role | Conductor geometry | Solved-current domain | `geometry.entries` |
| `study.antenna_object(shape, name)` | method | antenna role | Antenna mask | Antenna field source | `geometry.entries` |

### Complete stage-first context

A conductor object is a separate domain role, not a hidden parameter of an interaction.

```python
# %% Register a heavy-metal conductor domain
import fullmag as fm

nm = 1.0e-9

study = fm.study("auxiliary_geometry_api_example")
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

study.geometry_object(fm.Box(100 * nm, 20 * nm, 3 * nm), name="hm", type="conductor")
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-geometry-auxiliary-geometry-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Auxiliary objects lower into `geometry.entries` with their role recorded, keeping conductor and
antenna domains distinct from magnetic objects.

(python-api-geometry-auxiliary-geometry-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Duplicate names and unknown role types fail immediately.

(python-api-geometry-auxiliary-geometry-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Auxiliary domains are meshed alongside magnetic objects with role-specific ownership.

(python-api-geometry-auxiliary-geometry-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/world.py` (`geometry_object`).

(python-api-geometry-auxiliary-geometry-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-geometry-auxiliary-geometry-limitations)=
<!-- (limitations)= -->
## Limitations
Role support depends on the consuming interaction (transport, Oersted, antenna).

(python-api-geometry-auxiliary-geometry-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-geometry-auxiliary-geometry-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Auxiliary roles | `packages/fullmag-py/src/fullmag/world.py` | `geometry_object` | Role registration | Ownership test |
