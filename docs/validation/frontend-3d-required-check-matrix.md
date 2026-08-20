# Macierz wymaganych bramek wizualizacji 3D FEM/FDM

## Status

Niniejszy dokument definiuje repozytoryjny release gate dla zmian dotyczących
Control Room, API v2 i wizualizacji 3D. Ustawienia ochrony gałęzi w GitHub muszą
wymagać odpowiadających im kontekstów. Sam dokument nie jest dowodem wykonania
bramki dla konkretnego SHA.

## Wymagane konteksty CI

| Workflow / job | Zakres | Wymagany wynik |
|---|---|---|
| `bootstrap / rust-contracts` | `fullmag-quantities`, API, IR, planner i authoring | `success` |
| `bootstrap / api-hygiene-rg13` | niezależna kontrola resource-first API | `success` |
| `bootstrap / control-room-contracts` | deterministyczny OpenAPI, architektura, lint, typecheck, Vitest, browser lifecycle i WebGL | `success` |
| `contract-guard / canonicalization-guards` | kontrakty canonical i dokumentacja naukowa | `success` |
| managed FEM qualification | realny FEM magnetic-only i shared-air uruchomiony przez repozytoryjny `just` | `success` dla wydania obejmującego FEM |

`React Doctor` pozostaje sygnałem dodatkowym i nie zastępuje żadnej z powyższych
bramek.

## Dowód dla konkretnego SHA

Końcowy proof bundle musi zawierać: pełny head SHA, identyfikator workflow run,
nazwę workflow i joba, conclusion, hashe runtime components oraz powiązany
manifest `fullmag.viewport-proof.v1`. Brak któregokolwiek z tych pól klasyfikuje
bramkę jako `BLOCKED`, a nie `PASS`.

Pola te są obowiązkowym obiektem `execution`: `provider`, `runId`,
`workflowName`, `jobName`, `headSha` i `conclusion`. Walidator odrzuca manifest,
jeżeli `execution.headSha` nie jest identyczny z `source.implementationCommit`.

## Negatywne kontrole

CI utrzymuje negatywne kontrole lifecycle viewportu. Walidator proof manifestu
ma własny self-test odrzucający artefakt z niezgodnym SHA-256. Zmiana generatora
OpenAPI jest odrzucana, jeśli ponowne generowanie pozostawia diff w plikach
transportu.
