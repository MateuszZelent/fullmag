# Exchange Boundary Condition Policy v0

- Status: accepted
- Last updated: 2026-03-23
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related physics note: `docs/physics/0200-llg-exchange-reference-engine.md`

---

## 1. Purpose

This document freezes the boundary condition semantics for the exchange interaction in the
exchange-only release. Boundary conditions are not user-configurable in this release — they
are implicit and documented here.

## 2. Physical semantics

The exchange-only release uses homogeneous Neumann boundary conditions:

$$
\frac{\partial \mathbf{m}}{\partial n}\bigg|_{\partial\Omega} = 0
$$

where $\partial\Omega$ is the sample boundary and $n$ is the outward surface normal.

### 2.1 Physical justification

Homogeneous Neumann BC is the standard free-surface boundary condition in micromagnetics.
It corresponds to zero surface torque from exchange — physically, the magnetization has no
preferred tilt at free surfaces.

This is the default in mumax3, BORIS, and OOMMF for exchange-only FDM solvers.

### 2.2 When Neumann BC is not appropriate

- Interface exchange coupling between adjacent magnetic layers — requires explicit interface terms.
- Periodic boundary conditions — relevant for films, superlattice unit cells, and infinite systems.
- Dirichlet (fixed) boundary conditions — relevant for pinned-edge geometries.

All of these are **out of scope** for the exchange-only release.

## 3. FDM realization

The reference engine (`crates/fullmag-engine`) implements Neumann BC via **ghost cell mirroring**:

For a grid index that would fall outside the domain, the stencil reads the value at the
nearest boundary cell instead. This is equivalent to clamping the neighbor index:

```
left  = max(i - 1, 0)
right = min(i + 1, n - 1)
```

This yields a symmetric 6-point Laplacian stencil where boundary cells effectively see
$\mathbf{m}_{-1} = \mathbf{m}_0$ and $\mathbf{m}_{n} = \mathbf{m}_{n-1}$, canceling the
derivative across the boundary.

### 3.1 Implementation reference

The current implementation in `crates/fullmag-engine/src/lib.rs` uses `saturating_sub(1)` for
left neighbors and `min(i+1, n-1)` for right neighbors, which is correct for Neumann BC.

## 4. FEM realization

For the FEM exchange operator using the standard Galerkin weak form:

$$
\int_\Omega A \nabla \mathbf{m} \cdot \nabla \mathbf{v} \, dV
$$

Homogeneous Neumann BC is the **natural boundary condition** — it requires no additional surface
integral term. The boundary term

$$
\int_{\partial\Omega} A \frac{\partial \mathbf{m}}{\partial n} \cdot \mathbf{v} \, dS
$$

vanishes identically for $\partial\mathbf{m}/\partial n = 0$.

This means the FEM backend automatically satisfies Neumann BC without any special boundary treatment.

## 5. User-facing API

There is **no user-facing boundary condition API** in the exchange-only release.

- Boundary conditions are implicit — always Neumann for exchange.
- The `ProblemIR` does not carry a boundary condition section.
- The Python API does not expose BC parameters.

### 5.1 Future evolution

When additional BC types are needed (periodic, Dirichlet, interface coupling), boundary
conditions will be added as:

1. A new `BoundaryConditionIR` section in `ProblemIR`.
2. Corresponding Python model classes in `fullmag.model`.
3. Capability matrix entries for backend support.

## 6. Validation

- The reference engine test `uniform_gives_zero_field` confirms that Neumann BC produces zero
  exchange field for uniform magnetization (correct: $\nabla^2 \mathbf{m} = 0$).
- The reference engine test for non-uniform exchange stencil verifies that boundary cells use
  mirrored neighbors, consistent with $\partial\mathbf{m}/\partial n = 0$.
