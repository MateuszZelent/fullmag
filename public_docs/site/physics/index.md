---
title: Physics reference
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0000-physics-documentation-standard.md
---

(public-docs-physics-root)=
# Physics reference

Each public physics page follows the same chain:

physical problem → continuous equations → FDM and FEM interpretations → implementation → test →
reproducible example.

```{figure} /_static/diagrams/fullmag-object-interaction-architecture.svg
:alt: Fullmag architecture pipeline from fm.study and scene objects with immutable object_id, regions, SI materials, and explicit physics modules through ProblemIR requested intent and the fail-closed planner to four separate execution lanes (FDM CPU, FDM GPU, FEM CPU, FEM GPU) and materialized binary/scalar Zarr outputs.
:width: 100%
:name: fig-fullmag-object-interaction-architecture
:figclass: fm-physics-figure

Canonical Fullmag object, physics-module, `ProblemIR`, and four-lane execution architecture. Scene objects carry immutable `object_id`, user `name`, presentational `type`, geometry AST, `ObjectRegion` partitions, and SI `Material` records; explicit physics modules register field terms ($\mathcal{K}_{\mathrm{field}} \to \mathbf{H}_k$), direct torques ($\boldsymbol{\tau}_{\mathrm{direct}}$), coupled PDEs, and inter-region couplings ($\Gamma_{ab}$). `ProblemIR` preserves **requested intent**, while `fullmag-plan` resolves execution fail-closed across the four separate lanes (**FDM CPU**, **FDM GPU**, **FEM CPU**, **FEM GPU**) and materialized Zarr/binary observables (see Abert 2019, [CC-BY PDF](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf)).
```

```{toctree}
:hidden:
:maxdepth: 3

foundations/index
interactions/index
```

```{toctree}
:hidden:

conventions
geometry-and-materials
```

## Explore the physics library

The library is grouped by purpose so you can open only the branch you need. The complete
Sphinx navigation remains available in the site sidebar and inside each section page.

:::{dropdown} Foundations
:class-container: fm-physics-menu__group

Shared definitions used by every interaction and numerical backend:

- {doc}`foundations/conventions-and-units` — SI conventions, reduced magnetization, and canonical quantities.
- {doc}`foundations/micromagnetic-energy` — total energy functional and variational principle.
- {doc}`foundations/effective-field` — effective field, direct torque, and interaction composition.
- {doc}`foundations/llg-equation` — Landau–Lifshitz–Gilbert dynamics and overdamped relaxation.
- {doc}`foundations/boundary-conditions` — exchange, DMI, periodic, airbox, and mechanical boundaries.
- {doc}`foundations/observables` — fields, scalars, table output, and materialisation rules.
:::

:::{dropdown} Interactions
:class-container: fm-physics-menu__group

Physical energy and torque contributions. Open an interaction page to reach its solver-specific
FDM/FEM and CPU/GPU branches.

- {doc}`interactions/exchange/index` — exchange stiffness and discrete Laplacians.
- {doc}`interactions/demagnetization/index` — FDM convolution, FEM Poisson, BEM, periodic demag, and validation.
- {doc}`interactions/zeeman/index` — externally prescribed magnetic fields.
- {doc}`interactions/anisotropy/index` — uniaxial and cubic anisotropy.
- {doc}`interactions/dmi/index` — interfacial and bulk Dzyaloshinskii–Moriya interaction.
- {doc}`interactions/thermal-noise/index` — thermal stochastic field and reproducibility policy.
- {doc}`interactions/magnetoelastic/index` — magnetoelastic energy and strain coupling.
- {doc}`interactions/oersted-field/index` — current-generated Oersted fields.
- {doc}`interactions/spin-transfer-torque/index` — Zhang–Li and related spin-transfer terms.
- {doc}`interactions/spin-orbit-torque/index` — spin Hall and other spin-orbit torque models.
- {doc}`interactions/drift-diffusion-spin-torque/index` — drift–diffusion spin transport coupling.
- {doc}`interactions/inter-region-couplings/index` — coupling terms across material regions.
:::
