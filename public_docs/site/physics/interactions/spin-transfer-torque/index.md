---
title: Spin-transfer torque
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-stt)=
# Spin-transfer torque

Spin-transfer torque (STT) is a non-conservative LLG source. Fullmag exposes local
Slonczewski CPP/MTJ and Zhang–Li CIP models, plus canonical source-binding variants. Legacy
formula versions remain distinguishable in `ProblemIR`; they must not be relabelled as the
canonical SI models.

(physics-spin-transfer-torque-problem-statement)=
## Physical problem

Spin-transfer torque models angular-momentum transfer from spin-polarized charge currents via two
local mechanisms: Slonczewski perpendicular/multilayer torque (`SlonczewskiSTT`) and Zhang–Li
current-in-plane gradient torque (`ZhangLiSTT`).

(physics-spin-transfer-torque-governing-equations)=
## Governing equations

### Common torque convention

A torque module authors a Gilbert-source rate $\mathbf T_G$. Fullmag converts it to the
explicit LLG RHS exactly once:

```{math}
:label: eq-public-spin-transfer-torque-stt-gilbert-explicit
\mathbf T_{\mathrm{explicit}}
=
\frac{\mathbf T_G+\alpha\,\mathbf m\times\mathbf T_G}{1+\alpha^2}.
```

A backend must not pre-convert the same source and then let the LLG layer convert it again.

## Slonczewski CPP/MTJ torque

For unit spin-polarization direction $\hat{\mathbf p}$ and oriented stack normal $\hat{\mathbf n}_{\mathrm{stack}}$:

```{math}
:label: eq-public-spin-transfer-torque-stt-slonczewski
\mathbf T_{\mathrm{SL},G}
=
\Omega_{\mathrm{DL}}\,
\mathbf m\times(\hat{\mathbf p}\times\mathbf m)
+
\Omega_{\mathrm{FL}}\,
\mathbf m\times\hat{\mathbf p},
```

where the canonical `slonczewski.fullmag.v2` prefactor and Slonczewski angular asymmetry factor are

```{math}
:label: eq-public-spin-transfer-torque-stt-slonczewski-rates
\Omega_J = \frac{\gamma_e\hbar J_\perp}{e M_s t_F},
\qquad
J_\perp = \mathbf J_c\cdot\hat{\mathbf n}_{\mathrm{stack}},
\qquad
\epsilon_{\mathrm{DL}}(\mathbf m)
=
\frac{P\Lambda^2}{(\Lambda^2+1)+(\Lambda^2-1)(\mathbf m\cdot\hat{\mathbf p})},
```

with $\Omega_{\mathrm{DL}} = -\Omega_J\,\epsilon_{\mathrm{DL}}(\mathbf m)$ (so that $\Omega_{\mathrm{DL}}\,\mathbf m\times(\hat{\mathbf p}\times\mathbf m) = +\Omega_J\,\epsilon_{\mathrm{DL}}\,\mathbf m\times(\mathbf m\times\hat{\mathbf p})$ in backend kernels) and $\Omega_{\mathrm{FL}} = \Omega_J\,\epsilon'$.
Legacy `slonczewski.legacy_fullmag.v0` uses a factor of $2$ in the denominator of $\Omega_J$ and applies $\epsilon_{\mathrm{DL}}$ to both the damping-like and $\epsilon'$ field-like terms.

The canonical model uses a signed normal current density, an oriented stack normal, target
$M_s$, and either a free-layer thickness or an explicitly resolved interface realization.
Current sign, stack-normal orientation, and fixed-layer polarization remain independent
authored quantities.

## Zhang–Li CIP torque

For conventional current density $\mathbf J_c$,

```{math}
:label: eq-public-spin-transfer-torque-stt-zhang-li-velocity
\mathbf u
=
\frac{g\mu_{\mathrm B}P}{2eM_s}\mathbf J_c ,
```

and

```{math}
:label: eq-public-spin-transfer-torque-stt-zhang-li
\mathbf T_{\mathrm{ZL},G}
=
-(\mathbf u\cdot\nabla)\mathbf m
+
\beta\,\mathbf m\times
[(\mathbf u\cdot\nabla)\mathbf m].
```

The exact sign is tied to conventional charge current ($e > 0$) and the
Fullmag LLG convention rather than electron-flow sign.

```{figure} /_static/diagrams/stt-slonczewski-vs-zhang-li.svg
:alt: Comparison of Slonczewski CPP/MTJ trilayer torque with computed angular asymmetry curves epsilon_DL(theta) versus Zhang-Li CIP domain-wall translation, plus the single Gilbert-to-explicit conversion invariant.
:width: 100%
:name: fig-stt-slonczewski-vs-zhang-li
:figclass: fm-physics-figure

Side-by-side physics and Fullmag formula comparison for local spin-transfer torques. **(a)** `SlonczewskiSTT` CPP/MTJ trilayer geometry (`slonczewski.fullmag.v2`) and computed angular asymmetry $\epsilon_{\mathrm{DL}}(\theta)$ at $P = 0.40$ for $\Lambda \in \{1.0, 1.5, 2.0\}$. **(b)** `ZhangLiSTT` CIP domain-wall profile $\mathbf m(x)$ separating conventional charge current $\mathbf J_c$ from electron drift, showing adiabatic wall drag and non-adiabatic out-of-plane canting. The bottom guard states Fullmag's single Gilbert-to-explicit RHS conversion invariant.
```

(physics-spin-transfer-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf m$ | unit magnetization vector | $1$ |
| $\mathbf J_c$ | signed conventional charge-current density | $\mathrm{A\,m^{-2}}$ |
| $J_\perp$ | signed current density normal to stack | $\mathrm{A\,m^{-2}}$ |
| $\hat{\mathbf n}_{\mathrm{stack}}$ | unit stack normal | $1$ |
| $\hat{\mathbf p}$ | spin-polarization direction | $1$ |
| $P$ | spin polarization degree | $1$ |
| $\Lambda$ | Slonczewski angular asymmetry parameter | $1$ |
| $\epsilon_{\mathrm{DL}}$ | Slonczewski angular efficiency | $1$ |
| $\epsilon'$ | secondary field-like Slonczewski coefficient | $1$ |
| $\beta$ | Zhang–Li non-adiabaticity | $1$ |
| $g$ | Landé $g$-factor | $1$ |
| $\mu_{\mathrm B}$ | Bohr magneton | $\mathrm{J\,T^{-1}}$ |
| $\gamma_e$ | positive magnitude of electron gyromagnetic ratio | $\mathrm{s^{-1}\,T^{-1}}$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | positive elementary charge | $\mathrm{C}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $t_F$ | physical free-layer thickness | $\mathrm{m}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $\mathbf u$ | spin-drift velocity | $\mathrm{m\,s^{-1}}$ |
| $\Omega_J$ | Slonczewski base torque frequency | $\mathrm{s^{-1}}$ |
| $\Omega_{\mathrm{DL}},\Omega_{\mathrm{FL}}$ | torque rates | $\mathrm{s^{-1}}$ |
| $\mathbf T_G,\mathbf T_{\mathrm{explicit}}$ | Gilbert-source and explicit RHS torques | $\mathrm{s^{-1}}$ |

(physics-spin-transfer-torque-assumptions-and-validity)=
## Assumptions and validity

The authored models assume continuum-scale magnetization ($\lVert\mathbf m\rVert_2 = 1$), positive local $M_s$, and strictly separate `SlonczewskiSTT` (volumetric thin-layer homogenized or schema-only interface flux) and `ZhangLiSTT` (gradient-driven diffusive adiabatic/non-adiabatic) regimes within the discretization and capability limits stated on this page.

(physics-spin-transfer-torque-discrete-realization)=
## Capability matrix

The exact result depends on formula version (legacy versus canonical), target kind, current
source, and realization.

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | legacy and selected canonical IR | reference executable subsets | μMAG SP5 and analytic/current-scaling tests | target/source/formula-version gates apply |
| FDM | GPU | same tagged IR | implemented subsets | device and precision qualification separate | no silent replacement of canonical request by legacy formula |
| FEM | CPU | legacy and selected canonical IR | reference/partial executable | skew-mesh and weak-gradient tests required | target and current-source support narrower |
| FEM | GPU | authoring/IR | partial or unsupported by variant | no generic qualification claim | planner must report exact rejected feature |

(physics-spin-transfer-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("slonczewski_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

stt = fm.SlonczewskiSTT(
    current_density=(0.0, 0.0, 5.0e10),
    spin_polarization=(0.0, 0.0, 1.0),
    degree=0.4,
    lambda_asymmetry=1.0,
    epsilon_prime=0.0,
    free_layer_thickness_m=4 * nm,
)
study.spin_torque(stt)
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

See {doc}`/python-api/interactions/spin-transfer-torque` for complete constructor signatures, defaults,
and validation rules for `fm.SlonczewskiSTT` and `fm.ZhangLiSTT`. Execution support depends on
the selected study target, formula version, and current-source route.

## Constructor parameters

### `SlonczewskiSTT`

| Parameter | Unit | Meaning |
|---|---:|---|
| `current_density` | $\mathrm{A\,m^{-2}}$ | signed three-vector prescribed current; mutually exclusive with `current_source` |
| `spin_polarization` | $1$ | fixed-layer polarization direction |
| `degree` | $1$ | polarization magnitude |
| `lambda_asymmetry` | $1$ | angular asymmetry parameter |
| `epsilon_prime` | $1$ | field-like coefficient in the selected formula |
| `free_layer_thickness_m` | $\mathrm m$ | local volumetric prefactor realization |
| `id`, `target`, `stack_normal`, `interface_id` | mixed | canonical tagged-module identity and realization |

### `ZhangLiSTT`

| Parameter | Unit | Meaning |
|---|---:|---|
| `current_density` | $\mathrm{A\,m^{-2}}$ | signed three-vector prescribed current |
| `degree` / `xi` | $1$ | polarization parameter/alias under the documented formula |
| `beta` | $1$ | non-adiabaticity |
| `current_source` | $1$ | named solved-current source, exclusive with prescribed current |
| `id`, `target`, `lande_g`, `operator_version` | mixed | canonical tagged-module contract |

(physics-spin-transfer-torque-problem-ir)=
## ProblemIR and provenance

The IR must preserve:

- `kind` and `formula_version`;
- legacy versus canonical semantics;
- signed current source and its identity;
- target and stack/interface orientation;
- thickness/interface realization;
- all polarization/asymmetry parameters.

Canonical export preserves any explicit legacy formula version without silently upgrading it.

(physics-spin-transfer-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-spin-transfer-torque-validation)=
## Validation requirements

Python and planner validation reject non-finite vectors/scalars, zero polarization direction, invalid
degree/asymmetry domains, conflicting current sources, incomplete canonical identity, invalid
target, and missing realization. Planner validation additionally owns mesh derivatives, target
materialization, source availability, backend/device support, and current-field cardinality.

## Required numerical validation

- zero-current and zero-polarization limits;
- odd current scaling and exact sign reversal;
- $\mathbf m\parallel\hat{\mathbf p}$ zero damping-like torque;
- finite-difference/analytic single-cell torque oracles;
- Zhang–Li translation of a one-dimensional wall;
- μMAG Standard Problem 5 with fully declared convention;
- source-bound versus prescribed-current equivalence;
- CPU/GPU trajectories with matched timestep, precision, and formula version;
- proof that Gilbert conversion is applied exactly once.

(physics-spin-transfer-torque-limitations)=
## Limitations and extensions

The local Slonczewski model does not solve tunnelling, spin accumulation, backflow, heating, or
bias-dependent polarization. Zhang–Li is a diffusive adiabatic/non-adiabatic local model. Solved
drift–diffusion torque is documented separately and must not be replaced by fitted local
coefficients.

(physics-spin-transfer-torque-scientific-bibliography)=
## Scientific bibliography

1. J. C. Slonczewski, "Current-driven excitation of magnetic multilayers," *Journal of Magnetism and Magnetic Materials* **159**(1-2), L1–L7 (1996), [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
2. L. Berger, "Emission of spin waves by a magnetic multilayer traversed by a current," *Physical Review B* **54**(13), 9353–9358 (1996), [doi:10.1103/PhysRevB.54.9353](https://doi.org/10.1103/PhysRevB.54.9353).
3. S. Zhang and Z. Li, "Roles of Nonequilibrium Conduction Electrons on the Magnetization Dynamics of Ferromagnets," *Physical Review Letters* **93**(12), 127204 (2004), [doi:10.1103/PhysRevLett.93.127204](https://doi.org/10.1103/PhysRevLett.93.127204) ([arXiv:cond-mat/0407174](https://arxiv.org/abs/cond-mat/0407174)).
4. A. Thiaville, Y. Nakatani, J. Miltat, and Y. Suzuki, "Micromagnetic understanding of current-driven domain wall motion in patterned nanowires," *Europhysics Letters (EPL)* **69**(6), 990–996 (2005), [doi:10.1209/epl/i2004-10452-6](https://doi.org/10.1209/epl/i2004-10452-6) ([arXiv:cond-mat/0407628](https://arxiv.org/abs/cond-mat/0407628)).
5. D. C. Ralph and M. D. Stiles, "Spin transfer torques," *Journal of Magnetism and Magnetic Materials* **320**(7), 1190–1216 (2008), [doi:10.1016/j.jmmm.2007.12.019](https://doi.org/10.1016/j.jmmm.2007.12.019) ([arXiv:0711.4608](https://arxiv.org/abs/0711.4608)).
6. M. Najafi, B. Krüger, S. Bohlens, M. Franchin, H. Fangohr, A. Vanhaverbeke, R. Allenspach, M. Bolte, U. Merkt, D. Pfannkuche, D. P. F. Möller, and G. Meier, "Proposal for a standard problem for micromagnetic simulations including spin-transfer torque," *Journal of Applied Physics* **105**(11) (2009), [doi:10.1063/1.3126702](https://doi.org/10.1063/1.3126702).

(physics-spin-transfer-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(physics-spin-transfer-torque-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT`, `class ZhangLiSTT` | public constructors and formula versions |
| `packages/fullmag-py/src/fullmag/world.py` | `spin_torque facade` | stage registration boundary |
| `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | variant/source/target capability |
| `crates/fullmag-engine/src/fdm/cpu/fields/direct_torques.rs` | `slonczewski_torque_from_config` | FDM CPU reference STT evaluator |
| `backends/fem/cpu/mfem/interactions/stt_slonczewski.cpp` | `add_slonczewski_stt_rhs_aos` | FEM CPU Slonczewski realization |
| `backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp` | `add_zhang_li_stt_rhs_aos` | FEM CPU Zhang–Li realization |
| `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `slonczewski_stt_rhs_kernel` | FEM GPU CUDA STT kernels |

