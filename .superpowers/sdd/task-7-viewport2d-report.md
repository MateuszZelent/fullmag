# Task 7 — model renderowania i renderer Field Map

## Zakres

Zmieniono wyłącznie frontendowy model i renderer `field-map`, zużywający
zatwierdzony kontrakt Task7A `df1479b6e`. Nie zmieniano
OpenAPI, backendowego samplera, CRUD monitora, własności `fieldMapStore`,
Inspectorów Tasku 8 ani workflow 3D.

## Zrealizowane zachowania

- `FieldMapModule` buduje jeden `FieldMapRenderModel` z zasobów revisioned i
  serwerowego `PlanarVisualizationState`; `PlanarSurface` nie scala już
  równolegle identity, bufory i presentation z rozproszonych propsów.
- Model zachowuje canonical SI i sample identity, rozwiązuje canonical
  `auto | manual | symmetric`, jednostkę prezentacji, bounds, viewport
  pan/zoom, warstwy, budżet wektorów i provenance buforów. `raster_opacity`
  przechodzi wyłącznie do rastra po strict validation (bez clampowania).
- Ręczny adapter generated → render model mapuje `boundary_classification` z
  snake_case i odrzuca fail-closed `manual` z `null`, niefinitycznymi lub
  odwróconymi granicami; nie ma aliasów `auto_contrast` ani `contrast_*`.
- Worker otrzymuje własne klony wartości oraz maski. Ten sam request tworzy
  raster i kontury; renderer/probe pozostają przy nieodłączonych danych.
- Raster, contours, mesh, vectors i probes są niezależnie sterowane flagami.
  Wyłączone raster+contours nie uruchamiają workera ani nie publikują dowodu
  rastra; wyłączenie probes usuwa hover oraz pin.
- `mesh_overlay_descriptor` steruje pobraniem geometrii dla mesh albo
  boundaries. Tylko `FMCS v4` z klasyfikacją `exact` może narysować segmenty
  `target_boundary`; `FMCS v3`, nieznana i degraded klasyfikacja wyłączają
  boundaries z jawną diagnostyką, bez geometrycznego zgadywania. Mesh pozostaje
  niezależną warstwą.
- Legenda i probe korzystają ze wspólnego rejestru display units, obejmującego
  `A/m` ↔ `T`/`mT` przez μ₀, energie, częstotliwości i `1`; wartości canonical
  pozostają bez zmian.
- Quiver odrzuca NaN/Infinity, ogranicza geometrię do komórki, zachowuje znak
  normalnej i stosuje `length_mode` oraz `color_mode`. Raster, contours i
  glyphy odwracają backendowy wiersz `v_min` do dolnej części canvasa.
- Wheel, drag, double-click, `0`, `+/-` i strzałki publikują interaction w metrach;
  resize z rzeczywistym DPR odmalowuje posiadany raster bez nowej próbki.
- Hover jest ograniczony do jednej aktualizacji React na klatkę i jego RAF jest
  anulowany przy unmount. Unmount odłącza też `ResizeObserver`, zakańcza worker
  i zwalnia canvas/scratch.

## RED → GREEN

Przed poprawkami review uruchomiono focused RED: 3 testy nieprzechodzące oraz
1 suite z brakującym modułem interakcji (orientacja `v`, jednostki,
fail-closed diagnostics i interakcje). Po implementacji zestawy przechodzą.
Końcowe przewodowanie Task7A zaczęto od RED: 2 focused suites, 19 testów i
4 oczekiwane błędy (symmetric/opacity, v3 boundaries i brak partycjonowania
FMCS v4); dodatkowy RED potwierdził brak walidatora nullable manual range.
Końcowy review P1 rozpoczął się od RED: 4 focused suites, 30 testów i 6
oczekiwanych błędów: brak semantycznego flip rastra, rekreacja workera przy
pan/zoom, lokalny rejestr jednostek, rozszerzanie manual equal range i clamp
opacity, brak jednostki probe i skrótów `+/-`. GREEN obejmuje jawny canvas
transform, lifecycle jednego renderer/observera/workera per mount, shared
registry, strict range/opacity i testy skrótów.
Ostatni review P1 zaczął się od RED: 4 focused suites, 30 testów i 5 błędów:
brak zwolnienia/wyczyszczenia rastra po wyłączeniu warstw, aktywny probe RAF,
brak identity dla nieznanych canonical units i padding symmetric zera. GREEN
obejmuje `clearBase`, terminację workera po wyłączeniu obu warstw scalar,
lazily odtwarzany worker contour-only, anulowanie probe RAF oraz testy
tożsamości jednostek i dokładnego `[0,0]`.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| focused model/renderer/surface/module/unit tests | 4 pliki, 31 testów PASS |
| regresja `src/modules/field-map` | 19 plików, 79 testów PASS |
| `pnpm --dir apps/control-room typecheck` | PASS |
| targeted ESLint zmienionych plików | PASS |
| `pnpm --dir apps/control-room audit:idle-performance` | PASS |
| `pnpm --dir apps/control-room check:api-hygiene` | PASS |
| `pnpm --dir apps/control-room check:architecture-hygiene` | PASS |
| `git diff --check` | PASS |

### P1 zamknięte

- Raster stosuje `save → translate(0,height) → scale(1,-1) → drawImage`;
  test sprawdza kolejność i dodatni docelowy prostokąt. Backendowy `v_min`
  trafia na dół, tak jak contours, glyphy i probe.
- Pan/zoom wywołuje lokalny repaint cache, bez terminacji workera ani transferu
  i recolorowania; renderer, observer i worker są tworzone raz na mount.
- Pusty/masked/non-finite auto range jest `[0,0]`, stały finite auto `[v,v]`,
  manual wymaga `min < max`, opacity musi być finite `[0,1]`. Błędne wartości
  są fail-closed, bez ekspansji i bez clampowania.
- Probe zawiera unit, zaś `+/-` wykonują zoom 1.25/0.8 wokół środka widoku.
- Wyłączenie rastra czyści cache obrazu bazowego; wyłączenie jednocześnie
  rastra i contours zakańcza worker. Ponowne contours-only tworzy worker
  lazy, liczy wyłącznie contours i nie publikuje/nie odmalowuje rastra.
  Wyłączenie probes anuluje zaplanowany RAF i pokazuje `No sample`.
- Tożsama, po trimie, canonical/display unit jest zawsze identity (także `m`,
  `Pa`, `V`, `rad`, `dimensionless`); wyłącznie zarejestrowane centralnie
  alternatywy mogą wykonywać przeliczenie. Symmetric all-zero pozostaje
  dokładnie `[0,0]`.

Nie uruchomiono pełnego runtime ani screenshotów FDM/FEM; pozostają one bramką
integracyjną Tasku 10.
