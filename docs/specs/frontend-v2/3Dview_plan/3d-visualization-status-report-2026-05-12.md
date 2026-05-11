# Raport stanu implementacji wizualizacji 3D frontend v2

**Data:** 2026-05-12  
**Zakres:** aktualny working tree `apps/control-room` oraz dokumentacja `docs/specs/frontend-v2`.  
**Werdykt:** 3D visualization jest po duzym kroku naprzod i lokalnie przechodzi kluczowe bramki kodu, ale **nie jest jeszcze w 100% zamknietym workflow uzytkownika**. Najwazniejsza zmiana wzgledem poprzedniej wersji raportu: smoke runtime nie konczy sie juz na starym `Illegal invocation`/blank-center-pixel problemie. Produkcyjny `/workspace` wyrenderowal widoczny niepusty R3F canvas w kontrolowanym trybie bez aktywnej sesji. Nadal brakuje smoke na realnej aktywnej sesji z opublikowanymi zasobami `model/scene`, topology, fields i websocketem.

## Odpowiedzi krotkie

| Pytanie | Odpowiedz |
|---|---|
| Czy mamy zaimplementowane wszystkie sekcje z dokumentacji nowego frontendu v2? | **Nie.** `22-implementation-plan.md` nadal ma otwarte fragmenty poza domknietym kernelem i czescia Phase 5. Ten raport dotyczy slice'u 3D/geometry/mesh lifecycle, nie calego frontendu v2. |
| Czy 3D viewport jest zaimplementowany? | **Czesciowo, w uzywalnym szkielecie.** Jest modul `viewport-3d`, manifest, jeden R3F canvas `frameloop="demand"`, store kamery, zasoby, adaptery FEM/FDM, mesh/airbox/vector layers, primitive fallback i smoke canvas. Brakuje aktywnej sesji do pelnego acceptance. |
| Czy rezygnujemy z podzialu viewportu? | **Tak.** Aktualna specyfikacja Phase 5 trzyma jeden R3F viewport, jeden canvas, bez split/multi-pane. Multi-view wymagalby osobnego ADR i planu wydajnosciowego. |
| Czy ribbony 3D juz dzialaja? | **W duzej czesci tak.** `Quantity`, `Vectors`, `Mesh View` patchuja backendowy `/visualization/state`; `Airbox` patchuje target `airbox`; Geometry/Mesh lifecycle actions ida przez `CommandRegistry`. Trim i czesc zaawansowanego stylowania airboxa pozostaja niepelne. |
| Czy moge wlaczyc/wylaczyc airbox? | **Modelowo tak.** `View -> Airbox` ma callbacki dla visible/shaded/wireframe/points/vectors/opacity/reset i mutuje canonical target `airbox`. Smoke potwierdza niepusty canvas, ale nie potwierdza jeszcze realnych danych airbox z aktywnej sesji. |
| Czy moge wlaczyc wektory w airboxie dla `H_demag`, `H_eff` itd.? | **Przeplyw jest podlaczony, ale niepotwierdzony na aktywnej sesji.** `Quantity` ustawia aktywna quantity, a `Airbox` ustawia `vectorsVisible`; renderer czyta `fieldVector` aktywnej quantity i mapuje airbox przez node selection. Brakuje testu z backendiem publikujacym te pola. |
| Czy moge wlaczac/wylaczac shader, zostawic samo wireframe albo same points? | **Dla modelu targetow tak.** Inspector, selected ribbon i 3D layers respektuja `shaderVisible`, `wireframeVisible`, `pointsVisible`, `opacityPercent` i `renderMode`. Wizualna walidacja realnych danych pozostaje otwarta. |

## Mapa dokumentacja -> implementacja

| Obszar dokumentacji | Stan wedlug kodu i walidacji |
|---|---|
| `01-module-kernel-architecture.md` | `viewport-3d` jest modulem z manifestem, slotem `viewport-main`, root componentem i command contributions. Komunikacja idzie przez kernel/API/resource hooks, nie przez importy miedzy modulami. |
| `04-state-management.md` | Kamera i widgety 3D sa w prywatnym `viewport3dStore`; zasoby ida przez resource hooks/cache; per-target display state jest przez `ObjectVisualizationController` i backendowy visualization state. |
| `05-viewport-architecture.md` | Jest jeden R3F canvas i dirty/demand frameloop. Topologia i field resources sa rozdzielone. Kontrolowany smoke potwierdzil render canvas; aktywna sesja jest nadal niezweryfikowana. |
| `12-ribbon-toolbar-command-system.md` | Fit/reset/orientation, Geometry lifecycle i Mesh lifecycle actions sa w `CommandRegistry`. Disabled-state guard dziala przed side effectami. |
| `14-viewport-3d-module.md` | Struktura Phase 5 jest w duzej czesci obecna: canvas, camera, mesh, airbox, selection, diagnostics, resource hooks, primitive fallback. Otwarte: aktywna sesja, quantity switch bez pelnej live-profiler walidacji, pelny memory stress dla 3D/2D. |
| `15-viewport-2d-module.md` | Po decyzji o jednym R3F viewport 2D pozostaje niezaleznym modulem dla slices/profiles/charts, nie podzialem 3D viewportu. Ten slice nie wdraza jeszcze 2D. |
| `21-cutover-acceptance.md` | Nie spelnione globalnie. Nadal brakuje pelnego start-project workflow, authoring modules, 2D/charts/console/results, desktop, parity i legacy freeze. |
| `22-implementation-plan.md` | Nie jest caly odhaczony. Phase 2 kernel contracts sa domkniete; Phase 5 ma istotny postep, ale nie ma jeszcze 100% acceptance. |
| `23-per-object-visualization-control.md` | Najlepiej domkniety fragment tego slice'u: explorer nodes, inspector, selected ribbon i 3D layers uzywaja wspolnego target modelu object/part/airbox. Backend persistence targetow nadal wymaga finalizacji. |
| `24-geometry-object-authoring-lifecycle.md` | Wdrozone sa command adapters dla object draft/apply/delete/focus i invalidacje resource hooks. Pelne field-level editing, transform commit i validation display pozostaja otwarte. |

## Stan ribbonow 3D

### Dziala w kodzie

- `viewport-3d.fit`, `viewport-3d.reset-camera`, `viewport-3d.toggle-viewcube` i HSL reference commands sa zarejestrowane w module.
- `Selected Display` buduje UI z aktualnej selekcji i `ObjectVisualizationController`.
- Inspector `ObjectVisualizationPanel` i selected ribbon zmieniaja ten sam target registry: `visible`, `shaderVisible`, `wireframeVisible`, `pointsVisible`, `vectorsVisible`, `opacityPercent`, `renderMode`.
- `View -> Quantity` patchuje `active_quantity_id`, overlay quantity, colormap, auto-scale i vector color mode.
- `View -> Vectors` patchuje `layers.vectors.visible`, glyph style, density, max glyphs, component, domain i vector style.
- `View -> Mesh View` patchuje globalny render mode surface/wireframe/points oraz opacity warstw mesh.
- `View -> Airbox` patchuje canonical target `airbox` dla visible, shaded, wireframe, points, vectors, opacity i resetu.
- Geometry/Mesh ribbon actions `geometry.add-*`, `geometry.focus-primitive`, `geometry.delete-object`, `geometry.commit-object-draft`, `mesh.build-selected` i `mesh.build-shared-domain` ida przez `CommandRegistry`.
- Shortcut dispatcher wykonuje komendy z `shortcut` przez `CommandRegistry` i ignoruje editable targets.

### Nadal nie jest pelnym workflow

- `View -> Mesh View -> 3D trim` nadal jest glownie statycznym UI.
- Zaawansowane parametry airbox style, np. vector density/length/thickness/alpha i mono-color picker, nie maja jeszcze pelnego backendowego modelu per-airbox.
- `Focus airbox` wybiera canonical `Airbox Visualization` node, a klik w `AirboxLayer` wybiera `mesh-part-airbox`, ale realny active-session inspector flow wymaga jeszcze smoke.
- Mesh build integration invaliduje immediate resources, ale build completion, provenance match i stale badge clearing po zakonczonym buildzie pozostaja otwarte.

## Stan airbox i pol wektorowych

Airbox jest osobnym targetem wizualizacji, nie `SceneObject`:

- `AIRBOX_VISUALIZATION_TARGET` ma id `airbox`.
- `resolveVisualizationTargetFromSelection(...)` mapuje `airbox.visualization` i `mesh-part-airbox` na target `airbox`.
- Adapter FEM shared-domain rozdziela `role === "air"` do `airboxParts`.
- `AirboxLayer` renderuje shader/wireframe/points/vectors zależnie od `VisualizationTargetSettings`.

Ograniczenia:

- Field vector request jest nadal scoped jako full-field query, a airbox jest filtrowany/renderowany po stronie render modelu.
- Airbox vectors dla `H_demag`/`H_eff` wymagaja aktywnego backendu publikujacego te pola; obecny lokalny API smoke mial `active_session:false`.
- Skalarny coloring nadal aktualizuje atrybut kolorow `BufferGeometry` w warstwach mesh/fallback. To nie jest rebuild topologii, ale nie jest jeszcze idealnym uniform/GPU-buffer split dla wszystkich przypadkow.

## Smoke runtime

Stary problem opisany w poprzedniej wersji raportu byl dwojaki:

1. `ControlRoomApi` uzywal niezwiazanego `globalThis.fetch`, co w przegladarce dawalo `Illegal invocation`.
2. Smoke czytal `gl.readPixels` z WebGL drawing buffer przy `preserveDrawingBuffer=false`, przez co potrafil widziec blank canvas mimo widocznego composited renderu.

Naprawione:

- `ControlRoomApi` binduje domyslny fetch przez `globalThis.fetch.bind(globalThis)`.
- Regresja jednostkowa wymusza poprawny receiver dla fetch.
- `smoke-viewport-3d.mjs` probkuje compositor screenshot PNG zamiast polegac na `gl.readPixels`.
- Smoke potrafi wstrzyknac `CONTROL_ROOM_API_BASE_URL` do `window.__FULLMAG_CONFIG__.controlRoomApiBase`.
- Smoke ma jawny tryb `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1`, ktory dopuszcza 404 dla `/v2/sessions/current/*` i websocketu tylko wtedy, gdy testujemy sam render canvas bez aktywnej sesji.

Sprawdzony wariant produkcyjny:

```bash
# terminal 1, z katalogu apps/control-room
pnpm exec next start --hostname 127.0.0.1 --port 3920

# terminal 2
FULLMAG_DISABLE_STATIC_CONTROL_ROOM=1 FULLMAG_API_PORT=8181 .fullmag/local/bin/fullmag-api

# terminal 3
CONTROL_ROOM_URL=http://127.0.0.1:3920/workspace \
CONTROL_ROOM_API_BASE_URL=http://127.0.0.1:8181 \
CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
pnpm --dir apps/control-room smoke:viewport-3d
```

Wynik:

```text
Viewport 3D smoke passed at http://127.0.0.1:3920/workspace.
```

Wazna uwaga operacyjna: `next start` musi byc uruchamiany z `apps/control-room`. Wariant `pnpm --dir apps/control-room exec next start` potrafil serwowac HTML, ale psul serwowanie niektorych `_next/static` chunkow dla `/workspace`.

Strict smoke bez `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1` nadal nie przechodzi z lokalnym API na 8181, bo ten proces nie ma aktywnej sesji:

```text
active_session: false
404 /v2/sessions/current/status
404 /v2/sessions/current/model/scene
404 /v2/sessions/current/data/domain/meta
404 /v2/sessions/current/events/ws
```

To nie jest dowod, ze viewport nie renderuje; to brak aktywnego runtime/session fixture do acceptance testu.

## Weryfikacja lokalna

Zielone:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room build
pnpm --dir apps/control-room build:webpack
node --check apps/control-room/scripts/smoke-viewport-3d.mjs
git diff --check
```

Wyniki istotne:

```text
Typecheck passed.
ESLint passed with --max-warnings=0.
Test Files 59 passed (59).
Tests 203 passed (203).
API hygiene passed.
Idle performance audit passed.
Default Next/Turbopack build passed after sandbox escalation.
Webpack build compiled, but nie jest runtime proof dla /workspace.
Viewport 3D controlled smoke passed on production /workspace.
```

Ograniczenia walidacji:

- `react-doctor` nie zostal wykonany. Standardowe uruchomienie padlo na DNS `EAI_AGAIN registry.npmjs.org`; eskalowane `npx -y react-doctor@latest ...` zostalo odrzucone, bo wymagaloby pobrania i wykonania zewnetrznego pakietu npm.
- Strict active-session smoke nadal wymaga realnego backendu z aktywna sesja i opublikowanymi zasobami.
- Live airbox vectors dla `H_demag`/`H_eff` nie zostaly jeszcze potwierdzone na aktywnych danych.

## Prompt-to-artifact checklist

| Wymaganie z promptu | Dowod w tym raporcie | Status |
|---|---|---|
| Przeczytac plan `3Dview_plan` i skorygowac kierunek | Raport odnosi sie do Phase 5, single R3F viewport i rezygnacji ze split viewportu. | Done |
| Nie dzielic viewportu 3D | `14-viewport-3d-module.md` i ten raport trzymaja one-R3F/one-canvas decision. | Done |
| Zweryfikowac czy 3D jest zaimplementowane | Sekcje "Odpowiedzi krotkie", "Mapa dokumentacja -> implementacja" i "Smoke runtime". | Done |
| Zweryfikowac ribbony 3D | Sekcja "Stan ribbonow 3D". | Done |
| Zweryfikowac airbox on/off | Sekcje "Odpowiedzi krotkie", "Stan ribbonow 3D", "Stan airbox i pol wektorowych". | Done modelowo, live partial |
| Zweryfikowac airbox vectors dla `H_demag`/`H_eff` | Sekcja "Stan airbox i pol wektorowych". | Partial |
| Zweryfikowac shader/wireframe/points | Sekcje "Odpowiedzi krotkie" i "Stan ribbonow 3D". | Partial live |
| Browser/canvas smoke | `smoke:viewport-3d` przeszedl na produkcyjnym `/workspace` z `ALLOW_MISSING_SESSION=1`. | Partial |
| Lokalne bramki jakosci | Typecheck, lint, test, API hygiene, idle audit, build, diff check. | Done |

## Decyzja koncowa

Nie nalezy jeszcze mowic, ze frontend-v2 3D visualization jest "100% gotowa".

Najbardziej uczciwy status:

1. **Kod jest lokalnie shippable dla tego slice'u:** typecheck, lint, test, API hygiene, idle audit, build, syntax check i diff check sa zielone.
2. **3D viewport runtime nie jest juz blank:** produkcyjny `/workspace` wyrenderowal niepusty R3F canvas w kontrolowanym smoke.
3. **Architektura idzie w dobra strone:** jeden R3F canvas, command registry, resource hooks, target visualization model, primitive fallback i geometry/mesh lifecycle commands sa spojne z dokumentacja.
4. **Najwiekszy blocker acceptance:** brak aktywnej lokalnej sesji do strict smoke z prawdziwymi zasobami `model/scene`, topology, fields, websocket i airbox vector data.
5. **Najblizszy P0 nastepny krok:** przygotowac deterministic active-session fixture albo uruchomic realny runtime z sesja, a potem powtorzyc strict `smoke:viewport-3d` bez `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1` dla `m`, `H_demag`, `H_eff`, airbox vectors oraz shader/wireframe/points toggles.
