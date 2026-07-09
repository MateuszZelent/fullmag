# 01. Poprawność naukowa, provenance i staleness

Ta kategoria ma najwyższy priorytet. Wszystkie cztery problemy mogą spowodować,
że poprawnie wyglądająca geometria, kolor lub glyph nie odpowiada bieżącej scenie,
domenie albo polu.

## F3D-001 — różnica rewizji scene/manifest może zostać uznana za `current`

**Priorytet:** P0 — krytyczny
**Dowód:** T + S
**Kontrakt:** topologia bieżąca musi pochodzić z bieżącej sceny; tagi dirty są
dodatkowym sygnałem, nie zamiennikiem jawnego provenance.

### Dowód i mechanizm

- `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:18-53`
  odczytuje `scene.revision` i `manifest.source_scene_revision`.
- Przy jawnej różnicy rewizji kod w `:49-51` zwraca `current`, jeżeli scena ma
  obiekty i żaden nie ma taga dirty.
- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyStaleness.test.ts:23-58`
  utrwala to zachowanie dla ogólnego obiektu i dla edycji regionu: scena `r13`
  z manifestem `source r12` ma być według testu `current`.
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts:272-286`
  zwraca `null` freshness dla regionu, więc region Inspector całkowicie omija ten
  sygnał.

### Wpływ

Po zmianie regionu, obiektu lub innej semantyki sceny stary manifest może nadal
dostarczać `mesh_part_ids`, object/part mapping i scope dla shaderów oraz pól.
Użytkownik nie otrzymuje wymuszonego degraded state, ponieważ topologia zostaje
oznaczona jako bieżąca.

### Przyczyna źródłowa

Resolver próbuje zachować obraz podczas authoringu, ale utożsamia brak dirty taga
z dowodem zgodności. `source_scene_revision` jest silniejszym tokenem provenance i
nie może zostać nadpisane heurystyką.

### Plan naprawy

1. W `resolveVisualizationTopologyFreshness` ustalić twardą regułę:
   `source_scene_revision != scene.revision -> stale`.
2. Zostawić dirty tags wyłącznie dla przypadków bez `source_scene_revision`.
3. Usunąć wyjątek regionu w
   `resolveObjectVisualizationPanelTopologyFreshness`; Inspector ma używać tego
   samego resolvera co viewport.
4. Dla stanu stale zachować co najwyżej jawnie oznaczony ghost/wireframe starej
   geometrii; nie używać starych region carrierów do field scope.
5. Odwrócić istniejące testy `keeps ... current` i dodać macierz:
   object edit, region edit, visibility edit, transform edit, brak provenance.

### Test regresyjny i kryterium akceptacji

- Scena `r13` + manifest `source r12` zawsze daje `stale`.
- Region Inspector i viewport pokazują ten sam freshness/degraded reason.
- Dla stale manifestu nie powstają scoped field requests z jego `mesh_part_ids`.
- Browser smoke potwierdza przejście: aktualny mesh -> edycja regionu -> ghost bez
  pola -> rebuild -> pole na nowej topologii.

## F3D-002 — topologia `stale` pozostaje pełnoprawnym nośnikiem pól

**Priorytet:** P0 — krytyczny
**Dowód:** T + S
**Kontrakt:** stary mesh może być pokazany jako kontekstowy ghost, lecz warstwy
field-driven działają tylko na topologii `current`.

### Dowód i mechanizm

- `visualizationDisplayResolution.ts:62-66` definiuje renderable jako wszystko
  poza `unknown`, czyli również `stale`.
- `visualizationDisplayResolution.ts:93-107` zwraca normalne effective settings
  dla `stale`; bezpieczne `resolveTopologyConstrainedVisualizationSettings` jest
  stosowane tylko do `unknown`.
- `useViewport3DSceneModel.ts:2255-2283` oblicza osobno `topologyCurrent` i
  `topologyRenderable`, ale `:2343` przekazuje renderable topologię do
  `currentTopologyRenderModel`.
- Ten model zasila scoped requests i field render options w
  `useViewport3DSceneModel.ts:2707-2783`.
- `viewport3dTopologyStaleness.test.ts:146-167` jawnie oczekuje, że stale topology
  pozostawi shader, points i vectors na zwykłej ścieżce.

### Wpływ

Kolory, HSL orientation, glyphy i punkty mogą być pokazane na poprzedniej siatce
po zmianie sceny. Sama etykieta stale nie zapobiega naukowej nadinterpretacji,
bo render wygląda jak pełnoprawny wynik.

### Przyczyna źródłowa

Jeden predykat `renderable` pełni dwie role: pozwolenie na pokazanie geometrii i
pozwolenie na użycie geometrii jako indeksowania pola. Te decyzje muszą być
rozdzielone.

### Plan naprawy

1. Wprowadzić dwa jawne predykaty:
   `topologyGeometryRenderable` oraz `topologyFieldCompatible`.
2. `topologyFieldCompatible` ma być true tylko dla `current` i dopasowanych tokenów
   generation/hash/revision z `F3D-003`.
3. Dla `stale` budować osobny ghost model: surface shader off, points off, vectors
   off, brak field/meta/range/scoped requests, ograniczona opacity, jednoznaczny
   stale badge.
4. Nazwać `currentTopologyRenderModel` zgodnie z rzeczywistością albo sprawić, by
   faktycznie zawierał wyłącznie current topology.
5. Zmienić testy staleness i dodać asercje request-level.

### Test regresyjny i kryterium akceptacji

- `stale` może tworzyć tylko ghost/wireframe primitive/topology layer.
- Liczba requestów `data/fields/*`, field meta i range podczas stale wynosi zero.
- Shader, points i vectors są efektywnie off mimo zachowania skonfigurowanych
  wartości w registry.
- Po nadejściu current topology passy wracają bez utraty konfiguracji.

## F3D-003 — `domain_generation_id` nie uczestniczy w zgodności ani invalidation

**Priorytet:** P0 — krytyczny
**Dowód:** S
**Kontrakt:** payload pola może zostać użyty tylko z dokładnie tą generacją domeny,
dla której został obliczony.

### Dowód i mechanizm

- `apps/control-room/src/kernel/api/codecs/types.ts:15-29` oraz
  `fieldVectorCodec.ts:100+` zachowują `domainGenerationId` z FMVP v3.
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts:1800-1822`
  porównuje tylko `meshTopologyHash` i `meshTopologyRevision`; brak tokenu jest
  tolerowany, a generation ID nie jest sprawdzane.
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts:17-39`
  nie przechowuje generation ID, a `buildViewport3DTargetFieldBuffer` w `:54-115`
  nie włącza go do `bufferId`.
- `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts:18-28`
  nie przenosi `DomainMetaResource.generation_id` do modelu FDM.
- Ręczny typ `RealtimeBatchChange` w
  `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts:64-70` nie
  ma `domain_generation_id`, a parser w `:178-202` usuwa ten token mimo że
  `docs/specs/asyncapi/fullmag-live-realtime-v1.json` go publikuje.
- Backend emituje zmianę field samples również przy samej zmianie generacji w
  `crates/fullmag-api/src/main.rs:440-460`. `field_revision` może pozostać wtedy
  bez zmian.
- `ResourceInvalidationController.ts:39-43` ignoruje invalidation z tą samą
  rewizją, więc po zgubieniu generation ID event może nie wymusić refetchu.

### Wpływ

Stary payload o pasującym kształcie, liczbie punktów albo tych samych częściowych
tokenach może zostać użyty po przebudowie domeny. Dla scoped payloadów
`nodeIndices` mogą wtedy wskazywać inne węzły niż w chwili obliczenia. Dodatkowo
sam websocket może nie odświeżyć pola, gdy zmienia się tylko generation ID.

### Przyczyna źródłowa

FMVP v3 i AsyncAPI rozszerzyły provenance, ale render model/target buffer pozostały
na kontrakcie v2, a frontendowy typ websocketu jest ręcznie utrzymywany poza
generowanym HTTP OpenAPI. Zgodność HTTP schema nie wykrywa tego driftu WS.

### Plan naprawy

1. Dodać `domainGenerationId` do FDM/FEM render-domain identity, topology render
   model i `Viewport3DTargetFieldBuffer`.
2. Włączyć generation ID do cache/build/buffer keys.
3. Stworzyć jeden centralny `resolveFieldDomainCompatibility`, używany przez
   scalar, vector, target buffers, FDM i FEM.
4. Dla FMVP v3 wymagać dokładnej zgodności generation ID. Dla v2 zdefiniować
   jawny degraded policy: dodatkowe hash/revision/count checks i warning, nigdy
   ciche uznanie niepełnych tokenów za pełny dowód.
5. Po mismatch odrzucać payload przed utworzeniem attribute/glyph buffers i
   pokazywać reason z oczekiwanym/otrzymanym tokenem.
6. Dodać `domain_generation_id` do frontendowego eventu/parsera, najlepiej przez
   generowanie typów z AsyncAPI albo wspólny schema test zamiast kolejnego ręcznego
   interfejsu.
7. Klucz invalidation dla field samples musi uwzględniać generation ID lub
   wymuszać event order nowszy od poprzedniego nawet przy tej samej field revision.

### Test regresyjny i kryterium akceptacji

- Ten sam hash, revision i point count, ale różne generation ID -> `mismatch`.
- Osobne testy FDM, FEM, full-domain i scoped `nodeIndices`.
- Event z tą samą `field_revision`, ale nowym `domain_generation_id`, wymusza
  refetch i odrzuca poprzedni cache entry.
- Contract test porównuje AsyncAPI payload z parserem frontendowym.
- Browser test zmienia domenę przed nadejściem nowego pola i potwierdza, że stare
  pole nie jest widoczne nawet przez jedną klatkę.
- Diagnostics i audit hook raportują generation ID pola i domeny.

## F3D-004 — asynchroniczny model FDM może zwrócić wynik poprzedniego buildu

**Priorytet:** P0 — krytyczny
**Dowód:** S
**Kontrakt:** wynik buildu jest bieżący tylko wtedy, gdy jego identity odpowiada
bieżącemu requestowi; błąd nie może zostawić starego wyniku jako current.

### Dowód i mechanizm

- `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx:528-588`
  buduje request i publikuje `{ buildKey, request, result }`.
- `:590-591` zwraca `snapshot.result` bez sprawdzenia, czy
  `snapshot.buildKey === buildKey` i czy snapshot request odpowiada bieżącej domenie.
- `:581-583` ignoruje każdy błąd inny niż abort; nie publikuje stanu error i nie
  usuwa poprzedniego wyniku.

### Wpływ

Po zmianie domeny, pola, voxel policy lub parametrów stylu warstwa może przez czas
buildu B wyświetlać model A jako zwykły current model. Jeżeli B zakończy się
błędem, A może pozostać bezterminowo.

### Przyczyna źródłowa

Store przechowuje identity, ale hook ignoruje ją przy odczycie. Brakuje formalnego
stanu `pending/current/stale-compatible/error`.

### Plan naprawy

1. Rozszerzyć snapshot o terminalny status i error.
2. Zwracać result wyłącznie przy dokładnym `buildKey` i identity domeny/topologii.
3. Po zmianie key natychmiast oznaczyć poprzedni rezultat jako stale-compatible
   albo ukryć go zgodnie z polityką; nie przedstawiać go jako current.
4. Obsłużyć non-abort error: wyczyścić current result dla nowego key, zarejestrować
   diagnostic i udostępnić kontrolowany fallback.
5. Włączyć generation ID z `F3D-003` do build key.

### Test regresyjny i kryterium akceptacji

- Opóźniony build A, przejście do B i późne zakończenie A: A nie wraca do sceny.
- Błąd B nie pozostawia A jako current i jest widoczny w HUD/diagnostics.
- Unmount/abort nie publikuje rezultatu.
- Każdy widoczny FDM model raportuje dokładny build key, domain generation i field
  revision użyte do jego utworzenia.
