---
title: Initial Magnetization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-initial-magnetization)=
# Initial Magnetization

(python-api-magnets-and-textures-initial-magnetization-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Initial magnetization sets the starting magnetic state on a body.

(python-api-magnets-and-textures-initial-magnetization-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; the initial state is an initial condition.

(python-api-magnets-and-textures-initial-magnetization-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
The value is a dimensionless reduced magnetization vector.

(python-api-magnets-and-textures-initial-magnetization-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The vector must be finite length-3; an explicit seed is required for random initialization.

(python-api-magnets-and-textures-initial-magnetization-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `UniformMagnetization.value` | `tuple[float,float,float]` | `required` | Finite length-3 | Uniform direction | `kind="uniform"` |
| `RandomMagnetization.seed` | `int` | `required` | Positive integer | Random seed | `kind="random"` |
| `SampledMagnetization.values` | `list[tuple]` | `required` | Vector samples | Sampled state | sampled state |

### Complete stage-first example

```python
# %% Uniform initial state
import fullmag as fm

nm = 1.0e-9

study = fm.study("initial_magnetization_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-magnets-and-textures-initial-magnetization-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Initial magnetization lowers to the magnet's initial-condition record; preset textures materialize
into sampled states at lowering.

(python-api-magnets-and-textures-initial-magnetization-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Malformed vectors and non-positive seeds fail immediately.

(python-api-magnets-and-textures-initial-magnetization-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Sampled values are mapped to FDM cells or FEM nodes during materialization.

(python-api-magnets-and-textures-initial-magnetization-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/init/magnetization.py`
(`UniformMagnetization`, `RandomMagnetization`, `SampledMagnetization`).

(python-api-magnets-and-textures-initial-magnetization-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-magnets-and-textures-initial-magnetization-limitations)=
<!-- (limitations)= -->
## Limitations
Initial state is not normalized by this surface; dynamics constraints handle $|\mathbf m|=1$.

(python-api-magnets-and-textures-initial-magnetization-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-magnets-and-textures-initial-magnetization-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: The exposed texture families are partial; unlisted presets remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Magnetization` | `partial` | Apply magnetization draft; authored object state is revised |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Magnetization` | `TODO` | Python-only until implemented |

TODO: frontend support for texture presets and arguments not exposed by ObjectMagneticTexturePanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx (ObjectMagneticTexturePanel)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Initial states | `packages/fullmag-py/src/fullmag/init/magnetization.py` | `UniformMagnetization`, `RandomMagnetization`, `SampledMagnetization` | Initial condition lowering | Ownership test |
