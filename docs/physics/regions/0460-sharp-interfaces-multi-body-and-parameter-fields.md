
# Sharp interfaces, constitutive parameter fields, and multi-body coupling in Fullmag

- Status: proposal
- Owners: Fullmag core
- Last updated: 2026-03-25
- Related physics notes:
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`
  - `docs/physics/0421-fdm-multilayer-convolution-demag.md`
  - `docs/physics/0440-fdm-interfacial-dmi.md`
- Related implementation files:
  - `packages/fullmag-py/src/fullmag/world.py`
  - `packages/fullmag-py/src/fullmag/model/discretization.py`
  - `packages/fullmag-py/src/fullmag/model/structure.py`
  - `crates/fullmag-ir/src/lib.rs`
  - `crates/fullmag-plan/src/lib.rs`
  - `crates/fullmag-engine/src/multilayer.rs`
  - `crates/fullmag-fdm-demag/src/transfer.rs`

---

## 1. Problem statement

Fullmag already moves in a physics-first direction: the public Python model is centered on
problem objects, geometries, materials, and ferromagnets rather than on a global array of region
IDs. However, the “regions” question remains one of the most important unresolved semantics
problems for the solver, because several different physical situations are easy to conflate:

- a single ferromagnet with spatially varying constitutive coefficients,
- a single ferromagnet with piecewise-constant material jumps,
- multiple magnetic bodies that touch,
- multiple magnetic bodies separated by a spacer,
- multiple magnetic bodies coupled only through stray field,
- multiple bodies that also need explicit interfacial exchange or IEC/RKKY,
- thin-film interfacial DMI that belongs to one layer but is induced by an adjacent heavy-metal interface.

If Fullmag encodes all of these cases through one primitive such as “regions on a grid”, then
the solver semantics will be ambiguous, backend-dependent, and hard to validate.

This note defines a stronger contract.

---

## 2. Executive summary

### 2.1 Core thesis

Fullmag should distinguish **three layers of meaning**:

1. **topology / ownership**
2. **constitutive material law**
3. **coupling between magnetic bodies**

These should not collapse into one implementation trick.

### 2.2 The two major physical modes

Fullmag should support two major modeling modes explicitly:

#### Mode A — Single-body heterogeneous continuum

One reduced magnetization field \(m(x,t)\) on one magnetic domain, with constitutive coefficients
that may vary smoothly or piecewise.

#### Mode B — Multi-body coupled system

Multiple reduced magnetization fields \(m_k(x,t)\) on distinct bodies, coupled by demag and
optionally by explicit interface/surface terms.

### 2.3 Design consequence

- **Regions** remain useful, but mostly as topology / labeling / assignment helpers.
- **Ferromagnets / bodies** own magnetization fields.
- **Parameter fields** are real constitutive fields, not disguised interface objects.
- **Couplings** between bodies or surfaces are first-class objects.
- **Demag** always depends on the physical magnetization \(M = M_s m\), not just on the reduced field.

---

## 3. Terminology and semantic split

### 3.1 Geometry asset

A geometry asset is a spatial object before backend-specific realization:

- analytic primitive,
- imported surface / CAD,
- constructive solid geometry result.

A geometry asset has no material and no dynamics by itself.

### 3.2 Region

A region is a named topological subset of a geometry asset.

A region may be used for:

- imported CAD domain markers,
- subdomain labeling,
- piecewise material assignment inside one body,
- output selection,
- mesh/grid ownership checks.

A region is **not itself**:

- an energy term,
- a direct exchange law,
- a surface exchange law,
- a guarantee that two touching cells belong to the same continuum magnetization field.

### 3.3 Ferromagnet / magnetic body

A ferromagnet is the owner of:

- a geometry,
- a material law,
- an initial magnetization,
- optional native discretization hints,
- body-local fields and energies.

A ferromagnet is the right owner for one reduced magnetization field.

### 3.4 Material law

A material law describes how constitutive coefficients are defined **inside one ferromagnet**.

Recommended forms:

1. `uniform`
2. `piecewise_regions`
3. `continuous_fields`
4. `sampled_fields`

This should be an explicit object, not an accidental consequence of grid painting.

### 3.5 Parameter field

A parameter field is a scalar/vector/tensor field associated with a constitutive coefficient.
Examples:

- `Ms(x)`
- `A(x)`
- `Ku1(x)`
- `anisU(x)`
- `alpha(x)`
- `D(x)`

Parameter fields need explicit semantics because they do not all affect the physics in the same way.

### 3.6 Coupling

A coupling is a relationship between two magnetic bodies, two surfaces, or two material domains.

Examples:

- direct contact exchange,
- bilinear/biquadratic surface exchange,
- future chiral inter-body coupling,
- future transport-mediated coupling.

Demag is a global coupling but is sufficiently universal that it can remain an energy term instead
of an explicit user-supplied pair object.

---

## 4. Continuum physics

## 4.1 State variables

### 4.1.1 Single-body mode

For one body:
\[
m : \Omega \times [0,T] \to S^2,
\qquad
M = M_s(x)\,m.
\]

### 4.1.2 Multi-body mode

For \(N\) bodies:
\[
m_k : \Omega_k \times [0,T] \to S^2,
\qquad
M_k = M_{s,k}(x)\,m_k.
\]

The total physical magnetization is the union / sum over all bodies in the ambient space.

---

## 4.2 Demagnetization and the meaning of \(M_s(x)\)

Magnetostatics depends on the physical magnetization \(M\), not the reduced field \(m\) alone.

With no free current,
\[
\nabla \times H_{\mathrm{demag}} = 0,
\qquad
\nabla \cdot B = 0,
\qquad
B = \mu_0(H_{\mathrm{demag}} + M).
\]

Writing \(H_{\mathrm{demag}} = -\nabla u\) gives
\[
\nabla \cdot(-\nabla u + M) = 0.
\]

Equivalently, the demag source can be expressed through the volume and surface charge picture:

- volume charge associated with \(-\nabla\cdot M\),
- surface charge associated with the normal component of \(M\) at boundaries or jumps.

### 4.2.1 Important consequence

If
\[
M = M_s(x)\,m,
\]
then for smooth \(M_s\),
\[
\nabla\cdot M
=
M_s \nabla\cdot m + m\cdot \nabla M_s.
\]

So:

- a real `Ms` gradient is a real magnetostatic source,
- a real `Ms` jump gives a real interfacial source tied to the jump in the normal component of \(M\).

### 4.2.2 What is an artifact, then?

The artifact is not the resulting demag field itself.  
The artifact is the **modeling shortcut** of using a constitutive gradient to imitate a sharp
geometric or topological interface that should instead be represented explicitly.

This distinction is absolutely central for Fullmag.

---

## 4.3 Exchange in a single heterogeneous body

The exchange energy is
\[
E_{\mathrm ex}[m]
=
\int_\Omega A(x)\,|\nabla m|^2\,dV.
\]

The variational derivative gives
\[
H_{\mathrm ex}
=
\frac{2}{\mu_0 M_s}
\nabla\cdot(A\nabla m).
\]

At a sharp interface \(\Sigma\) inside one body, the continuum jump condition is
\[
A^- \partial_n m^- = A^+ \partial_n m^+.
\]

This is the governing continuum law. Any correct discretization must reduce to it.

### 4.3.1 Single-grid FDM realization

For cell-centered FDM, the correct foundation is a face-based discrete energy
\[
E_{\mathrm ex,h}
=
\sum_{f=i|j}
A_f \frac{S_f}{d_f}\|m_j-m_i\|^2.
\]

This yields
\[
H_{\mathrm ex,i}
=
\frac{2}{\mu_0 M_{s,i}V_i}
\sum_{f=i|j}
A_f \frac{S_f}{d_f}(m_j-m_i).
\]

For piecewise-constant \(A_i\) on a shared grid, a natural default is
\[
A_f = \frac{2A_iA_j}{A_i+A_j},
\]
which may be derived from flux continuity / virtual-point elimination.

### 4.3.2 Why this is not enough for all interface physics

This face-based rule solves one problem only:

- a single magnetization field with a material jump in `A`.

It does **not** by itself encode:

- whether two domains are one continuum or two separate bodies,
- whether exchange should exist across the interface at all,
- whether the interface carries a distinct surface energy \(\sigma\) or \(\sigma_2\),
- whether two sides should have independent state variables.

Therefore Fullmag must not use the face coefficient as the public semantic carrier of all interface physics.

---

## 4.4 Multi-body contact exchange

When two bodies touch and the user intends direct exchange across the contact, there are two valid
ways to model the physics:

### 4.4.1 Model as one body with internal material assignment

This is appropriate when the intended physics is still a single continuum magnetization field.

### 4.4.2 Model as distinct bodies with explicit coupling

This is appropriate when the bodies should remain independently addressable, may use different
native grids, or need couplings that can be turned on/off independently.

The solver should then use an explicit contact operator across the matched interface faces / cells /
surface elements.

This is a semantic, not merely numerical, distinction.

### 4.4.3 Default rule

A strong and clean Fullmag default is:

> **Exchange acts inside a body by default.  
> Exchange across different bodies must be declared explicitly.**

That makes user intent visible and prevents silent changes caused by adjacency in a realized grid.

---

## 4.5 Surface exchange and IEC/RKKY

A bilinear / biquadratic interfacial coupling is naturally described by
\[
E_{\mathrm IEC}
=
-\int_\Sigma \sigma_1 (m_1\cdot m_2)\,dA
-\int_\Sigma \sigma_2 (m_1\cdot m_2)^2\,dA.
\]

Key implications:

- the energy has units of `J/m^2`,
- the discrete field contribution scales like \(1/\Delta\), not \(1/\Delta^2\),
- it is a surface law, not a volumetric `A(x)` law,
- it needs a pairing / matching rule over discrete interface elements.

So Fullmag should represent this with a dedicated interface-coupling object.

---

## 4.6 Anisotropy, damping, and DMI

### 4.6.1 Uniaxial anisotropy

Spatial variation in `Ku1(x)` or axis fields is legitimate constitutive variation inside a body.
These coefficients do not directly create a magnetostatic source, but they alter the equilibrium
state \(m\), which then changes demag indirectly.

### 4.6.2 Damping

`alpha(x)` is purely dynamical. It should be allowed as a field if a backend supports it.

### 4.6.3 Interfacial DMI

For the standard thin-film iDMI used in current Fullmag notes, `D` belongs to the ferromagnetic
body (or to the free-surface closure condition that this body owns). In multi-layer stacks, each
ferromagnet may have its own `D`, sign, and interface orientation semantics.

For Fullmag v1 multi-body design:

- keep DMI body-local,
- do not treat DMI as a generic cross-body coupling,
- reserve explicit chiral inter-body couplings for future work.

---

## 4.7 LLG dynamics for coupled bodies

For each body \(k\),
\[
\frac{dm_k}{dt}
=
-\gamma_0 m_k \times H_{\mathrm eff,k}
+
\alpha_k m_k \times \frac{dm_k}{dt}.
\]

The effective field contains:

- body-local self terms,
- global demag from all bodies,
- optional explicit couplings.

Because these contributions are mutually coupled, the time integrator must treat the system
synchronously.

### 4.7.1 Contract for time stepping

- one global time step,
- one global RHS evaluation per stage,
- aggregate error estimate across all bodies,
- no asynchronous per-body stepping in a coupled run.

---

## 5. Numerical contract for Fullmag

## 5.1 Shared-grid single-body FDM

For a single heterogeneous body, FDM should realize:

- one active magnetic mask,
- cell-centered `m`,
- cellwise or facewise material data as needed,
- demag from `M = Ms m`,
- exchange via face-based discrete energy,
- backend provenance stating whether constitutive fields are active.

### 5.1.1 Required discrete semantics

| Quantity | Required representation |
|---|---|
| `m` | cell-centered reduced magnetization |
| `M` | derived physical magnetization `Ms * m` |
| `Ms` | cellwise scalar, may be uniform/piecewise/field |
| `A` | cellwise source data, but used through face coefficient `A_f` |
| exchange BC | Neumann at free surfaces, interface-aware inside body |
| demag | exact/consistent tensor convolution from `M` |

## 5.2 Per-body multi-grid FDM

For multiple bodies, Fullmag should allow:

- one native grid per body,
- optional per-body origin / translation,
- common convolution grid for demag when appropriate,
- self and cross demag accumulation,
- body-local self terms,
- explicit pair/interface coupling operators.

This naturally supports:

- layers with different `dz`,
- layers with different lateral resolution,
- sparse occupation of space,
- stacks without wasting cells on large empty spacers.

## 5.3 Transfer operators

When demag uses a common convolution grid while bodies keep native grids, transfer operators are required:

- `push_m`: native body grid \(\to\) convolution grid
- `pull_h`: convolution grid \(\to\) native body grid

A minimal V1 contract is:

- volume-weighted averaging for coarsening,
- piecewise-constant injection for refinement,
- trilinear interpolation for pulling fields back,
- axis-aligned box-grid restriction in V1,
- clear provenance about the transfer used.

### 5.3.1 Important subtlety

Demag transfer should be formulated in terms of the physical magnetization \(M\) and demag field \(H\),
not in ways that accidentally mix reduced and physical units.

---

## 6. Public API direction

## 6.1 What the current API already gets right

The current public flat API already exposes multiple magnetic bodies through repeated calls to
`fm.geometry(...)`, and the underlying class model already has `Ferromagnet`, `Material`, and
`Region` as distinct concepts.

The FDM discretization hints also already expose:

- per-magnet native grid overrides,
- a demag strategy choice between single-grid and multilayer-convolution policies.

This is a strong foundation.

## 6.2 What is still missing

The missing semantics are:

1. explicit constitutive parameter fields,
2. explicit inter-body couplings,
3. planner/runtime support for these semantics end-to-end,
4. validation messages that tell the user which semantics are being used.

## 6.3 Proposed API shape

### 6.3.1 Material law inside one body

```python
rod = fm.geometry(fm.Box(...), name="rod")
rod.Ms = 800e3
rod.Aex = 13e-12

# proposed future
# rod.material_field("Ms", ms_field, semantics="constitutive")
# rod.material_field("Aex", a_field, semantics="constitutive")
# rod.material_regions({
#     "soft": fm.Material(...),
#     "hard": fm.Material(...),
# })
```

### 6.3.2 Explicit couplings across bodies

```python
a = fm.geometry(...)
b = fm.geometry(...)

# proposed future
# fm.contact_exchange(a, b, law="continuum_contact")
# fm.surface_exchange(a, b, sigma=-1e-4, sigma2=0.0)
```

### 6.3.3 Per-body native grids

```python
disc = fm.FDM(
    default_cell=(4e-9, 4e-9, 1e-9),
    per_magnet={
        "a": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
        "b": fm.FDMGrid(cell=(4e-9, 4e-9, 2e-9)),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(512, 512),
    ),
)
```

---

## 7. IR design

## 7.1 New IR concepts

The current `ProblemIR` already has enough structure to separate geometries, regions, materials,
magnets, and discretization hints. The next extension should make two new semantic layers explicit:

- `MaterialLawIR`
- `CouplingIR`

### 7.1.1 Suggested pseudo-IR

```rust
enum MaterialLawIR {
    Uniform {
        material: String,
    },
    PiecewiseRegions {
        default_material: String,
        assignments: Vec<RegionMaterialBindingIR>,
    },
    ParameterFields {
        base_material: String,
        fields: Vec<ParameterFieldBindingIR>,
    },
}

enum ParameterFieldKindIR {
    Ms,
    ExchangeStiffness,
    UniaxialAnisotropy,
    AnisotropyAxis,
    Damping,
    InterfacialDmi,
}

struct ParameterFieldBindingIR {
    kind: ParameterFieldKindIR,
    field_ref: String,
    semantics: ConstitutiveFieldSemanticsIR,
}

enum ConstitutiveFieldSemanticsIR {
    ExplicitConstitutiveField,
}

enum CouplingIR {
    ContactExchange {
        body_a: String,
        body_b: String,
        law: ContactExchangeLawIR,
    },
    SurfaceExchange {
        body_a: String,
        body_b: String,
        sigma: f64,
        sigma2: f64,
        matcher: SurfaceMatcherIR,
    },
}
```

## 7.2 Planner modes

The planner should explicitly choose among execution modes such as:

1. `single_body_uniform`
2. `single_body_piecewise_material`
3. `single_body_parameter_fields`
4. `multi_body_single_grid`
5. `multi_body_multilayer_demag`
6. `multi_body_general_cross_demag`
7. `multi_body_with_explicit_couplings`

These are not just performance variants; they are semantic commitments.

## 7.3 Planner validation

The planner should validate at least:

- whether a backend supports the requested parameter fields,
- whether contact exchange is requested across bodies with compatible interface realization,
- whether multilayer demag eligibility conditions are met,
- whether the user appears to be encoding a sharp interface through a constitutive field.

---

## 8. Validation and provenance rules

## 8.1 Non-negotiable validations

### 8.1.1 `Ms` field warnings

If a user declares an `Ms` field, Fullmag should record a provenance note such as:

> `Ms(x)` is treated as a constitutive field and will directly affect magnetostatic source
> through `M = Ms m`. Use separate bodies or sharp region assignment if you intended a sharp interface.

### 8.1.2 Touching bodies without explicit coupling

If two bodies are geometrically adjacent or overlapping in a way that suggests physical contact,
and no explicit coupling is declared, Fullmag should warn:

> bodies touch, but only demag coupling is active; no exchange is assumed across body boundaries.

### 8.1.3 Unsupported heterogeneous exchange path

If a backend cannot realize interface-aware exchange for `A(x)`, it should not silently fall back
to a naive cellwise formula. It should error or produce a very explicit provenance warning.

## 8.2 Explainability

An `explain()` / provenance output should state:

- whether the problem is single-body or multi-body,
- whether material variability is uniform, piecewise, or field-based,
- how exchange interfaces are realized,
- which demag strategy is selected,
- which transfer operators are active,
- which couplings are active.

This is especially important for cross-backend trust.

---

## 9. Backend architecture

## 9.1 Current state of the repository

The repository already contains the beginnings of the right architecture:

- Python DSL support for multiple magnets,
- per-magnet FDM grid hints,
- demag policy objects for single-grid vs multilayer convolution,
- IR support for per-magnet FDM hints and multilayer plans,
- multilayer runtime scaffolding,
- transfer operators between native and convolution grids.

At the same time, the current executable FDM planner baseline still supports only one geometry and one magnet.

This means Fullmag already has the *right direction*, but not yet the full end-to-end product path.

## 9.2 Single-body backend path

For one heterogeneous body, a robust FDM backend should expose:

- cell masks,
- cellwise `Ms`,
- facewise `A_f`,
- exact or calibrated tensor demag,
- clear field/energy outputs.

## 9.3 Multi-body demag path

The multilayer demag runtime should preserve the following contract:

1. transfer each body magnetization to the convolution grid,
2. transform to Fourier space,
3. accumulate self and cross tensor convolutions,
4. inverse transform,
5. transfer demag field back to native grids,
6. assemble body-local `H_eff`.

### 9.3.1 Strong identity test

For a single body (`L=1`), the multilayer path should reduce identically to the single-body exact
tensor demag path.

## 9.4 Interface coupling runtime

Future coupling runtimes should use precomputed pairing structures:

- aligned interface face maps for simple stacks,
- surface-cell link lists for IEC,
- future non-aligned interface search / quadrature for general geometries.

The key is that coupling data structures should live alongside the plan as first-class execution data.

---

## 10. Recommended semantics for the user-facing model

## 10.1 Sharp-interface-first policy

Fullmag should adopt a “sharp-interface-first” policy:

- if the user means distinct bodies or interfaces, make that explicit,
- if the user means a true constitutive field, allow it and state the consequences,
- never force one concept to masquerade as the other.

## 10.2 Safe default policy

A safe default policy is:

- body-local exchange is always on when `Exchange()` is enabled,
- demag is global when `Demag()` is enabled,
- inter-body exchange is off unless explicitly declared,
- constitutive fields are opt-in and validated.

This avoids silent physics changes.

---

## 11. Test and benchmark program

## 11.1 Single-body heterogeneous media

1. **Heistracher standard problem**  
   Domain wall pinning at a phase boundary, with separate cases for jumps in:
   - `A`,
   - `K`,
   - `Js/Ms`,
   - combinations thereof.

2. **Exchange interface test**  
   Compare discrete exchange against analytic flux continuity in 1D and 3D aligned cases.

3. **`Ms` gradient demag tests**  
   Compare:
   - uniform `m`,
   - graded `Ms(x)`,
   - sharp `Ms` jump,
   against analytical or high-accuracy reference computations.

## 11.2 Multi-body coupled systems

1. Two bodies with only demag coupling.
2. Touching bodies with no explicit coupling.
3. Touching bodies with explicit contact exchange.
4. Separated bodies with bilinear / biquadratic surface exchange.
5. Mixed-resolution multilayer stack.
6. `L=1` multilayer demag identity test.
7. Pair symmetry and reciprocity tests for cross demag energy.

## 11.3 Cross-code validation

Where practical:

- compare shared-grid single-body heterogeneous exchange against OOMMF-style references,
- compare surface exchange against OOMMF `TwoSurfaceExchange`,
- compare layered demag against Boris-style multilayer results or internal exact tests.

---

## 12. Implementation phases

## 12.1 Phase 0 — semantics freeze

- freeze the distinction between region / body / material law / coupling,
- add documentation and provenance messages first,
- do not silently overload `Region` with more meaning.

## 12.2 Phase 1 — single-body heterogeneous media

- finish face-based heterogeneous exchange,
- finish cellwise `Ms` demag semantics,
- add constitutive field declarations,
- add validation/provenance.

## 12.3 Phase 2 — public multi-body demag path

- expose end-to-end planner support for multiple magnets,
- use existing per-magnet grid hints and multilayer demag scaffolding,
- enforce synchronous LLG stepping.

Status on `2026-03-25`:

- done for public FDM on the current eligible multilayer slice,
- done for bootstrap FEM via merged disjoint mesh assets into one `FemPlanIR`,
- still missing for explicit inter-body couplings and native CUDA multilayer FDM execution.

## 12.4 Phase 3 — explicit couplings

- contact exchange,
- surface exchange,
- interface pairing/link-list infrastructure,
- outputs for coupling energy.

## 12.5 Phase 4 — advanced geometry/interface handling

- non-aligned interfaces,
- general 3D surface matching,
- FEM/FDM cross-validation for sharp interfaces,
- future chiral inter-body couplings.

---


## 12.6 Concrete repository work items

### Python shared model
- extend `structure.py` with a material-law concept instead of assuming only one uniform `Material`,
- add parameter-field bindings,
- add coupling objects,
- keep `Region` lightweight and non-physical.

### Flat API
- keep repeated `fm.geometry(...)` as the path to multiple magnetic bodies,
- add explicit helpers for contact exchange and surface exchange,
- add explicit declarations for constitutive fields.

### IR
- extend `ProblemIR` with `MaterialLawIR` and `CouplingIR`,
- preserve backward compatibility for the current uniform-material single-body path.

### Planner
- separate semantic selection from backend selection,
- emit provenance that explains whether the problem is:
  - one body / many bodies,
  - uniform / piecewise / field-based,
  - demag-only coupled / explicitly exchange-coupled.

### Runtime
- keep demag transfer semantics in `M` and `H`,
- add coupling runtimes next to multilayer demag rather than burying them inside a generic exchange stencil,
- preserve the `L=1` identity between multilayer and single-layer exact demag.


## 13. Final recommendation

The categorical Fullmag answer to the “region problem” is not “ban material gradients”, and it is
not “use harmonic means everywhere”. The correct answer is:

- model **true material gradients** as constitutive fields,
- model **sharp interfaces inside one continuum field** with interface-aware discrete operators,
- model **distinct magnetic bodies** with separate magnetization fields,
- model **inter-body couplings explicitly**,
- derive demag from the physical magnetization \(M = Ms\,m\),
- make the selected semantics visible in planner provenance and validation.

That is the cleanest path to a solver that is both physically correct and architecturally stable.



---

## 14. References and validation targets

### Repository references
- `docs/physics/0100-mesh-and-region-discretization.md`
- `docs/physics/0400-fdm-exchange-demag-zeeman.md`
- `docs/physics/0421-fdm-multilayer-convolution-demag.md`
- `docs/physics/0440-fdm-interfacial-dmi.md`
- `packages/fullmag-py/src/fullmag/world.py`
- `packages/fullmag-py/src/fullmag/model/discretization.py`
- `packages/fullmag-py/src/fullmag/model/structure.py`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-engine/src/multilayer.rs`
- `crates/fullmag-fdm-demag/src/transfer.rs`

### External physics references
- Paul Heistracher et al., *Proposal for a micromagnetic standard problem: Domain wall pinning at phase boundaries*, JMMM 548 (2022) 168875.
- Claas Abert, *Micromagnetics and spintronics: models and numerical methods*, Eur. Phys. J. B 92, 120 (2019).
- OOMMF User Guide:
  - `Oxs_Exchange6Ngbr`
  - `Oxs_ExchangePtwise`
  - `Oxs_TwoSurfaceExchange`
- mumax3:
  - `engine/exchange.go`
  - workshop Q&A on inter-region exchange
- Lucian Lepadatu, multilayered / multiscale convolution demagnetization references.
