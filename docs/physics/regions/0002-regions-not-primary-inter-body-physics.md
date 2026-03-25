
# ADR: Regions must not be the primary carrier of inter-body physics in Fullmag

- Status: proposed
- Date: 2026-03-25
- Decision owners: Fullmag core

---

## 1. Context

Fullmag already distinguishes geometry, region, material, and ferromagnet in the shared model.
However, the project still needs an explicit architectural decision about how “regions” relate to:

- piecewise material assignment,
- continuous constitutive fields,
- multiple magnetic bodies,
- exchange across interfaces,
- IEC/RKKY across surfaces,
- demagnetization across independently discretized bodies.

Without a hard decision, backend implementations may drift toward a Mumax-like “paint regions and
let neighbor rules decide the physics” approach. That would make it difficult to express user
intent precisely and would entangle modeling semantics with a particular FDM stencil.

---

## 2. Decision

Fullmag adopts the following decision:

> **Regions are topology / labeling objects.  
> They are not the primary carrier of inter-body physics.**

The primary physics-bearing objects are:

- `Ferromagnet` / magnetic body — owner of one magnetization field,
- `MaterialLaw` — constitutive law inside that body,
- `Coupling` — explicit physics between different bodies or interfaces.

### 2.1 Default physics contract

- Exchange acts **inside a body** when `Exchange()` is enabled.
- Demag acts **globally** across all magnetic bodies when `Demag()` is enabled.
- Exchange **across different bodies** is **off by default** and must be enabled explicitly through a coupling object.
- Constitutive parameter fields are allowed only through explicit declarations, not as hidden region tricks.

---

## 3. Rationale

## 3.1 Why regions alone are insufficient

A region can represent:

- topological ownership,
- material partitioning inside one body,
- imported CAD markers,
- output selection.

But a region cannot, by itself, tell the solver whether:

- two sides should share one reduced magnetization field,
- exchange should exist across the interface,
- the interface carries a distinct surface energy,
- two sides should live on different native grids,
- a material variation is a true constitutive field or a surrogate for a sharp interface.

Therefore region adjacency is not a sufficient semantic source for interface physics.

## 3.2 Why the default must be explicit

If touching bodies automatically exchange-couple just because their masks touch after voxelization,
then changing:

- grid resolution,
- voxelizer tolerance,
- geometry import details,

can silently change the modeled physics.

An explicit coupling avoids this.

## 3.3 Why constitutive fields must remain supported

Rejecting all spatially varying coefficients would be wrong physically. Fullmag must support real:

- graded `Ms`,
- graded `A`,
- graded anisotropy,
- graded damping,
- per-body DMI.

But these are constitutive fields inside a model, not substitutes for topological interfaces.

---

## 4. Consequences

## 4.1 Positive consequences

- user intent becomes explicit,
- solver semantics become backend-independent,
- multi-body and heterogeneous single-body problems can coexist cleanly,
- provenance can explain what the planner selected,
- validation can detect suspicious modeling shortcuts,
- per-body native grids become natural.

## 4.2 Trade-offs

- user API becomes a little more explicit,
- planners and runtimes need additional IR objects,
- some “simple region-painting” scripts will need migration or warnings,
- contact exchange across touching bodies becomes a deliberate modeling choice.

---

## 5. Detailed decision

## 5.1 Semantics of main entities

### `Geometry`

Spatial asset only.

### `Region`

Named topological subset used for:

- domain labeling,
- imported geometry markers,
- piecewise assignment inside a body.

### `Ferromagnet`

Owner of:

- geometry,
- material law,
- initial magnetization,
- native discretization hints.

### `MaterialLaw`

Defines one of:

- uniform coefficients,
- piecewise region-based coefficients,
- constitutive parameter fields.

### `Coupling`

Defines explicit inter-body/interface physics.

---

## 6. Proposed model additions

## 6.1 Python-side additions

```python
# proposed
body.material_field("Ms", field, semantics="constitutive")
body.material_field("Aex", field, semantics="constitutive")

fm.contact_exchange(body_a, body_b, law="continuum_contact")
fm.surface_exchange(body_a, body_b, sigma=-1e-4, sigma2=0.0)
```

## 6.2 IR additions

```rust
enum MaterialLawIR {
    Uniform { material: String },
    PiecewiseRegions { default_material: String, assignments: Vec<...> },
    ParameterFields { base_material: String, fields: Vec<ParameterFieldBindingIR> },
}

enum CouplingIR {
    ContactExchange { body_a: String, body_b: String, law: ContactExchangeLawIR },
    SurfaceExchange { body_a: String, body_b: String, sigma: f64, sigma2: f64, matcher: SurfaceMatcherIR },
}
```

---

## 7. Validation policy

## 7.1 Warnings

Emit warnings when:

- `Ms(x)` is declared and therefore will directly affect demag source,
- multiple bodies touch but no inter-body exchange coupling is declared,
- heterogeneous `A(x)` is requested on a backend that cannot realize interface-aware exchange,
- a user attempts to emulate a spacer purely through region tricks on one body.

## 7.2 Errors

Emit errors when:

- requested couplings are unsupported by the backend,
- nonlocal interface couplings have no realizable interface matcher,
- constitutive fields are declared without a supported realization strategy.

---

## 8. Planner impact

The planner must distinguish at least:

1. single-body uniform,
2. single-body piecewise heterogeneous,
3. single-body constitutive fields,
4. multi-body demag-only,
5. multi-body with explicit couplings.

Planner provenance should always record:

- semantic mode selected,
- demag strategy selected,
- exchange interface policy,
- active warnings.

---

## 9. Backend impact

## 9.1 FDM

Inside one body:

- demag from `M = Ms * m`,
- exchange from face-based discrete energy,
- interface-aware `A_f`.

Across bodies:

- self terms per body,
- demag cross-coupling,
- explicit interface coupling operators.

## 9.2 Multilayer demag

The existing multilayer demag scaffolding fits the ADR well because it already assumes:

- per-body state,
- per-body native grids,
- common convolution grid,
- transfer operators.

## 9.3 FEM

The same semantic split should hold in FEM:

- region/domain markers for topology,
- material laws for coefficients,
- explicit couplings for inter-body physics.

---

## 10. Migration guidance

### Existing scripts that already use one `Ferromagnet`

No change needed.

### Existing scripts that use multiple `fm.geometry(...)` calls

They already express multiple bodies semantically. Future work should simply make couplings and
planner support explicit.

### Existing or future scripts that rely on region adjacency for exchange semantics

These should receive warnings and eventually migrate to one of:

- single-body piecewise material assignment,
- explicit inter-body contact coupling,
- explicit surface exchange coupling.

---


## 10.1 Concrete module/file mapping proposal

### Python model
- `packages/fullmag-py/src/fullmag/model/structure.py`
  - add `MaterialLaw`
  - add parameter-field bindings
  - add coupling model types

- `packages/fullmag-py/src/fullmag/world.py`
  - keep `fm.geometry(...)` as body registration
  - add explicit coupling helpers
  - add explicit material-field declarations

- `packages/fullmag-py/src/fullmag/model/discretization.py`
  - mostly already aligned through `per_magnet` and demag policy objects

### IR and planning
- `crates/fullmag-ir/src/lib.rs`
  - add `MaterialLawIR`
  - add `CouplingIR`
  - preserve backward-compatible lowering from the current uniform-material API

- `crates/fullmag-plan/src/lib.rs`
  - add semantic-mode selection
  - add validation and provenance messages
  - add multi-body planning path

### Runtime
- `crates/fullmag-engine/src/multilayer.rs`
  - keep per-body runtime ownership
  - add explicit coupling operators next to demag runtime orchestration

- `crates/fullmag-fdm-demag/src/transfer.rs`
  - preserve explicit transfer semantics
  - document unit handling carefully (`M` vs `m`, `H` vs scaled fields)


## 11. Implementation roadmap

### Phase A

Freeze docs and validation language.

### Phase B

Land constitutive field declarations and provenance.

### Phase C

Land public multi-body planner path using existing per-magnet and multilayer demag scaffolding.

### Phase D

Land explicit inter-body coupling objects.

### Phase E

Extend to general non-aligned interfaces and FEM parity.

---

## 12. Resulting design principle

This ADR establishes the long-term Fullmag rule:

> **Use regions to describe where things are.  
> Use material laws to describe what a body is made of.  
> Use couplings to describe how different bodies interact.**

That separation is the cleanest possible answer to the multi-region problem.

