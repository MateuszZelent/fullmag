# Inspector katalogu wyników stage anteny — walidacja 2026-09-21

## Zakres

Panel `AntennaCompositionPanel` dostał osobny odczyt katalogu wyników
antenowego stage. Nie pobiera on binarnych tablic pola ani FFT. Korzysta z
zasobu v2:

```text
GET /v2/sessions/current/data/antenna/stages/{stage_id}/output-catalog
```

Resolver węzłów `solution`, `projection`, `drive` i `spectrum` przekazuje
`stageId` razem z `solutionId` i `spectrumOutputId`. Dzięki temu każdy z tych
Inspectorów może pokazać ten sam, zgodny z aktualnym stage, stan publikacji.

## Zachowanie UI

Poza istniejącym wynikiem pola lub widmem panel pokazuje:

- `Stage catalog result`: `ready`, `loading`, `stale`, `error`, `missing` albo
  `not attached`;
- status stage i jego rewizję;
- opublikowane `output_id` oraz listę `quantity_ids`;
- asset IDs, manifest refs oraz informację, czy output został użyty ponownie,
  czy opublikowany jako nowy;
- digest katalogu;
- komunikat diagnostyczny, jeśli backend go opublikował;
- treść błędu zasobu, bez maskowania go jako brak wyniku.

Stan badge grupy nadal pochodzi ze zgodnego zasobu pola albo widma. Katalog
stage nie jest używany do udawania gotowego pola, gdy brakuje właściwego
`AntennaFieldSolutionResource`.

## Weryfikacja wykonana

- `pnpm --dir apps/control-room exec vitest run
  src/modules/inspector/panels/antenna/AntennaCompositionPanels.test.ts
  src/modules/inspector/panels/antenna/AntennaCompositionPanels.dom.test.tsx`:
  **6/6**;
- `pnpm --dir apps/control-room exec vitest run`: **6567/6572** testów
  zaliczonych, **4** istniejące regresje poza zmianą w:
  `src/modules/inspector/inspectorCssContract.test.ts`,
  `src/modules/viewport-3d/viewport3dGeometryColors.test.ts`,
  `src/modules/viewport-3d/viewport3dRenderModel.test.ts` oraz
  `src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`;
- ESLint trzech zmienionych plików: **OK**;
- lokalny `pnpm exec react-doctor --verbose --scope changed`: **OK**, wynik
  `91/100`, **No issues found** po wydzieleniu helperów z pliku komponentu;
- `git diff --check`: **OK**;
- `node --test apps/control-room/scripts/lib/antenna-authoring-browser.test.mjs`:
  **3/3**, kontrakt sceny anteny i stabilne ID węzłów Explorera;
- dodano `smoke:antenna-authoring-ui`, który wykonuje realny Playwright
  przebieg `create → Explorer → conductor/port/solution → ready metadata` z
  kontrolowanym thin-metadata fixture oraz sprawdzeniem canvas/WebGL. Próba
  uruchomienia 2026-09-21 nie wystartowała: lokalny API na `127.0.0.1:3100`
  był nieaktywny, a repozytoryjny `just control-room-v2` zatrzymał się na
  ochronie storage, ponieważ worktree zawiera realne katalogi
  `node_modules` wymagające jawnej migracji. Nie przenoszono ani nie usuwano
  tych danych;
- typecheck Control Room zatrzymuje się na trzech znanych błędach nullability
  w `src/modules/field-map/FieldMapModule.tsx:588-591`; w zmienionych plikach
  nie zgłoszono błędu;
- nie uruchamiano kompilacji testów Rust, browser smoke ani dowodu
  kwalifikacji FEM/FDM GPU.

## Pozostaje otwarte

Ten krok domyka prezentację metadanych katalogu w Inspectorze i dodaje
reproducible smoke harness, ale nie jest dowodem pełnego przepływu
`create → solve → inspect → stale`: smoke wymaga przygotowanego API/frontendu
i obecnie ma status **not run — storage/environment blocker**. Nadal trzeba
wykonać go przeciwko działającej usłudze, dodać Relax/Run, export/reload,
waveform/reuse, stale/geometry oraz osobny lifecycle field-map, a następnie
połączyć stage z natywnym polem FDM/FEM zgodnie z T16.
