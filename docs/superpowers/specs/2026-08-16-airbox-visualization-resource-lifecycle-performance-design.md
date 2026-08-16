# Projekt naprawy produkcyjnej wizualizacji Airboxa

**Data:** 2026-08-16
**Źródło wymagań:** `docs/audits/2026-08-16-airbox-visualization-resource-lifecycle-performance-audit.md`
**Status:** przyjęty do realizacji na podstawie polecenia wdrożenia wszystkich punktów audytu

## Cel i granice

Naprawa obejmuje pełny przepływ FDM single-grid, FDM multilayer i FEM od
`compute_fields`, przez publiczny API v2 i cache zasobów, do pierwszej adopcji
warstwy wektorów oraz Inspektora. Nie zmienia równań fizycznych ani znaczenia
quantity. Wszystkie ciężkie dane pozostają na data plane, a WebSocket nadal
tylko unieważnia zasoby.

## Kontrakt docelowy

Każda próba pola ma tożsamość:

```text
(session, target, quantity, scope_kind, scope_id, generation,
 component, topology_or_grid_identity, requested_budget)
```

`compute_fields` zapisuje wymagane quantity/scope/generation i kończy się jako
`Completed` dopiero po pozytywnym odczycie każdego wymaganego zasobu przez ten
sam publiczny handler. Endpoint binarny zwraca `204` wyłącznie dla znanego,
jeszcze nieuruchomionego quantity, `202` z kodem reason i `retry_after_ms`
podczas materializacji, `404` wyłącznie dla nieistniejącej tożsamości oraz
`409` dla niespójnego generation/carrier. Publikacja multilayer używa katalogu
niezmiennej generacji i atomowego wskaźnika manifestu.

Frontend posiada niezależny wpis runtime dla każdego żądania. Kolekcje są
widokiem pochodnym częściowych wpisów; pojedyncza awaria nie zeruje innych
targetów. Wpis zachowuje ostatni zgodny bufor podczas `pending/stale`, a nowy
bufor jest adoptowany atomowo dopiero po walidacji identity. Retry jest
bounded, reason-coded i abortowalny; trwałe `404/409` nie są retryowane.

Model topologii Airboxa ma klucz wyłącznie od carrier/grid/membership/style.
Quantity, field revision i readiness nie powodują rebuilda topologii. Wektorowy
worker otrzymuje próbki z explicit ordinals; nie buduje pełnego modelu
nieaktywnych komórek tylko po to, by odrzucić większość glyphów. Globalny
allocator rozdziela limit widocznych glyphów między targety i publikuje
requested/effective/adopted wartości.

Inspektor korzysta z jednego deskryptora capacity targetu: `targetId`,
`carrierId`, `anchorKind`, `fullCount`, `surfaceCount`, `exact`,
`generation/revision`. FDM liczy centra komórek z membership (Airbox = inactive),
FEM liczy union węzłów z manifestu. Accounting rozdziela available anchors,
requested budget, effective allocation, decoded samples i adopted arrows.
Zwykłe otwarcie Inspektora nie uruchamia pełnego skanu wartości pola.

## Moduły i odpowiedzialność

1. **Backend readiness i carrier publication** — `fullmag-cli` przechowuje
   wymagania komendy, `fullmag-api` waliduje completion i publikuje status oraz
   generacyjne artefakty.
2. **API/data plane** — schema/OpenAPI, generated types, `ControlRoomApi`,
   FMVP sampled payload i telemetria request/bytes/duration.
3. **Resource runtime** — `ResourceRuntimeStore`, `useResource` oraz
   `viewport3dResources` zapewniają retry/deadline/partial state/last-good.
4. **Viewport render model** — osobne topology/field/vector keys, sampled
   vector worker path, global allocator i retained render buffers.
5. **Visualization state** — target-specific merge/CAS oraz optimistic state
   jako źródło kolejnych patchy.
6. **Inspector/accounting** — target-aware capacity adapter, jawne jednostki i
   efektywne clampowanie.
7. **Qualification** — testy kontraktowe, benchmark cold/warm, stress loops i
   browser smoke z asercjami WebGL.

## Błędy i adopcja

`pending` nie jest pustym wynikiem. Warstwa pokazuje last-good carrier i status
`stale/pending`; jeśli nie ma żadnego zgodnego bufora, renderer pozostaje
fail-closed bez syntetycznej geometrii pola. Każdy wynik async sprawdza request
sequence oraz generation/topology identity przed adopcją. Abort, unmount,
worker fallback i GPU upload są liczone w bounded telemetryce.

## Weryfikacja

Wymagane są testy RED/GREEN dla każdego kontraktu, następnie focused Vitest,
Rust API/CLI tests, OpenAPI regeneration, typecheck/lint, `audit:idle-performance`,
benchmark 20 cold + 20 warm prób dla każdej lane oraz browser smoke FDM
single-grid/multilayer/FEM. Smoke musi potwierdzić `gl.isContextLost() === false`,
niezerowy drawing buffer, osobne klatki `wireframe on -> wireframe off ->
vectors on`, brak utraty innych targetów i powrót worker/listener/GPU counts do
baseline po unmount.
