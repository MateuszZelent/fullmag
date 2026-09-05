---
name: frontend-v2-state-hygiene
description: "Use when modifying apps/control-room Zustand stores, React context, selection, layout, session state, inspector drafts, persistence, or derived state."
---

# Frontend v2 State Hygiene

Use this skill for state ownership changes in `apps/control-room`. The user instruction and root `AGENTS.md` take precedence. Reuse already loaded frontend/API skills.

## Required checks

1. Read `docs/specs/frontend-v2/04-state-management.md`.
2. Classify every changed field as server resource, kernel UI state, module UI state, draft state, or imperative external resource.
3. Keep server resources in resource hooks/cache, not module stores.
4. Keep mutable application state out of React context; dependency injection or an imperative external resource may use context when ownership is explicit.
5. Keep module stores private and use explicit draft transactions for Inspector edits.
6. Persist only layout and user preferences, never canonical simulation/runtime resources.
7. Keep derived data derived; avoid `useEffect + setState` when a selector or pure computation is sufficient.

## Banned patterns

- React context owning session/model/viewport/command state;
- module stores importing each other;
- stores holding full mesh topology, field arrays, or session snapshots;
- store actions calling `fetch`;
- mutable singleton feature flags or diagnostics;
- avoidable effect-driven copies of derived data.

## Verification

Use the repository architecture gate when applicable, then the focused store/resource tests:

~~~powershell
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room test -- --run <focused-store-or-resource-test>
~~~

Do not use a blanket `rg "let .*="` check: ordinary local variables do not establish application state. For a legitimate exception, document the owner and lifetime in the change summary.
