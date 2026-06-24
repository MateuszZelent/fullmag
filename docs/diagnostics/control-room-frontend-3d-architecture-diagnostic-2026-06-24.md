# Control Room frontend 3D architecture diagnostic

Data: 2026-06-24

Zakres: `apps/control-room`, szczegolnie viewport 3D, per-object/per-region/airbox controls, vector budget, resource hooks, data-plane, module/kernel lifecycle oraz bramki architektoniczne.

## Werdykt

Frontend v2 ma solidne elementy bazowe: jeden aktywny `viewport-main` jest realnie montowany, 3D canvas pracuje w `frameloop="demand"`, obiekty i airbox maja dzialajaca sciezke override'ow, a vector-only payloady potrafia isc przez scoped field-vector API z `max_samples`.

Nie jest jednak architektonicznie czysty. Najwazniejsze problemy to:

1. kernel importuje wewnetrzny modul `viewport-3d`, przez co `check:architecture-hygiene` nie przechodzi;
2. mieszane widoki scalar+vector potrafia rozszerzac fetch pola do full-domain i dopiero potem probkowac/wycinac wektory po stronie klienta;
3. globalny vector budget i vector length sa rozdzielone miedzy globalny stan renderowania i target settings, przez co inspector/ribbon moze pokazywac inna semantyke niz renderer;
4. airbox ma dwie sciezki zapisu: inspector zapisuje length/thickness jako target override, ribbon zapisuje je globalnie;
5. target `region` istnieje i jest czesciowo stosowany, ale nie wszystkie komendy i warstwy interakcji go respektuja.

## Material dowodowy

Kontrakty:

- `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- `docs/specs/frontend-v2/02-module-catalog.md`
- `docs/specs/frontend-v2/05-viewport-architecture.md`
- `docs/specs/frontend-v2/14-viewport-3d-module.md`
- `docs/specs/frontend-v2/17-performance-memory-profiler.md`
- `docs/specs/frontend-v2/23-per-object-visualization-control.md`
- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/adr/0011-resource-first-api.md`
- `docs/adr/0013-frontend-v2-module-kernel.md`

Implementacja:

- `apps/control-room/src/kernel/KernelProvider.tsx`
- `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts`
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DFieldRenderOptions.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts`
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`

Uzyto rowniez trzech subagentow eksploracyjnych:

- data-plane/vector budget;
- module/kernel lifecycle;
- target semantics dla object/region/airbox.

## Bramki i wyniki

`pnpm --dir apps/control-room check:architecture-hygiene` nie przechodzi:

```text
Architecture hygiene check failed:
src/kernel/KernelProvider.tsx imports module internals through "@/modules/viewport-3d/viewport3dResourceLifecycle".
src/modules/inspector/panels/region/ObjectRegionDiagnosticsPanel.tsx contains raw hex colors outside design tokens: #eee.
src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.tsx contains raw hex colors outside design tokens: #ccc.
src/modules/viewport-3d/layers/HysteresisReplayGlyphLayer.tsx contains raw hex colors outside design tokens: #ffcc66, #7dd3fc, #c4b5fd.
```

`pnpm --dir apps/control-room check:api-hygiene` nie przechodzi:

```text
API hygiene check failed: hand-built v2 endpoint strings outside API/generated
src/kernel/performance/diagnostic-recorder/diagnosticSuspectReport.test.ts:          path: "/v2/sessions/current/data/field-vector/m",
src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.test.ts:      path: "/v2/sessions/current/data/field-vector/m?component=full",
src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.test.ts:      resourceKey: "/v2/sessions/current/data/field-vector/m?component=full",
src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.test.ts:        path: "/v2/sessions/current/data/field-vector/m",
src/kernel/performance/diagnostic-recorder/DiagnosticRecorderController.test.ts:        resourceKey: "/v2/sessions/current/data/field-vector/m?component=full",
src/kernel/performance/diagnostic-recorder/diagnosticRecorderTypes.test.ts:      path: "/v2/sessions/current/data/fields/m/samples/vector",
```

`pnpm --dir apps/control-room test -- src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/viewport-3d/hooks/useViewport3DFieldRenderOptions.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/viewport3dResourceLifecycle.test.ts src/modules/viewport-3d/layers/regionOverlayModel.test.ts` przechodzi. Vitest uruchomil wszystkie 288 plikow testowych:

```text
Test Files 288 passed (288)
Tests 2322 passed (2322)
```

`pnpm --dir apps/control-room audit:idle-performance` przechodzi:

```text
Idle performance audit passed.
```

Uwaga: drzewo robocze bylo brudne przed utworzeniem tego raportu. Wyniki bramek opisuja stan aktualnego drzewa, nie regresje wprowadzone przez ten dokument.

## Priorytety

| ID | Priorytet | Obszar | Stan |
|---|---:|---|---|
| F3D-001 | P1 | module/kernel boundary | realny blad architektury, bramka czerwona |
| F3D-002 | P1 | field data-plane/vector budget | realny blad semantyki resource-first |
| F3D-003 | P2 | airbox scoped data-plane | realny blad dla multi-airbox / przyszlych siatek |
| F3D-004 | P2 | global vector budget | niespojny zapis/odczyt semantyki |
| F3D-005 | P2 | airbox ribbon controls | split persistence model |
| F3D-006 | P2 | region target commands | region quantity path odrzuca `region` |
| F3D-007 | P2 | region picking | ukryty region moze nadal przechwytywac klik |
| F3D-008 | P2 | viewport code ownership | za duze komponenty/hooki, ryzyko lifecycle |
| F3D-009 | P3 | design tokens | raw hex blokuje hygiene gate |
| F3D-010 | P3 | API hygiene tests | reczne `/v2` strings w testach diagnostycznych |
| F3D-011 | P3 | UX wording | "per-part" UI zapisuje object target |

## F3D-001: kernel importuje wewnetrzne API `viewport-3d`

Priorytet: P1

Kontrakt: `01-module-kernel-architecture.md` i `02-module-catalog.md` mowia, ze kernel moze znac registry modulow, ale nie wewnetrzne pliki modulow. Kernel ma zarzadzac slotami, resource invalidation i lifecycle przez stabilne interfejsy, nie przez import konkretnego modulu.

Dowody:

- `apps/control-room/src/kernel/KernelProvider.tsx:60-63` importuje `createViewport3DInactiveResourcePauseController` z `@/modules/viewport-3d/viewport3dResourceLifecycle`.
- `apps/control-room/src/kernel/KernelProvider.tsx:456-484` montuje `Viewport3DResourceLifecycleConnector` wewnatrz providera kernela.
- `apps/control-room/scripts/check-architecture-hygiene.mjs:24-48` dopuszcza tylko `@/modules` w `KernelProvider.tsx`; kazdy glebszy import `@/modules/...` jest naruszeniem.
- `pnpm --dir apps/control-room check:architecture-hygiene` potwierdza blad.

Co dziala:

- `apps/control-room/src/modules/viewport-3d/viewport3dResourceLifecycle.ts:48-82` faktycznie pauzuje 3D-exclusive resources kiedy aktywny `viewport-main` nie jest `viewport-3d`.
- `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts:189-230` poprawnie abortuje/pauzuje matching resources i nie startuje nowych loadow, gdy predicate jest aktywny.

Problem:

To jest funkcjonalnie sensowna polityka, ale jest w zlej warstwie. Kernel zalezy od detali modulu, a modul zalezy od kernela. To tworzy cykl pojeciowy: kernel nie jest juz neutralnym hostem modulow, tylko zna viewport-3d jako szczegolny przypadek.

Skutek dla uzytkownika:

- bramka architektoniczna jest czerwona;
- wylaczenie, wymiana lub refactor `viewport-3d` moze zostawic kernel z martwym importem;
- kolejne moduly moga zaczac kopiowac ten wzorzec i dodawac module-specific lifecycle do kernela.

Naprawa:

1. Przeniesc predicate i controller do kernela, np. `src/kernel/resources/inactiveViewportResourcePolicy.ts`, jezeli polityka jest shell-level.
2. Alternatywnie dodac deklaratywne pole w manifestach modulow, np. `resourcePausePolicy`, i niech kernel czyta je przez registry, nie przez import pliku modulu.
3. Przeniesc testy z `viewport3dResourceLifecycle.test.ts` albo dodac test kernela, ktory sprawdza: aktywny tab != `viewport-3d` pauzuje resource keys zadeklarowane przez policy.

Weryfikacja po naprawie:

- `pnpm --dir apps/control-room check:architecture-hygiene`
- focused test lifecycle/pause policy
- smoke tab-switch: `viewport-3d -> cross-section-image -> viewport-3d`

## F3D-002: mixed scalar+vector views omijaja scoped vector budget

Priorytet: P1

Kontrakt: `docs/specs/resource-first-control-room-api-v2.md:261-302` wymaga scoped fetching. Szczegolnie `:263-264` mowi, ze frontend nie powinien sciagac full shared-domain mesh/field arrays dla isolation workflows, a `:301-302` zakazuje pobierania full-domain data tylko po to, by filtrowac duze FEM payloady klientem.

Co dziala:

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:317-339` buduje stabilny resource key z `component`, `max_samples`, `scope_id`, `scope_kind`, snapshot i stage.
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:420-451` buduje part requests z `scope_kind: "part"` i `scope_id: partId`.
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1160-1216` buduje scoped part vector requests z `max_samples` z targetowego `vectorBudget`.
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts:1420-1478` ma test, ze vector-only magnetic part idzie scoped i primary data options nie wymagaja full field data.
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts:1499-1520` testuje cap `max_samples` do interactive glyph budget.

Blad:

Sciezka scoped part request jest pomijana, gdy target ma rownoczesnie shader/scalar color:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1192-1197` wylicza `surfaceColorMode`; jezeli istnieje, `resolveViewport3DScopedPartVectorFieldRequests` robi `continue`.
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:852-887` w `resolveViewport3DPrimaryFieldQuery` zwraca `FULL_FIELD_QUERY`, gdy `viewport3DFieldRenderOptionsNeedFullVectorData(...)` jest prawdziwe albo gdy kolorowanie wymaga pelnego wektora.
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts:636-687` potem iteruje po czesciach i wybiera/sampluje part vectors po stronie render modelu.

To oznacza, ze dla trybu "powierzchnia kolorowana + wektory" per-object vector budget ogranicza glyph generation, ale niekoniecznie ogranicza payload pobierany z API. Dla duzego FEM moze to oznaczac pobranie szerokiego/full-domain pola mimo malego budzetu strzalek na obiekcie.

Backend ma potrzebna infrastrukture:

- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:938-990` rozpoznaje `scope_kind`.
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:1466-1474` rozwiazuje scope i `max_samples`.

Skutek dla uzytkownika:

- przy wlaczonych kolorach i wektorach mozna przekroczyc intencje `vectorBudget`;
- duze FEM payloady moga generowac latency/memory pressure mimo pozornie malego budzetu wektorow;
- UI moze dawac falszywe poczucie kontroli, bo slider "Arrow budget" ogranicza rendering, ale nie zawsze data-plane.

Naprawa:

1. Rozdzielic scalar-color payload od vector payload dla targetow.
2. Dla wektorow zawsze preferowac `scope_kind=object|part|airbox` z `max_samples`, gdy wektory targetu sa jedyna potrzeba wektorowa.
3. Jezeli scalar color wymaga pelnego pola, traktowac to jako osobne zapotrzebowanie i nie mieszac go z vector budget.
4. Dodac test: target z `shaderVisible=true`, `surfaceColorSource=magnitude`, `vectorsVisible=true`, `vectorBudget=512` nie powinien powodowac vector-only full-domain fetch dla wektorow; jezeli scalar wymaga full data, resource keys powinny byc dwa i jawnie rozdzielone.

Weryfikacja:

- focused tests w `useViewport3DSceneModel.test.ts`
- network/assert resource key audit: brak nieuzasadnionego `component=full&scope_kind=full` dla per-object vector-only payloadu
- memory churn audit dla duzej FEM sceny

## F3D-003: explicit airbox part scope jest ignorowany

Priorytet: P2

Kontrakt: `docs/specs/resource-first-control-room-api-v2.md:290-299` definiuje:

- `scope_kind=airbox` jako pierwszy airbox mesh part;
- `scope_kind=airbox&scope_id=<part_id>` jako explicit airbox part.

Dowody frontend:

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:341-350` wymusza `scope_kind: "airbox"` i usuwa `scope_id`.
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts:357-371` mapuje wszystkie airbox parts na ten sam query/key.

Dowody backend:

- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:970-981` przy `scope_kind == "airbox"` wybiera pierwszy mesh part z `role == "air"` i ignoruje `query.scope_id`.

Skutek:

Jezeli mesh bedzie mial wiecej niz jeden airbox part, frontend nie potrafi poprosic o konkretny part, a backend i tak wybierze pierwszy airbox. Wtedy kilka airbox layerow moze renderowac dane z nie tego zakresu.

Niepewnosc:

Nie znalazlem gwarancji, ze produkcyjny shared-domain mesh zawsze ma dokladnie jeden airbox part. Jesli taka gwarancja istnieje, ryzyko jest nizsze, ale kontrakt API nadal obiecuje explicit airbox scope.

Naprawa:

1. Nie usuwac `scope_id` w `resolveViewport3DAirboxFieldVectorQuery`, gdy caller przekazuje explicit airbox part.
2. Budowac per-airbox-part keys z `scope_id=part.id`.
3. Backend: dla `scope_kind=airbox` uzyc `scope_id`, jesli podany; fallback do pierwszego air part tylko gdy `scope_id` jest puste.
4. Dodac testy frontend+backend dla dwoch airbox partow.

## F3D-004: global vector budget jest zapisywany, ale frontend nie czyta go jako object default

Priorytet: P2

Dowody:

- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:3042-3056` slider "Vector glyph budget" zapisuje `layers.vectors.density`, `sampling.max_glyphs` i `vector_density`.
- `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs:1757-1775` backend target settings mapuje `layers.vectors.density` na `vector_budget`, a `vector_style.length_scale` na `vector_length_scale`.
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:805-870` `resolveGlobalObjectVisualizationSettings` czyta `layers.surface`, `layers.wireframe`, `layers.points`, `layers.vectors.visible`, `vector_style.color_mode`, `mono_color`, `alpha`, `thickness`, ale nie czyta `layers.vectors.density` jako `vectorBudget` i nie czyta `vector_style.length_scale` jako `vectorLengthScale`.
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts:1516-1525` global density jest uzywany oddzielnie jako globalny cap `max_glyphs`.

Skutek:

Ten sam globalny slider ma dwie semantyki:

- backend traktuje go jak target settings default (`vector_budget`);
- renderer frontendu traktuje go jak globalny cap;
- inspector/object resolver moze dalej pokazywac default `vectorBudget=1200`, bo nie czyta `layers.vectors.density`.

To nie zawsze psuje rendering, ale psuje model mentalny. Uzytkownik moze zmienic globalny budget i nie zobaczyc tej wartosci jako efektywnego budgetu targetu.

Naprawa do wyboru:

1. Jesli globalny slider ma byc defaultem object targetow: `resolveGlobalObjectVisualizationSettings` musi czytac `state.layers.vectors.density` do `vectorBudget` oraz `state.vector_style.length_scale` do `vectorLengthScale`.
2. Jesli globalny slider ma byc tylko globalnym capem wydajnosci: zmienic etykiete i nie mieszac go z `layers.vectors.density` jako target default. Per-target budgets powinny zostac w `overrides[].style.vector_budget`.

Weryfikacja:

- test `resolveGlobalObjectVisualizationSettings` dla `layers.vectors.density=512` i `vector_style.length_scale=2`;
- test ribbon/inspector, ze wyswietlana wartosc i render budget sa zgodne z wybrana semantyka.

## F3D-005: Airbox ribbon zapisuje length/thickness globalnie, nie jako airbox target override

Priorytet: P2

Kontrakt: `docs/specs/frontend-v2/23-per-object-visualization-control.md:31-35` mowi, ze airbox arrow budget jest w `layers.airbox.vectors.density`, ale airbox arrow length i vector thickness maja byc persisted jako `airbox` target override style (`vector_length_scale`, `vector_thickness`), nie globalne `vector_style`.

Co dziala:

- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:969-1075` helper `airboxVisualizationStatePatchFromTargetPatch` zapisuje `vectorBudget` do `layers.airbox.vectors.density` oraz `vectorLengthScale`/`vectorThickness` do `overrides` targetu airbox.
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx:1022-1048` inspector airbox uzywa tego helpera.

Blad:

- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:3636-3647` airbox length slider zapisuje `vector_style.length_scale`.
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:3650-3661` airbox thickness slider zapisuje `vector_style.thickness`.

Skutek:

Zmiana z airbox ribbonu moze przeciekac do globalnego/magnetic vector style. Inspector i ribbon moga tez miec rozne persistence semantics dla tego samego widocznego targetu.

Naprawa:

1. Airbox ribbon powinien uzywac tej samej sciezki co inspector: `airboxVisualizationStatePatchFromTargetPatch`.
2. Dla length/thickness command powinien tworzyc/merge'owac `scope: "airbox", scope_id: "airbox"` override.
3. Dodac test: ribbon airbox length/thickness patch generuje `overrides[]`, nie `vector_style`.

## F3D-006: selected region quantity path odrzuca target `region`

Priorytet: P2

Dowody:

- `apps/control-room/src/kernel/selection/selectionTypes.ts:31-39` wspiera target id `region:<object_id>:<region_id>`.
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts:1144-1156` rozpoznaje selected scene-object region jako `kind: "region"`.
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:3948-3967` selected target "Quantity source" uzywa `RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND` i przekazuje aktualny target.
- `apps/control-room/src/modules/ribbon/ribbonCommands.ts:607-610` `isVisualizationTargetKind` akceptuje tylko `"airbox" | "object" | "part"`.

Skutek:

Dla wybranego regionu czesc kontrolki dziala, a czesc nie:

- checkboxy oparte o `visualization.target.*` ida przez `resolveVisualizationTargetFromSelection` i moga patchowac region;
- explicit `ribbon.visualization.patch-target` odrzuca ten sam `region` target.

Uzytkownik zobaczy niespojny ribbon: wireframe/surface toggle moze dzialac, ale zmiana quantity dla regionu moze sie nie wykonac.

Naprawa:

1. Rozszerzyc `isVisualizationTargetKind` o `"region"`.
2. Dodac test w `ribbonStructure.test.ts` albo `ribbonCommands.test.ts`, ze selected region quantity patch zapisuje `scope: "region"`.
3. Upewnic sie, ze default/global patch command nie zaczyna przypadkiem traktowac regionow jako globalnych defaults.

## F3D-007: authored region picking ignoruje target visibility

Priorytet: P2

Co dziala:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1961-1985` buduje `getRegionSettings` z object inheritance i region override.
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx:1004-1011` `RegionOverlayLayer` dostaje `getRegionSettings`.
- `apps/control-room/src/modules/viewport-3d/layers/RegionOverlayLayer.tsx:45-63` przekazuje `resolveSettings` do `buildRegionOverlayModels`.
- `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts:174-213` style regionu respektuje `settings.visible`, `shaderVisible`, `wireframeVisible`, opacity i kolory.
- `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.test.ts:296-386` testuje, ze per-region settings wplywaja na overlay i ze `visible: false` usuwa model.

Blad:

- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx:916-922` montuje `RegionOverlayNativePickingLayer` dla authored overlays.
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx:1032-1050` `RegionOverlayNativePickingLayer` buduje `buildRegionOverlayModels(regions, { selectedObjectId, selectedRegionId })` bez `getRegionSettings`.

Skutek:

Warstwa wizualna moze nie renderowac regionu ukrytego przez target override, ale natywna warstwa pickingu moze nadal zbudowac model pickingu dla tego regionu. Uzytkownik moze kliknac "niewidoczny" region i zmienic selection.

Naprawa:

1. Dodac `getRegionSettings` do `RegionOverlayNativePickingLayer`.
2. Uzyc tego samego `buildRegionOverlayModels(..., { resolveSettings })`, co warstwa renderujaca.
3. Dodac test, ze `visible:false` region nie tylko nie renderuje, ale tez nie jest pickowalny.

## F3D-008: `viewport-3d` ma za duze mixed-responsibility pliki

Priorytet: P2

Dowody z `wc -l`:

```text
1238 apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx
1411 apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx
2457 apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts
2913 apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts
4280 apps/control-room/src/modules/ribbon/ribbonContributions.tsx
```

Dlaczego to jest problem:

- `Viewport3DModule.tsx` laczy SSR/client gate, resource tracker, camera sync, selection handlers, field refresh UI, R3F canvas, HUD, dialogs, inspect tooltip, debug controls.
- `useViewport3DSceneModel.ts` laczy domain adaptation, topology freshness, region overlays, visualization target resolution, airbox state, field fetches, FDM build jobs, scalar colors, vector payloads i final props.
- `viewport3dRenderModel.ts` laczy topology model, scalar color buffers, vector segment caches, memory-budget accounting i glyph budget distribution.

To zwieksza koszt review i ryzyko ukrytych regresji lifecycle. Nie jest to samo w sobie blad runtime, ale jest to architektoniczny risk multiplier dla dokladnie tych obszarow, ktore sa najbardziej wrazliwe: WebGL cleanup, field data-plane, per-target overrides i idle rendering.

Naprawa bez zmiany zachowania:

1. Wydzielic z `Viewport3DModule.tsx`:
   - `Viewport3DCanvasSurface`
   - `Viewport3DHud`
   - `Viewport3DDialogs`
   - `useViewport3DCameraPersistence`
   - `useViewport3DInspectHover`
2. Wydzielic z `useViewport3DSceneModel.ts`:
   - `useViewport3DVisualizationTargets`
   - `useViewport3DFieldDataPlane`
   - `useViewport3DRegionOverlayState`
   - `useViewport3DFdmBuildModel`
3. Wydzielic z `viewport3dRenderModel.ts` backend-neutral helpery vector budgets i cache stats do osobnych plikow, bez zmiany publicznego API.

Warunek: najpierw testy charakterystyki, potem split. Ten refactor nie powinien zmieniac endpointow, resource keys ani render output.

## F3D-009: raw hex tokens blokuja hygiene gate

Priorytet: P3

Dowody z `check:architecture-hygiene`:

- `src/modules/inspector/panels/region/ObjectRegionDiagnosticsPanel.tsx` ma `#eee`.
- `src/modules/inspector/panels/region/ObjectRegionMagneticParametersPanel.tsx` ma `#ccc`.
- `src/modules/viewport-3d/layers/HysteresisReplayGlyphLayer.tsx` ma `#ffcc66`, `#7dd3fc`, `#c4b5fd`.

Kontrakt projektu wymaga tokenow `--fm-*` i centralnych theme/token files. To nie jest kosmetyka: czerwona bramka oznacza, ze kazda kolejna praca nad `apps/control-room` startuje z naruszonym baseline.

Naprawa:

- zastapic fallbacki tokenami `--fm-*` albo centralnymi stałymi design-token;
- dodac test, jezeli te kolory sa czescia semantyki hysteresis glyph axis.

## F3D-010: `check:api-hygiene` lapie reczne `/v2` strings w testach diagnostycznych

Priorytet: P3

Dowody:

`check:api-hygiene` wykrywa recznie wpisane `/v2/...` strings w testach diagnostic recorder. To sa testy, nie runtime React components, ale bramka jest czerwona.

Skutek:

- API hygiene nie moze odroznic realnego runtime naruszenia od fixture/test literal;
- kazdy przyszly PR frontendowy ma czerwony baseline.

Naprawa:

1. Zamienic literały w testach na `DATA_FIELD_VECTOR_PATH`, `resolve...ResourceKey` albo centralne test helpers.
2. Jezeli test celowo sprawdza literal protokolu, dodac jawny allowlist w skrypcie i komentarz z powodem.

## F3D-011: "per-part" UI zapisuje object-level state dla object-owned parts

Priorytet: P3

Kontrakt: `docs/specs/frontend-v2/23-per-object-visualization-control.md:18-25` mowi, ze `part:<part_id>` jest tylko fallbackiem, gdy mesh part nie ma object id.

Dowody:

- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx:809-823` renderuje fieldset `aria-label="Per-part vector visibility"` i label "Surfaces".
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx:1164-1208` dla partu z `object_id` tworzy target `{ id: p.object_id, kind: "object" }`, nie `{ id: p.id, kind: "part" }`.
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts:73-89` renderer ma ta sama semantyke: mesh part z `object_id` mapuje sie do canonical object target.

To jest zgodne ze specyfikacja, ale mylaca etykieta UI. Uzytkownik moze oczekiwac, ze toggluje pojedyncza surface/part, a faktycznie toggluje caly object target, wiec wszystkie czesci z tym samym object id moga zmienic stan.

Naprawa:

- zmienic copy i grouping na "Object surfaces" / "Object target visibility" albo pokazac target badge;
- jezeli produkt ma wspierac prawdziwe per-part overrides dla object-owned parts, najpierw zmienic spec i registry, bo obecna semantyka celowo tego nie robi.

## Matryca zgodnosci

| Obszar | Ocena | Dowod |
|---|---|---|
| Aktywny viewport-main mount | zgodne | `ViewportTabHost.tsx:74-80` renderuje jeden keyed `MountedModule` |
| 3D render loop | zgodne | `viewport3dTypes.ts:18` ma `VIEWPORT_3D_FRAMELOOP = "demand"`, `Viewport3DModule.tsx:788-830` przekazuje to do Canvas |
| WebGL/resource cleanup | czesciowo zgodne | `viewport3dDiagnostics.ts:350-360` dispose na unmount; policy pause dziala, ale jest w zlej warstwie |
| Direct React fetch | brak istotnego naruszenia w audytowanym runtime | wyszukiwanie nie znalazlo komponentowego `fetch()` w sciezce viewport/inspector |
| Object target override | zgodne | `ObjectVisualizationController.ts:432-620` czyta/zapisuje style override, testy przechodza |
| Airbox inspector persistence | zgodne | `ObjectVisualizationPanel.tsx:1022-1048` uzywa airbox helpera |
| Airbox ribbon persistence | niezgodne | `ribbonContributions.tsx:3636-3661` zapisuje length/thickness globalnie |
| Vector-only scoped data-plane | zgodne | `viewport3dResources.ts:420-451`, `useViewport3DSceneModel.ts:1160-1216` |
| Mixed scalar+vector data-plane | niezgodne | `useViewport3DSceneModel.ts:1192-1197`, `:852-887` |
| Region visual overlay settings | czesciowo zgodne | render layer uzywa settings, picking layer nie |
| Region selected quantity | niezgodne | command validator nie akceptuje `region` |

## Zalecana kolejnosc napraw

1. **Zamknac czerwone bramki baseline**: F3D-001, F3D-009, F3D-010. Bez tego kazda kolejna zmiana frontendowa bedzie miala szum w walidacji.
2. **Naprawic data-plane semantics**: F3D-002 i F3D-003. To ma najwiekszy wplyw na duze FEM payloady i per-object vector budget.
3. **Ujednolicic visualization persistence**: F3D-004 i F3D-005. Wybrac, czy global vector budget jest defaultem targetow, czy tylko capem.
4. **Domknac region target UX**: F3D-006 i F3D-007. Region ma byc first-class albo trzeba ograniczyc UI, ktore udaje, ze nim jest.
5. **Dopiero potem dzielic duze pliki**: F3D-008. Split bez testow charakterystyki moze zamaskowac regresje.

## Minimalny plan testow po naprawach

Komendy:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

Testy funkcjonalne do dodania lub rozszerzenia:

1. Mixed scalar+vector target:
   - object/part ma `shaderVisible=true`, `surfaceColorSource=magnitude`, `vectorsVisible=true`, `vectorBudget=512`;
   - oczekiwane: vector payload nie jest niejawnie full-domain, chyba ze scalar payload jawnie wymaga osobnego full-field resource.
2. Airbox explicit part:
   - dwa airbox parts;
   - `scope_kind=airbox&scope_id=<part_id>` zwraca dane tego partu.
3. Airbox ribbon:
   - length/thickness zapisuje `overrides: [{ scope: "airbox", scope_id: "airbox", style: ... }]`;
   - nie zapisuje `vector_style.length_scale` dla airbox targetu.
4. Region quantity:
   - selected region quantity radio tworzy `scope: "region"`;
   - validator akceptuje `region`.
5. Hidden region picking:
   - region z `visible:false` nie renderuje sie i nie jest pickowalny.
6. Global vector budget:
   - wybrana semantyka default vs cap ma test odczytu w `resolveGlobalObjectVisualizationSettings` albo test label/cap.

## Rzeczy, ktore nie sa bledami w obecnym audycie

- `ViewportTabHost` nie trzyma ukrytych center surfaces; montowany jest tylko aktywny modul.
- `Canvas` nie pracuje w always-on frame loop; `VIEWPORT_3D_FRAMELOOP` to `"demand"`.
- Per-object/part target override dla `vector_budget` i `vector_length_scale` ma dzialajaca sciezke serializacji i odczytu.
- Airbox inspector nie uzywa starej globalnej sciezki dla length/thickness; problem jest w ribbonie.
- Mesh part z `object_id` mapowany do object target jest zgodny ze specyfikacja; problemem jest UI wording, jesli obiecuje per-part behavior.
