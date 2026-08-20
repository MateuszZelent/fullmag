---
title: Charge–spin drift-diffusion and transfer torque — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/drift-diffusion-spin-torque/index.md
  - public_docs/site/python-api/interactions/drift-diffusion-spin-torque.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Charge–spin drift-diffusion and transfer torque

## Audit verdict

| Area | Verdict |
|---|---|
| Voltage, spin-splitting, current-tensor, and factor-of-two conventions | Explicit and internally consistent. |
| M1 one-way constitutive law | Correctly excludes inverse-SHE and reciprocal longitudinal feedback. |
| M2 reciprocal constitutive law | Coherent, including AMR/PHE/AHE tensor and the stated Schur positivity gate. |
| Reaction-to-torque ownership | Correctly excludes spin-flip relaxation from magnetic torque. |
| Capability statement | Honest inside the page, but inconsistent with front matter `status: implemented`. |
| Example | Current stage-first M2 example is valuable but too advanced for the first user path. |
| Page architecture | Approximately 79 kB and too monolithic for a model with two closures, several boundary/interface laws, torque, solver policy, and four execution lanes. |
| Transient scope | Public objects expose transient/capacitance vocabulary, while the root physics model is framed as steady; ownership and executable status need a separate page. |

## Required corrections

1. Replace the page-wide status with `partial` or a generated capability summary. The general
   `DriftDiffusionSpinTorque` capability is explicitly `semantic_only`; bounded CPU workflows do
   not justify `implemented` for all solver/device combinations.
2. Split the root into:
   - conventions and overview;
   - M1 steady one-way transport;
   - M2 steady reciprocal transport;
   - transient spin accumulation, if retained publicly;
   - boundaries and interfaces;
   - transfer torque and LLG coupling;
   - API/IR and solver policy;
   - validation and benchmarks.
3. Keep the definitions `mu_s` in volts and `G = -grad(mu_s)/2` adjacent to every constitutive
   equation. Omitting either convention creates a factor-of-two error.
4. Define every interface normal and flux orientation. Mixing conductance, specified flux, and
   spin-memory-loss signs cannot be reconstructed from scalar parameter names alone.
5. State that `Q_ia` is a rank-two charge-equivalent spin-current tensor: index `i` is flow
   direction and `a` is spin polarization. Do not visualize or serialize it as one unlabelled
   vector.
6. Separate transport dissipation/power from conservative magnetic energy. No scalar
   `E_drift_diffusion_torque` should be invented.
7. Record the charge source, transport formula/operator version, material assignment, interface
   graph, boundary coverage, gauge, nonlinear policy, solved-state revision, and torque target in
   provenance.
8. Clarify the relationship between the legacy semantic `DriftDiffusionSpinTorque` class and the
   canonical solve-bound `DriftDiffusionSpinTorque(id, solve_id, target)` workflow. Ambiguous
   overloads need a migration table or separate class names.

## Public conventions

FullMag uses:

- conventional charge current `J_c`;
- charge electrochemical potential `V` in volts;
- full spin-channel splitting `mu_s` in volts;
- a charge-equivalent spin-current tensor `Q` in A/m²;
- a right-handed Cartesian frame and Levi–Civita tensor;
- positive elementary charge `e` and positive angular gyromagnetic magnitude `gamma_e`.

Define

```math
E_i=-\partial_i V,
\qquad
G_{ia}=-\frac{1}{2}\partial_i\mu_{s,a}.
```

The factor `1/2` follows from using the full up-minus-down spin-channel splitting. Imported data or
literature formulas using half splitting, energy units, or spin-angular-momentum current require an
explicit conversion.

## M1 — steady one-way charge-to-spin transport

M1 solves charge first and then solves spin without feeding the spin solution back into the charge
current:

```math
J_{c,i}=\sigma E_i,
```

```math
Q_{ia}
=\sigma_sG_{ia}
+P\sigma E_i m_a
+\theta_{SH}\sigma\epsilon_{ika}E_k.
```

The last term is direct spin Hall generation. M1 deliberately excludes inverse SHE and reciprocal
longitudinal charge–spin feedback. It is appropriate only when that one-way approximation is part
of the requested physical model.

## M2 — steady reciprocal charge–spin transport

The magnetoresistive charge current is

```math
J_{mr}
=\sigma_{\perp}E
+(\sigma_{\parallel}-\sigma_{\perp})(m\cdot E)m
+\sigma_{AHE}\,m\times E.
```

The complete reciprocal constitutive block is

```math
J_{c,i}
=J_{mr,i}+P\sigma m_aG_{ia}
+\theta_{SH}\sigma\epsilon_{ija}G_{ja},
```

```math
Q_{ia}
=\sigma_sG_{ia}+P\sigma E_i m_a
+\theta_{SH}\sigma\epsilon_{ika}E_k.
```

The symmetric anisotropic charge tensor contains AMR and planar Hall response. The antisymmetric
`m × E` term contains AHE and does not contribute to local Joule dissipation. The reference scalar
`sigma` in the reciprocal charge–spin blocks is not silently replaced by `sigma_parallel` or
`sigma_perpendicular`.

For the declared parameterization, the dissipative longitudinal block requires

```math
\min(\sigma_{\parallel},\sigma_{\perp})\,\sigma_s-P^2\sigma^2>0.
```

Validation should also reject non-finite conductivities and any nonpositive conductivity that is
required by the active formula.

## Spin reactions and balance

FullMag defines

```math
R_{sf}=\frac{\sigma_s}{2\lambda_{sf}^2}\mu_s,
```

```math
R_J=\frac{\sigma_s}{2\lambda_J^2}(\mu_s\times m),
```

```math
R_{\phi}
=\frac{\sigma_s}{2\lambda_{\phi}^2}
 m\times(\mu_s\times m).
```

The steady balance is

```math
\partial_iQ_{ia}
=-R_{sf,a}-R_{J,a}-R_{\phi,a}.
```

An absent `lambda_J` or `lambda_phi` disables that reaction. A zero diffusion/reaction length is
not a disable flag and must fail validation.

`R_sf` transfers spin angular momentum to an unresolved lattice/reservoir. Only the transverse
exchange and dephasing channels act on magnetization in this model:

```math
T_{tr,G}
=-\frac{\gamma_e}{M_s}\frac{\hbar}{2e}
(R_J+R_{\phi}).
```

This is a Gilbert-source rate in 1/s and must undergo the common Gilbert-to-explicit conversion
exactly once.

## Boundary and interface contract

Every exterior spin boundary must have exactly one declared owner or an explicit default policy.
The documentation should give equations, units, normal orientation, and sign for each supported
variant:

- spin insulating: zero outward normal spin flux;
- perfect spin sink: declared spin accumulation, commonly zero;
- specified spin potential: Dirichlet `mu_s` in volts;
- specified spin flux: outward charge-equivalent `Q·n` in A/m²;
- periodic spin boundary: orientation-preserving facet pairing and translation;
- transparent internal interface: continuity of spin potential and normal spin flux within the
  selected conforming/discontinuous discretization;
- mixing-conductance interface: longitudinal and transverse interfacial currents with an oriented
  normal and explicitly stated conductance units;
- spin-memory-loss reservoir: separately parameterized loss channels and angular-momentum sink.

Conductances reported in literature as dimensionless channel counts per area, `1/m²`, or
`ohm^-1 m^-2` are not interchangeable. The public API must state that it expects SI S/m² and any
conversion must name the convention used.

## Transient extension

If `mode="transient"` and a spin capacitance remain public, they need a separate governing equation,
for example a declared storage term multiplying `partial_t mu_s`, together with:

- exact capacitance units and density-of-states conversion;
- initial condition;
- time integrator and stability/error policy;
- coupling schedule relative to LLG and charge transport;
- checkpoint/restart state;
- executable lane matrix.

Until those items are complete, transient objects should be labelled `semantic_only`; the steady
M1/M2 page must not imply transient execution.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `V` | charge electrochemical potential | V |
| `mu_s` | full spin-channel splitting | V |
| `E` | electric field | V/m |
| `G` | negative half-gradient of spin voltage | V/m |
| `J_c` | conventional charge-current density | A/m² |
| `Q_ia` | charge-equivalent spin-current tensor | A/m² |
| `sigma`, `sigma_s` | reference charge and spin conductivities | S/m |
| `sigma_parallel`, `sigma_perpendicular`, `sigma_AHE` | magnetoresistive conductivities | S/m |
| `P`, `theta_SH` | signed reciprocal polarization and spin-Hall coefficients | 1 |
| `lambda_sf`, `lambda_J`, `lambda_phi` | spin-flip, exchange, and dephasing lengths | m |
| `R_sf`, `R_J`, `R_phi` | reaction current densities per volume | A/m³ |
| `T_tr` | magnetic transfer-torque rate | 1/s |

## Bounded stage-first M2 example

The first user tutorial should be M1. The following M2 cell is appropriate as an advanced,
strictly bounded example because it uses the current public API and records the exact operator:

```python
# %% Bounded reciprocal FEM M2 problem
import fullmag as fm

study = fm.study("bounded_fem_m2_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

strip = study.geometry(fm.Box(30e-9, 20e-9, 4e-9), name="strip")
strip.Ms = 8.0e5
strip.Aex = 13.0e-12
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.0, 0.0)

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

study.spin_torque(
    fm.DriftDiffusionSpinTorque(
        "transport_torque",
        spin.id,
        region,
    )
)
study.stages.add_run(1.0e-15, stage_id="m2_run")
```

Documentation CI should execute construction and serialization, verify complete boundary ownership,
operator/version identity, solve-to-torque reference integrity, and the requested strict CPU/FP64
slice. It must not call this a production benchmark.

## Capability statement

| Solver/device | M1 | M2 | General torque capability |
|---|---|---|---|
| FDM CPU | `reference_executable` | bounded `reference_executable` | bounded solve-bound torque only |
| FDM GPU | `semantic_only` | `semantic_only` | `semantic_only` |
| FEM CPU | bounded `reference_executable` | narrower bounded `reference_executable` | bounded solve-bound torque only |
| FEM GPU | `semantic_only` | `semantic_only` | `semantic_only` |

The exact matrix should come from the capability registry, including precision, interface,
boundary, material, and domain restrictions.

## Required validation suite

1. **Ohmic reference:** linear potential and constant current in a homogeneous bar.
2. **Charge conservation:** volume residual and integrated boundary-current balance.
3. **One-dimensional spin diffusion:** exponential/hyperbolic analytic solutions for spin sink and
   insulating boundaries.
4. **M1 SHE sign:** current, interface normal, and spin-polarization orientation tests.
5. **M2 reciprocity:** compare direct and inverse cross-coefficients under the documented
   force/flux convention.
6. **Dissipation:** verify nonnegative symmetric constitutive/reaction dissipation when the Schur
   gate passes; antisymmetric Hall terms should not contribute.
7. **Schur gate:** approach and cross the positivity boundary deliberately.
8. **Interface flux:** continuity, mixing conductance, spin-memory loss, and normal reversal.
9. **Spin balance:** integrated divergence equals boundary flux plus all reaction sinks.
10. **Angular momentum:** integrated `R_J + R_phi` matches magnetic torque with the exact
    `hbar/(2e)` conversion; `R_sf` is excluded.
11. **Mesh/order convergence:** potential, spin splitting, currents, reactions, and torque.
12. **Nonlinear M2:** convergence and tolerance independence of the coupled/Picard/Newton policy.
13. **CPU lane parity:** compare independent FDM/FEM reference problems within discretization
    error, not raw nodal arrays.
14. **Failure semantics:** GPU requests, unsupported interfaces, incomplete boundaries, zero
    lengths, missing gauge, and stale source revisions fail closed.
15. **Round-trip:** preserve every region, surface, normal, material, interface, boundary, solver,
    formula/operator version, and target binding.

## Recommended extensions

- a short M1 tutorial before the reciprocal M2 reference;
- explicit transient spin-capacitance model and tests;
- device-resident FDM/FEM GPU operators with strict no-fallback provenance;
- discontinuous/material-interface formulations beyond the bounded conforming FEM slice;
- self-consistent spin pumping and inverse-SHE only as separately versioned reciprocal extensions;
- transport diagnostics for charge residual, spin residual, boundary flux, entropy production, and
  angular-momentum transfer;
- automatic conversion helpers for common spin-mixing-conductance conventions;
- reduced-order and frequency-domain charge–spin response after steady validation is complete.

## Bibliography

- C. Abert et al., “A three-dimensional spin-diffusion model for micromagnetics,”
  *Scientific Reports* **5**, 14855 (2015), DOI `10.1038/srep14855`.
- C. Abert et al., “Self-consistent micromagnetic simulations including spin-diffusion effects,”
  *Physical Review B* **94**, 134408 (2016), DOI `10.1103/PhysRevB.94.134408`.
- A. Brataas, A. D. Kent, and H. Ohno, “Current-induced torques in magnetic materials,”
  *Nature Materials* **11**, 372–381 (2012).
