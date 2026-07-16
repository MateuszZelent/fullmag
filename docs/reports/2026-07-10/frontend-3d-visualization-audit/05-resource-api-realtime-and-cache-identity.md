# 05. Resource-first API, realtime i tożsamość cache

## Stan reaudytu 2026-07-14

F3D-018 pozostaje **naprawione** dla canonical query identity i invalidation.
Niezależna utrata precyzji `domain_generation_id` w JSON/OpenAPI pozostaje
niezamkniętą częścią F3D-003.

## F3D-018 — invalidation pola jest zbyt szerokie, a query identity niespójne

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** resource key i transport query muszą używać jednego canonical
serializera. Jeżeli kontrakt WS zostanie rozszerzony o exact identity, exact
invalidation ma pierwszeństwo przed quantity-wide fallbackiem.

### Dowód i mechanizm

- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts:353-389`
  specjalnie przechwytuje `fields/samples`.
- Dla nie-broad zmiany iteruje po quantity IDs i w `:495-504` unieważnia wszystkie
  resource keys zawierające prefix quantity. W tej gałęzi ignoruje dokładne
  `recommended_fetch` z eventu.
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:369-390`
  buduje cache key z surowego `scope_id`.
- `apps/control-room/src/kernel/api/ControlRoomApi.ts:2545-2558` przed requestem
  normalizuje `scope_id` funkcją `normalizeFieldMetaScopeId`; przykładowo target
  id `object:foo` może stać się transportowym `foo`.
- Cache key i transport nie współdzielą jednego serializera/normalizatora; event
  może więc odnosić się do innej reprezentacji tej samej query.
- Aktualny produkcyjny publisher field samples ustawia `recommended_fetch: None`
  i wysyła `quantity_ids`/`broad` (`crates/fullmag-api/src/main.rs:241-253,408-421`).
  Bridge unieważnia wtedy wszystkie subskrybowane keys quantity, więc obecny
  przepływ przede wszystkim over-fetchuje; nie ma dowodu na missed invalidation
  wynikające dziś wyłącznie z prefiksu `scope_id`.

### Wpływ

- Aktualny nie-broad quantity event nadal uruchamia refetch wszystkich scope i
  komponentów tej quantity, bo schema nie niesie scope/component identity.
- Różna reprezentacja `scope_id` jest latentnym ryzykiem dopiero po wprowadzeniu
  exact `recommended_fetch`; bez wspólnej canonicalizacji taki przyszły event
  mógłby nie trafić cache/collection key.
- Duże sesje FEM tracą korzyść scoped fetching i bounded target budgets podczas
  częstych aktualizacji pola.

### Plan naprawy

1. Stworzyć wspólny `canonicalFieldQuery` i `serializeCanonicalFieldResourceKey`.
2. Normalizować quantity, component, scope kind/id, snapshot, stage, view,
   phase i `max_samples` przed użyciem przez transport, cache, collections i
   realtime.
3. Podjąć jawną decyzję kontraktową: zachować quantity-wide fallback jako jedyny
   wspierany model albo rozszerzyć backend/AsyncAPI o exact scope/component query.
4. Dopiero po takim rozszerzeniu unieważnić najpierw exact key oraz odpowiadającą
   collection identity; quantity-wide prefix zachować dla broad eventu albo braku
   wystarczającej tożsamości.
5. Dodać telemetry counter exact/broad invalidations oraz liczbę refetches na
   event, aby wykrywać regresje.

### Decyzja implementacyjna

Aktualny backend nie publikuje dokładnego `recommended_fetch` dla zmian
`fields/samples`; frontend nie rozszerza z tego powodu schematu ani AsyncAPI.
Jeżeli przyszły publisher poda canonical URL zasobu
`/data/fields/{quantity_id}/samples/vector`, bridge traktuje go jako
forward-compatible exact hint i unieważnia wyłącznie zgodne zasoby oraz ich
kolekcje. Każdy inny lub nieobecny hint zachowuje obecny quantity-wide fallback.
Diagnostyka zlicza faktycznie unieważnione subskrybowane klucze po flushu, nie
domniemane żądania HTTP.

### Test regresyjny i kryterium akceptacji

- Obecny quantity event ma test, że odświeża wszystkie i tylko subskrybowane keys
  tej quantity.
- Po dodaniu exact hint: event dla `object:foo`, `component=x` odświeża tylko tę
  query; nie odświeża full, airbox, object:bar ani component=y.
- Cache key, request URL i recommended_fetch po parsowaniu dają identyczny
  canonical query object.
- Testy obejmują prefixed/unprefixed object/part ids, różną kolejność parametrów,
  stage/snapshot, view/phase i sampled vectors.
- Broad event nadal poprawnie invaliduje całą quantity family.

## Elementy resource-first potwierdzone jako poprawne

- W audytowanej ścieżce React components nie wykonują bezpośredniego `fetch()`.
- `ControlRoomApi` używa wygenerowanego `openapi-fetch` i centralnego facade.
- HTTP OpenAPI zapisane w repo jest zgodne z aktualnym backendowym generatorem.
  Nie dowodzi to zgodności ręcznego parsera WS z AsyncAPI; patrz `F3D-003`.
- HTTP dostarcza snapshoty i PATCH; websocket służy do invalidation/lifecycle,
  a nie przesyłania ciężkich tablic.
- FMVP/FMMT codecs, ETag/304 i bounded `ResourceCache` są obecne.
- Scoped queries object/part/airbox oraz sampled payloads są obsługiwane.
- Warm quantity switching wykorzystuje cache; `compute_fields` jest wywoływane
  dopiero po odpowiedzi wskazującej brak materializacji, nie przy zwykłej zmianie
  quantity.
- Historyczny błąd odrzucania target kind `region` w Ribbon command validatorze
  jest naprawiony; `ribbonCommands.ts:607-615` akceptuje region.
- Historyczny hidden-region picking jest naprawiony; native picking layer używa
  `getRegionSettings` w `Viewport3DScene.tsx:1033-1054`.

## Wymagania dla zmian w tej kategorii

Każda naprawa `F3D-018` dotyka kontraktu resource identity, dlatego musi zachować:

1. wygenerowany transport jako jedyny low-level transport;
2. HTTP jako źródło prawdy;
3. websocket jako invalidation, nie drugi store;
4. osobne control-plane JSON i data-plane binary;
5. ETag/304, abort deduplication i bounded cache;
6. current HTTP OpenAPI/type generation oraz jawny AsyncAPI contract test lub
   generowane typy WS, bez ręcznego driftu payloadów.
