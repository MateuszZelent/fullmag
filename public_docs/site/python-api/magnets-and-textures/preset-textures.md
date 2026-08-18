---
title: Preset Textures
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-preset-textures)=
# Preset Textures

(python-api-magnets-and-textures-preset-textures-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Preset textures are analytic magnetic texture factories (vortex, skyrmion, domain walls, and
related profiles) with object/world mapping and rigid transforms.

(python-api-magnets-and-textures-preset-textures-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Texture mathematics belongs to the preset evaluator; this page records the public authoring
surface.

(python-api-magnets-and-textures-preset-textures-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Texture parameters follow each preset; mapping pivots/scales are in metres or dimensionless.

(python-api-magnets-and-textures-preset-textures-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Preset kinds and mapping modes are validated; transforms are composed in author order.

(python-api-magnets-and-textures-preset-textures-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `PresetTexture.preset_kind` | `str` | `required` | Supported preset | Texture family | `preset_kind` |
| `PresetTexture.params` | `Mapping` | `{}` | Parameter domain | Profile parameters | `preset_params` |
| `PresetTexture.mapping` | `TextureMapping` | default | Valid space/projection/clamp | Coordinate mapping | `mapping` |
| `PresetTexture.transform` | `TextureTransform3D` | identity | Composable | Rigid transform | `texture_transform` |
| `.translate/.rotate_*/_deg/.scale/.with_pivot` | methods | — | Finite args | Transform chain | `texture_transform` |

### Complete stage-first context

Textures are created through the `fm.texture.*` factory and assigned to a magnet.

```python
# %% Uniform state (see presets for vortex/skyrmion factories)
import fullmag as fm

nm = 1.0e-9

study = fm.study("preset_textures_api_example")
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

(python-api-magnets-and-textures-preset-textures-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`PresetTexture.to_ir()` emits `kind="preset_texture"`, `preset_kind`, `preset_params`, `mapping`,
`texture_transform`, `ui_label`, and `preview_proxy`.

(python-api-magnets-and-textures-preset-textures-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Unknown preset kinds and invalid mapping modes fail immediately.

(python-api-magnets-and-textures-preset-textures-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Preset values are evaluated at FDM cells or FEM nodes during initial-state materialization.

(python-api-magnets-and-textures-preset-textures-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/init/textures.py` (`PresetTexture`,
`texture` factory, `TextureMapping`, `TextureTransform3D`).

(python-api-magnets-and-textures-preset-textures-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-magnets-and-textures-preset-textures-limitations)=
<!-- (limitations)= -->
## Limitations
A texture factory presence does not prove solver execution; materialization is the realization
gate.

(python-api-magnets-and-textures-preset-textures-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Profile definitions belong to the preset evaluator and texture tests.

(python-api-magnets-and-textures-preset-textures-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Preset textures | `packages/fullmag-py/src/fullmag/init/textures.py` | `PresetTexture`, `texture` | Texture lowering | Ownership test |
