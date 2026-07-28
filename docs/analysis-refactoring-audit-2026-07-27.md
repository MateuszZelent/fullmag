# Audyt realizacji planu refaktoryzacji zakładki Analysis

> **Werdykt:** **GO dla podstawowych wykresów w bieżącym working tree; NO-GO publikacyjne bez celowego commitu i kwalifikacji na jego SHA**  
> **Data audytu:** 2026-07-27  
> **Plan:** `docs/analysis-tab-refactoring-plan.md`  
> **HEAD i `origin/master`:** `9853cbc17acfde6c6917942f6323a365f4e9025f`  
> **Baseline wskazany przez plan:** `85dc1765`  
> **Zakres:** niezatwierdzony diff oraz nowe pliki `apps/control-room` związane z Analysis; niezależne zmiany FEM i `external_solvers/3` wyłączono z oceny funkcjonalnej.

## Aktualizacja po korekcie — podstawowe wykresy `tableautosave` (2026-07-27)

> **Bieżący zakres:** tylko podstawowe wykresy tabelaryczne z `study.tableautosave(...)`. Γ spin-wave, dynamic structure factor i frequency-domain są świadomie **poza bieżącą kwalifikacją**.

Poniższa sekcja zastępuje historyczne twierdzenia implementacyjne A-01–A-13. Historyczna część raportu pozostaje jako zapis pierwszej inspekcji, ale nie jest opisem obecnego kodu.

| Obszar | Stan po korekcie | Dowód |
|---|---|---|
| Live table / pauza | Po publikacji schema hook pozostaje włączony i subskrybowany na rewizje. `paused` przekazuje wyłącznie `pauseLoad`, więc zachowuje ostatnie widoczne dane i ich status `Paused`, zamiast odłączać resource i zwracać fałszywe `idle`. Przy budowaniu serii zamrożona rewizja mapuje się na `ready`, nie `idle`; po resume bramka `pauseLoad` znika. | `shouldLoadPublishedTableRows`, `shouldPausePublishedTableRows`, `tableRowsStatusForDisplay`, `resourceStatusFromString` oraz testy `useAnalysisTableData`/`analysisWorkbenchModel`. |
| Quantity availability | Schema runtime jest jedynym źródłem listy `columns`: przed jego nadejściem request `/rows` jest zablokowany, więc UI nie odpyta starego fallbacku quantity. Po nadejściu schema panel `Available quantities` pokazuje dokładne `column_id`, etykietę i unit oraz steruje X/Y. To jest kontrakt dla `step`, `mx`, `my`, `mz`, `e_ex`, `e_demag`, `e_total`, `max_torque_T` i dowolnego innego faktycznie opublikowanego quantity. | `useAnalysisTableData.ts`, `useAnalysisTableData.test.tsx`, `AnalysisTableSurface.tsx`. |
| Osie i zakres | Etykieta semantyczna oraz canonical unit są rozdzielone; ten sam SI scale zasila nazwę osi, ticki i tooltip. Górny control bar jest ownerem follow/tail/fixed/full oraz budżetu punktów; ECharts nie renderuje dolnego slidera. `tailTime` (np. `Last 1 ns`) jest dostępny tylko dla osi `t`/`time` i jako jedyny generuje `from_t/to_t`; zoom po dowolnej innej wielkości pozostaje lokalny, zamiast fałszywie zamieniać wartość fizyczną na numer wiersza. `Fixed range` pojawia się dopiero po rzeczywistym zoomie. | `analysisPlotsModel.test.ts`, `chartTableModel.test.ts`, `ChartControlBar.test.tsx`, `scientificChartFormatting.test.ts`, `chartRenderer.test.ts`. |
| Deferred dynamics | Główny workbench podstawowych wykresów nie wywołuje już endpointów spin-wave ani dynamic structure factor. W realnej sesji te opcjonalne, nieobsługiwane zasoby powodowały cykliczne 404 mimo braku funkcjonalności dynamics w bieżącym zakresie. Compute gate zabrania ponownego importu tych hooków do controllera. | `useAnalysisPlotsController.ts`, `AnalysisPlotsView.tsx`, `analysisWorkbench.test.tsx`, `audit-compute-performance.mjs`. |
| Scientific trust | HTTP `ready` nie jest już prezentowane jako `Canonical`. Resource state i scientific trust są osobne; bez payloadu kwalifikacji UI i sidecar eksportu pokazują `Unknown`. | `ChartSection.test.tsx`, `chartExport*.test.ts`. |
| Lifecycle i koszt danych | Renderer nie buduje dodatkowych pełnych tablic X/Y do autoskalowania; liczy ekstrema jednoprzebiegowo dla bounded payloadu tabeli. | `chartRenderer.test.ts`, `scientificChartFormatting.test.ts`. |
| Preferences i Inspector | Preferencje tabeli są hydratowane po stronie klienta pod stabilnym descriptor ID `analysis:data-table:default`. Inspector zapisuje zmianę X/Y, live/pause, range i target points; akcja Fit publikuje tylko lekki licznik żądania widoku, bez kopiowania danych wykresu do store. Visibility/solo/range/axes/target points nie są już globalnym stanem współdzielonym z innymi chart families. | `ChartInspectorPanel.tsx`, `analysisPlotsWorkspace.ts`, `analysisChartPreferences.ts`, odpowiadające testy workspace/preferences, typecheck. |
| Export i Points Table | Points Table jest podpięty do ECharts surface. CSV/TSV i PNG zapisują sidecar provenance; URL blob jest zwalniany. Descriptor tabeli w sidecarze ma ten sam stabilny klucz co persisted preferences: `analysis:data-table:<tableId>`. | `EChartsSurface.tsx`, `ChartExportControls.tsx`, `chartExport.download.test.ts`. |
| Widoczność i układ | Celowe ukrycie wszystkich serii nie jest opisywane jako brak danych tabeli. Frame wykresu jest kolumną flex: canvas zajmuje pozostałą wysokość, a Data Table/CSV/TSV/PNG mają zarezerwowany, zawijany wiersz zamiast być ucięte pod canvasem. | `EChartsSurface.test.tsx`, `analysis-plots.css` (test statyczny; bez browser proof). |
| Quick Chart i footer | `transport-footer` nadal jest jedynym ownerem `panel-bottom`; test obejmuje wszystkie sześć jego zakładek i lazy mount contentu. Quick Chart najpierw odczytuje runtime schema, a następnie pobiera wyłącznie opublikowaną oś X i dostępne osie Y. Nie zależy od kolumn zapisanych przez pełny Analysis i nie wysyła guessed/static quantity list. Brak wybranej quantity jest stanem `unsupported`, nie fałszywym pustym wykresem. | `FooterModule.tsx`, `footer/manifest.test.ts`, `QuickChartResourceView.tsx`, `quickChart.test.tsx`. |
| Audyty statyczne i runtime | Audit compute-performance sprawdza aktualny resource owner tabeli i runtime schema oraz zakazuje automatycznego ładowania deferred dynamics. Audit chart-performance zatrzymuje live Analysis przed obserwacją idle, mierzy `rows.bin` dopiero po `requestfinished` i odrzuca anulowane przez unmount żądania zamiast fałszywie uznawać je za niezmierzoną odpowiedź. Smoke test obejmuje tylko podstawowy chart i nie zakłada konkretnych quantities. | `computePerformanceAuditScript.test.ts`, `analysisPlotsPerformanceAuditScript.test.ts`, `analysisPlotsSmokeScript.test.ts`, `audit:compute-performance`, `check:api-hygiene`. |

### Wynik bramek po korekcie

Przeszły na bieżącym working tree:

- `corepack pnpm --dir apps/control-room typecheck`
- `corepack pnpm --dir apps/control-room lint`
- `corepack pnpm --dir apps/control-room check:api-hygiene`
- `corepack pnpm --dir apps/control-room check:architecture-hygiene`
- `corepack pnpm --dir apps/control-room audit:compute-performance`
- pełny `corepack pnpm --dir apps/control-room test`: **3917 passed / 1 skipped**
- test audytu compute-performance oraz `audit:compute-performance` po sprawdzeniu kontraktu schema-first
- browser smoke `smoke:analysis-plots` na production build `:3102`, połączonym z działającym API `:8081`
- chart-performance na żywej sesji: **100 przełączeń Analysis ↔ 3D, 0 failed responses, 0 idle redraws, 101 instancji ECharts utworzonych / 100 zniszczonych / 1 aktywna**; proof: `/tmp/fullmag-chart-performance-final/chart-performance-proof-unspecified.json`
- backend/API: sesja `mumag_sp4_fem_relax_projected_gradient_bb` była w stanie `running` (4515 kroków, `scalars_revision=4516`); `rows.bin` przez proxy production build zwrócił `200`, format `FMTB.v1.row-major-f64le` i binarny payload `83948 B`
- `react-doctor --diff` dla `apps/control-room`

Ograniczenia i pozostałe warunki publikacji:

- wynik browser tests wymagał uruchomienia Chromium poza sandboxem; sandboxowy launch kończy się ograniczeniem środowiska `sandbox_host_linux.cc:41`, nie błędem aplikacji;
- proof obejmuje podstawowy wykres `tableautosave`; dynamics/spin-wave/frequency-domain są poza bieżącym zakresem;
- `git diff --check` nadal raportuje istniejące, niezwiązane z Analysis trailing whitespace w `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`; nie zostało dotknięte;
- working tree nadal jest niezatwierdzony i zawiera niezależne zmiany, więc publikacja wymaga wąskiego commitu oraz ponowienia kwalifikacji na jego pełnym SHA.

**Werdykt dla podstawowych wykresów:** implementacja, pełny test pakietu i browser proof są zielone na aktywnej symulacji. **Werdykt publikacyjny:** wstrzymany wyłącznie do czasu wydzielenia i zatwierdzenia wąskiego commitu oraz ponowienia kwalifikacji na jego SHA.

## Archiwum pierwszego audytu — nieaktualny snapshot

Poniższe sekcje są zachowanym snapshotem sprzed korekt. Mogą służyć do zrozumienia genezy zmian, ale **nie są bieżącą listą findings ani statusów bramek**. Aktualną oceną jest wyłącznie sekcja „Aktualizacja po korekcie” powyżej.

## 1. Wniosek wykonawczy (historyczny)

Twierdzenie, że plan został zrealizowany w całości, jest fałszywe.

1. Implementacja nie znajduje się w commicie na `master`. `HEAD` i `origin/master` wskazują commit dokumentacyjny `9853cbc`; oceniany kod jest dużym, niezatwierdzonym stanem working tree, w tym 14 nieśledzonymi plikami frontendowymi.
2. Żaden z etapów 0–11 nie ma kompletnego zestawu kodu, testów i dowodów wymaganego przez plan. Etap 7 zachowuje poprawny baseline ownership footera, ale dirty diff nie realizuje ani nie kwalifikuje jego scenariuszy.
3. Główna ścieżka live tabeli ma regresję blokującą: po pierwszym oknie HTTP wykres przestaje pobierać kolejne rewizje, a Resume nie wykonuje zapowiadanego fetchu.
4. Automatyczne skalowanie osi może wyświetlać ticki w ns/GHz z etykietą `[s]`/`[Hz]`. Jest to błąd naukowej interpretacji danych.
5. Preferencje, trzy hooki rodzin zasobów i Points Table są martwym kodem. Controller nadal ma 639 linii, a obok niego dodano 529 linii nieużywanych duplikatów.
6. Bramki produkcyjne są czerwone: browser smoke, chart-performance, architecture hygiene i pełny test suite nie przechodzą. Brakuje dwóch qualification runs, screenshotów Analysis, kompletnego `ChartPerformanceProof` i rzeczywistych próbek eksportu.

Rozmiar ocenianej zmiany frontendowej:

| Rodzaj | Liczba |
|---|---:|
| Zmienione tracked pliki w `apps/control-room/src` i `scripts` | 21 |
| Dodane, nieśledzone pliki w `apps/control-room/src` | 14 |
| Tracked diff | +1593 / -211 linii |
| Nowe nieśledzone pliki | 2408 linii |

## 2. Stan Git i granica audytu

`git status` pokazuje jednocześnie:

- zmiany Analysis i shared chart infrastructure;
- niezależną zmianę `apps/control-room/scripts/audit-compute-performance.mjs`;
- zmianę submodułu `external_solvers/3`;
- zmianę scenariusza FEM oraz dwa nowe pliki `backends/fem/core/demag_solver_policy.*`.

Te obszary nie mogą trafić do jednego przypadkowego commita. Przed dalszą pracą trzeba zbudować jawny, śledzony diff tylko dla Analysis i ponownie uruchomić kwalifikację na tym samym SHA. Obecny stan nie jest ani publikowalny, ani reprodukowalny.

## 3. Findings blokujące

### A-01 — BLOCKER: wykres live zamraża się po pierwszym oknie HTTP

**Dowody:**

- `analysisPlotsModel.ts:48-64` zwraca `false`, gdy istnieją widoczne wiersze i `range === null`, także w trybie `following`;
- `useAnalysisPlotsController.ts:107-115` przekazuje ten wynik jako `enabled` do `useTableRowsBinaryResource`;
- `useAnalysisPlotsController.ts:326-344` przyjmuje dane wyłącznie z tego resource hooka;
- dotychczasowe dopisywanie `telemetry:scalar-sample` usunięto, a listener w `useAnalysisPlotsController.ts:346-354` jest no-op;
- test `AnalysisPlotsModule.test.tsx:2178-2207` wręcz utrwala zasadę „tylko initial load i zoom”, ale nie testuje relevant revision, paused ani resume.

Sekwencja błędu:

1. Pierwszy render nie ma wierszy, więc `enabled=true` i HTTP zwraca okno.
2. Reducer zapisuje `visibleTable`; przy następnym renderze `hasVisibleRows=true`.
3. Dla normalnego live follow `range=null`, więc `enabled=false`.
4. Hook przestaje subskrybować resource revision i loader nie może wykonać kolejnego requestu.
5. Przejście `paused -> following` nadal daje `enabled=false`; zapowiedziany „dokładnie jeden latest fetch” nie występuje.

Skutek jest gorszy niż samo zatrzymanie danych. Wyłączony hook zwraca status `idle`, a `AnalysisTableSurface.tsx:21-31` mapuje każdy stan poza `error/loading/stale` na `Live` i `canonical`. Użytkownik widzi stare dane jako żywe i wiarygodne; eksport może oznaczyć stare okno jako canonical bez ostrzeżenia.

**Wymagane przed merge:** revision-aware test z request counterem dla initial/relevant/irrelevant/paused/resume oraz naprawa ownership pauzy. `paused` ma wstrzymywać przyjęcie/pobranie payloadu, ale nie może trwale odłączyć ścieżki follow od invalidation.

### A-02 — BLOCKER: autoskalowanie fałszuje jednostkę osi

**Dowody:**

- `analysisWorkbenchModel.ts:69-71` tworzy etykietę `t [s]`;
- energy adapter przekazuje `xUnit: "s"` (`energyHistoryAdapter.ts:38-48`);
- `chartRenderer.ts:127-139` wykrywa skalę SI i dzieli ticki przez wybrany factor;
- `chartRenderer.ts:305-308` pozostawia etykietę bez zmian, jeśli zawiera `[`.

Dla danych `1e-9, 2e-9 s` ticki zostaną pokazane jako `1, 2`, ale nazwa osi pozostanie `t [s]`, zamiast `t [ns]`. Ten sam problem dotyczy częstotliwości, np. GHz pokazywanych pod etykietą `[Hz]`.

Tooltip częściowo pokazuje prefiksowaną wartość, ale nagłówek X nadal zawiera preformatowaną etykietę, więc interfejs sam sobie przeczy. Brak testu `chartRenderModelToEChartsOption` dla takiego przypadku.

**Wymagane przed merge:** model osi musi przenosić osobno semantic label i canonical unit. Nazwa osi oraz formatter ticków muszą być generowane z tego samego `AxisScale`. Testy muszą obejmować s→ns, Hz→GHz, wartości dimensionless, zero, szeroki zakres i mixed-sign.

### A-03 — BLOCKER wydania: implementacja nie jest zmianą na `master`

`HEAD == origin/master == 9853cbc`. Commit ten dodaje plan, nie implementację. Zmiana implementacyjna jest dirty i zawiera nieśledzone pliki wymagane do kompilacji. Nie można twierdzić, że funkcja jest „zrealizowana na masterze”, dopóki nie istnieje celowy commit z jednoznacznym zakresem i dowodami przypiętymi do jego pełnego SHA.

## 4. Findings o wysokim priorytecie

### A-04 — Preferences i controller split są niewpiętymi duplikatami

`rg` nie znajduje żadnego produkcyjnego wywołania:

- `useAnalysisChartPreferencesHydration`;
- `useAnalysisTableData`;
- `useAnalysisEnergyData`;
- `useAnalysisFrequencyData`.

`useAnalysisPlotsController.ts` nadal ma 639 linii. Nowe hooki mają łącznie 529 linii i kopiują jego resource loading, modele oraz listenery. Jest to dokładnie stan dwóch równoległych paths zabroniony rollbackiem etapu 10.

Skutki:

- localStorage nie wpływa na UI;
- `targetPoints` pozostaje na sztywno `1600` (`analysisPlotsModel.ts:34-45`);
- tryby `tailRows`, `tailTime` i `fullDecimated` nie mapują się na query;
- display units, descriptor-scoped visibility, solo i persisted active surface nie działają;
- aktywne UI nadal używa monolitycznego controllera.

`useAnalysisFrequencyData.ts` dodatkowo importuje route helper z monolitycznego controllera. Po rzeczywistym wpięciu hooków utworzyłoby to odwróconą zależność/cykl zamiast czystego podziału.

### A-05 — Solo nie działa, a visibility ma niewłaściwy scope

`AnalysisPlotsModule.tsx:37-41` przekazuje `controller.yAxisIds` jako listę wszystkich series IDs. To nie są series IDs:

- tabela tworzy ID w formacie `data.table:<table>:<x>:<column>`;
- energia używa `simulation.solver.energies:<term>`;
- frequency ma własne identyfikatory.

Store ukrywa więc surowe column IDs, których renderer nie znajduje, i solo nie ukrywa właściwych serii.

Drugi błąd znajduje się w surface components. Przekazują `soloed: soloedId !== null && soloedId !== series.id`, czyli flagują serie inne niż solo. `ChartLegend.tsx:75` szuka elementu jednocześnie `soloed && !hidden`; takie połączenie nie występuje po poprawnym ukryciu pozostałych serii. Drugie Shift+Click nie rozpozna aktywnego solo i nie wyczyści go.

Ponadto jeden globalny `hiddenSeriesIds` jest współdzielony przez table, energy i frequency, zamiast descriptor-scoped preference. Stan z jednej surface może zanieczyścić logikę innej.

### A-06 — Range toolbar jest atrapą

`ChartControlBar` deklaruje `onRangeModeChange`, ale nie destrukturyzuje ani nie wywołuje tego callbacku. Renderuje wyłącznie tekstowy badge. Nie ma kontrolek dla:

- `tailRows`;
- `tailTime`;
- `fixed from/to`;
- `fullDecimated`;
- `targetPoints`.

Przycisk Fit jest podłączony do jawnego no-op w `AnalysisTableSurface.tsx:93-101`. Komentarz twierdzi, że akcja jest dispatchowana w `EChartsSurface`, ale taka ścieżka nie istnieje.

### A-07 — Status i scientific trust są semantycznie niepoprawne

`AnalysisTableSurface.statusToTrust()` zwraca `canonical` także dla `idle`, `error`, `unsupported`, `empty` i `aborted`. `statusPrimary()` pokazuje `Live` dla większości nieznanych stanów.

Energy i Frequency (`AnalysisEnergySurface.tsx:68-78`, `AnalysisFrequencySurface.tsx:138-150`) utożsamiają resource status `ready` z `Live` i scientific trust `canonical`. Spec 16 wymaga niezależnego `ScientificTrust`; gotowy transport nie oznacza kwalifikacji naukowej.

`ChartSection` wykorzystuje `trust` jedynie do klasy koloru (`ChartSection.tsx:63-69`) i nigdy nie renderuje jego tekstu. Stan nie ma non-color cue. Revision jest obsługiwane przez typ, ale żaden analizowany surface go nie przekazuje.

### A-08 — Renderer nie spełnia kontraktu tokenów, lifecycle i a11y

Potwierdzone problemy:

1. `fullmagChartTokens.ts:51-96` zawiera 19 surowych kolorów poza `theme.css`. `check:architecture-hygiene` failuje dokładnie na tym pliku.
2. `chartRenderer.ts:170-198` ma dalsze fallbacki `var(--fm-*)`, literalne rozmiary fontów i raw `rgba`. Canvas nie gwarantuje interpretacji CSS variables przekazanych jako stringi.
3. `accentFill` zwraca `color-mix(...)`, mimo komentarza mówiącego o „concrete hex”. Nie ma browser testu potwierdzającego obsługę tego koloru przez ECharts Canvas.
4. Theme mutation wywołuje `owner.update`, a owner zawsze używa `setOption(..., true)` (`chartRenderer.ts:118-120`). `notMerge=true` przebudowuje option i może zresetować lokalny `dataZoom`; plan wymaga zachowania zakresu/selection. Nie ma testu theme switch.
5. Theme update nie wywołuje liczników `modelUpdated/setOption`, więc diagnostics nie widzi części redrawów.
6. Brak `aria: { enabled: true }` w ECharts option, DOM summary i działającej alternatywy Points Table.
7. Tooltip nie pokazuje canonical row id ani stale/degraded marker. Precyzja nadal jest jedną heurystyką globalną, nie quantity metadata policy.
8. `scientificChartFormatting.detectAxisScale()` używa `Math.max(...array)` i `Math.min(...array)` (`scientificChartFormatting.ts:54-60`), mimo jawnego zakazu spreadowania dużych tablic. Obecne query jest bounded, ale shared helper sam nie egzekwuje limitu i nie powinien tworzyć dodatkowych kopii.
9. Komentarz `chartRenderer.ts:145-154` twierdzi, że built-in legend jest włączona, podczas gdy kod ustawia `legend: { show: false }`. To oznaka niezweryfikowanego, niespójnego kontraktu.

Nie należy „naprawiać” gate'a przez przeniesienie raw hex do innych plików TypeScript. Fallbacki powinny wynikać z centralnych tokenów/theme i być rozstrzygnięte przed przekazaniem do Canvas.

### A-09 — Eksport i Points Table są niekompletne

`PointsTableDialog` istnieje i ma test SSR markup, ale nie jest importowany przez żaden produkcyjny komponent ani komendę. Użytkownik nie może go otworzyć.

Eksport:

- CSV/TSV pobiera sidecar, PNG nie (`ChartExportControls.tsx:16-39`);
- sidecar nie zawiera session/run/stage, canonical/display units, backend/device/precision ani pełnego trust payloadu;
- `descriptorId` jest ustawione na dynamiczny `model.key`, a nie stabilny descriptor;
- PNG pochodzi wyłącznie z canvas, więc nie zawiera zewnętrznej Fullmag legendy ani status/provenance chrome;
- brak `chartExport.download.test.ts`, rzeczywistego pobranego pliku, PNG dimensions/theme proof i testu object URL lifecycle;
- nie ma przycisku/komendy Points Table.

Pozytywne elementy — numeric values pozostają bez locale formatting, dodano row id/revision/decimation, ostrzeżenie stale/degraded i ochronę komórek tekstowych przed spreadsheet formula injection — nie zamykają etapu 9.

### A-10 — Testy zostały osłabione zamiast rozszerzone

Przykłady:

- `AnalysisPlotsModule.test.tsx:1998-2003` sprawdza tylko istnienie ogólnych klas, zamiast statusu X/Y/visible/total/zoom;
- test wybranego punktu (`2037-2040`) nie sprawdza już wartości `mx 0.2`, tylko obecność footera;
- limit cienkiego widoku podniesiono z 180 do 185 linii;
- test nazwany „mounts only the selected dedicated heavy surface” oczekuje dwóch chart families w Overview;
- test initial/zoom utrwala błąd A-01 i nie obejmuje invalidation/pause/resume.

Brakuje dziesięciu jawnie wymaganych plików:

1. `fullmagChartTokens.test.ts`
2. `EChartsCanvasSurface.test.tsx`
3. `ChartSection.test.tsx`
4. `ChartLegend.test.tsx`
5. `ChartControlBar.test.tsx`
6. `chartExport.download.test.ts`
7. `useAnalysisChartPreferencesHydration.test.tsx`
8. `useAnalysisTableData.test.tsx`
9. `useAnalysisEnergyData.test.tsx`
10. `useAnalysisFrequencyData.test.tsx`

Istniejący `EChartsSurface.test.tsx` nadal opiera lifecycle głównie na source-string assertions i nie montuje realnej instancji ECharts, observerów, theme switch ani exportu.

### A-11 — Latentne błędy niewpiętego preference store

Nawet po podłączeniu obecny kod wymaga napraw:

- `getServerSnapshot()` tworzy nowy obiekt przy każdym wywołaniu (`useAnalysisChartPreferencesHydration.ts:33-35`), zamiast zwracać stabilny cached snapshot wymagany przez `useSyncExternalStore`;
- każdy subscriber tworzy globalny listener `storage`, a każdy listener powiadamia wszystkich subscriberów (`44-58`), co daje O(n²) notifications;
- `displayUnits` jest tylko rzutowane na `Record<string,string>` bez walidacji wartości i limitów;
- klucze descriptorów i stringi nie są ograniczone rozmiarem;
- `_lruAccessAt` przyjmuje dowolne liczby, w tym wartości niefinitywne;
- przy pełnych 50 deskryptorach nowy descriptor jest odcinany przez `.slice(0, MAX_DESCRIPTORS)`, a caller później może dodać go z powrotem; `_lruAccessAt` nie jest przycinane (`analysisChartPreferences.ts:291-321`);
- limit 256 KiB jest sprawdzany tylko raz; po przycięciu do połowy kod nie sprawdza ponownie rzeczywistego rozmiaru (`258-282`);
- test localStorage nadpisuje `globalThis.localStorage` i go nie przywraca.

### A-12 — Specialized surfaces nie zostały zmigrowane

Zmieniono tylko `AnalysisFrequencySurface`. `DynamicStructureFactorView` nadal używa czterech surowych `<select>` (`DynamicStructureFactorView.tsx:29-33`) i starej kompozycji panelu. `SpinWaveGammaView` nie został przeniesiony na wymagany shared ChartSection/Select contract. Nie dodano wymaganych zmian/testów `frequencyRenderModels` dla etapu 8.

### A-13 — Etap dokumentacyjny 0 pozostaje czerwony

Dokumenty nadal przeczą aktualnej, poprawnej architekturze footera:

- `02-module-catalog.md:76` mówi `viewport-main, target panel-bottom`;
- `16-charts-analysis-module.md:130` proponuje slot-aware wariant Analysis w `panel-bottom`;
- aktywny starszy plan `2026-07-25-analysis-workbench-refactor.md:153-161` wymaga, by manifest Analysis deklarował `viewport-main + panel-bottom`.

Kod poprawnie zachowuje `analysis-plots/manifest.ts` z `slots: ["viewport-main"]`, a `transport-footer` jest jedynym ownerem `panel-bottom`. Etap 0 miał usunąć właśnie tę rozbieżność; dirty diff nie zmienia żadnego z wymaganych dokumentów ani footer tests.

## 5. Macierz realizacji etapów 0–11

| Etap | Status | Ocena |
|---|---|---|
| 0 — docs/baseline | **FAIL** | Trzy źródła nadal instruują `panel-bottom` ownership przez Analysis; brak wymaganego doc/test diffu. |
| 1 — instrumentation | **FAIL** | Brak zmian w trzech wymaganych skryptach i `chartDiagnostics`; brak versioned `ChartPerformanceProof`, fixtures i baseline. |
| 2 — HTTP truth/live | **FAIL / regresja** | Realtime usunięty jako data source, ale follow i resume nie fetchują po pierwszym oknie; brak abort/session tests. |
| 3 — preferences/range | **FAIL** | Pliki istnieją, lecz są niewpięte; range modes i targetPoints nie wpływają na query; brak hydration testu. |
| 4 — renderer/tokens | **PARTIAL, gate FAIL** | Dodano formatter/token resolver, ale raw colors blokują architekturę, jednostki osi są błędne, brak real lifecycle/theme tests i screenshotów. |
| 5 — ChartSection/tabs/status | **PARTIAL, semantics FAIL** | ChartSection istnieje; Tabs nadal są ręczne; trust/revision nie są poprawnie widoczne, tests osłabiono. |
| 6 — legend/axes/controls | **FAIL** | Solo i Fit nie działają; brak range/unit/point controls, descriptor prefs i wymaganych testów. |
| 7 — Quick Chart/footer | **BASELINE PRESERVED, NOT QUALIFIED** | Poprawny owner istnieje w baseline; dirty diff nie zmienia wymaganych plików/skryptów i nie dowodzi 100 cykli Quick Chart + 3D. |
| 8 — specialized surfaces | **FAIL** | Dynamic Structure Factor i Spin Wave Gamma nieprzeniesione; frequency tylko częściowo opakowane. |
| 9 — export/Points Table | **FAIL** | Points Table martwy; PNG bez sidecar; provenance niepełne; brak real download/PNG proof. |
| 10 — controller split | **FAIL** | Trzy hooki martwe, monolit pozostaje; dwie równoległe implementacje. |
| 11 — qualification/retirement | **FAIL** | Brak 2 green runs i Analysis proof; stare komponenty/CSS/listener pozostają; specs nie zaktualizowane. |

### 5.1. Konfrontacja z raportem Opusa

Przeanalizowano także raport:

`/home/kkingstoun/.gemini/antigravity-ide/brain/79ba8f43-a41c-436e-b539-79c1e10564c7/analysis-refactoring-audit.md`.

Raport Opusa poprawnie wykrył martwe preferences/hooki/Points Table, dziesięć brakujących testów, błędne `yAxisIds` w solo, no-op Fit, ręczne Tabs, brak ECharts aria, brak keyboard reset oraz brak final qualification. Te findings zostały potwierdzone w bieżącym kodzie i uwzględnione powyżej.

Nie można jednak przyjąć jego końcowej klasyfikacji bez korekty:

- oznaczył etap 0 jako zakończony i dokumenty jako aligned, podczas gdy `02-module-catalog`, spec 16 i aktywny starszy plan nadal żądają `panel-bottom` contribution przez Analysis;
- potraktował etap 2 jako częściowy głównie z powodu brakujących testów, ale nie wykrył, że aktualny warunek `enabled` trwale blokuje live follow i resume;
- oznaczył etap 7 jako zakończony bez wymaganego 100-cycle Quick Chart + 3D proof;
- uznał scientific formatting za dobry, ale nie sprawdził wspólnej semantyki scaled ticks i preformatted axis unit, przez co przeoczył A-02;
- uznał ChartLegend/trust za zasadniczo poprawne, ale nie wykrył odwróconej flagi solo ani faktu, że tekst trust nie jest renderowany;
- rekomendował hardcoded Mocha hex w TypeScript, co bezpośrednio łamie token-first gate i nie jest dopuszczalną naprawą;
- podał wyniki testów bez aktualnego uruchomienia pełnych kwalifikacyjnych bramek. Bieżące wykonanie daje 3854 pass, 1 skip i 4 fail, a browserowe Analysis gates są czerwone.

Wniosek: raport Opusa był użytecznym drugim przeglądem statycznym, lecz zaniżył ryzyko dwóch najważniejszych błędów i przeszacował stopień realizacji planu. Niniejszy raport zastępuje jego macierz etapów wynikami zweryfikowanymi w kodzie i uruchomionych bramkach.

## 6. Wyniki uruchomionych bramek

Komendy uruchomiono 2026-07-27 na bieżącym dirty worktree.

| Bramka | Wynik | Istotny dowód |
|---|---|---|
| `corepack pnpm --dir apps/control-room typecheck` | **PASS** | Next route types wygenerowane, exit 0. |
| `corepack pnpm --dir apps/control-room lint` | **PASS** | ESLint `--max-warnings=0`, exit 0. |
| `check:architecture-hygiene` | **FAIL** | 19 raw hex w nowym `fullmagChartTokens.ts`. Bezpośrednia regresja tego diffu. |
| `check:api-hygiene` | **FAIL** | Raw `/v2/...` w `src/shared/domain/analysis/chartContracts.test.ts`; plik jest poza ocenianym diffem, więc to zastany repo-wide blocker, nie nowa regresja Analysis. |
| focused Analysis/shared chart tests | **PASS** | 19 plików, 168 testów. Nie obejmują blokujących ścieżek opisanych wyżej. |
| pełny `vitest run` | **FAIL** | 402 pass, 1 skip, 1 file/4 tests fail w `SimulationPreparationMounted.test.tsx` (poza ocenianym diffem). |
| `smoke:analysis-plots` | **FAIL** | Timeout w `waitForAnalysisRowsAndCanvas`. Skrypt nadal szuka usuniętego `.fm-analysis-plots__range span:last-child` (`smoke-analysis-plots.mjs:162-185`). |
| `audit:chart-performance` | **FAIL** | `rows.bin response size was not measured`; brak kompletnego proof. |
| `audit:idle-performance` | **PASS** | Settled idle audit passed. |
| `audit:viewport-3d-memory-churn` | **PASS po naprawie PATH do pnpm** | 120 cached quantity switches, heap 18.9→20.3 MiB, brak field requests. Skrypt nie zawiera wymaganego scenariusza Quick Chart + Analysis, więc nie kwalifikuje etapu 7/11. |
| `git diff --check` | **FAIL** | `AnalysisPlotsModule.tsx:58: new blank line at EOF`. |
| React Doctor | **NIEURUCHOMIONY** | Lokalnie brak pakietu; pobranie z npm nie powiodło się w sandboxie, a wykonanie zdalnego `latest` poza sandboxem zostało odrzucone jako ryzykowne. |

Browser smoke został ponowiony poza sandboxem, więc jego timeout nie jest błędem uruchomienia Chromium. Audyt 3D zbudował produkcyjny audit build i odświeżył tracked artefakty `apps/control-room/.artifacts/viewport-3d-browser-audit/*`; te pliki są dowodem osobnego scenariusza 3D, nie dowodem Analysis/Quick Chart.

## 7. Pozytywne elementy, które warto zachować po naprawie

Nie wszystko należy wyrzucić. Następujące kierunki są zgodne z planem, ale wymagają integracji i testów:

- ECharts pozostaje za neutralnym `ChartRendererOwner` i ma jawne `dispose()`;
- data animation oraz ECharts sampling są wyłączone;
- dodano 12 tokenów chart palette w centralnym `theme.css` dla Mocha i Latte;
- CSV/TSV zawiera row id, revision, decimation i numeric round-trip values;
- tekstowe komórki eksportu mają ochronę przed formula injection;
- Points Table jest bounded do 500 wierszy na serię;
- reduced-motion wyłącza live pulse;
- pełny manifest Analysis nadal nie przejmuje `panel-bottom` od footera;
- focused tests i typecheck/lint pozostają zielone.

Te elementy nie równoważą jednak blockerów A-01 i A-02 ani braku dowodów produkcyjnych.

## 8. Minimalna kolejność naprawcza

1. **Zamrozić publikację i wydzielić czysty zakres Git.** Nie łączyć Analysis z FEM, submodułem ani wygenerowanymi artefaktami bez jawnej decyzji.
2. **Naprawić scientific correctness.** Dodać RED tests i skorygować live invalidation/pause/resume oraz spójne skalowanie wartości i unit label.
3. **Wybrać jedną architekturę controllera.** Wpiąć i przetestować family hooks albo usunąć je; nie utrzymywać monolitu i kopii równolegle.
4. **Wpiąć descriptor preferences end-to-end.** Range modes, point budget, units, visibility i solo muszą zmieniać właściwy view/query owner i przejść SSR/storage/session tests.
5. **Dokończyć controls i a11y.** Działający Fit, shared Tabs/Select/Dialog, jawne solo, non-color trust, revision, DOM summary i dostępny Points Table.
6. **Naprawić token/render contract.** Zero raw colors poza theme, jedna semantyczna oś/unit pipeline, zachowanie zoomu przy theme update, pełny real renderer lifecycle test.
7. **Dokończyć eksport i specialized surfaces.** Kompletny sidecar także dla PNG, real download inspection, Dynamic Structure Factor i Spin Wave Gamma na wspólnych primitives.
8. **Naprawić testy i instrumentację przed kolejnym claimem.** Nie zastępować semantic assertions ogólnym sprawdzaniem klas.
9. **Uruchomić pełną kwalifikację dwa razy na production buildzie.** Trzy fixture sizes, relevant/irrelevant/paused/resume, 100 Analysis↔3D, 100 Quick Chart cycles, heap/listener/observer/worker plateau, WebGL health, Mocha/Latte/narrow/200%/keyboard/axe, pobrane eksporty.
10. **Dopiero po zielonych dowodach** usunąć stare komponenty/CSS, zaktualizować specs i utworzyć commit przypięty do artefaktów.

## 9. Kryterium ponownego review

Kolejne review ma sens dopiero, gdy jednocześnie:

- A-01 i A-02 mają reprodukujące RED tests, poprawkę i GREEN;
- nie ma niewpiętych hooks/preferences/Points Table;
- `check:architecture-hygiene`, `smoke:analysis-plots` i `audit:chart-performance` przechodzą;
- istnieje co najmniej jeden kompletny `ChartPerformanceProof` dla Quick Chart + 3D i jeden dla full Analysis↔3D;
- working tree/commit zawiera wyłącznie zamierzony zakres Analysis;
- status „complete” odnosi się do pełnego SHA oraz zapisanych artefaktów, nie do liczby dodanych plików.

**Końcowa klasyfikacja:** kod zawiera wartościowe prototypowe fragmenty, ale obecna implementacja jest funkcjonalnie niekompletna, ma dwa blokujące błędy poprawności i nie spełnia Definition of Done planu. Nie może zostać uznana za produkcyjną ani za pełną realizację refaktoryzacji Analysis.
