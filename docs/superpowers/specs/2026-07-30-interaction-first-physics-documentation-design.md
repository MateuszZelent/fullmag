# Interaction-first physics documentation

## Objective

Replace the duplicated `solver → backend → interaction` publication tree with one canonical scientific home for each physical interaction. Preserve explicit FDM/FEM and CPU/GPU truth inside that canonical interaction documentation, while allowing large topics such as demagnetization and DMI to grow into focused subchapters.

## Problem with the current tree

The existing public scaffold creates four files for every interaction:

- FDM CPU,
- FDM GPU,
- FEM CPU,
- FEM GPU.

The physical energy, effective field, symbols, SI units, Python API, and `ProblemIR` semantics are shared. Repeating them in four files creates competing sources of truth and makes scientific drift likely. Backend realization is important, but it is a dimension of an interaction rather than the owner of its physical definition.

## Canonical ownership

`public_docs/site/physics/interactions/` owns physical-interaction documentation. Every interaction has one canonical `index.md`. That page owns the common physics and contains an explicit realization matrix for FDM CPU, FDM GPU, FEM CPU, and FEM GPU. Separate realization sections are mandatory only when algorithms, discretization, boundaries, precision, memory ownership, support, failure semantics, or validation differ.

`public_docs/site/numerical-methods/` owns reusable numerical algorithms such as FFT demagnetization, Poisson-airbox methods, BEM, time integration, eigensolvers, and meshing. Interaction pages link to those method chapters rather than duplicating their general derivations.

`public_docs/site/python-api/interactions/` remains the user-facing Python authoring reference. Canonical physics pages link to it and retain only the API/ProblemIR material required to connect physics to implementation.

## Target public tree

```text
physics/
├── index.md
├── foundations/
│   ├── index.md
│   ├── conventions-and-units.md
│   ├── micromagnetic-energy.md
│   ├── effective-field.md
│   ├── llg-equation.md
│   ├── boundary-conditions.md
│   └── observables.md
└── interactions/
    ├── index.md
    ├── exchange/
    │   └── index.md
    ├── demagnetization/
    │   ├── index.md
    │   ├── mathematical-formulation.md
    │   ├── boundary-conditions.md
    │   ├── fdm-convolution.md
    │   ├── fem-poisson-airbox.md
    │   ├── fem-bem.md
    │   ├── periodic-demag.md
    │   └── validation.md
    ├── zeeman/
    │   └── index.md
    ├── anisotropy/
    │   ├── index.md
    │   ├── uniaxial.md
    │   └── cubic.md
    ├── dmi/
    │   ├── index.md
    │   ├── interfacial.md
    │   ├── bulk.md
    │   ├── boundary-conditions.md
    │   └── validation.md
    ├── thermal-noise/index.md
    ├── magnetoelastic/index.md
    ├── oersted-field/index.md
    ├── spin-transfer-torque/index.md
    ├── spin-orbit-torque/index.md
    ├── drift-diffusion-spin-torque/index.md
    └── inter-region-couplings/index.md
```

## Canonical interaction-page contract

An interaction `index.md` contains, in order:

1. physical definition and validity domain;
2. energy, effective field, torque, or source equations as applicable;
3. complete symbols and SI units;
4. assumptions and boundary conditions;
5. Python API and canonical `ProblemIR` mapping;
6. FDM realization;
7. FEM realization;
8. four-lane FDM/FEM CPU/GPU support and qualification matrix;
9. separate CPU/GPU subsections where implementation differs;
10. validation and known limitations;
11. primary literature;
12. source-code index using stable path plus symbol identities.

Small interactions remain one page. A topic receives subchapters only when the material has an independently useful scientific or numerical boundary. Demagnetization and DMI qualify immediately.

## Exchange migration

The authored `physics/exchange.md` becomes `physics/interactions/exchange/index.md` and remains the single scientific Exchange reference. Its equations, source map, labels, Python example, and source index are preserved. Links from Python API and legacy URLs are updated.

The four planned Exchange realization scaffolds are removed with the rest of the duplicated solver tree. Their old published URLs receive static redirect pages or equivalent Sphinx redirects to the canonical Exchange page. No authored scientific content is discarded.

## Navigation behavior

The sidebar follows the interaction-first tree. It exposes `Physics → Foundations` and `Physics → Interactions`; the active interaction branch expands, while unrelated branches remain collapsed. Demagnetization and DMI expose their subchapters. The menu must not show four copies of every interaction.

The root navigation depth must be sufficient to resolve the complete hierarchy, and rendered navigation tests must verify canonical links and absence of the removed solver/backend interaction branches.

## Manifest and governance migration

The canonical information-architecture manifest and its tests change from solver/backend interaction symmetry to interaction-first ownership. Validation continues to require explicit four-lane realization truth inside authored interaction pages.

Update the repository and mirrored `scientific-documentation-contract` skill so it requires:

- one canonical page per interaction;
- an explicit FDM/FEM CPU/GPU matrix;
- separate realization chapters only for material differences;
- large-topic subchapters where scientifically justified;
- no copied common equations across backend pages.

The changed-page validator remains fail-closed. Exact planned scaffolds may remain exempt, while authored scientific pages require adjacent source maps.

## Migration and compatibility

- Remove the duplicated `physics/solvers/{fdm,fem}/{cpu,gpu}/interactions/` pages from canonical navigation and source ownership.
- Preserve old public URLs through redirects to canonical interaction pages.
- Keep numerical solver method chapters under `numerical-methods/`.
- Preserve all existing public Python API pages.
- Do not move internal development documentation into the public site.
- Do not claim implementation or qualification for planned lanes.

## Verification

1. Manifest tests prove every canonical interaction appears exactly once.
2. Tests prove no canonical physics path contains duplicated FDM/FEM CPU/GPU interaction pages.
3. Demagnetization and DMI contain their complete approved subtrees.
4. The migrated Exchange page and source map pass scientific validation.
5. Strict Sphinx builds with zero warnings and no orphan pages.
6. Rendered sidebar inspection proves the interaction-first hierarchy and active-branch expansion.
7. Every old realization URL resolves to a canonical page rather than returning 404.
8. GitHub Pages build and deployment succeed before production is accepted.

## Acceptance criteria

- Exactly one canonical scientific page owns each interaction.
- Exchange is available at `/physics/interactions/exchange/`.
- Demagnetization and DMI have dedicated subtrees.
- FDM/FEM and CPU/GPU differences remain explicit and fail-closed.
- The public sidebar matches the target interaction-first hierarchy.
- No scientific content is lost and no legacy published interaction URL returns 404.
