# Analiza modu eigen w 3D: coolwarm i blokada tekstury magnetyzacji — plan implementacji

> **Dla agentów wykonawczych:** wymagane jest użycie `subagent-driven-development` albo `executing-plans`; kroki są atomowe i oznaczone checkboxami.

**Cel:** Renderować rzeczywiste pole modu eigen (w tym `Imag`) w 3D z paletą `coolwarm`, bez zastępowania go statyczną teksturą magnetyzacji, oraz potwierdzić wynik na rzeczywistym artefakcie warstwy z dziurą.

**Architektura:** Nie zmieniamy identyfikatorów API ani danych artefaktu. Dodajemy wyłącznie jawny kontrakt renderowania: ilość analityczna `analysis:eigen:*`/`analysis:frequency-response:*` może zasilać żądany renderowalny kanał `m`; dopasowanie buforów, colorbara i sceny korzysta z jednej funkcji. Aktywny overlay eigenmode ma domyślnie `coolwarm`, a fallback `magnetizationTexturePreview` jest wyłączony dla overlayu. Sam field eigenmode pozostaje fizycznie globalnym polem domeny; istniejące targety `object:<id>` nadal sterują widocznością bazowych obiektów, ale ta poprawka nie udaje osobnego per-object storage dla jednego pola eigenmode.

**Technologie:** TypeScript, React, Three.js/WebGL, Zustand/external stores, Vitest, Playwright, Next.js 16.

## Ograniczenia globalne

- Nie zmieniać publicznych identyfikatorów API ani kontraktu `ProblemIR`.
- Nie regenerować ani nie przebudowywać siatki podczas przejścia do `Study`/`Results`.
- Wszystkie klasy CSS pozostają z prefiksem `fm-`; ta poprawka nie dodaje CSS.
- Testy viewportu muszą sprawdzać widoczny canvas, brak utraty kontekstu WebGL i niezerowy drawing buffer.
- Zmiany kodu wykonuje się przez `apply_patch`; nie modyfikować niezwiązanych lokalnych zmian.
- Raport i plan są po polsku; identyfikatory i komentarze w kodzie pozostają po angielsku.

---

## Mapa plików

| Plik | Odpowiedzialność w tej zmianie |
|---|---|
| `apps/control-room/src/kernel/api/quantityIds.ts` | Wspólny predykat zgodności renderowalnych ilości. |
| `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts` | Dopasowanie bufora pola do żądanej ilości. |
| `apps/control-room/src/modules/viewport-3d/model/viewport3DColorbarPlan.ts` | Dopasowanie bufora do żądania colorbara. |
| `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx` | Dopasowanie buforów scalar oraz wyłączenie tekstury magnetyzacji dla overlayu. |
| `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts` | Użycie tego samego predykatu w modelu sceny. |
| `apps/control-room/src/kernel/visualization/analysisFieldOverlayCommandContributions.ts` | Domyślne `coolwarm` i brak wektorów dla eigen mode. |
| odpowiadające pliki `*.test.ts(x)` | Testy kontraktu ilości, fallbacku i domyślnego wyglądu. |
| `docs/superpowers/plans/2026-08-14-analysis-mode-coolwarm-viewport-fallback.md` | Ten plan i ślad wykonania. |

## Task 1: Zabezpieczyć kontrakt ilości renderowalnych

**Pliki:**
- Modify: `apps/control-room/src/kernel/api/quantityIds.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DColorbarPlan.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: istniejące testy tych trzech modeli oraz `quantityIds`.

**Interfejs:** Dodać eksportowaną funkcję:

```ts
export function sameRenderableFieldQuantityId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftId = normalizeQuantityIdOrDefault(left);
  const rightId = normalizeQuantityIdOrDefault(right);
  return (
    leftId === rightId ||
    (leftId === "m" && isAnalysisFieldQuantityId(rightId)) ||
    (rightId === "m" && isAnalysisFieldQuantityId(leftId))
  );
}
```

- [x] **Krok 1: Napisać testy czerwone.** Sprawdzić `analysis:eigen:sample-0000:mode-0000` względem `m` jako zgodne, identyczne ID jako zgodne i `H_eff` względem `m` jako niezgodne. Dodać przypadki bufora pola i colorbara.
- [x] **Krok 2: Uruchomić testy.** Testy wykonano przez lokalny runtime Vitest, ponieważ `pnpm` nie jest dostępny w tym checkoutcie.
- [x] **Krok 3: Wdrożyć minimalną funkcję i podmienić literalne porównania.** W trzech modelach użyto `sameRenderableFieldQuantityId`; `sameViewport3DQuantityId` deleguje do tego predykatu.
- [x] **Krok 4: Uruchomić testy ponownie.** Dopasowanie zwykłych ilości pozostało bez zmian.

## Task 2: Usunąć statyczną teksturę magnetyzacji z aktywnego overlayu

**Pliki:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.test.tsx` albo istniejący test helpera warstwy.

**Interfejs:** Warstwa wylicza `magnetizationFallbackColor` jako `null`, gdy `fieldModel?.modeOverlay` jest aktywny; dla zwykłej sceny zachowuje dotychczasowy kolor preview.

- [x] **Krok 1: Napisać test czerwony.** Dla aktywnego overlayu potwierdzono brak koloru tekstury magnetyzacji; dla sceny bez overlayu zachowano kolor preview.
- [x] **Krok 2: Uruchomić test warstwy.** Testy warstwy wykonano przez lokalny runtime Vitest.
- [x] **Krok 3: Wprowadzić minimalną zmianę.** `MeshPartLayer` przekazuje `null` dla aktywnego overlayu; zwykłe pole `m` zachowuje fallback.
- [x] **Krok 4: Uruchomić test ponownie.** Test nowego przypadku i istniejące testy materiału przechodzą.

## Task 3: Ustawić prawdziwe domyślne widoków eigen mode

**Pliki:**
- Modify: `apps/control-room/src/kernel/visualization/analysisFieldOverlayCommandContributions.ts`
- Test: istniejący `analysisFieldOverlayCommandContributions.test.ts`.

**Interfejs:** Dla `source === "eigen-mode"` domyślna konfiguracja overlayu to `surfaceColorSource: "colormap"`, `scalarColorPalette: "coolwarm"`, `vectorsVisible: false`; domyślne zachowanie frequency-response pozostaje kompatybilne wstecz.

- [x] **Krok 1: Napisać test czerwony.** Test `plot-mode-3d-imag` obejmuje `query.view === "imag"` oraz wygląd eigenmode.
- [x] **Krok 2: Uruchomić test.** Testy komend wykonano przez lokalny runtime Vitest.
- [x] **Krok 3: Wdrożyć dwa jawne defaulty.** Eigenmode używa `colormap` + `coolwarm` i ukrywa wektory; response zachowuje dotychczasowy default.
- [x] **Krok 4: Uruchomić test ponownie.** Testy komend i normalizacji appearance przechodzą.

## Task 4: Weryfikacja end-to-end w rzeczywistym UI

**Artefakt wejściowy:** `.fullmag/reports/fem-periodic-antidot-relax-eigenmodes/nearest-cache-v2-2ghz-realui1` w worktree targetowym, bez generowania nowej siatki.

- [x] **Krok 1: Uruchomić focused testy, typecheck i lint.** 13 plików testowych, 525 testów przechodzi. Lint nie zgłasza nowych błędów w tej zmianie; pozostają trzy wcześniejsze błędy `preserve-manual-memoization` w innych memoizacjach sceny. Typecheck jest zablokowany przez niekompletne `node_modules` checkoutu.
- [ ] **Krok 2: Uruchomić API/UI smoke.** Smoke otworzył Results, ale fixture nie publikuje aktualnych domen/mesh metadata i viewport zatrzymał się fail-closed na `FDM DomainMeta is missing its structured grid descriptor`.
- [ ] **Krok 3: Sprawdzić kontrakty runtime.** Nie można uznać za wykonane bez świeżego artefaktu z aktualną tożsamością siatki.
- [ ] **Krok 4: Zrobić dwa screenshoty.** Wymaga świeżego artefaktu; screenshot fixture dokumentuje tylko blokadę viewportu.
- [x] **Krok 5: Sprawdzić regresję zwykłego pola.** Test helpera zachowuje `magnetizationTexturePreview` bez aktywnego overlayu.

## Kryteria ukończenia

1. Testy kontraktów ilości, modeli viewportu, warstwy i komend przechodzą.
2. W realnym artefakcie eigen mode `Imag` jest renderowany z bufora analitycznego, nie z tekstury `m`.
3. Inspector pokazuje i stosuje `coolwarm`; przełączenie `Imag` ↔ `Real` zmienia żądany komponent i wynik shader/material.
4. Canvas WebGL jest widoczny, ma niezerowy buffer i nie traci kontekstu.
5. Zwykłe pole magnetyzacji i frequency-response nie tracą dotychczasowego fallbacku ani kontraktu.
6. Nie powstała żadna nowa siatka ani zmiana artefaktu wejściowego.

## Wynik audytu per-object

- Bazowy target per obiekt jest zaimplementowany: `Visualization` pod każdym obiektem, `object:<id>`, inspector, ribbon i registry override.
- `Mode visualization` jest osobnym overlayem analitycznym. `visualizationTargetId` zawiera obiekt, ale `AnalysisFieldOverlayController` przechowuje jeden snapshot bez `objectId`; dlatego wybór pola eigenmode pozostaje globalny, a nie osobnym payloadem dla każdego obiektu.
- Nie rozszerzamy w tym zadaniu API o wielo-overlayowy model. Rozszerzenie wymagałoby osobnej decyzji: czy globalny eigenvector ma być tylko filtrowany do wybranego obiektu, czy backend ma publikować osobne pola scoped.

## Samokontrola planu

- Pokrycie wymagań: kontrakt danych (Task 1), fallback tekstury (Task 2), palette/query (Task 3), produkcyjny dowód przeglądarkowy (Task 4).
- Placeholder scan: brak `TBD`, `TODO` i nieokreślonych funkcji w krokach.
- Spójność typów: `sameRenderableFieldQuantityId` jest jedynym nowym interfejsem współdzielonym przez trzy modele; `modeOverlay` jest istniejącym polem `Viewport3DFieldRenderModel`.
