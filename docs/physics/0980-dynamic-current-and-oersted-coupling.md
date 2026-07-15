# Dynamic current and Oersted coupling

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-07-15
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula/operator versions: `current_transport.fullmag.v1`,
  `fdm_face_to_cell_current_v1`, `fdm_oersted_fft_open_v1`,
  `fem_oersted_vector_potential_v1`

## 1. Problem statement

All current-induced physics must consume one signed, conservative current field
at the same stage time. Computing torque from one current approximation and
Oersted field from another creates an internally inconsistent multiphysics
problem. This note defines charge-source timing, global circuit closure,
Oersted field/energy semantics, FDM cell-integrated convolution, FEM
`H(curl)` vector potential, caching, rollback, observables, and qualification.

It specifies a target contract and does not claim existing lanes satisfy it.

## 2. Physical model

### 2.1 Conservative dynamic current

On conducting domain `Omega_c`, the M1 electroquasistatic problem is

```text
E=-grad V,
J_c=sigma E,
div J_c=0.
```

M2 may make `J_c=J_c(V,mu_s,m)` through AMR/PHE/AHE and reciprocal spin
feedback, but it retains charge continuity. `J_c` is conventional and signed.
A prescribed `CurrentDensityField` must pass discrete divergence, electrode
flux, and insulating-boundary balance before STT, SHE, or Oersted uses it.
Automatic solenoidal projection is a different explicit model and changes
provenance.

Every drive owns exactly one `TimeEnvelope`:

```text
constant(value)
sinusoidal(amplitude,frequency_hz,phase_rad,offset)
pulse(amplitude,t_on,t_off)                 # [t_on,t_off)
piecewise_linear([(t0,y0),...])
sinc(amplitude,center,bandwidth_hz,offset)
tabulated(artifact,interpolation,extrapolation)
```

Torque and Oersted bind to that source; they do not carry independent copies.
For a separable linear solve,

```text
J_c(x,t)=a(t)J_c0(x),
H_oe(x,t)=a(t)H_oe0(x),
```

so the base maps may be cached. Magnetization-dependent conductivity, iSHE, or
nonseparable electrodes require refresh under the selected coupling policy.

### 2.2 Global circuit closure

Local continuity in a truncated bar with inlet and outlet is insufficient for
Biot–Savart: the magnetic field depends on the return circuit. A general
`OerstedField` requires exactly one closure:

- closed conductor geometry with return path and zero net outer source flux;
- versioned `ExternalLeadExtension` that extends and closes electrodes;
- analytic field of a complete circuit as a prescribed source.

An open two-electrode bar without specified leads/return path is rejected for
general Oersted evaluation. Closure identity and geometry revision are
provenance and cache inputs.

### 2.3 Magnetoquasistatic Oersted field

For the instantaneous conservative current,

```text
H_oe(x,t) = 1/(4 pi) integral_Omega_c
  J_c(x',t) x (x-x')/|x-x'|^3 dV',          [A/m]
curl H_oe=J_c,
div(mu0 H_oe)=0.
```

There is no `mu0` in Biot–Savart for `H`. In vacuum `B_oe=mu0 H_oe`.
Magnetization belongs to the demagnetizing operator and may not be counted as
material permeability in the Oersted solve.

### 2.4 Energy and work semantics

For current independent of `m`, the instantaneous external Zeeman interaction
is

```text
E_oe(t)=-mu0 integral_Omega_m M_s m dot H_oe(t)dV. [J]
```

There is no factor `1/2`. It is published as `oersted_zeeman_energy` with
`energy_semantics=external_zeeman` and may participate in the normal external
field energy accounting.

In M2, `J_c(m)` makes the snapshot above nonvariational: its variation does not
generate the full coupled response. It is published as
`oersted_zeeman_work_snapshot` with
`energy_semantics=coupled_diagnostic_nonvariational`, excluded from canonical
`E_total` and conservative minimizers. It must still match the exact stage
field used in the LLG RHS.

### 2.5 Quasistatic validity

For highest significant angular frequency `omega`, conductor transverse size
`d`, characteristic length `L`, permittivity `epsilon`, conductivity `sigma`,
and magnetic permeability used only in the regime estimate,

```text
r_disp=omega epsilon/sigma,
delta=sqrt(2/(mu sigma omega)),
kL=omega L sqrt(mu0 epsilon).
```

Electro/magnetoquasistatics require all three to be small. Product defaults
warn at `r_disp>1e-2` or `d/delta>0.1`; strict execution rejects values above
`0.1` without an explicit expert override. `kL` also needs a versioned threshold.
Pulse/PWL/tabulated inputs require finite rise time or declared
`bandwidth_hz`; an ideal infinite-bandwidth step is outside strict validity.

### 2.6 Stage time, accepted state, and rollback

For every explicit RK RHS evaluation:

```text
t_stage=t_n+c_i dt,
m_stage=m_i,
J_stage=J_c(m_i,t_stage),
H_oe,stage=H[J_stage].
```

FSAL reuse is valid only when cache identity includes accepted time/state,
transport revision, envelope revision, closure, and method. A rejected step
does not publish a field, change committed revisions, or leave tentative
transport/Oersted state as accepted. After acceptance, observables are refreshed
at the accepted state; published `J_charge`, `H_oe`, and work/energy correspond
to the RHS state they describe.

### 2.7 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `V` | electric potential | V |
| `E` | electric field | V/m |
| `sigma` | conductivity | S/m, positive definite |
| `J_c` | conventional current density | A/m^2 |
| `H_oe` | Oersted field | A/m |
| `B_oe` | magnetic flux density | T |
| `A` | magnetic vector potential | T m |
| `p_gauge` | gauge multiplier in the chosen weak form | A/m |
| `M_s` | saturation magnetization | A/m |
| `E_oe` | external Zeeman energy/snapshot | J |
| `epsilon` | permittivity | F/m |
| `mu` | permeability used in skin-depth estimate | H/m |
| `omega` | highest significant angular frequency | s^-1 |
| `delta`, `d`, `L` | lengths | m |
| `t`, `dt` | time | s |

### 2.8 Assumptions and validity limits

The model excludes displacement current, propagation delay, full-wave
electromagnetics, unresolved skin/eddy-current redistribution, and magnetic
material response inside the Oersted operator. Unsupported PBC, missing closure,
nonconservative prescribed current, undefined source time, or strict operation
outside the regime fail closed rather than selecting a plausible fallback.

## 3. Numerical interpretation

### 3.1 FDM current reconstruction and Oersted convolution

Finite-volume charge produces globally oriented face flux. The only current
map consumed by Oersted and published as `J_charge` is

```text
J_K,x=0.5(J_x,K-1/2+J_x,K+1/2),
```

and analogously for `y,z`, under `fdm_face_to_cell_current_v1`. A future
non-Cartesian source requires a conservative least-squares reconstruction with
a new version. Oersted must not recompute `sigma E`.

Production open-boundary FDM uses a cell-integrated antisymmetric kernel:

```text
K(r) = [ 0    k_z -k_y
        -k_z  0    k_x
         k_y -k_x  0 ],
k_a=1/(4 pi) integral_source_cell r_a/|r|^3 dV',
K(0)=0.
```

Near field uses the cell integral; far field may use a controlled approximation.
The source mask is the conductor, independent of the magnetic mask. FFT uses
zero padding to at least `2N` in every nonperiodic axis, versioned crop,
normalization, R2C layout, near/far cutoff, and kernel precision. PBC is rejected
without a dedicated periodic/Ewald kernel. `nz=1` and other singleton axes have
independent oracles. Plans/buffers are persistent, never rebuilt per RHS.

Cache identity includes cell size, shape, origin, conductor/magnet union grid,
mask and source revisions, closure, cutoff, layout, method, and precision.
CPU double `fdm_oersted_fft_open_v1` is reference/production baseline; CUDA
`fdm_oersted_cufft_open_v1` must preserve kernel/layout/crop semantics with no
strict hot-loop vector transfers.

`analytic_cylinder` is a special geometry oracle and must support an arbitrary
declared axis by a covariant rotation or reject it. `direct_biot_savart` is the
small independent O(N^2) oracle with controlled near-field quadrature.

### 3.2 FEM vector-potential contract

Production FEM solves on conductor plus airbox with vacuum `mu0` everywhere:

```text
curl(mu0^-1 curl A)+grad p_gauge=J_c,
div A=0,
B_oe=curl A,
H_oe=mu0^-1 B_oe.
```

The block form is

```text
[ C  G^T ][A] = [J],
[ G   0  ][p]   [0].
```

`A` uses de Rham-compatible Nedelec `H(curl)` and `p_gauge` uses `H1`, with
zero-mean gauge and any extra harmonic constraints required by multiply
connected domains. Baseline outer BC is `n x A=0`; it is a truncation, not an
exact open boundary. Qualification requires at least three growing airboxes
and extrapolated magnetic-domain error, plus a BC study.

`H_oe` is projected by a consistent `L2` mass matrix to the same nodal field
space used by the LLG RHS, and the observable publishes that exact projection.
Matrix caching is allowed only for unchanged geometry and `mu0`. Production
CPU uses MFEM plus block solver/AMS; GPU uses device hypre/libCEED-owned
operators and state. Assembly, BC, solve, projection, and telemetry have
separate owners; `mfem_bridge.cpp` is an adapter. Strict GPU has no CPU vector-
potential solve or hidden transfer fallback.

Material `mu_r != 1` requires a separate coupled publication to prevent double
counting micromagnetic response.

### 3.3 Hybrid and coupling cadence

No hybrid Oersted lane is validated here. Any future cross-discretization
source projection must conserve total and local current, report projection
error, retain closure, and converge to the same direct Biot–Savart oracle.

`refresh=stage_consistent` is strict. `separable_scale` is exact only after the
planner proves separability. `accepted_step_approx` is explicitly degraded and
requires temporal-order evidence; it cannot claim strict high-order coupling.
M2 nonlinear failure rejects the LLG step. M3 uses common IMEX rollback for
`m,V,mu_s,J,H`, cache state, and telemetry.

## 4. API, IR, planner, runtime, and workspace impact

### 4.1 Python API surface

`CurrentTransport` owns model, domain, drive, one envelope, materials,
electrodes, and coupling. `OerstedField` binds `current_source`, one tagged
circuit closure, method, and refresh policy. Python validation rejects missing
gauge, invalid source/closure, unsupported PBC, unsigned vector reduction,
missing bandwidth, and ambiguous thickness/regions. Canonical script export
preserves all envelope data, including complete piecewise-linear points.

### 4.2 ProblemIR representation

Typed `ResolvedCurrentTransportPlanIR` and `OerstedSourceIR`/
`ResolvedOerstedPlanIR` preserve source identity, signed convention, envelope,
electrodes/BC, closure, method/operator versions, validity assessment,
refresh/coupling, energy semantics, mesh/source revisions, and requested lane.
Legacy flat fields are accepted only by a versioned migrator that cannot drop
parameters. Normalized four-path authoring round-trip is field-for-field equal.

### 4.3 Planner and capability matrix

Capabilities distinguish `transport.charge.ohmic`,
`transport.charge.magnetoresistive`, `field.oersted.dynamic`,
`field.oersted.fdm_fft`, `field.oersted.fem_vector_potential`, and coupling
cadence. Planner verifies continuity, closure, regime, topology, PBC, method,
lane/device/precision, cache identity, solver availability, and strict
residency. Requested and resolved selections remain visible. Validation is
scoped to named workload, geometry/BC, lane, precision, and frequency envelope.

### 4.4 Runtime, quantities, provenance, API, and UI

Transport workflow owns current state; Oersted consumes `J_charge`; integrator
coordinates stage evaluation without owning either physics. Existing IDs
`V_electric`, `J_charge`, and `H_oe` are retained. Energy/work snapshots carry
explicit semantics. Telemetry records residual/balance, refresh/cache counts,
method/operator revision, airbox/kernel metadata, stage time, timings, and
strict-GPU transfer counts.

Provenance records authored source and closure, formula/operator versions,
current convention, envelope/bandwidth, validity metrics/override, requested
and resolved execution, energy semantics, revisions, and external-oracle version.

Resource-first API projects revisioned Current Transport and Oersted Field
models while heavy fields remain in `/data/fields`. Dedicated Explorer and
Inspector nodes show source, signed current, closure, method, refresh, SI units,
regime, freshness, residual, and capability scope. UI Apply shares canonical
validation and export emits canonical Python.

## 5. Validation strategy

### 5.1 Analytical checks

| Workload | Required result |
|---|---|
| uniform/layered conductor | analytic potential, resistance, flux balance |
| infinite-wire limit | `H_phi=I/(2 pi r)` after controlled length study |
| uniform cylinder | analytic inside/outside and continuity at `R` |
| signed-current involution | exact chirality reversal |
| arbitrary-axis cylinder | rotational covariance for z, x, and `(1,1,1)` |
| separable envelope | exact amplitude/phase at every RK stage |
| energy consistency | snapshot from exactly the RHS field, no `1/2` |

### 5.2 Cross-method/backend checks

FDM cell-integrated FFT is compared componentwise with direct integration for
the same closed circuit, including random signed current, near cells, shifted
conductor, mask, `nz=1`, crop, and self-cell zero. FEM vector potential is
compared with direct quadrature and an airbox sequence. Independent FDM/FEM
families converge to the same continuum solution. CPU double is the oracle for
its GPU double lane; FP32 follows a separate error budget. NeuralMag supplies a
comparative regular-grid cell-integrated pattern, not an MFEM oracle.

### 5.3 Regression and quantitative gates

Tests cover discrete `curl(H)-J` and `div(H)` away from a controlled boundary
zone, FFT layout/normalization, singleton axes, unsupported PBC rejection,
closure rejection, conductor/magnet masks, sine/pulse/PWL/sinc timing, FSAL,
rejected-step rollback, final refresh, M2 diagnostic exclusion from `E_total`,
strict-GPU zero hot-loop transfers, quantity/RHS identity, normalized authoring
round-trip, and browser author/run/inspect smoke. Continuum studies use at least
three spatial resolutions and three time steps; observed temporal order must be
at least nominal minus `0.25` in the asymptotic range.

## 6. Completeness checklist

- [ ] Python current/Oersted model and complete envelope export
- [ ] ProblemIR, planner, migration, and scoped capabilities
- [ ] Conservative FDM charge and face-to-cell publication
- [ ] FDM direct oracle and cell-integrated CPU/CUDA FFT
- [ ] FEM direct oracle and `H(curl)` CPU/GPU vector potential
- [ ] Stage-consistent coupling, FSAL, rollback, final refresh
- [ ] Correct external/nonvariational energy semantics
- [ ] Quantities, provenance, typed API, and UI inspectors
- [ ] Cross-backend convergence and managed/browser proof

Unchecked items remain implementation work.

## 7. Known limits and deferred work

Full Maxwell waves, displacement current, skin/eddy redistribution, magnetic
`mu_r` in the Oersted solve, periodic Ewald kernels, higher-order Nedelec,
exact open-boundary FEM treatments, and hybrid source projection require
separate publications and gates. An expert regime override is provenance, not
evidence that the approximation is accurate.

## 8. References

1. T. Schrefl, `docs/papers/mic_intro.pdf` (local copy, 2016).
2. *Manual for Micromagnetics Module*, `docs/comsol/Manual_for_Micromagnetics_Module.pdf` (local copy; workflow comparison only).
3. NeuralMag Oersted implementation and tests under `external_solvers/neuralmag`, used as comparative cell-integrated FFT evidence.
4. BORIS Oersted/transport sources under `external_solvers/BORIS/Boris`, used as comparative lifecycle evidence only.
5. J. R. Dormand and P. J. Prince, J. Comput. Appl. Math. 6 (1980), DOI: 10.1016/0771-050X(80)90013-3.
