---
title: RF Drive
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# RF drive

(public-docs-python-api-current-and-excitations-rf-drive)=
(python-api-current-and-excitations-rf-drive-problem-statement)=
## Problem statement

An explicit waveform takes precedence over frequency-derived convenience construction.

Construction validates typed drive parameters in Python; calling `to_ir()` lowers the drive into its canonical `ProblemIR` dictionary for antenna or excitation attachment.

(python-api-current-and-excitations-rf-drive-governing-equations)=
## Governing equations

`RfDrive` constructs a scalar temporal current envelope $I(t) = I_0\,w(t)$ for an antenna or excitation channel, where $w(t)$ defaults to a harmonic drive $\sin(2\pi f t + \phi)$ when `frequency_hz` is given or delegates to an explicit `waveform`. Coupled with an antenna field basis, this scales the resulting magnetic induction $\mathbf{B}(\mathbf{x}, t) = I(t)\,\mathbf{b}_{\mathrm{unit}}(\mathbf{x})$ ($\mathbf{H} = \mathbf{B}/\mu_0$) described in {doc}`../../physics/interactions/oersted-field/index` and {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-rf-drive-symbols-and-si-units)=
## Symbols and SI units

Drive current $I_0$ (`current_a`) uses SI amperes ($\mathrm{A}$); carrier frequency $f$ (`frequency_hz`) uses hertz ($\mathrm{Hz}$); phase offset $\phi$ (`phase_rad`) uses radians ($\mathrm{rad}$); explicit `waveform` descriptors are dimensionless ($1$).

(python-api-current-and-excitations-rf-drive-assumptions-and-validity)=
## Assumptions and validity

`current_a` and `phase_rad` must be finite; `frequency_hz` must be finite and strictly positive when supplied without an overriding `waveform`. Invalid types or contradictory waveform arguments fail closed at construction or lowering.

(python-api-current-and-excitations-rf-drive-python-api)=
## Python API

### Constructor or function

`fm.RfDrive(current_a, frequency_hz=None, phase_rad=0.0, waveform=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `current_a` | `float` | `required` | $\mathrm{A}$ | finite | drive current | FEM/FDM CPU/GPU: IR; resolver-specific | `current` |
| `frequency_hz` | `float or None` | `None` | $\mathrm{Hz}$ | positive when supplied | frequency for convenience waveform | FEM/FDM CPU/GPU: IR; resolver-specific | `waveform.frequency` |
| `phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite | phase offset | FEM/FDM CPU/GPU: IR; resolver-specific | `waveform.phase` |
| `waveform` | `Waveform or None` | `None` | $1$ | typed when supplied | explicit waveform override | FEM/FDM CPU/GPU: IR; resolver-specific | `waveform` |

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
value = fm.RfDrive(current_a=1.0e-3, frequency_hz=1.0e9)
canonical_ir = value.to_ir()
```

In a complete simulation script, attach `value` to an antenna or study excitation handle so it participates in `ProblemIR` capture.

(python-api-current-and-excitations-rf-drive-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary containing `"current_a"` and a nested `"waveform"` record (for example, `{"kind": "sinusoidal", "frequency_hz": ..., "phase_rad": ..., "offset": 0.0}`).

(python-api-current-and-excitations-rf-drive-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing current amplitude, non-finite inputs, and non-positive frequencies, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-rf-drive-discrete-realization)=
## Discrete realization

The Python contract supplies current amplitude and waveform metadata in `ProblemIR` only; time-step evaluation and coupling to antenna field bases are owned by the FEM/FDM backend lanes documented in {doc}`../../physics/interactions/zeeman/index` and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-rf-drive-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/antenna.py` (`class RfDrive`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that class.

(python-api-current-and-excitations-rf-drive-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_rf_drive_serializes_to_ir`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-rf-drive-limitations)=
## Limitations and Control Room

Harmonic and sinc RF waveform definitions are editable in Control Room inside `AntennaObjectPanel` (for antenna-attached excitations) and `RegionalFieldDrivePanel` (for regional field drives), supporting amplitude (`mT`/`T`), `frequency`, `cutoff`, `t0`, `phase`, and `offset` with optimistic `scene_revision` checks. Multi-tone expressions or custom Python callables remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| `sinc` / `sinusoidal` / `piecewise_linear` waveform parameters | `AntennaObjectPanel` or `RegionalFieldDrivePanel` | `partial` | `runAuthoringMutationWithHistory` with `scene_revision` check |
| Custom Python waveform expressions | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-antenna-rf-and-waveforms.png
:alt: Control Room RF waveform parameters and antenna excitation panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-rf-drive-scientific-bibliography)=
## Scientific bibliography

- D. M. Pozar, *Microwave Engineering*, 4th ed., John Wiley & Sons (2011), ISBN 978-0-470-63155-3.
- A. Baker et al., “Proposal of a micromagnetic standard problem for ferromagnetic resonance simulations,” *Journal of Magnetism and Magnetic Materials* **421**, 428–439 (2017), [doi:10.1016/j.jmmm.2016.08.009](https://doi.org/10.1016/j.jmmm.2016.08.009) | [arXiv:1603.05419](https://arxiv.org/abs/1603.05419).

(python-api-current-and-excitations-rf-drive-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class RfDrive` | public constructor and IR lowering |
