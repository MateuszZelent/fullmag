---
title: Spin-orbit torque
description: Local damping-like and field-like spin-orbit torque with prescribed signed current or a named vector-current source.
status: partial
doc_kind: reference
---

(public-docs-physics-interactions-sot)=
# Spin-orbit torque

(physics-spin-orbit-torque-problem-statement)=
## Physical problem

`PrescribedSpinOrbitTorque` adds a local damping-like (DL) and field-like (FL)
source to the magnetization equation. It does **not** solve charge accumulation,
spin accumulation, spin diffusion, or an HM/FM interface problem. The authored
efficiencies already represent all conversion and transmission physics that the
model omits.

Use the tabs below to choose the correct model before assigning parameters.

::::{tab-set}
:::{tab-item} Prescribed local SOT

Use `PrescribedSpinOrbitTorque` when the signed current density, spin-polarization
axis, and effective DL/FL efficiencies are known inputs. The heavy-metal layer
does not need to be meshed. Runtime cost is that of a local LLG source.

This is the Fullmag counterpart of a MuMax-style `EnableSOT` model: `J` maps to
the signed drive, `Pol` to `sigma`, `ThetaSH` to `xi_dl`, `ThetaFL` to `xi_fl`,
and `FreeLayerThickness` to `free_layer_thickness_m`. The mapping is a parameter
mapping, not a claim that `xi_dl` equals a bulk spin Hall angle in a real stack.

:::
:::{tab-item} Solved SHE transport

Use the transport model when the torque must follow from material conductivities,
spin Hall angle, spin-relaxation lengths, boundary conditions, and HM/FM mixing
conductance. Fullmag then resolves

```text
CurrentTransport -> SpinDriftDiffusion -> interface absorption -> DriftDiffusionSpinTorque
```

That route produces a generally nonuniform torque and can include backflow and
finite-transparency effects. It is documented separately in
{doc}`Spin Hall drift-diffusion transport </physics/interactions/drift-diffusion-spin-torque/index>`.
Do not add `PrescribedSpinOrbitTorque` on top of the solved transport torque
unless the two sources intentionally represent different physics.

:::
::::

| Question | Prescribed local SOT | Solved SHE transport |
| --- | --- | --- |
| Primary input | signed current and effective `xi_dl`, `xi_fl` | material and interface transport parameters |
| Charge/spin PDE | none | solved |
| HM mesh | optional and not consumed by this torque | part of the transport domain |
| Spatial variation | target mask, material fields, and current-source projection | transport solution and interface absorption |
| Best use | calibrated reduced model, switching scans, MuMax comparison | stack design and spatial spin-transport studies |

(physics-spin-orbit-torque-prescribed-comparison)=
## Prescribed SOT comparison: local SOT, M1, and M2

`PrescribedSpinOrbitTorque`, M1, and M2 can all add a spin torque to the same
magnetization equation, but they do **not** represent the same physical problem.
The distinction is the location at which the model starts:

```text
Prescribed SOT: authored J, sigma, xi_DL, xi_FL, t_F -> local LLG source

M1: electrodes/materials -> charge solve -> spin solve -> interface absorption -> LLG source

M2: electrodes/materials <-> reciprocal charge-spin block
                              -> interface absorption -> LLG source
```

The prescribed model starts at the final, reduced torque law. M1 starts at
charge transport and computes the spin distribution without feeding spin back
into the charge solution. M2 solves a reciprocal charge-spin problem in which
the spin state can modify the charge response. Therefore `xi_dl=theta_sh` does
not, by itself, make a prescribed-SOT simulation equivalent to M1 or M2.

### Meaning of M1 and M2 in Fullmag

These names describe coupling levels of the drift-diffusion model, not two
formula variants of `PrescribedSpinOrbitTorque`.

**M1: one-way solved transport.** `CurrentTransport(coupling="one_way")`
produces the charge-current field first. `SpinDriftDiffusion` then consumes that
named current source, evaluates direct spin Hall injection, diffusion and active
spin reactions, and supplies absorbed interface spin flux to
`DriftDiffusionSpinTorque`. The spin solution does not alter the already solved
charge field.

**M2: reciprocal solved transport.**
`CurrentTransport(coupling="bidirectional")` selects the reciprocal
constitutive contract. Charge and spin belong to one coupled steady problem;
the charge block includes the authored magnetoresistive conductivities and the
spin block can return an inverse-spin-Hall contribution. In the public Python
contract, bidirectional current transport requires `model="ohmic_poisson"`,
complete anisotropic conductivity data, and a `block_gmres` charge policy.
`SpinDriftDiffusion.to_ir()` records
`transport_constitutive.reciprocal.fullmag.v1` instead of the M1
`transport_constitutive.one_way.fullmag.v1` contract.

**Prescribed SOT: no transport solve.** The module directly evaluates a local
DL/FL source from a signed current, a polarization axis, two effective
efficiencies and the physical FM thickness. It does not create charge
potential, spin potential, spin current, interface backflow, or inverse-SHE
observables.

### Side-by-side physical comparison

| Property | Prescribed SOT | M1: one-way transport | M2: reciprocal transport |
| --- | --- | --- | --- |
| Model entry point | effective local torque law | charge boundary-value problem | coupled charge-spin boundary-value problem |
| Charge potential and current | not solved by `SignedScalarDrive`; optional named current projection with `VectorCurrentDrive` | solved before spin | solved inside the reciprocal block |
| Spin accumulation | not a state variable | solved in the transport domain | solved and coupled back to charge |
| Direct SHE | absorbed into fitted `xi_dl`/`xi_fl` | generated from local `theta_sh` and charge current | generated from local `theta_sh` and coupled charge current |
| Inverse SHE | absent | absent from charge feedback | included by the reciprocal constitutive contract |
| AMR/PHE/AHE charge response | absent from the torque module | not part of one-way spin feedback | authored through parallel, perpendicular and AHE conductivities |
| Spin diffusion and relaxation | absent | resolved from `sigma_s_Spm`, `lambda_sf_m`, and enabled magnetic lengths | resolved in the reciprocal block |
| HM/FM interface | not required by the module | explicit transparent or mixing-conductance interface | explicit interface in the coupled transport graph |
| Interface transparency and backflow | folded into effective efficiencies | computed from interface and bulk transport data | computed while charge and spin are mutually coupled |
| Torque source | local DL/FL formula | absorbed transverse interface spin flux | absorbed transverse interface spin flux |
| Spatial nonuniformity | target mask, local magnetic fields, envelope, and optional current projection | charge crowding, diffusion, reactions, boundaries, geometry, and interface absorption | all M1 mechanisms plus reciprocal charge-spin redistribution |
| Required nonmagnetic mesh | none for the torque itself | yes, for every active transport region | yes, for every active transport region |
| Main fitted quantities | effective `xi_dl`, `xi_fl` | bulk and interface transport parameters | bulk, interface, magnetoresistive, and reciprocal transport parameters |
| Typical computational cost | local per magnetic degree of freedom | charge solve plus spin solve | coupled nonlinear/block solve; normally the most expensive of the three |
| Natural observables | magnetization and prescribed torque | potential, charge current, spin state, absorbed flux, and torque | M1 observables plus reciprocal charge response |
| Appropriate use | calibrated reduced switching/dynamics model | spatial SHE transport without feedback to charge | reciprocal device transport where spin modifies charge |

The table compares physics only. Executable discretization, device, precision,
solver, and interface support are lane-specific and fail closed. Consult the
{doc}`drift-diffusion transport page </physics/interactions/drift-diffusion-spin-torque/index>`
before selecting an M1 or M2 backend.

### What prescribed SOT removes

The reduction replaces the solved transport chain with effective coefficients:

```text
bulk charge conversion
+ spin diffusion and relaxation
+ interface transmission and backflow
+ unresolved stack losses
                         -> xi_DL and xi_FL
```

This replacement is useful only when those coefficients are known for the
stack, temperature, thickness range and sign convention being simulated. It
also changes what can be predicted. Prescribed SOT can answer how a magnetic
body responds to an assumed torque efficiency. It cannot predict how changing
HM conductivity, HM thickness, spin-diffusion length, interface mixing
conductance or electrode geometry changes that efficiency. M1 or M2 is needed
for those questions.

There is generally no unique parameter-by-parameter conversion from M1/M2 to
prescribed SOT. An effective `xi_dl` may be extracted by matching an integrated
or averaged damping-like torque for one operating point. An effective `xi_fl`
may be fitted in the same way. The resulting pair need not reproduce local
hotspots, edge accumulation, thickness dependence, current crowding, backflow,
or a different magnetic state.

### When the models may agree

Prescribed SOT can approximate M1 or M2 when all of the following are justified:

- the FM is thin enough that a volume-averaged torque is meaningful;
- the in-plane current and injected spin polarization are approximately uniform;
- transport relaxes much faster than the magnetic dynamics of interest;
- interface and bulk losses can be represented by fixed effective efficiencies;
- reciprocal modification of the charge path is negligible, or already folded
  into a calibration performed at the same operating point;
- the observable depends on the integrated torque rather than its local profile.

Agreement should be demonstrated against a declared observable, not assumed
from similar-looking trajectories. Useful calibration targets include the
volume-integrated DL/FL torque, initial angular acceleration, switching
threshold, or a selected harmonic response. A coefficient fitted to one target
is not automatically validated for the others.

### When M1 or M2 is required

Choose **M1** when spatial charge and spin transport matters but one-way
charge-to-spin coupling is an acceptable approximation. Typical reasons are
current crowding, finite spin-diffusion length, multilayer spin absorption,
mixing-conductance interfaces, nonuniform torque, or a geometry in which a
single authored `sigma` is insufficient.

Choose **M2** when the reciprocal charge response is itself part of the physics
or observable. Examples include inverse-SHE voltage/current, simultaneous
AMR/PHE/AHE transport, or a device state in which magnetization-dependent charge
redistribution materially changes spin injection. M2 is not automatically
"more accurate": it is a larger constitutive model requiring additional
parameters, boundary data, solver policy, and validation.

Choose **prescribed SOT** when the scientific input is already an effective
torque efficiency, when reproducing a MuMax-style local SOT experiment, or when
large parameter scans would make a solved transport domain unnecessary. Do not
use it merely to avoid supplying unknown transport data while still claiming
predictions about that missing transport physics.

### Python authoring: the decisive differences

The following fragments show the model-selection fields. They are deliberately
short; complete M1 and M2 examples, including materials, interfaces, electrodes
and solver restrictions, are maintained on the drift-diffusion page.

::::{tab-set}
:::{tab-item} Prescribed SOT

```python
study.spin_torque(fm.PrescribedSpinOrbitTorque(
    name="local_sot",
    target=fm.RegionRef("fm"),
    drive=fm.SignedScalarDrive(
        current_density_Apm2=1.0e11,
        sigma=(0.0, 1.0, 0.0),
    ),
    xi_dl=0.12,
    xi_fl=0.01,
    free_layer_thickness_m=1.0e-9,
))
```

No `CurrentTransport`, `SpinDriftDiffusion`, transport material, interface, or
spin boundary is consumed by this module.

:::
:::{tab-item} M1 one-way

```python
charge = study.current_transport(
    name="charge",
    model="ohmic_poisson",
    coupling="one_way",
    # domain, materials, boundaries, gauge, solver
)
spin = study.spin_transport(fm.SpinDriftDiffusion(
    id="spin",
    current_source_id=charge.name,
    # domain, materials, interfaces, boundaries, solver
))
study.spin_torque(fm.DriftDiffusionSpinTorque(
    id="transport_torque",
    solve_id=spin.id,
    target=fm.RegionRef("fm"),
))
```

The dependency direction is `charge -> spin -> torque`; no spin-to-charge edge
is authored.

:::
:::{tab-item} M2 reciprocal

```python
charge = study.current_transport(
    name="charge",
    model="ohmic_poisson",
    coupling="bidirectional",
    # complete anisotropic materials and block_gmres policy
)
spin = study.spin_transport(fm.SpinDriftDiffusion(
    id="spin",
    current_source_id=charge.name,
    mode="steady",
    # reciprocal operator and lane-specific solver policy
))
study.spin_torque(fm.DriftDiffusionSpinTorque(
    id="transport_torque",
    solve_id=spin.id,
    target=fm.RegionRef("fm"),
))
```

The problem validator binds charge and spin to the reciprocal constitutive
contract. This is not obtained by adding `PrescribedSpinOrbitTorque` to M1.

:::
::::

### Do not double count the torque

`DriftDiffusionSpinTorque` consumes the absorbed spin flux from a named M1/M2
solve. `PrescribedSpinOrbitTorque` creates an independent local source. Adding
both to the same target sums both terms in the magnetization equation; Fullmag
does not infer that one replaces the other. Such a combination is valid only
when the user can identify two distinct physical sources, for example a solved
HM torque plus a separately calibrated torque from another unmeshed layer.

For a comparison study, run separate problems or stages with one torque model
active at a time, preserve the current and normal sign convention, and compare
the same torque or magnetization observable.

(physics-spin-orbit-torque-governing-equations)=
## Governing equations and sign convention

Let $\mathbf m$ be the unit magnetization, $\hat{\boldsymbol\sigma}$ the unit spin
polarization, and $J_{\mathrm{signed}}$ the conventional signed charge-current
density. A thin-film reduction converts an effective spin angular-momentum flux
$(\hbar/2e)\,\xi J_{\mathrm{signed}}$ into a volume source by dividing by the
free-layer thickness $t_F$.

The reduction is written below as separate equations. This is intentional: the
base current-to-frequency conversion, the two efficiencies, and the two torque
directions are different modelling choices and should not be read as one fitted
constant.

### Base current-to-frequency conversion

```{math}
:label: eq-prescribed-sot-base-rate
\Omega_0 =
\frac{\gamma_e\hbar J_{\mathrm{signed}}}
     {2eM_s t_F}.
```

This equation answers only: "how large is the torque frequency before DL/FL
efficiencies are applied?" Its sign comes from $J_{\mathrm{signed}}$. Increasing
$M_s$ or $t_F$ reduces the same injected angular momentum per magnetic volume.
The constants $e$, $\hbar$, and $\gamma_e$ are supplied by the backend and are
not Python inputs.

### Damping-like rate

```{math}
:label: eq-prescribed-sot-dl-rate
\Omega_{\mathrm{DL}}
=
\xi_{\mathrm{DL}}\Omega_0.
```

`xi_dl` is an effective dimensionless damping-like efficiency. In a reduced
model it absorbs bulk conversion, interface transmission, spin backflow, and
other stack-specific losses. It is usually inferred from harmonic Hall,
spin-torque ferromagnetic resonance, switching, or another calibrated torque
measurement. It is not automatically equal to the bulk spin Hall angle.

### Field-like rate

```{math}
:label: eq-prescribed-sot-fl-rate
\Omega_{\mathrm{FL}}
=
\xi_{\mathrm{FL}}\Omega_0.
```

`xi_fl` is the signed effective field-like efficiency. Its sign and magnitude
can depend strongly on interfaces, stack order, annealing, and the convention
used for current and interface normal. Do not infer it from `xi_dl` unless the
chosen physical model or measurement explicitly supplies that relation.

### Damping-like Gilbert torque

```{math}
:label: eq-prescribed-sot-dl-gilbert
\mathbf T_{\mathrm{DL}}^{G}
=
\Omega_{\mathrm{DL}}
\mathbf m\times
(\hat{\boldsymbol\sigma}\times\mathbf m).
```

The vector $\mathbf m\times(\hat{\boldsymbol\sigma}\times\mathbf m)$ is the
component of $\hat{\boldsymbol\sigma}$ transverse to $\mathbf m$. The DL term
therefore pushes $\mathbf m$ toward or away from that transverse polarization,
depending on the total sign of $J_{\mathrm{signed}}\xi_{\mathrm{DL}}$.

### Field-like Gilbert torque

```{math}
:label: eq-prescribed-sot-fl-gilbert
\mathbf T_{\mathrm{FL}}^{G}
=
\Omega_{\mathrm{FL}}
\mathbf m\times\hat{\boldsymbol\sigma}.
```

The vector $\mathbf m\times\hat{\boldsymbol\sigma}$ has the same geometry as
precession about a field parallel to $\hat{\boldsymbol\sigma}$. This explains
the name "field-like"; `xi_fl` remains a torque efficiency, not a magnetic-field
input in tesla.

### Total Gilbert source

```{math}
:label: eq-prescribed-sot-gilbert-total
\mathbf T_{\mathrm{SOT}}^{G}
=
\mathbf T_{\mathrm{DL}}^{G}
+
\mathbf T_{\mathrm{FL}}^{G}.
```

The source has units $\mathrm{s^{-1}}$ and is added to the magnetization time
derivative. Reversing the signed current, reversing `sigma`, or reversing one
efficiency reverses the corresponding term. Reversing both current and `sigma`
leaves the torque unchanged.

### Gilbert-to-explicit conversion

Backends add an explicit right-hand-side contribution after solving the Gilbert
form once. Define the explicit damping-like coefficient separately:

```{math}
:label: eq-prescribed-sot-explicit-dl
C_{\mathrm{DL}}
=
\Omega_0
\frac{\xi_{\mathrm{DL}}-\alpha\xi_{\mathrm{FL}}}
     {1+\alpha^2}.
```

Define the explicit field-like coefficient independently:

```{math}
:label: eq-prescribed-sot-explicit-fl
C_{\mathrm{FL}}
=
\Omega_0
\frac{\xi_{\mathrm{FL}}+\alpha\xi_{\mathrm{DL}}}
     {1+\alpha^2}.
```

The actual explicit source is then

```{math}
:label: eq-prescribed-sot-explicit-total
\mathbf T_{\mathrm{SOT}}
=
C_{\mathrm{DL}}
\mathbf m\times
(\hat{\boldsymbol\sigma}\times\mathbf m)
+
C_{\mathrm{FL}}
\mathbf m\times\hat{\boldsymbol\sigma}.
```

The cross-coupling by $\alpha$ is an algebraic consequence of converting the
Gilbert equation to an explicit time derivative. It is why MuMax-style code may
contain apparent DL/FL compensation. Author the physical `xi_dl` and `xi_fl`;
do not pre-apply these formulas in Python.

(physics-spin-orbit-torque-drives)=
## Drive definitions

### Signed scalar drive

`SignedScalarDrive` is the direct reduced-model input:

```{math}
:label: eq-prescribed-sot-scalar-current
J_{\mathrm{signed}}(t)
=
J_0 f(t).
```

`J_0` is the signed current-density amplitude controlled by the script or
experiment. $f(t)$ is the dimensionless envelope evaluated at stage time.

```{math}
:label: eq-prescribed-sot-sigma-normalization
\hat{\boldsymbol\sigma}=
\frac{\boldsymbol\sigma}{\lVert\boldsymbol\sigma\rVert}.
```

The authored vector $\boldsymbol\sigma$ states the spin-polarization direction;
only its direction is retained. `J_0` may be positive, negative, or zero. `sigma` is normalized during
authoring. The optional envelope must be one of the canonical Fullmag envelope
objects: `ConstantEnvelope`, `SinusoidalEnvelope`, `PulseEnvelope`,
`PiecewiseLinearEnvelope`, `SincEnvelope`, or `TabulatedEnvelope`.

### Vector-current binding

`VectorCurrentDrive` binds the torque to a named vector-current source while
making the geometric convention explicit:

```{math}
:label: eq-prescribed-sot-vector-current
J_{\mathrm{signed}}
=
\mathbf J_c\cdot\hat{\mathbf t}.
```

Only the component of the named current source along `drive_direction`
contributes to this reduced torque.

```{math}
:label: eq-prescribed-sot-vector-polarization
\hat{\boldsymbol\sigma} =
\frac{\hat{\mathbf n}_{NF}\times\hat{\mathbf t}}
     {\lVert\hat{\mathbf n}_{NF}\times\hat{\mathbf t}\rVert}.
```

`drive_direction` defines $\hat{\mathbf t}$ and `interface_normal` defines the
oriented normal $\hat{\mathbf n}_{NF}$ from the nonmagnetic layer toward the
ferromagnet. Both authored axes are normalized. They must be nonzero and must
not be parallel within the canonical axis tolerance $10^{-12}$. The projection
preserves current reversal; the polarization axis does not flip when only the
source current reverses.

(physics-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $m$ | unit magnetization | $1$ |
| $\hat{\boldsymbol\sigma}$ | unit spin-polarization axis | $1$ |
| $\boldsymbol\sigma$ | authored nonzero spin-polarization vector | $1$ |
| $J_{\mathrm{signed}}$ | signed conventional charge-current density driving the local source | $\mathrm{A\,m^{-2}}$ (`A/m^2`) |
| $J_0$ | prescribed signed current-density amplitude | $\mathrm{A\,m^{-2}}$ (`A/m^2`) |
| $\mathbf J_c$ | named vector charge-current density | $\mathrm{A\,m^{-2}}$ (`A/m^2`) |
| $\hat{\mathbf t}$ | normalized current-projection direction | $1$ |
| $\hat{\mathbf n}_{NF}$ | normalized oriented nonmagnet-to-ferromagnet interface normal | $1$ |
| $\xi_{\mathrm{DL}}$ | signed effective damping-like efficiency | $1$ |
| $\xi_{\mathrm{FL}}$ | signed effective field-like efficiency | $1$ |
| $t_F$ | physical free-layer thickness | $\mathrm{m}$ (`m`) |
| $M_s$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ (`A/m`) |
| $\gamma_e$ | positive magnitude of electron gyromagnetic ratio | $\mathrm{s^{-1}\,T^{-1}}$ (`1/(s T)`) |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ (`J s`) |
| $e$ | positive elementary charge | $\mathrm{C}$ (`C`) |
| $\alpha$ | Gilbert damping | $1$ |
| $\Omega_0$ | signed base torque frequency | $\mathrm{s^{-1}}$ (`1/s`) |
| $\Omega_{\mathrm{DL}}$ | signed damping-like Gilbert rate | $\mathrm{s^{-1}}$ (`1/s`) |
| $\Omega_{\mathrm{FL}}$ | signed field-like Gilbert rate | $\mathrm{s^{-1}}$ (`1/s`) |
| $C_{\mathrm{DL}}$ | damping-like coefficient after Gilbert-to-explicit conversion | $\mathrm{s^{-1}}$ (`1/s`) |
| $C_{\mathrm{FL}}$ | field-like coefficient after Gilbert-to-explicit conversion | $\mathrm{s^{-1}}$ (`1/s`) |
| $\mathbf T_{\mathrm{DL}}^{G}$ | damping-like source in Gilbert form | $\mathrm{s^{-1}}$ (`1/s`) |
| $\mathbf T_{\mathrm{FL}}^{G}$ | field-like source in Gilbert form | $\mathrm{s^{-1}}$ (`1/s`) |
| $\mathbf T_{\mathrm{SOT}}^{G}$ | total prescribed source in Gilbert form | $\mathrm{s^{-1}}$ (`1/s`) |
| $\mathbf T_{\mathrm{SOT}}$ | prescribed spin-orbit torque contribution | $\mathrm{s^{-1}}$ (`1/s`) |
| $f(t)$ | canonical scalar time-envelope multiplier | $1$ |

(physics-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

- The ferromagnet is represented by a unit magnetization with positive local $M_s$.
- The HM/FM conversion is reduced to signed effective efficiencies; bulk spin Hall angle,
  interface transparency, spin backflow, and diffusion are not solved.
- The free-layer thickness is an authored physical parameter and is not inferred from mesh cells.
- `VectorCurrentDrive` uses fixed authored axes and one signed projection of a named current source.
- The source is local to the resolved target mask; it does not generate an Oersted field.

### Which values come from where?

The following classification is the practical minimum for preparing a script.
"Literature" means a starting point for a comparable stack, not a universal
material constant.

| Script value | Category | Where to obtain it | Example used below | Required action |
| --- | --- | --- | --- | --- |
| `name` | model identity | chosen by the author | `"hm_sot"` | choose a unique ID |
| `target` | geometry/model identity | Fullmag object and region names | `RegionRef("film")` | point to the magnetic free layer |
| `body.Ms` | measured material parameter | magnetometry or a validated material dataset | $8.0\times10^5\,\mathrm{A\,m^{-1}}$ | replace with the sample value |
| `body.Aex` | material/model parameter | spin-wave, domain-wall, or literature calibration | $13\,\mathrm{pJ\,m^{-1}}$ | replace or justify |
| `body.alpha` | measured effective material parameter | FMR linewidth or calibrated dynamics | $0.02$ | replace with the stack value |
| `free_layer_thickness_m` | fabricated geometry | magnetic-layer thickness, not HM thickness | $1.5\,\mathrm{nm}$ | enter the physical magnetic thickness |
| `current_density_Apm2` | controlled drive | applied current divided by the conducting cross-section, with declared sign | $-4.0\times10^{11}\,\mathrm{A\,m^{-2}}$ | choose the sweep or pulse value |
| `sigma` | controlled geometry and sign convention | current direction, interface normal, and SHE convention | $(0,1,0)$ | verify using a current-reversal test |
| `xi_dl` | effective fitted SOT parameter | harmonic Hall, ST-FMR, switching fit, or literature seed | $0.12$ | calibrate for the actual stack |
| `xi_fl` | effective fitted SOT parameter | harmonic Hall, ST-FMR, or dedicated fit | $-0.03$ | calibrate independently |
| `envelope` | controlled waveform | experiment or numerical protocol | `None`, meaning constant | define pulse/ramp if needed |
| `until` | controlled simulation window | physical timescale and convergence study | $1\,\mathrm{ps}$ | choose long enough for the observable |
| cell size | numerical parameter | convergence study and exchange length | $(2,2,2)\,\mathrm{nm}$ | demonstrate mesh convergence |
| engine/device/precision | numerical execution policy | desired qualified backend lane | FDM CPU double strict | choose explicitly |

Fullmag supplies $e$, $\hbar$, and $\gamma_e$. Fullmag derives $\Omega_0$,
$\Omega_{\mathrm{DL}}$, $\Omega_{\mathrm{FL}}$, $C_{\mathrm{DL}}$, and
$C_{\mathrm{FL}}$. None of those constants or derived rates belongs in the
Python constructor.

### How to use literature values safely

Nguyen, Ralph, and Buhrman reported a peak damping-like efficiency per current
density of $\xi_{\mathrm{DL}}^j=0.12$ for their Pt/Co samples at Pt thickness
$2.8$-$3.9\,\mathrm{nm}$. This supports `xi_dl=0.12` as a realistic literature
seed for a related Pt/FM stack, but it does not determine the Co thickness,
$M_s$, $\alpha$, `xi_fl`, or the sign convention of a different sample. Their
measured efficiency also changes with Pt thickness and resistivity.

Garello and co-workers measured both DL-like and FL-like components and found
strong dependence on stack composition, magnetization angle, and annealing.
Consequently, the example `xi_fl=-0.03` is explicitly illustrative; it is not
presented as a transferable Pt/Co constant.

Use this order when building a real case:

1. Enter measured geometry, $M_s$, $A_{\mathrm{ex}}$, and $\alpha$ for the same sample.
2. Fix and test the current, interface-normal, and spin-polarization sign convention.
3. Use literature `xi_dl` and `xi_fl` only as initial estimates from a comparable stack.
4. Fit or measure both effective efficiencies for the actual stack.
5. Sweep their uncertainty separately from mesh, timestep, and current uncertainty.

(physics-spin-orbit-torque-python-api)=
## Python authoring

### Complete stage-first example

```python
# %% Study and execution policy
import fullmag as fm

nm = 1.0e-9
study = fm.study("prescribed_sot_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

# %% Geometry, material, and initial state
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Canonical prescribed SOT
sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot",
    target=fm.RegionRef("film"),
    drive=fm.SignedScalarDrive(
        current_density_Apm2=-4.0e11,
        sigma=(0.0, 1.0, 0.0),
    ),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5 * nm,
)
study.spin_torque(sot)

# %% Ordered run stage
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

The sign in `current_density_Apm2` is retained in ProblemIR. The authored
`sigma=(0, 1, 0)` is normalized and serialized as `sigma_hat`.

### What the example numbers produce

Using the constants embedded by Fullmag, the example inputs produce the
following signed rates. These values check units and sign propagation; they do
not predict a switching time by themselves.

| Derived quantity | Example value | Interpretation |
| --- | --- | --- |
| $\Omega_0$ | $-1.932\times10^{10}\,\mathrm{s^{-1}}$ | base rate set by current, $M_s$, and $t_F$ |
| $\Omega_{\mathrm{DL}}$ | $-2.318\times10^9\,\mathrm{s^{-1}}$ | Gilbert DL rate before damping conversion |
| $\Omega_{\mathrm{FL}}$ | $+5.795\times10^8\,\mathrm{s^{-1}}$ | Gilbert FL rate; positive because both $J$ and `xi_fl` are negative |
| $C_{\mathrm{DL}}$ | $-2.329\times10^9\,\mathrm{s^{-1}}$ | explicit DL coefficient for $\alpha=0.02$ |
| $C_{\mathrm{FL}}$ | $+5.329\times10^8\,\mathrm{s^{-1}}$ | explicit FL coefficient after DL/FL mixing |

The $1\,\mathrm{ps}$ stage in the example is deliberately short. A switching,
oscillation, or relaxation study must choose the stage duration from the actual
field, anisotropy, damping, geometry, and observable, then demonstrate temporal
and spatial convergence.

### Binding to an existing vector-current source

If the study already contains a current module named `charge`, replace the
drive object only:

```python
# %% Alternative object-level vector-current binding
drive = fm.VectorCurrentDrive(
    current_source="charge",
    drive_direction=(1.0, 0.0, 0.0),
    interface_normal=(0.0, 0.0, 1.0),
)

sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot_from_charge",
    target=fm.RegionRef("film"),
    drive=drive,
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5e-9,
)
sot.to_ir_module()
```

For these axes, $\hat{\boldsymbol\sigma}=\hat{\mathbf z}\times\hat{\mathbf x}
=\hat{\mathbf y}$ and only the $x$ projection of the named current contributes.
`VectorCurrentDrive` has no independent envelope argument; timing belongs to the
named current source.

### Constructor reference

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PrescribedSpinOrbitTorque.name` | `str` | `required` | $1$ | non-empty | stable module ID | all prescribed-SOT lanes | `spin_torque_modules[].id` |
| `PrescribedSpinOrbitTorque.target` | `RegionRef` | `required` | $1$ | exact RegionRef resolving to magnetic target | torque target | all prescribed-SOT lanes | `spin_torque_modules[].target` |
| `PrescribedSpinOrbitTorque.drive` | `SignedScalarDrive or VectorCurrentDrive` | `required` | $1$ | exact canonical drive type | signed current and polarization definition | all prescribed-SOT lanes after planning | `spin_torque_modules[].drive` |
| `PrescribedSpinOrbitTorque.xi_dl` | `float` | `required` | $1$ | finite | signed damping-like efficiency | all prescribed-SOT lanes | `spin_torque_modules[].xi_dl` |
| `PrescribedSpinOrbitTorque.xi_fl` | `float` | `0.0` | $1$ | finite | signed field-like efficiency | all prescribed-SOT lanes | `spin_torque_modules[].xi_fl` |
| `PrescribedSpinOrbitTorque.free_layer_thickness_m` | `float` | `required` | $\mathrm{m}$ (`m`) | finite and positive | physical free-layer thickness | all prescribed-SOT lanes | `spin_torque_modules[].free_layer_thickness_m` |
| `SignedScalarDrive.current_density_Apm2` | `float` | `required` | $\mathrm{A\,m^{-2}}$ (`A/m^2`) | finite; sign retained | prescribed scalar current amplitude | all prescribed-SOT lanes | `spin_torque_modules[].drive.current_density_Apm2` |
| `SignedScalarDrive.sigma` | `Sequence[float]` | `required` | $1$ | finite nonzero three-axis vector; normalized | authored spin-polarization direction | all prescribed-SOT lanes | `spin_torque_modules[].drive.sigma_hat` |
| `SignedScalarDrive.envelope` | `TimeEnvelope or None` | `None` | $1$ | canonical supported envelope type | scalar time multiplier | bounded prescribed-SOT lanes | `spin_torque_modules[].drive.envelope` |
| `VectorCurrentDrive.current_source` | `str` | `required` | $1$ | non-empty and resolvable named current source | vector-current producer | planner-resolved prescribed-SOT lanes | `spin_torque_modules[].drive.current_source_id` |
| `VectorCurrentDrive.drive_direction` | `Sequence[float]` | `required` | $1$ | finite nonzero axis; normalized; not parallel to interface normal | signed current projection axis | planner-resolved prescribed-SOT lanes | `spin_torque_modules[].drive.drive_direction` |
| `VectorCurrentDrive.interface_normal` | `Sequence[float]` | `required` | $1$ | finite nonzero axis; normalized; not parallel to drive direction | oriented nonmagnet-to-ferromagnet normal | planner-resolved prescribed-SOT lanes | `spin_torque_modules[].drive.interface_normal` |

`SpinOrbitTorque` is a deprecated compatibility constructor. New scripts and
canonical exports must use `PrescribedSpinOrbitTorque`.

(physics-spin-orbit-torque-problem-ir)=
## ProblemIR contract

The scalar example lowers to the following module record:

```json
{
  "kind": "prescribed_sot",
  "schema_version": "prescribed_sot.v1",
  "id": "hm_sot",
  "target": {"object_id": "film", "region_id": null},
  "formula_version": "prescribed_sot.fullmag.v1",
  "drive": {
    "kind": "signed_scalar",
    "current_density_Apm2": -400000000000.0,
    "sigma_hat": [0.0, 1.0, 0.0]
  },
  "xi_dl": 0.12,
  "xi_fl": -0.03,
  "free_layer_thickness_m": 1.5e-9
}
```

Validation fails closed for duplicate IDs, non-finite coefficients, non-positive
thickness, unresolved targets or current sources, invalid axes, parallel vector
axes, and incompatible envelope artifacts. The legacy wire formula
`prescribed_sot.legacy_fullmag.v0` is retained only for migration and is not the
authoring contract documented here.

(physics-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round trip and failure semantics

The **requested intent** preserves the authored target, drive variant, signed values,
axes, envelope, efficiencies, thickness, execution mode, device, and precision. The
planner records **resolved execution** separately, including the selected lane and the
projected signed current. Python and ProblemIR **validation errors** reject malformed
or unresolved inputs before runtime. Strict **unsupported combinations** fail closed;
they are not silently rebound to another solver or device. Provenance therefore keeps
both the canonical authored module and the planner/runtime resolution.

(physics-spin-orbit-torque-discrete-realization)=
## Discrete realization

| Solver | Device | Status | Evidence boundary |
| --- | --- | --- | --- |
| FDM | CPU | Partial | executable double-precision reference path, signed current, target mask, and envelope contracts; broad scientific qualification is not claimed |
| FDM | GPU | Partial | native CUDA implementation with fixed-trajectory CPU parity and bounded current-scaling tests when CUDA is available; no implicit CPU fallback |
| FEM | CPU | Partial | executable MFEM reference source with SI-prefactor, damping conversion, mask, and time-envelope checks |
| FEM | GPU | Partial | native CUDA RHS kernel with independent SI oracle and CPU comparison; device availability and wider production qualification remain separate gates |

`Partial` means the interaction is executable in the bounded lanes above, not
that every mesh, precision, integrator, or deployment route is production
qualified.

### FDM CPU

The reference evaluator consumes a per-cell active mask, local $M_s$ and $\alpha$,
the signed scalar amplitude, normalized polarization, and the stage-time envelope.

### FDM GPU

The native CUDA path selects `prescribed_sot.fullmag.v1` explicitly and is bounded
by fixed-trajectory CPU parity and current-scaling tests when a CUDA device is present.

### FEM CPU

The MFEM local-interaction path evaluates the same SI prefactor at magnetic nodes,
applies the active mask, and performs the Gilbert-to-explicit conversion once.

### FEM GPU

The CUDA RK source adds the canonical local RHS on device. Its bounded contract checks
the independent SI oracle, active-mask exclusion, and CPU parity; this does not by
itself qualify every runtime or mesh configuration.

(physics-spin-orbit-torque-validation)=
## Validation requirements

A trustworthy SOT result should demonstrate all of the following for the chosen
backend and device:

- exact SI prefactor for a single cell or node;
- odd scaling under current reversal;
- independent DL-only and FL-only basis-vector cases;
- the $\alpha$-dependent Gilbert-to-explicit coefficient mixing;
- target-mask exclusion and zero contribution outside the magnetic target;
- envelope value at stage time, including retry or rollback behavior;
- CPU/GPU parity on the same trajectory when GPU execution is claimed;
- no silent CPU fallback for a strict GPU request.

(physics-spin-orbit-torque-limitations)=
## Limitations

- `xi_dl` and `xi_fl` are effective reduced-model inputs, not independently solved
  bulk and interface observables.
- The model cannot predict spin accumulation, spin backflow, diffusion-length effects,
  interface hot spots, or a self-consistent inverse spin Hall response.
- A spatially resolved SHE stack must use the separate drift-diffusion transport model.
- Published backend statuses are bounded evidence statements, not universal production
  qualification for every precision, integrator, device, and deployment route.

(physics-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

| Layer | File and stable symbol | Responsibility |
| --- | --- | --- |
| Python API | `packages/fullmag-py/src/fullmag/model/spin_torque.py`, `class PrescribedSpinOrbitTorque` | validates module arguments and emits canonical v1 ProblemIR |
| Scalar drive | same file, `class SignedScalarDrive` | preserves signed current, normalizes `sigma`, validates envelope |
| Vector drive | same file, `class VectorCurrentDrive` | validates axes and emits named-current binding |
| ProblemIR | `crates/fullmag-ir/src/study.rs`, `PrescribedSotV1DriveIR` | owns tagged drive variants and formula fields |
| Planner | `crates/fullmag-plan/src/spin_torque.rs`, `resolve_sot_fields` | resolves current projection, polarization, target, and lane eligibility |
| FDM CPU | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs`, `build_sot` | maps the plan into the CPU evaluator configuration |
| FDM GPU | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`, `ffi_prescribed_sot_formula` | selects canonical versus legacy native CUDA formula |
| FEM CPU | `backends/fem/cpu/mfem/interactions/sot.cpp`, `add_sot_rhs_aos` | evaluates the canonical SI torque and damping conversion |
| FEM GPU | `backends/fem/gpu/cuda/integrators/rk/rk_sot_torque.cu`, `fullmag_cuda_add_prescribed_sot_rhs` | adds the canonical source to the device RHS |
| UI | `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx`, `SpinAuthoringInspector` | exposes prescribed SOT and its DL/FL efficiencies |

(physics-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

- L. Liu et al., "Current-Induced Switching of Perpendicularly Magnetized Magnetic Layers Using Spin Torque from the Spin Hall Effect," *Physical Review Letters* **109**, 096602 (2012), [doi:10.1103/PhysRevLett.109.096602](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.109.096602).
- K. Garello et al., "Symmetry and magnitude of spin-orbit torques in ferromagnetic heterostructures," *Nature Nanotechnology* **8**, 587-593 (2013), [doi:10.1038/nnano.2013.145](https://www.nature.com/articles/nnano.2013.145). Experimental basis for treating DL-like and FL-like torques as separately measured, stack-dependent quantities.
- P. M. Haney et al., "Current induced torques and interfacial spin-orbit coupling: Semiclassical modeling," *Physical Review B* **87**, 174411 (2013), [doi:10.1103/PhysRevB.87.174411](https://journals.aps.org/prb/abstract/10.1103/PhysRevB.87.174411). Theoretical context for bulk, interfacial, Boltzmann, and drift-diffusion interpretations.
- M.-H. Nguyen, D. C. Ralph, and R. A. Buhrman, "Spin Torque Study of the Spin Hall Conductivity and Spin Diffusion Length in Platinum Thin Films with Varying Resistivity," *Physical Review Letters* **116**, 126601 (2016), [doi:10.1103/PhysRevLett.116.126601](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.116.126601). Reports $\xi_{\mathrm{DL}}^j=0.12$ at the stated Pt thickness range and demonstrates thickness/resistivity dependence.
- A. Manchon et al., "Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic systems," *Reviews of Modern Physics* **91**, 035004 (2019), [doi:10.1103/RevModPhys.91.035004](https://journals.aps.org/rmp/abstract/10.1103/RevModPhys.91.035004).

(physics-spin-orbit-torque-source-code-index)=
## Source-code index

| Claim | Path | Symbol | Responsibility and evidence |
| --- | --- | --- | --- |
| Python torque API | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class PrescribedSpinOrbitTorque` | canonical validation and ProblemIR lowering |
| Scalar drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SignedScalarDrive` | signed current, normalized polarization, envelope validation |
| Vector drive | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class VectorCurrentDrive` | axes and named-current binding |
| ProblemIR | `crates/fullmag-ir/src/study.rs` | `PrescribedSotV1DriveIR` | canonical tagged drive variants |
| Planner | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_sot_fields` | projection, target, envelope, and executable fields |
| FDM CPU | `crates/fullmag-runner/src/fdm/cpu/reference/interactions.rs` | `build_sot` | CPU evaluator configuration |
| FDM GPU | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `ffi_prescribed_sot_formula` | canonical native formula selection |
| FEM CPU | `backends/fem/cpu/mfem/interactions/sot.cpp` | `add_sot_rhs_aos` | SI torque and damping conversion |
| FEM GPU | `backends/fem/gpu/cuda/integrators/rk/rk_sot_torque.cu` | `fullmag_cuda_add_prescribed_sot_rhs` | device RHS source |
| Python tests | `packages/fullmag-py/tests/test_prescribed_sot.py` | `class TestPrescribedSpinOrbitTorque` | exact JSON and fail-closed authoring tests |
| Planner test | `crates/fullmag-plan/src/spin_torque.rs` | `canonical_prescribed_sot_vector_binding_preserves_axes_and_reverses_signed_projection` | signed vector projection contract |
| FDM GPU test | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available` | bounded CUDA/CPU trajectory parity |
| FEM GPU test | `backends/fem/tests/cuda_sot_contract.cpp` | `main` | independent oracle and CPU/CUDA contract runner |
| Control Room | `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` | `SpinAuthoringInspector` | prescribed-SOT authoring fields |
