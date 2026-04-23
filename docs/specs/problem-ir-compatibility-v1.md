# Problem IR Compatibility v1

- Status: canonical compatibility policy for `ProblemIR`
- Last updated: 2026-04-23
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Program ADR: `docs/adr/0012-canonicalization-backbone.md`

## 1. Purpose

This spec defines versioning, read compatibility, and migration policy for `ProblemIR`.

## 2. Version Signals

- canonical current version: `CURRENT_IR_VERSION`
- wire field: `ProblemIR.ir_version`
- read support list: `SUPPORTED_READ_IR_VERSIONS`

## 3. Compatibility Matrix

| Producer | Version | Consumer | Supported | Notes |
|---|---|---|---|---|
| Python exporter | current | planner/runtime | yes | canonical write path |
| UI exporter | current | planner/runtime | yes | canonical write path |
| saved payload | previous supported | planner/runtime | read-only via migration | transitional read support |
| saved payload | unsupported | planner/runtime | no | validation error |

## 4. Rules

- New public semantics that alter meaning require a version bump.
- Removing a public field requires at least one supported read-compat path.
- Writer paths emit only the current canonical version.
- Python and UI must not emit divergent semantic structures for the same intent.

## 5. Canonical Serialization Rules

- deterministic field ordering in fixtures,
- no UI-only transport artifacts in canonical payloads,
- no semantic dependence on omitted-vs-null ambiguity.

## 6. Golden Corpus Policy

Golden fixtures must cover at least:

- FDM minimal and FEM minimal,
- mixed object/primitives scenarios,
- per-object mesh configuration semantics,
- multi-stage execution intent,
- migration read cases for supported previous versions.
