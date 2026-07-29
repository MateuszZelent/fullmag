# Scientific documentation contract skill design

Date: 2026-07-29  
Status: approved design, awaiting written-spec review  
Scope: FullMag scientific, physics, solver, interaction, and numerical-method documentation

## Objective

Create a repository skill that is mandatory whenever an agent creates, updates, reviews, restructures, or publishes documentation about FullMag physics, numerical methods, solvers, backends, or interactions.

The skill must make documentation structurally mirror the implementation and must prevent publication-quality claims that cannot be traced to equations, source symbols, backend realizations, validation evidence, and scientific references.

## Relationship to existing documentation

The new skill complements `physics-publication`:

- `physics-publication` remains the physics-first feature-development workflow;
- the new skill governs the structure, completeness, traceability, and publication quality of scientific documentation;
- both skills are required when a task changes physics or numerics and its documentation;
- internal canonical notes remain under `docs/physics/`;
- curated public pages remain under `public_docs/site/`;
- internal plans, audits, diagnostics, and agent instructions must not enter the public build.

## Mandatory documentation hierarchy

Scientific implementation documentation must follow this hierarchy:

1. implementation domain;
2. solver family: FEM or FDM;
3. execution lane: CPU or GPU;
4. interaction or numerical subsystem: exchange, demagnetization, DMI, anisotropy, Zeeman, thermal field, spin torque, integrator, eigensolver, or another concrete subsystem;
5. physical model, discrete realization, implementation mapping, validation, limitations, and references.

FEM and FDM must have separate chapters. CPU and GPU must have separate chapters whenever they differ in algorithm, precision, memory ownership, library, operator realization, boundary treatment, convergence behavior, supported scope, or validation status.

A shared chapter is allowed only for a proven backend-neutral physical contract. It must link to separate realization chapters and must not imply implementation parity.

## Publication-grade scientific content

Every interaction and numerical topic must be written as a scientific publication, not a product summary. Each terminal topic page must include:

1. problem statement and physical scope;
2. complete governing equations in LaTeX;
3. derivation or cited derivation sufficient to establish signs, factors, and boundary terms;
4. symbol table with SI units and conventions;
5. assumptions and validity limits;
6. energy, effective field, torque, weak form, discrete operator, or update equation as applicable;
7. FEM and FDM interpretations;
8. CPU and GPU realizations where supported;
9. precision, boundary conditions, discretization, solver tolerances, convergence, and failure semantics;
10. observables and artifact/provenance semantics;
11. validation methods, reference oracles, tolerances, and executed-runtime evidence;
12. known unsupported scopes stated explicitly;
13. scientific bibliography;
14. source-code traceability table.

No simplification, approximation, omitted term, or pedagogical reduction may be presented as the implemented production equation. If the implementation itself uses an approximation, the exact approximation, derivation, error regime, and code realization must be documented.

## Equation-to-code contract

Every equation used by the project must map to the implementation that realizes it. Assign stable equation identifiers and map every nontrivial term to one or more source anchors.

Each source anchor must contain:

- repository-relative file path;
- fully qualified symbol: function, method, type, kernel, trait implementation, or constant;
- implementation responsibility;
- solver family and execution lane;
- revision identity: full Git commit SHA for the published version;
- generated current line range and GitHub link;
- validation or test anchor when available.

The stable identity is `path + symbol`, not a handwritten line range. Build tooling may resolve the current line range dynamically. Historical publication evidence remains reproducible through the full commit SHA.

If code has no stable symbol, add an explicit unique marker such as:

```text
DOC-ANCHOR: physics.demag.fdm.gpu.field
```

before documenting the implementation. A file-only citation is insufficient. A line-only citation is insufficient.

## Source references in prose

Implementation claims in prose must cite the relevant source anchor near the claim, for example:

```text
The CUDA kernel evaluates the discrete demagnetizing field
([backends/fdm/cuda/demag.cu], symbol `fullmag_demag_field_cuda`,
generated lines 500-600, revision `<full-sha>`).
```

Every terminal page must end with a source-code index that maps equations and responsibilities to paths, symbols, generated line ranges, revisions, and tests.

## Dynamic resolution and validation

Bundle a deterministic validator with the skill. It must support a manifest describing documentation pages and source anchors.

The validator must fail when:

- a required hierarchy level is missing;
- a source file does not exist;
- a declared symbol or `DOC-ANCHOR` cannot be found;
- an equation lacks a source mapping;
- a terminal page lacks bibliography or source-code index;
- a documented GPU/CPU or FEM/FDM difference lacks separate coverage;
- placeholders such as TODO, TBD, “to be documented,” or unsupported parity claims remain;
- internal documentation is routed into the public source tree.

The validator may generate current line ranges and GitHub links from symbols or explicit markers. It must not rewrite scientific content automatically.

## AGENTS.md integration

Add a non-negotiable rule to `AGENTS.md`:

- the new skill is mandatory for every scientific documentation task;
- documentation work is blocked until the skill is read and its contract is applied;
- physics or numerics changes require both `physics-publication` and the new skill;
- no page may be called complete or publication-ready while its hierarchy, equation mapping, backend split, scientific references, source index, or validation gate is incomplete;
- the public/internal documentation boundary remains mandatory.

The rule must be discoverable near the existing physics-before-implementation and canonical documentation rules, not only in the accumulated project-learnings list.

## Skill package

Create:

- `.agents/skills/scientific-documentation-contract/SKILL.md`;
- `.agents/skills/scientific-documentation-contract/agents/openai.yaml`;
- `.agents/skills/scientific-documentation-contract/references/page-contract.md`;
- `.agents/skills/scientific-documentation-contract/assets/source-map.example.yaml`;
- `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`;
- focused validator tests or fixtures under the skill directory.

The SKILL.md remains concise and points to the detailed page contract only when scientific documentation work is in scope.

## Skill verification

Use RED-GREEN-REFACTOR:

1. retain baseline scenarios showing agents avoid line references, compress backend hierarchy, and accept phased/incomplete pages;
2. initialize the skill with the repository skill-creation tooling;
3. implement the minimum binding contract and validator;
4. validate skill metadata and structure;
5. test the validator against passing and failing manifests;
6. rerun the pressure scenarios with the skill and verify compliance;
7. close any newly discovered loopholes;
8. review the `AGENTS.md` rule and complete diff;
9. commit, open a PR, run relevant repository checks, and merge only after approval.

## Non-goals

- automatically deriving physics equations from code;
- publishing internal plans or audits;
- claiming CPU/GPU or FEM/FDM parity from shared API names;
- replacing scientific judgment with a formatter;
- requiring identical implementation structure where mathematically justified backend differences exist.
