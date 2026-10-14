# P8-53BZ — typowany authoring i granice buforów przeglądarki

Data: 14.10.2026. Baza `49c0be12ffe4fc427d55cd59d0559c7c0eb994cd`.
Status: **production source typecheck PASS; CI, build i browser/runtime w toku**.

Aktualizacja: produkcyjne źródła przeszły też typecheck na rzeczywistych
nowych zależnościach **TypeScript 7.0.2**, receipt
`00a38ea0131c42c9916b31da5452f753`, source before=after
`01290a72e4e95dc1418003ef7bc4d5a4124bc4b7b39a6ee38d25c4d86fb645d1`.
To kontrola produkcji z wykluczeniem unit sources, bez kwalifikacji browser/runtime.
Zarządzany native build na snapshotcie
`6c3ce36d2a82d6f05fc74897af0d7bd66580f41f768dc3158634816339d01549`
ukończył CLI/API w 5 min 17 s, lecz desktop zatrzymał się na braku miejsca
podczas zapisu incremental dep-graph (`os error 112`). Cały build jest
**failed / exit 1**, log `native-build-f2accc4855a741e78cca19a89fb466bb.log`.
Nie zaliczono pełnego pakietu; nie kasowano cache ani wyników.

Świeży lint `5865c5b1978e426ead433cd36cb43473` wykazał rzeczywistą
niezgodność narzędzi: `@typescript-eslint/typescript-estree@8.59.0` podłączony
do TS7 kończy się `TypeError: Cannot read properties of undefined (reading 'Cjs')`.
Samo dodanie osobnego API6 dla dwóch testów AST nie rozwiązuje peer dependency
parsera. Następny przyrost musi rozdzielić API narzędzi od natywnego CLI;
nie wolno wyłączać lintu ani twierdzić, że cały frontend jest shippable.

## Przyczyna i zakres

CI dla PR #164 przeszło kompilację czytników limitu CPU po P8-53BY, lecz
`generated-api-determinism` (job `115726863452`) ujawnił E0308: potwierdzenie
transakcji authoringu przekazywało `serde_json::Value` zamiast `SceneResource`.
Handler używa teraz istniejącego `authoring_transaction_response`, który
projektuje dokładnie zacommitowany dokument do kanonicznego zasobu sceny.
Kontrola request context po commicie i rewizja potwierdzenia pozostają zachowane.
Istniejąca regresja `authoring_transaction_ack_matches_current_scene_resource_and_revision`
pozostaje wymaganym dowodem CI; nie wykonano jej lokalnie.

`control-room-contracts` (job `115726863776`) ujawnił błędy typów przy WebCrypto,
Blob i ImageData oraz rozbieżne fixtures i importy parsera AST:

| Obszar | Poprawka | Granica dowodu |
|---|---|---|
| FMRM SHA-256 | Zwykły ArrayBuffer otrzymuje view z dokładnym offsetem/długością, bez kopii payloadu; shared backing jest kopiowany przed WebCrypto | Regresja źródłowa sprawdza SHA-256 `abc` z obu rodzajów podbuforu; wykonanie w CI |
| Zapis projektu | Dekoder base64 deklaruje faktycznie własny `Uint8Array<ArrayBuffer>`; browser download przyjmuje ten typ | Bez castu, zmiany archiwum lub dodatkowej kopii |
| Field Map ImageData | View zwykłego bufora zachowuje zakres i backing; shared backing jest kopiowany do ArrayBuffer | Regresja sprawdza offset, wartości, brak kopii zwykłego backing i niemutowanie wejścia; browser rendering nadal NOT VERIFIED |
| Ribbon | Przywrócony brakujący import `normalizeInteractionDiscretization` z kanonicznego modułu interakcji | Production typecheck odtworzył TS2552 przed poprawką i przeszedł po niej |
| Stage execution fixtures | Jawny request scope zgodny z fixture sesji; legacy payload z `run_id: null` konstruowany jawnie w runtime testu; dodatkowy przypadek braku zasobu | Zachowano wcześniejszą dodatnią asercję exact-null tuple; nie poluzowano schematu API ani kontroli session/epoch/run |
| Explorer fixtures | Wymagane nazwy materiałów; zachowane malformed/niefinityczne wartości używane przez regresje DMI | Bez castów przez `unknown` |
| Testy AST | Oficjalny `@typescript/typescript6` 6.0.2, lock wskazuje jego implementację TypeScript 6.0.3 | TypeScript 7.0.2 nadal jest kompilatorem aplikacji; nie wyłączono analizy AST |

Compiler API wydania 7 nie jest eksportowane jak dawniej; ścieżka side-by-side
jest opisana przez [Microsoft](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
Lockfile odświeżono przez pnpm `--lockfile-only --ignore-scripts`, bez instalacji
lub kompilacji testów. Diff lockfile dodaje tylko ten pakiet i jego zależność.
Nie zmieniono publicznych endpointów, OpenAPI, wygenerowanych plików, fizyki,
requested/resolved execution ani procesu restartu.

Pełny lokalny lint (`2c146bf5f53d44ef9870fecfa7beaa32`) wskazał dwie
wcześniejsze diagnozy: synchroniczne setState w efekcie browser fixture
Explorera oraz niestabilny derived draft Inspectora anteny. Fixture używa
istniejącego wzorca `useSyncExternalStore` dla hydratacji, a draft `useMemo`
z kompletnymi zależnościami. Nie zmieniono wartości, dirty keys, baseline,
obsługi ACK ani lifetime formularza. Wymagany jest nowy lint i browser proof.

Bounded review zgłosiło P2 dotyczące utraty legacy exact-null tuple testu;
asercję przywrócono bez rozszerzania bieżącego schematu StageExecutionResource.
Review buforów, ACK, importu ribbonu i lockfile nie wykazało potwierdzonego P0/P1.
Zgodność rzeczywistego parsera ESLint z TS7 pozostaje osobną bramką: lokalne
zależności to TS5.8.3, a CI zatrzymało się przed lintem.

## Aktualne dowody

- Managed production source typecheck: `1fbabb2426a24c75a2d060c5f65698c9`,
  PASS, exit 0; source before=after
  `edc7f2d94d7896eb8a0c30204e349913d8296772e515b43845a172c4b38ca625`.
  Użyto istniejących lokalnych zależności (TypeScript 5.8.3), bez instalacji;
  wszystkie unit sources wykluczono. Nie jest to dowód CI na TypeScript 7.
- Lockfile-only: `43454c76ae5d4e358a4a058efae14469`, PASS, exit 0;
  package before=after, lock po aktualizacji
  `af02cef65b83881f66631057ae2fc87b5c31b825e0eb7dae51f6b7b1fff98060`.
- Read-only Rust parser dla `authoring.rs`: exit 0, bez zapisu i bez
  rekurencyjnego formatowania zależnych modułów.

Dwie próby `just windows-workspace-build dev dev 3197 true` zakończyły
oczekiwanie przed startem kompilacji: wspólny natywny slot zajmował proces
build-only w worktree `fem-script-launch-20261013`. Nie zabijano cudzych
procesów i nie obchodzono blokady. Te próby nie są dowodem buildu.

CI pozostaje wymagane: źródłowe testy buforów/AST/fixtures, typowany ACK,
generowanie API, pełny lint/typecheck i pozostałe bramki integracji.
P8-53, A→B→C, natywny pakiet Windows i cały plan pozostają **IN PROGRESS**;
procentów nie podniesiono na podstawie samej naprawy źródeł.
