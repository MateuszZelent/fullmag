# Audyt modułu wizualizacji 3D (`apps/control-room/src/modules/viewport-3d`)

**Zakres:** shadery, glify wektorowe (airbox + powierzchnia ferromagnetyków), kamera (orbit / pan / scroll / snap), wydajność, wycieki pamięci, poprawność logiczna, dług technologiczny.
**Data:** 2026-09-06
**Rewizja kodu:** `C:\git\fullmag\fullmag`, `apps/control-room` v0.1.0
**Stos:** Next 16.2.11 · React 19.2.4 · three ^0.183.2 · @react-three/fiber ^9.5.0 · drei ^10.7.7 · @react-three/postprocessing ^3.0.4
**Metoda:** pięć niezależnych, równoległych ścieżek analizy (kamera / shadery / glify+airbox / pamięć / architektura), pełny odczyt 290 plików modułu (64 949 linii źródeł + 51 691 linii testów), następnie ręczna weryfikacja krytycznych tez bezpośrednio w kodzie (numery linii sprawdzone `grep -n` / `awk`).

> Wszystkie odwołania do plików są względne wobec `apps/control-room/src/modules/viewport-3d/`, o ile nie zaznaczono inaczej.

---

## 1. Streszczenie wykonawcze

Moduł jest **inżyniersko dojrzały pod względem higieny kodu** (0 × `any`, 0 × `@ts-ignore`, 0 × `TODO/FIXME/HACK`, 0 × `console.*`, 1606 testów, 141 plików testowych) i ma **bardzo dobrą infrastrukturę** (`build-engine/` z pulą workerów, budżetowanym uploadem GPU, cache'em z eksmisją, `Viewport3DResourceTracker`, epoki gestów kamery, sonda trajektorii). Ta jakość jest realna i warto ją zachować.

Jednocześnie moduł ma **cztery grupy defektów o charakterze systemowym**, których nie da się naprawić punktowo:

| # | Problem systemowy | Skutek |
|---|---|---|
| **I** | **Cała scena jest bezoświetleniowa (`unlit`) i bez zarządzania przestrzenią barw.** Rig świateł zwraca zawsze `directional: []`, wszystkie materiały to `MeshBasicMaterial`/`ShaderMaterial`, geometrie MES nie mają atrybutu `normal`. Palety zapisane w sRGB trafiają surowo do bufora. | Bryły 3D wyglądają jak płaskie wycinanki 2D; te same dane renderują się w dwóch różnych kolorach zależnie od ścieżki (shader vs vertex-color); włączenie Bloom/AO powoduje podwójną korekcję gamma. |
| **II** | **Praca O(N) na wątku UI tam, gdzie istnieje worker.** Worker glifów zwraca surowe składowe, a główny wątek składa 2 macierze 4×4 na strzałkę. Scheduler FDM kopiuje `Float64Array` pola **dwukrotnie** przed wysłaniem do workera. Airbox wgrywa całą tablicę macierzy dwa razy, bez chunkowania. | Zacięcia i spadki FPS przy każdej zmianie pola; przy 2 mln komórek to ~50 MB kopiowane dwa razy na klatkę animacji. |
| **III** | **Stany „fail-closed" bez ścieżki wyjścia.** Cztery niezależne mechanizmy potrafią trwale zablokować się po jednym zdarzeniu: przepełnienie batched-invalidate zabija pętlę renderu, `suppressNextRestCommitRef` blokuje zapis kamery, błąd workera trwale degraduje lane, clamp azymutu zapętla animację orbit-debug. | Viewport zamarza / kamera przestaje być zapisywana / strzałki znikają do końca sesji — bez żadnego komunikatu. |
| **IV** | **Monolit orkiestracyjny bez testów zachowania.** `useViewport3DSceneModel.ts` — 6576 linii, ciało hooka 3902 linie, 94 × `useMemo`, CC ≈ 682, **0 × `renderHook`**. Zamiast tego ~970 asercji `expect(source).toContain(...)` na tekście źródłowym w 40 plikach testowych. | Testy nie chronią przed regresją zachowania, a jednocześnie blokują refaktor (asercja tekstowa utrwala martwy parametr). |

**Bilans znalezisk:** 27 × Krytyczny/Wysoki priorytet w kategorii „psuje działanie", 34 × Średni, 11 × Niski. Poniżej pełny rejestr.

### 1.1 Top 12 — do naprawy w pierwszej kolejności

| Rank | ID | Tytuł | Plik |
|---:|---|---|---|
| 1 | [C-01](#c-01) | Przepełnienie `batched invalidate` trwale zabija pętlę renderu | `viewport3dBatchedInvalidate.ts:43-79` |
| 2 | [S-01](#s-01) | Brak oświetlenia i normalnych — bryły wyglądają płasko | `layers/Viewport3DLightingRig.tsx:26-34` |
| 3 | [S-08](#s-08) | Nowy `ShaderMaterial` + rekompilacja programu GL **w każdej klatce** animacji fazy | `layers/MeshPartLayer.tsx:904-933` |
| 4 | [V-01](#v-01) | Kwaterniony i `matrix.compose` per strzałka na wątku UI | `layers/VectorFieldLayer.tsx:989-1024` |
| 5 | [V-06](#v-06) | Dwukrotna kopia `Float64Array` pola przed wysłaniem do workera | `layers/fdmCuboidBuildScheduler.ts:349-393` |
| 6 | [C-02](#c-02) | Clamp zamiast zawijania azymutu → nieskończona animacja + wyciek blokady pola | `layers/CameraControls.tsx:216-239` |
| 7 | [S-04](#s-04) | `ShaderMaterial` ignoruje płaszczyzny tnące — przekrój nie działa na mapie pola | `viewport3dScalarSurfaceShader.ts:456-518` |
| 8 | [V-04](#v-04) | Cienki film (`nz = 1`) traci całe wnętrze w trybie „surface" | `layers/fdmCuboidBuildModel.ts:654-669` |
| 9 | [M-01](#m-01) | 272 MB cache'y modułowych nigdy nie zwalnianych przy odmontowaniu | `viewport3dResources.ts:57-81` |
| 10 | [M-07](#m-07) | Brak `renderer.dispose()` / `forceContextLoss()` — wyczerpanie kontekstów WebGL | `Viewport3DCanvas.tsx:122-141` |
| 11 | [C-09](#c-09) | Twarda podłoga `far ≥ 1e-3` i brak `min/maxDistance` — clipping i utrata kontroli | `layers/CameraControls.tsx:361-364` |
| 12 | [A-08](#a-08) | ~970 asercji na tekście źródła; monolit bez ani jednego testu wykonującego kod | `hooks/useViewport3DSceneModel.test.ts` |

---

## 2. Konfrontacja z raportem Gemini

Raport Gemini (`audit_frontend_3d_viewport.md`) trafnie wskazał kierunki, ale w kilku miejscach diagnoza jest niepełna albo myląca. Poniżej weryfikacja punkt po punkcie.

| Teza Gemini | Werdykt | Uzasadnienie |
|---|---|---|
| „Near-plane slicing: `near: fit.near` jest sztywne (`distance/100`)" | **Częściowo potwierdzone, ale przyczyna jest inna** | `near` faktycznie jest wyliczane raz (`CameraControls.tsx:363`), ale realnym mechanizmem znikania modelu jest to, że `cameraClip` liczony jest z **debounce'owanego o 180 ms stanu ze store'a**, a nie z żywej kamery (`Viewport3DScene.tsx:1826-1829`). Podczas ciągłego scrolla timer jest restartowany i clip nie jest przeliczany ani razu. Zob. [C-10](#c-10). |
| „Brak `minDistance` w OrbitControls" | **Potwierdzone** | `CameraControls.tsx:1250-1267` — brak `minDistance`/`maxDistance`/`zoomToCursor`. Co więcej, jest to **świadome i utrwalone testem** (`CameraControls.test.ts:333-351`). Zob. [C-10](#c-10). |
| „Osobliwość biegunowa / gimbal lock przy world-up = Z" | **Potwierdzone i rozszerzone** | Nie jest to jednak własność `lookAt`, tylko: (a) `resolveCameraUpForDirection` **ignoruje argument** i zawsze zwraca `[0,0,1]` (`orientation/cameraOrientation.ts:25-30`), (b) następujące po tym `controls.update()` przelicza offset na współrzędne sferyczne i **bezpowrotnie zeruje azymut**. Zob. [C-07](#c-07), [C-08](#c-08). |
| „`WIDGET_CAMERA_DISTANCE = 2 m` koliduje ze skalą nanometrową" | **Niepotwierdzone jako defekt** | HUD orientacji renderuje się we **własnej, znormalizowanej przestrzeni widżetu**, niezależnej od skali sceny — stała 2 jest tam poprawna. Realny problem skali dotyczy czego innego: twardej podłogi `far ≥ 1e-3 m` w rzucie ortograficznym ([C-09](#c-09)) oraz `aoRadius={0.5}` w postprocessingu ([S-16](#s-16)). |
| „Ciężkie obliczenia macierzy w głównym wątku" | **Potwierdzone, i to jest większy problem niż opisano** | Oprócz `VectorFieldLayer.tsx:989-1024` ([V-01](#v-01)) na wątku UI dzieje się: podwójna kopia całego pola ([V-06](#v-06)), tożsamościowa kopia N×16 macierzy airboxa ([V-07](#v-07)), podwójny niechunkowany upload macierzy ([V-08](#v-08)) i kopia tablicy segmentów przed transferem ([V-19](#v-19)). |
| „Dwa draw calle na pole wektorowe, `frustumCulled={false}`" | **Potwierdzone** | Zob. [V-02](#v-02). Dodatkowo `boundingSphere` nigdy nie jest unieważniana po zmianie macierzy, co psuje raycast inspekcji ([V-09](#v-09)). |
| „Całkowity brak oświetlenia" | **Potwierdzone — to znalezisko nr 2 w całym audycie** | Zob. [S-01](#s-01). Przyczyna jest głębsza: rig świateł jest martwym kodem (`directional: []` zawsze), a geometrie w ogóle nie mają atrybutu `normal`. |
| „Rekompilacja `WebGLProgram` przy zmianie trybu" | **Potwierdzone, ale najgorszy przypadek to nie zmiana trybu** | Podmiana stringów przy zmianie trybu ([S-09](#s-09)) to koszt jednorazowy. Znacznie gorsze jest to, że **cały `ShaderMaterial` jest rekreowany w każdej klatce animacji fazy modu** ([S-08](#s-08)) — to 3-15 ms synchronicznego linkowania programu 60 razy na sekundę. |
| „Niezdefiniowane zachowanie dla NaN w `clamp()`" | **Potwierdzone i rozszerzone** | Poza `clamp` istnieją trzy niezgodne implementacje wyznaczania zakresu ([S-06](#s-06)), niezdefiniowane `atan(0,0)` ([S-12](#s-12)) i degeneracja przy `min == max` przez epsilon **absolutny** 1e-12 przy wartościach rzędu 8e5 ([S-05](#s-05)). |
| „Monolit 6576 / 3360 linii" | **Potwierdzone, ale sedno jest w testach** | Sam rozmiar to objaw. Sedno: monolit **nie ma ani jednego testu wykonującego kod** — 146 testów w 4911-liniowym pliku testowym dotyczy wyłącznie 50 czystych funkcji pomocniczych, a ciało hooka (3902 linie, CC ≈ 682) jest weryfikowane wyłącznie asercjami na tekście źródła ([A-08](#a-08)). |

**Czego raport Gemini nie wykrył, a co jest krytyczne:** [C-01](#c-01) (zabicie pętli renderu), [C-02](#c-02) (zapętlenie orbit-debug), [C-03](#c-03) (zakleszczenie zapisu pozy kamery), [C-06](#c-06) (brak `onPointerUp` w managerze zdarzeń — martwy gizmo), [S-02](#s-02)/[S-03](#s-03) (przestrzeń barw), [S-04](#s-04) (przekrój nie działa), [S-11](#s-11) (cała `Viewport3DScalarRangePolicy` jest martwa), [V-04](#v-04) (cienki film traci wnętrze), [V-03](#v-03) (`|| 1` zamienia zero na maksimum skali), [M-01](#m-01)…[M-07](#m-07) (wycieki), [A-09](#a-09) (rozjazd worker↔fallback w kolorowaniu).

---

## 3. Kamera: orbitowanie, translacja, scroll, snapy

### <a id="c-01"></a>C-01 · **KRYTYCZNY** · Przepełnienie `batched invalidate` trwale zabija pętlę renderu

**Lokalizacja:** `viewport3dBatchedInvalidate.ts:24`, `:43-79`

```ts
export const VIEWPORT_3D_BATCHED_INVALIDATE_REASON_LIMIT = 16;
...
const reasons = new Set<Viewport3DDirtyReason>();
let overflowed = false;

const flush = () => {
  scheduled = false;
  if (overflowed || reasons.size === 0) return;   // ← nigdy nie czyści overflowed
  ...
};
invalidate(reason) {
  if (overflowed) return false;
  if (!reasons.has(reason) && reasons.size >= maxReasons) {
    overflowed = true;                            // ← zatrzask
    return false;
  }
```

**Przyczyna źródłowa.** Limit wynosi 16 unikalnych powodów w jednym mikrozadaniu, ale `VIEWPORT_3D_DIRTY_REASONS` (`viewport3dTypes.ts:20-79`) definiuje **57** wartości. Wystarczy jeden commit Reacta, w którym więcej niż 16 różnych warstw (kamera + clip + fdm-cuboids + field-colors + wireframe + points + overlays + …) wywoła `invalidate()` w tej samej mikrotasce, żeby `overflowed` stało się `true`. Flaga jest resetowana **wyłącznie** w `cancel()`, wołanym tylko w cleanupie `Viewport3DInvalidationProvider`, czyli przy odmontowaniu `<Canvas>`. Od tej chwili każde `invalidate()` zwraca `false`, `flush()` wychodzi wcześniej, a `rootInvalidate()` nie jest już nigdy wołane. Przy `frameloop="demand"` (`viewport3dTypes.ts:18`) oznacza to całkowity brak klatek.

**Objaw.** Viewport zamarza na ostatniej klatce. OrbitControls dalej liczy pozycję kamery, ale nic się nie rysuje. Reszta UI działa normalnie, więc użytkownik zgłasza to jako „zawieszenie widoku 3D". Jedyny ratunek to przeładowanie strony.

**Naprawa.** „Fail closed" musi być odwracalne — przepełnienie ma wymusić jedną awaryjną klatkę, nie zablokować wszystkie następne:

```ts
if (!reasons.has(reason) && reasons.size >= maxReasons) {
  reasons.clear();
  invalidate([reason]);   // awaryjna klatka, bez dedupu
  return false;           // sygnalizuj przepełnienie wywołującemu, ale NIE blokuj
}
```
oraz w `flush()`: `if (overflowed) { overflowed = false; reasons.clear(); invalidate([...]); return; }`.
Niezależnie: podnieść limit do `VIEWPORT_3D_DIRTY_REASONS.length` — obecna wartość 16 przy 57 możliwych powodach jest arbitralna i praktycznie osiągalna.

---

### <a id="c-02"></a>C-02 · **KRYTYCZNY** · Clamp zamiast zawijania azymutu → nieskończona animacja i wyciek blokady aktualizacji pola

**Lokalizacja:** `layers/CameraControls.tsx:110-115`, `:216-239`, `:1009-1074`

```ts
export const VIEWPORT_3D_ORBIT_DEBUG_LIMITS = {
  azimuthMax: ORBIT_DEBUG_TWO_PI,   // 2π
  azimuthMin: 0,
  polarMax: Math.PI,
  polarMin: 0,
} as const;
...
azimuth: clampOrbitDebugAngle(
  currentAngles.azimuth +
    shortestOrbitDebugAzimuthDelta(currentAngles.azimuth, targetAngles.azimuth) * dampingFactor,
  VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin,
  VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMax,
  currentAngles.azimuth,
),
```

**Przyczyna źródłowa.** Azymut jest wielkością **cykliczną**, ale krok tłumienia domyka go liniowym `min(max(v, 0), 2π)`. Funkcja `shortestOrbitDebugAzimuthDelta` poprawnie wybiera najkrótszą drogę **przez szew 0/2π** (np. z 0.2 do 6.0 zwraca deltę ≈ −0.48), po czym clamp ścina wynik do 0. Zweryfikowane numerycznie: dla `azimuth = 0.2`, `target = 6.0`, `dt = 16 ms` po dwóch klatkach azymut wynosi dokładnie 0 i **tam zostaje**, a `shouldApplyViewport3DOrbitDebugAngles` nadal zwraca `true`, więc `settled` nigdy nie nastąpi.

Kaskada w `useFrame` (`:1009-1074`):
* `orbitDebugAnimatingRef` nigdy nie schodzi do `false`, więc na końcu każdej klatki wołane jest `invalidate()` → `frameloop="demand"` degeneruje się do ciągłych 60 fps (GPU pracuje bez przerwy);
* `endViewport3DCameraGesture` nigdy się nie wykonuje, więc `beginViewport3DFieldUpdateHold()` otwarty w `viewport3DCameraGesture.ts:56-59` **nigdy nie jest zwolniony** — aktualizacje pola przestają docierać do sceny.

**Objaw.** Po ustawieniu azymutu w panelu orbit-debug tak, że przejście przechodzi przez 0°/360°, kamera „przykleja się" do 0° i nie dojeżdża do celu; wentylator GPU rusza; scena zamraża się w czasie (brak nowych danych pola).

**Naprawa.** Użyć normalizacji modulo, tej samej co przy odczycie z kontrolek:

```ts
azimuth: normalizeOrbitDebugAzimuthFromControls(
  currentAngles.azimuth +
    shortestOrbitDebugAzimuthDelta(currentAngles.azimuth, targetAngles.azimuth) * dampingFactor,
),
```

Dodatkowo w `useFrame` dodać bezpiecznik czasowy (przerwij animację i wykonaj `endViewport3DCameraGesture` po 2 s), żeby żaden przyszły błąd zbieżności nie blokował field-hold.

---

### <a id="c-03"></a>C-03 · **WYSOKI** · `suppressNextRestCommitRef` — zakleszczenie: po jednym użyciu orbit-debug pozycja kamery nie jest już nigdy zapisywana

**Lokalizacja:** `layers/CameraControls.tsx:804`, `:985`, `:1003`, `:1076-1085`, `:1143-1161`

```ts
const scheduleCameraControlsPoseCommit = useCallback((epoch, { restart = false } = {}) => {
  if (controlsSyncingRef.current || orbitDebugAnimatingRef.current ||
      suppressNextRestCommitRef.current) {
    return;                                    // ← nie planuje timera
  }
  ...
  cameraControlsPoseCommitTimeoutRef.current = setTimeout(() => {
    commitCameraControlsPose(epoch);           // ← jedyne miejsce zerujące flagę
  }, VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS);
```

**Przyczyna źródłowa.** Efekty `orbitDebugRevision` (`:985`) i `orbitDebugCommitRevision` (`:1003`) ustawiają `suppressNextRestCommitRef.current = true`. Jedyne miejsce kasujące tę flagę to `commitCameraControlsPose` (`:1079-1080`), a jedyne wywołanie `commitCameraControlsPose` to `setTimeout` wewnątrz `scheduleCameraControlsPoseCommit` — który **sam odmawia zaplanowania timera**, dopóki flaga jest ustawiona. Klasyczne zakleszczenie: warunek wyjścia jest osiągalny tylko przez ścieżkę, którą ten warunek blokuje.

**Objaw.** Po jednorazowym ruszeniu suwakiem orbit-debug (lub kliknięciu „commit") kamera nadal daje się obracać myszą, ale jej pozycja przestaje być utrwalana. Po zmianie zakładki, przełączeniu projekcji albo odświeżeniu widok wraca do starego ujęcia. Bez komunikatu.

**Naprawa.** Kasować flagę tam, gdzie kończy się animacja debug (blok `settled` w `useFrame`, ok. `:1038-1070`), albo konsumować ją w samym `scheduleCameraControlsPoseCommit`:

```ts
if (suppressNextRestCommitRef.current) {
  suppressNextRestCommitRef.current = false;   // skonsumuj JEDNO pominięcie
  settleViewport3DCameraGesture(cameraGestureRef, epoch);
  onCameraInteractionEnd?.(epoch);
  activeGestureEpochRef.current = null;
  return;
}
```

---

### <a id="c-04"></a>C-04 · **WYSOKI** · Dwóch niezależnych właścicieli `controls.enabled` — po przeciągnięciu pierścienia ViewCube OrbitControls zostaje trwale wyłączone

**Lokalizacja:** `layers/CameraControls.tsx:912-948`; `orientation/ViewCube3DBox.tsx:311-334`, `:406-424`; kolejność renderu `layers/Viewport3DScene.tsx:1596-1623`

```ts
// CameraControls.tsx
const restoreControls = () => {
  const previousEnabled = previousHudControlsEnabledRef.current;
  previousHudControlsEnabledRef.current = null;
  if (!controls || previousEnabled === null) return;
  controls.enabled = previousEnabled;
};
const handlePointerDownCapture = (event: PointerEvent) => {
  if (!isViewport3DImmediatePointerDownRegion(event)) return;
  previousHudControlsEnabledRef.current = Boolean(controls.enabled);
  controls.enabled = false;
};
window.addEventListener("pointerup", restoreControls, { capture: true, signal });
```

**Przyczyna źródłowa.** Ten sam boolean jest zapisywany i odtwarzany przez dwa niezależne mechanizmy, bez licznika ani właściciela:

1. `pointerdown` (capture, na `gl.domElement`) w `CameraControls` trafia pierwszy, bo pierścień leży w strefie 240 px (`viewport3dEventManager.ts:18`): zapisuje `previous = true`, ustawia `enabled = false`.
2. Następnie R3F dostarcza `pointerdown` do mesha pierścienia (`ViewCube3DBox.tsx:406-424`), który czyta **już zmodyfikowaną** wartość: `previousControlsEnabledRef.current = false`.
3. Na `pointerup` oba listenery są zarejestrowane na `window` w fazie capture. Kolejność wykonania = kolejność rejestracji, a `OrbitCameraControls` renderuje się **przed** `OrientationHudLayer`, więc: `restoreControls()` → `enabled = true`, potem `restoreOrbitControls()` → `enabled = false`.

Ponieważ prop `enabled={!props.interactionBlocked}` (`:1253`) nie zmienia wartości, R3F nigdy nie nadpisze `false` z powrotem.

**Objaw.** Po **jednym** przeciągnięciu pierścienia orbity przy kostce widoku mysz przestaje obracać, przesuwać i zoomować scenę — na stałe, aż do przemontowania `<Canvas>`.

**Naprawa.** Jedno źródło prawdy: zamienić boolean na **licznik blokad** we wspólnym module — `pushViewport3DControlsLock(controls)` / `popViewport3DControlsLock(controls)`, a `enabled` liczyć jako `lockCount === 0 && !interactionBlocked`. Wariant minimalny: usunąć zapis/odczyt z `ViewCube3DBox` (blokadę i tak już zakłada `CameraControls`).

---

### <a id="c-05"></a>C-05 · **WYSOKI** · Martwa strefa 240×240 px w prawym górnym rogu blokuje orbitowanie — także gdy ViewCube jest ukryty

**Lokalizacja:** `viewport3dEventManager.ts:18`, `:55-64`; `layers/CameraControls.tsx:924-930`

```ts
const VIEWPORT_3D_IMMEDIATE_POINTER_DOWN_REGION_PX = 240;
export function isViewport3DImmediatePointerDownRegion(event: Event): boolean {
  return (
    offsetX >= target.clientWidth - VIEWPORT_3D_IMMEDIATE_POINTER_DOWN_REGION_PX &&
    offsetY <= VIEWPORT_3D_IMMEDIATE_POINTER_DOWN_REGION_PX
  );
}
```

**Przyczyna źródłowa.** Heurystyka „prostokąt w rogu" zastępuje faktyczny raycast na widżet. Efekt w `CameraControls.tsx:912-948` jest bezwarunkowy — nie sprawdza ani `viewCubeVisible`, ani wyniku trafienia w kostkę. Realny widżet zajmuje ok. 48-160 px od krawędzi (kotwica 104 px w `orientation/hudLayout.ts:8`, promień pierścienia `31 · 1.52 · 1.15 ≈ 54 px`, etykiety `49 · 1.15 ≈ 56 px`), więc powstaje szeroki pierścień pikseli, gdzie kursor „nie trafia w nic", a mimo to `controls.enabled = false` na czas całego gestu. Przy `viewCubeVisible === false` **cały kwadrat 240×240 jest martwy**.

**Objaw.** Rozpoczęcie przeciągania w prawym górnym rogu viewportu (typowe przy obracaniu modelu wypełniającego cały kadr) nic nie robi. Użytkownik odbiera to jako losowe „zacinanie się" obrotu w jednym rogu.

**Naprawa.** `ViewCube3DBox` już wykonuje `raycaster.intersectObject(group, true)` (`ViewCube3DBox.tsx:182-192`) — wystawić z niego predykat `viewCubeHitTest(event)` i to nim warunkować blokadę w `CameraControls.tsx:924`. Minimalnie: dodać warunek `viewCubeVisible` i zawęzić stałą do rzeczywistego boxa widżetu liczonego z `resolveOrientationHudAnchors`.

---

### <a id="c-06"></a>C-06 · **WYSOKI** · `onPointerUp` wycięty z managera zdarzeń, `onPointerMove` blokowany przy wciśniętym przycisku → przeciąganie w R3F nie działa

**Lokalizacja:** `viewport3dEventManager.ts:9-17`, `:106-116`; `MoveObjectGizmo.tsx:221-237`

```ts
const VIEWPORT_3D_EVENT_HANDLER_KEYS = [
  "onClick", "onPointerDown", "onPointerMove", "onPointerLeave",
  "onPointerCancel", "onLostPointerCapture", "onWheel",
] as const satisfies readonly (keyof Events)[];   // ← brak "onPointerUp"

export function createViewport3DPointerMoveHandler(handler) {
  return (event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.buttons !== 0) return;       // ← cisza podczas przeciągania
    handler(event);
  };
}
```

**Przyczyna źródłowa.** `pickViewport3DEventHandlers` przepuszcza tylko wymienione klucze, więc R3F **nie rejestruje w ogóle nasłuchu `pointerup`** na elemencie zdarzeń. Równolegle wrapper `onPointerMove` odrzuca każde zdarzenie z `buttons !== 0`, czyli wszystkie ruchy w trakcie przeciągania.

Konsekwencja dla `moveAxisPointerHandlers`: `onPointerDown` startuje gest i robi `setPointerCapture`; `onPointerMove` nigdy nie dociera (`controller.move` nie jest wołane, `translation` zostaje `[...origin]`); `onPointerUp` nigdy nie dociera (`controller.end` → brak `onCommit`). Gest kończy się dopiero natywnym `lostpointercapture` przy puszczeniu przycisku, który jest zmapowany na `cancelAxisDrag` — czyli **anulowanie**.

**Objaw.** Narzędzie przesuwania obiektu (gizmo osi) jest całkowicie martwe: strzałka podświetla się, ale ciągnięcie nie przesuwa obiektu i po puszczeniu nic się nie zapisuje. Dodatkowo hover/inspect w scenie zamiera na czas trzymania dowolnego przycisku myszy.

**Naprawa.** Dodać `"onPointerUp"` do `VIEWPORT_3D_EVENT_HANDLER_KEYS` i zawęzić filtr ruchu wyłącznie do ścieżki hover, przepuszczając ruch gdy trwa pointer capture:

```ts
export function createViewport3DPointerMoveHandler(handler, store) {
  return (event) => {
    const pointerEvent = event as PointerEvent;
    if (pointerEvent.buttons !== 0 && store.getState().internal.capturedMap.size === 0) return;
    handler(event);
  };
}
```

---

### <a id="c-07"></a>C-07 · **WYSOKI** · Snap ViewCube na TOP/BOTTOM daje `up ∥ kierunek patrzenia` — degeneracja `lookAt` i reset azymutu

**Lokalizacja:** `orientation/cameraOrientation.ts:25-48`, `:173-176`; `orientation/viewCubeModel.ts:69-92`; `orientation/OrientationHudLayer.tsx:111-135`

```ts
export function resolveCameraUpForDirection(direction: Direction3): Direction3 {
  void direction;                                   // ← argument ignorowany
  return [...VIEWPORT_3D_ORIENTATION_WORLD_UP];      // zawsze [0,0,1]
}
```

**Przyczyna źródłowa.** Świat ma up = Z (`VIEWPORT_3D_WORLD_UP = [0, 0, 1]`, zweryfikowane `CameraControls.tsx:104`), a ściana „top" kostki ma kierunek `[0,0,1]`. Po snapie `position − target = (0, 0, d)`, czyli offset jest **równoległy** do `camera.up`. Skutki:

1. `camera.lookAt` trafia na przypadek zdegenerowany — `Matrix4.lookAt` ratuje się mikro-perturbacją osi, więc orientacja jest arbitralna;
2. następujące po tym `controls.update()` (`OrientationHudLayer.tsx:132`) przelicza offset na współrzędne sferyczne: `phi = 0` (clampowane przez `makeSafe` do `EPS`), a `theta = atan2(0, 0) = 0`. **Bieżący azymut zostaje bezpowrotnie zgubiony i wyzerowany.**

**Objaw.** Kliknięcie ściany TOP/BOTTOM kostki nie tylko obraca kamerę do góry, ale dodatkowo skręca model do zerowego azymutu — użytkownik widzi „przeskok o ~180°" i lekkie przechylenie zamiast czystego rzutu z góry. Kolejny gest orbitowania zaczyna się od tej zresetowanej wartości.

**Naprawa.** Dla kierunków niemal równoległych do world-up wybrać deterministyczny `up` prostopadły do kierunku, zachowując bieżący azymut:

```ts
export function resolveCameraUpForDirection(direction: Direction3, currentAzimuth = 0): Direction3 {
  const d = normalizeDirection(direction);
  if (Math.abs(d[2]) > 1 - 1e-6) {
    const s = Math.sign(d[2]);
    return [-Math.cos(currentAzimuth) * s, -Math.sin(currentAzimuth) * s, 0];
  }
  return [...VIEWPORT_3D_ORIENTATION_WORLD_UP];
}
```

Dodatkowo w `snapCameraToDirection` odchylić kierunek o ~1e-4 rad od bieguna, skoro warstwa niżej korzysta z parametryzacji sferycznej.

---

### <a id="c-08"></a>C-08 · **ŚREDNI** · Limity orbit-debug dopuszczają dokładnie bieguny (`polar ∈ {0, π}`) — ta sama osobliwość

**Lokalizacja:** `layers/CameraControls.tsx:110-115`, `:258-288`

```ts
polarMax: Math.PI,
polarMin: 0,
...
const sinPolar = Math.sin(nextPolar);
camera.position.set(
  target.x + radius * sinPolar * Math.cos(nextAzimuth),
  target.y + radius * sinPolar * Math.sin(nextAzimuth),
  target.z + radius * Math.cos(nextPolar),
);
applyCameraLookAt(camera, tuple3(target.toArray()));
controls.update();
```

**Przyczyna źródłowa.** `normalizeViewport3DOrbitDebugAngles` clampuje polar do **domkniętego** `[0, π]`, więc wartości brzegowe są osiągalne. Przy `polar = 0` składowe X/Y znikają, kamera ląduje dokładnie nad targetem przy `camera.up = [0,0,1]` — dokładnie przypadek C-07: `lookAt` degeneruje, a następujące `controls.update()` zeruje azymut. `readViewport3DOrbitDebugAngles` na kolejnej klatce odczyta azymut 0, co daje sprzężenie zwrotne: panel pokazuje wartość, której nie da się utrzymać.

**Naprawa.** Zawęzić limity o epsilon, tak jak robi `Spherical.makeSafe()`:

```ts
const ORBIT_DEBUG_POLAR_EPSILON = 1e-4;
polarMax: Math.PI - ORBIT_DEBUG_POLAR_EPSILON,
polarMin: ORBIT_DEBUG_POLAR_EPSILON,
```

---

### <a id="c-09"></a>C-09 · **WYSOKI** · Twarda podłoga `far ≥ 1e-3 m` niezależnie od skali sceny — załamanie precyzji z-bufora w rzucie ortograficznym

**Lokalizacja:** `layers/CameraControls.tsx:356-364`; `layers/Viewport3DScene.tsx:383-392`

```ts
const radius = Math.max(activeBounds.radius, 1e-12);
const distance = radius * 2.8;
const near = Math.max(distance / 100, 1e-12);
const far = Math.max(distance * 100, near * 100, 1e-3);   // ← 1e-3 w METRACH
```

**Przyczyna źródłowa.** `1e-3` to stała absolutna w metrach, dobrana pod scenę metrową, ale mnożona przez nią jest scena o promieniu `5e-8 m`. Dla `radius = 5e-8`: `near = 1.4e-9`, `far = 1e-3` → stosunek `far/near ≈ 7·10⁵`.

* W rzucie **perspektywicznym** rozkład 1/z ratuje sytuację (≈ 5·10⁴ poziomów głębi w obrębie modelu).
* W rzucie **ortograficznym** głębia jest liniowa: model o rozpiętości `1e-7 m` zajmuje `1e-7 / 1e-3 = 0.01 %` zakresu bufora, czyli ~1700 z 16.7 mln poziomów (24 bit), a na kontekście 16-bitowym ~6 poziomów.

Kontekst nie ma `logarithmicDepthBuffer` (`Viewport3DModule.tsx:358-377` konfiguruje tylko `alpha/antialias/powerPreference/preserveDrawingBuffer`). Dodatkowo człon macierzy projekcji `(far+near)/(far−near) = 1.0000000028` po konwersji do `float32` na GPU staje się dokładnie `1.0`.

**Objaw.** Po przełączeniu na rzut ortograficzny w domenie FDM/FEM w skali nanometrowej powierzchnie migoczą (z-fighting): wireframe przebija przez powierzchnię, nakładki regionów mrugają przy najmniejszym ruchu kamery, przekroje pokazują ściany z tyłu obiektu.

**Naprawa.** Podłogi wyrazić **względnie**, nie absolutnie:

```ts
const far = Math.max(distance * 100, near * 100);            // CameraControls.tsx:364
far: Math.max(fit.far, orbitFar, fit.near * 100),            // Viewport3DScene.tsx:389
```

Absolutną podłogę stosować tylko gdy `bounds === null`. Dla trybu ortograficznego dodatkowo zacieśnić `near`/`far` do rzeczywistego rzutu bounds na oś patrzenia (`near = dist − R`, `far = dist + R` z marginesem) — ortho nie potrzebuje dodatniego `near`.

---

### <a id="c-10"></a>C-10 · **WYSOKI** · Model znika przy oddalaniu i wraca 180 ms po zatrzymaniu scrolla; brak `minDistance`/`maxDistance`

**Lokalizacja:** `layers/Viewport3DScene.tsx:1826-1829`, `:1948-1969`; `layers/CameraControls.tsx:1250-1267`; test utrwalający: `layers/CameraControls.test.ts:333-351`

```tsx
const cameraClip = useMemo(
  () => resolveViewport3DProjectionCameraClip(bounds, effectiveCameraState),
  [bounds, effectiveCameraState],   // ← stan ZE STORE'A, nie z żywych OrbitControls
);
...
<DreiOrbitControls ... enableZoom={options.enableZoom} zoomSpeed={options.zoomSpeed} />
{/* brak minDistance / maxDistance / zoomToCursor */}
```

**Przyczyna źródłowa.** `effectiveCameraState` pochodzi z propa aktualizowanego dopiero przez `commitCameraControlsPose`, debouncowanego o `VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS = 180 ms` **od ostatniego** zdarzenia `change`. W trakcie ciągłego scrollowania każdy „ząbek" kółka restartuje timer, więc `cameraClip` nie jest przeliczany ani razu. `far` w commicie to `distance + radius·4`, a bieżący `far` to wartość z poprzedniego commitu — przy odsunięciu poza `fit.far = radius·280` geometria wypada za dalszą płaszczyznę.

Zoom nie jest niczym ograniczony, więc promień orbity może zbiec do wartości denormalnej; po osiągnięciu `radius ≈ 0` `readViewport3DOrbitDebugAngles` zwraca `null` (`:195`), a obracanie przestaje mieć zdefiniowany kierunek.

**Objaw.** Podczas płynnego oddalania (trackpad, ciągły scroll) model nagle znika; po zatrzymaniu palca wraca z opóźnieniem ~0.2 s. Przy agresywnym przybliżeniu kamera „wchodzi w target" i nie da się już nią obrócić — jedyne wyjście to Fit/Reset.

**Naprawa.**
1. Przeliczać clip z **żywej** kamery w `useFrame`, nie z propsa:
```ts
const d = camera.position.distanceTo(controls.target);
const nextFar = Math.max(fit.far, d + radius * 4);
const nextNear = Math.max(d - radius * 4, radius * 1e-4);
if (relDiff(camera.far, nextFar) > 0.01 || relDiff(camera.near, nextNear) > 0.01) {
  camera.far = nextFar; camera.near = nextNear; camera.updateProjectionMatrix();
}
```
2. `minDistance={Math.max(bounds.radius * 1e-3, 1e-12)}`, `maxDistance={bounds.radius * 1e4}`.
3. Rozważyć `zoomToCursor` — przy skalach nano celowanie środkiem ekranu jest bardzo uciążliwe.
4. Zmienić asercję `CameraControls.test.ts:333-351`, która obecnie utrwala brak limitów jako kontrakt.

---

### <a id="c-11"></a>C-11 · **ŚREDNI** · `panSpeed: 2` łamie odwzorowanie 1:1 przy `screenSpacePanning`

**Lokalizacja:** `layers/CameraControls.tsx:117-126`, `:1260-1262`; test: `layers/CameraControls.test.ts:43-64`

```ts
const VIEWPORT_3D_CAMERA_INTERACTION_OPTIONS = {
  dampingFactor: 0.08, enableDamping: true, enablePan: true,
  enableRotate: true, enableZoom: true,
  panSpeed: 2, rotateSpeed: 1, zoomSpeed: 1,
} satisfies Viewport3DCameraInteractionOptions;
```

**Przyczyna źródłowa.** Przy `screenSpacePanning` OrbitControls liczy przesunięcie jako `deltaPx / clientHeight · 2 · distance · tan(fov/2) · panSpeed`. Dla `panSpeed = 1` daje to **dokładnie 1:1** — punkt świata pod kursorem zostaje pod kursorem. Mnożnik 2 podwaja przesunięcie. Test `CameraControls.test.ts:43-64` wręcz utrwala tę wartość (`expect(options.panSpeed).toBeGreaterThan(options.rotateSpeed)`), co jest porównaniem wielkości o **różnych jednostkach**: `panSpeed` to bezwymiarowy mnożnik odwzorowania, `rotateSpeed` to rad/px.

**Objaw.** Przy przesuwaniu model „wyrywa się" spod kursora; precyzyjne wycentrowanie komórki siatki wymaga kilku korekt. Efekt rośnie z DPI ekranu.

**Naprawa.** `panSpeed: 1` i zastąpienie asercji: `expect(options.panSpeed).toBe(1); // 1:1 screen-space panning`.

---

### <a id="c-12"></a>C-12 · **ŚREDNI** · `cachedRect` kostki widoku odświeżany tylko przez `ResizeObserver` — trafienia lądują w złym miejscu po scrollu

**Lokalizacja:** `orientation/ViewCube3DBox.tsx:160-205`

```ts
let cachedRect = element.getBoundingClientRect();
const resizeObserver = new ResizeObserver(() => { cachedRect = element.getBoundingClientRect(); });
const handlePointerDown = (event: PointerEvent) => {
  const rect = cachedRect;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
```

**Przyczyna źródłowa.** `ResizeObserver` reaguje wyłącznie na zmianę **rozmiaru** obserwowanego elementu, a nie jego **pozycji**. Przewinięcie strony, otwarcie/zamknięcie panelu bocznego o stałej szerokości, zmiana wysokości paska narzędzi — wszystko to zmienia `rect.left/top` bez zmiany `width/height`. `pointer.set()` dostaje wtedy przesunięte NDC i `raycaster.intersectObject` albo nie trafia w kostkę, albo trafia w sąsiednią ścianę.

**Naprawa.** Nie cachować w ogóle — `getBoundingClientRect()` raz na `pointerdown` jest tani. Alternatywnie unieważniać cache także na `scroll` (capture, `passive: true`).

---

### <a id="c-13"></a>C-13 · **ŚREDNI** · Ścieżka HUD omija epokę gestu i niesymetrycznie zwalnia blokadę aktualizacji pola

**Lokalizacja:** `orientation/OrientationHudLayer.tsx:86-94`, `:136-199`; `layers/CameraControls.tsx:1076-1135`; `Viewport3DModule.tsx:1591-1604`

```ts
const commitCameraChange = useCallback((nextCamera: Viewport3DCameraState) => {
  onCameraInteractionStart?.();                      // ← bez epoki
  void Promise.resolve(onCameraChange(nextCamera))   // ← bez epoki
    .catch(() => undefined)
    .finally(() => onCameraInteractionEnd?.());      // ← bez epoki
}, [...]);
```

**Przyczyna źródłowa.** `OrientationHudLayer` nie dostaje `cameraGestureRef` (`Viewport3DScene.tsx:1613-1622`), więc `viewport3DCameraGestureActive()` pozostaje `false` mimo trwającej manipulacji kamerą. Jednocześnie `beginCameraInteraction` w module jest strzeżone refem (`if (!cameraFieldUpdateHoldRef.current) { … }`), a `endCameraInteraction` **bezwarunkowo** zwalnia hold. Jeśli w chwili snapu z kostki trwa gest OrbitControls, `beginCameraInteraction()` z HUD nic nie zrobi, ale jego `.finally()` **zamknie cudzy hold**.

**Objaw.** Snap kostką w trakcie lub tuż po przeciąganiu myszą powoduje, że blokada opada w środku gestu — scena szarpie podmienionymi danymi pola w połowie obrotu, a poza z trwającego gestu potrafi nie zostać zapisana.

**Naprawa.** Przekazać `cameraGestureRef` do `OrientationHudLayer` i objąć każdą akcję HUD pełnym cyklem epoki (`begin` → `apply` → `settle` → `end`), analogicznie dla `onOrbit`/`commitOrbit` (jedna epoka na całe przeciąganie pierścienia).

---

### <a id="c-14"></a>C-14 · **ŚREDNI** · Każdy „ząbek" kółka tworzy i natychmiast anuluje pełną epokę gestu

**Lokalizacja:** `layers/CameraControls.tsx:1200-1227`; `layers/viewport3DCameraGesture.ts:43-61`, `:132-141`

```ts
const handleTransitionStart = useCallback(() => {
  if (controlsSyncingRef.current) return;
  clearCameraControlsPoseCommit();
  const previousEpoch = activeGestureEpochRef.current;
  if (previousEpoch !== null) {
    cancelViewport3DCameraGesture(cameraGestureRef, previousEpoch);
    onCameraInteractionEnd?.(previousEpoch);
  }
  cameraGestureEndedRef.current = false;
  const epoch = beginViewport3DCameraGesture(cameraGestureRef, "orbit");   // ← zawsze "orbit"
```

**Przyczyna źródłowa.** `OrbitControls.onMouseWheel` w three dispatchuje parę `start`/`end` **dla każdego zdarzenia wheel**. Każdy `start` anuluje poprzednią epokę (→ `endViewport3DFieldUpdateHold()`), wywołuje `onCameraInteractionEnd(prev)` (→ kolejne `endViewport3DFieldUpdateHold()`) i otwiera nową epokę z nowym holdem. Przy scrollu trackpadem (60-120 zdarzeń/s) licznik holdu spada do zera i wraca dziesiątki razy na sekundę, przepuszczając za każdym razem oczekujące aktualizacje pola.

Dodatkowo źródło gestu jest **zawsze** zakodowane jako `"orbit"` — warianty `"wheel"`, `"pan"`, `"orientation-hud"`, `"fit"`, `"reset"`, `"projection"`, `"debug"` z `viewport3DCameraGestureSource` nie są nigdzie produkowane, więc sonda trajektorii (`:837`) raportuje każdą operację jako orbit.

**Naprawa.** Wprowadzić okno łączenia epok (jeśli od `onEnd` minęło < 250 ms, kontynuować tę samą epokę zamiast `cancel + begin`) i ustalać źródło z `controls.state`:

```ts
const source = controls.state === STATE.DOLLY ? "wheel"
             : controls.state === STATE.PAN   ? "pan"
             : "orbit";
```

---

### <a id="c-15"></a>C-15 · **ŚREDNI** · Brak jakiejkolwiek obsługi klawiatury i fokusu dla kamery

**Lokalizacja:** `Viewport3DCanvas.tsx:391-411`; `layers/CameraControls.tsx:1249-1268`

`<canvas>` nie ma `tabIndex`, `role` ani `aria-label` — nie da się go sfokusować klawiszem Tab. Drei `OrbitControls` domyślnie **nie** podpina obsługi klawiszy (wymaga propa `keyEvents` lub `controls.listenToKeyEvents(el)`), którego tu nie ma. Jedyny nasłuch klawiatury w module (`MoveObjectGizmo.tsx:203-213`) obsługuje wyłącznie Escape.

**Objaw.** Użytkownik korzystający wyłącznie z klawiatury nie jest w stanie ani obrócić, ani przesunąć, ani przybliżyć widoku 3D. Cała wizualizacja jest dla niego statycznym obrazem bez alternatywy tekstowej.

**Naprawa.** (1) `<canvas tabIndex={0} role="img" aria-label="Widok 3D — strzałki przesuwają, +/− przybliża">`; (2) `keyEvents={canvasElement}` + jawne `keys={{...}}` na `DreiOrbitControls`; (3) własny handler `keydown` dla `+`/`−` (dolly) i `[`/`]` (azymut co 15°), spinany tą samą ścieżką epok co gesty wskaźnika; (4) wystawić Fit/Reset/snapy ViewCube jako fokusowalne przyciski poza canvasem.

---

### <a id="c-16"></a>C-16 · **ŚREDNI** · Każde tyknięcie `ResizeObserver` uruchamia pełne `root.configure()`

**Lokalizacja:** `Viewport3DCanvas.tsx:248-265`, `:273-369`

```tsx
const measure = () => {
  const next = sanitizeViewport3DCanvasMeasure(container.getBoundingClientRect());
  setSize((previous) => sameViewport3DCanvasSize(previous, next) ? previous : next);
};
const observer = new ResizeObserver(measure);
...
void root.configure({ camera, dpr, events, flat, frameloop, gl, ..., size })
// deps: [..., size]
```

**Przyczyna źródłowa.** `getBoundingClientRect()` zwraca wartości subpikselowe, więc przy przeciąganiu splittera `sameViewport3DCanvasSize` prawie nigdy nie zwraca `true`. Ponieważ `size` jest w zależnościach efektu konfigurującego, każda taka zmiana wykonuje **pełne, asynchroniczne** `root.configure(...)` — z inkrementacją `configureGeneration`, przebudową opcji renderera, ponownym `onCreated` i pełnym `render()`. Nie ma tu debounce'u, który R3F stosuje domyślnie w `<Canvas resize={{ debounce: 250 }} />`.

**Naprawa.** Zaokrąglić pomiar i skoalescować przez rAF:

```ts
const measure = () => {
  const rect = container.getBoundingClientRect();
  const next = { height: Math.round(rect.height), left: 0, top: 0, width: Math.round(rect.width) };
  setSize((prev) => sameViewport3DCanvasSize(prev, next) ? prev : next);
};
let frame = 0;
const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
return () => { cancelAnimationFrame(frame); observer.disconnect(); };
```

Docelowo rozdzielić „zmiana rozmiaru" (wystarczy `state.setSize(...)`) od „zmiana konfiguracji" (pełne `configure`).

---

### <a id="c-17"></a>C-17 · **NISKI** · `Number("")` → `0`: wyczyszczenie pola w dialogu kamery cicho ustawia zero

**Lokalizacja:** `components/Viewport3DCameraDialog.tsx:455-502`, `:527-536`

```ts
function parseFiniteDraftNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
```

`Number("")` i `Number("   ")` zwracają `0`, a `Number.isFinite(0) === true`. Wyjątkiem jest tylko `orthographicScale` (`:473-476`). Usunięcie zawartości pola „Distance" daje `distance = 0` → `buildViewport3DCameraPoseFromOrientation` (`viewport3dCameraModel.ts:72-78`) tworzy `position === target`, czyli zerowy promień orbity — dokładnie stan z C-10. Dodatkowo `orientationDirtyRef` (`:121`, `:169`) nigdy nie jest zerowany po zewnętrznej zmianie `snapshot`, więc „Apply" użyje ścieżki orientacyjnej ze starymi yaw/pitch.

**Naprawa.**
```ts
function parseFiniteDraftNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
```
plus `safeDistance = Math.max(distance, 1e-12)` i `useEffect(() => { orientationDirtyRef.current = false; }, [snapshot])`.

---

### <a id="c-18"></a>C-18 · **NISKI** · Martwy kod i zawsze aktywne globalne nasłuchy w `OrbitRing3D`; alokacje per-klatka

**Lokalizacja:** `orientation/ViewCube3DBox.tsx:312-318`, `:348-372`, `:374-395`, `:638-649`; `layers/CameraControls.tsx:187-202`, `:1016-1017`

```ts
const attachWindowDragListeners = useCallback(() => {
  if (dragListenersAttachedRef.current) return;
  dragListenersAttachedRef.current = true;
  const dragMoveListener = (event: PointerEvent) => handleMove(event);   // nigdy nie podpięty
  const dragEndListener = () => handleUp();                              // nigdy nie podpięty
  dragMoveListenerRef.current = dragMoveListener;
  dragEndListenerRef.current = dragEndListener;
}, [handleMove, handleUp]);
```

`attach/detachWindowDragListeners` **tylko zapisują funkcje do refów** — `addEventListener` nie jest w nich wołany. Rzeczywiste nasłuchy są rejestrowane bezwarunkowo w `useEffect` (`:374-395`) na `window` w fazie capture i żyją przez cały czas życia komponentu, więc **każdy** `pointermove` w aplikacji przechodzi przez callback HUD-a.

Osobno: `readViewport3DOrbitDebugAngles` alokuje `camera.position.clone().sub(target)` przy każdym wywołaniu, w tym z `useFrame`; `AutoOrientText` odwraca macierz świata rodzica w `useFrame` dla **każdej z sześciu** ścian kostki.

**Naprawa.** Usunąć martwe refy i funkcje; podpinać `pointermove` dopiero w `onPointerDown` i odpinać w `handleUp` (`AbortController` per gest). W `readViewport3DOrbitDebugAngles` użyć modułowego bufora `const _offset = new Vector3()`. W `AutoOrientText` przeliczać orientację tylko przy realnej zmianie `camera.quaternion`.

---

## 4. Shadery, materiały, oświetlenie, kolorystyka

### <a id="s-01"></a>S-01 · **KRYTYCZNY** · Cała scena jest bezoświetleniowa (unlit flat) — rig świateł to martwy kod

**Lokalizacja:** `layers/Viewport3DLightingRig.tsx:26-34`, `:45-58`; `viewport3dScalarSurfaceShader.ts:357-375`; `layers/MeshPartLayer.tsx:153-184`, `:1023-1030`

```ts
export function resolveViewport3DLightingRig(profile: Viewport3DVisualProfile): Viewport3DLightingRigModel {
  return {
    ambient: { color: 0xffffff, intensity: profile.lighting === "minimal" ? 0.6 : 0.72 },
    directional: [],     // ← zawsze pusta
    hemisphere: null,    // ← zawsze null
  };
}
```
```glsl
// viewport3dScalarSurfaceShader.ts:361-364 — wierzchołek nie ma normalnej
void main() {
  vScalarValue = fmScalarValue;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

**Przyczyna źródłowa.** Trzy niezależne warunki składają się na płaskość:
1. `directional` jest zawsze pustą tablicą, `hemisphere` zawsze `null`, więc rig montuje wyłącznie `ambientLight`.
2. W całym module **nie ma ani jednego materiału reagującego na światło** — zweryfikowane: `grep` po `meshStandardMaterial|meshPhongMaterial|meshLambertMaterial|MeshStandardMaterial` zwraca **zero** trafień w kodzie produkcyjnym. Wszystkie 21 użyć to `meshBasicMaterial`, plus `lineBasicMaterial`, `pointsMaterial` i własny `ShaderMaterial`. `MeshBasicMaterial` ignoruje światła całkowicie, więc `ambientLight` nie wpływa na ani jeden piksel — jest obiektem generującym koszt `WebGLLights.setup()` bez efektu.
3. Geometrie powierzchni **nie mają atrybutu `normal`** — `createMeshPartSurfaceGeometry` (`MeshPartLayer.tsx:153-184`) ustawia tylko `position` i indeks; nigdzie nie ma `computeVertexNormals()` dla siatek MES.

**Objaw.** Bryła 3D jest kompletnie płaska — sylwetka wielościanu, wypukłości/wklęsłości i nachylenie ścianek są nieodróżnialne. Użytkownik widzi „plamę" koloru pola bez informacji o geometrii; przy obrocie kamery kształt zmienia się tylko na krawędziach sylwetki. Dla mikromagnetyzmu (cienkie warstwy, ostrza, nanodruty) uniemożliwia to ocenę, **na której ścianie** leży wizualizowana wartość.

**Naprawa (tania, zachowująca wierność kolorów pola).** Cieniowanie zależne od normalnej ekranowej, sterowane uniformem — 0 = tryb „figure" (płaski, do publikacji), 0.45 domyślnie:

```glsl
// vertex
attribute vec3 normal;              // wymaga geometry.computeVertexNormals()
varying vec3 vNormalView;
vNormalView = normalize(normalMatrix * normal);

// fragment
uniform float fmShadeStrength;
vec3 base = paletteColor(t);
vec3 n = normalize(vNormalView) * (gl_FrontFacing ? 1.0 : -1.0);
float ndl = clamp(dot(n, normalize(vec3(0.35, 0.55, 0.75))) * 0.5 + 0.5, 0.0, 1.0);
gl_FragColor = vec4(base * mix(1.0, 0.55 + 0.75 * ndl, fmShadeStrength), fmOpacity);
```

Wariant bez atrybutu (flat shading z pochodnych ekranowych): `vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));`.
Rig świateł należy albo usunąć jako martwy kod, albo — jeśli ma zostać — przenieść powierzchnie na `MeshLambertMaterial`/`MeshStandardMaterial` z `vertexColors` i dodać co najmniej jedno `directionalLight` + `hemisphereLight`.

---

### <a id="s-02"></a>S-02 · **KRYTYCZNY** · Brak zarządzania przestrzenią barw — dwie ścieżki renderują te same dane w dwóch różnych kolorach

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:495-518`, `:560-562`; `viewport3dVisualProfile.ts:190-202`; `layers/MeshPartLayer.tsx:789-796`, `:1020-1031`

```glsl
  return mixStops4(t, vec3(0.267, 0.004, 0.329), vec3(0.192, 0.408, 0.557),
                      vec3(0.208, 0.718, 0.475), vec3(0.992, 0.906, 0.145));
}
void main() {
  float span = max(fmScalarMax - fmScalarMin, 1e-12);
  float t = clamp((vScalarValue - fmScalarMin) / span, 0.0, 1.0);
  gl_FragColor = vec4(paletteColor(t), fmOpacity);   // ← brak colorspace_fragment
}
```

**Przyczyna źródłowa.** Stopnie palety to dosłowne wartości **sRGB** z matplotlib: `0.267 = 0x44/255`, `0.004 = 0x01/255`, `0.329 = 0x54/255` → `#440154` (viridis 0.0); dalej `#31688E`, `#35B779`, `#FDE725`. Shader zapisuje je bez `#include <colorspace_fragment>`. Renderer ma `outputColorSpace = SRGBColorSpace` (`viewport3dVisualProfile.ts:201`), a `THREE.ColorManagement` jest w r183 domyślnie włączone. Skutek:

* **ścieżka shaderowa (bez postprocessingu):** wartość sRGB wpisana wprost do bufora sRGB — kolor wychodzi *przypadkowo* poprawnie, ale jest to zbieg okoliczności, nie kontrakt;
* **ścieżka vertex-color** (`MeshPartLayer.tsx:1023-1030`, `meshBasicMaterial vertexColors`): te **same liczby** (CPU liczy paletę przez `magnitudeColorRgb` → `scalarColorRgb`) trafiają do atrybutu `color`. Three **nie** kolor-menedżuje atrybutów wierzchołkowych — traktuje je jako linear-sRGB i na końcu programu wykonuje `linearToOutputTexel()`. Wartość 0.267 zostaje zakodowana do ≈ 0.56, czyli kolor jaśnieje o ~2 stopnie ekspozycji.

Wybór ścieżki jest **dynamiczny** (`shaderScalarColorsEnabled`, `MeshPartLayer.tsx:789-796`), więc ten sam obiekt z tym samym polem renderuje się dwoma różnymi kolorami zależnie od tego, czy bufor zawiera `scalarValues`/`vectorValues` (shader), czy tylko `colors` (vertex).

**Objaw.** Ta sama wielkość na dwóch obiektach — albo na tym samym obiekcie po przełączeniu trybu — ma wyraźnie różną jasność i nasycenie. Viridis w ścieżce vertex-color jest wyblakły; ciemny fiolet `#440154` wygląda jak `#8B3F92`. Colorbar (rysowany w DOM z tych samych stopni sRGB) zgadza się tylko z jedną z dwóch ścieżek. **Dla publikacji naukowej oznacza to niezgodność koloru z legendą.**

**Naprawa.** Ustalić konwencję: paleta w **linear-sRGB**, konwersja na wyjściu.

```glsl
gl_FragColor = vec4(paletteColor(t), fmOpacity);
#include <colorspace_fragment>
```
i **jednocześnie** przeliczyć stopnie palety do linear (`c_lin = c ≤ 0.04045 ? c/12.92 : pow((c+0.055)/1.055, 2.4)`), np. `#440154 → vec3(0.0267, 0.0002, 0.0889)`. W ścieżce CPU analogicznie `Color.setStyle(hex, SRGBColorSpace)` / `SRGBToLinear()` przed zapisem do atrybutu `color`. Dodać test regresyjny porównujący kolor obu ścieżek dla `t ∈ {0, 0.5, 1}`.

---

### <a id="s-03"></a>S-03 · **WYSOKI** · Podwójna korekcja gamma po włączeniu SSAO/Bloom

**Lokalizacja:** `layers/PostProcessingLayer.tsx:34-40`; `viewport3dScalarSurfaceShader.ts:514-518`

**Przyczyna źródłowa.** `EffectComposer` z `@react-three/postprocessing` renderuje scenę do własnego `WebGLRenderTarget` typu `HalfFloatType` w przestrzeni **LinearSRGB**, a konwersję linear→sRGB wykonuje dopiero ostatni pass efektowy. Materiały wbudowane three zachowują się poprawnie (ich `colorspace_fragment` staje się tożsamością przy liniowym targecie). Nasz `ShaderMaterial` zapisuje jednak wartości **już zakodowane sRGB** (S-02) do bufora liniowego → końcowy pass koduje je **po raz drugi**: `srgb(srgb(x))`. Dla viridis 0.0: 0.267 → 0.56; dla 1.0: 0.992 → 0.997 (saturacja).

**Objaw.** Włączenie „Ambient Occlusion" lub „Bloom" natychmiast rozjaśnia i odbarwia całą powierzchnię pola (ciemne końce palety znikają, mapa traci kontrast), podczas gdy siatka, krawędzie i punkty pozostają bez zmian — wizualny rozjazd między warstwami tej samej sceny, pojawiający się i znikający w trakcie sesji.

**Naprawa.** Po naprawie S-02 problem znika automatycznie (chunk `colorspace_fragment` wykryje liniową przestrzeń docelową i stanie się tożsamością). Obejście doraźne: uniform `fmOutputIsLinear` ustawiany z `PostProcessingLayer`.

---

### <a id="s-04"></a>S-04 · **WYSOKI** · `ShaderMaterial` nie obsługuje płaszczyzn tnących — przekrój nie działa na powierzchniach kolorowanych polem

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:140-172`, `:456-518`; `layers/ClipPlaneLayer.tsx:407-413`

```ts
function applyRendererClipping(renderer: WebGLRenderer, clippingPlane: Plane | null): void {
  renderer.localClippingEnabled = Boolean(clippingPlane);
  renderer.clippingPlanes = clippingPlane ? [clippingPlane] : [];
}
```

**Przyczyna źródłowa.** `renderer.clippingPlanes` realizowane jest **wyłącznie** przez wstrzyknięte chunki `clipping_planes_pars_vertex/fragment` + `clipping_planes_fragment`, będące częścią wbudowanych shaderów. `ShaderMaterial` dostaje od `WebGLProgram` jedynie `#define NUM_CLIPPING_PLANES n`; jeśli autor shadera nie użyje chunków, `discard` nigdy się nie wykona. Zweryfikowane: `grep -c "clipping_planes" viewport3dScalarSurfaceShader.ts` → **0**. Materiał nie ma też `clipping: true`.

**Objaw.** Po włączeniu płaszczyzny cięcia znikają siatka, krawędzie, punkty i powierzchnie w kolorze jednolitym (`MeshBasicMaterial`), ale **powierzchnia z mapą pola pozostaje pełna**. Użytkownik widzi „nieprzeciętą skorupę" zasłaniającą wnętrze, co całkowicie unieważnia funkcję przekroju — kluczową przy analizie profilu pola w głąb warstwy.

**Naprawa.** W obu shaderach:

```glsl
// vertex — przed main
#include <clipping_planes_pars_vertex>
// vertex — w main
vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
#include <clipping_planes_vertex>

// fragment — przed main
#include <clipping_planes_pars_fragment>
// fragment — na początku main
#include <clipping_planes_fragment>
```
oraz `clipping: true` w konstruktorze `ShaderMaterial` w `createScalarSurfaceShaderMaterial`.

---

### <a id="s-05"></a>S-05 · **WYSOKI** · Puste okno wartości (`min == max`) → epsilon absolutny `1e-12` zamienia szum float32 w pełną skalę kolorów

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:514-518`; `field-colors/viewport3dFieldColorBuildModel.ts:471-474`; `viewport3dVectorColoring.ts:121-129`

```glsl
float span = max(fmScalarMax - fmScalarMin, 1e-12);
float t = clamp((vScalarValue - fmScalarMin) / span, 0.0, 1.0);
```

**Przyczyna źródłowa.** `1e-12` jest epsilonem **absolutnym**, a wartości mikromagnetyczne mają skalę fizyczną: `Ms ≈ 8·10⁵ A/m`, `H_d ≈ 10⁵ A/m`, gęstość energii ≈ 10⁴ J/m³. Dla jednorodnie namagnesowanej próbki (`min == max == 8e5`) `span = 1e-12`, a licznik `vScalarValue − fmScalarMin` jest różnicą dwóch liczb, z których jedna przeszła przez `Float32Array` (ULP ≈ 0.0625 przy 8e5), a druga przez uniform `float`. Typowa różnica ±0.0625 podzielona przez 1e-12 daje ±6.25·10¹⁰ → `clamp` do 0 albo 1 **losowo per wierzchołek**. Ta sama arytmetyka powtarza się na CPU (`normalizeScalarValue`, `scalarValueColorRgb`).

**Objaw.** Jednorodne pole (stan nasycony, stan początkowy, stałe pole zewnętrzne) renderuje się jako **losowa szachownica dwóch skrajnych kolorów palety** — ciemnofioletowe i jaskrawożółte plamy zamiast jednolitego koloru. Użytkownik interpretuje to jako artefakt numeryczny solvera. Colorbar pokazuje `8.0e5 … 8.0e5`.

**Naprawa.** Epsilon względny + jawna ścieżka „pole stałe":

```glsl
float scale = max(abs(fmScalarMax), abs(fmScalarMin));
float span  = fmScalarMax - fmScalarMin;
float t = span > 1e-6 * max(scale, 1.0)
  ? clamp((vScalarValue - fmScalarMin) / span, 0.0, 1.0)
  : 0.5;   // zdegenerowany zakres → środek palety
```
Analogicznie w `normalizeScalarValue` i `scalarValueColorRgb`. Dodatkowo rozszerzać zdegenerowany zakres po stronie CPU przed wysłaniem uniformów.

---

### <a id="s-06"></a>S-06 · **WYSOKI** · Brak sanityzacji NaN/Inf w shaderze i **trzy niezgodne** implementacje wyznaczania zakresu

**Lokalizacja:** `viewport3dFieldMapping.ts:847-861`, `:1258-1271`; `field-colors/viewport3dFieldColorBuildModel.ts:291-311`; `viewport3dScalarSurfaceShader.ts:514-517`

```ts
// viewport3dFieldMapping.ts:847-858 — Math.min/max PROPAGUJE NaN
let min = Infinity, max = -Infinity;
for (...) { min = Math.min(min, value); max = Math.max(max, value); }
if (!Number.isFinite(min) || !Number.isFinite(max)) return { max: 0, min: 0 };
```
```ts
// viewport3dFieldColorBuildModel.ts:297-301 — porównania POMIJAJĄ NaN
if (value < min) min = value;
if (value > max) max = value;
```

**Przyczyna źródłowa.** Trzy funkcje liczące ten sam zakres mają trzy różne semantyki wobec NaN:
* `resolveScalarRange` (`Math.min/max`) **propaguje NaN** i przez `!Number.isFinite` degraduje cały zakres do `{0, 0}`;
* `resolveScalarRangeForField` **pomija NaN** dzięki porównaniom `<`/`>`;
* `scalarRangeFromValues` (`:1263`) jawnie filtruje `!Number.isFinite`.

Wybór zależy od ścieżki budowy (worker vs sync vs chunked), więc pojedyncza komórka NaN daje **różny wynik dla różnych trybów**. Po stronie GPU nie ma żadnej ochrony: `clamp(NaN, 0.0, 1.0)` jest w GLSL ES **nieokreślone** (`min(max(NaN,0),1)` na większości sterowników zwraca NaN), po czym wszystkie warunki `t < 0.5` w `mixStops*` są fałszywe i funkcja zwraca `mix(c, d, NaN)` → NaN w `gl_FragColor`.

**Objaw.** (a) Jedna rozbieżna komórka (0/0 w solverze, niezainicjalizowany airbox) powoduje, że colorbar pokazuje `0 … 0` i cała powierzchnia dostaje jeden kolor — użytkownik traci całą wizualizację przez jeden punkt. (b) W innej ścieżce ta sama komórka daje czarne/białe plamy, zależnie od sterownika — zachowanie **niedeterministyczne między przeglądarkami**.

**Naprawa.** Ujednolicić do **jednej** funkcji z jawnym pominięciem nie-skończonych i licznikiem odrzuconych (`nonFiniteCount` już istnieje w `ScalarRangeDiagnostics`), a w shaderze dodać strażnika z kolorem sentinela spoza wszystkich palet:

```glsl
float v = vScalarValue;
bool bad = !(v == v) || abs(v) > 3.0e38;
vec3 c = bad ? vec3(0.85, 0.0, 0.85) : paletteColor(clamp((v - fmScalarMin) / span, 0.0, 1.0));
gl_FragColor = vec4(c, fmOpacity);
```

---

### <a id="s-07"></a>S-07 · **WYSOKI** · Utrata precyzji: wartości fizyczne float64 wrzucane do atrybutu float32, normalizacja dopiero na GPU

**Lokalizacja:** `field-colors/viewport3dFieldColorBuildModel.ts:378-380`; `hooks/useViewport3DScalarColorUpload.ts:602-610`; `viewport3dScalarSurfaceShader.ts:515-516`

```ts
if (scalarValues) {
  scalarValues[targetIndex] = scalarAt(fieldVector, pointIndex, colorMode);   // f64 → f32, BEZ normalizacji
}
```

**Przyczyna źródłowa.** `fieldVector.values` to `Float64Array`. Skalar zapisywany jest bez normalizacji do `Float32Array` (24 bity mantysy), a normalizacja `(v − min)/span` wykonuje się dopiero we fragmencie, na dwóch float32. To **katastrofalne odejmowanie**: gdy interesujące okno jest wąskie względem wartości bezwzględnej (np. `H_exch ∈ [7.9995e5, 8.0005e5]`, span 100 przy wartościach 8e5), ULP float32 wynosi 0.0625, więc na całą mapę koloru przypada ~1600 rozróżnialnych poziomów zamiast 2²⁴. W gorszym przypadku (`span/|v| < 1e-7`) **wszystkie** wierzchołki zaokrąglają się do tej samej liczby i mapa staje się jednolita. Symetrycznie, wartości poniżej ~1.2e-38 (gęstości energii w J na komórkę) wpadają w denormale float32 i są zerowane.

**Objaw.** Mapa pola z małą modulacją na dużym tle jest schodkowa (widoczne pasy kwantyzacji) albo całkowicie płaska, mimo że colorbar pokazuje niezerowy zakres.

**Naprawa.** Normalizować **na CPU w float64** i wysyłać na GPU już `t ∈ [0,1]`:

```ts
const inv = span > 0 ? 1 / span : 0;
scalarValues[i] = span > 0 ? Math.min(1, Math.max(0, (scalarAt(...) - min) * inv)) : 0.5;
```
Shader upraszcza się do `float t = clamp(vScalarValue, 0.0, 1.0);`, a `fmScalarMin/Max` służą już tylko colorbarowi.
**Uwaga:** wymaga to unieważnienia bufora przy zmianie zakresu — klucz `rawModeBufferKey` (`model/modeCompositionViewportProjection.ts:530-550`) musi zacząć zawierać `min`/`max`.
Alternatywa bez zmiany kontraktu: wysyłać `v − min` (nie surowe `v`) jako float32.

---

### <a id="s-08"></a>S-08 · **KRYTYCZNY** · Nowy `ShaderMaterial` i pełna rekompilacja programu GL **w każdej klatce** animacji fazy modu

**Lokalizacja:** `layers/MeshPartLayer.tsx:904-933`, `:645-674`; `hooks/useViewport3DScalarColorUpload.ts:404-413`; `model/modeCompositionViewportProjection.ts:161-195`

```tsx
const scalarShaderMaterial = useMemo(() => {
  ...
  return tracker.track("material", createScalarSurfaceShaderMaterial(scalarShaderBuffer, {...}));
}, [ ..., scalarShaderBuffer, surfaceOpacity, surfacePolicy, tracker ]);
```

**Przyczyna źródłowa — łańcuch tożsamości obiektów.** `modeScalarColors` (`:645-674`) ma `modeCompositionPhaseRad` w zależnościach i zwraca **nowy literał obiektu** przy każdej zmianie fazy. Obiekt wędruje przez `effectiveScalarColors` → `useViewport3DScalarShaderColorUpload`, gdzie ścieżka „reuse" (`useViewport3DScalarColorUpload.ts:404-413`) publikuje **nowy** `colorBuffer` do store'a, mimo że atrybuty GPU nie są ponownie wysyłane. Nowa referencja trafia do `scalarShaderBuffer` → `useMemo` tworzy nowy `ShaderMaterial`.

Cleanup poprzedniego efektu (`:930-933`) wywołuje `tracker.release("material", ...)` → `material.dispose()` → `WebGLRenderer.releaseProgram()` zmniejsza `usedTimes` do zera **zanim** nowy materiał został po raz pierwszy wyrenderowany, więc program jest usuwany (`gl.deleteProgram`) i przy najbliższym `render()` kompilowany i **linkowany od zera**. Link programu GLSL to 3-15 ms **synchronicznego** czasu na wątku głównym.

**Objaw.** Animacja fazy modu (odtwarzanie drgania magnonowego) zamiast płynnych 60 fps daje 5-20 fps z równomiernym „stukaniem". Przy wielu częściach siatki koszt mnoży się przez liczbę części. Licznik `materialsDisposed` w diagnostyce rośnie liniowo z czasem animacji.

**Naprawa.** Materiał musi zależeć wyłącznie od **kształtu programu**, nie od danych:

```tsx
const shaderKey = `${shaderColorModeId(...)}:${hasComplexShaderValues(buf)}`;
const scalarShaderMaterial = useMemo(
  () => createScalarSurfaceShaderMaterial(...),
  [shaderKey, tracker],                       // bez scalarShaderBuffer, bez surfaceOpacity
);
useEffect(() => {
  if (!scalarShaderMaterial) return;
  updateScalarSurfaceShaderMaterial(scalarShaderMaterial, buffer, surfaceOpacity);
  applyPolicy(scalarShaderMaterial, surfacePolicy);
  invalidate();
}, [buffer, surfaceOpacity, surfacePolicy, scalarShaderMaterial]);
```

`updateScalarSurfaceShaderMaterial` **już istnieje** i poprawnie aktualizuje same uniformy (`viewport3dScalarSurfaceShader.ts:207-223`) — wystarczy przestać obok niej rekreować materiał. Dodatkowo ścieżka „reuse" powinna publikować **poprzedni** obiekt bufora, skoro dane GPU się nie zmieniły.

---

### <a id="s-09"></a>S-09 · **ŚREDNI** · Przełączanie wariantów przez podmianę stringów shaderów + `needsUpdate` zamiast `defines`

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:182-197`, `:271-283`, `:377-454`

```ts
if (material.vertexShader !== nextVertexShader || material.fragmentShader !== nextFragmentShader) {
  material.vertexShader = nextVertexShader;
  material.fragmentShader = nextFragmentShader;
  material.needsUpdate = true;
}
```

**Przyczyna źródłowa.** Cztery warianty shadera (skalar/orientacja × rzeczywisty/zespolony) rozróżniane przez podmianę całego źródła. `needsUpdate = true` inkrementuje `material.version`, co przy najbliższym `setProgram` wymusza `initMaterial` → nowy `programCacheKey` → `acquireProgram`. Programy są cache'owane po treści źródła, więc powrót do wariantu jest tani, ale: (a) każde pierwsze wejście w wariant to synchroniczny link programu widoczny jako zacięcie; (b) różnice między wariantami to dosłownie 6 linii kodu, powielonych w czterech stałych (`:377-454` to dwie niemal identyczne kopie funkcji `projectComplex`).

**Naprawa.** Jeden shader z `defines` (`FM_ORIENTATION`, `FM_COMPLEX`) + prekompilacja wszystkich czterech kombinacji przy montowaniu sceny przez `renderer.compileAsync(scene, camera)` (three r183, oparte na `KHR_parallel_shader_compile`).

---

### <a id="s-10"></a>S-10 · **ŚREDNI** · Palety odtworzone z 3-5 przystanków — banding, utrata percepcyjnej jednorodności, obecność `jet`

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:465-512`

```glsl
vec3 mixStops4(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  if (t < 0.3333333) return mix(a, b, t * 3.0);
  if (t < 0.6666667) return mix(b, c, (t - 0.3333333) * 3.0);
  return mix(c, d, (t - 0.6666667) * 3.0);
}
```

**Przyczyna źródłowa.** Viridis (256 próbek w matplotlib) jest tu aproksymowany **4 punktami**, inferno/magma/twilight pięcioma. Interpolacja jest kawałkami liniowa w przestrzeni sRGB — funkcja jest ciągła (C⁰), ale jej pochodna ma skok na granicach `t = 1/3` i `t = 2/3`. Ludzki układ wzrokowy wykrywa nieciągłość pochodnej jasności jako **pasma Macha** — ostre linie na gładkim gradiencie. Dodatkowo liniowa interpolacja w sRGB między `#31688E` a `#35B779` przechodzi przez barwy, których w prawdziwym viridisie nie ma (odchyłka ΔE2000 rzędu 8-12), więc mapa **przestaje być percepcyjnie jednorodna** — czyli traci dokładnie tę własność, dla której viridis został stworzony. Osobno: `fmPaletteId == 3` to `jet` (`:502-504`) — mapa niemonotoniczna w luminancji, dyskwalifikowana w publikacjach naukowych.

**Objaw.** Na gładkim polu (np. `mz` w wirze) widać 2-4 nienaturalne obręcze w miejscach przystanków; kolory nie zgadzają się z tymi samymi danymi wyeksportowanymi do matplotlib.

**Naprawa.** Przenieść paletę do **tekstury LUT** (`DataTexture`, 256 × N_PALET, `RGBAFormat`, `LinearFilter`, `ClampToEdgeWrapping`), generowanej raz z tych samych tablic co colorbar CPU:

```glsl
uniform sampler2D fmPaletteLut;
vec3 paletteColor(float t) {
  float row = (float(fmPaletteId) + 0.5) / float(FM_PALETTE_COUNT);
  return texture2D(fmPaletteLut, vec2(clamp(t, 0.0, 1.0), row)).rgb;
}
```
Gwarantuje to identyczność GPU ↔ colorbar (jedno źródło prawdy), usuwa banding (sprzętowa interpolacja 256 próbek) i pozwala trywialnie dodać kolejne mapy. `jet` oznaczyć jako deprecated.

---

### <a id="s-11"></a>S-11 · **WYSOKI** · Cała `Viewport3DScalarRangePolicy` jest martwa — palety rozbieżne bez symetryzacji, zakres ręczny bez efektu

**Lokalizacja:** `model/viewport3DFieldDataPlan.ts:71-77`, `:276-282`; `model/viewport3DColorbarPlan.ts:375-384`; `field-colors/viewport3dFieldColorBuildModel.ts:281-311`

```ts
export interface Viewport3DScalarRangePolicy {
  max: number | null;
  min: number | null;
  mode: "auto" | "manual" | "shared";
  scale: "diverging" | "linear" | "log";
  symmetric: boolean;
}
```

**Przyczyna źródłowa.** `grep` po `policy.scale|policy.symmetric|"diverging"|scale === "log"` w całym module zwraca wyłącznie deklarację typu, wartość domyślną i funkcję **budującą klucz cache** (`viewport3DColorbarPlan.ts:375-384`). **Nie istnieje żadna ścieżka**, która zastosowałaby `symmetric`, `log`, `diverging` ani ręczne `min`/`max` do faktycznego mapowania koloru — `resolveScalarRangeForField` zwraca surowe `{min, max}` z danych, a shader liniowo mapuje je na `[0,1]`.

Dla palety rozbieżnej `coolwarm` (`:496-498`: niebieski → biały `#DDDDDD` → czerwony) punkt biały leży przy `t = 0.5`, czyli przy `(min+max)/2`. Dla `mz ∈ [−0.2, 1.0]` biel wypada przy `mz = 0.4`, a **nie przy 0**. Jedyne miejsce, gdzie symetryzacja *jest* zaimplementowana, to ścieżka kompozycji modów (`modeCompositionViewportProjection.ts:516-518`) — ten sam typ danych zachowuje się różnie w dwóch trybach.

**Objaw.** Na mapie składowej `mz` domeny o `mz = 0` (ściany domenowe, rdzeń wiru) **nie są białe**, tylko jasnoniebieskie lub jasnoczerwone — użytkownik odczytuje przesunięty znak. Przy zmianie kroku czasowego punkt zerowy „pływa", bo `min`/`max` zmienia się z klatki na klatkę, więc ta sama ściana domenowa zmienia kolor w trakcie animacji. **Ustawienia zakresu ręcznego w inspektorze nie mają żadnego efektu** poza unieważnieniem cache.

**Naprawa.** Zaimplementować politykę w jednym miejscu, przed budową bufora:

```ts
function applyRangePolicy(raw: ScalarRange, p: Viewport3DScalarRangePolicy): ScalarRange {
  if (p.mode === "manual" && p.min != null && p.max != null && p.min < p.max) return { min: p.min, max: p.max };
  if (p.symmetric || p.scale === "diverging") {
    const a = Math.max(Math.abs(raw.min), Math.abs(raw.max));
    return { min: -a, max: a };
  }
  return raw;
}
```
i wywołać w `resolveScalarRangeForField` oraz `resolveScalarRange`. Dla `scale === "log"` dodać uniform `fmScaleId` i `t = log(max(v,eps)/min) / log(max/min)`. Wybór palety rozbieżnej powinien **wymuszać** `symmetric = true`.

---

### <a id="s-12"></a>S-12 · **WYSOKI** · `atan(0.0, 0.0)` — zachowanie niezdefiniowane; „phase" + „magnitude" liczy `length()` z wektora faz

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:391-406`, `:434-442`; `model/modeCompositionViewportProjection.ts:496-498`

```glsl
float scalarFromVector(vec3 value) {
  if (fmColorModeId == 2) return value.x;
  if (fmColorModeId == 3) return value.y;
  if (fmColorModeId == 4) return value.z;
  return length(value);
}
vec3 projectComplex(vec3 complexReal, vec3 complexImag, float theta) {
  ...
  if (fmRepresentationId == 4) return atan(complexImag, complexReal);
```

**Przyczyna źródłowa — dwa defekty w tej samej gałęzi.**
1. Specyfikacja GLSL ES mówi wprost, że `atan(y, x)` jest **nieokreślony, gdy `x` i `y` są jednocześnie zerem**. Dla węzłów bez amplitudy modu (powietrze, węzły poza nośnikiem modu, komórki wyzerowane) `complexReal.c == complexImag.c == 0.0` — sterowniki zwracają 0, NaN albo wartość losową (Mesa / ANGLE / Metal różnią się).
2. `projectComplex` dla `fmRepresentationId == 4` zwraca **wektor trzech niezależnych faz** `(φx, φy, φz)`. Gdy `fmColorModeId == 0` (component = `magnitude`, osiągalne przez `colorModeForComponent`), `scalarFromVector` liczy `length((φx, φy, φz))` — euklidesową normę **trzech kątów**. Wynik leży w `[0, π√3] ≈ [0, 5.44]`, podczas gdy zakres dla reprezentacji „phase" to `{min: −π, max: π}` — **połowa dziedziny palety jest nieosiągalna**, a górna połowa wyników jest obcinana przez `clamp`.

**Objaw.** W trybie „phase" + „magnitude" mapa cyklicznego twilighta jest bez sensu: dolna połowa palety nie występuje, duże obszary są nasycone kolorem końcowym, granice domen nie pokrywają się ze ścianami fazowymi. W obszarach zerowej amplitudy pojawiają się czarne lub migoczące plamy, **różne na różnych maszynach** (klasyczne „u mnie działa").

**Naprawa.**
```glsl
float safeAtan2(float y, float x) {
  return (abs(x) < 1e-30 && abs(y) < 1e-30) ? 0.0 : atan(y, x);
}
if (fmRepresentationId == 4) {
  if (fmColorModeId == 2) return vec3(safeAtan2(complexImag.x, complexReal.x));
  if (fmColorModeId == 3) return vec3(safeAtan2(complexImag.y, complexReal.y));
  if (fmColorModeId == 4) return vec3(safeAtan2(complexImag.z, complexReal.z));
  return vec3(safeAtan2(sign(dot(complexImag, complexReal)) * length(complexImag), length(complexReal)));
}
```
Dodatkowo w UI zablokować kombinację `representation = "phase"` + `component = "magnitude"` albo jawnie zdefiniować jej semantykę.

---

### <a id="s-13"></a>S-13 · **ŚREDNI** · Brak redukcji argumentu przed `sin`/`cos` — degradacja fazy Floqueta przy dużych `k·r`

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:408-418`, `:444-453`

```glsl
float theta = fmTemporalPhaseSign * fmPhaseRad;
if (fmFloquetActive == 1) {
  theta += fmSpatialPhaseSign * dot(fmWavevectorKf, position - fmCellOrigin);
}
```

**Przyczyna źródłowa.** `theta` nigdy nie jest zawijane do `[−π, π]`. Wektor falowy w mikromagnetyzmie ma skalę `k ≈ 10⁷–10⁸ rad/m`; dla komórki o rozmiarze `10⁻⁶–10⁻⁵ m` iloczyn `k·(r − r₀)` osiąga `10²–10³`, a przy większych superkomórkach `10⁴+`. `sin`/`cos` w GLSL ES nie mają gwarantowanej dokładności poza małym zakresem — sterowniki mobilne i ANGLE/D3D implementują redukcję argumentu w float32, gdzie przy `|x| > ~10⁴` błąd redukcji przekracza wartość samej fazy. Dodatkowo `position − fmCellOrigin` to odejmowanie dwóch bliskich float32.

**Objaw.** Wizualizacja modu Floqueta z niezerowym `k` pokazuje szum fazowy zamiast regularnej fali biegnącej; wzór interferencyjny jest inny na Chrome/Windows (ANGLE) niż na Firefox/Linux; przy animacji fala drga zamiast płynąć.

**Naprawa.** `theta = mod(theta + PI, TWO_PI) - PI;` — a docelowo policzyć `k·r` po stronie CPU w float64 i wysłać zawiniętą fazę przestrzenną jako dodatkowy atrybut float32.

---

### <a id="s-14"></a>S-14 · **ŚREDNI** · Powierzchnie półprzezroczyste: `DoubleSide` + `depthWrite: false` + sortowanie per-obiekt

**Lokalizacja:** `layers/viewport3DRenderPolicy.ts:51-70`; `layers/MeshPartLayer.tsx:1012-1032`

**Przyczyna źródłowa.** Przy `depthWrite: false` i `side: DoubleSide` trójkąty tej samej bryły są rysowane w kolejności bufora indeksów, bez sortowania wewnątrzobiektowego (three sortuje tylko obiekty, po `renderOrder`, potem po `z` środka bounding sphere). Blending `SrcAlpha, OneMinusSrcAlpha` **nie jest przemienny**, więc wynikowy kolor zależy od kolejności trójkątów. Ściany tylne i przednie tej samej powłoki mieszają się ze sobą, podwajając gęstość półprzezroczystości. Wszystkie `contextSurface` mają ten sam `renderOrder = 10`, więc dwie nakładające się części są sortowane po odległości środków — dla przenikających się brył (warstwa magnetyczna w airboxie) daje to skokowe przełączenie kolejności przy obrocie.

**Objaw.** Przy `opacity < 1` powierzchnia miga i zmienia jasność przy obrocie kamery; nakładające się części zamieniają się kolejnością skokowo; wnętrze prześwituje niejednorodnymi łatami. Blending odbywa się w przestrzeni sRGB (S-02), więc mieszanie daje wynik ciemniejszy niż fizycznie poprawny.

**Naprawa.** Dla powłok zamkniętych rozdzielić na dwa przebiegi zamiast `DoubleSide`: `BackSide` (renderOrder 10) i `FrontSide` (renderOrder 11) — poprawna kolejność „tył przed przodem" bez sortowania per-trójkąt. Dla przypadku ogólnego: depth pre-pass (`colorWrite: false`) albo ważone OIT. Minimalnie: nadać różnym częściom `renderOrder` wynikające z zagnieżdżenia (airbox zawsze po powierzchni magnetycznej).

---

### <a id="s-15"></a>S-15 · **ŚREDNI** · Przełącznik antyaliasingu nie działa; włączenie efektu po cichu zmienia tryb AA

**Lokalizacja:** `viewport3dVisualProfile.ts:172-188`; `layers/PostProcessingLayer.tsx:7-9`, `:34-40`

```ts
export function resolveViewport3DCanvasGlOptions(profile, _antialiasOverride?: boolean) {
  void _antialiasOverride;                 // ← jawnie porzucony
  return { alpha: false, antialias: profile.antialias, ... };
```

**Przyczyna źródłowa.** MSAA kontekstu WebGL zależy wyłącznie od profilu wizualnego, nie od przełącznika użytkownika. Flaga `effectAntialias` jest czytana tylko w `PostProcessingLayer` jako `multisampling` composera — ale composer w ogóle nie istnieje, gdy oba efekty są wyłączone (`:7-9` zwraca `null`). Efekt uboczny: włączenie samego Bloom przekierowuje rendering do offscreenowego targetu, gdzie MSAA kontekstu przestaje działać.

**Objaw.** (a) Przełącznik „Antialiasing" nie robi nic w trybie bez efektów. (b) Włączenie „Bloom"/„AO" skokowo zmienia jakość krawędzi bez związku z nazwą opcji.

**Naprawa.** Zawsze montować `EffectComposer` (nawet z pustą listą efektów) i uczynić `multisampling` jedynym źródłem AA — wtedy przełącznik działa spójnie. Minimalnie: wyszarzyć przełącznik AA, gdy żaden efekt nie jest aktywny.

---

### <a id="s-16"></a>S-16 · **ŚREDNI** · Postprocessing: próg Bloom na wartościach nieliniowych, `aoRadius` w jednostkach świata, N8AO nie widzi powierzchni przezroczystych

**Lokalizacja:** `layers/PostProcessingLayer.tsx:11-32`

```tsx
<N8AO key="ao" aoRadius={0.5} intensity={2.5} halfRes color="black" />
<Bloom key="bloom" luminanceThreshold={0.5} luminanceSmoothing={0.1} intensity={1.2} />
```

**Przyczyna źródłowa.**
* `luminanceThreshold={0.5}` interpretowany jest na wartościach zakodowanych sRGB (S-02/S-03). Luminancja żółtego końca viridisa `(0.992, 0.906, 0.145)` wynosi ≈ 0.90, zielonego ≈ 0.58 — czyli **górna połowa każdej palety** przekracza próg i świeci. W poprawnej przestrzeni liniowej byłoby to 0.79 i 0.29.
* `aoRadius={0.5}` jest w jednostkach świata, a scena mikromagnetyczna ma skalę nanometrową: przy `1e-6` promień 0.5 obejmuje całą scenę (AO degeneruje się do stałego przyciemnienia), przy `1e3` nie obejmuje niczego.
* Wszystkie powierzchnie przezroczyste mają `depthWrite: false`, więc nie zapisują głębokości — N8AO rekonstruuje okluzję z bufora głębi i ich **nie widzi**.

**Objaw.** Bloom przepala połowę mapy kolorów, niszcząc czytelność wartości. AO albo nie robi nic, albo przyciemnia scenę jednolicie. Krawędzie i punkty wyglądają, jakby unosiły się nad zacienioną geometrią.

**Naprawa.** Bloom na luminancji liniowej z `luminanceThreshold ≥ 1.0` — a właściwie: w tej scenie **nie ma źródeł HDR** (to unlit mapa kolorów), więc Bloom nie ma czego prześwietlać i najlepiej go usunąć. `aoRadius={sceneRadius * 0.05}`. Dla AO na powierzchniach kontekstowych — depth pre-pass albo jawna decyzja, że AO liczone jest tylko na `solidSurface`.

---

### <a id="s-17"></a>S-17 · **NISKI** · Martwa konfiguracja wizualna: `toneMapping`, `lighting`, `figureBoost` nigdy nie przyjmują innej wartości

**Lokalizacja:** `viewport3dVisualProfile.ts:40-149`, `:190-202`; `layers/viewport3DMaterialProfile.ts:48-93`

Wszystkie pięć profili (`interactive-lite`, `interactive`, `balanced`, `figure`, `capture`) ma `lighting: "minimal"` i `toneMapping: "none"`. W konsekwencji `figureBoost` jest zawsze 0, `toneMapped` zawsze `false`, gałąź `ACESFilmicToneMapping` (`:194-196`) jest nieosiągalna, a wszystkie warunki `lighting === "minimal" ? a : b` (`viewport3DMaterialProfile.ts:69-91`) zwracają stale pierwszą gałąź.

**Objaw.** Przełączanie profilu zmienia tylko rozdzielczość, liczbę glifów i krycie krawędzi. Profil „Figure"/„Capture" nie różni się oświetleniem ani mapowaniem tonalnym, wbrew nazwie.

**Naprawa.** Albo nadać profilom realnie różne wartości (po naprawie S-02), albo usunąć pola `lighting`/`toneMapping`/`toneMappingExposure` i uprościć `resolveViewport3DMaterialProfile`. Stan obecny generuje martwe ścieżki, których nie pokrywa żaden test.

---

### <a id="s-18"></a>S-18 · **ŚREDNI** · Dwie równoległe implementacje uploadu atrybutów — testowana jest ta, której produkcja nie używa

**Lokalizacja:** `viewport3dScalarSurfaceShader.ts:55-124`, `:285-305`; `hooks/useViewport3DScalarColorUpload.ts:475-577`; `viewport3dScalarSurfaceShader.test.ts:56-110`

`grep -rn "applyScalarShaderColorBuffer"` (z pominięciem `.test.`) zwraca **wyłącznie definicję** — jedynym konsumentem są testy (`:61,77,93`). Analogicznie `applyVertexScalarColors` (`viewport3dGeometryColors.ts:28`) nie ma produkcyjnego wywołania. Produkcja używa `createViewport3DScalarShaderColorUploadPlan`, która ma **inną semantykę**: alokuje własny `Float32Array` i kopiuje partiami po 8192 wierzchołków z `addUpdateRange`, podczas gdy martwa ścieżka przypina bufor źródłowy bez kopii i bez zakresów.

**Objaw.** Fałszywe poczucie pokrycia testami — regresja w rzeczywistej ścieżce uploadu (np. błąd offsetu w `addUpdateRange`, `:555`) przechodzi przez zielony zestaw testów shadera. Dodatkowo dwie implementacje różnią się zużyciem pamięci, więc szacunki w ledgerze pamięci mogą się rozjeżdżać.

**Naprawa.** Usunąć `applyScalarShaderColorBuffer`, `deleteShaderAttributes`, `setFloatAttribute`, `applyVertexScalarColors`; przepisać testy tak, aby celowały w `createViewport3DScalarShaderColorUploadPlan` (wywołując `chunk.upload()` i `onVisible()` ręcznie).

---

### <a id="s-19"></a>S-19 · **ŚREDNI** · Atrybuty skalarne aktualizowane co klatkę pozostają w `StaticDrawUsage`

**Lokalizacja:** `hooks/useViewport3DScalarColorUpload.ts:303-306`, `:602-610`; dla kontrastu `layers/VectorFieldLayer.tsx:583`

`BufferAttribute` domyślnie ma `usage = StaticDrawUsage` → `gl.bufferData(..., GL_STATIC_DRAW)`. Warstwa glifów (`VectorFieldLayer.tsx:583`) i kuboidy FDM (`FdmCuboidLayer.tsx:620`) poprawnie deklarują `DynamicDrawUsage`, ale atrybuty `fmScalarValue` / `fmVectorValue` / `fmComplexRealValue` / `fmComplexImagValue` — dokładnie te nadpisywane w **każdym kroku animacji fazy** — nie. Sterownik alokuje je w pamięci przeznaczonej do jednokrotnego zapisu; częste `bufferSubData` na `STATIC_DRAW` powoduje realokację bufora lub synchronizację potoku.

**Naprawa.** `if (!existingAttribute) attribute.setUsage(DynamicDrawUsage);` — hint musi być ustawiony **przed pierwszym** `bufferData`, czyli w momencie tworzenia atrybutu.

---

### <a id="s-20"></a>S-20 · **NISKI** · `buildSurfaceEdgeGeometryFromBufferGeometry` klonuje cały bufor pozycji zamiast go współdzielić

**Lokalizacja:** `viewport3dSurfaceEdges.ts:28-45`

```ts
const geometry = new BufferGeometry();
geometry.setAttribute("position", position.clone());   // ← nowy Float32Array + nowy bufor GPU
```

Moduł ma dedykowany mechanizm współdzielenia (`attachViewport3DSharedTopologyPosition`, `viewport3dSharedTopologyPositions.ts:16-36`, z licznikiem właścicieli i przechwyceniem `dispose`), używany przez `buildLineIndexGeometry` i `createMeshPartSurfaceGeometry`. Ta funkcja go pomija.

**Naprawa.** `attachViewport3DSharedTopologyPosition(geometry, position.array as Float32Array);`

---

### <a id="s-21"></a>S-21 · **NISKI** · `setTimeout(…, 0)` jako yield — 4 ms martwego czasu na każde 10 000 punktów

**Lokalizacja:** `hooks/useViewport3DChunkedScalarColors.ts:1457-1467`; `field-colors/viewport3dFieldColorBuildModel.ts:360-362`

Domyślny `chunkSize` to 10 000, a po każdej porcji budowa czeka na `setTimeout(0)`. Specyfikacja HTML wymusza minimalne opóźnienie 4 ms po piątym zagnieżdżonym timerze, a większość przeglądarek stosuje je od razu w łańcuchu zadań makro. Dla pola o 1 mln punktów to 100 porcji × ~4 ms = **~400 ms samego oczekiwania** przy czasie liczenia rzędu 60 ms. Ścieżka używana jest w fallbacku (gdy worker zawiódł) — czyli wtedy, gdy wydajność ma największe znaczenie.

**Naprawa.** `scheduler.yield()` z fallbackiem do `MessageChannel` (nie podlega zaciskowi 4 ms), a sam yield uczynić warunkowym (dopiero po przekroczeniu budżetu `performance.now() - start > 4`), a nie po każdej porcji o stałym rozmiarze.

---

## 5. Strzałki / glify wektorowe i airbox

### <a id="v-01"></a>V-01 · **KRYTYCZNY** · Kwaterniony, kompozycja macierzy i `setMatrixAt` dla każdej strzałki na wątku UI

**Lokalizacja:** `layers/VectorFieldLayer.tsx:989-1024`; kontrakt danych `layers/vectorGlyphGeometry.ts:116-123`; worker `layers/vectorGlyphBuildWorker.ts:26`

```ts
upload: () => {
  for (let index = batch.start; index < batch.end; index += 1) {
    const offset = index * 3;
    direction.set(activeGlyphs.directions[offset] ?? 0, ...);
    quaternion.setFromUnitVectors(UNIT_Y, direction);
    position.set(activeGlyphs.shaftCenters[offset] ?? 0, ...);
    scale.set(activeGlyphs.shaftScales[offset] ?? 0, ...);
    matrix.compose(position, quaternion, scale);
    activeShaft.setMatrixAt(index, matrix);
    // ...to samo dla activeHead
```

**Przyczyna źródłowa.** Worker zwraca **wyłącznie surowe składowe** (`directions`, `shaftCenters`, `shaftScales`, `headCenters`, `headScales`). Cała trygonometria — `setFromUnitVectors` (normalizacja + iloczyn wektorowy + normalizacja kwaternionu) i **dwa** `matrix.compose` (mnożenie macierzy 4×4) — wykonuje się na wątku głównym, po 2 macierze na glif. Dla 200 tys. strzałek to ~400 tys. kompozycji i 6,4 mln zapisów do `Float32Array`.

**Objaw.** Zacinanie kamery i spadek FPS przy każdej zmianie pola lub budżetu strzałek. Przycinanie do 3 ms/klatkę (`VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS`) rozciąga to na setki klatek — strzałki „dojeżdżają" sekundami.

**Naprawa.** Przenieść kompozycję do workera. `buildVectorGlyphTransforms` powinien od razu produkować dwa `Float32Array(count*16)` (`shaftMatrices`, `headMatrices`) i dodać je do `transferablesForVectorGlyphBuildResult`. Na wątku głównym zostaje wtedy **wyłącznie memcpy**:

```ts
(mesh.instanceMatrix.array as Float32Array).set(chunk, offset);
```

To zmienia charakter operacji z O(N) obliczeń na O(N) kopiowania i pozwala kilkukrotnie zwiększyć `VECTOR_GLYPH_UPLOAD_BATCH_SIZE` (obecnie 256).

---

### <a id="v-02"></a>V-02 · **WYSOKI** · Dwa `InstancedMesh` na pole zamiast jednej scalonej geometrii; obrót policzalny w vertex shaderze

**Lokalizacja:** `layers/VectorFieldLayer.tsx:486-503`, `:1288-1305`; `layers/vectorGlyphGeometry.ts:90-113`

```jsx
<instancedMesh args={[shaftGeometry, material, capacity]} frustumCulled={false} key={`vector-shaft-${capacity}`} ... />
<instancedMesh args={[headGeometry,  material, capacity]} frustumCulled={false} key={`vector-head-${capacity}`}  ... />
```
```ts
const headLength  = length * headLengthRatio;    // 0.28 * length
const shaftLength = Math.max(length - headLength, 0);
const shaftRadius = length * shaftRadiusRatio;   // 0.035 * length
const headRadius  = length * headRadiusRatio;    // 0.10 * length
```

**Przyczyna źródłowa.** **Wszystkie** wymiary glifu są liniowe względem `length`, więc trzon i grot są jednorodnym przeskalowaniem jednego kanonicznego glifu. Mimo to trzymane są dwie geometrie, dwa bufory `instanceMatrix` (2 × 64 B/instancję) i generowane są 2 draw calle na pole. `material` jest tym samym obiektem, więc scalenie jest trywialne. Do tego `frustumCulled={false}` odbiera GPU jedyną tanią optymalizację.

**Naprawa — dwa kroki, oba niezależnie opłacalne.**

1. **Scalić geometrie** w jedną `BufferGeometry` w przestrzeni kanonicznej (podstawa w `y=0`, ostrze w `y=1`) przez `BufferGeometryUtils.mergeGeometries`. Wtedy jedna macierz `compose(start, quaternion, new Vector3(L, L, L))` obsługuje cały glif → **1 mesh, 1 draw call, 16 B/instancję zamiast 32**.
2. **Zrezygnować z macierzy** na rzecz `InstancedBufferAttribute`: `aStart` (vec3), `aDir` (vec3), `aLength` (float) = **7 floatów zamiast 32**, a obrót zbudować w vertex shaderze wzorem Rodriguesa dla bazy `(0,1,0)`, z jawną gałęzią dla przypadku antyrównoległego (`dot(up, aDir) ≈ −1`). Zysk: 4,5× mniej pasma i zero pracy CPU per glif.

---

### <a id="v-03"></a>V-03 · **WYSOKI** · Zerowy wektor pola dostaje `relMag = 1` — maksimum skali kolorów zamiast minimum

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:1334` + `:1354`; identycznie `:558` + `:581`

```ts
const length = Math.hypot(vx, vy, vz) || 1;   // ← ochrona przed dzieleniem przez zero
const ux = vx / length;
const uy = vy / length;
const uz = vz / length;
...
segments[target + 6] = length / scaleMagnitude;   // ← ta sama zmienna jako FIZYCZNA długość
```

**Przyczyna źródłowa.** `|| 1` chroni przed dzieleniem przez zero, ale zmienna `length` jest potem **ponownie użyta jako fizyczna długość wektora** przy zapisie kanału 7 (`relMag`). Dla komórki o `|M| = 0` zapisywana jest wartość `1 / scaleMagnitude` zamiast `0`. Ponieważ `scaleMagnitude = max(maxMagnitude, 1e-12)` liczone jest z prawdziwych wartości, dla pola znormalizowanego (`|m| ≤ 1`, typowe dla `m`) daje to `relMag = 1` — **koniec skali kolorów**.

**Objaw.** W trybie kolorowania „magnitude" komórki o zerowej magnetyzacji (pustka, airbox, obszary wygaszone) dostają kolor **końca** palety (żółty w viridis) zamiast początku. Efekt jest częściowo maskowany tym, że taki glif ma skalę 0 (jest niewidoczny), ale ujawnia się natychmiast w każdym innym konsumencie kanału 7 i w `resolveSegmentColorRange`.

**Naprawa** (w obu ścieżkach — `1334/1354` i `558/581`):
```ts
const magnitude = Math.hypot(vx, vy, vz);
const length = magnitude || 1;                    // tylko do normalizacji kierunku
...
segments[target + 6] = magnitude / scaleMagnitude;
```

---

### <a id="v-04"></a>V-04 · **KRYTYCZNY** · Cienki film (`nz = 1`) traci całe wnętrze w trybie „surface" — normalna się zeruje

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:654-669`; sprzeczna implementacja `:1210-1231`; użycia `:604-612`, `:1157-1177`

```ts
const ix = cellIndex % nx;
const iy = Math.floor(cellIndex / nx) % ny;
const iz = Math.floor(cellIndex / (nx * ny)) % nz;
let normalX = 0, normalY = 0, normalZ = 0;
if (ix === 0      || !targetAt(cellIndex - 1))  normalX -= 1;
if (ix === nx - 1 || !targetAt(cellIndex + 1))  normalX += 1;
if (iy === 0      || !targetAt(cellIndex - nx)) normalY -= 1;
if (iy === ny - 1 || !targetAt(cellIndex + nx)) normalY += 1;
const planeStride = nx * ny;
if (iz === 0      || !targetAt(cellIndex - planeStride)) normalZ -= 1;
if (iz === nz - 1 || !targetAt(cellIndex + planeStride)) normalZ += 1;
const length = Math.hypot(normalX, normalY, normalZ);
if (length <= 0) return null;                     // ← „to nie jest komórka powierzchniowa"
```

**Przyczyna źródłowa.** Dla `nz === 1` każda komórka spełnia **jednocześnie** `iz === 0` i `iz === nz - 1`, więc `normalZ = −1 + 1 = 0`. Komórka w środku filmu ma też `normalX = 0` i `normalY = 0` → `length === 0` → funkcja zwraca `null`. Ta sama funkcja jest jedynym filtrem w `resolveFdmGeometryScopeInstanceOrdinals` (`:1157-1177`, ścieżka z dokładną membership) i w `resolveAnchorSurfaceOrdinals` (`:604-612`).

Tymczasem **alternatywna ścieżka** `isFdmTargetSurfaceCell` (`:1219-1221`) zwraca `true` dla `iz === 0`, czyli dla tego samego filmu uznaje **wszystkie** komórki za powierzchniowe. Wynik zależy więc od tego, czy do budowy dołączono `realizedRegionIds`.

**Objaw.** Przy włączonym `geometryScope: "surface"` w symulacji cienkowarstwowej — **najczęstszym przypadku w mikromagnetyzmie** — widać tylko obrys/ramkę strzałek zamiast pełnej górnej powierzchni. Dodatkowo zeruje to offset powierzchniowy (`offsetFdmVectorAnchor:684-691` zwraca `[x,y,z]` bez przesunięcia), więc strzałki toną w meshu i migoczą (z-fighting).

**Naprawa.** Rozdzielić „wektor normalnej" od „czy komórka jest powierzchniowa":
* zliczać odsłonięte ściany osobno i traktować komórkę jako powierzchniową gdy `exposedFaces > 0`;
* normalną wyznaczać jako sumę odsłoniętych kierunków, a przy zerowaniu się sumy (płyta jednokomórkowa) wybrać kierunek dodatni tej osi, wzdłuż której siatka ma najmniejszą rozciągłość (dla `nz === 1` → `+Z`);
* ujednolicić `isFdmTargetSurfaceCell` i `resolveFdmSurfaceAnchorNormal` tak, by dawały ten sam zbiór komórek.

---

### <a id="v-05"></a>V-05 · **WYSOKI** · `count` nie jest przycinany do `capacity` — przy > 1 048 576 glifów zapis poza buforem

**Lokalizacja:** `layers/VectorFieldLayer.tsx:470-475`, `:900-905`, `:1038-1040`

```ts
function resolveVectorGlyphCapacity(glyphCount: number): number {
  const desired = Math.max(1, glyphCount);
  let next = 1;
  while (next < desired) next *= 2;
  return Math.min(next, 1 << 20);   // ← twardy cap ~1M
}
...
onVisible: () => {
  activeShaft.count = activeGlyphs.count;   // ← bez Math.min(..., capacity)
  activeHead.count  = activeGlyphs.count;
```

**Przyczyna źródłowa.** `capacity` jest twardo ograniczone do 2²⁰, ale `count` ustawiany jest z `activeGlyphs.count` bez przycięcia. Bufor `instanceMatrix` ma `capacity*16` elementów, `instanceColorAttr` — `capacity*3`. Powyżej progu `colorArray.set(glyphColors.subarray(...), batch.start * 3)` rzuca `RangeError: offset is out of bounds`, a `setMatrixAt` po cichu nic nie zapisuje. `resolveViewport3DMaxVectorGlyphs` jest sterowane stanem wizualizacji i **nie ma twardego capa 1M**.

**Naprawa.**
```ts
const renderCount = Math.min(activeGlyphs.count, capacity);
```
i użycie `renderCount` w `mesh.count`, w `buildVectorGlyphUploadBatches(...)` oraz w `markVectorGlyphAttributeRange`; równolegle zaraportować obcięcie do trackera zamiast cichego rozjazdu.

---

### <a id="v-06"></a>V-06 · **KRYTYCZNY** · Pole `DecodedFieldVector` kopiowane na wątku głównym — i to dwukrotnie

**Lokalizacja:** `layers/fdmCuboidBuildScheduler.ts:237`, `:349-393`, `:401`

```ts
function cloneFdmCuboidBuildRequestForWorker(input, id) {
  return {
    ...input, id,
    modelFieldVector: cloneFieldVectorForWorker(input.modelFieldVector),
    ...
    vectorField:      cloneFieldVectorForWorker(input.vectorField),
```
```ts
function cloneFieldVectorValues(values) {
  recordVisualizationDebugPerformanceMetric("typedArrayCopiedBytes", values.byteLength);
  return new Float64Array(values);
}
```

**Przyczyna źródłowa.** `build()` **synchronicznie** kopiuje `Float64Array` z wartościami pola, żeby móc je przetransferować bez „ogłuszania" oryginału. Gdy `modelFieldVector` i `vectorField` to **ten sam obiekt** (typowe: te same wartości używane do progowania magnitudy i do strzałek), powstają **dwie niezależne kopie**, a warunek deduplikacji w `transferablesForFdmCuboidBuildRequest:401` (`request.vectorField?.values.buffer !== request.modelFieldVector?.values.buffer`) **już nigdy nie trafia**, bo klonowanie właśnie rozdzieliło bufory. Do tego `new Uint32Array(realizedRegionIds)` (`:360`) kopiuje maskę całej domeny.

**Objaw.** Dla siatki 256×256×32 (2,1 mln komórek, 3 składowe, f64) to **50 MB kopiowane dwa razy** przy **każdej** przebudowie — czyli przy każdej klatce odtwarzania histerezy/animacji. Widoczne jako regularne, długie zacięcia wątku głównego skorelowane z odświeżeniem pola.

**Naprawa (rosnąco co do nakładu).**
1. Rozpoznać tożsamość obiektów przed klonowaniem i wysłać **jeden** bufor z flagą `vectorFieldIsModelField: true`.
2. Utrzymywać własność bufora po stronie workera (ping-pong: worker zwraca bufor w odpowiedzi, main thread oddaje go przy kolejnym żądaniu) — całkowicie bez kopii.
3. Docelowo `SharedArrayBuffer` dla wartości pola.
4. Minimalnie: przenieść klon do `queueMicrotask`/chunkować, żeby nie blokować pojedynczej klatki.

---

### <a id="v-07"></a>V-07 · **WYSOKI** · `prepareFdmCuboidInstanceMatrices` — kopia N×16 macierzy w `useMemo`, w większości przypadków tożsamościowa

**Lokalizacja:** `layers/FdmCuboidLayer.tsx:419-428`, `:476-506`, `:1482-1492`

```ts
const ordinals = instanceOrdinals ? new Uint32Array(instanceOrdinals)
                                  : Uint32Array.from({ length: count }, (_, i) => i);
const cellIndices = new Uint32Array(count);
const matrices = new Float32Array(count * 16);
for (let index = 0; index < count; index += 1) {
  const sourceInstance = ordinals[index] ?? 0;
  cellIndices[index] = model.cellIndices[sourceInstance] ?? 0;
  matrices.set(model.matrices.subarray(sourceInstance * 16, sourceInstance * 16 + 16), index * 16);
}
const membershipContentRevision = resolveFdmCuboidMembershipRevision(cellIndices);
```

**Przyczyna źródłowa.** Worker już wyprodukował `model.matrices` w docelowym układzie. Gdy `geometryScopeOrdinals` jest `undefined` (scope „full" bez ordinali — **przypadek domyślny**), pętla wykonuje **czystą kopię tożsamościową**: N alokacji `subarray()` + N wywołań `set()` po 16 floatów, plus hash FNV po `cellIndices`. Dla airboxa 500 tys. komórek to 500 tys. tymczasowych widoków i **32 MB memcpy w jednym `useMemo`**.

**Naprawa.** Skrót dla ścieżki tożsamościowej — gdy `instanceOrdinals == null`, zwrócić bezpośrednio `{ matrices: model.matrices, cellIndices: model.cellIndices, ordinals: null, contentRevision: model.matrixContentRevision, ... }` bez kopii, a `resolveFdmCuboidPreparedSourceOrdinal` obsłużyć `ordinals === null` jako identyczność. Dla ścieżki z ordinalami — przenieść kompakcję do workera (worker zna scope) i transferować gotowy podzbiór.

---

### <a id="v-08"></a>V-08 · **WYSOKI** · Pełny, niechunkowany upload macierzy airboxa — i ta sama macierz wgrywana dwa razy

**Lokalizacja:** `layers/FdmCuboidLayer.tsx:609-625`, `:1180-1193`

```ts
export function uploadFdmCuboidAttribute(attribute, source, contentRevision, uploadedRevision) {
  if (uploadedRevision === contentRevision) return uploadedRevision;
  (attribute.array as Float32Array).set(source);      // ← cała tablica w jednym set()
  attribute.setUsage(DynamicDrawUsage);
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, source.length);
```
```ts
surfaceMatrixRevisionRef.current   = uploadFdmCuboidAttribute(surface.instanceMatrix,   preparedInstances.matrices, ...);
wireframeMatrixRevisionRef.current = uploadFdmCuboidAttribute(wireframe.instanceMatrix, preparedInstances.matrices, ...);
```

**Przyczyna źródłowa.** W przeciwieństwie do ścieżki glifów (która ma `createViewport3DGpuUploadManager` z budżetem 3 ms/klatkę), airbox wgrywa całą tablicę macierzy w jednym `set()` wewnątrz `useEffect` — i robi to **dwa razy dla dokładnie tych samych danych**, bo `surface` i `wireframe` to dwa `InstancedMesh` z osobnymi buforami `instanceMatrix`.

**Objaw.** Pojedyncze, długie zacięcie (2 × 32 MB memcpy + 2 × pełny `bufferSubData`) przy każdej zmianie modelu; podwojone zużycie VRAM na macierze airboxa.

**Naprawa.** (a) Współdzielić jeden `InstancedBufferAttribute` między oba meshe — `wireframe.instanceMatrix = surface.instanceMatrix` (three renderuje z tego samego bufora, wystarczy jeden upload). (b) Przepuścić upload przez ten sam `Viewport3DGpuUploadManager`, który obsługuje glify.

---

### <a id="v-09"></a>V-09 · **WYSOKI** · Raycast inspekcji przechodzi po wszystkich instancjach; `boundingSphere` nigdy nie jest unieważniana

**Lokalizacja:** `layers/FdmCuboidLayer.tsx:1291`, `:1302`, `:1527-1548`

```ts
const targets = visibleFdmCuboidInspectTargets([surfaceRef.current, wireframeRef.current]);
const hit = inspectRaycastState.raycaster
  .intersectObjects(targets, false)
  .find((intersection) => typeof intersection.instanceId === "number");
```
przy `<instancedMesh args={[geometry, undefined, renderCount]} frustumCulled={false} ...>`

**Przyczyna źródłowa.** `InstancedMesh.raycast` iteruje po `this.count` instancjach i dla każdej testuje przecięcie z geometrią pudełka (12 trójkątów). Dla airboxa z 300 tys. komórek to **~3,6 mln testów trójkąt-promień na każdy `pointermove`** (throttlowany do rAF, czyli do 60×/s). Fallback projekcyjny ma limit `FDM_INSPECT_PROJECTION_FALLBACK_LIMIT = 5000` (`:125`, `:353`), ale **sam raycast nie ma żadnego limitu**.

Dodatkowo `boundingSphere` jest liczona przez three leniwie przy pierwszym raycaście i **nigdy nie jest zerowana** po zmianie `instanceMatrix` — zweryfikowane: `computeBoundingSphere` występuje wyłącznie w `FrozenSpinsOverlay`, `ClipPlaneLayer`, `DimensionFrameLayer`, `PrimitiveObjectLayerModel`, ale nie w `FdmCuboidLayer`.

**Objaw.** Przy najechaniu myszą na dużą domenę FPS spada do wartości jednocyfrowych. Po zmianie topografii wokselowej (`resolveVoxelTopographyDisplacement` przesuwa środki w Z) sfera otaczająca jest nieaktualna i inspekcja przestaje trafiać w komórki na brzegach.

**Naprawa.** (a) Dodać ten sam próg co dla fallbacku — gdy `renderCount > LIMIT`, nie wołać `intersectObjects`, tylko ścieżkę projekcyjną (którą trzeba przyspieszyć siatką przestrzenną/BVH po `model.centers`). (b) Po każdym `uploadFdmCuboidAttribute` macierzy wykonać `mesh.boundingSphere = null; mesh.computeBoundingSphere();` i **włączyć `frustumCulled`**.

---

### <a id="v-10"></a>V-10 · **WYSOKI** · Druga pętla „dopełniająca" łamie przestrzenną równomierność próbkowania

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:1054-1074`

```ts
// Second pass: inject all matching cells that the stride-based sampling
// missed.  Active cells are typically a small fraction of the grid, so
// injecting them all keeps the budget nearly unchanged ...
for (let cellIndex = 0; cellIndex < totalCells; cellIndex += 1) {
  if (selected.has(cellIndex)) continue;
  ...
  if (selected.size < budget) selected.add(cellIndex);
}
```

**Przyczyna źródłowa.** Dopełnianie idzie w **rosnącej kolejności indeksu komórki**, a indeksacja jest x-fastest (`iz = floor(cellIndex/(nx·ny))`). Gdy liczba pasujących komórek przekracza `budget` — a założenie z komentarza („mała frakcja") nie zachodzi dla dużych próbek magnetycznych — budżet wyczerpuje się na **najniższych warstwach Z**, zanim pętla dojdzie do reszty.

**Objaw.** Materiał renderuje się gęsto w dolnej części (małe `z`) i rzednie ku górze; przy zmianie budżetu granica „gęste/rzadkie" skacze. Dla animacji z progiem magnitudy zbiór wybranych komórek zmienia się między klatkami → **migotanie** strzałek i komórek.

**Naprawa.** Dopełniać z tego samego równomiernego rozkładu, co `sampleFdmDisplayCellIndices`: zebrać `matchingCells` do tablicy i przepuścić przez `sampleFdmSpatialCellIndices(matchingCells, gridShape, budget)` (funkcja jest już importowana, `:14`), albo iterować pasujące komórki z krokiem `stride = ceil(matching / remainingBudget)`.

---

### <a id="v-11"></a>V-11 · **ŚREDNI** · Próbkowanie i resolver indeksów pola liczone dwa (miejscami trzy) razy na jedną budowę

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:384-406` (wywołujący), `:1271-1275`, `:1407-1411`, `:1449-1466`

```ts
const vectorSegments   = buildFdmVectorSegmentsUncached(model, request.vectorField, ...);
const vectorCellIndices = buildFdmVectorSampledCellIndices(model, request.vectorField, request.maxVectorGlyphs, ...);
```

**Przyczyna źródłowa.** Obie funkcje wywołują niezależnie `resolveFdmVectorSampledInstances`, które buduje `buildFdmFieldIndexResolver` (dla `explicit_node_indices` — `Map` o `pointCount` wpisach) oraz `ordinalByCell: Map<number, number>`. Do tego `buildFdmVectorSegmentsUncached` buduje resolver **jeszcze raz** we własnym ciele (`:1271`).

**Objaw.** 3× budowa `Map` na milionach wpisów w workerze — kilkaset MB szczytowej alokacji i sekundy pracy przy dużych domenach; wyraźna latencja pojawiania się strzałek.

**Naprawa.** Policzyć `sampledInstances` i `fieldIndexing` **raz** w `buildViewport3DFdmCuboid` i przekazać do obu funkcji jako argumenty. Dla indeksacji `full_domain`/`legacy_count_only` w ogóle nie tworzyć `Map` (resolver jest tożsamościowy), a dla `explicit_node_indices` użyć `Int32Array(totalCells)` wypełnionej `−1` zamiast `Map` (**4 B/komórkę zamiast ~50 B/wpis**).

---

### <a id="v-12"></a>V-12 · **ŚREDNI** · Skala odstępu próbkowania liczona z liczby *wszystkich* komórek siatki w ścieżce anchorowej

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:528-535` vs `:1524-1542`

```ts
// ścieżka anchorowa — carrierCount = CAŁA siatka (z airboxem/próżnią)
resolveFdmVectorGlyphSamplingSpacingScale(
  request.gridShape[0] * request.gridShape[1] * request.gridShape[2], count)
// ścieżka pełna — carrierCount = model.count
resolveFdmVectorGlyphSamplingSpacingScale(modelCount, renderedGlyphCount)
```

**Przyczyna źródłowa.** `spacingScale = cbrt(carrierCount / renderedGlyphCount)` ma odpowiadać rzeczywistemu rozrzedzeniu. W ścieżce anchorowej `carrierCount` to cała siatka, a nie liczba kandydatów, z których faktycznie próbkowano. Dla małej próbki w dużym airboxie (typowo 5% aktywnych komórek) mnożnik jest zawyżony ~2,7×, więc górne ograniczenie długości strzałki `maxCellSize · 0.75 · spacingScale` przestaje cokolwiek ograniczać.

**Objaw.** Strzałki znacząco dłuższe niż odstęp między nimi → gęsty, nieczytelny „las" nakładających się glifów. Dodatkowo **ten sam target wygląda inaczej** zależnie od tego, czy poszedł ścieżką anchorową (`vectorOnly`), czy pełną — a wybór zależy od tego, czy włączone są punkty/wireframe (`hooks/useViewport3DSceneModel.ts:5459-5461`).

**Naprawa.** Przekazywać `candidates.length` (liczbę komórek-kandydatów po filtrze membership, `:494`) zamiast iloczynu `gridShape`.

---

### <a id="v-13"></a>V-13 · **ŚREDNI** · Pojemność zaokrąglana do potęgi dwójki — do 2× nadmiarowa pamięć i remount przy każdym progu

**Lokalizacja:** `layers/VectorFieldLayer.tsx:470-475`, `:1180-1183`, `:1290-1303`

`capacity` trafia do `args={[geometry, material, capacity]}`, a `InstancedMesh` alokuje `Float32Array(capacity*16)` natychmiast — dla **obu** meshy. Przy 520 tys. glifów `capacity = 1 048 576`, czyli 2 × 64 MB macierzy + 12 MB kolorów zamiast 2 × 33 MB + 6 MB. Dodatkowo `key={"vector-shaft-" + capacity}` wymusza **pełny remount** przy każdej zmianie progu potęgi dwójki — również przy **zmniejszeniu** liczby glifów — co unieważnia bufory GPU i wymusza pełny ponowny upload.

**Naprawa.** Rosnąca pojemność z histerezą i granulacją: `Math.ceil(count / 8192) * 8192`, ze zmniejszaniem dopiero gdy `count < capacity / 4`; brak remountu przy zmniejszeniu (wystarczy `mesh.count`).

---

### <a id="v-14"></a>V-14 · **ŚREDNI** · Zmiana samej palety wymusza pełne przeliczenie i re-upload wszystkich macierzy

**Lokalizacja:** `layers/VectorFieldLayer.tsx:851-943`, `:945-948`, `:1050-1056`, `:1087-1102`

```ts
}, [
  buildKey,
  glyphColors,        // ← macierze przeliczane, bo zmieniły się KOLORY
  glyphTransforms,
  ...
```

**Przyczyna źródłowa.** Efekt kolorów zapisuje tylko do tablicy CPU — `needsUpdate`/`addUpdateRange` dla `instanceColorAttr` ustawia dopiero `onVisible` efektu **macierzowego** (`:1050-1056`). Żeby kolory dotarły na GPU, `glyphColors` musi być w zależnościach efektu macierzowego — i jest. Skutek uboczny: zmiana palety przy niezmienionych `glyphTransforms` uruchamia całe V-01 od nowa.

**Naprawa.** Rozdzielić odpowiedzialności — efekt kolorów sam wywołuje `markVectorGlyphAttributeRange(instanceColorAttr, batch.start, batch.end - batch.start, 3)` w swoim `onVisible`, po czym `glyphColors` można usunąć z zależności efektu macierzowego.

---

### <a id="v-15"></a>V-15 · **ŚREDNI** · Kolory glifów liczone w workerze i natychmiast wyrzucane w ścieżce FDM

**Lokalizacja:** `layers/vectorGlyphBuildModel.ts:33-36`; `layers/VectorFieldLayer.tsx:1173`; `layers/FdmCuboidLayer.tsx:1645`; `hooks/useViewport3DSceneModel.ts:5262-5273`

```ts
return {
  colors: buildVectorGlyphColors(request.segments, request.colorMode),
  transforms: buildVectorGlyphTransforms(request.segments, options),
};
```
```ts
const glyphColors = glyphColorsOverride ?? glyphBuild?.colors ?? null;
```

**Przyczyna źródłowa.** `buildViewport3DVectorGlyphs` **zawsze** liczy kolory (poza trybem `monochrome`), łącznie z dodatkowym przebiegiem O(n) w `resolveSegmentColorRange:189-208`. Warstwa FDM **zawsze** podaje własne `vectorGlyphColors` (liczone na wątku głównym), więc tablica z workera jest natychmiast porzucana — po zaalokowaniu `count*3` floatów i przetransferowaniu przez `postMessage`.

**Objaw.** 12 B/glif zmarnowanego transferu i dwa pełne przebiegi kolorowania na budowę; przy 200 tys. strzałek ~2,4 MB i kilkadziesiąt ms w workerze bez żadnego efektu.

**Naprawa.** Dodać do `VectorGlyphBuildRequest` flagę `skipColors`; docelowo przenieść `buildFdmSampledScalarColors` do tego samego workera i zlikwidować liczenie kolorów na wątku głównym.

---

### <a id="v-16"></a>V-16 · **WYSOKI** · Jeden błąd workera trwale degraduje ścieżkę i wycisza strzałki bez komunikatu

**Lokalizacja:** `layers/vectorGlyphBuildScheduler.ts:118-140`, `:175-177`, `:422-429`; `layers/VectorFieldLayer.tsx:695-699`; ten sam wzorzec w `layers/fdmCuboidBuildScheduler.ts:150-152`

```ts
} catch (error) {
  if (isAbortError(error)) throw error;
  vectorGlyphWorkerFallbackReason = "worker-error";
  options.recordFallback?.(fallbackReason);
  vectorGlyphWorkerClient = null;      // ← na stałe, do końca życia modułu
}
if (vectorGlyphBuildExceedsMainThreadFallbackLimit(request)) {
  throw createVectorGlyphWorkerFallbackLimitError(...);   // limit 4096 segmentów
}
```
```ts
.catch((error: unknown) => {
  if (isAbortError(error)) return;
  measureVectorGlyphWork(VECTOR_GLYPH_BUILD_MEASURE, startMark);
  measured = true;                     // ← błąd nigdzie nie trafia
});
```

**Przyczyna źródłowa.** `vectorGlyphWorkerClient = null` (a nie `undefined`) sprawia, że `getVectorGlyphWorkerClient:175-177` **na zawsze** zwraca `null` — worker nigdy nie zostanie odtworzony. Każda kolejna budowa > 4096 glifów rzuca wyjątek, który `VectorFieldLayer` łyka bez śladu.

**Objaw.** Po **jednym** transientnym błędzie workera (np. OOM przy jednej dużej budowie) strzałki znikają z całej sceny **do końca sesji**, bez żadnego komunikatu ani wpisu widocznego dla użytkownika.

**Naprawa.** (a) Backoff zamiast trwałego wyłączenia: licznik kolejnych porażek i próba odtworzenia workera po N sekundach. (b) W `VectorFieldLayer` zapisać błąd do stanu i wystawić przez tracker, żeby UI mógł pokazać „strzałki niedostępne: <powód>".

---

### <a id="v-17"></a>V-17 · **ŚREDNI** · Efekt budowy kluczowany na tożsamość obiektu `buildReference` — abort i replanowanie na każdy re-render

**Lokalizacja:** `layers/VectorFieldLayer.tsx:639-707` (deps `:707`); producent `hooks/useViewport3DSceneModel.ts:5307-5310`

```ts
}, [buildKey, buildReference, cache, invalidate, request, store, tracker]);
```

`vectorBuildReference` powstaje jako literał obiektowy wewnątrz `flatMap`, więc jest **nowym obiektem przy każdym przeliczeniu memo sceny**, mimo że semantycznie identyczny. Efekt czyści się (`abortController.abort()`) i uruchamia od nowa. Ratuje to dopiero krótkie spięcie cache'a (`:643-658`) — ale tylko gdy `cached.state === "ready-current"`; w stanach `stale-compatible`/`stale-physical` idzie pełne przeplanowanie do workera.

**Naprawa.** Zdenormalizować referencję do prymitywów w zależnościach (`buildReference.buildKey`, `.fieldRevision`, `.targetRevision`, `.topologyRevision`, `.groupKey`) i trzymać obiekt w `useRef`, albo zmemoizować `buildReference` po stronie producenta.

---

### <a id="v-18"></a>V-18 · **ŚREDNI** · Widoczne „przecieranie" strzałek — chunkowany upload bez podwójnego buforowania

**Lokalizacja:** `layers/VectorFieldLayer.tsx:53-54`, `:957`, `:983-1028`, `:1038-1040`

```ts
const VECTOR_GLYPH_UPLOAD_BATCH_SIZE = 256;
const VECTOR_GLYPH_UPLOAD_FRAME_BUDGET_MS = 3;
```

Chunki nadpisują `instanceMatrix` **w miejscu**, rozłożone na wiele klatek, a `count` przełącza się na nową wartość dopiero w `onVisible`. Dla indeksów `< poprzedni count` na ekranie miesza się stara i nowa geometria; nie ma bufora zapasowego ani atomowego przełączenia.

**Objaw.** Przy 100 tys. strzałek (391 chunków) pole wektorowe wizualnie „przewija się" pasami przez 2-6 klatek przy każdej aktualizacji; w animacji histerezy wygląda to jak artefakt fizyczny.

**Naprawa.** Dwa bufory `InstancedBufferAttribute` na mesh (A/B), zapis do nieaktywnego i podmiana `mesh.instanceMatrix` w `onVisible` — atomowe przełączenie za cenę jednego dodatkowego bufora. Alternatywnie: po przeniesieniu kompozycji do workera (V-01) zwiększyć `BATCH_SIZE` do rzędu 16k, bo chunk staje się czystym memcpy.

---

### <a id="v-19"></a>V-19 · **ŚREDNI** · Kopia całej tablicy segmentów na wątku głównym przed transferem do workera

**Lokalizacja:** `layers/vectorGlyphBuildScheduler.ts:225`, `:234-235`, `:260`

```ts
const segments = new Float32Array(input.segments);   // pełna kopia, synchronicznie
```

Kopia jest konieczna, bo transfer „ogłusza" bufor, a `segments` jest własnością wywołującego (cache w `FdmCuboidLayer.tsx:211-247` trzyma go do ponownego użycia). Ale wykonywana jest synchronicznie w `build()`, przed `postMessage`. Dla 200 tys. glifów w formacie 7-floatowym to **5,6 MB memcpy na budowę**, marnowane jeśli żądanie zostanie zaraz porzucone przez `latestWins`.

**Naprawa.** Skoro segmenty i tak są wytwarzane w workerze FDM (`buildViewport3DFdmCuboid` zwraca `vectorSegments` jako transferable, `fdmCuboidBuildModel.ts:1588`), **połączyć oba etapy w jednym workerze** i nigdy nie sprowadzać segmentów na wątek główny.

---

### <a id="v-20"></a>V-20 · **ŚREDNI** · Długość strzałki nie koduje `|M|`; komórki o zerowym polu konsumują budżet

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:1334-1355`; `layers/vectorGlyphGeometry.ts:86-93`; kandydaci `:478-494`, `:1420-1427`

Każdy segment ma **stałą długość geometryczną** `scale`; magnituda trafia wyłącznie do kanału 7 (kolor). Dla `m` (|m| = 1) jest to poprawne, ale te same ścieżki obsługują `H_demag` (airbox, `model/viewport3DFdmMultilayerAirbox.ts:9`), gdzie magnituda zmienia się o rzędy wielkości. Osobno: komórki o dokładnie zerowym polu produkują segment o zerowej długości → `shaftScales`/`headScales` = 0, ale **instancja nadal istnieje**, zajmuje slot budżetu, 2 × 64 B macierzy i przechodzi przez vertex shader.

**Objaw.** (a) Mapa `H_demag` sugeruje jednorodne pole, bo wszystkie strzałki są tej samej długości. (b) W airboxie, gdzie duża część komórek ma pole numerycznie zerowe, budżet strzałek jest zjadany przez niewidoczne glify — użytkownik podnosi budżet, a liczba widocznych strzałek nie rośnie.

**Naprawa.** (a) Dodać tryb skalowania długości (`lengthMode: "unit" | "magnitude" | "sqrt"`), w którym `halfScale` mnożone jest przez `relMag` (lub `sqrt(relMag)` dla dużych zakresów dynamicznych). (b) Odfiltrować komórki poniżej progu magnitudy **przed** przydziałem budżetu, a nie dopiero przy zapisie segmentu.

---

### <a id="v-21"></a>V-21 · **ŚREDNI** · Zakres kolorów x/y/z liczony z maksimum w wylosowanej podpróbce, na znormalizowanych kierunkach

**Lokalizacja:** `layers/vectorGlyphGeometry.ts:188-208`

```ts
if (colorMode === "x" || colorMode === "y" || colorMode === "z") {
  let maxAbs = 0;
  for (let vector = 0; vector < count; vector += 1) {
    const dx = (segments[source + 3] ?? 0) - (segments[source] ?? 0);
    ...
  }
  return { min: -Math.max(maxAbs, 1e-12), max: Math.max(maxAbs, 1e-12) };
}
```

**Przyczyna źródłowa.** Zakres normalizacji wyznaczany jest z **narysowanego podzbioru** strzałek, a nie z fizycznego zakresu pola. Dodatkowo `dx/dy/dz` to różnice końców segmentu, czyli `u · scale` — **znormalizowany kierunek przemnożony przez stałą**, a nie składowa pola.

**Objaw.** Zmiana budżetu strzałek albo przełączenie scope „full"/„surface" zmienia kolory tych samych komórek; dwa targety w tej samej scenie mają niezgodne skale barw; brak legendy odpowiadającej rzeczywistym wartościom fizycznym.

**Naprawa.** Przekazywać zakres jawnie z planu kolorów (`model/viewport3DColorbarPlan.ts` już taki zakres wylicza). Dla trybów x/y/z na znormalizowanej magnetyzacji użyć stałego `{min: −1, max: 1}`, a dla pól nieznormalizowanych — zakresu z całego `fieldVector`.

---

### <a id="v-22"></a>V-22 · **ŚREDNI** · Niejednoznaczne wykrywanie kroku segmentu (6 vs 7) — cichy rozjazd interpretacji bufora

**Lokalizacja:** `layers/vectorGlyphGeometry.ts:170-174`; sprzeczne twarde założenie `layers/vectorGlyphBuildScheduler.ts:90`, `:426-428`

```ts
function resolveSegmentStride(segments: Float32Array): number {
  return segments.length > 0 && segments.length % FLOATS_PER_SEGMENT === 0 ? FLOATS_PER_SEGMENT : 6;
}
```
```ts
itemCount: Math.floor(request.segments.length / 7),   // zawsze 7
```

**Przyczyna źródłowa.** Dla tablicy w formacie starszym (6 floatów) o liczbie floatów będącej wielokrotnością 7 (42, 84, 126…) `length % 7 === 0`, więc heurystyka wybiera krok 7 i odczytuje `6/7` liczby glifów z **całkowicie przesuniętymi składowymi**. Niezależnie scheduler zawsze dzieli przez 7, więc `itemCount` w diagnostyce i próg fallbacku są błędne dla formatu 6-floatowego.

**Naprawa.** Przekazywać krok **jawnie** (`segmentStride` w `VectorGlyphBuildRequest`); heurystykę zostawić wyłącznie jako fallback testowy.

---

### <a id="v-23"></a>V-23 · **ŚREDNI** · Licznik pamięci cache'a segmentów rozjeżdża się w górę bez granicy

**Lokalizacja:** `layers/FdmCuboidLayer.tsx:137-144`, `:201-247`, `:249-271`

```ts
const fdmVectorSegmentCache = new WeakMap<FdmCuboidInstanceModel, FdmVectorSegmentCache>();
...
fieldCache.set(cacheKey, segments);
fdmVectorSegmentCacheCounter.entryCount += 1;
fdmVectorSegmentCacheCounter.byteLength += fdmVectorSegmentByteLength(segments);
```

**Dwa niezależne błędy księgowania.** (1) `fieldCache.set` na **istniejącym kluczu** nie zwiększa `Map.size`, ale licznik i tak jest inkrementowany, a bajty dodane ponownie. (2) Cache jest podwójnym `WeakMap` — gdy model albo pole zostaną zebrane przez GC, cała `Map` znika, a globalny licznik **nigdy** nie jest pomniejszany, bo dekrementacja żyje wyłącznie w jawnej eksmisji.

**Objaw.** `memoryBudgetRegistry` raportuje monotonicznie rosnące zużycie, które przekracza `maxBytes` (32 MB) i nigdy nie wraca. Diagnostyka pamięci staje się bezużyteczna, a mechanizmy reagujące na budżet mogą niepotrzebnie degradować jakość.

**Naprawa.** Liczyć przyrost jako **różnicę** (`fieldCache.get(cacheKey)` przed zapisem), a dla ścieżki GC — zrezygnować z globalnego licznika na rzecz `FinalizationRegistry` albo przeliczania na żądanie z rejestru żywych wpisów.

---

### <a id="v-24"></a>V-24 · **WYSOKI** · `buildFdmFieldIndexResolver` ignoruje kształt siatki — brak weryfikacji konwencji indeksowania

**Lokalizacja:** `model/fdmFieldIndexing.ts:22-48`

```ts
export function buildFdmFieldIndexResolver(
  fieldVector,
  domainCellCount: number,
  _domainGridShape?: readonly [number, number, number] | null,   // ← przyjęty i ZIGNOROWANY
): FdmFieldIndexingResult {
  if (indexing === "full_domain" || indexing === "legacy_count_only") {
    if (fieldVector.pointCount !== safeDomainCellCount) return { reason: "point-count-mismatch", status: "degraded" };
    return { indexing, resolve: (o) => ..., status: "compatible" };
```

**Przyczyna źródłowa.** Dla `full_domain`/`legacy_count_only` jedyną walidacją jest **równość liczby punktów**. Parametr `_domainGridShape` jest przyjęty i zignorowany, mimo że `fieldVector.grid` jest dostępny w typie. Renderer w całości zakłada x-fastest (`fdmCuboidBuildModel.ts:654-656`, `:796-798`, `:896-898`, `:1216-1218`, `FrozenSpinsOverlay.tsx:190-192`). Jeśli backend wyśle bufor w porządku z-fastest przy tej samej liczbie punktów, resolver zwróci `compatible` i wartości zostaną przypisane do **niewłaściwych komórek**.

**Objaw.** Pole wygląda poprawnie, ale jest **transponowane** — struktury domenowe (wiry, ściany domenowe) pojawiają się w złych miejscach. Przy siatce sześciennej (`nx = ny = nz`) błąd jest praktycznie niewykrywalny wzrokowo. Brak jakiegokolwiek ostrzeżenia.

**Naprawa.** Użyć `_domainGridShape`: gdy `fieldVector.grid` jest dostępny, wymagać `grid[axis] === domainGridShape[axis]` dla wszystkich osi i zwracać `degraded` z powodem `grid-shape-mismatch`. Docelowo dodać do `DecodedFieldVector` jawną deklarację kolejności (`ordering: "x-fastest" | "z-fastest"`) i przy niezgodności permutować indeks w resolverze albo odmówić renderu.

---

### <a id="v-25"></a>V-25 · **ŚREDNI** · `cellMatchesSelection` nie obsługuje selekcji `"dense"` — cicha pusta scena

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:1077-1087`; użycia `:254-263`, `:989`, `:1010`, `:1061`; ręczne obejście `:648`

```ts
function cellMatchesSelection(regionId: number, selection: FdmCuboidCellSelection): boolean {
  const inactive = regionId === FMRM_INACTIVE_REGION_ID;
  return selection === "all"
      || (selection === "active"   && !inactive)
      || (selection === "inactive" &&  inactive);   // ← brak gałęzi "dense"
}
```
```ts
return selection === "dense" || cellMatchesSelection(regionId, selection);   // :648 — jedyne miejsce, które o tym pamięta
```

**Przyczyna źródłowa.** `"dense"` jest pełnoprawnym wariantem `FdmCuboidCellSelection` (`:90`) i jest realnie używane (`hooks/useViewport3DSceneModel.ts:5444`, `:5538`). Dla `"dense"` wszystkie trzy gałęzie są fałszywe, więc każda pętla filtrująca odrzuca **wszystkie** komórki. Obecnie ratuje to routing w `buildViewport3DFdmCuboid:370-375`, ale `buildFdmCuboidInstanceModel` jest **eksportowane publicznie** (`FdmCuboidLayer.tsx:104`), a `createFdmVectorOnlyBuildInput:261` używa tej samej funkcji.

**Objaw.** Każdy nowy wywołujący, który przekaże `"dense"`, dostanie `null` **bez błędu** — warstwa po prostu zniknie, a przyczyna będzie nie do wyśledzenia.

**Naprawa.** Dodać `selection === "dense"` do `cellMatchesSelection` i usunąć doraźny warunek z `:648`; albo — jeśli `"dense"` nie ma być selekcją membershipową — usunąć go z typu i wprowadzić osobne pole `carrierKind`.

---

### <a id="v-26"></a>V-26 · **NISKI** · Fallback „jedna komórka" i martwy warunek przy braku komórek powierzchniowych

**Lokalizacja:** `layers/fdmCuboidBuildModel.ts:1203-1207`

```ts
if (surfaceCount > 0 || exactMembership) {   // ← exactMembership tu ZAWSZE false (return w :1177)
  return surfaceInstances.slice(0, surfaceCount);
}
const fallback = candidates[0];
return fallback === undefined ? new Uint32Array() : Uint32Array.of(fallback);
```

Gałąź `exactMembership` zwróciła już wcześniej w `:1177`, więc warunek jest martwy. Fallback zwraca **jedną, arbitralną** komórkę bez żadnego oznaczenia degradacji.

**Objaw.** W scenariuszu, w którym detekcja powierzchni zawiedzie (V-04), użytkownik zamiast pustej warstwy widzi **jedną samotną strzałkę w rogu domeny** i nie wie, że to artefakt.

**Naprawa.** Usunąć martwy `|| exactMembership`; zamiast fallbacku zwrócić pustą tablicę i zaraportować przyczynę przez tracker.

---

### <a id="v-27"></a>V-27 · **NISKI** · `args={[geometry, undefined, renderCount]}` — three alokuje domyślny materiał przy każdym remoncie

**Lokalizacja:** `layers/FdmCuboidLayer.tsx:1290`, `:1301`

```jsx
<instancedMesh args={[geometry, undefined, renderCount]} frustumCulled={false} ...>
  <primitive attach="material" object={surfaceMaterial} />
</instancedMesh>
```

Konstruktor `Mesh` ma domyślny parametr `material = new MeshBasicMaterial()`, więc przekazanie `undefined` tworzy materiał, który jest natychmiast nadpisany i **nigdy nie trafia do `tracker` ani do `dispose()`**. `args` zawiera `renderCount`, więc R3F przebudowuje oba obiekty przy **każdej** zmianie liczby komórek.

**Naprawa.** `args={[geometry, surfaceMaterial, renderCount]}` i usunięcie `<primitive attach="material">`, albo jeden współdzielony `PLACEHOLDER_MATERIAL` na moduł.

---

## 6. Wycieki pamięci i cykl życia zasobów GPU

### <a id="m-01"></a>M-01 · **KRYTYCZNY** · Trzy cache'e modułowe (272 MB) nigdy nie są czyszczone przy odmontowaniu viewportu

**Lokalizacja:** `viewport3dResources.ts:57-65`, `:76-81`, `:473-475`; wywołanie `:102`

```ts
const topologyCache    = new ResourceCache<DecodedTopology>({    maxBytes:  96 * 1024 * 1024 });
const fieldVectorCache = new ResourceCache<DecodedFieldVector,
                                           FieldVectorResponseMetadata>({ maxBytes: 128 * 1024 * 1024 });
const qualityDataCache = new ResourceCache<DecodedMeshQualityData>({ maxBytes: 48 * 1024 * 1024 });
```

**Przyczyna źródłowa.** Cache'e są singletonami modułu. Jedyne wywołanie `clearViewport3DSessionCaches()` znajduje się w `synchronizeViewport3DSessionIdentity` (`:102`), które reaguje **wyłącznie** na zmianę `sessionId`/`sessionEpoch`. Nie ma żadnego hooka `useEffect(() => () => …clear(), [])`, który zwalniałby te bufory przy odmontowaniu `Viewport3DModule`. Klucze są `sessionScopedResourceKey(...)`, więc wpisy starej sesji też pozostają do czasu wypchnięcia przez LRU.

**Objaw.** Po zamknięciu panelu 3D (przełączenie zakładki lub slotu layoutu) **do 272 MB** zdekodowanych `Float32Array` pozostaje w JS heapie na czas życia karty. Powrót do panelu nie zwalnia pamięci; kumuluje się z cache'ami pochodnymi (M-02).

**Naprawa.** Dodać liczenie referencji viewportu (analogicznie do `acquireViewport3DWorkerRuntime`) i przy zejściu do zera wywołać:
```ts
topologyCache.clear(); fieldVectorCache.clear(); qualityDataCache.clear();
abortViewport3DInflightBinaryResources();
```
Alternatywnie wyeksportować `releaseViewport3DResourceCaches()` i wołać w `useEffect(() => () => releaseViewport3DResourceCaches(), [])` w `Viewport3DModule`.

---

### <a id="m-02"></a>M-02 · **KRYTYCZNY** · Budżet cache'y pochodnych jest „per owner", nie globalny — brak jakiegokolwiek górnego ograniczenia sumarycznego

**Lokalizacja:** `viewport3dRenderModel.ts:319-320`, `:364-386`, `:2085-2151`

```ts
const RENDER_CACHE_MAX_ENTRIES_PER_OWNER = 8;
export const RENDER_CACHE_MAX_BYTES_PER_OWNER = 64 * 1024 * 1024;
...
function evictOldestRenderCacheEntries<TValue>(entries, statsId, maxEntries = 8, maxBytes = 64MB) {
  while (entries.size > maxEntries || renderCacheEntriesByteLength(entries) > maxBytes) {
```

**Przyczyna źródłowa.** `scalarColorCache`, `partScalarColorCache`, `mappedScalarColorCache`, `complexPhaseProjectionCache`, `fullVectorSegmentCache`, `partVectorSegmentCache` (`:364-386`) to `WeakMap<DecodedFieldVector, Map<string, TValue>>`. Eksmisja działa **wyłącznie wewnątrz `Map` jednego `DecodedFieldVector`**. Liczba właścicieli to liczba żywych wektorów pola w `fieldVectorCache` (128 MB / rozmiar pola — łatwo kilkadziesiąt). Sumaryczny limit wynosi więc `liczba_właścicieli × 6 rodzin × 64 MB` — praktycznie nieograniczony.

**Objaw.** Po przełączaniu wielkości / komponentu / palety (każda kombinacja to nowy `key` w wewnętrznej mapie) i po przełączaniu quantity (nowy właściciel) RAM rośnie **wielokrotnie ponad zadeklarowane 128 MB** budżetu pól. Bufory kolorów są zwykle 3× większe od pola źródłowego.

**Naprawa.** Wprowadzić globalny rejestr wpisów (`Set<{owner, key, bytes, lastUsedAtMs}>` + `FinalizationRegistry`, albo jawna lista LRU) i eksmitować globalnie do wspólnego budżetu. Alternatywnie: ograniczyć liczbę żywych właścicieli, czyszcząc pochodne przy każdej eksmisji z `fieldVectorCache`.

---

### <a id="m-03"></a>M-03 · **WYSOKI** · Liczniki cache'y pochodnych rosną monotonicznie — eksmisja przez GC nie jest raportowana

**Lokalizacja:** `viewport3dRenderModel.ts:343-362`, `:2170-2185`; wywołanie eksmisji `:2149`

```ts
function recordRenderCacheInsert(statsId, value) {
  counter.entryCount += 1;
  counter.byteLength += estimateRenderCacheValueByteLength(value);
}
function recordRenderCacheEviction(statsId, value) {
  counter.entryCount = Math.max(0, counter.entryCount - 1);
```

**Przyczyna źródłowa.** `recordRenderCacheEviction` wywoływane jest wyłącznie z `evictOldestRenderCacheEntries`. Gdy `DecodedFieldVector` zostanie zebrany przez GC, cała wewnętrzna `Map` znika razem z `WeakMap` — **bez żadnej dekrementacji**. Licznik `byteLength` narasta w nieskończoność, a `memoryBudgetRegistry.register(id, …)` raportuje go z `maxBytes: RENDER_CACHE_MAX_BYTES_PER_OWNER`, czyli porównuje **sumę globalną z limitem jednostkowym**.

**Objaw.** Panel budżetu pamięci pokazuje stale rosnące gigabajty „render-buffer" i permanentne przekroczenie budżetu, mimo że rzeczywista pamięć została zwolniona. **Detektor wycieków (`compareDiagnosticLeakSnapshots`) staje się bezużyteczny** — każdy przebieg raportuje wyciek.

**Naprawa.** Zarejestrować `FinalizationRegistry<DecodedFieldVector>` dekrementujący licznik, albo przechowywać rozmiar per właściciel w osobnej mapie i przeliczać sumę na żądanie. Dodatkowo raportować `maxBytes` jako budżet globalny, nie per-owner.

---

### <a id="m-04"></a>M-04 · **WYSOKI** · Anulowany transfer GPU nigdy nie wykonuje rollbacku — częściowo wgrane zasoby wyciekają

**Lokalizacja:** `build-engine/gpu/viewport3dGpuUploadManager.ts:135-144`, `:252-270`; test świadomie pomijający: `viewport3dGpuUploadManager.test.ts:294-350`

```ts
function settleTicket(ticket, status, error?, removeFromQueue = true): void {
  if (removeFromQueue) removeTicket(ticket);
  try {
    if (status === "failed") {          // ← tylko "failed", nie "aborted"
      rollbackTicket(ticket);
    }
  } finally {
    cleanupTicket(ticket);
    recordTerminal(ticket, status, error);
    schedule();
  }
}
```

**Przyczyna źródłowa.** `rollbackTicket` wywoływany jest wyłącznie dla `status === "failed"`. Przy `"aborted"` (`runFrame:160-163`, `:232-235`) oraz w `dispose()` (`:135-144`) chunki już wykonane (`ticket.uploadedChunksForRollback`) nie są cofane, a `onVisible()` nigdy nie zostanie wywołane — **konsument nigdy nie otrzyma uchwytu do zasobu i nie może go zwolnić**.

**Objaw.** Anulowanie w połowie transferu (zmiana targetu, szybkie przełączanie quantity, odmontowanie warstwy) zostawia niepodpięty `BufferAttribute` z zaalokowanym buforem WebGL oraz **częściowo nadpisany** `attribute.array` (`useViewport3DScalarColorUpload.ts:303-328` pisze wprost do żywej tablicy istniejącego atrybutu). VRAM rośnie, a kolory potrafią być „pół stare / pół nowe" przy następnym `needsUpdate`.

**Naprawa.**
```ts
if (status === "failed" || status === "aborted") rollbackTicket(ticket);
```
oraz analogicznie dla każdego biletu w `dispose()`.

---

### <a id="m-05"></a>M-05 · **WYSOKI** · Zasoby GPU tworzone i rejestrowane w `useMemo` (faza renderu) — StrictMode/concurrent gubi jedną kopię

**Lokalizacja:** `layers/VectorFieldLayer.tsx:486-528`; `layers/MeshPartLayer.tsx:904-933`; `layers/FallbackTopologyMeshLayer.tsx:278-303`; `layers/FdmCuboidLayer.tsx:1118-1150`; tracker `viewport3dDiagnostics.ts:157`, `:271-282`

```ts
const material = useMemo(
  () => tracker.track("material", new MeshBasicMaterial({ ... })),
  [depthPolicy.depthTest, depthPolicy.depthWrite, glyphPolicy, tracker],
);
useEffect(() => () => tracker.release("material", material), [material, tracker]);
```

**Przyczyna źródłowa.** `tracker.track()` wstawia zasób do **silnej** mapy `disposables`. React 19 w StrictMode podwójnie wykonuje funkcję renderu, więc fabryka `useMemo` uruchamia się dwukrotnie i **rejestruje dwa materiały**; `useEffect` zwalnia tylko ten, który React zachował. To samo dzieje się przy renderze porzuconym (przerwanie przez update o wyższym priorytecie, retry Suspense) — efekt dla porzuconego renderu nigdy nie wystartuje. Wzorzec powtarza się w **12 miejscach** (`grep -n "tracker.track(" layers/`).

**Objaw.** Rosnące `counts.materials` / `counts.geometries` i wpisy w `memoryBudgetRegistry` przy każdej zmianie zależności (suwak krycia, zmiana rewizji pola, zmiana profilu wizualnego). Zwolnienie następuje dopiero w `tracker.disposeAll()` przy odmontowaniu viewportu.

**Naprawa.** Tworzyć zasób leniwie w efekcie (wzorzec z `useViewport3DGeometryUpload`):
```ts
const materialRef = useRef<MeshBasicMaterial | null>(null);
useEffect(() => {
  const m = tracker.track("material", new MeshBasicMaterial({ ... }));
  materialRef.current = m;
  return () => { tracker.release("material", m); materialRef.current = null; };
}, [...]);
```

---

### <a id="m-06"></a>M-06 · **WYSOKI** · `InstancedMesh.instanceColor` podmieniany bez `dispose()` — wyciek bufora WebGL

**Lokalizacja:** `layers/FdmCuboidLayer.tsx:1207-1216`

```ts
if (!surface.instanceColor || surface.instanceColor.array.length !== surfaceColors.colors.length) {
  surface.instanceColor = new InstancedBufferAttribute(new Float32Array(surfaceColors.colors.length), 3);
  colorRevisionRef.current = null;
}
```

**Przyczyna źródłowa.** three.js (`WebGLAttributes`) usuwa `WebGLBuffer` **wyłącznie** w reakcji na zdarzenie `dispose` atrybutu — `WeakMap` kluczowana atrybutem nie wystarcza, bo GC obiektu JS nie zwalnia zasobu GL. Stary `instanceColor` jest tu po prostu nadpisywany; nikt nie woła na nim `.dispose()`.

**Objaw.** Każda zmiana liczby instancji FDM (zmiana `geometryScope`, decymacji, warstwy airboxa, zakresu cięcia) zostawia w VRAM osierocony bufor kolorów o rozmiarze `3 × instanceCount × 4 B`. Przy przeskakiwaniu między warstwami w dużym modelu — **dziesiątki MB VRAM na sesję**.

**Naprawa.**
```ts
const previous = surface.instanceColor;
surface.instanceColor = new InstancedBufferAttribute(...);
previous?.dispose();
```

---

### <a id="m-07"></a>M-07 · **WYSOKI** · Brak jawnego zwolnienia kontekstu WebGL przy odmontowaniu; liczniki `contextDisposed` są fikcyjne

**Lokalizacja:** `Viewport3DCanvas.tsx:122-141`, `:371-387`; `Viewport3DModule.tsx:1901`, `:2672`

```ts
return () => {
  const teardown = lifecycle.unmountRoot();
  rootStateRef.current?.events.disconnect?.();
  rootStateRef.current = null;
  rootRef.current?.unmount();
  if (teardown.disposeContext) {
    recordVisualizationDebugCanvasLifecycle("context-disposed");   // ← tylko telemetria
  }
```

**Przyczyna źródłowa.** W całym module **nie ma ani jednego** wywołania `renderer.dispose()`, `gl.forceContextLoss()` ani `renderLists.dispose()` — zweryfikowane: `grep -rn "forceContextLoss|renderer.dispose|gl.dispose|renderLists"` (bez testów) zwraca **0 trafień**. `unmountRoot()` jedynie inkrementuje `snapshot.contextDisposed`, czyli telemetria raportuje utylizację kontekstu, **której kod nie wykonuje**. Jednocześnie `key={canvasContextKey}` (`:2672`) wymusza pełny remount `<canvas>` przy każdym przełączeniu antialiasingu / `preserveDrawingBuffer` w dialogu ustawień.

**Objaw.** Kilkukrotne przełączenie antialiasingu (albo kilka cykli mount/unmount panelu) tworzy nowe konteksty WebGL bez gwarantowanego zwolnienia poprzednich. Przeglądarki twardo limitują liczbę żywych kontekstów (8-16) i zaczynają zabijać najstarsze — objaw: nagle **czarny/pusty viewport** i `webglcontextlost`.

**Naprawa.** W cleanupie przed `root.unmount()`:
```ts
const gl = rootStateRef.current?.gl;
rootRef.current?.unmount();
gl?.renderLists?.dispose();
gl?.dispose();
gl?.forceContextLoss();
```
oraz oprzeć `teardown.disposeContext` na faktycznym wyniku, nie na fladze licznikowej.

---

### <a id="m-08"></a>M-08 · **WYSOKI** · Klient workera osierocony i lane trwale zdegradowany po błędzie workera

**Lokalizacja:** `viewport3dTopologyIndexScheduler.ts:133-150`, `:183-200`; ten sam wzorzec: `layers/vectorGlyphBuildScheduler.ts:126`, `layers/fdmCuboidBuildScheduler.ts:152`, `viewport3dColorTransformScheduler.ts:106`, `region-overlays/viewport3dRegionOverlayBuildScheduler.ts:99`

```ts
const client = getTopologyIndexWorkerClient();
if (client) {
  try {
    return await client.build(request, options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    topologyIndexWorkerFallbackReason = "worker-error";
    options.recordFallback?.(topologyIndexWorkerFallbackReason);
    topologyIndexWorkerClient = null;        // ← brak dispose(), a lane trwale bez workera
  }
```

**Przyczyna źródłowa.** Przy błędzie zgłoszonym przez workera (`response.ok === false`) klient **nie jest disposowany** — `Worker` żyje dalej z podpiętymi listenerami `message`/`error`/`messageerror`. Jednocześnie `topologyIndexWorkerClient = null`, a `getTopologyIndexWorkerClient` (`:184-186`) zwraca wcześnie dla `!== undefined`, więc lane pozostaje **na zawsze** bez workera. `disposeViewport3DTopologyIndexWorker()` (`:155`) robi `null?.dispose()` — no-op; osieroconego workera nikt już nie zakończy.

**Objaw.** Po jednym przejściowym błędzie (np. OOM przy dużej topologii) wszystkie kolejne buildy lecą na main thread → **trwała zacinka UI**, a wątek workera z pełnym snapshotem topologii wisi do końca życia karty.

**Naprawa.**
```ts
} catch (error) {
  if (isAbortError(error)) throw error;
  topologyIndexWorkerFallbackReason = "worker-error";
  options.recordFallback?.(topologyIndexWorkerFallbackReason);
  topologyIndexWorkerClient?.dispose(error);
  topologyIndexWorkerClient = undefined;    // pozwól na odtworzenie
}
```

---

### <a id="m-09"></a>M-09 · **WYSOKI** · `viewport3dBuildEngineStore` — mapa zadań rośnie bez ograniczeń, klucze zawierają rewizje

**Lokalizacja:** `build-engine/viewport3dBuildEngineStore.ts:27-39`, `:64-76`; klucze `build-engine/viewport3dBuildJobKeys.ts:113-117`

```ts
const jobsByKey = new Map<Viewport3DBuildJobKey, Viewport3DBuildJobSnapshot>();
function publishJobState(job): void {
  const previous = jobsByKey.get(job.key);
  if (previous && areJobSnapshotsEqual(previous, job)) return;
  jobsByKey.set(job.key, job);
  rebuildSnapshotAndNotify();          // ← O(n log n) na każdy job
}
```

**Przyczyna źródłowa.** Wpisy **nigdy nie są usuwane** — stany terminalne (`"ready"`, `"failed"`, `"aborted"`) zostają w mapie na zawsze. Klucz zawiera `lane` oraz zserializowane `fieldRevision`, `topologyRevision`, `styleRevision`, `samplingRevision`, `targetVisualizationRevision` — przestrzeń kluczy jest nieograniczona i rośnie z każdą klatką symulacji. `rebuildSnapshotAndNotify()` dodatkowo rekonstruuje i sortuje **całą** tablicę przy każdej publikacji.

**Objaw.** Podczas długiego odtwarzania (replay histerezy, animacja fazy) mapa i sortowana tablica rosną liniowo z liczbą rewizji; publikacja stanu zadania zaczyna dominować profil CPU, a snapshot zjada dziesiątki MB stringów `revisionSummary`.

**Naprawa.** Usuwać wpisy w stanach terminalnych (`if (job.state !== "queued" && job.state !== "running") jobsByKey.delete(job.key)`), albo ograniczyć mapę do LRU o stałym rozmiarze (np. 64 wpisy na lane) i budować `snapshot` leniwie w `getSnapshot()`.

---

### <a id="m-10"></a>M-10 · **WYSOKI** · Cache buforów pochodnych: `get()` powiadamia subskrybentów, `dispose()` nie zwalnia buforów, `refCount > 0` trwale blokuje eksmisję

**Lokalizacja:** `build-engine/cache/viewport3dDerivedBufferCache.ts:154-162`, `:234-240`, `:254-280`, `:337-340`; subskrybent `layers/vectorGlyphDerivedBufferRuntime.tsx:36-37`

```ts
function get(key) {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.lastUsedAtMs = now();
  notify();                          // ← notyfikacja przy ODCZYCIE
  return freezeEntry(entry);
}
function deleteEntry(key) {
  const entry = entries.get(key);
  if (!entry || entry.refCount > 0) return false;   // ← „pinned" na zawsze
function dispose(): void {
  entries.clear();                   // ← brak buffer.dispose()
  notify();
}
```

**Trzy niezależne defekty.**
1. `get()` wywołuje `notify()`, a subskrybentem jest `tracker.recordGlyphDerivedBufferCache` → `tracker.notify()` → `useSyncExternalStore` → re-render. **Odczyt cache może wywołać pętlę renderowania.**
2. `evictToBudget` filtruje `refCount <= 0` (`:265`) i po wyczerpaniu kandydatów po prostu wychodzi — przy wycieku uchwytu `retain()` budżet 64 MB jest **cicho przekraczany bez żadnego sygnału**.
3. `dispose()` porzuca wartości bez wywołania czegokolwiek na `TBuffer` — działa dla `VectorGlyphBuildResult` (czyste `Float32Array`), ale jest pułapką dla dowolnego przyszłego typu z zasobem GPU.

**Naprawa.** Usunąć `notify()` z `get()` (aktualizacja `lastUsedAtMs` nie jest zmianą obserwowalną). W `evictToBudget` raportować `pinnedBytes`, gdy budżet jest przekroczony a kandydatów brak. Dodać opcjonalne `disposeBuffer?: (buffer: TBuffer) => void` wołane w `dispose()`/`deleteEntry()`.

---

### <a id="m-11"></a>M-11 · **WYSOKI** · Publisher Visualization Debug wykonuje efekty uboczne w inicjalizatorze `useState`

**Lokalizacja:** `hooks/useViewport3DVisualizationDebugPublisher.ts:133-143`, `:236-239`, `:330-337`, `:347`

```ts
let publisherToken: VisualizationDebugPublisherToken = controller.registerPublisher(viewportId);
...
const unsubscribeAdoption = adoptionRegistry.subscribe((targetId) => { ... });
...
const [publisher] = useState(() => createViewport3DVisualizationDebugPublisher({ ... }));
```

**Przyczyna źródłowa.** React 19 w StrictMode podwójnie wywołuje inicjalizator `useState`. Powstają **dwa** publishery; oba rejestrują token w `controller` i oba subskrybują `adoptionRegistry`. `useEffect(() => () => publisher.dispose(), [publisher])` zwalnia tylko instancję zachowaną przez Reacta — osierocony publisher nigdy nie wywoła `controller.clearPublisher(publisherToken)` ani `unsubscribeAdoption()`.

**Objaw.** Każdy montaż viewportu zostawia w kontrolerze martwy token publishera oraz nieusuwalny listener w `adoptionRegistry.listeners`. Przy wielokrotnym otwieraniu/zamykaniu panelu liczba martwych publisherów rośnie liniowo.

**Naprawa.** Uczynić konstruktor czystym — przenieść `registerPublisher` i `adoptionRegistry.subscribe` do metody `start()` wołanej z `useEffect`, albo zamienić `useState(fabryka)` na leniwe tworzenie w efekcie z `useRef`.

---

### <a id="m-12"></a>M-12 · **ŚREDNI** · Efekt uploadu geometrii re-enqueue'uje bilet przy każdej zmianie tożsamości `createGeometry`; anulowane bilety zalegają w kolejce

**Lokalizacja:** `hooks/useViewport3DGeometryUpload.ts:82-153`; `build-engine/gpu/viewport3dGpuUploadManager.ts:125-133`, `:151-159`

```ts
}, [ clearCurrentGeometry, createGeometry, dirtyReason, enabled, estimatedBytes,
     invalidate, itemCount, key, lane, store, targetRevision, releaseGeometry, tracker, uploadManager ]);
```

**Przyczyna źródłowa.** `createGeometry` to callback przekazywany przez warstwę; jeśli nie jest memoizowany, efekt uruchamia się przy każdym renderze — nowy bilet trafia do `queue`, stary zostaje oznaczony `aborted`. Menedżer przetwarza wyłącznie `queue[0]` (`runFrame:158`) i zdejmuje **jeden** anulowany bilet na klatkę. Anulowane bilety trzymają w domknięciach `createGeometry` → referencje do źródłowych `Float32Array` topologii/pola.

**Objaw.** Podczas przeciągania suwaka albo szybkiej zmiany targetu kolejka rośnie szybciej niż jest drenowana; RSS rośnie skokowo o wielkość buforów źródłowych × długość kolejki i opada dopiero po ustaniu interakcji.

**Naprawa.** W `abort(key)` i przy `signal.aborted` usuwać bilet z kolejki **natychmiast**, a nie dopiero na czele; w `runFrame` odfiltrować anulowane bilety w pętli zamiast `return` po pierwszym. Po stronie hooka — wymusić memoizację `createGeometry` (`useCallback`) i zawęzić zależności.

---

### <a id="m-13"></a>M-13 · **ŚREDNI** · `synchronizeViewport3DSessionIdentity` mutuje globalny stan w fazie renderu

**Lokalizacja:** `viewport3dResources.ts:93-111`

```ts
export function synchronizeViewport3DSessionIdentity(identity): boolean {
  const identityKey = identity ? sessionKeyOf(identity) : null;
  if (activeViewportSessionIdentityKey === identityKey) return false;
  viewport3DSessionIdentityGeneration += 1;
  abortViewport3DInflightBinaryResources();
  clearViewport3DSessionCaches();
  activeViewportSessionIdentityKey = identityKey;
  return true;
}
function useViewport3DSessionIdentity() {
  const identity = useSessionResourceIdentity();
  synchronizeViewport3DSessionIdentity(identity);   // ← W CIELE RENDERU
  return identity;
}
```

**Przyczyna źródłowa.** Czyszczenie 272 MB cache'y i abort wszystkich żądań `fetch` odbywa się w ciele funkcji renderu, poza `useEffect`. `activeViewportSessionIdentityKey` jest **pojedynczą globalną zmienną**, a moduł jawnie wspiera wiele slotów (`slotId`, `Viewport3DModule.tsx:2672`).

**Objaw.** Przy dwóch viewportach 3D w różnych sesjach każdy render „tego drugiego" przestawia globalny klucz → pełne czyszczenie cache'ów i abort wszystkich żądań obu paneli, **w pętli**. Objaw dla użytkownika: nieustanne przeładowywanie pól, brak trafień cache, migotanie. W trybie concurrent porzucony render też trwale wyczyści cache.

**Naprawa.** Przenieść synchronizację do `useEffect`/`useLayoutEffect` z zależnością od `identityKey`, a stan sesji trzymać **per slot** (mapa `slotId → identityKey`) zamiast pojedynczej globalnej zmiennej.

---

### <a id="m-14"></a>M-14 · **ŚREDNI** · Runtime cache'a glifów tworzony w `useMemo` — subskrypcja i zapis do trackera w fazie renderu

**Lokalizacja:** `layers/vectorGlyphDerivedBufferRuntime.tsx:31-38`, `:68-71`

```ts
const cache = createViewport3DDerivedBufferCache<VectorGlyphBuildResult>({...});
const report = () => tracker.recordGlyphDerivedBufferCache(cache.getSnapshot());
const unsubscribe = cache.subscribe(report);
report();                                            // ← mutuje tracker i notyfikuje
...
const runtime = useMemo(() => createVectorGlyphDerivedBufferRuntime({ tracker }), [tracker]);
const lease   = useMemo(() => runtime.acquire(), [runtime]);
```

**Przyczyna źródłowa.** Fabryka `useMemo` subskrybuje cache i natychmiast wywołuje `report()`, który mutuje `tracker` i wywołuje `tracker.notify()` — czyli **aktualizuje zewnętrzny store w trakcie renderu**. Przy podwójnym renderze StrictMode powstaje drugi runtime z własnym cache'em i subskrypcją, którego `release()` nigdy nie nastąpi.

**Objaw.** Ostrzeżenia Reacta o aktualizacji store'a w trakcie renderu; osierocone cache'e glifów (do 64 MB każdy) żyją do czasu GC całego drzewa; liczniki `glyphCacheBytes` raportują wartości nieistniejącego cache'a.

**Naprawa.** Tworzyć runtime leniwie w `useEffect` (albo przez `useState(() => …)` z konstruktorem **bez** efektów ubocznych) i przenieść `cache.subscribe(report)` + pierwsze `report()` do `useEffect`.

---

### <a id="m-15"></a>M-15 · **ŚREDNI** · Stan modułowy `Viewport3DModule` i singleton `viewport3dStore` nie są resetowane przy odmontowaniu

**Lokalizacja:** `Viewport3DModule.tsx:1167-1171`, `:2178-2193`; `viewport3dStore.ts:558`

```ts
const retainedViewport3DColorbarPlansBySlot = new Map<string, readonly Viewport3DColorbarPlan[]>();
const retainedViewport3DColorbarPlanListeners = new Set<() => void>();
...
useEffect(() => {
  setRetainedViewport3DColorbarPlans(slotId, resolveRetained({...}));
  viewport3dStore.setActiveScalarColorbarLegends(colorbarLegends.map(({ legend }) => legend));
  viewport3dStore.setRenderedScalarRanges(renderedScalarRanges);
}, [...]);                                        // ← brak cleanupu
```

**Objaw.** Zamknięcie panelu 3D zostawia w pamięci legendy i zakresy skal poprzedniej sesji; Inspector może odczytać zakres z nieistniejącego już renderu. Przy dynamicznie generowanych `slotId` mapa rośnie z każdym otwarciem panelu.

**Naprawa.**
```ts
useEffect(() => () => {
  setRetainedViewport3DColorbarPlans(slotId, []);
  viewport3dStore.setActiveScalarColorbarLegends([]);
  viewport3dStore.setRenderedScalarRanges([]);
}, [slotId]);
```

---

### <a id="m-16"></a>M-16 · **ŚREDNI** · `EffectComposer` z render targetami tworzony przy zmianie `multisampling` — alokacja GPU w fazie renderu biblioteki

**Lokalizacja:** `layers/PostProcessingLayer.tsx:34-40`

`@react-three/postprocessing` memoizuje instancję `EffectComposer` na zależnościach obejmujących `multisampling`, a `EffectComposer` alokuje `WebGLRenderTarget` **już w konstruktorze** (w fazie renderu). Podwójny render StrictMode lub porzucony render concurrent tworzy render target, którego `useEffect(() => () => composer.dispose())` biblioteki nigdy nie obsłuży. Zmienna jest sterowana przełącznikiem w `Viewport3DSettingsDialog`, więc scenariusz jest w pełni osiągalny przez użytkownika.

**Objaw.** Każde przełączenie antialiasingu / włączenie AO+Bloom może zostawić parę render targetów w rozmiarze framebuffera (przy 4K MSAA×4 to **dziesiątki MB VRAM na przełączenie**).

**Naprawa.** Stabilizować `multisampling` przez `useMemo` na poziomie propsów; docelowo odmontowywać cały `PostProcessingLayer` przez `key` i pozwolić bibliotece przejść pełną ścieżkę `dispose`.

---

### <a id="m-17"></a>M-17 · **ŚREDNI** · `webglcontextlost` blokowany bez ścieżki odtworzenia zasobów zarządzanych ręcznie

**Lokalizacja:** `layers/CanvasLifecycleProbe.tsx:33-49`; ręczny upload `hooks/useViewport3DScalarColorUpload.ts:322-325`

```ts
const onLost = (event: Event) => {
  event.preventDefault();            // ← deklaracja: „aplikacja obsłuży restore"
  tracker.recordContextLost();
};
const onRestored = () => {
  tracker.recordContextRestored();
  tracker.recordDirtyFrame("context-restored");
  invalidate();                      // ← tylko jedna klatka
};
```

**Przyczyna źródłowa.** `preventDefault()` deklaruje, że aplikacja obsłuży odtworzenie kontekstu, ale `onRestored` jedynie zleca jedną klatkę. Wszystkie bufory wgrywane ręcznie przez `Viewport3DGpuUploadChunk.upload()` nie mają wymuszonego `needsUpdate = true` po restore; nie ma też re-enqueue biletów porzuconych w momencie utraty kontekstu (M-04).

**Objaw.** Po utracie i przywróceniu kontekstu (przełączenie GPU, uśpienie laptopa) siatki renderują się z nieaktualnym kolorem wierzchołków aż do następnej zmiany rewizji pola.

**Naprawa.** W `onRestored` unieważnić stan uploadu — wprowadzić `contextGeneration` w zależnościach efektów `useViewport3DScalarColorUpload`/`useViewport3DGeometryUpload` i ponowić kolejkowanie; albo zrezygnować z `preventDefault()` i pozwolić przeglądarce na pełny restore three.js.

---

### <a id="m-18"></a>M-18 · **NISKI** · `Viewport3DResourceTracker.disposables` to silna `Map` — każdy nietrafiony `release()` przypina zasób do końca życia viewportu

**Lokalizacja:** `viewport3dDiagnostics.ts:157-158`, `:271-282`, `:312-327`

```ts
private readonly disposables   = new Map<object, () => void>();
private readonly ledgerEntries = new Map<object, Viewport3DResourceLedgerEntry>();
```

Tracker trzyma **silne** referencje do każdego `BufferGeometry`/`Material`/`Texture`, więc dowolna ścieżka pomijająca `release()` (zob. M-05) uniemożliwia GC nawet wtedy, gdy warstwa dawno zniknęła ze sceny.

**Naprawa.** Trzymać `disposables` jako `WeakMap` + osobny, ograniczony rejestr liczników; albo dodać `FinalizationRegistry` raportujący zasoby zebrane bez `release()` jako wyciek. Minimum: asercja w trybie dev „tracked but never released" przy `disposeAll()`.

---

## 7. Architektura i dług technologiczny

### 7.1 Metryki

**15 największych plików źródłowych**

| plik | linie | KB | wywołania hooków | eksporty | test dedykowany | linie testu |
|---|---:|---:|---:|---:|:---:|---:|
| `hooks/useViewport3DSceneModel.ts` | 6576 | 232 | **158** (94 × `useMemo`) | 53 | tak | 4912 |
| `Viewport3DModule.tsx` | 3360 | 112 | **90** | 30 | tak | 2155 |
| `viewport3dRenderModel.ts` | 3173 | 103 | 0 | 41 | tak | 4058 |
| `viewport3dResources.ts` | 2273 | 69 | 85 | 47 | tak | 1883 |
| `layers/Viewport3DScene.tsx` | 2117 | 70 | 37 | 19 | tak | 1038 |
| `layers/FdmCuboidLayer.tsx` | 1818 | 55 | 33 | 32 | tak | 1186 |
| `layers/fdmCuboidBuildModel.ts` | 1692 | 54 | 0 | 29 | tak | 975 |
| `model/viewport3DFieldDataPlan.ts` | 1660 | 48 | 0 | 45 | tak | 1128 |
| `viewport3dFieldMapping.ts` | 1494 | 43 | 0 | 21 | tak | 867 |
| `hooks/useViewport3DChunkedScalarColors.ts` | 1468 | 44 | 14 | 18 | tak | 933 |
| `layers/VectorFieldLayer.tsx` | 1376 | 38 | 36 | 15 | tak | 610 |
| `layers/CameraControls.tsx` | 1309 | 39 | 41 | 18 | tak | 690 |
| `layers/BoundsLayers.tsx` | 1267 | 39 | 14 | 21 | tak | 710 |
| `layers/MeshPartLayer.tsx` | 1206 | 40 | 22 | 11 | tak | 1162 |
| `viewport3dTopologyIndexModel.ts` | 1084 | 34 | 0 | 26 | tak | 542 |
| *(granica)* `viewport3dTypes.ts` | 81 | 2 | 0 | 4 | **NIE** | 0 |
| *(granica)* `public.ts` | 17 | 1 | 0 | 4 | **NIE** | 0 |

**Zliczenia globalne (290 plików)**

| metryka | wartość | ocena |
|---|---:|---|
| pliki źródłowe / testowe | 149 / 141 | ✅ |
| linie źródłowe / testowe | 64 949 / 51 691 | ✅ |
| liczba testów (`it`/`test`) | 1606 | ✅ |
| `any` jako typ / `as any` | **0 / 0** | ✅ wybitne |
| `@ts-ignore` / `@ts-expect-error` | **0 / 0** | ✅ wybitne |
| non-null assertion `!.` | **2** | ✅ |
| `TODO` / `FIXME` / `HACK` / `XXX` | **0 / 0 / 0 / 0** | ✅ |
| `console.*` | **0** | ✅ |
| „ciche" `catch` | 8 — **wszystkie z komentarzem uzasadniającym** | ✅ |
| `eslint-disable` | 8 (5 × `preserve-manual-memoization`, 3 × `exhaustive-deps`) | ⚠️ |
| eksporty ogółem (bez testów) | **1157** | ❌ |
| symbole w `public.ts` | **7** | ❌ |
| eksporty używane **wyłącznie** przez testy | **312** w 71 plikach | ❌ |
| eksporty `*ForTests` w kodzie produkcyjnym | 16 | ❌ |
| eksporty bez żadnej referencji zewnętrznej | 153 | ❌ |
| cykle importów | **5** (1 wartościowy, runtime) | ❌ |
| mutowalne singletony na poziomie modułu | **82** | ❌ |
| nazwy funkcji zdefiniowane w > 1 pliku | **40** | ❌ |
| odrębne identyfikatory `*Revision` (typ `number`) | **104** | ❌ |
| `VIEWPORT_3D_DIRTY_REASONS` | **57** (limit batchera: 16) | ❌ |
| flagi `viewport3D*EnabledFromBrowserConfig` | **21** | ⚠️ |
| asercje na **tekście źródłowym** w testach | **~970** w 40 plikach | ❌ |
| `renderHook` w teście monolitu | **0** | ❌ |

---

### <a id="a-01"></a>A-01 · **KRYTYCZNY** · Monolit `useViewport3DSceneModel` — jedna funkcja 3902 linii, CC ≈ 682

**Lokalizacja:** `hooks/useViewport3DSceneModel.ts:2645` (start ciała), `:6438` (`return`), koniec `:6546`

**Dowód (zmierzone).**
* ciało hooka: **3902 linie** w jednej funkcji (druga najdłuższa funkcja w module ma 910 linii);
* **295** deklaracji `const` na poziomie ciała, w tym **108** o prefiksie `fdm*` (34 `fdmAirbox*`, 13 `fdmMultilayer*`, 8 `fdmTarget*`);
* **94 × `useMemo`**, 4 × `useCallback`, 3 × `useEffect`, **35 różnych hooków zasobowych**;
* szacowana złożoność cyklomatyczna ciała ≈ **682**, **1031** operatorów `?`, maksymalne zagnieżdżenie 6;
* zwracany obiekt: **94 pola** (płaski worek).

**Przyczyna źródłowa.** Hook powstał jako „jedno miejsce, gdzie schodzą się wszystkie zasoby", a każda nowa ścieżka renderowania (FDM airbox → multilayer → native layers → targets → mode composition → analysis overlay → hysteresis replay) była dodawana inkrementalnie, a nie wydzielana. Ponieważ wszystkie memo są w jednym zakresie, każda nowa zależność może „za darmo" sięgnąć po dowolną wcześniejszą — koszt dodania jest zerowy, koszt usunięcia rośnie kwadratowo.

**Objaw dla zespołu.** Nie da się zmienić niczego w ścieżce FDM bez przeczytania ~4 tys. linii; brak możliwości równoległej pracy dwóch osób na pliku bez konfliktu; każdy przegląd PR-a dotykającego hooka jest de facto przeglądem całego modułu. Ryzyko regresji przy dowolnej zmianie zależności memo jest **nieograniczone**, bo nie ma testu uruchamiającego hook (A-08).

**Naprawa — dekompozycja po granicach domenowych, które już są widoczne w nazwach zmiennych:**

| nowy plik | co obejmuje | ile lokalnych `const` |
|---|---|---:|
| `hooks/scene/useViewport3DFdmAirboxModel.ts` | `fdmAirbox*` | 34 |
| `hooks/scene/useViewport3DFdmMultilayerModel.ts` | `fdmMultilayer*` | 13 |
| `hooks/scene/useViewport3DFdmTargetsModel.ts` | `fdmTarget*`, `fdmNativeLayer*` | 8+ |
| `hooks/scene/useViewport3DFemTopologyModel.ts` | `topology*`, `mesh*` | — |
| `hooks/scene/useViewport3DFieldDemandModel.ts` | `field*`, `quantity*` (zapytania i plany zasobów) | — |
| `hooks/scene/useViewport3DOverlaysModel.ts` | `region*`, `periodic*`, `analysis*`, `hysteresis*`, `mode*` | — |
| `hooks/scene/useViewport3DCameraAndSelectionModel.ts` | kamera, selekcja | — |

Każdy zwraca **własny, nazwany podobiekt**; `useViewport3DSceneModel` staje się ~150-liniowym kompozytem zwracającym `{ fdm, fem, field, overlays, camera, selection, diagnostics }` zamiast płaskich 94 pól. Czyste funkcje `resolve*`/`merge*` (linie 303-2643, 50 funkcji) przenieść do `model/` — są bezstanowe i już przetestowane.

---

### <a id="a-02"></a>A-02 · **KRYTYCZNY** · `Viewport3DModule.tsx` to pięć modułów w jednym pliku

**Lokalizacja:** `Viewport3DModule.tsx:513-1165` (model colorbara), `:1167-1234` (ręczny store), `:1236-1303` (formatery + lifecycle), `:1362-1687` (shell modułu), `:1843-2752` (`Viewport3DFrame`), `:2767-2857` (announcements a11y)

**Dowód.** 3360 linii, **30 eksportów**, **90 wywołań hooków**; komponent `Viewport3DFrame` ma **910 linii** i **37 propsów** (CC ≈ 123). W liniach 498-1240 znajduje się **114** wystąpień słowa „colorbar" — czyli ~740 linii czystej logiki legend i skal, bez JSX, w pliku komponentu React.

**Przyczyna źródłowa.** `Viewport3DModule.tsx` jest punktem wejścia modułu (`manifest.ts: component: () => import("./Viewport3DModule")`), więc wszystko, co „musi być na górze", tam wylądowało. Logika colorbara wymaga jednocześnie planów z hooka i stanu retencji między klatkami, więc zamiast wydzielić model — wstawiono ją obok komponentu.

**Naprawa.**
* `model/viewport3DColorbarLegendModel.ts` — `resolveViewport3DColorbarLegend`, `resolveViewport3DScalarColorbarLegends`, `buildViewport3DColorbarTargetPlans`, `resolveRetained*`, `shouldRetain*`, `shouldClear*` (linie 513-1165);
* `viewport3dColorbarRetentionStore.ts` — ręczny store z A-07;
* `Viewport3DFrame.tsx` — wydzielony komponent + własny typ propsów;
* `viewport3dAnnouncements.ts` — `resolveViewport3DFdmSelectionAnnouncement`, `nonEmptyAnnouncementText`;
* `Viewport3DModule.tsx` zostaje jako ~250-liniowy shell.

---

### <a id="a-03"></a>A-03 · **KRYTYCZNY** · Prop drilling: `Viewport3DScene` przyjmuje 92 propsy i nie jest memoizowany

**Lokalizacja:** `layers/Viewport3DScene.tsx:171-294` (`Viewport3DSceneProps` — 104 pola), `:1691` (destrukturyzacja 92 propsów); `Viewport3DModule.tsx:2678`

**Dowód.**
* `Viewport3DScene` — 92 destrukturyzowane propsy, `memo` **nieużyty** (`grep 'memo(' layers/Viewport3DScene.tsx` → 0);
* `Viewport3DModelLayerStack:1045` — **61 propsów**, 449 linii, też bez `memo`;
* `Viewport3DOverlayLayerStack:859` — 27 propsów; `Viewport3DInteractionAndHudStack:1554` — 18;
* łańcuch: hook (94 pola) → `Viewport3DFrame` (37 + `...sceneProps`) → `Viewport3DScene` (92) → 4 stacki → ~20 warstw;
* w całym module tylko 5 komponentów ma > 20 propsów i **wszystkie** leżą na tej ścieżce.

**Przyczyna źródłowa.** Model sceny jest płaskim workiem pól, więc jedyną możliwą formą przekazania jest spread. Kontekst R3F nie został użyty, bo dane pochodzą z hooka **poza** `<Canvas>`.

**Objaw.** Zmiana jednego z 94 pól hooka (np. `fdmMultilayerAirboxBuildStatus: string`) przerenderowuje całe poddrzewo sceny; profilowanie „co spowodowało klatkę" jest niewykonalne. Dodanie warstwy = edycja 4 plików i 3 list propsów.

**Naprawa.** Konteksty per domena **wewnątrz** `<Canvas>`, zasilane podobiektami z A-01:
`layers/context/Viewport3DFdmContext.tsx`, `Viewport3DFemContext.tsx`, `Viewport3DOverlayContext.tsx`, `Viewport3DCameraContext.tsx`. Stacki konsumują kontekst zamiast propsów; `Viewport3DScene` schodzi do ~10 propsów. `memo` + jawne `arePropsEqual` na `Viewport3DModelLayerStack` i `MeshPartLayer`.

---

### <a id="a-04"></a>A-04 · **WYSOKI** · Granica modułu jest fikcyjna — 1157 eksportów przy 7 symbolach publicznych

**Lokalizacja:** `public.ts:1-17`; `hooks/useViewport3DSceneModel.ts` (53 eksporty), `Viewport3DModule.tsx` (30), `layers/FdmCuboidLayer.tsx` (32)

**Dowód.**
* `public.ts` eksportuje **7** symboli; moduł eksportuje **1157**;
* **312 eksportów jest używanych wyłącznie przez testy** (46/52 w `useViewport3DSceneModel.ts`, 27/29 w `Viewport3DModule.tsx`, 22/30 w `FdmCuboidLayer.tsx`);
* **16 funkcji `*ForTests`** trafia do bundla produkcyjnego (`viewport3dRenderModel.ts:2153`, `layers/FdmCuboidLayer.tsx:273`, `region-overlays/useViewport3DRegionOverlayModels.ts:248,261`, …);
* **wyciek typu przez granicę publiczną**: `public.ts` eksportuje `Viewport3DRenderedScalarRange`, którego pole `scopeKind: Viewport3DFieldScopeKind` (`viewport3dStore.ts:54`) pochodzi z `model/viewport3DFieldDataPlan.ts:62` — pliku **nieeksportowanego** przez `public.ts`. Konsument nie może nazwać ani zawęzić tego typu bez głębokiego importu;
* nic nie egzekwuje granicy — brak `index.ts`, brak reguły `no-restricted-imports`.

**Przyczyna źródłowa.** `export` był używany jako mechanizm **testowalności** (jedyny sposób dobrania się do logiki zamkniętej w monolicie), a nie jako deklaracja kontraktu. Komentarz w `public.ts` („Internal render/runtime modules remain private") opisuje intencję, której nic nie pilnuje.

**Naprawa.**
1. Dodać `Viewport3DFieldScopeKind` do `public.ts` — **natychmiast**, to błąd kontraktu;
2. reguła ESLint `no-restricted-imports` blokująca `@/modules/viewport-3d/*` poza `public`;
3. `*ForTests` przenieść za `import.meta.vitest` albo do `__testing__/` wykluczanego z bundla;
4. 312 eksportów test-only zniknie samo po dekompozycji A-01/A-02 — testowana będzie jednostka, nie wnętrze pliku.

---

### <a id="a-05"></a>A-05 · **WYSOKI** · Pięć cykli importów i odwrócenie warstw `model/` ↔ root ↔ `layers/`

| cykl | rodzaj |
|---|---|
| `layers/BoundsLayers.tsx:57` ↔ `layers/MeshPartLayer.tsx:64` | **wartościowy (runtime)** |
| `layers/FdmCuboidLayer.tsx:50` ↔ `viewport3dInspect.ts:3` | typowy |
| `viewport3dRenderModel.ts:28` ↔ `model/viewport3DDerivedWorkPlan.ts:6` | typowy |
| `viewport3dRenderModel.ts:34` ↔ `model/viewport3DTargetDiagnostics.ts:1` | typowy |
| `viewport3dDomainAdapter.ts:43` ↔ `layers/fdmCuboidBuildModel.ts:6` | typowy |

**Dowód.** `BoundsLayers` importuje **wartości** `recordMeshPartSurfaceAdoption`, `resolveMeshPartSurfacePickIdentity` z `MeshPartLayer`, a `MeshPartLayer` importuje **wartość** `BoundsBox` z `BoundsLayers` — prawdziwy cykl ESM, którego kolejność inicjalizacji zależy od bundlera. Pozostałe cztery są `import type` (znikają po kompilacji), ale kodują **odwróconą warstwowość**: `model/` (warstwa niższa) zależy od `viewport3dRenderModel.ts` (wyższa), a `viewport3dDomainAdapter.ts` (adapter domeny) zależy od `layers/` (prezentacja). `viewport3dInspect.ts` — model domenowy w korzeniu — importuje typ z komponentu React.

**Przyczyna źródłowa.** Typy współdzielone są definiowane tam, gdzie po raz pierwszy były potrzebne (`FdmCuboidInstanceModel` w `layers/FdmCuboidLayer.tsx`, `FdmGridRenderDomain` w `viewport3dDomainAdapter.ts`), a nie w warstwie kontraktów.

**Naprawa.**
* `model/viewport3DRenderContracts.ts` — wspólne typy: `Viewport3DTargetRenderPassModel`, `FdmCuboidInstanceModel`, `FdmGridRenderDomain`, `Viewport3DDerivedWorkItem`; wszystkie cztery cykle typowe znikają;
* `layers/meshPartAdoption.ts` — wyciągnąć `recordMeshPartSurfaceAdoption` + `resolveMeshPartSurfacePickIdentity`, co rozcina jedyny cykl runtime;
* `layers/primitives/BoundsBox.tsx` — wydzielić z `BoundsLayers.tsx`;
* dodać `eslint-plugin-import/no-cycle` do CI.

---

### <a id="a-06"></a>A-06 · **WYSOKI** · Brak jednego źródła prawdy dla kamery — czterech niezależnych właścicieli

**Lokalizacja:** `viewport3dStore.ts:356` (`setCamera`); `hooks/useViewport3DSceneModel.ts:2622` (`resolveViewport3DSceneCameraView`); `layers/CameraControls.tsx:321`, `:338`, `:838`; `orientation/OrientationHudLayer.tsx:102`; `Viewport3DModule.tsx:1532`, `:1584`

Stan kamery żyje równolegle w **czterech** miejscach:
1. `viewport3dStore.camera` — zapisywany z `CameraControls.tsx:321`, `Viewport3DModule.tsx:1540`, `manifest.ts:205,216`;
2. kernel `CameraRegistryController` — `useCameraRegistryCamera()`, **to z niego czyta scena**;
3. zasób wizualizacji (`cameraResource`);
4. żywy obiekt `THREE.Camera` sterowany przez OrbitControls.

**Dowody rozjazdu.**
* `resolveViewport3DSceneCameraView` (`:2622`) deklaruje parametr `commandState: Pick<Viewport3DCommandState, "camera" | "widgets">` i **nigdy go nie używa** — zamrożony ślad po migracji store → registry;
* `OrientationHudLayer.tsx:102` godzi trzy źródła naraz: `camera.position.toArray()`, `controls.getTarget()` i `viewport3dStore.getSnapshot().camera`;
* `layers/Viewport3DScene.tsx:1942` wyłącza `exhaustive-deps` z komentarzem, że ponowne zaaplikowanie stanu Reacta nadpisałoby pozycję OrbitControls i spowodowało „visible rewind";
* `viewport3DCameraViewSignature` (`viewport3dStore.ts:656`) — funkcja stworzona do porównywania tych źródeł — jest już **martwa** (0 referencji).

**Objaw.** Każdy bug „kamera skacze / wraca" wymaga zbadania 4 ścieżek; nie da się napisać testu determinującego stan kamery.

**Naprawa.**
1. usunąć nieużywany parametr `commandState` (i towarzyszącą asercję tekstową w teście — A-08);
2. `viewport3dCameraOwnership.ts` — jeden adapter: `CameraRegistry` = źródło prawdy **trwałej**, `THREE.Camera` = źródło prawdy **chwilowej** podczas gestu, jawna funkcja `commitLiveCameraToRegistry(reason)`;
3. usunąć `camera` z `Viewport3DCommandState` (`viewport3dStore.ts:21`) i przepiąć `CameraControls:838`, `OrientationHudLayer:102`, `Viewport3DModule:1584` na registry;
4. usunąć martwe `viewport3DCameraViewSignature`.

---

### <a id="a-07"></a>A-07 · **WYSOKI** · Ręczny, trzeci store w pliku komponentu — z niepełną równością i bez sprzątania

**Lokalizacja:** `Viewport3DModule.tsx:1167-1234`, `:1174` (`sameViewport3DColorbarPlans`), `:2178`, `:2204`; typ `model/viewport3DColorbarPlan.ts:26-40`

**Dowód.**
* `retainedViewport3DColorbarPlansBySlot = new Map<...>()` + `retainedViewport3DColorbarPlanListeners = new Set<...>()` — **trzeci** magazyn stanu obok `viewport3dStore` i React state, zdefiniowany na poziomie modułu w pliku komponentu;
* `Viewport3DColorbarPlan` ma **13 pól**, a funkcja równości porównuje **5**: `groupKey`, `range.min`, `range.max`, `rangeState`, `targetIds`. **Ignorowane są**: `colorMode`, `palette`, `projectionMode`, `quantityId`, `rangeSource`, `legendId`, `renderKey`, `scopeId`, `scopeKind`;
* efekt `:2178` zapisuje jednocześnie do tej mapy **i** do `viewport3dStore`, a w tablicy zależności ma `retainedColorbarPlans` — czyli **własny output** odczytany z powrotem przez `useSyncExternalStore`;
* cleanup `:2204` czyści `viewport3dStore`, ale **nie usuwa wpisu** z `retainedViewport3DColorbarPlansBySlot` (M-15).

**Objaw — realny błąd.** Zmiana palety albo komponentu skalarnego przy niezmienionych `groupKey`/`range`/`targetIds` **nie zaktualizuje zachowanej legendy** — colorbar pokazuje starą paletę. Dodatkowo pętla render → efekt → store → render jest chroniona wyłącznie tą niepełną równością.

**Naprawa.**
* wydzielić do `viewport3dColorbarRetentionStore.ts` z API `createViewport3DColorbarRetention(slotId)` → `{ subscribe, get, set, dispose }`;
* **równość generować z `renderKey`** (już istnieje w typie i jest deterministycznym skrótem planu) zamiast ręcznej listy pól — jedna linia zamiast 25;
* `dispose()` wołany w cleanupie efektu;
* docelowo wchłonąć do `viewport3dStore` jako `colorbarRetentionBySlot`, żeby liczba magazynów spadła z 3 do 2.

---

### <a id="a-08"></a>A-08 · **KRYTYCZNY** · Testy sprzężone z tekstem źródła: ~970 asercji `toContain`/`toMatch` na kodzie, 0 × `renderHook` dla monolitu

**Lokalizacja:** `hooks/useViewport3DSceneModel.test.ts:1` (`readFileSync`), `:305`, `:417-520`, `:4527`; łącznie **40 ze 141** plików testowych

**Dowód.**
* `readFileSync` na plikach `.ts` w **40 plikach testowych**; ~**970** asercji typu `expect(source | block).toContain(...)`;
* rozkład: `useViewport3DSceneModel.test.ts` — 216, `Viewport3DModule.test.ts` — 120, `FdmCuboidLayer.test.ts` — 98, `Viewport3DScene.test.ts` — 92, `CameraControls.test.ts` — 74;
* przykłady: `expect(settingsBlock).toContain("inheritedSettings: globalObjectBaseSettings,")`, `expect(source).toContain('cellSelection: "inactive"')`, `expect(source).toContain("const cameraView = resolveViewport3DSceneCameraView({")`;
* `useViewport3DSceneModel.test.ts` ma 4911 linii i **146 testów**, ale **`renderHook` = 0** — testowane są wyłącznie 52 czyste funkcje z linii 303-2643. **Ciało hooka (3902 linie, CC ≈ 682) nie ma ani jednego testu wykonującego kod.**

**Przyczyna źródłowa.** Monolit z A-01 jest nieuruchamialny w teście (wymagałby zamockowania 35 hooków kernela), więc zespół zaczął weryfikować **wygląd kodu** zamiast **zachowania**. To racjonalna reakcja na architekturę, ale ją utrwala: teraz sam refaktor łamie testy.

**Objaw.** Przemianowanie zmiennej lokalnej albo zmiana formatowania wywala test; testy nie wykryją żadnej regresji zachowania w orkiestracji; asercja `:4527` **blokuje usunięcie martwego parametru** z A-06. Zespół płaci pełny koszt utrzymania testów przy **zerowej wartości ochronnej** dla najbardziej złożonej części modułu.

**Naprawa.**
1. Natychmiast: zakaz nowych asercji na `readFileSync` (reguła lintu na `readFileSync` w `*.test.ts`);
2. po dekompozycji A-01 każdy z 7 pod-hooków testować przez `renderHook` z `@testing-library/react` + fake'owym `KernelContext`;
3. dla kontraktów, które naprawdę wymagają „ten kod nie może się pojawić" — zastąpić testem zachowania na danych granicznych albo regułą lintu, nie grepem;
4. migrować partiami: usuwać asercje tekstowe **dopiero razem** z dodaniem odpowiadającego testu zachowania (dziś są jedyną dokumentacją niektórych inwariantów).

---

### <a id="a-09"></a>A-09 · **WYSOKI** · Duplikacja algorytmów między wątkiem głównym a workerami — z już wystąpioną rozbieżnością

**Lokalizacja rozjazdu:** `viewport3dFieldMapping.ts:1475` vs `field-colors/viewport3dFieldColorBuildModel.ts:471`

```ts
// viewport3dFieldMapping.ts:1475 (wątek główny)
if (!Number.isFinite(value)) return 0.5;
const span = Math.max(range.max - range.min, 1e-12);

// field-colors/viewport3dFieldColorBuildModel.ts:471 (worker) — BRAK strażnika
const span = Math.max(range.max - range.min, 1e-12);
```

**Skala duplikacji.**
* **40 nazw funkcji** zdefiniowanych w więcej niż jednym pliku; `throwIfAborted` w **9** plikach, `isAbortError` w **9** (trzy różne implementacje!), `serializeError` w 5, `addArrayBufferTransferable` w 9;
* klaster 7 identycznych funkcji (`colorAt`, `scalarAt`, `normalizeScalarValue`, `writeVectorValue`, `shaderScalarModeSupports`, `shaderVectorModeSupports`, `resolveProvidedScalarRange`) skopiowany z `viewport3dFieldMapping.ts` (1494 linie) do `field-colors/viewport3dFieldColorBuildModel.ts` (491 linii) — **cała ścieżka kolorowania istnieje w dwóch egzemplarzach**;
* `isAbortError` różni się **semantycznie** między schedulerami: `viewport3dTopologyIndexScheduler.ts:675` i `layers/fdmCuboidBuildScheduler.ts:435` dopasowują dodatkowo `error.message`, `region-overlays/…:380` tylko `error.name`;
* stałe: `VIEWPORT_3D_WORLD_UP` zdefiniowane w `layers/CameraControls.tsx:104` (**w komponencie!**), ale literał `[0, 0, 1]` powtórzony w `model/viewport3DTargets.ts:228,283`, `layers/regionOverlayModel.ts:153`, `orientation/viewCubeModel.ts:71,74,99,103,111`, `orientation/magnetizationColor.ts:37`, `viewport3dPrimitiveModel.ts:141`;
* `DEFAULT_HEAD_RADIUS_RATIO = 0.1` i `DEFAULT_SHAFT_RADIUS_RATIO = 0.035` — po dwa razy (`layers/vectorGlyphGeometry.ts:32,33` i `layers/VectorFieldLayer.tsx:50,51`);
* `CSS_VARIABLE_COLOR_PATTERN` + `resolveCssColorToken` — **cztery kopie**.

**Konsekwencja rozjazdu NaN.** Dla `value = NaN` wątek główny daje 0.5, worker daje `NaN` → `resolveViewport3DVectorColorRgb` zwróci `null` → fallback `[1,1,1]` (biel) zamiast koloru środka palety. **Ten sam zbiór danych renderuje się różnie w zależności od tego, czy zadziałał worker, czy fallback** — a to zależy od środowiska, więc jest nieodtwarzalne lokalnie.

**Naprawa.**
* `field-colors/core/viewport3dScalarColorKernel.ts` — bezzależnościowy rdzeń importowany **i** przez `viewport3dFieldMapping.ts`, **i** przez worker; test parametryzowany na `NaN`/`±Infinity`/pustym zakresie;
* `build-engine/workerProtocol.ts` — jedno `serializeError`, `addArrayBufferTransferable`, `cloneOptionalArray`, `throwIfAborted`, `isAbortError` dla wszystkich 5 schedulerów;
* `viewport3dConstants.ts` — `VIEWPORT_3D_WORLD_UP`, `DEFAULT_*_RATIO`;
* `layers/cssColorTokens.ts` — jeden `resolveCssColorToken`.

---

### <a id="a-10"></a>A-10 · **WYSOKI** · Typowanie strukturalne zamiast nominalnego: 104 różne „rewizje" typu `number`

**Lokalizacja:** całe API modelu; np. `layers/Viewport3DScene.tsx:171-294` — propsy `fitRevision`, `inspectRevision`, `resetCameraRevision`, `orbitDebugRevision`, `orbitDebugCommitRevision`, `moveDraftResetRevision`, `visualizationRevision`, `topologyRevision`, `sceneRevision`, `captureRevision` — **wszystkie `number`**

**Dowód.** **104 odrębne identyfikatory** kończące się na `Revision` (`topologyRevision` 306 wystąpień, `fieldRevision` 256, `targetRevision` 174, `meshTopologyRevision` 82, `payloadRevision` 68, `styleRevision` 24, `samplingRevision` 27, `matrixContentRevision` 12 …). Wszystkie są zwykłymi `number`/`string` — kompilator **nie wykryje** podania `fitRevision` tam, gdzie oczekiwany jest `captureRevision`. Identyczny problem dla identyfikatorów: `objectId`, `partId`, `regionId`, `targetId`, `carrierId`, `bufferId`, `resourceKey`, `groupKey`, `renderKey`, `slotId`, `legendId`, `buildKey`.

Moduł jest wzorowo czysty typowo (0 × `any`, 0 × `@ts-ignore`, 2 × `!`), więc jest to **jedyna** realna dziura w bezpieczeństwie typów — i największa.

**Objaw.** Pomyłka przy 92-propsowym spreadzie (A-03) jest niewykrywalna kompilacyjnie i objawia się jako „warstwa się nie odświeża" albo „odświeża się w kółko".

**Naprawa.**
```ts
// viewport3dBrands.ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };
export type TopologyRevision = Brand<number, "TopologyRevision">;
export type PartId = Brand<string, "PartId">;
```
Wprowadzać przyrostowo: najpierw `TopologyRevision`, `FieldRevision`, `TargetRevision` (3 najczęstsze, **736 wystąpień**), potem identyfikatory. Równolegle `Viewport3DDirtyReason` (57 wariantów) i `Viewport3DDomainRenderLane` zamienić na **unie dyskryminowane z ładunkiem** — dziś `dirtyReason` to gołe stringi bez powiązania z tym, co faktycznie stało się nieaktualne.

---

### <a id="a-11"></a>A-11 · **WYSOKI** · Escape hatche React Compilera: pięć `preserve-manual-memoization` w monolicie

**Lokalizacja:** `hooks/useViewport3DSceneModel.ts:4994`, `:4996`, `:5890`, `:5898`, `:5910`; `:3399` (`exhaustive-deps`); `layers/Viewport3DScene.tsx:1942`; `layers/CameraControls.tsx:609`

```ts
[ fdmAirboxPassPlan.needsPointGeometry, …, fdmDomain,
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  fdmAirboxFieldVector,
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  fdmAirboxVectorCarrierSampleLimit,
  fdmRealizedRegionIds ]
```

Wśród 31 wykrytych tablic zależności w ciele hooka: średnio **5,6 zależności**, **5 tablic ma ≥ 10**, największa **21**.

**Przyczyna źródłowa.** Rekomputacja przy 94 memo jest kosztowna (dane pól są w megabajtach), więc autorzy ręcznie zawężają zależności. Kompilator wykrywa to jako niebezpieczne i jest uciszany.

**Objaw.** Każdy z tych 5 punktów to potencjalne **stale memo** — jeśli `fdmAirboxVectorCarrierSampleLimit` zmieni się bez zmiany pozostałych zależności, kolory glifów zostaną stare. Nie da się tego wykryć testem, bo hook nie jest uruchamiany (A-08).

**Naprawa.** Po dekompozycji A-01 każdy pod-hook ma 10-20 memo o wąskim zakresie — zawężanie zależności przestaje być potrzebne. Do tego czasu: przy każdym `preserve-manual-memoization` dodać komentarz z **dowodem**, dlaczego pominięta zależność nie może zmienić się niezależnie (dziś takiego uzasadnienia nie ma; przy `exhaustive-deps` w `:3399` i `Viewport3DScene.tsx:1942` — jest, i to dobry wzorzec).

---

### <a id="a-12"></a>A-12 · **ŚREDNI** · Martwy kod: 153 eksporty bez referencji, martwy parametr utrwalony testem

**Lokalizacja:** `model/viewport3DTargets.ts:23` (`FULL_FIELD_QUERY`), `:79` (`fdmNativeLayerIdFromTargetId`); `viewport3dStore.ts:656` (`viewport3DCameraViewSignature`); `hooks/useViewport3DSceneModel.ts:2622` (parametr `commandState`)

* **153 eksporty** nie mają ani jednej referencji poza własnym plikiem (ani w źródłach, ani w testach); największe skupiska: `model/viewport3DFieldDataPlan.ts` (13), `viewport3dDiagnostics.ts` (6), `viewport3dRenderModel.ts` (6), `model/modeCompositionRenderPlan.ts` (6);
* w pełni martwe: `FULL_FIELD_QUERY`, `fdmNativeLayerIdFromTargetId`, `viewport3DCameraViewSignature`;
* `@deprecated` bez daty wygaśnięcia i bez usunięcia: `layers/vectorGlyphBuildScheduler.ts:151`, `viewport3dTopologyIndexScheduler.ts:160`, `viewport3dColorTransformScheduler.ts:168`;
* **zero** komentarzy `TODO`/`FIXME`/`HACK` i zero zakomentowanego kodu — martwy kod jest „czysty", więc niewidoczny.

**Naprawa.** Dodać `knip` (albo `ts-prune`) do CI z progiem zero na nowe nieużywane eksporty; usunąć trzy w pełni martwe symbole i trzy `@deprecated` aliasy; usunąć parametr `commandState` **razem** z asercją `:4527`.

---

### <a id="a-13"></a>A-13 · **ŚREDNI** · 21 flag funkcjonalnych bez daty wygaśnięcia, ewaluowanych w ciele renderu

**Lokalizacja:** `layers/Viewport3DScene.tsx:918,922,932,944,954,995,1004,1007,1013,1173,1397,1414,1435,1477,1613,1625,1874,1876,1877,1975`

* **21** różnych `viewport3D*EnabledFromBrowserConfig` (m.in. `SceneLayers`, `BoundsLayers`, `OverlayLayers`, `ClipLayers`, `AirboxLayer`, `FdmCuboidLayer`, `TopologyMeshLayer`, `PrimitiveObjectLayer`, `VectorLayers`, `FieldColorLayers`, `DimensionFrame` + 4 pod-flagi ramki, `OrientationHud`, `PostProcessing`, `MeshSizeHighlightLayer`, `CanvasLifecycleProbe`, `OrbitDebug`, `AuditRenderErrorInjection`);
* **20 wywołań w samym `Viewport3DScene.tsx`**, część zagnieżdżona (4 flagi na jeden element UI);
* funkcje są wywoływane **w trakcie renderu**, nie przez hook — brak reaktywności i jednego punktu odczytu;
* brak jakiegokolwiek znacznika czasu/właściciela: 0 wystąpień `remove once`, `expires`;
* `Viewport3DAuditRenderErrorInjection` (`Viewport3DModule.tsx:1689`) — komponent, który **zawsze rzuca wyjątek** (`: never`), warunkowany flagą, w kodzie produkcyjnym (strzeżony dodatkowo przez `NODE_ENV`/`NEXT_PUBLIC_AUDIT_BUILD`, `:1701`).

**Objaw.** 2²¹ teoretycznych konfiguracji sceny; żadna nie jest testowana poza domyślną. Przy zgłoszeniu „nic nie widać" pierwsze pytanie brzmi „jaka konfiguracja flag?".

**Naprawa.** `viewport3dFeatureFlags.ts` — jeden `useViewport3DFeatureFlags()` zwracający zamrożony rekord, czytany **raz** na górze `Viewport3DScene`, z polami `{ enabled, addedAt, owner, removeBy }`; test w CI failujący gdy `removeBy < today`. Scalić 4 flagi ramki wymiarowej w enumerację `dimensionFrameDetail: "off" | "labels" | "major" | "full"`. `Viewport3DAuditRenderErrorInjection` przenieść do `__testing__/` z dynamicznym importem.

---

### <a id="a-14"></a>A-14 · **ŚREDNI** · Cztery konwencje nazewnicze dla jednej domeny + katalog `layers/` z modelami domenowymi

* pliki: **54** z prefiksem `viewport3d` (korzeń), **23** z `viewport3D` (katalog `model/`), **8** z `Viewport3D` (komponenty); id modułu: `"viewport-3d"`;
* identyfikatory: **89** unikalnych `viewport3D*` vs **63** `viewport3d*` vs 376 `Viewport3D*`;
* stałe: **47** z `VIEWPORT_3D_`, ale `model/viewport3DFieldDataPlan.ts:40,43` używa `VIEWPORT3D_` (`DEFAULT_VIEWPORT3D_SHADER_MONO_COLOR`, `VIEWPORT3D_VECTOR_CARRIER_OVERSAMPLING_FACTOR`);
* `viewport3dTypes.ts` (81 linii) sugeruje centralny moduł typów, ale zawiera wyłącznie `Viewport3DColors`, `VIEWPORT_3D_FRAMELOOP` i 57 dirty reasons — **370 eksportowanych typów** rozproszone jest po 149 plikach;
* `layers/` (katalog prezentacji) zawiera czyste modele bez JSX: `fdmCuboidBuildModel.ts` (1692 linie), `regionOverlayModel.ts` (924), `vectorGlyphBuildModel.ts`, `clipPlaneModel.ts`, `dimensionFrameModel.ts`, `meshPartGeometryPlan.ts`;
* jednocześnie `region-overlays/` (własny katalog) i `layers/regionOverlayModel.ts` obsługują tę samą domenę.

**Naprawa (jednorazowy codemod + `git mv`, do wykonania PRZED A-01, żeby nie mnożyć konfliktów).**
Struktura docelowa: `model/` (czyste modele, zero importów z `layers/`), `layers/` (wyłącznie `.tsx`), `hooks/`, `runtime/` (schedulery + workery + `build-engine/`), `state/` (`viewport3dStore`, retencja colorbara), `contracts/` (typy publiczne + `public.ts`). Konwencja: pliki i identyfikatory `viewport3D*` (camelCase), typy/komponenty `Viewport3D*`, stałe `VIEWPORT_3D_*`.

---

### <a id="a-15"></a>A-15 · **ŚREDNI** · Kaskada render → efekt → globalny store → `useSyncExternalStore` → render

**Lokalizacja:** `Viewport3DModule.tsx:2178-2203`, `:2354-2380`; `layers/Viewport3DScene.tsx:763`, `:768`

* efekt `:2178` ma 9 zależności, w tym `retainedColorbarPlans` — wartość, którą sam pośrednio produkuje. Jedyną blokadą pętli jest **niepełna** równość z A-07;
* efekt `:2354` wykonuje trzy `setState` w jednym przebiegu (`setOrbitDebugAngles` ×2, `setOrbitDebugRevision`, `setOrbitDebugCommitRevision`) — **cztery rendery zamiast jednego**;
* `Viewport3DScene.tsx:763,768` — dwa `useEffect` ustawiające `setStageState` i wołające `invalidate()`; etapowanie warstw realizowane łańcuchem efektów zamiast maszyny stanów;
* 57 dirty reasons przy `frameloop="demand"` — każda warstwa ma własne `invalidate(reason)`, bez centralnego arbitra (zob. C-01).

**Objaw.** Pojedyncza zmiana pola powoduje 3-5 renderów `Viewport3DFrame` (910 linii, 37 propsów) i tyleż pełnych renderów sceny (92 propsy, bez `memo` — A-03).

**Naprawa.** `viewport3dFrameStateMachine.ts` — jawna maszyna `idle → planning → building → uploading → committed` z jednym `useReducer` zamiast łańcucha efektów (`Viewport3DModule.tsx` już używa `useReducer` raz — rozszerzyć ten wzorzec). Orbit-debug: jeden `dispatch({type:"orbit/commit", angles})` zamiast czterech `setState`. `invalidate(reason)` zebrać w istniejącym `viewport3dBatchedInvalidate.ts` i **zabronić** bezpośrednich wywołań w warstwach.

---

### <a id="a-16"></a>A-16 · **ŚREDNI** · Globalne cache modułowe: 82 singletony, izolacja sesji utrzymywana ręcznie

**Lokalizacja:** `viewport3dResources.ts:71-90`; `viewport3dRenderModel.ts:329-404` (13 cache'y); `hooks/useViewport3DChunkedScalarColors.ts:116-125`; `hooks/useViewport3DTopologyIndexBundle.ts:97-101`

* **82** mutowalne singletony na poziomie modułu (`let` / `new Map` / `new Set` / `new WeakMap`);
* `viewport3dRenderModel.ts` sam trzyma **13** cache'y;
* izolacja między sesjami zależy od ręcznego `synchronizeViewport3DSessionIdentity`, które czyści `topologyCache`, `fieldVectorCache`, `qualityDataCache`, `lastGoodFieldVectorRequestKeys` — ale **nie** 13 cache'y z `viewport3dRenderModel.ts` ani cache'y w hookach;
* polityki eviction są rozproszone: `TOPOLOGY_INDEX_BUNDLE_CACHE_MAX_BYTES`, `REGION_OVERLAY_MODEL_CACHE_MAX_BYTES`, `MAX_LAST_GOOD_FIELD_VECTOR_REQUEST_KEYS = 1024`, plus `build-engine/cache/viewport3dDerivedBufferCache.ts` z własnym budżetem — **cztery niezależne budżety pamięci bez wspólnego arbitra**, mimo istnienia `@/kernel/performance/MemoryBudgetRegistry` (importowanego w 7 miejscach).

**Naprawa.** Zmigrować 13 cache'y `viewport3dRenderModel.ts` na istniejący `viewport3dDerivedBufferCache.ts` (ma już budżet, eviction i diagnostykę). Jeden `viewport3dSessionScope.ts` rejestrujący każdy cache (`registerSessionScopedCache({ clear, byteLength })`), tak by `synchronizeViewport3DSessionIdentity` czyścił **wszystko przez rejestr**, a nie przez listę literałową. Podpiąć rejestr pod `MemoryBudgetRegistry`.

---

### <a id="a-17"></a>A-17 · **ŚREDNI** · Duplikacja planowania zapytań o pole między `model/` a monolitem

**Lokalizacja:** `model/viewport3DFieldDataPlan.ts:1130` vs `hooks/useViewport3DSceneModel.ts:1941` (`resolveViewport3DTargetFieldQuery`); `model/viewport3DFieldDataPlan.ts:1626` vs `hooks/useViewport3DSceneModel.ts:2397` (`fieldColorModeScalarComponent`)

Dwie funkcje o **identycznej nazwie i przeznaczeniu** istnieją równolegle w warstwie modelu (dedykowanej do planowania zapotrzebowania na pola) i w monolicie. Monolit **importuje** z `viewport3DFieldDataPlan.ts` (robi to 15 plików), a mimo to ma własną kopię, którą też eksportuje — i którą testuje osobno.

**Przyczyna źródłowa.** Migracja planowania z hooka do `model/` została wykonana **częściowo** — funkcje skopiowano, ale starych nie usunięto, bo były już wyeksportowane i przetestowane (A-04: eksport dla testów uniemożliwia usunięcie).

**Naprawa.** Usunąć obie kopie z `useViewport3DSceneModel.ts`, przekierować importy na `model/viewport3DFieldDataPlan.ts`, przenieść testy. Zysk natychmiastowy: ~60 linii i dwie ścieżki ryzyka mniej, **bez żadnej zmiany zachowania**. To najtańszy możliwy pierwszy krok dekompozycji A-01.

---

## 8. Wzorce przekrojowe — cztery przyczyny źródłowe, z których wynika większość znalezisk

Poniższe cztery wzorce powtarzają się w niezależnych częściach modułu. Naprawa wzorca jest tańsza i trwalsza niż naprawa każdego wystąpienia z osobna.

### 8.1 „Fail closed" bez ścieżki powrotu

Moduł konsekwentnie stosuje zasadę „w razie problemu wyłącz mechanizm", ale **ani razu nie przewiduje ponownego włączenia**. Wystąpienia:

| ID | Mechanizm | Zatrzask | Skutek |
|---|---|---|---|
| [C-01](#c-01) | batched invalidate | `overflowed = true` | brak klatek do końca sesji |
| [C-02](#c-02) | animacja orbit-debug | clamp azymutu do 0 | nieskończona animacja + wyciek field-hold |
| [C-03](#c-03) | commit pozy kamery | `suppressNextRestCommitRef` | pozycja kamery nigdy nie zapisana |
| [C-04](#c-04) | `controls.enabled` | dwóch właścicieli boolean | kamera martwa |
| [V-16](#v-16), [M-08](#m-08) | 5 schedulerów workerów | `client = null` | trwała degradacja do main thread |

**Reguła do wprowadzenia w code review:** *każde trwałe wyłączenie musi mieć albo licznik z backoffem, albo jawny reset przy zdarzeniu cyklu życia, albo bezpiecznik czasowy — i musi być widoczne w diagnostyce.*

### 8.2 Praca proporcjonalna do N na wątku UI, mimo istniejącego workera

Infrastruktura workerów jest dobra, ale **kontrakt danych jest zbyt niskopoziomowy** — worker zwraca półprodukt, a wątek główny go dokańcza.

| ID | Co dzieje się na wątku UI | Skala |
|---|---|---|
| [V-01](#v-01) | `setFromUnitVectors` + 2 × `matrix.compose` per glif | 400 tys. operacji @ 200 tys. strzałek |
| [V-06](#v-06) | podwójna kopia `Float64Array` pola | 2 × 50 MB per przebudowa |
| [V-07](#v-07) | tożsamościowa kopia N×16 macierzy | 32 MB @ 500 tys. komórek |
| [V-08](#v-08) | podwójny, niechunkowany upload macierzy | 2 × 32 MB memcpy |
| [V-19](#v-19) | kopia tablicy segmentów przed transferem | 5,6 MB @ 200 tys. glifów |
| [V-11](#v-11) | potrójna budowa `Map` indeksów pola | setki MB alokacji |
| [S-08](#s-08) | link programu GLSL | 3-15 ms **na klatkę** animacji |

**Reguła:** *granica worker/main thread powinna przebiegać tam, gdzie kończy się obliczenie, a nie w połowie. Worker oddaje bufory gotowe do `set()` — nic więcej.*

### 8.3 Efekty uboczne w fazie renderu

React 19 + concurrent + StrictMode wykonuje render dwukrotnie i porzuca rendery. Moduł tworzy w fazie renderu zasoby GPU, subskrypcje, publisherów i mutuje globalny stan.

| ID | Co powstaje w renderze |
|---|---|
| [M-05](#m-05) | 12 × `tracker.track(...)` w `useMemo` |
| [M-11](#m-11) | publisher + subskrypcja w inicjalizatorze `useState` |
| [M-13](#m-13) | czyszczenie 272 MB cache i abort `fetch` w ciele hooka |
| [M-14](#m-14) | cache glifów + `tracker.notify()` w `useMemo` |
| [M-16](#m-16) | `WebGLRenderTarget` w konstruktorze `EffectComposer` |
| [A-13](#a-13) | 21 flag funkcjonalnych czytanych w ciele renderu |

**Reguła:** *`useMemo` może liczyć, nie może alokować zasobu wymagającego zwolnienia ani rejestrować się nigdzie na zewnątrz.*

### 8.4 Konwencja bez egzekwowania

Moduł ma **poprawne intencje architektoniczne**, których nic nie pilnuje: `public.ts` (7 symboli vs 1157 eksportów, [A-04](#a-04)), warstwowość `model/`/`layers/` (5 cykli, [A-05](#a-05)), jedno źródło prawdy dla kamery ([A-06](#a-06)), budżety pamięci ([M-02](#m-02), [A-16](#a-16)), rdzeń kolorowania ([A-09](#a-09)).

**Reguła:** *intencja architektoniczna, której nie sprawdza CI, przestaje obowiązywać w ciągu jednego kwartału.* Do CI: `eslint-plugin-import/no-cycle`, `no-restricted-imports` na granicy modułu, `knip` na nieużywane eksporty, zakaz `readFileSync` w testach.

---

## 9. Mocne strony — co należy zachować przy refaktorze

1. **Dyscyplina typowania rzadko spotykana w projektach tej skali.** 0 × `any`, 0 × `as any`, 0 × `@ts-ignore`, 0 × `@ts-expect-error`, 2 non-null assertions na 65 tys. linii. Wszystkie 9 produkcyjnych `as unknown as` to uzasadnione rzutowania zakresu workera (`globalThis`) albo katalogu THREE.

2. **Zero długu komentarzowego.** 0 × `TODO`/`FIXME`/`HACK`/`XXX`, 0 × `console.*`, brak zakomentowanego kodu. Dług tego modułu jest **strukturalny, nie brudny** — to znacznie łatwiejszy punkt startowy do refaktoru niż typowy legacy.

3. **Świadoma obsługa błędów.** Wszystkie 8 „cichych" `catch` mają komentarz uzasadniający (np. `viewport3dRenderModel.ts:533`: „Diagnostics must never break viewport rendering"). Dwie warstwy error boundary (`Viewport3DErrorBoundary` wokół modułu + `Viewport3DCanvasErrorBoundary` wewnątrz `<Canvas>`) plus obsługa `webglcontextlost`/`webglcontextrestored`.

4. **Model epok gestu kamery** (`layers/viewport3DCameraGesture.ts`) z `isCurrentActiveEpoch` — zapewnia, że spóźniony `setTimeout`/`Promise` z anulowanego gestu nie nadpisze świeżej pozy. Idiomatyczne rozwiązanie klasy problemów „race między animacją a gestem".

5. **Skalo-świadome porównywanie póz kamery** (`layers/viewport3DCameraState.ts:13-63`) — tolerancja **względna** 1e-8 skalowana rozmiarem sceny plus porównanie wektora `up` kątowo. Poprawnie obsługuje jednocześnie domeny nanometrowe i metrowe.

6. **Delegacja zoomu do OrbitControls zamiast własnego handlera `wheel`** — za darmo działa normalizacja `deltaMode` (`DOM_DELTA_LINE ×16`, `DOM_DELTA_PAGE ×100`), skalowanie `ctrl+wheel` dla pinch, wykładniczy dolly `0.95^k` i `preventDefault` na nasłuchu `{passive:false}`. Eliminuje całą rodzinę typowych błędów zoomu.

7. **Konsekwentne sprzątanie nasłuchów przez `AbortController`** (`CameraControls.tsx:914`, `ViewCube3DBox.tsx:375`) oraz `disconnect()` dla wszystkich `ResizeObserver`/`MutationObserver`.

8. **Aktualne API zakresów aktualizacji bufora (three r183)** — konsekwentne `clearUpdateRanges()`/`addUpdateRange()`; nigdzie nie występuje przestarzałe `updateRange`, częsty błąd przy migracji na r158+.

9. **Współdzielenie bufora pozycji z liczeniem właścicieli** (`viewport3dSharedTopologyPositions.ts:16-36`) — przechwytuje `geometry.dispose` i odpina atrybut u nie-ostatniego właściciela. Nietrywialny i poprawnie zaimplementowany wzorzec.

10. **Chunkowany upload GPU z budżetem klatki, rollbackiem i współdzielonym koordynatorem** (`build-engine/gpu/viewport3dGpuUploadManager.ts:333-431`) — jeden budżet `targetFrameBudgetMs` dzielony między niezależne menedżery, z `pruneInactiveHosts`. To wzorzec, do którego należy dociągnąć airbox ([V-08](#v-08)).

11. **Bogate, kompletne klucze buildów** (`build-engine/viewport3dBuildJobKeys.ts:113-117`) — `sessionId`, `domainGenerationId`, `topologyRevision`, `fieldRevision`, `styleRevision`, `samplingRevision`, `algorithmVersion`. Brak ryzyka serwowania nieaktualnego bufora pod tym samym kluczem.

12. **Bardzo szczelna walidacja wejścia tam, gdzie istnieje** — `resolveFdmMultilayerAirboxFieldVector` (`model/viewport3DFdmMultilayerAirbox.ts:71-91`) sprawdza wersję formatu, `quantityId`, scope, generację domeny, odcisk topologii, kształt siatki, `nComp`, spójność `valueCount` i unikalność indeksów węzłów. To wzorzec, który należy rozciągnąć na `buildFdmFieldIndexResolver` ([V-24](#v-24)).

13. **Sonda trajektorii kamery** (`layers/viewport3DCameraTrajectoryProbe.ts`) z pierścieniowym buforem, głębokim klonowaniem próbek i zerowym narzutem w produkcji (`NOOP_PROBE`) — bardzo dobre narzędzie do diagnozy dokładnie tych klas błędów, które opisuje sekcja 3.

14. **Ograniczone bufory diagnostyczne** — `MAX_DEBUG_CARRIERS`, `MAX_DEBUG_ISSUES`, `MAX_DEBUG_SNAPSHOT_BYTES = 64 KiB`, obcinanie stringów metadanych. Żaden bufor telemetrii nie rośnie liniowo.

15. **Jawne, scentralizowane polityki przebiegów renderowania** (`layers/viewport3DRenderPolicy.ts:40-121`) — `transparent`/`depthWrite`/`depthTest`/`side`/`renderOrder`/`polygonOffset` w jednej tabeli semantyk, z poprawnym `polygonOffsetFactor: +1` dla powierzchni i `−1` dla powłoki zaznaczenia.

16. **`build-engine/` jako wzorzec docelowy** — `{cache, gpu, workerPool}` z czystą separacją typy/diagnostyka/implementacja, własnym budżetem pamięci i pulą workerów. Jedyna część modułu, którą można czytać w izolacji.

---

## 10. Plan naprawczy

Kolejność jest podyktowana zależnościami: naprawy „chirurgiczne" nie kolidują z refaktorem, a zmiany strukturalne wymagają najpierw ujednolicenia nazewnictwa (żeby nie mnożyć konfliktów w git).

### Faza 0 — hotfixy (≈ 2-4 dni, zerowe ryzyko architektoniczne)

Zmiany punktowe, każda w jednym pliku, każda z testem regresyjnym.

| # | ID | Zmiana | Plik |
|---|---|---|---|
| 1 | C-01 | reset `overflowed` + awaryjne `invalidate`; limit = `DIRTY_REASONS.length` | `viewport3dBatchedInvalidate.ts` |
| 2 | C-02 | `normalizeOrbitDebugAzimuth` zamiast `clampOrbitDebugAngle` + bezpiecznik 2 s | `layers/CameraControls.tsx:219` |
| 3 | C-03 | konsumowanie `suppressNextRestCommitRef` w `scheduleCameraControlsPoseCommit` | `layers/CameraControls.tsx:1143` |
| 4 | C-06 | dodać `"onPointerUp"` do listy kluczy; zawęzić filtr `pointermove` | `viewport3dEventManager.ts:9` |
| 5 | V-03 | rozdzielić `magnitude` od `length` przy zapisie `relMag` (2 miejsca) | `layers/fdmCuboidBuildModel.ts:1334`, `:558` |
| 6 | V-05 | `renderCount = Math.min(count, capacity)` | `layers/VectorFieldLayer.tsx:1038` |
| 7 | M-04 | rollback także dla `"aborted"` i w `dispose()` | `build-engine/gpu/viewport3dGpuUploadManager.ts:262` |
| 8 | M-06 | `previous?.dispose()` przy podmianie `instanceColor` | `layers/FdmCuboidLayer.tsx:1211` |
| 9 | M-07 | `gl.dispose()` + `forceContextLoss()` w cleanupie | `Viewport3DCanvas.tsx:122` |
| 10 | M-08, V-16 | `client?.dispose()` + `= undefined` + backoff (5 schedulerów) | `*Scheduler.ts` |
| 11 | M-09 | usuwanie wpisów terminalnych z `jobsByKey` | `build-engine/viewport3dBuildEngineStore.ts:70` |
| 12 | M-10 | usunąć `notify()` z `get()`; raportować `pinnedBytes` | `viewport3dDerivedBufferCache.ts:158` |
| 13 | M-15 | cleanup retencji colorbara i store'u przy unmount | `Viewport3DModule.tsx:2204` |
| 14 | C-11 | `panSpeed: 1` + poprawiona asercja | `layers/CameraControls.tsx:123` |
| 15 | C-17 | `parseFiniteDraftNumber` odrzuca pusty string | `components/Viewport3DCameraDialog.tsx:455` |
| 16 | V-25 | `"dense"` w `cellMatchesSelection` | `layers/fdmCuboidBuildModel.ts:1077` |

### Faza 1 — poprawność wizualna i fizyczna (≈ 1,5-2 tygodnie)

Ta faza ma największy wpływ na **wiarygodność naukową** wyników.

| # | ID | Zmiana | Uwagi |
|---|---|---|---|
| 1 | S-02, S-03 | paleta w linear-sRGB + `#include <colorspace_fragment>`; identycznie w ścieżce CPU | wymaga testu regresyjnego porównującego obie ścieżki |
| 2 | S-10 | paleta jako `DataTexture` LUT 256×N, generowana z tych samych tablic co colorbar | usuwa banding **i** rozjazd z legendą |
| 3 | S-05, S-06 | epsilon **względny**, jedna funkcja zakresu, sentinel NaN (magenta) w shaderze | trzy niezgodne implementacje → jedna |
| 4 | S-11 | zaimplementować `Viewport3DScalarRangePolicy` (`symmetric`, `manual`, `log`) | dziś cały typ jest martwy |
| 5 | S-12 | `safeAtan2` + faza jako skalar; zablokować `phase` + `magnitude` w UI | |
| 6 | S-04 | chunki `clipping_planes_*` + `clipping: true` w `ShaderMaterial` | przywraca działanie przekroju |
| 7 | S-01 | atrybut `normal` (`computeVertexNormals`) + cieniowanie z `fmShadeStrength` | `fmShadeStrength = 0` zachowuje tryb „figure" |
| 8 | V-04 | rozdzielić „normalna" od „czy powierzchniowa"; fallback dla `nz = 1` | naprawia cienkie warstwy |
| 9 | V-24 | walidacja `grid` w `buildFdmFieldIndexResolver` + jawne `ordering` | zabezpiecza przed transpozycją pola |
| 10 | V-10, V-12, V-21 | równomierne dopełnianie próbki; `candidates.length` jako carrier; zakres kolorów z planu | |
| 11 | S-13 | zawijanie fazy Floqueta do `[−π, π]` | |
| 12 | S-16 | `aoRadius` z promienia sceny; próg Bloom na luminancji liniowej (albo usunięcie Bloom) | |

### Faza 2 — wydajność (≈ 2 tygodnie)

| # | ID | Zmiana | Oczekiwany zysk |
|---|---|---|---|
| 1 | S-08 | materiał zależny od **kształtu programu**, nie od danych | animacja fazy: 5-20 fps → 60 fps |
| 2 | V-01 | worker zwraca gotowe macierze; main thread robi `set()` | eliminacja zacięć przy zmianie pola |
| 3 | V-06 | deduplikacja/ping-pong buforów pola zamiast podwójnej kopii | −100 MB memcpy na klatkę animacji |
| 4 | V-07, V-08 | ścieżka tożsamościowa bez kopii; współdzielony `instanceMatrix` | −64 MB memcpy, −50 % VRAM airboxa |
| 5 | V-09 | próg raycastu + `computeBoundingSphere()` + `frustumCulled` | hover na dużej domenie: 1-9 fps → 60 fps |
| 6 | V-02 | scalona geometria glifu (krok 1) | −50 % draw calli i pamięci macierzy |
| 7 | V-11, V-15, V-19 | jeden przebieg indeksowania; `skipColors`; jeden worker dla FDM+glify | |
| 8 | S-19 | `DynamicDrawUsage` dla atrybutów skalarnych | usuwa realokacje bufora |
| 9 | C-10 | clip z żywej kamery + `min/maxDistance` | koniec znikania modelu przy scrollu |
| 10 | C-16 | debounce/rAF dla `ResizeObserver` + zaokrąglenie pomiaru | płynne przeciąganie splittera |
| 11 | V-18 | podwójne buforowanie `instanceMatrix` (albo większe chunki po V-01) | koniec „przecierania" strzałek |
| 12 | M-01, M-02, M-03 | globalny budżet cache'y + zwalnianie przy unmount + `FinalizationRegistry` | −272 MB po zamknięciu panelu |

### Faza 3 — architektura (≈ 6-10 tygodni, iteracyjnie)

Kolejność jest istotna: **A-14 przed A-01**, żeby codemod nazw nie kolidował z dekompozycją.

| # | ID | Krok | Kryterium zakończenia |
|---|---|---|---|
| 1 | A-17 | usunąć duplikaty planowania zapytań o pole | −60 linii, zero zmian zachowania |
| 2 | A-09 | wydzielić `viewport3dScalarColorKernel.ts` i `workerProtocol.ts`; `viewport3dConstants.ts` | 40 → 0 zduplikowanych nazw funkcji |
| 3 | A-14 | codemod nazw + przeniesienie modeli z `layers/` do `model/` | jedna konwencja, `layers/` zawiera tylko `.tsx` |
| 4 | A-05 | `model/viewport3DRenderContracts.ts`; rozcięcie cyklu runtime; `no-cycle` w CI | 5 → 0 cykli |
| 5 | A-04 | rozszerzyć `public.ts`; `no-restricted-imports`; `*ForTests` za `import.meta.vitest`; `knip` | granica egzekwowana przez CI |
| 6 | A-10 | typy markowane dla 3 najczęstszych rewizji (736 wystąpień) | kompilator wykrywa pomyłki rewizji |
| 7 | A-07 | `viewport3dColorbarRetentionStore.ts` z równością po `renderKey` | 3 → 2 magazyny stanu |
| 8 | A-06 | `viewport3dCameraOwnership.ts`; usunąć `camera` ze `store` | 4 → 2 źródła prawdy |
| 9 | A-01 | dekompozycja monolitu na 7 pod-hooków | żaden plik > 800 linii |
| 10 | A-02 | rozbicie `Viewport3DModule.tsx` na 5 modułów | shell < 300 linii |
| 11 | A-03 | konteksty per domena; `memo` na stackach | `Viewport3DScene` < 15 propsów |
| 12 | A-08 | `renderHook` dla każdego pod-hooka; usuwanie asercji tekstowych **parami** z nowym testem | ~970 → < 50 asercji na źródle |
| 13 | A-11 | usunięcie `preserve-manual-memoization` (naturalnie po A-01) | 8 → ≤ 3 `eslint-disable` |
| 14 | A-13, A-12, A-16 | rejestr flag z datą wygaśnięcia; `knip`; `viewport3dSessionScope.ts` | jeden budżet pamięci, zero martwych eksportów |

### 10.1 Sugerowane bramki CI do wprowadzenia razem z fazą 3

```
eslint-plugin-import/no-cycle          → 0 cykli
no-restricted-imports                  → import spoza public.ts zabroniony
knip / ts-prune                        → 0 nowych nieużywanych eksportów
zakaz readFileSync w *.test.ts         → koniec asercji na tekście źródła
limit linii na plik (np. 800)          → zapobiega odtworzeniu monolitu
test wygaśnięcia flag (removeBy)       → flagi nie żyją wiecznie
```

---

## 11. Załącznik — metoda weryfikacji

Znaleziska powstały w pięciu równoległych, niezależnych ścieżkach analizy (kamera / shadery / glify+airbox / pamięć / architektura), każda z pełnym odczytem przypisanych plików. Następnie **ręcznie zweryfikowałem w kodzie** wszystkie tezy krytyczne i wybrane wysokie — poniżej lista potwierdzeń.

| Teza | Weryfikacja | Wynik |
|---|---|---|
| C-01 zatrzask `overflowed` | odczyt `viewport3dBatchedInvalidate.ts:24-80` | ✅ potwierdzone: reset tylko w `cancel()` |
| C-02 clamp azymutu | odczyt `CameraControls.tsx:110-115`, `:219-229` | ✅ `clampOrbitDebugAngle(…, 0, 2π)` |
| C-03 zakleszczenie commitu | `grep -n suppressNextRestCommitRef` → `:804,985,1003,1079,1080,1149`; `commitCameraControlsPose` wołane tylko z `:1159` wewnątrz `scheduleCameraControlsPoseCommit` | ✅ cykl potwierdzony |
| C-06 brak `onPointerUp` | odczyt `viewport3dEventManager.ts:9-17`, `:106-116` | ✅ brak klucza; `buttons !== 0` blokuje |
| C-09 podłoga `far ≥ 1e-3` | odczyt `CameraControls.tsx:356-364` | ✅ literał `1e-3` |
| C-10 brak `min/maxDistance` | odczyt `CameraControls.tsx:1249-1268` | ✅ brak obu propsów |
| C-11 `panSpeed: 2` | odczyt `CameraControls.tsx:117-126` + `screenSpacePanning` w `:1262` | ✅ |
| S-01 brak oświetlenia | odczyt `Viewport3DLightingRig.tsx` (całość) + `grep meshStandardMaterial\|meshPhongMaterial\|meshLambertMaterial` w kodzie produkcyjnym | ✅ `directional: []`; **0 trafień** materiałów świetlnych |
| S-04 brak clippingu w shaderze | `grep -c clipping_planes viewport3dScalarSurfaceShader.ts` | ✅ **0** |
| V-01 kompozycja na wątku UI | odczyt `VectorFieldLayer.tsx:985-1028` | ✅ pętla z `setFromUnitVectors` + 2 × `compose` |
| V-02 dwa `InstancedMesh` | odczyt `VectorFieldLayer.tsx:486-503` | ✅ `CylinderGeometry` + `ConeGeometry` osobno |
| V-03 `\|\| 1` w `relMag` | odczyt `fdmCuboidBuildModel.ts:1331-1355` | ✅ `length` reużyte w `:1354` |
| V-04 `nz = 1` | odczyt `fdmCuboidBuildModel.ts:648-670` | ✅ `iz===0 && iz===nz-1` → `normalZ = 0` → `return null` |
| V-05 cap 1M | odczyt `VectorFieldLayer.tsx:470-475` | ✅ `Math.min(next, 1 << 20)` bez przycięcia `count` |
| V-10 dopełnianie od indeksu 0 | odczyt `fdmCuboidBuildModel.ts:1054-1074` | ✅ pętla `for (cellIndex = 0; …)` |
| M-01 cache'e 272 MB | odczyt `viewport3dResources.ts:57-81`, `:473-475`; `grep clearViewport3DSessionCaches` → tylko `:76` (def.) i `:102` (wywołanie) | ✅ |
| M-04 rollback tylko dla `failed` | odczyt `viewport3dGpuUploadManager.ts:252-270` | ✅ `if (status === "failed")` |
| M-06 `instanceColor` bez `dispose` | odczyt `FdmCuboidLayer.tsx:1200-1220` | ✅ podmiana bez zwolnienia |
| M-07 brak `renderer.dispose()` | `grep -rn "forceContextLoss\|renderer.dispose\|gl.dispose\|renderLists"` bez testów | ✅ **0 trafień** |
| M-13 mutacja w renderze | odczyt `viewport3dResources.ts:93-111` | ✅ wywołanie w ciele `useViewport3DSessionIdentity` |

Tezy, których nie dało się zweryfikować statycznie (wymagają pomiaru w przeglądarce), są w raporcie opisane jako mechanizm z oszacowaniem skali, nie jako zmierzony fakt — dotyczy to głównie liczb wydajnościowych (ms, fps, MB/s). Zalecam potwierdzenie ich istniejącymi skryptami repozytorium:

```
pnpm --filter @fullmag/control-room audit:viewport-3d-memory-churn
pnpm --filter @fullmag/control-room audit:viewport-main-tab-memory
pnpm --filter @fullmag/control-room audit:airbox-vector-cold-toggle
pnpm --filter @fullmag/control-room audit:viewport-3d-profile-switch
pnpm --filter @fullmag/control-room smoke:viewport-3d
```

oraz sondą trajektorii kamery wystawioną pod `window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__` (`layers/viewport3DCameraTrajectoryProbe.ts`) dla znalezisk z sekcji 3.

---

## 12. Indeks znalezisk

**Kamera (18):** [C-01](#c-01) · [C-02](#c-02) · [C-03](#c-03) · [C-04](#c-04) · [C-05](#c-05) · [C-06](#c-06) · [C-07](#c-07) · [C-08](#c-08) · [C-09](#c-09) · [C-10](#c-10) · [C-11](#c-11) · [C-12](#c-12) · [C-13](#c-13) · [C-14](#c-14) · [C-15](#c-15) · [C-16](#c-16) · [C-17](#c-17) · [C-18](#c-18)

**Shadery i kolor (21):** [S-01](#s-01) · [S-02](#s-02) · [S-03](#s-03) · [S-04](#s-04) · [S-05](#s-05) · [S-06](#s-06) · [S-07](#s-07) · [S-08](#s-08) · [S-09](#s-09) · [S-10](#s-10) · [S-11](#s-11) · [S-12](#s-12) · [S-13](#s-13) · [S-14](#s-14) · [S-15](#s-15) · [S-16](#s-16) · [S-17](#s-17) · [S-18](#s-18) · [S-19](#s-19) · [S-20](#s-20) · [S-21](#s-21)

**Glify i airbox (27):** [V-01](#v-01) · [V-02](#v-02) · [V-03](#v-03) · [V-04](#v-04) · [V-05](#v-05) · [V-06](#v-06) · [V-07](#v-07) · [V-08](#v-08) · [V-09](#v-09) · [V-10](#v-10) · [V-11](#v-11) · [V-12](#v-12) · [V-13](#v-13) · [V-14](#v-14) · [V-15](#v-15) · [V-16](#v-16) · [V-17](#v-17) · [V-18](#v-18) · [V-19](#v-19) · [V-20](#v-20) · [V-21](#v-21) · [V-22](#v-22) · [V-23](#v-23) · [V-24](#v-24) · [V-25](#v-25) · [V-26](#v-26) · [V-27](#v-27)

**Pamięć i cykl życia (18):** [M-01](#m-01) · [M-02](#m-02) · [M-03](#m-03) · [M-04](#m-04) · [M-05](#m-05) · [M-06](#m-06) · [M-07](#m-07) · [M-08](#m-08) · [M-09](#m-09) · [M-10](#m-10) · [M-11](#m-11) · [M-12](#m-12) · [M-13](#m-13) · [M-14](#m-14) · [M-15](#m-15) · [M-16](#m-16) · [M-17](#m-17) · [M-18](#m-18)

**Architektura i dług (17):** [A-01](#a-01) · [A-02](#a-02) · [A-03](#a-03) · [A-04](#a-04) · [A-05](#a-05) · [A-06](#a-06) · [A-07](#a-07) · [A-08](#a-08) · [A-09](#a-09) · [A-10](#a-10) · [A-11](#a-11) · [A-12](#a-12) · [A-13](#a-13) · [A-14](#a-14) · [A-15](#a-15) · [A-16](#a-16) · [A-17](#a-17)

**Razem: 101 znalezisk** — 10 krytycznych, 33 wysokich, 42 średnie, 16 niskich.
