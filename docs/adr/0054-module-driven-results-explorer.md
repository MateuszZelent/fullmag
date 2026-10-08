# ADR 0054: Explorer wyników sterowany modułami analizy

- Status: proposed
- Data: 2026-10-09
- Powiązane: ADR 0013, ADR 0022, ADR 0023, ADR 0029, ADR 0035 (typed study artifact manifest)
- Specyfikacja: [frontend-v2/32 — Moduły analizy wyników](../specs/frontend-v2/32-results-analysis-feature-modules.md)
- Plan: [module-driven-results-explorer](../plans/active/module-driven-results-explorer/README.md)

## Kontekst

Zakładka Analysis obsługuje wiele rodzajów analiz: dyspersję, FMR i odpowiedź
wymuszoną, histerezę, transmisję oraz analizę czasową. Dziś interfejs wyników
jest zaszyty na sztywno w czterech miejscach (stan sprawdzony w
`apps/control-room/src` na `92a5fc689`):

| Miejsce | Stan | Skutek |
|---|---|---|
| Drzewo wyników | `buildPhysicsFirstResultsTree` (`modules/explorer/builders/resultsExplorerNodes.ts:1090`) zawsze tworzy `Dynamics`, `Resonance & FMR`, `Dispersion & k-resolved response`, `Hysteresis` (ta ostatnia z `[]`) | gałęzie istnieją niezależnie od tego, co policzono; nowa analiza wymaga zmiany buildera |
| Główny widok | `AnalysisSurfaceTabs.tsx:5-24` ma pięć stałych powierzchni i stałe podwidoki | Analysis to zestaw zakładek, a nie widok zaznaczonego węzła |
| Inspector | statyczny katalog `INSPECTOR_ROUTE_CONTRIBUTIONS` (`modules/inspector/inspectorRouteCatalog.tsx:630`) | każdy nowy rodzaj węzła to edycja centralnego katalogu |
| Ribbon | stała `resultsTab` (`modules/ribbon/ribbonContributions.tsx:663-735`); `Add Dispersion`, `Add Modes`, `Chart` są wyłączone | brak kontekstowych narzędzi dla zaznaczonego wyniku |

Do tego węzły tworzone przez użytkownika (`PostprocessingDefinition`,
`shared/domain/analysis/postprocessingDefinitions.ts:70`) nie mają trwałego
właściciela. Kod opisuje to stałą `POSTPROCESSING_OWNER_CONTRACT_GAP`, a ADR
0023 (`:71-74`) wstrzymuje je do czasu zatwierdzenia zasobu.

COMSOL nie buduje osobnego interfejsu dla każdej analizy. Badanie tworzy
zbiory danych, a użytkownik dodaje pod `Results` grupy wykresów i ich cechy.
Zaznaczony węzeł decyduje o oknie `Settings`, o `Graphics` i o kontekstowej
zakładce ribbonu.

## Decyzja

1. **Explorer buduje interfejs wyników.** Zaznaczony węzeł wyników wyznacza
   główny widok w slocie `viewport-main`, sekcje Inspectora oraz kontekstową
   zakładkę ribbonu. Zakładka Analysis nie ma własnych podzakładek: pokazuje
   widok zaznaczonego węzła.
2. **Węzły powstają z opublikowanych danych.** Badanie publikuje zbiory
   danych (`AnalysisResultDatasetManifestResource`: `product_kind`,
   `item_kinds`, `axes`, `capabilities`, `projections`, `status`). Moduły
   analizy deklarują, które zbiory obsługują. Gałąź wyników powstaje tylko
   wtedy, gdy opublikowany zbiór pasuje do modułu. Obecność zasobu bez
   publikacji niczego nie aktywuje (zasada z
   `frequency-domain-results-product-projection-v1.md:9-11` pozostaje).
3. **Moduły analizy to wtyczki ładowane leniwie.** Każdy moduł ma manifest z
   samymi metadanymi (reguły dopasowania, szablony węzłów), ładowany przy
   starcie. Kod widoków, sekcji Inspectora i grup ribbonu ładuje się dopiero
   po rozwinięciu lub zaznaczeniu węzła tego modułu. Kontrakt definiuje
   specyfikacja 32.
4. **Węzły użytkownika są trwałe i należą do modułów.** Wizualizacja modu
   przypięta do punktu wykresu, nakładka referencji, import COMSOL/CSV i
   zapisany widok to definicje postprocessingu z polami `module_id`,
   `module_version` i `definition_schema`. Zapisuje je nowy zasób w rodzinie
   `analysis` (właściciel opisany w specyfikacji 32), z rewizją i z
   tożsamością danych według ADR 0029 (`dataset_id`, `sample_id`, `item_id`,
   `branch_id`), nigdy po indeksach.
5. **Wizualizacje modów należą do `Results`.** Wizualizacja pola modu jest
   dzieckiem węzła analizy, z którego pochodzi (np. `Dispersion › Mode
   visualizations`), a nie węzłem `Model › Objects › Visualization`.
6. **Moduły składają gotowe klocki.** Wykres (wspólny renderer ECharts z
   `shared/analysis-charts`), mapa 2D, tabela i wizualizacja pola w jedynym
   module `viewport-3d`. Moduł nie wywołuje `fetch`, nie tworzy własnego
   kontekstu WebGL i nie liczy fizyki. Referencje analityczne i dane
   porównawcze pochodzą z zasobów backendu.
7. **Zbiór bez modułu jest widoczny.** Taki zbiór pokazuje się jako
   „Dataset · brak modułu analizy” z widokiem tabeli i powodem. Nie znika z
   drzewa.
8. **Mod to wielkość głównego viewportu, nie osobny silnik.** Wizualizacja
   modu używa tego samego modułu `viewport-3d` i tej samej ścieżki
   renderowania co pola modelu. Zaznaczenie węzła wizualizacji ustawia
   aktywną wielkość viewportu na pole modu (np. `analysis:eigen:…`), tak jak
   wybór `m` czy `H_eff`. Dziś mod jest osobną nakładką
   (`AnalysisFieldOverlayController`) nadpisującą wielkość
   (`useViewport3DSceneModel.ts:3060`, `2199-2270`). Przez to ribbon może
   pokazywać `M`, gdy viewport rysuje mod. Docelowo jest jeden właściciel:
   `active_quantity_id` niesie identyfikator pola modu, a kontroler nakładki
   staje się resolverem tej wielkości (faza, widok, intencja), a nie drugim
   stanem. Wybór innej wielkości opuszcza wizualizację modu.
9. **Jeden styl Inspectora dla całego drzewa.** Każdy widok Inspectora w
   drzewie wyników używa wzorca Inspectora wizualizacji ferromagnetyka z
   drzewa modelu (`VisualizationTargetInspectorPanel` w
   `modules/inspector/panels/ObjectVisualizationPanel.tsx:1127`, na
   `InspectorOverviewFrame`). Wizualizacja modu kopiuje ten Inspector
   dosłownie: te same sekcje, chipy warstw, kafelki trybu renderowania,
   kolorowanie powierzchni przez `ScalarColorbarControl`, ikony lucide i
   sesję edycji (Reset w stopce). Dochodzą tylko sekcje specyficzne dla modu:
   część zespolona i składowa (w kolorowaniu powierzchni) oraz faza i
   animacja. Szczegóły: specyfikacja 32 §12.

### Rozstrzygnięcia (2026-10-09)

1. **Właściciel definicji: rodzina API `analysis`, zapis z projektem.**
   Definicje opisują postprocessing wyników, więc należą do `analysis` (ta
   sama rodzina co katalog zbiorów). Rodzina `workspace` przechowuje układ i
   preferencje interfejsu, a nie treść naukową projektu. Definicje są
   zapisywane razem z projektem przez `persistence`. Nie trafiają do
   `ProblemIR`, bo nie zmieniają fizyki.
2. **Kontekst k i role osi publikuje backend.** Manifest zbioru dostaje
   `k_context` i `axes[].role`. Dopasowanie modułów działa wyłącznie na
   polach manifestu (fail-closed, bez parsowania etykiet). Obecny
   klasyfikator kliencki z ADR 0023 zostaje tylko dla starszych manifestów,
   ze stanem „legacy classification” widocznym w Inspectorze. Usuwamy go,
   gdy backend publikuje nowe pola dla wszystkich produktów.
3. **Migracja przez jedną warstwę zgodności, moduł po module.** Dyspersja
   migruje pierwsza. Stare rodzaje `results.dispersion.*` są aliasami nowych
   `analysis.dispersion.*` przez jeden etap, żeby zachować trasy Inspectora,
   zapisane zaznaczenia i testy. Alias usuwamy w następnym etapie. Nie
   robimy migracji wszystkich analiz naraz.

## Zmiana wcześniejszych decyzji

| Dokument | Fragment | Zmiana |
|---|---|---|
| ADR 0023 | `:53-54` stabilne powierzchnie Analysis | zastąpione przez widok zaznaczonego węzła |
| ADR 0023 | `:71-74` brak właściciela definicji | właściciela określa specyfikacja 32; do wdrożenia zasobu węzły użytkownika pozostają niedostępne z jawnym powodem |
| `docs/specs/frequency-domain-results-product-projection-v1.md` | `:219-221` nowy produkt wymaga osobnych węzłów w builderze | nowe produkty dostają węzły przez manifest modułu; zamknięta unia w builderze zostaje wycofana |
| `docs/plans/active/dynamics-analysis-interface-comsol-inspired/02-target-interface-contract.md` | `:134-180` statyczna hierarchia | zastąpiona szablonami węzłów modułów |
| tamże `03-schematics.md` | `:174-199` wizualizacja modu pod `Model › Objects` | przeniesiona pod węzeł analizy w `Results` |
| ADR 0023 | jeden `Active Analysis Overlay` (`:55`) jako stan obok wielkości | mod staje się aktywną wielkością viewportu; nakładka jest jej resolverem |
| `docs/plans/active/2026-07-25-analysis-workbench-refactor.md` | etap 6, stałe zakładki workbench | zastąpione widokiem zaznaczonego węzła; renderer, plan danych i eksport zostają |

Niezmienione invariants: jeden typowany klient API, jedna warstwa resource
hooks, jedna selekcja, jeden Inspector, jeden viewport 3D dla FDM i FEM,
rozdział requested intent i resolved execution, granica live charts / analysis
z ADR 0022.

## Konsekwencje

- Nowa analiza (np. transmisja) to nowy moduł z manifestem, bez zmian w
  builderze drzewa, katalogu Inspectora i stałej zakładce ribbonu.
- Builder drzewa wyników staje się generyczny: zbiory × manifesty × trwałe
  definicje. Istniejące rodzaje węzłów `results.dispersion.*` migrują do
  modułu `analysis.dispersion` z zachowaniem dedykowanych Inspectorów
  (reguła: każdy semantyczny węzeł ma własny widok Inspectora).
- Potrzebny jest nowy zasób definicji postprocessingu (backend + OpenAPI).
  Do tego czasu tworzenie węzłów użytkownika jest niedostępne z jawnym
  powodem, a nie symulowane w stanie przeglądarki.
- Ryzyko: rozjazd wersji modułu i zapisanej definicji. Definicja niesie
  `module_version` i `definition_schema`. Nieobsługiwana wersja daje stan
  `unsupported` z powodem, bez cichej migracji.

## Stan

Decyzja jest propozycją do przeglądu. Nic z niej nie jest wdrożone.
Interaktywna makieta w planie służy wyłącznie ocenie i nie jest kodem
produkcyjnym.
