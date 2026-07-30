---
title: Boundary conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-periodic-boundary-conditions.md
---

(public-docs-physics-foundations-boundary-conditions)=
# Boundary conditions

Boundary conditions define how the magnetization and auxiliary fields (scalar potential,
displacement) behave at the edges of the computational domain. FullMag implements
several boundary-condition types, each owned by the relevant interaction or solver module.

## Free-surface Neumann (natural exchange boundary)

The default magnetic boundary condition in bulk micromagnetics is the homogeneous Neumann
condition on the reduced magnetization:

```{math}
:label: eq-neumann-free-surface
A\,\partial_n\mathbf{m}
=
A\,(\nabla\mathbf{m})\mathbf{n}
=
\mathbf{0}
\qquad\text{on }\partial\Omega_m,
```

where $\mathbf{n}$ is the outward unit normal. This represents zero exchange torque at
free surfaces — the magnetization is free to rotate without constraint at the boundary.

In FEM implementations, this condition is the natural (variational) boundary condition
and requires no explicit enforcement. In FDM implementations, open or inactive neighbours
are replaced by the centre magnetization, yielding zero normal flux.

## DMI-modified boundary conditions

When Dzyaloshinskii–Moriya interaction (DMI) is active, the natural boundary condition on
$\partial\Omega_m$ is modified. The exchange-plus-DMI surface term becomes

```{math}
:label: eq-dmi-modified-bc
A\,\partial_n\mathbf{m} + D\,\mathbf{n}\times\mathbf{m} = \mathbf{0}
\qquad\text{(interfacial DMI)},
```

or the corresponding bulk DMI form. This boundary condition arises naturally from the
variational principle when the DMI weak form is included. FullMag enforces it through the
FEM weak formulation; FDM implementations handle it through stencil-boundary modifications.

See {doc}`../interactions/dmi/index` for the full DMI boundary-condition documentation.

## Periodic boundary conditions

Periodic boundary conditions (PBC) impose translational symmetry along one or more Cartesian
axes. For the magnetization:

```{math}
:label: eq-pbc-magnetization
\mathbf{m}(\mathbf{r} + L_d\,\hat{\mathbf{e}}_d) = \mathbf{m}(\mathbf{r})
\qquad\text{for periodic axis } d,
```

where $L_d$ is the period length along direction $d$.

### PBC in FDM

The FDM grid wraps neighbour indices along periodic axes. Exchange stencils use wrapped
neighbours instead of open-boundary clamping. Demagnetization uses convolution with
periodically replicated sources (multilayer convolution or Ewald-like summation).

### PBC in FEM

FEM periodicity reduces the finite-element space by identifying periodic boundary-node
pairs. The Poisson-demag operator uses the reduced $P^T A P$ system. Exchange and DMI
stiffness matrices are assembled on the reduced space. The field is lifted back from reduced
to full nodes after the solve.

### Python API

```python
import fullmag as fm

problem = fm.Problem(
    ...,
    boundary_conditions=[
        fm.PeriodicBoundaryCondition(axis="x"),
        fm.PeriodicBoundaryCondition(axis="y"),
    ],
)
```

## Airbox boundary conditions (demagnetization)

The FEM Poisson-demag solver operates on a domain larger than the magnetic body. The airbox
boundary supports two modes:

1. **Dirichlet**: $u = 0$ on $\partial\Omega_{\mathrm{air}}$. Accuracy improves with
   airbox size, but large airboxes increase computational cost.

2. **Robin (asymptotic)**: $\partial_n u + u/r = 0$ on $\partial\Omega_{\mathrm{air}}$.
   This first-order asymptotic condition yields better accuracy at smaller airbox scales.

See {doc}`../interactions/demagnetization/boundary-conditions` for the full demagnetization
boundary-condition documentation.

## Mechanical boundary conditions

For magnetoelastic simulations, the elastic displacement field $\mathbf{u}$ requires its own
boundary conditions:

- **Free surface (traction-free)**: $\boldsymbol{\sigma}\cdot\mathbf{n} = \mathbf{0}$
- **Clamped (fixed)**: $\mathbf{u} = \mathbf{0}$
- **Prescribed traction**: $\boldsymbol{\sigma}\cdot\mathbf{n} = \mathbf{t}$

See {doc}`../interactions/magnetoelastic/index` for details.

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf{n}$ | outward unit normal | $1$ |
| $\partial_n$ | normal derivative | $\mathrm{m^{-1}}$ |
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $D$ | DMI constant | $\mathrm{J\,m^{-2}}$ |
| $L_d$ | periodic cell size along axis $d$ | $\mathrm{m}$ |
| $u$ | magnetic scalar potential (demag) | $\mathrm{A}$ |
| $r$ | distance from magnetic body centre | $\mathrm{m}$ |
| $\mathbf{u}$ | elastic displacement | $\mathrm{m}$ |
| $\boldsymbol{\sigma}$ | stress tensor | $\mathrm{Pa}$ |

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York, 1963.
2. S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in
   the presence of Dzyaloshinskii-Moriya interaction," *Physical Review B* **88**, 184422
   (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
3. D. R. Fredkin and T. R. Koehler, "Hybrid method for computing demagnetizing fields,"
   *IEEE Trans. Magn.* **26**(2), 415 (1990).
