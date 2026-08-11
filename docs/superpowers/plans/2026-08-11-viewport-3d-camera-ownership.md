# Jednolita własność kamery viewportu 3D — plan implementacji

> **Dla agentów wykonawczych:** WYMAGANA PODUMIEJĘTNOŚĆ: użyj `subagent-driven-development` (zalecane) albo `executing-plans`, realizując plan zadanie po zadaniu. Kroki są śledzone składnią checkbox (`- [ ]`).

**Cel:** wyeliminować cofanie, samoczynne odświeżanie i klatkowanie kamery przez wprowadzenie jednego epokowego lifecycle’u dla orbit, pan, zoom, auto-fit, HUD i zmiany projekcji.

**Architektura:** żywa kamera Three.js wraz z Drei `OrbitControls` jest jedynym właścicielem pozycji podczas gestu, a `CameraRegistryController` jedynym właścicielem zatwierdzonego snapshotu. Monotoniczna epoka unieważnia spóźnione callbacki, remote state aktualizuje shadow bez snap-back, a `viewport3dStore` przestaje być równoległym wejściem sterującym żywą kamerą.

**Stos:** React 19, TypeScript, React Three Fiber, Drei `OrbitControls`, Three.js, Zustand-like external store, Vitest, Playwright/Chromium, resource-first API v2.

## Ograniczenia globalne

- Zachować `frameloop="demand"`, pełną jakość wizualizacji i zero renderowania w idle.
- Nie dodawać nowego globalnego store’a ani nowej ścieżki API.
- Gesty kamery nie mogą uruchamiać requestów `data`, `model`, `meshing` ani `visualization`.
- Wszystkie nowe klasy CSS, jeśli powstaną, muszą mieć prefix `fm-`; ten plan nie przewiduje zmian CSS.
- Każda zmiana viewportu wymaga browser smoke sprawdzającego widoczny canvas, zdrowy WebGL i niezerowy drawing buffer.
- Nie dotykać niezwiązanych zmian obecnych w brudnym checkoutcie.

## Struktura plików

- Utworzyć `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraState.ts`: snapshot żywej kamery, skalowe tolerancje i porównanie.
- Rozbudować `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.ts`: monotoniczna epoka, source, changed/settling/idle, cleanup i field hold.
- Zmodyfikować `apps/control-room/src/kernel/visualization/CameraRegistryController.ts`: epokowe begin/commit/end, shadow bez snap-back i jawna adopcja remote.
- Zmodyfikować `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`: jeden lifecycle Drei, registry callbacks, auto/user ownership, atomiczny commit oraz brak własnego wheel.
- Zmodyfikować `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx` i `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`: poprowadzenie callbacków lifecycle i usunięcie podwójnych zapisów.
- Zmodyfikować `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`: usunięcie bezwarunkowego registry → store mirror.
- Utworzyć `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.ts`: audit-only bounded ring buffer bez kosztu w trybie wyłączonym.
- Rozbudować `apps/control-room/scripts/smoke-viewport-3d.mjs`: trajektoria orbit/pan/wheel/projection, remote/bounds race, idle i WebGL.

---

### Zadanie 1: Skalowo spójny snapshot kamery

**Pliki:**
- Utworzyć: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraState.ts`
- Utworzyć: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraState.test.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`

**Interfejsy:**
- Produkuje: `Viewport3DLiveCameraSnapshot`, `viewport3DCameraSnapshotsEqual(a, b, scale)`, `readViewport3DLiveCameraSnapshot(camera, target, projection, orthographicScale)`.
- Konsumuje: typy `Viewport3DCameraProjection` i tuple `[number, number, number]` używane przez viewport.

- [ ] **Krok 1: napisać testy, które obalają absolutne `1e-7`**

```ts
it("detects a meaningful 20 nm move in a 200 nm scene", () => {
  expect(viewport3DCameraSnapshotsEqual(base, movedBy(20e-9), 200e-9)).toBe(false);
});

it("ignores numerical jitter relative to a metre-scale view", () => {
  expect(viewport3DCameraSnapshotsEqual(baseMetres, movedBy(1e-12), 1)).toBe(true);
});

it("compares orthographic scale relatively and up direction angularly", () => {
  expect(viewport3DCameraSnapshotsEqual(baseOrtho, orthoJitter, 1e-6)).toBe(true);
});
```

- [ ] **Krok 2: uruchomić test i potwierdzić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/viewport3DCameraState.test.ts`  
Oczekiwane: FAIL, ponieważ moduł i eksporty jeszcze nie istnieją.

- [ ] **Krok 3: zaimplementować wspólny model**

```ts
export interface Viewport3DLiveCameraSnapshot {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  up: readonly [number, number, number];
  projection: Viewport3DCameraProjection;
  orthographicScale: number | null;
}

export function resolveViewport3DCameraLinearTolerance(sceneScale: number): number {
  return Math.max(Math.abs(sceneScale) * 1e-8, 1e-15);
}
```

Porównanie position/target używa tej tolerancji, up tolerancji kątowej `1e-8`, a orthographic scale `max(abs(scale) * 1e-8, 1e-15)`.

- [ ] **Krok 4: zastąpić lokalne porównania pose w `CameraControls.tsx` wspólną funkcją**

Usunąć `CAMERA_STATE_EPSILON` i nie pozostawić alternatywnego absolutnego progu dla position/target.

- [ ] **Krok 5: uruchomić testy i potwierdzić GREEN**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/viewport3DCameraState.test.ts src/modules/viewport-3d/layers/CameraControls.test.ts`  
Oczekiwane: oba pliki PASS.

- [ ] **Krok 6: commit**

```bash
git add apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraState.ts apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraState.test.ts apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts
git commit -m "fix: scale viewport camera comparisons"
```

### Zadanie 2: Epokowy lifecycle gestu i field hold

**Pliki:**
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.test.ts`

**Interfejsy:**
- Produkuje: `Viewport3DCameraGestureSource`, `beginViewport3DCameraGesture(ref, source): number`, `markViewport3DCameraGestureChanged(ref, epoch)`, `settleViewport3DCameraGesture(ref, epoch): boolean`, `cancelViewport3DCameraGesture(ref)`, `disposeViewport3DCameraGesture(ref)`.
- Zachowuje: `viewport3DCameraGestureActive(ref)` dla guardów R3F.

- [ ] **Krok 1: dodać testy latest-wins i cleanup**

```ts
const first = beginViewport3DCameraGesture(ref, "orbit");
const second = beginViewport3DCameraGesture(ref, "wheel");
expect(settleViewport3DCameraGesture(ref, first)).toBe(false);
expect(viewport3DCameraGestureActive(ref)).toBe(true);
expect(settleViewport3DCameraGesture(ref, second)).toBe(true);
expect(viewport3DFieldUpdateHoldActive()).toBe(false);
```

Dodać osobne przypadki: brak ruchu, wielokrotne settle, cancel, dispose i starszy callback, który nie zwalnia hold nowszej epoki.

- [ ] **Krok 2: uruchomić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/viewport3DCameraGesture.test.ts`  
Oczekiwane: FAIL na brakujących API i starej semantyce timeoutu.

- [ ] **Krok 3: zaimplementować maszynę stanu bez release timeout jako źródła prawdy**

```ts
interface Viewport3DCameraGestureState {
  epoch: number;
  active: boolean;
  changed: boolean;
  source: Viewport3DCameraGestureSource | null;
  fieldHoldActive: boolean;
  disposed: boolean;
}
```

`begin` zwiększa epokę i aktywuje hold; `settle` działa tylko dla aktualnej epoki, ustawia inactive i natychmiast równoważy hold; `dispose` jest idempotentne. Nie pozostawiać stałego 150 ms ustawiającego `active=false` przed końcem ruchu.

- [ ] **Krok 4: uruchomić GREEN**

Uruchomić ten sam test. Oczekiwane: PASS i brak pending timers.

- [ ] **Krok 5: commit**

```bash
git add apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.ts apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraGesture.test.ts
git commit -m "fix: make camera gestures epoch based"
```

### Zadanie 3: Registry bez snap-back i ze sprawdzaniem epoki

**Pliki:**
- Zmodyfikować: `apps/control-room/src/kernel/visualization/CameraRegistryController.ts`
- Zmodyfikować: `apps/control-room/src/kernel/visualization/CameraRegistryController.test.ts`

**Interfejsy:**
- Produkuje: `beginInteraction(epoch: number): void`, `patchCamera(patch, epoch?: number): boolean`, `endInteraction(epoch: number): void`, `cancelInteraction(epoch: number): void`.
- Reguła: remote zawsze aktualizuje `persistedShadow`; adopcja `camera` zachodzi tylko bez aktywnej/nowszej lokalnej epoki i bez dirty.

- [ ] **Krok 1: dodać test sekwencji A/B/C/D z audytu**

```ts
controller.observeRemoteState(visualizationState(1, cameraA));
controller.beginInteraction(7);
controller.observeRemoteState(visualizationState(2, staleRemoteA));
expect(controller.patchCamera(cameraD, 6)).toBe(false);
expect(controller.patchCamera(cameraD, 7)).toBe(true);
controller.observeRemoteState(visualizationState(3, staleRemoteA));
controller.endInteraction(7);
expect(controller.getSnapshot().camera).toEqual(cameraD);
expect(controller.getSnapshot().persistedShadow).toEqual(staleRemoteA);
```

Dodać przypadki: `endInteraction` bez patcha nie adoptuje shadow; `endInteraction` starej epoki nie kończy nowej; initial hydration bez interakcji nadal adoptuje remote.

- [ ] **Krok 2: uruchomić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/visualization/CameraRegistryController.test.ts`  
Oczekiwane: FAIL, ponieważ obecne `endInteraction()` wykonuje snap-back i nie zna epoki.

- [ ] **Krok 3: wdrożyć aktywną epokę registry**

```ts
private activeInteractionEpoch: number | null = null;

patchCamera(patch: CameraPatch, epoch?: number): boolean {
  if (epoch !== undefined && epoch !== this.activeInteractionEpoch) return false;
  // istniejąca normalizacja i dirty update
  return changed;
}
```

Usunąć blok kopiujący `persistedShadow` do `camera` z `endInteraction`. `flushDue` pozostaje blokowany do końca aktualnej interakcji.

- [ ] **Krok 4: uruchomić pełny test registry GREEN**

Uruchomić ten sam test. Oczekiwane: wszystkie przypadki PASS.

- [ ] **Krok 5: commit**

```bash
git add apps/control-room/src/kernel/visualization/CameraRegistryController.ts apps/control-room/src/kernel/visualization/CameraRegistryController.test.ts
git commit -m "fix: prevent stale camera registry commits"
```

### Zadanie 4: Jeden lifecycle Drei dla orbit, pan i wheel

**Pliki:**
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`

**Interfejsy:**
- `OrbitCameraControlsProps` konsumuje `onCameraInteractionStart(epoch)`, `onCameraInteractionCommit(change, epoch)`, `onCameraInteractionEnd(epoch)`.
- `onStart`, `onChange`, `onEnd` Drei są jedynym źródłem lifecycle’u pointer i wheel.

- [ ] **Krok 1: zmienić testy kontraktu źródłowego na oczekiwany jeden owner**

Test musi wymagać:

```ts
expect(source).not.toContain("useSmoothViewport3DWheelZoom");
expect(source).not.toContain('addEventListener("wheel"');
expect(orbitControlsBlock).toContain("onStart={handleTransitionStart}");
expect(orbitControlsBlock).toContain("onChange={recordOrbitControlFrame}");
expect(orbitControlsBlock).toContain("onEnd={handleEnd}");
```

Test sceny wymaga przekazania callbacków registry również do `OrbitCameraControls`, nie tylko `OrientationHudLayer`.

- [ ] **Krok 2: uruchomić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/CameraControls.test.ts src/modules/viewport-3d/layers/Viewport3DScene.test.ts`  
Oczekiwane: FAIL na custom wheel i brakujących callbackach.

- [ ] **Krok 3: usunąć własny wheel i canvas-level lifecycle**

Usunąć `useSmoothViewport3DWheelZoom`, oba listenery wheel, pointer capture listener służący do przedwczesnego kończenia gestu, `wheelZoom*Ref` i 150 ms release. Pozostawić `enableDamping`, `zoomSpeed`, `onStart`, `onChange`, `onEnd` Drei.

- [ ] **Krok 4: wprowadzić settle z aktualną epoką**

`handleTransitionStart` rozpoczyna epokę i woła registry start. `onEnd` oznacza wejście w fazę settle. Każde późniejsze `onChange` restartuje bounded quiet timer przypisany do tej samej epoki. Callback timera atomowo odczytuje position/target/up/projection/ortho scale, wykonuje jeden commit i dopiero wtedy kończy registry/hold. Każdy callback sprawdza epokę przed działaniem.

- [ ] **Krok 5: uruchomić GREEN**

Uruchomić testy z kroku 2 oraz `viewport3DCameraGesture.test.ts`. Oczekiwane: PASS.

- [ ] **Krok 6: commit**

```bash
git add apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts
git commit -m "fix: unify orbit controls camera lifecycle"
```

### Zadanie 5: Atomiczny registry-only commit i kontrolowany auto-fit

**Pliki:**
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts`

**Interfejsy:**
- `saveCameraState(camera, epoch)` wykonuje wyłącznie `cameraRegistry.patchCamera(buildViewport3DCameraRegistryPatch(camera), epoch)`.
- Auto-fit ma runtime ref `"auto" | "user"`; pierwszy gest użytkownika ustawia `user`, Reset ustawia `auto`, Fit pozostawia `user`.

- [ ] **Krok 1: dodać testy podwójnego zapisu i auto-fit race**

Wymagać braku `viewport3dStore.setCamera`/`setCameraView` w `saveCameraState`, braku bezwarunkowego `useViewport3DCameraRegistryStoreSync`, oraz braku fit przy bounds update podczas aktywnej epoki i po przejściu do `user`.

- [ ] **Krok 2: uruchomić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/Viewport3DModule.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/layers/CameraControls.test.ts`  
Oczekiwane: FAIL na obecnym dual write i auto-fit.

- [ ] **Krok 3: usunąć store jako ownera pose**

`saveCameraState` patchuje wyłącznie registry. Usunąć `useViewport3DCameraRegistryStoreSync(cameraResource)` albo ograniczyć go do jawnej pierwszej hydracji bez aktywnej epoki; normalna rewizja zasobu nie może wywoływać `setCameraView`. Renderer czyta zatwierdzony snapshot registry, nie konkurencyjny pose store.

- [ ] **Krok 4: wdrożyć auto/user ownership**

Pierwsza hydracja i pierwsze kompletne bounds mogą fitować tylko w `auto`. Orbit/pan/wheel/HUD przełącza na `user`. Bounds w `user` nie ustawia position, store ani registry. Fit anuluje starą epokę i robi jeden registry commit; Reset robi to samo i ponownie ustawia `auto`.

- [ ] **Krok 5: ujednolicić projection/HUD/ViewCube**

Każde programowe polecenie unieważnia starszą epokę, przenosi aktualny pose/target do nowej kamery, wykonuje jeden commit i ignoruje spóźniony settle poprzedniej projekcji.

- [ ] **Krok 6: uruchomić GREEN**

Uruchomić testy z kroku 2 oraz `viewport3dCameraModel.test.ts`. Oczekiwane: PASS.

- [ ] **Krok 7: commit**

```bash
git add apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx apps/control-room/src/modules/viewport-3d/layers/CameraControls.test.ts
git commit -m "fix: make camera registry the committed owner"
```

### Zadanie 6: Audit-only trajectory probe

**Pliki:**
- Utworzyć: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.ts`
- Utworzyć: `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.test.ts`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx`

**Interfejsy:**
- Produkuje: `createViewport3DCameraTrajectoryProbe({ enabled, capacity })`, `record(sample)`, `snapshot()`, `clear()`.
- Wyłączony probe zwraca singleton no-op i nie tworzy próbek.

- [ ] **Krok 1: napisać test bounded/no-op**

```ts
expect(createViewport3DCameraTrajectoryProbe({ enabled: false, capacity: 64 }).snapshot()).toEqual([]);
for (let index = 0; index < 100; index += 1) probe.record(sample(index));
expect(probe.snapshot()).toHaveLength(64);
expect(probe.snapshot()[0]?.frame).toBe(36);
```

- [ ] **Krok 2: uruchomić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.test.ts`  
Oczekiwane: FAIL, moduł nie istnieje.

- [ ] **Krok 3: zaimplementować ring buffer i audit gate**

Próbka zawiera frame/timestamp, live position/target/up/projection, registry camera/shadow/localVersion/remoteRevision, kompatybilny store snapshot, epoch/source/active/dirty/fieldHold i reason. Eksport do `window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__` istnieje tylko przy `NEXT_PUBLIC_AUDIT_BUILD=1` lub równoważnej istniejącej fladze smoke.

- [ ] **Krok 4: uruchomić GREEN i test braku kosztu**

Uruchomić test z kroku 2 oraz performance contracts. Oczekiwane: PASS; wyłączona ścieżka nie alokuje wpisów.

- [ ] **Krok 5: commit**

```bash
git add apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.ts apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.test.ts apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx
git commit -m "test: expose bounded camera trajectory audit"
```

### Zadanie 7: Browser smoke ciągłości, requestów i WebGL

**Pliki:**
- Zmodyfikować: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Zmodyfikować: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

**Interfejsy:**
- Smoke konsumuje `window.__FULLMAG_VIEWPORT3D_CAMERA_AUDIT__` i istniejące metryki viewportu.
- Raport produkuje osobne fazy `camera-orbit-continuity`, `camera-pan-continuity`, `camera-wheel-perspective`, `camera-wheel-orthographic`, `camera-remote-bounds-race`, `camera-idle`.

- [ ] **Krok 1: rozbudować test kontraktu skryptu**

Wymagać tokenów dla sześciu faz, co najmniej 2 s orbit, obu projekcji, kontroli forbidden request families, `gl.isContextLost()`, drawing buffer, jednego commitu na gest i maksymalnego kroku wstecz.

- [ ] **Krok 2: uruchomić RED**

Uruchomić: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`  
Oczekiwane: FAIL na brakujących fazach/probe.

- [ ] **Krok 3: wdrożyć sekwencję runtime**

Smoke wykonuje orbit 2 s, right-pan, perspective wheel, projection swap, orthographic wheel, wymusza testową remote revision i bounds update w środku aktywnego gestu, wykonuje Fit/Reset/ViewCube, czeka na settle i sprawdza zero nowych frame/dirty reasons w oknie idle.

- [ ] **Krok 4: policzyć ciągłość**

Dla każdego gestu obliczyć projekcję kolejnych delt na oczekiwany kierunek. Odrzucić krok wstecz większy od wspólnej tolerancji bez nowego inputu. Wymagać co najmniej kilku próbek zoomu i dokładnie jednego wzrostu `localVersion` na zmieniony gest.

- [ ] **Krok 5: uruchomić GREEN kontraktu**

Uruchomić test z kroku 2. Oczekiwane: PASS.

- [ ] **Krok 6: commit**

```bash
git add apps/control-room/scripts/smoke-viewport-3d.mjs apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
git commit -m "test: gate viewport camera trajectory"
```

### Zadanie 8: Pełna weryfikacja i zamknięcie audytu

**Pliki:**
- Zmodyfikować: `docs/audits/2026-08-11-viewport-3d-camera-rewind-performance-audit.md`

**Interfejsy:**
- Konsumuje wszystkie implementacje i dowody z zadań 1–7.
- Produkuje macierz `wymaganie → kod → test → świeży runtime proof`.

- [ ] **Krok 1: uruchomić zawężone testy kamery**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/visualization/CameraRegistryController.test.ts \
  src/modules/viewport-3d/layers/viewport3DCameraState.test.ts \
  src/modules/viewport-3d/layers/viewport3DCameraGesture.test.ts \
  src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.test.ts \
  src/modules/viewport-3d/layers/CameraControls.test.ts \
  src/modules/viewport-3d/layers/Viewport3DScene.test.ts \
  src/modules/viewport-3d/Viewport3DModule.test.ts \
  src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
  src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Oczekiwane: wszystkie testy PASS, zero unhandled errors.

- [ ] **Krok 2: typecheck i React Doctor**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room exec react-doctor .
```

Oczekiwane: typecheck exit 0; React Doctor bez regresji wyniku i bez nowych krytycznych uwag w zmienionych plikach.

- [ ] **Krok 3: uruchomić repozytoryjny browser smoke**

Uruchomić istniejący disposable launcher `just run-viewport-3d-smoke-disposable` z audit build. Oczekiwane: wszystkie fazy kamery PASS; visible canvas; `isContextLost=false`; drawing buffer > 0; brak forbidden requests; idle zero frames.

- [ ] **Krok 4: wykonać ręczną kwalifikację FDM i FEM**

Na aktywnej sesji każdego backendu wykonać orbit ≥2 s, right-pan, wheel perspective/ortho, projection, Fit, Reset i ViewCube przy odświeżaniu visualization/field. Oczekiwane: brak cofnięcia, brak auto-fit w trybie user i zgodny finalny snapshot.

- [ ] **Krok 5: zaktualizować audyt dowodami**

Dla P0-1…P2-2 oraz dziesięciu kryteriów sekcji 11 zapisać status, dokładny plik/symbol, test, komendę runtime i wynik. Nie oznaczać ręcznej kwalifikacji jako wykonanej bez rzeczywistej próby.

- [ ] **Krok 6: sprawdzić diff i commit**

```bash
git diff --check
git diff --cached --name-only
git add docs/audits/2026-08-11-viewport-3d-camera-rewind-performance-audit.md
git commit -m "docs: close viewport camera rewind audit"
```

Przed commitem ponownie wykonać osobne `git diff --cached --name-only`; staged set może zawierać wyłącznie pliki tego zadania.

