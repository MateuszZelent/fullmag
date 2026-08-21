# Macierz wymaganych bramek wizualizacji 3D FEM/FDM

## Status

Niniejszy dokument definiuje repozytoryjny release gate dla zmian dotyczących
Control Room, API v2 i wizualizacji 3D. Ustawienia ochrony gałęzi w GitHub muszą
wymagać odpowiadających im kontekstów. Sam dokument nie jest dowodem wykonania
bramki dla konkretnego SHA.

## Wymagane konteksty CI

| Workflow / job (dokładny context) | Klasa dowodu | Zakres | Wymagany wynik |
|---|---|---|---|
| `bootstrap / rust-contracts` | source contract / compiled API | `fullmag-quantities`, runner quantity, API v2 router i CLI interactive-runtime | `success` |
| `bootstrap / generated-api-determinism` | generated API | ponowne wygenerowanie OpenAPI v2 bez diffu transportu | `success` |
| `bootstrap / api-hygiene-rg13` | source/API hygiene | hermetyczna kontrola resource-first API na ripgrep 13 | `success` |
| `bootstrap / control-room-contracts` | frontend source contract | resource-first i architektura, TypeScript, ESLint, Vitest oraz compute performance | `success` |
| `bootstrap / browser-fixture-smoke` | browser/WebGL fixture | proof-manifest, Chromium fixture lifecycle, WebGL i topology uploads | `success` |
| `frontend-3d-managed-fem / managed-fem-qualification` | managed runtime / physical | realny FEM magnetic-only i shared-air przez repozytoryjny `just verify-fem-mixed-prism-airbox-runtime` | `success` dla wydania obejmującego FEM |
| `contract-guard / canonicalization-guards` | canonical source contract | kontrakty canonical i dokumentacja naukowa | `success` |

`React Doctor` pozostaje sygnałem dodatkowym i nie zastępuje żadnej z powyższych
bramek.

Konteksty `bootstrap` sprawdzają źródło albo API/compiled contracts; nie są
dowodem działania managed runtime ani fizycznej poprawności. `browser-fixture-smoke`
jest dowodem lifecycle/WebGL na fixture, nie dowodem modelu fizycznego. Dopiero
`frontend-3d-managed-fem / managed-fem-qualification` jest dowodem realnego
managed runtime; nie zastępuje go test fixture ani deklaracja capability.

## Fail-closed dla środowiska

Job managed FEM jest przypisany wyłącznie do runnera
`[self-hosted, linux, x64, fem-managed]`. Bez takiego runnera GitHub nie może
zakończyć contextu wynikiem `success`: pozostaje on oczekujący, a release
obejmujący FEM ma status `BLOCKED`. Nie wolno dodawać warunku `if:` prowadzącego
do `skipped` ani zastępować go jobem Ubuntu bez repozytoryjnego managed runtime.
Dispatcher `scripts/ci/run_frontend3d_required_gate.sh` dodatkowo kończy się
kodem `2` i komunikatem `BLOCKED managed-fem-runner-unavailable`, gdy marker
runnera nie jest obecny. Brak Chromium ma analogicznie zakończyć job browsera
niepowodzeniem, nigdy `PASS`.

## Dowód dla konkretnego SHA

Końcowy proof bundle musi zawierać: pełny head SHA, identyfikator workflow run,
nazwę workflow i joba, conclusion, hashe runtime components oraz powiązany
manifest `fullmag.viewport-proof.v1`. Brak któregokolwiek z tych pól klasyfikuje
bramkę jako `BLOCKED`, a nie `PASS`.

Pola te są obowiązkowym obiektem `execution`: `provider`, `runId`,
`workflowName`, `jobName`, `headSha` i `conclusion`. Walidator odrzuca manifest,
jeżeli `execution.headSha` nie jest identyczny z `source.implementationCommit`.
Writer `writeProofManifest` najpierw waliduje te pola, source binding i hashe
artefaktów, a następnie zapisuje manifest bez nadpisania (`flag: "wx"`).
Manifest bez identity wykonania nie jest samocertyfikowanym `PASS`; jest
`BLOCKED` dla konkretnego SHA.

Produkcyjny `browser-fixture-smoke` nie używa self-testu jako wyniku CI. Po
zapisaniu `source-snapshot.v2.json` przez kanoniczny
`scripts/capture_source_snapshot_identity.py` uruchamia audyty, ponownie
weryfikuje brak source drift i dopiero wtedy uruchamia
`write-browser-fixture-proof-manifest.mjs`, który wymaga
rzeczywistych `GITHUB_RUN_ID`, `GITHUB_SHA`, `GITHUB_WORKFLOW` i `GITHUB_JOB`,
zapisuje `viewport-proof-manifest.json` obok `source-snapshot.v2.json` w
istniejącym report/artifact root i wiąże manifest z dokładnie tym snapshotem
przed sukcesem joba. Writer nie oblicza alternatywnego source identity.
Lokalny brak tych zmiennych kończy bramkę
`BLOCKED`; syntetyczny `validate:viewport-proof --self-test` pozostaje wyłącznie
testem walidatora. Każdy execution zapisuje `timestampUtc`; `pass` wymaga
`conclusion=success`, a `fail`/`blocked` nie może mieć takiej conclusion.

## Negatywne kontrole

CI utrzymuje negatywne kontrole lifecycle viewportu. Walidator proof manifestu
ma własny self-test odrzucający artefakt z niezgodnym SHA-256. Zmiana generatora
OpenAPI jest odrzucana, jeśli ponowne generowanie pozostawia diff w plikach
transportu.

`scripts/test_frontend3d_required_checks.py` uruchamia ten sam dispatcher co
workflow: `FULLMAG_CI_INJECT_FAILURE=proof-manifest` wymusza kod `1` zanim
browser fixture może wystawić wynik, a brak managed runnera wymusza kod `2` z
`BLOCKED`. To jest test wykonawczy bramki, nie test tekstu YAML.
