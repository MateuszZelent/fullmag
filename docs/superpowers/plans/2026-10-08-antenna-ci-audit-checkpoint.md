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
