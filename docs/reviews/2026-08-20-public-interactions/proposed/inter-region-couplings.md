---
title: Inter-region and interlayer couplings — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/inter-region-couplings/index.md
  - public_docs/site/python-api/interactions/inter-region-couplings.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Inter-region and interlayer couplings

## Audit verdict

| Area | Verdict |
|---|---|
| Separation of region exchange and surface IEC | Conceptually correct and preserved in `ProblemIR`. |
| Bilinear/biquadratic surface energy | Correct for the declared `-J1 q - J2 q^2` convention. |
| Harmonic interface stiffness | Correct only for symmetric centre-to-interface distances; the general weighted formula is missing. |
| Capability statement | Honest inside the page: only FDM CUDA region exchange executes; front matter `status: implemented` overstates the scope. |
| Executable example | Incorrect geometry: both `left` and `right` region boxes are centred at the origin and overlap completely. |
| Surface implementation contract | Incomplete: no surface pairing, measure, nonmatching-mesh, projection, or field-distribution rule is yet executable. |
| Completeness | Needs analytic `J1/J2` ground states, exact energy/field consistency, and partition validation. |

## Release-blocking example defect

`fm.Box` is centred at the origin. The current example creates both named regions as
`fm.Box(40*nm, 20*nm, 4*nm)` without translation inside an `80*nm` body. Therefore the two region
shapes coincide rather than forming left and right halves. The example must translate them by
opposite half-region widths and CI must assert that the regions are disjoint and cover the intended
body volume.

## Required corrections

1. Change the page summary to `partial` or generate it from the matrix:
   - FDM CUDA region exchange: executable;
   - FDM CPU, FEM CPU, FEM GPU region exchange: unsupported;
   - RKKY and bilinear/biquadratic interlayer terms: semantic-only on all lanes.
2. Correct the region geometry and add region-overlap/coverage validation to documentation tests.
3. Replace the simple harmonic mean by the weighted interface formula when adjacent centre-to-
   interface distances differ.
4. Publish the exact discrete region-link energy and field used by the CUDA materializer. A link
   override is not scientifically complete without an energy/field pair and counting convention.
5. For surface coupling, define surface orientation, overlap domain, face pairing, quadrature,
   nonmatching-mesh transfer, area weights, and conversion from surface derivative to cell/nodal
   field.
6. State that negative ordinary exchange stiffness is not accepted by the executable region-link
   path. Antiferromagnetic spacer coupling belongs to signed surface `J1/J2`, not an undocumented
   negative continuum `A`.
7. Keep `rkky` and `interlayer_exchange` as distinct provenance/API kinds if desired, but document
   that the former is the `J2 = 0` member of the same local surface-energy family at this level.

# Region-to-region exchange

Region exchange modifies nearest-neighbour exchange links across an internal material boundary. It
is not a long-range spacer interaction and must not connect geometrically separated bodies
implicitly.

For adjacent material regions with stiffnesses `A_a` and `A_b`, and centre-to-interface distances
`d_a` and `d_b`, flux continuity gives the weighted link coefficient

```math
A_{ab}
=\frac{d_a+d_b}{d_a/A_a+d_b/A_b}.
```

For equal distances this reduces to

```math
A_{ab}^{harm}
=\frac{2A_aA_b}{A_a+A_b}.
```

FullMag's harmonic mode may apply a nonnegative scale `s`:

```math
A_{ab}=sA_{ab}^{harm},
\qquad s\ge 0.
```

Explicit mode uses the authored nonnegative `inter_exchange`; disabled mode produces zero link
coupling. The exact discrete energy must identify:

- whether every undirected link is counted once;
- face area and centre distance;
- cell volumes used for fields;
- inactive/masked-cell behaviour;
- periodic seam handling;
- material and region precedence;
- field and energy precision/reduction policy.

A recommended canonical link form is

```math
E_{ab}^{link}
=\frac{A_{ab}S_{ab}}{d_a+d_b}|m_b-m_a|^2,
```

provided this is exactly the form used by the runtime. If the implementation uses a different
normalization, the documentation must publish the implemented expression rather than forcing this
proposal onto it.

# Bilinear and biquadratic surface coupling

For paired magnetic traces `m_a` and `m_b` on the resolved overlap surface `Gamma_ab`, FullMag uses

```math
\sigma_{IEC}(q)=-J_1q-J_2q^2,
\qquad
q=m_a\cdot m_b,
```

```math
E_{IEC}=\int_{\Gamma_{ab}}\sigma_{IEC}\,dS.
```

The unconstrained surface derivatives are

```math
\frac{\partial\sigma_{IEC}}{\partial m_a}
=-(J_1+2J_2q)m_b,
```

```math
\frac{\partial\sigma_{IEC}}{\partial m_b}
=-(J_1+2J_2q)m_a.
```

For two uniformly magnetized thin layers with thicknesses `t_a` and `t_b`, a homogenized volume
field is

```math
H_a
=\frac{J_1+2J_2q}{\mu_0M_{s,a}t_a}m_b,
\qquad
H_b
=\frac{J_1+2J_2q}{\mu_0M_{s,b}t_b}m_a.
```

A discrete surface implementation should replace `1/t` by its exact face-area-to-associated-volume
weight. This conversion must be published for boundary cells/nodes and nonuniform meshes.

## Ground-state interpretation

Writing `q = cos(theta)`:

```math
\sigma(\theta)=-J_1\cos\theta-J_2\cos^2\theta.
```

The stationary condition is

```math
\sin\theta\left(J_1+2J_2\cos\theta\right)=0.
```

Therefore:

- for `J2 = 0`, `J1 > 0` favours parallel alignment and `J1 < 0` favours antiparallel alignment;
- `J2 > 0` favours collinear states `|q| = 1`, with `J1` selecting parallel versus antiparallel;
- `J2 < 0` can stabilize a canted state
  `q_* = -J1/(2J2)` when `|q_*| < 1`.

These cases should appear as analytic examples with exact expected energies, not only as parameter
definitions.

## Surface-resolution contract required before execution

An executable RKKY/interlayer implementation must define:

1. the two oriented surface endpoints and their outward normals;
2. how physical overlap `Gamma_ab` is determined;
3. behaviour for unequal areas, gaps, offsets, curvature, and partial overlap;
4. matching versus nonmatching surface meshes;
5. point/face pairing or mortar/projection operator;
6. quadrature order and area weights;
7. field projection into each magnetic volume;
8. ownership of periodic or duplicated faces;
9. action–reaction and total-energy consistency;
10. CPU/GPU precision and reduction ordering.

Nearest-neighbour pairing by coordinate tolerance is not a sufficient undocumented production
contract.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `A_a`, `A_b`, `A_ab` | material and interface exchange stiffnesses | J/m |
| `d_a`, `d_b` | centre-to-interface distances | m |
| `S_ab` | interface-link area | m² |
| `J1`, `J2` | bilinear and biquadratic surface coefficients | J/m² |
| `q` | `m_a · m_b` | 1 |
| `sigma_IEC` | surface coupling energy density | J/m² |
| `Gamma_ab` | paired physical interface | m² as a measure |
| `t_a`, `t_b` | homogenized magnetic layer thicknesses | m |
| `H_a`, `H_b` | coupling fields | A/m |

## Corrected stage-first region-exchange example

```python
# %% Executable FDM CUDA region exchange
import fullmag as fm

nm = 1.0e-9
study = fm.study("region_exchange_reference")
study.engine("fdm")
study.device("cuda", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

body = study.geometry(fm.Box(80 * nm, 20 * nm, 4 * nm), name="bilayer")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

left_shape = fm.Box(40 * nm, 20 * nm, 4 * nm).translate((-20 * nm, 0.0, 0.0))
right_shape = fm.Box(40 * nm, 20 * nm, 4 * nm).translate((20 * nm, 0.0, 0.0))
left = body.add_region("left", left_shape)
right = body.add_region("right", right_shape)

study.couplings.exchange(
    source=left,
    target=right,
    mode="explicit",
    inter_exchange=13.0e-12,
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk23",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-14,
    max_err=1.0e-7,
    relax_alpha=1.0,
    tolT=1.0e-6,
    max_steps=50_000,
)
```

Documentation CI must execute construction and assert from geometry/selection evaluation that:

- `left` and `right` are both nonempty;
- their intersection is empty up to the declared geometric tolerance;
- their union covers the intended `bilayer` body;
- the materialized interface contains the expected number of links;
- the coupling resolves to the intended numeric region IDs.

## Surface authoring example policy

RKKY/interlayer examples should use `capability_policy="authored_only"` only as clearly labelled
serialization examples. Strict executable examples must not be published until a surface
materializer exists. A proposed future workflow is:

```python
study.couplings.interlayer_exchange(
    source=bottom_surface,
    target=top_surface,
    J1=0.8e-3,
    J2=-0.2e-3,
    capability_policy="require_runtime",
)
```

This block becomes executable documentation only after one lane defines and validates the surface
contract above.

## Capability statement

| Solver/device | Region exchange | RKKY / `J1,J2` surface coupling |
|---|---|---|
| FDM CPU | `unsupported` | `semantic_only` |
| FDM GPU | `production_executable` only for the current qualified region-link slice | `semantic_only` |
| FEM CPU | `unsupported` | `semantic_only` |
| FEM GPU | `unsupported` | `semantic_only` |

`authored_only` means representable/exportable; it is not executable evidence or a validation
bypass.

## Required validation suite

### Region exchange

1. Region partition nonemptiness, disjointness, and intended coverage.
2. Uniform magnetization: zero link torque and the correct constant energy offset convention.
3. Parallel/antiparallel two-cell analytic link energy.
4. Centred finite-difference derivative of link energy versus field.
5. Weighted harmonic coefficient for unequal `A` and unequal distances.
6. Explicit, harmonic, scaled, and disabled modes.
7. Material/region precedence and exact link-count ownership.
8. Periodic seam, inactive mask, and multi-region junction tests.
9. GPU materialization identity and no silent CPU fallback.

### Surface IEC

1. Exact parallel, antiparallel, orthogonal, and canted `J1/J2` macrospin energies.
2. Surface energy derivative versus fields on both layers.
3. Area scaling and associated-volume/thickness scaling.
4. Invariance under swapping endpoints while preserving the same physical pair.
5. Partial-overlap and unequal-area convergence.
6. Matching and nonmatching mesh convergence.
7. Curved-interface quadrature and normal/orientation handling.
8. Conservative action–reaction/angular-momentum balance in zero damping.
9. CPU/GPU field and energy parity once implementations exist.
10. Fail-closed behaviour for missing, ambiguous, self-coupled, or multiply owned surfaces.

## Recommended extensions

- FDM CPU reference materializer for region links before broader GPU qualification;
- FEM internal-interface exchange with trace/mortar formulation;
- executable RKKY/interlayer `J1/J2` surface operator for matching and nonmatching meshes;
- automatic multilayer opposing-surface pairing with inspectable overlap maps;
- spatially varying `J1/J2` fields and roughness maps;
- spacer-thickness-dependent imported coupling profiles with provenance;
- interface visualization showing paired faces, weights, normals, and unresolved gaps;
- standard synthetic-antiferromagnet and canted-biquadratic benchmark notebooks.

## Bibliography

- P. Grünberg et al., “Layered magnetic structures: Evidence for antiferromagnetic coupling of Fe
  layers across Cr interlayers,” *Physical Review Letters* **57**, 2442–2445 (1986).
- P. Bruno, “Theory of interlayer magnetic coupling,” *Physical Review B* **52**, 411–439 (1995),
  DOI `10.1103/PhysRevB.52.411`.
- S. S. P. Parkin, N. More, and K. P. Roche, “Oscillations in exchange coupling and
  magnetoresistance in metallic superlattice structures,” *Physical Review Letters* **64**,
  2304–2307 (1990).
