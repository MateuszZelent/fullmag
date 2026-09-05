---
name: full-output-enforcement
description: "Use when the user explicitly requests an exhaustive set of files, comments, components, or a complete cross-layer implementation."
---

# Full Output Enforcement

A requested exhaustive deliverable must be complete in the workspace. Do not replace requested code or documentation with a skeleton, placeholder, or description. Work in the files and keep the final response concise unless the user explicitly asks to see the full content.

The user instruction and root `AGENTS.md` take precedence. Reuse already loaded skills and do not reload the same skill merely because the output is long.

## Scope discipline

1. Count the requested deliverables and keep a checklist.
2. Map every affected Fullmag layer before editing: docs, Python DSL, `ProblemIR`, planner/capabilities, runtime/provenance, OpenAPI/generated types, API/resource hooks, unified viewport/ribbon UI, and tests where applicable.
3. Implement every requested deliverable fully, including generated artifacts when the repository owns them.
4. Remove placeholders introduced by the change.
5. Before finalizing, compare the completed files with the original deliverable list.

Cross-layer completeness is conditional on the semantics changed. A local bug fix does not require unrelated API/UI migration.

## FEM build boundary

For native FEM/MFEM/CUDA/hypre/libCEED work, inspect the `justfile` and use the matching managed/container recipe first. Host `cargo`, `cmake`, Docker, or direct binaries are diagnostics only unless a host-only check is explicitly requested. Do not report a host build as final FEM proof when a managed recipe exists. If no matching recipe exists, state that before using a host diagnostic.

## Output and continuation

Do not print full files merely because the workspace change is exhaustive. Summarize paths, behavior, and validation. Use compaction or a file checkpoint when context is constrained. State a pause only when an actual output limit prevents completing the authorized deliverable; otherwise continue to the next file.
