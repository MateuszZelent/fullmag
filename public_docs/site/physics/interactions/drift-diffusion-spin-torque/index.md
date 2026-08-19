---
title: Spin Hall drift-diffusion transport
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0970-spin-hall-drift-diffusion-transport.md
---

(public-docs-physics-interactions-drift-diffusion-stt)=
# Spin Hall drift-diffusion transport

`SpinDriftDiffusion` represents a solved charge-coupled spin-transport problem.
M1 is steady one-way transport with direct SHE but no inverse-SHE feedback into
charge current. M2 is steady reciprocal transport: direct SHE, inverse SHE,
polarized charge--spin coupling, and the magnetoresistive charge tensor are one
constitutive block. `DriftDiffusionSpinTorque` binds a named solved transport to
a magnetic target; it never accepts a private current or polarization shortcut.

The general `DriftDiffusionSpinTorque` capability row remains `semantic_only`.
Bounded CPU reference slices can materialize torque inside specific M2
workflows, but this does not promote the general capability to production or
validated status.

| Solver | Device | M1 | M2 | Exact current boundary |
|---|---|---|---|---|
| FDM | CPU | `reference_executable` | `reference_executable` | Strict FP64 structured-grid reference implementations exist; M2 evidence is bounded and not production-qualified. |
| FDM | GPU | `semantic_only` | `semantic_only` | IR vocabulary exists, but no qualified CUDA charge--spin solve or strict device-residency proof exists. |
| FEM | CPU | `reference_executable` | bounded `reference_executable` | M1 is conforming H1/P1 with transparent interfaces; M2 is a uniform full-domain monolithic conforming H1/P1 FP64 slice. |
| FEM | GPU | `semantic_only` | `semantic_only` | No executable/qualified device-resident spin-transport operator exists; strict GPU requests fail closed. |

(ddst-problem-statement)=
## Physical problem

Fullmag uses conventional charge current $\mathbf J_c$, charge potential $V$,
and full spin-channel splitting $\boldsymbol\mu_s$. The charge-equivalent spin
current $Q_{ia}$ is a rank-two tensor: $i$ is the flow direction and $a$ the
spin-polarization direction. It is not an unlabelled three-vector.

M1 solves charge first and then spin for the same authored source. M2 solves
the reciprocal monolithic block. Only exchange-rotation and transverse-
dephasing reactions transfer angular momentum to magnetization; spin-flip
relaxation belongs to a separate reservoir.

(ddst-governing-equations)=
## Governing equations

The public convention fixes the two gradient variables before either
constitutive block is assembled:

```{math}
:label: eq-ddst-gradients
E_i=-\partial_iV,\qquad
G_{ia}=-\frac12\partial_i\mu_{s,a}.
```

M1 is

```{math}
:label: eq-ddst-m1
J_{c,i}=\sigma E_i,\qquad
Q_{ia}=\sigma_sG_{ia}+P\sigma E_i m_a
+\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k.
```

M1 deliberately omits inverse SHE and reciprocal longitudinal feedback. M2
first forms the complete three-dimensional magnetoresistive current

```{math}
:label: eq-ddst-jmr
\mathbf J_{\mathrm{mr}}
=\sigma_{\perp}\mathbf E
+(\sigma_{\parallel}-\sigma_{\perp})
  (\mathbf m\mathbin{\cdot}\mathbf E)\mathbf m
+\sigma_{\mathrm{AHE}}\,\mathbf m\mathbin{\times}\mathbf E.
```

The symmetric anisotropic term contains AMR and PHE; the antisymmetric term
contains AHE. The scalar $\sigma$ below remains the reciprocal reference
conductivity and is not replaced by $\sigma_{\parallel}$ or
$\sigma_{\perp}$. The full coupled block is

```{math}
:label: eq-ddst-m2
\begin{aligned}
J_{c,i}&=J_{\mathrm{mr},i}+P\sigma m_aG_{ia}
+\theta_{\mathrm{SH}}\sigma\epsilon_{ija}G_{ja},\\
Q_{ia}&=\sigma_sG_{ia}+P\sigma E_i m_a
+\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k.
\end{aligned}
```

For the public tensor parameterization, positivity requires

```{math}
:label: eq-ddst-schur
\min(\sigma_{\parallel},\sigma_{\perp})\sigma_s-P^2\sigma^2>0.
```

The three volumetric reaction laws are

```{math}
:label: eq-ddst-reactions
\begin{aligned}
\mathbf R_{\mathrm{sf}}
  &=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\boldsymbol\mu_s,\\
\mathbf R_J
  &=\frac{\sigma_s}{2\lambda_J^2}
    (\boldsymbol\mu_s\mathbin{\times}\mathbf m),\\
\mathbf R_\phi
  &=\frac{\sigma_s}{2\lambda_\phi^2}
    \mathbf m\mathbin{\times}
    (\boldsymbol\mu_s\mathbin{\times}\mathbf m).
\end{aligned}
```

An absent $\lambda_J$ or $\lambda_\phi$ disables that reaction; zero is never
a valid length. The quasistatic spin balance and magnetic-transfer torque are

```{math}
:label: eq-ddst-balance-torque
\partial_iQ_{ia}=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a},\qquad
\mathbf T_{\mathrm{tr},G}=-\frac{\gamma_e}{M_s}\frac{\hbar}{2e}
(\mathbf R_J+\mathbf R_\phi).
```

(ddst-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $V$ | charge electrochemical potential | $\mathrm{V}$ |
| $\boldsymbol\mu_s$ | full spin-channel splitting | $\mathrm{V}$ |
| $E_i$ | electric field | $\mathrm{V\,m^{-1}}$ |
| $G_{ia}$ | negative half-gradient of spin voltage | $\mathrm{V\,m^{-1}}$ |
| $J_{c,i}$ | conventional charge-current density | $\mathrm{A\,m^{-2}}$ |
| $Q_{ia}$ | charge-equivalent spin-current tensor | $\mathrm{A\,m^{-2}}$ |
| $\sigma$ | reciprocal scalar charge conductivity | $\mathrm{S\,m^{-1}}$ |
| $\sigma_s$ | spin conductivity | $\mathrm{S\,m^{-1}}$ |
| $\sigma_{\parallel}$ | charge conductivity parallel to magnetization | $\mathrm{S\,m^{-1}}$ |
| $\sigma_{\perp}$ | charge conductivity transverse to magnetization | $\mathrm{S\,m^{-1}}$ |
| $\sigma_{\mathrm{AHE}}$ | anomalous-Hall antisymmetric conductivity | $\mathrm{S\,m^{-1}}$ |
| $P$ | signed charge--spin polarization | $1$ |
| $\theta_{\mathrm{SH}}$ | signed spin-Hall angle | $1$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf J_{\mathrm{mr}}$ | magnetoresistive charge current | $\mathrm{A\,m^{-2}}$ |
| $\lambda_{\mathrm{sf}}$ | spin-flip diffusion length | $\mathrm{m}$ |
| $\lambda_J$ | transverse exchange length | $\mathrm{m}$ |
| $\lambda_\phi$ | transverse dephasing length | $\mathrm{m}$ |
| $\mathbf R_{\mathrm{sf}}$ | spin-flip reaction density | $\mathrm{A\,m^{-3}}$ |
| $\mathbf R_J$ | transverse exchange reaction density | $\mathrm{A\,m^{-3}}$ |
| $\mathbf R_\phi$ | transverse dephasing reaction density | $\mathrm{A\,m^{-3}}$ |
| $\epsilon_{ijk}$ | right-handed Levi--Civita symbol | $1$ |
| $i,j,k$ | Cartesian flow indices | $1$ |
| $a$ | spin-polarization index | $1$ |
| $\gamma_e$ | positive angular gyromagnetic magnitude | $\mathrm{s^{-1}\,T^{-1}}$ |
| $M_s$ | target saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | positive elementary charge | $\mathrm{C}$ |
| $\mathbf T_{\mathrm{tr},G}$ | transport Gilbert-source torque | $\mathrm{s^{-1}}$ |

(ddst-assumptions-and-validity)=
## Assumptions and validity limits

The model is diffusive and electroquasistatic. It excludes ballistic transport,
first-principles tunnelling, full Maxwell displacement current, and implicit
spin pumping. Every active diffusion/reaction length is positive; a disabled
reaction is represented explicitly, not by a zero length. A charge gauge is
mandatory. Missing boundary coverage, incompatible interface laws, non-finite
or non-positive material coefficients, and a non-positive M2 Schur complement
are validation errors.

The bounded FEM M1 lane accepts transparent interfaces in one conforming H1/P1
space. Mixing conductance, SML, specified spin flux, and periodic spin
boundaries fail closed there. The bounded FEM M2 lane is still narrower: one
uniform anisotropic charge tensor, one uniform spin material, full conforming
domain, a Dirichlet charge reference, no internal spin interface, FP64 CPU,
strict mode. GPU requests do not fall back.

(ddst-python-api)=
## Python API

The public stage-first builder can register current transport, spin transport,
and the torque consumer. The following bounded FEM M2 authoring cell uses the
current public classes; constructing it does not claim a qualified physical
benchmark.

```python
# %% Study, backend, geometry, and material
import fullmag as fm

study = fm.study("bounded-fem-m2-doc")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(30e-9, 20e-9, 4e-9), name="strip")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Typed transport region and boundary references
region = fm.RegionRef("strip")
x_min = fm.SurfaceRef("strip", "x_min", (-1.0, 0.0, 0.0))
x_max = fm.SurfaceRef("strip", "x_max", (1.0, 0.0, 0.0))
sides = tuple(
    fm.SurfaceRef("strip", name, normal)
    for name, normal in (
        ("y_min", (0.0, -1.0, 0.0)),
        ("y_max", (0.0, 1.0, 0.0)),
        ("z_min", (0.0, 0.0, -1.0)),
        ("z_max", (0.0, 0.0, 1.0)),
    )
)
operator = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"

# %% Reciprocal charge and spin modules
charge = study.current_transport(
    name="charge",
    model="ohmic_poisson",
    coupling="bidirectional",
    domain=(region,),
    materials=(
        fm.ChargeTransportMaterialAssignment(
            region,
            fm.ChargeTransportMaterial(
                sigma_Spm=4.0e6,
                sigma_parallel_Spm=4.4e6,
                sigma_perpendicular_Spm=4.0e6,
                sigma_AHE_Spm=0.2e6,
            ),
        ),
    ),
    boundaries=(
        fm.VoltageElectrode("left", (x_min,), potential_V=0.0),
        fm.VoltageElectrode("right", (x_max,), potential_V=1.0e-3),
        fm.ChargeInsulating("sides", sides),
    ),
    gauge=fm.ChargePotentialGauge("dirichlet_reference"),
    solver=fm.ChargeSolverPolicy(
        engine="block_gmres",
        relative_tolerance=1.0e-8,
        absolute_tolerance=0.0,
        max_iterations=200,
        operator_version=operator,
    ),
)
spin = study.spin_transport(
    fm.SpinDriftDiffusion(
        id="spin",
        current_source_id=charge.name,
        domain=(region,),
        materials=(
            fm.SpinTransportMaterialAssignment(
                region,
                fm.SpinTransportMaterial(
                    sigma_s_Spm=5.0e6,
                    polarization_p=0.2,
                    theta_sh=0.1,
                    lambda_sf_m=2.0e-9,
                    lambda_j_m=1.0e-9,
                    lambda_phi_m=1.0e-9,
                ),
            ),
        ),
        solver=fm.SpinSolverPolicy(
            engine="gmres",
            relative_tolerance=1.0e-8,
            absolute_tolerance=0.0,
            max_iterations=200,
            operator_version=operator,
        ),
        requested_execution=fm.TransportExecution(
            discretization="fem",
            device="cpu",
            precision="double",
            execution_mode="strict",
        ),
    )
)
study.spin_torque(fm.DriftDiffusionSpinTorque("transport_torque", spin.id, region))

# %% Ordered LLG stage
study.stages.add_run(1.0e-15, stage_id="m2_run")
```

### Parameter reference

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SpinDriftDiffusion.id` | `str` | required | $1$ | non-empty and unique | stable spin-solve identity | all authoring lanes; execution is capability-gated | `spin_transport_modules[].id` |
| `SpinDriftDiffusion.current_source_id` | `str` | required | $1$ | names one compatible `CurrentTransport` | charge-source binding | CPU M1/M2 reference slices | `spin_transport_modules[].current_source_id` |
| `SpinDriftDiffusion.domain` | `Sequence[RegionRef]` | required | $1$ | non-empty and resolvable | solved spin domain | lane-specific mesh/interface limits | `spin_transport_modules[].domain` |
| `SpinDriftDiffusion.materials` | `Sequence[SpinTransportMaterialAssignment]` | required | $1$ | non-empty typed assignments with complete positive dissipative coefficients | spin constitutive-data assignments | CPU reference slices; GPU semantic-only | `spin_transport_modules[].materials` |
| `SpinDriftDiffusion.interfaces` | `Sequence[SpinInterface]` | `()` | $\mathrm{S\,m^{-2}}$ for conductances | oriented and non-overlapping; unsupported laws fail closed | transparent or mixing interface contract | FDM CPU broader reference; bounded FEM accepts transparent/no internal interface only | `spin_transport_modules[].interfaces` |
| `SpinDriftDiffusion.boundaries` | `Sequence[SpinBoundary]` | `()` | $\mathrm{V}$ or $\mathrm{A\,m^{-2}}$ by variant | exact external-face ownership; unassigned policy is explicit | spin boundary conditions | CPU reference slices with lane-specific variants | `spin_transport_modules[].boundaries` |
| `SpinDriftDiffusion.solver` | `SpinSolverPolicy` | `SpinSolverPolicy()` | $1$ | positive iteration/tolerance data and compatible operator | spatial spin solve policy | M1/M2 CPU reference slices | `spin_transport_modules[].solver` |
| `SpinDriftDiffusion.requested_execution` | `TransportExecution` | `fdm/cpu/double/strict` | $1$ | enumerated discretization, device, precision, and mode | requested lane | GPU and unsupported combinations fail closed | `spin_transport_modules[].requested_execution` |
| `SpinDriftDiffusion.mode` | `steady or transient` | `steady` | $1$ | transient requires physical capacitance/DOS on every material | temporal transport regime | this page's M1/M2 are steady | `spin_transport_modules[].mode` |
| `DriftDiffusionSpinTorque.id` | `str` | required | $1$ | non-empty and unique | torque-module identity | bounded CPU M2 workflows; general capability remains semantic-only | `spin_torque_modules[].id` |
| `DriftDiffusionSpinTorque.solve_id` | `str` | required | $1$ | references an existing `SpinDriftDiffusion` | solved-transport binding | bounded CPU M2 workflows | `spin_torque_modules[].solve_id` |
| `DriftDiffusionSpinTorque.target` | `RegionRef` | required | $1$ | resolvable magnetic target | torque recipient | bounded CPU M2 workflows | `spin_torque_modules[].target` |

The aggregate rows above are not substitutes for the scalar fields that define
the constitutive law. The following rows complete the public records used by
the example and the optional M1/M2 reaction fields.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.name` | `str` | required | $1$ | non-empty and unique | charge-module identity | all authoring lanes | `current_modules[].name` |
| `CurrentTransport.model` | `str` | `prescribed_density` | $1$ | `prescribed_density` or `ohmic_poisson`; bidirectional lowers to magnetoresistive Poisson | charge model | M1/M2 CPU reference slices | `current_modules[].model` |
| `CurrentTransport.current_density` | `Sequence[float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | three finite components; required only for prescribed density | prescribed current vector | prescribed-source lanes, not solved M2 | `current_modules[].current_density` |
| `CurrentTransport.solve_region` | `str or None` | `None` | $1$ | non-empty when supplied | legacy prescribed-source region | prescribed-source lanes | `current_modules[].solve_region` |
| `CurrentTransport.conductivity_s_per_m` | `float or None` | `None` | $\mathrm{S\,m^{-1}}$ | finite and positive when supplied | legacy scalar conductivity | prescribed-source metadata | `current_modules[].conductivity_s_per_m` |
| `CurrentTransport.coupling` | `str` | `one_way` | $1$ | one_way or bidirectional | selects M1 or reciprocal M2 | CPU reference slices | `current_modules[].coupling` |
| `CurrentTransport.domain` | `Sequence[RegionRef]` | `()` | $1$ | non-empty for solved transport | charge solve domain | CPU reference slices | `current_modules[].domain` |
| `CurrentTransport.materials` | `Sequence[ChargeTransportMaterialAssignment]` | `()` | $1$ | complete typed assignment coverage | charge constitutive assignments | CPU reference slices | `current_modules[].materials` |
| `CurrentTransport.boundaries` | `Sequence[ChargeBoundary]` | `()` | $1$ | typed non-overlapping surface ownership | charge boundary set | CPU reference slices | `current_modules[].boundaries` |
| `CurrentTransport.gauge` | `ChargePotentialGauge or None` | `None` | $1$ | mandatory for solved transport | potential null-space policy | CPU reference slices | `current_modules[].gauge` |
| `CurrentTransport.solver` | `ChargeSolverPolicy or None` | `None` | $1$ | operator and engine must match coupling | charge linear/block policy | CPU reference slices | `current_modules[].solver` |
| `CurrentTransport.time_envelope` | `TimeEnvelope or None` | `None` | $1$ | canonical finite envelope | stage-time source multiplier | lane-specific | `current_modules[].time_envelope` |
| `CurrentTransport.conservative_current_view` | `ConservativeCurrentView or None` | `None` | $1$ | typed immutable RT0 request | optional conservative current view | bounded FEM CPU only | `current_modules[].conservative_current_view` |
| `ChargeTransportMaterialAssignment.region` | `RegionRef` | required | $1$ | resolvable charge region | assignment target | CPU reference slices | `current_modules[].materials[].region` |
| `ChargeTransportMaterialAssignment.material` | `ChargeTransportMaterial` | required | $1$ | typed material | assigned charge tensor | CPU reference slices | `current_modules[].materials[].material` |
| `ChargeTransportMaterial.sigma_Spm` | `float` | required | $\mathrm{S\,m^{-1}}$ | finite and positive | reciprocal scalar conductivity $\sigma$ | M1/M2 CPU reference slices | `current_modules[].materials[].material.sigma_Spm` |
| `ChargeTransportMaterial.sigma_parallel_Spm` | `float or None` | `None` | $\mathrm{S\,m^{-1}}$ | positive; authored with both other tensor fields | $\sigma_\parallel$ | reciprocal M2 CPU reference slices | `current_modules[].materials[].material.sigma_parallel_Spm` |
| `ChargeTransportMaterial.sigma_perpendicular_Spm` | `float or None` | `None` | $\mathrm{S\,m^{-1}}$ | positive; authored with both other tensor fields | $\sigma_\perp$ | reciprocal M2 CPU reference slices | `current_modules[].materials[].material.sigma_perpendicular_Spm` |
| `ChargeTransportMaterial.sigma_AHE_Spm` | `float or None` | `None` | $\mathrm{S\,m^{-1}}$ | finite and signed; authored with both tensor diagonals | $\sigma_\mathrm{AHE}$ | reciprocal M2 CPU reference slices | `current_modules[].materials[].material.sigma_AHE_Spm` |
| `VoltageElectrode.id` | `str` | required | $1$ | non-empty and unique | electrode identity | solved CPU lanes | `current_modules[].boundaries[].id` |
| `VoltageElectrode.surfaces` | `Sequence[SurfaceRef]` | required | $1$ | non-empty typed surfaces | Dirichlet support | solved CPU lanes | `current_modules[].boundaries[].surfaces` |
| `VoltageElectrode.potential_V` | `float` | required | $\mathrm{V}$ | finite | prescribed potential | solved CPU lanes | `current_modules[].boundaries[].potential_V` |
| `ChargeInsulating.id` | `str` | required | $1$ | non-empty and unique | insulating-boundary identity | solved CPU lanes | `current_modules[].boundaries[].id` |
| `ChargeInsulating.surfaces` | `Sequence[SurfaceRef]` | required | $1$ | non-empty typed surfaces | zero-normal-current support | solved CPU lanes | `current_modules[].boundaries[].surfaces` |
| `ChargePotentialGauge.kind` | `str` | required | $1$ | `dirichlet_reference` or `zero_mean` | charge-potential gauge | CPU reference slices | `current_modules[].gauge` |
| `ChargeSolverPolicy.engine` | `str` | `cg` | $1$ | `cg` or `block_gmres`; must match operator | linear/block engine | CPU reference slices | `current_modules[].solver.engine` |
| `ChargeSolverPolicy.relative_tolerance` | `float` | `1e-10` | $1$ | finite and positive | relative linear tolerance | CPU reference slices | `current_modules[].solver.linear.relative_tolerance` |
| `ChargeSolverPolicy.absolute_tolerance` | `float` | `0.0` | $1$ | finite and non-negative | absolute linear tolerance | CPU reference slices | `current_modules[].solver.linear.absolute_tolerance` |
| `ChargeSolverPolicy.max_iterations` | `int` | `10000` | $1$ | positive integer | iteration cap | CPU reference slices | `current_modules[].solver.linear.max_iterations` |
| `ChargeSolverPolicy.physical_residual_version` | `str` | `charge_balance_integrated_l2.v1` | $1$ | exact version compatible with engine/operator | physical residual contract | CPU reference slices | `current_modules[].solver.physical_residual_version` |
| `ChargeSolverPolicy.operator_version` | `str` | `fv_charge_harmonic_v1` | $1$ | exact supported operator; M2 requires reciprocal version | discrete charge/block operator | CPU reference slices | `current_modules[].solver.operator_version` |
| `SpinTransportMaterialAssignment.region` | `RegionRef` | required | $1$ | resolvable spin region | assignment target | CPU reference slices | `spin_transport_modules[].materials[].region` |
| `SpinTransportMaterialAssignment.material` | `SpinTransportMaterial` | required | $1$ | typed material | assigned spin coefficients | CPU reference slices | `spin_transport_modules[].materials[].material` |
| `SpinTransportMaterial.sigma_s_Spm` | `float` | required | $\mathrm{S\,m^{-1}}$ | finite and positive | spin conductivity $\sigma_s$ | CPU reference slices | `spin_transport_modules[].materials[].material.sigma_s_Spm` |
| `SpinTransportMaterial.polarization_p` | `float` | required | $1$ | finite in $[-1,1]$ | signed $P$ | CPU reference slices | `spin_transport_modules[].materials[].material.polarization_p` |
| `SpinTransportMaterial.theta_sh` | `float` | required | $1$ | finite and signed | spin-Hall angle | CPU reference slices | `spin_transport_modules[].materials[].material.theta_sh` |
| `SpinTransportMaterial.lambda_sf_m` | `float` | required | $\mathrm{m}$ | finite and positive | spin-flip length | CPU reference slices | `spin_transport_modules[].materials[].material.lambda_sf_m` |
| `SpinTransportMaterial.lambda_j_m` | `float or None` | `None` | $\mathrm{m}$ | positive when enabled; None lowers to disabled | exchange-rotation length | CPU reference slices | `spin_transport_modules[].materials[].material.lambda_j_m` |
| `SpinTransportMaterial.lambda_phi_m` | `float or None` | `None` | $\mathrm{m}$ | positive when enabled; None lowers to disabled | transverse-dephasing length | CPU reference slices | `spin_transport_modules[].materials[].material.lambda_phi_m` |
| `SpinSolverPolicy.engine` | `str` | `auto` | $1$ | non-empty; M2 bounded slice requires compatible GMRES policy | spin/block engine | CPU reference slices | `spin_transport_modules[].solver.engine` |
| `SpinSolverPolicy.relative_tolerance` | `float` | `1e-8` | $1$ | finite and positive | relative tolerance | CPU reference slices | `spin_transport_modules[].solver.linear.relative_tolerance` |
| `SpinSolverPolicy.absolute_tolerance` | `float` | `0.0` | $1$ | finite and non-negative | absolute tolerance | CPU reference slices | `spin_transport_modules[].solver.linear.absolute_tolerance` |
| `SpinSolverPolicy.max_iterations` | `int` | `500` | $1$ | positive integer | iteration cap | CPU reference slices | `spin_transport_modules[].solver.linear.max_iterations` |
| `SpinSolverPolicy.operator_version` | `str` | `fv_spin_upwind_v1` | $1$ | exact lane-compatible version | spin or coupled operator | CPU reference slices | `spin_transport_modules[].solver.operator_version` |
| `SpinSolverPolicy.default_external_boundary` | `str` | `spin_insulating` | $1$ | `spin_insulating` or `reject_unassigned` | unassigned-face policy | CPU reference slices | `spin_transport_modules[].solver.default_external_boundary` |
| `SpinSolverPolicy.reciprocal_nonlinear` | `ReciprocalNonlinearSolverPolicy or None` | `None` | $1$ | typed policy when present | optional nonlinear M2 outer solve | FDM CPU reference scope | `spin_transport_modules[].solver.reciprocal_nonlinear` |
| `TransportExecution.discretization` | `str` | `fdm` | $1$ | `fdm`, `fem`, or `auto` | requested discretization | all authoring lanes | `spin_transport_modules[].requested_execution.discretization` |
| `TransportExecution.device` | `str` | `cpu` | $1$ | `cpu`, `gpu`, or `auto` | requested device | all authoring lanes | `spin_transport_modules[].requested_execution.device` |
| `TransportExecution.precision` | `str` | `double` | $1$ | `single` or `double`; bounded M2 is double only | requested precision | all authoring lanes | `spin_transport_modules[].requested_execution.precision` |
| `TransportExecution.execution_mode` | `str` | `strict` | $1$ | `strict` or `extended` | fallback/extension policy | all authoring lanes | `spin_transport_modules[].requested_execution.execution_mode` |

(ddst-problem-ir)=
## Python to ProblemIR representation

`SpinDriftDiffusion.to_ir(coupling=charge.coupling)` emits a typed
`spin_transport.v1` record. M1 resolves
`transport_constitutive.one_way.fullmag.v1`; M2 resolves
`transport_constitutive.reciprocal.fullmag.v1`. Coupling is owned by the named
`CurrentTransport`; the spin object cannot override it independently.

`DriftDiffusionSpinTorque.to_ir_module()` emits
`kind=drift_diffusion_spin_torque`, `solve_id`, target, and
`transport_torque_angular_momentum.fullmag.v1`. The torque record stores no
duplicated current, spin Hall angle, or solver policy.

Executing the exact Python block above under script capture and calling
`LoadedProblem.to_ir(..., include_geometry_assets=False)` produces the complete
canonical ProblemIR document below. The no-asset mode sets only optional
generated geometry assets to `null`; geometry, material, magnet, current, spin,
torque, study, graph, and provenance records are all serialized.

```json
{
  "ir_version": "0.3.0",
  "problem_meta": {
    "name": "bounded-fem-m2-doc",
    "description": null,
    "script_language": "python",
    "script_source": "# %% Study, backend, geometry, and material\nimport fullmag as fm\n\nstudy = fm.study(\"bounded-fem-m2-doc\")\nstudy.engine(\"fem\")\nstudy.device(\"cpu\", precision=\"double\")\nstudy.mode(\"strict\")\nbody = study.geometry(fm.Box(30e-9, 20e-9, 4e-9), name=\"strip\")\nbody.Ms = 8.0e5\nbody.Aex = 13.0e-12\nbody.alpha = 0.02\nbody.m = fm.texture.uniform(1.0, 0.0, 0.0)\n\n# %% Typed transport region and boundary references\nregion = fm.RegionRef(\"strip\")\nx_min = fm.SurfaceRef(\"strip\", \"x_min\", (-1.0, 0.0, 0.0))\nx_max = fm.SurfaceRef(\"strip\", \"x_max\", (1.0, 0.0, 0.0))\nsides = tuple(\n    fm.SurfaceRef(\"strip\", name, normal)\n    for name, normal in (\n        (\"y_min\", (0.0, -1.0, 0.0)),\n        (\"y_max\", (0.0, 1.0, 0.0)),\n        (\"z_min\", (0.0, 0.0, -1.0)),\n        (\"z_max\", (0.0, 0.0, 1.0)),\n    )\n)\noperator = \"fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1\"\n\n# %% Reciprocal charge and spin modules\ncharge = study.current_transport(\n    name=\"charge\",\n    model=\"ohmic_poisson\",\n    coupling=\"bidirectional\",\n    domain=(region,),\n    materials=(\n        fm.ChargeTransportMaterialAssignment(\n            region,\n            fm.ChargeTransportMaterial(\n                sigma_Spm=4.0e6,\n                sigma_parallel_Spm=4.4e6,\n                sigma_perpendicular_Spm=4.0e6,\n                sigma_AHE_Spm=0.2e6,\n            ),\n        ),\n    ),\n    boundaries=(\n        fm.VoltageElectrode(\"left\", (x_min,), potential_V=0.0),\n        fm.VoltageElectrode(\"right\", (x_max,), potential_V=1.0e-3),\n        fm.ChargeInsulating(\"sides\", sides),\n    ),\n    gauge=fm.ChargePotentialGauge(\"dirichlet_reference\"),\n    solver=fm.ChargeSolverPolicy(\n        engine=\"block_gmres\",\n        relative_tolerance=1.0e-8,\n        absolute_tolerance=0.0,\n        max_iterations=200,\n        operator_version=operator,\n    ),\n)\nspin = study.spin_transport(\n    fm.SpinDriftDiffusion(\n        id=\"spin\",\n        current_source_id=charge.name,\n        domain=(region,),\n        materials=(\n            fm.SpinTransportMaterialAssignment(\n                region,\n                fm.SpinTransportMaterial(\n                    sigma_s_Spm=5.0e6,\n                    polarization_p=0.2,\n                    theta_sh=0.1,\n                    lambda_sf_m=2.0e-9,\n                    lambda_j_m=1.0e-9,\n                    lambda_phi_m=1.0e-9,\n                ),\n            ),\n        ),\n        solver=fm.SpinSolverPolicy(\n            engine=\"gmres\",\n            relative_tolerance=1.0e-8,\n            absolute_tolerance=0.0,\n            max_iterations=200,\n            operator_version=operator,\n        ),\n        requested_execution=fm.TransportExecution(\n            discretization=\"fem\",\n            device=\"cpu\",\n            precision=\"double\",\n            execution_mode=\"strict\",\n        ),\n    )\n)\nstudy.spin_torque(fm.DriftDiffusionSpinTorque(\"transport_torque\", spin.id, region))\n\n# %% Ordered LLG stage\nstudy.stages.add_run(1.0e-15, stage_id=\"m2_run\")\n",
    "script_api_version": "0.3.0",
    "serializer_version": "0.3.0",
    "entrypoint_kind": "flat_workspace",
    "source_hash": "60a62b485bb5b7c4edfdc6d99bef0eef6fe82cb73cd131ee61c2bc85d77a920c",
    "runtime_metadata": {
      "interactive_session_requested": true,
      "script_api_surface": "study",
      "runtime_selection": {
        "backend": "fem",
        "device": "cpu",
        "gpu_count": 0,
        "device_index": null,
        "cpu_threads": null,
        "execution_mode": "strict",
        "execution_precision": "double"
      },
      "study_pipeline": {
        "version": "study_pipeline.v1",
        "nodes": [
          {
            "id": "m2_run",
            "label": "",
            "enabled": true,
            "source": "script_imported",
            "node_kind": "primitive",
            "stage_kind": "run",
            "payload": {
              "kind": "run",
              "entrypoint_kind": "flat_run",
              "stage_id": "m2_run",
              "until_seconds": "1e-15"
            }
          }
        ]
      },
      "domain_frame": {
        "declared_universe": null,
        "object_bounds_min": [
          -1.5e-08,
          -1e-08,
          -2e-09
        ],
        "object_bounds_max": [
          1.5e-08,
          1e-08,
          2e-09
        ],
        "mesh_bounds_min": null,
        "mesh_bounds_max": null,
        "effective_extent": [
          3e-08,
          2e-08,
          4e-09
        ],
        "effective_center": [
          0.0,
          0.0,
          0.0
        ],
        "effective_source": "object_union_bounds"
      },
      "model_builder": {
        "schema_version": "model_builder.v1",
        "source_kind": "flat_script",
        "entrypoint_kind": "flat_workspace",
        "script_api_surface": "study",
        "editable_via_ui": true,
        "editable_scopes": [
          "runtime",
          "geometry",
          "materials",
          "energies",
          "study",
          "outputs",
          "current_transport",
          "spin_transport",
          "meshing",
          "spin_torque"
        ],
        "canonical_script_strategy": "canonical_rewrite",
        "problem": {
          "name": "bounded-fem-m2-doc",
          "description": null,
          "runtime": {
            "backend": "fem",
            "device": "cpu",
            "gpu_count": 0,
            "device_index": null,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
          },
          "universe": null,
          "domain_frame": {
            "declared_universe": null,
            "object_bounds_min": [
              -1.5e-08,
              -1e-08,
              -2e-09
            ],
            "object_bounds_max": [
              1.5e-08,
              1e-08,
              2e-09
            ],
            "mesh_bounds_min": null,
            "mesh_bounds_max": null,
            "effective_extent": [
              3e-08,
              2e-08,
              4e-09
            ],
            "effective_center": [
              0.0,
              0.0,
              0.0
            ],
            "effective_source": "object_union_bounds"
          },
          "geometry": [
            {
              "name": "strip_geom",
              "kind": "box",
              "size": [
                3e-08,
                2e-08,
                4e-09
              ]
            }
          ],
          "regions": [
            {
              "name": "strip",
              "geometry": "strip_geom"
            }
          ],
          "materials": [
            {
              "name": "mat_strip",
              "saturation_magnetisation": 800000.0,
              "exchange_stiffness": 1.3e-11,
              "damping": 0.02,
              "uniaxial_anisotropy": null,
              "uniaxial_anisotropy_k2": null,
              "anisotropy_axis": null,
              "cubic_anisotropy_kc1": null,
              "cubic_anisotropy_kc2": null,
              "cubic_anisotropy_kc3": null,
              "cubic_anisotropy_axis1": null,
              "cubic_anisotropy_axis2": null,
              "interfacial_dmi": null,
              "bulk_dmi": null,
              "ms_field": null,
              "a_field": null,
              "alpha_field": null,
              "ku_field": null,
              "ku2_field": null,
              "kc1_field": null,
              "kc2_field": null,
              "kc3_field": null,
              "dind_field": null,
              "dbulk_field": null
            }
          ],
          "magnets": [
            {
              "name": "strip",
              "region": "strip",
              "material": "mat_strip",
              "initial_magnetization": {
                "kind": "preset_texture",
                "preset_kind": "uniform",
                "preset_params": {
                  "direction": [
                    1.0,
                    0.0,
                    0.0
                  ]
                },
                "mapping": {
                  "space": "object",
                  "projection": "object_local",
                  "clamp_mode": "none"
                },
                "texture_transform": {
                  "translation": [
                    0.0,
                    0.0,
                    0.0
                  ],
                  "rotation_quat": [
                    0.0,
                    0.0,
                    0.0,
                    1.0
                  ],
                  "scale": [
                    1.0,
                    1.0,
                    1.0
                  ],
                  "pivot": [
                    0.0,
                    0.0,
                    0.0
                  ]
                },
                "ui_label": null,
                "preview_proxy": "none"
              },
              "mesh_recipe": null,
              "absorbing_boundary": null
            }
          ],
          "energy_terms": [
            {
              "kind": "exchange"
            },
            {
              "kind": "demag",
              "realization": "auto"
            }
          ],
          "current_modules": [
            {
              "kind": "current_transport",
              "name": "charge",
              "model": "magnetoresistive_poisson",
              "coupling": "bidirectional",
              "domain": [
                {
                  "object_id": "strip"
                }
              ],
              "materials": [
                {
                  "region": {
                    "object_id": "strip"
                  },
                  "material": {
                    "sigma_Spm": 4000000.0,
                    "sigma_parallel_Spm": 4400000.0,
                    "sigma_perpendicular_Spm": 4000000.0,
                    "sigma_AHE_Spm": 200000.0
                  }
                }
              ],
              "boundaries": [
                {
                  "kind": "voltage_electrode",
                  "id": "left",
                  "surfaces": [
                    {
                      "object_id": "strip",
                      "surface_id": "x_min",
                      "orientation": [
                        -1.0,
                        0.0,
                        0.0
                      ]
                    }
                  ],
                  "potential_V": 0.0
                },
                {
                  "kind": "voltage_electrode",
                  "id": "right",
                  "surfaces": [
                    {
                      "object_id": "strip",
                      "surface_id": "x_max",
                      "orientation": [
                        1.0,
                        0.0,
                        0.0
                      ]
                    }
                  ],
                  "potential_V": 0.001
                },
                {
                  "kind": "insulating",
                  "id": "sides",
                  "surfaces": [
                    {
                      "object_id": "strip",
                      "surface_id": "y_min",
                      "orientation": [
                        0.0,
                        -1.0,
                        0.0
                      ]
                    },
                    {
                      "object_id": "strip",
                      "surface_id": "y_max",
                      "orientation": [
                        0.0,
                        1.0,
                        0.0
                      ]
                    },
                    {
                      "object_id": "strip",
                      "surface_id": "z_min",
                      "orientation": [
                        0.0,
                        0.0,
                        -1.0
                      ]
                    },
                    {
                      "object_id": "strip",
                      "surface_id": "z_max",
                      "orientation": [
                        0.0,
                        0.0,
                        1.0
                      ]
                    }
                  ]
                }
              ],
              "gauge": "dirichlet_reference",
              "solver": {
                "engine": "block_gmres",
                "linear": {
                  "relative_tolerance": 1e-08,
                  "absolute_tolerance": 0.0,
                  "max_iterations": 200
                },
                "physical_residual_version": "transport_balance_integrated_l2.v1",
                "operator_version": "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
              }
            }
          ],
          "field_drives": [],
          "planar_monitors": [],
          "excitation_analysis": null,
          "study": {
            "kind": "time_evolution",
            "dynamics": {
              "kind": "llg",
              "gyromagnetic_ratio": 221100.0,
              "integrator": "auto",
              "fixed_timestep": null
            },
            "sampling": {
              "outputs": []
            }
          },
          "discretization": {
            "fdm": null,
            "fem": {
              "order": 1,
              "hmax": 5.6858023018340375e-09,
              "mesh": null
            },
            "hybrid": null
          },
          "mesh_workflow": null,
          "spin_torque": null,
          "spin_torque_modules": [
            {
              "kind": "drift_diffusion_spin_torque",
              "schema_version": "drift_diffusion_spin_torque.v1",
              "id": "transport_torque",
              "solve_id": "spin",
              "target": {
                "object_id": "strip"
              },
              "formula_version": "transport_torque_angular_momentum.fullmag.v1"
            }
          ],
          "temperature": null
        },
        "study_pipeline": {
          "version": "study_pipeline.v1",
          "nodes": [
            {
              "id": "m2_run",
              "label": "",
              "enabled": true,
              "source": "script_imported",
              "node_kind": "primitive",
              "stage_kind": "run",
              "payload": {
                "kind": "run",
                "entrypoint_kind": "flat_run",
                "stage_id": "m2_run",
                "until_seconds": "1e-15"
              }
            }
          ]
        }
      },
      "script_sync": {
        "schema_version": "script_sync.v1",
        "source_kind": "flat_script",
        "entrypoint_kind": "flat_workspace",
        "source_of_truth": "model_builder",
        "rewrite_strategy": "canonical_rewrite",
        "editable_scopes": [
          "runtime",
          "geometry",
          "materials",
          "energies",
          "study",
          "outputs",
          "current_transport",
          "spin_transport",
          "meshing",
          "spin_torque"
        ],
        "phase": "round_trip_canonical_sync",
        "study_pipeline_version": "study_pipeline.v1",
        "study_pipeline_node_count": 1
      }
    },
    "backend_revision": null,
    "seeds": []
  },
  "geometry": {
    "entries": [
      {
        "name": "strip_geom",
        "kind": "box",
        "size": [
          3e-08,
          2e-08,
          4e-09
        ]
      }
    ]
  },
  "geometry_assets": null,
  "regions": [
    {
      "name": "strip",
      "geometry": "strip_geom"
    }
  ],
  "object_regions": [],
  "materials": [
    {
      "name": "mat_strip",
      "saturation_magnetisation": 800000.0,
      "exchange_stiffness": 1.3e-11,
      "damping": 0.02,
      "uniaxial_anisotropy": null,
      "uniaxial_anisotropy_k2": null,
      "anisotropy_axis": null,
      "cubic_anisotropy_kc1": null,
      "cubic_anisotropy_kc2": null,
      "cubic_anisotropy_kc3": null,
      "cubic_anisotropy_axis1": null,
      "cubic_anisotropy_axis2": null,
      "interfacial_dmi": null,
      "bulk_dmi": null,
      "ms_field": null,
      "a_field": null,
      "alpha_field": null,
      "ku_field": null,
      "ku2_field": null,
      "kc1_field": null,
      "kc2_field": null,
      "kc3_field": null,
      "dind_field": null,
      "dbulk_field": null
    }
  ],
  "material_parameter_fields": [],
  "couplings": [],
  "planar_monitors": [],
  "field_drives": [],
  "magnets": [
    {
      "name": "strip",
      "region": "strip",
      "material": "mat_strip",
      "initial_magnetization": {
        "kind": "preset_texture",
        "preset_kind": "uniform",
        "preset_params": {
          "direction": [
            1.0,
            0.0,
            0.0
          ]
        },
        "mapping": {
          "space": "object",
          "projection": "object_local",
          "clamp_mode": "none"
        },
        "texture_transform": {
          "translation": [
            0.0,
            0.0,
            0.0
          ],
          "rotation_quat": [
            0.0,
            0.0,
            0.0,
            1.0
          ],
          "scale": [
            1.0,
            1.0,
            1.0
          ],
          "pivot": [
            0.0,
            0.0,
            0.0
          ]
        },
        "ui_label": null,
        "preview_proxy": "none"
      },
      "mesh_recipe": null,
      "absorbing_boundary": null
    }
  ],
  "energy_terms": [
    {
      "kind": "exchange"
    },
    {
      "kind": "demag",
      "realization": "auto"
    }
  ],
  "current_modules": [
    {
      "kind": "current_transport",
      "name": "charge",
      "model": "magnetoresistive_poisson",
      "coupling": "bidirectional",
      "domain": [
        {
          "object_id": "strip"
        }
      ],
      "materials": [
        {
          "region": {
            "object_id": "strip"
          },
          "material": {
            "sigma_Spm": 4000000.0,
            "sigma_parallel_Spm": 4400000.0,
            "sigma_perpendicular_Spm": 4000000.0,
            "sigma_AHE_Spm": 200000.0
          }
        }
      ],
      "boundaries": [
        {
          "kind": "voltage_electrode",
          "id": "left",
          "surfaces": [
            {
              "object_id": "strip",
              "surface_id": "x_min",
              "orientation": [
                -1.0,
                0.0,
                0.0
              ]
            }
          ],
          "potential_V": 0.0
        },
        {
          "kind": "voltage_electrode",
          "id": "right",
          "surfaces": [
            {
              "object_id": "strip",
              "surface_id": "x_max",
              "orientation": [
                1.0,
                0.0,
                0.0
              ]
            }
          ],
          "potential_V": 0.001
        },
        {
          "kind": "insulating",
          "id": "sides",
          "surfaces": [
            {
              "object_id": "strip",
              "surface_id": "y_min",
              "orientation": [
                0.0,
                -1.0,
                0.0
              ]
            },
            {
              "object_id": "strip",
              "surface_id": "y_max",
              "orientation": [
                0.0,
                1.0,
                0.0
              ]
            },
            {
              "object_id": "strip",
              "surface_id": "z_min",
              "orientation": [
                0.0,
                0.0,
                -1.0
              ]
            },
            {
              "object_id": "strip",
              "surface_id": "z_max",
              "orientation": [
                0.0,
                0.0,
                1.0
              ]
            }
          ]
        }
      ],
      "gauge": "dirichlet_reference",
      "solver": {
        "engine": "block_gmres",
        "linear": {
          "relative_tolerance": 1e-08,
          "absolute_tolerance": 0.0,
          "max_iterations": 200
        },
        "physical_residual_version": "transport_balance_integrated_l2.v1",
        "operator_version": "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
      }
    }
  ],
  "spin_transport_modules": [
    {
      "schema_version": "spin_transport.v1",
      "id": "spin",
      "current_source_id": "charge",
      "domain": [
        {
          "object_id": "strip"
        }
      ],
      "mode": "steady",
      "materials": [
        {
          "region": {
            "object_id": "strip"
          },
          "material": {
            "sigma_s_Spm": 5000000.0,
            "polarization_p": 0.2,
            "theta_sh": 0.1,
            "lambda_sf_m": 2e-09,
            "lambda_j_m": 1e-09,
            "lambda_phi_m": 1e-09
          }
        }
      ],
      "interfaces": [],
      "boundaries": [],
      "solver": {
        "engine": "gmres",
        "linear": {
          "relative_tolerance": 1e-08,
          "absolute_tolerance": 0.0,
          "max_iterations": 200
        },
        "physical_residual_version": "transport_balance_integrated_l2.v1",
        "operator_version": "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        "default_external_boundary": "spin_insulating"
      },
      "requested_execution": {
        "discretization": "fem",
        "device": "cpu",
        "precision": "double",
        "execution_mode": "strict"
      },
      "constitutive_version": "transport_constitutive.reciprocal.fullmag.v1"
    }
  ],
  "physics_graph": {
    "schema_version": "physics_graph.v1",
    "scene_revision": 0,
    "modules": [
      {
        "id": "charge",
        "kind": "current_transport",
        "applies_to": [
          {
            "kind": "object",
            "object_id": "strip"
          }
        ],
        "solve_domain": [
          {
            "object_id": "strip"
          }
        ],
        "depends_on": [],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/current_modules/0",
        "family_payload": {
          "kind": "current_transport",
          "name": "charge",
          "model": "magnetoresistive_poisson",
          "coupling": "bidirectional",
          "domain": [
            {
              "object_id": "strip"
            }
          ],
          "materials": [
            {
              "region": {
                "object_id": "strip"
              },
              "material": {
                "sigma_Spm": 4000000.0,
                "sigma_parallel_Spm": 4400000.0,
                "sigma_perpendicular_Spm": 4000000.0,
                "sigma_AHE_Spm": 200000.0
              }
            }
          ],
          "boundaries": [
            {
              "kind": "voltage_electrode",
              "id": "left",
              "surfaces": [
                {
                  "object_id": "strip",
                  "surface_id": "x_min",
                  "orientation": [
                    -1.0,
                    0.0,
                    0.0
                  ]
                }
              ],
              "potential_V": 0.0
            },
            {
              "kind": "voltage_electrode",
              "id": "right",
              "surfaces": [
                {
                  "object_id": "strip",
                  "surface_id": "x_max",
                  "orientation": [
                    1.0,
                    0.0,
                    0.0
                  ]
                }
              ],
              "potential_V": 0.001
            },
            {
              "kind": "insulating",
              "id": "sides",
              "surfaces": [
                {
                  "object_id": "strip",
                  "surface_id": "y_min",
                  "orientation": [
                    0.0,
                    -1.0,
                    0.0
                  ]
                },
                {
                  "object_id": "strip",
                  "surface_id": "y_max",
                  "orientation": [
                    0.0,
                    1.0,
                    0.0
                  ]
                },
                {
                  "object_id": "strip",
                  "surface_id": "z_min",
                  "orientation": [
                    0.0,
                    0.0,
                    -1.0
                  ]
                },
                {
                  "object_id": "strip",
                  "surface_id": "z_max",
                  "orientation": [
                    0.0,
                    0.0,
                    1.0
                  ]
                }
              ]
            }
          ],
          "gauge": "dirichlet_reference",
          "solver": {
            "engine": "block_gmres",
            "linear": {
              "relative_tolerance": 1e-08,
              "absolute_tolerance": 0.0,
              "max_iterations": 200
            },
            "physical_residual_version": "transport_balance_integrated_l2.v1",
            "operator_version": "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
          }
        }
      },
      {
        "id": "spin",
        "kind": "spin_transport",
        "applies_to": [
          {
            "kind": "object",
            "object_id": "strip"
          }
        ],
        "solve_domain": [
          {
            "object_id": "strip"
          }
        ],
        "depends_on": [
          "charge"
        ],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/spin_transports/0",
        "family_payload": {
          "schema_version": "spin_transport.v1",
          "id": "spin",
          "current_source_id": "charge",
          "domain": [
            {
              "object_id": "strip"
            }
          ],
          "mode": "steady",
          "materials": [
            {
              "region": {
                "object_id": "strip"
              },
              "material": {
                "sigma_s_Spm": 5000000.0,
                "polarization_p": 0.2,
                "theta_sh": 0.1,
                "lambda_sf_m": 2e-09,
                "lambda_j_m": 1e-09,
                "lambda_phi_m": 1e-09
              }
            }
          ],
          "interfaces": [],
          "boundaries": [],
          "solver": {
            "engine": "gmres",
            "linear": {
              "relative_tolerance": 1e-08,
              "absolute_tolerance": 0.0,
              "max_iterations": 200
            },
            "physical_residual_version": "transport_balance_integrated_l2.v1",
            "operator_version": "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
            "default_external_boundary": "spin_insulating"
          },
          "requested_execution": {
            "discretization": "fem",
            "device": "cpu",
            "precision": "double",
            "execution_mode": "strict"
          },
          "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
        }
      },
      {
        "id": "transport_torque",
        "kind": "spin_torque",
        "applies_to": [
          {
            "kind": "object",
            "object_id": "strip"
          }
        ],
        "solve_domain": [
          {
            "object_id": "strip"
          }
        ],
        "depends_on": [
          "spin"
        ],
        "activation": "active",
        "authored_state": "authored",
        "capability": "semantic_only",
        "source_path": "/spin_torques/0",
        "family_payload": {
          "kind": "drift_diffusion_spin_torque",
          "schema_version": "drift_diffusion_spin_torque.v1",
          "id": "transport_torque",
          "solve_id": "spin",
          "target": {
            "object_id": "strip"
          },
          "formula_version": "transport_torque_angular_momentum.fullmag.v1"
        }
      }
    ],
    "edges": [
      {
        "kind": "current_to_spin_transport",
        "source_id": "charge",
        "target_id": "spin",
        "status": "active"
      },
      {
        "kind": "current_to_torque",
        "source_id": "spin",
        "target_id": "transport_torque",
        "status": "active"
      }
    ]
  },
  "excitation_analysis": null,
  "study": {
    "kind": "time_evolution",
    "dynamics": {
      "kind": "llg",
      "gyromagnetic_ratio": 221100.0,
      "integrator": "auto",
      "fixed_timestep": null
    },
    "sampling": {
      "outputs": []
    }
  },
  "backend_policy": {
    "requested_backend": "fem",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": null,
      "fem": {
        "order": 1,
        "hmax": 5.6858023018340375e-09,
        "mesh": null
      },
      "hybrid": null
    }
  },
  "validation_profile": {
    "execution_mode": "strict"
  },
  "spin_torque_modules": [
    {
      "kind": "drift_diffusion_spin_torque",
      "schema_version": "drift_diffusion_spin_torque.v1",
      "id": "transport_torque",
      "solve_id": "spin",
      "target": {
        "object_id": "strip"
      },
      "formula_version": "transport_torque_angular_momentum.fullmag.v1"
    }
  ],
  "elastic_materials": [],
  "elastic_bodies": [],
  "magnetostriction_laws": [],
  "mechanical_bcs": [],
  "mechanical_loads": []
}
```

A publication validator compares the displayed JSON with a fresh full no-asset
serialization of the exact block. The repository round-trip test then loads a
flat script, exports canonical builder Python with
`rewrite_loaded_problem_script`, reloads it, and compares the complete current,
spin, torque, and stage semantics. Requested intent remains in these records;
planner resolution and runtime provenance remain separate.

(ddst-round-trip-and-failure-semantics)=
## Requested intent, resolved execution, and failures

The **requested intent** includes coupling, charge/spin material data,
boundaries, interfaces, solver policies, requested discretization/device/
precision/mode, solve identity, and torque target. The planner stores
**resolved execution** separately: M1/M2 constitutive and operator versions,
actual lane, inserted default boundaries, interface realization, capability
status, and validation scope.

**Validation errors** identify the owning field and reject before execution.
Examples include missing charge gauge, missing reciprocal tensor components,
non-positive Schur complement, incompatible charge/spin operators, unsupported
interface or boundary law, missing solve reference, single precision, or GPU.
**Unsupported combinations** remain visible and do not silently substitute M1
for M2, FDM for FEM, CPU for GPU, or a post-hoc prescribed torque for the
solved transport.

(ddst-discrete-realization)=
## Discrete realization

### FDM CPU

Cell-centred $V$, $\boldsymbol\mu_s$, magnetization, and material data use
single oriented face fluxes for $\mathbf J_c$ and $Q_{ia}$. M1 is a bounded
one-way reference path; M2 is a monolithic block-GMRES reference with explicit
reciprocal material and residual policies. Neither is production-qualified.

An explicit `native_m1_v1` CPU-double/strict development prototype crosses the
public ProblemIR, planner, dedicated C ABI adapter, Rust FFI, runner, and
persistent artifact path. It supports the bounded M1 transparent and
mixing-conductance fixtures and publishes complete $V$, cell and face
$\mathbf J_c$, $\boldsymbol\mu_s$, cell and face $Q_{ia}$, reaction channels,
interface observations, torque, and requested/resolved provenance without
fallback. The adapter checks count-controlled record byte extents before
dereference and maps every interface by exact per-face topology. This is an
opt-in executable contract only: capability is `semantic_only`,
`implementation_state=executable`, `validation_state=unvalidated`, and no
stable, public-qualified, validated-workload, or production claim is made.
The current worktree implements the requested exact-provenance and
per-quantity oracle fixes and received `final5 independent review APPROVE, no Critical/Important`.
This review result does not make the lane stable,
public-qualified, validated, or production-qualified.

### FDM GPU

The semantic contract and requested lane can be authored, but no executable
qualified CUDA transport solve exists. Strict GPU requests fail closed without
CPU fallback.

### FEM CPU

M1 uses conforming H1/P1 charge and spin spaces with transparent interfaces.
The bounded M2 realization solves one monolithic conforming H1/P1 block for
$(V,\mu_{s,x},\mu_{s,y},\mu_{s,z})$ in FP64. Its scope is uniform, full-domain,
strict CPU. A bounded M2 stage callback can add solved transport torque directly
to the LLG RHS with transactional rollback; this does not promote the general
torque capability.

### FEM GPU

No device-resident spin-transport operator is executable or qualified. Source
presence, planner vocabulary, and unrelated CUDA torque kernels are not FEM GPU
transport evidence.

(ddst-implementation-mapping)=
## Implementation mapping

| Claim | Path | Stable symbol | Responsibility |
|---|---|---|---|
| Public spin solve | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinDriftDiffusion` | validates and lowers the canonical M1/M2 spin solve |
| Public torque binding | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class DriftDiffusionSpinTorque` | binds a solved transport to a magnetic target |
| Requested lane | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class TransportExecution` | preserves requested discretization/device/precision/mode |
| Spin solver policy | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinSolverPolicy` | preserves linear/operator and boundary-default policy |
| Current source | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | owns one-way/bidirectional coupling and charge definition |
| FDM planning | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_spin_transport` | resolves FDM CPU M1/M2 and rejects unsupported lanes |
| FEM planning | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_m1_fem_spin_transport` | resolves bounded FEM CPU M1/M2 descriptors |
| FDM execution | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_coupled_module` | executes the FDM CPU coupled charge--spin solve |
| Native FDM M1 C ABI | `native/include/fullmag_fdm.h` | `fullmag_fdm_cpu_charge_solve_v1`; `fullmag_fdm_cpu_steady_spin_solve_v1` | declares append-only native M1 requests, results, snapshot ownership, and symbols |
| Native FDM M1 ABI adapter | `backends/fdm/api/cpu_transport_v1.cpp` | `fullmag_fdm_cpu_charge_solve_v1`; `fullmag_fdm_cpu_steady_spin_solve_v1` | validates extents, translates owner records, and maps observations by exact topology |
| Native FDM M1 Rust FFI | `crates/fullmag-fdm-sys/src/lib.rs` | `fullmag_fdm_cpu_charge_result_v1`; `fullmag_fdm_cpu_steady_spin_result_v1` | exposes byte-exact Rust records and symbols |
| Native FDM M1 runner | `crates/fullmag-runner/src/fdm/cpu/native_transport.rs` | `solve_native_m1_snapshot` | validates full native results fail closed and materializes persistent snapshots |
| Native FDM M1 public E2E | `crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs` | `public_native_m1_v1_transparent_and_mixing_artifacts_match_reference_and_provenance` | proves the opt-in transparent/mixing public artifact path without qualification promotion |
| FEM execution | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport` | dispatches bounded native FEM M1/M2 solves |
| FDM M1 constitutive flux | `crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion.rs` | `face_fluxes` | evaluates the oriented M1 charge/spin face laws |
| FDM M2 constitutive block | `crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs` | `ReciprocalConstitutiveMaterial::evaluate` (`evaluate`) | evaluates AMR/PHE/AHE and reciprocal charge--spin coupling |
| FDM reactions | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `reaction` | evaluates all three volumetric reaction laws |
| FDM transport torque | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `CoupledChargeSpinProblem::transport_gilbert_torque` (`transport_gilbert_torque`) | transfers only exchange/dephasing channels to magnetization |
| FEM constitutive block | `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `class CoupledTransportGradientIntegrator`; owner `SteadyTransportOracle::Impl::constitutive_response` | assembles and evaluates native M2 charge and spin currents |
| FEM reactions | `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `class ReactionMatrixCoefficient` | assembles the native reaction matrix |
| FEM transport torque | `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `class TorqueCoefficient`; owner `SteadyTransportOracle::Impl::project_torque` | performs the native consistent torque projection |
| FEM stage torque | `crates/fullmag-runner/src/native_fem/stage_transport.rs` | `StageTransportProvider::evaluate` (`evaluate`) | evaluates exact-stage reciprocal M2 torque for the CPU callback |

(ddst-validation)=
## Validation and evidence

Current CPU evidence includes analytical profiles, residual/balance gates, and
bounded mesh/common-limit/constitutive fixtures named in the canonical note.
The bounded FEM M2 lane has affine constitutive, Onsager/dissipation, mesh
refinement, and selected FDM--FEM common-limit evidence. These are named
reference fixtures, not `validated_workloads` promotion. There is no GPU
transport parity, broad heterogeneous/interface qualification, BORIS parity,
or production qualification.

(ddst-limitations)=
## Limitations

- The general `DriftDiffusionSpinTorque` capability remains `semantic_only`;
  bounded CPU M2 callback execution is narrower.
- FEM mixing/SML, periodic spin, specified spin flux, heterogeneous M2 tensors,
  and GPU are fail-closed.
- M3 transient transport is outside this M1/M2 page.
- Ballistic transport, tunnelling, Rashba--Edelstein physics, and spin pumping
  require separate contracts.

(ddst-scientific-bibliography)=
## Scientific bibliography

1. T. Valet and A. Fert, *Phys. Rev. B* 48, 7099 (1993),
   [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
2. C. Abert et al., *Comput. Math. Appl.* 68, 639--654 (2014),
   [doi:10.1016/j.camwa.2014.07.010](https://doi.org/10.1016/j.camwa.2014.07.010).
3. C. Abert et al., *Sci. Rep.* 5, 14855 (2015),
   [doi:10.1038/srep14855](https://doi.org/10.1038/srep14855).
4. J. E. Hirsch, *Phys. Rev. Lett.* 83, 1834 (1999),
   [doi:10.1103/PhysRevLett.83.1834](https://doi.org/10.1103/PhysRevLett.83.1834).

(ddst-source-code-index)=
## Source-code index

| Claim | Source path | Stable symbol / owner | Responsibility | Lane | Exact test | Evidence status | Source anchor | Test anchor |
|---|---|---|---|---|---|---|---|---|
| Public spin solve | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinDriftDiffusion` | Validate and lower the canonical M1 or M2 spin solve. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_canonical_fem_spin_transport_and_torque_round_trip_through_flat_script` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Public torque binding | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class DriftDiffusionSpinTorque` | Bind a solved transport to a magnetic target without duplicating source data. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_canonical_fem_spin_transport_and_torque_round_trip_through_flat_script` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Requested lane | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class TransportExecution` | Preserve requested discretization, device, precision, and execution mode. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_spin_transport_round_trip_preserves_full_boundary_and_solver_policy` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Spin solver policy | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinSolverPolicy` | Preserve linear, operator, residual, and default-boundary policy. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_spin_transport_round_trip_preserves_full_boundary_and_solver_policy` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/spin_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| Current source | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | Own current model, coupling, charge definition, and time envelope. | API/IR | `packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py::test_full_builder_scene_rewrite_loader_pipeline_preserves_physics_ir` | source mapped; focused public round-trip | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/src/fullmag/model/current_transport.py) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py) |
| FDM planning | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_spin_transport` | Resolve FDM CPU M1/M2 descriptors and reject unsupported lanes. | FDM CPU planner | `crates/fullmag-plan/src/spin_transport.rs::resolves_bidirectional_m2_to_separate_reciprocal_descriptor` | source mapped; focused planner contract | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_transport.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_transport.rs) |
| FEM planning | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_m1_fem_spin_transport` | Resolve bounded FEM CPU M1/M2 descriptors and fail-closed limits. | FEM CPU planner | `crates/fullmag-plan/src/spin_transport.rs::resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback` | source mapped; focused planner contract | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_transport.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-plan/src/spin_transport.rs) |
| FDM dispatch | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_coupled_module` | Execute the FDM CPU coupled charge-spin reference solve. | FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs::m2_phe_and_ahe_manufactured_current_has_full_3d_components` | bounded CPU oracle/contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/fdm/cpu/spin_transport.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs) |
| Native FDM M1 C ABI | `native/include/fullmag_fdm.h` | `fullmag_fdm_cpu_charge_solve_v1`; `fullmag_fdm_cpu_steady_spin_solve_v1` | Declare append-only requests, results, snapshot ownership, and symbols. | FDM CPU opt-in | `backends/fdm/tests/cpu_transport_abi_v1_contract.cpp::main` | managed contract; unvalidated and not production qualification | `worktree/uncommitted` | `worktree/uncommitted` |
| Native FDM M1 ABI adapter | `backends/fdm/api/cpu_transport_v1.cpp` | `fullmag_fdm_cpu_charge_solve_v1`; `fullmag_fdm_cpu_steady_spin_solve_v1` | Check record extents and map owner observations by exact topology. | FDM CPU opt-in | `backends/fdm/tests/cpu_transport_abi_v1_contract.cpp::main` | managed contract; unvalidated and not production qualification | `worktree/uncommitted` | `worktree/uncommitted` |
| Native FDM M1 Rust FFI | `crates/fullmag-fdm-sys/src/lib.rs` | `fullmag_fdm_cpu_charge_result_v1`; `fullmag_fdm_cpu_steady_spin_result_v1` | Expose byte-exact Rust records and native symbols. | FDM CPU opt-in | `crates/fullmag-fdm-sys/src/lib.rs::cpu_transport_abi_layout_manifest_matches_every_rust_record_field` | managed layout contract; unvalidated and not production qualification | `worktree/uncommitted` | `worktree/uncommitted` |
| Native FDM M1 runner adapter | `crates/fullmag-runner/src/fdm/cpu/native_transport.rs` | `solve_native_m1_snapshot` | Validate complete native results fail closed and materialize canonical persistent transport snapshots. | FDM CPU opt-in | `crates/fullmag-runner/src/fdm/cpu/native_transport.rs::native_m1_v1_charge_validator_rejects_every_owned_result_contract_mutation` | managed adapter contract; unvalidated and not production qualification | `worktree/uncommitted` | `worktree/uncommitted` |
| Native FDM M1 public E2E | `crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs` | `public_native_m1_v1_transparent_and_mixing_artifacts_match_reference_and_provenance` | Compare persistent transparent/mixing artifacts and provenance against the reference owner. | FDM CPU opt-in | same symbol | managed public-path contract; unvalidated and not production qualification | `worktree/uncommitted` | `worktree/uncommitted` |
| FEM dispatch | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `solve_native_fem_steady_transport` | Dispatch bounded native FEM M1/M2 solves. | FEM CPU | `crates/fullmag-runner/src/native_fem/steady_transport.rs::native_m2_solver_publishes_reciprocal_diagnostics` | bounded native CPU contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/native_fem/steady_transport.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/native_fem/steady_transport.rs) |
| FDM M1 flux | `crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion.rs` | `face_fluxes` | Evaluate oriented M1 charge and spin face fluxes. | FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion_tests.rs::she_1d_film_v1_has_positive_y_accumulation_gradient_and_expected_profile` | bounded CPU oracle/contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion_tests.rs) |
| FDM M2 constitutive | `crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs` | `evaluate; owner ReciprocalConstitutiveMaterial` | Evaluate the full AMR/PHE/AHE and reciprocal charge-spin M2 block. | FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs::m2_onsager_oracle_freezes_reciprocal_and_she_signs` | bounded CPU oracle/contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs) |
| FDM reactions | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `reaction` | Evaluate spin-flip, exchange-rotation, and dephasing reaction channels. | FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion_tests.rs::spin_relaxation_modes_v1_have_correct_signs_and_torque_partition` | bounded CPU oracle/contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion_tests.rs) |
| FDM torque | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `transport_gilbert_torque; owner CoupledChargeSpinProblem` | Convert exchange/dephasing reactions to the transport Gilbert-source torque. | FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs::m2_transport_torque_is_dimensionally_converted_and_gated_by_outer_lte` | bounded CPU oracle/contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs) |
| FEM constitutive | `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `class CoupledTransportGradientIntegrator; owner SteadyTransportOracle::Impl::constitutive_response` | Assemble and evaluate the native FEM M2 constitutive response, including AMR/PHE/AHE and reciprocal blocks. | FEM CPU | `crates/fullmag-runner/src/native_fem/steady_transport.rs::reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles` | bounded native CPU contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/transport/steady_transport.cpp) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/native_fem/steady_transport.rs) |
| FEM reactions | `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `class ReactionMatrixCoefficient` | Assemble the native FEM spin reaction matrix. | FEM CPU | `backends/fem/tests/steady_transport_contract.cpp::direct_she_sign_and_torque_projection_are_canonical` | bounded native CPU contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/transport/steady_transport.cpp) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/tests/steady_transport_contract.cpp) |
| FEM torque | `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `class TorqueCoefficient; owner SteadyTransportOracle::Impl::project_torque` | Evaluate and project exchange/dephasing angular-momentum transfer to the native FEM torque field. | FEM CPU | `backends/fem/tests/steady_transport_contract.cpp::direct_she_sign_and_torque_projection_are_canonical` | bounded native CPU contract; not production qualification | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/cpu/mfem/transport/steady_transport.cpp) | [test](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/backends/fem/tests/steady_transport_contract.cpp) |
| FEM stage torque | `crates/fullmag-runner/src/native_fem/stage_transport.rs` | `evaluate; owner StageTransportProvider` | Evaluate exact-stage reciprocal M2 torque in the bounded CPU callback. | FEM CPU | `crates/fullmag-runner/src/native_fem.rs::native_fem_reciprocal_m2_shares_one_stage_solve_for_torque_and_oersted` | bounded native CPU contract; not production qualification; test worktree-uncommitted; immutable test anchor unavailable | [source](https://github.com/MateuszZelent/fullmag/blob/220262df5d84fa04b842c414e3e5868444b356e5/crates/fullmag-runner/src/native_fem/stage_transport.rs) | `worktree/uncommitted`; path + symbol only |

Immutable tracked baseline for these links:
[Fullmag `220262df5d84fa04b842c414e3e5868444b356e5`](https://github.com/MateuszZelent/fullmag/tree/220262df5d84fa04b842c414e3e5868444b356e5).
Every linked cell above was dereferenced with `git show SHA:path` and its exact
symbol was found in that blob. A `worktree/uncommitted` cell intentionally has
no immutable URL: its current `path + symbol` identity is verifiable locally,
but publication remains blocked until a controlled commit supplies the anchor.
