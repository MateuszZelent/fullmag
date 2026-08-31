---
title: Spin Hall drift-diffusion transport
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-drift-diffusion-stt)=
# Spin Hall drift-diffusion transport

Fullmag treats the spin Hall effect (SHE) as a solved charge-and-spin transport problem, not an
algebraic torque coefficient. A charge solution drives vector spin accumulation, a rank-two
spin-current tensor transports angular momentum, and a named torque consumer transfers absorbed
transverse spin to magnetization.

This terminal page keeps the physics, public API, capability envelope, and source evidence in one
auditable contract because the scientific-doc validator requires every scientific page to carry
the complete model, API, and backend-lane contract. Jump to [equations](#governing-equations), [interfaces](#boundaries-and-interfaces),
[Python](#python-api), [numerics](#discrete-realization), or [validation](#validation).

(physics-drift-diffusion-spin-torque-problem-statement)=
## Physical problem

A heavy metal (HM) carries conventional charge current. Spin-orbit scattering generates transverse
spin current and spin accumulation $\boldsymbol\mu_s$. At an oriented HM/FM interface, longitudinal
spin is transmitted or reflected while absorbed transverse spin torques the ferromagnet (FM).

```{figure} ../../../_static/diagrams/spin-hall-hm-fm.svg
:alt: HM and FM stack with charge current, electric field, spin Hall current, spin accumulation, interface normal, magnetization, and torque.
:width: 100%

Fullmag convention map. The first index of $Q_{ia}$ is flow direction and the second is spin
polarization. Here the normal points from HM to FM.
```

Fullmag uses $e>0$, conventional current, and $\mathbf E=-\nabla V$. Here $\sigma$ is charge
conductivity, distinct from spin conductivity $\sigma_s$. The direct-SHE contribution is
proportional to $\theta_{\mathrm{SH}}\sigma(\mathbf n\times\mathbf E)$. Reversing
$\theta_{\mathrm{SH}}$, current, $\mathbf n$, or HM/FM orientation reverses the corresponding
polarization or flux. A material sign is meaningful only with these definitions.

(physics-drift-diffusion-spin-torque-governing-equations)=
## Governing equations

$\boldsymbol\mu_s$ is the full spin-channel voltage splitting: the channels are
$V+\boldsymbol\mu_s/2$ and $V-\boldsymbol\mu_s/2$. $Q_{ia}$ is charge-equivalent spin current;
$(\hbar/2e)Q_{ia}$ is angular-momentum current.

```{math}
:label: eq-dd-gradients
E_i=-\partial_iV,\qquad
G_{ia}=-\frac12\partial_i\mu_{s,a},\qquad
\mathcal J^s_{ia}=\frac{\hbar}{2e}Q_{ia}.
```

### M1 one-way FDM face flux

```{math}
:label: eq-dd-m1-face-flux
\mathbf Q_i=P_f\mathbf m_{\mathrm{up}}J_{c,i}
+\theta_{\mathrm{SH},f}\sigma_f(\mathbf e_i\times\mathbf E_f)
-\frac{\boldsymbol\mu_{s,R}-\boldsymbol\mu_{s,L}}
{h_L/(2\sigma_{s,L})+h_R/(2\sigma_{s,R})}.
```

Here $\sigma_f$ is accepted face charge conductivity and $\sigma_{s,L/R}$ are spin
conductivities.

<code>fv_spin_upwind_v1</code> chooses $\mathbf m_{\mathrm{up}}$ from the sign of $P_fJ_{c,i}$;
the central reference operator averages neighbors. The steady balance is

```{math}
:label: eq-dd-spin-balance
\partial_iQ_{ia}+R_{\mathrm{sf},a}+R_{J,a}+R_{\phi,a}=0,
\quad
\mathbf R_{\mathrm{sf}}=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\boldsymbol\mu_s,
\quad
\mathbf R_J=\frac{\sigma_s}{2\lambda_J^2}(\boldsymbol\mu_s\times\mathbf m),
\quad
\mathbf R_\phi=\frac{\sigma_s}{2\lambda_\phi^2}
\mathbf m\times(\boldsymbol\mu_s\times\mathbf m).
```

Only exchange rotation and dephasing torque the FM:

```{math}
:label: eq-dd-transport-torque
\mathbf T_{\mathrm{tr},G}=
-\frac{\gamma_e}{M_s}\frac{\hbar}{2e}(\mathbf R_J+\mathbf R_\phi).
```

Absorbed transverse interface flux uses the same negative convention after area-to-volume
conversion.

### M2 reciprocal FDM block

The current FDM implementation uses $\sigma_s$ in reciprocal polarization and SHE blocks. Older
target-contract prose using scalar charge $\sigma$ in these terms is not the implemented FDM law:

```{math}
:label: eq-dd-m2-charge
J_{c,i}=\sigma_\perp E_i+(\sigma_\parallel-\sigma_\perp)
(\mathbf m\cdot\mathbf E)m_i+\sigma_{\mathrm{AHE}}(\mathbf m\times\mathbf E)_i
+P\sigma_s m_aG_{ia}+\theta_{\mathrm{SH}}\sigma_s\epsilon_{ija}G_{ja}.
```

```{math}
:label: eq-dd-m2-spin
Q_{ia}=\sigma_sG_{ia}+P\sigma_sE_im_a
+\theta_{\mathrm{SH}}\sigma_s\epsilon_{ika}E_k.
```

M2 solves $(V,\mu_{s,x},\mu_{s,y},\mu_{s,z})$ per cell. The last charge term is inverse SHE; the
symmetric anisotropic term contains AMR/PHE and the cross product contains AHE.

(physics-drift-diffusion-spin-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $V$ | charge electrochemical potential | $\mathrm{V}$ |
| $\boldsymbol\mu_s$ | full spin-channel splitting | $\mathrm{V}$ |
| $E_i$ | electric field | $\mathrm{V\,m^{-1}}$ (V/m) |
| $G_{ia}$ | negative half-gradient of spin voltage | $\mathrm{V\,m^{-1}}$ (V/m) |
| $J_{c,i}$ | conventional charge-current density | $\mathrm{A\,m^{-2}}$ (A/m^2) |
| $Q_{ia}$ | charge-equivalent spin-current tensor; flow index first | $\mathrm{A\,m^{-2}}$ (A/m^2) |
| $\sigma_s$ | spin conductivity and implemented M2 reciprocal coefficient | $\mathrm{S\,m^{-1}}$ (S/m) |
| $P$ | signed transport polarization | $1$ |
| $\theta_{\mathrm{SH}}$ | signed spin Hall angle in the Fullmag convention | $1$ |
| $\lambda_{\mathrm{sf}},\lambda_J,\lambda_\phi$ | active reaction lengths | $\mathrm{m}$ |
| $\mathbf R_{\mathrm{sf}},\mathbf R_J,\mathbf R_\phi$ | reaction densities | $\mathrm{A\,m^{-3}}$ (A/m^3) |
| $G_\uparrow,G_\downarrow,G_r,G_i$ | interface conductances per area | $\mathrm{S\,m^{-2}}$ (S/m^2) |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ (A/m) |
| $\mathbf T_{\mathrm{tr},G}$ | Gilbert-form transport torque source | $\mathrm{s^{-1}}$ (1/s) |

## Boundaries and interfaces

Authoring includes <code>SpinInsulating</code>, <code>SpinSink</code>,
<code>SpecifiedSpinPotential</code>, outward <code>SpecifiedSpinFlux</code>, and
<code>PeriodicSpin</code>. A negative-axis face reverses outward flux when stored in positive-axis
form. Transparent interfaces enforce continuity. With $\Delta V=V_N-V_F$ and
$\Delta\boldsymbol\mu_s=\boldsymbol\mu_{s,N}-\boldsymbol\mu_{s,F}$, M1 longitudinal
injection/backflow is

```{math}
:label: eq-dd-mixing-longitudinal
j_{c,n}^{\mathrm{M1}}=(G_\uparrow+G_\downarrow)\Delta V,
\qquad
\mathbf q_{s,\parallel}^{\mathrm{M1}}=
\left[(G_\uparrow-G_\downarrow)\Delta V+
\frac12(G_\uparrow+G_\downarrow)\mathbf m\cdot\Delta\boldsymbol\mu_s\right]\mathbf m.
```

The $G_r,G_i$ transverse absorption law is

```{math}
:label: eq-dd-mixing-absorption
\mathbf q_{\mathrm{abs},\perp}=G_r\mathbf m\times
(\Delta\boldsymbol\mu_s\times\mathbf m)+G_i(\Delta\boldsymbol\mu_s\times\mathbf m).
```

For magnetic cell $K$ adjacent to face $f$, the interface torque contribution is

```{math}
:label: eq-dd-interface-torque-volume
\mathbf T_{f,K}=-\frac{\gamma_e}{M_s}\frac{\hbar}{2e}
\frac{A_f}{V_K}\mathbf q_{\mathrm{abs},\perp}.
```

Optional spin-memory-loss reservoir data exists in authoring/reference FDM but is not generally
executable. The spin domain must be a subset of the conducting charge domain; material coverage
must be complete and non-overlapping.

### M1, M2, and prescribed SOT

| Model | Charge path | Spin/torque path |
|---|---|---|
| M1 | solved first; no spin-to-charge feedback | direct SHE, diffusion, reactions, absorbed-spin torque |
| M2 | coupled AMR/PHE/AHE, polarization, and iSHE | reciprocal block and named-solve torque |
| Prescribed SOT | no drift-diffusion solve | authored drive, efficiencies, and FM thickness |

Canonical <code>fm.DriftDiffusionSpinTorque(id, solve_id, target)</code> consumes a named solve.
The same-named class in <code>fullmag.model.spin_torque</code> is a hidden legacy semantic
placeholder; its current-density signature is not the public API.

(physics-drift-diffusion-spin-torque-assumptions-and-validity)=
## Assumptions and validity

The model is diffusive and continuum-scale. Active conductivities and lengths are positive; absent
reactions use <code>None</code>. A realistic HM/FM model needs separate regions, oriented interface,
charge contacts/gauge, HM <code>theta_sh</code>, FM $M_s$ and $\mathbf m$, and complete materials.
FDM cells must resolve each layer and shortest active length. FEM needs a conforming interface and
local refinement. Mesh convergence must be demonstrated.

(physics-drift-diffusion-spin-torque-python-api)=
## Python API

### A. HM/FM M1 authoring graph

```python
# %% Stage-first HM/FM model
import fullmag as fm

nm = 1.0e-9
study = fm.study("hm_fm_m1")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
hm_body = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 3 * nm), name="hm").translate((0, 0, 1.5 * nm)),
    name="hm",
)
fm_body = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 1 * nm), name="fm").translate((0, 0, 3.5 * nm)),
    name="fm",
)
fm_body.Ms, fm_body.Aex, fm_body.alpha = 5.8e5, 1.5e-11, 0.03
fm_body.m = fm.texture.uniform(1.0, 0.0, 0.0)
hm, ferromagnet = fm.RegionRef("hm"), fm.RegionRef("fm")

# %% Solved charge, spin, and named-solve torque
charge = study.current_transport(
    name="charge", model="ohmic_poisson", coupling="one_way",
    domain=[hm, ferromagnet],
    materials=[
        fm.ChargeTransportMaterialAssignment(hm, fm.ChargeTransportMaterial(5.0e6)),
        fm.ChargeTransportMaterialAssignment(ferromagnet, fm.ChargeTransportMaterial(1.0e6)),
    ],
    boundaries=[], gauge=fm.ChargePotentialGauge("zero_mean"),
    solver=fm.ChargeSolverPolicy(engine="cg"),
)
spin = study.spin_transport(fm.SpinDriftDiffusion(
    id="spin", current_source_id=charge.name, domain=[hm, ferromagnet],
    materials=[
        fm.SpinTransportMaterialAssignment(
            hm, fm.SpinTransportMaterial(5.0e6, 0.0, 0.20, 1.5 * nm)
        ),
        fm.SpinTransportMaterialAssignment(
            ferromagnet, fm.SpinTransportMaterial(1.0e6, 0.4, 0.0, 5 * nm, 1 * nm, 1 * nm)
        ),
    ],
    interfaces=[fm.MixingConductanceSpinInterface(
        id="hm_fm", normal_to_ferromagnet=(0, 0, 1),
        normal_side=hm, ferromagnet_side=ferromagnet,
        g_up_Spm2=2.5e14, g_down_Spm2=2.5e14,
        g_r_Spm2=5.0e14, g_i_Spm2=5.0e13,
    )],
    requested_execution=fm.TransportExecution("fdm", "cpu", "double", "strict"),
))
study.spin_torque(fm.DriftDiffusionSpinTorque("transport_torque", spin.id, ferromagnet))
study.stages.add_run(1.0e-15, stage_id="m1_run")
```

This is an authoring/planner graph. Execution also requires complete face ownership accepted by the
selected lane.

### B. Bounded FEM M2 pattern

```python
# %% FEM CPU reciprocal reference
import fullmag as fm

study = fm.study("fem_m2_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(size=(30e-9, 20e-9, 4e-9), name="film"), name="film")
body.Ms, body.Aex, body.alpha = 8.0e5, 13.0e-12, 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
region = fm.RegionRef("film")
operator = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
charge = study.current_transport(
    name="m2_charge", model="ohmic_poisson", coupling="bidirectional",
    domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(
        region, fm.ChargeTransportMaterial(4.0e6, 4.0e6, 4.0e6, 0.0)
    )],
    boundaries=[], gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(engine="block_gmres", operator_version=operator),
)
spin = study.spin_transport(fm.SpinDriftDiffusion(
    id="m2_spin", current_source_id=charge.name, domain=[region],
    materials=[fm.SpinTransportMaterialAssignment(
        region, fm.SpinTransportMaterial(3.0e6, 0.2, 0.1, 4e-9, 1e-9, 1e-9)
    )],
    solver=fm.SpinSolverPolicy(engine="block_gmres", operator_version=operator),
    requested_execution=fm.TransportExecution("fem", "cpu", "double", "strict"),
))
study.spin_torque(fm.DriftDiffusionSpinTorque("m2_torque", spin.id, region))
study.stages.add_run(1.0e-15, stage_id="m2_run")
```

This is a bounded reference pattern. The executable fixture
<code>examples/fem_reciprocal_m2_public.py</code> adds conforming mesh and complete electrodes.

### C. Prescribed SOT comparison

```python
# %% Local prescribed SOT, without drift diffusion
import fullmag as fm

study = fm.study("prescribed_sot_comparison")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
film = study.geometry(fm.Box(40e-9, 20e-9, 1e-9), name="film")
film.Ms, film.Aex, film.alpha = 8.0e5, 13.0e-12, 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
target = fm.RegionRef("film")
drive = fm.SignedScalarDrive(1.0e11, sigma=(0.0, 1.0, 0.0))
study.spin_torque(fm.PrescribedSpinOrbitTorque(
    "local_sot", target, drive, xi_dl=0.12, xi_fl=0.01,
    free_layer_thickness_m=1.0e-9,
))
study.stages.add_run(1.0e-15, stage_id="sot_run")
```

### Exact core arguments

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| TransportExecution.discretization | str | fdm | 1 | fdm, fem, or auto | requested discretization | planner-resolved | spin_transport_modules[].requested_execution.discretization |
| TransportExecution.device | str | cpu | 1 | cpu, gpu, or auto | requested device | planner-resolved | spin_transport_modules[].requested_execution.device |
| SpinTransportMaterial.sigma_s_Spm | float | required | S/m | finite and positive | spin conductivity | FDM/FEM bounded lanes | spin_transport_modules[].materials[].material.sigma_s_spm |
| SpinTransportMaterial.polarization_p | float | required | 1 | finite in [-1,1] | signed drift polarization | FDM/FEM bounded lanes | spin_transport_modules[].materials[].material.polarization_p |
| SpinTransportMaterial.theta_sh | float | required | 1 | finite | signed spin Hall angle | direct SHE; M2 also iSHE | spin_transport_modules[].materials[].material.theta_sh |
| SpinTransportMaterial.lambda_sf_m | float | required | m | finite and positive | spin-flip length | FDM/FEM bounded lanes | spin_transport_modules[].materials[].material.lambda_sf_m |
| SpinDriftDiffusion.mode | str | steady | 1 | steady or transient; transient requires capacitance | temporal model | M3 not production-qualified | spin_transport_modules[].mode |
| SpinSolverPolicy.engine | str | auto | 1 | non-empty; lane whitelist applies | spatial solver | lane-specific | spin_transport_modules[].solver.engine |
| DriftDiffusionSpinTorque.solve_id | str | required | 1 | active named spin solve | solved-spin consumer | canonical lane-specific | spin_torque_modules[].solve_id |
| CurrentTransport.coupling | str | one_way | 1 | one_way or bidirectional | selects M1/M2 | bounded CPU lanes | current_modules[].coupling |
| TransportExecution.precision | str | double | 1 | single or double | requested precision | transport lanes require double | spin_transport_modules[].requested_execution.precision |
| TransportExecution.execution_mode | str | strict | 1 | strict or extended | fallback policy | strict lanes fail closed | spin_transport_modules[].requested_execution.execution_mode |
| SpinTransportMaterial.lambda_j_m | float or None | None | m | positive when enabled | exchange length | magnetic reactions | spin_transport_modules[].materials[].material.lambda_j_m |
| SpinTransportMaterial.lambda_phi_m | float or None | None | m | positive when enabled | dephasing length | magnetic reactions | spin_transport_modules[].materials[].material.lambda_phi_m |
| SpinDriftDiffusion.interfaces | Sequence | empty | 1 | typed oriented interfaces | internal transfer | lane-specific | spin_transport_modules[].interfaces |
| SpinDriftDiffusion.boundaries | Sequence | empty | 1 | typed non-conflicting faces | external spin BC | lane-specific | spin_transport_modules[].boundaries |
| SpinSolverPolicy.relative_tolerance | float | 1e-8 | 1 | finite and positive | algebraic tolerance | bounded CPU lanes | spin_transport_modules[].solver.linear.relative_tolerance |
| SpinSolverPolicy.operator_version | str | fv_spin_upwind_v1 | 1 | exact lane identifier | discrete operator | lane-specific | spin_transport_modules[].solver.operator_version |
| DriftDiffusionSpinTorque.target | RegionRef | required | 1 | magnetic subset with positive Ms | torque target | canonical lane-specific | spin_torque_modules[].target |
| MixingConductanceSpinInterface.g_r_Spm2 | float | required | S/m^2 | finite and non-negative | real mixing conductance | FDM reference/native subsets | spin_transport_modules[].interfaces[].g_r_spm2 |
| PrescribedSpinOrbitTorque.xi_dl | float | required | 1 | finite | damping-like efficiency | separate prescribed-SOT lanes | spin_torque_modules[].xi_dl |
| PrescribedSpinOrbitTorque.xi_fl | float | 0 | 1 | finite | field-like efficiency | separate prescribed-SOT lanes | spin_torque_modules[].xi_fl |
| PrescribedSpinOrbitTorque.free_layer_thickness_m | float | required | m | finite and positive | FM thickness | separate prescribed-SOT lanes | spin_torque_modules[].free_layer_thickness_m |

TransportExecution also defaults to double precision and strict mode. SpinTransportMaterial accepts
optional exchange/dephasing lengths and versioned capacitance/DOS metadata. SpinDriftDiffusion
requires keyword-only id, current_source_id, domain, and materials; interfaces, boundaries, solver,
requested execution, and mode have the defaults shown by the source. Interfaces, SML reservoir,
and all five boundary constructors are typed public objects.

(physics-drift-diffusion-spin-torque-problem-ir)=
## ProblemIR

SpinDriftDiffusion lowers under spin_transport_modules[] with schema spin_transport.v1, current
source, mode, domains, materials, interfaces, boundaries, solver, requested execution, and the
one-way or reciprocal constitutive version. Canonical torque lowers with kind
drift_diffusion_spin_torque, schema drift_diffusion_spin_torque.v1, solve_id, target, and formula
transport_torque_angular_momentum.fullmag.v1.

```json
{
  "spin_transport_modules": [{
    "schema_version": "spin_transport.v1",
    "id": "spin",
    "current_source_id": "charge",
    "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
  }],
  "spin_torque_modules": [{
    "kind": "drift_diffusion_spin_torque",
    "id": "transport_torque",
    "solve_id": "spin",
    "formula_version": "transport_torque_angular_momentum.fullmag.v1"
  }]
}
```

(physics-drift-diffusion-spin-torque-round-trip-and-failure-semantics)=
## Round trip and failure semantics

Requested intent preserves signs, orientations, materials, coupling, target, and execution request.
Resolved execution records backend, device, precision, operator, realization, and capability.
Validation errors reject malformed coverage, gauges, interfaces, and coefficients. Unsupported combinations
fail closed; they are not dropped, converted to prescribed SOT, or rebound to CPU.
Opaque round trip is not execution support.

(physics-drift-diffusion-spin-torque-discrete-realization)=
## Discrete realization

| Lane | Executable boundary | Evidence boundary |
|---|---|---|
| FDM CPU Rust | M1 reference and bounded CPU-double M2; M3 authoring only | unvalidated and not production-qualified |
| FDM CPU native | strict steady one-way native_m1_v1 | M2/M3/SML/periodic/specified flux fail closed |
| FDM GPU | bounded M1 descriptors and CUDA slices | aggregate capability semantic-only/unvalidated; no fallback |
| FEM CPU | strict steady conforming H1/P1 M1 and bounded M2 | one-way torque fails; M2 torque only; unqualified |
| FEM GPU | no native transport realization | strict request rejected without CPU rebinding |

FDM M2 requires equal charge/spin domains, Dirichlet voltage gauge, no periodic spin, no transparent
cross-material interface, explicit mixing laws, reciprocal policy, and complete anisotropic charge
coefficients. FEM M2 requires one conforming domain, no internal interfaces, uniform anisotropic
coefficients, and a monolithic linear policy. Reciprocal transient is unavailable.

### Control Room and outputs

Control Room has current- and spin-transport CRUD panels with model, coupling, JSON
domain/material/interface/boundary data, solver, requested lane, qualification, and validation. Its
torque editor offers Zhang-Li, Slonczewski, and Prescribed SOT, not canonical drift-diffusion torque;
unknown variants are opaque/read-only.

M1 can carry spin potential, face spin current, reactions, balance diagnostics, torque, and
telemetry. M2 additionally carries solved charge potential, charge current, spin-current tensor,
and interface observations. The server recognizes V_electric, J_charge, spin_potential, and
spin_current_tensor. Dedicated transport visualization/export and browser materialization were not
verified.

(physics-drift-diffusion-spin-torque-implementation-mapping)=
## Implementation mapping

Python owns typed authoring and serialization. ProblemIR owns canonical intent and graph edges.
The planner validates domains, policies, and capability. Backend operators own equations and signs.
API/UI preservation does not prove runtime realization.

(physics-drift-diffusion-spin-torque-validation)=
## Validation

Python tests verify serialization, named-solve references, material validation, and round trip;
round-trip tests do not run a solver. FDM CPU tests cover one-dimensional SHE profile/sign, exact
removal at $\theta_{\mathrm{SH}}=0$, balance, and torque sign. Managed recipes exist, but this
page does not claim they ran for this revision.

Promotion requires analytic diffusion and mesh convergence; zero-SHE and sign reversal; charge
conservation/gauge invariance; spin residuals; interface and angular-momentum balance; M1 recovery
from M2; FDM/FEM common-limit comparison; and actual-device GPU parity with no-fallback provenance.

(physics-drift-diffusion-spin-torque-limitations)=
## Limitations

No drift-diffusion lane is documented as scientifically validated or production-qualified. Source,
schema, planner, unit-test, runtime, and production evidence are separate. Live field publication,
full FEM/CUDA parity, and browser rendering were not established. Experimental parameters must be
converted into these units and signs.

(physics-drift-diffusion-spin-torque-scientific-bibliography)=
## Scientific bibliography

1. S. Zhang, P. M. Levy, and A. Fert, Physical Review Letters 88, 236601 (2002), [doi:10.1103/PhysRevLett.88.236601](https://doi.org/10.1103/PhysRevLett.88.236601).
2. C. Abert et al., Scientific Reports 5, 14855 (2015), [doi:10.1038/srep14855](https://doi.org/10.1038/srep14855).
3. C. Abert et al., Scientific Reports 6, 16 (2016), [doi:10.1038/s41598-016-0019-y](https://doi.org/10.1038/s41598-016-0019-y).
4. J. Sinova et al., Reviews of Modern Physics 87, 1213 (2015), [doi:10.1103/RevModPhys.87.1213](https://doi.org/10.1103/RevModPhys.87.1213).
5. S. Zhang, Physical Review Letters 85, 393 (2000), [doi:10.1103/PhysRevLett.85.393](https://doi.org/10.1103/PhysRevLett.85.393).

(physics-drift-diffusion-spin-torque-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/spin_transport.py | class SpinDriftDiffusion | public spin transport and IR lowering |
| packages/fullmag-py/src/fullmag/model/spin_transport.py | class DriftDiffusionSpinTorque | canonical named-solve torque |
| packages/fullmag-py/src/fullmag/model/current_transport.py | class CurrentTransport | charge authoring |
| packages/fullmag-py/src/fullmag/model/spin_torque.py | class PrescribedSpinOrbitTorque | separate prescribed SOT |
| crates/fullmag-plan/src/spin_transport.rs | resolve_m1_fem_spin_transport | capability and FEM gates |
| crates/fullmag-runner/src/fdm/cpu/spin_transport.rs | solve_coupled_module | FDM CPU reference |
| backends/fdm/cpu/transport/spin_transport_v1.cpp | solve | native FDM M1 |
| backends/fdm/cpu/transport/spin_transport_validation_v1.cpp | evaluate_local_residual_gate | balance validation |
| backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_spin | FEM M1 |
| backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_reciprocal | FEM M2 |
| backends/fdm/gpu/cuda/transport/spin/device_solver.cu | solve_device | bounded CUDA slice |
