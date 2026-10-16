# Źródłowe triage 40 ostrzeżeń performance React Doctor

Oceniono 40 pozycji performance z body agregatu React Doctor dla PR #97. Historyczny kod pochodzi z rewizji b34953c8616684901c187b368b1d1c069b5fd43f; stan bieżący sprawdzono na exact bazie ledgeru 152ad2e1fe7830536bd195db73c396f9f6ac5121. Dla wszystkich 40 wskazań historyczna treść linii jest identyczna z dopasowaną linią w obecnym snapshotcie. Przesunięcia numerów wynikają z późniejszych wstawek.

Pełne pięcioliniowe konteksty historyczne i bieżące, hashe źródeł, mapowanie linii, reguła oraz rationale każdej pozycji są w 2026-10-16-react-doctor-performance-triage-evidence.json. Inventory klasyfikował te ostrzeżenia jako pending_source_review; brak wpisu w ledgerze nie jest traktowany jako dowód nieszkodliwości.

## Wynik

| Disposition | Liczba |
|---|---:|
| sequential_required | 19 |
| superseded | 1 |
| unresolved | 3 |
| valid_candidate | 17 |

valid_candidate to ograniczony kierunek do sprawdzenia, nie potwierdzony bottleneck ani zmierzona poprawa. W kilku miejscach bezpieczniejszy kierunek to jeden page.evaluate zachowujący wspólną chwilę odczytu, a nie Promise.all trzech wywołań na tym samym page. sequential_required obejmuje obserwację zdarzeń/stanu, granice przed–po, odczekiwanie na UI, serialne garbage collection i cleanup. unresolved wymaga pomiaru lub dodatkowego kontraktu. superseded oznacza tu wyłącznie stałą pętlę długości jeden.

## Rozkład według reguły

| Reguła | Liczba | Kandydat | Wymagana sekwencja | Superseded | Nierozstrzygnięte |
|---|---:|---:|---:|---:|---:|
| async-await-in-loop | 17 | 2 | 13 | 1 | 1 |
| async-parallel | 4 | 3 | 1 | 0 | 0 |
| js-set-map-lookups | 2 | 0 | 0 | 0 | 2 |
| server-sequential-independent-await | 17 | 12 | 5 | 0 | 0 |

## Wyłączenia zakresu

| Pozycja | Reguła | Stan inventory | Powód |
|---|---|---|---|
| apps/control-room/src/modules/inspector/panels/analysis-results/PinnedVisualizationsInspectorPanel.tsx:41 | no-high-complexity-react-function | covered_by_inline_review_and_later_source_change | Poza 40 performance. Cztery wpisy są oznaczone w inventory jako covered_by_inline_review_and_later_source_change; EigenDispersion L24 complexity pozostaje wyłączony z tej triage zgodnie z poleceniem rodzica. |
| apps/control-room/src/modules/inspector/panels/frequency-domain/EigenBranchInspectorPanel.tsx:68 | only-export-components | covered_by_inline_review_and_later_source_change | Poza 40 performance. Cztery wpisy są oznaczone w inventory jako covered_by_inline_review_and_later_source_change; EigenDispersion L24 complexity pozostaje wyłączony z tej triage zgodnie z poleceniem rodzica. |
| apps/control-room/src/modules/inspector/panels/frequency-domain/EigenBranchInspectorPanel.tsx:102 | only-export-components | covered_by_inline_review_and_later_source_change | Poza 40 performance. Cztery wpisy są oznaczone w inventory jako covered_by_inline_review_and_later_source_change; EigenDispersion L24 complexity pozostaje wyłączony z tej triage zgodnie z poleceniem rodzica. |
| apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.tsx:24 | no-high-complexity-react-function | pending_source_review | Jedyny EigenDispersion complexity warning został jawnie pominięty w tym zadaniu. |
| apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.tsx:205 | only-export-components | covered_by_inline_review_and_later_source_change | Poza 40 performance. Cztery wpisy są oznaczone w inventory jako covered_by_inline_review_and_later_source_change; EigenDispersion L24 complexity pozostaje wyłączony z tej triage zgodnie z poleceniem rodzica. |

## Mapa 40 pozycji

| ID | Reguła | Linia historyczna → bieżąca | Bieżący symbol | Disposition | Ocena źródłowa |
|---|---|---|---|---|---|
| W01 | lookup w tablicy | apps/control-room/scripts/audit-chart-performance.mjs:384 → 384 | page.addInitScript / PerformanceObserver callback | **unresolved** | Observer porównuje wpisy z dwiema stałymi nazwami. Źródło nie podaje liczby wpisów ani pomiaru kosztu liniowego includes przy kardynalności 2; samo zastąpienie tablicy przez Set nie dowodzi poprawy. |
| W02 | await niezależne | apps/control-room/scripts/audit-chart-performance.mjs:520 → 520 | główna sekwencja audit w try | **valid_candidate** | Po scenariuszach idle i opcjonalnym abort code pobiera trzy niemutujące wartości: liczniki chartu, tekstowy snapshot danych i liczbę canvasów. Można odczytać je jednym page.evaluate, zachowując pola i wspólny punkt obserwacji. Promise.all na trzech wywołaniach tego samego page nie gwarantuje spójnego snapshotu. |
| W03 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:874 → 874 | verifyIdleChartBudget | **valid_candidate** | Po wyciszeniu requestów i RAF pobierane są trzy próbki bazowe przed idleObserveMs. Mogą wejść do jednego page.evaluate w zachowanej kolejności, w tym z wywołaniem sweepActiveListeners, i nadal poprzedzać okno obserwacji. |
| W04 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:878 → 878 | verifyIdleChartBudget | **valid_candidate** | Po idleObserveMs pobierane są trzy próbki końcowe. Można zebrać je jednym page.evaluate, zachowując kolejność diag → lifecycle → data oraz koniec okna pomiaru; Promise.all mógłby rozsunąć punkt obserwacji. |
| W05 | await w pętli | apps/control-room/scripts/audit-chart-performance.mjs:960 → 960 | waitForQuietRowsBinRequests | **sequential_required** | Pętla czeka po 100 ms, porównuje liczbę obserwowanych rows.bin i resetuje quietSince po nowym zdarzeniu. To warunek zakończenia obserwacji requestów, a nie niezależna praca. |
| W06 | await w pętli | apps/control-room/scripts/audit-chart-performance.mjs:981 → 981 | waitForRowsTransportSizes | **sequential_required** | Pętla ponownie przegląda requesty szukając brakującego responseBytes i kończy się po uzupełnieniu asynchronicznych danych albo timeoutcie. Kolejna obserwacja zależy od napływu odpowiedzi. |
| W07 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1027 → 1027 | verifyChartInstanceLifecycle | **sequential_required** | Lifecycle snapshot wywołuje sweepActiveListeners, który usuwa odłączone węzły z rejestru i aktualizuje runtime.listeners; następnie CDP pobiera JSHeapUsedSize. Kolejność utrwala pomiar heapu po aktualizacji instrumentacji i GC/RAF. |
| W08 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1046 → 1046 | verifyChartInstanceLifecycle | **sequential_required** | Po zamknięciu chartu lifecycle snapshot wykonuje sweep listenerów, a potem odczytywany jest heap użyty przez assertBoundedLifecycle. Współbieżność mogłaby zmierzyć heap przed lub podczas aktualizacji rejestru listenerów. |
| W09 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1061 → 1061 | verifyChartInstanceLifecycle | **valid_candidate** | Po waitForStableChartDiagnostics kod odczytuje licznik z window i liczbę canvasów DOM, by je porównać. Obie wartości można zwrócić z jednego page.evaluate i porównać z tego samego stanu. |
| W10 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1116 → 1116 | verifyQuickChartViewportIsolation | **sequential_required** | Baseline Quick Chart powstaje po GC i stabilizacji RAF. Lifecycle snapshot aktualizuje runtime.listeners przez sweep; odczyt heapu powinien pozostać po tej aktualizacji, aby para opisująca baseline miała stałą kolejność. |
| W11 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1139 → 1139 | verifyQuickChartViewportIsolation | **sequential_required** | Lifecycle snapshot końcowy wykonuje sweep listenerów przed pomiarem heapu; oba wyniki tworzą parę przekazywaną do assertBoundedLifecycle. |
| W12 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1246 → 1246 | verifyLocalQuickChartActionBudget | **valid_candidate** | Baseline przed akcją Quick Chart pobiera stan viewport/WebGL oraz lifecycle. Można połączyć je w jednym page.evaluate z zachowaniem dotychczasowej kolejności; oba odczyty muszą zakończyć się przed focus/press/export. |
| W13 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:1256 → 1256 | verifyLocalQuickChartActionBudget | **valid_candidate** | Po akcji i 250-ms oknie kod pobiera lifecycle oraz viewport do porównania z baseline. Można zrobić wspólny odczyt po tym oknie; nie uruchamiać go równolegle z akcją ani przed jej zakończeniem. |
| W14 | await w pętli | apps/control-room/scripts/audit-chart-performance.mjs:1386 → 1386 | forceGarbageCollection | **sequential_required** | Każda z trzech rund wykonuje page.gc, CDP HeapProfiler.collectGarbage, a następnie 100-ms przerwę. To sekwencja serializująca GC i dająca runtime czas na uspokojenie. |
| W15 | await w pętli | apps/control-room/scripts/audit-chart-performance.mjs:1397 → 1397 | waitForSessionRequestQuiet | **sequential_required** | Pętla obserwuje sessionRequests co 100 ms i wymaga 500 ms stabilnej liczby przed zwrotem. To zamierzony pomiar ciszy zdarzeń. |
| W16 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:2288 → 2288 | verifyPendingRequestAbort | **valid_candidate** | Po remount i waitach chartu provenance oraz wartości legendy są niemutującymi odczytami tej samej prezentacji. Jeden snapshot DOM po istniejących wait gate może zachować wspólną rewizję. |
| W17 | await sekwencyjne | apps/control-room/scripts/audit-chart-performance.mjs:2332 → 2332 | verifyPendingRequestAbort | **valid_candidate** | Po dispatch nowego zakresu waitForFunction potwierdza rewizję N+1. Provenance i legenda są potem odczytywane z tego samego UI; wspólny snapshot po wait gate poprawia spójność odczytów. |
| W18 | await w pętli | apps/control-room/scripts/smoke-analysis-plots.mjs:231 → 231 | assertNoVisibleResourceErrors | **unresolved** | Pętla przechodzi po dynamicznym zbiorze toastów: count jest odczytywany w warunku każdej iteracji, a innerText zależy od isVisible. Źródło nie ogranicza liczby toastów; jednorazowe evaluateAll może zmienić semantykę widoczności lub pominąć toast pojawiający się podczas sprawdzenia. |
| W19 | await w pętli | apps/control-room/scripts/smoke-analysis-plots.mjs:247 → 247 | captureAnalysisAcceptanceScreenshots | **sequential_required** | Każda iteracja zmienia theme, czeka na render i wykonuje screenshot. To kolejne stany tego samego dokumentu, więc nie są niezależne. |
| W20 | await w pętli | apps/control-room/scripts/smoke-analysis-plots.mjs:281 → 281 | verifyResponsiveAnalysisFixtures | **sequential_required** | Każda iteracja zmienia viewport, czeka na layout i sprawdza fixture dla nowej szerokości. To różne stany jednego page. |
| W21 | await sekwencyjne | apps/control-room/scripts/smoke-analysis-plots.mjs:523 → 523 | verifySeriesLegend | **valid_candidate** | Po timeoutcie asercji legendy catch zbiera tekst body i szczegóły itemów. Są to niezależne, niemutujące dane diagnostyczne; można pobrać je jednym snapshotem. Dotyczy wyłącznie failure path, nie sukcesu smoke. |
| W22 | await sekwencyjne | apps/control-room/scripts/smoke-analysis-plots.mjs:1300 → 1522 | waitForFrequencyChart | **valid_candidate** | Po niepowodzeniu waitForFrequencyChart catch zbiera body, resource key i renderedPoints. To niezależne dane diagnostyczne; można zebrać je jednym odczytem po zachowaniu pierwotnego wait/timeout. |
| W23 | lookup w tablicy | apps/control-room/scripts/smoke-analysis-plots.mjs:1316 → 1538 | waitForFrequencyChart | **unresolved** | Aktualny fixture wymaga dwóch stałych etykiet. Nie ma dowodu, że normalizedLabels lub requiredLegendLabels osiągają liczbę uzasadniającą Set; pętla przebiega raz, a porównuje dwie nazwy. |
| W24 | await sekwencyjne | apps/control-room/scripts/smoke-analysis-plots.mjs:1958 → 2180 | waitForFrequencyDomainTooltip | **sequential_required** | waitForFunction obserwuje pojawienie się tooltipu z wymaganymi terms, a następnie odczytywany jest tekst tooltipu. Odczyt przed waitem mógłby zwrócić stary albo nieobecny element. |
| W25 | await w pętli | apps/control-room/scripts/smoke-inspector.mjs:599 → 599 | capture | **valid_candidate** | Przed drag pobierane są boundingBox uchwytu i panelu. Obie geometrie są potrzebne do obliczenia celu, ale nie zależą od siebie; można odczytać parę współbieżnie lub jednym DOM snapshotem. Iteracje i sam drag muszą pozostać sekwencyjne. |
| W26 | await w pętli | apps/control-room/scripts/smoke-inspector.mjs:619 → 619 | capture | **sequential_required** | Zmiana theme, 100-ms settle i screenshot muszą pozostać uporządkowane, bo zrzut ma pokazać konkretny theme i szerokość. |
| W27 | await w pętli | apps/control-room/scripts/smoke-inspector.mjs:843 → 843 | capture | **sequential_required** | Po akcji pętla odczytuje isDisabled resetu, czekając aż kontrolka osiągnie stan settled; dopiero potem pobiera atrybuty resetu. |
| W28 | await w pętli | apps/control-room/scripts/smoke-inspector.mjs:1127 → 1127 | qualifyVisualizationMutationStability | **sequential_required** | Każda iteracja ustawia focus, mutuje kontrolkę, czeka 40 ms i obserwuje remount/focus/animacje. Współbieżność zmieniłaby kolejność mutacji i pomiaru. |
| W29 | await w pętli | apps/control-room/scripts/smoke-inspector.mjs:4655 → 4865 | waitForInspectorRequestQuiet | **sequential_required** | waitForInspectorRequestQuiet obserwuje rosnącą tablicę requestów i wymaga okresu bez nowych wpisów. To polling zdarzeń. |
| W30 | await w pętli | apps/control-room/scripts/smoke-study-authoring-ui.mjs:383 → 1091 | LLG-only algorithm assertion block | **superseded** | Kod iteruje po stałej, jednoelementowej liście [nonlinear_cg]. Nie ma tu powtarzanego workloadu do równoleglenia, więc ostrzeżenie syntaktyczne nie wskazuje praktycznej pracy performance. |
| W31 | await w pętli | apps/control-room/scripts/smoke-study-authoring-ui.mjs:556 → 1285 | verifyWorkflowActionInspectors | **valid_candidate** | Po otwarciu inspectora pięć waitFor sprawdza widoczność niezależnych metryk w tym samym stabilnym widoku. Między locatorami nie ma mutacji, więc waitery można uruchomić wspólnie, zachowując komplet etykiet i timeoutów. |
| W32 | await niezależne | apps/control-room/scripts/smoke-study-authoring-ui.mjs:1012 → 2772 | expandExplorerNode | **sequential_required** | expandExplorerNode najpierw czeka na wskazany node. Dopiero catch po timeoutcie pobiera widoczne IDs, by wyjaśnić brak elementu; diagnostyka zależy od wyniku pierwszego wait. |
| W33 | await niezależne | apps/control-room/scripts/smoke-study-authoring-ui.mjs:1579 → 3339 | createObjectRegionAndAssertScriptSync | **valid_candidate** | Po timeoutcie nagłówka panelu catch odczytuje data-active, tekst wiersza i tekst inspectora. To niezależne dane błędu, które można pobrać jednym snapshotem DOM. Tylko failure path. |
| W34 | await niezależne | apps/control-room/scripts/smoke-study-authoring-ui.mjs:2007 → 3767 | addEigenmodesAndEditFrequencyWindow | **valid_candidate** | Po ACK transakcji i walidacji zapisanej sceny, bez kolejnej mutacji, odczytywane są cztery wartości formularza: Target, Frequency min/max i Operator. To read-only odczyty niezależne od siebie. |
| W35 | await sekwencyjne | apps/control-room/scripts/smoke-study-authoring-ui.mjs:2010 → 3770 | addEigenmodesAndEditFrequencyWindow | **valid_candidate** | Frequency min należy do tej samej grupy czterech readbacków po ACK co Target, Frequency max i Operator; nie zależy od ich wartości. |
| W36 | await sekwencyjne | apps/control-room/scripts/smoke-study-authoring-ui.mjs:2016 → 3776 | addEigenmodesAndEditFrequencyWindow | **valid_candidate** | Frequency max i Operator należą do tej samej grupy czterech readbacków po ACK; nie mutują formularza i nie wymagają kolejności. |
| W37 | await sekwencyjne | apps/control-room/scripts/smoke-study-authoring-ui.mjs:2409 → 4169 | assertExplorerRowSelected | **valid_candidate** | Dopiero po wyczerpaniu pollingu selection timeout failure path zbiera selected rows i tekst inspectora. To niezależne dane diagnostyczne do wspólnego snapshotu; warunek wyboru pozostaje bez zmian. |
| W38 | await w pętli | apps/control-room/scripts/smoke-study-authoring-ui.mjs:2435 → 4195 | waitForRegionScriptSyncCount | **sequential_required** | Pętla czeka, aż event-driven scriptSyncs osiągnie wymagany count albo upłynie deadline. Kolejne odczyty zależą od nadchodzących synców. |
| W39 | await w pętli | apps/control-room/scripts/smoke-study-authoring-ui.mjs:3184 → 4950 | waitForTransactionCount | **sequential_required** | Pętla czeka na wymaganą liczbę transactions zarejestrowanych przez fixture, czyli synchronizuje test z faktycznymi POST/ACK. |
| W40 | await w pętli | apps/control-room/scripts/smoke-viewport-3d-explorer-inspector-targets.mjs:1815 → 3417 | stop | **sequential_required** | Cleanup zatrzymuje proces przed usunięciem jego artefaktów, a potem odtwarza konfigurację. Catch gromadzi błędy, ale kontynuuje kolejne operacje. Współbieżność mogłaby usunąć zasoby przed stop albo przywrócić config za wcześnie. |

## Hash-bound źródła

| Plik | SHA-256 historyczny b34953c | SHA-256 bieżący 152ad2e | Bajty historyczne / bieżące |
|---|---|---|---|
| apps/control-room/scripts/audit-chart-performance.mjs | 73d4da388772f33fc01d06e251f755287e457fcd1b117a1e4824c073462709a9 | 73d4da388772f33fc01d06e251f755287e457fcd1b117a1e4824c073462709a9 | 89759 / 89759 |
| apps/control-room/scripts/smoke-analysis-plots.mjs | 7127d939fba6713bebc46818841c76b8564f2f0cfdf075ee8c91d6137208e1ea | 97f8015e3c65445ca4fbd30986ad1a7a8ef7604fdc383d6afe0e0abffa304a4b | 123259 / 137656 |
| apps/control-room/scripts/smoke-inspector.mjs | fe03ff2c055c9bf17da78db170c04ff54f56da8bc77884da0807c6401af96cc6 | dea58b8edb496682bda27c34e345427884344627f2f35244c752bfd9604ca3da | 237017 / 245989 |
| apps/control-room/scripts/smoke-study-authoring-ui.mjs | 56094c485cfabad8cb706a7fb020fc36471c8d90492e6fd69c3f6924e98c9e45 | 5b5252c0930dbf54cde644172e4b90fb2d335e909657079ad5cb0155d6cfb552 | 111370 / 175392 |
| apps/control-room/scripts/smoke-viewport-3d-explorer-inspector-targets.mjs | 308dac3801db16adf192924dd5a642d53898dfd5fe55a987208a02bf3cfd32b4 | c366685a07656228ab1360f912598e7ea4046324e06a38bef27e6ebaca09a2b8 | 89066 / 152130 |

Plik audit-chart-performance.mjs jest byte-identical w obu rewizjach. Mapowanie linii wykorzystuje dopasowanie sekwencji źródeł; generowanie JSON wymagało identycznej treści wskazanej linii. Artefakt zapisuje kontekst przed i po każdym historycznym wskazaniu do niezależnego review.

## Granica weryfikacji

To przegląd źródła, nie benchmark ani runtime proof. Nie uruchamiano testów, buildu, Node, przeglądarki ani kodu projektu; nie zmieniano źródeł. Klasyfikacja nie twierdzi, że kandydaci przyspieszą smoke ani że unresolved oznacza defekt.

## Rozstrzygnięcie po review prowadzącego

Wszystkie 40 pozycji zostały rozpatrzone; nie wszystkie są błędami do naprawienia. Poniższa decyzja jest odrębna od wstępnego triage i nie zmienia jego źródłowych obserwacji.

| Pozycje | Ostateczna decyzja w zakresie tego review |
|---|---|
| W05–W08, W10–W11, W14–W15, W19–W20, W24, W26–W29, W32, W38–W40 | **reviewed_no_change — sequential_required**. Zachowano kolejność mutacji, obserwacji, garbage collection i cleanup. Współbieżność zmieniłaby znaczenie dowodu; nie dodano wyłączenia reguł ani pozornie równoległego wykonania. |
| W30 | **reviewed_no_change — fixed_single_item**. Lista jednoelementowa nie stanowi powtarzanego workloadu do przyspieszenia. Nie oznacza to usunięcia ostrzeżenia z analizatora. |
| W01, W23 | **reviewed_no_change — constant_small_lookup**. Oba lookupy porównują dwie stałe nazwy; brak pomiaru uzasadniającego budowę Set. Obecny koszt jest ograniczony, a semantyka poprawna. |
| W18 | **reviewed_no_change — dynamic_diagnostic_observation**. Sekwencyjny odczyt uwzględnia widoczność i zmieniający się zbiór toastów. Jeden snapshot lub Promise.all zmieniłby granicę obserwacji. Nie stwierdzono na tej podstawie utraty poprawności smoke ani kosztu wymagającego zmiany. |
| W02–W04, W09, W12–W13, W16–W17, W21–W22, W25, W31, W33–W37 | **reviewed_deferred_optimization** (17 pozycji). Możliwe ograniczenie round-tripów Playwright albo spójniejszy snapshot. Nie wykazano bottlenecku ani mierzalnej korzyści; część dotyczy wyłącznie diagnostyki po błędzie. Zachowano jako opcjonalny dług pomiarowy, bez deklaracji wdrożenia lub poprawy wydajności. |

W tym zadaniu wdrażane są potwierdzone problemy zachowania i kontraktów. Te 17 optymalizacji pozostaje jawnym backlogiem usprawnień, nie blokadą poprawności i nie naprawionymi błędami. Ewentualna realizacja musi zachować wszystkie wait gates, przedziały pomiaru i kolejność działań na pojedynczej stronie; wymaga też dowodu browser/runtime i porównania kosztów. Zielony typecheck lub mniej ostrzeżeń nie dowodzi przyspieszenia.

Oddzielne ostrzeżenie complexity w EigenDispersionInspectorPanel (historyczna L24) zostało przeczytane w całości na exact 2d7b4e3edcf2516edb32995df3f57312db2bbcf8: **reviewed_retained_maintenance_debt**. Komponent korzysta już ze wspólnego InspectorOverviewFrame, osobnego modelu/hooka, chartu i tabeli. Pozostała złożoność wynika głównie z prezentacji pustego/wybranego punktu i tonów metryk. Nie wykazano osobnego błędu solvera, pętli ani efektu React. Nie nazywamy ostrzeżenia fałszywym ani usuniętym; przyszły refaktor musi zachować tożsamość sample/mode/run/stage/revision oraz nie dodawać fetchy/store.

Granica: pełna ocena źródłowa 41 pozycji nie jest kwalifikacją wydajności ani stwierdzeniem ich usunięcia z React Doctor. Kod skryptów i komponentu w tej aktualizacji nie został zmieniony.
