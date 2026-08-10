# Gaussian Plane-Wave Antenna Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parameterized, serializable Gaussian plane-wave regional antenna that expands to two `RegionalFieldDrive` entries and can represent the `4.5GHz.mx3` source on the qualified CPU/FEM paths.

**Architecture:** The Python `GaussianPlaneWaveAntenna` is an authoring macro. It lowers to two existing regional drives, each carrying a new closed `GaussianPlaneWaveFieldProfile` in `FieldSpatialProfileIR`. The Rust planner and native FEM CPU projection evaluate the same finite parameter set; the FEM GPU lane consumes the projected basis and the current FDM GPU rejection remains explicit.

**Tech Stack:** Python `dataclasses`, Fullmag Python DSL/script builder, Rust `serde` ProblemIR and planner, C++ MFEM regional Zeeman interaction, C ABI descriptors, repository `just` managed FEM recipes.

## Global Constraints

- Preserve unrelated dirty worktree changes and ignored `tests/vlad/` conventions.
- Do not add arbitrary callbacks or expression strings; all profile parameters are finite numeric IR fields.
- Keep `RegionalFieldDrive` as the canonical interaction; do not add a second antenna solver or silent backend fallback.
- Use `fwhm_y_m` only at the Python boundary and store normalized `sigma_y_m` in IR.
- Keep the Gaussian envelope centre independent from `carrier_origin_x_m` so the MuMax source's translated envelope and global carrier phase remain exact.
- Native FEM build and runtime evidence use the repository container-backed `justfile` recipes first.
- Write a failing test before each implementation slice and run the focused test before moving on.

---

### Task 1: Python API contract tests

**Files:**
- Modify: `packages/fullmag-py/tests/test_regional_field_drive.py`
- Test: `packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py`

**Interfaces:**
- Produces `fm.GaussianPlaneWaveFieldProfile` with `to_ir()` and
  `fm.GaussianPlaneWaveAntenna` with `to_drives()`.
- `to_drives()` returns exactly two `RegionalFieldDrive` objects with ids
  `<id>_x` and `<id>_z`.

- [ ] **Step 1: Write the failing constructor and lowering tests.**

```python
def test_antenna_expands_to_global_carrier_quadratures():
    antenna = fm.GaussianPlaneWaveAntenna(
        id="src", amplitude_B_T=3e-3, frequency_hz=4.5e9,
        wavelength_m=196e-9, sigma_x_m=196e-9,
        fwhm_y_m=440e-9, center_x_m=-1e-6,
        carrier_origin_x_m=0.0, t0_s=2e-9,
    )
    x_drive, z_drive = antenna.to_drives()
    assert x_drive.id == "src_x"
    assert z_drive.id == "src_z"
    assert x_drive.direction == (1.0, 0.0, 0.0)
    assert z_drive.direction == (0.0, 0.0, 1.0)
    assert x_drive.spatial_profile.to_ir()["carrier_phase_rad"] == 0.0
    assert z_drive.spatial_profile.to_ir()["carrier_phase_rad"] == -math.pi / 2
    assert x_drive.waveform.to_ir()["phase_rad"] == pytest.approx(-2 * math.pi * 4.5e9 * 2e-9)

def test_gaussian_profile_rejects_non_finite_and_non_positive_parameters():
    with pytest.raises(ValueError):
        fm.GaussianPlaneWaveFieldProfile(
            center_x_m=0.0, center_y_m=0.0, carrier_origin_x_m=0.0,
            sigma_x_m=0.0, sigma_y_m=1e-9,
            wavelength_m=1e-9, carrier_phase_rad=0.0,
        )
```

- [ ] **Step 2: Run the focused test to verify it fails.**

Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py`

Expected: collection or attribute failure because neither typed class exists.

- [ ] **Step 3: Add round-trip and exact-profile-value tests.**

Assert `to_ir()` contains the normalized `sigma_y_m`, independent carrier
origin, and the x/z phase pair. Evaluate the profile at the carrier origin and
one quarter wavelength to verify `cos` and `sin` quadratures.

- [ ] **Step 4: Run the Python tests again and keep the failure red until the
implementation task.**

Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py packages/fullmag-py/tests/test_regional_field_drive.py`

Expected: the new tests fail only for missing implementation, while existing
regional-drive tests remain green.

---

### Task 2: Python implementation, exports, and script round-trip

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/antenna.py`
- Modify: `packages/fullmag-py/src/fullmag/model/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py`

**Interfaces:**
- `GaussianPlaneWaveFieldProfile(center_x_m, center_y_m,
  carrier_origin_x_m, sigma_x_m, sigma_y_m, wavelength_m,
  carrier_phase_rad=0.0)` validates all finite numeric fields and serializes
  with `kind="gaussian_plane_wave"`.
- `GaussianPlaneWaveAntenna(id, amplitude_B_T, frequency_hz, wavelength_m,
  sigma_x_m, fwhm_y_m, center_x_m=0.0, center_y_m=0.0,
  carrier_origin_x_m=0.0, spatial_phase_rad=0.0, phase_rad=0.0,
  t0_s=0.0, target=FieldTarget.global_domain(),
  activation=DriveActivation.all_time_evolution(),
  time_origin="stage_local", enabled=True)` returns two drives.

- [ ] **Step 1: Implement the typed profile and helper with existing validators.**

Use `require_positive`, `require_finite`, `require_non_negative`, and
`require_non_empty`. Compute
`sigma_y_m=fwhm_y_m/(2*sqrt(2*log(2)))`; compute temporal phase as
`phase_rad - 2*pi*frequency_hz*t0_s`. Keep `spatial_phase_rad` on the x
profile and subtract `pi/2` for the z profile.

- [ ] **Step 2: Export both classes through the existing model and package
`__all__` lists.**

- [ ] **Step 3: Extend profile rendering and payload rendering in
`script_builder.py`.**

The canonical exporter must render a typed profile, not a callback or a raw
dictionary. Reloading the rendered script must produce equal `to_ir()` payloads.

- [ ] **Step 4: Run the focused Python suite to verify green.**

Run: `PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py packages/fullmag-py/tests/test_regional_field_drive.py packages/fullmag-py/tests/test_script_builder_roundtrip.py`

Expected: all focused Python tests pass.

---

### Task 3: ProblemIR and planner red/green contract

**Files:**
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-plan/src/regional_field_drive.rs`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`
- Test: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Add `FieldSpatialProfileIR::GaussianPlaneWave { center_x_m,
  center_y_m, carrier_origin_x_m, sigma_x_m, sigma_y_m, wavelength_m,
  carrier_phase_rad }` with `deny_unknown_fields` inherited from the tagged
  profile enum.
- Add validation for finite centres/phases and positive widths/wavelength.
- Add `gaussian_plane_wave_value(profile, point)` and route it through
  `spatial_point_value` and cell averaging.

- [ ] **Step 1: Add Rust serde/validation tests before the enum variant.**

Test JSON round-trip, rejection of an unknown field, negative width, zero
wavelength, and non-finite phase. Add a planner test comparing point values at
`x=carrier_origin_x_m`, `x=carrier_origin_x_m+wavelength_m/4`, and the envelope
centre.

- [ ] **Step 2: Run the focused Rust tests and record the red failures.**

Run: `cargo test -p fullmag-ir --test ir_tests gaussian_plane_wave` and
`cargo test -p fullmag-plan gaussian_plane_wave`.

Expected: missing enum variant/function or compile failure.

- [ ] **Step 3: Implement the enum, validation, analytic evaluator, and
adaptive cell-average routing.**

Use `exp`, `cos`, and the stable `sin`/`cos` quadrature directly; do not call
Python or parse a string expression. Keep `Uniform`, `Sinc`, and
`GeometryMask` behavior unchanged.

- [ ] **Step 4: Run `cargo fmt --check` and the focused Rust tests.**

Expected: serde, validation, point-value, and cell-average tests pass without
changing existing regional-drive behavior.

---

### Task 4: Native FEM descriptor and CPU projection

**Files:**
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `backends/fem/cpu/mfem/interactions/zeeman_regional_field.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp`
- Modify: `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu` only if descriptor packing requires it
- Test: `backends/fem/tests/step_metrics_contract.cpp` or a focused regional-profile contract test

**Interfaces:**
- Extend `fullmag_fem_spatial_profile_desc` append-only with the Gaussian
  parameters and increment the regional-drive ABI version.
- Map the IR kind to the descriptor in `pack_native_regional_field_drives`.
- Extend `RegionalFieldDriveRuntime` with the same scalar fields and evaluate
  the profile in the existing projection quadrature.
- Keep the GPU device descriptor waveform-only: it consumes the projected basis
  and must not evaluate a host formula per timestep.

- [ ] **Step 1: Add a failing native contract test for descriptor kind and
  analytic projection values.**

Check the packed kind, append-only struct size/version, and values at the
carrier origin and quarter wavelength. Keep the existing uniform profile test
as a regression.

- [ ] **Step 2: Run the repository-managed FEM test recipe identified in the
`justfile` before implementation.**

Run: `rg -n "verify-fem|rebuild-fem|fem.*test|regional_field" justfile` and use
the matching container-backed recipe. Record the expected red failure.

- [ ] **Step 3: Implement ABI packing, runtime storage, and profile evaluation.**

Preserve append-only ABI compatibility checks, deterministic projection order,
and the existing `basis_h_xyz` waveform path.

- [ ] **Step 4: Run the focused managed FEM contract recipe.**

Expected: native ABI and CPU projection tests pass; GPU is reported only as
source-visible/executable if the managed recipe actually exercises it.

---

### Task 5: Exact 4.5 GHz FEM scenario and integration tests

**Files:**
- Create: `tests/vlad/4.5GHz_fem.py` (ignored by the repository convention)
- Modify: `packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py`
- Test: focused scenario-construction test under `tests/` or Python package tests

**Interfaces:**
- The scenario uses the style of
  `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`.
- It preserves the MuMax geometry: central Py box, two split annular pieces,
  YIG box, sample translation, and 100 mirrored Msat/alpha/Aex gradient strips.
- It registers both generated drives, the `max_damping=0.5` smootherstep
  absorbing boundary, relax stage, and 18 ns time-evolution stage.

- [ ] **Step 1: Add a failing construction test for geometry/gradient/drive
  counts.**

Load the script in lightweight mode and assert two geometry roots, 100 gradient
regions, generated drive ids `antenna_x`/`antenna_z`, `B=3e-3`, `f=4.5e9`,
`lambda=196e-9`, `t0=2e-9`, and `carrier_origin_x_m=0.0`.

- [ ] **Step 2: Create the stage-first FEM scenario with explicit geometry and
  materials.**

Use free tetrahedral mesh for the CSG union because the existing prismatic mesh
path accepts only a single box body. Keep end gradients as explicit region
materials and do not replace the executable `Ms_center=720e3` with the comment
value `790e3`.

- [ ] **Step 3: Run the lightweight scenario construction and Python focused
  tests.**

Expected: exact IR geometry, gradient regions, and two-drive expansion pass.

- [ ] **Step 4: Run the managed FEM scenario only after the container-backed
  build/runtime gate is available.**

Report solver completion, device identity, and scientific qualification
separately; source construction alone is not FEM physics proof.

---

### Task 6: Documentation and final verification

**Files:**
- Modify: `docs/physics/0921-gaussian-plane-wave-regional-profile.md`
- Modify: `docs/physics/0921-gaussian-plane-wave-regional-profile.source-map.json`
- Modify: `docs/specs/capability-matrix-v0.md` only for evidence-backed lane changes

- [ ] **Step 1: Update source-map symbols to the implemented declarations.**

Replace planned source anchors with the final class/function/ABI symbols and
keep every source path plus symbol unique.

- [ ] **Step 2: Run the scientific documentation validator and its unit tests.**

Run: `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0921-gaussian-plane-wave-regional-profile.source-map.json --repo-root .` and
`python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'`.

- [ ] **Step 3: Run focused Python/Rust tests, then the matching container-backed
FEM `just` recipe from the repository.**

Do not report a lane as validated when only source or unit tests passed.

- [ ] **Step 4: Inspect the final diff and cached path list separately.**

Confirm that only the antenna implementation, tests, scenario, and its
documentation changed; preserve all pre-existing UI, example, submodule, and
untracked plan changes.
