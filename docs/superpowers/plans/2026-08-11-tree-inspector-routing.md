# Explorer and Inspector Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rozdzielić builder Explorera od routingu Inspectorów i zapewnić, że każdy wybieralny semantyczny węzeł ma jawnego właściciela panelu.

**Architecture:** `buildModelTree.ts` pozostaje publicznym kompozytorem, a logika domenowa trafia do pure builderów. Inspector otrzymuje exact-match route catalog; `PlaceholderPanel` jest wyłącznie widocznym bezpiecznikiem dla nieznanego kontraktu. Stabilne node IDs i selection refs pozostają bez zmian.

**Tech Stack:** TypeScript, React 19, Next.js 16, Vitest, resource-first kernel selection, shadcn/Radix primitives.

## Global Constraints

- Zachować jeden Explorer, jeden Inspector registry i jeden unified workspace dla FEM/FDM.
- Stabilne node IDs (`airbox.mesh`, `airbox.visualization`, object/region/result IDs) pozostają kompatybilne.
- React components i moduły nie wykonują bezpośredniego `fetch()` ani nie składają ścieżek `/v2`.
- HTTP v2/resource hooks pozostają źródłem prawdy; selection przechowuje małą semantic ref.
- Każdy nowy route ma własny owner panelu; wspólne są tylko pure adaptery, prymitywy i neutralne renderery.
- `selectionKinds: ["*"]` nie może rozwiązywać znanego wybieralnego kindu.
- Wszystkie nowe klasy CSS zaczynają się od `fm-` i korzystają z `--fm-*`.
- Nie obniżać jakości viewportu ani glyph density w celu zamaskowania kosztu routingu.
- Zachować niezwiązaną zmianę `external_solvers/3`; staging i commity muszą być path-specific.
- Każde zadanie kończy się focused testem przed przejściem do następnego.

---

## Mapa plików

| Plik | Odpowiedzialność po migracji |
|---|---|
| `apps/control-room/src/modules/explorer/explorerTypes.ts` | eksport `ExplorerNodeKind` i stabilne dane węzła |
| `apps/control-room/src/modules/explorer/builders/buildModelTree.ts` | publiczny kompozytor oraz flatten/filter/path helpers |
| `apps/control-room/src/modules/explorer/builders/modelRootNodes.ts` | session, universe, definitions i root objects |
| `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts` | obiekt, regiony, material, texture, visualization i physics children |
| `apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.ts` | Airbox overview, mesh, visualization i debug |
| `apps/control-room/src/modules/explorer/builders/meshExplorerNodes.ts` | shared-domain, FDM grid, quality, builds i unassigned parts |
| `apps/control-room/src/modules/explorer/builders/explorerNodeContract.ts` | wspólne konstruktory i invariants wybieralnego node |
| `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx` | exact `InspectorRouteId -> InspectorPanelContribution` |
| `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` | public compatibility facade dla registry |
| `apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts` | coverage wszystkich selectable kinds |
| `apps/control-room/src/modules/inspector/panels/airbox/AirboxVisualizationPanel.tsx` | Airbox-specific display owner |
| `apps/control-room/src/modules/inspector/panels/MeshPartVisualizationPanel.tsx` | mesh-part-specific display owner |
| `apps/control-room/src/modules/inspector/panels/mode-visualization/*` | osobne overview/group/field/view owners |

### Task 1: Zbuduj failing coverage dla obecnego drzewa i routingu

**Files:**
- Read: `docs/superpowers/specs/2026-08-11-control-room-tree-inspector-analysis-design.md`
- Read: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Read: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Create: `apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts`

**Interfaces:**
- Consumes: `buildExplorerTree`, `flattenExplorerNodes`, `resolveInspectorPanel`.
- Produces: failing tests, które blokują przejście przez wspólny panel Visualization i normalny wildcard.

- [ ] **Step 1: Dodaj failing exact-owner assertions**

```tsx
it("keeps Airbox, object, and mesh-part visualization owners distinct", () => {
  expect(resolveInspectorPanel({ kind: "airbox.visualization" })?.id).toBe(
    "airbox-visualization",
  );
  expect(resolveInspectorPanel({ kind: "object.visualization" })?.id).toBe(
    "object-visualization",
  );
  expect(resolveInspectorPanel({ kind: "mesh-part" })?.id).toBe(
    "mesh-part-visualization",
  );
});
```

- [ ] **Step 2: Dodaj coverage test na istniejących fixture’ach**

Rozszerz fixture używany w `buildModelTree.test.ts` o model, obiekty, Airbox, region, mesh, study, resources, results, jobs i diagnostics. Test zbiera `flattenExplorerNodes(buildExplorerTree(tabId, resources))` dla `model`, `resources`, `results`, `jobs` i `diagnostics`, pomija tylko `selectable === false`, a następnie sprawdza wynik registry:

```ts
for (const node of selectableNodes) {
  const panel = resolveInspectorPanel({ kind: node.kind });
  expect(panel?.id, `missing Inspector for ${node.id}`).toBeTruthy();
  expect(panel?.id, `placeholder for ${node.id}`).not.toBe("placeholder");
}
```

- [ ] **Step 3: Uruchom RED testów**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/inspectorRouteCoverage.test.ts
```

Expected: FAIL, ponieważ Airbox/Object/Mesh-part współdzielą panel, a część wybieralnych kinds może przejść przez placeholder.

- [ ] **Step 4: Zacommituj failing tests**

```bash
git add apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts
git commit -m "test: define exact inspector route coverage"
```

### Task 2: Wprowadź exact route catalog bez zmiany publicznego API registry

**Files:**
- Create: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts`

**Interfaces:**
- Consumes: istniejące importy paneli i `InspectorPanelContribution`.
- Produces: `InspectorRouteId`, `resolveInspectorRoute(kind)` i kompatybilne `resolveInspectorPanel(selection)`.

- [ ] **Step 1: Zdefiniuj katalog i resolver**

```tsx
export type InspectorRouteId = string & {
  readonly __brand: "InspectorRouteId";
};

export interface InspectorRoute {
  id: InspectorRouteId;
  title: string;
  selectionKinds: readonly string[];
  component: InspectorPanelContribution["component"];
  contribution: InspectorPanelContribution;
}

export function resolveInspectorRoute(kind: string): InspectorRoute | null {
  return INSPECTOR_ROUTES_BY_KIND.get(kind) ?? null;
}
```

`INSPECTOR_ROUTES_BY_KIND` buduje się raz na module scope z exact selection-kind entries. Wpisy `airbox.visualization`, `object.visualization`, `mesh-part`, `airbox.visualization.debug` i `object.visualization.debug` mają różne route IDs. Frequency-domain kinds pozostają one-to-one z istniejącymi dedicated panels.

- [ ] **Step 2: Przenieś deklaracje paneli z `PANELS` do katalogu**

Zachowaj istniejące eksporty `FREQUENCY_DOMAIN_INSPECTOR_SELECTION_KINDS` i `resolveInspectorPanel`, ale spraw, aby facade wykonywał:

```ts
export function resolveInspectorPanel(
  selection: Pick<Selection, "kind">,
): InspectorPanelContribution | null {
  if (!selection.kind) return null;
  return resolveInspectorRoute(selection.kind)?.contribution ?? null;
}
```

Nie dodawaj kolejnego first-match array. `PlaceholderPanel` może być zwrócony tylko przez jawny `resolveUnknownInspectorRoute`, używany w diagnostycznym boundary.

- [ ] **Step 3: Uruchom testy GREEN routingu**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/inspectorRouteCoverage.test.ts
```

Expected: route tests przechodzą; dedykowane component owners mogą jeszcze nie istnieć, więc tymczasowo użyj istniejącego body tylko w nowych wrapperach z odrębnym route ID.

- [ ] **Step 4: Zacommituj katalog**

```bash
git add apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx apps/control-room/src/modules/inspector/inspectorRegistry.tsx apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts
git commit -m "refactor: add exact inspector route catalog"
```

### Task 3: Rozdziel `buildModelTree.ts` na pure buildery domenowe

**Files:**
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/explorerNodeContract.ts`
- Create: `apps/control-room/src/modules/explorer/builders/modelRootNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/meshExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Test: `apps/control-room/src/modules/explorer/explorerStore.performance.test.ts`

**Interfaces:**
- Consumes: obecne snapshot types i `ModelTreeResources` z `buildModelTree.ts`.
- Produces: ten sam publiczny `buildModelTree(snapshot, resources)`, `buildExplorerTree(tabId, resources)`, `flattenExplorerNodes`, `collectExplorerNodeIds`, `findExplorerNodePath`.

- [ ] **Step 1: Eksportuj `ExplorerNodeKind` bez zmiany wartości unionu**

Zmień istniejącą deklarację `type ExplorerNodeKind =` na `export type ExplorerNodeKind =`, zachowując bez zmian wszystkie istniejące literal values unionu.

Nie zmieniaj żadnego istniejącego literal ID/kind. Test kompilacji i `explorerSelection.test.ts` ma wykryć przypadkowe usunięcie.

- [ ] **Step 2: Dodaj wspólny konstruktor node**

```ts
export function createExplorerNode(
  input: ExplorerNode,
): ExplorerNode {
  if (input.id.trim().length === 0) {
    throw new Error("Explorer node requires a non-empty id");
  }
  return input;
}
```

Konstruktor nie wymusza parenta, ponieważ obecny kontrakt dopuszcza wybieralne root nodes. Nie pobiera zasobów i nie zmienia selection.

- [ ] **Step 3: Przenieś funkcje w granicach odpowiedzialności**

Przenoś grupami przez `git mv`/extract, zachowując sygnatury i eksporty testowane publicznie. `buildModelTree.ts` ma wyłącznie zebrać snapshot/resource adapters, wywołać buildery i złożyć root order. Nie przenoś JSX, resource hooks ani side effects do builderów.

- [ ] **Step 4: Uruchom testy regresji drzewa**

```bash
pnpm --dir apps/control-room test -- --run src/modules/explorer/builders/buildModelTree.test.ts src/modules/explorer/explorerSelection.test.ts src/modules/explorer/explorerStore.test.ts src/modules/explorer/explorerStore.performance.test.ts
```

Expected: PASS z niezmienionymi node IDs, parent IDs, selection kinds i statusami.

- [ ] **Step 5: Sprawdź granice importów**

```bash
rg "from ['\"]\.\./" apps/control-room/src/modules/explorer/builders
rg "fetch\(|useKernel|use.*Resource" apps/control-room/src/modules/explorer/builders
```

Expected: brak importów między modułami, transportu i hooków React w pure builderach.

- [ ] **Step 6: Zacommituj split buildera**

```bash
git add apps/control-room/src/modules/explorer/explorerTypes.ts apps/control-room/src/modules/explorer/builders
git commit -m "refactor: split explorer model builders by domain"
```

### Task 4: Utwórz odrębnych ownerów Visualization i Mode Visualization

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/airbox/AirboxVisualizationPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/MeshPartVisualizationPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/mode-visualization/ModeVisualizationOverviewPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/mode-visualization/ModeVisualizationGroupPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/mode-visualization/ModeVisualizationFieldPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/mode-visualization/ModeVisualizationViewPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.test.tsx`

**Interfaces:**
- Consumes: `ObjectVisualizationPanelModel`, canonical visualization target registry, existing mode overlay commands.
- Produces: route-specific components with shared pure body models and explicit target labels.

- [ ] **Step 1: Dodaj RED assertions owner identity**

```tsx
expect(renderToStaticMarkup(<AirboxVisualizationPanel selection={airboxSelection} />)).toContain(
  'data-inspector-owner="airbox.visualization"',
);
expect(renderToStaticMarkup(<ObjectVisualizationPanel selection={objectSelection} />)).toContain(
  'data-inspector-owner="object.visualization"',
);
```

- [ ] **Step 2: Zbuduj wrappery bez drugiego resource store’a**

Każdy wrapper przekazuje selection do wspólnego pure modelu, ale posiada własny `data-inspector-owner`, tytuł, target identity, capability explanation i action set. Nie kopiuj requestów ani ECharts/WebGL lifecycle.

- [ ] **Step 3: Rozdziel cztery poziomy Mode Visualization**

Overview pokazuje mode family/provenance, Group pokazuje listę pól, Field pokazuje quantity/resource metadata, a View pokazuje phase/render controls. Każdy poziom zachowuje link breadcrumb do rodzica i nie udaje pełnego overview.

- [ ] **Step 4: Uruchom focused tests**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx src/modules/inspector/panels/ModeVisualizationInspectorPanel.test.tsx src/modules/inspector/inspectorRouteCoverage.test.ts
```

- [ ] **Step 5: Zacommituj owner wrappers**

```bash
git add apps/control-room/src/modules/inspector/panels apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx
git commit -m "feat: give visualization nodes dedicated inspectors"
```

### Task 5: Zamknij coverage wszystkich selectable node kinds

**Files:**
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCoverage.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modify: `apps/control-room/src/modules/explorer/builders/explorerNodeContract.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorDescriptor.ts`
- Test: `apps/control-room/src/modules/inspector/inspectorDescriptor.test.ts`

**Interfaces:**
- Consumes: wszystkie builder outputs z Task 3 i route owners z Task 4.
- Produces: fail-closed coverage dla nowych kinds oraz owner-specific descriptor title/type/icon metadata.

- [ ] **Step 1: Wymuś brak unknown selectable kinds**

Test ma zebrać unikalne `(kind, node.id)` z każdej zakładki, wywołać resolver dla każdego kindu i zgłosić wszystkie braki jednym komunikatem. Foldery z `selectable: false` są jedyną dopuszczalną kategorią bez panelu.

- [ ] **Step 2: Dodaj icon/title/type contract**

Rozszerz `InspectorDescriptor` o jawny `icon`/`ownerId` tylko wtedy, gdy istniejący `InspectorShell` może je konsumować bez zmiany selection. Test sprawdza, że Airbox, object, mesh-part i mode nie mają wspólnego title/type.

- [ ] **Step 3: Uruchom pełny focused gate**

```bash
pnpm --dir apps/control-room test -- --run src/modules/explorer/builders/buildModelTree.test.ts src/modules/explorer/explorerSelection.test.ts src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/inspectorRouteCoverage.test.ts src/modules/inspector/inspectorDescriptor.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Expected: exit 0 i brak normalnych użyć `PlaceholderPanel` dla selectable node.

- [ ] **Step 4: Zacommituj coverage closure**

```bash
git add apps/control-room/src/modules/explorer apps/control-room/src/modules/inspector
git commit -m "test: close explorer inspector ownership coverage"
```

### Task 6: Browser qualification routingu

**Files:**
- Read: `apps/control-room/scripts/smoke-inspector.mjs`
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`
- Create: `apps/control-room/src/modules/inspector/inspectorSmokeScript.test.ts`
- Read: `apps/control-room/src/modules/viewport-3d/airboxFieldRoutingSmokeScript.test.ts`
- Read: `apps/control-room/src/modules/viewport-3d/viewportMixedTargetSmokeScript.test.ts`
- Read: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

**Interfaces:**
- Consumes: exact route catalog, stable tree IDs, existing local dev-server ownership.
- Produces: browser proof wyboru Airbox/Object/Mesh-part/Mode and powrotu do viewportu bez błędu WebGL.

- [ ] **Step 1: Dodaj scenariusz selection matrix**

Smoke klika po jednym node z każdej owner family, sprawdza `data-inspector-owner`, tytuł, breadcrumb i brak tekstu `Selection`/`Placeholder`.

- [ ] **Step 2: Dodaj narrow/keyboard checks**

Ustaw szerokość panelu, przejdź Tab/Enter/Arrow keys przez tree i Inspector, sprawdź widoczność primary action oraz brak poziomego overflow dla form controls.

- [ ] **Step 3: Dodaj WebGL lifecycle assertion**

Po wyborze Mode visualization i powrocie do viewportu sprawdź canvas visibility, `gl.isContextLost() === false` i dodatni drawing buffer.

- [ ] **Step 4: Uruchom smoke przez istniejący launcher**

```bash
pnpm --dir apps/control-room smoke:inspector
pnpm --dir apps/control-room smoke:viewport-3d-explorer-inspector-targets
```

Expected: exit 0; reused dev server nie jest zabijany przez launcher.

- [ ] **Step 5: Zacommituj browser gate**

```bash
git add apps/control-room/scripts/smoke-inspector.mjs apps/control-room/src/modules/inspector/inspectorSmokeScript.test.ts
git commit -m "test: qualify explorer inspector routing in browser"
```

## Końcowa bramka planu

Po Task 6 uruchom:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
```

Nie raportuj ukończenia, jeśli coverage test nie obejmuje wszystkich aktualnie generowanych selectable nodes albo jeśli browser smoke nie potwierdza zdrowego canvasu po zmianie selection.
