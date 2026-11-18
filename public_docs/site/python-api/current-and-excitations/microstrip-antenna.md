---
title: Microstrip Antenna
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Microstrip antenna

(public-docs-python-api-current-and-excitations-microstrip-antenna)=
(python-api-current-and-excitations-microstrip-antenna-problem-statement)=
## Problem statement

The antenna object is an explicit authoring description; electromagnetic realization is a later resolver step.

Construction validates typed geometry parameters in Python; calling `to_ir()` lowers the object into its canonical `ProblemIR` record for study capture and field-basis generation.

(python-api-current-and-excitations-microstrip-antenna-governing-equations)=
## Governing equations

`MicrostripAntenna` specifies a rectangular microstrip conductor of trace width $w$, thickness $t$, and preview length $L$ positioned at height $h$ (`height_above_magnet`) above the magnetic film. Driven by an RF current source, the trace produces a spatially varying induction field $\mathbf{B}(\mathbf{x}, t)$ ($\mathbf{H} = \mathbf{B}/\mu_0$) governed by quasi-static Biot–Savart / magnetostatic induction as documented in {doc}`../../physics/interactions/oersted-field/index` and {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-microstrip-antenna-symbols-and-si-units)=
## Symbols and SI units

Conductor width, thickness, standoff (`height_above_magnet`), preview length, and center coordinates (`center_x`, `center_y`) use SI metres ($\mathrm{m}$); `current_distribution` is a dimensionless selector ($1$). Downstream solved fields produce $\mathbf{B}$ in tesla ($\mathrm{T}$) or $\mathbf{H}$ in $\mathrm{A\,m^{-1}}$.

(python-api-current-and-excitations-microstrip-antenna-assumptions-and-validity)=
## Assumptions and validity

Trace `width`, `thickness`, and `preview_length` must be finite and strictly positive; `height_above_magnet` must be finite and non-negative; and center coordinates must be finite. Unsupported distribution selectors fail closed at construction or lowering rather than being silently converted.

(python-api-current-and-excitations-microstrip-antenna-python-api)=
## Python API

### Constructor or function

`fm.MicrostripAntenna(width, thickness, height_above_magnet, preview_length, center_x=0.0, center_y=0.0, current_distribution="uniform")`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `width` | `float` | `required` | $\mathrm{m}$ | positive | signal width | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `width` |
| `thickness` | `float` | `required` | $\mathrm{m}$ | positive | conductor thickness | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `thickness` |
| `height_above_magnet` | `float` | `required` | $\mathrm{m}$ | non-negative | height over magnet | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `height_above_magnet` |
| `preview_length` | `float` | `required` | $\mathrm{m}$ | positive | preview length | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `preview_length` |
| `center_x/center_y` | `float` | `0.0` | $\mathrm{m}$ | finite | in-plane position | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `center` |
| `current_distribution` | `str` | `uniform` | $1$ | only uniform currently accepted | current distribution | FEM/FDM CPU/GPU: IR; resolver-specific | `current_distribution` |

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
value = fm.MicrostripAntenna(width=2.0e-6, thickness=1.0e-7, height_above_magnet=1.0e-7, preview_length=20.0e-6)
canonical_ir = value.to_ir()
```

In a complete simulation script, attach the antenna object through the study antenna/excitation registration API or Control Room antenna inspector.

(python-api-current-and-excitations-microstrip-antenna-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "microstrip"` and fields `"width"`, `"thickness"`, `"height_above_magnet"`, `"preview_length"`, `"center_x"`, `"center_y"`, and `"current_distribution"`. The IR records requested intent independently of backend field-basis resolution.

(python-api-current-and-excitations-microstrip-antenna-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields, non-finite values, non-positive geometric lengths, and unsupported distribution values, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-microstrip-antenna-discrete-realization)=
## Discrete realization

The Python contract supplies geometric parameters and canonical `ProblemIR` only; discrete field-basis computation and solver execution are owned by the FEM/FDM backend lanes and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-microstrip-antenna-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/antenna.py` (`class MicrostripAntenna`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that class.

(python-api-current-and-excitations-microstrip-antenna-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_flat_antenna_object_prescribed_zeeman_mask_round_trip` and `test_flat_antenna_object_exports_scene_document_object`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-microstrip-antenna-limitations)=
## Limitations and Control Room

Microstrip trace geometry, current distribution presets, port excitations, pre-solved basis overlays, and driven RF waveforms are authored in Control Room via `AntennaObjectPanel` and the `antenna/*` inspector sub-panels (`AntennaGeometryPanel`, `AntennaConductorAuthoring`, `AntennaPortComposer`, `AntennaFieldSolveAuthoring`, `AntennaFieldBasisPreview`). Specialized analytical distributions or backend-specific solver flags not exposed by those panels stay `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Microstrip trace parameters, ports, & drive waveforms | `Model Explorer -> Physics Objects -> <antenna>` (`AntennaObjectPanel`, `AntennaConductorAuthoring`, `AntennaPortComposer`) | `partial` | `runAuthoringMutationWithHistory` (`scene_revision` checked) and 3D field-basis inspection |
| Parameters without a named UI field | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-antenna-rf-and-waveforms.png
:alt: Antenna Inspector showing microstrip/inductive antenna parameters, ports, and RF waveform settings
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-microstrip-antenna-scientific-bibliography)=
## Scientific bibliography

- D. M. Pozar, *Microwave Engineering*, 4th ed., John Wiley & Sons (2011), ISBN 978-0-470-63155-3.
- J. D. Jackson, *Classical Electrodynamics*, 3rd ed., John Wiley & Sons (1999).

(python-api-current-and-excitations-microstrip-antenna-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class MicrostripAntenna` | public constructor and IR lowering |
