# 32 — Moduły analizy wyników (Results analysis feature modules)

- Status: proposed (target-only; nic nie jest wdrożone)
- Data: 2026-10-09
- Decyzja: [ADR 0054](../../adr/0054-module-driven-results-explorer.md)
- Katalog drzew modułów: [01-explorer-tree-catalog.md](../../plans/active/module-driven-results-explorer/01-explorer-tree-catalog.md)
- Powiązane: [11 — Explorer](11-explorer-view.md), [13 — Inspector](13-inspector-and-property-editing.md), [16 — Charts/Analysis](16-charts-analysis-module.md), [19 — Module lifecycle](19-feature-flags-module-lifecycle.md), ADR 0029

Specyfikacja opisuje kontrakt, przez który moduł analizy dokłada do
wspólnego workspace węzły drzewa wyników, widoki głównego obszaru, sekcje
Inspectora, kontekstowy ribbon i komendy. Typy poniżej są projektem
kontraktu, nie istniejącym kodem.

## 1. Pojęcia

| Pojęcie | Znaczenie | Odpowiednik COMSOL |
|---|---|---|
| Zbiór danych (dataset) | opublikowany wynik badania z manifestem `AnalysisResultDatasetManifestResource` | Dataset / Solution |
| Moduł analizy | wtyczka obsługująca określone zbiory: dyspersja, rezonans, histereza, transmisja, analiza czasowa | rodzina Plot Group i Derived Values |
| Węzeł analizy | węzeł drzewa utworzony z szablonu modułu | Plot Group, Plot feature, Derived Value |
| Definicja | trwały opis węzła tworzonego przez użytkownika | zapisany węzeł Results w pliku modelu |
| Widok | zawartość głównego obszaru dla zaznaczonego węzła | okno Graphics |
| Sekcja Inspectora | blok ustawień lub danych zaznaczonego węzła | okno Settings |
| Kontekstowa zakładka | grupy ribbonu modułu, widoczne tylko dla jego węzłów | kontekstowa zakładka „1D Plot Group” |

## 2. Manifest modułu (metadane, ładowane przy starcie)

Manifest nie importuje kodu widoków. Musi dać się ocenić dla każdego zbioru
bez ładowania modułu.

```ts
interface AnalysisFeatureManifest {
  id: `analysis.${string}`;              // np. "analysis.dispersion"
  version: string;                       // semver; zapisywany w definicjach
  title: string;                         // "Dispersion"
  matches: DatasetMatchRule[];           // wystarczy jedna pasująca reguła
  nodeTemplates: AnalysisNodeTemplate[];
  definitionSchemas: Record<AnalysisNodeKind, DefinitionSchemaRef>; // dla węzłów "user"
  load: () => Promise<{ default: AnalysisFeatureModule }>;         // kod, leniwie
}

interface DatasetMatchRule {
  productKinds: AnalysisResultProductKind[];      // z manifestu zbioru
  itemKinds?: AnalysisResultItemKind[];
  kContexts?: KContext[];                         // finite_open | gamma | fixed_k | k_path | k_grid (ADR 0023)
  requiredAxes?: AxisRole[];                      // np. "wavevector", "frequency", "bias_field"
  requiredCapabilities?: Array<keyof AnalysisResultDatasetCapabilities>;
}
```

`kContexts` i `requiredAxes` wymagają, by manifest zbioru publikował rolę osi
i kontekst k. Dziś `AnalysisResultDatasetManifestResource` ma `axes`, ale
klasyfikacja k-context żyje w kliencie (ADR 0023). To luka kontraktu, patrz §9.

## 3. Szablony węzłów

```ts
interface AnalysisNodeTemplate {
  kind: AnalysisNodeKind;                         // "analysis.dispersion.relation"
  parent: AnalysisNodeKind | "dataset";
  role: "overview" | "plot-1d" | "plot-2d" | "plot-feature"
      | "data-collection" | "visualization-group" | "field-visualization"
      | "derived-value" | "quality";
  title: string;                                  // etykieta statyczna, do czasu załadowania danych
  instantiation: "auto" | "optional" | "user";
  availableWhen?: DatasetMatchRule;               // niespełnione: wyszarzone w „Add…” z powodem
  children?: { paging: "none" | "server"; pageSize?: number };
}
```

- `auto`: węzeł powstaje dla każdego pasującego zbioru (np. Overview,
  Dispersion relation).
- `optional`: węzeł jest w menu „Add…” rodzica. Gdy `availableWhen` nie jest
  spełnione, pozycja jest wyszarzona z powodem (np. „Iso-frequency contour
  wymaga zbioru z siatką k 2D”).
- `user`: węzeł powstaje z interakcji i jest zapisywany jako definicja (np.
  wizualizacja modu z punktu wykresu, nakładka referencji).

Identyfikator węzła jest deterministyczny:
`<run_id>/<dataset_id>/<template kind>[/<definition_id>]`. Indeksy i etykiety
nie wchodzą do tożsamości (ADR 0029).

Etykiety pokazują wielkości fizyczne z jednostkami, np.
`Branch 1 · kᵧ +15 rad/µm · 12.025 GHz`. Surowe identyfikatory trafiają do
sekcji Provenance.

## 4. Kod modułu (ładowany leniwie)

```ts
interface AnalysisFeatureModule {
  views: Partial<Record<AnalysisNodeKind, ViewContribution>>;
  inspectorSections: Partial<Record<AnalysisNodeKind, InspectorSectionContribution>>;
  ribbonGroups: Partial<Record<AnalysisNodeKind, RibbonGroupContribution[]>>;
  commands: CommandContribution[];               // istniejący typ z kernel/commands
  children?: Partial<Record<AnalysisNodeKind, ChildrenProvider>>; // dynamiczne dzieci, np. gałęzie
}

interface ViewContribution {
  surface: "summary" | "chart" | "map-2d" | "table" | "field-3d";
  component: ComponentType<AnalysisViewProps>;
  companion?: {                                  // tylko dla "field-3d" z przypiętym źródłem
    sourceNode: AnalysisNodeKind;                // np. wykres relacji dyspersji
    placements: Array<"replace" | "below" | "beside">;
    defaultPlacement: "replace" | "below" | "beside";
  };
}

// Moduł dostarcza treść, kernel składa ją w ramę z §12 (ten sam układ co
// Inspector wizualizacji ferromagnetyka). Moduł nie buduje własnej ramy.
interface InspectorSectionContribution {
  identity: { title: string; badges: [string, string] };
  view?: ComponentType<InspectorSectionProps>;            // opcjonalna grupa „View”
  metrics: (props: InspectorSectionProps) => [Metric, Metric, Metric, Metric];
  primary: { title: string; icon: LucideIconName; component: ComponentType<InspectorSectionProps> };
  nav: Array<{ id: string; title: string; icon: LucideIconName;
               summary: (props: InspectorSectionProps) => string;
               group: "presentation" | "data" | "comparison" | "quality";
               component: ComponentType<InspectorSectionProps> }>;
  recompute?: ComponentType<InspectorSectionProps>;      // parametry badania, wizualnie oddzielone
  editSession?: "liveViewport";                           // Reset/Apply w stopce
}

interface RibbonGroupContribution {
  id: string;
  title: string;
  tone?: "analysis" | "compose" | "export";
  actions: Array<{ commandId: string; label: string; icon: string }>;
}
```

Kernel dodaje zawsze, bez kodu modułu, zwinięty kontekst
(`ScientificInspectorContext`): **Status** (słownik z §7), **Physical
properties** i **Provenance** (run, stage, dataset, rewizje, schemat, silnik,
urządzenie, requested → resolved), a także stopkę akcji powłoki.
Sekcje z grupy `recompute` są wizualnie oddzielone i nigdy nie zmieniają
istniejącego wyniku: prowadzą do ustawień badania.

## 5. Cykl życia

1. Start: kernel rejestruje manifesty (metadane). Kod modułów nie jest
   ładowany.
2. Katalog zbiorów dla wybranego wykonania: dla każdego zbioru kernel ocenia
   reguły `matches`. Pasujące szablony `auto` tworzą węzły. Trwałe definicje
   tworzą węzły `user`. Zbiór bez pasującego modułu daje węzeł
   „Dataset · brak modułu analizy”.
3. Rozwinięcie węzła z dynamicznymi dziećmi: `load()` modułu, potem
   stronicowane zasoby (`pageSize` domyślnie 50). Mody w próbce k ładują się
   dopiero po rozwinięciu próbki.
4. Zaznaczenie węzła: `load()`, jeśli kod nie jest jeszcze załadowany (stan
   węzła `loading`), potem montaż widoku, sekcji Inspectora i grup ribbonu.
5. Zmiana zaznaczenia: widok i jego renderer wykresu są usuwane (`dispose`).
   Moduł pozostaje w pamięci podręcznej. Viewport 3D nie jest odmontowywany,
   bo jest jeden.
6. Błąd ładowania modułu: węzeł ma stan `error` z akcją ponowienia. Reszta
   drzewa działa dalej.

## 6. Główny obszar i viewport 3D

- `viewport-main` zachowuje karty `3D Viewport | 2D View | Live Charts |
  Analysis`. Karta Analysis to host widoku zaznaczonego węzła, bez
  podzakładek.
- **Wizualizacja pola to wielkość głównego viewportu.** Moduł analizy nie
  ma własnego renderera 3D. Widok `field-3d` ustawia aktywną wielkość
  jedynego modułu `viewport-3d` na pole wyniku (np. `analysis:eigen:…`,
  rozpoznawane przez `isAnalysisFieldQuantityId`,
  `kernel/api/quantityIds.ts:259`). Używa przy tym tej samej ścieżki co
  `m` czy `H_eff`: `buildViewport3DFieldRenderModel`, plany per część
  magnetyczna, colorbar.
- **Jeden właściciel wielkości.** `visualization/state.quantity.active_quantity_id`
  niesie identyfikator pola modu, a jego parametry (faza harmoniczna, część
  zespolona, intencja punktu) są parametrami tej wielkości. Kontroler
  `AnalysisFieldOverlayController` przestaje być równoległym nadpisaniem
  (`useViewport3DSceneModel.ts:3060`, `2199-2270`) i staje się resolverem
  wielkości. Grupa Quantity w ribbonie oraz HUD viewportu pokazują wtedy
  „Mode m̃ · kᵧ … · f”, a wybór `m` opuszcza wizualizację modu (komenda
  `analysis.frequency-domain.clear-3d-overlay` już istnieje). Wygląd (kolor
  powierzchni, paleta, wektory) płynie przez ustawienia celu wizualizacji z
  specyfikacji 23, a nie przez `overlay.appearance`.
- Ułożenie `replace` to po prostu karta `3D Viewport` z modem jako wielkością.
  Ułożenia `below` i `beside` składają w karcie Analysis wykres źródłowy
  (`analysis-plots`) z tą samą instancją `viewport-3d`. `ViewportTabHost`
  dostaje tryb podziału, który przenosi tę instancję, zamiast tworzyć drugą.
  Ułożenie jest ustawieniem definicji węzła. Proporcja podziału jest
  preferencją użytkownika (`Resizable`, `autoSaveId`).
- Wykres źródłowy pokazuje przypięty punkt definicji. Kliknięcie innego punktu
  tworzy zaznaczenie chwilowe i nie zmienia przypiętej wizualizacji.
- Ochrona przed polem poprzedniego punktu pozostaje w
  `ModeFieldOverlayIntentController`.

## 7. Słownik stanów węzła

Jeden komponent stanu, używany przez drzewo, widok i Inspector:

| Stan | Źródło | Zachowanie |
|---|---|---|
| `loading` | `ResourceStatus`, ładowanie modułu | cel ładowania w treści; poprzednie dane nie są pokazywane jako bieżące |
| `partial` | `status`/`spectrum_completeness` zbioru | baner; serie nie są opisywane jako pełne pasma |
| `stale` | rewizja modelu ≠ rewizja wyniku | dane widoczne, akcja „Recompute” |
| `missing` | `missing_reason`, brak pola | brak danych jest pokazywany jako brak; nie jako zero ani zastępczy rysunek |
| `incompatible` | `binding = incompatible` | wskazanie niezgodnej tożsamości |
| `unsupported` | `unsupported_reason`, wersja definicji | kontrolka widoczna, nieaktywna, z powodem |
| `error` | błąd zasobu lub modułu | jedno zdanie w panelu; szczegóły w doku Diagnostics |

## 8. Trwałe definicje (nowy zasób)

```
GET    /v2/sessions/current/analysis/postprocessing/definitions?run_id=…
POST   /v2/sessions/current/analysis/postprocessing/definitions
PATCH  /v2/sessions/current/analysis/postprocessing/definitions/{definition_id}
DELETE /v2/sessions/current/analysis/postprocessing/definitions/{definition_id}
```

```ts
interface AnalysisDefinition {
  definition_id: string;
  revision: number;
  module_id: string;            // "analysis.dispersion"
  module_version: string;
  definition_schema: string;    // "analysis.dispersion.mode_visualization.v1"
  node_kind: AnalysisNodeKind;
  parent: { dataset_id: string; definition_id?: string };
  label: string;                // nadana przez użytkownika lub wygenerowana z danych
  data_ref: {                   // ADR 0029, bez indeksów
    run_id: string; dataset_id: string; dataset_revision: string;
    sample_id?: string; item_id?: string; branch_id?: string; field_id?: string;
  };
  settings: unknown;            // walidowane przez definition_schema
}
```

Zasób należy do rodziny `analysis` (ADR 0054, rozstrzygnięcie 1). Rodzina
`workspace` przechowuje układ i preferencje interfejsu, nie treść naukową.
Definicje są zapisywane razem z projektem (rodzina `persistence`) i nie
trafiają do `ProblemIR`. Zmiana
definicji jest transakcją z rewizją. Nieznany `definition_schema` lub
niezgodna wersja daje stan `unsupported` z powodem, bez cichej migracji.
Dopóki zasób nie istnieje, komendy tworzące węzły użytkownika są wyłączone z
powodem; definicji nie przechowuje się w `localStorage`.

## 9. Luki kontraktu do zamknięcia

| Luka | Dziś | Potrzebne |
|---|---|---|
| Kontekst k i role osi w manifeście zbioru | klasyfikacja w kliencie (ADR 0023) | `k_context` i `axes[].role` w `AnalysisResultDatasetManifestResource` publikowane przez backend; klasyfikator kliencki tylko dla starszych manifestów, ze stanem „legacy classification” |
| Mod jako wielkość viewportu | osobna nakładka nadpisująca wielkość | `active_quantity_id` z identyfikatorem pola modu i jego parametrami; wpisy w `visualizationQuantityItems` (`ObjectVisualizationPanelModel.ts:2242`) i w grupie Quantity ribbonu; colorbar i field-meta dla identyfikatorów `analysis:*` |
| Rodzaje produktów | `product_kind`: `modal_eigen`, `driven_response`, `time_domain_spectrum`, `dynamic_structure_factor` | rodzaje dla histerezy i transmisji, gdy backend je opublikuje |
| Referencje | `analytic_frequency_hz` jako kolumna CSV; punkty referencji dzielą `rowIndex` z policzonym wierszem (`frequencyDomainChartModels.ts:1135-1162`) | osobny zasób referencji z modelem, założeniami i zakresem ważności |
| Tracking gałęzi | typed results zwraca `tracking_score: None` | źródło score i statystyki overlap |
| Definicje użytkownika | `POSTPROCESSING_OWNER_CONTRACT_GAP` | zasób z §8 |

## 10. Reguły dla autorów modułów

- Tylko typowany klient i resource hooks; żadnego `fetch` w komponentach.
- Tylko wspólne renderery: `shared/analysis-charts` i jedyny `viewport-3d`.
- Bez fizyki w UI: referencje, Δf względem referencji z backendu i dopasowania
  pochodzą z zasobów.
- Tylko tokeny `--fm-*`; bez kolorów zapisanych w komponentach.
- Każdy rodzaj węzła ma własny zestaw sekcji Inspectora.
- Mod do gałęzi przypisuje tylko tracking z backendu, nigdy kolejność
  częstotliwości.

## 11. Bramki odbioru (wspólne dla modułów)

- Test modelu: reguły dopasowania dla zbiorów pasujących, niepasujących i bez
  modułu; brak surowych ID w etykietach.
- Test UI: zaznaczenie węzła ładuje moduł raz; zmiana zaznaczenia usuwa
  renderer wykresu.
- Przeglądarka (dla widoków `field-3d`): jeden canvas, kontekst WebGL nie
  utracony, niezerowy drawing buffer po wielokrotnym przełączaniu układów.
- Stabilność Inspectora zgodnie z regułami frontendu (bez remountu, z
  zachowaniem scrolla i fokusu).
- Testy jednostkowe uruchamiane w GitHub Actions.
- Kontrakt stylu z §12 sprawdzany testem projektu Inspectora
  (`modules/inspector/inspectorDesignSystemContract.test.ts`) dla wszystkich
  tras `analysis.*`.

## 12. Kontrakt stylu Inspectora

Wszystkie widoki Inspectora w drzewie wyników mają ten sam styl co Inspector
ferromagnetyka w drzewie modelu. Wzorcem jest Inspector wizualizacji obiektu:
`VisualizationTargetInspectorPanel`
(`modules/inspector/panels/ObjectVisualizationPanel.tsx:1127-1280`), oparty na
`InspectorOverviewFrame` (`modules/inspector/primitives/InspectorOverviewFrame.tsx`)
i stylach `design/styles/inspector-visualization.css`. Ten sam wzorzec
stosują już `MeshPartVisualizationPanel`, `AirboxVisualizationPanel` i
`FieldQuantityInspectorPanel`.

Układ każdej sekcji modułu, od góry:

1. `ScientificInspectorIdentity`: tytuł i dwie odznaki (rodzaj, rola).
2. Opcjonalna grupa „View” (np. 3D / planar).
3. `InspectorMetricStrip` z dokładnie czterema metrykami i tonem
   (`success`, `warning`, `degraded`, `danger`, `stale`).
4. Jedna główna karta (`fm-viz-display-card`) z ikoną lucide 18 px.
5. Sekcje nawigacyjne (`InspectorGroup variant="nav"`, `fm-viz-nav-sections`)
   z ikoną lucide 16 px w okrągłym polu, podsumowaniem po prawej i
   `ChevronRight`.
6. Opcjonalny blok „Needs a new computation” dla parametrów badania.
7. Zwinięty `ScientificInspectorContext`: Status, Physical properties,
   Provenance.

Kontrolki: tylko `FormField`, `InspectorPropertyRow`, `FieldRow`,
`NumberField`, `ColorField`, `VisualizationRadioGroup`, `Switch`,
`SegmentedControl` i `ScalarColorbarControl`. Żadnych surowych `<select>` ani
`<input>`. Edycje wyświetlania rejestrują sesję edycji
(`useRegisterInspectorEditSession("liveViewport")`), żeby Reset w stopce
działał.

**Wizualizacja modu kopiuje Inspector wizualizacji obiektu**, zamiast mieć
własny panel. Węzeł wizualizacji modu to cel wizualizacji z własnym
`VisualizationInspectorOwner` (identyfikator, tytuł, etykieta celu, opis).
Zachowuje sekcje: Display (chipy Visible / Bounds / Surface / Vectors,
kafelki trybu renderowania, „Quantity source” = mod), Surface coloring
(z `ScalarColorbarControl`), Vectors, Clipping & section, Camera & view.
Dochodzą tylko:

- w Surface coloring: część zespolona (Re / Im / |m̃| / arg) i składowa;
- sekcja nawigacyjna „Phase & animation” (ikona `Play`): faza harmoniczna,
  tempo odtwarzania z adnotacją, że tempo jest wizualne, a częstotliwość
  fizyczna się nie zmienia;
- sekcja „Layout” (zamiast / pod / obok wykresu).

Obecne `ModeVisualizationViewControls`
(`modules/inspector/panels/ModeVisualizationInspectorPanel.tsx:342-533`),
`FrequencyDomainModeDisplayControls` (14 wierszy z surowymi kontrolkami) i
grupa „Eigen Mode 3D Visualization” w `EigenModeInspectorPanel` są
zastępowane przez ten wzorzec.
