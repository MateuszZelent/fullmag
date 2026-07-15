# Three-dimensional separable quasistatic microwave-antenna field basis and k-selective spin-wave excitation

- Status: proposed canonical physics and numerics contract
- Owners: Fullmag core
- Last updated: 2026-07-10
- Related ADRs:
  - `docs/adr/0004-backend-canonical-quantities.md`
  - `docs/adr/0011-resource-first-api.md`
  - `docs/adr/0017-staged-antenna-field-basis-workflow.md`
- Related specs:
  - `docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/resource-first-control-room-api-v2.md`
- Related physics notes:
  - `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
  - `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`
  - `docs/physics/0860-fdm-generalized-oersted-from-prescribed-current.md`
  - `docs/physics/0920-regional-time-domain-field-drive.md`

## 1. Problem statement

Fullmag needs two deliberately different microwave-field source families:

1. a three-dimensional conductor-backed microstrip or coplanar-waveguide
   source whose geometry determines the spatial field profile and therefore the
   wave vectors available for spin-wave excitation;
2. a MuMax-style prescribed regional magnetic field for fast FMR, pulse, and
   controlled spin-wave tests that do not claim to represent a conductor.

The conductor-backed source must support a width profile that varies along the
current-flow direction. A CPW may therefore contain a taper or a constriction
in the middle of the line. This is not representable by a translationally
invariant 2.5D cross-section. The source calculation must see the full
three-dimensional conductor geometry, current crowding, signal line, and
return-current paths.

The scientific target is not a full transient Maxwell solve. Fullmag will
calculate a spatial magnetic-field basis once and reuse it in subsequent LLG
stages:

$$
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
= \sum_p I_p(t)\,\mathbf H_{p,1\mathrm A}(\mathbf r),
$$

where $p$ identifies an independent antenna port mode. For the common
single-mode case this reduces to

$$
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
= I(t)\,\mathbf H_{1\mathrm A}(\mathbf r).
$$

This separable model is intentionally cheaper than harmonic or full-wave
electromagnetics. It captures finite three-dimensional geometry and
quasistatic current redistribution, but it does not claim microwave impedance,
propagation, or frequency-dependent current profiles.

The design is motivated by the established transduction mechanism: the
spatial Fourier spectrum of the microwave field acts as a wave-vector filter.
A CPW whose dimensions vary along its axis can make a desired wave vector
available only in a localized section, creating a spin-wave beam. The source
field spectrum and the actual magnetization response must remain separate
observables.

## 2. Model hierarchy and selected fidelity level

Fullmag uses an explicit fidelity ladder. The selected implementation target is
Tier 1.

| Tier | Public meaning | Field model | Intended use |
|---|---|---|---|
| 0 | prescribed regional field | authored spatial mask or profile multiplied by a waveform | MuMax-style excitation, FMR, controlled tests |
| 1 | separable 3D quasistatic antenna | DC/quasistatic conduction plus 3D Biot-Savart field basis normalized per ampere | tapered or constricted microstrip/CPW, k-selective time-domain LLG |
| 2 | harmonic magnetoquasistatic antenna | complex frequency-specific current and field basis | narrowband phase-aware excitation, skin/proximity studies |
| 3 | full-wave microwave antenna | frequency-domain Maxwell solve with dielectric and wave ports | impedance, S-parameters, radiation, matched-power efficiency |

Tier 1 is the production MVP because it is the least expensive model that can
respond to a three-dimensional constriction. Tier 0 remains a separate source;
it is not a fallback that may be silently substituted for Tier 1. Tiers 2 and
3 require separate capabilities and must not be inferred from a Tier 1 result.

The existing `mqs_2p5d_az` implementation is not Tier 2. Its current runner
realization samples the infinite-line Biot-Savart field of rectangular strips,
ignores finite length and the authored `center_y`, and does not solve an
$A_z$ finite-element problem. It must be treated as a compatibility
approximation and renamed in provenance to
`legacy_infinite_strip_biot_savart`; it is not exposed by the new authoring UI.

## 3. Physical model

### 3.1 Conductor domain and electric potential

Let $\Omega_c$ be the union of all conducting volumes participating in one
antenna port mode. In each conductor with scalar conductivity $\sigma(\mathbf
r)>0$, Tier 1 solves

$$
\nabla\cdot\mathbf J=0,
\qquad
\mathbf J=-\sigma\nabla V
\quad\text{in }\Omega_c.
$$

The exterior conductor boundary is insulating except on declared terminal
faces:

$$
\mathbf J\cdot\mathbf n=0
\quad\text{on }\partial\Omega_c\setminus\Gamma_{\mathrm{term}}.
$$

Terminals use an integral-current/equipotential formulation. For conductor
branch $q$, `current_weight` is signed relative to the common local $+u$
orientation from its inlet face to its outlet face. Each terminal face is
equipotential, while the current constraints for mode $p$ are

$$
\int_{\Gamma^{\mathrm{in}}_{p,q}}
\mathbf J_p\cdot\mathbf n\,dS
=-w_{p,q} I_{p,\mathrm{ref}},
\qquad
\int_{\Gamma^{\mathrm{out}}_{p,q}}
\mathbf J_p\cdot\mathbf n\,dS
=+w_{p,q} I_{p,\mathrm{ref}},
\qquad
\sum_q w_{p,q}=0.
$$

The reference current is

$$
I_{p,\mathrm{ref}}=1\ \mathrm A.
$$

The zero-sum condition is mandatory. It prevents a physically open current
source across a common transverse section and makes the signal/return
convention explicit. A negative weight reverses current relative to local
$+u$; authors do not also reverse the inlet/outlet selectors.

For a symmetric CPW mode, the initial production convention is

$$
(w_{\mathrm{signal}},w_{\mathrm{ground,left}},
w_{\mathrm{ground,right}})=(+1,-1/2,-1/2).
$$

An asymmetric design may author different weights whose sum is zero, or define
multiple independent port modes. A microstrip layout is invalid without an
explicit return conductor or return plane. The Tier 1 solver does not infer a
return current through a dielectric substrate.

Disconnected signal and ground conductors are solved as parts of the same
current mode through their own terminal face pairs and signed integral-current
constraints. The scalar-potential solves determine the distribution inside
each connected metal body; the authored port-mode weights determine how the
total source current is divided between disconnected return bodies. Automatic
RF return splitting requires a harmonic circuit/field model and belongs to
Tier 2 or 3.

### 3.2 Per-ampere normalization

For every independent mode $p$, normalize the solved current density so that

$$
\sum_{q:w_{p,q}>0}
\int_{\Gamma^{\mathrm{out}}_{p,q}}
\mathbf J_{p,1\mathrm A}\cdot\mathbf n\,dS
=1\ \mathrm A.
$$

The normalized electric potential is gauge-fixed by one terminal reference or
a mean-zero constraint on each otherwise free connected component. The
artifact records the selected gauge; voltage values are not comparable across
solutions with different gauges.

### 3.3 Magnetostatic field basis

The Tier 1 magnetic-field realization is the three-dimensional Biot-Savart
integral evaluated from the normalized volume current:

$$
\mathbf H_{p,1\mathrm A}(\mathbf r)
=\frac{1}{4\pi}
\int_{\Omega_c}
\frac{\mathbf J_{p,1\mathrm A}(\mathbf r')
\times(\mathbf r-\mathbf r')}
{\lVert\mathbf r-\mathbf r'\rVert^3}
\,dV'.
$$

For the MVP field medium,

$$
\mathbf B_{p,1\mathrm A}=\mu_0\mathbf H_{p,1\mathrm A}.
$$

This equation computes the imposed free-current field in a nonmagnetic
background. It does not solve magnetic-material backreaction, eddy currents in
the ferromagnet, or frequency-dependent permeability. Those effects require a
later magnetoquasistatic or full-wave realization.

Near-source evaluation requires singular or near-singular quadrature. A simple
centroid sum with equivalent-sphere regularization is retained only as a
reference/debug oracle. Production Tier 1 must use element-aware adaptive
quadrature or an analytically integrated near-field rule and must expose the
near-field error/convergence evidence.

### 3.4 Time-domain LLG coupling

The antenna contribution enters the effective field additively:

$$
\mathbf H_{\mathrm{eff}}
=\mathbf H_{\mathrm{ex}}
+\mathbf H_{\mathrm{demag}}
+\mathbf H_{\mathrm{ext}}
+\mathbf H_{\mathrm{ant}}
+\cdots.
$$

For port mode $p$ with scalar waveform $f_p(t)$ and peak/reference current
$I_{p,0}$,

$$
I_p(t)=I_{p,0}f_p(t),
$$

and therefore

$$
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
=\sum_p I_{p,0}f_p(t)\mathbf H_{p,1\mathrm A}(\mathbf r).
$$

The Zeeman energy contribution is

$$
E_{\mathrm{ant}}(t)
=-\mu_0\int_{\Omega_m}
M_s(\mathbf r)\mathbf m(\mathbf r,t)
\cdot\mathbf H_{\mathrm{ant}}(\mathbf r,t)\,dV.
$$

The field basis is independent of magnetization and may be solved before
relaxation. The component that efficiently drives small oscillations around an
equilibrium $\hat{\mathbf m}_0$ is derived after an equilibrium exists:

$$
\mathbf h_\perp(\mathbf r)
=\mathbf H_{\mathrm{ant}}(\mathbf r)
-(\mathbf H_{\mathrm{ant}}(\mathbf r)\cdot
\hat{\mathbf m}_0(\mathbf r))\hat{\mathbf m}_0(\mathbf r).
$$

The LLG solver receives the full vector field, not $\lVert\mathbf H\rVert$ and
not only $\mathbf h_\perp$. The transverse field is a derived analysis and
visualization product.

### 3.5 Supported time dependences

The separable field basis can be multiplied by any canonical, serializable
`TimeDependenceIR` supported by the selected LLG lane:

- constant;
- sinusoidal;
- rectangular pulse;
- piecewise-linear sampled waveform;
- normalized sinc pulse.

Raw Python callbacks are not part of the public model because they cannot
round-trip through `ProblemIR`, UI authoring, or device execution. A future
restricted expression language requires one shared parser and evaluator
contract across Python, Rust, CPU, GPU, and script export.

### 3.6 Separability and validity limits

Tier 1 assumes

$$
\mathbf H(\mathbf r,\omega)
\approx a(\omega)\mathbf H_0(\mathbf r)
$$

over the waveform bandwidth. It is valid only when the normalized spatial
current profile is effectively frequency independent.

The approximation excludes:

1. frequency-dependent skin and proximity effects;
2. capacitive/displacement-current return paths;
3. transmission-line propagation, standing waves, reflections, and radiation;
4. port impedance and S-parameters;
5. frequency-dependent relative phase between field components;
6. absolute conversion from dBm or delivered microwave power to current;
7. induced detector voltage and electrical-to-magnon efficiency;
8. feedback of magnetization dynamics onto the conductor field.

The solve and UI publish two advisory validity ratios at the declared maximum
waveform frequency $f_{\max}$:

$$
\eta_{\mathrm{wave}}=\frac{L_{\max}f_{\max}}{c},
\qquad
\eta_{\mathrm{skin}}=\frac{t_{\max}}{\delta(f_{\max})},
$$

with

$$
\delta(f)=\sqrt{\frac{2}{2\pi f\mu\sigma}}.
$$

If either ratio is at least $0.1$, Fullmag emits
`separable_field_basis_validity_warning`. This threshold is an engineering
warning, not a proof that results below it are exact and not an automatic
rejection above it. A sinc pulse uses its declared cutoff as $f_{\max}$; a
piecewise-linear drive must provide `declared_bandwidth_hz` for this diagnostic
or report `validity_bandwidth_unknown`.

## 4. Geometry contract

### 4.1 Local frame and transform

The MVP antenna layout is planar and straight in its local frame:

- local $u$: direction of current flow and profile stations;
- local $v$: transverse width direction;
- local $w$: conductor-thickness direction.

A rigid scene transform positions and rotates the entire layout in 3D. Curved
centerlines and arbitrary swept paths are deferred. This keeps the first
geometry realization focused while still supporting a constriction anywhere
along a straight microstrip or CPW.

### 4.2 Width stations

The width profile is a piecewise-linear loft between ordered stations. Each
station uses a normalized coordinate $s\in[0,1]$ along local $u$.

Microstrip station:

```text
{ s, signal_width_m }
```

CPW station:

```text
{
  s,
  signal_width_m,
  left_gap_m,
  right_gap_m,
  left_ground_width_m,
  right_ground_width_m
}
```

Rules:

1. station coordinates are finite, strictly increasing, and include $0$ and
   $1$;
2. every width and gap is positive;
3. conductor thickness is positive and constant for the MVP;
4. lofted signal and ground volumes may not self-intersect;
5. terminal end sections must have nonzero face area;
6. a named constriction is authored as at least two stations around a narrower
   section, not as a visual-only annotation;
7. geometry validation reports the minimum width, minimum gap, taper slope,
   and any meshing-size requirement implied by them.

### 4.3 Return paths

A CPW layout includes the signal conductor and both ground conductors. A
microstrip layout includes the signal strip plus an explicit return conductor
or plane geometry. The return path is part of the physical source and the
field-basis hash. Omitting it is a validation error for Tier 1.

The dielectric substrate may be present as scene geometry for placement and
future Tier 3 work, but it does not affect the Tier 1 conduction/Biot-Savart
solution and provenance states this explicitly.

## 5. k-selective excitation products

### 5.1 Source spectrum

For a chosen analysis plane and equilibrium magnetization, the source
wave-vector weighting is computed from the vector transverse field:

$$
\widetilde{\mathbf h}_\perp(\mathbf k)
=\mathcal F_{\mathbf r}
\left[w(\mathbf r)\mathbf h_\perp(\mathbf r)\right],
$$

$$
W_H(\mathbf k)
=\sum_{a\in\{x,y,z\}}
\left|\widetilde h_{\perp,a}(\mathbf k)\right|^2.
$$

The analysis artifact records the coordinate frame, sampled plane or volume,
window, spatial resolution, normalization, and whether components were
combined or inspected separately. Fourier transforming the scalar magnitude
$\lVert\mathbf H\rVert$ before LLG is forbidden because it discards sign,
polarization, and component information.

### 5.2 Local spectrum for a constricted antenna

For a layout whose profile changes along local $u$, a global FFT hides where a
wave vector is available. Fullmag therefore defines an optional windowed local
spectrum

$$
W_H(u_0,k_v)
=\sum_a
\left|
\int h_{\perp,a}(u,v)g(u-u_0)e^{-ik_vv}\,du\,dv
\right|^2,
$$

where $g$ is a declared spatial window. This `local_k_spectrum` product is the
primary diagnostic for a CPW constriction. It shows whether a target $k_v$ is
present only in the narrowed section.

For an idealized four-edge-current CPW, the first characteristic maximum and
zero scale approximately as

$$
k_{\max}\approx\frac{\pi}{w+s},
\qquad
k_{\mathrm{zero}}\approx\frac{2\pi}{w+s},
$$

where $w+s$ denotes the relevant signal-plus-gap scale of that approximation.
These expressions are validation trends, not substitutes for the computed
three-dimensional field.

### 5.3 Magnetization response

The actual excited spin-wave response is a different product:

$$
S_m(\mathbf k,\omega)
=\left\lVert
\mathcal F_{\mathbf r,t}
[\mathbf m(\mathbf r,t)-\mathbf m_0(\mathbf r)]
\right\rVert^2.
$$

`source_k_spectrum` answers which wave vectors are supplied by the antenna.
`dynamic_structure_factor` answers which magnetization waves were actually
excited and propagated. The UI and artifacts must not label the first as the
second.

For an available normalized eigenmode $\mathbf m_n$, an optional later product
is the overlap

$$
C_n=
\frac{
\left|\int_{\Omega_m}\mathbf h_\perp\cdot\mathbf m_n^*\,dV\right|^2
}{
\int_{\Omega_m}|\mathbf h_\perp|^2dV
\int_{\Omega_m}|\mathbf m_n|^2dV
}.
$$

Mode overlap is deferred until the modal field normalization and spatial
transfer contracts are validated.

## 6. Numerical interpretation

### 6.1 Solver ownership

The first production field solve belongs to `backends/fem` even when the
downstream LLG discretization is FDM. This is explicit cross-discretization
state transfer with provenance, not a hidden hybrid solver.

The initial production lane is:

```text
FEM CPU / MFEM H1 conduction
  -> normalized volume current J_1A
  -> CPU adaptive 3D Biot-Savart target evaluation
  -> field-basis artifact
  -> projection to FDM cells and/or FEM nodes
```

GPU field-solve acceleration is deferred. GPU consumption of an already solved
basis is a separate capability and may arrive earlier.

### 6.2 Conductor mesh

The conductor mesh is independent from the magnetic solver mesh. It must:

1. conform to all conductor boundaries and terminal faces;
2. refine the minimum constriction width, ground gap, thickness, and taper;
3. retain stable conductor-body and terminal marker identities;
4. record element order, size policy, quality metrics, and mesh hash;
5. pass a current-conservation convergence study before the field basis is
   promoted beyond reference status.

The initial solve uses P1/H1 potential on tetrahedra. Higher order is deferred
until the P1 validation suite is complete.

### 6.3 Field sampling domains

Tier 1 produces three related but distinct spatial representations:

1. `conductor_domain`: $V$ and $\mathbf J$ on the conductor mesh;
2. `field_sampling_domain`: $\mathbf H_{p,1\mathrm A}$ on a user-selected
   regular lattice or explicit point cloud covering conductor, air, and
   magnetic regions for heatmaps and line cuts;
3. `target_projection`: $\mathbf H_{p,1\mathrm A}$ sampled on one concrete
   magnetic runtime topology.

The field sampling domain must not be truncated to the ferromagnet. Its purpose
is to show range and decay in air. The target projection is the buffer used by
LLG and is separately invalidated when the magnetic mesh/grid changes.

### 6.4 FDM consumption

For FDM, evaluate or transfer the basis at active magnetic cell centers. The
reference CPU lane stores double-precision cell-centered vectors and is the
oracle for waveform composition. The production CUDA lane uploads each active
port-mode basis once, keeps it resident, evaluates the canonical waveform, and
adds the scaled vector to `H_eff` during every RHS evaluation.

Topology identity, cell ordering, active mask, precision, and projection method
are part of the target-projection signature. A basis for one grid may not be
reused on another grid merely because point counts match.

### 6.5 FEM consumption

For FEM P1 time evolution, the MVP projection is a nodal vector coefficient
with explicit `sampling=node_lumped`. A later $L^2$ projection or
quadrature-owned coefficient may be added for high-order or sharp field
variation, but it must have a distinct realization identifier and parity test.

CPU and GPU FEM implementations consume the same backend-neutral field-basis
contract through separate MFEM/hypre/libCEED runtime realizations. The field
must remain backend-resident between steps; host readback occurs only for
requested outputs or diagnostics.

### 6.6 Error metrics

Every accepted solve records at least:

- normalized residual of the conduction equation;
- per-terminal requested and realized current;
- net current imbalance;
- elementwise or sampled $\lVert\nabla\cdot\mathbf J\rVert$ diagnostic;
- conductor-mesh convergence level;
- near-field quadrature tolerance and refinement count;
- minimum distance between field samples and conductor elements;
- target-projection method and topology identity;
- finite-value and maximum-field checks.

The default acceptance gate requires finite fields, solver convergence, and a
relative net current imbalance no greater than $10^{-8}$ for double-precision
CPU reference fixtures. Production tolerances for large models may be relaxed
only by a documented workload-specific validation gate and must remain visible
in provenance.

## 7. Runtime stage and artifact contract

### 7.1 Stage graph

The source solve is a first-class study stage:

```text
AntennaFieldSolve
  -> optional Relaxation
  -> TimeEvolution using SolvedAntennaDrive
  -> SpinWaveResponseAnalysis
```

`AntennaFieldSolve` may run before relaxation because it does not depend on
$\mathbf m$. A derived $\mathbf h_\perp$ or source k-spectrum that references
$\mathbf m_0$ runs only after the equilibrium artifact is available.

Downstream execution rejects a missing, failed, incompatible, or stale field
basis. It must not start a hidden solve inside an LLG RHS call.

### 7.2 Field-solution artifact

The canonical artifact family is `antenna_field_solution.v1`. Its manifest
contains:

- solution id, source id, stage id, and creation time;
- authored conductor layout and rigid transform;
- conductor material and conductivity;
- port modes, terminal selectors, weights, and 1 A normalization;
- conductor mesh identity, statistics, and hash;
- requested and resolved solver/backend/device/precision;
- gauge policy and linear-solver policy;
- $V_{p,1\mathrm A}$ and $\mathbf J_{p,1\mathrm A}$ field references;
- $\mathbf H_{p,1\mathrm A}$ field-sampling references;
- target-projection references;
- convergence, current-balance, and quadrature diagnostics;
- Tier 1 assumptions and validity ratios;
- content signatures and dependency revisions.

The manifest references heavy binary payloads instead of embedding arrays in
JSON.

### 7.3 Staleness signatures

Staleness is split into three signatures:

1. `current_solution_signature`: conductor layout, transform, conductivity,
   ports, conductor mesh, gauge, and conduction solver;
2. `field_solution_signature`: current solution plus Biot-Savart realization,
   quadrature policy, and field-sampling domain;
3. `target_projection_signature`: field solution plus target topology,
   ordering, scope, and projection method.

Changing a waveform or peak current invalidates none of these signatures.
Changing equilibrium magnetization invalidates only derived
`h_perp`/source-spectrum products. Changing geometry, conductivity, terminal
faces, or return weights invalidates all downstream signatures.

### 7.4 Quantities and units

The accepted quantity identities remain:

| Quantity/resource | Unit | Domain | Meaning |
|---|---|---|---|
| `H_ant` | A/m | full field or magnetic target | instantaneous summed antenna field |
| `H_ant_basis` | A/m/A | field sampling or target | one port-mode field per ampere |
| `J_charge` | A/m^2 | conductor mesh | solved charge-current density |
| `V_electric` | V | conductor mesh | gauge-dependent electric potential |
| `h_perp` | A/m | magnetic target | field component transverse to an equilibrium |

`H_ant` is frozen by ADR 0004 and must not be renamed or overloaded as
`B_ext`. The UI may display the derived quantity $\mu_0\mathbf H_{\mathrm{ant}}$
in T or mT through a unit transform. That display transform does not change the
canonical stored field or imply magnetic-material polarization.

## 8. Public Python, ProblemIR, and planner impact

### 8.1 Python authoring target

The canonical Python shape separates layout, field solve, and drive:

```python
cpw = fm.CPWAntenna(
    name="cpw_constriction",
    length=12e-6,
    thickness=120e-9,
    conductivity=5.8e7,
    stations=[
        fm.CPWStation(s=0.0, signal_width=2.0e-6, gap=1.0e-6, ground_width=4.0e-6),
        fm.CPWStation(s=0.40, signal_width=2.0e-6, gap=1.0e-6, ground_width=4.0e-6),
        fm.CPWStation(s=0.46, signal_width=260e-9, gap=95e-9, ground_width=1.2e-6),
        fm.CPWStation(s=0.54, signal_width=260e-9, gap=95e-9, ground_width=1.2e-6),
        fm.CPWStation(s=0.60, signal_width=2.0e-6, gap=1.0e-6, ground_width=4.0e-6),
        fm.CPWStation(s=1.0, signal_width=2.0e-6, gap=1.0e-6, ground_width=4.0e-6),
    ],
    transform=fm.Transform(translation=(0.0, 0.0, 150e-9)),
)

cpw_mode = fm.AntennaPortMode.symmetric_cpw(
    name="drive_mode",
    signal="signal",
    grounds=("ground_left", "ground_right"),
)

field_solution = fm.AntennaFieldSolve(
    name="solve_cpw_field",
    antenna=cpw,
    port_modes=(cpw_mode,),
    model="quasistatic_conduction_biot_savart_3d",
    field_sampling=fm.FieldSamplingBox(
        size=(16e-6, 10e-6, 3e-6),
        spacing=(40e-9, 40e-9, 20e-9),
    ),
    target_objects=("yig_waveguide",),
)

drive = fm.SolvedAntennaDrive(
    name="cpw_sinc_drive",
    solution=field_solution,
    port_mode="drive_mode",
    peak_current=10e-3,
    waveform=fm.SincPulse(cutoff_hz=25e9, t0=100e-12),
    time_origin="stage_local",
)
```

The existing constant-width `MicrostripAntenna` and `CPWAntenna` constructors
remain deserializable. They lower to two endpoint stations with constant
parameters. Existing `AntennaFieldSource(model="prescribed_zeeman_mask")`
round-trips through a compatibility adapter to the separate regional-drive
contract described by note 0920.

### 8.2 ProblemIR target

The canonical IR adds explicit types instead of adding more optional fields to
the current conflated `AntennaFieldSource` variant:

```text
AntennaLayoutIR
  id
  kind = microstrip | cpw
  length_m
  thickness_m
  local_frame
  transform
  stations
  conductor_parts
  conductivity_s_per_m

AntennaPortModeIR
  id
  terminal_groups[]
  current_weights[]
  normalization_current_a = 1

StudyIR::AntennaFieldSolve
  antenna_ref
  port_modes[]
  model = quasistatic_conduction_biot_savart_3d
  conductor_mesh_policy
  field_sampling_domain
  target_refs[]
  solver_policy

SolvedAntennaDriveIR
  name
  solution_ref = { stage_id, output_id }
  port_mode
  peak_current_a
  waveform
  time_origin

RegionalFieldDriveIR
  name
  region_ref
  amplitude_B_T
  direction
  spatial_profile
  waveform
  time_origin
```

The existing `StudyPipelineDocument` primitive node owns `stage_id` and stage
ordering. `ProblemIR` retains one singular `study: StudyIR` for the currently
lowered primitive stage. A downstream stage-output reference is resolved to a
concrete solution manifest id and content hash before backend execution.

Shared IR describes physical intent. MFEM spaces, CUDA buffer layouts,
quadrature work arrays, and artifact file paths remain plan/runtime details.

### 8.3 Validation and normalization

Validation requires:

1. globally unique layout, port-mode, stage, solution-output, and drive ids;
2. monotone complete station profiles;
3. positive geometry and conductivity parameters;
4. valid terminal selectors on conductor boundary faces;
5. signed port weights summing to zero;
6. explicit return conductors;
7. one or more target objects for LLG coupling;
8. a solved-drive reference to an earlier compatible field-solve stage;
9. finite peak currents and canonical waveform parameters;
10. an explicit time-origin policy.

Normalization converts convenience symmetric CPW definitions to explicit
terminal weights and converts constant-width layouts to endpoint stations.
Normalization must not invent a missing microstrip return plane.

### 8.4 Planner and execution selection

The field-solve stage and the downstream LLG stage have separate requested and
resolved execution records. An FDM LLG request may resolve its antenna
precomputation to FEM CPU only when that cross-discretization state transfer is
explicit in the plan and provenance.

Initial capability target:

| Capability | FDM CPU reference | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| Tier 1 field solve | consumes artifact only | consumes artifact only | reference then production solve | unsupported initially |
| Tier 1 drive consumption | reference oracle | after double parity | production | after double parity |
| Tier 0 regional drive | current partial reference | deferred until implemented | deferred until native implementation | deferred until native implementation |
| local source k-spectrum | backend-neutral artifact analysis | same artifact | backend-neutral artifact analysis | same artifact |

Forced unsupported lanes fail clearly. `auto` may resolve the Tier 1 field solve
to FEM CPU, but it preserves both requested downstream discretization and
resolved precompute lane.

## 9. Runtime, OpenAPI, and unified workspace impact

The exact resource and module contract is specified in
`docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`.
Physics-level obligations are:

1. `AntennaFieldSolve` appears as a real stage in
   `simulation/stages/execution`;
2. field solutions are named, revisioned resources, not hidden runner cache;
3. heavy $V$, $\mathbf J$, and $\mathbf H$ payloads use the binary data plane;
4. standard field slice/projection resources visualize the field on either the
   field-sampling domain or a magnetic target projection;
5. the UI exposes exact stale reasons and requested/resolved execution;
6. HTTP v2 remains authoritative and websocket events only invalidate changed
   resources;
7. one unified Explorer, ribbon, inspector, and viewport tree serves FDM and
   FEM;
8. the 3D viewport shows procedural layout intent before meshing and realized
   conductor topology after solve;
9. an active-only `field-map` center surface owns interactive heatmaps,
   contours, probes, and slices without keeping the 3D WebGL canvas mounted;
10. source k-spectrum and dynamic structure factor are labeled as distinct
    analysis products.

## 10. Validation strategy

### 10.1 Analytical current and field checks

1. Uniform straight bar: $V$ is linear along the bar and integrated current is
   constant across transverse cuts.
2. Infinite-wire far field: $H_\varphi\to I/(2\pi r)$ away from a sufficiently
   long finite fixture.
3. Rectangular strip symmetry: field components have the expected parity about
   conductor center planes.
4. CPW balance: signal and ground terminal currents sum to zero and the far
   field decays faster than an unbalanced single conductor.
5. Linearity: doubling the authored current doubles `H_ant` and Zeeman drive
   while leaving the stored per-ampere basis unchanged.

### 10.2 Mesh and quadrature convergence

Run at least three conductor-mesh levels. Track:

- terminal current imbalance;
- $L^2$ change in $\mathbf J$ away from geometric corners;
- $L^2$ and $L^\infty$ changes in $\mathbf H$ on fixed observation surfaces;
- convergence of source-spectrum peak locations;
- sensitivity to near-field quadrature tolerance.

Corner-current density may be singular in the ideal sharp-edge model. Pointwise
$\mathbf J$ at a sharp corner is not a convergence target; integrated current,
field away from the corner, and spectrum peaks are.

### 10.3 Cross-lane checks

1. FDM CPU and FEM CPU consume the same field artifact at matched physical
   points and agree within interpolation error.
2. FDM GPU matches FDM CPU in double precision for static `H_ant`, waveform
   samples, and a short LLG trajectory.
3. FEM GPU matches FEM CPU for the same quantities before promotion.
4. Artifact reload produces the same field hash and LLG result as an in-memory
   solution.
5. Changing only the waveform reuses the solution; changing one geometry
   station makes it stale.

### 10.4 Spin-wave benchmark

The publication-aligned benchmark uses a thin YIG waveguide and two CPW
profiles whose wide and constricted sections place a chosen $k$ near a source
spectrum minimum and maximum respectively. Acceptance evidence includes:

- `local_k_spectrum` localizing the selected $k$ to the constriction;
- a time-domain $S_m(k,\omega)$ ridge compatible with an independently
  calculated dispersion;
- a beam or localized source region in the dynamic magnetization map;
- correct qualitative changes when width/gap stations are varied;
- explicit statement that propagation length is not validated from a fixture
  using artificially reduced damping.

The primary literature targets are Gruszecki et al. for localized CPW beam
excitation and Höfinger et al. for realistic vector-field k weighting. Absolute
transduction efficiency is not an acceptance metric for Tier 1.

### 10.5 UI and API checks

1. CPW stations round-trip Python -> ProblemIR -> scene -> exported Python.
2. Geometry, terminal, and field-solve edits invalidate only their documented
   signatures; waveform edits do not stale the field solve.
3. Slice/projection resources work for the field-sampling domain and FDM/FEM
   target projections with ETag/304 behavior.
4. The heatmap displays component, magnitude, $\mu_0H$ unit transform,
   contours, probe, and empty-mask status correctly.
5. Explorer selection maps every antenna child node to a dedicated Inspector.
6. `field-map` and `viewport-3d` obey active-only lifecycle and bounded-memory
   tests.
7. Browser smoke proves a visible 3D canvas with a live WebGL context when 3D
   is active and no 3D canvas when `field-map` is active.

## 11. Implementation status and completeness checklist

This note is implementation-ready as a physics contract. It does not claim the
new Tier 1 path is implemented.

- [x] physical problem and fidelity decision
- [x] governing equations and SI units
- [x] validity limits and prohibited claims
- [x] variable-width microstrip/CPW geometry semantics
- [x] return-current and port-mode semantics
- [x] per-ampere normalization
- [x] FDM interpretation
- [x] FEM interpretation
- [x] CPU/GPU separation
- [x] source-spectrum and dynamic-response distinction
- [x] Python and ProblemIR target
- [x] planner and runtime-stage impact
- [x] artifacts, quantities, provenance, API, and UI impact
- [x] validation strategy
- [ ] Python/ProblemIR implementation
- [ ] native FEM CPU field solver
- [ ] FDM/FEM field-basis consumers
- [ ] GPU parity
- [ ] OpenAPI and control-room implementation
- [ ] publication benchmark artifacts

## 12. Deferred work

1. Harmonic complex MQS bases and multi-frequency interpolation.
2. Full-wave Maxwell ports, substrate permittivity, impedance, S-parameters,
   radiation, and dBm normalization.
3. Magnetic-material feedback and eddy currents in the ferromagnet.
4. Curved and arbitrary swept antenna centerlines.
5. Automatic circuit-derived split of disconnected ground returns.
6. High-order conductor FEM and $H(\mathrm{curl})$ magnetic-field solve.
7. Fast multipole or hierarchical acceleration for very large source/target
   evaluations.
8. Validated mode-overlap analysis and inductive detector-voltage prediction.

## 13. References

1. A. Höfinger et al., “k-Selective Electrical-to-Magnon Transduction with
   Realistic Field-distributed Nanoantennas,” arXiv:2511.10346 (2025),
   https://arxiv.org/abs/2511.10346, journal DOI:
   https://doi.org/10.1002/apxr.202500211.
2. P. Gruszecki et al., “Microwave excitation of spin wave beams in thin
   ferromagnetic films,” Scientific Reports 6, 22367 (2016),
   https://doi.org/10.1038/srep22367.
3. L. Fallarino et al., “Propagation of Spin Waves Excited in a Permalloy Film
   by a Finite-Ground Coplanar Waveguide,” IEEE Transactions on Magnetics 49,
   1033-1036 (2013), https://doi.org/10.1109/TMAG.2012.2229385.
4. X. Zhang et al., “Antenna design for propagating spin wave spectroscopy in
   ferromagnetic thin films,” Journal of Magnetism and Magnetic Materials 450,
   24-28 (2018), https://doi.org/10.1016/j.jmmm.2017.04.048.
