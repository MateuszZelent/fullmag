# Explorer wyników sterowany modułami analizy — plan

- Status: projekt do przeglądu; **nic nie jest wdrożone**
- Data: 2026-10-09
- Decyzja: [ADR 0054](../../../adr/0054-module-driven-results-explorer.md) (proposed)
- Kontrakt: [spec frontend-v2/32](../../../specs/frontend-v2/32-results-analysis-feature-modules.md)
- Katalog drzew: [01-explorer-tree-catalog.md](01-explorer-tree-catalog.md)
- Makieta: [mockups/results-workbench.html](mockups/results-workbench.html)

## Cel

Zakładka Analysis obsługuje wiele rodzajów analiz. Nie może mieć stałych
podzakładek ani stałego drzewa wyników. Interfejs ma powstawać z tego, co
badanie opublikowało: Explorer pokazuje węzły modułów pasujących do danych.
Kliknięcie węzła ładuje moduł, który dokłada główny widok, sekcje Inspectora
i kontekstową zakładkę ribbonu, tak jak w COMSOL-u.

## Uwagi z przeglądu (2026-10-09)

1. **Bez nowego silnika renderowania.** Wizualizacja modu używa dokładnie
   tego samego głównego modułu viewportu. Zmienia się tylko wielkość
   (quantity): zamiast `m` viewport pokazuje mod. Dziś mod jest osobną
   nakładką nadpisującą wielkość, więc ribbon może pokazywać `M`, gdy
   viewport rysuje mod. Plan to naprawia: jeden właściciel
   `active_quantity_id` (spec 32 §6).
2. **Jeden styl Inspectorów.** Wszystkie widoki Inspectora w drzewie wyników
   mają styl Inspectora ferromagnetyka z drzewa modelu. Inspector
   wizualizacji modu kopiuje Inspector wizualizacji obiektu
   (`VisualizationTargetInspectorPanel`): ten sam układ, ikony, chipy warstw,
   kafelki trybu renderowania, `ScalarColorbarControl`, sesja edycji. Dochodzą
   tylko część zespolona i składowa, faza i animacja oraz ułożenie (spec 32 §12).

Obecny Inspector modu odbiega od wzorca. Nie ma ramy przeglądu, paska metryk,
głównej karty ani sekcji nawigacyjnych. Używa surowych `<select>` i `<input>`,
nie ma ikon, ma własną rampę kolorów zamiast `ScalarColorbarControl` i nie
rejestruje sesji edycji, więc Reset i Apply w stopce nie działają
(`ModeVisualizationInspectorPanel.tsx:342-533`,
`FrequencyDomainModeDisplayControls.tsx:387-655`,
`frequency-domain/EigenModeInspectorPanel.tsx:262-310`).

## Diagnoza (stan na `92a5fc689`, `apps/control-room/src`)

| Obszar | Kod | Problem |
|---|---|---|
| Drzewo wyników | `modules/explorer/builders/resultsExplorerNodes.ts:1090` | stałe gałęzie Dynamics, Resonance & FMR, Dispersion, Hysteresis (pusta) |
| Analysis | `modules/analysis-plots/components/AnalysisSurfaceTabs.tsx:5-24` | pięć stałych powierzchni i stałe podwidoki |
| Inspector | `modules/inspector/inspectorRouteCatalog.tsx:630` | statyczny katalog tras budowany przy imporcie |
| Ribbon | `modules/ribbon/ribbonContributions.tsx:663-735` | stała zakładka Results; `Add Dispersion`, `Add Modes`, `Chart` wyłączone |
| Węzły użytkownika | `shared/domain/analysis/postprocessingDefinitions.ts:22-23,70` | `PostprocessingDefinition` istnieje, ale bez trwałego właściciela |
| Środek ekranu | `kernel/layout/ViewportTabHost.tsx:24-84` | montuje jedną powierzchnię naraz; wykres i pole 3D się wykluczają |
| Referencje | `shared/domain/analysis/frequencyDomainChartModels.ts:1135-1162` | punkty referencji dzielą `rowIndex` z policzonym wierszem |
| Manifest modułu | `kernel/types.ts:54-69` | `component` już ładowany leniwie; `contributes` obsługuje tylko komendy |
| Mod w viewporcie | `useViewport3DSceneModel.ts:3060`, `2199-2270` | mod jest nakładką nadpisującą wielkość, nie wielkością; HUD pokazuje tylko tekst wielkości (`Viewport3DModule.tsx:2646`) |
| Inspector modu | `ModeVisualizationInspectorPanel.tsx:342-533` | inny styl niż Inspector wizualizacji obiektu (patrz wyżej) |

## Co zostaje, co się zmienia

**Zostaje:** jeden workspace i slot `viewport-main`, karty `3D Viewport`,
`2D View`, `Live Charts` i `Analysis`, jeden moduł `viewport-3d`, wspólny
renderer wykresów (`shared/analysis-charts`), selekcja w kernelu, typowany
katalog zbiorów (`analysis/results/runs/{run_id}/datasets/...`), kontroler
intencji pola modu z ochroną tożsamości, kontrolki fazy z tempem animacji
oddzielonym od częstotliwości fizycznej, tokeny `--fm-*`.

**Zmienia się:**

- builder drzewa wyników staje się generyczny: zbiory × manifesty modułów ×
  trwałe definicje;
- karta Analysis pokazuje widok zaznaczonego węzła, bez podzakładek;
- `ModuleManifest.contributes` rozszerzony o moduły analizy (spec 32 §2–4);
- katalog Inspectora przyjmuje sekcje z modułów obok sekcji kernela
  (Identity, State, Provenance);
- ribbon dostaje zakładki kontekstowe z modułów;
- `ViewportTabHost` dostaje tryb podziału, który przenosi tę samą instancję
  viewportu (bez drugiego kontekstu WebGL);
- nowy zasób trwałych definicji postprocessingu (backend + OpenAPI).

## Makieta

`mockups/results-workbench.html` to samodzielny plik HTML. Otwiera się
lokalnie, bez sieci i bez budowania aplikacji. Interfejs w makiecie jest
generowany z danych, a nie rysowany ręcznie:

- manifesty pięciu modułów (`analysis.dispersion`, `analysis.resonance`,
  `analysis.hysteresis`, `analysis.transmission`, `analysis.time-domain`) są
  oceniane względem opublikowanego zbioru pilota; pasuje tylko dyspersja,
  pozostałe pokazują powód braku dopasowania;
- pierwsze zaznaczenie węzła dyspersji symuluje leniwe ładowanie modułu;
  dopiero wtedy pojawia się zakładka kontekstowa „Dispersion” i sekcje
  modułu w Inspectorze (każda sekcja ma znacznik „kernel” lub „module”);
- kliknięcie punktu wykresu tworzy zaznaczenie chwilowe; „Create mode
  visualization” tworzy węzeł w `Mode visualizations`, z ułożeniem
  zamiast / pod / obok wykresu;
- wizualizacja modu to główny viewport z wielkością „Mode m̃”: HUD i grupa
  Quantity w ribbonie pokazują mod, a ułożenie „zamiast” to po prostu karta
  3D Viewport;
- każdy Inspector ma układ Inspectora wizualizacji ferromagnetyka: pasek
  czterech metryk, jedna główna karta, sekcje nawigacyjne z ikonami,
  zwinięty kontekst i stopka akcji; Inspector modu ma chipy warstw, kafelki
  trybu renderowania i działający Reset;
- „Add reference” tworzy nakładkę referencji z panelem porównania metadanych
  („Different assumptions”); „Δf vs reference” dodaje wykres odchyłki;
- „Iso-frequency contour” i import COMSOL/CSV są wyszarzone z powodem.

Ograniczenia makiety:

- Częstotliwości pochodzą z pilota FEM (`selected_only`). Wartości referencji
  otwartego filmu policzono ze wzoru Kalinikosa–Slavina n=0 wyłącznie na
  potrzeby makiety. W produkcji pochodzą z zasobu backendu.
- Pole 3D jest schematem z napisem „SCHEMATIC — NOT FIELD DATA”.
- Definicje są trzymane w pamięci strony. W produkcji wymagają zasobu z
  spec 32 §8. Do tego czasu tworzenie węzłów użytkownika ma być niedostępne.
- Identyfikatory provenance są wypełniaczami (`[run_id]` itp.).

Sprawdzone w przeglądarce (2026-10-09, lokalny serwer na `127.0.0.1`):

- przed zaznaczeniem nie ma zakładki kontekstowej;
- po zaznaczeniu „Dispersion relation” moduł się ładuje, pojawia się zakładka
  „Dispersion” i siedem punktów wykresu;
- „Create mode visualization” jest nieaktywne bez punktu i aktywne po
  kliknięciu punktu; po utworzeniu jest jeden panel 3D, a zmiana ułożenia
  działa;
- „Add reference” tworzy węzeł referencji, a „Δf” dodaje drugi wykres;
- po przebudowie Inspectora: pasek metryk, karta Display z czterema chipami
  i czterema kafelkami, sześć sekcji nawigacyjnych i kontekst; chip Vectors
  zmienia opis wielkości w HUD; Reset przywraca ustawienia; ułożenie
  „replace” przełącza na kartę 3D Viewport; bez błędów JavaScript.

## Kolejność wdrożenia i kryteria odbioru

Każdy etap kończy się osobnym commitem. Testy jednostkowe uruchamia GitHub
Actions (lokalny zakaz kompilacji testów obowiązuje).

### Etap 1 — rejestr modułów analizy (bez zmian w UI)

Stan: **wdrożone w źródłach** (`apps/control-room/src/kernel/analysis-modules/`,
`modules/analysis-{dispersion,resonance,time-domain}/`). Dopasowanie korzysta z
ról osi, które backend już publikuje (`wavevector`, `spectral`,
`outer_sweep`) i z ich liczebności: ścieżka k (≥ 2 wartości osi
`wavevector`) → dyspersja; brak osi k lub jedna wartość → rezonans. Testy:
`analysisDatasetMatching.test.ts`, uruchamiane w GitHub Actions. Lokalnie:
typecheck nowych plików i ESLint bez uwag. Moduły histerezy i transmisji nie
są zarejestrowane, dopóki backend nie publikuje ich `product_kind`.

- Typy z spec 32 §2–4, rejestr manifestów obok `REGISTERED_MODULES`,
  funkcja dopasowania zbiorów.
- Odbiór: testy dopasowania dla zbiorów pasujących, niepasujących i bez
  modułu; manifest nie importuje kodu widoków (test importu).

### Etap 2 — generyczny builder drzewa

Stan: **część 2a wdrożona w źródłach.** `buildPhysicsFirstResultsTree` nie tworzy
już pustych rodzin: Dynamics, Resonance & FMR i Dispersion pojawiają się
tylko z opublikowanymi danymi (Dynamics także w trakcie ładowania), a stała
pusta gałąź Hysteresis zniknęła. Rodziny niosą `analysisModuleId` modułu
właściciela. Część 2b (węzły z katalogu zbiorów × szablony manifestów, aliasy
`results.dispersion.*`) pozostaje do zrobienia.

- `buildPhysicsFirstResultsTree` zastąpiony przez builder: zbiory ×
  manifesty × definicje. Istniejące rodzaje `results.dispersion.*`
  przechodzą do szablonów `analysis.dispersion`, z zachowaniem dedykowanych
  Inspectorów. Węzeł „Dataset · brak modułu analizy”.
- Odbiór: gałąź pojawia się wyłącznie dla opublikowanego i dopasowanego
  zbioru (brak pustej gałęzi Hysteresis); etykiety bez surowych ID;
  identyfikatory węzłów deterministyczne.

### Etap 3 — widok węzła zamiast podzakładek

Stan: **część 3a wdrożona w źródłach.** Zaznaczenie węzła wyników wybiera
widok Analysis modułu-właściciela (`kernel/analysis-modules/analysisSurfaceRouting.ts`,
przez aliasy z etapu 2b): dyspersja → Dispersion, rezonans → Resonance & FMR,
migawki → Dynamics. Podzakładki zostają przejściowo jako nawigacja
pomocnicza. Część 3b (usunięcie podzakładek i widoki dostarczane przez moduły)
wymaga równoległej zmiany smoke testów przeglądarkowych.
Część 3b jest **zablokowana przez etap 8**: powierzchnie Comparison i
Hysteresis nie mają jeszcze węzłów w drzewie wyników (Hysteresis dostanie je
z modułem `analysis.hysteresis`, gdy backend opublikuje jego `product_kind`).
Usunięcie podzakładek wcześniej odcięłoby te powierzchnie.

- Karta Analysis renderuje widok zaznaczonego węzła; `AnalysisSurfaceTabs`
  wycofane; widoki modułu dyspersji jako pierwsze.
- Odbiór: zaznaczenie węzła ładuje moduł raz; zmiana zaznaczenia usuwa
  renderer wykresu (test lifecycle).

### Etap 4 — Inspectory w stylu ferromagnetyka i zakładki kontekstowe

Stan: **część 4a wdrożona w źródłach.** Inspector wizualizacji modu
(`object.mode_visualization`) to teraz `VisualizationTargetInspectorPanel` z
właścicielem „Mode visualization”: te same sekcje Display, Surface coloring,
Vectors, ikony i sesja edycji co Inspector ferromagnetyka. Dochodzą tylko
sekcje nav „Complex representation” i „Phase & animation”. Stare „Render
controls” (`FrequencyDomainModeDisplayControls`) zniknęły z tej trasy.
Część 4b: zakładka kontekstowa ribbonu (np. „Dispersion”) pojawia się po
zaznaczeniu węzła modułu analizy, obok Results; to stan lokalny ribbonu, więc
lewy panel zostaje przy nawigatorze wyników. Zawiera tylko działające komendy:
wykres / pole 3D w głównym obszarze, zatrzymanie animacji, wyjście z widoku
modu. Pozostaje: rama dla pozostałych Inspectorów wyników i rozszerzenie
testu kontraktu projektu.

- Kernel składa treść modułu w ramę z spec 32 §12 (identyfikacja, pasek
  czterech metryk, główna karta, sekcje nawigacyjne, kontekst, stopka).
  Ribbon dostaje zakładkę kontekstową.
- Inspector wizualizacji modu powstaje jako kolejny właściciel
  `VisualizationTargetInspectorPanel`, a nie osobny panel.
  `ModeVisualizationViewControls`, `FrequencyDomainModeDisplayControls` i
  grupa 3D w `EigenModeInspectorPanel` są usuwane.
- Odbiór:
  - test kontraktu projektu (`inspectorDesignSystemContract.test.ts`)
    rozszerzony na wszystkie trasy `analysis.*`: rama przeglądu, dokładnie
    cztery metryki, jedna główna karta, brak surowych `<select>` / `<input>`;
  - zrzut porównawczy: Inspector wizualizacji modu i Inspector wizualizacji
    ferromagnetyka mają te same sekcje wspólne, ikony i odstępy;
  - Reset w stopce działa dla wizualizacji modu;
  - regresja stabilności Inspectora (bez remountu, z zachowaniem scrolla i
    fokusu); zakładka kontekstowa znika po wyjściu z węzłów modułu.

### Etap 5 — mod jako wielkość głównego viewportu i podział wykres + pole

Stan: **część 5a wdrożona w źródłach.** Gdy mod jest pokazywany, grupa
Quantity w ribbonie nie oznacza już `M` jako aktywnej, tylko pokazuje aktywną
pozycję „Mode” z opisem modu. Wybór innej wielkości (`m`, `H_eff`, …) opuszcza
wizualizację modu. HUD viewportu pokazuje „Mode · …” zamiast surowego
identyfikatora pola. Smoke przeglądarkowy viewportu: **NOT VERIFIED** (brak
zbudowanego workspace w tym worktree). Pozostaje: jeden właściciel
`active_quantity_id` (nakładka jako resolver wielkości), colorbar/field-meta
dla `analysis:*`.

Część 5c: **zamknięta decyzją.** Zapisane `active_quantity_id` zostaje
wielkością modelu, bo runner strumieniuje według niego pola na żywo; pokazywaną
wielkość (mod) wylicza się z nakładki, która jest jedynym właścicielem pola
modu. Ribbon, HUD, Inspector obiektu i viewport są z nią spójne (5a i poprawka
`18c151c67`). Szczegóły: spec 32 §6.

Część 5b: tryb podziału w `ViewportTabHost`. Układ ma opcjonalny
`viewportCompanion` (moduł i ułożenie obok/pod). Host renderuje wtedy aktywny
moduł i towarzyszący w regulowanym podziale; każdy moduł ma jedną instancję,
a wybranie towarzyszącego jako aktywnego zamyka podział. Zakładka kontekstowa
ma akcję „Chart + 3D”.

- `active_quantity_id` niesie identyfikator pola modu; kontroler nakładki
  staje się resolverem wielkości; mod w grupie Quantity ribbonu i w HUD;
  colorbar i field-meta dla `analysis:*`. Bez nowego renderera.
- Tryb podziału w `ViewportTabHost` z tą samą instancją `viewport-3d`;
  ułożenie z definicji węzła; ułożenie „zamiast” to karta 3D Viewport.
- Odbiór:
  - ribbon, HUD i viewport zawsze pokazują tę samą wielkość; wybór `m`
    opuszcza wizualizację modu;
  - w przeglądarce dokładnie jeden canvas, kontekst WebGL nie utracony,
    niezerowy drawing buffer po wielokrotnym przełączaniu ułożeń i wielkości;
  - szybkie przełączanie wizualizacji kończy się polem ostatnio wybranego
    węzła (istniejąca ochrona tożsamości).

### Etap 6 — trwałe definicje (backend + frontend)

Stan: **wdrożone w źródłach, CI zielone** (`rust-contracts`,
`generated-api-determinism`, `control-room-contracts`). Zasób
`/v2/sessions/current/analysis/postprocessing/definitions` (list/get/create/
patch/delete, rewizja sceny) zapisuje definicje w opcjonalnej sekcji
`analysis` dokumentu sceny, więc są zapisywane i odtwarzane z projektem, nie
trafiają do skryptu ani fizyki. Walidacja: unikalne id, `node_kind` należący
do modułu, opublikowana tożsamość danych, brak cykli rodziców; zmiana
właściciela i usunięcie rodzica z dziećmi są odrzucane. W UI: „Pin mode
visualization” na węźle modu, grupa „Pinned visualizations” w rodzinie
modułu (węzły są kopiami opublikowanych węzłów modu; nieopublikowane pole
zostaje widoczne jako niedostępne) i „Remove pinned visualization”.
Ograniczenie: ponowny import skryptu, który tworzy nowy dokument sceny,
nie przenosi definicji.

- Zasób z spec 32 §8 w OpenAPI, zapis w projekcie, transakcje z rewizją.
  Komendy „Create mode visualization”, „Add reference”, „Save view”.
- Odbiór: definicja przetrwa ponowne otwarcie projektu; nieznany schemat daje
  `unsupported` z powodem; dane odwołują się do tożsamości z ADR 0029, nie do
  indeksów.

### Etap 7 — zasób referencji i porównania

Stan: **częściowo wdrożone.** Punkty referencji nie wybierają już
policzonego modu. Import COMSOL/CSV w Inspectorze relacji dyspersji
(jawne mapowanie kolumn i jednostek na SI) zapisuje referencję jako
definicję postprocessingu; wykres dyspersji rysuje ją jako serię
referencyjną. Pierwsza kolumna jest czytana jako współrzędna ścieżki
wykresu, bo punkty dyspersji w tym branchu nie mają wektora k. Pozostaje:
backendowy zasób referencji analitycznej z modelem i zakresem ważności oraz
status porównania liczony z metadanych.

- Referencja jako osobny zasób backendu z modelem, założeniami i zakresem
  ważności; status porównania liczony z metadanych; import COMSOL/CSV.
- Odbiór: bliskość krzywych nigdy nie daje statusu „matching”; punkt
  referencji nie wybiera modu.

### Etap 8 — kolejne moduły

- `analysis.resonance`, `analysis.time-domain`, a po publikacji odpowiednich
  `product_kind`: `analysis.hysteresis` i `analysis.transmission`.
- Odbiór: dodanie modułu nie wymaga zmian w builderze, katalogu Inspectora ani
  w kodzie ribbonu kernela.

## Rozstrzygnięcia

Szczegóły i uzasadnienie: ADR 0054, sekcja „Rozstrzygnięcia”.

1. Zasób definicji należy do rodziny `analysis` i jest zapisywany z
   projektem. `workspace` zostaje dla układu i preferencji interfejsu.
2. `k_context` i role osi publikuje backend w manifeście zbioru. Klasyfikator
   kliencki zostaje tylko dla starszych manifestów, z widocznym stanem.
3. Migracja moduł po module, dyspersja pierwsza, z aliasami
   `results.dispersion.*` → `analysis.dispersion.*` przez jeden etap.

## Poza zakresem

Solver, progi numeryczne, Docker i runner pozostają bez zmian.
