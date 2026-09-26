# P3a-B — sesyjna tożsamość klienta dla data-plane cache

Status: **source-level PASS dla pierwszego slice'u `data`**. Nie jest to
jeszcze dowód browser/runtime ani pełna migracja P3a-B.

## Zakres

Ten przyrost obejmuje zasoby, które wcześniej budowały klucz wyłącznie z
kanonicznej ścieżki `/v2/sessions/current/...` i parametrów pola:

- wektor pola używany przez data preview;
- metadata, binary mask/vector/render/scalar i probe dla planar field;
- metadata i dekodowane bufory zespolonych pól modalnych dla overlay oraz
  mode-composition;
- prefix invalidation zasobów opakowanych w klucz sesyjny.

Nie zmienia się publiczna ścieżka API ani format FMVP. `ControlRoomApi` nadal
jest jedynym właścicielem transportu i dekodowania; zmiana dotyczy wyłącznie
tożsamości cache/resource-hook oraz propagacji rewizji.

## Kontrakt tożsamości

`useSessionResourceIdentity()` dostarcza parę `session_id + session_epoch` z
revision-aware `session:status`. Zasób otrzymuje klucz:

```text
session=<encoded-session-id>&epoch=<encoded-session-epoch>|<canonical-v2-resource-key>
```

Przed uzyskaniem tożsamości hook pozostaje wyłączony. Po zmianie sesji nowy
klucz nie może trafić do cache poprzedniej sesji; stare wpisy pozostają tylko
bounded cache i mogą zostać usunięte przez normalny eviction.

Realtime nadal publikuje invalidacje dla kanonicznego prefiksu. `ResourceInvalidationController`
rozpoznaje teraz kanoniczny suffix za separatorem klucza sesyjnego, więc
`invalidatePrefix("/v2/sessions/current/...")` aktualizuje także aktywny
klucz sesyjny. WebSocket pozostaje kanałem invalidacji, nie źródłem payloadu.

Kontroler `ModeCompositionFieldLayerController` dostaje dodatkowy scope
sesyjny. Przy jego zmianie anuluje bieżący odczyt i czyści metadata cache,
rewizje, retained fields oraz decoded field cache przed ponownym ładowaniem.
`ModeFieldOverlayIntentController` ma ten sam lifecycle przez `AbortController`
i token żądania, a resource hook nie rozpoczyna pobierania bez kompletnej
tożsamości sesji.

## Dowody

- `pnpm --dir apps/control-room typecheck` — **PASS**;
- `pnpm --dir apps/control-room check:api-hygiene` — **PASS**;
- ukierunkowane testy resource hooks — **PASS** (91 testów);
- dodatkowy zestaw kontrolera/tożsamości/invalidation — **PASS** (21 testów),
  w tym kontrola zmiany sesji dla mode-composition;
- `python scripts/check_repo_consistency.py` — **PASS**;
- `git diff --check` — **PASS**; ostrzeżenia dotyczą normalizacji LF/CRLF na
  Windows.

Testy browser/WebGL, managed runtime, migracja endpointów oznaczonych `OPEN`,
persistence/events poza pilotem oraz pozostałe rodziny `simulation`, `meshing`,
`analysis` (poza tym slice'em) i `diagnostics` pozostają **NOT VERIFIED**.

## Następny krok

Kolejny przyrost model/runtime/workspace jest opisany w
[`03-client-resource-context-model-runtime.md`](03-client-resource-context-model-runtime.md).
Późniejsze przyrosty objęły meshing/data-plane, analysis i diagnostics; aktualny
zakres i dowody są w
[`04-client-resource-context-data-analysis.md`](04-client-resource-context-data-analysis.md).
Source-level inventory coverage OpenAPI z ownerem/write policy jest już w
[`06-endpoint-owner-policy.md`](06-endpoint-owner-policy.md); nadal pozostają
migracja operacji `OPEN`, legacy semantics recovery/persistence poza pilotem
oraz browserowy test przełączenia sesji podczas trwającego decode. Deduplikacja długich operacji jest już
izolowana przez `sessionScopeKey` przekazywany z `ResourceRuntimeStore` do
`ControlRoomApi`.
