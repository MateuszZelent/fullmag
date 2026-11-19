---
title: Initial Magnetization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Initial magnetization

(public-docs-python-api-magnets-and-textures-initial-magnetization)=
(python-api-magnets-and-textures-initial-magnetization-problem-statement)=
## Problem statement

Initializers are explicit object-level values and are lowered without assuming a particular mesh.

This page covers the Python authoring contract: construction validates initial magnetization directions, PRNG seeds, or sampled field arrays and provenance metadata in Python, while `to_ir()` emits the canonical `ProblemIR` initializer record before mesh mapping.

(python-api-magnets-and-textures-initial-magnetization-governing-equations)=
## Governing equations

Continuum micromagnetics specifies an initial condition $\mathbf{m}(\mathbf{x}, t=0) = \mathbf{m}_0(\mathbf{x})$ obeying the unit-norm constraint $\lVert\mathbf{m}_0(\mathbf{x})\rVert_2 = 1$ at active magnetic cells or nodes prior to LLG integration or energy minimization. Continuum initial-value semantics and high-level texture helpers are documented in {doc}`../../physics/foundations/llg-equation`, {doc}`uniform-texture`, and {doc}`preset-textures`.

(python-api-magnets-and-textures-initial-magnetization-symbols-and-si-units)=
## Symbols and SI units

Reduced magnetization components (`UniformMagnetization.value`, `SampledMagnetization.values`), random `seed` integers, and external file provenance fields (`source_path`, `source_format`, `dataset`, `sample_index`) are dimensionless ($1$).

(python-api-magnets-and-textures-initial-magnetization-assumptions-and-validity)=
## Assumptions and validity

`UniformMagnetization.value` requires a finite non-zero three-vector, `RandomMagnetization.seed` requires an integer seed, and `SampledMagnetization.values` requires typed vector entries compatible with normalization. Zero vectors or malformed sampled shapes fail closed during construction or discretization.

(python-api-magnets-and-textures-initial-magnetization-python-api)=
## Python API

### Constructor or function

`fm.init.UniformMagnetization`, `fm.init.RandomMagnetization`, `fm.init.SampledMagnetization`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `UniformMagnetization.value` | `Sequence[float]` | `required` | $1$ | finite three-vector | uniform direction/value | FEM/FDM CPU/GPU: IR; resolver-specific | `value` |
| `RandomMagnetization.seed` | `int` | `required` | $1$ | integer | reproducible random seed | FEM/FDM CPU/GPU: IR; resolver-specific | `seed` |
| `SampledMagnetization.values` | `Sequence[Sequence[float]]` | `required` | $1$ | typed sampled vectors | sampled initial field | FEM/FDM CPU/GPU: IR; resolver-specific | `values` |
| `SampledMagnetization.source_path/source_format/dataset/sample_index` | `optional` | `None` | $1$ | typed when supplied | sample provenance and selection | FEM/FDM CPU/GPU: IR; resolver-specific | `source metadata` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.init.UniformMagnetization((0.0, 0.0, 1.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, assign initial magnetization via `body.m = ...` using `fm.texture.*` helpers or these `fm.init.*` value classes.

(python-api-magnets-and-textures-initial-magnetization-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "uniform", "value": [...]}`, `{"kind": "random", "seed": ...}`, or `{"kind": "sampled", "values": ...}` with optional sample provenance metadata.

(python-api-magnets-and-textures-initial-magnetization-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves uniform vectors, random seeds, sampled arrays, and source provenance in `ProblemIR` independently of `resolved execution`. `Validation errors` reject zero-norm or malformed sequences, while `unsupported combinations` (such as mismatched sampled DOF counts at load time) fail closed during discretization.

(python-api-magnets-and-textures-initial-magnetization-discrete-realization)=
## Discrete realization

The Python contract supplies mesh-independent initializer data and provenance in `ProblemIR` only; evaluating random cell/nodal spin vectors or loading sampled fields onto active FEM nodes or FDM cells is handled by the solver backends.

(python-api-magnets-and-textures-initial-magnetization-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/init/magnetization.py` (`class UniformMagnetization`, `class RandomMagnetization`, and `class SampledMagnetization`). Constructor parameters, validation branches, and `to_ir()` keys come directly from that module.

(python-api-magnets-and-textures-initial-magnetization-validation)=
## Validation

Focused repository unit tests covering initializer IR serialization and sampled provenance include `test_random_initializer_serializes_to_ir` and `test_sampled_initializer_preserves_provenance`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-magnets-and-textures-initial-magnetization-limitations)=
## Limitations and Control Room

- **Supported initial-magnetization editing in Control Room:** `Model Explorer -> Objects -> <object> -> Magnetization` renders `ObjectMagneticTexturePanel`, which authors object-level initial magnetization using the 16 `MAGNETIZATION_TEXTURE_PRESETS` and commits draft changes through `commitMagneticTextureApply`.
- **Python-only surfaces:** Analytical `SpatialParameterField` callbacks, custom spatial expressions, region-specific overrides not exposed in `ObjectMagneticTexturePanel`, and textures outside the supported preset family remain `Python-only`; see {doc}`/frontend/inspectors/objects-and-materials` and {doc}`/frontend/capability-register`.

```{image} /_static/images/ui/inspector-magnetic-texture.png
:alt: Semantic Inspector Magnetic Texture panel configuring initial magnetization presets on an object
:width: 92%
```

(python-api-magnets-and-textures-initial-magnetization-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *The European Physical Journal B* **92**(6), 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6) | [Open-access Springer PDF](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf).

(python-api-magnets-and-textures-initial-magnetization-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/init/magnetization.py` | `class UniformMagnetization` | public constructor and IR lowering |
