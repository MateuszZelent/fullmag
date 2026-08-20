# Raport Task 2: kanoniczny evaluator predykatów geometrycznych

## Status

Zaimplementowano jeden czysty evaluator członkostwa punktu w geometrii oraz
przepięto wskazanych konsumentów: regional-field drive, materializację regionów
FDM i geometryczne preview członkostwa regionu w API. Nie dodano żadnego
`SelectionExprIR`, frozen-spins IR ani runtime constraint.

## RED

Pierwsza próba standardowego polecenia nie była ważnym RED, ponieważ istniejący
repozytoryjny `target/` jest własnością `nobody:nogroup` i Cargo zakończyło się
przed kompilacją:

```text
cargo test -p fullmag-plan selection::tests -- --nocapture
error: failed to create directory `.../target/debug`: Permission denied (os error 13)
```

Właściwy RED uruchomiono w izolowanym, repozytoryjnie zalecanym katalogu Cargo:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/selection-task2 CARGO_INCREMENTAL=0 cargo test -p fullmag-plan selection::tests -- --nocapture
exit 101
error[E0432]: unresolved import `super::geometry`
could not find `geometry` in `super`
```

To był oczekiwany RED: testy kontraktu istniały, a moduł produkcyjny evaluatora
jeszcze nie istniał.

## GREEN

Finalne, świeże polecenia po ostatniej zmianie źródła:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/selection-task2 CARGO_INCREMENTAL=0 cargo test -p fullmag-plan selection::tests
exit 0; 5 passed, 0 failed
```

Zakres: Box, Cylinder, Sphere, Union, Intersection, Difference, inkluzywna
granica, translacja, quaternion, niejednorodna skala, pivot, object/world frame,
singular transform oraz imported solid.

```text
env CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/selection-task2 CARGO_INCREMENTAL=0 cargo test -p fullmag-plan regional_field_drive
exit 0; 9 passed, 0 failed
```

```text
env CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/selection-task2 CARGO_INCREMENTAL=0 cargo test -p fullmag-api mesh_region_membership
exit 0; 8 passed, 0 failed
```

API emituje nadal istniejące ostrzeżenia `dead_code` w
`schemas/decimal_u64.rs`, a zależne crate'y istniejące ostrzeżenia
`unused_mut`/`dead_code`; nie są spowodowane tą zmianą i nie były tłumione.

Checkpoint:

```text
git diff --check -- crates/fullmag-plan crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs crates/fullmag-api/src/router_v2/tests.rs
exit 0; brak outputu
```

## Zmienione pliki

- `crates/fullmag-plan/src/selection/mod.rs` — właściciel modułu.
- `crates/fullmag-plan/src/selection/geometry.rs` — `GeometryPredicate`,
  `AffineTransform3`, `BoundaryMembership`, `SelectionError`, lowering z
  `GeometryEntryIR`/`ObjectRegionIR` i kanoniczne `contains_point`.
- `crates/fullmag-plan/src/selection/tests.rs` — testy RED/GREEN oraz
  deterministyczny corpus CSG i affine.
- `crates/fullmag-plan/src/lib.rs` — rejestracja i minimalny publiczny adapter
  potrzebny crate'owi API; samo `contains_point` pozostaje `pub(crate)`.
- `crates/fullmag-plan/src/geometry.rs` — istniejące prymitywy FDM korzystają z
  tych samych funkcji członkostwa Box/Cylinder/Sphere.
- `crates/fullmag-plan/src/regional_field_drive.rs` — usunięto lokalne gałęzie
  predykatów i pozostawiono adapter błędu do `PlanError`.
- `crates/fullmag-plan/src/fdm.rs` — regiony FDM kompilują jeden predykat na
  region i próbkują world point; obsługują object/world frame i CSG bez lokalnego
  evaluatora.
- `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs` —
  preview używa `ObjectRegionIR` oraz pełnej scene transformacji; błędy
  evaluatora przechodzą jako typed 422 zamiast pozornej pustej maski/404.
- `crates/fullmag-api/src/router_v2/tests.rs` — konieczna korekta istniejących
  oczekiwań 404: rotacja, niejednorodna skala i wspierany CSG są teraz
  geometrycznym preview. Ten istniejący plik testowy nie był wyszczególniony w
  briefie, ale zmiana była konieczna do zweryfikowania migracji API.

## Self-review

- Transformacja świata jest odwracana raz na granicy `GeometryPredicate`, przed
  testem drzewa lokalnego; każdy jawny authored `Translate` odwraca wyłącznie
  własny węzeł affine.
- Quaternion jest normalizowany przed użyciem odwrotności; singular quaternion
  i skala dają `selection_singular_transform`.
- Imported solid daje `selection_imported_solid_unqualified`; nieobsługiwane
  warianty analityczne dają `selection_variant_unsupported`; błędy nie są
  zamieniane na `false` w kanonicznym evaluatorze.
- Cylinder normalizuje authored axis; rozmiary i środki są walidowane jako
  skończone, a rozmiary jako dodatnie.
- Inkluzywna granica używa zatwierdzonego defaultu `absolute=0`,
  `relative=1e-12`.
- Regional drive zachowuje osobny algorytm klasyfikacji/całkowania komórki, ale
  każde faktyczne próbkowanie punktu przechodzi przez evaluator kanoniczny.
- Nie zmieniono schematu IR, capability matrix, runtime ani solvera.
- Nie wykonano stage, commit ani push.

## Obawy i granice dowodu

- „Property” corpus jest deterministycznym wyczerpującym gridem dla
  sprawdzanych relacji CSG, bez nowej zależności `proptest`; nie jest losowym
  fuzzingiem.
- API geometry projection pozostaje nieautorytatywnym node/centroid preview;
  migracja evaluatora nie kwalifikuje go jako FEM true-DOF membership.
- Wewnętrzny kompatybilnościowy helper `build_mesh_region_membership`, używany
  poza endpointem, zachowuje historyczne `Option` i mapuje błąd na `None`.
  Endpoint pojedynczego regionu używa ścieżki `Result` i publikuje typed 422.
- FDM `ProblemIR` ma obecnie tylko translację właściciela geometrii; pełny
  quaternion/scale/pivot jest wykonywany i testowany dla scene/API, bez
  wymyślania nowych pól FDM IR.

## Poprawki po review

Status: **DONE**. Wszystkie ustalenia z `task-2-review.md` zostały naprawione.
Poniższa sekcja zastępuje wcześniejszą uwagę o helperze API mapującym błąd na
`None`: helper ma teraz kontrakt `Result<Option<_>, ApiError>` i zachowuje
typed błędy selekcji również w endpointach listy i jakości.

### Zrealizowane poprawki

- Regional field drive nie odrzuca już z góry wspieranych kształtów bez
  bezpiecznej analitycznej klasyfikacji komórki. Sphere i CSG dochodzą do
  kanonicznego próbkowania punktów.
- Granice regionów FDM są wyznaczane konserwatywnie dla Union, Intersection i
  Difference, łącznie z transformacją ośmiu narożników AABB.
- Endpointy membership pojedynczego regionu, listy membership i jakości
  propagują `selection_*` jako HTTP 422. HTTP 404 pozostaje wyłącznie dla
  brakującej tożsamości zasobu. OpenAPI deklaruje odpowiedź 422 dla wszystkich
  trzech ścieżek.
- Testy affine API sprawdzają dokładne indeksy elementów, węzłów i powierzchni,
  nie tylko niepustą odpowiedź.
- Normalizacja quaternionu i osi używa stabilnej normy skalowanej; bardzo duże
  skończone wartości nie przepełniają normy. Każda skończona niezerowa skala,
  również subnormalna, pozostaje odwracalna; singularność oznacza dokładne zero
  albo wartość nieskończoną/NaN.
- `GeometryShape::contains` zwraca `Result<bool, SelectionError>` i dla
  Box/Cylinder/Sphere/Translate/Difference deleguje do kanonicznego evaluatora.
  Imported solid nie jest już cicho zamieniany na `false`. Specjalne Sin/Arch
  zachowują jawne istniejące realizacje poza zakresem evaluatora authored IR.
- Regional field drive, FDM i API używają wspólnego fixture
  `crates/fullmag-plan/tests/fixtures/geometry_selection_parity.json` dla
  Difference(Box, translated Sphere), obejmującego także granice bryły bazowej
  i narzędzia.
- Usunięto zbędny publiczny adapter `object_region_contains_point`; evaluator,
  granice i pomocnicze operacje pozostają wewnętrzne, a crate API otrzymuje
  wyłącznie minimalny wymagany kontrakt.
- Dokument v2 opisuje wspierane prymitywy, CSG, pełną transformację obiektu,
  niezależność world frame oraz fail-closed 422 `selection_*`.
- Nie zmieniono `SelectionExprIR`, frozen runtime, formatu payloadu ani ścieżek
  v2. Nie było potrzeby regenerowania transportu frontendowego. Nie dotknięto
  niezwiązanych brudnych zmian Control Room, websocketów ani UI.

### Dowody RED

- Selection: po dodaniu przypadków skrajnych wynik wynosił 5 passed / 2 failed:
  duży skończony quaternion nie normalizował się poprawnie, a bardzo mała
  niezerowa skala zwracała `selection_singular_transform`.
- Regional drive: 9 passed / 2 failed; Sphere i CSG kończyły się błędem
  `unsupported primitive` przed kanonicznym próbkowaniem.
- FDM CSG bounds: 0 passed / 1 failed; planner odrzucał CSG komunikatem, że
  regiony transportu FDM jeszcze go nie wspierają.
- API membership: 9 passed / 1 failed; endpoint listy zwracał 200 zamiast 422.
  API quality: 0 passed / 1 failed; endpoint zwracał 404 zamiast typed 422.
- `GeometryShape` RED był błędem kompilacji E0599: testy `unwrap`/`unwrap_err`
  ujawniły, że lokalny evaluator zwracał goły `bool` i gubił semantykę błędu.
- Wspólny corpus RED był błędem E0425 dla brakujących adapterów regional/FDM,
  zanim konsumenci zostali spięci z rzeczywistymi ścieżkami wykonania.
- Duża skończona oś cylindra FDM: 0 passed / 1 failed z
  `selection_invalid_geometry`, ponieważ lokalna normalizacja przepełniała normę.
- Pierwszy pełny gate planera po poprawkach: 388 passed / 1 failed. Jedyna
  awaria była nieaktualnym testem oczekującym odrzucenia wspieranego CSG; test
  został zaktualizowany tak, aby potwierdzał materializację maski CSG i nadal
  sprawdzał odrzucenie niewspieranego coupling.

### Dowody GREEN

- `cargo test -p fullmag-plan --lib`: **389 passed, 0 failed, 0 ignored**.
- `cargo test -p fullmag-api mesh_region_`: **14 passed, 0 failed, 928 filtered
  out**.
- Wcześniejszy `git diff --check` dla zmienionych plików przeszedł bez uwag;
  po końcowej korekcie testu `rustfmt` i lokalny `git diff --check` dla tego
  pliku również przeszły. Zgodnie z poleceniem zatrzymania po końcowych gate'ach
  nie uruchamiano dodatkowego globalnego diff-check.
- Kompilacja API zgłasza wyłącznie istniejące ostrzeżenia `unused_mut` i
  `dead_code` w `fullmag-engine`, `fullmag-runner` oraz helperach
  `decimal_u64`; żadne nie jest błędem ani nie pochodzi z tej poprawki.

### Pliki zmienione w ramach poprawki review

- `crates/fullmag-plan/src/selection/geometry.rs`
- `crates/fullmag-plan/src/selection/tests.rs`
- `crates/fullmag-plan/tests/fixtures/geometry_selection_parity.json`
- `crates/fullmag-plan/src/geometry.rs`
- `crates/fullmag-plan/src/regional_field_drive.rs`
- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-plan/src/tests.rs`
- `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs`
- `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- `crates/fullmag-api/src/router_v2/tests.rs`
- `docs/specs/resource-first-control-room-api-v2.md`
- `.superpowers/sdd/task-2-report.md`

Nie wykonano stage, commit ani push.

## Poprawki po re-review: kompilacja predykatów i legacy waveguides

Status: **DONE**. Usunięto obie regresje dopisane w sekcji
`Re-review residual regressions` bez dodawania `SelectionExprIR`, frozen runtime
ani nowej publicznej semantyki.

### Zmiana implementacyjna

- `GeometryShape` nie wykonuje już lowering/allocacji drzewa authored IR przy
  każdym punkcie. `CompiledGeometryShape` jest tworzony raz przed pętlą
  voxelizacji albo materializacji maski, a kolejne próbki otrzymują referencję
  do skompilowanego predykatu.
- Poddrzewo bez `SinWaveguide`/`ArchWaveguide` kompiluje się w całości do
  jednego kanonicznego `GeometryPredicate`. Wewnętrzna reprezentacja ma osobne
  legacy leaves wyłącznie dla Sin/Arch. `Translate` i `Difference` są składane
  lokalnie tylko wtedy, gdy ich poddrzewo zawiera taki legacy leaf; semantyka
  Box/Cylinder/Sphere i kanonicznego CSG nie została zduplikowana.
- `voxelize_shape` oraz transportowy `sample_shape_mask` kompilują predykat
  przed iteracją po komórkach. Zagnieżdżone
  `Translate(Difference(SinWaveguide, ArchWaveguide))` zachowuje wcześniejsze
  legalne członkostwo.
- Regional field drive tworzy `CompiledSpatialProfile` raz na drive przed
  pętlą po komórkach. Ten obiekt przechowuje znalezioną geometrię i jeden
  `GeometryPredicate`; wszystkie punkty kwadratury używają go przez referencję.
  Konserwatywna klasyfikacja cylindra zwraca `Boundary`, więc nie uruchamia
  dodatkowego lowering w rekursywnym classifierze.
- `GeometryPredicate::from_geometry_entry` ma teraz widoczność `pub(crate)`.
  Żaden call-site poza `fullmag-plan` go nie potrzebuje; API nadal korzysta z
  publicznego `from_object_region`.

### Dowody RED

- `cargo test -p fullmag-plan canonical_membership_tests -- --nocapture`:
  **1 passed, 2 failed**. Voxelizacja 64 punktów wykazała 64 kompilacje zamiast
  jednej. Zagnieżdżony Translate/Difference z Sin/Arch zwrócił
  `selection_variant_unsupported` dla `fdm-sin-waveguide`.
- `cargo test -p fullmag-plan geometry_mask_compiles_once_for_multiple_point_samples -- --nocapture`:
  **0 passed, 1 failed**. Trzy punkty regional geometry mask wykazały trzy
  kompilacje zamiast jednej.

Testowy licznik jest `thread_local` i aktywny tylko pod `cfg(test)`, dzięki
czemu mierzy rzeczywisty call-site kompilacji bez wyścigów z równoległymi
testami i nie dodaje stanu ani kosztu do buildu produkcyjnego.

### Dowody GREEN

- `cargo test -p fullmag-plan canonical_membership_tests -- --nocapture`:
  **3 passed, 0 failed**. Obejmuje jedną kompilację dla 64 voxel samples oraz
  dwa rozłączne punkty zagnieżdżonego Translate/Difference z Sin/Arch.
- `cargo test -p fullmag-plan regional_field_drive::tests -- --nocapture`:
  **8 passed, 0 failed**, w tym jedna kompilacja dla trzech point samples.
- `cargo test -p fullmag-plan selection::tests -- --nocapture`:
  **8 passed, 0 failed**.
- `cargo test -p fullmag-plan fdm:: -- --nocapture`:
  **5 passed, 0 failed**; obejmuje konserwatywne CSG bounds i materializację
  masek regionów FDM.
- `cargo test -p fullmag-api mesh_region_`:
  **14 passed, 0 failed, 929 filtered out**.
- Końcowy `git diff --check` dla plików planera, API membership i raportu:
  **exit 0**, bez diagnostyki.
- Gate API nadal zgłasza wyłącznie istniejące ostrzeżenia `unused_mut` i
  `dead_code` w `fullmag-engine`, `fullmag-runner` i `decimal_u64`; brak nowych
  błędów lub ostrzeżeń z tej poprawki.

### Pliki zmienione w tej rundzie

- `crates/fullmag-plan/src/selection/geometry.rs`
- `crates/fullmag-plan/src/geometry.rs`
- `crates/fullmag-plan/src/regional_field_drive.rs`
- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-plan/src/tests.rs`
- `.superpowers/sdd/task-2-report.md`

Nie zmieniono endpointów ani payloadów API w tej rundzie; skupiony gate API
potwierdza kompatybilność. Nie dotknięto niezwiązanych plików Control Room.
Nie wykonano stage, commit ani push.

## Regeneracja artefaktów OpenAPI v2 dla Control Room

Status: **DONE_WITH_CONCERNS** wyłącznie z powodu istniejącego, niezwiązanego
gate'a typecheck. Kanoniczna regeneracja i skupiony kontrakt generated są
zielone. Żaden plik generated nie był edytowany ręcznie.

### Przebieg generatora

- Pierwsze `pnpm --dir apps/control-room generate:api` zakończyło się exit 101,
  ponieważ Cargo nie mogło utworzyć repozytoryjnego `target/debug`:
  `Permission denied (os error 13)`. Shell redirection skryptu tymczasowo
  otworzył `openapi-v2.json` jako pusty plik przed startem Cargo.
- Ten sam kanoniczny generator został natychmiast ponowiony z
  `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/control-room-api-generation`
  i `CARGO_INCREMENTAL=0`. Zakończył się **exit 0** i odtworzył JSON bez
  ręcznej ingerencji, następnie uruchomił `openapi-typescript` oraz
  `generate-v2-client.mjs`.
- Generator zapisał cztery kanoniczne artefakty:
  - `apps/control-room/src/kernel/api/generated/openapi-v2.json`
    — 1 088 211 bajtów;
  - `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
    — 721 904 bajty;
  - `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
    — 468 bajtów;
  - `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
    — 13 797 bajtów.
- W porównaniu z `HEAD` różnią się tylko JSON i typy: JSON `+77/-3`, typy
  `+45/-4`. Client i path literals zostały deterministycznie przepisane, ale
  pozostały byte-identical i dlatego nie występują w `git diff`.

### Weryfikacja typed 422

Automatyczna, read-only walidacja zakończyła się **exit 0** dla wszystkich
trzech zasobów:

- `/v2/sessions/current/data/mesh-region-membership/{region_id}`;
- `/v2/sessions/current/data/mesh-region-memberships`;
- `/v2/sessions/current/meshing/meshes/regions/{region_id}/quality`.

Dla każdej ścieżki potwierdzono jednocześnie:

- odpowiedź JSON `422` wskazuje
  `#/components/schemas/ApiErrorResponse`;
- odpowiadająca operacja w `openapi-v2-types.ts` ma typed `422` z
  `ApiErrorResponse`;
- ścieżka występuje w `openapi-v2-paths.ts`;
- `openapi-v2-client.ts` pozostaje generycznym, niskopoziomowym transportem
  `createClient<paths>` związanym z wygenerowanymi typami.

Zmiana dotyczy wyłącznie kontraktu odpowiedzi błędu istniejących zasobów.
Ścieżki, payload sukcesu, facade, API modules, hooks, cache, codecs, adapters,
realtime events, ribbon i viewport nie zostały zmienione. HTTP v2 pozostaje
źródłem prawdy; websocket pozostaje mechanizmem event/invalidation.

### Gate'y

- Pierwsza próba focused Vitest nie uruchomiła testów z powodu środowiskowego
  `ENOENT` przy tworzeniu Windows Temp `.../ssr`.
- `TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/api/openapiV2GeneratedContract.test.ts`:
  **1 file passed, 9 tests passed, 0 failed**.
- `pnpm --dir apps/control-room typecheck`: **exit 1** po pomyślnym generowaniu
  route types. Zgłoszono 19 istniejących błędów w niezwiązanych plikach:
  `visualizationDebugPerformanceProbe.ts`, `BoundsLayers.tsx`,
  `FallbackTopologyMeshLayer.tsx`, `MeshPartLayer.tsx` oraz
  `viewport3dResources.test.ts`. Żaden błąd nie wskazuje na generated OpenAPI,
  membership facade ani tę regenerację. Nie naprawiano ich poza zakresem P1.
- `git diff --check` dla czterech artefaktów generated: **exit 0**, bez
  diagnostyki.

Nie dotknięto innych plików Control Room. Nie wykonano stage, commit ani push.
