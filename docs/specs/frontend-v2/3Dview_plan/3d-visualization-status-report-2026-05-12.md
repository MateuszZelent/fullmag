# Raport stanu implementacji wizualizacji 3D frontend v2

**Data:** 2026-05-12  
**Zakres:** aktualny working tree `apps/control-room` oraz dokumentacja `docs/specs/frontend-v2`.  
**Werdykt:** wizualizacja 3D ma duzy kawalek architektury i lokalnych bramek, ale **nie jest jeszcze gotowa jako w pelni dzialajacy workflow uzytkownika**. Kod przechodzi lokalne testy, typecheck, lint i build, ale realny smoke w przegladarce pokazuje pusty canvas 3D oraz blad runtime zasobow API: `Failed to execute 'fetch' on 'Window': Illegal invocation`.

## Odpowiedzi krotkie

| Pytanie | Odpowiedz |
|---|---|
| Czy mamy zaimplementowane wszystkie sekcje z dokumentacji nowego frontendu v2? | **Nie.** `22-implementation-plan.md` nadal ma wiele otwartych checkboxow w Phase 0, 1, 3, 4, 5, 6, 7 i 8. Phase 2 jest oznaczona jako domknieta, a w Phase 5 zamkniety jest tylko fragment per-target visualization overrides. |
| Czy 3D viewport jest zaimplementowany? | **Czesciowo.** Jest modul `viewport-3d`, manifest, jeden R3F canvas `frameloop="demand"`, store kamery, zasoby, adaptery FEM/FDM, warstwy mesh/airbox/vector oraz testy. Brakuje jednak zielonego smoke runtime i pelnego pokrycia acceptance z dokumentacji. |
| Czy ribbony 3D juz dzialaja? | **Czesciowo.** `Selected Display` jest podlaczone do wspolnego rejestru wizualizacji. Globalne menu typu `Airbox`, `Vectors`, `Quantity`, `Mesh View` zawiera UI, ale wiele pozycji jest statyczne i nie ma `commandId`, `onCheckedChange` ani `onValueChange`, wiec nie mutuje jeszcze stanu. |
| Czy moge wlaczyc/wylaczyc airbox? | **Nie jako pewny globalny ribbon workflow.** Rejestr ma target `airbox`, inspector i selected-target flow potrafia go zmieniac po selekcji airboxa. Globalny przycisk `View -> Airbox` pokazuje statyczne checkboxy i nie jest zrodlem prawdy. Live smoke dodatkowo nie potwierdza renderu. |
| Czy moge wlaczyc wektory w airboxie dla `H_demag`, `H_eff` itd.? | **Nie w pelnym produkcyjnym sensie.** Warstwa `AirboxLayer` moze narysowac `VectorFieldLayer` dla airbox node selection, jesli `vectorsVisible=true` i istnieje `fieldVector`. Brakuje jednak dzialajacego runtime fetch w przegladarce, podlaczonego wyboru quantity w ribbonie oraz osobnego, zweryfikowanego workflow dla `H_demag`/`H_eff` w airboxie. |
| Czy moge wlaczac/wylaczac shader, zostawic samo wireframe albo same points? | **Modelowo tak, workflow czesciowo.** `ObjectVisualizationController`, inspector i `Selected Display` obsluguja `shaderVisible`, `wireframeVisible`, `pointsVisible` i `renderMode`. Warstwy 3D respektuja te flagi. Nie jest to jeszcze potwierdzone live, a globalny `Mesh View` jest w duzej czesci statycznym menu. |

## Mapa dokumentacja -> implementacja

| Obszar dokumentacji | Stan wedlug kodu i planu |
|---|---|
| `01-module-kernel-architecture.md` | Modul `viewport-3d` ma manifest, slot `viewport-main`, root `Viewport3DModule` i komendy. Pliki sa rozbite, bez importow z `apps/web` w skanach lokalnych. |
| `04-state-management.md` | Kamera i widgety 3D sa w prywatnym `viewport3dStore`; duze zasoby ida przez hooks/cache, nie przez store. Per-target display preferences sa w `ObjectVisualizationController` jako tymczasowy client-owned registry. |
| `05-viewport-architecture.md` | Jest jeden R3F canvas i dirty/demand frameloop. Topologia i pole sa rozdzielone w zasobach, ale smoke pokazuje, ze browser runtime nie dociera jeszcze do danych. |
| `12-ribbon-toolbar-command-system.md` | Komendy fit/reset/orientation sa zarejestrowane. Selected-target display korzysta z rejestru. Globalne display menus nie sa jeszcze pelnym rendererem komend i zasobow. |
| `14-viewport-3d-module.md` | Wiekszosc struktury Phase 5 istnieje: canvas, camera, mesh, airbox, selection, diagnostics, resource hooks. Nie ma pelnego potwierdzenia: browser/canvas smoke pada, a quantity switch/no topology rebuild nie jest udowodniony live. |
| `21-cutover-acceptance.md` | Nie spelnione. V2 nie ma jeszcze wszystkich workflow: project start, pelne authoring modules, 2D/charts/console/results, desktop, side-by-side parity i legacy freeze. |
| `22-implementation-plan.md` | Nie jest caly odhaczony. Najwazniejsze: Phase 2 oznaczona jako gotowa; Phase 5 ma tylko czesciowe checkboxy dla per-target overrides. |
| `23-per-object-visualization-control.md` | Najlepiej domkniety fragment: explorer nodes, inspector, selected ribbon i 3D warstwy uzywaja wspolnego rejestru targetow object/part/airbox. Backend persistence nadal nie jest czescia tego slice'u. |

## Stan ribbonow 3D

### Dziala w kodzie

- `viewport-3d.fit` i `viewport-3d.reset-camera` mutuja `viewport3dStore`.
- `viewport-3d.toggle-viewcube` oraz `viewport-3d.hsl-reference-*` sa w manifeście i maja testy.
- `buildSelectedVisualizationGroup(...)` buduje `Selected Display` na podstawie aktualnej selekcji i `ObjectVisualizationController`.
- Inspector `ObjectVisualizationPanel` i selected ribbon zmieniaja ten sam rejestr: `visible`, `shaderVisible`, `wireframeVisible`, `pointsVisible`, `vectorsVisible`, `opacityPercent`, `renderMode`.

### Nie jest jeszcze pelnym workflow

- `View -> Airbox` ma checkboxy i suwaki, ale w aktualnym kodzie sa to glownie statyczne nodes. Nie ida przez command registry ani przez `ObjectVisualizationController`.
- `View -> Vectors` i `View -> Quantity` zawieraja statyczne `radio-group`/checkbox/slider nodes bez podlaczonego `onValueChange` do `/visualization/state`.
- `View -> Mesh View` zawiera statyczny wybor render mode i opacity, ale nie aktualizuje jeszcze globalnego stanu renderera.
- Selected-target flow zalezy od poprawnej selekcji object/airbox/part. Dla explorer `Airbox Visualization` sciezka istnieje; dla bezposredniego klikniecia airbox layer nie widac jeszcze pointer handlera w `AirboxLayer`.

## Stan airbox i pol wektorowych

Airbox jest modelowany poprawnie jako osobny target, nie jako `SceneObject`:

- `AIRBOX_VISUALIZATION_TARGET` ma id `airbox`.
- `resolveVisualizationTargetFromSelection(...)` mapuje `airbox.visualization` i `mesh-part-airbox` na target `airbox`.
- `adaptFemSharedDomainManifest(...)` rozdziela `role === "air"` do `airboxParts`.
- `AirboxLayer` renderuje shader/wireframe/points/vectors zależnie od `VisualizationTargetSettings`.

Ograniczenia:

- `Viewport3DModule` pobiera tylko aktywne `quantityId` z `/visualization/state` i domyslnie `m`.
- Field vector request idzie jako `FULL_FIELD_QUERY` (`scope_kind: "full"`), a airbox dostaje node selection dopiero w warstwie renderowania.
- Nie ma jeszcze podlaczonego UI, ktory zmienia aktywna quantity na `H_demag`, `H_eff`, `H_ex` itd. z ribbonu.
- Live smoke nie potwierdza zadnego pola, bo zasoby API w przegladarce koncza sie bledem fetch.

Wniosek: backend/API i renderer maja kierunek na airbox vectors, ale uzytkownik nie ma jeszcze pewnego, zweryfikowanego przycisku "wlacz airbox vectors dla H_demag/H_eff".

## Smoke runtime

Uruchomiono lokalny serwer produkcyjny:

```bash
pnpm --dir apps/control-room exec next start -p 3910
```

Nastepnie uruchomiono smoke:

```bash
CONTROL_ROOM_URL=http://127.0.0.1:3910/workspace pnpm --dir apps/control-room smoke:viewport-3d
```

Wynik po uruchomieniu poza sandboxem:

```text
Error: 3D viewport canvas center pixel is blank.
```

Dodatkowy sampling 25 pikseli canvas:

```text
hasContext: true
canvas: 741 x 528
nonBlank sampled pixels: 0 / 25
browser console errors: 0
HUD: Failed to execute 'fetch' on 'Window': Illegal invocation
HUD diagnostics: q:m top:none field:none obj:0 air:0 geo:0 cache:0B frames:2
```

Najbardziej prawdopodobne zrodlo runtime failure: domyslny `fetchImpl = fetch` w `ControlRoomApi` jest trzymany jako metoda instancji i wywolywany przez `this.fetchImpl(...)`. W przegladarce niepodpiety `window.fetch` wywolany z blednym `this` moze dac `Illegal invocation`. Testy jednostkowe tego nie lapia, bo mockowany/node'owy fetch nie wymaga `Window` jako receivera.

## Weryfikacja lokalna

Zielone:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room build:webpack
pnpm --dir apps/control-room build   # po uruchomieniu poza sandboxem
node --check apps/control-room/scripts/smoke-viewport-3d.mjs
```

Wyniki istotne:

```text
Test Files  47 passed (47)
Tests       153 passed (153)
Idle performance audit passed.
Webpack build: passed.
Turbopack build: passed outside sandbox; sandbox failure was EPERM on helper process/port binding.
```

Czerwone:

```bash
CONTROL_ROOM_URL=http://127.0.0.1:3910/workspace pnpm --dir apps/control-room smoke:viewport-3d
```

Powod:

```text
WebGL context exists, but sampled canvas is blank.
Viewport HUD reports: Failed to execute 'fetch' on 'Window': Illegal invocation.
```

## Prompt-to-artifact checklist

| Wymaganie z promptu | Dowod w tym raporcie | Status |
|---|---|---|
| Uzyc `executing-plans` | Wczytano skill; potraktowano zadanie jako raportowy plan audytu, nie implementacje produkcyjna. | Done |
| Uzyc `test-driven-development` | Nie zmieniano kodu produkcyjnego, wiec TDD nie mialo zastosowania poza istniejacymi testami. Raport dokumentuje uruchomione testy. | Done / not applicable |
| Uzyc `frontend-v2-viewport-lifecycle` | Sprawdzono single canvas, frameloop demand, resource hooks/cache, tracker, smoke i idle audit. | Done |
| Uzyc `frontend-v2-module-architecture` | Sprawdzono manifest, slot, command registry i skany braku `apps/web`/direct fetch w badanym zakresie. | Done |
| Uzyc `frontend-v2-state-hygiene` | Sprawdzono ownership: resource hooks/cache vs store vs visualization registry. | Done |
| Uzyc `high-end-visual-design` | Sprawdzono token/ribbon tests i brak raw hex w ribbon contribution testach; brak finalnej visual acceptance przez blank canvas. | Partial |
| Uzyc `verification-before-completion` | Uruchomiono swieze bramki lokalne, build i browser smoke; raport rozroznia zielone i czerwone dowody. | Done |
| Raport o stanie implementacji 3D | Ten plik. | Done |
| Odpowiedz czy wszystkie sekcje frontend v2 sa zaimplementowane | Sekcja "Odpowiedzi krotkie" i "Mapa dokumentacja -> implementacja". | Done |
| Odpowiedz czy 3D ribbony dzialaja | Sekcja "Stan ribbonow 3D". | Done |
| Odpowiedz airbox on/off | Sekcje "Odpowiedzi krotkie", "Stan ribbonow 3D", "Stan airbox i pol wektorowych". | Done |
| Odpowiedz airbox vectors dla `H_demag`/`H_eff` | Sekcja "Stan airbox i pol wektorowych". | Done |
| Odpowiedz shader/wireframe/points | Sekcje "Odpowiedzi krotkie" i "Stan ribbonow 3D". | Done |

## Decyzja koncowa

Nie nalezy jeszcze mowic, ze frontend-v2 3D visualization jest "100% gotowa".

Najbardziej uczciwy status:

1. **Architektura i lokalne bramki sa mocne:** modul 3D, per-target registry, inspector/selected ribbon, API facade, cache i test suite sa w working tree.
2. **Globalne ribbony 3D sa tylko czesciowo podlaczone:** czesc jest realna przez command registry i selected-target registry, czesc jest nadal statycznym UI.
3. **Airbox ma dobry model targetu, ale workflow uzytkownika nie jest domkniety:** szczegolnie globalne airbox toggles i airbox field vectors dla wybranych quantity.
4. **Najwiekszy aktualny blocker live:** browser runtime fetch failure powoduje brak danych i pusty canvas.

Najblizszy P0 fix przed kolejnym raportem: naprawic browser `fetchImpl` w `ControlRoomApi`, dodac regresje, ponownie uruchomic `smoke:viewport-3d`, a potem dopiero oceniac wizualnie shadery/wireframe/points i airbox vectors na realnych danych.
