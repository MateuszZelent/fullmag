---
title: Initial Magnetization
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Initial magnetization

(public-docs-python-api-magnets-and-textures-initial-magnetization)=
(python-api-magnets-and-textures-initial-magnetization-problem-statement)=
## Problem statement

Initializers are explicit object-level values and are lowered without assuming a particular mesh.

This page covers the Python authoring contract: construction validates initial magnetization directions, non-negative PRNG seeds, or sampled field arrays and file-provenance metadata in Python, while `to_ir()` emits the canonical `ProblemIR` initializer record before mesh mapping. It also documents the magnetization and vector-field state I/O helpers (`fm.load_magnetization`, `fm.save_magnetization`, `fm.FieldState`, `fm.load_field_state`, `fm.save_field_state`) that bridge external state files (`json`, `zarr`, `h5`, `ovf`, `npz`, `npy`) with `SampledMagnetization`.

(python-api-magnets-and-textures-initial-magnetization-governing-equations)=
## Governing equations

Continuum micromagnetics specifies an initial condition $\mathbf{m}(\mathbf{x}, t=0) = \mathbf{m}_0(\mathbf{x})$ obeying the unit-norm constraint $\lVert\mathbf{m}_0(\mathbf{x})\rVert_2 = 1$ at active magnetic cells or nodes prior to LLG integration or energy minimization. Continuum initial-value semantics and high-level analytic texture helpers are documented in {doc}`../../physics/foundations/llg-equation`, {doc}`uniform-texture`, and {doc}`preset-textures`.

(python-api-magnets-and-textures-initial-magnetization-symbols-and-si-units)=
## Symbols and SI units

Reduced magnetization components (`UniformMagnetization.value`, `SampledMagnetization.values`), random `seed` integers, and external file provenance fields (`source_path`, `source_format`, `dataset`, `sample_index`) are dimensionless ($1$).

(python-api-magnets-and-textures-initial-magnetization-assumptions-and-validity)=
## Assumptions and validity

`UniformMagnetization.value` requires a finite three-component vector (`as_vector3`), `RandomMagnetization.seed` requires a non-negative integer (`bool` rejected), and `SampledMagnetization.values` requires a non-empty sequence of finite three-component vectors compatible with normalization at discretization/execution time. Zero vectors, negative/boolean seeds, or malformed sampled shapes fail closed during construction or discretization.

Convenience factories `fm.init.uniform(...)` and `fm.init.random(seed)` construct `UniformMagnetization` and `RandomMagnetization`, respectively. `fm.init.from_function(...)` currently raises `NotImplementedError` because analytic spatial callbacks are authored through `fm.fields.function(...)` for material parameters or sampled explicitly onto target coordinates.

(python-api-magnets-and-textures-initial-magnetization-python-api)=
## Python API

### Constructor or function

- Initializer classes and helpers: `fm.init.UniformMagnetization`, `fm.init.RandomMagnetization`, `fm.init.SampledMagnetization`, `fm.init.uniform`, `fm.init.random`
- State file I/O helpers (re-exported at top level `fm.*`): `fm.load_magnetization`, `fm.save_magnetization`, `fm.FieldState`, `fm.load_field_state`, `fm.save_field_state`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `init.UniformMagnetization.value` | `Sequence[float]` | `required` | $1$ | finite three-vector | uniform direction/value | FEM/FDM CPU/GPU: IR; planner materializes | `value` |
| `init.RandomMagnetization.seed` | `int` | `required` | $1$ | non-negative integer; `bool` rejected | reproducible random seed | FEM/FDM CPU/GPU: IR; planner materializes | `seed` |
| `init.SampledMagnetization.values` | `Sequence[Sequence[float]]` | `required` | $1$ | non-empty sequence of finite three-vectors | sampled initial field | FEM/FDM CPU/GPU: IR; planner validates DOF count | `values` |
| `init.SampledMagnetization.source_path` | `str \| None` | `None` | $1$ | optional string provenance | origin path of loaded state artifact | Python provenance metadata (not emitted by `to_ir()`) | Python provenance only |
| `init.SampledMagnetization.source_format` | `str \| None` | `None` | $1$ | optional format tag (`json`, `zarr`, `h5`, `ovf`, `npz`, `npy`) | source serialization format | Python provenance metadata (not emitted by `to_ir()`) | Python provenance only |
| `init.SampledMagnetization.dataset` | `str \| None` | `None` | $1$ | optional dataset key | dataset name selected from container file | Python provenance metadata (not emitted by `to_ir()`) | Python provenance only |
| `init.SampledMagnetization.sample_index` | `int \| None` | `None` | $1$ | optional integer sample index | frame index selected from multi-sample archive | Python provenance metadata (not emitted by `to_ir()`) | Python provenance only |

### State file I/O formats

`packages/fullmag-py/src/fullmag/init/state_io.py` supports reading and writing sampled magnetization states and general vector-field states across six interchange formats:

- `MAGNETIZATION_STATE_FORMATS = ("json", "zarr", "h5", "ovf", "npz", "npy")` via `fm.load_magnetization(path, *, format="auto", dataset=None, sample=-1)` (returning `SampledMagnetization`) and `fm.save_magnetization(path, magnetization, *, format="auto", dataset="m", grid_shape=None, cell_size=None, metadata=None)`.
- `FIELD_STATE_FORMATS = ("zarr", "h5", "ovf", "npz", "npy", "json")` via `fm.load_field_state(...)` and `fm.save_field_state(...)` using `fm.FieldState(values, field_name=..., grid_shape=..., cell_size=..., units=..., metadata=..., source_path=..., source_format=..., dataset=..., sample_index=...)`.

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

# Construct and lower low-level fm.init value objects.
uniform_init = fm.init.UniformMagnetization((0.0, 0.0, 1.0))
random_init = fm.init.RandomMagnetization(seed=42)
sampled_init = fm.init.SampledMagnetization(
    [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)],
    source_path="checkpoint.ovf",
    source_format="ovf",
    dataset="m",
    sample_index=-1,
)
assert uniform_init.to_ir() == {"kind": "uniform", "value": [0.0, 0.0, 1.0]}
assert random_init.to_ir() == {"kind": "random", "seed": 42}
assert sampled_init.to_ir()["kind"] == "sampled_field"
```

In a complete simulation script, assign initial magnetization via `body.m = ...` using `fm.texture.*` helpers, these `fm.init.*` value classes, or `fm.load_magnetization(...)`.

(python-api-magnets-and-textures-initial-magnetization-problem-ir)=
## ProblemIR

`to_ir()` emits exact canonical records:

- `UniformMagnetization.to_ir()` -> `{"kind": "uniform", "value": [mx, my, mz]}`
- `RandomMagnetization.to_ir()` -> `{"kind": "random", "seed": seed}`
- `SampledMagnetization.to_ir()` -> `{"kind": "sampled_field", "values": [[mx, my, mz], ...]}`

Notice that `SampledMagnetization.to_ir()` emits `"kind": "sampled_field"` (not `"sampled"`), while `source_path`, `source_format`, `dataset`, and `sample_index` remain Python-level provenance attributes on `SampledMagnetization`.

(python-api-magnets-and-textures-initial-magnetization-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves uniform vectors, random seeds, and sampled vector arrays in `ProblemIR` independently of `resolved execution`. `Validation errors` reject malformed sequences, non-finite coordinates, empty `values`, or negative/boolean seeds, while `unsupported combinations` (such as mismatched sampled DOF counts against the resolved FEM mesh or FDM grid at load time) fail closed during discretization.

(python-api-magnets-and-textures-initial-magnetization-discrete-realization)=
## Discrete realization

| Solver | Device | Realization | Qualification status |
|---|---|---|---|
| FDM | CPU | planner materializes uniform, seeded random, or sampled vectors onto active cell centres | authoring and IR documented; runtime qualification separate |
| FDM | GPU | consumes the shared planner-materialized initial magnetization buffer | authoring and IR documented; GPU runtime qualification separate |
| FEM | CPU | planner materializes initial vectors onto magnetic mesh nodes (excluding air nodes) | authoring and IR documented; runtime qualification separate |
| FEM | GPU | consumes the shared planner-materialized initial magnetization buffer | authoring and IR documented; GPU runtime qualification separate |

The Python contract supplies mesh-independent initializer data in `ProblemIR`; evaluating random cell/nodal spin vectors or binding sampled fields onto active FEM nodes or FDM cells is performed by the planner and solver backends.

(python-api-magnets-and-textures-initial-magnetization-implementation-mapping)=
## Implementation mapping

The authoritative implementations are `packages/fullmag-py/src/fullmag/init/magnetization.py` (`class UniformMagnetization`, `class RandomMagnetization`, and `class SampledMagnetization`) and `packages/fullmag-py/src/fullmag/init/state_io.py` (`class FieldState`, `load_magnetization`, `save_magnetization`, `load_field_state`, `save_field_state`). Constructor parameters, validation branches, format registries, and `to_ir()` keys come directly from those modules.

(python-api-magnets-and-textures-initial-magnetization-validation)=
## Validation

Focused repository unit tests covering initializer IR serialization, sampled provenance, and multi-format state I/O include `test_random_initializer_serializes_to_ir`, `test_sampled_initializer_preserves_provenance`, and `state_io` round-trip tests across `json`, `zarr`, `h5`, `ovf`, `npz`, and `npy`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-magnets-and-textures-initial-magnetization-limitations)=
## Limitations and Control Room

- **Supported initial-magnetization editing in Control Room:** `Model Explorer -> Objects -> <object> -> Magnetization` renders `MagneticTextureInspectorPanel` (`apps/control-room/src/modules/inspector/panels/magnetic-texture/MagneticTextureInspectorPanel.tsx`), which authors object-level initial magnetization using the 20 built-in `MAGNETIZATION_TEXTURE_PRESETS` and commits draft changes through `commitMagneticTextureApply`.
- **Python-only surfaces:** `SampledMagnetization` file loading (`fm.load_magnetization`), `FieldState` I/O, analytical `SpatialParameterField` callbacks, custom spatial expressions, and raw `fm.init.*` low-level constructors remain `Python-only`; see {doc}`/frontend/inspectors/objects-and-materials` and {doc}`/frontend/capability-register`.

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
| [`packages/fullmag-py/src/fullmag/init/magnetization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/magnetization.py#L14) | [`class UniformMagnetization`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/magnetization.py#L14) | uniform initializer constructor and `to_ir()` lowering |
| [`packages/fullmag-py/src/fullmag/init/magnetization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/magnetization.py#L25) | [`class RandomMagnetization`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/magnetization.py#L25) | deterministic seeded random initializer and `to_ir()` lowering |
| [`packages/fullmag-py/src/fullmag/init/magnetization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/magnetization.py#L38) | [`class SampledMagnetization`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/magnetization.py#L38) | sampled magnetization container, provenance attributes, and `sampled_field` IR lowering |
| [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L22) | [`class FieldState`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L22) | general vector-field state payload with grid and provenance metadata |
| [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L55) | [`load_magnetization`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L55) | multi-format magnetization loader (`json`, `zarr`, `h5`, `ovf`, `npz`, `npy`) |
| [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L106) | [`save_magnetization`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L106) | multi-format magnetization writer |
| [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L141) | [`load_field_state`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L141) | multi-format general vector-field state loader |
| [`packages/fullmag-py/src/fullmag/init/state_io.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L228) | [`save_field_state`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/init/state_io.py#L228) | multi-format general vector-field state writer |
