---
name: scientific-documentation-contract
description: Use when creating, changing, reviewing, restructuring, or publishing FullMag documentation about physics, numerical methods, FEM/FDM solvers, CPU/GPU realizations, interactions, operators, validation, or scientific implementation claims.
---

# Scientific Documentation Contract

## Core rule

Make scientific documentation mirror implementation ownership and prove every equation-to-code claim. A page is blocked, not “draft complete,” when hierarchy, equations, source anchors, backend differences, validation, bibliography, or source index are missing.

For physics or numerics changes, **REQUIRED SUB-SKILL:** use `physics-publication` before this skill.

## Required workflow

1. Read [references/page-contract.md](references/page-contract.md) completely.
2. Inspect current source, tests, validation artifacts, and full commit SHA. Never document from memory.
3. Build the hierarchy: domain → FEM/FDM → CPU/GPU → interaction or numerical subsystem.
4. Write the backend-neutral physical contract only where it is truly shared. Create separate realization chapters for every FEM/FDM or CPU/GPU difference.
5. Give every governing, weak-form, discrete, operator, torque, field, energy, and update equation a stable identifier and complete LaTeX form.
6. Map every nontrivial equation term to a source anchor: repository path + fully qualified symbol or `DOC-ANCHOR` + responsibility + solver/lane + full SHA + tests.
7. Resolve current lines dynamically from the symbol or anchor. Treat `path + symbol` as stable identity; use the SHA for historical reproducibility.
8. End every terminal page with a scientific bibliography and source-code index.
9. Create or update a source-map manifest following [assets/source-map.example.yaml](assets/source-map.example.yaml).
10. Run:

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  <manifest> --repo-root .
```

11. Publish only after the validator, scientific review, and relevant runtime validation pass.

## Non-negotiable gates

- Do not simplify or omit implemented terms. If production uses an approximation, document its exact equation, derivation, validity/error regime, and code realization.
- Do not combine FEM with FDM or CPU with GPU when algorithms, discretization, precision, memory ownership, libraries, boundary treatment, convergence, scope, or validation differ.
- Do not cite only a file or handwritten line range. Cite a symbol or explicit `DOC-ANCHOR`; generated lines supplement it.
- Do not infer parity from shared APIs, names, source presence, compilation, or host-only tests.
- Do not use placeholders (`TODO`, `TBD`, “to be documented”) in publication-ready pages.
- Do not route internal `docs/` plans, audits, diagnostics, or agent instructions into `public_docs/site/`.

## Required evidence

For GPU claims, require executed-device/runtime identity. For FEM/MFEM/CUDA/hypre/libCEED claims, use the repository-managed `just` verification route required by `AGENTS.md`. Label source-only, synthetic, host-only, and planned evidence honestly.

## Stop conditions

Stop and report the page as incomplete if any equation cannot be mapped, any source symbol cannot be found, a backend difference lacks its own chapter, or validation evidence does not support the claim. Never fill scientific gaps by inference.
