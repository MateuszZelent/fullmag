# P8-49 — eksport OpenAPI z ukończonego pakietu managed

## Cel i granica

Ten etap dodaje kontrolowaną trasę diagnostycznego eksportu dokumentu OpenAPI z już zakończonego zadania BuildRunner. Trasa nie buduje źródeł, nie inicjalizuje storage, nie uruchamia koordynatora, nie podmienia pakietu i nie kwalifikuje solvera ani fizyki. Wynikiem jest świeży, identity-bound artefakt dowodowy, który może zasilić późniejszy import klienta v2.

Implementacja znajduje się w `scripts/export_runner_openapi.py`, a regresje interpretowane w `scripts/test_export_runner_openapi.py`.

## Warunki wejścia

Przed uruchomieniem eksportu skrypt:

1. Rozwiązuje kanoniczny projektowy storage przez `fullmag_storage.resolve_layout` oraz wymaga, aby job należał do bieżącego checkoutu i jego `worktree_id`.
2. Otwiera `index/runner-jobs.sqlite` wyłącznie przez SQLite URI `mode=ro` z `PRAGMA query_only=ON`. Nie tworzy tabel, nie migruje kolejki i nie czyta tokenów lease ani logów.
3. Wymaga job ID dokładnie `32` małych znaków hex, operacji `build`, stanu `succeeded` i `exit_code=0`.
4. Wymaga koordynatorowego `receipt.json` w fazie `terminal`, ze stanem `succeeded`, kodem `0`, zgodnym job/source/profile i immutowalnym `sha256:<64 hex>` obrazu.
5. Weryfikuje wszystkie trzy zaufane wejścia koordynatora oraz ładuje kontekst przez istniejący `load_context`; nie kopiuje ani nie rekonstruuje kontraktu tożsamości.
6. Weryfikuje pełny `build-receipt.json` przez istniejące `validate_build_receipt`, w tym wszystkie wymagane niepuste wyjścia profilu release (obecnie 15), hashe artefaktów i trzy zakończone etapy.
7. Weryfikuje kapsułę źródłową przez istniejące `verify_source` i `bind_identity`, a następnie wymaga dokładnego czystego commit SHA-1 podanego przez operatora.
8. Sprawdza pakiet oraz `bin/fullmag-api` jako regularne pliki/katalogi, bez symlinków, junctionów i reparse points na ścieżce.

Nie ma drogi akceptującej `HEAD`, `unknown`, dirty snapshot, niejawny fallback CPU/GPU, stale receipt ani samą obecność pliku binarnego.

## Wykonanie

Przed uruchomieniem obrazu wykonywany jest tylko read-only `docker image inspect`; ID obrazu musi być równe digestowi z terminalnego dziennika i obraz nie może deklarować anonimowych volume. Następnie skrypt buduje bezpośrednią tablicę argumentów Docker — bez shella i bez komendy z payloadu joba:

- `--network=none`, `--read-only`, `--user 65532:65532`, `--cap-drop ALL`, `no-new-privileges:true`, limity CPU/pamięci/PID;
- pakiet jest jedynym bind mountem, zamontowanym jako `readonly` pod `/package`;
- `/tmp` jest ograniczonym tmpfs, pozostały root filesystem pozostaje read-only;
- generowany kontener ma unikatową nazwę i label eksportu; uruchamiane są wyłącznie `/package/bin/fullmag-api --print-openapi-v2`;
- stdout i stderr są zbierane niezależnie, każdy do 64 MiB, z limitem czasu 180 s.

Po zakończeniu, timeoutcie, przepełnieniu lub błędzie startu skrypt wykonuje exact inspect po wygenerowanej nazwie/labelu i digestcie obrazu. Zatrzymuje i usuwa wyłącznie kontener należący do tego eksportu, a następnie ponownie potwierdza jego nieobecność. Niepotwierdzone cleanup albo obca kolizja nazwy kończą eksport jako błąd i pozostają w dowodzie; nie ma automatycznego przejmowania kontenera.

Nie jest montowana kapsuła źródłowa ani katalog wynikowy. Nie jest używany Compose, dev server, cargo, instalator zależności ani endpoint HTTP.

## Walidacja surowego eksportu

stdout musi być bounded UTF-8 JSON-em będącym obiektem. Walidacja zachowuje kontrakt istniejącego `normalize-openapi-build-identity.mjs`/`validateManagedOpenApiIdentity`: `git_commit`, `source_snapshot_sha256`, `worktree_state=clean`, poprawny `built_at_utc` oraz canonical `/v2/sessions/current/status` muszą istnieć i odpowiadać pakietowi. Dokument z błędną tożsamością, brakującą trasą, uszkodzonym JSON-em, kodem różnym od zera, timeoutem albo przepełnieniem limitu jest odrzucany.

## Dowód i publikacja

Każde wywołanie otrzymuje nowy katalog pod `runs/<worktree_id>/openapi-export/<uuid>`. Skrypt zapisuje wyłącznie nowe pliki:

- `stdout.raw.json` — dokładne stdout procesu;
- `stderr.raw.log` — dokładne stderr procesu;
- `receipt.json` — stan, exit code, command, identyfikatory źródła/obrazu/job, hashe receiptu buildu, kapsuły, binarki i raw outputu;
- `proof.json` — skrócony dowód tych samych granic i hash `receipt.json`.

Hash binarki API, build receiptu i manifestu źródłowego są zapisywane po przejściu walidatorów, przed startem procesu, i porównywane ponownie po jego zakończeniu. Zmiana któregokolwiek wejścia kończy eksport jako błąd; dowód zachowuje hash przedstartowy i nie zastępuje go hash-em zmienionego pliku. Zapisy są ekskluzywne i odrzucają istniejącą ścieżkę; nic w pakiecie wejściowym, kapsule ani źródłowym checkoutcie nie jest nadpisywane. Artefakt ma `qualification=NOT VERIFIED` i `diagnostic_only=true`; sukces eksportu nie jest dowodem uruchomienia solvera, GPU, FEM, FDM, runtime service ani poprawności naukowej.

## Weryfikacja wykonana w tym etapie

03.10.2026: `python -B scripts/test_export_runner_openapi.py` — **25/25 PASS**,
bez kompilacji testów. Niezależny review eksportera i ścisłej trasy wrappera:
PASS bez P0/P1. Regresje obejmują walidatory receiptu/kapsuły, terminalną
kolejkę read-only, dirty/stale identity, izolację procesu, bounded capture,
timeout/overflow/spawn/read failure, ciągłość ID kontenera i exact cleanup,
zmianę/brak wejść po starcie oraz reparse points. Cztery regresje wrappera
odrzucają błędny job, `HEAD`, komendę złożoną i próbę obejścia przez marker
diagnostyczny — przed przygotowaniem storage.

Pierwsze wywołanie ujawniło, że ogólny wrapper próbował przygotować istniejącą
realną `.fullmag`. Naprawiono admission przez rozpoznanie wyłącznie stałego
helpera i pełnego kształtu argumentów przed ogólną diagnostyką. Nie migrowano,
nie kasowano ani nie zmieniano `.fullmag`.

### Rzeczywisty build i eksport

BuildRunner **218**, job `5a2659ca616448fdacd75e16f004e2af`, zakończył się
`succeeded`, exit `0`. Walidacja potwierdziła 120 artefaktów, 15 wymaganych
niepustych wyjść i 6829 plików kapsuły. Źródło:
`9f7eadb06b7f4e9be3b0fed7b1c9006a4666ea04`, clean snapshot
`ce7fec0a8446178a03ae18c28128cd85c3c9dbe63c041c8a876f96198fa27097`.
Build obejmuje B-03; późniejsze B-04–B-08 nie są nim zweryfikowane.

Wykonano kanoniczną receptę:

```text
just export-runner-openapi 5a2659ca616448fdacd75e16f004e2af 9f7eadb06b7f4e9be3b0fed7b1c9006a4666ea04
```

Dowód: `C:/git/fullmag/storage/runs/fullmag-0950f4dca4ffe38f/openapi-export/3abacb4e61ce43a1b3679add903673a5/`.
Eksport ma `succeeded`, exit `0`, `cleanup_confirmed=true`,
`input_hashes_checked=true`, `input_hashes_verified=true`. Surowy JSON ma
1 478 530 bajtów. Hashe:

| Wejście/wyjście | SHA-256 |
|---|---|
| Build receipt | `a83e6db94e49cec989ccca985385d2250b14adb3e11e89bc7bbc0052ef811cc7` |
| Binarium API | `91fe2162431d27254e8ce6224920717fe48ed4d0f5964e9e936e42eac1dc9564` |
| Surowy OpenAPI | `7b46d6b6f0edec46e5dfd6e8efcac1ba769630dfcc80f323ef0a00803e5a6d6d` |
| Receipt eksportu | `022e52e211765c05b8b25443333edb45dd072717e752f7f883641c715aeb1268` |

### Import frontendowy

Import surowego pliku z dokładnym expected commit i snapshot zakończył się
exit `0`; regeneracja typów i paths odbyła się przez istniejące narzędzia,
bez ręcznej edycji generated. Kontrakt zawiera trwały scalar resource oraz
`/v2/platform/runtime-service`.

- `just generate-control-room-client`: PASS, receipt kończący się
  `generate-client/f93cc76cac2e486eaba4006fa28b6ff5/receipt.json`.
- `just check-control-room-production-source`: PASS, receipt
  `production-source/e97378a289d147399148937a087ea265/receipt.json`.
- `just verify-control-room-openapi-import`: **11/11 PASS**, receipt
  `openapi-import-check/9d646c7d206c422783369f8766e6afcc/receipt.json`.

Wszystkie trzy receipty należą do
`C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-control-room-source-check/`.
Kontrola importu początkowo była odrzucona przez listę dozwolonych tras
wrappera. Dodano wyłącznie już istniejący `openapi-import-check`; powyższy
wynik potwierdza poprawkę. Nie wykonywano kompilacji testów jednostkowych.
Source check dotyczy baseline wygenerowanego kontraktu, przed integracją UI
skalarów; zmieniony frontend wymaga nowego dowodu.

## Pozostałe bramki

Eksport i import są zweryfikowane. Nie są dowodem wykonania solvera,
accepted-runtime, FEM/GPU, nauki ani niezależnego produktu Windows. P6 nadal
wymaga facade/resource/UI oraz odbioru w przeglądarce. Nie restartowano UI3104,
nie podmieniano aktywnej sesji i nie usuwano danych użytkownika. `qualification`
pozostaje `NOT VERIFIED`; pełny cel P0–P8 pozostaje otwarty.
