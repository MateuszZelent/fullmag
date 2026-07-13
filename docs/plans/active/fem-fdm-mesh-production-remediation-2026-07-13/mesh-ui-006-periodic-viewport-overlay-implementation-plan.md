# MESH-UI-006 — Periodic topology viewport overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pokazać w unified 3D viewport certyfikowane source/destination faces, node links, translation arrows i unpaired topology.

**Architecture:** Resource adapter zamienia scoped v6 data na bounded render model. Osobna demand-rendered layer używa current topology/certificate fingerprint i nie renderuje stale data jako current.

**Tech Stack:** React Three Fiber, Three.js, resource hooks, Playwright/WebGL smoke

## Global Constraints

- `frameloop="demand"`; brak idle redraw.
- Layer rozdziela magnetic, airbox i invalid/mixed; kolory z `--fm-*` tokens.
- Large pairs są scoped/decimated; pełne arrays nie trafiają do React state.

---

**Finding:** MESH-UI-006, P1.
**Dependencies:** MESH-API-002..004 i MESH-UI-002.

### Task 1: render model RED

- [ ] Dodać pure model tests dla valid, unpaired, mixed-domain i stale fingerprint; każdy output ma bounded counts i semantic styles.
- [ ] Dodać render test sprawdzający source/destination/arrow/link layers i stale suppression.

### Task 2: viewport layer

```ts
export type PeriodicOverlayModel = { facePairs: FacePairGlyph[]; nodeLinks: LinkGlyph[]; arrows: ArrowGlyph[]; unpaired: FaceGlyph[]; fingerprint: string };
```

- [ ] Utworzyć adapter w `apps/control-room/src/shared/domain/mesh/` i layer pod `modules/viewport-3d/layers/`; wpiąć przez `useViewport3DSceneModel.ts` oraz module.
- [ ] Renderować tylko current matching topology; invalid/stale ma widoczny Inspector reason i brak mylącego current overlay.
- [ ] Uruchomić focused tests, typecheck i lint; PASS.

### Task 3: browser proof

- [ ] Uruchomić `pnpm --dir apps/control-room smoke:viewport-3d` i `just run-viewport-3d-mixed-target-smoke`; canvas visible, context current, drawing buffer > 0.
- [ ] Zapisać screenshot valid i unpaired fixture; commit: `git add apps/control-room/src/shared/domain/mesh apps/control-room/src/modules/viewport-3d && git commit -m "feat(viewport): visualize periodic mesh certification"`.

**Exit:** użytkownik może zlokalizować pary i błędy seam w 3D; layer nie pokazuje stale certificate i nie redrawuje w idle.

