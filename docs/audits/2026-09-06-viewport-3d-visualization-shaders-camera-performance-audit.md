# Raport z Audytu Architektoniczno-Wydajnościowego: Moduł Viewport 3D (Fullmag Control Room)

**Data audytu:** 2026-09-06  
**Zakres audytu:** Główny moduł wizualizacji 3D (`apps/control-room/src/modules/viewport-3d`) — shadery powierzchniowe, wektory/strzałki (powierzchnia ferromagnetyków i objętość airboxa), geometria airboxa i siatki, kinematyka i kontrola kamery, zarządzanie pamięcią WebGL, cykl życia zasobów, wydajność oraz dług technologiczny.  
**Autor:** Antigravity AI (Pair Programming & Code Review)

---

## 1. Wstęp i Metodologia Audytu

Audyt został przeprowadzony metodą statycznej analizy kodu źródłowego, weryfikacji z kontraktami projektowymi (`AGENTS.md`, `.agents/instructions/frontend.md`, `docs/specs/frontend-v2/05-viewport-architecture.md`, `docs/specs/frontend-v2/14-viewport-3d-module.md`) oraz analizy wzorców alokacji pamięci GPU/CPU i przetwarzania potokowego (React Three Fiber, Three.js, WebGL2, Web Workers).

### Przeanalizowane pliki kluczowe:
1. **Główny potok modułu i Canvas:**
   - [`Viewport3DModule.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx) (3 360 linii)
   - [`Viewport3DCanvas.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.tsx) (413 linii)
   - [`layers/Viewport3DScene.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx) (2 117 linii)
2. **Kamera, nawigacja i manipulacja widokiem:**
   - [`layers/CameraControls.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx) (1 309 linii)
   - [`orientation/OrientationHudLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/orientation/OrientationHudLayer.tsx) (492 linie)
   - [`orientation/ViewCube3DBox.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/orientation/ViewCube3DBox.tsx) (898 linii)
   - [`orientation/AxisLabelSprite.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/orientation/AxisLabelSprite.tsx) (69 linii)
3. **Shadery i renderowanie powierzchni ferromagnetyków:**
   - [`viewport3dScalarSurfaceShader.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts) (564 linie)
   - [`layers/MeshPartLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx) (1 206 linii)
   - [`layers/FdmCuboidLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx) (1 818 linii)
4. **Wektory i strzałki (Airbox i powłoki ferromagnetyków):**
   - [`layers/VectorFieldLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx) (1 376 linii)
   - [`layers/vectorGlyphGeometry.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/vectorGlyphGeometry.ts) (213 linii)
   - [`layers/vectorGlyphBuildWorker.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildWorker.ts) (54 linie)
   - [`layers/vectorGlyphBuildModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildModel.ts) (75 linii)
   - [`model/viewport3DVectorBudgetAllocator.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/model/viewport3DVectorBudgetAllocator.ts) (133 linie)
   - [`model/viewport3DVectorGlyphScale.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/model/viewport3DVectorGlyphScale.ts) (32 linie)
5. **Wizualizacja Airboxa i obwiedni:**
   - [`layers/BoundsLayers.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx) (1 267 linii)
   - [`layers/dimensionFrameModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/dimensionFrameModel.ts) (374 linie)
6. **Zarządzanie stanem, pamięcią i modelem sceny:**
   - [`hooks/useViewport3DSceneModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts) (6 576 linii)
   - [`viewport3dRenderModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts) (3 000+ linii)
   - [`viewport3dDiagnostics.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts) (675 linii)

---

## 2. Podsumowanie Wykonawcze (Executive Summary)

Moduł `viewport-3d` jest zaawansowanym, wysoce zoptymalizowanym systemem renderowania 3D, stworzonym w oparciu o React Three Fiber (R3F) i Three.js. Wdrożono w nim restrykcyjne zasady demand-renderingu (renderowanie tylko przy oznaczonym stanie *dirty*), rozdzielenie aktualizacji topologii od buforów polowych, śledzenie zasobów w dedykowanym rejestrze (`tracker`), kolejkowanie asynchronicznego przesyłu buforów na GPU z budżetem klatki (3 ms) oraz odciążanie obliczeń do Web Workerów.

Mimo wysokiej klasy inżynieryjnej, audyt ujawnił **szereg krytycznych wąskich gardeł wydajnościowych, błędów kinematyki kamery, luk w obsłudze pamięci WebGL oraz ogromny dług technologiczny**:

1. **Wektory/Strzałki (Krytyczne wąskie gardło CPU):** Web Worker odciąża obliczenia jedynie częściowo – finalne wyliczanie kwaternionów i macierzy 4x4 (`Matrix4.compose`) dla tysięcy strzałek odbywa się **w głównym wątku JavaScript** w partich po 256 elementów. Przy gęstych polach generuje to nawet 100 000 operacji macierzowych w JS na klatkę.
2. **Kamera i Nawigacja (Błąd obcinania widoku i osobliwość biegunowa):**
   - **Near-Plane Slicing:** Płaszczyzna obcinania `camera.near` jest ustawiana sztywno na podstawie skali obiektu (`fit.near = distance / 100`). Przy zbliżaniu kamery (zoom-in) w celu inspekcji drobnych struktur, obiekty są odcinane przez przednią płaszczyznę i znikają.
   - **Brak `minDistance` w OrbitControls:** Użytkownik może wjechać kamerą w sam środek celu (`radius = 0`), co powoduje zablokowanie rotacji i niemożność oddalenia widoku.
   - **Gimbal lock w osi Z-up:** Kamera patrząca pionowo w dół ($+Z$) lub w górę ($-Z$) pokrywa się z wektorem `up = (0,0,1)`, co w funkcji `lookAt` generuje skok yaw o 180° i drgania widoku.
3. **Shadery powierzchniowe (Brak oświetlenia i rekompilacje):**
   - Custom shadery powierzchniowe (`SCALAR_SURFACE_FRAGMENT_SHADER` i `ORIENTATION_SURFACE_FRAGMENT_SHADER`) są całkowicie **nieoświetlone** (unlit). Bryły 3D wyglądają jak płaskie plamy bez poczucia głębi i krzywizny.
   - Dynamiczna zmiana trybu barwienia (np. ze skalarnego na orientacyjny) podmienia kod źródłowy shaderów w locie z flagą `needsUpdate = true`, co wymusza synchroniczną rekompilację WebGLProgram na GPU.
4. **Airbox (Naruszenie specyfikacji separacji wireframe):**
   - W pewnych ścieżkach awaryjnych przezroczystość wireframe objętości airboxa jest powiązana z przezroczystością jego powierzchni, wbrew specyfikacji `frontend.md:149`.
5. **Dług Technologiczny (Skrajnie monolityczna struktura):**
   - Pojedynczy plik hooka [`useViewport3DSceneModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts) liczy **6 576 linii kodu (237 KB)**.
   - [`Viewport3DModule.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx) liczy **3 360 linii**.
   - Skrajna centralizacja stanu utrudnia utrzymanie, testowanie jednostkowe i zwiększa ryzyko regresji.

---

## 3. Szczegółowe Wyniki Audytu wg Obszarów

---

### 3.1. Kamera, Ruch, Translacja, Scroll i Orbitowanie

#### [BŁĄD KRYTYCZNY] 1. Near-Plane Slicing — Znikanie obiektów przy zoomowaniu
- **Lokalizacja:** 
  - [`layers/CameraControls.tsx#L361-L365`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx#L361-L365)
  - [`layers/Viewport3DScene.tsx#L373-L393`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx#L373-L393)
- **Mechanizm błędu:**
  W funkcji `resolveViewport3DCameraFit`:
  ```typescript
  const distance = radius * 2.8;
  const near = Math.max(distance / 100, 1e-12);
  const far = Math.max(distance * 100, near * 100, 1e-3);
  ```
  Następnie w `resolveViewport3DProjectionCameraClip`:
  ```typescript
  export function resolveViewport3DProjectionCameraClip(
    bounds: Viewport3DBounds | null,
    cameraState?: Viewport3DCameraState,
  ): Viewport3DCameraClip {
    const fit = resolveViewport3DCameraFit(bounds);
    ...
    return {
      near: fit.near, // <-- ZAWSZE STAŁA WARTOŚĆ Z FIT!
      far: Math.max(fit.far, orbitFar, fit.near * 100, 1e-3),
    };
  }
  ```
  `near` jest przypisywane na stałe jako `fit.near`. Kiedy użytkownik kręci kółkiem myszy (dolly zoom-in) lub zbliża widok gestem pinch, aby obejrzeć detal siatki, ścianę domenową lub wir magnetyczny, odległość kamery od powierzchni obiektu maleje. Kiedy odległość ta spadnie poniżej początkowego `fit.near`, geometria zostaje ucięta przez przednią płaszczyznę kamery (near clipping plane) — model wygląda jak pocięty nożem lub całkowicie znika z ekranu.
- **Rozwiązanie:**
  Wartość `near` musi być adaptacyjna i zależna od aktualnej odległości `distance` między pozycją kamery a celem:
  ```typescript
  const near = Math.max(Math.min(fit.near, distance * 0.01), 1e-12);
  ```

---

#### [BŁĄD PROGRAMISTYCZNY] 2. Brak `minDistance` i `maxDistance` w OrbitControls — Zapadnięcie kamery w cel
- **Lokalizacja:** [`layers/CameraControls.tsx#L1250-L1268`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx#L1250-L1268)
- **Mechanizm błędu:**
  Do komponentu `<DreiOrbitControls />` nie są przekazywane propsy `minDistance` ani `maxDistance`:
  ```tsx
  <DreiOrbitControls
    ref={controlsRef}
    makeDefault
    enabled={!props.interactionBlocked}
    domElement={domElement}
    dampingFactor={options.dampingFactor}
    enableDamping={options.enableDamping}
    enablePan={options.enablePan}
    enableRotate={options.enableRotate}
    enableZoom={options.enableZoom}
    panSpeed={options.panSpeed}
    rotateSpeed={options.rotateSpeed}
    screenSpacePanning
    zoomSpeed={options.zoomSpeed}
    onChange={recordOrbitControlFrame}
    onEnd={handleEnd}
    onStart={handleTransitionStart}
  />
  ```
  Jeśli użytkownik energicznie przybliży widok scrollem, odległość kamery od `target` może osiągnąć dokładnie `0` (wektor `camera.position - target` ma długość 0). 
  W układzie współrzędnych sferycznych OrbitControls promień $r=0$ tworzy osobliwość matematyczną. Kamera traci możliwość obrotu (kąty $\theta$ i $\phi$ nie mają ramienia obrotu), a próba oddalenia scrollem często zawodzi, ponieważ mnożenie wektora zerowego przez współczynnik skali daje nadal wektor zerowy. Użytkownik zostaje zablokowany i musi zresetować widok przyciskiem Reset Camera.
- **Rozwiązanie:**
  Należy wyznaczyć bezpieczne limity oparte o promień obwiedni (`bounds.radius`):
  ```typescript
  minDistance={Math.max(bounds?.radius ? bounds.radius * 0.05 : 1e-6, 1e-11)}
  maxDistance={Math.max(bounds?.radius ? bounds.radius * 50 : 100, 1e-2)}
  ```

---

#### [BŁĄD KINEMATYKI] 3. Osobliwość biegunowa i niekontrolowany obrót (Gimbal Lock) w osi Z-Up
- **Lokalizacja:** 
  - [`layers/CameraControls.tsx#L104`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx#L104)
  - [`layers/CameraControls.tsx#L1250-L1268`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx#L1250-L1268)
- **Mechanizm błędu:**
  Układ współrzędnych Fullmag używa pionowej osi Z:
  `export const VIEWPORT_3D_WORLD_UP: [number, number, number] = [0, 0, 1];`
  W Three.js `OrbitControls` domyślnie przyjmuje zakres kąta polarnego `minPolarAngle = 0`, `maxPolarAngle = Math.PI`.
  Gdy użytkownik orbituje kamerą bezpośrednio nad obiekt (zenit, oś $+Z$) lub pod obiekt (nadir, oś $-Z$), wektor patrzenia kamery staje się równoległy (kolinearny) do wektora `camera.up = (0, 0, 1)`.
  Wewnętrzna funkcja `camera.lookAt()` oblicza iloczyn wektorowy wektora kierunku i wektora `up`. Przy kolinearności długość iloczynu wektorowego wynosi 0:
  `crossVectors(up, forward) -> (0, 0, 0)`.
  Skutkuje to gwałtownym przeskokiem kąta azymutalnego o 180° (yaw snapping) lub chwilowym zniekształceniem macierzy widoku.
- **Rozwiązanie:**
  Wzorując się na profesjonalnych programach CAD/CAE (Blender, COMSOL, ParaView), należy ograniczyć kąt polarny o bezpieczną deltę $\varepsilon = 10^{-3}$ radiana:
  ```typescript
  minPolarAngle={0.001}
  maxPolarAngle={Math.PI - 0.001}
  ```

---

#### [BŁĄD SKALI] 4. Sztywna odległość 2 m w `OrientationHudLayer` w fizyce mikromagnetycznej
- **Lokalizacja:** 
  - [`orientation/orientationHudConstants.ts#L1`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/orientation/orientationHudConstants.ts#L1)
  - [`orientation/OrientationHudLayer.tsx#L425`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/orientation/OrientationHudLayer.tsx#L425)
- **Mechanizm błędu:**
  W stałych zdefiniowano:
  `export const WIDGET_CAMERA_DISTANCE = 2;` (2 metry).
  Następnie w `updateScreenAnchor`:
  ```typescript
  const distance = Math.min(far * 0.90, Math.max(WIDGET_CAMERA_DISTANCE, near * 10));
  ```
  W symulacjach mikromagnetycznych (FDM/FEM) domeny nanometrowe mają rozmiary rzędu $10^{-9}$ m do $10^{-6}$ m. Wartość `far` może wynosić np. $10^{-5}$ m.
  Wyrażenie `Math.max(2, near * 10)` zwraca `2`, po czym `Math.min(far * 0.90, 2)` obcina odległość do `far * 0.90`. Stała `2` (metry) jest w tym kontekście reliktem makroskopowym i może powodować niestabilne pozycjonowanie widgetu ViewCube oraz sfery HSL, gdy `far` jest małe.
- **Rozwiązanie:**
  Odległość widgetu HUD powinna być relatywna do `near` i `far` kamery (np. `distance = near + (far - near) * 0.85`), bez wprowadzania bezwzględnych stałych w metrach.

---

### 3.2. Wizualizacja Wektorów i Strzałek (Airbox i Ferromagnetyki)

#### [WĄSKIE GARDŁO WYDAJNOŚCIOWE] 5. Przeniesienie ciężkich obliczeń macierzy na główny wątek UI
- **Lokalizacja:** 
  - [`layers/vectorGlyphGeometry.ts#L56-L124`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/vectorGlyphGeometry.ts#L56-L124)
  - [`layers/VectorFieldLayer.tsx#L983-L1028`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx#L983-L1028)
- **Mechanizm problemu:**
  Architektura zakładała odciążenie obliczeń za pomocą Web Workera (`vectorGlyphBuildWorker.ts`). Jednak worker wylicza jedynie proste tablice pomocnicze (`directions`, `headCenters`, `headScales`, `shaftCenters`, `shaftScales`) i przesyła je do głównego wątku.
  W głównym wątku JavaScript, w pliku [`VectorFieldLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx#L990-L1024), podczas wysyłki buforów GPU (`uploadManager`), dla każdego pojedynczego wektora wykonywana jest pętla CPU:
  ```typescript
  for (let index = batch.start; index < batch.end; index += 1) {
    ...
    quaternion.setFromUnitVectors(UNIT_Y, direction); // Iloczyny skalarne, wektorowe, normalizacja
    matrix.compose(position, quaternion, scale);      // Tworzenie macierzy 4x4 dla trzonu
    activeShaft.setMatrixAt(index, matrix);

    matrix.compose(position, quaternion, scale);      // Tworzenie macierzy 4x4 dla grotu
    activeHead.setMatrixAt(index, matrix);
  }
  ```
  Dla siatki z 30 000 strzałek oznacza to **60 000 obliczeń kwaternionów i konstrukcji macierzy 4x4 w JS w głównym wątku**.
  Nawet przy podziale na batche po 256 elementów i budżecie 3 ms na klatkę, wysłanie strzałek trwa od kilkunastu do kilkudziesięciu klatek, powodując zauważalne spadki FPS i opóźnienia w reakcji interfejsu (input lag).
- **Rozwiązanie:**
  1. **Opcja A (Zalecana - GPU Vertex Shader):** Zrezygnować z przesyłania macierzy 4x4. Zaimplementować custom shader instancjonowania (`ShaderMaterial` lub `onBeforeCompile`), w którym pojedynczy wierzchołek strzałki pobiera tylko wektor początku `vec3 origin` i wektor pola `vec3 vector` (łącznie tylko 6 floatów zamiast 32 floatów macierzy na instancję!). Orientacja i skala są obliczane bezpośrednio na GPU w vertex shaderze.
  2. **Opcja B (Optymalizacja Workera):** Przenieść wyliczanie gotowych buforów `Float32Array` (16 floatów macierzy na instancję) w całości do Web Workera i przesyłać je przez zero-copy `Transferable ArrayBuffer`. Wtedy główny wątek wykonuje wyłącznie natywne `gl.bufferSubData` / `attribute.set(transferredArray)`.

---

#### [NIEOPTYMALNOŚĆ RENDEROWANIA] 6. Dwa oddzielne wywołania rysowania (Draw Calls) na każde pole wektorowe
- **Lokalizacja:** [`layers/VectorFieldLayer.tsx#L1290-L1305`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx#L1290-L1305)
- **Mechanizm problemu:**
  Każde pole wektorowe (dla każdego obiektu, warstwy FDM oraz airboxa) renderuje dwa niezależne obiekty `InstancedMesh`:
  ```tsx
  <instancedMesh
    args={[shaftGeometry, material, capacity]}
    frustumCulled={false}
    key={`vector-shaft-${capacity}`}
    ref={shaftRef}
  />
  <instancedMesh
    args={[headGeometry, material, capacity]}
    frustumCulled={false}
    key={`vector-head-${capacity}`}
    ref={headRef}
  />
  ```
  - Podwaja to liczbę wywołań rysowania (draw calls) dla glifów.
  - Wymusza zarządzanie dwoma zestawami buforów macierzy instancji.
  - Dodatkowo flaga `frustumCulled={false}` powoduje, że GPU przetwarza wszystkie instancje nawet wtedy, gdy znajdują się one całkowicie za plecami kamery.
- **Rozwiązanie:**
  Połączyć geometrię trzonu (cylinder) i grotu (stożek) w jedną statyczną `BufferGeometry` (poprzez `mergeGeometries` z `three/examples/jsm/utils/BufferGeometryUtils.js`). Umożliwi to wyrysowanie całej strzałki w **jednym wywołaniu `InstancedMesh`**, redukując o 50% narzut CPU-GPU.

---

### 3.3. Shadery Powierzchniowe, Materiały, Oświetlenie i Przestrzenie Barwne

#### [BŁĄD KRYTYCZNY] 7. Całkowicie płaskie cieniowanie (Unlit Flat Shading) i martwy rig świateł (S-01)
- **Lokalizacja:** 
  - [`layers/Viewport3DLightingRig.tsx#L26-L34`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/Viewport3DLightingRig.tsx#L26-L34)
  - [`viewport3dScalarSurfaceShader.ts#L357-L375`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L357-L375)
  - [`layers/MeshPartLayer.tsx#L153-L184`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx#L153-L184)
- **Mechanizm problemu:**
  W `resolveViewport3DLightingRig`:
  ```typescript
  export function resolveViewport3DLightingRig(profile: Viewport3DVisualProfile): Viewport3DLightingRigModel {
    return {
      ambient: { color: 0xffffff, intensity: profile.lighting === "minimal" ? 0.6 : 0.72 },
      directional: [],     // ZAWSZE PUSTA TABLICA!
      hemisphere: null,    // ZAWSZE NULL!
    };
  }
  ```
  Jednocześnie w `viewport3dScalarSurfaceShader.ts`:
  ```glsl
  void main() {
    vScalarValue = fmScalarValue;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
  ```
  - Vertex shader nie deklaruje ani nie przekazuje atrybutu `normal` do fragment shadera.
  - Wszystkie materiały powierzchniowe to albo `MeshBasicMaterial`, albo nieoświetlony `ShaderMaterial`.
  - Rig świateł jest martwym kodem montującym jedynie `ambientLight`. W efekcie zakrzywione bryły (cylindry nano-drutów, dyski, kulki magnetyczne, elipsoidy) renderują się jako płaskie plamy barwne, uniemożliwiając ocenę krzywizny bez siatki krawędzi (wireframe).
- **Rozwiązanie:**
  Obliczać normalne wierzchołkowe w loaderach/adapterach siatek (`geometry.computeVertexNormals()`), dodać światła kierunkowe do rigu oraz wdrożyć cieniowanie hemisferyczne/diffuse we fragment shaderach zachowujące czytelność barwy naukowej:
  ```glsl
  vec3 normal = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.5, 0.8, 1.0));
  float diffuse = max(dot(normal, lightDir), 0.0) * 0.35 + 0.65;
  gl_FragColor = vec4(paletteColor(t) * diffuse, fmOpacity);
  ```

---

#### [ROZBIEŻNOŚĆ WIZUALNA] 8. Niespójność przestrzeni barwnych (Color Space Mismatch) (S-02)
- **Lokalizacja:** 
  - [`viewport3dScalarSurfaceShader.ts#L495-L518`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L495-L518)
  - [`layers/MeshPartLayer.tsx#L1023-L1030`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx#L1023-L1030)
- **Mechanizm problemu:**
  `paletteColor(t)` zwraca surowe współrzędne sRGB wpisane bezpośrednio na stałe w kodzie shadera (np. Viridis `vec3(0.267, 0.004, 0.329)`).
  Shader przypisuje je do `gl_FragColor` **bez konwersji do przestrzeni wyjściowej Three.js** (brak `#include <colorspace_fragment>`).
  W tym samym czasie ścieżka `MeshBasicMaterial` z `vertexColors={true}` używa standardowego potoku Three.js, który traktuje bufor kolorów jako sRGB i konwertuje go do `LinearSRGB` na etapie próbkowania.
  **Skutek:** To samo pole fizyczne renderowane przez shader powierzchniowy ma zupełnie inną jasność i saturację niż renderowane przez atrybuty wierzchołków (`color`), co narusza determinizm wizualny aplikacji.
- **Rozwiązanie:**
  Wprowadzić stałe barwne w przestrzeni Linear-sRGB lub wstrzyknąć Three.js color space chunk:
  ```glsl
  #include <colorspace_fragment>
  ```

---

#### [DEGRADACJA POST-PROCESSINGU] 9. Podwójna korekcja Gamma pod SSAO/Bloom (Double Gamma) (S-03)
- **Lokalizacja:** [`layers/PostProcessingLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/PostProcessingLayer.tsx)
- **Mechanizm problemu:**
  `@react-three/postprocessing` oczekuje, że scena jest renderowana w przestrzeni `LinearSRGB`, a pass wyjściowy post-processingu wykonuje końcową konwersję do formatu sRGB.
  Ponieważ `ShaderMaterial` wpisuje wartości już zakodowane jako sRGB, pass wyjściowy aplikuje krzywą gamma powtórnie (`sRGB(sRGB(x))`).
  **Skutek:** Skrajne wypłukanie kontrastu, wyblakłe cienie i prześwietlone żółcie (yellow clipping) w paletach takich jak Viridis i Magma po włączeniu efektów post-processingu.
- **Rozwiązanie:**
  Wymusić jednolite renderowanie w `LinearSRGB` we wszystkich custom shaderach, gdy pipeline post-processingu jest aktywny.

---

#### [BŁĄD INTEGRACJI] 10. Ignorowanie płaszczyzn obcinania (Clipping Planes) w ShaderMaterial (S-04)
- **Lokalizacja:** [`viewport3dScalarSurfaceShader.ts#L140-L172`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L140-L172)
- **Mechanizm problemu:**
  W `new ShaderMaterial({...})` **brakuje flagi `clipping: true`** oraz chunków GLSL:
  - `#include <clipping_planes_pars_vertex>` i `#include <clipping_planes_vertex>` w vertex shaderze.
  - `#include <clipping_planes_pars_fragment>` i `#include <clipping_planes_fragment>` w fragment shaderze.
  **Skutek:** Gdy użytkownik włącza płaszczyznę przekroju (Clip Plane) w celu inspekcji wnętrza struktury ferromagnetycznej lub domen wewnętrznych, obwiednie i siatka krawędziowa są prawidłowo odcinane, ale kolorowana powierzchnia skalarna **pozostaje nienaruszona**, wystając poza przekrój.
- **Rozwiązanie:**
  Dodać `clipping: true` do opcji `ShaderMaterial` oraz dołączyć wymagane chunki Three.js w kodzie GLSL.

---

#### [BŁĄD NUMERYCZNY] 11. Szum szachownicy przy stałym polu magnetycznym (Absolute Epsilon 1e-12) (S-05)
- **Lokalizacja:** [`viewport3dScalarSurfaceShader.ts#L515-L516`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L515-L516)
- **Mechanizm problemu:**
  ```glsl
  float span = max(fmScalarMax - fmScalarMin, 1e-12);
  float t = clamp((vScalarValue - fmScalarMin) / span, 0.0, 1.0);
  ```
  Dla jednorodnego nasycenia magnetycznego ($M_s \approx 8 \times 10^5 \text{ A/m}$), `fmScalarMax == fmScalarMin`. Wtedy `span = 1e-12`.
  W pojedynczej precyzji float32 błędy zaokrągleń wierzchołków wynoszą rzędu $\pm 0.05$.
  Wartość $\pm 0.05 / 10^{-12} \approx \pm 5 \times 10^{10}$, co po funkcji `clamp` daje losowo `0.0` lub `1.0`.
  **Skutek:** Całkowicie jednorodny stan namagnesowania renderuje się jako chaotyczna, ziarnista szachownica o maksymalnym kontraście (np. fiolet i jaskrawa żółć w Viridis).
- **Rozwiązanie:**
  Zastosować epsilon relatywny zależny od rzędu wielkości pola:
  ```glsl
  float span = fmScalarMax - fmScalarMin;
  float relEps = max(abs(fmScalarMax) * 1e-5, 1e-12);
  float t = span < relEps ? 0.5 : clamp((vScalarValue - fmScalarMin) / span, 0.0, 1.0);
  ```

---

#### [BŁĄD SPÓJNOŚCI DANYCH] 12. Sprzeczna obsługa `NaN` i kolaps zakresu pól (S-06)
- **Lokalizacja:**
  - [`viewport3dFieldMapping.ts#L847-L858`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts#L847-L858)
  - [`field-colors/viewport3dFieldColorBuildModel.ts#L298-L301`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/field-colors/viewport3dFieldColorBuildModel.ts#L298-L301)
- **Mechanizm problemu:**
  - W `viewport3dFieldMapping.ts`:
    ```typescript
    min = Math.min(min, value);
    max = Math.max(max, value);
    ```
    W JavaScript `Math.min(min, NaN)` zwraca `NaN`. Pojedyncza komórka brzegowa z `NaN` powoduje, że cały zakres pola kolapsuje do `{ min: 0, max: 0 }`.
  - W `viewport3dFieldColorBuildModel.ts`:
    ```typescript
    if (value < min) min = value;
    if (value > max) max = value;
    ```
    Operatory `<` i `>` z `NaN` dają `false`, więc `NaN` jest tam po cichu ignorowane.
  - W GLSL `clamp(NaN, ...)` jest niezdefiniowane (UB w specyfikacji GLSL ES).
- **Rozwiązanie:**
  Wprowadzić jednolitą filtrację `Number.isFinite(value)` na CPU oraz zabezpieczenie `isnan(vScalarValue)` w GLSL zwracające kolor diagnostyczny (szary).

---

#### [UTRATA PRECYZJI] 13. Degradacja Float64 do Float32 przed normalizacją (S-07)
- **Lokalizacja:** [`viewport3dFieldMapping.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts)
- **Mechanizm problemu:**
  Wartości solwera w mikromagnetyzmie operują na precyzji `Float64Array`. Przy silnym tle składowej stałej ($M_z = 8 \times 10^5 \text{ A/m}$) małe fluktuacje fal spinowych ($\Delta M \sim 0.05 \text{ A/m}$) reprezentują relatywną zmianę $6 \times 10^{-8}$.
  Przekonwertowanie tablicy bezpośrednio do `Float32Array` przed normalizacją powoduje bezpowrotną utratę fluktuacji w szumie kwantyzacji mantysy 23-bitowej.
- **Rozwiązanie:**
  Obliczać normalizację `(value - min) / span` lub odejmować tło stałe $M_0$ w Float64 na CPU przed konwersją do bufora atrybutów float32 dla GPU.

---

#### [BŁĄD WYDAJNOŚCIOWY KRYTYCZNY] 14. Rekreacja ShaderMaterial w każdej klatce animacji fazowej (S-08)
- **Lokalizacja:** [`layers/MeshPartLayer.tsx#L903-L928`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx#L903-L928)
- **Mechanizm problemu:**
  ```typescript
  const scalarShaderBuffer = committedScalarColorState.buffer;
  const scalarShaderMaterial = useMemo(() => {
    ...
    return tracker.track("material", createScalarSurfaceShaderMaterial(scalarShaderBuffer, ...));
  }, [..., scalarShaderBuffer, ...]); // <-- scalarShaderBuffer zmienia się w każdej klatce!
  ```
  Podczas animacji modów falowych Floqueta/częstotliwościowych hook animacji aktualizuje fazę `modeCompositionPhaseRad` z częstotliwością 60 FPS, generując nowy obiekt `buffer`.
  W rezultacie `useMemo` w każdej klatce niszczy dotychczasowy materiał (`tracker.release`) i tworzy nowy `createScalarSurfaceShaderMaterial`.
  Wymusza to 60 razy na sekundę wywołanie `gl.deleteProgram` i synchroniczne linkowanie nowego `WebGLProgram`, blokując główny wątek na 3–15 ms na klatkę! Istniejący `useEffect` z `updateScalarSurfaceShaderMaterial` nigdy nie ma szansy zadziałać na istniejącym materiale.
- **Rozwiązanie:**
  Usunąć `scalarShaderBuffer` z tablicy zależności `useMemo`. Tworzyć materiał wyłącznie na podstawie typu geometrii i pipeline'u, a wartości parametrów bufora (faza, amplituda, min/max) aktualizować wyłącznie przez uniformy w `updateScalarSurfaceShaderMaterial`.

---

#### [BŁĄD ARCHITEKTONICZNY] 15. Rekompilacja programów przy zmianie trybów barwienia (S-09)
- **Lokalizacja:** [`viewport3dScalarSurfaceShader.ts#L180-L197`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L180-L197)
- **Mechanizm problemu:**
  Przełączanie pomiędzy 4 wariantami (skalar/orientacja $\times$ rzeczywiste/zespolone) mutuje stringi `vertexShader` i `fragmentShader` z flagą `needsUpdate = true`. W silniku Three.js zmiana kodu źródłowego shadera wymusza synchroniczną rekompilację programu GPU na głównym wątku.
- **Rozwiązanie:**
  Zunifikować shader z gałęziami opartymi o stałe `uniform int fmColorModeId` lub prekompilować i buforować instancje materiałów w puli.

---

#### [BŁĄD JAKOŚCI WIZUALNEJ] 16. Paszkowanie (Banding) palet i obecność Jet (S-10)
- **Lokalizacja:** [`viewport3dScalarSurfaceShader.ts#L465-L512`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L465-L512)
- **Mechanizm problemu:**
  Paleta Viridis została zaimplementowana za pomocą zaledwie 4 punktów kontrolnych (`mixStops4`) z interpolacją liniową. Prowadzi to do powstawania pasów Macha i załamań gradientów barwnych.
  Dodatkowo obecna jest paleta Jet (`fmPaletteId == 3`), która jest niezgodna ze współczesnymi standardami wizualizacji naukowej (brak monotoniczności percepcyjnej luminancji).
- **Rozwiązanie:**
  Zastąpić ręczne instrukcje `mixStops` jednowymiarową teksturą LUT (1D `DataTexture` 256x1 z filtrowaniem dwuliniowym) lub aproksymacją wielomianową wysokiego rzędu (np. Turbo/Viridis polynomial GLSL).

---

#### [MARTWY KOD / NARUSZENIE KONTRAKTU] 17. Ignorowanie polityki zakresu skalarnego (S-11)
- **Lokalizacja:** 
  - [`model/viewport3DColorbarPlan.ts#L70-L93`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/model/viewport3DColorbarPlan.ts#L70-L93)
  - [`model/viewport3DFieldDataPlan.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts)
- **Mechanizm problemu:**
  Interfejs deklaruje bogate polityki `Viewport3DScalarRangePolicy` (`symmetric`, `diverging`, `log`, `manual`). Są one uwzględniane w budowaniu kluczy cache (`scalarRangePolicyKey`), ale **nigdy nie są aplikowane do parametrów `fmScalarMin` i `fmScalarMax`** wysyłanych do shadera.
  Dla palet rozbieżnych (`coolwarm`) punkt neutralny (biel) ląduje w połowie wartości `(min + max) / 2` zamiast w fizycznym zerze `0.0`.
- **Rozwiązanie:**
  Aplikować transformację polityki do `ScalarRange` przed przypisaniem wartości do uniformów shadera.

---

#### [BŁĄD FIZYCZNO-MATEMATYCZNY] 18. Norma euklidesowa z trzech kątów fazowych (S-12)
- **Lokalizacja:** [`viewport3dScalarSurfaceShader.ts#L391-L405`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L391-L405)
- **Mechanizm problemu:**
  Dla reprezentacji fazowej (`representationId == 4`), funkcja `projectComplex` zwraca wektor kątów w radianach $(\phi_x, \phi_y, \phi_z)$.
  Następnie `scalarFromVector(projected)` przy domyślnym trybie wielkości oblicza:
  ```glsl
  return length(value);
  ```
  Obliczanie długości euklidesowej $\sqrt{\phi_x^2 + \phi_y^2 + \phi_z^2}$ z trzech niezależnych kątów fazowych jest matematycznie i fizycznie pozbawione sensu.
- **Rozwiązanie:**
  Dla fazy zespolonej udostępnić wyłącznie wizualizację poszczególnych składowych lub zdefiniować koherentną fazę globalną rzutu.

---

#### [ARTEFAKTY RENDEROWANIA] 19. Moiré i błędy głębi przy przezroczystości DoubleSide (S-14)
- **Lokalizacja:** [`layers/MeshPartLayer.tsx#L912-L916`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx#L912-L916)
- **Mechanizm problemu:**
  Ustawienie `side: DoubleSide`, `transparent: true`, `depthWrite: false` bez techniki Depth Pre-Pass lub kolejkowania ścian tylnych i przednich powoduje, że fragmenty przednie i tylne siatki nakładają się w losowej kolejności w zależności od indeksów w buforze wierzchołków, wywołując migotanie i artefakty interferencyjne.
- **Rozwiązanie:**
  Wdrożyć renderowanie dwuprzebiegowe (pass 1: ściany tylne `CullFaceFront`, pass 2: ściany przednie `CullFaceBack`) lub włączyć `depthWrite: true` z renderowaniem nieprzezroczystego pre-passu głębi.

---

#### [NIEDOPASOWANIE SKALI] 20. Skala SSAO i próg Bloom niszczący wizualizację (S-15, S-16)
- **Lokalizacja:** [`layers/PostProcessingLayer.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/PostProcessingLayer.tsx)
- **Mechanizm problemu:**
  - `aoRadius = 0.5` m: W symulacjach mikromagnetycznych w skali nanometrów ($10^{-9}$ m) promień 0.5 metra wielokrotnie przekracza całą scenę, sprawiając że ambient occlusion nie wnosi żadnego cieniowania w szczelinach domenowych.
  - Próg Blooma ustawiony na `0.5`: Żółte obszary w palecie Viridis mają luminancję $> 0.8$, co powoduje ich natychmiastowe rozmycie i rozbłysk, zacierając naukowe detale fal spinowych.
- **Rozwiązanie:**
  Skalować `aoRadius` relatywnie do promienia obwiedni sceny (`bounds.radius * 0.05`), a próg Blooma podnieść powyżej `1.0` (tylko dla elementów emisyjnych/HDR).

---

#### [DŁUG I WYCIEKI PAMIĘCI] 21. Martwy kod uploadu, STATIC_DRAW i dławienie makrozadań (S-18, S-19, S-20, S-21)
- **Lokalizacja:**
  - [`viewport3dScalarSurfaceShader.ts#L55`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L55) (`applyScalarShaderColorBuffer` — martwy kod nieużywany w module).
  - [`hooks/useViewport3DScalarColorUpload.ts#L605`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts#L605) (`new BufferAttribute` z domyślnym `StaticDrawUsage` na dynamicznie animowanych danych).
  - [`layers/dimensionFrameModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/dimensionFrameModel.ts) (klonowanie `position.clone()` przy ekstrakcji krawędzi zamiast współdzielenia referencji).
  - [`viewport3dFieldMapping.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts) (użycie `setTimeout(0)` z narzuconym przez przeglądarki dławieniem 4 ms na makrozadanie, co wydłuża przetwarzanie 100 partii o 400 ms).
- **Rozwiązanie:**
  Usunąć martwe funkcje, ustawić `attribute.setUsage(DynamicDrawUsage)` dla buforów strumieniowanych oraz zastąpić `setTimeout` kooperatywnym wywłaszczaniem `scheduler.yield()` lub `MessageChannel`.

---

---

### 3.4. Wizualizacja Airboxa (Objętość, Krawędzie i Siatka)

#### [NARUSZENIE KONTRAKTU] 10. Ryzyko powiązania przezroczystości krawędzi z powierzchnią w fallbacku
- **Lokalizacja:** [`layers/BoundsLayers.tsx#L460-L492`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx#L460-L492)
- **Mechanizm problemu:**
  W instrukcji `frontend.md:149` określono twardy niezmiennik:
  > *"Airbox wireframe is not the same contract as magnetic mesh wireframe: full airbox extent must always include an interior bounds/volume overlay with hidden-edge semantics even when mesh edge geometry exists; surface extent may render only boundary surface edges; airbox surface opacity must not attenuate airbox wireframe opacity."*
  W komponencie `AirboxMeshPartLayer`, gdy brak jest załadowanej geometrii siatki (`!geometry`), renderowany jest fallback:
  ```tsx
  {renderPlan.surface.visible ? (
    <BoundsBox
      bounds={resolveMeshPartBounds(part)}
      color={shaderColorFromSettings(renderSettings, colors.accent)}
      opacity={opacity}
      wireframe={false}
    />
  ) : null}
  ```
  Jeśli użytkownik ustawi suwak przezroczystości powierzchni na 0, a nastąpi przełączenie fallbacku, stan krawędzi może ulec niepożądanej modyfikacji. Ponadto `BoundsBox` tworzy instancję `<boxGeometry args={[...]} />` bezpośrednio w JSX, co przy częstych zmianach granic (np. dynamiczna edycja wymiarów w inspektorze) wymusza niszczenie i alokowanie nowej geometrii w każdej klatce.

---

### 3.5. Wycieki Pamięci, Cykl Życia i Zasoby WebGL

#### [LUKA MONITOROWANIA] 11. Brak śledzenia zasobów tworzonych inline w JSX
- **Lokalizacja:** 
  - [`layers/BoundsLayers.tsx#L119-L132`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx#L119-L132)
  - [`layers/BoundsLayers.tsx#L150-L158`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx#L150-L158)
  - [`layers/MeshPartLayer.tsx#L1039, L1058`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx#L1039)
- **Mechanizm problemu:**
  System diagnostyczny Fullmag monitoruje liczbę aktywnych geometrii i materiałów za pomocą `tracker.track(...)`.
  Jednak elementy deklaratywne R3F takie jak `<boxGeometry>`, `<meshBasicMaterial>`, `<pointsMaterial>`, `<lineBasicMaterial>` tworzone w JSX nie przechodzą przez `tracker.track`.
  Chociaż R3F dba o ich unmount, licznik `resourceCounts.geometries` i `resourceCounts.materials` zaniża faktyczną liczbę zaalokowanych struktur w WebGL, fałszując telemetrię i testy audytu pamięci (`audit-viewport-3d-memory-churn.mjs`).
- **Rozwiązanie:**
  Wszystkie współdzielone prymitywy (jak np. jednostkowy sześcian) powinny być tworzone raz i współdzielone przez referencję z rejestracją w `tracker`, zamiast tworzenia instancji inline w szablonach JSX.

---

#### [POTENCJALNY WYCIEK GPU] 12. Nadpisywanie `BufferAttribute` bez wyczyszczenia WebGLBuffer
- **Lokalizacja:** [`viewport3dScalarSurfaceShader.ts#L285-L305`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts#L285-L305)
- **Mechanizm problemu:**
  W funkcji `setFloatAttribute`:
  ```typescript
  const existing = geometry.getAttribute(name);
  if (
    existing instanceof BufferAttribute &&
    existing.itemSize === itemSize &&
    existing.count === vertexCount &&
    existing.array instanceof Float32Array
  ) {
    (existing.array as Float32Array).set(values);
    existing.needsUpdate = true;
    return;
  }
  geometry.setAttribute(name, new BufferAttribute(values, itemSize));
  ```
  Jeśli rozmiar bufora ulegnie zmianie, wywoływane jest `geometry.setAttribute(...)`. W architekturze Three.js `WebGLAttributes` utrzymuje mapę buforów powiązaną z instancją `BufferAttribute`. Podmiana atrybutu na nową instancję bez zwolnienia starej może pozostawić osierocony bufor VRAM na GPU aż do momentu wywołania `geometry.dispose()`.

---

### 3.6. Architektura i Dług Technologiczny (Monolityczne Pliki)

#### [KRYTYCZNY DŁUG ARCHITEKTONICZNY] 13. Gigantyczne pliki o przerośniętej odpowiedzialności
- **Lokalizacja:**
  - [`hooks/useViewport3DSceneModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts) — **6 576 linii (237 KB)**
  - [`Viewport3DModule.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx) — **3 360 linii (114 KB)**
  - [`viewport3dRenderModel.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts) — **3 000+ linii (105 KB)**
  - [`layers/Viewport3DScene.tsx`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx) — **2 117 linii (71 KB)**
- **Skutki dla systemu:**
  - **Złożoność kognitywna:** Niemożliwe jest przeanalizowanie pełnego przepływu danych przez programistę bez ryzyka przeoczenia efektów ubocznych.
  - **Kaskadowe re-rendery:** Hook `useViewport3DSceneModel` subskrybuje ponad 25 różnych źródeł danych. Jakakolwiek zmiana (np. puls statusu symulacji, ruch kursora w inspektorze, zmiana kąta kamery) powoduje ponowne wykonanie tysięcy linii logiki adaptacyjnej.
  - **Utrudnione testowanie:** Pliki te są niemal niemożliwe do testowania w izolacji bez mockowania setek zależności jądra.
- **Rekomendacja refaktoryzacji:**
  Rozbić `useViewport3DSceneModel.ts` na dedykowane domeny:
  1. `useViewport3DFdmModel.ts` (obsługa domen FDM, siatek strukturalnych, podwarstw)
  2. `useViewport3DFemModel.ts` (obsługa domen FEM, siatek nieustrukturyzowanych)
  3. `useViewport3DFieldColors.ts` (zarządzanie paletami i mapowaniem pól skalarnych)
  4. `useViewport3DVectorModel.ts` (budżetowanie i agregacja pól wektorowych)
  5. `useViewport3DCameraSync.ts` (synchronizacja rejestru kamery)

---

## 4. Plan Naprawczy (Action Plan & Prioritization)

| Priorytet | Problem | Proponowane Rozwiązanie | Szacowany Nakład |
|---|---|---|---|
| **P0 (Krytyczny)** | Rekreacja `ShaderMaterial` przy animacji 60 FPS (S-08) | Usunięcie `scalarShaderBuffer` z zależności `useMemo` w `MeshPartLayer.tsx`; aktualizacja wyłącznie przez uniformy w `useEffect` | Bardzo niski (0.5 dnia) |
| **P0 (Krytyczny)** | Znikanie geometrii przy zoomie (Near-plane clipping) | Dynamiczne wyliczanie `near` na podstawie odległości `distance` w `resolveViewport3DProjectionCameraClip` | Niski (1 dzień) |
| **P0 (Krytyczny)** | Szum szachownicy na jednorodnym namagnesowaniu (S-05) | Zmiana bezwzględnego `1e-12` na relatywny epsilon `max(abs(max)*1e-5, 1e-12)` i domyślny kolor środkowy | Bardzo niski (0.5 dnia) |
| **P0 (Krytyczny)** | Zapadnięcie kamery w cel (DreiOrbitControls lock) | Wprowadzenie `minDistance` i `maxDistance` zależnych od `bounds.radius` | Bardzo niski (0.5 dnia) |
| **P0 (Krytyczny)** | Wąskie gardło macierzy strzałek w wątku UI | Przeniesienie `Matrix4.compose` do Workera lub implementacja GPU vertex shader instancing | Średni (3 dni) |
| **P1 (Wysoki)** | Ignorowanie płaszczyzn przekroju (Clip Planes) w shaderze (S-04) | Włączenie `clipping: true` i wstrzyknięcie chunków `#include <clipping_planes_*>` do shaderów powierzchniowych | Niski (0.5 dnia) |
| **P1 (Wysoki)** | Płaskie, nieoświetlone shadery powierzchniowe (S-01) | Dodanie cieniowania wektora normalnego (diffuse lighting) do fragment shadera i aktywacja świateł w rigu | Niski (1 dzień) |
| **P1 (Wysoki)** | Niespójność przestrzeni barwnych i podwójna gamma (S-02, S-03) | Standaryzacja na `LinearSRGB` we wszystkich shaderach i wstrzyknięcie `#include <colorspace_fragment>` | Niski (1 dzień) |
| **P1 (Wysoki)** | Osobliwość biegunowa w osi Z (Gimbal lock) | Clamping kąta polarnego `minPolarAngle={0.001}`, `maxPolarAngle={Math.PI - 0.001}` | Bardzo niski (0.5 dnia) |
| **P1 (Wysoki)** | 2 wywołania rysowania na pole wektorowe | Scalenie geometrii stożka i walca w jedną `BufferGeometry` | Średni (2 dni) |
| **P2 (Średni)** | Paszkowanie palet (Banding) i obecność Jet (S-10) | Zastąpienie `mixStops` 1D teksturą LUT (256x1 `DataTexture`) lub wielomianem GLSL | Średni (1.5 dnia) |
| **P2 (Średni)** | Rekompilacja shaderów przy zmianie trybu barwienia (S-09) | Zunifikowanie fragment shadera z przełączaniem przez `uniform int` | Średni (2 dni) |
| **P2 (Średni)** | Sprzeczne traktowanie `NaN` w CPU i GPU (S-06) | Ujednolicony filtr `Number.isFinite` w mapperach oraz diagnostyczny kolor `isnan()` w GLSL | Niski (0.5 dnia) |
| **P2 (Średni)** | Błędna metryka kątów w trybie zespolonym (S-12) | Usunięcie `length()` na 3 kątach fazowych; wybór składowej lub rzut koherentny | Niski (0.5 dnia) |
| **P2 (Średni)** | Skala SSAO i próg Blooma (S-15, S-16) | Adaptacja `aoRadius` do nanometrowej skali sceny i podniesienie progu Blooma $> 1.0$ | Niski (0.5 dnia) |
| **P3 (Architektura)**| Monolit `useViewport3DSceneModel.ts` (6.5k linii) | Podział na sub-hooki domenowe (FDM, FEM, Fields, Camera) | Znaczny (1 tydzień) |

---

## 5. Zredagowany i Ulepszony Prompt Użytkownika

Poniżej znajduje się profesjonalna, precyzyjna i ustrukturyzowana wersja promptu wyjściowego, gotowa do wykorzystania w zaawansowanych audytach technicznych:

```markdown
Wykonaj kompleksowy, profesjonalny audyt techniczny modułu 3D Viewport we frontendzie Control Room (apps/control-room/src/modules/viewport-3d), odpowiedzialnego za wizualizację domen ferromagnetycznych (FDM/FEM) oraz airboxa.

Skup się na następujących filarach inżynieryjnych:
1. Wizualizacja ferromagnetyków i shadery:
   - Poprawność implementacji GLSL w customowych shaderach powierzchniowych (viewport3dScalarSurfaceShader.ts), obsługa skalarów, orientacji i pól zespolonych.
   - Analiza cieniowania, wektorów normalnych, oświetlenia oraz zachowania przy wartościach brzegowych (NaN, Infinity).
   - Koszt przełączania trybów barwienia (rekompilacja programów WebGL vs aktualizacja uniformów).

2. Strzałki i wektory (w powłokach ferromagnetyków i objętości airboxa):
   - Wydajność potoku generowania glifów (podział pracy między Web Worker a główny wątek UI).
   - Efektywność instancjonowania (InstancedMesh, bufory macierzy, narzut pamięciowy i liczba draw calls).
   - Skalowanie i budżetowanie glifów zgodnie z niezmiennikami projektowymi (niezależność rozmiaru od ruchu kamery).

3. Wizualizacja Airboxa:
   - Rozdzielenie geometrii powierzchniowej od objętościowej obwiedni siatki krawędziowej (hidden-edge semantics).
   - Poprawność zachowania przezroczystości (niezależność opacity krawędzi od powierzchni).

4. Kinematyka i kontrola kamery:
   - Stabilność orbitowania, translacji (pan) i zoomowania (scroll / pinch) w DreiOrbitControls.
   - Płaszczyzny obcinania (near/far clipping planes) pod kątem z-fightingu i obcinania widoku przy zbliżeniach (near-plane slicing).
   - Osobliwości geometryczne (gimbal lock przy orientacji Z-up) oraz zabezpieczenia przed kolapsem odległości (minDistance/maxDistance).
   - Integracja widgetu orientacji (OrientationHudLayer, ViewCube).

5. Zarządzanie pamięcią, cykl życia zasobów i dług technologiczny:
   - Wykrywanie wycieków pamięci GPU/CPU (zwalnianie geometrii, materiałów, tekstur, buforów atrybutów oraz wątków workerów).
   - Przestrzeganie zasad demand-renderingu (brak niepotrzebnych klatek w stanie spoczynku).
   - Identyfikacja długu technologicznego, anty-wzorców i przerośniętych modułów monolitycznych.

Przygotuj szczegółowy raport w formacie Markdown z podaniem dokładnych ścieżek do plików, numerów linii, wyjaśnieniem przyczyn źródłowych (root causes) oraz konkretnymi, kodowymi propozycjami naprawy.
```
