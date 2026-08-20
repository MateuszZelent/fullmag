---
title: Spin-transfer torque — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/spin-transfer-torque/index.md
  - public_docs/site/python-api/interactions/spin-transfer-torque.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Spin-transfer torque

## Audit verdict

| Area | Verdict |
|---|---|
| Canonical Zhang–Li equations | Internally correct, including tangent projection and one Gilbert conversion. |
| Canonical Slonczewski equations | Internally correct for the declared efficiency and independent `epsilon_prime`. |
| Legacy/canonical distinction | Scientifically important and documented, but too easy for users to miss. |
| Public execution | Legacy paths execute; canonical v1/v2 objects are semantic-only. |
| Stage-first example | Misleading: it builds an unrelated runnable shell and only inspects a disconnected STT object. |
| Source ownership | Module docstring, backend matrices, and public page disagree about FEM/canonical executable scope. |

STT is a direct non-conservative rate contribution. It must never be assigned an `E_stt` energy or
included in an energy-minimization relaxation as though it were conservative.

## Required corrections

1. Change the page summary status from `implemented` to a matrix-driven summary such as `partial`:
   legacy execution and canonical representation are different capabilities.
2. Do not call the current shell-plus-object block a complete authoring example. Add a public
   `study.spin_torque(...)` registration method or publish the object block as an explicitly
   non-executable IR fixture.
3. Add a prominent migration table for `fixed_layer_position` versus oriented `stack_normal`.
   Never apply both sign transformations.
4. State conventional-current and electron-flow directions in every example.
5. Separate thin-layer homogenized CPP (`1/t_F`) from interface absorbed-flux CPP; the latter must
   not acquire an artificial thickness factor.
6. Resolve the discrepancy between `spin_torque.py`'s “current executable subset: FDM CPU/GPU”
   statement and public FEM legacy claims. The capability registry must be the single owner.
7. Add formula and operator version to every saved provenance record.

# Common LLG contract

FullMag writes the Gilbert equation as

```math
\partial_t m
=-\gamma_0m\times H_{eff}
+\alpha m\times\partial_t m
+T_G.
```

A direct Gilbert-form source is converted exactly once:

```math
T_{explicit}
=\frac{T_G+\alpha m\times T_G}{1+\alpha^2}.
```

Applying this conversion in both the interaction kernel and the integrator is a double conversion;
omitting it in both is also wrong. Provenance should identify the source form expected by the RHS.

# Zhang–Li CIP torque

For signed conventional current density `J_c`, polarization `P`, Landé factor `g`, and positive
elementary charge `e`,

```math
u=\frac{g\mu_BP}{2eM_s}J_c,
\qquad
v=(u\cdot\nabla)m.
```

The canonical Gilbert source is

```math
T_{ZL,G}=-v+\beta m\times v.
```

With tangent projection `v_perp = v-m(m·v)`, the explicit rate is

```math
T_{ZL,explicit}
=\frac{-(1+\alpha\beta)v_{perp}
 +(\beta-\alpha)m\times v_{perp}}{1+\alpha^2}.
```

The historical `zhang_li.legacy_fullmag.v0` drift factor and charge literal must remain documented
as compatibility behaviour, not as the canonical formula.

# Slonczewski CPP torque

Let `n_stack` point from fixed to free layer, `J_n = J_c·n_stack`, `p_hat` be the normalized fixed
layer polarization, and `q=m·p_hat`. FullMag canonical v2 uses

```math
\Omega_J=\frac{\gamma_e\hbar J_n}{eM_st_F},
\qquad
\varepsilon(q)=\frac{P\Lambda^2}
{\Lambda^2+1+(\Lambda^2-1)q}.
```

Define

```math
D=m\times(m\times p_{hat}),
\qquad
C=m\times p_{hat}.
```

Then

```math
T_{SL,explicit}
=\frac{\Omega_J}{1+\alpha^2}
\left[(\varepsilon+\alpha\varepsilon')D
 +(\varepsilon'-\alpha\varepsilon)C\right].
```

`epsilon_prime` is independent of the angular efficiency. It must not be multiplied by
`epsilon(q)` unless a separately versioned formula explicitly defines that model.

## Orientation and sign table

| Transformation | Expected consequence |
|---|---|
| `J_c -> -J_c` | reverses the complete STT rate |
| `n_stack -> -n_stack` at fixed vector `J_c` | reverses `J_n` and therefore the CPP torque |
| `p_hat -> -p_hat` | changes both basis vectors and `q`; evaluate the full formula, not only a global sign |
| `m -> -m` | transforms basis/gradient terms according to each model; test explicitly |
| legacy `top <-> bottom` | migration-only sign rule; must not be combined with canonical normal reversal |

The page should include a diagram defining conventional current, electron flow, fixed layer, free
layer, and `n_stack`.

## Thin-layer versus interface realization

- `slonczewski_thin_layer_homogenized.v1`: a volume torque in a free layer of thickness `t_F`;
  the frequency scale contains `1/t_F`.
- `slonczewski_interface_flux.v1`: an oriented surface functional derived from absorbed angular
  momentum flux; no artificial `1/t_F` belongs in the weak surface term.

These are mutually exclusive physical realizations and require distinct validation.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `T` | direct torque/rate contribution | 1/s |
| `J_c` | conventional charge-current density | A/m² |
| `u` | Zhang–Li drift velocity | m/s |
| `P`, `beta`, `Lambda`, `epsilon_prime` | dimensionless model coefficients | 1 |
| `p_hat`, `n_stack` | polarization and oriented stack unit vectors | 1 |
| `t_F` | homogenized free-layer thickness | m |
| `Omega_J` | signed CPP rate scale | 1/s |
| `gamma_e`, `gamma_0` | gyromagnetic constants in declared conventions | 1/(T s), m/(A s) |

## Public authoring boundary

Until stage registration exists, publish an honest constructor/IR fixture rather than a runnable
shell that does not contain STT:

```python
# Canonical Slonczewski requested intent; not yet a stage-first executable registration.
import fullmag as fm

stt = fm.SlonczewskiSTT(
    id="cpp_free_layer",
    target=fm.RegionRef("free_layer"),
    current_density=(0.0, 0.0, -2.0e11),
    spin_polarization=(0.0, 0.0, 1.0),
    stack_normal=(0.0, 0.0, 1.0),
    degree=0.55,
    lambda_asymmetry=1.4,
    epsilon_prime=0.03,
    free_layer_thickness_m=1.5e-9,
)
assert stt.to_ir_module()["formula_version"] == "slonczewski.fullmag.v2"
```

The production documentation target should instead be:

```python
study.spin_torque(stt)
study.stages.add_run(stage_id="drive", until=5.0e-9)
```

Only publish that block as executable after the stage builder, planner, runner, round-trip, and at
least one native lane support the complete canonical path.

## Capability matrix

| Solver/device | Legacy Slonczewski/Zhang–Li | Canonical v1/v2 |
|---|---|---|
| FDM CPU | `reference_executable` | `semantic_only` until wired |
| FDM GPU | `production_executable` subject to device qualification | `semantic_only` |
| FEM CPU | report exact native legacy path after source-of-truth reconciliation | `semantic_only` |
| FEM GPU | report exact native legacy path after executed-device evidence | `semantic_only` |

## Required validation suite

1. **Tangent property:** `m·T = 0` for all models and precisions.
2. **Zero drive:** exact zero torque for zero current.
3. **Current reversal:** exact odd response under `J -> -J`.
4. **Gilbert conversion:** compare direct algebra with one explicit conversion and detect double
   conversion.
5. **Slonczewski macrospin:** compare damping-like and field-like basis amplitudes for selected
   `q`, `P`, `Lambda`, `epsilon_prime`, and `alpha`.
6. **CPP critical current:** compare a single-domain stability threshold under a fully declared
   field/anisotropy/damping convention.
7. **Zhang–Li texture translation:** domain-wall/skyrmion velocity and nonadiabatic transverse
   response in a resolved regime.
8. **Derivative operator:** Fourier/manufactured tests for central/upwind/FEM gradient versions.
9. **Orientation:** stack-normal, polarization, and legacy top/bottom transformation tests.
10. **Interface flux:** angular-momentum balance between transport flux and magnetic torque.
11. **CPU/GPU:** compare torque arrays before integration, then trajectory observables.
12. **Round-trip:** preserve formula, operator, realization, target, orientation, and current-source
    identity.

## Recommended extensions

- complete canonical stage registration and removal plan for ambiguous legacy fields;
- spatial polarization and current fields with strict frame/cardinality semantics;
- multilayer interface mapping and absorbed spin-current flux;
- automatic current/electron-flow diagram generation from oriented stack metadata;
- critical-current and domain-wall benchmark notebooks;
- deprecation diagnostics that print exact legacy-to-canonical transformations.

## Bibliography

- J. C. Slonczewski, *Journal of Magnetism and Magnetic Materials* **159**, L1–L7 (1996), DOI
  `10.1016/0304-8853(96)00062-5`.
- S. Zhang and Z. Li, *Physical Review Letters* **93**, 127204 (2004), DOI
  `10.1103/PhysRevLett.93.127204`.
- A. Thiaville et al., *Europhysics Letters* **69**, 990–996 (2005).
