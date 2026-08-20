# Addendum traceability do audytu wizualizacji 3D FEM/FDM

## Metryka

| Pole | Wartość |
|---|---|
| Data addendum | 2026-08-20 |
| Audyt źródłowy | `docs/audits/2026-08-20-frontend-3d-visualization-fem-fdm-audit.md` |
| Fizycznie przesłany audyt | 1205 wierszy, 16 ustaleń `F3D-001–F3D-016` |
| Audytowy base commit | `d9518082eaee2131c3e7160bd8ae952ed2f45899` |
| Implementation base commit | `d9518082eaee2131c3e7160bd8ae952ed2f45899` |
| Implementation base tree | `6b56e8bd434b85329b362d73c32ba7dce06aaedf` |
| Masterplan | `docs/superpowers/plans/2026-08-20-frontend-3d-visualization-fem-fdm-remediation.md` |

## 1. Korekta namespace ustaleń

Przesłany audyt źródłowy zawiera 16 ustaleń. Późniejsza recenzja planu
przedstawiła dodatkowy, 22-punktowy zestaw problemów i niepoprawnie przypisała
go temu samemu audytowi. Addendum nie renumeruje ani nie zastępuje pierwotnych
ustaleń.

Obowiązują trzy rozłączne przestrzenie nazw:

- `F3D-001–F3D-016` — ustalenia przesłanego audytu;
- `R3D-001–R3D-022` — rozszerzające ustalenia pochodzące z recenzji planu,
  które wymagają własnego dowodu zamknięcia;
- `F3D-S01/S02` — wymagania przekrojowe dodane podczas konsolidacji planu.

Nie wolno raportować `R3D` jako ustaleń audytu 1205-wierszowego. Ich status
końcowy musi być wykazywany osobno.

## 2. Wymagania przekrojowe

### F3D-S01 — canonical public Airbox target

`airbox` jest jedynym publicznym targetem wizualizacji Airboxa.
`fdm-universe-outside-support`, `part:__air__` i `object:__air__` mogą występować
wyłącznie jako techniczne carriery, provenance albo aliasy wejściowe migracji.
Nie mogą być drugim właścicielem persisted visualization state, selection,
cache ani ACK.

### F3D-S02 — fail-closed FDM membership

Każdy pass wybierający `active` albo `inactive` cells wymaga dokładnej,
zgodnej z bieżącą domeną maski membership. Brak maski, błędna długość, stara
rewizja albo niezgodny grid fingerprint daje typed unavailable i zero buildów,
worker jobs, glyphów oraz adoption receipts. Brak maski nigdy nie oznacza,
że cała siatka jest inactive.

## 3. Rejestr ustaleń rozszerzających `R3D`

| ID | Zakres | Dowód wejściowy |
|---|---|---|
| R3D-001 | Session-scoped cache/resource/last-good identity | recenzja planu; wymagany test cross-session |
| R3D-002 | Capability quantities niezależne od field cache/list preview | recenzja i aktywny handler quantity catalog |
| R3D-003 | Backend-neutral retained materialization po stage | recenzja i runtime host |
| R3D-004 | Final materialization parity FEM/FDM | recenzja; wymagany black-box runtime |
| R3D-005 | FEM spatial energy-density capability parity | recenzja; wymagany provider/capability audit |
| R3D-006 | Fields i energies na jednym observation frame | recenzja; wymagany contract/runtime proof |
| R3D-007 | Usunięcie aktywnej legacy field-vector path | potwierdzone: `useViewport3DFieldVector` ma aktywnego consumera |
| R3D-008 | Stable fallback carrier IDs i diagnostic-only | potwierdzone: indeksowe `segment:<object>:<index>` |
| R3D-009 | Exact component/scope/carrier matching | recenzja; wymagane testy kontraktu |
| R3D-010 | Per-carrier resource isolation | recenzja; wymagane failure-isolation tests |
| R3D-011 | Ortogonalny lifecycle solver/session/connectivity | recenzja i hardkodowany Inspector status |
| R3D-012 | Świeży real-model runtime/browser/WebGL proof | zgodne z audytowym F3D-001 |
| R3D-013 | Bounded priority concurrency | recenzja; wymagane request/latency measurements |
| R3D-014 | Kwalifikacja custom R3F root lifecycle | recenzja; wymagany browser stress proof |
| R3D-015 | Zmierzona polityka 3D↔2D | zgodne z audytowym F3D-016 |
| R3D-016 | Byte-accounted derived-cache budgets | recenzja; wymagany inventory i eviction tests |
| R3D-017 | Raw lifecycle/performance measurements | zgodne z audytowym F3D-011 |
| R3D-018 | Brak render-phase `setState` w Inspectorze | potwierdzone: `setLastGoodPanel` jest wywoływane podczas renderu |
| R3D-019 | Metadata-driven quantity selector | potwierdzone: ręczna `VISUALIZATION_QUANTITY_ITEMS` |
| R3D-020 | Legacy cutover i backup hygiene | potwierdzone: aktywne legacy hooki i backup/reject files |
| R3D-021 | Typed dirty reasons | potwierdzone: publiczne liczniki przyjmują dowolny `string` |
| R3D-022 | Widoczna CI/required-check matrix | recenzja; istniejący React Doctor nie zamyka macierzy |

## 4. Lokalny implementation preflight

Preflight wykonano przed zmianami produkcyjnego runtime, API, resource cache i
renderera. Zadanie 0 dodaje wyłącznie testy, proof tooling, plan i dokumentację.

| Element | Snapshot |
|---|---|
| Pełny `git status --porcelain=v1 -z` po rozpoczęciu Zadania 0 | SHA-256 `043ba4a0ee8120effa220dc2960f677075cd14e41ef96853b3be154e2979e832` |
| Chroniona zmiana `apps/control-room/next-env.d.ts` | diff SHA-256 `07bd9e14f69d750a7c3c5733126aad1c60e7663fde2955eaac2007574ca1636c` |
| Chroniony stan zagnieżdżonego `external_solvers/3` | status SHA-256 `e5f0ffbcff960e9d629a3bf17b6d6dcb015054acc1ae4cd02f30baae2579cafe` |

Dodatkowy, niezwiązany artefakt użytkownika
`docs/superpowers/specs/2026-08-20-frozen-spins-production-design.md` pozostaje
nietknięty i nie może zostać przypadkowo staged.

Przed każdym checkpointem należy ponownie porównać oba chronione hashe oraz
wykonać osobno `git diff --cached --name-only`. Zmiana chronionego hasha jest
blokadą stagingu, nie sygnałem do odtworzenia albo usunięcia cudzej zmiany.

## 5. Status kwalifikacyjny addendum

Addendum naprawia traceability i definiuje wymagania, ale nie zamyka żadnej
bramki runtime/browser. `R3D-012`, audytowe `F3D-001`, `F3D-011–F3D-014` oraz
`F3D-016` pozostają niezamknięte do czasu świeżych, self-identifying proof
bundles dla rzeczywistych modeli FEM i FDM.

## 6. Granica zadania 9: telemetria i proof performance

Zadanie 9 wprowadza wyłącznie opt-in telemetrykę i wykonywalne bramki proof dla
widoku 3D. `fieldDecodes` jest inkrementowane dokładnie raz przez dekoder
`field-vector` w `ControlRoomApi`; `fieldSwaps` jest callbackiem
`onFreshAdoption` po świeżym `fieldVectorCache.set`, bez ścieżek cache-hit,
HTTP 304 ani `not-applicable`.
Trace ma wersjonowany, ograniczony format, a lista przyczyn ramek utrzymuje
najwyżej 64 klucze oraz deterministyczny licznik odrzuconych wpisów.

Wykonywalne bramki obejmują przełączenie wcześniej rozgrzanych quantities
(`0` topology builds, GET, decode i swap) oraz orbit kamery (`0` field GET,
decode, topology build i ACK). Są to bramki lokalnych harnessów, nie dowód
przeglądarkowy Tasku 12 ani kwalifikacja rzeczywistych modeli FEM/FDM.

Smoke po orbit rotate zapisuje atomowo i przed PASS ponownie waliduje JSON z
dwoma labeled raw snapshots, deltą i wynikiem gate w istniejącym katalogu
`CONTROL_ROOM_AUDIT_ARTIFACTS_DIR`. Brak takiego artefaktu blokuje PASS, lecz
sam artefakt harnessu nie jest proof bundlem Tasku 12.

Ograniczona współbieżność `loadViewport3DFieldRequestsBounded` i jej hunki w
`viewport3dResources.ts` należą do Zadania 4. Zadanie 9 ich nie modyfikuje ani
nie przypisuje sobie ich zamknięcia.
