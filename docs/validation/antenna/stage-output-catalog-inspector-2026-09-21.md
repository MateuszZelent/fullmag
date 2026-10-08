# Inspector katalogu wyników stage anteny — walidacja 2026-09-21

## Zakres

Panel `AntennaCompositionPanel` dostał osobny odczyt katalogu wyników
antenowego stage. Nie pobiera on binarnych tablic pola ani FFT. Korzysta z
zasobu v2:

```text
GET /v2/sessions/current/data/antenna/stages/{stage_id}/output-catalog
```

Resolver węzłów `solution`, `projection`, `drive` i `spectrum` przekazuje
`stageId` razem z `solutionId` i `spectrumOutputId`. Dzięki temu każdy z tych
Inspectorów może pokazać ten sam, zgodny z aktualnym stage, stan publikacji.

## Zachowanie UI

Poza istniejącym wynikiem pola lub widmem panel pokazuje:

- `Stage catalog result`: `ready`, `loading`, `stale`, `error`, `missing` albo
  `not attached`;
- status stage i jego rewizję;
- opublikowane `output_id` oraz listę `quantity_ids`;
- asset IDs, manifest refs oraz informację, czy output został użyty ponownie,
  czy opublikowany jako nowy;
- digest katalogu;
- komunikat diagnostyczny, jeśli backend go opublikował;
- treść błędu zasobu, bez maskowania go jako brak wyniku.

Stan badge grupy nadal pochodzi ze zgodnego zasobu pola albo widma. Katalog
stage nie jest używany do udawania gotowego pola, gdy brakuje właściwego
`AntennaFieldSolutionResource`.

## Weryfikacja wykonana

- `pnpm exec vitest run
  src/modules/inspector/panels/AntennaObjectPanel.dom.test.tsx
  src/modules/inspector/panels/AntennaObjectPanelModel.test.ts`: **10/10**;
  regresja obejmuje canonical `replaceFieldDrive`, legacy full-array
  migration, `base_revision`, zachowanie fazy/offsetu oraz aktywny fokus i
  niezależne kontrolki podczas oczekiwania na ACK;
- po dodaniu workflow konfliktu ten sam zestaw przechodzi jako **11/11**;
  test 409 wymusza `Refetch Scene → Rebase Draft → Retry Save`, pokazuje
  wartości draft/server i zachowuje lokalny draft do jawnej decyzji użytkownika;
- `pnpm exec vitest run
  src/kernel/authoring/geometryLifecycleCommandContributions.test.ts`:
  **42/42**; komenda `Add Microstrip Antenna` przekazuje `base_revision`,
  odrzuca scenę bez rewizji i przy dwóch równoległych zapisach kończy się
  jednym sukcesem oraz jawnym konfliktem 409 zamiast cichego nadpisania;
- ESLint panelu i nowego testu DOM: **OK**;
- lokalny `pnpm exec react-doctor --verbose --scope changed`: **OK**, wynik
  `91/100`, `No issues found`;
- `git diff --check`: **OK**;
- `pnpm --dir apps/control-room exec vitest run
  src/modules/inspector/panels/antenna/AntennaCompositionPanels.test.ts
  src/modules/inspector/panels/antenna/AntennaCompositionPanels.dom.test.tsx`:
  **10/10**; regresja obejmuje także dedykowany conductor Inspector i jego
  odczyt kanonicznego `geometry.geometry_kind` (`Box`), zamiast fałszywego
  `unavailable` z nieistniejącego pola `geometry.kind`;
- `pnpm --dir apps/control-room exec vitest run`: **6567/6572** testów
  zaliczonych, **4** istniejące regresje poza zmianą w:
  `src/modules/inspector/inspectorCssContract.test.ts`,
  `src/modules/viewport-3d/viewport3dGeometryColors.test.ts`,
  `src/modules/viewport-3d/viewport3dRenderModel.test.ts` oraz
  `src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`;
- ESLint trzech zmienionych plików: **OK**;
- lokalny `pnpm exec react-doctor --verbose --scope changed`: **OK**, wynik
  `91/100`, **No issues found** po wydzieleniu helperów z pliku komponentu;
- `git diff --check`: **OK**;
- `node --test apps/control-room/scripts/lib/antenna-authoring-browser.test.mjs`:
  **3/3**, kontrakt sceny anteny i stabilne ID węzłów Explorera;
- dodano `smoke:antenna-authoring-ui`, który wykonuje realny Playwright
  przebieg `create → Explorer → conductor/port/solution → ready metadata` z
  kontrolowanym thin-metadata fixture oraz sprawdzeniem canvas/WebGL. Próba
  uruchomienia 2026-09-21 nie wystartowała: lokalny API na `127.0.0.1:3100`
  był nieaktywny, a repozytoryjny `just control-room-v2` zatrzymał się na
  ochronie storage, ponieważ worktree zawiera realne katalogi
  `node_modules` wymagające jawnej migracji. Nie przenoszono ani nie usuwano
  tych danych;
- typecheck Control Room zatrzymuje się na trzech znanych błędach nullability
  w `src/modules/field-map/FieldMapModule.tsx:588-591`; w zmienionych plikach
  nie zgłoszono błędu;
- test authoringu ujawnił i naprawił rozjazd presetu `Add Microstrip Antenna`
  z kanonicznym portem v2. Preset wcześniej wysyłał legacy
  `terminal_selector_ref` bez `schema_version`, więc scena nie mogła zostać
  zdeserializowana jako `AntennaPortModeIR`. Obecnie emituje
  `antenna_port_mode.v2`, dwie jawne gałęzie z parami
  `inlet_terminal_ref/outlet_terminal_ref` oraz cztery rozłączne elektrody
  (`signal_in/out`, `return_in/out`) i izolowane powierzchnie pozostałych
  ścian. Test 42/42 wymusza ten kształt i odrzuca powrót do legacy pola;
  jest to dowód kontraktu authoringu, nie kwalifikacja prądu ani pola FEM.
- Explorer nie oznacza już portu jako `ready` tylko dlatego, że ma jedną
  gałąź. Status portu jest `ready` wyłącznie dla v2 z co najmniej dwiema
  gałęziami, unikalnymi terminalami, niezerowymi skończonymi wagami, wagą
  dodatnią sumującą się do `1` i bilansem całkowitym `0`; w przeciwnym razie
  badge pokazuje `invalid`, a node ma status `warning`. Test Explorera obejmuje
  zarówno poprawny port (`2 branches`), jak i niekompletny port (`1 branches ·
  invalid`).
- Dedykowany port Inspector pokazuje tę samą walidację jako wiersz
  `Validation`, zamiast ograniczać się do surowych terminali i wag. Regresja
  DOM dla niekompletnej gałęzi pokazuje konkretnie `requires at least two
  branches`; reguły są współdzielone przez Explorer i Inspector w helperze
  `src/modules/antenna/antennaPortValidation.ts`, aby badge i diagnostyka nie
  rozjechały się semantycznie.
- Inspector stage `solution` pokazuje teraz konkretną walidację referencji przed
  publikacją wyniku: brak `current_transport_id`, brak `port_mode_id` oraz
  powiązanie portu z innym źródłem/transportem są wyświetlane w wierszu
  `Validation`, a badge zmienia się na `invalid · result pending`. Brak
  `H_ant_basis` jest również jawnie zgłaszany. Regresja DOM dla niekompletnego
  stage przechodzi razem z pozostałymi trzema scenariuszami kompozycji (4/4 w
  pliku DOM); jest to walidacja metadanych authoringu, nie dowód wykonania
  solve.
- Inspector `projection` wykonuje analogiczną walidację referencji: stage,
  output `H_ant_basis` oraz target object/region. Brakujące odwołania albo
  output o innej quantity są pokazywane w `Validation` i ustawiają badge
  `invalid · result pending`; global target pozostaje poprawny bez zależności
  od listy obiektów.
- Inspector `drive` sprawdza referencję portu, projekcji i każdego stage'a z
  `activation.stage_ids`; gdy projekcja istnieje, pokazuje też jej błędy
  referencji. Braki trafiają do `Validation` i ustawiają
  `invalid · result pending`, zamiast pozostawiać pozorną gotowość. Testy
  modelu i DOM kompozycji przechodzą teraz 11/11 (DOM 6/6).
- Inspector `spectrum` waliduje wspólną referencję stage/output/asset/digest,
  target i opcjonalny port, a także odwzorowuje reguły IR dla płaszczyzny
  próbkowania: skończony ortonormalny frame, dodatnie extent, liczniki
  próbek, interpolację `fem_element`/`fdm_trilinear`, zgodność transformu z
  k-grid oraz dozwolony komponent. Niepoprawny request pokazuje konkretne
  komunikaty i `invalid · result pending`; poprawny request pozostaje jawnie
  `configured · result pending` do czasu publikacji FFT. Testy kompozycji
  przechodzą 13/13 (DOM 8/8), a regresja authoring/Inspector 60/60.
- nie uruchamiano kompilacji testów Rust, browser smoke ani dowodu
  kwalifikacji FEM/FDM GPU.

## Pozostaje otwarte

Ten krok domyka prezentację metadanych katalogu w Inspectorze i dodaje
reproducible smoke harness, ale nie jest dowodem pełnego przepływu
`create → solve → inspect → stale`: smoke wymaga przygotowanego API/frontendu
i obecnie ma status **not run — storage/environment blocker**. Nadal trzeba
wykonać go przeciwko działającej usłudze, dodać Relax/Run, export/reload,
waveform/reuse, stale/geometry oraz osobny lifecycle field-map, a następnie
połączyć stage z natywnym polem FDM/FEM zgodnie z T16.

## Aktualizacja runtime i browser smoke — 2026-09-21

### Naprawa awarii transakcji authoringu

Pierwsze uruchomienie smoke ujawniło rzeczywistą awarię po stronie API:
`POST /v2/sessions/current/model/transactions` kończył proces workera Tokio
`STATUS_STACK_OVERFLOW` jeszcze przed wejściem do logiki wariantu transakcji.
Przyczyną nie był payload anteny, lecz ogromny `async fn` z jednym dopasowaniem
wszystkich wariantów `AuthoringTransactionRequest`; Windowsowy worker musiał
zbudować zbyt duży typ przyszłości. Zachowano publiczny extractor JSON i
rozbito dispatcher na synchroniczne dopasowanie oraz osobno boksowane futures
dla poszczególnych wariantów. Dzięki temu nie zmieniono kontraktu API ani
semantyki commitów, a zmniejszono rozmiar przyszłości konstruowanej przez
runtime.

Dowód minimalny po restarcie przez zarządzany `just control-room-v2` (stable
toolchain, storage na `D:\git\fullmag\storage`):

- utworzenie sesji zwróciło `201 Created`;
- pusty `merge_patch` zwrócił `200 OK`, `transaction_kind=merge_patch` oraz
  `scene_revision=1`;
- `/healthz` zwrócił `200 OK` po transakcji, bez ponownego stack overflow.

### Wynik pierwszej fazy browser smoke

Uruchomiono:

```text
CONTROL_ROOM_API_BASE=http://127.0.0.1:8081
CONTROL_ROOM_URL=http://127.0.0.1:3107/workspace
pnpm --dir apps/control-room smoke:antenna-authoring-ui
```

Smoke zakończył się powodzeniem dla ograniczonego kontraktu authoringu:

- utworzono obiekt przewodnika, port, stage solve i output;
- Explorer oraz dedykowane Inspectory rozwiązały stabilne identyfikatory;
- katalog stage/output i metadane `H_ant_basis` osiągnęły stan `ready`;
- canvas WebGL był widoczny, drawing buffer niezerowy, a kontekst nie był
  utracony;
- manifest podał `scene_revision=1` oraz wszystkie rozstrzygnięte ID.

Świadectwa zapisano w:

```text
D:\git\fullmag\worktrees\microwave-antenna-latest-20260909\.fullmag\test-results\antenna-authoring\fdm-authoring-inspector.png
D:\git\fullmag\worktrees\microwave-antenna-latest-20260909\.fullmag\test-results\antenna-authoring\fdm-authoring-inspector.manifest.json
```

Fixture zasobów ustawia jawne nagłówki CORS dla
`x-api-contract-version` i `etag`. Smoke toleruje wyłącznie znane anulowane
żądania GET wywołane przez kontrolowaną invalidację (`shared-domain/manifest`,
`stages/execution`, `fdm-region-memberships`, `domain/topology`) i zapisuje je
w `expected_request_failures`; każda inna awaria żądania powoduje niepowodzenie
testu.

Ten wynik jest dowodem stabilności transakcji, authoringu, control-plane
metadata i cyklu życia WebGL. Nie jest dowodem natywnego solve FEM/FDM,
projekcji pola na komórki, Relax/LLG, FFT, export/reload, reuse ani stale
invalidation. Te bramki pozostają otwarte w T15/T16 i muszą być wykonane na
rzeczywistych artefaktach, z kontenerowym runtime dla ścieżek FEM/MFEM/CUDA.

### Pozostałe ograniczenia w tej iteracji

- Nie kompilowano testów jednostkowych Rust zgodnie z bieżącą blokadą sesji.
- Typecheck Control Room nadal raportuje wyłącznie istniejące błędy
  nullability w `src/modules/field-map/FieldMapModule.tsx:588-591`; zmienione
  pliki antenowe nie dodały nowych błędów.
- Testy Vitest authoringu i kompozycji anteny przechodzą: **55/55** w trzech
  celowanych plikach (`geometryLifecycleCommandContributions`, model i DOM
  kompozycji). ESLint zmienionych plików przechodzi z jednym wcześniejszym
  ostrzeżeniem `sceneFieldDrives` w istniejącym kodzie.

## Aktualizacja: `H_ant` w FEM CPU preview — 2026-09-21

W tej iteracji domknięto brakującą materializację bezpośredniego pola anteny
na ścieżce **FEM native CPU preview**. Nie jest to jeszcze publikacja pola z
pełnego natywnego snapshotu ani kwalifikacja całego LLG. Rozdzielenie jest
celowe: ABI natywnego FEM snapshotu nie ma obserwabli `H_ant`, dlatego nie
wolno było ogłaszać tej quantity jako gotowej w ścieżce snapshot/artifact.

### Kontrakt i ścieżka obliczenia

- Aktywność `H_ant` dla FEM CPU wynika wyłącznie z rozstrzygniętego planu:
  `antenna_zeeman_masks`, `solved_antenna_drive_bases` albo kompletnego
  legacy `mqs_2p5d_az` (`antenna` + `drive`). Bez jednego z tych źródeł
  capability pozostaje pusta.
- `H_ant` jest udostępnione w katalogu **preview**, ale nie w katalogu
  **snapshot quantities**. FEM native GPU pozostaje fail-closed, ponieważ
  jego obecny kontrakt urządzenia nie udostępnia obserwabli antenowej.
- Dla aktywnego, cache'owanego i terminalnego preview ścieżka CPU wywołuje
  `compute_antenna_field_at_time(plan, source_time)`, następnie buduje
  `LivePreviewField` przez wspólny mesh preview builder i nakłada magnetyczną
  maskę aktywną dla `H_ant`. W metadanych pozostają chwila źródłowa, krok,
  rewizja żądania oraz czas materializacji.
- Pole jest obliczane do obserwacji z rozstrzygniętego planu i nie dodaje
  osobnego termu do RHS ani nie zmienia relaksacji. `source_time` pochodzi z
  kontekstu wykonania preview; cache terminalny zachowuje czas startu etapu
  zgodnie z istniejącą polityką cache.
- Pozostałe quantity nadal przechodzą przez istniejący natywny worker preview;
  zmiana nie obchodzi ABI dla demag, exchange, energii ani magnetyzacji.

### Weryfikacja

- `rustfmt --edition 2021 --check` dla pięciu zmienionych plików Rust: **OK**.
- `git diff --check`: **OK**.
- Zarządzany build Windows, uruchomiony przez
  `just windows-build backend=fem device=cpu frontend=dev`, skompilował bez
  błędów `fullmag-runner`, `fullmag-cli`, `fullmag-api` oraz `fullmag-py-core`
  w obrazie FEM CPU. Końcowy receipt nie został przyjęty, ponieważ guard
  tożsamości źródeł wykrył zmieniony, niezatwierdzony worktree podczas
  wielominutowego builda; nie jest to błąd kompilacji i nie zastępuje pełnej
  bramki runtime.
- Testów jednostkowych Rust nie kompilowano zgodnie z blokadą sesji. Nie
  wykonano też kwalifikacji FEM GPU, natywnego snapshotu `H_ant`, pełnej
  trajektorii LLG, FFT ani eksportu artefaktów pola.

Ta zmiana daje bezpośredni runtime preview `H_ant` dla FEM CPU, gotowy do
dalszej kwalifikacji, ale status
T13 pozostaje otwarty do czasu testów rzeczywistego RHS/LLG, wszystkich
integratorów i snapshotów. T16 nadal nie jest zamknięte: projekcja do FDM,
upload CUDA oraz parity CPU/GPU wymagają osobnych dowodów.

## Aktualizacja: artefaktowy `H_ant` w natywnym FEM CPU — 2026-09-21

Uzupełniono następną, węższą lukę kontraktu: zaplanowany output `H_ant` może
być teraz zapisany jako zwykły `FieldSnapshot` na ścieżce **native FEM CPU**,
mimo że natywny ABI obserwabli urządzenia nie ma jeszcze `H_ant`. To nie jest
zmiana ABI ani obejście ścieżki GPU. Jest to jawna realizacja hostowa dla
quantity pochodnej, zgodna z tym samym resolved `FemPlanIR`, który steruje
preview i termem Zeemana.

### Zakres materializacji

- `FemCpuNative` klasyfikuje `H_ant` jako `Derived`; aktywność pozostaje
  filtrowana przez rozstrzygnięty plan i wymaga resolved maski, solved basis
  albo kompletnego legacy `mqs_2p5d_az`.
- Dla CPU helper wywołuje
  `compute_antenna_field_at_time(plan, physical_time)` i tworzy pełny wektor
  w kolejności węzłów `plan.mesh.nodes`. Nie używa pola z `t=0`, nie wykonuje
  drugiej konwersji przez `mu0` i nie kopiuje nieistniejącego obserwabla z
  urządzenia.
- Snapshoty komponentowe `H_ant.x`, `H_ant.y` i `H_ant.z` przechodzą przez
  ten sam helper; zachowują kontrakt trójskładowego payloadu z wybraną
  składową i zerami w dwóch pozostałych osiach, zamiast trafiać do ABI jako
  nieznana nazwa obserwabli.
- Ta ścieżka obejmuje początkowy snapshot, każdy zaplanowany accepted-step,
  snapshot terminalny oraz końcowy output harmonogramu. Do obliczenia trafia
  rzeczywisty czas `stats.time`, a `step`, `solver_dt` i rewizja są zapisywane
  razem z artefaktem.
- W trybie streaming snapshot trafia do istniejącego `ArtifactPipeline` jako
  hostowy `FieldSnapshot` i jest zapisywany przez tę samą warstwę JSON/Zarr co
  inne pola. W trybie nie-streaming pozostaje w lokalnym wyniku runu.
- `FemNativeGpu` nadal nie reklamuje `H_ant` w snapshotach i nie wchodzi do
  helpera hostowego. Brak kwalifikowanego device ABI pozostaje błędem
  capability, a nie cichym fallbackiem.

### Weryfikacja tej iteracji

- Zarządzany build Windows przez
  `just windows-build backend=fem device=cpu frontend=dev` skompilował
  zmienione crate'y bez błędów. Pierwsza próba na dirty worktree nie dostała
  końcowego receiptu przez guard tożsamości; po commicie `c38e14692` ten sam
  build z clean HEAD zakończył się komunikatem `Build mode: fem-cpu`,
  `Windows FEM cpu container build is ready` i kodem sukcesu.
- `git diff --check`: **OK**. Formatowanie nowych fragmentów oraz sześciu
  plików pomocniczych sprawdzono przez `rustfmt --edition 2021 --check`;
  `dispatch.rs` zachowuje istniejące dwa fragmenty formatowania bazowego,
  których nie zmieniano mechanicznie.
- Testów jednostkowych Rust nie kompilowano zgodnie z blokadą sesji. Nie
  wykonano jeszcze rzeczywistego eksportu Zarr/JSON, pełnej trajektorii LLG,
  kwalifikacji GPU ani porównania wartości `H_ant` z niezależnym wzorcem.

Ta zmiana zamyka implementacyjnie hostowy zapis `H_ant` dla FEM CPU, ale nie
odhacza T13. Brakuje nadal dowodu numerycznego na RHS/energię/torque, wszystkich
integratorów i waveformów, a także kwalifikacji natywnego ABI GPU. T16 pozostaje
otwarte dla projekcji FDM, uploadu CUDA i parity CPU/GPU.

## Aktualizacja: legacy `current_modules` w natywnym FEM CPU — 2026-09-21

Audyt ścieżki wykonawczej wykazał, że selekcja runtime kierowała legacy
`AntennaFieldSource` do CPU, ale pakowanie native przekazywało wyłącznie
`field_drives` i `solved_antenna_drive_bases`. W efekcie referencyjny FEM oraz
hostowy preview mogły zawierać `H_ant`, podczas gdy natywny RHS go pomijał.
Naprawiono tę niespójność bez dodawania drugiego solvera pola:

- legacy `mqs_2p5d_az` jest obliczany hostowo przez istniejące
  `compute_per_unit_antenna_fields`, skalowany przez `current_a` dokładnie raz i
  pakowany jako pełnodomenowy `PREPROJECTED_NODAL` profil w jednostkach A/m;
- resolved `prescribed_zeeman_mask` korzysta z tego samego carrier-a, z już
  materializowanym `field_xyz` w A/m; amplituda nie jest ponownie mnożona przez
  `mu0`;
- dla obu źródeł native dostaje waveform `constant`, `sinusoidal`, `pulse`,
  `piecewise_linear` albo `sinc_pulse`; legacy zegar pozostaje absolutny, więc
  zachowuje semantykę referencyjnego `dynamic_antenna_drive_terms`;
- istniejący native `project_regional_field_drive_bases` przyjmuje profil
  preprojektowany, a `materialize_regional_field_drive` wyznacza tylko skalarne
  $f(t)$ przy każdym rzeczywistym podetapie RK. Ten sam `h_drive_xyz` trafia do
  `H_eff` i energii Zeemana;
- nie rozszerzono capability GPU: obecna selekcja nadal wymusza CPU dla
  `current_modules`, a GPU pozostaje fail-closed. Legacy model nadal ma status
  kompatybilnościowy i nie jest dowodem pełnego trójwymiarowego solve przewodnika.

### Weryfikacja tej iteracji

- Zarządzana recepta `just windows-build backend=fem device=cpu frontend=dev`
  zakończyła kompilację `fullmag-runner`, CLI, API i `fullmag-py-core` w trybie
  `fem-cpu` po poprawce adaptera. Build wykonał ścieżkę kontenerową; nie użyto
  hostowego `cargo` jako dowodu FEM.
- Po commitach `38febcef2`, `eb2559d2a` i `780680003` tę samą receptę
  powtórzono na czystym HEAD `780680003b6b21e706dfcbd49959009c10493664`;
  receipt zakończył się kodem 0, `Build mode: fem-cpu` i komunikatem
  `Windows FEM cpu container build is ready`.
- `git diff --check`: **OK**. Testów jednostkowych Rust nie kompilowano zgodnie
  z blokadą sesji. Nie wykonano jeszcze end-to-end porównania RHS/energii z
  niezależnym oraklem ani kwalifikacji GPU.

Ta zmiana usuwa konkretny błąd „preview pokazuje pole, native LLG go nie używa”
dla CPU. Nie zamyka T13: pozostają bramki trajektorii wszystkich integratorów i
waveformów, snapshot-vs-RHS parity, niezależny wzorzec fizyczny oraz GPU/T16.
