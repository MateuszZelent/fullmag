---
name: frontend-v2-module-architecture
description: "Use when modifying apps/control-room modules, module manifests, module registry, layout slots, command/menu/ribbon contributions, or cross-module interactions."
---

# Frontend v2 Module Architecture

Use this skill for module-kernel boundaries in `apps/control-room`. The user instruction and root `AGENTS.md` take precedence. Reuse any already loaded frontend/API skill.

## Required checks

1. Read `docs/specs/frontend-v2/01-module-kernel-architecture.md` and `02-module-catalog.md`.
2. Identify the affected module id, manifest, slot, and root component.
3. Verify the module has `manifest.ts` and a root component accepting `ModuleProps`.
4. Reject imports from one module's internal path into another module's internal path. Relative imports inside the same module are valid.
5. Use kernel events, command registry, resource hooks, or `src/shared` instead of cross-module imports or shell callback plumbing.
6. Keep module stores private and manifest contributions declarative and side-effect free.
7. Use shared shadcn/ui-style primitives for menus, ribbons, tabs, dialogs, context menus, switches, segmented controls, tooltips, and command palettes.
8. Consume `--fm-*` Catppuccin tokens; do not add raw component colors or a second widget system.

## Banned patterns

- importing another module's store, component, hook, renderer, or internal type;
- callback props through the shell to connect modules;
- commented-out registrations as feature toggles;
- module-local command systems bypassing the kernel registry;
- imports from the legacy tree;
- bespoke menu/ribbon/tab/dropdown/dialog/tooltip primitives when a shared primitive exists.

## Verification

Prefer the repository architecture gate and then the narrow checks:

```powershell
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room typecheck
```

Use a boundary-aware search or the architecture script to find imports crossing `apps/control-room/src/modules/<module-id>` boundaries. Do not use a blanket `from ../` grep because it rejects valid local imports. If the v2 module is not present, record the intended gate for the implementation.
