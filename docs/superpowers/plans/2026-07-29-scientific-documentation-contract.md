# Scientific Documentation Contract Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Create and enforce a FullMag skill that makes scientific documentation mirror FEM/FDM and CPU/GPU implementation structure and trace every publication-grade equation to source symbols.

**Architecture:** Keep the workflow in a concise SKILL.md, move the terminal-page schema to one reference, provide a machine-readable sidecar source-map template, and enforce objective requirements with dependency-free Python validators. A changed-file gate requires every changed terminal scientific page to carry an adjacent manifest, and the documentation workflow runs both validator tests and the gate. Make the skill mandatory through the canonical AGENTS.md physics/documentation rules.

**Tech Stack:** Markdown skills, JSON-compatible YAML manifests, Python 3 standard library, unittest, GitHub Actions, repository AGENTS.md.

## Global Constraints

- Internal canonical notes remain under `docs/physics/`; curated public pages remain under `public_docs/site/`.
- Scientific hierarchy is domain → FEM/FDM → CPU/GPU → interaction/subsystem → physical model, realization, validation, limitations, references.
- Every equation term maps to repository-relative path + stable symbol or DOC-ANCHOR + implementation responsibility + backend/lane + numerical evidence at one resolved revision.
- Current line ranges are generated metadata; stable identity is path + symbol.
- CPU/GPU and FEM/FDM differences require separate chapters.
- No simplification may be represented as the production equation.
- Every terminal page ends with scientific bibliography and source-code index.
- AGENTS.md usage is mandatory and blocking.
- Do not publish internal plans, audits, diagnostics, or agent instructions.

---

### Task 1: Initialize and author the skill package

**Files:**
- Create: `.agents/skills/scientific-documentation-contract/SKILL.md`
- Create: `.agents/skills/scientific-documentation-contract/agents/openai.yaml`
- Create: `.agents/skills/scientific-documentation-contract/references/page-contract.md`
- Create: `.agents/skills/scientific-documentation-contract/assets/source-map.example.yaml`

**Interfaces:**
- Consumes: approved design and existing `physics-publication` contract.
- Produces: discoverable skill metadata, binding workflow, terminal-page schema, and example source-map manifest.

- [x] Run `init_skill.py scientific-documentation-contract --path .agents/skills --resources scripts,references,assets` with generated interface fields.
- [x] Replace scaffold placeholders with the binding workflow and exact trigger description.
- [x] Define the complete page contract and hierarchical template in `references/page-contract.md`.
- [x] Add a valid example source map with equations, FEM/FDM, CPU/GPU, file, symbol, SHA, bibliography, and tests.
- [x] Run `quick_validate.py .agents/skills/scientific-documentation-contract`; expect success.

### Task 2: Implement source-map validation with RED-GREEN tests

**Files:**
- Create: `.agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py`
- Create: `.agents/skills/scientific-documentation-contract/scripts/test_validate_scientific_docs.py`
- Create: `.agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py`
- Create: `.agents/skills/scientific-documentation-contract/scripts/test_validate_changed_scientific_docs.py`
- Modify: `.github/workflows/documentation.yml`

**Interfaces:**
- Consumes: JSON-compatible YAML manifest schema documented by the example asset.
- Produces: CLI `validate_scientific_docs.py MANIFEST --repo-root ROOT` plus `validate_changed_scientific_docs.py --base SHA --head HEAD --repo-root ROOT`, with deterministic nonzero diagnostics on violations.

- [x] Write unittest cases for a valid manifest and failures covering hierarchy, missing file, missing symbol/anchor, missing equation mapping, backend split, bibliography, source index, placeholders, SHA format, and public/internal boundary.
- [x] Run the tests before implementation; expect import or assertion failures.
- [x] Implement the dependency-free validator with Python standard-library JSON parsing; JSON is valid YAML and keeps CI deterministic.
- [x] Run `python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py' -v`; expect all tests to pass.
- [x] Keep `assets/source-map.example.yaml` as an explicitly incomplete template whose TODO evidence is rejected until replaced.

### Task 3: Make the skill mandatory and forward-test behavior

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: validated skill package.
- Produces: canonical mandatory invocation rule and evidence that fresh agents apply the contract under pressure.

- [x] Add a non-negotiable scientific-documentation rule near the canonical source hierarchy and physics-before-implementation rule.
- [x] Require both `physics-publication` and `scientific-documentation-contract` for physics/numerics changes.
- [x] State the completion blockers: missing hierarchy, equation mapping, backend split, bibliography, source index, validation, or public/internal boundary.
- [x] Run three fresh pressure scenarios with the skill and confirm they retain symbol anchors, backend hierarchy, complete publication content, and refusal to publish incomplete pages.
- [x] Run skill validation, unit tests, example-manifest validation, and a scoped diff review.
- [ ] Open a PR and merge only after review and passing checks.
