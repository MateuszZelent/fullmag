---
title: Spin Hall drift-diffusion transport
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0970-spin-hall-drift-diffusion-transport.md
---

(public-docs-physics-interactions-drift-diffusion-stt)=
# Spin Hall drift-diffusion transport

This page documents the solved charge/spin transport model behind direct and inverse
spin Hall effects (SHE/iSHE). It is deliberately separate from
{doc}`../spin-orbit-torque/index`: `SpinOrbitTorque`/`PrescribedSpinOrbitTorque` is a
local prescribed source, while this page solves for electric potential, spin potential,
spin-current tensor, interfaces, and magnetic torque. A prescribed SOT object never
satisfies the `transport.spin.direct_she` capability.

The current public Python surface contains two records:

- `SpinDriftDiffusion` owns the transport solve and its materials, boundaries, interfaces,
  solver policy, execution request, and steady/transient mode.
- `DriftDiffusionSpinTorque` references a named solve and a magnetic target. It does not
  duplicate current, polarization, or transport parameters.

## Backend and qualification matrix

| Solver | Device | current code boundary | qualification status |
|---|---|---|---|
| FDM | CPU | M1 one-way/reference and M3 transient reference paths exist in the planner/runner | `reference_executable` only for the explicitly scoped workloads; no broad SHE qualification is claimed. |
| FDM | GPU | transport IR and CUDA-facing planning vocabulary exist, but no qualified production transport lane is recorded | `semantic_only` |
| FEM | CPU | narrow M1 strict double MFEM descriptor/ABI path exists for conforming H1/P1 transparent-interface workloads | `reference_executable`/`algebra_validated` only for that bounded slice; mixing, specified flux, periodic spin, and LLG coupling reject. |
| FEM | GPU | no qualified device spin-transport operator | `semantic_only`; CPU fallback is forbidden. |

The capability matrix remains authoritative for promotion. Implementation presence, a
serialized descriptor, or a successful unit contract is not an executed CPU/GPU parity result.

(ddst-problem-statement)=
## Physical problem

On an oriented domain, $V$ is the electric potential and
$\boldsymbol\mu_s$ is the full spin-channel splitting. The charge-equivalent spin-current
tensor $Q_{ia}$ uses the first index for flow direction and the second for spin polarization.
The magnetic torque is obtained from exchange rotation and transverse dephasing only; spin-flip
loss and spin-memory-loss flux go to separate reservoirs.

The model is split into:

1. **M1 one-way steady transport:** charge solve first, then spin solve with prescribed charge
   current and direct SHE source.
2. **M2 reciprocal quasistatic transport:** charge and spin constitutive blocks are coupled;
   SHE/iSHE makes the system nonsymmetric.
3. **M3 transient transport:** spin accumulation has a physical capacitance and is advanced in
   time with rollback-safe stage state.

(ddst-governing-equations)=
## Governing equations

Define

```{math}
:label: eq-ddst-fields
E_i=-\partial_i V,
\qquad
G_{ia}=-\frac12\partial_i\mu_{s,a},
\qquad
\mathcal J^s_{ia}=\frac{\hbar}{2e}Q_{ia}.
```

### Charge and direct SHE, M1

```{math}
:label: eq-ddst-m1-constitutive
J_{c,i}=\sigma E_i,
\qquad
\partial_iJ_{c,i}=0,
\qquad
Q_{ia}=\sigma_sG_{ia}+P\sigma E_i m_a
 +\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k.
```

The last term is direct SHE. M1 deliberately omits reciprocal spin-to-charge feedback.
The M2 constitutive block adds the reciprocal polarization and iSHE terms:

```{math}
:label: eq-ddst-m2-constitutive
J_{c,i}=J_{\mathrm{mr},i}+P\sigma m_aG_{ia}
 +\theta_{\mathrm{SH}}\sigma\epsilon_{ija}G_{ja},
\qquad
Q_{ia}=\sigma_sG_{ia}+P\sigma E_i m_a
 +\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k.
```

The magnetoresistive current is

```{math}
:label: eq-ddst-mr-current
\mathbf J_{\mathrm{mr}}
=\sigma_\perp\mathbf E
 +(\sigma_\parallel-\sigma_\perp)(\mathbf m\cdot\mathbf E)\mathbf m
 +\sigma_{\mathrm{AHE}}\,\mathbf m\times\mathbf E.
```

### Spin balance and torque

```{math}
:label: eq-ddst-spin-balance
C_s\partial_t\mu_{s,a}+\partial_iQ_{ia}
=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a}.
```

For the isotropic reaction model,

```{math}
:label: eq-ddst-reaction
R_{\mathrm{sf}}=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\boldsymbol\mu_s,
\quad
R_J=\frac{\sigma_s}{2\lambda_J^2}(\boldsymbol\mu_s\times\mathbf m),
\quad
R_\phi=\frac{\sigma_s}{2\lambda_\phi^2}\mathbf m\times(\boldsymbol\mu_s\times\mathbf m).
```

Only exchange rotation and transverse dephasing transfer angular momentum to the magnet:

```{math}
:label: eq-ddst-transport-torque
\mathbf T_{\mathrm{tr},G}
=-\frac{\gamma_e}{M_s}\frac{\hbar}{2e}(R_J+R_\phi).
```

For the canonical isotropic nonmagnetic capacitance adapter,

```{math}
:label: eq-ddst-capacitance
C_s=e^2N_0,
```

where $N_0$ is the per-spin density of states. A transient request without a physical
capacitance or an accepted `dos_isotropic_nonmagnetic.fullmag.v1` adapter is rejected.

### Boundaries and interfaces

Charge boundaries are `VoltageElectrode`, `Ground`, `NormalCurrentElectrode`, and
`ChargeInsulating`, with an explicit potential gauge. Spin boundaries are
`SpinInsulating`, `SpinSink`, `SpecifiedSpinPotential`, `SpecifiedSpinFlux`, and `PeriodicSpin`.
Each selected face receives exactly one charge and one spin assignment; missing or conflicting
assignments fail closed.

For an oriented transparent interface,

```{math}
:label: eq-ddst-transparent-interface
[V]=0,\qquad [\boldsymbol\mu_s]=0,
\qquad [\mathbf J_c\cdot\mathbf n]=0,
\qquad [n_iQ_{ia}]=0.
```

The mixing-conductance interface uses $g_\uparrow$, $g_\downarrow$, complex transverse
$g_r+i g_i$, and an optional three-branch spin-memory-loss reservoir. Only transverse absorbed
spin flux torques the magnet; the lattice branch is not magnetic torque.

(ddst-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $V$ | electric potential | $\mathrm V$ |
| $\mathbf E$ | electric field $-\nabla V$ | $\mathrm{V\,m^{-1}}$ |
| $\boldsymbol\mu_s$ | full spin potential splitting | $\mathrm V$ |
| $G_{ia}$ | spin-potential gradient | $\mathrm{V\,m^{-1}}$ |
| $J_{c,i}$ | conventional charge-current density | $\mathrm{A\,m^{-2}}$ |
| $Q_{ia}$ | charge-equivalent spin-current tensor | $\mathrm{A\,m^{-2}}$ |
| $\mathcal J^s_{ia}$ | angular-momentum spin flux | $\mathrm{J\,m^{-2}}$ |
| $\sigma$, $\sigma_s$ | charge and spin conductivities | $\mathrm{S\,m^{-1}}$ |
| $\sigma_\parallel$, $\sigma_\perp$, $\sigma_{\mathrm{AHE}}$ | magnetoresistive conductivity coefficients | $\mathrm{S\,m^{-1}}$ |
| $P$ | charge-spin polarization | $1$ |
| $\theta_{\mathrm{SH}}$ | spin Hall angle | $1$ |
| $C_s$ | spin capacitance | $\mathrm{A\,s\,V^{-1}\,m^{-3}}$ |
| $\lambda_{\mathrm{sf}}$, $\lambda_J$, $\lambda_\phi$ | spin-flip, exchange, and dephasing lengths | $\mathrm m$ |
| $R_{\mathrm{sf}}$, $R_J$, $R_\phi$ | volumetric reaction terms | $\mathrm{A\,m^{-3}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\gamma_e$ | angular gyromagnetic magnitude | $\mathrm{s^{-1}\,T^{-1}}$ |
| $e$, $\hbar$ | positive elementary charge and reduced Planck constant | $\mathrm C$, $\mathrm{J\,s}$ |
| $N_0$ | per-spin density of states | $\mathrm{J^{-1}\,m^{-3}}$ |
| $g_\uparrow$, $g_\downarrow$, $g_r$, $g_i$ | interface conductances | $\mathrm{S\,m^{-2}}$ |
| $\mathbf T_{\mathrm{tr},G}$ | transport-derived Gilbert torque | $\mathrm{s^{-1}}$ |

(ddst-assumptions-and-validity)=
## Assumptions and validity limits

- The model is diffusive, local, and electroquasistatic; it is not a ballistic or full-wave
  Maxwell solver.
- `mu_s` is the full channel splitting; it is not a half-splitting convention.
- $Q_{ia}$ is rank two and must not be published as an unlabelled three-vector. The canonical
  row-major order is `[Q_xx,Q_xy,Q_xz,Q_yx,Q_yy,Q_yz,Q_zx,Q_zy,Q_zz]`.
- Active reaction lengths are positive; infinity is represented by an explicit disabled reaction.
- M1 has direct SHE but no iSHE. M2 is the reciprocal constitutive block and is nonsymmetric.
- A transient module requires physical $C_s$ or the exact DOS adapter; assigning a dimensionless
  placeholder is invalid.
- Prescribed SOT, Oersted, or an unbound current source is not silently substituted for a failed
  transport solve.

(ddst-python-api)=
## Python API and copyable object workflow

The stage builder does not yet expose a single interaction registration call for the complete
transport graph. The following object-level fragment is the public, copyable contract and
serializes the solve before it is attached to a larger study.

```python
# %% Stage-first simulation shell
import fullmag as fm

nm_length = 1.0e-9
study = fm.study("spin-transport-stage-boundary")
study.engine("fdm")
study.cell(2 * nm_length, 2 * nm_length, 2 * nm_length)
body = study.geometry(fm.Box(40 * nm_length, 20 * nm_length, 2 * nm_length), name="ferromagnet")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_run(stage_id="run", until=1.0e-12)

# %% Transport regions and current source
nm = fm.RegionRef("stack", "normal_metal")
fm_region = fm.RegionRef("stack", "ferromagnet")
charge = fm.CurrentTransport(
    name="charge",
    model="prescribed_density",
    current_density=(0.0, 0.0, 1.0e11),
)

# %% M1 spin Hall drift-diffusion solve
solve = fm.SpinDriftDiffusion(
    id="spin_solve",
    current_source_id="charge",
    domain=[nm, fm_region],
    materials=[
        fm.SpinTransportMaterialAssignment(
            nm, fm.SpinTransportMaterial(
                sigma_s_Spm=5.0e6, polarization_p=0.0,
                theta_sh=0.12, lambda_sf_m=1.5e-9,
            )
        ),
        fm.SpinTransportMaterialAssignment(
            fm_region, fm.SpinTransportMaterial(
                sigma_s_Spm=3.0e6, polarization_p=0.45,
                theta_sh=0.0, lambda_sf_m=4.0e-9,
                lambda_j_m=1.0e-9, lambda_phi_m=0.8e-9,
            )
        ),
    ],
    solver=fm.SpinSolverPolicy(relative_tolerance=1.0e-9),
)
solve_ir = solve.to_ir()
assert solve_ir["schema_version"] == "spin_transport.v1"
assert solve_ir["materials"][0]["material"]["theta_sh"] == 0.12

# %% Torque consumer references the solve; it does not duplicate transport data
torque = fm.DriftDiffusionSpinTorque(
    id="transport_torque", solve_id="spin_solve", target=fm_region,
)
assert torque.to_ir_module()["solve_id"] == "spin_solve"
```

### Exhaustive transport parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SpinDriftDiffusion.id` | `str` | required | $1$ | non-empty | solve identity | all authoring lanes | `spin_transport_modules[].id` |
| `SpinDriftDiffusion.current_source_id` | `str` | required | $1$ | non-empty reference | owner of charge drive/coupling | planner-resolved | `spin_transport_modules[].current_source_id` |
| `SpinDriftDiffusion.domain` | `Sequence[RegionRef]` | required | $1$ | non-empty | solved regions | FDM/FEM descriptors | `spin_transport_modules[].domain` |
| `SpinDriftDiffusion.materials` | `Sequence[SpinTransportMaterialAssignment]` | required | mixed SI | non-empty and complete | region material map | FDM/FEM descriptors | `spin_transport_modules[].materials` |
| `SpinDriftDiffusion.interfaces` | `Sequence[TransparentSpinInterface or MixingConductanceSpinInterface]` | `()` | mixed SI | oriented references | internal spin interface laws | transparent bounded; mixing gated | `spin_transport_modules[].interfaces` |
| `SpinDriftDiffusion.boundaries` | `Sequence[...]` | `()` | mixed SI | exact surface ownership | spin boundary conditions | bounded by lane | `spin_transport_modules[].boundaries` |
| `SpinDriftDiffusion.solver` | `SpinSolverPolicy or None` | `SpinSolverPolicy()` | mixed SI | positive tolerances, iterations | solver/operator policy | FDM/FEM planner | `spin_transport_modules[].solver` |
| `SpinDriftDiffusion.requested_execution` | `TransportExecution or None` | `TransportExecution()` | $1$ | enum values | requested solver/device/precision/mode | provenance | `spin_transport_modules[].requested_execution` |
| `SpinDriftDiffusion.mode` | `str` | `steady` | $1$ | `steady` or `transient` | M1/M2 versus M3 | FDM transient reference; other lanes gated | `spin_transport_modules[].mode` |
| `SpinTransportMaterial.sigma_s_Spm` | `float` | required | $\mathrm{S\,m^{-1}}$ | positive | spin conductivity | FDM/FEM descriptor | `materials[].material.sigma_s_Spm` |
| `SpinTransportMaterial.polarization_p` | `float` | required | $1$ | $-1\leq P\leq1$ | polarization | FDM/FEM descriptor | `materials[].material.polarization_p` |
| `SpinTransportMaterial.theta_sh` | `float` | required | $1$ | finite, signed | spin Hall angle | direct SHE contract | `materials[].material.theta_sh` |
| `SpinTransportMaterial.lambda_sf_m` | `float` | required | $\mathrm m$ | positive | spin-flip length | FDM/FEM descriptor | `materials[].material.lambda_sf_m` |
| `SpinTransportMaterial.lambda_j_m` | `float or None` | `None` | $\mathrm m$ | positive when supplied | exchange-transfer length | torque-capable regions | `materials[].material.lambda_j_m` |
| `SpinTransportMaterial.lambda_phi_m` | `float or None` | `None` | $\mathrm m$ | positive when supplied | dephasing length | torque-capable regions | `materials[].material.lambda_phi_m` |
| `SpinTransportMaterial.spin_capacitance_As_per_V_m3` | `float or None` | `None` | $\mathrm{A\,s\,V^{-1}\,m^{-3}}$ | positive with formula version | transient capacitance | FDM M3 reference | `materials[].material.spin_capacitance_As_per_V_m3` |
| `SpinTransportMaterial.density_of_states_per_spin_Jinv_m3` | `float or None` | `None` | $\mathrm{J^{-1}\,m^{-3}}$ | positive with formula version | DOS adapter for $C_s$ | FDM M3 reference | `materials[].material.density_of_states_per_spin_Jinv_m3` |
| `SpinTransportMaterial.capacitance_formula_version` | `str or None` | `None` | $1$ | exact `dos_isotropic_nonmagnetic.fullmag.v1` when used | capacitance normalization identity | planner validation | `materials[].material.capacitance_formula_version` |
| `SpinSolverPolicy.engine` | `str` | `auto` | $1$ | non-empty | linear solver engine | lane-dependent | `solver.engine` |
| `SpinSolverPolicy.relative_tolerance` | `float` | `1e-8` | $1$ | positive | relative residual tolerance | FDM/FEM policy | `solver.linear.relative_tolerance` |
| `SpinSolverPolicy.absolute_tolerance` | `float` | `0.0` | $1$ | finite and non-negative | absolute residual tolerance | FDM/FEM policy | `solver.linear.absolute_tolerance` |
| `SpinSolverPolicy.max_iterations` | `int` | `500` | $1$ | positive | iteration cap | FDM/FEM policy | `solver.linear.max_iterations` |
| `SpinSolverPolicy.operator_version` | `str` | `fv_spin_upwind_v1` | $1$ | non-empty | discretization identity | provenance | `solver.operator_version` |
| `SpinSolverPolicy.default_external_boundary` | `str` | `spin_insulating` | $1$ | `spin_insulating` or `reject_unassigned` | external-face default | planner boundary gate | `solver.default_external_boundary` |
| `TransportExecution.discretization` | `str` | `fdm` | $1$ | `fdm`, `fem`, or `auto` | requested solver family | planner | `requested_execution.discretization` |
| `TransportExecution.device` | `str` | `cpu` | $1$ | `cpu`, `gpu`, or `auto` | requested device | planner | `requested_execution.device` |
| `TransportExecution.precision` | `str` | `double` | $1$ | `single` or `double` | requested precision | qualification | `requested_execution.precision` |
| `TransportExecution.execution_mode` | `str` | `strict` | $1$ | `strict` or `extended` | fallback policy | planner | `requested_execution.execution_mode` |
| `DriftDiffusionSpinTorque.id` | `str` | required | $1$ | non-empty | torque identity | IR reference | `spin_torque_modules[].id` |
| `DriftDiffusionSpinTorque.solve_id` | `str` | required | $1$ | non-empty solve reference | transport result consumed | IR reference | `spin_torque_modules[].solve_id` |
| `DriftDiffusionSpinTorque.target` | `RegionRef` | required | $1$ | valid region | magnetic target | IR reference | `spin_torque_modules[].target` |

The interface and boundary constructors are also public API. Their conductances use
$\mathrm{S\,m^{-2}}$, potentials use $mathrm V$, normal spin flux uses
$\mathrm{A\,m^{-2}}$, and every surface/normal is oriented and normalized once during lowering.

(ddst-problem-ir)=
## Python-to-`ProblemIR` representation

`SpinDriftDiffusion.to_ir()` emits `schema_version="spin_transport.v1"` with separate current
source identity, region material assignments, interface/boundary records, solver policy,
requested execution, mode, and constitutive version. `DriftDiffusionSpinTorque.to_ir_module()`
emits only a named solve reference:

```json
{
  "kind": "drift_diffusion_spin_torque",
  "schema_version": "drift_diffusion_spin_torque.v1",
  "id": "transport_torque",
  "solve_id": "spin_solve",
  "target": {"object_id": "stack", "region_id": "ferromagnet"},
  "formula_version": "transport_torque_angular_momentum.fullmag.v1"
}
```

The current module owns coupling and source data. The spin module must not duplicate a private
current or a second coupling policy. Resolved plans add operator version, masks, BC marker sets,
residual policy, requested/resolved lane, and provenance revisions.

(ddst-round-trip-and-failure-semantics)=
## Round-trip, planning, and failure semantics

Requested intent contains all authored regions, orientations, materials, source identity,
boundaries, solver tolerances, execution request, and mode. Resolved execution contains the
selected operator, charge/spin solver identities, residuals, iterations, balances, stage refresh,
precision, and device provenance. A canonical export must preserve `Q` component order and not
replace a solved transport module with prescribed SOT.

Validation rejects missing materials/domain, invalid lengths or coefficients, duplicate/partial
face ownership, missing gauge, incompatible coupling, transient mode without physical capacitance,
and an unresolved `current_source_id`. Planner errors reject unsupported FEM/GPU combinations,
mixing/SML or specified-flux records outside their bounded lane, and any hidden CPU fallback.
These validation errors are part of the public contract: they must identify the offending field,
the violated physical invariant, and the supported alternative; a failed request is never silently
rewritten as prescribed SOT or as a CPU fallback.

(ddst-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU

Cell-centred $V$, $\boldsymbol\mu_s$, $\mathbf m$, and materials use one oriented face flux for
$\mathbf J_c$ and each $Q_{ia}$. `fv_spin_upwind_v1` uses signed upwind magnetization in the
polarized flux; `structured_cross_gradient_v1` reconstructs normal and tangential electric
gradients with BC-consistent stencils. Direct SHE and polarized terms are summed before insertion
with opposite cell signs. CPU double uses CG/AMG for symmetric M1 charge and block GMRES for spin;
M2 is nonsymmetric.

### FDM GPU

The transport descriptor and resident-state vocabulary exist, but the current capability matrix
does not promote a production CUDA spin-transport lane. No CPU result may be reported as GPU output.

### FEM CPU

The bounded M1 slice uses broken H1/P1 spaces for independent charge/spin traces, MFEM boundary
attributes, transparent interfaces, and separate charge CG/spin GMRES identities. The C ABI keeps
domain masks, marker sets, and authored torque target. Mixing/SML, specified spin flux, periodic
spin, and LLG/Oersted coupling fail before native execution.

### FEM GPU

No qualified GPU weak-form realization is published. Native GPU transport must keep operators and
state resident and prove FP64 parity before any FP32 promotion; source declarations are not proof.

(ddst-implementation-mapping)=
## Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python solve | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinDriftDiffusion` | transport object and IR | Python |
| Python torque consumer | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class DriftDiffusionSpinTorque` | named solve reference | Python |
| Python material | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinTransportMaterial` | conductivity, SHE, lengths, capacitance | Python |
| Python solver policy | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinSolverPolicy` | tolerance, iteration, operator, BC default | Python |
| IR schema | `crates/fullmag-ir/src/spin_transport.rs` | `struct SpinTransportModuleIR` | canonical transport module | IR |
| planner | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_spin_transport` | lane resolution and descriptor construction | planner |
| planner FEM | `crates/fullmag-plan/src/spin_transport.rs` | `materialize_fem_descriptor` | masks, markers, interfaces, BC | FEM CPU |
| planner FDM | `crates/fullmag-plan/src/spin_transport.rs` | `materialize_fdm_descriptor` | finite-volume descriptor | FDM |
| FDM runner | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_one_way_snapshot` | M1 source/field solve | FDM CPU |
| FDM runner | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_transient_module` | M3 stage/rollback solve | FDM CPU |
| FEM transport | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `run_steady_transport` | native FEM M1 ABI/runtime | FEM CPU |
| Python tests | `packages/fullmag-py/tests/test_spin_drift_diffusion.py` | `test_m1_module_serializes_canonical_typed_contract` | authoring contract | test |

(ddst-validation)=
## Validation status

Python tests cover M1 serialization, interface orientation, SML reservoir positivity, transient
capacitance/DOS normalization, coupling ownership, and separate solve/torque records. Planner
tests cover BC ownership, material completeness, operator identity, and unsupported combinations.
The bounded FEM M1 and FDM M3 reference gates must still be reported by their exact managed
recipes; no current evidence promotes full SHE/iSHE, mixing, SML, GPU, or coupled LLG transport.

(ddst-limitations)=
## Limitations

- Direct SHE/iSHE capabilities are versioned and not interchangeable with prescribed SOT.
- M2 reciprocal transport, mixing-conductance production, and full SML coupling remain gated.
- GPU transport is not qualified; no hidden CPU fallback is allowed.
- The public stage builder still lacks a one-call transport graph registration surface.
- A transport solve does not automatically create an `E_she` energy scalar; torque and flux
  observables are separate from conservative magnetic energy.

(ddst-scientific-bibliography)=
## Scientific bibliography

1. S. Zhang, P. M. Levy, and A. Fert, “Mechanisms of spin-polarized current-driven magnetization
   switching,” *Physical Review Letters* **88**, 236601 (2002),
   [doi:10.1103/PhysRevLett.88.236601](https://doi.org/10.1103/PhysRevLett.88.236601).
2. C. Petitjean, D. Luc, and X. Waintal, “Unified drift-diffusion theory for transverse spin
   currents,” *Physical Review Letters* **109**, 117204 (2012),
   [doi:10.1103/PhysRevLett.109.117204](https://doi.org/10.1103/PhysRevLett.109.117204).
3. Fullmag normative owner: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`.

(ddst-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Lane |
|---|---|---|---|
| solve object | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinDriftDiffusion` | Python |
| torque reference | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class DriftDiffusionSpinTorque` | Python |
| material contract | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinTransportMaterial` | Python |
| solver policy | `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinSolverPolicy` | Python |
| IR module | `crates/fullmag-ir/src/spin_transport.rs` | `struct SpinTransportModuleIR` | IR |
| planner resolution | `crates/fullmag-plan/src/spin_transport.rs` | `resolve_spin_transport` | planner |
| FEM descriptor | `crates/fullmag-plan/src/spin_transport.rs` | `materialize_fem_descriptor` | FEM CPU |
| FDM descriptor | `crates/fullmag-plan/src/spin_transport.rs` | `materialize_fdm_descriptor` | FDM |
| M1 runner | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_one_way_snapshot` | FDM CPU |
| M3 runner | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `solve_transient_module` | FDM CPU |
| FEM runtime | `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `run_steady_transport` | FEM CPU |
