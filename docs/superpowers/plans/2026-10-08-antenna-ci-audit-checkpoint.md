# Anteny — checkpoint audytu blokad CI, 2026-10-08

## Zakres i stan

Kontynuacja T01 oraz bramek integracji T18, nie zamknięcie całego planu
T00–T18. Punkt wyjścia: `fbfae6818522b4f368ee53f2dff36690af1a466c`.
PR: https://github.com/MateuszZelent/fullmag/pull/147, nadal Draft.
Commit zweryfikowanego przyrostu:
`0a7d2d7cfd73ecf273b48e90ff636066b2dab8d2`, wypchnięty na branch PR.
Pobrany `origin/master`: `2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`,
już zawarty w branchu. Worktree przed przyrostem było czyste.

## Naprawiony przyrost

- `apps/control-room/scripts/audit-compute-performance.mjs`,
  `checkObjectGeneralPanelVisualizationSelector`: audyt wymaga teraz
  rzeczywistej komendy `visualization.target.set-primitive-mono-color`,
  `primitiveMonoColor` oraz `surfaceColorSource`. Jawnie zabrania używania
  komendy koloru shadera w tym panelu. Zachowuje wymagania selektora,
  porównania kolorów, centralnego rejestru komend, wireframe oraz zakaz
  subskrypcji pełnego registry. `shaderMonoColor` pozostaje wymagane jako
  część rozwiązywania koloru, nie jako komenda mutacji.
- `useObjectVisualization.performance.test.ts`: zapisano zgodne asercje
  primitive/shader i pól selektora, bez usuwania kontroli wydajności.
- `ribbonStructure.test.ts`: nazwę testu zmieniono z „bootstrap FDM domain”
  na „initial FDM domain”. Dane wejściowe i asercje są identyczne.
  Skaner API wcześniej dopasowywał samo słowo w nazwie testu; nie znaleziono
  tam ścieżki legacy. Nie zmieniono skanera ani jego wyjątków.

Nie zmieniono zachowania produkcyjnego UI, API ani solverów. Nie restartowano
aktywnego workspace ani nie uruchamiano nowego solve.

## Dowody

- Bezpośrednie wykonanie istniejącego audytu produkcyjnych źródeł Node:
  `Compute performance audit passed.`, exit 0. Przed zmianą ten sam audyt
  odmawiał z powodu wymagania starej komendy shadera.
- Wykonano rzeczywisty legacy search z `LEGACY_PATH_PATTERN`, tym samym
  zakresem `src`, wyłączeniem generated oraz
  `filterCanonicalComputePreviewMatchLines` i `shouldFailSearchCheck`:
  PASS, exit 0. Nie uruchamiano wrappera `check-api-hygiene.mjs`, ponieważ
  automatycznie wykonuje testy jednostkowe Node. To dowód tej kontroli
  wyszukiwania, nie pełnego wrappera ani wszystkich kontroli API.
- `git diff --check`: PASS dla przyrostu.
- Niezależne review trzech plików: brak Required/Blocker; kontrola komend
  jest silniejsza, nie wyciszona.
- Zarządzany pełny ESLint (`just lint-control-room-source`): PASS, exit 0,
  receipt `c07a7f8638ee421cb79cc2af1266786c`. Źródła frontendu były
  zamrożone na czas kontroli; digest przed i po:
  `b1f61d1168b7a625a4d2c5e91c96c78180e9c1f8744a542481015bc30b712b67`.
- Zgodnie z zakazem projektu nie kompilowano ani nie wykonywano Vitest/Rust
  unit tests. Zapisane asercje nie są przedstawiane jako wykonane testy.

## Pozostałe blokady wykryte w CI

Źródło: istniejące logi GitHub Actions dla powyższego HEAD, run
`37719938810`; dokumentacyjny build także run `37719938781`.

1. `rust-contracts`: `E0063`, fixture `make_test_plan` w
   `crates/fullmag-runner/src/native_fem.rs` nie inicjalizuje
   `charge_transport_plans`. Kolejny przyrost powinien uzupełnić pusty
   wektor dla tego planu bez modułu charge; nie zmieniać produkcyjnej fizyki.
2. `python-contracts`: stara asercja tekstowa w `test_api.py` oczekuje
   `.translate((1.5e-08, 0, 0))`, podczas gdy exporter zachowujący round-trip
   float emituje `.translate((1.5e-08, 0.0, 0.0))`. Nie cofać precyzyjnego
   formatera; dostosować test semantycznie po przeczytaniu konsumentów.
3. `control-room-contracts`: poza naprawionym audytem pozostają m.in.
   niepełne mocki resource registry (`resources.getRevision is not a
   function`), mock development hook bez nowego eksportu oraz rozbieżności
   asercji autosave i pozostałych testów. Wymagają osobnej analizy; nie
   zakładać, że wszystkie są wyłącznie błędami fixture.
4. `build`: validator wymaga sidecar manifestu
   `docs/physics/0920-regional-time-domain-field-drive.source-map.json`;
   istniejący manifest `0980-dynamic-current-and-oersted-coupling` wskazuje
   niejednoznaczny symbol `validation_errors` w `spin_transport.rs`.
   Naprawa wymaga skilla `scientific-documentation-contract` i adekwatnej
   walidacji dokumentacji naukowej, nie wyłączenia bramki.
5. `browser-fixture-smoke`: `qualifyPhysicsScopeExclusivity` w
   `scripts/smoke-inspector.mjs:1048` przekracza 60 s podczas oczekiwania
   na widoczny menuitem `Rotated interfacial DMI`. To ustalony punkt
   niepowodzenia, nie jeszcze przyczyna braku tej pozycji w danym scenariuszu.
   Nie zaliczać na podstawie wcześniejszego lokalnego renderu CPW.

Pełniejszy inwentarz frontendu z tego runu: 26 porażek testów, jedna błędnie
wykryta suite oraz 7701 testów PASS. Są to wyniki zdalnego CI, nie lokalne
wykonanie przez tego agenta. Audytowany przyrost adresuje dwie porażki
dotyczące komendy koloru; nie zgłasza naprawy pozostałych.

- `scripts/lib/antenna-authoring-browser.test.mjs` używa `node:test`, lecz
  Vitest zbiera go jako własną suite (`No test suite found`). Sprawdzić
  rozdział runnerów i zachować rzeczywiste wykonanie Node w odpowiedniej bramce.
- `AntennaCompositionPanels.dom.test.tsx`: dziewięć porażek niepełnego
  kontraktu mock resource registry; `DevelopmentBackendBanner.test.tsx`:
  siedem porażek mocka bez `useDevelopmentWorkspacePaused`.
- Testy Move Object oczekują ośmiu invalidacji zamiast dziewięciu;
  `useSimulationPreparation` oczekuje trzech requestów zamiast dwóch.
  Przed zmianą asercji ustalić właściwy zestaw zasobów i semantykę sesji.
- Scratch Inspector nie renderuje `Ms`: sprawdzić jawne moduły fizyki w
  fixture, nie aktywować fizyki na podstawie nazwy/type obiektu.
- Kontrakt CSS odmawia `gap: 1px`/`2px`; nie usuwać minimalnych wymagań
  czytelności w celu uzyskania PASS.
- Testy PrimitiveObjectLayer wymagają starego literalnego odczytu koloru
  i globalnie zabraniają `computeVertexNormals`; sprawdzić nowy helper
  koloru oraz odrębny kontrakt siatki anteny przed korektą asercji.
- Autosave: oczekiwane numeryczne `until_seconds`, rzeczywiście string;
  najpierw ustalić kanoniczny typ i wymagane zachowanie transakcji.

CI należy ponownie sprawdzić dla nowego HEAD. Zielone lokalne kontrole tego
przyrostu nie oznaczają zielonego CI całego pakietu. Nadal brakuje kwalifikacji
pełnego current → reusable field → LLG/FFT oraz wszystkich czterech realizacji.

## Drugi przyrost — fixture FEM i semantyczny eksport CSG

Punkt wyjścia: `c423b4c310f27c20e7cd37e7e1049f1cb0143cad`.
Commit przyrostu: `92ee66c6ab025e74b117c6254374b5b3b1d1f6d2`,
wypchnięty na branch PR #147.

- `crates/fullmag-runner/src/native_fem.rs::make_test_plan`: dodano
  `charge_transport_plans: vec![]` do istniejącego konstruktora objętego
  `#[cfg(test)]`. Odpowiada to `FemPlanIR::default()` w
  `crates/fullmag-ir/src/plan.rs`. Fixture nie zadawał modułu charge;
  nie dodano go ani nie zmieniono kodu produkcyjnego solvera.
- `packages/fullmag-py/tests/test_api.py`,
  `test_builder_draft_exports_structured_csg_geometry`: zastąpiono
  dopasowanie tekstu translacji sprawdzeniem AST. Wymagana jest dokładnie
  jedna translacja z dokładnym wektorem `(15e-9, 0.0, 0.0)`.
  Pozostałe asercje geometrii Box/Difference/Cylinder zachowano.
  Równoważny zapis zer całkowitych i zmiennoprzecinkowych jest akceptowany;
  błędny wektor, brak lub dodatkowa translacja nadal powodują odmowę.
  Produkcyjny `_py_float_roundtrip` i renderer nie zostały zmienione.

Weryfikacja bez buildu, unit-test runnera i solvera:

- Python `-B`, kontrola produkcyjnego `_render_geometry_expr` na tej samej
  geometrii CSG: wartości translacji PASS; rzeczywisty literal zawiera
  `(1.5e-08, 0.0, 0.0)`.
- Niezależny wektor o długiej mantysie: dokładny round-trip trzech wartości
  IEEE-754 sprawdzony przez `float.hex()`, PASS.
- `ast.parse` zmienionego pliku Python: PASS.
- `git diff --check` dla przyrostu: PASS.
- Niezależne review dwóch plików: brak Required/Blocker.
- Próba dodatkowego parsera Rust nie została wykonana: środowisko
  `contract-python` nie ma modułu `tree_sitter` (`ModuleNotFoundError`).
  Nie instalowano zależności ani nie zastępowano tego kompilacją.
  Składnia/typowanie i testy Rust pozostają **NOT VERIFIED** w tym przyroście.
- Nie uruchomiono całego testu z `load_problem_from_script`, suite Python
  ani Rust/Vitest. Kontrole in-memory nie są dowodem całego round-trip
  sceny ani rozwiązania naukowego. Nowe CI musi potwierdzić obie korekty.

To postęp T01 i bramek T18, nie odbiór całego planu. Pozostałe blokady
frontendu, publikacji naukowej i browser smoke nadal wymagają naprawy.

## Trzeci przyrost — kontrakt active lane w browser smoke

Punkt wyjścia: `be06fe48cd53ed01b192194133d99d4e65badb44`.

Przyczyna timeoutu `Rotated interfacial DMI` nie była nieobecnością funkcji
w produkcyjnym menu. `inspectorPhysicsGuardLane` w kontrolowanym HTTP
zwracało `source.kind = "fixture"`, natomiast produkcyjny
`resolveActiveLaneDiscretization` wymaga `"planner"`. Resolver poprawnie
zwracał `unknown`; ribbon nie udostępniał katalogu FEM.

- Fixture symuluje teraz prawidłowy snapshot planera (`kind: "planner"`).
  Zachowano profil `inspector-smoke`, status nauki `not_asserted` oraz
  wszystkie kontrole konfliktu global/object przed mutacją.
  Nie poluzowano produkcyjnego resolvera ani nie dodano fallbacku z carrier.
- `check-ribbon-active-lane.mjs` interpretuje rzeczywistą funkcję fixture
  i produkcyjny resolver. Nowa regresja przed poprawką odtworzyła odmowę
  `unknown !== fem`; po poprawce PASS dla FEM, dostępności rotated DMI oraz
  zachowanego `qualification.status = not_asserted`.
  Dotychczasowe 13 kontroli, w tym fail-closed nieznanej ścieżki, nadal PASS.
- Dodano `just verify-inspector-routing-browser`, stały port 3261,
  dokładny whitelist shell boundary oraz scenariusz istniejącego managed
  runnera. Wykonuje cały istniejący `smoke-inspector.mjs` na `/workspace`,
  nie jego skrócony zamiennik ani działającą sesję użytkownika.
- Raport/channel scenariusza ustawiane są także dla trasy workspace bez
  dodatkowej fixture page. Windows używa jawnego kanału Chrome; bez tej
  konfiguracji skrypt zachowuje dotychczasowy Playwright Chromium.
- Niezależne review pięciu plików: brak Required/Blocker; mechanizm
  immutable snapshot, blokady, digestów oraz cleanupu własnego procesu
  zachowano.
- Składnia zmienionego runnera Python i `git diff --check`: PASS.

Pełny browser smoke i ESLint uruchomiono sekwencyjnie. Wyniki końcowe będą
dopisane po zakończeniu polecenia; review i kontrola resolvera nie zastępują
realnego przeklikania Inspectora. Nie kompilowano testów jednostkowych,
nie restartowano workspace 3197 i nie uruchamiano solvera.

Pierwszy pełny smoke (`bc92bcc054294f6db5cafd5683be6f69`) zakończył się
FAIL przed testem konfliktów fizyki: render count tekstury wyniósł 4 przy
budżecie 3. Źródła przed/po były identyczne, a zakończenie własnego serwera
potwierdzone. Nie jest to dowód przejścia poprawki menu.

Hipotezę obejmowania stabilizacji panelu przez pomiar sprawdzono, przenosząc
istniejące oczekiwanie 1100 ms przed baseline. Druga próba
`aa958927acd74b709a5a0e90fe25dd06` również odmówiła przy czterech renderach.
Hipoteza nie wyjaśniła błędu; dodatkową zmianę granicy pomiaru wycofano.
Nie zwiększono `renderCount <= 3`, timeoutów ani request budget i nie
usunięto żadnej kontroli. Oba uruchomienia potwierdziły cleanup własnego
serwera. Pełny smoke pozostaje **FAIL**, a poprawka menu ma na razie dowód
interpretowanej regresji, nie odbiór przeglądarkowy.

Po powtórzeniu błędu sprawdzono oficjalne możliwości diagnostyki React:

1. [Profiler](https://react.dev/reference/react/Profiler): rozdzielić commit
   według `phase`/`commitTime`; to wybrany następny krok, zanim kod zostanie
   zmieniony. Sam render count nie wskazuje właściciela nadmiarowej aktualizacji.
2. [Batching](https://react.dev/learn/queueing-a-series-of-state-updates):
   sprawdzić granice asynchronicznych aktualizacji pending/ACK/sync, nie
   wprowadzać wymuszonego flush ani scalać niepowiązanych transakcji na ślepo.
3. [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore):
   sprawdzić stabilność snapshotów oraz właścicieli subskrypcji zasobów.
4. [StrictMode](https://react.dev/reference/react/StrictMode): zweryfikować
   rzeczywisty tryb środowiska; nie przełączać go w celu zaliczenia testu.

Pełny ESLint z polecenia sekwencyjnego nie został uruchomiony, ponieważ
browser gate zakończył się niepowodzeniem. Nie wolno przedstawiać go jako
PASS dla tego przyrostu. Zmiany pozostają WIP do dalszej diagnozy i kontroli;
nie stanowią podstawy do merge ani zamknięcia T01/T18.

## Aktualizacja PR na żądanie użytkownika

Ponowny `git fetch origin master` potwierdził bazę
`2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`; liczba commitów
`HEAD..origin/master` wynosi 0. Nie był potrzebny kolejny merge mastera.
Zmiany są przekazywane do istniejącego roboczego PR #147, nie bezpośrednio
do mastera. Worktree pozostaje zachowany do naprawy bramek.

Trzecia próba pełnego smoke, receipt `52071de32b11480cbb1cb39c9c79d7dc`,
zakończyła się FAIL. Digest przed/po:
`f5e32adfaf6f17a866e0180893e651c970b9c01fe8ade9353d6c0fc100b01f65`;
cleanup własnego serwera potwierdzony. Nowy ograniczony artefakt
`browser/magnetic-texture-mutation-evidence.json` zachowuje oś czasu i żądania.
Zarejestrowano dwie próbki `update` i dwie `nested-update`, 13 żądań,
w tym jeden transaction POST i jeden sync POST. To próbki profilera
ograniczonego do 1000 ms na nazwę/fazę, nie pełna liczba commitów React.
Zachowano tożsamość panelu, fokus, scroll i opacity; błąd wydajności nadal
wymaga poprawki. Nie zwiększono budżetów i nie wyłączono kontroli.

Niezależna analiza wskazuje na niepublikowany do resource store
`committed_scene` z ACK oraz następujące po nim odświeżenia scene/regions
i script sync jako kierunek dalszej diagnozy. Nie wdrożono tej hipotezy
bez osobnej weryfikacji. Fixture i narzędzia diagnostyczne w PR nie oznaczają
naprawy tego błędu ani ukończenia modułu anten.

Kontrole przy publikacji: 13 interpretowanych kontroli produkcyjnych oraz
nowa kontrola fixture active lane PASS; składnia Node/Python i scoped
`git diff --check` PASS. Pełny ESLint zakończony PASS/exit 0, receipt
`4dd6288928fd47d9903e32e9a23c2de7`. Nie kompilowano testów jednostkowych.
Zmiany diagnostyczne są gotowe do publikacji w roboczym PR, ale pełna
kwalifikacja Inspectora i całego modułu pozostaje niezaliczona.

## Dalsza diagnoza Inspectora — publikacja ACK

Po publikacji `89177c627a85e860c6bf244010dc6b003fb69b29` wdrożono lokalnie
publikację `committed_scene` w save/clear tekstury, z istniejącym fence
session/history oraz ponownym sprawdzeniem po script sync. Nie zmieniono
pełnej listy invalidacji ani budżetów. Stan pozostaje WIP.

Pełny smoke receipt `b7c514770f034f43b4522a391c0ad7ab` zakończył się FAIL;
digest przed/po identyczny:
`3fcbc9283a74e609d15a391d4196680d37a5e1c070034e0c2db15910dcc1cebd`.
Zakończenie własnego serwera potwierdzone. Rzeczywisty browser evidence
potwierdza usunięcie GET scene po ACK: liczba żądań spadła z 13 do 12,
history-before GET pozostał, jeden transaction POST i jeden sync POST.
To dowód optymalizacji zapytań, nie naprawy całego błędu.

Nadal cztery próbki profilera: `update` przy 7894.7 i 9252.9 ms,
`nested-update` przy 8281.1 i 9481.6 ms. Dwie ostatnie zagnieżdżone próbki
mają duration 0; nie dowodzi to, że nie wykonano commitów. Panel, fokus,
scroll i opacity pozostały stabilne. Następny krok: zidentyfikować właściciela
`nested-update` i granice czasowe history/ACK/sync; sam brak ponownego GET
nie wystarczył do budżetu renderów. Session/history fence nie zastępuje
osobnej ochrony zmiany targetu lub nowszego szkicu. Nie zamknięto T01/T15/T18.

Architecture hygiene PASS. Produkcyjny TypeScript source-check PASS, receipt
`ec8afda728ff46c4936a162aab4ad429`; nie kompilowano testów jednostkowych.
Pełny ESLint zakończył się PASS/exit 0, receipt
`164e8eb835f747249afe5e4dc0e7cc4b`. Sesja polecenia `73461` jest zakończona;
nie pozostaje aktywny browser/source-check tej iteracji.

Read-only review nie ustaliło właściciela `nested-update`. Konkretni kandydaci
to resize/visibility state w Radix ScrollArea i rejestracja triggerów Tooltip.
Tab store nie publikuje dla niezmienionego aktywnego tab; panel tekstury nie
rejestruje edit-session. To hipotezy, nie potwierdzona przyczyna. Następna
diagnostyka powinna zachować ograniczoną oś commitów gałęzi Inspector
(nazwy komponentów i informację o zmianie hook-state, bez wartości stanu)
wyłącznie w browser fixture; nie zmieniać produkcyjnych primitive bez dowodu.

## Odbiór śladu commitów — Tooltip, nie ponowny GET

Dodano opt-in `CONTROL_ROOM_INSPECTOR_COMMIT_TRACE=1` w pełnym smoke.
Helper `scripts/lib/inspector-commit-trace.mjs` zachowuje callback hooka
React, ogranicza przejście do 4096 fiberów, zapis do 128 zmian/commit,
32 indeksów hooków i 64 commitów. Wynik zawiera metadane, bez wartości
hook-state i bez serializacji fiberów. Mechanizm korzysta z
[hooka React](https://github.com/facebook/react/blob/main/packages/react-reconciler/src/ReactFiberDevToolsHook.js);
to diagnostyka zależna od wewnętrznej struktury, nie publiczny kontrakt produktu.

Pierwszy receipt `e71087bdcce74768b334bec662b14fd3` i drugi
`5382ea059d4e4e43aae690e83f2c746d` nie pozwalały ustalić właściciela:
ucięte przejście nie obserwowało wszystkich ponownie użytych fiberów.
Nie wykorzystano tych list jako dowodu przyczyny. Rozdzielono limit zapisu
od limitu przejścia, dodano rozróżnienie ponownego użycia i puste commity.
Kontrole interpretowanego helpera: chaining, bounded retention, brak danych
stanu w JSON oraz zachowanie pustych commitów PASS; składnia i diff PASS.

Receipt `108d67ba42404cbb9b8c3d116fa93920` nadal FAIL na budżecie 4/3,
ale ma kompletny ślad (`traversalTruncated=false`, dropped=0, errors=0).
Digest przed/po identyczny:
`0c5ba9f655d6b674fba39b93a7e76bbec75ff18dc02a93d7e9bbd927e544042c`;
własny serwer zakończony. Przy obu zachowanych próbkach `nested-update`
(8243.9 oraz 9651.3 ms, duration 0) najbliższy commit (8245.7/9652.8 ms)
wykazuje dokładnie cztery komponenty `Tooltip`, indeksy hooków
4/10/11/13/19 i actualDuration 0. Nie jest to dowód kosztu renderu ani
jeszcze dowód konkretnego wadliwego ref; wskazuje właścicieli do dalszej
analizy. Nie wyłączono zerowych próbek ani nie podniesiono budżetu.

Następny krok: zbadać toolbar `InspectorShell`, zależności/refy Radix Tooltip
i odświeżenia całego shell. Nie przypisywać błędu ScrollArea bez dowodu.
Pełne CI, browser gate, runtime/nauka i T00–T18 nadal pozostają otwarte.

Read-only analiza zainstalowanych zależności wskazała
`@radix-ui/react-slot@1.2.3::SlotClone`: w renderze tworzy nowy
`composeRefs(forwardedRef, childrenRef)`. `TooltipTrigger` memoizuje własny
ref, ale Slot przy `asChild` zmienia callback DOM, co wywołuje detach/attach
i `Tooltip.setTrigger(null)` / ten sam element. To mechanizm zgodny ze
śladem czterech Tooltipów; bez dodatkowego pomiaru par ref nie należy
przedstawiać go jako pełnego dowodu każdej aktualizacji. Insertion effect
w `useControllableState` aktualizuje ref callbacka, nie publikuje tam state.

Wybrany następny krok: izolowany, memoizowany footer akcji Inspectora
ze stabilnymi callbackami i istotnymi scalar props; zachować wszystkie
tooltips, disabled/focus i aktualizacje Apply/Reset. Nie zmieniać zależności,
nie ręcznie zastępować Radix i nie filtrować zerowych próbek.
Pełny ESLint nowej diagnostyki pozostaje w aktywnej sesji `25092`;
ostatni odczyt potwierdza działające polecenie. Kontynuacja musi odebrać
ten sam handle przed edycją fingerprintowanych źródeł, bez ponownego startu.

## Izolacja paska akcji — wdrożony WIP

ESLint diagnostyki zakończony PASS/exit 0, receipt
`ddc607e97977434fad5acfe86fbc061f`; sesja `25092` jest terminalna.

`InspectorShell::InspectorActionBar` jest teraz memoizowaną granicą,
która sama subskrybuje `useInspectorEditSession`. Shell nie posiada tej
zbędnej subskrypcji. Zachowano cały markup footer, tooltipy, `useId`,
aria-describedby, disabled, focus oraz Apply/Reset. `InspectorModule`
stabilizuje callback Focus przez `useCallback`; kliknięcie nadal korzysta
z żywego selection controller, a zmiana project-only aktualizuje callback.

Niezależny review wszystkich zmienionych linii: brak Blocker/Required,
niezmienione reguły dirty/valid/pending/lock. `git diff --check` PASS.
Pełny smoke z diagnostyką jest uruchomiony w sesji `9352`; przed wynikiem
nie wolno przedstawiać poprawki jako odbioru bramki renderów lub UI.
Budżety render/request, profiler i timeouty pozostają bez zmian.

Pełny smoke zakończył się PASS/exit 0, receipt
`98a2589f3e8d45659035972eda026236`. Digest przed/po:
`c4a81e45281b868967799cc7db20a4500a0477640d2358d38421b4424e45612a`;
źródła niezmienione, własny serwer zakończony. Tekstura: render samples
4 → 2 przy niezmienionym limicie 3, żądania 12 przy limicie 12;
zero zachowanych `nested-update`. Wykonano pełny skrypt, w tym routing,
Object/Airbox mutation stability, dirty-selection guard, wizualizacyjny
Reset i konflikt zakresów fizyki w obu kierunkach. Raport zawiera jeden
oczekiwany console error 409 z kontrolowanego konfliktu; brak nieoczekiwanych
błędów według istniejącego guardu. Nie jest to smoke bez żadnego console error.

Odebrano screenshot `visualization-overview-dark-416.png`: cztery akcje,
układ, kolory i disabled styling zachowane. Nie zmieniono wizualnej jakości
ani density. Produkcyjny TypeScript PASS, receipt
`0463c01d56f64ac890199bc4b72fd8a6`; pełny ESLint tego snapshotu zakończony
PASS/exit 0, receipt `79ba196b6b8940b18554ae65b6040965` (sesja `65728`).
To odbiór konkretnego browser fixture, nie wykonanie anteny,
LLG/FFT ani kwalifikacja czterech backendów. Całe T00–T18 nadal otwarte.

Porównanie identycznego kadru `mode-visualization-phase-controls-416.png`
przed/po izolacji paska: identyczny SHA256
`FFD18C891B351911F7343D0CDE5E445422EA7024FBB684CBCCE9F5A8DB4C742A`.
Dowód dotyczy tego kadru, nie wszystkich możliwych stanów UI.

## Publikacja aktualizacji PR na żądanie użytkownika

Ponowny `git fetch origin master` potwierdził HEAD mastera
`2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`; `HEAD..origin/master` = 0.
Nie było nowych commitów mastera do scalenia. Publikacja obejmuje aktualny
branch zadania w istniejącym PR #147 do `master`, bez merge i bez usuwania
worktree. Lokalny odbiór Inspectora nie zastępuje wymaganych kontroli całego PR.

## T18 — jednoznaczny właściciel walidacji prądu

GitHub job `113144873569`, run `37726218209`, dla HEAD
`bf25abacdcd1856c1889f49c6a31194a52dcea7d` zakończył się failure w kroku
`Require source maps for changed scientific pages`, przed Sphinx. To błąd
publikacji dokumentacji, nie dowód błędu kompilacji aplikacji.

Log wskazuje brak `0920-regional-time-domain-field-drive.source-map.json`
oraz niejednoznaczne `validation_errors` w `spin_transport.rs`: są tam dwie
metody różnych właścicieli. W mapie 0980 i jej indeksie zastąpiono samą
nazwę metody jednoznacznym typem `StructuredCurrentClosureIR`; opis nadal
wskazuje dokładnie `StructuredCurrentClosureIR::validation_errors` i odróżnia
ją od `ConservativeCurrentSourceIR::validation_errors`. Nie zmieniono kodu,
walidatora, równań, progów ani statusów kwalifikacji.

Focused validator całej noty 0980: exit 0. Interpretowany zestaw walidatora:
33/33 PASS, exit 0, bez kompilowania testów jednostkowych. Scoped whitespace
PASS. Brak mapy 0920 pozostaje wymaganym otwartym krokiem; pełny gate zmienionych
stron i publiczny build nadal nie mają odbioru. Nie jest to zamknięcie T18.

## T18/T10 — audyt regionalnego drive i rozpoczęte uzupełnienie 0920

WIP `0920-regional-time-domain-field-drive.md`: 13 istniejących bloków równań
przeniesiono do nazwanych dyrektyw MyST, dodano tabelę głównych symboli i SI,
kotwice sekcji oraz jawny rozdział kontraktu docelowego od faktycznego
manifestu/PBC. Nie zmieniono solvera, tolerancji ani statusu backendów.
Dokument nadal wymaga kompletnej tabeli API/IR, przykładu, mapy źródeł,
bibliografii i focused/changed-page validation; zależny WIP nie jest gotowy
do publikacji ani nie zamyka błędu CI. `git diff --check` PASS.

Źródłowy audyt głównego agenta i niezależnego `regional_drive_source_audit`
ustalił kolejne wymagane działania, nie nowe deklaracje kwalifikacji:

- Python `model/antenna.py::GaussianPlaneWaveFieldProfile` i
  `GaussianPlaneWaveAntenna` istnieją; nota wymaga wzoru i wszystkich parametrów.
- Planner `regional_field_drive.rs::resolve_fdm_regional_field_drives`
  hashuje cały drive, w tym waveform. Docelowy waveform-independent cache
  wymaga oddzielonego podpisu przestrzennego oraz faktycznej regresji reuse.
- `adaptive_cell_average` ma absolutny próg średniej, nie względną tolerancję.
- FEM `zeeman_regional_field.cpp::project_regional_field_drive_bases`
  stosuje inne tolerancje PBC niż nominalny kontrakt noty; trzeba uzgodnić
  kontrakt i wykonać regresję bez maskowania mismatch.
- `regional_field_drive_artifacts.rs::RegionalFieldDriveManifest` nie
  zapisuje norm bazy, PBC certificate/ABI/quantity revisions. FSAL count/times
  pochodzą z harmonogramu, nie telemetry solvera.
- T10: `spin_wave_response.rs::append_requested_spin_wave_artifacts`
  liczy StageLocal względem `start_time_s`, nie waveform origin; source_trace
  pomija direction. Najpierw potrzebna regresja segmentu wznowionego i
  kierunków pola, następnie poprawka zgodna z kontraktem źródła/podatności.
- Gamma collector ograniczony do `my`/`mz` i global/uniform. Finite-k
  `spin_wave_sampling.rs::requested_finite_k_artifacts` wymaga FEM oraz
  >=4 zgodnych snapshotów m/H_drive, nie odejmuje jawnie m0 i odmawia
  nieważnych przekrojów zamiast realizować kompletną analizę z maską.

Nie kompilowano testów, nie wykonano nowego solve/LLG ani nie restartowano
sesji. Pełny plan T00–T18 pozostaje aktywny. Następny krok: domknąć notę/mapę
0920 oraz rzeczywisty błąd czasu źródła Gamma z wykonywalnym dowodem.

## Zapis całego WIP do Draft PR na polecenie użytkownika — 2026-10-08

Ponowny fetch potwierdził master
`2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`: zero brakujących commitów
mastera względem brancha. Istniejący PR #147 kieruje branch
`codex/microwave-antenna-latest-20260909` do `master`.

Pozostały diff dwóch dokumentów jest zapisywany jako jawny WIP, nie jako
ukończona publikacja naukowa. Przykład Python w 0920 wykonano bez LLG;
`drive.to_ir()` jest dokładnie równy pokazanemu fragmentowi JSON (PASS).
Scoped `git diff --check` PASS. Tabela zawiera 41 wpisów publicznego modelu
i fabryk. Nadal brakuje mapy źródeł 0920, pełnego kontraktu publikacyjnego
i jego walidacji; samo zapisanie WIP nie usuwa blockera dokumentacji CI.

Wcześniejszy opis błędu zegara Gamma jest historią audytu: poprawka jest
już w `7742006934104fe805ebabd1a7393a6f798cd5e1`, a jej dokładne dowody
i ograniczenia zapisano w `2026-10-08-gamma-waveform-origin-checkpoint.md`.
Kierunek źródła i kwalifikacja Rust/FFT nadal pozostają otwarte.

Kontrola GitHub dla HEAD 7742006934104fe805ebabd1a7393a6f798cd5e1:
`build` i `control-room-contracts` FAIL; `rust-contracts` in_progress,
`managed-fem-qualification` queued. Browser fixture, Python contracts,
storage guards, canonicalization, generated API, API hygiene, React doctor
i FDM relaxation mają status success. Nie przypisuje się tych wyników
następnemu commitowi przed sprawdzeniem jego własnego CI.

PR pozostaje Draft, bez merge, cleanup ani restartu workspace. Następny krok:
uzupełnić kontrakt 0920, zbadać obie nieudane bramki i uzyskać review oraz
brakujące dowody runtime/nauki przed scaleniem. Zapis WIP nie zamyka T00–T18.

## T18 — domknięty strukturalny kontrakt noty 0920

Dodano sąsiadującą mapę źródeł: 14 nazwanych równań, 69 symboli z SI,
41 pozycji tabeli publicznego API i 37 jednoznacznych źródeł. Nota zawiera
cztery osobne realizacje, macierz source_visible, bibliografię i indeks
path + symbol z linkami do niezmiennego commita. Gaussian jest jawnym
zadanym profilem; nie zastępuje solve 3D przewodnika.

Uzgodniono wzór i pseudokod czasu z waveform origin, również po resume.
Jednostki Gamma opisują rzeczywistą moc binów, a nie PSD na Hz; częstotliwość
ma odrębny symbol nu. Oddzielono masę geometryczną projekcji od Ms-weighted
realizacji energii. Nie promowano źródłowego mixed-mesh path do qualified.

Read-only review znalazł pięć Required: stary stage_start w pseudokodzie,
globalny opis FEM-only predykatów, nadmierną deklarację classifiera Cylinder,
nieistniejącą estymatę błędu w komunikacie oraz nieudowodnione ostrzeganie
ogona sinc/rekomendację próbkowania. Wszystkie poprawiono po sprawdzeniu
źródeł. Ponowny scoped review: brak pozostałych Required/Blocker.

Focused validator 0920 exit 0; public-example guard exit 0; aktualny
przykład Python i dokładna zgodność fragmentu JSON PASS bez LLG; scoped
whitespace PASS. Niezmieniony validator miał wcześniej 33/33 interpretowanych
testów PASS; nie kompilowano testów jednostkowych. Changed-page gate będzie
sprawdzony na rzeczywistym nowym HEAD po zapisaniu mapy w Git.

Nie jest to odbiór strict Sphinx/render, całego CI ani T18/T00–T18.
Pozostają: kierunek Gamma source_trace, runtime FFT/resume, spójność PBC,
waveform-independent cache/provenance i pełna kwalifikacja czterech lanes.
PR Draft, bez merge, restartu workspace lub usuwania danych.

## Publikacja aktualnego zakresu do PR — kontrakt Problem API

Ponowny fetch na polecenie użytkownika potwierdził master
`2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`; brak nowych commitów
mastera poza historią brancha. Wszystkie zmiany trafiają do istniejącego
Draft PR #147, bez bezpośredniego push na master i bez merge.

CI dla `9ff9370eaf3561af814fe124e41f3219f859d694` potwierdziło usunięcie
blockera brakującej mapy 0920. Kolejny błąd dokumentacji dotyczył sześciu
brakujących parametrów konstruktora Problem w tabeli oraz mapie źródeł,
nie błędnych kotwic. Uzupełniono typy, wartości domyślne, walidację,
jednostki, lowering i granicę authoringu względem kwalifikacji wykonania.

Lokalnie: cały krok documented Python API contracts 7/7 PASS;
focused source-map validator PASS; przykład study obniżony przez loader
bez solvera, fragment JSON dokładnie zgodny z wynikiem PASS.
Puste physics_objects jest pomijane, a pięć kolekcji anten pozostaje [].
Nie kompilowano testów jednostkowych. Te dowody nie zastępują strict
Sphinx/render ani CI nowego commita.

Read-only diagnoza wcześniejszego CI frontendu potwierdziła trzy rozjazdy
fixtures: brak eksportu useDevelopmentWorkspacePaused w mocku bannera,
asercja Ms/Aex na magnetic-parameters zamiast osobnego Material child,
oraz oczekiwanie ośmiu invalidacji przy dziewięciu różnych zasobach.
Przyczyna retry w useSimulationPreparation pozostaje nierozstrzygnięta;
sama liczba ticków nie dowodzi błędu produkcyjnego. W tym fragmencie
nie zmieniano frontendu ani nie osłabiano jego bramek.

PR nadal wymaga zielonego CI, review i brakujących dowodów runtime/nauki.
Worktree zachowane do dalszej pracy; T00–T18 pozostaje otwarte.

## Frontend — dwa potwierdzone rozjazdy fixtures

Na bazie `774cea4fe61e14cf9daf250fbf31161d5c7ace94` uzupełniono mock
DevelopmentBackendBanner o useDevelopmentWorkspacePaused=false.
Test konfliktu przesunięcia sprawdza teraz dokładny zestaw dziewięciu
zasobów oraz ich unikalność, zamiast starego oczekiwania liczby osiem.
Zachowano kontrolę rewizji scene:43 dla preparation i 43 dla pozostałych,
konflikt 409, refetch/rebase/retry, reset szkicu i blokadę orbitowania.
Nie zmieniano komponentów ani produkcyjnej polityki invalidacji.

Kontrola parsera/AST z task storage frontend-fixture-contract-20261008.cjs:
baseline HEAD 2/2 FAIL, working source 2/2 PASS. Porównuje importowane
hooki z eksportami mocka i niezależnie zadeklarowany zestaw z rzeczywistą
tablicą geometry dependents; nie emituje TypeScript ani nie wykonuje React.
Scoped ESLint --max-warnings=0 PASS (exec50097 completed/0), whitespace PASS.
Architecture hygiene PASS z właściwego cwd apps/control-room; wcześniejsze
uruchomienie z root repo błędnie rozwiązywało ścieżki i nie jest dowodem regresji.
Scoped review diffu: brak nowych zmian produkcyjnych i osłabionych asercji.

Nie kompilowano ani nie uruchamiano Vitest. Wykonanie tych fixtures w CI,
pełny TypeScript/lint/test gate oraz dwa pozostałe problemy Inspector/retry
nadal wymagają odbioru. Dla bazowego HEAD kontrola GitHub potwierdziła
control-room-contracts 113155821640 i dokumentację 113155821560 in_progress,
managed-fem queued; nie przypisuje się ich przyszłemu commitowi.
T00–T18 nadal aktywne; bez merge, cleanup i restartu workspace.

## Inspector — regresja scalars we właściwym węźle

Baza `41bdedfd883e0d18da9786a78b933daf1b9176ab`. Produkcyjna funkcja
materialInspectorSections celowo wyłącza material-parameters dla
object.magnetic-parameters, a włącza ją dla object.material. Test nie jest
dowodem znikania Ms/Aex po ACK: szukał pól niewystępujących w wybranym węźle.

Zachowano wybór magnetic-parameters, oba ACK, root/focus/scroll, szkic Ku1,
limity listeners i invalidacji oraz kontrolę braku opacity. Dodano asercję
nieobecności scalars w tym węźle; następnie jawną nawigację do Material
tego samego obiektu i niezmienione asercje Ms=1100000 A/m, Aex=1.3e-11 J/m.
Po nawigacji sprawdzany jest również ten sam root panelu. Uzgodniono dwa
frontendowe opisy specyfikacji z istniejącym podziałem odpowiedzialności.
Nie zmieniano komponentów, zasobów, fizyki ani wartości materiału.

Kontrola inspector-material-child-contract-20261008.cjs w task storage:
baseline FAIL (brak jawnej nawigacji), working PASS. Wykonuje rzeczywisty
czysto-JS switch sekcji i parsuje kolejność asercji fixture bez emitowania
TypeScript ani uruchamiania React/Vitest. Scoped ESLint --max-warnings=0
PASS exit0; scoped whitespace PASS. Scoped review bez osłabienia istniejących
wartości scalars i kontroli ACK. Pełne wykonanie React/CI pozostaje do odbioru.

Potwierdzone bieżące CI bazowego HEAD: control-room-contracts 113157050180
oraz documentation build 113157050031 in_progress, managed-fem queued.
Nie przypisuje się tych obserwacji przyszłemu commitowi. Następny krok:
odebrać fixtures CI i zdiagnozować retry nowej potwierdzonej sesji fazami,
bez zmniejszenia oczekiwań 3/4. Następnie kwalifikacja native/LLG/FFT oraz
pełne T00–T18. PR Draft; bez merge, cleanup i restartu workspace.

## Preparation — fazowa regresja retry dwóch sesji

Baza `ca40b06b0c8a07565728a1ef4d266697dbf22f89`. Poprzedni test oczekiwał
rozpoczęcia B po sześciu tickach, lecz nie sprawdzał zakończenia retry A ani
osobnych stanów kolekcji i statusu B. Log expected3/actual2 nie dowodzi
udziału produkcyjnego errorCountRef. Nie zmieniano backoffu ani hooków.

Fixture czeka teraz na błąd A i gotowy wynik retry A. Oddzielne deferred
status/collection B pozwalają sprawdzić brak żądania przy starym current=A
i nowym status=B. Po zgodnej kolekcji B test oczekuje trzeciego żądania
z błędem, a potem czwartego po retry. Każde żądanie ma sprawdzany pełny
sessionScopeKey: dwa A i dwa B, przy tej samej rewizji preparation 7.
Zachowano limit sześciu ticków po 1 ms dla każdej fazy oraz dotychczasowe
advance11ms dla retry; nie zwiększano czasu ani nie obniżano counts 3/4.

preparation-session-phase-contract-20261008.cjs w task storage:
baseline FAIL (brak scope assertions), working PASS; wykonane rzeczywiste
plain-JS funkcje confirmedSessionResourceIdentity i sessionRequestScopeKey,
kontrola AST faz i limitów. To dowód kontraktu fixture i funkcji czystych,
nie wykonanie React/Vitest ani udowodniona naprawa przyczyny starego CI.
Scoped ESLint --max-warnings=0 oraz whitespace PASS. Pełne wykonanie nowej
regresji i TypeScript pozostaje do odbioru w CI; lokalnie testów nie kompilowano.

GitHub dla bazowego HEAD: documentation build 113158350447 SUCCESS;
control-room-contracts 113158350536, Python/Rust/browser/generated-api
in_progress; managed-fem queued. Dokumentacja przeszła swój pełny job,
nie oznacza to zielonego całego PR ani kwalifikacji runtime anten.
Następny krok: odebrać nowe fazy CI i wyciągnąć przyczynę z konkretnego
nieudanego etapu, następnie wymagane native/current→field→basis→LLG/FFT,
trwałość i cztery lanes. T00–T18 aktywne, PR Draft, bez restartu i merge.
