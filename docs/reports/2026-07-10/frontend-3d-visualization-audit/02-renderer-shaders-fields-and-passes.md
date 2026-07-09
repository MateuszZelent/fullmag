# 02. Renderer, shadery, pola i passy

## F3D-005 — part projection override może zostać skierowany do object targetu

**Priorytet:** P1 — wysoki
**Dowód:** S; dodatkowa reprodukcja R używa niekanonicznego fixture
**Objaw bramki:** `raw_nodal`, `surface_faces` i `thickness_average_z` dają ten
sam obraz, ale gate nie izoluje jeszcze jednej przyczyny produkcyjnej.

### Reprodukcja

Polecenie uruchomione dwukrotnie:

```bash
pnpm --dir apps/control-room screenshot:viewport-3d
```

Obie próby zakończyły się identycznym błędem bramki:

```text
Top/bottom projection fixture did not visually distinguish all projection modes.
raw_nodal->surface_faces=0/8906
surface_faces->thickness_average_z=0/8906
raw_nodal->thickness_average_z=0/8906
```

Fixture prawidłowo patchuje override:

- `apps/control-room/scripts/screenshot-viewport-3d.mjs:1471-1477` —
  `scope_id: "part-film"`, `surface_projection_mode: projectionMode`;
- `:1587-1588` — part ma `geometry_id: "projection-film"`, ale nie ma
  `object_id`.

Fixture ma jednocześnie osobny błąd kontraktu: scena jest pusta
(`screenshot-viewport-3d.mjs:1549`), a entries w `targets.parts` używają
`id` i nie mają wymaganych `scope`, `scope_id` ani pełnego resolved settings
(`screenshot-viewport-3d.mjs:1504-1526`). Obecny frontend ignoruje
`targets.parts` (`F3D-006`), więc runtime failure nadal przechodzi przez poprawny
`overrides[]`, ale przed uznaniem screenshotu za reprezentację live backendu
fixture trzeba zaktualizować do bieżącego OpenAPI. Dowód runtime jest dowodem
awarii bieżącej bramki/ścieżki fixture; nie izoluje samodzielnie `geometry_id` od
`F3D-006`. Dowód naruszenia target contract opiera się na statycznym resolverze
poniżej.

### Mechanizm

- `apps/control-room/src/kernel/selection/selectionTypes.ts:52-59`
  `visualizationObjectIdForMeshPartLike` traktuje `geometry_id` jak object ID.
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts:74-91`
  mapuje taki part na target `object:projection-film`.
- Analogiczny resolver inspektora jest w
  `ObjectVisualizationPanelModel.ts:220-234`.
- Jawny override `part:part-film` nie jest więc targetem konsumowanym przez
  renderer; wszystkie tryby spadają do tej samej wartości bazowej.
- `viewport3DTargets.test.ts:65-77` utrwala mapowanie geometry-only part na object.

### Wpływ

Part override i target konsumowany przez shader mogą mieć różną identity. To jest
błąd semantyczny, nie kosmetyczny: po potwierdzeniu na kanonicznym fixture
użytkownik mógłby sądzić, że ogląda face projection lub thickness average, podczas
gdy renderer czyta object/default settings.

### Plan naprawy

1. Zdefiniować jeden canonical target resolver z wejściami: mesh part, current
   scene object registry oraz backend `targets.objects/parts`.
2. `object_id` ma jednoznacznie prowadzić do `object:*`.
3. Samo `geometry_id` może prowadzić do object targetu tylko wtedy, gdy resolver
   potwierdzi jego mapowanie do istniejącego scene object; w przeciwnym razie
   obowiązuje `part:<part_id>`.
4. Jawny effective `targets.parts` albo part override musi wygrać dla targetu,
   który backend sklasyfikował jako part.
5. Ten sam resolver zastosować w viewport, Inspector, Ribbon i selection.
6. Zaktualizować fixture scene oraz `targets.*` do pełnego current OpenAPI shape
   (`scope`, `scope_id`, `source`, kompletne settings) i dopiero wtedy utrzymać
   screenshot jako production-representative visual gate.
7. Odwrócić test geometry-only oraz dodać przypadek geometry alias, który
   rzeczywiście mapuje się do scene object.

### Test regresyjny i kryterium akceptacji

- Unit: geometry-only part + part override rozwiązuje `kind: "part"`.
- Integration: Inspector, Ribbon i viewport raportują ten sam target id.
- Visual gate: każda para trzech projection modes ma dodatnią i stabilną liczbę
  różniących się pikseli ponad ustalonym progiem.
- Network/state assertion: PATCH target id jest tym samym targetem, który renderer
  umieszcza w diagnostics.

## F3D-006 — frontend ignoruje backendowy effective registry dla object/part

**Priorytet:** P1 — wysoki
**Dowód:** S
**Kontrakt:** backend `visualization/state.targets` jest kompletnym effective
registry; UI nie może niezależnie odtwarzać innej efektywnej konfiguracji.

### Dowód i mechanizm

- Wygenerowany kontrakt opisuje `targets` jako "Complete effective target
  registry" w
  `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts:7334-7335`.
- Registry zawiera `airbox`, `objects` i `parts` (`:7376-7387`) oraz backendowe
  diagnostics (`:7296-7297`).
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:416-463`
  składa object/part z base settings, `state.overrides` i lokalnego override.
- `resolveVisualizationStateTargetOverride` w `:466-569` czyta wyłącznie surowe
  overrides.
- Wyszukiwanie użycia wykazuje konsumpcję tylko `state.targets.airbox.settings`
  w `ObjectVisualizationController.ts:952-988`; brak odpowiednika dla
  `targets.objects` i `targets.parts`.
- Backendowe visualization diagnostics są dostępne w debug registry inspector,
  ale nie są częścią normalnego HUD/target Inspector degraded state.

### Wpływ

Po backendowym clampie, normalizacji, fallbacku capability albo innym scaleniu
frontend może pokazać i wyrenderować ustawienia inne niż effective settings
backendu. Surowy override nie zawiera pełnej informacji o rozstrzygnięciu.

### Plan naprawy

1. Dodać centralny lookup `resolveEffectiveTargetRegistryEntry(state, target)`.
2. Dla object/part/airbox przyjąć `entry.settings` jako bazę effective state.
3. Surowe `overrides` wykorzystywać do configured/override badge i operacji clear,
   nie do ponownego niezależnego symulowania backendowego resolvera.
4. Krótkotrwały optimistic overlay może wygrywać z serwerową bazą tylko jako
   jawnie pending patch związany z konkretną ACK/resource revision; po ACK nie
   może pozostać bezterminowym local override.
5. Regiony, których backend registry nie publikuje, rozwiązywać lokalnie w
   jawnie oddzielonej ścieżce na bazie owner object + region override.
6. Propagować `visualization/state.diagnostics` do target Inspector i viewport HUD
   z kodem, reason i target id.
7. Włączyć source/effective registry revision do target diagnostics.

### Test regresyjny i kryterium akceptacji

- Jeżeli `targets.objects[].settings` różni się od global+override, w viewport,
  Ribbon i Inspector wygrywa registry entry.
- Analogiczny test dla part i airbox.
- Backend warning/degraded reason jest widoczny w Inspectorze i HUD.
- Brak trzech niezależnych implementacji scalania target state.

## F3D-007 — diagnostics nie łączą payload i requested revision podczas sync

**Priorytet:** P3 — niski
**Dowód:** S
**Kontrakt:** stale-while-revalidate może zachować obraz, lecz UI i diagnostics
muszą zachować informację, że widoczny payload jest starszy.

### Dowód i mechanizm

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1425-1440`
  normalizuje `status === "stale"` na `"ready"` w resource-frame key, jeżeli
  istnieje displayable data. Ten helper zasila wewnętrzne klucze/frame diagnostics
  w `:3530+`, nie główny user-facing refresh status.
- Główny `fieldRefresh` w `useViewport3DSceneModel.ts:3233-3248` zachowuje surowy
  `fieldVector.status`, a `Viewport3DFieldRefreshCountdown` pokazuje `syncing` dla
  stale/loading. Problem nie ukrywa więc staleness we wszystkich powierzchniach UI.

### Wpływ

HUD sygnalizuje synchronizację, ale compact diagnostics nie pokazuje jednocześnie
`payloadRevision` i `requestedRevision`. To utrudnia ustalenie, którą rewizję
użytkownik faktycznie ogląda podczas sync; nie jest to utrata całego komunikatu UI.

### Plan naprawy

1. Oddzielić w frame diagnostics `displayable` od `freshness` bez zmiany stabilnego
   render key, jeśli normalizacja jest potrzebna do uniknięcia churnu.
2. Przechowywać `payloadRevision`, `requestedRevision` i przyczynę hold/refetch.
3. Dla zgodnego stale payloadu pozwolić na render; zachować istniejący syncing HUD
   i dodać compact diagnostic `field syncing rX -> rY`.
4. Dla niezgodnego payloadu użyć centralnej polityki z `F3D-003` i go odrzucić.
5. Ujednolicić status w HUD, Inspector i audit hook.

### Test regresyjny i kryterium akceptacji

- Frame diagnostics rozróżnia displayable stale payload od current payload bez
  generowania zbędnego renderer churn.
- Renderer może użyć payloadu tylko przy `compatibility=exact`.
- HUD pokazuje obie rewizje aż do potwierdzonego current payloadu.
- Po refetch status przechodzi do `ready` bez migotania albo utraty konfiguracji.

## F3D-008 — FDM nie realizuje niezależnych passów `vectors` i `points`

**Priorytet:** P1 — wysoki
**Dowód:** S
**Kontrakt:** każdy target może niezależnie włączać surface, wireframe, points i
vectors; Inspector nie może oferować passu, którego renderer nie realizuje.

### Dowód i mechanizm

- `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx:891-897`
  zwraca `null`, jeżeli wyłączone są surface i wireframe, bez względu na vectors.
- `:956-967` ma `VectorFieldLayer`, ale nie jest osiągalne w trybie vectors-only
  z powodu wcześniejszego return.
- `pointsVisible` nie uczestniczy w warunku i plik nie renderuje point geometry.
- `useViewport3DSceneModel.ts:2972+` może zbudować model dla wektorów, więc koszt
  pracy występuje mimo pustego viewportu.

### Wpływ

Inspector/Ribbon pokazuje aktywny vectors-only lub points-only pass, a viewport
jest pusty. To narusza wspólny target registry i zasadę independent passes.

### Plan naprawy

1. Zdefiniować `hasAnyEffectiveFdmPass` obejmujące surface, wireframe, points,
   vectors i ewentualny bounds/frame.
2. Nie uzależniać group lifetime od passów powierzchniowych.
3. Dodać bounded point geometry centrów komórek, respektującą geometry scope,
   sampling budget, opacity i point color.
4. Renderować VectorFieldLayer samodzielnie, z właściwym picking/inspect policy.
5. Nie budować cuboid surface instances, kiedy żaden pass ich nie potrzebuje.

### Test regresyjny i kryterium akceptacji

- Macierz FDM: każdy pojedynczy pass oraz sensowne kombinacje 2-pass/4-pass.
- Vectors-only i points-only dają niepusty canvas i zero niepotrzebnych surface
  draw calls.
- Wyłączenie wszystkich passów daje pustą warstwę i brak jobów.
- Inspector, Ribbon i renderer raportują identyczny effective state.
