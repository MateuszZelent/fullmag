# Gaussian plane-wave profile for regional Zeeman excitation

- Status: canonical profile contract; implementation present; qualification pending
- Owners: Fullmag core
- Last updated: 2026-08-04
- Related interaction: `docs/physics/0920-regional-time-domain-field-drive.md`
- Related design: `docs/superpowers/specs/2026-08-04-gaussian-plane-wave-antenna-design.md`
- Related scenario: `tests/vlad/4.5GHz.mx3`

This page defines one closed spatial profile and its Python authoring module.
It does not define a conductor solve. The source is a prescribed Zeeman field,
and all shared regional-drive semantics (stage clocks, energy, output, and
provenance) remain owned by the regional-field-drive contract.

(problem-statement)=
## 1. Physical domain

The source represents the two transverse quadratures used by the 4.5 GHz
spin-wave test. Its magnetic flux-density field is a Gaussian envelope in the
`x-y` plane multiplied by a plane-wave carrier along `x`. It is applied only to
the selected magnetic target and is independent of the magnetization and of
any conductor current.

The public helper `GaussianPlaneWaveAntenna` is an authoring macro. It expands
to two canonical `RegionalFieldDrive` entries, one along `x` and one along `z`.
The expansion is intentional: it reuses the existing interaction, energy,
field readback, stage activation, and backend capability contracts.

(governing-equations)=
## 2. Governing equations

Let $x_c,y_c$ be the Gaussian-envelope centre and let $x_{\mathrm{carrier}}$
be the independent carrier origin. The dimensionless envelope is

```{math}
:label: gaussian-plane-wave-envelope
G(\mathbf r)=\exp\left[-\frac{(x-x_c)^2}{2\sigma_x^2}
                         -\frac{(y-y_c)^2}{2\sigma_y^2}\right].
```

The carrier wavenumber and the two quadrature profiles are

```{math}
:label: gaussian-plane-wave-quadratures
k=\frac{2\pi}{\lambda},\qquad
S_x(\mathbf r)=G(\mathbf r)\cos\left(k(x-x_{\mathrm{carrier}})+\phi_s\right),
\qquad
S_z(\mathbf r)=G(\mathbf r)\sin\left(k(x-x_{\mathrm{carrier}})+\phi_s\right).
```

For stage-local time $\tau$, both regional drives use the same waveform

```{math}
:label: gaussian-plane-wave-time-field
\mathbf B_{\mathrm{drive}}(\mathbf r,t)
=B_0\left[\hat{\mathbf x}S_x(\mathbf r)+\hat{\mathbf z}S_z(\mathbf r)\right]
\sin\left(2\pi f\tau+\phi_t-2\pi f t_0\right),
\qquad
\mathbf H_{\mathrm{drive}}=\frac{\mathbf B_{\mathrm{drive}}}{\mu_0}.
```

Thus `phase_rad=0` and `t0_s=2 ns` reproduce
`sin(omega*(t-2 ns))`. The amplitude $B_0$ is authored in tesla; the native
field buffer is in ampere per metre. The corresponding Zeeman energy is

```{math}
:label: gaussian-plane-wave-energy
E_{\mathrm{drive}}(t)=-\mu_0\int_{\Omega_m}
M_s(\mathbf r)\mathbf m(\mathbf r,t)\cdot
\mathbf H_{\mathrm{drive}}(\mathbf r,t)\,dV.
```

(symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf r$ | spatial position | $\mathrm{m}$ |
| $x$ | Cartesian x coordinate | $\mathrm{m}$ |
| $y$ | Cartesian y coordinate | $\mathrm{m}$ |
| $x,y$ | Cartesian coordinates | $\mathrm{m}$ |
| $x_c$ | Gaussian-envelope x centre | $\mathrm{m}$ |
| $y_c$ | Gaussian-envelope y centre | $\mathrm{m}$ |
| $x_c,y_c$ | Gaussian-envelope centre | $\mathrm{m}$ |
| $x_{\mathrm{carrier}}$ | carrier phase origin | $\mathrm{m}$ |
| $\sigma_x$ | Gaussian x standard deviation | $\mathrm{m}$ |
| $\sigma_y$ | Gaussian y standard deviation | $\mathrm{m}$ |
| $\sigma_x,\sigma_y$ | Gaussian standard deviations | $\mathrm{m}$ |
| $\lambda$ | carrier wavelength | $\mathrm{m}$ |
| $k$ | carrier wavenumber | $\mathrm{rad\,m^{-1}}$ |
| $\phi_s$ | spatial carrier phase | $\mathrm{rad}$ |
| $B_0$ | peak flux-density amplitude | $\mathrm{T}$ |
| $\mathbf B_{\mathrm{drive}}$ | imposed flux-density field | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{drive}}$ | imposed effective field | $\mathrm{A\,m^{-1}}$ |
| $f$ | carrier frequency | $\mathrm{Hz}$ |
| $\tau$ | stage-local or absolute time | $\mathrm{s}$ |
| $t_0$ | waveform time shift | $\mathrm{s}$ |
| $\phi_t$ | temporal phase | $\mathrm{rad}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $E_{\mathrm{drive}}$ | Zeeman energy | $\mathrm{J}$ |
| $S_x$ | dimensionless x quadrature profile | $1$ |
| $S_z$ | dimensionless z quadrature profile | $1$ |
| $G$ | dimensionless Gaussian envelope | $1$ |
| $w_{qc}$ | FDM cell-averaged spatial weight | $1$ |
| $V_c$ | FDM cell volume | $\mathrm{m^3}$ |
| $\mathbf H^0_{qc}$ | FDM immutable drive basis | $\mathrm{A\,m^{-1}}$ |
| $\hat{\mathbf e}_q$ | normalized drive direction | $1$ |
| $M_i$ | FEM lumped P1 mass | $\mathrm{m^3}$ |
| $\varphi_i$ | FEM P1 basis function | $1$ |
| $w_{qi}$ | FEM nodal spatial weight | $1$ |
| $\mathbf H^0_{qi}$ | FEM immutable drive basis | $\mathrm{A\,m^{-1}}$ |

The public parameter `fwhm_y_m` is converted to
$\sigma_y=\mathrm{fwhm}_y/(2\sqrt{2\ln 2})$; it is not stored as a second
independent width.

(assumptions-and-validity)=
## 4. Assumptions and validity limits

- The field is prescribed and does not respond to the magnetization.
- No conductor, return current, impedance, Oersted/Biot--Savart solve, or
  electromagnetic wave propagation is implied.
- The profile is closed and analytic. Python callbacks and arbitrary expression
  strings are invalid because they cannot round-trip or execute deterministically
  on every backend.
- `sigma_x_m`, `fwhm_y_m`, `wavelength_m`, and `frequency_hz` are finite and
  strictly positive. The amplitude is finite and nonnegative. All phases and
  centres are finite.
- The profile is not automatically periodic. A nonzero carrier in a periodic
  unit cell is accepted only when the resolved target/profile satisfies the
  existing regional-drive PBC contract.
- The first FEM realization is P1 lumped-L2 projection; the first FDM
  realization is deterministic cell-volume averaging.

## 5. Backend matrix

| Solver | Device | Status | Boundary |
|---|---|---|---|
| FEM | CPU | implemented, qualification pending | Uses the native regional-drive projection path and profile descriptor; managed end-to-end qualification is still blocked by the environment. |
| FEM | GPU | implemented through projected basis, qualification pending | The device consumes the projected basis, but this profile has no independent GPU trajectory qualification yet. |
| FDM | CPU | implemented planner path, qualification pending | The Rust planner shares the analytic profile evaluator; numerical parity is pending. |
| FDM | GPU | unsupported | The current public FDM CUDA lane rejects regional field drives; no hidden CPU fallback is allowed. |

(python-api)=
## 6. Python API

The authoring module is used in a stage-first script:

```python
# %%
import fullmag as fm

study = fm.study("gaussian-plane-wave")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")

# %%
antenna = fm.GaussianPlaneWaveAntenna(
    id="antenna",
    amplitude_B_T=3e-3,
    frequency_hz=4.5e9,
    wavelength_m=196e-9,
    sigma_x_m=196e-9,
    fwhm_y_m=440e-9,
    center_x_m=-4500e-9 / 2.3,
    center_y_m=0.0,
    carrier_origin_x_m=0.0,
    t0_s=2e-9,
)
for drive in antenna.to_drives():
    study.field_drives.add(drive)

# %%
study.stages.add_run(stage_id="excite", until=18e-9)
```

This excerpt intentionally shows only the interaction registration and stage
clock. A complete scenario must also configure the universe, geometry,
materials, magnetization, mesh, demagnetization, damping ramp, and outputs as
shown by the repository-owned FEM SP4 scenario.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `GaussianPlaneWaveAntenna.id` | `str` | required | $1$ | non-empty | stable module prefix and generated drive id | FEM/FDM authoring lanes | expanded `field_drives[].id` |
| `amplitude_B_T` | `float` | required | $\mathrm{T}$ | finite and $\ge 0$ | peak flux-density amplitude | FEM/FDM CPU; FEM GPU planned; FDM GPU unsupported | `field_drives[].amplitude_B_T` |
| `frequency_hz` | `float` | required | $\mathrm{Hz}$ | finite and $>0$ | sinusoidal frequency | FEM/FDM CPU; FEM GPU planned; FDM GPU unsupported | `field_drives[].waveform.frequency_hz` |
| `wavelength_m` | `float` | required | $\mathrm{m}$ | finite and $>0$ | carrier wavelength | FEM/FDM CPU; FEM GPU planned; FDM GPU unsupported | `field_drives[].spatial_profile.wavelength_m` |
| `sigma_x_m` | `float` | required | $\mathrm{m}$ | finite and $>0$ | longitudinal Gaussian width | FEM/FDM CPU; FEM GPU planned; FDM GPU unsupported | `field_drives[].spatial_profile.sigma_x_m` |
| `fwhm_y_m` | `float` | required | $\mathrm{m}$ | finite and $>0$ | transverse Gaussian full width at half maximum | FEM/FDM CPU; FEM GPU planned; FDM GPU unsupported | `field_drives[].spatial_profile.sigma_y_m` |
| `center_x_m` | `float` | `0` | $\mathrm{m}$ | finite | envelope centre in `x` | all planned CPU lanes | `field_drives[].spatial_profile.center_x_m` |
| `center_y_m` | `float` | `0` | $\mathrm{m}$ | finite | envelope centre in `y` | all planned CPU lanes | `field_drives[].spatial_profile.center_y_m` |
| `carrier_origin_x_m` | `float` | `0` | $\mathrm{m}$ | finite | independent carrier phase origin | all planned CPU lanes | `field_drives[].spatial_profile.carrier_origin_x_m` |
| `spatial_phase_rad` | `float` | `0` | $\mathrm{rad}$ | finite | shared carrier phase | all planned CPU lanes | `field_drives[].spatial_profile.carrier_phase_rad` |
| `phase_rad` | `float` | `0` | $\mathrm{rad}$ | finite | temporal phase | all planned CPU lanes | `field_drives[].waveform.phase_rad` |
| `t0_s` | `float` | `0` | $\mathrm{s}$ | finite and $\ge 0$ | temporal shift | all planned CPU lanes | `field_drives[].waveform.phase_rad` |
| `target` | `FieldTarget` | global | $1$ | existing typed target validation | magnetic target | existing regional-drive target lanes | `field_drives[].target` |
| `activation` | `DriveActivation` | all evolution | $1$ | existing activation validation | stage selection | existing regional-drive activation lanes | `field_drives[].activation` |
| `time_origin` | `str` | `stage_local` | $1$ | `stage_local` or `absolute` | waveform clock | existing regional-drive clock lanes | `field_drives[].time_origin` |
| `enabled` | `bool` | `True` | $1$ | boolean | source enable | existing regional-drive lanes | `field_drives[].enabled` |

(problem-ir)=
## 7. ProblemIR representation

The helper expands to two `RegionalFieldDriveIR` values. Their profiles use a
new tagged variant with numeric, JSON-serializable fields:

```json
{
  "kind": "gaussian_plane_wave",
  "center_x_m": -1.9565217391304348e-6,
  "center_y_m": 0.0,
  "carrier_origin_x_m": 0.0,
  "sigma_x_m": 1.96e-7,
  "sigma_y_m": 1.868507960633642e-7,
  "wavelength_m": 1.96e-7,
  "carrier_phase_rad": 0.0
}
```

The x and z drives differ only in direction and carrier phase (`0` and
$-\pi/2$). The requested Python module is retained in the authoring source;
the canonical IR records the resolved physical drives, not a Python object or
backend buffer.

(round-trip-and-failure-semantics)=
## 8. Round-trip and failure semantics

The script builder emits two `fm.RegionalFieldDrive(...)` calls. Re-importing
that script reproduces the same two profile records and waveform phase. This is
an intent-preserving expansion rather than a lossy fallback.

Validation fails before execution for non-finite values, non-positive widths,
wavelength or frequency, duplicate generated ids, unsupported target/profile
types, unsupported activation, or a backend/device combination that rejects
regional drives. Requested execution and resolved execution remain separate;
the requested intent and resolved execution are both retained. These are
validation errors for unsupported combinations, not fallback opportunities;
there is no silent FEM-to-FDM or CPU-to-GPU substitution.

(discrete-realization)=
## 9. Discrete realization

### 9.1 FDM CPU

For cell $c$ the planner computes the existing regional-drive cell average

```{math}
:label: gaussian-plane-wave-fdm-average
w_{qc}=V_c^{-1}\int_{V_c}S_q(\mathbf r)\,dV,
\qquad
\mathbf H^0_{qc}=\frac{B_0}{\mu_0}\hat{\mathbf e}_q w_{qc}.
```

The analytic profile is evaluated at deterministic quadrature points and uses
the existing adaptive cell-volume path. The immutable basis is multiplied by
the sinusoidal waveform at each integrator substage.

### 9.2 FEM CPU

For P1 nodal basis functions $\varphi_i$, the native projection follows the
regional-drive lumped-L2 contract:

```{math}
:label: gaussian-plane-wave-fem-projection
M_i=\int_{\Omega_m}\varphi_i\,dV,
\qquad
w_{qi}=M_i^{-1}\int_{\Omega_m}\varphi_iS_q(\mathbf r)\,dV,
\qquad
\mathbf H^0_{qi}=\frac{B_0}{\mu_0}\hat{\mathbf e}_q w_{qi}.
```

The formula is evaluated while constructing the immutable nodal basis. The
GPU lane, when enabled, receives this projected basis and evaluates only the
waveform; it does not run a host callback or parse a formula every timestep.

### 9.3 FEM GPU and FDM GPU

FEM GPU shares the projected-basis contract but remains unqualified until a
managed native runtime proves descriptor packing, basis parity, and trajectory
parity. FDM GPU is unsupported by the current regional-drive capability and
must fail closed.

(implementation-mapping)=
## 10. Implementation mapping

- Python construction and expansion live in
  `packages/fullmag-py/src/fullmag/model/antenna.py`.
- Public exports and canonical script rendering live in
  `packages/fullmag-py/src/fullmag/model/__init__.py`,
  `packages/fullmag-py/src/fullmag/__init__.py`, and
  `packages/fullmag-py/src/fullmag/runtime/script_builder.py`.
- Tagged IR and validation live in `crates/fullmag-ir/src/study.rs` and
  `crates/fullmag-ir/src/validation.rs`.
- The resource/OpenAPI schema mirror lives in
  `crates/fullmag-api/src/schemas/authoring.rs` and the generated v2 contract
  under `apps/control-room/src/kernel/api/generated/`.
- FDM profile evaluation lives in
  `crates/fullmag-plan/src/regional_field_drive.rs`.
- Native FEM descriptor packing lives in
  `crates/fullmag-fem-sys/src/lib.rs` and
  `crates/fullmag-runner/src/native_fem.rs`.
- FEM CPU projection lives in
  `backends/fem/cpu/mfem/interactions/zeeman_regional_field.hpp` and
  `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp`.
- The final scenario is `tests/vlad/4.5GHz_fem.py` and is intentionally kept
  alongside the ignored MuMax input.

(validation)=
## 11. Validation strategy

The red/green sequence is:

1. Python constructor, lowering, and round-trip tests;
2. Rust IR and planner tests for analytic values and invalid inputs;
3. FEM C++ projection and ABI tests;
4. a focused 4.5 GHz scenario construction test;
5. managed container-backed FEM runtime verification through the repository
   `justfile` once the implementation compiles.

Analytic checks use the exact values $G$, $G\cos$, and $G\sin$ at the carrier
origin, envelope centre, and one wavelength. Refinement checks compare cell and
tetrahedral projection against the analytic integral. Runtime claims are
reported separately from source-level and unit-test evidence.

(limitations)=
## 12. Limitations and deferred work

- This feature is not a conductor-backed antenna and does not provide
  impedance, current crowding, radiation, or Oersted fields.
- Arbitrary formula parsing, rotation of the Gaussian axes, and a full vector
  profile are deferred; the current module is intentionally tied to the
  `x-y` envelope and `x` carrier needed by SP4.
- The MuMax input's finite-image `PBCx=4, PBCy=256` demagnetization and its
  stage-local `temp=300` to `temp=0` toggle have no exact FEM equivalent in
  the current public stage contract; the counterpart keeps those choices
  explicit rather than silently claiming parity.
- FDM GPU support and cross-device scientific qualification are deferred until
  the regional-drive CUDA path has its own validated basis and trajectory gates.

(scientific-bibliography)=
## 13. Scientific bibliography

- A. Vansteenkiste et al., “The design and verification of MuMax3,”
  *AIP Advances* 4, 107133 (2014), DOI
  [10.1063/1.4899186](https://doi.org/10.1063/1.4899186).
- J. C. Slonczewski, “Current-driven excitation of magnetic multilayers,”
  *Journal of Magnetism and Magnetic Materials* 159 (1996),
  DOI [10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).

(source-code-index)=
## 14. Source-code index

| Claim/equation | Path | Symbol | Responsibility | Lane | Test/evidence |
|---|---|---|---|---|---|
| Gaussian profile and antenna module | `packages/fullmag-py/src/fullmag/model/antenna.py` | `class GaussianPlaneWaveFieldProfile`, `class GaussianPlaneWaveAntenna` | Validate the closed profile and expand it into two canonical drives | FEM/FDM authoring | `packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py` |
| Python-to-IR normalization | `packages/fullmag-py/src/fullmag/model/antenna.py` | `RegionalFieldDrive.to_ir` | Serialize resolved drive intent | FEM/FDM | `packages/fullmag-py/tests/test_regional_field_drive.py` |
| v2 resource schema | `crates/fullmag-api/src/schemas/authoring.rs` | `FieldSpatialProfileResource::GaussianPlaneWave` | Preserve the profile in the browser/API contract | FEM/FDM authoring | `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs` |
| FDM cell basis | `crates/fullmag-plan/src/regional_field_drive.rs` | `spatial_point_value`, `resolve_fdm_regional_field_drives` | Evaluate the closed profile and construct cell-centred regional-drive basis | FDM CPU | `crates/fullmag-plan/src/regional_field_drive.rs` |
| FEM regional basis | `backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp` | `spatial_profile_value` | Evaluate/project spatial profile | FEM CPU | `backends/fem/tests/zeeman_contract.cpp` |
| Native profile ABI | `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_spatial_profile_desc` | Pass closed profile parameters to native FEM | FEM CPU/GPU | native ABI tests |
| MuMax source | `tests/vlad/4.5GHz.mx3` | `B_x` | Reference Gaussian quadrature field | reference | scenario comparison |
