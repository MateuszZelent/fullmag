---
title: CPW Antenna
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# CPW antenna

(public-docs-python-api-current-and-excitations-cpw-antenna)=
(python-api-current-and-excitations-cpw-antenna-problem-statement)=
## Problem statement

The CPW dimensions are validated at authoring time and retained as explicit IR geometry inputs.

Construction validates typed geometry parameters in Python; calling `to_ir()` emits the canonical `ProblemIR` antenna record consumed by downstream field-basis generation and study capture.

(python-api-current-and-excitations-cpw-antenna-governing-equations)=
## Governing equations

`CPWAntenna` defines the coplanar waveguide (ground–gap–signal–gap–ground) conductor layout placed above the magnetic body at elevation $h$ (`height_above_magnet`). Combined with an RF current excitation, the conductor cross-section sources a spatially inhomogeneous Oersted/Zeeman induction field $\mathbf{B}(\mathbf{x}, t)$ ($\mathbf{H} = \mathbf{B}/\mu_0$) governed by quasi-static Biot–Savart / magnetostatic induction as documented in {doc}`../../physics/interactions/oersted-field/index` and {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-cpw-antenna-symbols-and-si-units)=
## Symbols and SI units

All conductor widths, gaps, conductor thickness, vertical standoff (`height_above_magnet`), preview length, and in-plane center offsets use SI metres ($\mathrm{m}$); `current_distribution` is a dimensionless selector ($1$). Downstream solved fields produce $\mathbf{B}$ in tesla ($\mathrm{T}$) or $\mathbf{H}$ in $\mathrm{A\,m^{-1}}$.

(python-api-current-and-excitations-cpw-antenna-assumptions-and-validity)=
## Assumptions and validity

Transverse dimensions, thickness, and preview length must be finite and strictly positive; `height_above_magnet` must be finite and non-negative; and center coordinates must be finite. Unsupported distribution modes fail closed at construction or lowering rather than being silently converted.

(python-api-current-and-excitations-cpw-antenna-python-api)=
## Python API

### Constructor or function

`fm.CPWAntenna(signal_width, gap, ground_width, thickness, height_above_magnet, preview_length, center_x=0.0, center_y=0.0, current_distribution="uniform")`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `signal_width/gap/ground_width` | `float` | `required` | $\mathrm{m}$ | positive | CPW transverse dimensions | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `dimensions` |
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
value = fm.CPWAntenna(signal_width=2.0e-6, gap=1.0e-6, ground_width=5.0e-6, thickness=1.0e-7, height_above_magnet=1.0e-7, preview_length=20.0e-6)
canonical_ir = value.to_ir()
```

In a complete simulation script, attach the antenna object through the study antenna/excitation registration API or Control Room antenna inspector.

(python-api-current-and-excitations-cpw-antenna-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "cpw"` and fields `"signal_width"`, `"gap"`, `"ground_width"`, `"thickness"`, `"height_above_magnet"`, `"preview_length"`, `"center_x"`, `"center_y"`, and `"current_distribution"`. The IR records requested intent independently of backend field-basis resolution.

(python-api-current-and-excitations-cpw-antenna-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields, non-finite values, non-positive geometric dimensions, and unsupported current distributions, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-cpw-antenna-discrete-realization)=
## Discrete realization

The Python contract supplies geometric parameters and canonical `ProblemIR` only; discrete basis-field evaluation, port discretization, and solver execution are owned by the FEM/FDM backend lanes and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-cpw-antenna-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/antenna.py` (`class CPWAntenna`). Constructor arguments, validation rules, defaults, and `to_ir()` keys come directly from that class.

(python-api-current-and-excitations-cpw-antenna-validation)=
## Validation

Focused repository unit tests covering authoring and IR round-tripping include `test_flat_antenna_object_prescribed_zeeman_mask_round_trip` and `test_flat_antenna_object_exports_scene_document_object`. Runtime execution, device performance, and browser rendering require separate qualification.

(python-api-current-and-excitations-cpw-antenna-limitations)=
## Limitations and Control Room

CPW geometry, signal/ground gap ratios, port modes, solved electromagnetic field bases, and temporal drives are exposed in Control Room through `AntennaObjectPanel` and its `antenna/*` sub-panels (`AntennaCompositionSummaryPanel`, `AntennaGeometryPanel`, `AntennaConductorAuthoring`, `AntennaPortComposer`, `AntennaFieldSolveAuthoring`, `AntennaExternalLeadInspectionPanel`, and `AntennaFieldBasisPreview`). Advanced Python-authored geometry expressions or solver policy overrides without named inspector fields remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| CPW conductor layout, port modes, solve stage, & RF waveforms | `Model Explorer -> Physics Objects -> <antenna>` (`AntennaObjectPanel`, `AntennaPortComposer`, `AntennaFieldSolveAuthoring`) | `partial` | `runAuthoringMutationWithHistory` (`scene_revision` checked) and 3D basis overlay preview |
| Unsupported low-level geometry expressions or backend solver hints | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-antenna-rf-and-waveforms.png
:alt: Antenna Inspector displaying CPW/RF waveform parameters, conductor placement, and port composition
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-cpw-antenna-scientific-bibliography)=
## Scientific bibliography

- C.-P. Wen, “Coplanar Waveguide: A Surface Strip Transmission Line Suitable for Nonreciprocal Gyromagnetic Device Applications,” *IEEE Transactions on Microwave Theory and Techniques* **17**(12), 1087–1090 (1969), [doi:10.1109/TMTT.1969.1127105](https://doi.org/10.1109/TMTT.1969.1127105).
- D. M. Pozar, *Microwave Engineering*, 4th ed., John Wiley & Sons (2011), ISBN 978-0-470-63155-3.

(python-api-current-and-excitations-cpw-antenna-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class CPWAntenna` | public constructor and IR lowering |
