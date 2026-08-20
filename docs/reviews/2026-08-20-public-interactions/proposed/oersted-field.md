---
title: Oersted field — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/oersted-field/index.md
  - public_docs/site/python-api/interactions/oersted-field.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Oersted field

## Audit verdict

| Area | Verdict |
|---|---|
| Biot–Savart H-field convention | Correct: the H-field integral contains no `mu0`. |
| Closure-aware solved-current model | Scientifically strong, but too large and advanced for the root page. |
| Analytic cylinder | Implemented in the public API but not given equal canonical physics coverage. |
| Python API example | Stale and internally inconsistent with the current stage-first DSL. |
| Source ownership | Conflicting: the physics and Python API pages point to different internal source-of-truth documents and describe different planner generations. |
| Usability | A 93 kB monolithic page and full IR dump obscure the first-use path. |

## Release-blocking documentation defects

1. The Python API page uses removed/incompatible calls including `study.discretization`,
   `study.material`, and `study.current_module` instead of the current stage-first surface.
2. Its example creates an `OerstedField` object but does not register that source-bound term on the
   study; only the cylinder is registered.
3. The example describes a cylindrical antenna current as `1e6 A`, which is not a credible
   nanoscale tutorial value and distracts from the contract.
4. The physics page embeds a very large expert RT0/external-lead graph and complete IR, while the
   simpler `OerstedCylinder` physics is not the first canonical example.
5. The older API text says the planner resolves a prescribed-density source to a regularized
   midpoint Biot–Savart field, while the newer physics page requires conservative-current identity,
   closure, and OE-F1/OE-F2 semantics. One owner must prevail.

## Required restructuring

Split the material into:

1. `index.md` — model selection, sign/units, capability matrix, two short examples;
2. `analytic-cylinder.md` — exact infinite-cylinder field and time envelopes;
3. `solved-current.md` — source identity, current closure, OE-F1/OE-F2;
4. `numerical-methods.md` — singular quadrature, vector potential, gauge, airbox, GPU realization;
5. `validation.md` — Ampère loop, cylinder, closure, convergence, reciprocity limits;
6. downloadable advanced fixtures for RT0 external leads and full `ProblemIR`.

# Analytic infinite cylinder

Let `a_hat` be the current axis, `c` a point on the axis, and

```math
rho_vec=(r-c)-[(r-c)\cdot\hat a]\hat a,
\qquad
rho=|rho_vec|.
```

For total current `I` uniformly distributed over a cylinder of radius `R`,

```math
H_{oe}(r)=
\begin{cases}
\dfrac{I}{2\pi R^2}(\hat a\times rho_vec), & 0\le rho<R,\\[6pt]
\dfrac{I}{2\pi rho^2}(\hat a\times rho_vec), & rho\ge R.
\end{cases}
```

At the axis, use the continuous value `H_oe = 0`. Reversing `I` or `a_hat` reverses field chirality.
The formula assumes an infinitely long straight conductor and uniform current density inside.

# Field from a solved current

For a closed, sufficiently regular current density,

```math
H_{oe}(r)
=\frac{1}{4\pi}\int_{\Omega_c}
\frac{J(r')\times(r-r')}{|r-r'|^3}\,dV'.
```

`J` is in A/m² and `H_oe` is in A/m. Multiplying this equation by `mu0` would incorrectly convert
it to a B-field formula.

A finite-device current solve must also define how current closes outside or through the boundary.
A nonzero prescribed current entering an isolated finite volume without an exit is not a physical
magnetostatic source. FullMag's conservative-current identity and closure data are therefore part
of the scientific input, not optional implementation metadata.

## OE-F1 and OE-F2

### OE-F1 — conservative-current Biot–Savart

Document:

- source module and state revision;
- conservative RT0/current representation;
- topology, mesh, conductivity, envelope, and field digests;
- closure type and interface pairing;
- self/near-element singular integration;
- algebraic and physical closure gates;
- target field sampling and reduction.

### OE-F2 — mixed/vector-potential realization

Document:

- vector-potential PDE and constitutive assumptions;
- gauge condition and nullspace treatment;
- exterior-domain/airbox boundary condition;
- finite-element spaces and discrete de Rham compatibility;
- conversion from `B = curl(A)` to the H-field supplied to LLG;
- solver/preconditioner and convergence gates.

The page must not imply that selecting `OerstedField(model="from_current_solution")` uniquely
selects OE-F1 or OE-F2 if the public constructor has no method selector. Requested intent and
resolved method belong to separate provenance fields.

## Energy ownership

For a prescribed current source independent of magnetization, the external-field contribution may
be evaluated as

```math
E_{oe}=-\mu_0\int_{\Omega_m}M\cdot H_{oe}\,dV.
```

If current is solved self-consistently with magnetization-dependent conductivity or reciprocal
charge–spin coupling, this scalar is not automatically the complete energy of the coupled driven
system. The documentation should report magnetic field work and transport power/entropy production
without inventing a conservative total energy.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `I` | signed total current | A |
| `J` | current density | A/m² |
| `H_oe` | Oersted magnetic field | A/m |
| `B_oe` | magnetic flux density, when explicitly formed | T |
| `R`, `rho` | conductor radius and radial distance | m |
| `a_hat` | current-axis unit vector | 1 |
| `Omega_c` | conducting integration domain | m³ as a domain measure |

## Minimal stage-first cylinder example

```python
# %% Analytic Oersted cylinder
import fullmag as fm

nm = 1.0e-9
study = fm.study("oersted_cylinder_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

free_layer = study.geometry(fm.Box(100 * nm, 100 * nm, 4 * nm), name="free_layer")
free_layer.Ms = 800.0e3
free_layer.Aex = 13.0e-12
free_layer.alpha = 0.02
free_layer.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.oersted(
    fm.OerstedCylinder(
        current=5.0e-3,
        radius=50 * nm,
        center=(0.0, 0.0, 0.0),
        axis=(0.0, 0.0, 1.0),
    )
)
study.stages.add_run(stage_id="sample", until=1.0e-12)
```

CI should execute this example, compare the exact serialized cylinder record, and evaluate a small
analytic fixture at `rho = R/2`, `R`, and `2R`.

## Solved-current example policy

Do not place the complete RT0/external-lead fixture inline on the root page. Link to a tested file
such as `examples/fem_external_lead_oersted_public.py` and show only the essential registration:

```python
charge = study.current_transport(..., conservative_current_view=view)
study.oersted(fm.OerstedField(source=charge.name))
study.stages.add_run(3.0e-13, stage_id="oersted_run")
```

The ellipsis belongs only in a non-executable explanatory excerpt. The downloadable fixture must
remain complete and executable.

## Required validation suite

1. **Analytic cylinder:** inside linear `H_phi ~ rho`, outside `H_phi ~ 1/rho`, continuity at `R`,
   zero at the axis, and current/axis reversal.
2. **Ampère loop:** verify `integral H·dl = I_enclosed` for loops around the conductor.
3. **Biot–Savart reference:** compare OE-F1 against high-accuracy quadrature for smooth closed
   current distributions.
4. **Near/self integration:** isolate singular/near-singular quadrature convergence.
5. **Current closure:** reject open sources and perturb external-lead closure to exercise physical
   gates.
6. **OE-F2:** gauge/nullspace, airbox, polynomial-order, and mesh convergence.
7. **Conservation:** verify charge residual and boundary flux balance before field evaluation.
8. **Time envelope:** test half-open pulse edges and interpolation/extrapolation policies.
9. **CPU/GPU:** compare realized field, not only source serialization.
10. **Coupled transport:** verify provenance invalidation when source state, mesh, conductivity,
    envelope, or topology revision changes.

## Recommended extensions

- explicit public method policy for OE-F1/OE-F2/analytic realization;
- finite straight wire, loop, stripline, and coplanar-waveguide analytic sources;
- adaptive near-field quadrature and FMM acceleration with error estimates;
- reusable circuit/lead closure library;
- current-to-field cache keyed by complete conservative source identity;
- live diagnostic plots for current continuity, Ampère residual, and field convergence.

## Bibliography

- J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1998.
- P. Monk, *Finite Element Methods for Maxwell's Equations*, Oxford University Press, 2003.
