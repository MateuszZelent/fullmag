---
title: Uniform Texture
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-uniform-texture)=
# Uniform Texture

(python-api-magnets-and-textures-uniform-texture-problem-statement)=
## Contract

`texture.uniform` creates a versioned analytic preset for constant reduced magnetization. Version
2 rejects a zero or non-finite direction; version 1 is retained only for compatibility.

(python-api-magnets-and-textures-uniform-texture-governing-equations)=
## Governing equations

The preset evaluates $\mathbf m(\mathbf x)=\mathbf m_0$ at every active sample point. The runtime
normalization policy belongs to the initial-state evaluator.

(python-api-magnets-and-textures-uniform-texture-symbols-and-si-units)=
## Symbols and SI units

All direction components and `preset_version` are dimensionless.

(python-api-magnets-and-textures-uniform-texture-assumptions-and-validity)=
## Assumptions and validity

Use either one three-component sequence or three scalar components. `preset_version` must be the
integer `1` or `2`; booleans and other values are rejected by `PresetTexture`.

(python-api-magnets-and-textures-uniform-texture-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `texture.uniform.direction_or_x` | `Sequence[float] \| float` | `(1,0,0)` | $1$ | sequence of three values or first scalar component | uniform direction input | all authoring lanes | preset params `direction` |
| `texture.uniform.y` | `float \| None` | `None` | $1$ | required with scalar `x,z` form | second component | all authoring lanes | preset params `direction` |
| `texture.uniform.z` | `float \| None` | `None` | $1$ | required with scalar `x,y` form | third component | all authoring lanes | preset params `direction` |
| `texture.uniform.preset_version` | `int` | `2` | $1$ | exactly `1` or `2`; not `bool` | serialized texture formula/version identity | all authoring lanes; evaluator supports declared versions | `initial_magnetization.preset_version` |

```python
# %% Uniform initial magnetization
import fullmag as fm

study = fm.study("uniform_texture_api_example")
study.engine("fdm")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
film = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
film.Ms = 8.0e5
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0, preset_version=2)
study.exchange()
study.stages.add_run(stage_id="run", until=1e-12)
```

(python-api-magnets-and-textures-uniform-texture-problem-ir)=
## ProblemIR

Version 2 lowers as a `preset_texture` with `preset_kind="uniform"`, explicit
`preset_version=2`, direction parameters, mapping, and texture transform.

(python-api-magnets-and-textures-uniform-texture-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Export preserves the authored preset version. It must not silently rewrite a compatibility-v1
texture as v2 or discard the version field.

(python-api-magnets-and-textures-uniform-texture-discrete-realization)=
## Discrete realization

The analytic preset is sampled at FDM cell centres or FEM nodes after final geometry/mesh ordering.

(python-api-magnets-and-textures-uniform-texture-implementation-mapping)=
## Implementation mapping

`packages/fullmag-py/src/fullmag/init/textures.py`, `texture.uniform` and `PresetTexture`, own
validation and serialization.

(python-api-magnets-and-textures-uniform-texture-validation)=
## Validation

Tests compare this inventory with the live function signature and verify v1/v2 evaluation and
round-trip behavior.

(python-api-magnets-and-textures-uniform-texture-limitations)=
## Limitations

A uniform preset is an initial condition, not a persistent magnetization constraint.

(python-api-magnets-and-textures-uniform-texture-scientific-bibliography)=
## Scientific bibliography

No independent interaction is introduced.

(python-api-magnets-and-textures-uniform-texture-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| factory and versioning | `packages/fullmag-py/src/fullmag/init/textures.py` | `texture.uniform`, `PresetTexture` | preset construction and IR | signature/evaluator tests |
