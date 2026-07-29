# Terminal scientific page contract

Read this file completely for every FullMag physics, solver, interaction, operator, or numerical-method documentation task.

## Hierarchy

Use this tree. Omit a lane only when source inspection proves it is unsupported; state that unsupported status explicitly.

```text
Implementation domain
├── FEM
│   ├── CPU
│   │   └── interaction or subsystem
│   └── GPU
│       └── interaction or subsystem
└── FDM
    ├── CPU
    │   └── interaction or subsystem
    └── GPU
        └── interaction or subsystem
```

Examples of terminal topics: exchange, demagnetization, bulk/interfacial DMI, anisotropy, Zeeman, thermal field, STT/SOT, relaxation, time integrator, eigensolver, mesh operator, boundary realization.

## Mandatory terminal-page sections

Use these stable section IDs in the source-map manifest:

1. `problem-statement`
2. `governing-equations`
3. `symbols-and-si-units`
4. `assumptions-and-validity`
5. `discrete-realization`
6. `implementation-mapping`
7. `validation`
8. `limitations`
9. `scientific-bibliography`
10. `source-code-index`

Also document boundary/initial conditions, energy, effective field, torque, weak form, solver tolerances, convergence, precision, observables, artifacts, and provenance whenever applicable.

## LaTeX-to-code contract

Assign every equation an ID such as `eq-demag-poisson`. Write the full production equation in LaTeX, including signs, factors, tensors, boundary terms, normalization, and units. Split it into nontrivial terms. Every term lists one or more source IDs.

Do not substitute a pedagogical equation for the implemented equation. An implemented approximation requires its complete mathematical form, derivation or primary citation, error/validity regime, and mapping to code.

## Source anchor contract

Every source entry contains:

| Field | Requirement |
|---|---|
| `path` | Repository-relative source file |
| `symbol` or `anchor` | Fully qualified function/method/type/kernel/constant, or unique `DOC-ANCHOR` |
| `responsibility` | Exact equation term or algorithmic responsibility |
| `solver` | `FEM` or `FDM` |
| `lane` | `CPU` or `GPU` |
| `revision` | Full 40-character Git SHA used by the publication |
| `tests` | Tests or managed validation artifacts supporting the claim |

Use `path + symbol` as current identity and `revision` as historical identity. Generate the current line or range; never maintain line numbers as the only anchor. If no stable symbol exists, add `DOC-ANCHOR: <unique-id>` in source before publication.

Place source citations next to implementation claims. End the page with a source-code index mapping equation IDs and responsibilities to source IDs, resolved lines, revision, and tests.

## Backend split rule

Create separate chapters when FEM/FDM or CPU/GPU differ in any of:

- mathematical/discrete operator;
- boundary or interface treatment;
- precision or accumulation;
- matrix assembly, stencil, FFT, quadrature, or linear solver;
- host/device memory ownership or transfers;
- external libraries;
- tolerances, convergence, or failure semantics;
- supported geometry, materials, interactions, or observables;
- validation or qualification status.

A shared physical chapter may define common continuum physics. It must link to realization chapters and must not assert parity.

## Scientific evidence

Use primary literature for physical and numerical formulations. State author, title, venue, year, DOI or stable URL. Cite validation cases, reference oracles, tolerances, residual definitions, hardware/runtime identity, precision, and artifact paths.

Distinguish: target, implemented, transitional, reference-only, planned, source-verified, compiled, runtime-executed, and validated. These statuses are not interchangeable.

## Completion gate

Publication-ready means all mandatory sections exist, every equation term maps to resolvable source, backend differences have separate chapters, bibliography and source index are complete, relevant validation executed, and public/internal routing is correct. Otherwise report the exact blocker and stop.
