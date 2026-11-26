---
title: Auxiliary Geometry
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Auxiliary geometry

(public-docs-python-api-geometry-auxiliary-geometry)=
(python-api-geometry-auxiliary-geometry-problem-statement)=
## Problem statement

Auxiliary and parametric specialized geometries cover both curved magnonic waveguide domains
(`SinWaveguide`, `ArchWaveguide`) and nonmagnetic 3D conductor/antenna layouts
(`MicrostripAntennaLayout`, `CPWAntennaLayout`, `MeanderAntennaLayout`, `InductiveLoopLayout`,
`PiecewisePath3DLayout`) registered onto a study via `study.conductor(...)`,
`study.antenna_object(...)`, or `study.geometry_object(...)`.

Construction validates typed geometric dimensions, width stations, waypoints, and electrical
conductivity in Python; calling `to_ir()` lowers each geometry into its canonical `ProblemIR`
descriptor before meshing or antenna field-solve planning.

(python-api-geometry-auxiliary-geometry-governing-equations)=
## Governing equations

- `SinWaveguide` and `ArchWaveguide` define curved three-dimensional solid domains
  $\Omega_m \subset \mathbb{R}^3$ (with sinusoidal modulation $z(x) = z_0 + A\sin(2\pi x/\lambda + \varphi)$
  or smooth arch modulation).
- The five 3D conductor layouts define multi-part metallic domains (signal, ground, return, and
  optional closed-loop inlet/outlet connections) oriented by an optional `RigidTransform` for
  magnetostatic/quasistatic/FIT antenna field solves.

Geometry lowering and 3D antenna field-solve physics are documented in
{doc}`../../physics/geometry-and-materials`, {doc}`../../numerical-methods/meshing/index`,
{doc}`../current-and-excitations/cpw-antenna`, and
{doc}`../current-and-excitations/microstrip-antenna`.

(python-api-geometry-auxiliary-geometry-symbols-and-si-units)=
## Symbols and SI units

All geometric extents (`length`, `width`, `height`, `period`, `amplitude`, `z0`, `arch_height`,
`length_m`, `thickness_m`, `signal_width_m`, `left_gap_m`, `right_gap_m`, `pitch_m`,
`inner_radius_m`, `bend_radius_m`, `feed_gap_m`, and `Path3DWaypoint` coordinates `x_m`, `y_m`,
`z_m`, `width_m`) use SI metres ($\mathrm{m}$). `phase` uses radians ($\mathrm{rad}$), electrical
conductivity (`conductivity_s_per_m`) uses siemens per metre ($\mathrm{S\,m^{-1}}$), and
normalized station parameter `s` ($s \in [0, 1]$), counts (`finger_count`, `turns`), part IDs, and
`name` strings are dimensionless ($1$).

(python-api-geometry-auxiliary-geometry-assumptions-and-validity)=
## Assumptions and validity

Positive lengths, thicknesses, widths, radii, and conductivities must be finite and strictly
positive. Station lists (`MicrostripWidthStation`, `CPWWidthStation`) must have monotonically
increasing $s \in [0, 1]$ spanning the strip. `PiecewisePath3DLayout` requires at least two
distinct `Path3DWaypoint` points. Registering an auxiliary geometry via `study.conductor(...)`,
`study.antenna_object(...)`, or `study.geometry_object(...)` declares its role without implicitly
running a current-transport or Oersted field solve.

(python-api-geometry-auxiliary-geometry-python-api)=
## Python API

### Waveguide constructors and study registration helpers

- Waveguides: `fm.SinWaveguide(length, width, height, period, amplitude, *, phase=0.0, z0=0.0, name="sin_waveguide")` and `fm.ArchWaveguide(length, width, height, arch_height, *, z0=0.0, name="arch_waveguide")` (also `fm.shapes.sin_waveguide`, `fm.shapes.arch_waveguide`).
- Study auxiliary-object registration:
  - `study.conductor(shape, name="conductor", *, object_id=None, geometry_name=None)` — registers a nonmagnetic conductor auxiliary object.
  - `study.antenna_object(shape, name="antenna", *, object_id=None, geometry_name=None)` — registers a 3D antenna layout or geometry with explicit `"antenna"` role.
  - `study.geometry_object(shape, name="object", *, type="geometry", object_id=None, geometry_name=None)` — registers a generic auxiliary geometry with an explicit role string.

### 3D conductor antenna layout constructors

| Class | Key parameters | Companion station / waypoint class |
| --- | --- | --- |
| `fm.MicrostripAntennaLayout` | `(name, length_m=..., thickness_m=..., conductivity_s_per_m=..., stations=(), transform=None, return_width_m=None, return_offset_m=None, signal_part_id="signal", return_part_id="return", *, closed_loop=False, inlet_connection_*=None, outlet_connection_*=None)` | `fm.MicrostripWidthStation(s, signal_width_m=None, *, signal_width=None)` |
| `fm.CPWAntennaLayout` | `(name, length_m=..., thickness_m=..., conductivity_s_per_m=..., stations=(), transform=None, signal_part_id="signal", left_ground_part_id="ground_left", right_ground_part_id="ground_right", *, closed_loop=False, inlet_connection_*=None, outlet_connection_*=None)` | `fm.CPWWidthStation(s, signal_width_m=None, left_gap_m=None, right_gap_m=None, left_ground_width_m=None, right_ground_width_m=None)` |
| `fm.MeanderAntennaLayout` | `(name, length_m=..., signal_width_m=..., thickness_m=..., conductivity_s_per_m=..., finger_count=4, pitch_m=..., bend_radius_m=0.0, transform=None, signal_part_id="signal")` | — |
| `fm.InductiveLoopLayout` | `(name, loop_shape="circular" \| "rectangular" \| "omega", inner_radius_m=..., signal_width_m=..., thickness_m=..., conductivity_s_per_m=..., turns=1, bend_radius_m=0.0, feed_gap_m=None, pitch_m=None, transform=None)` | — |
| `fm.PiecewisePath3DLayout` | `(name, waypoints, signal_width_m=..., thickness_m=..., conductivity_s_per_m=..., transform=None, signal_part_id="signal")` | `fm.Path3DWaypoint(x_m, y_m, z_m, width_m=None, bend_radius_m=0.0)` |

### Core waveguide and antenna layout parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `SinWaveguide.length` | `float` | `required` | $\mathrm{m}$ | finite and positive | waveguide length along $x$ | FEM/FDM CPU/GPU: IR; resolver-specific | `length` |
| `SinWaveguide.width` | `float` | `required` | $\mathrm{m}$ | finite and positive | waveguide cross-section width | FEM/FDM CPU/GPU: IR; resolver-specific | `width` |
| `SinWaveguide.height` | `float` | `required` | $\mathrm{m}$ | finite and positive | waveguide thickness | FEM/FDM CPU/GPU: IR; resolver-specific | `height` |
| `SinWaveguide.period` | `float` | `required` | $\mathrm{m}$ | finite and positive | sinusoidal wavelength $\lambda$ | FEM/FDM CPU/GPU: IR; resolver-specific | `period` |
| `SinWaveguide.amplitude` | `float` | `required` | $\mathrm{m}$ | finite | sinusoidal vertical modulation amplitude | FEM/FDM CPU/GPU: IR; resolver-specific | `amplitude` |
| `SinWaveguide.phase` | `float` | `0.0` | $\mathrm{rad}$ | finite | initial sinusoidal phase offset | FEM/FDM CPU/GPU: IR; resolver-specific | `phase` |
| `SinWaveguide.z0` | `float` | `0.0` | $\mathrm{m}$ | finite | baseline vertical offset | FEM/FDM CPU/GPU: IR; resolver-specific | `z0` |
| `ArchWaveguide.arch_height` | `float` | `required` | $\mathrm{m}$ | finite | vertical arch apex elevation | FEM/FDM CPU/GPU: IR; resolver-specific | `arch_height` |
| `CPWAntennaLayout.stations` | `Sequence[CPWWidthStation]` | `()` | $1$ | monotonically increasing $s \in [0, 1]$ with positive widths/gaps | cross-section stations along the CPW strip | FEM/FDM CPU/GPU: IR; antenna solve planner-gated | `stations` |
| `MicrostripAntennaLayout.conductivity_s_per_m` | `float` | `required` | $\mathrm{S\,m^{-1}}$ | finite and positive | conductor electrical conductivity (shared across all 3D antenna layouts) | FEM/FDM CPU/GPU: IR; antenna solve planner-gated | `conductivity_s_per_m` |
| `PiecewisePath3DLayout.waypoints` | `Sequence[Path3DWaypoint]` | `required` | $\mathrm{m}$ | at least two distinct finite 3D waypoints | 3D centerline path of an arbitrary conductor trace | FEM/FDM CPU/GPU: IR; antenna solve planner-gated | `waypoints` |

### Stage-first example

```python
# %% Stage-first study registering a curved waveguide and a 3D CPW antenna object
import fullmag as fm

nm = 1.0e-9
um = 1.0e-6

study = fm.study("auxiliary_geometry_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=25 * nm)

waveguide = fm.SinWaveguide(
    length=1.0 * um,
    width=100 * nm,
    height=30 * nm,
    period=500 * nm,
    amplitude=20 * nm,
    name="yig_waveguide",
)
film = study.geometry(waveguide, name="film")
film.Ms = 140.0e3
film.Aex = 3.5e-12
film.alpha = 0.001
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

cpw = fm.CPWAntennaLayout(
    name="cpw_exciter",
    length_m=600 * nm,
    thickness_m=40 * nm,
    conductivity_s_per_m=5.8e7,
    stations=(
        fm.CPWWidthStation(0.0, signal_width_m=120 * nm, left_gap_m=60 * nm, right_gap_m=60 * nm, left_ground_width_m=100 * nm, right_ground_width_m=100 * nm),
        fm.CPWWidthStation(1.0, signal_width_m=120 * nm, left_gap_m=60 * nm, right_gap_m=60 * nm, left_ground_width_m=100 * nm, right_ground_width_m=100 * nm),
    ),
    transform=fm.RigidTransform(translation_m=(0.0, 0.0, 80 * nm)),
)
study.antenna_object(cpw, name="cpw_exciter")
study.exchange()
study.stages.add_relax(stage_id="relax", dt=5e-13, max_steps=1)

assert waveguide.to_ir()["kind"] == "sin_waveguide"
assert cpw.to_ir()["kind"] == "cpw"
```

(python-api-geometry-auxiliary-geometry-problem-ir)=
## ProblemIR

- `SinWaveguide.to_ir()` / `ArchWaveguide.to_ir()` emit `"kind": "sin_waveguide"` or `"arch_waveguide"` with validated dimensional fields.
- 3D antenna layouts emit `"kind": "microstrip"`, `"cpw"`, `"meander"`, `"inductive_loop"`, or `"piecewise_3d_path"` under `geometry.entries`, with role metadata recorded in `physics_objects[]` when registered via `study.conductor`, `study.antenna_object`, or `study.geometry_object`.

(python-api-geometry-auxiliary-geometry-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves waveguide parameters, 3D conductor layout stations/waypoints,
conductivities, rigid frames, and auxiliary-object roles in `ProblemIR` independently of
`resolved execution`. `Validation errors` reject non-positive dimensions/conductivities or
malformed station/waypoint sequences, while `unsupported combinations` fail closed at the mesher or
antenna field-solve planner boundary.

(python-api-geometry-auxiliary-geometry-discrete-realization)=
## Discrete realization

| Solver | Device | Auxiliary & antenna geometry realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Rasterizes waveguides onto active cells; consumes projected 3D antenna fields when paired with an antenna field solve | Projection and Oersted accuracy qualified separately |
| FDM | GPU | Consumes planner-materialized cell masks and projected antenna basis fields on CUDA | GPU solver parity validated separately |
| FEM | CPU | Builds conforming Gmsh/OpenCASCADE solids for curved waveguides and multi-part 3D conductor meshes | Conforming mesh and current/Oersted solve qualified separately |
| FEM | GPU | Consumes host-built conforming FEM mesh and solved antenna basis on CUDA | Executed-device GPU qualification remains separate |

(python-api-geometry-auxiliary-geometry-implementation-mapping)=
## Implementation mapping

Authoritative implementations live in `packages/fullmag-py/src/fullmag/model/geometry.py`
(`class SinWaveguide`, `class ArchWaveguide`, `class MicrostripAntennaLayout`,
`class CPWAntennaLayout`, `class MeanderAntennaLayout`, `class InductiveLoopLayout`,
`class PiecewisePath3DLayout`, `class Path3DWaypoint`) and
`packages/fullmag-py/src/fullmag/world.py` (`StudyBuilder.conductor`,
`StudyBuilder.antenna_object`, `StudyBuilder.geometry_object`).

(python-api-geometry-auxiliary-geometry-validation)=
## Validation

Focused repository unit tests cover waveguide IR serialization
(`test_waveguide_geometries_export_canonical_ir`,
`test_waveguide_geometry_validation_rejects_invalid_dimensions`) and 3D antenna layout construction,
station/waypoint validation, and role registration.

(python-api-geometry-auxiliary-geometry-limitations)=
## Limitations and Control Room

Control Room supports `ArchWaveguide` inside `ObjectGeometrySpec` and inspects registered 3D antenna
objects (`AntennaObjectPanel`, `AntennaFieldSolveAuthoring`); `SinWaveguide` and programmatic
station/waypoint layouts (`MicrostripAntennaLayout`, `CPWAntennaLayout`, `MeanderAntennaLayout`,
`InductiveLoopLayout`, `PiecewisePath3DLayout`) are authored in Python scripts. See
{doc}`/frontend/capability-register`.

(python-api-geometry-auxiliary-geometry-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-auxiliary-geometry-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2116) | [`class SinWaveguide`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L2116), `class ArchWaveguide` | curved magnonic waveguide geometry constructors |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L816) | [`class MicrostripAntennaLayout`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L816), `class CPWAntennaLayout`, `class MeanderAntennaLayout`, `class InductiveLoopLayout`, `class PiecewisePath3DLayout` | 3D multi-part conductor antenna layouts |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7113) | `StudyBuilder.geometry_object`, `StudyBuilder.conductor`, `StudyBuilder.antenna_object` | auxiliary-object and conductor/antenna registration on studies |
