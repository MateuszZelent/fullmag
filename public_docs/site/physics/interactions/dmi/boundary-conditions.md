---
title: DMI boundary conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-boundary-conditions)=
# DMI boundary conditions

When Dzyaloshinskii–Moriya interaction is active, the natural boundary condition on the
magnetic surface $\partial\Omega_m$ is modified from the standard homogeneous Neumann
exchange condition. This page documents the exact boundary terms for both DMI variants.

## Interfacial DMI boundary condition

The combined exchange-plus-interfacial-DMI variational problem produces the natural surface
term

```{math}
:label: eq-idmi-bc
A\,\partial_n\mathbf{m}
+ D\,\hat{\mathbf{n}}\times(\mathbf{n}_s\times\mathbf{m})
= \mathbf{0}
\qquad\text{on }\partial\Omega_m,
```

where $\mathbf{n}_s$ is the outward surface normal and $\hat{\mathbf{n}}$ is the
interface-symmetry normal. For $\hat{\mathbf{n}}=\hat{\mathbf{z}}$ this reduces to the
Rohart–Thiaville condition.

This boundary condition is physically significant: it modifies the equilibrium magnetization
at the sample edges and determines the boundary twist of chiral domain walls and skyrmions.
For strong DMI ($|D|/(2A)$ comparable to the inverse sample width), the boundary condition
lifts the edge magnetization toward the interface normal.

### FEM implementation

In the FEM weak formulation, the natural boundary condition arises automatically from the
variational principle. The DMI weak residual includes a boundary integral that implicitly
enforces Eq. {eq}`eq-idmi-bc`. No explicit boundary penalty or constraint is needed.

### FDM implementation

In the FDM stencil, open or inactive boundary neighbours use the centre magnetization as
the ghost value, which enforces the standard zero-flux exchange condition. The DMI stencil
contribution at boundary cells uses one-sided finite differences or reflected values that
encode the same surface condition.

## Bulk DMI boundary condition

The combined exchange-plus-bulk-DMI natural boundary term is

```{math}
:label: eq-bdmi-bc
A\,\partial_n\mathbf{m}
+ D\,\mathbf{n}_s\times\mathbf{m}
= \mathbf{0}
\qquad\text{on }\partial\Omega_m.
```

This is the isotropic analogue: the DMI surface correction is a tangential rotation
proportional to the DMI constant and the surface normal.

## Characteristic length

The DMI boundary condition introduces a characteristic length

```{math}
:label: eq-dmi-bc-length
\ell_{\mathrm{DMI}} = \frac{2A}{|D|}
```

that determines the spatial extent of the boundary twist. When the sample dimension is much
larger than $\ell_{\mathrm{DMI}}$, the boundary modification is confined to a surface layer.
When the sample is comparable to $\ell_{\mathrm{DMI}}$, the DMI boundary condition
significantly modifies the bulk magnetization profile.

## Impact on skyrmion confinement

In confined geometries (nanodiscs, nanowires), the DMI boundary condition determines
whether skyrmions are attracted to or repelled from the sample edge. The Rohart–Thiaville
analysis shows that the boundary condition creates an effective edge potential for skyrmion
centres.

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $A$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $D$ | DMI constant | $\mathrm{J\,m^{-2}}$ |
| $\hat{\mathbf{n}}$ | interface-symmetry normal | $1$ |
| $\mathbf{n}_s$ | outward surface normal | $1$ |
| $\partial_n$ | normal derivative | $\mathrm{m^{-1}}$ |
| $\ell_{\mathrm{DMI}}$ | DMI boundary-twist length | $\mathrm{m}$ |

## Scientific bibliography

1. S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in
   the presence of Dzyaloshinskii-Moriya interaction," *Physical Review B* **88**, 184422
   (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
2. A. O. Leonov, T. L. Monchesky, N. Romming, A. Kubetzka, A. N. Bogdanov, and
   R. Wiesendanger, "The properties of isolated chiral skyrmions in thin magnetic films,"
   *New Journal of Physics* **18**, 065003 (2016).
   [doi:10.1088/1367-2630/18/6/065003](https://doi.org/10.1088/1367-2630/18/6/065003).
