# Przyrost 37 — plikowy preflight i import archiwów

Data: 2026-09-30. Kod na masterze i remote:
`620654ca8215db5458d01a6b88a639087e66948a`.
Cel P0–P8 pozostaje aktywny. P6 nadal **52%**; ten checkpoint nie zamyka
kwalifikacji runtime, pamięci ani wydania.

## Wynik i zakres

API import/inspekcja oraz CLI Open/Inspect używają jednego `FmsStagedPreflight`.
ZIP jest rozpakowany raz do prywatnych plików pod storage wskazanym przez
callera, bez mapy pełnych decoded payloads. Bufor kopiowania/hashowania ma
64 KiB, a typowane odczyty sterujące limit 16 MiB. Opaque payload z rozszerzeniem
`.json` nie jest automatycznie parsowany. Publiczny adapter pamięciowy nadal
istnieje dla zgodności i nie jest przedstawiany jako bounded-memory route.

Admission sprawdza wolne miejsce na `2 × decoded + 16 KiB × entries + 256 MiB`.
To pomiar pojemności, nie rezerwacja między procesami. Własny katalog UUID jest
usuwany po zakończeniu używania uchwytu lub błędzie dekodowania; cudze dane,
cache, joby i worktree nie podlegają cleanupowi.

CAS jest publikowany strumieniowo, z pin-before-publication, ponownym hash/length
check i bez materializacji istniejącego dedup blobu do Vec. Dokumenty zachowują
namespace oraz niezmienność checkpointów. Kolejność: CAS, dokumenty, markery
checkpointów, uzgodnienie SolutionSet, session commit.

API i CLI budują osobny prywatny store. Przed przeniesieniem zamykają uchwyty
i potwierdzają `WRITER.owner.json.released=true`. Linux i Windows używają
atomowego no-replace rename. `PublicationUncertain` oraz
`WriterReleaseUnconfirmed` zachowują store do recovery; deterministyczny błąd
nie usuwa istniejącego celu. CLI wymaga nieistniejącego celu, również zamiast
zastępowania istniejącego pustego store. Błędny format/graf daje w API 400,
błąd pojemności/I/O lub niepewności storage — 500.

## Poprawki bezpieczeństwa grafu

Review wykrył istniejącą lukę, której nie można było przenieść do nowej trasy:
nieznane albo osierocone dokumenty run/checkpoint mogły zawierać nieodwiedzone
referencje CAS przy `complete=true`.

Wspólny coverage sprawdza rzeczywiste odwiedzenie rekordów po typed walk.
Dynamiczna ścieżka wskazana przez poprawny manifest jest pokryta; sama nazwa
`common_state.json` nie dowodzi odwiedzenia. Nieznane lub niekonsumowane pliki
wymuszają conservative retention i blokują GC. `artifacts/**` to opaque leaves.
Pliki podszywające się pod kontenery run/checkpoint/lease/task/journal są
odrzucane. Traversal katalogów jest iteracyjny, bez rekursji po głębokości
artifact paths.

Rekordy grafu, w tym nested task/artifact catalog entries, odrzucają nieznane
pola. Nieprzejrzyste backend `extra`, `integrator_state` i payload integratora
nie stanowią dowodu pełnego grafu; wymagają typowanego walkera. **Ich capture,
export lub restore wymagające complete graph mogą być odrzucone.** Typed RNG
pozostaje rozpoznawany. Pozytywne fixture używają typed RNG; osobna regresja
przechowuje ukrytą referencję w opaque stanie i oczekuje niekompletności,
bez zgadywania znaczenia hash-like string.

Decyzja i migracja: [ADR 0038](../../../../../adr/0038-file-backed-archive-import.md).

## Dowody i granice

| Bramka | Stan | Dowód / ograniczenie |
|---|---|---|
| Produkcyjne źródła API/session | PASS | `just check-api-source`, exit 0, źródła niezmienione podczas kontroli |
| Produkcyjne wejścia CLI/Python/desktop | PASS | `just check-project-entrypoints`, exit 0, źródła niezmienione |
| Review kodu i poprawionego grafu/publikacji | PASS w zakresie source review | backend_audit po korektach; nie dowodzi wykonania |
| Scoped staged diff / parser | PASS | 13 plików; własne hunki, canonical Rust parser match do sprawdzonych źródeł |
| Testy regresyjne | NOT COMPILED / NOT RUN | bieżący zakaz kompilacji testów jednostkowych |
| Managed build czystego commita | QUEUED / NOT VERIFIED | job `106c264dfe954e6b816a7811bbde2d4b`, exit null |
| Import runtime / Windows publication | NOT VERIFIED | wymagane rzeczywiste wykonanie po zwolnieniu WRITER.lock |
| Peak RAM i duże archiwa | NOT VERIFIED | brak pomiaru; API nadal ma base64 input w pamięci |
| Crash / power loss | NOT VERIFIED | bariery pliku/katalogu nie zastępują kwalifikacji awaryjnej |

Receipts:

- API: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-api-source-check\api-source-check\7c259e854c9f4653b1edc2cc76f14798\receipt.json`.
- CLI/Python/desktop: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-entrypoint-check\project-entrypoint-check\9ed4a3081e1249259a9b0eb2a6d73ad2\receipt.json`.

Obie kontrole obejmują współdzielony dirty checkout. Wykluczone cudze hunki w
plikach tego przyrostu są wyłącznie formatowaniem po canonical comparison;
pozostałe cudze zmiany repo nie zostały dołączone do commita. Kontrola source
nie jest dowodem buildu czystego HEAD. Dodatkowy build jest przypięty do commita,
bez dirty snapshotu i bez ponawiania istniejącego joba przyrostu 36.

Authored regresje obejmują: opaque payload ponad budżetem JSON, zgodność
inspect/restore, zmianę staged bytes, cleanup własnego UUID, błędny hash/length,
immutability checkpointu, writer release, no-replace i niepewną barierę,
unknown/orphan run records, reserved container files, unknown/nested fields,
opaque restart state oraz rozróżnienie HTTP format/storage. Nie wykonano ich.

## Pozostałe prace

Odebrać terminalny receipt oraz inventory przypiętego buildu. Następnie wykonać
kwalifikację realnego importu, private-store publication/recovery i peak RAM
na dużych payloads, po odwołaniu zakazu — wymagane regresje. API upload oraz
pozostali konsumenci StoreWalker/SolutionSet wymagają osobnego pomiaru.
Typed restart payload walkers i trwała attestacja actual runtime dla FMR
pozostają osobnymi otwartymi bramkami P6; nie zastąpiono ich etykietą engine/lane.

Rollback może przywrócić adapter pamięciowy z jawnym kosztem RAM, lecz nie może
przywrócić ignorowania ukrytych referencji ani nadpisywania katalogu docelowego.

## Przypięty build produkcyjny

Zlecono jeden build `fem-cpu-release` z source **commit**
`620654ca8215db5458d01a6b88a639087e66948a`.
Job: `106c264dfe954e6b816a7811bbde2d4b`.
Request key: `p6-file-backed-import-20260930-v1`.
Digest kapsuły: `feb089bc39bc0d83a2cc87e8373678c451a66fc4cc48e619c3f921cd42ad2ce9`.
Capture: `d9dd6cd227584b9cb5f430beb15ff2bb`.
Native source identity wskazuje ten pełny SHA i `source_snapshot_dirty=false`.

Wszystkie 13 plików commita porównano byte-for-byte z kapsułą:

| Plik | SHA-256 w czystej kapsule |
|---|---|
| `crates/fullmag-api/src/router_v2/handlers/persistence/session.rs` | `c3715ae2df4afb12074fc6cc22e083bd0dc8dfc25f1b7d4907ce2c6bc72cfee8` |
| `crates/fullmag-api/src/session_persistence.rs` | `933a2d2748ab09926f52b05df00ba3f8055b46584ccdb4e16118415a9f214359` |
| `crates/fullmag-cli/src/main.rs` | `01c7114cc0f3fd27054b0e1bce4cbbd85b19df642905e416e265fbfa95dad741` |
| `crates/fullmag-session/src/archive_capacity.rs` | `6b701f0d6d937ad8c0978ca2add0399056fbe5a8155e3a77adf68f1995242664` |
| `crates/fullmag-session/src/cas.rs` | `f9c32803bb5ec89b73567879d8ef577c42e4472b893a077210ef4196f750d0e0` |
| `crates/fullmag-session/src/durability.rs` | `4312b59a8ecb2522641a0cfb8a4dbef9109433002f20fb7ee58de651099990e2` |
| `crates/fullmag-session/src/fms.rs` | `b5042cd15c14be2a9603ec693342f234c63534e2e375987f208b512d5f607d9d` |
| `crates/fullmag-session/src/lib.rs` | `4065ec60d2e1f0969e5b51221d8e61603a9b922e4692dae2f072c684d14e8e50` |
| `crates/fullmag-session/src/reachability.rs` | `c3dce166ea116495db37a6f758d62edc00cd1a5ce853e4a5f7433e5aebf4dc38` |
| `crates/fullmag-session/src/store.rs` | `41f671d44cdab7fc0a36706d17c76d648da702fdac1568188803424161ffd065` |
| `crates/fullmag-session/src/types.rs` | `f386514e0ca219daeae4f42aa8fd38cb771c0a72b027741be36a426fc83f89f8` |
| `crates/fullmag-session/tests/p0_archive.rs` | `0c3563c71f380489433f63fb2064ce978ee426bf1caa21a91de3777df9f9c25b` |
| `docs/adr/0038-file-backed-archive-import.md` | `e4ebb3d584327fe8f4a1988f2d7dcdc52cc486a5058066721988a947be62247d` |

Odczyt stanu: **queued**, exit code null. Worker: alive/running,
accepting_jobs=true, worker_error=null, stop_requested=false. Nie zmieniono
konfiguracji runnera ani aktywnych zadań. Job przyrostu 36
`a5b88dbd27414615ae44413357d542b7` również pozostaje queued; nie ponowiono go.
Kolejka i clean capsule nie są dowodem wykonanego buildu ani runtime.
Następny krok to receipt terminalny i inventory tego samego joba.
