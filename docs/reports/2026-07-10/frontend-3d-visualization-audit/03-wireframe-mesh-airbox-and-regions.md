# 03. Wireframe, mesh, airbox i regiony

## Stan reaudytu 2026-07-14

F3D-009–F3D-012 pozostają **naprawione w swoim pierwotnym zakresie**. Obecne
działanie points/wireframe dla airboxa nie jest dowodem działania surface ani
vectors dla airboxa i obiektów magnetycznych; awaria tych passów ma osobny
finding F3D-029. Rozdzielenie kanonicznego `airbox` od transportowego carriera
`part:__air__` oraz ogólny kontrakt adresowalności renderer ↔ Explorer opisuje
F3D-032.

## F3D-009 — region dziedziczy master visibility i aktywne passy obiektu

**Priorytet:** P1 — wysoki
**Dowód:** T + S
**Kontrakt:** region jest ukryty domyślnie. Z owner object może dziedziczyć
quantity, palette i style, ale nie `visible` ani aktywne passy.

### Dowód i mechanizm

- Specyfikacja `docs/specs/frontend-v2/23-per-object-visualization-control.md:40-45`
  wymaga wyłączonych region surface/wireframe/points/vectors/primitive/master.
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:396-407`
  ma bezpieczny `DEFAULT_REGION_VISUALIZATION`, ale nakłada na niego całe
  `baseSettings`.
- `resolveTargetVisualization` w `:436-445` przekazuje dla regionu kompletne
  `inheritedSettings` owner object, które wygrywają z region defaults.
- `ObjectVisualizationController.test.ts:91-130` wymaga obecnie, aby quantity-only
  region odziedziczył `visible=true`, shader i wireframe.
- `ribbonStructure.test.ts:1018-1059` oczekuje aktywnego region wireframe bez
  jawnego regionowego display override.

### Wpływ

Ustawienie jedynie quantity/style może odziedziczyć aktywne passy i uruchomić
renderowanie regionu. Sam wybór w Explorerze nie mutuje visibility. Diagnostyczny
overlay i fizyczny region field target stają się wizualnie mylące, a region
przestaje być opt-in subdomain override.

### Plan naprawy

1. Stworzyć `resolveRegionInheritedBaseline(ownerSettings)`, który kopiuje tylko
   `activeQuantityId`, palette, color modes i uzgodnione style.
2. Zostawić `visible`, shader, wireframe, points, vectors, bounds i primitive z
   `DEFAULT_REGION_VISUALIZATION`, dopóki region override jawnie ich nie ustawi.
3. Użyć skorygowanych effective settings jako jedynego gate w viewport field
   demand/render oraz w Inspectorze i Ribbonie. Osobny picking predykat nie jest
   potrzebny, jeżeli wszystkie call-site'y korzystają z tego samego resolvera.
4. Odwrócić testy, które utrwalają dziedziczenie aktywnych passów.

### Test regresyjny i kryterium akceptacji

- Brak override, quantity-only i style-only: region pozostaje niewidoczny.
- `visible:true` bez passu nie uruchamia domyślnie niezamówionych passów, chyba że
  kontrakt jawnie definiuje jeden default surface pass.
- Jawne enable/disable działa niezależnie od owner object.
- Obiekt może pokazywać `mx`, region HSL tylko po explicit enable i tylko na
  manifestowym carrierze.

## F3D-010 — airbox style jest częściowo ulotny, a Reset nie czyści override

**Priorytet:** P1 — wysoki
**Dowód:** S
**Kontrakt:** wszystkie backend-supported airbox settings muszą round-tripować, a
Reset przywraca defaults w `layers.airbox` i usuwa airbox target override.

### Dowód i mechanizm

- Backend `VisualizationTargetStyleOverride` wspiera między innymi
  `surface_mono_color`, `point_color`, `vector_color_mode`, `vector_mono_color`,
  `vector_alpha`, `vector_budget`, `vector_length_scale`, `vector_thickness` i
  `wireframe_color` w
  `crates/fullmag-api/src/schemas/visualization_state.rs:848-876`.
- `AirboxLayerPatch` wspiera opacity poszczególnych basic layers przez
  `BasicLayerPatch.opacity` (`visualization_state.rs:249-254,298-313`).
- Frontendowy `airboxVisualizationStatePatchFromTargetPatch` w
  `ObjectVisualizationController.ts:1047-1161` serializuje ograniczony podzbiór
  style. Nie zapisuje między innymi point/surface/vector/wireframe colors,
  vector alpha ani wireframe opacity.
- `airboxLocalVisualizationPatchFromTargetPatch` w `:1164-1225` zachowuje te
  wartości wyłącznie lokalnie.
- Inspector patch przekazuje current overrides (`ObjectVisualizationPanel.tsx:1296-1313`),
  ale Reset w `:1347-1353` wywołuje helper bez current overrides.
- Ribbon Reset robi to samo w `ribbonCommands.ts:320-330`. Istniejący wpis
  `scope=airbox` pozostaje i po refetch ponownie nadpisuje default.

### Wpływ

Kolor, vector alpha albo wireframe opacity airboxu może zniknąć po reloadzie lub
różnić się między klientami. Główne `layers.airbox.opacity` jest serializowane;
problem dotyczy wymienionych pól pomijanych przez helper. Reset może wyglądać na
wykonany lokalnie, po czym stare ustawienie wraca z backendu.

### Plan naprawy

1. Utworzyć jedną kompletną mapę `VisualizationTargetPatch -> VisualizationStatePatch`
   zgodną z backendowym schema; nie utrzymywać dwóch ręcznych list pól.
2. Zapisać style do `scope=airbox` override, a layer opacity do odpowiedniego
   `layers.airbox.*.opacity`.
3. Lokalnie zostawić wyłącznie pola nieobecne w publicznym kontrakcie, np. jawny
   dev-only synthetic vector toggle.
4. Dodać dedykowane `resetAirboxVisualizationState(currentState)`, które przywraca
   defaults w layers i usuwa airbox override atomowo w jednym PATCH.
5. Użyć tej samej operacji w Inspectorze, Ribbonie i command registry.

### Test regresyjny i kryterium akceptacji

- Round-trip każdej wspieranej airbox właściwości po refetch i pełnym reloadzie.
- Dwa klienty widzą tę samą effective wartość.
- Reset przy istniejącym quantity/style override usuwa wpis i przywraca defaults.
- `targets.airbox.settings` po ACK odpowiada viewportowi i obu powierzchniom UI.

## F3D-011 — freshness uznaje `object_segments`, ale FEM adapter ich nie konsumuje

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** jeden model freshness i jeden adapter muszą zgadzać się, jakie
manifestowe nośniki stanowią pokrycie sceny.

### Dowód i mechanizm

- `visualizationDisplayResolution.ts:151-186` uznaje object IDs zarówno z
  `manifest.object_segments`, jak i `manifest.mesh_parts` za pokrycie sceny.
- `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts:102-147`
  buduje FEM render domain wyłącznie z `mesh_parts`; `object_segments` nie są
  konsumowane.
- OpenAPI dopuszcza oba zbiory w manifest resource, ale sama obecność kolekcji nie
  dowodzi, że `object_segments` jest legalnym render carrierem.

### Wpływ

Jeżeli backend może legalnie wyemitować manifest segment-only lub częściowo
segmentowy, taki manifest może zostać oznaczony jako current, ale utracić
per-object render, picking, target mapping i scoped field routing. Jeżeli taki
manifest jest nielegalny, błąd leży w zbyt szerokiej regule freshness. To jest
luka kontraktu wymagająca rozstrzygnięcia, nie dowód, że segment jest carrierem.

### Plan naprawy

Są dwie legalne strategie; decyzja musi być jawna w kontrakcie:

1. **Normalizacja frontendowa:** przekształcić segment w jawny fallback carrier z
   ograniczonymi capabilities i degraded reason; albo
2. **Zaostrzenie backendu:** wymagać, aby każdy renderowalny object segment miał
   odpowiadający `mesh_part`, a segment-only manifest nie może być `current` dla
   renderera.

Po wyborze należy użyć tej samej funkcji `manifestRenderableCarriers` w freshness,
adapterze, Inspectorze i target registry.

### Test regresyjny i kryterium akceptacji

- Manifest tylko z object_segments ma deterministyczny wynik: renderowalny
  degraded fallback albo jawne unavailable, nigdy `current` + pusty renderer.
- Test mixed segments/parts sprawdza deduplikację i target ownership.
- Diagnostics podaje rodzaj carriera i ograniczone capabilities.

## F3D-012 — sekcja „Object surfaces” mutuje targety niezwiązane z Inspektorem

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** Inspector wybranego targetu nie powinien wykonywać ukrytych zmian na
innym object/part target id.

### Dowód i mechanizm

- `ObjectVisualizationPanel.tsx:1453-1476` buduje listę ze wszystkich magnetycznych
  części manifestu, bez filtrowania do bieżącego targetu.
- Sekcja jest przekazywana również dla regionu i airboxu.
- `onTogglePartVectors` w `:1508-1518` rozwiązuje target klikniętego partu i
  patchuje go, nawet gdy panel reprezentuje inny region/airbox/object.

### Wpływ

Użytkownik może z Inspektora airboxu lub regionu wyłączyć/wejść w ustawienia
wektorów innego obiektu. Zmiana nie odpowiada mentalnemu scope panelu i jest
trudna do odtworzenia z historii targetu.

### Plan naprawy

1. Zdecydować, czy macierz jest globalnym narzędziem zarządzania targetami, czy
   częścią selected-target Inspector.
2. Jeżeli selected-target: filtrować do carrierów bieżącego targetu i nie
   zezwalać na zapis innego target id.
3. Jeżeli globalna: przenieść do osobnego View/Visualization Registry panelu z
   jawnymi target badges i nagłówkiem zakresu.
4. Dla regionu używać wyłącznie manifestowych `mesh_part_ids`; dla airboxu tylko
   air parts.

### Test regresyjny i kryterium akceptacji

- Scena z dwoma obiektami: Inspector A nie może wygenerować PATCH dla B.
- Osobne testy regionu, part fallback i airboxu.
- Każdy wiersz pokazuje canonical target id, który zostanie zapisany.

## Potwierdzone poprawne zachowania wireframe/regionów

- `geometryScope: "surface"` może renderować tylko krawędzie powierzchni.
- Pełny airbox renderuje proceduralny volume/bounds overlay także wtedy, gdy
  istnieje backendowa edge geometry; nie zapada się wizualnie do surface-only.
- Airbox wireframe opacity nie jest mnożona przez surface opacity.
- FEM surface, wireframe, points i vectors są osobnymi passami.
- Region carrier preferuje `manifest.regions[*].mesh_part_ids`; projection
  membership jest diagnostyczny i nie udaje conformal field carrier.
- Hidden region picking korzysta obecnie z `getRegionSettings`; historyczny problem
  pickowania niewidocznych regionów został naprawiony.
