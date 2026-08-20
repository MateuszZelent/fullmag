---
title: Thermal noise — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
target: public_docs/site/physics/interactions/thermal-noise/index.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Thermal noise

## Audit verdict

| Area | Verdict |
|---|---|
| Brown-field amplitude | Dimensionally and conventionally consistent with the documented H-field and `gamma_mu0` convention. |
| Random-number provenance | Strong seed/substream discussion. |
| SDE interpretation | Insufficiently prominent; Stratonovich semantics and integrator restrictions must be explicit. |
| Adaptive timestep behaviour | Needs a normative accepted/rejected-step random-draw contract. |
| FEM volume treatment | Any average-volume fallback is too weak for strict scientific execution. |
| Validation | Needs equilibrium and weak-convergence tests, not only seeded replay. |

Thermal noise is not a conservative energy interaction. It is a stochastic field contribution to
the LLG SDE, and the documentation should classify it accordingly.

## Required corrections

1. State explicitly that the white-noise LLG equation is interpreted in the Stratonovich sense for
   the physical multiplicative-noise model, and identify which integrators preserve that contract.
2. Define whether one random field is reused across all stages of an accepted RK/Heun step and how
   rejected adaptive steps rewind or retain the RNG stream.
3. In strict mode, reject missing local integration volumes. Do not silently replace FEM nodal or
   lumped volumes with a global average.
4. Harmonize zero-temperature behaviour: either `T = 0` is a valid disabled stochastic term or the
   high-level API omits the term. Constructor, planner, and docs must agree.
5. Separate deterministic replay within one realization from distributional equivalence across
   CPU/GPU, precision, decomposition, or RNG algorithm.
6. Add statistical validation gates before using `status: validated`.

## Proposed canonical stochastic model

For magnetic degree of freedom `i`, FullMag adds a random field `H_th,i` to the effective field.
For fixed timestep `Delta t`, local magnetic volume `V_i`, damping `alpha_i`, temperature `T_i`,
and the documented gyromagnetic constant `gamma_mu0` in m/(A s), draw

```math
H_{th,i}^{n}
=\sigma_i\,\eta_i^n,
\qquad
\sigma_i
=\sqrt{\frac{2\alpha_i k_B T_i}
{\gamma_{\mu_0}\mu_0M_{s,i}V_i\Delta t}},
```

where each Cartesian component of `eta` is standard normal under the declared spatial/temporal
independence policy.

Equivalently, the continuum correlation represented by the discrete draws is

```math
\left\langle H_{th,a}(t)H_{th,b}(t')\right\rangle
=\frac{2\alpha k_BT}{\gamma_{\mu_0}\mu_0M_sV}
\,\delta_{ab}\,\delta(t-t').
```

The exact prefactor is inseparable from the LLG form and gamma definition. Documentation must not
mix a `gamma` in 1/(T s), `gamma_mu0` in m/(A s), B-field noise in tesla, and H-field noise in A/m.
Any alternative convention requires an explicit conversion and a new formula identifier.

## SDE and timestep contract

- The physical white-noise LLG model is interpreted as a Stratonovich SDE.
- A fixed-step stochastic Heun/midpoint-type method is the reference integration path unless a
  different method has a documented weak/strong order proof or validation.
- One physical Wiener increment belongs to one attempted time interval. All internal stages that
  approximate that interval must use the integrator-defined correlated increment, not unrelated
  random vectors.
- For adaptive/rejected steps, the implementation must define Brownian-bridge subdivision or an
  equivalent reproducible policy. Simply drawing again after rejection changes the stochastic
  path and can bias acceptance.
- Noise amplitude scales as `Delta t^(-1/2)`; therefore changing timestep without changing the
  variance is incorrect.

## Spatial discretization contract

### FDM

Use the active magnetic cell volume, local `Ms`, local `alpha`, and local temperature. Inactive or
nonmagnetic cells receive zero stochastic field and consume RNG state only under an explicitly
documented indexing policy.

### FEM

Use the exact local stochastic mass/volume convention owned by the discretization, preferably
lumped nodal magnetic volumes derived from the same mass operator used by the LLG projection.
The page must state how heterogeneous `Ms`, damping, and temperature enter the nodal variance.
Missing or nonpositive local volume is a strict failure.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `H_th` | stochastic magnetic field | A/m |
| `T` | temperature | K |
| `alpha` | Gilbert damping | 1 |
| `k_B` | Boltzmann constant | J/K |
| `gamma_mu0` | gyromagnetic coefficient used with H | m/(A s) |
| `Ms` | saturation magnetization | A/m |
| `V` | local magnetic integration volume | m³ |
| `Delta t` | stochastic timestep | s |
| `eta` | standard normal random vector | 1 |

## Capability and reproducibility matrix

| Lane | Required public statement |
|---|---|
| FDM CPU | RNG family, counter/key mapping, local volume, precision, integrator, draw reuse |
| FDM GPU | device RNG algorithm, decomposition independence, precision, exact replay boundary |
| FEM CPU | nodal/lumped-volume definition and heterogeneous material handling |
| FEM GPU | device-resident mass/volume arrays, RNG mapping, and distributional parity evidence |

“Same seed” should promise bitwise replay only for the exact realization explicitly qualified. For
other lanes, promise matching distributions within declared statistical tolerances.

## Stage-first example

```python
# %% Fixed-step stochastic reference case
import fullmag as fm

nm = 1.0e-9
study = fm.study("thermal_noise_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(4 * nm, 4 * nm, 4 * nm))

particle = study.geometry(fm.Box(16 * nm, 16 * nm, 16 * nm), name="particle")
particle.Ms = 800.0e3
particle.Aex = 13.0e-12
particle.alpha = 0.02
particle.m = fm.texture.uniform(0.0, 0.0, 1.0)

study.exchange()
study.thermal_noise(temperature=300.0, seed=123456)
study.solver(integrator="heun", fix_dt=1.0e-14)
study.stages.add_run(stage_id="thermalize", until=1.0e-9)
```

Documentation CI should execute construction and serialization, verify `temperature`, `seed`, and
fixed timestep, and reject an unsupported adaptive stochastic integrator under strict mode. It
must not claim that a one-nanosecond trajectory validates thermodynamics.

## Required validation suite

1. **RNG unit tests:** normal mean, variance, tails, cross-component correlation, and counter
   collision checks.
2. **Amplitude:** compare measured component variance with the exact formula for several
   `T`, `alpha`, `Ms`, `V`, and `Delta t` values.
3. **Scaling:** verify variance proportional to `T`, `alpha`, `1/Ms`, `1/V`, and `1/Delta t`.
4. **Fixed-seed replay:** exact replay within each declared realization.
5. **Macrospin equilibrium:** compare angular distribution with the Boltzmann distribution for a
   known anisotropy/field energy.
6. **Equipartition/small oscillations:** compare mode energies in a linearized regime.
7. **Weak timestep convergence:** compare ensemble observables for decreasing timestep.
8. **Mesh dependence:** verify that local-volume scaling does not create artificial temperature
   changes under refinement.
9. **FEM mass convention:** compare lumped and reference quadrature statistics on nonuniform
   meshes.
10. **CPU/GPU distributional parity:** use confidence intervals and multiple seeds; do not compare
    one trajectory pointwise unless bitwise identity is a declared feature.

## Recommended extensions

- spatial temperature fields with interpolation and discontinuity semantics;
- coloured noise only as a separate correlation model with its own state and integrator;
- Brownian-bridge adaptive stepping;
- ensemble-study objects with confidence intervals and reproducible seed allocation;
- checkpoint/restart that preserves the complete RNG state and pending Wiener increments.

## Bibliography

- W. F. Brown Jr., “Thermal fluctuations of a single-domain particle,” *Physical Review* **130**,
  1677–1686 (1963), DOI `10.1103/PhysRev.130.1677`.
- J. L. García-Palacios and F. J. Lázaro, “Langevin-dynamics study of the dynamical properties of
  small magnetic particles,” *Physical Review B* **58**, 14937 (1998), DOI
  `10.1103/PhysRevB.58.14937`.
