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
- „Add reference” tworzy węzeł referencji, a „Δf” dodaje drugi wykres.

## Kolejność wdrożenia i kryteria odbioru

Każdy etap kończy się osobnym commitem. Testy jednostkowe uruchamia GitHub
Actions (lokalny zakaz kompilacji testów obowiązuje).

### Etap 1 — rejestr modułów analizy (bez zmian w UI)

- Typy z spec 32 §2–4, rejestr manifestów obok `REGISTERED_MODULES`,
  funkcja dopasowania zbiorów.
- Odbiór: testy dopasowania dla zbiorów pasujących, niepasujących i bez
  modułu; manifest nie importuje kodu widoków (test importu).

### Etap 2 — generyczny builder drzewa

- `buildPhysicsFirstResultsTree` zastąpiony przez builder: zbiory ×
  manifesty × definicje. Istniejące rodzaje `results.dispersion.*`
  przechodzą do szablonów `analysis.dispersion`, z zachowaniem dedykowanych
  Inspectorów. Węzeł „Dataset · brak modułu analizy”.
- Odbiór: gałąź pojawia się wyłącznie dla opublikowanego i dopasowanego
  zbioru (brak pustej gałęzi Hysteresis); etykiety bez surowych ID;
  identyfikatory węzłów deterministyczne.

### Etap 3 — widok węzła zamiast podzakładek

- Karta Analysis renderuje widok zaznaczonego węzła; `AnalysisSurfaceTabs`
  wycofane; widoki modułu dyspersji jako pierwsze.
- Odbiór: zaznaczenie węzła ładuje moduł raz; zmiana zaznaczenia usuwa
  renderer wykresu (test lifecycle).

### Etap 4 — sekcje Inspectora i zakładki kontekstowe

- Katalog Inspectora przyjmuje sekcje modułów; ribbon dostaje zakładkę
  kontekstową; sekcje kernela Identity, State, Provenance.
- Odbiór: regresja stabilności Inspectora (bez remountu, z zachowaniem
  scrolla i fokusu); zakładka kontekstowa znika po wyjściu z węzłów modułu.

### Etap 5 — podział wykres + pole

- Tryb podziału w `ViewportTabHost` z tą samą instancją `viewport-3d`;
  ułożenie z definicji węzła.
- Odbiór w przeglądarce: dokładnie jeden canvas, kontekst WebGL nie utracony,
  niezerowy drawing buffer po wielokrotnym przełączaniu ułożeń; szybkie
  przełączanie wizualizacji kończy się polem ostatnio wybranego węzła.

### Etap 6 — trwałe definicje (backend + frontend)

- Zasób z spec 32 §8 w OpenAPI, zapis w projekcie, transakcje z rewizją.
  Komendy „Create mode visualization”, „Add reference”, „Save view”.
- Odbiór: definicja przetrwa ponowne otwarcie projektu; nieznany schemat daje
  `unsupported` z powodem; dane odwołują się do tożsamości z ADR 0029, nie do
  indeksów.

### Etap 7 — zasób referencji i porównania

- Referencja jako osobny zasób backendu z modelem, założeniami i zakresem
  ważności; status porównania liczony z metadanych; import COMSOL/CSV.
- Odbiór: bliskość krzywych nigdy nie daje statusu „matching”; punkt
  referencji nie wybiera modu.

### Etap 8 — kolejne moduły

- `analysis.resonance`, `analysis.time-domain`, a po publikacji odpowiednich
  `product_kind`: `analysis.hysteresis` i `analysis.transmission`.
- Odbiór: dodanie modułu nie wymaga zmian w builderze, katalogu Inspectora ani
  w kodzie ribbonu kernela.

## Otwarte decyzje

1. Czy zasób definicji należy do rodziny `analysis` (propozycja), czy
   `workspace`.
2. Czy `k_context` i role osi publikuje backend w manifeście zbioru
   (propozycja), czy klient nadal je klasyfikuje.
3. Czy istniejące rodzaje węzłów `results.dispersion.*` migrują od razu, czy
   przez warstwę zgodności na jeden etap.

## Poza zakresem

Solver, progi numeryczne, Docker i runner pozostają bez zmian.
