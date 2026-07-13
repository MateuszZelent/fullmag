# MESH-REGION-014 — Region Mesh Inspector lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Region Mesh Inspector rozróżnia authored policy od realized state i prowadzi użytkownika przez `Apply & Build` do terminalnej mesh generation.

**Architecture:** Panel używa wspólnego draft/build lifecycle object mesh. Badges Explorer/Inspector pochodzą z mesh generation, marker certificate i stale reasons; command czeka na terminal resource, nie na samo accepted.

**Tech Stack:** React/TypeScript, command registry, resource hooks, shadcn primitives

## Global Constraints

- Osobny semantic Explorer node zachowuje osobny Inspector.
- Status `ready` wymaga current mesh i fresh marker certificate.
- FDM local region mesh policy pokazuje capability-blocked, nie przycisk build.

---

**Finding:** MESH-REGION-014, P1.
**Dependencies:** MESH-REGION-001/005/006/012/013, MESH-UI-003.

### Task 1: RED panel/status tests

- [ ] Dodać model/render tests dla inherited, draft changed, rebuild required, build pending, current realized, stale marker, unsupported FDM i failed build.
- [ ] Zmienić browser smoke, który obecnie oczekuje `mesh=preserved`, aby po conformal/policy edit oczekiwał stale i zablokowanego runu.

### Task 2: Apply & Build i realized badge

- [ ] Podłączyć `ObjectRegionMeshPanel` do shared draft registration i command registry; `Apply` zapisuje draft, `Apply & Build` uruchamia canonical mesh command.
- [ ] Renderować requested/resolved policy, generation ID, marker status i actionable stale reason z named resources.
- [ ] Explorer badge liczyć z realized resource; declaration-only ma status `configured`, nie `ready`.

### Task 3: UI/browser proof

- [ ] Uruchomić focused Inspector/Explorer tests, typecheck, zero-warning lint, pełny Vitest i real browser/WebGL smoke z visible current/stale transition.
- [ ] Commit: `git add apps/control-room docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md && git commit -m "fix(ui): complete region mesh build lifecycle"`.

**Exit:** użytkownik nie może pomylić zapisanej polityki regionu z jej realizacją w bieżącej siatce.
