# P3a-B — sesyjna tożsamość zasobów modelu, runtime i workspace

Status: **source-level PASS dla kolejnego przyrostu hooków**. Ten dokument nie
oznacza jeszcze kwalifikacji browser/runtime ani zamknięcia P3a-B.

## Zakres

Wspólny hook `useSessionScopedResourceKey()` opakowuje kanoniczny klucz
zasobu parą `session_id + session_epoch`. W tym przyroście objęto nim:

- model i geometrię: scenę, diagnostykę/capabilities/validation, materiały,
  assety magnetyzacji, regiony, couplingi oraz interakcje obiektu;
- runtime i persistence: kolejkę oraz szczegóły komend, bieżący i wybrany
  run, wykonanie stage oraz katalog i szczegóły checkpointów;
- events/workspace: politykę komunikacji realtime, stan wizualizacji, client
  acknowledgements oraz listę i szczegóły planar monitorów.
- lifecycle meshing: build current/latest/history, summary, capabilities,
  semantics, shared-domain manifest/policy/report/quality, decoded quality i
  topology, histogram bins, quality gates, realized-size fields, universe
  reports/quality/policy oraz per-object mesh topology/report/quality/size/policy.

Publiczne ścieżki OpenAPI i formaty payloadów pozostają bez zmian. Hook nie
ładuje zasobu, dopóki status sesji nie dostarczy kompletnej tożsamości. Zmiana
epochu zmienia klucz runtime resource, więc poprzedni payload nie jest
odczytywany jako dane nowej sesji.

## Invalidation i kompatybilność

`ResourceInvalidationController` propaguje teraz także dokładną invalidację
kanonicznej ścieżki do aktywnego klucza sesyjnego. Prefix invalidation nadal
obsługuje przyszłe subskrypcje i klucze z suffixem kanonicznej ścieżki. Dzięki
temu istniejące komendy i realtime, które emitują `invalidate(path, revision)`,
nie omijają aktywnego scoped resource.

Seedowanie zatwierdzonej sceny przez `publishCommittedSceneResource()` aktualizuje
także istniejące aktywne aliasy sesyjne w `ResourceRuntimeStore`, więc ścieżki
Apply/Undo/Redo z `invalidate=false` nie wracają do starego payloadu ani nie
wymuszają zbędnego ponownego GET.

Dynamiczny klucz planar monitorów zachowuje lokalny suffix rewizji po
opakowaniu bazowej ścieżki; subskrypcja rewizji pozostaje przy kanonicznym
kluczu, aby istniejące mutacje i bridge realtime nadal sterowały odświeżeniem.

## Dowody

- `pnpm --dir apps/control-room typecheck` — **PASS**;
- `pnpm --dir apps/control-room check:api-hygiene` — **PASS**;
- `python scripts/check_repo_consistency.py` — **PASS**;
- `git diff --check` — **PASS**; ostrzeżenia dotyczą normalizacji LF/CRLF na
  Windows.

Testy źródłowe dla nowej propagacji exact invalidation i pokrycia hooków są
zapisane, lecz ich uruchomienie pozostaje `NOT RUN`: bieżące `AGENTS.md`
tymczasowo zabrania kompilowania i uruchamiania testów jednostkowych, a próba
uruchomienia Vitest została odrzucona przez automatyczną kontrolę. Nie jest to
dowód browser/runtime.

## Pozostaje

Membership/domain metadata, cross-section, katalogi pól/tabel/artefaktów,
binary decode oraz dalsze rodziny analysis/diagnostics są objęte kolejnym przyrostem w
[`04-client-resource-context-data-analysis.md`](04-client-resource-context-data-analysis.md).
Pozostaje migracja operacji `OPEN` z macierzy
[`06-endpoint-owner-policy.md`](06-endpoint-owner-policy.md), legacy semantics recovery/persistence
oraz events, a także browserowy test przełączenia sesji podczas aktywnego
decode. Deduplikacja materializacji/freshness w `ControlRoomApi` jest już
keyed per session przez `ResourceRuntimeStore`. Po tej migracji trzeba wykonać
inventory endpointów i kluczy oraz managed runtime evidence.
