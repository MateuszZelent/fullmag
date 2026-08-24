# Plan wdrożenia mechanizmu clipping / cutaway w widoku 3D Control Room

> **Data:** 2026-08-23
> **Zakres:** `apps/control-room` (frontend v2), warstwa viewport-3d + ribbon/inspector + kontrakt wizualizacyjny `/v2/sessions/current/visualization/state`
> **Charakter:** funkcja czysto prezentacyjna (visualization-only). Nie zmienia semantyki fizycznej, `ProblemIR`, planera ani wyników solvera. Notatka `docs/physics/` **nie jest wymagana** — brak semantyki fizycznej; obowiązuje natomiast `resource-first-api-check` przy każdej zmianie kontraktu JSON.

---

## 1. Cel

Użytkownik pracuje z układem 3D (FDM grid lub FEM shared-domain mesh + airbox) i widzi tylko
powierzchnię brył. Celem jest mechanizm **wycinania (cutaway)** pozwalający:

1. przeciąć model jedną płaszczyzną (już częściowo istnieje — `clip`),
2. przyciąć model prostopadłościanem (box-trim: „wycięty narożnik", „połówka", „warstwa przez grubość"),
3. zobaczyć wnętrze: siatkę, pole skalarne na powierzchni cięcia, wektory, airbox,
4. zachować spójność z resztą control room: jeden ribbon, jeden store stanu wizualizacji,
   jeden zasobowy API, eksportowalność i odtwarzalność sesji.

---

## 2. Audyt stanu obecnego (co już jest)

### 2.1 Pojedyncza płaszczyzna clip — zaimplementowana

| Element | Lokalizacja |
|---|---|
| Stan w kontrakcie | `ClipVisualizationState { axis: x\|y\|z, position_percent, flipped, enabled }` w `VisualizationStateResource.clip` (generowane typy: `openapi-v2-types.ts`) |
| Patch z UI | `visualizationStateCommandInput({ clip: { ... } })` → `RIBBON_VISUALIZATION_PATCH_STATE_COMMAND` (`modules/ribbon/ribbonCommands.ts`, `ribbonContributions.tsx` — akcja `view-selected-clip`) |
| Renderowanie | `modules/viewport-3d/layers/ClipPlaneLayer.tsx` — ustawia **globalnie** `renderer.localClippingEnabled` + `renderer.clippingPlanes = [plane]`, rysuje półprzezroczystą płaszczyznę + obrys + markery przecięć |
| Model płaszczyzny | `layers/clipPlaneModel.ts` — `resolveClipPlaneFrame(clip, bounds)` liczy center/normal/planeConstant z bounds domeny |
| Podgląd draftu | `crossSectionWorkspace.ts` (`CrossSectionFramePreview` → `crossSectionFramePreviewToClip`) podpięty w `hooks/useViewport3DSceneModel.ts` |

### 2.2 Box-trim — kontrakt jest, implementacji brak

W generowanych typach istnieje:

```ts
TrimVisualizationState {
  enabled: boolean;
  axes: { x: {enabled, min_percent, max_percent}, y: ..., z: ... };
}
TrimVisualizationPatch { enabled?, axes?: { x?: {enabled?, min_percent?, max_percent?}, ... } }
```

oraz `VisualizationStatePatch.trim` i `VisualizationStateResource.trim`. Backend publikuje ten
stan. Frontend natomiast ma **stub**: submenu „3D trim" w `ribbonContributions.tsx`
(`buildMeshViewMenu`) oraz `ribbonTabViews.tsx` zawiera twarde `checked: false`,
suwaki `disabled: true` — żaden element nie czyta `trim` z zasobu ani nie wysyła patchy.

### 2.3 Zasób przekroju 2D (FMCS)

`kernel/resources/crossSectionResources.ts` + `kernel/api/codecs/crossSectionCodec.ts`:
binarny zasób `GET /v2/sessions/current/meshing/meshes/shared-domain/cross-section`
(poligony przekroju siatki FEM, wireframe, `parent_element_ids`, punkty przecięć).
Obecnie używany do markerów na płaszczyźnie clip. **Nie jest** wykorzystywany do wypełniania
(capowania) przekroju 3D.

### 2.4 Zidentyfikowane luki (blokery dla pełnego cutaway)

1. **Własny shader ignoruje clip.** `viewport3dScalarSurfaceShader.ts` tworzy `ShaderMaterial`
   bez `clipping: true` i bez chunków `#include <clipping_planes_*>`. Three.js nie wstrzykuje
   obsługi clipping planes do własnego GLSL — kolorowane skalarnie powierzchnie
   (`MeshPartLayer`, `FallbackTopologyMeshLayer`) przechodzą przez płaszczyznę clip nietknięte.
   To jest główny błąd obecnego mechanizmu.
2. **Globalne `renderer.clippingPlanes` tną wszystko**, także rzeczy, których tnąć nie chcemy
   (obrys płaszczyzny, markery, view cube, HUD orientacji, dimension frames). Obecnie ratuje to
   tylko `depthTest=false` i renderOrder nakładek — kruche.
3. **Brak box-trim w runtime.** Nawet po podpięciu stubu trim nic nie renderuje — `trim` nie jest
   mapowany na żadną płaszczyznę.
4. **Brak capów (zaślepek przekroju).** Po wycięciu widać pustkę wewnątrz bryły (shellowa
   geometria surface). COMSOL-owy efekt wymaga zaślepki na płaszczyźnie cięcia.
5. **Picking nie respektuje clip/trim.** Raycast trafia geometrię odrzuconą wizualnie — klik w
   „niewidoczny" element wybiera obiekt.
6. **Wektory (line segments) i instancje FDM** działają z globalnymi płaszczyznami, ale glyphy
   są cięte ostro w połowie kreski; brak decyzji produktowej (tnij po anchorze vs. całościowo).
7. **Brak gizmo 3D** do przeciągania płaszczyzny myszką w scenie (sterowanie wyłącznie
   suwakami ribbonu).

---

## 3. Decyzje architektoniczne

### D1. Dwa niezależne, komplementarne mechanizmy

- **`clip`** — pojedyncza płaszczyzna (istniejąca): szybkie „otwórz model", baza dla planar
  monitorów i przekroju 2D. Bez zmian semantycznych.
- **`trim`** — box-trim 6 półpłaszczyzn osiowych (percenty bounds): precyzyjne wycinanie
  narożnika/połówki/warstwy. **Używamy istniejącego kontraktu OpenAPI** — zero zmian w schemacie
  w fazach 1–4.

Oba naraz mogą być aktywne (intersekcja). Stan żyje wyłącznie w
`visualization/state` (revision-driven, optimistic patches przez istniejący sync) — żadnych
lokalnych store'ów równoległych (state hygiene).

### D2. Materiałowe clipping zamiast globalnego renderer clipping

Przejście z `renderer.clippingPlanes` na `material.clippingPlanes` przy
`gl.localClippingEnabled = true` ustawianym raz na poziomie canvasa:

- warstwy **cięte**: topology/mesh parts, FDM cuboids, vector field, points, region overlays,
  primitive objects,
- warstwy **niecięte**: obrys płaszczyzny clip, markery, view cube, orientation HUD, dimension
  frames, grid podłogi, planar monitor previews.

Korzyść: znika ryzyko przypadkowego ścięcia nakładek, znika save/restore stanu renderera w
efekcie unmount (`applyRendererClipping`/`restoreRendererClipping`), umożliwia późniejsze
per-target wyłączenia (np. „airbox niepodcinany").

Płaszczyzny są budowane centralnie w nowym module `layers/clippingModel.ts`:

```ts
resolveActiveClippingPlanes({ clip, trim, bounds }): Plane[] | null
```

— jedna źródło prawdy dla wszystkich warstw (max 7 płaszczyzn: 1 clip + 6 trim; WebGL limity
są bezpieczne, three.js wspiera co najmniej 8 w standardowym pipeline).

### D3. Naprawa własnego shaderu (warunek konieczny)

`createScalarSurfaceShaderMaterial` musi otrzymać `clipping: true` oraz w GLSL:

- vertex: `#include <clipping_planes_pars_vertex>` + `#include <clipping_planes_vertex>`,
- fragment: `#include <clipping_planes_pars_fragment>` + `#include <clipping_planes_fragment>`
  (odrzucenie fragmentu),
- przy każdej zmianie liczby płaszczyzn three.js rekompiluje program (zmiana
  `NUM_CLIPPING_PLANES`) — trzeba to zrobić w istniejącym mechanizmie aktualizacji materiału
  (`updateScalarSurfaceShaderMaterial`), z invalidation przez `useBatchedInvalidate`.

### D4. Capy przekroju — dwuetapowo

- **Faza MVP:** brak dedykowanych capów; użytkownik widzi shell + istniejącą półprzezroczystą
  płaszczyznę clip jako wizualną referencję cięcia. Dla FDM wnętrze i tak jest widoczne
  (instancje komórek / punkty).
- **Faza docelowa (cap):** triangulacja poligonów z zasobu FMCS (FEM) w cap-mesh na płaszczyźnie
  clip, kolorowany tym samym polem skalarnym; dla trim — capy dopiero po rozszerzeniu zasobu
  przekroju o box-trim (backend, osobna decyzja). Alternatywa stencil-buffer (COMSOL-style
  solid cap) jest droższa i wymaga render pass ownershipu — odkładana.

### D5. Picking zgodny z wizualizacją

Filtracja wyników raycastu po stronie odrzuconej płaszczyzn (`plane.distanceToPoint(p) < 0`
→ skip) w `viewport3DPickPriority` / handlerach selekcji partii i regionów. Bez tego user
klika w niewidoczne elementy.

### D6. Sterowanie

- Faza 1–2: ribbon (rozbudowa istniejącego menu Clip + podpięcie submenu „3D trim") i Inspector
  (panel Viewport/Display) — przez `RIBBON_VISUALIZATION_PATCH_STATE_COMMAND` /
  `visualizationStateCommandInput({ trim: {...} })`.
- Faza 5: drag-gizmo płaszczyzny clip w scenie (uchwyt na obrysie, translacja wzdłuż normalnej,
  flip). Trim zostaje na suwakach (6 DOF gizmo to antywzorzec UX).

### D7. FDM vs FEM — capability guard, nie fork UI

- **FEM:** clipping działa na `TopologyMeshLayer`/`MeshPartLayer` (BufferGeometry) — materiałowe
  płaszczyzny wystarczą.
- **FDM:** `FdmCuboidLayer` (InstancedMesh + MeshBasicMaterial) — obsługa clipping jest wbudowana
  w standardowe materiały; instancje są cięte per-fragment, poprawnie.
- Warstwy wspólne (wektory, punkty, regiony) — jedno miejsce podpinania płaszczyzn
  (`viewport3DLayerSettings` / pass plan), bez duplikacji drzew UI.

---

## 4. Fazy implementacji

> Każda faza kończy się zielonym: `pnpm --dir apps/control-room typecheck && lint && test`
> oraz (fazy dotykające canvasa) smoke Playwright: canvas widoczny, `gl.isContextLost() === false`,
> drawing buffer > 0 (wymóg AGENTS.md dla viewport work).

### Faza 0 — Fundament: centralny model płaszczyzn + naprawa shaderu *(blokery)*

**Pliki:**

- Nowy: `modules/viewport-3d/layers/clippingModel.ts` (+ test)
  - `resolveActiveClippingPlanes({ clip, trim, bounds })` — łączy `clip` (reuse logiki
    `resolveClipPlaneFrame`) i `trim` (percenty → world coords na osiach) w tablicę `Plane[]`;
    `null` gdy nic nieaktywne.
- Zmiana: `viewport3dScalarSurfaceShader.ts` — `clipping: true` + chunki GLSL (D3); test
  jednostkowy assertujący obecność chunków i flagi.
- Zmiana: `Viewport3DCanvas.tsx` — `gl.localClippingEnabled = true` raz przy konfiguracji
  renderera (zamiast per-layer toggle w `ClipPlaneLayer`).
- Zmiana: `ClipPlaneLayer.tsx` — usunięcie globalnego `renderer.clippingPlanes`; warstwa
  nadal rysuje wizualizację płaszczyzny; materiały sceny dostają płaszczyzny z modelu.

**Weryfikacja:** test shadera; smoke: włączenie clip pokazuje przekrój również na
powierzchni barwionej skalarnie (regresja z pkt 2.4.1).

### Faza 1 — Podpięcie płaszczyzn do warstw ciętych/nieciętych

**Pliki:**

- `layers/Viewport3DScene.tsx` — propagacja `planes: Plane[] | null` do stacków warstw.
- `layers/TopologyMeshLayer.tsx`, `MeshPartLayer.tsx`, `FallbackTopologyMeshLayer.tsx`,
  `FdmCuboidLayer.tsx`, `VectorFieldLayer.tsx`, `PrimitiveObjectLayer.tsx`,
  `RegionOverlayLayer.tsx`, `RegionMeshOverlayLayer.tsx`, `FrozenSpinsOverlay.tsx` —
  `material.clippingPlanes = planes` (lub `[]`), update w `useEffect` z dispose-safe restore;
  wydajnościowo: ta sama referencja tablicy między renderami (memo w scene model).
- Nakładki niecięte (`BoundsLayers`, `DimensionFrameLayer`, `OrientationHudLayer`,
  `ViewCube3DBox`, `PlanarMonitorFramePreviewLayer`, obrys clip) — jawnie `[]`.
- `hooks/useViewport3DSceneModel.ts` — memo `resolveActiveClippingPlanes` z `clip` +
  `trim` z `visualizationState` + bounds.

**Testy:** `viewport3DLayerPassInputs.test.ts` / `viewport3DLayerSettings.test.ts` — kontrakt
propagacji; test że nakładki nigdy nie dostają płaszczyzn.

### Faza 2 — Box-trim: podpięcie kontraktu `trim`

**Pliki:**

- `ribbonContributions.tsx` + `ribbonTabViews.tsx` — usunięcie stubu; checkboxy/slidery czytają
  `trim` z `context.visualizationState`, wysyłają
  `visualizationStateCommandInput({ trim: { enabled, axes: { x: { enabled, min_percent, max_percent } } } })`;
  akcje Reset X/Y/Z/All.
- Inspector: panel Display/Viewport — te same patche (jeden właściciel stanu: serwer).
- `clippingModel.ts` — percenty → współrzędne światowe (min + size·pct), obsługa
  `min_percent > max_percent` (normalizacja lub blokada walidacyjna — preferencja: blokada z
  komunikatem, bez cichej zamiany stron).
- Opcjonalny quick-preset w menu: „Cut corner", „Half ±X/±Y/±Z", „Slab middle 50%" — czyste
  patche presetowe.

**Testy:** round-trip patch→zasób (mock API), stabilność Inspectora podczas optimistic update
(zgodnie z regułą inspektor-stability: brak globalnego pending-dim, brak remountów), test
klampowania percentów.

### Faza 3 — Picking zgodny z cięciem

**Pliki:**

- `viewport3DPickPriority.ts`, handlery `onSelectPart`/`onSelectRegion`/`onSelectFdmCell` /
  inspect (`viewport3dInspect.ts`) — filtr `distanceToPoint >= 0` dla wszystkich aktywnych
  płaszczyzn.
- Wspólny helper w `clippingModel.ts`: `isPointVisibleAfterClipping(point, planes)`.

**Testy:** jednostkowe na helperze + test integracyjny selekcji z aktywnym clipem.

### Faza 4 — Jakość przekroju: cap MVP + markery

- Cap dla FEM: triangulacja poligonów FMCS (już dekodowanych w `crossSectionCodec`) →
  `CapMeshLayer` renderowany na płaszczyźnie clip, kolor z aktywnego pola skalarnego
  (`parent_element_ids` → jakość/pole jak w planie cross-section). Renderowany tylko gdy clip
  aktywny i zasób dostępny; demand-render, dispose na unmount.
- Markery przecięć (istniejące) — weryfikacja czytelności przy trim (markery tylko od clip).
- Dokumentacja ograniczenia: trim bez capów do czasu rozszerzenia zasobu przekroju (wpis w
  sekcji „Ograniczenia" + degraded-state label w UI, zgodnie z honesty doctrine).

### Faza 5 — Interakcja 3D (drag-gizmo clip)

- Uchwyt drag na obrysie płaszczyzny (`ClipPlaneLayer`): pointer drag → translacja wzdłuż
  normalnej → throttlowany patch `position_percent` (optimistic sync już istnieje);
  dblclick → flip; Shift+drag → rotacja frame preview (jeśli utrzymujemy rotationDegrees).
- Gizmo wyłączne dla `clip`; trim pozostaje panelowy.
- Audit: brak interval polling, invalidate tylko podczas dragu (demand-render discipline).

### Faza 6 — Smoke E2E + dokumentacja

- Playwright: sekwencja `clip on → przesunięcie → trim corner on → screenshot commit` (analogia
  do reguły FDM airbox qualification: osobne, komitowalne kadry; zakaz akceptacji kadru z
  częściowym stanem).
- Aktualizacja `docs/specs/frontend-v2/05-viewport-architecture.md` (sekcja clipping/trim) i
  spec endpoint reference, jeśli doszło do czegoś ponad istniejący schemat.

---

## 5. Kontrakty API

**Fazy 0–5: zero zmian schematu OpenAPI.** `clip` i `trim` już istnieją w
`VisualizationStatePatch`/`VisualizationStateResource`. Frontend konsumuje i patchuje
wyłącznie istniejące pola przez istniejącą komendę ribbonową.

**Ewentualne przyszłe rozszerzenia (osobna decyzja, wg `resource-first-api-check`):**
- cap/poligony przekroju dla box-trim (rozszerzenie parametrów zasobu cross-section),
- per-target clip exclusion (np. `trim.exempt_targets`) — tylko jeśli pojawi się realny use case;
  nie projektować na zapas.

---

## 6. Testy — macierz

| Klasa | Co |
|---|---|
| Jednostkowe `clippingModel` | kolejność/zwrot płaszczyzn, percenty→world, clip+trim intersekcja, brak płaszczyzn gdy off |
| Jednostkowe shader | `clipping: true`, chunki GLSL, rekompilacja przy zmianie liczby płaszczyzn |
| Kontrakt warstw | warstwy cięte dostają planes; nakładki zawsze `[]`; brak leaków po unmount |
| Ribbon/Inspector | patche trim/clip, stany disabled, reset, optimistic ack |
| Picking | odrzucone fragmenty nieklikalne |
| Performance | brak rebuildu geometrii przy ruchu suwaka (tylko uniform/material update), brak alokacji per-frame, demand-render quiet when idle |
| Smoke Playwright | canvas alive, context not lost, buffer > 0, kadry clip/trim commitowane osobno |

---

## 7. Ryzyka i ograniczenia

1. **Rekompilacja shaderów** przy zmianie liczby aktywnych płaszczyzn (0↔1↔…): first-frame hitch.
   Mitigacja: stała górna liczba płaszczyzn w materiale (rezerwacja slotów) zamiast dynamicznej
   tablicy — decyzja w fazie 1 na podstawie pomiaru.
2. **Capy dla trim wymagają backendu** — do tego czasu trim pokazuje shell bez zaślepki
   (jawny degraded-state w UI).
3. **Glyphy wektorów cięte ostrym brzegiem** — akceptowalne dla MVP; ewentualna mitigacja:
   CPU-side filter anchorów przy budowaniu segmentów (worker już istnieje w pipeline glyphów).
4. **Z-order transparentów** przy półprzezroczystych powierzchniach + cap — wymaga renderOrder
   review w fazie 4.
5. **Zgodność wieloklientowa** — stan na serwerze; dwóch klientów dzieli clip/trim (jak camera).
   Świadoma decyzja, spójna z modelem session-wide visualization state.

---

## 8. Definition of Done

- [ ] Skalarne powierzchnie (custom shader) podlegają clip/trim (naprawa luki 2.4.1).
- [ ] Trim działa end-to-end: ribbon + inspector → patch → zasób → render, z resetami.
- [ ] Nakładki (view cube, HUD, obrysy, dimension frames) nigdy nie są cięte.
- [ ] Picking nie wybiera geometrii odrzuconej przez cięcie.
- [ ] Cap MVP dla FEM clip (lub jawny, oznaczony degraded-state).
- [ ] typecheck/lint/test zielone; smoke Playwright viewport zielone.
- [ ] Spec viewport architecture zaktualizowany; brak rozjazdów z OpenAPI.
- [ ] Żaden plik źródłowy nie przekracza ~1000 linii (split zamiast rozrostu).
