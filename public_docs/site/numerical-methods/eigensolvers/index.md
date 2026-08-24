---
title: Eigensolvers
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: linearized-llg, modal-validation, their source maps, and source revision 0388c3e7c4804923ee02a00b7ac4a789a44092d9
---

(public-docs-numerical-methods-eigensolvers-root)=
# Linearized-LLG eigensolvers

:::{admonition} Native lane boundary
:class: important

The public eigenmode request is not a promise of universal backend support. At the reviewed
revision, FEM owns several bounded modal slices rather than one universally production-qualified
lane. FDM CPU and FDM CUDA modal execution are unsupported. FEM CPU/GPU scope, demagnetization,
Floquet sampling, and external eigensolver availability must be demonstrated by resolved
provenance.
:::

## Purpose

The eigensolver computes small-amplitude normal modes around a declared equilibrium
$\mathbf m_0$. It answers a different question from time integration:

- time integration follows a finite-amplitude initial condition and can contain nonlinear mode
  coupling, switching, and transient forcing;
- a modal solve linearizes the complete enabled operator at one equilibrium and returns complex
  frequencies and mode profiles in the tangent space.

The result is meaningful only for the exact equilibrium, material fields, demagnetization
realization, boundary conditions, damping policy, mesh, and linearization convention recorded by
the study.

## Equilibrium prerequisite

The state must satisfy

```{math}
:label: eq-eigen-root-equilibrium
|\mathbf m_0|=1,
\qquad
\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0]
\approx\mathbf0.
```

A relaxation stage that ended because `max_steps` was exhausted is not automatically an
equilibrium. The modal provenance must include the source of the state (`relax`, `provided`, or
`artifact`), its digest, maximum torque, energy/stopping metrics, and whether the equilibrium gate
passed.

Linearization around an unconverged state introduces a residual forcing term and can shift,
split, or destabilize the computed spectrum. Mesh refinement cannot repair that error.

## Tangent-space representation

Write

```{math}
:label: eq-eigen-root-perturbation
\mathbf m(\mathbf x,t)
=\mathbf m_0(\mathbf x)+\delta\mathbf m(\mathbf x,t)
+O(\lVert\delta\mathbf m\rVert^2).
```

The first-order unit-length constraint is

```{math}
:label: eq-eigen-root-tangent-constraint
\mathbf m_0\cdot\delta\mathbf m=0.
```

At each magnetic degree of freedom, choose an orthonormal tangent frame
$(\mathbf e_1,\mathbf e_2)$ and write

```{math}
:label: eq-eigen-root-tangent-basis
\delta\mathbf m=\mathbf e_1q_1+\mathbf e_2q_2.
```

This reduces the dynamic unknown from three constrained components to two unconstrained tangent
coordinates. The basis is not unique: rotating $(\mathbf e_1,\mathbf e_2)$ changes coordinate
vectors but must not change physical eigenfrequencies or reconstructed three-component mode fields.
A basis-invariance test is therefore part of modal validation.

## Linearization of the LLG operator

Let

```{math}
:label: eq-eigen-root-effective-field-jacobian
\delta\mathbf H_{\mathrm{eff}}
=\mathcal D\mathbf H_{\mathrm{eff}}[\mathbf m_0]
\,\delta\mathbf m
```

be the Fréchet derivative of the complete enabled effective field. It contains the linearized
exchange, anisotropy, DMI, demagnetizing, coupling, and any other supported terms. Omitting dynamic
demagnetization while retaining static demagnetization defines a different operator and must be
explicitly requested and reported.

For the undamped conservative part, the first-order LLG structure contains

```{math}
:label: eq-eigen-root-linearized-precession
\partial_t\delta\mathbf m
=-\gamma\left[
\mathbf m_0\times\delta\mathbf H_{\mathrm{eff}}
+\delta\mathbf m\times\mathbf H_{\mathrm{eff},0}
\right],
```

with additional terms when damping or nonconservative torques are included. Fullmag assembles the
final tangent problem as the production generalized complex pencil

```{math}
:label: eq-eigen-root-pencil
\mathsf L\mathbf q
=\lambda\mathsf B_{\alpha}\mathbf q,
\qquad
\lambda=\mathrm i\omega,
\qquad
\omega=-\mathrm i\lambda,
\qquad
f=\frac{\operatorname{Re}\omega}{2\pi}.
```

`linearized-llg` is the public operator family. Here $\mathsf L$ has units $\mathrm{s^{-1}}$ and
$\mathsf B_{\alpha}$ is dimensionless. The exact placement of signs, gyromagnetic factors, mass
matrices, and damping blocks is owned by the native operator and its provenance. Damped spectra can
make $\omega$ complex; cyclic frequency comes only from its real part. Taking $|\omega|$ would mix
oscillation with damping and discard the branch sign. The temporal ansatz and recorded
eigenvalue-to-frequency mapping must be consulted before interpreting decay or growth.

## Damping policy

`damping_policy="ignore"` and `damping_policy="include"` are different eigenproblems.

- Ignoring damping is useful for conservative mode frequencies and often yields a structured
  imaginary spectrum.
- Including Gilbert damping produces complex eigenvalues whose real and imaginary parts encode
  decay/growth and oscillation according to the recorded sign convention.

A frequency comparison between these policies is not CPU/GPU parity. Likewise, a linewidth or
lifetime derived from $\sigma$ is invalid if the solver output does not preserve the temporal
convention and eigenvalue units.

## Spectral targeting

The public stage supports:

| Target | Required data | Intended selection |
|---|---|---|
| `lowest` | mode count | lowest requested positive-frequency modes according to the native ordering policy |
| `nearest` | `target_frequency` | modes nearest a declared frequency |
| `frequency_window` | `frequency_min`, `frequency_max` | modes inside a declared interval |

Target selection is not a convergence criterion. The native solver must report the returned
candidate count, converged count, residuals, ordering, rejected/filtered modes, and dependency
status. Shift-and-invert or other spectral transformations may be appropriate for interior targets,
but this documentation does not claim that a particular transformation ran unless provenance says
so.

## Bloch and Floquet sampling

For a lattice vector $\mathbf R$ and wave vector $\mathbf k$, a Bloch perturbation satisfies

```{math}
:label: eq-eigen-root-bloch
\delta\mathbf m(\mathbf r+\mathbf R)
=\delta\mathbf m(\mathbf r)
\exp\!\left(\mathrm i\mathbf k\cdot\mathbf R\right).
```

The same phase convention must be applied consistently to exchange/DMI couplings, tangent basis,
periodic node equivalence, dynamic demagnetization, and output reconstruction. A periodic static
mesh with a nonperiodic dynamic operator is not a valid Bloch eigensolve.

`k_vector` requests one sample; `k_sampling` requests a sequence used to construct a dispersion.
Mode indices alone do not identify branches across $\mathbf k$. Robust branch tracking should use
complex mode overlap, symmetry, frequency continuity, and an explicit degeneracy policy.

## Mode normalization and phase

An eigenvector is arbitrary under nonzero complex scaling:

```{math}
:label: eq-eigen-root-phase
\mathbf q\sim c\mathbf q,
\qquad c\in\mathbb C\setminus\{0\}.
```

Fullmag exposes `unit_l2` and `unit_max_amplitude` normalization requests. The selected convention
must be applied after the tangent vector is reconstructed and must remain attached to saved mode
fields. Neither normalization assigns a physical oscillation amplitude; linear modes are shape
functions.

For visualization or branch overlap, a deterministic phase may be fixed by selecting a reference
degree of freedom and rotating its dominant component to be real and positive. Such a display phase
must not be confused with an additional physical constraint.

## Residual and orthogonality diagnostics

For a computed pair $(\lambda,\mathbf q)$,

```{math}
:label: eq-eigen-root-residual
\mathbf r=\mathsf L\mathbf q-\lambda\mathsf B_{\alpha}\mathbf q,
\qquad
\varepsilon_{\mathrm{eig}}
=\frac{\lVert\mathbf r\rVert_2}
{\lVert\mathsf L\mathbf q\rVert_2
+|\lambda|\lVert\mathsf B_{\alpha}\mathbf q\rVert_2}.
```

The denominator convention above is a recommended scale-invariant diagnostic; the native solver's
reported residual definition must be preserved exactly. A finite frequency without a residual is
not a qualified mode.

For non-Hermitian damped problems, Euclidean right-eigenvector orthogonality is generally not
expected. Any orthogonality or biorthogonality claim must specify the metric and whether left modes
were computed. Fullmag's public normalization request alone does not imply such a relation.

## Public Python workflow

```python
# %% Equilibrium followed by FEM eigenmodes
import fullmag as fm

nm = 1.0e-9
study = fm.study("linearized_llg_modes")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="nonlinear_cg",
    tolT=1.0e-6,
    max_steps=50_000,
)
study.stages.add_eigenmodes(
    count=12,
    target="lowest",
    operator="linearized_llg",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
```

### Public parameter contract

| Parameter | Default | Unit | Meaning and validation |
|---|---:|---:|---|
| `count` | `10` | $1$ | positive number of requested modes |
| `target` | `lowest` | $1$ | `lowest`, `nearest`, or `frequency_window` |
| `target_frequency` | `None` | $\mathrm{Hz}$ | required by `nearest` |
| `frequency_min`, `frequency_max` | `None` | $\mathrm{Hz}$ | required and ordered for a frequency window |
| `operator` | `linearized_llg` | $1$ | supported tangent dynamic operator |
| `include_demag` | `True` | $1$ | includes the supported dynamic demagnetization contribution |
| `equilibrium_source` | `relax` | $1$ | `relax`, `provided`, or `artifact` |
| `equilibrium_artifact` | `None` | $1$ | required with `artifact`; digest belongs to provenance |
| `normalization` | `unit_l2` | $1$ | `unit_l2` or `unit_max_amplitude` |
| `damping_policy` | `ignore` | $1$ | `ignore` or `include` |
| `k_vector` | `None` | $\mathrm{m^{-1}}$ | finite three-vector for one Bloch sample |
| `k_sampling` | `None` | $1$ | validated dispersion-sampling object |
| `bc` | `free` | $1$ | supported spin-wave boundary schema |

The stage lowers to `StudyIR::Eigenmodes`. Requested parameters remain separate from resolved FEM
execution, dependency selection, matrix dimensions, tangent degree-of-freedom count, and solver
diagnostics.

## Realization matrix

| Solver | Device | Status | Meaning |
|---|---|---|---|
| FEM | CPU | partial-production-executable | reference/MVP artifacts and a bounded selected-spectrum, no-demag, Full2x2 Floquet slice; general Poisson-airbox/SLEPc production remains gated |
| FEM | GPU | partial-production-executable | narrow $k=0$, no-demag macrospin/Kittel cuSolverDN slice; Poisson-airbox dense paths remain algebraic or gated |
| FDM | CPU | unsupported | no native production FDM eigen lane is claimed |
| FDM | GPU | unsupported | no public CUDA modal lane is claimed |

Unsupported combinations must fail before expensive assembly. They must not route through a hidden
FEM CPU solve while retaining requested FDM/GPU provenance.

## Implementation mapping

| Responsibility | Repository path | Stable symbol | Evidence boundary |
|---|---|---|---|
| Public modal schema | `packages/fullmag-py/src/fullmag/world.py` | `class EigenmodesStageSpec` | validates modal request fields |
| Ordered modal stage | `packages/fullmag-py/src/fullmag/world.py` | `eigenmodes_stage` | stage construction and lowering input |
| Native modal contract | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract` | FEM modal validation, execution contract, and diagnostics |
| Eigenvalue/frequency mapping | `backends/fem/src/frequency_domain/mode_kinematics.cpp` | `frequency_hz_from_omega_rad_s` | converts the signed real angular-frequency component selected by `map_eigenvalue` to cyclic frequency |
| Dispersion-validation schema | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class ThinFilmDEBVDispersionValidation` | typed DE/BV validation intent |
| Kittel-validation schema | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class K0KittelFieldSweepValidation` | typed field-sweep validation intent |

The source map in {doc}`linearized-llg` links equations and public parameters to these symbols. It
deliberately does not manufacture FDM/GPU ownership where no native source claim exists.

## Modal validation programme

### Equilibrium and algebraic gates

Every mode set should report:

- maximum equilibrium torque and equilibrium completion reason;
- tangent constraint error after reconstruction;
- eigenvalue residual for every returned mode;
- finite/NaN checks, converged mode count, and target-selection diagnostics;
- normalization and phase convention;
- mesh/order, demagnetization, damping, boundary, precision, and dependency metadata.

### Analytical references

Fullmag exposes typed validation intent for:

1. **Kittel field sweeps** at $\mathbf k=0$, with at least three unique nonzero bias-field samples
   and an explicit macrospin/thin-film model;
2. **Damon--Eshbach and backward-volume dispersion**, with film thickness, equilibrium direction,
   film normal, branch/sample mapping, wave-vector bound, analytical model, and relative-error
   threshold.

For sample $j$,

```{math}
:label: eq-eigen-root-reference-error
\varepsilon_j
=\frac{|f_j^{\mathrm{num}}-f_j^{\mathrm{ref}}|}
{|f_j^{\mathrm{ref}}|}.
```

A passing error threshold without a reproducible branch assignment, equilibrium metric, eigen
residual, and demagnetization assumption is incomplete. See {doc}`modal-validation`.

### Mesh convergence and branch overlap

For normalized complex reconstructed modes $u_h$ and $u_{h/2}$ transferred to a common space, a
phase-insensitive overlap is

```{math}
:label: eq-eigen-root-mode-overlap
\mathcal O
=\frac{|\langle u_h,u_{h/2}\rangle|}
{\lVert u_h\rVert\,\lVert u_{h/2}\rVert}.
```

Report both frequency convergence and overlap. Frequency agreement alone can hide branch swapping
or a different localized mode.

## Failure semantics

The request must fail explicitly for invalid frequency windows, missing equilibrium artifacts,
unsupported operator names, illegal normalization/damping/boundary values, unavailable solver
dependencies, insufficient converged modes, non-finite eigenpairs, or unsupported backend/device
combinations. Returning fewer modes than requested is not success unless the result schema records a
partial result and the caller explicitly permits it.

## Limitations

- The reviewed modal implementations are bounded FEM slices, not one universal FEM production lane.
- Universal FEM GPU qualification is not claimed.
- A static periodic mesh does not establish a valid Floquet dynamic-demagnetization operator.
- Linear modes do not predict nonlinear saturation amplitude or mode coupling.
- `unit_l2` and `unit_max_amplitude` are numerical normalizations, not thermal or driven amplitudes.
- Analytical Kittel and thin-film dispersion checks qualify only their declared parameter domain.
- Dependency availability and matrix assembly success do not replace residual and mesh-convergence
  evidence.

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
2. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**, 155
   (1948), [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
3. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for
   ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State
   Physics* **19**, 7013--7033 (1986),
   [doi:10.1088/0022-3719/19/35/014](https://doi.org/10.1088/0022-3719/19/35/014).
4. V. Hernández, J. E. Román, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the
   solution of eigenvalue problems,” *ACM Transactions on Mathematical Software* **31**, 351--362
   (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
5. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

```{toctree}
:maxdepth: 1

linearized-llg
modal-validation
```
