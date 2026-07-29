---
name: frontend-v2-state-hygiene
description: Use when modifying frontend v2 Zustand stores, React context, selection, layout, session state, inspector drafts, persistence, or derived state.
---

# Frontend v2 State Hygiene

Use this to keep state ownership explicit.

## Required Checks

1. Read `docs/specs/frontend-v2/04-state-management.md`.
2. Classify every changed state field as server resource, kernel UI state, module UI state, draft state, or imperative external resource.
3. Keep server resources in resource hooks/cache, not module stores.
4. Keep mutable application state out of React context.
5. Keep module stores private.
6. Use explicit draft transactions for inspector edits.
7. Persist only layout and user preferences, never canonical simulation/runtime resources.

## Banned Patterns

- React context owning session/model/viewport/command state;
- module stores importing each other;
- stores holding full mesh topology, field arrays, or session snapshots;
- store actions calling `fetch`;
- mutable singleton feature flags or diagnostics;
- `useEffect + setState` for avoidable derived data.

## Verification

```bash
rg "createContext" apps/control-room/src
rg "fetch\\(" apps/control-room/src
rg "let .*=" apps/control-room/src/kernel apps/control-room/src/modules
pnpm --dir apps/control-room test -- --run stores
```

When a grep result is legitimate, document the ownership reason in the change summary.
