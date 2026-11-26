---
title: Microstrip Antenna
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Microstrip antenna

(public-docs-python-api-current-and-excitations-microstrip-antenna)=
(python-api-current-and-excitations-microstrip-antenna-problem-statement)=
## Problem statement

Fullmag supports both 2.5D rectangular microstrip authoring (`fm.MicrostripAntenna`) and a general family of 3D conductor-backed antenna layouts (`fm.MicrostripAntennaLayout`, `fm.MicrostripWidthStation`, `fm.MeanderAntennaLayout`, `fm.InductiveLoopLayout`, `fm.PiecewisePath3DLayout`, and `fm.Path3DWaypoint`) that feed the 3D quasi-static conduction and Biot–Savart field-solve pipeline (`fm.AntennaPortMode`, `fm.AntennaFieldSolveStage`, `fm.SolvedAntennaDrive`, `fm.AntennaSpectrumRequest`).

Construction validates typed geometry, station monotonicity, conductivity, and port contracts in Python; `to_ir()` lowers each object into canonical `ProblemIR` records for study capture and field-basis generation.

(python-api-current-and-excitations-microstrip-antenna-governing-equations)=
## Governing equations

`fm.MicrostripAntenna` specifies a rectangular microstrip trace of width $w$, thickness $t$, and preview length $L$ at standoff $h$ (`height_above_magnet`) above the magnetic film, while the 3D layout classes define meshed copper/gold signal and return conductors with conductivity $\sigma$. Driven by an RF current $I(t)$, the conductor current density $\mathbf{J}(\mathbf{x})$ produces a spatially varying induction field $\mathbf{B}(\mathbf{x}, t) = I(t)\,\mu_0\,\mathbf{h}_{\mathrm{basis}}(\mathbf{x})$ ($\mathbf{H} = \mathbf{B}/\mu_0$) governed by 2.5D $A_z$ or 3D Ohmic conduction + Biot–Savart / vector-potential magnetostatics as documented in {doc}`../../physics/interactions/oersted-field/index` and {doc}`../../physics/interactions/zeeman/index`.

> [!NOTE]
> Full-wave finite-integration-technique (FIT) gap-port excitation is currently a Rust CPU research reference implementation with no public Python authoring API yet. Public Python antenna excitation uses the 2.5D `mqs_2p5d_az` and 3D `quasistatic_conduction_biot_savart3d` contracts documented here and on {doc}`cpw-antenna`.

(python-api-current-and-excitations-microstrip-antenna-symbols-and-si-units)=
## Symbols and SI units

- 2.5D and 3D conductor lengths, widths, thicknesses, bend radii, pitches, standoffs, and waypoints (`width`, `thickness`, `height_above_magnet`, `preview_length`, `center_x`, `center_y`, `length_m`, `signal_width_m`, `return_width_m`, `return_offset_m`, `pitch_m`, `inner_radius_m`, `bend_radius_m`, `feed_gap_m`, `x_m`, `y_m`, `z_m`) use SI metres ($\mathrm{m}$).
- 3D conductor conductivity `conductivity_s_per_m` uses $\mathrm{S\,m^{-1}}$; station parameter `s`, `finger_count`, `turns`, and `current_distribution` are dimensionless ($1$).
- Downstream solved field bases produce $\mathbf{H}_{\mathrm{ant}}$ in $\mathrm{A\,m^{-1}}$ per ampere (or $\mathbf{B}$ in $\mathrm{T}$).

(python-api-current-and-excitations-microstrip-antenna-assumptions-and-validity)=
## Assumptions and validity

- On `fm.MicrostripAntenna`, `width`, `thickness`, and `preview_length` must be finite and strictly positive; `height_above_magnet` must be finite and non-negative; `center_x` and `center_y` must be finite; `current_distribution` currently accepts `"uniform"` only.
- On `fm.MicrostripAntennaLayout`, `length_m` (or `length`), `thickness_m` (or `thickness`), `conductivity_s_per_m` (or `conductivity`), and `return_width_m` (or `return_width`) are all required and strictly positive.
- On `fm.InductiveLoopLayout`, `loop_shape` must be `"circular"`, `"rectangular"`, or `"omega"`; `fm.PiecewisePath3DLayout` requires at least two waypoints (`fm.Path3DWaypoint`, mapping, or 3-sequence).
- Unsupported distribution selectors, invalid port branch weights, or unimplemented backend realizations fail closed at construction or planning.

(python-api-current-and-excitations-microstrip-antenna-python-api)=
## Python API

### Constructor or function

`fm.MicrostripAntenna(width, thickness, height_above_magnet, preview_length, center_x=0.0, center_y=0.0, current_distribution="uniform")`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `width` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | signal trace width | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `width` |
| `thickness` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | conductor thickness | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `thickness` |
| `height_above_magnet` | `float` | `required` | $\mathrm{m}$ | finite and `>= 0` | vertical standoff above magnetic film | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `height_above_magnet` |
| `preview_length` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | preview extrusion length | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `preview_length` |
| `center_x` | `float` | `0.0` | $\mathrm{m}$ | finite | in-plane $x$ center offset | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `center_x` |
| `center_y` | `float` | `0.0` | $\mathrm{m}$ | finite | in-plane $y$ center offset | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `center_y` |
| `current_distribution` | `str` | `"uniform"` | $1$ | currently accepts `"uniform"` only | cross-section current distribution model | FEM/FDM CPU/GPU: IR; resolver-specific | `current_distribution` |

### 3D conductor layouts (microstrip, meander, inductive loop, and 3D piecewise path)

All 3D antenna layout classes live in `packages/fullmag-py/src/fullmag/model/geometry.py` and attach to a study via `study.antenna_object(layout, name=...)`:

| Class | Key parameters & defaults | Geometry family & notes |
|---|---|---|
| `fm.MicrostripWidthStation` | `s`, `signal_width_m=None`, `*, signal_width=None` | defines tapered signal trace width at normalized station $s \in [0, 1]$ |
| `fm.MicrostripAntennaLayout` | `name`, `length_m`, `thickness_m`, `conductivity_s_per_m`, `stations=()`, `transform=None`, `return_width_m` (required), `return_offset_m=None`, `signal_part_id="signal"`, `return_part_id="return"`, `*, closed_loop=False`, inlet/outlet connection kwargs | 3D microstrip signal trace paired with return plane; supports optional closed-loop feed jumpers |
| `fm.MeanderAntennaLayout` | `name`, `length_m`, `signal_width_m`, `thickness_m`, `conductivity_s_per_m`, `finger_count=4`, `pitch_m=None`, `bend_radius_m=0.0`, `transform=None`, `signal_part_id="signal"` | multi-finger periodic meander line for narrowband $k$-selective spin-wave excitation |
| `fm.InductiveLoopLayout` | `name`, `loop_shape="circular"`, `inner_radius_m`, `signal_width_m`, `thickness_m`, `conductivity_s_per_m`, `turns=1`, `bend_radius_m=0.0`, `feed_gap_m=None`, `pitch_m=None`, `transform=None`, `signal_part_id="signal"` | `"circular"`, `"rectangular"`, or `"omega"` single- or multi-turn inductive loop |
| `fm.Path3DWaypoint` | `x_m`, `y_m`, `z_m`, `width_m=None`, `bend_radius_m=0.0` | single 3D centerline waypoint with optional local width and bend radius |
| `fm.PiecewisePath3DLayout` | `name`, `waypoints`, `signal_width_m`, `thickness_m`, `conductivity_s_per_m`, `transform=None`, `signal_part_id="signal"` | general 3D routed conductor ribbon swept along `Path3DWaypoint` vertices |

### Shared 3D antenna solve, drive, and spectrum pipeline

Every 3D layout above shares the same study pipeline documented in detail on {doc}`cpw-antenna`:

- **Source & port composition**: `fm.AntennaFieldSource` (`study.antenna_field_source`), `fm.AntennaPortBranch`, `fm.AntennaSourceCutRt0`, `fm.AntennaPortMode` (`study.add_antenna_port_mode`).
- **3D field-basis solve stage**: `fm.AntennaFieldSolveStage` (`study.stages.add_antenna_field_solve`), `fm.AntennaNamedOutput`, `fm.AntennaSurfaceFieldPolicy`, `fm.AntennaRetainedCurrentSource`, `fm.AntennaSourcePreparationAsset`, `fm.AntennaFieldSolve`, `fm.FieldOnly`.
- **Target projection & dynamic drive**: `fm.AntennaStageOutputRef`, `fm.AntennaFieldSolutionRef`, `fm.AntennaTargetProjection`, `fm.SolvedAntennaDrive` (`study.add_solved_antenna_drive`), `fm.AntennaWaveformBandwidthDeclaration`.
- **Excitation $k$-spectrum analysis**: `fm.AntennaSpectrumRequest` (`study.add_antenna_spectrum_request`), `fm.AntennaSpectrumSamplingPlane`, `fm.AntennaSpectrumKGrid`, `fm.EquilibriumStageOutputRef`, `fm.EquilibriumArtifactRef`, and 1D `fm.SpinWaveExcitationAnalysis` (`study.spin_wave_excitation`).

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("microstrip-antenna-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
# 2.5D microstrip source
ms_2p5d = fm.MicrostripAntenna(
    width=2.0e-6,
    thickness=1.0e-7,
    height_above_magnet=1.0e-7,
    preview_length=20.0e-6,
)
study.antenna_field_source(
    name="ms_2p5d_src",
    antenna=ms_2p5d,
    drive=fm.RfDrive(current_a=1.0e-3, frequency_hz=10.0e9),
)

# 3D microstrip layout, port mode, and field-basis solve stage
ms_layout = fm.MicrostripAntennaLayout(
    name="ms_3d_layout",
    length_m=20.0e-6,
    thickness_m=1.0e-7,
    conductivity_s_per_m=5.8e7,
    return_width_m=8.0e-6,
    return_offset_m=1.0e-6,
    stations=(
        fm.MicrostripWidthStation(s=0.0, signal_width_m=2.0e-6),
        fm.MicrostripWidthStation(s=1.0, signal_width_m=2.0e-6),
    ),
)
study.antenna_object(ms_layout, name="ms_3d")
study.add_antenna_port_mode(
    port_mode=fm.AntennaPortMode(
        id="ms_mode",
        source_object_id="ms_3d",
        current_transport_id="ms_charge",
        branches=(
            fm.AntennaPortBranch("signal", "sig_in", "sig_out", 1.0),
            fm.AntennaPortBranch("return", "ret_in", "ret_out", -1.0),
        ),
    )
)
basis_ref = study.stages.add_antenna_field_solve(
    id="ms_field_solve",
    definition=fm.AntennaFieldSolveStage(
        id="ms_field_solve",
        source_object_id="ms_3d",
        current_transport_id="ms_charge",
        port_mode_ids=("ms_mode",),
        field_sampling_domain=fm.FieldTarget.object("film"),
        target_refs=(fm.FieldTarget.object("film"),),
        outputs=(fm.AntennaNamedOutput(id="h_basis", quantity="H_ant_basis"),),
    ),
)

# Additional 3D layout families
meander = fm.MeanderAntennaLayout(
    name="meander_ant",
    length_m=10.0e-6,
    signal_width_m=200.0e-9,
    thickness_m=80.0e-9,
    conductivity_s_per_m=5.8e7,
    finger_count=4,
    pitch_m=500.0e-9,
)
loop = fm.InductiveLoopLayout(
    name="omega_loop",
    loop_shape="omega",
    inner_radius_m=500.0e-9,
    signal_width_m=150.0e-9,
    thickness_m=80.0e-9,
    conductivity_s_per_m=5.8e7,
)
routed = fm.PiecewisePath3DLayout(
    name="routed_trace",
    waypoints=(
        fm.Path3DWaypoint(0.0, 0.0, 100.0e-9),
        fm.Path3DWaypoint(5.0e-6, 0.0, 100.0e-9),
        fm.Path3DWaypoint(5.0e-6, 5.0e-6, 100.0e-9),
    ),
    signal_width_m=250.0e-9,
    thickness_m=80.0e-9,
    conductivity_s_per_m=5.8e7,
)
study.stages.add_relax(stage_id="ms-relax", dt=5e-13, max_steps=1)
canonical_ir = ms_2p5d.to_ir()
```

(python-api-current-and-excitations-microstrip-antenna-problem-ir)=
## ProblemIR

`ms_2p5d.to_ir()` emits a typed dictionary with `"kind": "microstrip"` and fields `"width"`, `"thickness"`, `"height_above_magnet"`, `"preview_length"`, `"center_x"`, `"center_y"`, and `"current_distribution"`. 3D layouts (`fm.MicrostripAntennaLayout`, `fm.MeanderAntennaLayout`, `fm.InductiveLoopLayout`, `fm.PiecewisePath3DLayout`) lower into geometry objects with conductivity and terminal metadata for 3D charge-Poisson and Biot–Savart stages.

(python-api-current-and-excitations-microstrip-antenna-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields (such as omitted `return_width_m` on `fm.MicrostripAntennaLayout`), non-finite values, non-positive geometric lengths, and unsupported distribution values. `Unsupported combinations` (including full-wave FIT gap ports not yet exposed in Python) fail closed at the planner or backend boundary.

(python-api-current-and-excitations-microstrip-antenna-discrete-realization)=
## Discrete realization

The Python contract supplies geometric parameters and canonical `ProblemIR`; discrete field-basis computation and solver execution proceed across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & acceleration notes |
|---|---|---|
| FEM CPU | Supported | Executes 2.5D `mqs_2p5d_az` and 3D `quasistatic_conduction_biot_savart3d` (factor-once charge Poisson + `direct_tetra_quadrature`, `vector_potential_solver`, or `analytic_rt0_surface` Biot–Savart) and 2D spatial FFT spectra; see {ref}`numerical-methods-performance-fem-spectral-multiphysics`. |
| FEM GPU | Supported | IR lowering supported; pre-solved antenna field bases project onto FEM GPU dynamic LLG stages, while 3D Biot–Savart basis solves follow FEM CPU/GPU qualification. |
| FDM CPU | Supported | Consumes projected antenna field bases and 2.5D microstrip Oersted profiles inside FDM LLG stages. |
| FDM GPU | Supported | Consumes projected antenna field bases on CUDA dynamic LLG stages where qualified. |

(python-api-current-and-excitations-microstrip-antenna-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/antenna.py` (`class MicrostripAntenna`, `class AntennaFieldSource`, `class AntennaPortMode`, `class AntennaFieldSolveStage`, `class SolvedAntennaDrive`) and `packages/fullmag-py/src/fullmag/model/geometry.py` (`class MicrostripAntennaLayout`, `class MicrostripWidthStation`, `class MeanderAntennaLayout`, `class InductiveLoopLayout`, `class PiecewisePath3DLayout`, `class Path3DWaypoint`).

(python-api-current-and-excitations-microstrip-antenna-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_flat_antenna_object_prescribed_zeeman_mask_round_trip` and `test_flat_antenna_object_exports_scene_document_object`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-microstrip-antenna-limitations)=
## Limitations and Control Room

Microstrip trace geometry, current distribution presets, port excitations, pre-solved basis overlays, and driven RF waveforms are authored in Control Room via `AntennaObjectPanel` and the `apps/control-room/src/modules/inspector/inspectors/objects/antenna/` specs (`AntennaGeometryPanel`, `AntennaConductorAuthoring`, `AntennaPortComposer`, `AntennaFieldSolveAuthoring`, `AntennaFieldBasisPreview`). Complex routed `fm.PiecewisePath3DLayout` paths, nonuniform spectrum $k$-grids, or backend-specific solver flags not exposed by those panels stay `Python-only`. Full-wave FIT gap ports are not yet exposed in Python or Control Room.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Microstrip trace parameters, ports, solve stage, & drive waveforms | `Model Explorer -> Physics Objects -> <antenna>` (`AntennaObjectPanel`, `AntennaConductorAuthoring`, `AntennaPortComposer`) | `partial` | `runAuthoringMutationWithHistory` (`scene_revision` checked) and 3D field-basis inspection |
| `fm.PiecewisePath3DLayout` custom routes & parameters without a named UI field | Python DSL | `Python-only` | Authored directly in Python |

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
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L1327) | `class MicrostripAntenna` | 2.5D microstrip constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L815) | `class MicrostripAntennaLayout` | 3D conductor-backed microstrip signal + return layout |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L644) | `class MicrostripWidthStation` | longitudinal width station for `MicrostripAntennaLayout` |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L1456) | `class MeanderAntennaLayout` | 3D periodic multi-finger meander conductor layout |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L1620) | `class InductiveLoopLayout` | 3D circular, rectangular, or omega inductive loop layout |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L1850) | `class PiecewisePath3DLayout` | 3D routed conductor ribbon swept along `Path3DWaypoint` vertices |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L1815) | `class Path3DWaypoint` | 3D centerline waypoint descriptor |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L529) | `class AntennaFieldSolveStage` | 3D quasi-static conduction + Biot–Savart field-basis solve stage |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyBuilder` | study registration methods `antenna_object`, `antenna_field_source`, `add_antenna_port_mode`, `add_solved_antenna_drive` |
