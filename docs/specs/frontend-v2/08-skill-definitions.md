# Frontend v2 - Skill Definitions

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Purpose

Frontend v2 needs agent-enforced architecture rules because the failure mode is predictable: a small urgent fix imports a legacy helper, bypasses the kernel, adds direct transport, or reintroduces a god context. The skills below are the guardrails.

Actual skill files live under `.agents/skills/`.

## 2. Required Skills

| Skill | Trigger | Blocks |
|---|---|---|
| `frontend-v2-module-architecture` | Any change under `apps/control-room/src/modules` or module registry/layout. | Cross-module imports, missing manifests, event contract drift, oversized module roots. |
| `frontend-v2-api-hygiene` | API facade, resource hooks, commands, realtime, binary codecs, generated v2 types. | Direct fetch, hand-built URLs, v1/live usage, status bloat, WebSocket-as-state. |
| `frontend-v2-state-hygiene` | Zustand stores, React context, selection/layout/session state, inspector drafts. | Mutable React context state, store-owned server data, module-store leakage, singleton flags. |
| `frontend-v2-viewport-lifecycle` | 3D/2D viewport, Three.js, WebGL, ECharts, render loops, workers. | Always-on rendering, unmanaged GPU resources, topology/field coupling, component-level FDM/FEM forks. |
| `frontend-v2-performance-gates` | Performance, memory, profiler, diagnostics, CI budgets, idle behavior. | Unmeasured "optimizations", missing idle/memory checks, hidden timers, render storms. |
| `frontend-v2-cutover-governance` | Migration, legacy deletion, AGENTS/docs updates, rollout/cutover decisions. | Permanent dual frontend, copied debt, dead legacy code, missing removal criteria. |

## 3. Skill Locations

```text
.agents/skills/frontend-v2-module-architecture/SKILL.md
.agents/skills/frontend-v2-api-hygiene/SKILL.md
.agents/skills/frontend-v2-state-hygiene/SKILL.md
.agents/skills/frontend-v2-viewport-lifecycle/SKILL.md
.agents/skills/frontend-v2-performance-gates/SKILL.md
.agents/skills/frontend-v2-cutover-governance/SKILL.md
```

## 4. Agent Workflow

Any agent touching frontend v2 must:

1. read `docs/specs/frontend-v2/README.md`;
2. load the relevant frontend-v2 skill;
3. identify which module, kernel service, resource family, command, and test gate are affected;
4. state whether the work touches canonical semantics, API contracts, or only UI composition;
5. avoid modifying `apps/web` unless the task is explicitly about the legacy reference;
6. run the narrow verification gate before claiming completion.

## 5. CI Translation

The skills should eventually become CI checks:

- module boundary import check;
- direct-fetch check;
- endpoint string check;
- manifest schema check;
- generated API freshness check;
- file-size check;
- viewport resource cleanup stress test;
- idle render budget audit;
- legacy import and legacy route check.
