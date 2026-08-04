# Gaussian Plane-Wave Regional Antenna

## Context

`tests/vlad/4.5GHz.mx3` prescribes a microwave Zeeman field with a Gaussian
transverse envelope and two spatial quadratures. Fullmag already has the typed
`RegionalFieldDrive` contract, but it has no closed spatial profile that can
represent this source without callbacks or backend-specific code.

The feature is a public authoring module, not a new electromagnetic solver. It
must lower to the existing regional-drive interaction so the same physical
intent can be planned for FEM and FDM and exported through the normal script
builder.

## Decision

Add a frozen, parameterized `GaussianPlaneWaveAntenna` helper to the Python DSL.
The helper is an authoring macro: `to_drives()` returns two ordinary
`RegionalFieldDrive` values with stable ids `<id>_x` and `<id>_z`.

The scalar profile is a new typed `GaussianPlaneWaveFieldProfile`:

\[
G(\mathbf r)=\exp\left[-\frac{(x-x_c)^2}{2\sigma_x^2}
                         -\frac{(y-y_c)^2}{2\sigma_y^2}\right],
\]

\[
S_\phi(\mathbf r)=G(\mathbf r)
\cos\left(k(x-x_c)+\phi\right),\qquad k=2\pi/\lambda.
\]

The x drive uses `phi=0`; the z drive uses `phi=-pi/2`, so the second profile
is `G sin(k(x-x_c))`. Both drives use the same sinusoidal waveform and the
same nonnegative `amplitude_B_T`. The waveform phase is normalized as
`phase_rad - 2*pi*frequency_hz*t0_s`, which is the exact
`sin(omega*(t-t0)+phase_rad)` convention.

The public constructor is:

```python
fm.GaussianPlaneWaveAntenna(
    id="antenna",
    amplitude_B_T=3e-3,
    frequency_hz=4.5e9,
    wavelength_m=196e-9,
    sigma_x_m=196e-9,
    fwhm_y_m=440e-9,
    center_x_m=-Tx / 2.3,
    center_y_m=0.0,
    t0_s=2e-9,
)
```

The helper accepts a `FieldTarget`, `DriveActivation`, `time_origin`, and
`enabled` flag with the same defaults and validation as `RegionalFieldDrive`.
`fwhm_y_m` is required and converted to
`sigma_y=fwhm_y/(2 sqrt(2 ln 2))`; this keeps the user-facing parameter aligned
with the MuMax source while the IR stores the numerical standard deviation.
An optional `spatial_phase_rad` is shared by both quadratures. `phase_rad` is
the temporal phase. `center_z_m` is not needed by this source and is therefore
not exposed; a regional target controls the magnetic domain.

## Lowering and round-trip

The helper never survives as a new solver object in `ProblemIR`. Its lowering
is deterministic:

```text
GaussianPlaneWaveAntenna(id=A)
  -> RegionalFieldDrive(id=A_x, direction=(1,0,0), profile=Gaussian(..., phase=0))
  -> RegionalFieldDrive(id=A_z, direction=(0,0,1), profile=Gaussian(..., phase=-pi/2))
```

The canonical script exporter emits the two regional drives. This is an
intent-preserving round trip: reloading the exported script produces identical
fields, waveforms, target, activation, and provenance even though the helper
macro itself is expanded.

The new profile is represented in `FieldSpatialProfileIR` with finite numeric
parameters only:

```json
{
  "kind": "gaussian_plane_wave",
  "center_x_m": -1.9565217391304348e-6,
  "center_y_m": 0.0,
  "sigma_x_m": 1.96e-7,
  "sigma_y_m": 1.868507960633642e-7,
  "wavelength_m": 1.96e-7,
  "carrier_phase_rad": 0.0
}
```

The profile is dimensionless. `RegionalFieldDrive.amplitude_B_T` remains the
field amplitude in tesla, and the runtime converts it to `H=B/mu0` in A/m.
Unknown fields, non-finite values, non-positive widths/wavelength/frequency,
zero amplitude direction, and non-finite phases are rejected before planning.

## Backend realization

The Rust FDM planner evaluates the closed profile at cell quadrature points and
uses the existing adaptive cell-volume averaging path. The FEM CPU projection
evaluates the same profile during deterministic P1 lumped-L2 projection. Native
FEM descriptors gain one profile kind and its numeric parameters; CUDA does not
evaluate the formula per timestep because it receives the already projected
nodal basis and only evaluates the waveform. This keeps CPU/GPU physics shared
while preserving separate runtime realizations.

FDM CPU is the reference lane. FEM CPU is executable once the existing regional
drive projection path is enabled. FEM GPU is source-visible/executable only
where the managed native regional-drive path is already qualified; this feature
does not promote a capability by source presence alone. FDM GPU remains
unsupported because the current public FDM CUDA path rejects regional drives.

## Validation

Tests must be written before implementation and cover:

1. Python constructor validation and exact `to_drives()` lowering;
2. Python script export/reload equivalence;
3. Rust IR serialization, unknown-field rejection, and profile validation;
4. FDM analytic point values and cell-average convergence;
5. FEM projection values against the analytic profile and uniform-profile
   regression;
6. native descriptor ABI version/size and profile packing;
7. waveform phase equivalence to `sin(omega*(t-t0))`;
8. the final 4.5 GHz FEM scenario, including end damping/Msat gradient and
   both quadrature drives.

The implementation must not claim full electromagnetic antenna fidelity,
finite-conductor current solve, FDM GPU support, or scientific cross-backend
qualification until those independent gates have evidence.

## Non-goals

- arbitrary expression strings or Python callbacks;
- conductor geometry, Oersted/Biot-Savart, impedance, or Maxwell solves;
- replacing `RegionalFieldDrive` with another interaction family;
- changing existing antenna-source model `mqs_2p5d_az`;
- silently falling back between devices or solvers.
