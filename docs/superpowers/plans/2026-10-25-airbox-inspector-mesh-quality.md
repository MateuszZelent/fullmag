# Airbox i Mesh — plan naprawy

**Cel:** poprawne, aktualne i jawnie opisane informacje Airboxa w Inspectorze, także dla siatki mieszanej; dowody API i przeglądarki, PR, merge i cleanup.

**Kontrakt:** wykonanie solvera, opublikowana topologia oraz polityka autorska mają niezależne stany. Brak rozstrzygnięcia wykonania nie odbiera prawa odczytu zgodnego artefaktu. Jakość markera 0 dotyczy Airboxa; jakość całej domeny pozostaje osobna. Brak metryki nigdy nie oznacza pass.

**Baza:** `28f4fcf5bba4387025944b8fb276c94b3eef5eb5`. Worktree zarządzane przez Codex: `/home/kkingstoun/.codex/worktrees/airbox-inspector-mesh-quality/fullmag`; branch `codex/airbox-inspector-mesh-quality`; rejestr `fullmag-d57a89a82a23172e`. Lokalizacja wynika z natywnego narzędzia worktree.

**Ograniczenia:** zachować obce zmiany; tylko grupa Docker wybranego checkoutu; bez hostowych buildów i instalacji; bez kompilacji testów jednostkowych zgodnie z poleceniem użytkownika; żadnego fallbacku GPU→CPU ani fałszywego SICN z proxy.

## Etapy i właściciele

- [ ] Python (worker mixed_quality): publikacja statystyk tet4/prism6/pyramid5 i pozostałych obsługiwanych rodzin, obliczenia per marker i global, jednostki SI, zachowanie pochodzenia metryk. Testy analityczne i nota naukowa przed zmianą obliczeń.
- [ ] API (root): prawdziwy wynik bramek Airboxa z istniejących progów i dowodów, liczba wspólnych węzłów, fallback z raportu budowy dla effective target, kontrola niepełnych danych.
- [ ] UI (worker airbox_frontend): żywe statusy, niezależność inspekcji artefaktu od gotowości solvera, zakres jakości i jednostki, aktualność, poprawne stany FDM.
- [ ] Weryfikacja (root): uruchomienie grupy Compose worktree, adekwatne lint/typecheck i interpretowane sprawdzenia, rzeczywiste dane siatki mieszanej, przegląd wszystkich paneli Airbox Mesh w przeglądarce oraz stanów loading/empty/stale/error. Zmiany edycji wymagają stabilności Object i Airbox.
- [ ] Integracja (root): review diffu i dowodów, logiczne commity, PR do master, wymagane kontrole/akceptacje, merge, bezpieczny fast-forward i cleanup wyłącznie zasobów zadania.

## Kryteria odbioru

1. Root/Mesh i nawigacja wewnętrzna nie generują bezpodstawnego unknown.
2. Published FEM z unresolved execution pozostaje dostępny do inspekcji, bez odblokowania nielegalnych poleceń.
3. Siatka mieszana ma zgodne sumy elementów, węzłów i objętości; miary mają jawny zakres, jednostki i źródło. Test obejmuje również brak i błędne dane.
4. Bramki jakości rozróżniają pass/fail/unknown; loading, brak publikacji i stale nie dają pass.
5. Przeglądarka i API pokazują tę samą rewizję oraz wartości; brak błędów konsoli i utraty tożsamości panelu podczas odświeżeń.
6. Ukończenie wymaga dowodu merge i cleanup; blokady są zapisane z następnym krokiem.

## Ryzyka do review

- Stary manifest po zmianie sceny/polityki i równoczesne odświeżanie zasobów.
- Mieszane rodziny elementów, wspólne węzły i kwadratowe ściany.
- Brak per-element Gmsh quality; nie wolno zastępować jej metryką o innym znaczeniu.
- Rozbieżność authored/runtime/published artifact FEM/FDM.
- Parametry efektywne to ustawienia, nie dowód osiągniętego rozmiaru elementów.

## Dowody

W trakcie implementacji uzupełnić wyniki i pełne hashe commitów. Audyt wejściowy: API master posiadało mixed mesh 1087250 elementów, Airbox 1057639 elementów, 183713 węzłów, quality null oraz unresolved active lane. To nie jest dowód stanu worktree po naprawie.

### Grupa i pierwsze uruchomienie

- Grupa: `fullmag-worktree-fullmag-d57a89a82a23172e`, port `3269`.
- Toolchain: próba `b9ba7444bed64577a4ee011f91cac24d`, sukces; obraz `sha256:411d6a179d9c3323741fe8fa64af5e619b6ee9704f658edad4afcfb0b2273cd2`.
- Pierwszy DEV: próba `a586d153bbc543808ed6b80b6d1b43cb`, sukces; konfiguracja `dde8746005f869facdc35a261a7d1b17cba908c01361edb7a7038bed4b50be44`. Potwierdzony start API; nie jest to jeszcze dowód poprawek ani przeglądarki.
- Receipty są w wolumenie kontrolnym `fullmag-build-control-fullmag-worktree-fullmag-d57a89a82a23172e-7b581684b085de65`.
- Po pierwszym etapie: około 24 GB wolnego miejsca na filesystemie checkoutu. Cache i pakiet grupy pozostają potrzebne do przyrostowej weryfikacji. Brak kandydatów do usunięcia w tym etapie; ponowna ocena po integracji i zatrzymaniu grupy.
- Testy Rust dodane dla pokrycia braków i zgodności danych pozostają niewykonane zgodnie z zakazem kompilacji testów jednostkowych. Kompilacja aplikacji oraz interpretowane sprawdzenia i dowody runtime są osobnymi bramkami.
- Etap API zapisany w `a6a4b622f9efd7aa00a3df0393db5f6ee971c47b`. Przegląd diffu i `git diff --cached --check` bez uwag. Zarządzana iteracja `22d1bef30be9458a833f9c60923c9937` zakończyła kompilację aplikacji, walidację pakietu i start API sukcesem; konfiguracja i grupa jak wyżej. Dowód zachowania API na docelowej siatce pozostaje do uzupełnienia przed merge.
- Statystyki mieszane: 14 interpretowanych regresji Pythona, następnie 3 kontrole zakresu certyfikatu i niezgodnych liczników oraz 4 kontrole histogramów — wszystkie zielone (zestawy częściowo się pokrywają). Walidator source-map oraz 41 testów kontraktu dokumentacji naukowej również przeszły. Objętości, krawędzie i liczności są sprawdzane na analitycznych komórkach; nie oznacza to kwalifikacji solvera.
- API rekonstrukcji geometrii dla starszych danych: zarządzana iteracja `9e5ea28727484ba590e00e480ee93514` zakończyła kompilację, walidację pakietu i start sukcesem. Histogramy zachowują zmienność małych objętości SI; kompletne opublikowane statystyki omijają ponowną rekonstrukcję.
- Review wykryło i zamknęło dwa ustalenia: powiązanie quality/report z aktualną rewizją i unieważnianie zasobów universe po buildzie (P1), oraz zbędną rekonstrukcję kompletnych statystyk (P2). Dodatkowo usunięto przypisywanie globalnego percentyla rodziny do części markerowej, gdy rodzina obejmuje wiele markerów.
- Ostatni typecheck frontendu po poprawce rewizji: exit 0. Kontrola API hygiene: 2 interpretowane testy Node i skan źródeł exit 0; uruchomiono lekki checker na hoście, ponieważ obraz frontendu nie zawiera `rg`. Bez instalacji i kompilacji.
- `react-doctor --scope changed` nie rozpoznał Git w kontenerowym widoku i rozpoczął pełny skan; zatrzymano dokładnie jego procesy. Wynik ograniczonego skanu: NOT VERIFIED. Lint i browser proof są osobnymi kontrolami.
- Fixture `examples/airbox_inspector_mixed.py` używa kanonicznego ograniczonego modelu dwóch ciał mixed-v2, zmieniając końcowy tryb na `interactive=True`, `wait_for_solve=True`. Weryfikacja Inspectora nie uruchamia Solve.

### Checkpoint integracji i próby runtime

- PR: https://github.com/MateuszZelent/fullmag/pull/256 (draft do zamknięcia dowodu przeglądarkowego).
- Commity etapów: Python `e2e5581e127d6883721930210e3bce987867c657`, UI `4aa4508137d3d4018d098e13e59714186da6e6dc`, browser QA `3a571433f43f7a15d027b1ae664f33a23464e2ce`, przeniesienie fixture `7898255ce308cd30b93a6c6016f8d2c74fb2e998`.
- Zarządzany build czystego `3a571433f43f7a15d027b1ae664f33a23464e2ce`: iteracja `c913d65cb0b94f85a1339c48b853e193`, sukces. Końcowy typecheck i ESLint przed aktywacją: sukces.
- Pierwsza aktywacja `55e9f15774ce44f6935865d332153d10`: potwierdzone odrzucenie HTTP 422 `docker_startup_output_mapping_required`, przed wykonaniem skryptu. Fixture przeniesiono z katalogu frontendu do wymaganego `examples`; sprawdzono AST i ścieżkę kanonicznego modelu.
- Poprawiona aktywacja wygenerowała 39 946 komórek mixed-v2. Natywny preparer zakończył się kodem 1: `FEM per-domain quality marker coverage does not match the canonical mesh`. Przyczyna: starszy format jakości wymaga kompletnego zestawu markerów, a pominięcie samego markera z nieobsługiwaną gamma tworzyło niekompletny zestaw. Poprawka ma pomijać cały niekompletny starszy format, zachowując bogate statystyki i rzeczywiście dostępne metryki. Brak publikacji siatki oznacza nadal NOT VERIFIED dla browser proof; solver ma zero kroków.
- Aktualny `origin/master` `28a856ed9df5a4493d2ffd32a7647ac5cc378429` włączono do brancha. Rozwiązano konflikt adaptera zaznaczenia, zachowując fallback statusów z master i przyczynę stanu Airboxa. Typecheck i lint zmienionego adaptera przeszły; 29 testów kernelów oraz 10 kontroli jakości/statystyk po automatycznym połączeniu Pythona przeszło.
- Hook React Doctor nie ukończył analizy ze względu na błąd parsera oxlint (`Unexpected discriminant 7 for TSTypeName`); nie traktujemy komunikatu „No issues found” jako dowodu. Wcześniejsze siedem wskazań harnessu dotyczy ograniczonych wyszukiwań w siedmiu panelach, celowej kolejności obserwacji stanu i klonowania syntetycznego JSON; nie są potwierdzonymi regresjami produkcyjnego UI.
- Poprawka pełnego pokrycia starszego raportu: `e8adeef015c886d71b1e826bfb3eb13a98f23e52`. Pięć ukierunkowanych regresji Pythona, walidator source-map oraz 41 testów kontraktu dokumentacji przeszły. Kontrole obejmują niedostępną gamma dla piramid, zachowanie bogatych statystyk, kompletne prism/tet, zgodność markerów i liczników oraz zgodność ze starszym raportem tetra bez jawnego licznika gamma.

### Blokada runtime i integracji

Aktywacja `d58f86f68d664597843d3fe19eecda20` dotyczyła wyłącznie modelu QA. Jej run
`run-live-3b56027074d2cec8f6b47c1f447e359a207eb94481365e69adeecc1af4d11385`
ma 39 946 komórek: marker 0 — 38 161 (38 071 tet4 i 90 pyramid5), marker 1 —
1 012, marker 2 — 773. Niekompletny starszy raport zawierał tylko markery 1 i 2.
Exit receipt preparera potwierdza kod 1; lease został zwolniony, artefakty nie
zostały opublikowane. Naprawiono producenta danych, lecz jeszcze nie wdrożono
tej poprawki do runtime.

Oficjalne polecenie Stop zostało przyjęte (command
`fm-b5a1e95b-539e-48ad-8a5b-e0b80a2ab38f`); API potwierdza `cancelled` i zero
kroków solvera. Aktywacja zakończyła się HTTP 409
`accepted_preparation_run_stopped`, a launcher zachował
`outcome-unknown-resources-retained`. Nie wykonano ponowienia.

Istniejące procedury recovery nie obsługują tego dokładnego zestawu dowodów:
`stop-diagnostic-volume` wymaga awarii ownera i zadania `accepted`,
`stop-held-retirement-volume` wymaga `failed`, a kwarantanna namespace wymaga
zadania `accepted` oraz węższego inwentarza. Bieżący owner jest `ready`, zadanie
jest `cancelled`, istnieją receipty procesu i intent anulowania. Idle restart
odrzuca aktywną sesję; recreate wymaga uprzedniego poprawnego zatrzymania.
Nie zmieniano markerów, nie usuwano sesji i nie zatrzymywano innych grup.

Status tego checkpointu: **blocked** przed browser proof, merge i cleanup. Wymagany
następny krok: jawnie obsługiwana procedura recovery dla anulowanego
przygotowania ze zwolnionym lease i zachowanym niejednoznacznym receiptem
aktywacji, następnie build poprawionego HEAD, nowa aktywacja bez Solve,
porównanie API/przeglądarki, merge i cleanup. Zakres recovery przekazano do
decyzji użytkownika. Worktree, grupa zadania i kontrolny wolumen dowodów
pozostają zachowane; głównego checkoutu nie aktualizowano.

### Rozszerzenie zatwierdzone przez użytkownika

Użytkownik zatwierdził naprawę recovery i dokończenie weryfikacji oraz merge.
Rejestr zadania przywrócono do `wip`. Procedura przypina anulowaną aktywację,
failed exit preparera i zwolniony lease, następnie wymaga potwierdzonego drain
tej samej instancji backendu. Osobny świeży runtime może powstać dopiero przez
zweryfikowaną archiwizację starego runtime-control, z zachowaniem state root.
Stare żądanie i wznowienie starego runtime pozostają zablokowane. Zakres i
inwarianty zapisano w ADR 0037. Przed wykonaniem wymagane są interpretowane
regresje, niezależny review i podgląd rzeczywistych pinów. Ten wpis nie jest
dowodem wykonania recovery ani dowodem działania przeglądarki.

- 23 interpretowane regresje recovery i blokad startu: sukces. Review zamknął
  niespójne identyfikatory kontenerów, przedwczesny stan `stop-issued` oraz
  konflikt rekordu wcześniejszego recovery wykrywany dopiero po stopie.
- Podgląd rzeczywistej próby: sukces, plan
  `35d93c146eedfd9ab6791581d40bbbfa24500be3d85510d5df854ba7da7d0b30`.
  Potwierdzono jawne uruchomienie skryptu, brak ukończonych task/stage receipts,
  failed exit 1, sekwencje heartbeat launch 0 → exit/released lease 3, brak
  admission i aktywnych zasobów solvera. `CurrentRun.total_steps=1` jest liczbą
  zaplanowanych zadań (`step_ids.len()`), nie licznikiem wykonanych iteracji.

- Recovery zapisane w `f7e9d7962fa97d52479ef8932cb3b36a5512e8a2` wykonano:
  exit backendu 0, drain potwierdzony, oryginalne rekordy zachowane i lease
  zwolniony przez helper. Receipt recovery:
  `50c496c984f771586c1800ff471a1d17da22f2330969726d9c34496a959f6785`.
- Świeże odtworzenie `96b8c72338e042709cd550847b5bec61`: sukces z archiwum
  runtime-control i zachowaniem starego state root. Nowa próba development
  `99eb100faa664e6793cf9977cfaf34ee` używa konfiguracji
  `2f9c9518a282af18e32faca71e12a99b1363b307e130ed269dace41d60717723`.
- Build `33497222e00fef318774736705c3bd508fa3abf9` ujawnił pięć konfliktów
  typów po integracji master: `SharedFemMesh` wymaga `as_deref()` przy
  przekazaniu `Option<&FemMeshPayload>`. Poprawiono wywołania; potwierdzenie
  kompilacji wymaga następnego zarządzanego buildu.
- Harness porównuje teraz wartości rozkładów geometrii, jakości rodzin,
  percentyle, progi i wspólne węzły z API. Kontrola składni i sprawdzenie
  odrzucenia zera zamiast `1e-24 m³`: sukces. Osiem uwag hooka React Doctor
  dotyczy ograniczonych wyszukiwań w panelach, celowo sekwencyjnych obserwacji
  stanu i klonowania syntetycznego JSON. Nie stanowią błędów produkcyjnego UI;
  rzeczywisty harness nadal czeka na poprawny runtime.

### Dalsza weryfikacja po recovery

- Zarządzane wznowienie `53f9ae86d38c4af28187ace268501c3b` zbudowało
  `6c8199b525a05515032204cd1355c9d38c1c532f` i uruchomiło API. Aktywacja
  `835d9c35a7054baab74d5991b7630b11` przygotowała fixture bez Solve.
- Rzeczywista siatka: 7131 węzłów, 39946 komórek (38844 tet4, 1012 prism6,
  90 pyramid5), Airbox marker 0: 38161 komórek, 1407 wspólnych węzłów.
  Audyt API ujawnił utratę bogatych statystyk podczas deserializacji MeshIR.
  Poprawka przenosi je przez opcjonalne `build_report.mesh_statistics`, także
  w ścieżce zachowującej typowaną siatkę zamiast JSON. Trzy interpretowane
  regresje producenta przeszły; brak raportu nadal nie tworzy niepełnego IR.
- Dwie próby przeglądarkowe ujawniły problemy harnessu: brak bezpiecznego
  loopback origin oraz błędne wymaganie historii interaktywnego buildu dla
  siatki przygotowanej skryptem. Druga próba weszła do workspace, bez błędów
  strony i konsoli, ale nie ukończyła dowodu Inspectora. Żadna nie jest
  zaliczonym browser proof. Kontrole TypeScript i lint po poprawkach: sukces.
- Kompilacja testów jednostkowych pozostaje wyłączona zgodnie z poleceniem
  użytkownika. Nowy nośnik statystyk wymaga produkcyjnego buildu, ponownego
  przygotowania modelu oraz porównania danych z panelem w przeglądarce.

- Produkcyjny build czystego `dc339bfc3d8f6e8ef47232b93835ff193448c0e3`
  przeszedł: iteration `6e4cc722cb2a46ce8cd1f5a484893fa0`, snapshot
  `65911408fdfba8f701ff451edf756142e3a7b0d8066b37656a2dff4a3ec51c90`.
  Aktywacja `146bae4e14ba45268059309a5b4d81be`: sukces, model oczekuje na
  Compute, licznik solvera 0. Pełny raport jakości przeszedł przez IR do API.
- Odczyt scoped API wykrył drugi błąd: fizyczna grupa Gmsh `air` miała tag 3
  w raporcie jakości, a marker 0 w topologii. Commit
  `cf38878523058ec0132fca8cc0b7fa6119fef6c1` normalizuje oba identycznie,
  zachowuje kontrolę nakładania grup i zmienia klucz cache bez kasowania
  starych danych. 13 interpretowanych regresji: sukces.
- Próba browser QA `f545b477cca940bc94d129a956935449` przeszła początkowe
  ładowanie i odczyt siedmiu paneli, a następnie poprawnie odrzuciła brak
  dostępnego percentyla Airboxa w starym runtime. Page errors i console
  errors: 0. Pozostaje pełna próba po nowym przygotowaniu; ten wynik nie
  kwalifikuje Inspectora. Wcześniejsze błędy harnessu opóźniania odpowiedzi
  pozostają w receiptach kontrolnych i nie są zaliczonymi dowodami.

- Zintegrowano `master` do `86003cd811ab9097f0b61437dbae0fd68170689a` przez
  merge `caf50d2d88a6cb4a286252709870d5eb3df556bd`. CI starszego
  `dc339bfc3d8f6e8ef47232b93835ff193448c0e3` wykryło nieaktualne fixture testów
  Inspectora/recovery oraz oczekiwania odziedziczone z master. Ich korekta
  jest w `d397c166366c11b8b5ed3c059e8bdac05d692420`. Interpretowane testy
  aktywacji: 19/19, guard recovery: 9/9, validator browser QA: 26/26.
  Typecheck, lint zmienionego UI, składnia harnessu i audyt compute: sukces.
- Boundary Faces rozróżnia brak osobnego nośnika w aktualnym manifeście od
  braku aktualnego dowodu; dodatnie stare dane nie dają statusu realized.
  Harness jawnie oddziela diagnostyczne ACK renderera od mutacji modelu i
  Solve, odrzuca błędne ACK i przekroczenie limitu dowodów, a handlery
  opóźnionych odpowiedzi kończy przed usunięciem routingu. Review źródłowe
  zamknięte; pozostaje pełny dowód runtime i browser dla nowego commita.
- Retencja przed kolejnym buildem: zachowano aktualny pakiet, cache
  przyrostowy, ledger, state roots i wszystkie receipty prób. Brak wskazanego
  zbędnego zasobu wymagającego kasowania; 24 GiB wolne na hoście i 471 GiB
  w przestrzeni wolumenów Docker w ostatnim pomiarze. Cache zadania podlega
  ponownej ocenie dopiero po integracji i potwierdzonym drain.

- Build czystego `35561e4c1ec6d2b1e74dd4912eea7e20f6a513b3`: sukces,
  iteration `1e6332ce43dc4044b170201c75155b1e`, snapshot
  `b358c7067f8b155b6fe0c8416285974f59cc8f199713c12ca7159b36e0730a8a`.
  Aktywacja `6b798cd361c04554bf958d27b4243932`: przygotowanie gotowe,
  oczekiwanie na Compute, bez Solve. Żywe API publikuje 7131 węzłów i 39946
  komórek: 38844 tet4, 1012 prism6, 90 pyramid5. Marker Airboxa 0 zawiera
  38161 komórek (38071 tet4 + 90 pyramid5), z SICN min
  0.14847032019231338, p05 0.5032030886511972, mean 0.7681302002971812.
  Interpretowane asercje potwierdziły sumy markerów i rodzin, liczności
  histogramów oraz średnie ważone z tolerancją 1e-12. Gamma dla pyramid5
  pozostaje jawnie niedostępna; bramki pass/pass/unknown nie udają pełnego pass.
- Browser QA `17b4445fe8424cb7bf0a9f53069b9d49`: timeout początkowego
  loopback GET; ponowny niezależny probe zakończył się HTTP 200.
  Próba `8e5274ed0aa64da293967abb8ecc9655` weszła do wszystkich paneli,
  ale porównanie Scope wykryło `not published` zamiast `airbox`; odnotowano
  też PATCH visualization/state wymagający wyjaśnienia. Wynik **niezaliczony**,
  bez błędów strony, konsoli i transportu. Pełny browser proof i merge nadal
  oczekują na usunięcie przyczyn i zielone CI.

- `3540e8dc3fa9e7415f68f9c0cffd545b3e6c2a06` i
  `cef74f785502ae6c486c3b0ae0a566141b56cf09` korygują fixture’y recovery,
  prawdziwe trzy tetraedry w przeglądarkowym fixture topologii oraz oczekiwania
  zakresu jakości UI. Interpretowane testy idle-stop/pre-admission/receipts:
  4/9/17 sukcesów; typecheck i lint zmienionych fixture’ów: sukces.
  `2b03657e5644f45b7e9668c46935cef69e503a27` uzupełnia analogiczny brak
  opcjonalnego rekordu w post-build fixture (3/3). Guard produkcyjny nadal
  wykonuje się w testach. Review nie wykazało osłabienia zabezpieczeń.
- CI `40246487110` zaliczyło kontrakty Rust oraz browser-fixture-smoke.
  Pozostały błędy post-build fixture (poprawione powyżej) i ostatnie stare
  etykiety rozkładu rozmiaru w jednym teście UI (8797 testów już zielonych).
  Nowe asercje zostały porównane z rzeczywistym HTML zapisanym przez CI.
- Live QA wykryło i pozwoliło poprawić prezentację Quality Gates podczas
  retry: zasób `stale + refreshError` zachowuje dane cache, ale panel musi
  jawnie zgłosić błąd odświeżenia i wycofać cached pass. Dodano regresję
  renderowania i niezależną próbę syntetycznego 503. Harness czeka na dane
  API po montowaniu panelu oraz rozwija drzewo przez przycisk gałęzi;
  po tej zmianie nie występują mutacje visualization/state.
- Próba `045443c4433b4905b69f328d95b2f85f` przeszła porównania API oraz
  próby jakości i odzyskania danych, lecz końcowo odrzuciła trzy startup GET
  `ERR_ABORTED` (diagnostics/cpu, diagnostics/gpu, platform/compute/nodes).
  Page/console/HTTP errors: 0; mutacje: 0. Wynik nadal **niezaliczony** do
  czasu potwierdzenia cyklu anulowania i zastępczych odpowiedzi tych zasobów.

- **Browser proof zaliczony:** attempt `f383b9bce64945e6a16bd4df0f3cf970`,
  exit 0, harness SHA-256
  `90a99e1ee3e02f4ca9974ef87a883d4fa18350cb9a83a66a774a719fca0278ce`.
  Wszystkie siedem paneli: root, mesh, parameters, quality-gates, statistics,
  topology, build. Zweryfikowano 38161 komórek Airboxa, rodziny tet4/pyramid5,
  7131 węzłów, 828 powierzchniowych ścian nośnika, 1407 węzłów interfejsów,
  jednostki m/m³, marker 0, źródło jakości, 9 porównań rozkładów rozmiaru,
  22 porównania metryk jakości i 3 percentyli. Osobny zakres globalnej siatki
  obejmuje też prism6. Manifest i panel pozostają zgodne z opublikowaną
  generacją przy unresolved runtime; nie przyznaje to możliwości Solve.
- Odświeżenie rzeczywistym GET 200 zachowało ten sam korzeń DOM i oryginalną
  odpowiedź. Pierwsze ładowanie, stale cached pass, błąd 503 (6 żądań przy
  dwóch konsumentach i trzech próbach), jawny refresh error, wycofanie jakości
  cache i odzyskanie żywego unknown przeszły. Syntetyczny pass służy wyłącznie
  testowi UI; gamma pyramid5 pozostaje naukowo niedostępna.
- Canvas widoczny, WebGL2 bez utraty kontekstu, drawing buffer 617×516.
  Page/console/request/HTTP errors: 0; mutacje modelu i Solve: 0.
  SwiftShader jest dowodem przeglądarki, nie sprzętowego GPU ani parytetu FEM.
  Runtime backendu pozostaje zweryfikowanym buildem `35561e4c1...`; późniejsze
  zmiany produkcyjne dotyczą wyłącznie prezentacji refresh error w frontendzie.
- Regresje harnessu usunięto przez oczekiwanie na DOM po zmianie store oraz
  jawne przekazanie stanu workspace. Test wykonania helpera potwierdził
  aktualizację widoczności i korelację zakończonego odczytu. Wcześniejsze próby
  pozostają niezaliczone w wolumenie kontrolnym. ResourceRuntimeStore
  anuluje żądania po ostatnim unsubscribe; sześć jawnych ścieżek startowych
  można rozliczyć tylko po zniknięciu Home i następczym GET 2xx z limitem
  10 s/256 KiB. Zaliczony przebieg nie potrzebował tej klasyfikacji (0 probe).
  Parser odrzuca brakujące i niezgodne dowody; interpretowane testy 26/26.
- Ostatnie review panelu nie wykazało dalszych defektów. Uzgodniono limit 503
  między runnerem i parserem oraz poprawiono dwa błędy zakresu/stanu helpera.
  Typecheck/lint produkcyjnego panelu i testów oraz lint harnessu: sukces.
  Pozostają końcowe CI, merge, aktualizacja głównego checkoutu i cleanup.
