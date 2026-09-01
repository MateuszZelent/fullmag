# 04 — Panel-left, Explorer i nawigacja Results

## 1. Cel

Docelowy panel-left ma jeden shell i pięć kart, lecz dwóch właścicieli treści:

- `explorer`: Model, Resources, Jobs, Diagnostics;
- `results-navigator`: Results.

Obecnie `ExplorerModule` zawiera własną kartę Results i builder
`buildPhysicsFirstResultsTree`, a równocześnie w tym samym slocie zarejestrowany
jest `results-navigator` aktywowany przez ribbon `results`. To podwójne
właścicielstwo należy usunąć.

## 2. Werdykt architektoniczny

### 2.1. Kernelowy host

Tab bar i wybór właściciela karty są infrastrukturą layoutu:

```text
apps/control-room/src/kernel/layout/panel-left/
  PanelLeftWorkspaceHost.tsx
  PanelLeftTabBar.tsx
  panelLeftTypes.ts
  panelLeftContributions.ts
  panelLeftNavigation.ts
```

Moduł nie może sam tworzyć konkurencyjnego zestawu globalnych kart panelu.

### 2.2. Contribution model

```typescript
export type PanelLeftTabId =
  | "model"
  | "results"
  | "resources"
  | "jobs"
  | "diagnostics";

export interface PanelLeftTabContribution {
  id: PanelLeftTabId;
  label: string;
  moduleId: ModuleId;
  order: number;
}

export interface ModuleManifest {
  // istniejące pola
  contributes?: {
    commands?: CommandContribution[];
    panelLeftTabs?: readonly PanelLeftTabContribution[];
  };
}
```

Contribution jest deklaratywne. Nie może wykonywać side effects podczas
importu manifestu.

### 2.3. Manifesty

```typescript
export const explorerManifest: ModuleManifest = {
  id: "explorer",
  title: "Explorer",
  slots: ["panel-left"],
  contributes: {
    panelLeftTabs: [
      { id: "model", label: "Model", moduleId: "explorer", order: 10 },
      { id: "resources", label: "Resources", moduleId: "explorer", order: 30 },
      { id: "jobs", label: "Jobs", moduleId: "explorer", order: 40 },
      { id: "diagnostics", label: "Diagnostics", moduleId: "explorer", order: 50 },
    ],
    commands: [/* ... */],
  },
  component: () => import("./ExplorerModule"),
  version: "0.2.0",
};

export const resultsNavigatorManifest: ModuleManifest = {
  id: "results-navigator",
  title: "Results",
  slots: ["panel-left"],
  contributes: {
    panelLeftTabs: [
      { id: "results", label: "Results", moduleId: "results-navigator", order: 20 },
    ],
    commands: [/* ... */],
  },
  component: () => import("./ResultsNavigatorModule"),
  version: "0.2.0",
};
```

Pole `activationTab: "results"` staje się bounded compatibility input i zostaje
usunięte po migracji layoutu.

## 3. Layout state

### 3.1. Rozdzielenie ribbon i panel-left

```typescript
export interface LayoutState {
  activeRibbonTab: RibbonTabId;
  activePanelLeftTab: PanelLeftTabId;
  activeViewportMainModuleId: ModuleId;
  activeBottomPanelTab: BottomPanelTabId;
  panelVisible: Record<PanelPosition, boolean>;
  focusedSlot: SlotId | null;
}
```

Migracja z `activeModuleTab`:

- `activeRibbonTab` zachowuje dotychczasową semantykę ribbonu;
- `activePanelLeftTab` przejmuje `ExplorerTabId`;
- active center surface pozostaje osobny;
- persisted layout dostaje nową wersję i bounded reader starego pola.

### 3.2. Controller

```typescript
export class LayoutController {
  setActiveRibbonTab(tab: RibbonTabId): void;
  setActivePanelLeftTab(tab: PanelLeftTabId): void;
  openPanelLeftTab(tab: PanelLeftTabId, options?: { focus?: boolean }): void;
  activateViewportMain(moduleId: ModuleId): void;
}
```

Ribbon command `results.open` może wykonać:

```typescript
ctx.layout?.setActiveRibbonTab("results");
ctx.layout?.openPanelLeftTab("results", { focus: true });
```

Późniejsza zmiana ribbonu nie nadpisuje karty panel-left bez jawnej komendy.

## 4. PanelLeftWorkspaceHost

```tsx
export function PanelLeftWorkspaceHost() {
  const kernel = useKernel();
  const activeTab = useLayoutSelector((state) => state.activePanelLeftTab);
  const contributions = usePanelLeftTabContributions(kernel.modules);
  const activeContribution = resolvePanelLeftTabContribution(
    contributions,
    activeTab,
  );

  return (
    <section className="fm-panel-left" data-panel-left-tab={activeTab}>
      <PanelLeftTabBar
        activeTab={activeTab}
        contributions={contributions}
        onChange={(tab) => kernel.layout.setActivePanelLeftTab(tab)}
      />
      <div className="fm-panel-left__content">
        {activeContribution ? (
          <MountedModule
            key={activeContribution.moduleId}
            kernel={kernel}
            manifest={kernel.modules.require(activeContribution.moduleId)}
            slotId="panel-left"
          />
        ) : (
          <PanelLeftUnavailable tab={activeTab} />
        )}
      </div>
    </section>
  );
}
```

### Lifecycle

- `explorer` pozostaje zamontowany podczas przejść między jego czterema kartami,
  o ile host jawnie wybierze policy `same-owner retain`; jego resource hooks są
  nadal gated przez aktywną kartę;
- przejście na Results odmontowuje Explorer i zwalnia jego subscriptions;
- przejście z Results odmontowuje Results Navigator, abortuje page requests i
  zwalnia virtualizer observers;
- result cursor pozostaje kernel-owned i nie jest kasowany przez unmount modułu;
- ciężkie fields nie należą do panel-left.

Retain policy nie może oznaczać hidden DOM dla dwóch właścicieli równocześnie.

## 5. Refaktor `ExplorerModule`

## 5.1. Zakres po migracji

`ExplorerModule` obsługuje:

```typescript
export type ExplorerOwnedTabId =
  | "model"
  | "resources"
  | "jobs"
  | "diagnostics";
```

Aktywną kartę odczytuje z kernel layout:

```typescript
const activeTab = useLayoutSelector((state) => state.activePanelLeftTab);
const explorerTab = assertExplorerOwnedTab(activeTab);
```

### Usuwane elementy

Po przejściu parity:

- `ExplorerTabBar.tsx` jako właściciel globalnych kart;
- `resultContextRunId` z `explorerStore`;
- `setExplorerResultContextRunId`;
- `reconcileResultContextRunId`;
- results-specific resource hooks z `ExplorerModule`;
- branch `if (tabId === "results")` w `buildExplorerTree`;
- `resultsExplorerNodes.ts` i physics-first Results node kinds, jeśli nie są już
  używane jako compatibility adapter;
- results-specific optional fields z `ExplorerNode`;
- Inspector routes używane wyłącznie przez stare drzewo.

### Pozostają

- Model builders;
- Resource tree;
- Jobs tree;
- Diagnostics tree;
- per-tab expanded/filter state;
- reveal selection dla model/resources/jobs/diagnostics;
- commands expand/collapse;
- result cross-links jako commands do `results-navigator`, bez lokalnego drzewa.

## 5.2. Docelowa wielkość root component

Obecny `ExplorerModule.tsx` przekracza próg odpowiedzialności. Należy wydzielić:

```text
modules/explorer/
  ExplorerModule.tsx                         <= 150 lines
  controller/useExplorerController.ts
  controller/useModelExplorerResources.ts
  controller/useRuntimeExplorerResources.ts
  controller/useExplorerSelectionBridge.ts
  components/ExplorerHeader.tsx
  components/ExplorerTreeSurface.tsx
  builders/*
  store.ts
```

Root tylko wybiera controller dla aktywnej karty i renderuje header/tree.

## 6. Results Navigator — struktura plików

```text
modules/results-navigator/
  manifest.ts
  ResultsNavigatorModule.tsx
  public.ts
  store.ts
  controller/
    useResultsNavigatorController.ts
    useResultContextController.ts
    useResultDatasetTree.ts
    useResultSliceController.ts
    useResultItemsController.ts
    useResultNavigationCommands.ts
  components/
    ResultContextBar.tsx
    ResultDatasetTree.tsx
    ResultDatasetTreeRow.tsx
    ResultDatasetStatus.tsx
    ResultSliceControls.tsx
    ResultAxisControl.tsx
    ResultItemToolbar.tsx
    ResultItemList.tsx
    ResultItemRow.tsx
    ResultBranchGapRow.tsx
    ResultActionBar.tsx
    ResultEmptyState.tsx
    ResultLoadError.tsx
  model/
    buildResultDatasetTree.ts
    resultItemColumns.ts
    resultItemLabels.ts
    resultNavigationState.ts
  compatibility/
    legacyFrequencyDomainResultsAdapter.ts
```

`public.ts` eksportuje tylko manifest i ewentualne pure domain-neutral helpers.
Inne moduły nie importują komponentów/store Results.

## 7. ResultsNavigatorModule

```tsx
export default function ResultsNavigatorModule({ kernel, moduleId }: ModuleProps) {
  const controller = useResultsNavigatorController(kernel, moduleId);

  return (
    <section className="fm-results" aria-label="Results">
      <ResultContextBar {...controller.context} />
      <ResultDatasetTree {...controller.datasetTree} />
      <ResultDatasetStatus {...controller.datasetStatus} />
      <ResultSliceControls {...controller.slice} />
      <ResultItemToolbar {...controller.itemToolbar} />
      <ResultItemList {...controller.items} />
      <ResultActionBar {...controller.actions} />
    </section>
  );
}
```

Root nie pobiera zasobów bezpośrednio i nie buduje całego modelu inline.

## 8. Result context bar

### 8.1. Zawartość

```text
Run selector
Stage selector / All stages
Search datasets
Refresh current context
History / current badge
Context status
```

### 8.2. Run selector

Run list jest stronicowany. Current run jest wyróżniony, lecz nie jedyny.

```typescript
interface ResultContextBarProps {
  currentRunId: string | null;
  selectedRunId: string | null;
  runOptions: readonly ResultRunSummary[];
  runStatus: ResourceStatus;
  onRunChange(runId: string): void;
  onLoadMoreRuns(): void;
  onRefresh(): void;
}
```

Zmiana runu:

1. czyści dataset/item cursor dopiero po zaakceptowaniu nowego run ID;
2. abortuje requests starego runu;
3. nie czyści model selection, dopóki użytkownik nie wybierze wyniku;
4. oznacza istniejący field overlay jako foreign/incompatible;
5. ładuje catalog nowego runu;
6. odtwarza ostatni legalny dataset preference dla runu albo pozostawia brak
   datasetu.

## 9. Dataset tree

## 9.1. Zakres

Drzewo zawiera maksymalnie:

```text
run summary
stage group
product family group
dataset
small semantic child: qualification/source/export
```

Nie zawiera sample/item pages.

## 9.2. Typ węzła

```typescript
export type ResultDatasetTreeNodeKind =
  | "run"
  | "stage"
  | "product-family"
  | "dataset"
  | "dataset-qualification"
  | "dataset-source"
  | "dataset-export";

export interface ResultDatasetTreeNode {
  id: string;
  kind: ResultDatasetTreeNodeKind;
  label: string;
  parentId: string | null;
  status: AnalysisResultStatusFacets;
  datasetRef?: AnalysisResultDatasetIdentity;
  children?: readonly ResultDatasetTreeNode[];
  selectable: boolean;
  contextCommands: readonly CommandId[];
}
```

### Stable node ID

```typescript
function datasetNodeId(ref: AnalysisResultDatasetIdentity): string {
  return [
    "results",
    encodeURIComponent(ref.runId),
    encodeURIComponent(ref.stageId),
    "dataset",
    encodeURIComponent(ref.datasetId),
  ].join(":");
}
```

Dataset revision nie wchodzi do DOM node ID, aby focus nie znikał podczas
refreshu. Jest częścią selection/resource identity.

## 9.3. Grupowanie produktów

Rekomendowane rodziny:

```text
Equilibrium & convergence
Dynamics
Resonance & FMR
Dispersion
Hysteresis
Comparisons
Validation & qualification
Exports
```

Grupowanie jest wyprowadzone z typed `product_kind`, nie z nazwy pliku.

## 10. Slice controls

## 10.1. Generowanie kontrolek

Kontrolki są generowane z `manifest.axes` dla osi, które aktualna projection
traktuje jako fixed/slice.

```tsx
export function ResultSliceControls({ axes, cursor, onChange }: Props) {
  return (
    <section className="fm-results__slice" aria-label="Result coordinates">
      {axes.map((axis) => (
        <ResultAxisControl
          key={axis.axisId}
          axis={axis}
          valueToken={cursor.valueFor(axis.axisId)}
          onChange={(valueToken) => onChange(axis.axisId, valueToken)}
        />
      ))}
    </section>
  );
}
```

### Typy kontrolek

| Axis value kind/cardinality | Kontrolka |
|---|---|
| scalar, mała cardinality | Select + previous/next |
| scalar, duża/ordered | combobox z wyszukiwaniem + slider tylko jako secondary navigation |
| vector3 | select wartości + projection selector komponent/magnitude |
| category | select/multi-select zgodnie z projection capability |
| entity ref | searchable select z label i owner |
| regular sequence | stepper i opcjonalny scrubber |

Slider nie jest źródłem identity. Pozycja slidera mapuje do value token.

## 10.2. Zmiana osi

```typescript
async function selectAxisValue(axisId: string, valueToken: string) {
  const nextCoordinates = replaceCoordinate(cursor.slice.coordinates, {
    axisId,
    valueToken,
  });
  const sample = await locateSample(nextCoordinates);
  const preserved = preservePolicy === "branch"
    ? await locateBranchPoint(sample.sampleId, cursor.branch?.branchId)
    : null;

  navigation.selectSlice({
    coordinates: nextCoordinates,
    sample,
    item: preserved?.item ?? null,
    branch: preserved?.branch ?? cursor.branch,
  });
}
```

Request ma cancellation i generation token. Spóźniona odpowiedź starej osi nie
może nadpisać nowszego wyboru.

## 11. Lista itemów

## 11.1. Wirtualizacja i strony

`@tanstack/react-virtual` może obsłużyć widoczne rows. API nadal stronicuje.

```tsx
const virtualizer = useVirtualizer({
  count: pageWindow.totalKnownRows,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => ROW_HEIGHT_PX,
  overscan: 8,
});
```

`pageWindow` utrzymuje maksymalnie aktywną, poprzednią i następną stronę
control-plane. Nie materializuje całego datasetu.

### Page boundary

Gdy virtual range zbliża się do końca załadowanej strony, controller może
prefetch następny cursor. Prefetch:

- jest anulowany po zmianie slice/filter/sort;
- nie pobiera fieldów;
- nie uruchamia się podczas inactive Results module;
- nie miesza revisions.

## 11.2. Kolumny/wiersze per item kind

### Eigen mode

```text
branch | mode label | frequency | damping/linewidth | residual | field | status
```

### Response point

```text
frequency | primary observable | convergence | field | status
```

### Spectral feature

```text
rank | frequency | power/amplitude | linewidth | uncertainty | field | relation
```

### DSF point

```text
k | frequency | power | component | field | status
```

### Branch

```text
branch | point count | gaps | tracking method | confidence | qualification
```

W małym panelu wiersz przechodzi na stacked key/value, bez utraty primary
metrics.

## 11.3. Row component

```typescript
interface ResultItemRowProps {
  item: AnalysisResultItemSummary;
  selected: boolean;
  focused: boolean;
  onFocus(itemId: string): void;
  onSelect(itemId: string): void;
  onOpenContextMenu(itemId: string, point: ScreenPoint): void;
}
```

Hover/focus nie pobiera field. Selection również domyślnie pobiera tylko item
detail; field wymaga explicit action lub włączonego przez użytkownika
`auto-plot selected field` preference z ostrzeżeniem o koszcie i bounded policy.
Domyślnie auto-plot jest wyłączone.

## 12. Filters i sortowanie

### Filtry wspólne

```text
item kind
frequency range
status completeness
qualification
has field
branch
search label/ID
```

### Modalne

```text
residual max
linewidth/damping range
component participation
tracking confidence
```

### Driven

```text
observable
amplitude/power range
convergence state
```

### FFT/DSF

```text
feature kind
power threshold
component/probe
k/f ranges
matched relation status
```

UI oznacza filtr jako `server` albo `local`. Lokalny filtr działa tylko na
załadowanym bounded page i nie może udawać filtru całego datasetu. Domyślnie
filtry semantyczne są server-side.

## 13. Action bar i commands

### 13.1. Komendy

```text
results.open-run
results.open-stage
results.open-dataset
results.select-slice
results.select-item
results.focus-branch
results.follow-branch
results.open-in-analysis
results.plot-field
results.open-field-map
results.compare-primary
results.compare-secondary
results.reveal-source
results.reveal-result-mesh
results.export-selection
results.copy-deep-link
results.refresh
```

### 13.2. Enablement

Komenda ma typed predicate:

```typescript
const plotFieldCommand: CommandContribution = {
  id: "results.plot-field",
  title: "Plot result field",
  scope: "selection",
  isEnabled: (ctx) => resultFieldCommandState(ctx).enabled,
  disabledReason: (ctx) => resultFieldCommandState(ctx).reason,
  run: (ctx) => activateSelectedResultField(ctx),
};
```

Nie renderujemy aktywnego buttonu, który dopiero po kliknięciu odkrywa brak
field ref.

## 14. Result Navigator store

```typescript
export interface ResultsNavigatorUiState {
  expandedNodeIds: ReadonlySet<string>;
  datasetSearch: string;
  itemFilter: AnalysisResultItemFilter;
  itemSort: readonly AnalysisResultSortKey[];
  preservePolicy: "none" | "branch";
  compactSection: "datasets" | "slice" | "items";
  lastFocusedItemId: string | null;
}
```

### Persistowane

- expanded stage/family nodes, bounded;
- ostatni compact section;
- preserve policy;
- display density;
- opcjonalnie ostatni dataset ID per run jako preference, bez revision.

### Niepersistowane

- page cursors;
- pages;
- sample/item details;
- status resource snapshots;
- field refs/payloads;
- topology;
- errors z transportu.

## 15. Cross-navigation między kartami panel-left

## 15.1. Model -> Results

Stage node publikuje output relation IDs. Komenda:

```typescript
results.reveal-stage-products({ runId, stageId })
```

- otwiera kartę Results;
- ustawia run/stage filter;
- nie zgaduje datasetu, jeśli stage ma kilka produktów;
- gdy jest dokładnie jeden preferred dataset, może go zaznaczyć zgodnie z
  manifest capability.

## 15.2. Jobs -> Results

Job detail zawiera `produced_dataset_ids`. `Show produced results` używa tych ID.

## 15.3. Resources -> Results

Artifact resource zawiera `owning_dataset_refs`. Przy wielu ownerach UI pokazuje
wybór; nie wybiera pierwszego arbitralnie.

## 15.4. Diagnostics -> Results

Issue posiada bounded affected refs:

```typescript
interface DiagnosticAffectedResultRef {
  runId: string;
  datasetId: string;
  datasetRevision?: string;
  sampleId?: string;
  itemId?: string;
  fieldId?: string;
}
```

Akcja `Reveal affected result` otwiera dokładny poziom, jeśli revision istnieje.

## 16. Selection i reveal

### 16.1. Results item selection

```typescript
function selectResultItem(item: AnalysisResultItemSummary) {
  const nextCursor = resultCursorForItem(currentCursor, item);
  kernel.resultNavigation.select({
    cursor: nextCursor,
    focus: "item",
    label: item.label,
    source: moduleId,
  });
}
```

### 16.2. Reveal po kliknięciu wykresu

Analysis nie manipuluje `resultsNavigatorStore`. Ustawia result cursor/selection.
Results po zamontowaniu:

1. odczytuje cursor;
2. rozwija dataset ancestors;
3. ustawia slice controls;
4. pobiera stronę zawierającą item przez locator endpoint, jeśli nie jest w
   bieżącym page window;
5. scrolluje do stable item ID;
6. zachowuje focus bez tworzenia duplikatu selection.

Locator endpoint może zwracać cursor strony:

```http
GET .../items/{item_id}/location?query_digest=...
```

## 17. Result context i historyczne runy

- `Current` jest badge, nie magiczna trasa;
- run selector ładuje bounded pages;
- historyczny run zachowuje immutable artifact revisions;
- overlay z innego runu ma status foreign;
- powrót do current run nie przywraca automatycznie starego field, dopóki cursor
  nie pasuje;
- URL/deep link może otworzyć historyczny run bez zmiany server current run.

## 18. Stany prezentacyjne

### Dataset tree row

```text
loading: spinner + zachowany label
ready/complete: status icon i qualification badge
running/partial: progress summary
interrupted: completed/requested + stop reason
corrupt: error icon, selection dozwolona dla diagnostics, analysis zablokowane
unsupported: reason code
stale: retained row + revision mismatch
```

### Item list

Nie blokujemy całej listy, gdy jeden field jest missing. Status jest per-row.

## 19. Plan migracji panel-left

### Krok 1 — testy aktualnego podwójnego ownera

- test registry potwierdza dwa panel-left manifests;
- test `SlotHost` pokazuje ribbon coupling;
- test Explorer potwierdza branch Results;
- te testy stają się kontrolowanym baseline, nie docelowym zachowaniem.

### Krok 2 — kernel contribution i layout state

- dodać `PanelLeftTabId`;
- dodać contribution registry;
- dodać `activePanelLeftTab`;
- dodać migration persistence;
- zbudować `PanelLeftWorkspaceHost`.

### Krok 3 — przenieść tab bar

- przenieść rendering do kernel layout;
- `ExplorerModule` odczytuje aktywną owned tab;
- Results manifest przejmuje `results` contribution;
- event `explorer:tab-requested` staje się compatibility command adapter.

### Krok 4 — nowy Results vertical slice

- typed field sweep resource;
- dataset tree;
- slice controls;
- item page;
- mode selection;
- Analysis/Inspector/field handoff.

### Krok 5 — usunąć duplicate Results

- usunąć results branch z `buildExplorerTree`;
- usunąć results resources z Explorer root;
- usunąć `resultsExplorerNodes.ts` po przeniesieniu niezbędnych pure adapters;
- odchudzić `ExplorerNodeKind`;
- usunąć stare Inspector routes dopiero po mapping parity.

## 20. Testy

### Kernel/layout

- contribution order i uniqueness;
- każda karta ma dokładnie jednego ownera;
- ribbon i panel-left są niezależne;
- persisted migration;
- inactive owner jest odmontowany;
- same-owner tab switch nie dubluje subscriptions.

### Explorer

- nie ładuje frequency-domain resources na Model;
- nie zawiera Results branch po cutover;
- cross-link commands otwierają Results;
- expanded/filter state per owned tab.

### Results

- tree nie zawiera sample/item children;
- 15 axis values prowadzi do właściwych sample IDs;
- list update przy zmianie slice;
- branch preserve/gap;
- server paging i virtualization;
- stale page restart;
- zero field request przy hover/focus/unit/filter;
- reveal from Analysis lokalizuje stronę i scrolluje do itemu;
- abort po unmount.

### Accessibility

- tab bar jest roving/keyboard accessible;
- tree i list mają oddzielne aria labels;
- statusy mają tekst;
- focus wraca po refreshu;
- compact mode przy 200% zoom;
- context menu dostępne klawiaturą.

## 21. Definition of Done

- panel-left ma jeden kernelowy tab host;
- istnieje dokładnie jeden owner Results;
- ribbon nie jest właścicielem karty panel-left;
- Explorer nie pobiera ani nie interpretuje Results;
- Results tree zawiera datasets, nie wszystkie itemy;
- sample/item pages są server-side paged i client-side virtualized;
- result cursor przeżywa unmount Results;
- cross-navigation działa przez commands/typed refs;
- żadna akcja nie importuje store innego modułu;
- 10k×100 fixture nie tworzy miliona node objects;
- zmiana slice nie pobiera fields i nie pozostawia starego overlay;
- wszystkie stany i reason codes są dostępne klawiaturą i w Inspectorze.
