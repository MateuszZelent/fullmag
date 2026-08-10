# Inspector Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ujednolicić wygląd, hierarchy, responsywność i accessibility wszystkich Inspectorów wokół istniejącego `InspectorShell` oraz reference Visualization Inspector.

**Architecture:** `InspectorShell` zarządza stałym chrome i action lifecycle, `InspectorOverviewFrame` zarządza overview geometry, a `InspectorGroup`, `InspectorPropertyRow`, `FieldRow`, `FormField` i `FeedbackBanner` są jedynymi prymitywami treści. Panele zachowują semantykę resource/draft, ale nie tworzą lokalnych systemów kart, inputów ani statusów.

**Tech Stack:** React 19, Tailwind CSS 4, Catppuccin `--fm-*` tokens, shadcn/Radix, CVA, Lucide, Vitest, Storybook, Playwright/browser smoke.

## Global Constraints

- Nie wprowadzać konkurencyjnego UI/CSS frameworka.
- `app/globals.css` pozostaje import-only; nowe real CSS trafia do `src/design/styles/*`.
- Każda klasa CSS ma prefix `fm-`; raw colors pozostają w centralnych token/theme files.
- Zachować istniejące `InspectorEditSession`, selection dirty guard i transaction semantics.
- Physics, mesh, material, geometry i study edits wymagają explicit apply; safe display preferences mogą auto-apply.
- Wartości pokazują symbol/jednostkę, source, revision/freshness i validation state tam, gdzie resource to publikuje.
- Nie usuwać istniejących paneli ani zmieniać API tylko po to, aby zmienić kosmetykę.
- Zachować niepowiązane `external_solvers/3` i path-specific commits.
- Każdy migration task ma focused DOM/model test przed globalnym lint/typecheck.

---

## Mapa plików

| Plik | Odpowiedzialność |
|---|---|
| `apps/control-room/src/modules/inspector/InspectorShell.tsx` | stały shell, identity, tabs, scroll i actions |
| `apps/control-room/src/modules/inspector/inspectorDescriptor.ts` | domain title/type/icon/status metadata |
| `apps/control-room/src/modules/inspector/InspectorModule.tsx` | selection → descriptor → panel composition |
| `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.tsx` | shared overview composition |
| `apps/control-room/src/modules/inspector/primitives/InspectorGroup.tsx` | semantic disclosure/group |
| `apps/control-room/src/modules/inspector/primitives/InspectorPropertyRow.tsx` | inline/stacked label/control geometry |
| `apps/control-room/src/modules/inspector/primitives/FieldRow.tsx` | read-only values and units |
| `apps/control-room/src/modules/inspector/primitives/FormField.tsx` | input/select/checkbox compatibility facade |
| `apps/control-room/src/modules/inspector/primitives/FeedbackBanner.tsx` | transaction/resource feedback |
| `apps/control-room/src/design/styles/inspector.css` | shared inspector tokens/geometry |
| `apps/control-room/src/design/styles/inspector-visualization.css` | visualization-specific controls |
| `apps/control-room/src/design/styles/inspector-frequency-domain.css` | frequency-domain-specific controls |
| `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts` | static ownership and token rules |
| `apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx` | DOM primitive contract |

### Task 1: Ustal failing baseline i contract identity

**Files:**
- Read: `docs/superpowers/specs/2026-07-17-inspector-design-system-reference-slice-design.md`
- Modify: `apps/control-room/src/modules/inspector/inspectorDescriptor.ts`
- Modify: `apps/control-room/src/modules/inspector/InspectorShell.tsx`
- Modify: `apps/control-room/src/modules/inspector/InspectorModule.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorDescriptor.test.ts`
- Create: `apps/control-room/src/modules/inspector/InspectorShell.test.tsx`

**Interfaces:**
- Consumes: `Selection`, `InspectorDescriptor`, route owner metadata from `inspectorRegistry`.
- Produces: `InspectorDescriptor.icon`, `InspectorDescriptor.ownerId`, explicit type/title/status metadata.

- [ ] **Step 1: Napisz failing descriptor assertions**

```ts
expect(resolveInspectorDescriptor(selection("airbox.visualization", "Airbox visualization"))).toMatchObject({
  ownerId: "airbox.visualization",
  typeLabel: "Airbox visualization",
});
expect(resolveInspectorDescriptor(selection("object.visualization", "Object visualization"))).toMatchObject({
  ownerId: "object.visualization",
  typeLabel: "Object visualization",
});
```

- [ ] **Step 2: Napisz failing shell DOM assertion**

```tsx
const html = renderToStaticMarkup(<InspectorShell descriptor={descriptor} onFocus={() => undefined} onSelectBreadcrumb={() => undefined}>Body</InspectorShell>);
expect(html).toContain('data-inspector-owner="airbox.visualization"');
expect(html).toContain('data-slot="inspector-identity-icon"');
```

- [ ] **Step 3: Uruchom RED testów**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorDescriptor.test.ts src/modules/inspector/InspectorShell.test.tsx
```

- [ ] **Step 4: Dodaj descriptor metadata i icon resolver**

Rozszerz typy:

```ts
export interface InspectorDescriptor {
  breadcrumbs: InspectorBreadcrumb[];
  icon: ExplorerIconToken;
  metadata: InspectorMetadataItem[];
  ownerId: string;
  status: { label: string; tone: InspectorStatusTone } | null;
  tabs: InspectorTabDescriptor[];
  title: string;
  typeLabel: string;
}
```

`InspectorShell` renderuje ikonę zgodną z descriptor, owner marker jako `data-*` i nie zmienia selection/resource state.

- [ ] **Step 5: Uruchom GREEN i zacommituj**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorDescriptor.test.ts src/modules/inspector/InspectorShell.test.tsx
git add apps/control-room/src/modules/inspector/inspectorDescriptor.ts apps/control-room/src/modules/inspector/InspectorShell.tsx apps/control-room/src/modules/inspector/InspectorModule.tsx apps/control-room/src/modules/inspector/inspectorDescriptor.test.ts apps/control-room/src/modules/inspector/InspectorShell.test.tsx
git commit -m "refactor: make inspector identity explicit"
```

### Task 2: Ujednolić primitives i token-backed layout

**Files:**
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorGroup.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorPropertyRow.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FieldRow.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FormField.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FeedbackBanner.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Test: `apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx`
- Test: `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.test.tsx`
- Test: `apps/control-room/src/modules/inspector/primitives/FormField.test.ts`

**Interfaces:**
- Consumes: current primitive props and existing Visualization reference markup.
- Produces: stable `data-slot`/`data-layout` DOM contract and responsive label/control behavior.

- [ ] **Step 1: Dodaj failing responsive DOM cases**

Testy renderują inline i stacked rows, unit-bearing input, error/help state oraz collapsed group. Wymagają odpowiednio `data-layout="inline"`, `data-layout="stacked"`, `aria-invalid="true"`, `data-slot="inspector-group-content"` i braku raw color attributes.

- [ ] **Step 2: Ustal canonical composition**

`InspectorOverviewFrame` pozostaje jedynym overview frame. `InspectorGroup` nie tworzy nested card domyślnie; `InspectorPropertyRow` steruje label/control grid:

```tsx
<div data-slot="inspector-property-row" data-layout={layout}>
  <div data-slot="inspector-property-label">{label}</div>
  <div data-slot="inspector-property-control">{children}</div>
</div>
```

- [ ] **Step 3: Dodaj container-aware CSS**

W `inspector.css` użyj istniejących tokenów i `container-type: inline-size` z `InspectorOverviewFrame`:

```css
.fm-inspector-overview-frame {
  container-type: inline-size;
}

@container (max-width: 280px) {
  .fm-inspector-overview-frame [data-slot="inspector-property-row"][data-layout="inline"] {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}
```

Użyj faktycznych klas obecnego prymitywu; nie twórz równoległego BEM namespace.

- [ ] **Step 4: Usuń tylko osierocone style**

Uruchom static contract test i usuń reguły, które nie mają consumerów po migracji primitive. Nie zmieniaj nazw klas używanych przez niezmigrowane panele bez równoczesnej migracji.

- [ ] **Step 5: Uruchom GREEN i zacommituj**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/primitives/InspectorComposition.test.tsx src/modules/inspector/primitives/InspectorOverviewFrame.test.tsx src/modules/inspector/primitives/FormField.test.ts
pnpm --dir apps/control-room check:architecture-hygiene
git add apps/control-room/src/modules/inspector/primitives apps/control-room/src/design/styles/inspector.css
git commit -m "refactor: unify inspector composition primitives"
```

### Task 3: Zmigruj Visualization jako reference slice

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxVisualizationPanel.tsx`
- Modify: `apps/control-room/src/design/styles/inspector-visualization.css`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx`

**Interfaces:**
- Consumes: route-specific panels from routing plan, `ObjectVisualizationPanelModel`, display-unit helpers and canonical target registry.
- Produces: reference-quality Airbox/Object visualization owners using identical composition but different identity and target semantics.

- [ ] **Step 1: Dodaj failing reference assertions**

Wymagaj `data-slot="inspector-overview-frame"`, `data-slot="inspector-metric-strip"`, one primary `InspectorGroup`, no duplicate global header, explicit `data-inspector-owner`, unit-bearing controls and accessible names.

- [ ] **Step 2: Przenieś body do shared pure sections**

Wyodrębnij formatter/model helpers bez resource hooks. `ObjectVisualizationPanel` i Airbox owner przyjmują selection, wywołują własny target resolver i renderują wspólny `VisualizationControlsBody` tylko jako neutralny component bez owner-specific title/status.

- [ ] **Step 3: Zredukuj nested cards**

`Display Settings`, `Render Mode`, `Quantity Source`, `Surface Coloring`, `Vectors` i vector accounting używają group/separator hierarchy. Border zostaje dla primary surface, status/error i data table; nie powielaj border/radius dla każdej podsekcji.

- [ ] **Step 4: Dodaj responsive/a11y tests**

Sprawdź keyboard path dla toggle/select/slider, `aria-pressed`, `aria-label`, `aria-invalid`, unit labels, disabled reason, dark/light token values oraz 280/420/640 px container geometry.

- [ ] **Step 5: Uruchom testy i commit**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx
pnpm --dir apps/control-room typecheck
git add apps/control-room/src/modules/inspector/panels/ObjectVisualization* apps/control-room/src/modules/inspector/panels/airbox/AirboxVisualizationPanel.tsx apps/control-room/src/design/styles/inspector-visualization.css
git commit -m "refactor: establish visualization inspector reference slice"
```

### Task 4: Przenieś mesh, geometry, material, region, physics i study panels

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxInspectorLanePanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`
- Modify: `apps/control-room/src/design/styles/inspector-mesh.css`
- Modify: `apps/control-room/src/design/styles/inspector-physics.css`
- Modify: `apps/control-room/src/design/styles/inspector-study.css`
- Create: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanelModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.dom.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/airbox/AirboxInspectorLanePanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.lane.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.dom.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx`

**Interfaces:**
- Consumes: resource hooks, edit sessions, lane-neutral mesh/region adapters.
- Produces: każdą rodzinę panelu z identyczną composition API, ale własnym owner/type/status.

- [ ] **Step 1: Wybierz jeden panel z każdej rodziny i dodaj migration marker test**

Test wymaga wspólnego `data-slot` i zakazuje historycznego `fm-inspector-section` w zmigrowanym ownerze. Nie przepisuj modelu resource ani transaction.

- [ ] **Step 2: Zmigruj read-only groups**

Najpierw `FieldRow`/`InspectorPropertyGrid`, następnie status/provenance, na końcu controls. Zachowaj SI units, source/inherited/resolved labels i stale/error semantics.

- [ ] **Step 3: Zmigruj draft controls**

Każdy edit panel zachowuje `InspectorEditSession`, reset/apply, validation przy polu i server rejection przy sekcji. Nie używaj `useEffect + setState` dla wartości pochodnych.

- [ ] **Step 4: Usuń lokalne warianty kontrolek**

Menu, tabs, select, switch, segmented control, dialog i tooltip pozostają shared UI primitives; lokalny widget wymaga wpisu w manifest/spec.

- [ ] **Step 5: Uruchom family test matrix**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/airbox src/modules/inspector/panels/fdm-grid src/modules/inspector/panels/mesh-details src/modules/inspector/panels/region src/modules/inspector/panels/GeometryObjectPanel.test.tsx src/modules/inspector/panels/ObjectMaterialPanelModel.test.ts src/modules/inspector/panels/PhysicsInteractionPanel.dom.test.tsx src/modules/inspector/panels/StudyInspectorPanel.test.tsx
```

- [ ] **Step 6: Zacommituj migrację rodzin**

```bash
git add apps/control-room/src/modules/inspector/panels apps/control-room/src/design/styles/inspector-mesh.css apps/control-room/src/design/styles/inspector-physics.css apps/control-room/src/design/styles/inspector-study.css
git commit -m "refactor: migrate inspector families to shared design system"
```

### Task 5: Zmigruj Results, Resources, Jobs i Diagnostics oraz responsive gate

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FieldQuantityInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/LiveChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/QuickChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Modify: `apps/control-room/src/design/styles/inspector-frequency-domain.css`
- Test: `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts`
- Test: `apps/control-room/src/modules/inspector/inspectorCssContract.test.ts`
- Test: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/FieldQuantityInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.dom.test.tsx`

**Interfaces:**
- Consumes: exact route catalog i neutralne resource adapters.
- Produces: wszystkie selectable Inspector surfaces z uniform header/status/sections i narrow panel behavior.

- [ ] **Step 1: Dodaj token/class contract scan**

Test skanuje komponenty i style zmigrowanego zakresu. Odrzuca raw hex/rgb poza centralnymi token files, klasę bez `fm-`, direct `fetch(` i lokalny shadcn replacement.

- [ ] **Step 2: Dodaj responsive DOM fixture**

Fixture renderuje owner w kontenerach 280, 360, 480 i 640 px; test wymaga stacked fields przy 280 px, zachowania unit/action controls i braku niekontrolowanego overflow.

- [ ] **Step 3: Dodaj state matrix**

Każdy owner renderuje osobno `ready`, `loading`, `refreshing`, `stale`, `unsupported`, `error`, `disabled`, `dirty` tam, gdzie stan jest legalny. Test nie pozwala komunikować statusu tylko kolorem.

- [ ] **Step 4: Uruchom design system gate**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorDesignSystemContract.test.ts src/modules/inspector/inspectorCssContract.test.ts src/modules/inspector/primitives
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
```

- [ ] **Step 5: Zacommituj globalny Inspector gate**

```bash
git add apps/control-room/src/modules/inspector apps/control-room/src/design/styles
git commit -m "test: qualify responsive inspector design system"
```

### Task 6: Browser visual qualification i performance

**Files:**
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.stories.tsx`
- Create: `apps/control-room/src/modules/inspector/inspectorSmokeScript.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`

**Interfaces:**
- Consumes: migrated owner panels and shared primitives.
- Produces: evidence for dark/light, keyboard, reduced-motion, 200% zoom, narrow/wide inspector and idle rendering.

- [ ] **Step 1: Zapisz reference screenshots**

Użyj istniejącego local dev server. Zrzuty obejmują Visualization Airbox/Object, geometry, mesh, results i frequency inspector. Nie uruchamiaj drugiego launcher-owned servera na zajętym porcie.

- [ ] **Step 2: Dodaj screenshot assertions**

Smoke sprawdza widoczny title/owner, primary group, action bar, status, form labels, selected states i brak clipped content przy 200% zoom.

- [ ] **Step 3: Dodaj idle/render budget assertions**

Otwieranie Inspectoru nie może powodować nowych 3D topology/field requests, camera changes, unchanged buffer uploads ani ciągłych animation frames.

- [ ] **Step 4: Uruchom gates**

```bash
pnpm --dir apps/control-room smoke:inspector
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

- [ ] **Step 5: Zacommituj browser/performance evidence**

```bash
git add apps/control-room/scripts/smoke-inspector.mjs apps/control-room/src/modules/inspector
git commit -m "test: qualify inspector visual and idle budgets"
```

## Końcowa bramka planu

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
```

Raport musi rozdzielić implementację, production-executable, browser-validated i pending; przejście typechecku bez screenshot/browser evidence nie zamyka tego planu.
