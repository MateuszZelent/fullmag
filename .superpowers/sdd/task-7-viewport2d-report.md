# Task 7 remediation partial — awaiting Task7A

## Zakres

Zmieniono wyłącznie frontendowy model i renderer `field-map`. To jest częściowa
naprawa po review: końcowe domknięcie range/opacity/boundaries czeka na Task7A
ustalający kontrakt. Nie zmieniano
OpenAPI, backendowego samplera, CRUD monitora, własności `fieldMapStore`,
Inspectorów Tasku 8 ani workflow 3D.

## Zrealizowane zachowania

- `FieldMapModule` buduje jeden `FieldMapRenderModel` z zasobów revisioned i
  serwerowego `PlanarVisualizationState`; `PlanarSurface` nie scala już
  równolegle identity, bufory i presentation z rozproszonych propsów.
- Model zachowuje canonical SI i sample identity, rozwiązuje auto/manual range,
  jednostkę prezentacji, bounds, viewport pan/zoom, warstwy, budżet wektorów i
  provenance buforów. Nieobecne obecnie w kontrakcie tryb symmetric, opacity i
  klasyfikacja granic są jawnie zgłaszane diagnostyką fail-closed; nie są
  lokalnie wymyślane.
- Worker otrzymuje własne klony wartości oraz maski. Ten sam request tworzy
  raster i kontury; renderer/probe pozostają przy nieodłączonych danych.
- Raster, contours, mesh, vectors i probes są niezależnie sterowane flagami.
  Wyłączone raster+contours nie uruchamiają workera ani nie publikują dowodu
  rastra; wyłączenie probes usuwa hover oraz pin.
- Legenda i probe stosują `A/m`, `kA/m`, `MA/m`, `T` oraz `mT` tylko w zgodnych
  wymiarach; wartości canonical pozostają bez zmian.
- Quiver odrzuca NaN/Infinity, ogranicza geometrię do komórki, zachowuje znak
  normalnej i stosuje `length_mode` oraz `color_mode`. Raster, contours i
  glyphy odwracają backendowy wiersz `v_min` do dolnej części canvasa.
- Wheel, drag, double-click, `0` i strzałki publikują interaction w metrach;
  resize z rzeczywistym DPR odmalowuje posiadany raster bez nowej próbki.
- Hover jest ograniczony do jednej aktualizacji React na klatkę i jego RAF jest
  anulowany przy unmount. Unmount odłącza też `ResizeObserver`, zakańcza worker
  i zwalnia canvas/scratch.

## RED → GREEN

Przed poprawkami review uruchomiono focused RED: 3 testy nieprzechodzące oraz
1 suite z brakującym modułem interakcji (orientacja `v`, jednostki,
fail-closed diagnostics i interakcje). Po implementacji zestawy przechodzą.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| focused model/renderer/surface tests | 5 plików, 26 testów PASS |
| regresja `src/modules/field-map` | 19 plików, 69 testów PASS |
| `pnpm --dir apps/control-room typecheck` | PASS |
| targeted ESLint zmienionych plików | PASS |
| `pnpm --dir apps/control-room audit:idle-performance` | PASS |
| `pnpm --dir apps/control-room check:api-hygiene` | PASS |
| `pnpm --dir apps/control-room check:architecture-hygiene` | PASS |
| `git diff --check` | PASS |

Nie uruchomiono pełnego runtime ani screenshotów FDM/FEM; pozostają one bramką
integracyjną Tasku 10.
