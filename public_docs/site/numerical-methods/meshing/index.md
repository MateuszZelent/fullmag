---
title: Meshing
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: numerical meshing pages and owner-oriented documentation architecture
---

(public-docs-numerical-methods-meshing-root)=
# Spatial discretization and meshing

:::{admonition} This is the numerical overview, not the configuration manual
:class: important

This section explains approximation spaces, discretization error, convergence, and state transfer.
Use the owner-specific branches for operational detail:

- {doc}`Python API / Meshing <../../python-api/meshing/index>` — commands, parameters, defaults,
  validation, and lowering;
- {doc}`Frontend / Control Room / Meshing <../../frontend/control-room/meshing/index>` — panels,
  drafts, Apply/Build actions, effective values, reports, and visualization;
- {doc}`Backend / Meshing <../../backend/meshing/index>` — actual grid/mesh generators, shared-domain
  construction, element families, fallbacks, extraction, quality, and provenance.
:::

## Why FDM and FEM are separate

| Property | FDM | FEM |
|---|---|---|
| Spatial support | Cartesian cells and masks | conforming elements and semantic attributes |
| Magnetization location | cell centres | finite-element degrees of freedom |
| Local derivatives | difference stencils | weak-form element operators |
| Curved boundaries | stair-step or qualified cut-cell correction | geometry and boundary elements |
| Nonlocal demag | padded/common FFT grids | airbox potential or FEM/BEM boundary operator |
| Refinement | cell-size/count sequence | h-, p-, geometry-, layer-, and airbox refinement |

The two discretizations solve related continuum models but not identical discrete problems. A field
transferred between them becomes a new state and all target operators must be rebuilt.

## Physical resolution scales

The exchange length

```{math}
:label: eq-meshing-overview-exchange-length
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

and a uniaxial wall parameter

```{math}
:label: eq-meshing-overview-wall-width
\Delta=\sqrt{\frac{A}{K_{\mathrm{eff}}}}
```

provide initial scales. They are not universal acceptance thresholds. DMI, interfaces, notches,
surface terms, vortex/skyrmion cores, localized modes, and through-thickness structure may require
finer resolution.

## Independent convergence limits

A defensible result separates:

1. FDM cell or FEM element-size convergence;
2. FEM polynomial and geometry-order convergence;
3. through-thickness layer convergence;
4. airbox extent, grading, and closure convergence;
5. periodic-image or periodic-pair convergence/consistency;
6. time-step, relaxation, eigen/linear-solver, and frequency-sampling errors.

For three geometrically related levels and refinement ratio $r$, an observed scalar order can be
estimated by

```{math}
:label: eq-meshing-overview-observed-order
p_{\mathrm{obs}}
=\frac{\log\left|\left(Q_h-Q_{h/r}\right)/
\left(Q_{h/r}-Q_{h/r^2}\right)\right|}{\log r},
```

provided the same physical branch is compared and other errors are smaller.

## Scientific acceptance

A mesh is not qualified because it renders correctly or because the mesher returned success. Record
and validate:

- bounds, volume, connectivity, region and boundary ownership;
- active masks or element/facet attributes;
- periodic correspondence and gauge metadata;
- positive Jacobians and lower-tail quality metrics;
- requested and realized topology, order, layers, size fields, and fallbacks;
- grid/mesh, submesh, transfer, and operator digests;
- observable convergence on a controlled sequence.

## Detailed numerical pages

The pages below retain the method-specific numerical background. Their operational configuration and
implementation cross-reference the owner-oriented branches listed above.

```{toctree}
:maxdepth: 1

fdm-grids
fem-shared-domain
airbox
swept-meshes
refinement
```
