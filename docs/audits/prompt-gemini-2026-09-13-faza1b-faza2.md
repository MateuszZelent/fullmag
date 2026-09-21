# Zadanie dla Gemini — FullMag: domknięcie Fazy 1 (LR-03 pole główne) + Faza 2 (LR-01 staged reveal)

## 0. Gdzie pracujesz i jak weryfikujesz punkt startu

**Repozytorium:** `C:\git\fullmag\fullmag`
**Gałąź:** `master`, bezpośrednio. Nie twórz gałęzi, nie przełączaj HEAD, nie pracuj w `C:\git\fullmag\worktrees\*`.
**Oczekiwany commit bazowy:** `900ebad94b43f81f449d74bc45d36dede9137582`

```bash
git rev-parse HEAD
git status --porcelain
```

- `HEAD` ≠ `900ebad94b43f81f449d74bc45d36dede9137582` → **zatrzymaj się i zgłoś**.
- Niezacommitowane zmiany w `apps/control-room/` → **zatrzymaj się i zgłoś**.

Dodatkowa kontrola kotwic — numery linii w tym zadaniu są zweryfikowane na tym commicie:

```bash
git show --stat HEAD | head -20
wc -c apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx   # oczekiwane: 71559
```

Jeśli `Viewport3DScene.tsx` ma inny rozmiar — numery linii w części B są nieaktualne, znajdź symbole po nazwie i **odnotuj to w raporcie**.

**Nie normalizuj końców linii.** Repozytorium ma mieszane EOL. `git diff --check` musi przechodzić.

---

## 1. Kontekst — co się właśnie wydarzyło

Poprzedni commit (`900ebad`, amend commita `e5186a9`) zrealizował Fazę 1: LR-02, LR-03, LR-04, LR-14. Przegląd kodu potwierdził, że matcher tożsamości, retencja w kolekcji pól, rozdzielenie `buffer: null` / `fresh: false` oraz liczniki diagnostyczne są zrobione poprawnie, a `canRetainViewport3DScalarUploadBuffer` nie został poluzowany.

Przegląd wykrył **jedną lukę** i **jedno ryzyko procesowe**:

1. **LR-03 domknięto tylko na ścieżce kolekcji.** Ścieżka **pola głównego** w `useViewport3DSceneModel.ts` nadal gaśnie przy `status === "ready"` z niezgodnym identity. To jest druga połowa ustalenia R1, opisana w audycie Codeksa jako „Podobna granica występuje dla pola głównego".
2. Poprzedni commit został **zamendowany po zaraportowaniu wyniku**, a pliki edytowane po pierwszym commicie nie mają dowodu przejścia bramek. Dlatego część A zaczyna się od ponownego uruchomienia pełnego zestawu bramek.

## 2. Obowiązkowa lektura

1. `docs/audits/2026-09-13-live-refresh-remediation-masterplan.md` — dokument nadrzędny. Twoje zadanie: reszta **Fazy 1** (§6) oraz cała **Faza 2** (§6).
2. `docs/audits/2026-09-11-active-simulation-render-synchronization-audit.md` — sekcja **R1** (§5), akapit o polu głównym; sekcja **R5** (§5).
3. `docs/audits/2026-09-11-viewport-3d-live-refresh-flicker-audit.md` — **VPF-001**, pełny opis mechanizmu staged reveal wraz z cytatami kodu.
4. `docs/audits/2026-09-11-live-refresh-audits-comparison.md` — **§4.1 „Reset etapów: korekta mojego R5"**. Zawiera zastrzeżenia, których musisz przestrzegać: samo przeniesienie resetu do efektu albo opóźnienie o 150 ms **nie wystarczy** i może chwilowo pokazać dane niezgodne z nową domeną.
5. `AGENTS.md` w katalogu głównym.

Mapowanie: `LR-01` = `VPF-001` = `R5`; `LR-03` = `R1`.

## 3. Reguły egzekwowane przez CI

Zero `any` / `as any`, zero nowych `@ts-expect-error`, zero `TODO`/`FIXME`/`HACK`, zero `console.log`/`console.debug`, zakaz importów między modułami z pominięciem `public.ts`, `eslint --max-warnings=0`. Każda zmiana zachowania ma mieć test.

---

# CZĘŚĆ A — domknięcie Fazy 1

## A1. Weryfikacja stanu odziedziczonego (rób to najpierw)

Uruchom pełny zestaw bramek **przed** jakąkolwiek edycją, żeby ustalić, czy `900ebad` jest zielony:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d src/kernel/resources src/kernel/api
```

Wynik każdej bramki zapisz — trafi do raportu jako „stan przed". Jeżeli którakolwiek jest czerwona **na nietkniętym `900ebad`**, napraw to jako pierwszą rzecz i opisz osobno; nie mieszaj tej naprawy z resztą zadania.

## A2. LR-03 na ścieżce pola głównego

**Plik:** `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`

Kotwice na `900ebad`:
- `incomingFieldVectorEnvelope` — **linia 4437**
- `incomingFieldVectorReady` — **linia 4460**
- `previousFieldVectorCompatible` — **linia 4468**
- `displayedFieldVectorEnvelope` — **linia 4476**
- `displayedFieldVector` — **linia 4481**
- `fieldVectorDisplayedRevision` — **linia 4490**

Stan obecny:

```ts
const previousFieldVectorCompatible = Boolean(
  fieldVector.status !== "ready" && incomingFieldVectorEnvelope &&
    resolveViewport3DFieldVectorIdentityMatch(incomingFieldVectorEnvelope, primaryFieldRequest).matches,
);
const displayedFieldVectorEnvelope = resolveViewport3DDisplayedLiveValue(
  incomingFieldVectorReady ? incomingFieldVectorEnvelope : null,
  previousFieldVectorCompatible ? incomingFieldVectorEnvelope : null,
  fieldVector.status !== "ready",
);
```

`resolveViewport3DDisplayedLiveValue` to `holdActive ? previousDisplayed : incoming`. Przy `status === "ready"` i **niezgodnym** identity oba argumenty są `null` ⇒ `displayedFieldVector === null` ⇒ warstwa pola głównego gaśnie. Dokładnie ta sama klasa błędu, którą naprawiłeś w kolekcji.

**Do zrobienia:**

1. Wprowadź **realną pamięć ostatniej zgodnej klatki** pola głównego. `resolveViewport3DDisplayedLiveValue` jest funkcją czystą bez pamięci — dziś „poprzednią" klatką jest ten sam `incomingFieldVectorEnvelope`, który przy `stale` wciąż niesie stary payload z cache. To działa dla `stale`, ale nie dla `ready + mismatch`, gdzie envelope jest już nowy i zły.
   Użyj `useRef` trzymającego ostatni envelope, który przeszedł `resolveViewport3DFieldVectorIdentityMatch` względem **bieżącego** `primaryFieldRequest`. Aktualizuj ref wyłącznie wtedy, gdy przychodzący envelope jest zgodny.
2. Przy `status === "ready"` i niezgodnym envelope: pokaż zawartość refa, o ile nadal przechodzi matcher względem bieżącego żądania. Jeżeli nie przechodzi — `null` jest poprawnym wynikiem (zmiana domeny, remesh, zmiana sesji, usunięcie targetu).
3. **Nie osłabiaj matchera.** Retencja pola głównego ma używać dokładnie tego samego `resolveViewport3DFieldVectorIdentityMatch`, bez żadnego luźniejszego wariantu.
4. Odrzucenie retencji na tej ścieżce raportuj przez `tracker.recordRetentionRejection(reason)` — tak samo jak w kolekcji.
5. `fieldVectorDisplayedRevision` ma odzwierciedlać rewizję **faktycznie pokazanej** klatki, także gdy pochodzi z refa. Dziś liczy się z `fieldVectorPreparedRevision`, czyli z rewizji żądania/payloadu — przy retencji to będzie **zła** liczba. Rewizję trzymaj razem z envelope'em w refie.
6. Jeżeli ref utrzymuje `DecodedFieldVector` przez wiele klatek, upewnij się, że nie blokujesz zwolnienia bufora po zmianie geometrii/domeny — czyść ref, gdy matcher odrzuca jego zawartość.

**Test:** w `apps/control-room/src/modules/viewport-3d/hooks/` (plik testowy tej logiki wybierz sam — jeśli funkcję trzeba wydzielić, żeby dało się ją przetestować bez React, zrób to; preferuj czystą funkcję `resolvePrimaryFieldDisplayedEnvelope(...)` obok istniejących eksportów).
Scenariusz: A zgodna → B `status: "ready"` z niezgodnym `snapshot_id` → C zgodna. Asercje: w kroku B pokazywana jest A i `fieldVectorDisplayedRevision` wskazuje rewizję A, nie B; w kroku C pokazywana jest C. Drugi scenariusz: B ze zmienionym `expected_generation_id` → wynik `null` (retencja słusznie odrzucona) i inkrement licznika z powodem `generation`.

---

# CZĘŚĆ B — Faza 2: LR-01, staged reveal

**Plik:** `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx` (71 559 B na `900ebad`)

Kotwice:
- `VIEWPORT_3D_MODEL_LAYER_FINAL_STAGE = 3` — **linia 569**
- `resolveViewport3DAirboxFrameState` — **linia 586**
- `resolveNextViewport3DModelLayerStage` — **linia 665**
- `resolveViewport3DModelLayerStageVisibility` — **linia 672**
- `resolveViewport3DModelLayerStageKey` — **linia 722**
- `useViewport3DModelLayerStage` — **linia 749**, reset w **linii 761**
- `stagedFieldModel` — **linia 1212**; `stagedFdmTargetViews` — **1213**; `stagedFdmNativeLayerViews` — **1223**; `stagedFdmMultilayerAirboxView` — **1232**; `stagedMeshQualityColors` — **1249**
- bramka montażu `{stageVisibility.baseGeometry && …` — **linie 1265 i 1370**
- `modelLayerStageKey` (useMemo) — **linia 1847**

## B1. Klucz resetu nie może zależeć od obecności danych

`resolveViewport3DModelLayerStageKey` (**722**) buduje klucz m.in. z:

```ts
fdmNativeLayerViews.length > 0 ? "fdm-native-ready" : "fdm-native-empty",
fdmTargetViews.length > 0 ? "fdm-ready" : "fdm-empty",
```

Te dwie flagi mieszają **tożsamość sceny** z **chwilową dostępnością danych**. Usuń je. Klucz ma zawierać wyłącznie tożsamość topologii i sceny: `meshGenerationId`, `meshRevision`, `nodeCount`, liczby części magnetycznych i airboxa, `sceneRevision`, liczbę obiektów.

Uzasadnienie z dowodem: `topologyKey` budowy FDM **nie zawiera** rewizji pola (`useViewport3DSceneModel.ts`, `fdm-grid:…|generation=…|…`), a `mergeFdmCuboidBuildResult` (`layers/fdmCuboidBuildState.ts:118–129`) zachowuje poprzedni `model`, gdy nowy jest `null`. Kolekcje mogą się więc opróżnić wyłącznie z powodów niezwiązanych z wartościami pola: niedostępny lub nieświeży `membership`, brak `realizedRegionIds`, `membership-cell-count-mismatch`, `invalid-region-legend`. Żaden z nich nie jest powodem do teardownu geometrii.

## B2. Reset etapu poza renderem, z histerezą bramkowaną zgodnością

`useViewport3DModelLayerStage` (**749**), linia **761**:

```ts
const stage = stageState.resetKey === resetKey ? stageState.stage : 0;
```

To zeruje etap **synchronicznie w trakcie renderu**, zanim jakikolwiek efekt zdąży się wykonać.

**Do zrobienia:**

1. Przenieś reset do efektu. W renderze używaj etapu ze stanu, nie wyliczaj zera z porównania kluczy.
2. Degradacja etapu ma zachodzić tylko wtedy, gdy **jednocześnie**: klucz tożsamości faktycznie się zmienił **i** nie ma zgodnej poprzedniej zawartości do pokazania. Sam upływ czasu nie jest warunkiem — **nie** implementuj gołego `setTimeout(150)`. Przeczytaj §4.1 dokumentu porównawczego: opóźnienie bez sprawdzenia zgodności może chwilowo pokazać dane niezgodne z nową domeną, co jest **gorsze** niż mignięcie.
3. Zachowaj etapowanie tam, gdzie jest uzasadnione: przy rzeczywistej zmianie siatki (`meshGenerationId` / `meshRevision` / `sceneRevision`) progresywny montaż zostaje bez zmian.

## B3. Koniec z zerowaniem danych pola w warstwach

Linie **1212–1258**: gdy `stageVisibility.fieldDrivenLayers` jest `false`, kod tworzy kopie widoków z wyzerowanymi `fieldVector`, `surfaceColors`, `vectorColors`, `vectorGlyphColors`, `vectorSegments`, oraz zeruje `fieldModel` i `meshQualityColors`.

Zastąp to retencją ostatniego dobrego kompletu, analogicznie do `retainLastGood` w `layers/FdmCuboidLayer.tsx`. Po Fazie 1 masz do tego narzędzia: envelope niesie `retained`, a bufory kolorów niosą `fresh`. Warstwa ma dostać ostatnie zgodne dane oznaczone jako nieaktualne, a nie `null`.

Jeżeli po B1 i B2 okaże się, że przy prawdziwej zmianie topologii te pola i tak są niezgodne (bo matcher je odrzuca) i zerowanie staje się martwym kodem — **usuń je i opisz to w raporcie**. To jest dopuszczalny wynik.

## B4. Bramka montażu zamiast odmontowania poddrzewa

Linie **1265** i **1370**: `{stageVisibility.baseGeometry && … ? (<>…</>) : null}` odmontowuje całe poddrzewo `FdmCuboidLayer` (i drugie poddrzewo w 1370).

Zamień na sterowanie widocznością — `visible={…}` na obiektach three.js albo `opacity` — zamiast warunkowego renderowania `null`. Materiały, geometrie i bufory GPU mają **przetrwać** przejście etapów. Nie dodawaj cross-fade — to LR-12/Faza C, poza zakresem.

## B5. Testy

`apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts` (istnieje, 36 355 B):

1. `resolveViewport3DModelLayerStageKey` — zmiana samej długości `fdmTargetViews` / `fdmNativeLayerViews` **nie zmienia** klucza; zmiana `meshRevision` / `meshGenerationId` / `sceneRevision` **zmienia** klucz.
2. `resolveViewport3DModelLayerStageVisibility` — bez zmian kontraktu, test regresyjny na progi 1/2/3.
3. Reset etapu: przy stałej tożsamości i zmieniających się danych pola etap **nie** spada do 0.
4. Warstwy: przy `fieldDrivenLayers === false` widoki nie mają wyzerowanego `fieldVector` (albo, jeśli usunąłeś tę ścieżkę, test potwierdza, że kod zerujący już nie istnieje).

---

## 4. Bramki i commit

Bramki uruchom **jako ostatni krok, po ostatniej edycji**:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d src/kernel/resources src/kernel/api
pnpm --dir apps/control-room audit:idle-performance
git diff --check
```

**Reguła bezwzględna:** jeżeli po commicie cokolwiek jeszcze zmienisz i zrobisz `--amend`, **najpierw przepuść wszystkie bramki ponownie**, a dopiero potem amenduj i raportuj. Poprzednim razem amend poszedł po raporcie i bez ponownej weryfikacji.

Zrób **dwa osobne commity** — części A i B są rozłączne merytorycznie:

```
fix(viewport-3d): domknij retencję pola głównego przy ready + mismatch (LR-03)

Ścieżka pola głównego w useViewport3DSceneModel zachowuje teraz ostatnią
zgodną klatkę także przy status=ready z niezgodnym identity, na tym samym
matcherze co kolekcja. displayedRevision wskazuje rewizję faktycznie
pokazanej klatki.

Plan: docs/audits/2026-09-13-live-refresh-remediation-masterplan.md, Faza 1
```

```
fix(viewport-3d): przestań zerować warstwy przy etapowaniu sceny (LR-01)

- klucz etapu nie zależy już od obecności danych FDM, tylko od tożsamości
  topologii i sceny
- reset etapu przeniesiony z renderu do efektu, bramkowany zgodnością
  poprzedniej zawartości, nie samym czasem
- warstwy dostają ostatnie zgodne dane oznaczone jako nieaktualne zamiast
  null; poddrzewo FdmCuboidLayer nie jest odmontowywane

Plan: docs/audits/2026-09-13-live-refresh-remediation-masterplan.md, Faza 2
```

Do commitów włącz wyłącznie pliki zmienione w ramach zadania. Nie pushuj, nie merguj, nie twórz PR.

## 5. Czego nie robić

- Nie dotykaj `build-engine/gpu/viewport3dGpuUploadManager.ts` (LR-05, Faza 3).
- Nie dotykaj `hooks/useViewport3DChunkedScalarColors.ts` (LR-06, Faza 4).
- Nie dotykaj `kernel/realtime/RealtimeInvalidationBridge.ts` (LR-07, Faza 5).
- Nie dotykaj `kernel/resources/planarFieldResources.ts` ani `modules/field-map/**` (LR-10, Faza 6).
- Nie dotykaj `layers/VectorFieldLayer.tsx` ani `vectorGlyph*` — aktywnie edytowane na `codex/frontend-refactoring-20260912`.
- Nie zmieniaj `canRetainViewport3DScalarUploadBuffer` ani żadnego matchera tożsamości w stronę luźniejszą.
- Nie zmieniaj interwałów, nie zastępuj `frameloop="demand"` stałą pętlą, nie dodawaj cross-fade ani opóźnień CSS.
- Nie refaktoryzuj `useViewport3DSceneModel.ts` przy okazji.

## 6. Raport końcowy

1. SHA bazowy i SHA **obu** utworzonych commitów. Jeśli którykolwiek amendowałeś — podaj SHA przed i po oraz potwierdź ponowne przejście bramek.
2. Wynik każdej bramki z A1 („stan przed") i z §4 („stan po").
3. Lista zmienionych plików z opisem zmiany.
4. Nowe testy: pliki i nazwy przypadków.
5. Decyzje podjęte samodzielnie — w szczególności: gdzie umieściłeś pamięć ostatniej zgodnej klatki pola głównego, jaki warunek degradacji etapu przyjąłeś w B2, oraz czy ścieżka zerowania z B3 okazała się martwa.
6. Rozbieżności wobec opisu — zwłaszcza jeśli rozmiar `Viewport3DScene.tsx` lub numery linii nie zgadzały się z podanymi.
