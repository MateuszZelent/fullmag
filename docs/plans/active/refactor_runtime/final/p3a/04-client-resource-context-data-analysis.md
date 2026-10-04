# P3a-B — sesyjna tożsamość membership, data-plane, analysis i diagnostics

Status: **source-level PASS dla kolejnego przyrostu hooków**. Zmiana izoluje
resource keys oraz cache/decode od niejawnego `sessions/current`, ale nie jest
jeszcze dowodem browser/runtime ani zamknięciem P3a.

## Zakres

Wspólny hook `useSessionScopedResourceKey()` obejmuje w tym przyroście:

- membership i metadane domeny: mesh region membership (pojedyncze i batch),
  FDM membership, binarny FMRM, domain meta, multilayer layout i aktywne maski;
- dodatkowe zasoby meshingu: cross-section JSON, obraz i quality, z cache
  binarnym opartym na kluczu sesji;
- data-plane: field availability, field drives, physics graph, artifacts,
  field/quantity catalog, field meta, scalar windows, table metadata, rows i
  binary rows;
- analysis results: dataset catalog/manifest, axis values, samples, items,
  branches, branch points, relations i projections;
- autorowanie/constraints i analizy pomocnicze: current/spin transports,
  spin torques, spin interfaces, Oersted fields, spin-wave gamma oraz dynamic
  structure factor;
- preparation, Frozen Spins collection/definition/mask/preview oraz aktywny
  preview; mode composition active resource czyści kontroler po zmianie scope.
- analysis runtime: hysteresis points/metrics/saturation/refinement, stage
  traces/bookmarks/branches/families/minor loops/reversal fields, frequency
  domain manifests/progress/cancel/diagnostics/artifacts oraz object metrics i
  topological charge;
- diagnostics/runtime explorer: engine log, CPU/GPU telemetry, solver profile,
  model readiness oraz command detail entries. Platform health i capabilities
  pozostają świadomie globalne, bo opisują host, a nie sesję.

Publiczne ścieżki OpenAPI oraz payloady nie zmieniają się. `ControlRoomApi`
pozostaje właścicielem transportu. Zmiana dotyczy klucza runtime, warunku
uruchomienia hooka i izolacji cache/decode.

## Reguły izolacji

Aktywny hook otrzymuje klucz:

```text
session=<encoded-session-id>&epoch=<encoded-session-epoch>|<canonical-resource-key>
```

Przed otrzymaniem kompletnej tożsamości sesji pobieranie jest wyłączone. Cache
FMRM, multilayer mask, cross-section oraz inne bufory binarne używają klucza
sesyjnego, więc payload poprzedniej sesji nie może zostać zwrócony nowej sesji
przez ten sam `current` path. Scheduler dekodowania binarnego sprawdza sygnał
abort przed i po pracy workera; wynik starego requestu po zmianie scope jest
odrzucany jako `AbortError`. Realtime nadal invaliduje kanoniczne ścieżki;
controller propaguje prefix do aktywnych kluczy sesyjnych.

`ModeCompositionController.resetForSession()` odrzuca stary authoritative
resource i anuluje oczekujące PATCH-e podczas zmiany scope. Dzięki temu
optymistyczna warstwa mode-composition nie utrzymuje danych ani mutacji starej
sesji po przełączeniu workspace.

## Dowody bieżącego checkpointu

- `pnpm --dir apps/control-room typecheck` — **PASS**;
- `pnpm --dir apps/control-room check:api-hygiene` — **PASS**;
- `python scripts/check_repo_consistency.py` — **PASS**;
- `git diff --check` — **PASS**; ostrzeżenia dotyczą wyłącznie LF→CRLF na
  Windows.
- `binaryDecodeScheduler.ts` oraz `ControlRoomApi.ts` przekazują `AbortSignal`
  do granicy decode i odrzucają wynik workera po zmianie właściciela zasobu;
  regresja jest zapisana w `binaryDecodeScheduler.test.ts` i ma status
  **NOT RUN**.

Nowe regresje źródłowe dla scope, exact/prefix invalidation, cache membership,
runtime store i resetu mode-composition są zapisane. Ich kompilacja i
uruchomienie pozostają **NOT RUN**, ponieważ bieżące `AGENTS.md` tymczasowo
zabrania kompilowania i uruchamiania testów jednostkowych; automatyczna kontrola
odrzuciła próbę uruchomienia Vitest. Nie jest to dowód browser/WebGL ani
managed runtime.

## Pozostaje

Do domknięcia P3a-B/C pozostaje migracja operacji `OPEN` z pełnej macierzy
[`06-endpoint-owner-policy.md`](06-endpoint-owner-policy.md), legacy semantics recovery/persistence oraz wszystkich events, a także dowód
wycofania pozostałych legacy aliasów. Deduplikacja długich operacji jest już
izolowana per session przez `ResourceRuntimeStore → ControlRoomApi`. Trzeba wykonać browserowy test
przełączenia sesji podczas aktywnego decode oraz managed runtime evidence.
Dopiero te dowody mogą podnieść status z source-level PASS do kwalifikacji
klienta.
