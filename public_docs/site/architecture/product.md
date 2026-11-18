---
title: Product architecture
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/fullmag-application-architecture-v2.md
---

(public-docs-architecture-product)=
# Product architecture

The public FullMag product has four surfaces:

1. Python authoring,
2. the local FullMag launcher,
3. the browser control room,
4. FDM and FEM compute backends.

The user authors one physical problem and receives one provenance-preserving result model. The
selected backend is an execution decision, not a second public physical language.

## Product flow

Python authoring or browser authoring → canonical physical model → validation and execution
planning → session, run and stage → selected FDM or FEM realization → fields, observables,
artifacts and provenance → control-room and export surfaces.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder` | stage-first public authoring |
| `crates/fullmag-cli/src/main.rs` | `main` | local launcher entry point |
| `apps/control-room/src/kernel/api/ControlRoomApi.ts` | `ControlRoomApi` | typed browser API facade |
| `crates/fullmag-plan/src/lib.rs` | `plan` | dispatch planning for the physical problem |
