# Time-domain regional magnetic-field drive

- Status: canonical physics and numerics contract
- Owners: Fullmag core
- Last updated: 2026-07-16
- Related ADRs:
  - `docs/adr/0011-resource-first-api.md`
  - `docs/adr/0019-regional-field-drive-and-stage-time-semantics.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/resource-first-control-room-api-v2.md`
  - `docs/specs/frontend-v2/01-module-kernel-architecture.md`
  - `docs/specs/frontend-v2/02-module-catalog.md`
  - `docs/specs/frontend-v2/14-viewport-3d-module.md`
  - `docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md`
- Related physics notes:
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
  - `docs/physics/0700-frequency-domain-linearized-llg.md`
  - `docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md`
  - `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
  - `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`
  - `docs/physics/0870-active-observable-and-energy-availability.md`
  - `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`

> Scope boundary: this note remains the canonical contract for the simplified
> MuMax-style prescribed regional field. It is not the conductor-backed
> variable-width microstrip/CPW solver. The latter is defined by physics note
> 0950 and ADR 0017 as a separate staged field-basis workflow.

> The historical `antenna_field_source(model="prescribed_zeeman_mask")` and
> `H_ant` wording below describes the compatibility origin of this feature.
> New authoring uses `RegionalFieldDrive` and the distinct quantities
> `H_drive`, `B_drive`, `E_drive`, and `eden_drive`. Compatibility input may be
> migrated, but canonical Python/UI export must never recreate the old model.

## 1. Problem statement

Fullmag needs a production-grade time-domain spin-wave excitation mechanism that
matches the common mumax-style workflow:

1. define a microstrip-like antenna region in space,
2. use that region as a mask for an externally prescribed microwave magnetic
   field,
3. drive the mask with a time waveform such as sinusoidal or sinc pulse,
4. run LLG in the time domain and observe propagating spin waves,
5. visualize and edit the antenna in the same control room as magnetic objects.

This note intentionally does not request a full electromagnetic antenna solve.
The antenna is a prescribed Zeeman field source:

```text
B_ant(x, t) = B0 * direction * spatial_profile(x) * waveform(t)
H_ant(x, t) = B_ant(x, t) / mu0
```

The antenna object is an authoring and visualization object, not a
ferromagnetic body. It does not carry `Ms`, `Aex`, `alpha`, magnetization
texture, exchange, demag participation, or magnetic material assignment.

The existing `AntennaFieldSource`, `MicrostripAntenna`, `RfDrive`, and
`SpinWaveExcitationAnalysis` concepts are close but not sufficient as-is:

- current `AntennaFieldSource` is shaped around a current-driven antenna field
  family with `solver="mqs_2p5d_az"` and FEM antenna-field precomputation;
- current FDM planning explicitly rejects antenna field sources;
- the requested workflow is a direct Zeeman mask, not Biot-Savart/Oersted or
  magnetoquasistatic microwave field calculation;
- the antenna must be object-backed in the scene and visible/editable in the
  unified viewport.

The production direction is therefore to extend the antenna-source family with a
new explicit model:

```text
antenna_field_source(model="prescribed_zeeman_mask")
```

and keep the existing current/field-solve antenna realizations separate.

## 2. Physical model

### 2.1 Governing equations

Fullmag LLG time evolution remains:

```text
dm/dt = -gamma0 * m x H_eff + alpha * m x dm/dt + tau_direct
```

with:

```text
H_eff = H_ex + H_demag + H_ext + H_ant + ...
```

For a prescribed microwave antenna field source:

```text
B_ant(x, t) = B_amp * e_b * S(x) * f(t)
H_ant(x, t) = B_ant(x, t) / mu0
```

where:

- `B_amp` is the scalar amplitude in tesla,
- `e_b` is a unit vector direction,
- `S(x)` is a dimensionless spatial profile,
- `f(t)` is a dimensionless waveform,
- `mu0` is vacuum permeability.

The Zeeman contribution is:

```text
E_ant[m, t] = - integral_Omega M(x) dot B_ant(x, t) dV
            = - mu0 * integral_Omega Ms(x) m(x) dot H_ant(x, t) dV
```

and the effective-field contribution is exactly:

```text
H_ant(x, t) = B_ant(x, t) / mu0
```

This is a local additive field. It is not a solve, not a conductor model, and
not a demagnetizing/Oersted calculation.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `M` | magnetization density | A/m |
| `Ms` | saturation magnetization | A/m |
| `B_ant` | prescribed antenna flux density | T |
| `H_ant` | prescribed antenna effective-field contribution | A/m |
| `B_amp` | scalar antenna amplitude | T |
| `e_b` | field direction unit vector | 1 |
| `S(x)` | spatial profile/mask | 1 |
| `f(t)` | time waveform/envelope | 1 |
| `w` | microstrip width | m |
| `L` | microstrip length | m |
| `d` | sinc spatial period or target wavelength | m |
| `sigma_x` | sinc/Gaussian profile width parameter | m |
| `t` | simulation time | s |
| `f0` | sinusoidal frequency | Hz |
| `fc` | sinc cutoff or center frequency convention parameter | Hz |

Public authoring should accept field amplitude in `B` units because existing
`Zeeman(B=...)` does. Runtime field buffers continue to store `H_*` quantities
in `A/m`.

### 2.3 Spatial profiles

The first production slice should support two spatial profiles.

#### Uniform volume/profile

```text
S(x) = 1 if x is inside the resolved antenna mask
S(x) = 0 otherwise
```

This is the direct equivalent of a mumax field mask. It is the recommended MVP
for the permalloy box test.

#### Sinc profile along a chosen axis

```text
u = dot(x - x0, e_profile)
S(x) = sinc((u - u0) / d) * window((u - u0) / sigma_x)
```

with the normalized convention:

```text
sinc(q) = sin(pi * q) / (pi * q)
```

The window should default to a rectangular clip by antenna width for exact
mumax-style masks. A Gaussian or Hann window can be added later if the UI needs
finite-support smoothing.

The sinc profile is useful when the user wants a spatial `k`-selective source.
It must be labeled as an authored field profile, not as the actual near-field
of a conductor.

### 2.4 Time waveforms

The current `TimeDependenceIR` supports:

- `constant`,
- `sinusoidal`,
- `pulse`,
- `piecewise_linear`.

For spin-wave time-domain work, add these canonical waveform families:

```text
sinc_pulse:
  f(t) = a * sinc(2 * fc * (t - t0))

gaussian_sine:
  f(t) = sin(2 * pi * f0 * (t - t0) + phase) * exp(-0.5 * ((t - t0) / sigma_t)^2)

expression:
  f(t) = restricted expression over t, pi, sin, cos, exp, sqrt, sinc
```

The production MVP should implement `sinusoidal` and `sinc_pulse` first.
`piecewise_linear` remains the safe fallback for arbitrary sampled user
functions. A raw Python callback must not be accepted by canonical scripts or
compiled solvers because it is not serializable, not reproducible, and not GPU
portable.

Here `sinc(q)=sin(pi*q)/(pi*q)`, so the canonical pulse is

```text
f(t) = a * sin(2*pi*fc*(t-t0)) / (2*pi*fc*(t-t0)),
f(t0) = a.
```

The UI and every executable backend must evaluate this exact convention. The
shift `t0` is the symmetry centre, not a delayed on/off event. If the selected
run starts at local time zero, the physically sampled source is the finite
window `f(t)` for `0 <= t < T`; the UI must show that actual window and may
also show the centred coordinate `tau=t-t0`. It must not silently reflect,
extend, or recenter the waveform.

Unequal left/right sinc-tail lengths are an informational truncation diagnostic,
not an invalid workflow: a spectroscopy run normally keeps a much longer
post-pulse interval to resolve free precession. Hard validation is reserved for
an invalid sampling clock, a missing response observable, or a violated Nyquist
condition.

If a "dowolna funkcja czasu" UI is needed, it should lower to one of:

1. `PiecewiseLinear(points=[...])` for sampled waveforms,
2. `ExpressionTimeDependence(expression="...")` after a strict expression
   parser is implemented and shared by Python, Rust validation, and script
   export.

### 2.5 Assumptions and approximations

1. The antenna field is prescribed and does not respond to magnetization.
2. No electromagnetic wave propagation, skin effect, impedance, reflections, or
   microwave circuit model is solved.
3. No Biot-Savart/Oersted conductor field is implied by
   `prescribed_zeeman_mask`.
4. The antenna object does not contribute to the magnetic mesh as a magnetic
   material region.
5. The field applies only to magnetic cells/nodes/elements whose sampling point
   is inside the resolved mask or projected mask.
6. The first mask realization is cell-centered for FDM and node-lumped for FEM.
7. For FEM, exact volume integration of the field over tetrahedra is deferred;
   node-lumped or quadrature-sampled application is acceptable only if
   documented in runtime provenance.
8. Multiple antenna sources superpose linearly.

## 3. Numerical interpretation

### 3.1 Shared source-resolution contract

Planner lowering must resolve every prescribed Zeeman antenna source into:

```json
{
  "kind": "resolved_antenna_zeeman_mask",
  "source": "drive",
  "object_id": "antenna_center",
  "amplitude_B_T": 0.001,
  "direction": [0.0, 0.0, 1.0],
  "spatial_profile": { "kind": "uniform" },
  "waveform": { "kind": "sinc_pulse", "cutoff_hz": 20000000000.0, "t0": 5e-11 },
  "sampling": "cell_center" | "node_lumped" | "quadrature",
  "target": "magnetic_domain",
  "resolved_mask_stats": {
    "sample_count": 0,
    "active_count": 0,
    "min_weight": 0.0,
    "max_weight": 1.0
  }
}
```

The shared plan must preserve requested intent. Backend-specific buffers are
runtime realizations, not public authoring semantics.

### 3.2 FDM

FDM uses a regular cell-centered grid. For each active magnetic cell `i`:

```text
mask_i = S(x_i)
H_ant_i(t) = (B_amp / mu0) * e_b * mask_i * f(t)
```

Implementation details:

1. During plan materialization, precompute one scalar mask buffer per antenna
   source on the CPU reference path.
2. For CUDA FDM, upload the mask buffer once and evaluate `f(t)` per RHS call.
3. Compose `H_ant` into `H_eff` at the same point where other local
   time-dependent field terms are composed.
4. If `H_ant` is requested as a display quantity, publish a vector field using
   the current time or last solver snapshot time.
5. If `B_amp=0` or the mask has zero active cells, the planner should warn but
   may allow the run.

The FDM CPU reference should be the validation oracle. CUDA must match CPU in
double precision before the feature is exposed as production executable on GPU.

### 3.3 FEM

FEM uses the shared-domain tetrahedral mesh. The first executable realization
should be node-lumped:

```text
mask_i = S(x_i) for magnetic node i
H_ant_i(t) = (B_amp / mu0) * e_b * mask_i * f(t)
```

The native MFEM CPU/GPU path should:

1. precompute `mask_i * e_b * (B_amp / mu0)` as a per-node vector coefficient,
2. keep that coefficient resident in the backend-local memory lane,
3. scale by `f(t)` during RHS/effective-field composition,
4. add the result into `H_eff`,
5. optionally write/read back `H_ant` under the active quantity contract.

Quadrature-owned realization can be added later for high-order FEM or sharp
antenna boundaries. Until then, provenance must state `sampling=node_lumped`.

For GPU FEM, avoid per-step host callbacks. The waveform variant must be either
closed-form in native code or a table uploaded to device memory.

### 3.4 Hybrid

Hybrid execution is deferred. The source should remain canonical in ProblemIR,
but hybrid planners must reject until each participating subdomain has a
compatible mask sampling and time-waveform realization.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The existing public antenna concepts should be extended rather than replaced.
Recommended explicit API:

```python
antenna = study.geometry(
    fm.MicrostripAntennaObject(
        width=50e-9,
        length=300e-9,
        thickness=10e-9,
        center=(0.0, 0.0, 0.0),
        normal=(0.0, 0.0, 1.0),
    ),
    name="center_microstrip",
)
antenna.role = "antenna"
antenna.visualization(show=True, mode="surface", color="#f5c2e7", wireframe=True)

study.antenna_field_source(
    name="drive",
    model="prescribed_zeeman_mask",
    object="center_microstrip",
    B=1e-3,
    direction=(0.0, 0.0, 1.0),
    spatial_profile=fm.profile.uniform(),
    waveform=fm.waveform.sinc_pulse(cutoff_hz=20e9, t0=50e-12),
)
```

Shorter flat-script convenience:

```python
antenna = fm.antenna.microstrip(
    name="center_microstrip",
    width=50e-9,
    length=300e-9,
    thickness=10e-9,
    center=(0.0, 0.0, 0.0),
)

fm.antenna_field_source(
    name="drive",
    model="prescribed_zeeman_mask",
    object=antenna,
    B=1e-3,
    direction=(0, 0, 1),
    waveform=fm.waveform.sinusoidal(frequency_hz=10e9),
)
```

Alternative for users who do not need a scene object:

```python
fm.zeeman_mask(
    name="drive",
    geometry=fm.Box(50e-9, 300e-9, 10e-9),
    B=(0.0, 0.0, 1e-3),
    waveform=fm.waveform.sinc_pulse(cutoff_hz=20e9, t0=50e-12),
)
```

The object-backed form should be the product path. The geometry-inline form is
useful for scripts and tests but must lower to the same IR.

Python validation rules:

1. `model="prescribed_zeeman_mask"` requires exactly one target object or
   inline geometry.
2. Antenna object role must be non-magnetic.
3. `B` or `amplitude_B_T` must be finite. Zero is legal but warns.
4. `direction` must be finite and nonzero; it is normalized during lowering.
5. `spatial_profile` defaults to `uniform`.
6. `waveform` defaults to `constant` only for debug/static checks. Time-domain
   spin-wave examples should use explicit non-constant waveforms.
7. Raw Python callables are not canonical; use waveform objects or
   `PiecewiseLinear`.

### 4.2 ProblemIR representation

Extend `CurrentModuleIR::AntennaFieldSource` instead of adding a separate
top-level family:

```json
{
  "kind": "antenna_field_source",
  "name": "drive",
  "model": "prescribed_zeeman_mask",
  "object": "center_microstrip",
  "field": {
    "amplitude_B_T": 0.001,
    "direction": [0.0, 0.0, 1.0]
  },
  "spatial_profile": {
    "kind": "uniform"
  },
  "waveform": {
    "kind": "sinusoidal",
    "frequency_hz": 10000000000.0
  }
}
```

Keep the current current-solve antenna source as a distinct model:

```json
{
  "kind": "antenna_field_source",
  "name": "cpw_mqs",
  "model": "mqs_2p5d_az",
  "antenna": { "kind": "cpw", "...": "..." },
  "drive": { "current_a": 0.01, "waveform": { "...": "..." } },
  "air_box_factor": 12.0
}
```

This avoids overloading `solver` as the physical model. The compatibility layer
can deserialize old payloads without `model` as `model="mqs_2p5d_az"`.

Add canonical IR structs:

```rust
pub enum AntennaFieldSourceModelIR {
    PrescribedZeemanMask,
    Mqs2p5dAz,
}

pub enum AntennaSpatialProfileIR {
    Uniform,
    Sinc {
        axis: [f64; 3],
        period_m: f64,
        width_m: Option<f64>,
        center_m: Option<f64>,
        window: String,
    },
}

pub enum TimeDependenceIR {
    Constant,
    Sinusoidal { frequency_hz: f64, phase_rad: f64, offset: f64 },
    Pulse { t_on: f64, t_off: f64 },
    PiecewiseLinear { points: Vec<[f64; 2]> },
    SincPulse { cutoff_hz: f64, t0: f64, amplitude: f64 },
    GaussianSine { frequency_hz: f64, t0: f64, sigma_s: f64, phase_rad: f64 },
}
```

ProblemIR validation:

1. `current_modules[*].name` remains unique.
2. `excitation_analysis.source` may reference any `antenna_field_source`, but
   analysis methods may require source metadata such as `spatial_profile`.
3. `prescribed_zeeman_mask` references a scene object with role `antenna` or an
   inline geometry payload.
4. `prescribed_zeeman_mask` is incompatible with `drive.current_a`; it uses
   `field.amplitude_B_T`.
5. `mqs_2p5d_az` keeps using `drive.current_a`.
6. `sinc.period_m`, `sinc.width_m`, `sinc_pulse.cutoff_hz`, and
   `gaussian_sine.sigma_s` must be positive.

### 4.3 Planner and capability-matrix impact

Capability vocabulary:

```text
antenna.prescribed_zeeman_mask
antenna.spatial_profile.uniform
antenna.spatial_profile.sinc
waveform.sinusoidal
waveform.sinc_pulse
quantity.H_ant
quantity.eden_ant
```

Planner behavior:

| Lane | MVP status | Notes |
|---|---|---|
| FDM CPU | reference executable | first oracle; cell-centered mask |
| FDM GPU | production after parity | device mask + native waveform eval |
| FEM CPU native | production executable | node-lumped mask |
| FEM GPU native | production after CPU/GPU parity | resident coefficient buffer |
| Rust FEM reference | optional/reference later | may reject initially |
| Hybrid | rejected | explicit unsupported diagnostic |

The existing `AntennaFieldSource` CPU-fallback policy must be narrowed:

- `model="mqs_2p5d_az"` keeps any current CPU-only limitations,
- `model="prescribed_zeeman_mask"` must not force CPU fallback merely because it
  is an antenna source.

Planner diagnostics must distinguish:

1. unsupported waveform,
2. unsupported spatial profile,
3. zero active mask samples,
4. stale/missing antenna object geometry,
5. backend lacks `H_ant` output even though it can fold the source into `H_eff`.

## 5. Runtime, artifacts, quantities, and provenance

### 5.1 Runtime stage impact

The canonical pipeline is ordered state, not a bag of globally declared
sources. A typical spectroscopy workflow is:

```text
Relax(stage_id="relax")
AddFieldDrive(stage_id="add-k0-antenna", drive=RegionalFieldDrive(...))
Run(stage_id="excite", ...)
RemoveFieldDrive(stage_id="remove-antenna", drive_id="k0-sinc-antenna")
Run(stage_id="free-evolution", ...)
```

`AddFieldDrive` is a typed, zero-duration pipeline action. It leaves the
magnetization, mesh, absolute solver time, and material state unchanged and
adds the complete drive descriptor to the persistent problem state seen by
subsequent stages. Therefore:

1. the `Relax` stage snapshot has no such drive in `ProblemIR.field_drives`;
2. no antenna field or drive energy exists during relaxation;
3. the action is recorded as its own completed stage in authoring, runtime
   progress, provenance, and exported Python;
4. the following `Run` starts from the relaxed magnetization and sees the
   drive;
5. removing or moving the action changes exactly the downstream stages;
6. duplicate drive ids and invalid targets fail at the action boundary.

`RemoveFieldDrive` is the symmetrical typed, zero-duration action. It removes
exactly one drive by `RegionalFieldDrive.id` from the persistent problem state
seen by subsequent stages while preserving magnetization, mesh, materials,
solver time, device residency, and output configuration. The public command is:

```python
study.stages.remove_field_drive(
    "k0-sinc-antenna",
    stage_id="remove-antenna",
)
```

The positional `drive_id` names the physical source. The optional `stage_id`
names only the removal action; it never identifies a Run or the earlier add
action. Removing an unknown or already removed identifier fails at the action
boundary. A removed identifier may be added again later. Removing one source
does not mutate any other active source.

The older global-definition plus `DriveActivation.stage_ids(...)` form remains
valid compatibility input. It does not replace the explicit action in new UI
pipelines. Dynamic drives remain invalid in minimize/direct-relax stages.

The stage must record whether `t` is:

1. absolute session time,
2. stage-local time starting at zero,
3. continuation time carried from a previous stage.

The default for new spin-wave stages should be stage-local time because users
usually design a pulse relative to the drive stage start.

### 5.1.1 Independent output and analysis commands

The public scripting surface follows the MuMax command model: configuration
commands mutate the persistent problem state seen by subsequent compute
instructions, while `add_run()` only starts time integration. Table sampling,
field/scalar autosave, and response analysis must not be nested inside
`add_run()`. They are typed zero-duration stages because their enabled state
may change between two time-integration intervals.

The canonical order is therefore:

```python
t_sampling = 5e-13
study.stages.tableautosave(t_sampling, quantities=["t", "mx", "my", "mz"])
study.stages.autosave("m", every=2e-12)
study.stages.autosave("H_drive", every=t_sampling)
study.stages.fft_response("my")
study.stages.add_run(stage_id="excite", until=2e-9)
```

`tableautosave()` defines the active response clock `t_sampling`.
`autosave()` commands independently define field/scalar artifact cadences.
`fft_response()` is an optional, independent post-processing request that
selects the response component; its defaults are the physically documented
Ms-times-lumped-volume weighting, linear detrend, Hann window, and a `1e-6`
source-spectrum floor. The internal artifact request name
`spin_wave_response` is not part of the normal user-facing workflow.

Each command takes effect from its position in the ordered pipeline, preserves
magnetization, mesh, materials, and solver time, and persists until another
configuration stage changes it. An unsampled interval is therefore explicit:

```python
study.stages.tableautosave(enabled=False)
study.stages.autosave("m", enabled=False)
study.stages.add_run(stage_id="unsampled", until=1e-9)
```

The canonical exporter must reproduce configuration changes immediately before
the first compute instruction that observes them. This keeps relaxation free
of an analysis request added only after relaxation and makes state transfer
explicit.

For a planned run of duration `T` sampled every `Delta t_s`, the samples are

```text
t_n = n * Delta t_s,  n = 0, ..., N-1,
N = floor(T / Delta t_s) when T/Delta t_s is integral,
Delta f = 1 / (N * Delta t_s),
f_Nyquist = 1 / (2 * Delta t_s).
```

This half-open convention avoids counting both ends of a continuation boundary.
For `T=2 ns` and `Delta t_s=0.5 ps`, `N=4000`, `Delta f=0.5 GHz`, and
`f_Nyquist=1 THz`. The integration step `dt`, table/response `t_sampling`, and
field snapshot cadence are distinct quantities and must be displayed
separately.

### Automatic response sampling from a sinc cutoff

For the active sinc-drive set `D_sinc(run)`,

\[
f_{c,max}=\max_{d\in D_{sinc}(run)} f_{c,d},\qquad
f_{N,target}=1.3 f_{c,max},\qquad
\Delta t_{sample}=\frac{1}{2f_{N,target}}.
\]

All frequencies are in Hz and `Delta t_sample` is in seconds. The fixed factor
1.3 supplies a 30% Nyquist guard. For `f_c,max=5 GHz`, `f_N,target=6.5 GHz`,
`f_sample=13 GHz`, and `Delta t_sample=76.923076923 ps`.

The exact lowercase Python token `"auto"` selects this policy for
`tableautosave()` or for an `autosave(..., every=...)` cadence. It is symbolic
requested intent: Python and UI authoring, canonical script export, and reload
must preserve `"auto"` rather than replacing it with a resolved float. Other
strings and boolean values are invalid. Numeric periods retain their current
explicit behavior and take precedence over automatic resolution for that
instruction.

ProblemIR and scene/study authoring payloads represent the requested cadence as
a tagged policy:

```text
explicit { period_s }
auto_sinc_cutoff { nyquist_guard_factor: 1.3 }
```

Legacy payloads containing only `sample_period_s` deserialize as `explicit`.
Unknown future policy kinds fail closed and remain preserved losslessly as
read-only authoring payloads. The resolved numerical period is plan/provenance
state and must never overwrite the requested ProblemIR policy.

Resolution is per `Run`, from ordered workflow state immediately before that
run. `D_sinc(run)` contains only sinc drives that were already added, remain
enabled, have not been removed, apply to the target run under their activation
policy, and have a finite positive `cutoff_hz`. A persistent automatic
instruction may therefore resolve to different periods for later runs as the
active drive set changes.
For one run, automatic table autosave and automatic field autosave use the same
active-drive rule and resolve to the same period; numeric autosave cadences
remain independent.

One backend-neutral planner resolver serves FDM and FEM, on CPU and GPU, after
ordered actions and drive activation are resolved and before output events are
scheduled. Backends consume only the resolved positive `sample_period_s` and
must not reimplement the cutoff or guard formula. The runtime scheduler may
shorten integration steps to land exactly on sampling events. A fixed-step
backend that cannot land on that clock rejects the plan instead of shifting
output times.

Run/stage provenance and sampling artifacts record the requested policy,
resolved `sample_period_s`, source drive identifiers, maximum source
`cutoff_hz`, guard factor, target Nyquist frequency, sampling frequency, and
target run/stage identifier. This requested-versus-resolved split is identical
for FDM and FEM and is retained across Python/UI round-trip.

Automatic resolution fails closed during workflow validation/planning when no
applicable active sinc drive exists, an applicable cutoff is non-finite or
non-positive, or an automatic policy reaches backend dispatch unresolved. The
diagnostic names the automatic instruction and target run. Resolution must not
guess from solver `dt`, run duration, sinusoidal frequency, or a UI preview
clock. If the selected backend cannot land on the resolved events, it also
fails closed. Exceeding a bounded preview or analysis sample limit disables or
decimates only that preview and does not invalidate the physical runtime clock.

The source preview FFT uses the authored waveform evaluated on this planned
clock. The response FFT uses actual artifact timestamps. Before an FFT, the
runtime/UI verifies finite strictly increasing samples and uniform spacing
within the documented tolerance. Nonuniform samples are marked uncertified and
are not silently resampled. After execution, actual `N`, `Delta t`, duration,
`Delta f`, and Nyquist replace planned estimates.

### 5.2 Quantities

Add active vector quantity:

```text
H_drive
unit: A/m
n_comp: 3
location: cell_center for FDM, node for FEM MVP
available when: at least one executable regional drive is present and active
```

Add optional scalar energy outputs:

```text
E_drive
eden_drive
```

The energy density convention follows Zeeman:

```text
eden_drive = - Ms * dot(m, B_drive)
```

or equivalently:

```text
eden_drive = - mu0 * Ms * dot(m, H_drive)
```

`H_drive` must be unavailable if the source is absent or unsupported. The browser
must not synthesize it from object geometry.

### 5.3 Artifacts

Write a source artifact per run:

```text
antenna_sources/<name>.json
```

Minimum content:

1. authored source IR,
2. resolved object id and scene revision,
3. backend sampling mode,
4. field amplitude and direction,
5. waveform IR,
6. spatial profile IR,
7. mask statistics,
8. active sample indices or a compact hash for large masks,
9. time-origin policy.

Optional binary artifact:

```text
antenna_sources/<name>_mask.fmq
```

for visualizing the scalar mask independently of `H_ant(t)`.

### 5.4 Provenance

Session/run provenance must preserve:

1. authored antenna object geometry and transform,
2. requested `prescribed_zeeman_mask` model,
3. resolved backend sampling mode,
4. requested and resolved waveform,
5. requested and resolved execution lane,
6. whether the source was active in each stage,
7. whether `H_ant` was materialized separately or folded only into `H_eff`.

## 6. Control-room and UI implementation plan

### 6.1 Object model and explorer

Add a scene object role:

```text
object.role = "antenna"
```

An antenna object:

- appears under `Model / Objects / <antenna name>`,
- has inspector nodes:
  - Geometry,
  - Antenna Field,
  - Waveform,
  - Spatial Profile,
  - Visualization,
  - Provenance,
- is selectable and pickable in the 3D viewport,
- is never shown under Magnetic Parameters,
- does not expose `Ms`, `Aex`, `alpha`, `m`, exchange, demag, DMI, or material
  assignment as magnetic parameters.

The explorer should use the same selection and visualization target contract as
magnetic objects:

```text
visualization target id: object:<antenna_object_id>
```

This keeps the user's proposed "options like a ferromagnet" behavior, but the
inspector fields remain antenna-specific.

### 6.2 Geometry and visualization

The antenna should render through existing primitive object layers with a
distinct role/style:

- default display: translucent shaded primitive plus wireframe frame,
- default color: a Catppuccin token such as `--fm-antenna-object`,
- selectable outline and hover behavior identical to other objects,
- visualization panel supports:
  - show/hide,
  - shaded surface,
  - wireframe,
  - opacity,
  - mono color,
  - active quantity target if `H_ant` or mask preview exists.

Do not add a separate "antenna viewport". This is a 3D viewport layer and
inspector extension inside the unified workspace.

### 6.3 Authoring controls

Add command registry entries:

```text
geometry.add-microstrip-antenna
physics.add-prescribed-antenna-field
physics.toggle-antenna-source
physics.preview-antenna-mask
```

Inspector controls:

1. Microstrip dimensions:
   - width,
   - length,
   - thickness,
   - center,
   - rotation/normal.
2. Field:
   - amplitude `B` in mT/T,
   - direction vector,
   - target magnetic objects or default `all magnetic`.
3. Spatial profile:
   - uniform,
   - sinc,
   - profile axis,
   - period,
   - width/window.
4. Time waveform:
   - constant,
   - sinusoidal,
   - sinc pulse,
   - piecewise-linear table,
   - future restricted expression editor.
5. Stage behavior:
   - active during selected time-evolution stages,
   - time origin: stage-local vs absolute.

The UI must submit canonical model transactions/resources. It must not keep
frontend-only antenna physics state.

### 6.4 Resource-first API additions

Add or extend v2 resources:

```text
GET /v2/sessions/current/model/scene
PATCH /v2/sessions/current/model/objects/{object_id}
GET /v2/sessions/current/model/antenna-sources
POST /v2/sessions/current/model/antenna-sources
PATCH /v2/sessions/current/model/antenna-sources/{source_id}
DELETE /v2/sessions/current/model/antenna-sources/{source_id}
GET /v2/sessions/current/visualization/antenna-sources/{source_id}/mask
```

The mask preview resource should return metadata plus binary scalar payload via
the existing data-plane pattern when the mask is large.

Realtime events only invalidate resources:

```text
model:scene-updated
model:antenna-source-updated
visualization:quantity-updated
simulation:stage-updated
```

### 6.5 Script export and round-trip

The Python exporter must emit object-backed antenna scripts in human-editable
form, not raw IR dictionaries.

Required round-trip cases:

1. Python script creates antenna object and source.
2. UI creates antenna object and source, then exports Python.
3. Exported Python reloads to the same ProblemIR.
4. Visualization settings for antenna object survive scene document round-trip.

### 6.6 Study pipeline authoring and scientific preview

The Study tree exposes `Add antenna` as a first-class stage between relaxation
and time evolution. Its dedicated inspector edits the complete canonical
`RegionalFieldDrive`: id/name/enabled state, amplitude and direction, global /
object / region target, spatial profile, waveform, stage-local/absolute clock,
and compatibility activation metadata. It includes a live plot of the actual
`sinc(t-t0)` window and its discrete source spectrum.

The Study tree owns independent `Table autosave`, `Autosave quantity`, and `FFT
response` stage inspectors, including explicit ON/OFF state. The `Run`
inspector owns only time integration, execution progress, produced results, and
a read-only summary of the configuration active at its position. The antenna
inspector resolves the last active `t_sampling` stage before the target Run and
must show, before execution,
response `N`, duration, `Delta f`, Nyquist, sinc cutoff, the maximum legal
`t_sampling = 1/(2 f_c)`, the guarded automatic period
`t_sampling = 1/(2 * 1.3 * f_c)`, and an explicit pass/fail Nyquist verdict. After
execution the analysis view shows actual drive and magnetization traces,
source/response spectra, and peak table from the versioned resource
`/v2/sessions/current/analysis/spin-wave/gamma.v1`.

The inspector and analysis module share only pure physics/sampling models under
`src/shared/domain/physics`; the inspector must not import analysis module
state. HTTP v2 resources remain the source of truth and realtime events only
invalidate them. Unknown stage kinds fail closed and never render as a relax
stage.

## 7. Test case: permalloy box waveguide drive

Base script:

```text
examples/permalloy_box_relax_300x1000x10nm.py
```

Geometry:

- magnetic object: `permalloy_box`,
- nominal size: `300 nm x 1000 nm x 30 nm`,
- coordinate convention for this example: `x` is waveguide width
  (`300 nm`), `y` is propagation/long axis (`1000 nm`), `z` is thickness
  (`30 nm`),
- hole radius: `40 nm`,
- antenna: centered at `(0, 0, 0)`,
- antenna width: `50 nm` along the propagation axis (`y`),
- antenna length: `300 nm` across the waveguide width (`x`),
- antenna thickness: enough to intersect or project through the magnetic film
  for mask sampling; recommended MVP uses an explicit field-mask box:
  `300 nm x 50 nm x 30 nm` in `(x, y, z)`.

Recommended first script variant after relaxation:

```python
center_antenna = study.geometry(
    fm.MicrostripAntennaObject(
        width=50e-9,
        length=300e-9,
        thickness=30e-9,
        center=(0.0, 0.0, 0.0),
        normal=(0.0, 0.0, 1.0),
    ),
    name="center_microstrip",
)
center_antenna.visualization(show=True, mode="surface", wireframe=True)

study.antenna_field_source(
    name="center_drive",
    model="prescribed_zeeman_mask",
    object="center_microstrip",
    B=1e-3,
    direction=(0.0, 0.0, 1.0),
    spatial_profile=fm.profile.uniform(),
    waveform=fm.waveform.sinc_pulse(cutoff_hz=20e9, t0=50e-12),
    time_origin="stage",
)

study.run(
    duration=2e-9,
    solver="rk45",
    dt_max=1e-13,
    outputs=[
        fm.SaveField("m", every=5e-12),
        fm.SaveField("H_ant", every=5e-12),
        fm.SaveScalar("E_ant", every=5e-12),
    ],
)
```

Expected behavior:

1. before mesh/runtime: 3D viewport shows the antenna primitive as a selectable
   non-magnetic object;
2. after mesh/runtime source resolution: mask preview shows a 50 nm strip across
   the waveguide center;
3. during time evolution: `H_ant` is nonzero only under the strip and follows
   the sinc pulse;
4. magnetization snapshots show counter-propagating spin-wave packets along the
   long axis, modulated by the hole/scattering geometry if present.

For early validation, set demag and DMI off and use exchange + Zeeman antenna
only. Add terms back after the source-field contract is verified.

## 8. Implementation phases

### Phase 0 - Contract and compatibility

1. Finish this physics note and update capability vocabulary.
2. Decide whether old `AntennaFieldSource` payloads without `model` deserialize
   as `mqs_2p5d_az`.
3. Add `prescribed_zeeman_mask` to ProblemIR with validation only.
4. Add `SincPulse` to `TimeDependenceIR`.
5. Add Python constructors and serialization tests.

Exit criteria:

- Python -> IR -> validation passes.
- UI-exported equivalent script shape is specified.
- Existing current/Oersted/STT tests still pass.

### Phase 1 - FDM CPU reference

1. Add FDM plan lowering for uniform mask.
2. Precompute scalar mask on CPU.
3. Compose `H_ant` into `H_eff`.
4. Publish `H_ant` quantity for active sources.
5. Add `E_ant` and optional `eden_ant` only after field parity is stable.

Exit criteria:

- uniform-state Zeeman-mask check matches analytical `E_ant`,
- sinusoidal and sinc-pulse waveform evaluation matches Python reference,
- zero active mask gives explicit warning,
- CPU reference waveguide test produces nonzero `H_ant` only under the strip.

### Phase 2 - FEM CPU native

1. Add native FEM plan lowering for node-lumped uniform mask.
2. Add native per-node coefficient buffer.
3. Compose field in `effective_field.cpp` or the existing local-field
   composition boundary, not inside unrelated operators.
4. Publish `H_ant` readback.

Exit criteria:

- FEM CPU `H_ant` matches analytical node mask,
- static `H_ant` contributes to `H_eff`,
- time waveform updates field without rebuilding the mask.

### Phase 3 - GPU lanes

1. FDM GPU uploads mask buffer and evaluates waveform on device.
2. FEM GPU keeps coefficient buffer in FEM GPU local-source memory.
3. Avoid per-step host copies except requested output cadence.
4. Double precision parity comes before single precision exposure.

Exit criteria:

- CPU/GPU field parity for `H_ant`,
- CPU/GPU magnetization parity for a short exchange-only waveguide drive,
- managed runtime proof uses the container-backed `just` recipes.

### Phase 4 - Control-room authoring and visualization

1. Add antenna object role and inspector nodes.
2. Add command registry actions.
3. Add viewport primitive rendering style.
4. Add mask preview resource and scalar coloring.
5. Add waveform editor and script export.

Exit criteria:

- user can add a microstrip antenna from UI,
- exported Python reloads to identical source IR,
- viewport smoke proves antenna object renders and is selectable,
- mask preview and `H_ant` colorbar/quantity display work through resource hooks.

### Phase 5 - Sinc spatial profile and richer waveforms

1. Add spatial sinc profile in planner/runtime mask sampling.
2. Add Gaussian sine waveform.
3. Add piecewise-linear waveform table editor.
4. Add restricted expression only after parser and Rust/Python parity tests
   exist.

Exit criteria:

- sinc profile has analytical CPU reference tests,
- UI validates period/width in SI units,
- script export round-trips every supported waveform/profile.

## 9. Validation strategy

### 9.1 Analytical checks

1. Uniform mask cell count equals expected geometry overlap for axis-aligned box.
2. `H_ant = B_amp / mu0` inside the mask and zero outside for uniform profile.
3. Sinusoidal waveform samples match:

```text
sin(2*pi*f*t + phase) + offset
```

4. Sinc pulse samples match the documented normalized sinc convention.
5. Zeeman energy check:

```text
E_ant = - sum_i Ms_i * dot(m_i, B_ant_i) * V_i
```

for FDM and the documented lumped rule for FEM.

### 9.2 Cross-backend checks

1. FDM CPU and FEM CPU agree qualitatively on the same coarse box source after
   accounting for sampling locations.
2. FDM GPU matches FDM CPU in double precision for `H_ant` and short LLG
   trajectories.
3. FEM GPU matches FEM CPU for `H_ant` and short LLG trajectories.
4. Existing `mqs_2p5d_az` antenna behavior remains unchanged.

### 9.3 UI/browser checks

1. Add antenna object from command palette/ribbon.
2. Select antenna object in viewport and explorer.
3. Edit width/length/thickness and see primitive update.
4. Attach prescribed Zeeman source and preview mask.
5. Switch quantity to `H_ant` and see vector/scalar colorbar with units.
6. Export Python and reload.
7. Run viewport R3F smoke after object/quantity changes.

### 9.4 Regression tests

Python:

- `MicrostripAntennaObject` validation,
- `AntennaFieldSource(model="prescribed_zeeman_mask")`,
- `SincPulse`,
- script rewrite round-trip.

Rust IR/planner:

- validation of source model,
- missing object rejection,
- unsupported profile rejection,
- FDM/FEM plan lowering,
- capability matrix diagnostics.

Runner/backend:

- waveform evaluator,
- mask sampler,
- `H_ant` composition,
- `H_ant` readback,
- `E_ant` optional energy.

Frontend:

- resource facade methods,
- inspector form validation,
- command registration,
- viewport render model includes antenna object,
- no direct component `fetch()`.

## 10. Risks and decisions

### 10.1 Use B amplitude, not H amplitude, in public API

Use `B` or `amplitude_B_T` publicly for consistency with `Zeeman(B=...)`.
Runtime converts to `H_ant` in `A/m`.

### 10.2 Do not accept raw Python functions as canonical waveforms

Raw callbacks cannot be serialized to ProblemIR, exported from UI, or evaluated
on GPU. Use named waveform classes and sampled `PiecewiseLinear` for arbitrary
functions.

### 10.3 Antenna object role must be non-magnetic

An antenna object may share visualization controls with ferromagnets, but it
must not appear as a magnetic material object. This prevents accidental `Ms`,
exchange, demag, or mesh-region semantics.

### 10.4 Field-mask antenna is not the same as Oersted antenna

`prescribed_zeeman_mask` is a simplified excitation source. Existing current
transport, Oersted, and MQS antenna field paths remain separate models.

### 10.5 Sampling provenance is mandatory

FDM cell-centered and FEM node-lumped masks are not identical. Provenance and
quantity metadata must expose sampling location.

## 11. Completeness checklist

- [x] Physics/problem statement
- [x] Governing equations and SI units
- [x] FDM interpretation
- [x] FEM interpretation
- [x] Python API plan
- [x] ProblemIR plan
- [x] Planner/capability plan
- [x] Runtime/provenance plan
- [x] UI/control-room plan
- [x] Permalloy box test plan
- [x] Python regional-drive API implementation
- [x] ProblemIR regional-drive implementation
- [x] Planner regional-drive implementation
- [x] Capability matrix update for implemented lanes
- [x] FDM CPU implementation
- [x] FDM GPU implementation
- [x] FEM CPU implementation
- [x] FEM GPU implementation
- [x] OpenAPI/resource implementation for regional drive and Gamma response
- [x] Explicit `AddFieldDrive` pipeline action and stage-local outputs
- [ ] Explicit `RemoveFieldDrive` pipeline action and round-trip
- [ ] Dedicated stage inspectors and complete planned/actual FFT UI
- [ ] End-to-end browser/runtime qualification for the explicit pipeline

## 12. Deferred work

1. Conductor-backed variable-width microstrip/CPW field calculation is defined
   by note 0950 and remains unimplemented; it is no longer an unspecified
   extension of this regional-mask model.
2. Biot-Savart/Oersted field for arbitrary microstrip current in FDM.
3. Conductivity/contact/impedance models.
4. Full arbitrary expression language before parser parity is proven.
5. Quadrature-owned FEM mask integration.
6. Hybrid execution.
7. Nonuniform-time spectral estimation (NUFFT/Lomb--Scargle); the canonical
   FFT path intentionally fails closed instead of resampling.

## 13. References

1. `docs/physics/0400-fdm-exchange-demag-zeeman.md`
2. `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`
3. `docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md`
4. `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
5. `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`
6. `docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md`
