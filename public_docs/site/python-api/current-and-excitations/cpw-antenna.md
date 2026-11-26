---
title: CPW Antenna
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# CPW antenna

(public-docs-python-api-current-and-excitations-cpw-antenna)=
(python-api-current-and-excitations-cpw-antenna-problem-statement)=
## Problem statement

Fullmag supports two complementary coplanar-waveguide (CPW) authoring paths:

1. **2.5D analytical/quasi-static CPW source (`fm.CPWAntenna`)**: validates ground–gap–signal–gap–ground cross-section dimensions and pairs with `fm.RfDrive` inside `fm.AntennaFieldSource` / `study.antenna_field_source(...)`.
2. **3D conductor-backed CPW layout and solve pipeline (`fm.CPWAntennaLayout`, `fm.CPWWidthStation`)**: authors tapered or uniform 3D ground–signal–ground conductors via `study.antenna_object(...)`, composes balanced port modes (`fm.AntennaPortMode`, `fm.AntennaPortBranch`, `fm.AntennaSourceCutRt0`), solves 3D quasi-static conduction + Biot–Savart field bases (`fm.AntennaFieldSolveStage`, `study.stages.add_antenna_field_solve(...)`), projects fields onto magnetic targets (`fm.AntennaTargetProjection`, `fm.SolvedAntennaDrive`), and requests $k$-space excitation spectra (`fm.AntennaSpectrumRequest`).

Construction validates typed geometry, port conservation, and stage contracts in Python; `to_ir()` emits canonical `ProblemIR` records before solver planning.

(python-api-current-and-excitations-cpw-antenna-governing-equations)=
## Governing equations

A CPW antenna defines a three-conductor coplanar waveguide (ground–gap–signal–gap–ground) placed above the magnetic film at elevation $h$ (`height_above_magnet` in 2.5D, or positioned via `RigidTransform` in 3D). Driven by an RF current $I(t)$ with opposing return currents on the ground planes, the conductor current density $\mathbf{J}(\mathbf{x})$ generates a spatially inhomogeneous Oersted/Zeeman induction field $\mathbf{B}(\mathbf{x}, t) = I(t)\,\mu_0\,\mathbf{h}_{\mathrm{basis}}(\mathbf{x})$ governed by steady charge conservation $\nabla\cdot(\sigma\nabla V) = 0$ and 2.5D $A_z$ or 3D Biot–Savart / vector-potential magnetostatics as documented in {doc}`../../physics/interactions/oersted-field/index` and {doc}`../../physics/interactions/zeeman/index`.

> [!NOTE]
> Full-wave finite-integration-technique (FIT) gap-port excitation is currently a Rust CPU research reference implementation with no public Python authoring API yet. Public Python antenna excitation uses the 2.5D `mqs_2p5d_az` and 3D `quasistatic_conduction_biot_savart3d` contracts documented below.

(python-api-current-and-excitations-cpw-antenna-symbols-and-si-units)=
## Symbols and SI units

- 2.5D and 3D conductor dimensions (`signal_width`, `gap`, `ground_width`, `thickness`, `height_above_magnet`, `preview_length`, `center_x`, `center_y`, `length_m`, `thickness_m`, `signal_width_m`, `left_gap_m`, `right_gap_m`, `left_ground_width_m`, `right_ground_width_m`) use SI metres ($\mathrm{m}$); station arc-length parameter `s` is dimensionless ($1$).
- 3D conductor conductivity `conductivity_s_per_m` uses $\mathrm{S\,m^{-1}}$; port normalization and peak currents (`normalization_current_a`, `peak_current_a`) use amperes ($\mathrm{A}$); bandwidth `f_max_hz` uses $\mathrm{Hz}$; wave vectors (`k_u_rad_per_m`, `k_v_rad_per_m`) use $\mathrm{rad\,m^{-1}}$.
- Downstream field bases produce $\mathbf{H}_{\mathrm{ant}}$ in $\mathrm{A\,m^{-1}}$ per ampere (or $\mathbf{B}$ in $\mathrm{T}$).

(python-api-current-and-excitations-cpw-antenna-assumptions-and-validity)=
## Assumptions and validity

- On `fm.CPWAntenna`, `signal_width`, `gap`, `ground_width`, `thickness`, and `preview_length` must be finite and strictly positive; `height_above_magnet` must be finite and non-negative; `center_x` and `center_y` must be finite; `current_distribution` currently accepts `"uniform"` only.
- On `fm.AntennaPortMode` (`schema_version="antenna_port_mode.v2"`), at least two `fm.AntennaPortBranch` entries are required with unique IDs and terminal references, signed weights summing to $0$ (within $10^{-12}$), positive weights summing to $1$ with at least one negative return branch, and `normalization_current_a == 1.0`. Under `"antenna_port_mode.v3"`, a typed `fm.AntennaSourceCutRt0` normalization is required.
- On `fm.AntennaFieldSolveStage`, `port_mode_ids` must contain exactly one port mode per executable stage, `outputs` must contain exactly one `H_ant_basis` output, `model` must be `"quasistatic_conduction_biot_savart3d"`, and `oersted_realization` must be `"direct_tetra_quadrature"`, `"vector_potential_solver"`, or `"analytic_rt0_surface"` (the last requiring `surface_field_policy`).

(python-api-current-and-excitations-cpw-antenna-python-api)=
## Python API

### Constructor or function

`fm.CPWAntenna(signal_width, gap, ground_width, thickness, height_above_magnet, preview_length, center_x=0.0, center_y=0.0, current_distribution="uniform")`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `signal_width` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | center signal conductor width | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `signal_width` |
| `gap` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | signal-to-ground slot width | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `gap` |
| `ground_width` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | lateral ground conductor width | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `ground_width` |
| `thickness` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | conductor thickness | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `thickness` |
| `height_above_magnet` | `float` | `required` | $\mathrm{m}$ | finite and `>= 0` | vertical standoff above magnetic film | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `height_above_magnet` |
| `preview_length` | `float` | `required` | $\mathrm{m}$ | finite and `> 0` | preview extrusion length | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `preview_length` |
| `center_x` | `float` | `0.0` | $\mathrm{m}$ | finite | in-plane $x$ center offset | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `center_x` |
| `center_y` | `float` | `0.0` | $\mathrm{m}$ | finite | in-plane $y$ center offset | FEM/FDM CPU/GPU: IR; preview/resolver-specific | `center_y` |
| `current_distribution` | `str` | `"uniform"` | $1$ | currently accepts `"uniform"` only | cross-section current distribution model | FEM/FDM CPU/GPU: IR; resolver-specific | `current_distribution` |

### 3D conductor-backed CPW layout and solve pipeline

For 3D meshed CPW conductors (including tapered width stations and optional closed-loop inlet/outlet connections), author `fm.CPWAntennaLayout` with `fm.CPWWidthStation` and wire it through the shared 3D antenna pipeline (for microstrip, meander, inductive-loop, and 3D piecewise-path layouts, see {doc}`microstrip-antenna`):

| Type / method | Key parameters & defaults | Role in the 3D antenna workflow |
|---|---|---|
| `fm.CPWWidthStation` | `s`, `signal_width_m=None`, `left_gap_m=None`, `right_gap_m=None`, `left_ground_width_m=None`, `right_ground_width_m=None`, `*, signal_width=None`, `gap=None`, `gap_m=None`, `ground_width=None`, `ground_width_m=None` | defines CPW cross-section widths and gaps at normalized longitudinal station $s \in [0, 1]$ |
| `fm.CPWAntennaLayout` | `name`, `length_m`, `thickness_m`, `conductivity_s_per_m`, `stations=()`, `transform=None`, `signal_part_id="signal"`, `left_ground_part_id="ground_left"`, `right_ground_part_id="ground_right"`, `*, closed_loop=False`, inlet/outlet connection kwargs | 3D CPW conductor geometry layout passed to `study.antenna_object(layout, name=...)` |
| `fm.AntennaFieldSource` / `study.antenna_field_source(...)` | `name`, `antenna=None`, `drive=None`, `solver=None`, `air_box_factor=None`, `model="mqs_2p5d_az"`, `object=None`, `B=None`, `direction=(0,0,1)`, `spatial_profile=None`, `waveform=None` | 2.5D `mqs_2p5d_az` antenna source or legacy `prescribed_zeeman_mask` source |
| `fm.AntennaPortBranch` | `id`, `inlet_terminal_ref`, `outlet_terminal_ref`, `signed_weight` | single conductor current branch (`inlet != outlet`) inside a port mode |
| `fm.AntennaSourceCutRt0` | `source_cut_ref`, `orientation="minus_outward"` | RT0 source-cut current normalization for `antenna_port_mode.v3` |
| `fm.AntennaPortMode` / `study.add_antenna_port_mode(...)` | `*, id`, `source_object_id`, `current_transport_id`, `branches`, `normalization_current_a=1.0`, `schema_version="antenna_port_mode.v2"`, `normalization=None` | defines a unit-normalized ($1\,\mathrm{A}$) multi-branch CPW port excitation |
| `fm.AntennaFieldSolveStage` / `study.stages.add_antenna_field_solve(...)` | `*, id`, `source_object_id`, `current_transport_id`, `port_mode_ids`, `field_sampling_domain`, `target_refs`, `outputs`, `oersted_realization="direct_tetra_quadrature"`, `surface_field_policy=None`, `conservative_current_view_ref=None`, `retained_current_source=None`, `retained_source_preparation=None`, `model="quasistatic_conduction_biot_savart3d"`, `conductor_mesh_policy="authored_shared_domain"`, `solver_policy="production_default"` | solves 3D quasi-static conduction + Biot–Savart field basis and returns `fm.AntennaStageOutputRef` |
| `fm.AntennaNamedOutput`, `fm.AntennaSurfaceFieldPolicy`, `fm.AntennaRetainedCurrentSource`, `fm.AntennaSourcePreparationAsset` | named output `(id, quantity="H_ant_basis")`; surface policy `(policy_version, limits, tolerances)`; retained-current & preparation asset refs | typed outputs, analytic RT0 surface tolerances, and retained current-source provenance |
| `fm.AntennaStageOutputRef` / `fm.AntennaFieldSolutionRef` | `(stage_id, output_id)` or pinned `(stage_id, output_id, asset_id, content_digest)` | links a solved antenna field basis into downstream projections and spectrum requests |
| `fm.AntennaTargetProjection` & `fm.SolvedAntennaDrive` / `study.add_solved_antenna_drive(...)` | `AntennaTargetProjection(id, solution, target, output_id)`; `SolvedAntennaDrive(id, name, projection_ref, port_mode_id, peak_current_a, waveform, bandwidth_declaration=None, time_origin="stage_local", activation=None)` (`fm.AntennaWaveformBandwidthDeclaration(f_max_hz)`) | projects the $1\,\mathrm{A}$ field basis onto magnetic targets and drives LLG stages with peak current and waveform |
| `fm.AntennaSpectrumRequest` / `study.add_antenna_spectrum_request(...)` | `id`, `solution_ref`, `target`, `transform` (`"spatial_fft"` / `"nonuniform_spatial_fft"`), `sampling_plane` (`fm.AntennaSpectrumSamplingPlane`), `window`, `normalization`, `component`, `output_id`, optional `port_mode_id`, `nonuniform_k_grid` (`fm.AntennaSpectrumKGrid`), `equilibrium_ref` (`fm.EquilibriumStageOutputRef` / `fm.EquilibriumArtifactRef`), `mode_basis_ref` | computes 2D spatial $k$-spectra of solved antenna fields (also see 1D `fm.SpinWaveExcitationAnalysis` / `study.spin_wave_excitation(...)`) |
| `fm.AntennaFieldSolve` & `fm.FieldOnly` | standalone stage descriptors in `packages/fullmag-py/src/fullmag/model/study.py` | static antenna/field-only stage families without magnetic time evolution |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("cpw-antenna-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
# 2.5D CPW field source with RF drive
cpw_2p5d = fm.CPWAntenna(
    signal_width=2.0e-6,
    gap=1.0e-6,
    ground_width=5.0e-6,
    thickness=1.0e-7,
    height_above_magnet=1.0e-7,
    preview_length=20.0e-6,
)
study.antenna_field_source(
    name="cpw_2p5d_src",
    antenna=cpw_2p5d,
    drive=fm.RfDrive(current_a=2.0e-3, frequency_hz=8.0e9),
)

# 3D conductor-backed CPW layout, balanced port mode, and field-solve stage
cpw_layout = fm.CPWAntennaLayout(
    name="cpw_3d_layout",
    length_m=20.0e-6,
    thickness_m=1.0e-7,
    conductivity_s_per_m=5.8e7,
    stations=(
        fm.CPWWidthStation(s=0.0, signal_width_m=2.0e-6, gap_m=1.0e-6, ground_width_m=4.0e-6),
        fm.CPWWidthStation(s=1.0, signal_width_m=2.0e-6, gap_m=1.0e-6, ground_width_m=4.0e-6),
    ),
)
study.antenna_object(cpw_layout, name="cpw_3d")
study.add_antenna_port_mode(
    port_mode=fm.AntennaPortMode(
        id="cpw_even_mode",
        source_object_id="cpw_3d",
        current_transport_id="cpw_charge",
        branches=(
            fm.AntennaPortBranch("signal", "sig_in", "sig_out", 1.0),
            fm.AntennaPortBranch("gnd_l", "gl_in", "gl_out", -0.5),
            fm.AntennaPortBranch("gnd_r", "gr_in", "gr_out", -0.5),
        ),
    )
)
basis_ref = study.stages.add_antenna_field_solve(
    id="cpw_field_solve",
    definition=fm.AntennaFieldSolveStage(
        id="cpw_field_solve",
        source_object_id="cpw_3d",
        current_transport_id="cpw_charge",
        port_mode_ids=("cpw_even_mode",),
        field_sampling_domain=fm.FieldTarget.object("film"),
        target_refs=(fm.FieldTarget.object("film"),),
        outputs=(fm.AntennaNamedOutput(id="h_basis", quantity="H_ant_basis"),),
    ),
)
study.stages.add_relax(stage_id="cpw-relax", dt=5e-13, max_steps=1)
canonical_ir = cpw_2p5d.to_ir()
```

(python-api-current-and-excitations-cpw-antenna-problem-ir)=
## ProblemIR

`cpw_2p5d.to_ir()` emits a typed dictionary with `"kind": "cpw"` and fields `"signal_width"`, `"gap"`, `"ground_width"`, `"thickness"`, `"height_above_magnet"`, `"preview_length"`, `"center_x"`, `"center_y"`, and `"current_distribution"`. 3D CPW layouts, port modes (`"schema_version": "antenna_port_mode.v2"` or `"v3"`), field-solve stages (`"model": "quasistatic_conduction_biot_savart3d"`), target projections, solved drives, and spectrum requests lower into their corresponding study `ProblemIR` sections.

(python-api-current-and-excitations-cpw-antenna-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields, non-finite values, non-positive geometric dimensions, unsupported `current_distribution` values, unbalanced `fm.AntennaPortMode` branch weights, or malformed `fm.AntennaFieldSolveStage` outputs. `Unsupported combinations` (such as requesting full-wave FIT gap ports or unimplemented GPU Biot–Savart realizations) fail closed at the planner or backend boundary.

(python-api-current-and-excitations-cpw-antenna-discrete-realization)=
## Discrete realization

The Python contract supplies geometric parameters, port-mode contracts, and canonical `ProblemIR`; discrete field-basis computation and execution proceed across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & acceleration notes |
|---|---|---|
| FEM CPU | Supported | Executes 2.5D `mqs_2p5d_az` and 3D `quasistatic_conduction_biot_savart3d` (factor-once charge Poisson + `direct_tetra_quadrature`, `vector_potential_solver`, or `analytic_rt0_surface` Biot–Savart) and 2D spatial FFT spectra; see {ref}`numerical-methods-performance-fem-spectral-multiphysics`. |
| FEM GPU | Supported | IR lowering supported; pre-solved antenna field bases project onto FEM GPU dynamic LLG stages, while 3D Biot–Savart basis solves follow FEM CPU/GPU qualification. |
| FDM CPU | Supported | Consumes projected antenna field bases and 2.5D CPW Oersted profiles inside FDM LLG stages (`fdm_trilinear` spectrum sampling). |
| FDM GPU | Supported | Consumes projected antenna field bases on CUDA dynamic LLG stages where qualified. |

(python-api-current-and-excitations-cpw-antenna-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/antenna.py` (`class CPWAntenna`, `class AntennaFieldSource`, `class AntennaPortMode`, `class AntennaFieldSolveStage`, `class SolvedAntennaDrive`, `class AntennaSpectrumRequest`), `packages/fullmag-py/src/fullmag/model/geometry.py` (`class CPWAntennaLayout`, `class CPWWidthStation`), `packages/fullmag-py/src/fullmag/model/study.py` (`class AntennaFieldSolve`, `class FieldOnly`), and `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder`).

(python-api-current-and-excitations-cpw-antenna-validation)=
## Validation

Focused repository unit tests covering authoring and IR round-tripping include `test_flat_antenna_object_prescribed_zeeman_mask_round_trip` and `test_flat_antenna_object_exports_scene_document_object`. Runtime execution, device performance, and browser rendering require separate qualification.

(python-api-current-and-excitations-cpw-antenna-limitations)=
## Limitations and Control Room

CPW geometry, signal/ground gap ratios, port modes, solved electromagnetic field bases, and temporal drives are exposed in Control Room through `AntennaObjectPanel` and the `apps/control-room/src/modules/inspector/inspectors/objects/antenna/` specs (`AntennaCompositionSummaryPanel`, `AntennaGeometryPanel`, `AntennaConductorAuthoring`, `AntennaPortComposer`, `AntennaFieldSolveAuthoring`, `AntennaExternalLeadInspectionPanel`, and `AntennaFieldBasisPreview`). Advanced Python-authored geometry expressions, `fm.AntennaSpectrumRequest` nonuniform $k$-grids, or solver policy overrides without named inspector fields remain `Python-only`. Full-wave FIT gap ports are not yet exposed in Python or Control Room.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| CPW conductor layout, port modes, solve stage, & RF waveforms | `Model Explorer -> Physics Objects -> <antenna>` (`AntennaObjectPanel`, `AntennaPortComposer`, `AntennaFieldSolveAuthoring`) | `partial` | `runAuthoringMutationWithHistory` (`scene_revision` checked) and 3D basis overlay preview |
| Nonuniform spectrum $k$-grids, `fm.AntennaSourceCutRt0`, & low-level solver hints | Python DSL | `Python-only` | Authored directly in Python |

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
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L1366) | `class CPWAntenna` | 2.5D CPW constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L1087) | `class CPWAntennaLayout` | 3D conductor-backed CPW layout with tapered stations and optional closed loop |
| [`packages/fullmag-py/src/fullmag/model/geometry.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/geometry.py#L674) | `class CPWWidthStation` | longitudinal cross-section station for `CPWAntennaLayout` |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L111) | `class AntennaPortMode` | balanced multi-branch unit-current port excitation contract |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L529) | `class AntennaFieldSolveStage` | 3D quasi-static conduction + Biot–Savart field-basis solve stage |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L251) | `class SolvedAntennaDrive` | time-dependent drive scaling a projected 3D antenna field basis |
| [`packages/fullmag-py/src/fullmag/model/antenna.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/antenna.py#L808) | `class AntennaSpectrumRequest` | 2D $k$-space excitation spectrum request on solved antenna fields |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L745) | `class AntennaFieldSolve` | standalone antenna field-solve stage family descriptor |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyBuilder` | study helpers `antenna_object`, `antenna_field_source`, `add_antenna_port_mode`, `add_solved_antenna_drive`, `add_antenna_spectrum_request` |
