# Frontend v2 - Agent Governance

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Agent Entry Checklist

Before touching frontend v2, an agent must state:

- affected module or kernel service;
- affected resource family or command;
- whether OpenAPI changes are needed;
- whether Python/IR/physics semantics are affected;
- which frontend-v2 skill applies;
- verification command or reason no command exists yet.

## 2. Required Reading

For any frontend v2 task:

1. `docs/specs/frontend-v2/README.md`;
2. the relevant detailed spec;
3. the relevant `.agents/skills/frontend-v2-*` skill;
4. `docs/specs/resource-first-control-room-api-v2.md` if API/resource behavior is touched;
5. `docs/adr/0013-frontend-v2-module-kernel.md` for architecture decisions.

## 3. Change Boundaries

Agents must not:

- modify `apps/legacy_web` while implementing `apps/control-room` unless explicitly asked;
- copy legacy files without naming what debt was removed;
- add compatibility shims without a removal condition;
- leave dead registrations, unused modules, or unreferenced commands;
- claim performance improvement without measurement;
- claim parity without listing the checked workflows.

## 4. Documentation Rule

Any architectural exception must update the relevant spec. Examples:

- a module imports another module;
- a file exceeds hard line thresholds;
- a command bypasses standard command registry;
- a resource hook cannot be revision-driven;
- a viewport needs continuous animation;
- a feature flag must live past cutover.

If the exception is long-lived, add or update an ADR.

## 5. Verification Language

Final summaries must distinguish:

- implemented;
- documented only;
- verified by command;
- not run, with reason;
- legacy path still present with removal criterion.

Agents must not report "done" for docs/code that were not read back or checked.

## 6. Dead Code Rule

When a v2 module replaces legacy behavior:

- remove v2 dead prototypes created during the task;
- mark replaced legacy files in migration docs;
- do not leave alternative unused module implementations;
- do not keep commented-out registrations;
- update feature flag lifecycle if a flag became unnecessary.
