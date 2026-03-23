# Material Assignment and Spatial Fields v0

## Goal

This specification defines the canonical Fullmag policy for:

- regions,
- material assignment,
- spatial variation of material parameters,
- backend lowering of heterogeneous material data.

Its main purpose is to avoid an architecture in which all spatial material variation is forced
through a fixed or backend-driven region system.

## Core decision

Fullmag must **separate topology from coefficient variation**.

That means:

- **regions** describe domain structure and tagging,
- **materials** describe base material definitions,
- **material assignment** binds materials to regions or subdomains,
- **spatial parameter fields** describe continuous or sampled variation of selected material
  parameters.

In other words:

> regions are not the primary mechanism for modeling smooth gradients of `Ms`, `A`, `alpha`, or
> future coefficients.

## Why this matters

Some existing FDM workflows tie parameter variation too tightly to region indices.
That creates practical problems:

- hard region-count limits,
- awkward modeling of smooth gradients,
- excessive region fragmentation,
- poor semantics for interface physics,
- backend-specific leakage into the shared model.

Fullmag must avoid that trap from the start.

## Canonical rules

### 1. No hard 256-region architecture rule

Fullmag must not adopt an architecture whose shared semantics depend on a tiny fixed region limit.

At the planning/lowering level, region identifiers should be representable at least as `u32`
indices or equivalent symbolic names lowered to `u32`.

If some backend later has an implementation-specific limit, that must be surfaced as a capability
restriction of that backend, not as a shared product rule.

### 2. Regions are for topology, not for every gradient

Regions exist to represent:

- domain decomposition,
- geometry parts,
- material-domain ownership,
- interface/boundary tagging,
- later domain-level physics policies.

Regions should not be the required representation for:

- smooth gradients of `Ms`,
- smooth gradients of `A`,
- smooth gradients of `alpha`,
- future spatially varying anisotropy or DMI parameters.

### 3. Spatial variability needs two legal modes

The shared architecture must support two distinct forms of material variability:

#### 3.1 Piecewise-constant assignment

Example:

- region `core` uses material `Py`
- region `shell` uses material `CoFeB`

This is the normal region/material mapping case.

#### 3.2 Continuous or sampled parameter fields

Example:

- `Ms(x)` varies smoothly along one axis,
- `A(x)` is graded through thickness,
- `alpha(x)` is sampled from a preprocessing step.

This mode must not require manufacturing large numbers of artificial regions.

### 4. Shared semantics stay backend-neutral

The public Python API and canonical `ProblemIR` may describe:

- material definitions,
- region definitions,
- material-to-region assignment,
- spatial parameter fields.

They must not expose:

- per-cell CUDA buffers,
- per-element MFEM coefficient objects,
- backend-owned storage layouts,
- backend-specific indexing hacks.

## Target conceptual model

The long-term model should be read as:

```text
Geometry
  -> Regions
      -> Material assignments
      -> Optional spatial parameter fields
```

More explicitly:

- `Region`
  - names a part of the domain
- `Material`
  - defines base constants
- `MaterialAssignment`
  - says which material applies in which region
- `SpatialScalarField`
  - optionally overrides or modulates a specific coefficient in space

The presence of a parameter field does not remove the base material.
The base material still defines defaults and physical identity.

## Backend interpretation

### FDM

For FDM, the planner/lowering layer should eventually distinguish:

1. `cell_region_id`
   - topological ownership of each cell
2. `cell_material_id`
   - base material assignment of each cell
3. parameter realization
   - either table lookup for piecewise-constant materials,
   - or per-cell arrays for varying coefficients

This implies three useful execution paths:

#### FDM fast path: uniform material

- one material everywhere
- no material lookup per cell

#### FDM medium path: piecewise-constant multi-region materials

- many cells may reference different material IDs
- coefficients are constant per material/region

#### FDM general path: parameter fields

- selected coefficients are realized as per-cell arrays

This split is important because not every problem should pay the cost of the most general path.

### Exchange-specific FDM rule

For heterogeneous exchange, the discrete operator should not be modeled as a naive cell-local
`A_i * Laplacian(m_i)` rule.

The planner/backend design should support **face-centered exchange coefficients** or an equivalent
interface-aware realization.

Conceptually:

\[
H_{\mathrm{ex},i} \sim \frac{1}{M_{s,i}} \sum_f A_f (m_j - m_i)
\]

where `A_f` is an inter-cell coefficient derived from neighboring material data.

This is the right place to support:

- material jumps,
- smooth spatial variation,
- future interface-specific exchange rules.

### FEM

For FEM, the same semantics should lower to:

- domain markers / attributes for topology,
- piecewise-constant coefficients when appropriate,
- coefficient fields / functions for spatial variability.

Again, the shared concept is the same:

- regions define topology,
- coefficient fields define continuous variation.

### Hybrid

Hybrid execution should preserve the same semantic split and lower it independently to:

- mesh-side coefficient realization,
- auxiliary grid-side coefficient realization,
- coupling/projection metadata.

## ProblemIR implications

Current bootstrap `ProblemIR` already separates:

- `RegionIR`
- `MaterialIR`
- `MagnetIR`

but it does not yet contain the full architecture for heterogeneous material realization.

That is acceptable only as a bootstrap limitation.

The long-term IR should be extended with concepts equivalent to:

- `MaterialAssignmentIR`
- `SpatialScalarFieldIR`
- possibly later:
  - `InterfaceMaterialRelationIR`
  - `ExchangeCoefficientPolicyIR`

The important design rule is:

- shared `ProblemIR` stores semantic relationships,
- execution plans store lowered per-cell / per-element realization.

## Execution-plan implications

The current bootstrap `FdmPlanIR` contains:

- `region_mask`
- one `material`

This is not the final architecture for heterogeneous materials.

The long-term FDM execution plan should evolve toward a shape conceptually closer to:

- `region_ids`
- `material_table`
- `cell_material_ids`
- optional per-cell realized coefficient arrays
- optional lowered face-coefficient buffers for selected operators

This is the correct place for backend-specific realized data.

## Validation policy

Validation should eventually distinguish:

### Shared semantic validation

- all referenced regions exist,
- all referenced materials exist,
- assignments are well-formed,
- parameter fields target legal coefficients,
- spatial fields are dimensionally consistent.

### Backend planning validation

- chosen backend supports the requested variability mode,
- selected operator realization is legal,
- required per-cell or per-element data can be produced.

### Scientific validation

- region-volume sanity,
- coefficient-field sanity,
- interface consistency,
- cross-backend comparison for heterogeneous cases.

## Immediate product rule

Until the full heterogeneous path is implemented, the repository should still behave as if this is
the intended architecture.

That means:

- no new feature should hardcode a small fixed region model into shared semantics,
- no new planner path should assume that gradients must be encoded as many regions,
- no CUDA ABI should be designed in a way that blocks future per-cell parameter fields.

## Current honest state

Today, the repository is still in a narrow bootstrap state:

- `Material` is effectively constant-valued,
- `FdmPlanIR` still carries a single realized material payload,
- `region_mask` exists but does not yet implement the full heterogeneous design.

This is acceptable only because the current public-executable subset is deliberately narrow.
It must not be mistaken for the long-term material architecture.

## Deferred implementation topics

These are intentionally deferred, but the architecture must leave room for them:

- sampled scalar coefficient fields from Python callables,
- imported scalar fields from files,
- interface-specific exchange models,
- parameter interpolation policies during mesh-grid projection,
- heterogeneous validation benchmarks.
