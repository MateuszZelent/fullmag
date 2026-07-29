# FullMag public documentation information architecture

**Status:** approved design candidate

**Scope:** public Sphinx documentation only

**Audience:** users, scientific reviewers, Python API users, and backend developers verifying published claims

## 1. Objective

Create a durable public-documentation skeleton that keeps four kinds of information separate:

1. user onboarding;
2. public Python API reference;
3. publication-style physics and numerical documentation;
4. product/runtime architecture.

The immediate correction is to remove general constructor inventories from the Exchange page without
discarding them. Those inventories move into dedicated Python API pages. The Exchange page remains a
terminal scientific page concerned only with Exchange physics, Exchange-facing authoring parameters,
its four solver/device realizations, observables, evidence, and source mapping.

The skeleton covers implemented, partial, unsupported, and planned capabilities. A planned page is a
navigation commitment, not a claim that the capability exists.

## 2. Non-goals

- This change does not complete the scientific content of every new page.
- It does not add or alter solver behavior, Python API behavior, ProblemIR, planner capabilities, or runtime support.
- It does not promote planned capabilities to implemented status.
- It does not move internal development plans from `docs/` into public documentation.
- It does not duplicate one shared backend description across CPU/GPU or FEM/FDM pages.

## 3. Information ownership

| Documentation family | Owns | Must not own |
|---|---|---|
| Getting started | installation, first execution, first results, solver selection | exhaustive API inventories or scientific derivations |
| Python API | constructors, parameters, validation, examples, Python-to-ProblemIR mapping | backend implementation equations or runtime qualification claims |
| Physics | governing equations, symbols, units, assumptions, solver/device realizations, validation, sources | unrelated constructor parameters used only to make an example executable |
| Numerical methods | algorithms, discretizations, convergence, tolerances, linear/nonlinear solvers | public authoring syntax except links to API pages |
| Validation | analytical and standard-problem evidence, parity, qualification matrices | new physics semantics |
| Architecture | canonical model, planner, runtime, provenance, control/data-plane boundaries | user-facing parameter reference tables |

## 4. Page lifecycle

Every scaffold page carries front matter with one of these statuses:

- `implemented`: current code and evidence support the documented contract;
- `partial`: at least one named lane exists, while explicit gaps remain;
- `unsupported`: the public model names the concept but the selected lane rejects it;
- `planned`: the page reserves an approved information-architecture location and makes no implementation claim.

Scaffold pages contain only a title, stable MyST label, status, audience, owner, scope sentence, and child
navigation where applicable. They contain no equations, parameter defaults, support promises, or synthetic
source citations. Terminal scientific content is added only when it satisfies the scientific documentation
contract and carries an adjacent source map.

## 5. Public root tree

```text
public_docs/site/
├── index.md
├── getting-started/
├── python-api/
├── physics/
├── numerical-methods/
├── validation/
└── architecture/
```

The root `index.md` exposes those six families in that order. Existing public architecture pages remain
under `architecture/`. Existing broad physics pages are retained temporarily and linked from their new
canonical parent until their content is migrated in a separately verified change.

## 6. Getting-started tree

```text
getting-started/
├── index.md
├── installation.md
├── first-fdm-simulation.md
├── first-fem-simulation.md
└── choosing-a-solver.md
```

All five pages start as `planned` scaffolds.

## 7. Python API tree

Python API is a first-class top-level section. It documents canonical public Python objects independently
from any one physics interaction page.

```text
python-api/
├── index.md
├── problem/
│   ├── index.md
│   ├── problem.md
│   ├── validation.md
│   ├── problem-ir.md
│   └── round-trip.md
├── geometry/
│   ├── index.md
│   ├── primitives.md
│   ├── transforms.md
│   ├── boolean-operations.md
│   ├── imported-geometry.md
│   ├── regions.md
│   ├── universe-and-domain.md
│   └── auxiliary-geometry.md
├── materials/
│   ├── index.md
│   ├── material.md
│   ├── spatial-parameter-fields.md
│   ├── elastic-materials.md
│   └── magnetostriction-laws.md
├── magnets-and-textures/
│   ├── index.md
│   ├── ferromagnet.md
│   ├── initial-magnetization.md
│   ├── uniform-texture.md
│   └── preset-textures.md
├── interactions/
│   ├── index.md
│   ├── exchange.md
│   ├── demagnetization.md
│   ├── zeeman.md
│   ├── uniaxial-anisotropy.md
│   ├── cubic-anisotropy.md
│   ├── interfacial-dmi.md
│   ├── bulk-dmi.md
│   ├── thermal-noise.md
│   ├── magnetoelastic.md
│   ├── oersted-field.md
│   ├── spin-transfer-torque.md
│   ├── spin-orbit-torque.md
│   ├── drift-diffusion-spin-torque.md
│   └── inter-region-couplings.md
├── current-and-excitations/
│   ├── index.md
│   ├── current-transport.md
│   ├── prescribed-current.md
│   ├── regional-field-drive.md
│   ├── rf-drive.md
│   ├── microstrip-antenna.md
│   └── cpw-antenna.md
├── boundary-conditions/
│   ├── index.md
│   ├── periodic-boundary-conditions.md
│   ├── floquet-boundary-conditions.md
│   └── mechanical-boundary-conditions.md
├── discretization/
│   ├── index.md
│   ├── discretization-hints.md
│   ├── fdm.md
│   ├── fem.md
│   ├── hybrid.md
│   ├── mesh-controls.md
│   └── per-object-meshing.md
├── dynamics/
│   ├── index.md
│   ├── llg.md
│   ├── integrators.md
│   ├── adaptive-timestep.md
│   └── field-refresh.md
├── studies/
│   ├── index.md
│   ├── time-evolution.md
│   ├── relaxation.md
│   ├── hysteresis.md
│   ├── eigenmodes.md
│   └── frequency-response.md
├── outputs/
│   ├── index.md
│   ├── fields-and-scalars.md
│   ├── quantities.md
│   ├── modes-and-spectra.md
│   ├── dispersion-and-response.md
│   ├── snapshots.md
│   └── autosave.md
└── runtime/
    ├── index.md
    ├── runtime-selection.md
    ├── backend-policy.md
    ├── simulation.md
    ├── results.md
    ├── artifacts.md
    └── provenance.md
```

## 8. Physics tree

The physics tree follows the mandatory hierarchy `domain → solver → backend → interaction`. Shared
foundations contain only genuinely backend-neutral continuum physics.

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
└── solvers/
    ├── index.md
    ├── fdm/
    │   ├── index.md
    │   ├── cpu/
    │   │   ├── index.md
    │   │   └── interactions/
    │   └── gpu/
    │       ├── index.md
    │       └── interactions/
    └── fem/
        ├── index.md
        ├── cpu/
        │   ├── index.md
        │   └── interactions/
        └── gpu/
            ├── index.md
            └── interactions/
```

Each of the four `interactions/` directories contains exactly this filename set:

```text
index.md
exchange.md
demagnetization.md
zeeman.md
uniaxial-anisotropy.md
cubic-anisotropy.md
interfacial-dmi.md
bulk-dmi.md
thermal-noise.md
magnetoelastic.md
oersted-field.md
spin-transfer-torque.md
spin-orbit-torque.md
drift-diffusion-spin-torque.md
inter-region-couplings.md
```

The equal filename set makes capability differences visible rather than erasing unsupported lanes from
navigation. Status and scope differ per solver/backend page. No page inherits another lane's equations,
precision, memory ownership, boundary treatment, or qualification.

## 9. Numerical-methods tree

```text
numerical-methods/
├── index.md
├── time-integration/
│   ├── index.md
│   ├── explicit-runge-kutta.md
│   ├── adaptive-stepping.md
│   └── tangent-plane-methods.md
├── relaxation/
│   ├── index.md
│   ├── llg-relaxation.md
│   ├── projected-gradient.md
│   └── stopping-criteria.md
├── demag-solvers/
│   ├── index.md
│   ├── fdm-convolution.md
│   ├── fem-poisson-airbox.md
│   ├── fem-bem.md
│   └── periodic-demag.md
├── eigensolvers/
│   ├── index.md
│   ├── linearized-llg.md
│   └── modal-validation.md
├── frequency-domain/
│   ├── index.md
│   ├── response-solver.md
│   └── floquet-response.md
├── meshing/
│   ├── index.md
│   ├── fdm-grids.md
│   ├── fem-shared-domain.md
│   ├── airbox.md
│   ├── swept-meshes.md
│   └── refinement.md
└── interpolation-and-state-transfer/
    ├── index.md
    ├── fem-to-fdm.md
    └── fdm-to-fem.md
```

## 10. Validation tree

```text
validation/
├── index.md
├── analytical-cases.md
├── mumag-standard-problems.md
├── cpu-gpu-parity.md
├── fem-fdm-comparison.md
└── qualification-status.md
```

## 11. Architecture tree

Existing architecture pages remain canonical. Two scaffold pages make missing ownership explicit:

```text
architecture/
├── index.md
├── product.md
├── semantic-model.md
├── runtime.md
├── planner-and-capabilities.md
└── provenance.md
```

## 12. Exchange cleanup and relocation map

The current executable Exchange example remains on `physics/exchange.md` during the first migration so its
Python-to-ProblemIR test remains useful. Its auxiliary constructors link to their Python API references.

| Current Exchange content | Destination | Exchange retains |
|---|---|---|
| Full `Material` constructor inventory | `python-api/materials/material.md` and `spatial-parameter-fields.md` | `A`, `A_field`, `Ms`, `Ms_field`; `Ms` remains because it appears in the implemented field equation |
| `Box` constructor parameters | `python-api/geometry/primitives.md` | only the example call and a link |
| `Ferromagnet` parameters | `python-api/magnets-and-textures/ferromagnet.md` | only the Exchange-relevant material assignment statement and a link |
| `texture.uniform` parameters | `python-api/magnets-and-textures/uniform-texture.md` | only the example call and a link |
| `TimeEvolution` and `LLG` inventories | `python-api/studies/time-evolution.md` and `python-api/dynamics/llg.md` | no general parameter table |
| `SaveField` and `SaveScalar` inventories | `python-api/outputs/fields-and-scalars.md` | Exchange-specific legality of `H_ex` and `E_ex` |
| `DiscretizationHints`, `FDM`, and `FEM` inventories | `python-api/discretization/*.md` | only Exchange-specific T0/T1 controls and lane constraints |
| Full `Problem` inventory | `python-api/problem/problem.md` | `energy=[Exchange()]` mapping and duplicate-term failure semantics |
| General ProblemIR sections from the example | `python-api/problem/problem-ir.md` | minimal canonical Exchange subset and exact Exchange mappings |

No relocated prose is deleted unless it duplicates identical content at its destination. The first migration
preserves wording and units, then adjusts only headings, links, and context required by the new owner page.

## 13. Navigation behavior

- Every directory has an `index.md` with a bounded `toctree`.
- Root navigation exposes families, not hundreds of terminal pages.
- Solver indexes expose CPU and GPU as peers.
- Backend indexes expose the complete interaction list.
- Python API interaction pages link to all four scientific realization pages.
- Scientific realization pages link back to the canonical Python API interaction page.
- Existing `physics/exchange.md` remains reachable during migration and becomes a temporary overview that
  points at the four canonical realization pages.

## 14. Automated safeguards

The implementation adds focused tests that prove:

1. every declared scaffold path exists;
2. every directory index includes every direct child exactly once;
3. all four solver/backend interaction directories have the same canonical filename set;
4. every scaffold page has a stable label and a recognized status;
5. `physics/exchange.md` does not contain the relocated general-section headings or unrelated constructor rows;
6. every constructor used by the Exchange example is documented somewhere in the Python API tree;
7. Exchange-facing parameters remain on the Exchange page;
8. Sphinx builds the complete tree with warnings treated as errors;
9. the existing scientific source-map and rendered-math checks still pass.

The constructor-completeness test searches an explicit ownership map, not every Markdown file indiscriminately.
This prevents a stray mention from satisfying API documentation completeness.

## 15. Delivery sequence

1. Add a repository-owned manifest describing the canonical documentation tree and page statuses.
2. Add failing tests for tree completeness, navigation, status metadata, and Exchange scope.
3. Generate or add the scaffold pages and toctrees from that manifest.
4. Move general constructor inventories from Exchange to their Python API owners.
5. Update Exchange links, ProblemIR excerpt, source map, and focused tests.
6. Run scientific-documentation validators and Python documentation tests.
7. Build Sphinx strictly and validate the rendered Exchange page.
8. Review the complete navigation and ensure no planned page implies implementation support.

## 16. Acceptance criteria

- Python API is a separate top-level public section.
- The complete approved tree exists and is navigable.
- Implemented and planned pages are visibly distinguished.
- All four FDM/FEM CPU/GPU branches contain the same interaction page set.
- Exchange contains no general geometry, study, output, discretization, or full-Problem parameter inventory.
- Existing useful prose is relocated rather than discarded.
- Exchange's equations, symbols, units, source anchors, source map, and executable lowering test remain valid.
- Strict Sphinx build and all focused documentation validators pass.
- No internal development document is published through the public tree.
