---
title: RF Drive
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# RF drive

(public-docs-python-api-current-and-excitations-rf-drive)=
(python-api-current-and-excitations-rf-drive-problem-statement)=
## Problem statement

`fm.RfDrive` pairs a peak/reference excitation current with either a frequency-derived sinusoidal waveform or an explicit `TimeDependence` object (`fm.Constant`, `fm.Sinusoidal`, `fm.Pulse`, `fm.PiecewiseLinear`, or `fm.SincPulse`). An explicit `waveform` takes precedence over `frequency_hz` / `phase_rad` convenience arguments.

Construction validates typed drive parameters in Python; calling `to_ir()` lowers the drive into its canonical `ProblemIR` dictionary for `fm.AntennaFieldSource` and `study.antenna_field_source(...)` attachment.

(python-api-current-and-excitations-rf-drive-governing-equations)=
## Governing equations

`fm.RfDrive` constructs a scalar temporal current envelope $I(t) = I_0\,w(t)$ for an antenna or excitation channel, where $w(t)$ defaults to a harmonic drive $\sin(2\pi f t + \phi)$ when `frequency_hz` is given (and `waveform` is `None`), or delegates to an explicit `waveform` object. Coupled with a 2.5D antenna field basis, this scales the resulting magnetic induction $\mathbf{B}(\mathbf{x}, t) = I(t)\,\mathbf{b}_{\mathrm{unit}}(\mathbf{x})$ ($\mathbf{H} = \mathbf{B}/\mu_0$) described in {doc}`../../physics/interactions/oersted-field/index` and {doc}`../../physics/interactions/zeeman/index`.

(python-api-current-and-excitations-rf-drive-symbols-and-si-units)=
## Symbols and SI units

- Drive current $I_0$ (`current_a`) uses SI amperes ($\mathrm{A}$).
- Carrier frequency $f$ (`frequency_hz`) and sinc cutoff frequency (`cutoff_hz`) use hertz ($\mathrm{Hz}$); phase offset $\phi$ (`phase_rad`) uses radians ($\mathrm{rad}$); pulse times (`t_on`, `t_off`, `t0`) and piecewise timestamps use seconds ($\mathrm{s}$).
- Normalized `waveform` envelopes and DC offsets are dimensionless ($1$).

(python-api-current-and-excitations-rf-drive-assumptions-and-validity)=
## Assumptions and validity

- `frequency_hz` must be finite and strictly positive whenever supplied.
- `waveform`, when supplied, must expose a `to_ir()` method (such as `fm.Constant`, `fm.Sinusoidal`, `fm.Pulse`, `fm.PiecewiseLinear`, or `fm.SincPulse`); invalid objects raise `TypeError`.
- When both `waveform` and `frequency_hz` are supplied, `waveform` takes precedence in `to_ir()`. When both are `None`, `"waveform"` is omitted from the serialized dictionary (representing a static DC current `current_a`).

(python-api-current-and-excitations-rf-drive-python-api)=
## Python API

### Constructor or function

`fm.RfDrive(current_a, frequency_hz=None, phase_rad=0.0, waveform=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `current_a` | `float` | `required` | $\mathrm{A}$ | cast to `float` | reference drive current amplitude | FEM/FDM CPU/GPU: IR; resolver-specific | `current_a` |
| `frequency_hz` | `float \| None` | `None` | $\mathrm{Hz}$ | finite and `> 0` when supplied | frequency for convenience sinusoidal waveform | FEM/FDM CPU/GPU: IR; resolver-specific | `waveform.frequency_hz` |
| `phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite when used in convenience `Sinusoidal` | phase offset for convenience sinusoidal waveform | FEM/FDM CPU/GPU: IR; resolver-specific | `waveform.phase_rad` |
| `waveform` | `TimeDependence \| None` | `None` | $1$ | typed waveform object with `to_ir()` when supplied; overrides `frequency_hz`/`phase_rad` | explicit temporal waveform override | FEM/FDM CPU/GPU: IR; resolver-specific | `waveform` |

### Supported `TimeDependence` waveform classes

All five waveform classes are defined in `packages/fullmag-py/src/fullmag/model/energy.py` and exported on `fullmag`:

| Class | Constructor signature | SI units & validation | ProblemIR `kind` |
|---|---|---|---|
| `fm.Constant` | `fm.Constant()` | dimensionless constant unity ($1$) | `"constant"` |
| `fm.Sinusoidal` | `fm.Sinusoidal(frequency_hz, phase_rad=0.0, offset=0.0)` | `frequency_hz > 0` ($\mathrm{Hz}$), `phase_rad` ($\mathrm{rad}$), `offset` ($1$) | `"sinusoidal"` |
| `fm.Pulse` | `fm.Pulse(t_on, t_off)` | `t_on`, `t_off` in $\mathrm{s}$ with `t_off > t_on` | `"pulse"` |
| `fm.PiecewiseLinear` | `fm.PiecewiseLinear(points)` | sequence of `(t_s, value)` pairs with monotonically increasing timestamps ($\mathrm{s}$, $1$) | `"piecewise_linear"` |
| `fm.SincPulse` | `fm.SincPulse(cutoff_hz, t0=0.0, amplitude=1.0)` | `cutoff_hz > 0` ($\mathrm{Hz}$), `t0` ($\mathrm{s}$), `amplitude` ($1$) | `"sinc"` |

For 3D solved-antenna drives with bandwidth declarations, see `fm.SolvedAntennaDrive` on {doc}`cpw-antenna` and {doc}`microstrip-antenna`.

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("rf-drive-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
antenna = fm.MicrostripAntenna(
    width=2.0e-6,
    thickness=1.0e-7,
    height_above_magnet=1.0e-7,
    preview_length=20.0e-6,
)
rf = fm.RfDrive(
    current_a=1.0e-3,
    waveform=fm.SincPulse(cutoff_hz=20.0e9, t0=0.5e-9, amplitude=1.0),
)
study.antenna_field_source(
    name="ms_rf",
    antenna=antenna,
    drive=rf,
)
study.stages.add_run(until=1.0e-12, stage_id="broadband-excite")
canonical_ir = rf.to_ir()
```

(python-api-current-and-excitations-rf-drive-problem-ir)=
## ProblemIR

`rf.to_ir()` emits a typed dictionary containing `"current_a"` and, whenever a `waveform` or `frequency_hz` is given, a nested `"waveform"` record (for example `{"kind": "sinusoidal", "frequency_hz": ..., "phase_rad": ..., "offset": 0.0}` or `{"kind": "sinc", "cutoff_hz": ..., "t0": ..., "amplitude": ...}`).

(python-api-current-and-excitations-rf-drive-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid waveform types, missing current amplitude, and non-positive frequencies, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-rf-drive-discrete-realization)=
## Discrete realization

The Python contract supplies current amplitude and waveform metadata in `ProblemIR`; time-step evaluation and multiplication against antenna field bases execute across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | Evaluates temporal waveforms at every LLG stage/substep to scale 2.5D/3D antenna basis fields. |
| FEM GPU | Supported | Evaluates temporal waveforms on device for qualified GPU antenna/field-drive lanes. |
| FDM CPU | Supported | Evaluates temporal waveforms on CPU for prescribed Zeeman, Oersted, and antenna field bases. |
| FDM GPU | Supported | Evaluates temporal waveforms on CUDA for active GPU field-drive and antenna basis lanes. |

(python-api-current-and-excitations-rf-drive-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/antenna.py` (`class RfDrive`, `class AntennaFieldSource`) and `packages/fullmag-py/src/fullmag/model/energy.py` (`class Constant`, `class Sinusoidal`, `class Pulse`, `class PiecewiseLinear`, `class SincPulse`).

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
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L1299) | `class RfDrive` | public RF drive constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L1414) | `class AntennaFieldSource` | attaches `RfDrive` and antenna geometry into an excitation field source |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py) | `class Sinusoidal` | sinusoidal temporal waveform `TimeDependence` |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py) | `class SincPulse` | broadband sinc-pulse temporal waveform `TimeDependence` |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py) | `class Pulse` | rectangular time-window waveform `TimeDependence` |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py) | `class PiecewiseLinear` | tabulated piecewise-linear temporal waveform `TimeDependence` |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py) | `class Constant` | unit constant temporal waveform `TimeDependence` |
