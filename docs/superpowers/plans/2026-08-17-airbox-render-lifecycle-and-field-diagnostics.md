# Airbox — plan naprawy lifecycle renderera i diagnostyki pól

> **Dla agentów:** wykonuj zadania kolejno, test-first. Nie zmieniaj routingu Inspectora bez potwierdzenia, który węzeł użytkownik wybiera.

**Cel:** Zapobiec znikaniu całej sceny podczas przebudowy Airbox po zmianie trybu oraz rozdzielić stan technicznego requestu FDM od publicznego targetu Airbox.

**Architektura:** Gotowość asynchronicznego modelu Airbox nie może resetować globalnego stagingu modelu. Ten staging ma zależeć od zmian topologii bazowej, a nie od pojawienia się opcjonalnego overlayu. Przy zmianie klucza builda na tej samej topologii renderer zachowa ostatni poprawny model do czasu ukończenia nowego builda. Transport zachowa obecne kontrakty: publiczny Airbox jest per-carrier z `scope_id`, techniczny FDM outside-support używa `scope_kind=airbox` i logicznego `scope_id=airbox` w tożsamości bufora.

**Technologie:** React 19, TypeScript, Three.js/R3F, resource-first v2, Vitest, istniejący worker build pipeline.

## Ograniczenia globalne

- Nie obniżać jakości, liczby glyphów ani domyślnej widoczności warstw.
- Nie scalać publicznego targetu `airbox` z technicznym targetem `fdm-universe-outside-support`.
- Nie dodawać bezpośredniego `fetch()` z komponentów.
- Nie ukrywać błędu backendu; błąd częściowy ma zachować last-good i wskazywać konkretny request.
- Nie usuwać ani nie nadpisywać istniejących zmian użytkownika w dirty viewport files.
- Nie zmieniać kontraktu `H_eff`/`H_demag` bez dowodu z katalogu ilości i request planu.

---

### Zadanie 1: Test globalnego stagingu niezależnego od gotowości Airbox

**Pliki:**

- Zmodyfikuj: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`

**Interfejs:**

- Wyeksportuj czystą funkcję `resolveViewport3DModelLayerStageKey` albo wydziel równoważny helper testowalny bez React.
- Klucz ma nadal obejmować topologię, primitive model, FDM native layers i FDM target views.
- Klucz nie może zależeć od `fdmAirboxInstanceModel` ani `fdmMultilayerAirboxView?.model`, bo oba są opcjonalnymi/asynchronicznymi carrierami Airbox.

- [ ] **Krok 1: Dodaj test RED.**

```ts
it("does not reset the global model stage when only Airbox carrier readiness changes", () => {
  const base = {
    fdmNativeLayerViews: [],
    fdmTargetViews: [],
    primitiveModel: null,
    topologyModel: null,
  } as const;
  const emptyAirboxKey = resolveViewport3DModelLayerStageKey({
    ...base,
    fdmAirboxInstanceModel: null,
    fdmMultilayerAirboxView: null,
  });
  const readyAirboxKey = resolveViewport3DModelLayerStageKey({
    ...base,
    fdmAirboxInstanceModel: { count: 4 } as never,
    fdmMultilayerAirboxView: { model: { count: 4 } } as never,
  });

  expect(readyAirboxKey).toBe(emptyAirboxKey);
});
```

- [ ] **Krok 2: Uruchom test RED.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/Viewport3DScene.test.ts
```

Oczekiwany wynik: FAIL, ponieważ obecny klucz zawiera `fdm-airbox-ready/empty` i `fdm-multilayer-airbox-ready/empty`.

- [ ] **Krok 3: Usuń tylko gotowość Airbox z klucza.**

Pozostaw parametry i kolejność bazowej topologii; usuń dwa segmenty zależne od modelu Airbox. Nie zmieniaj `resolveViewport3DModelLayerStageVisibility` ani renderowania `FdmCuboidLayer`.

- [ ] **Krok 4: Uruchom test GREEN i testy sceny.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/Viewport3DScene.test.ts
```

Oczekiwany wynik: wszystkie testy PASS.

---

### Zadanie 2: Last-good model przy zmianie trybu Airbox

**Pliki:**

- Zmodyfikuj: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.test.ts`
- Sprawdź użycie: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`

**Interfejs:**

- Snapshot kontrolera przechowuje `topologyKey` razem z `buildKey`, `result`, `status` i `error`.
- `resolveFdmCuboidBuildState` przyjmuje `currentTopologyKey`.
- Gdy `currentBuildKey` różni się od snapshotu, ale `currentTopologyKey` jest identyczny i snapshot ma wynik, zwraca stan `pending` z poprzednim wynikiem; przy innej topologii zwraca `result: null`.
- Stary błąd nie może przejść do nowego klucza builda.

- [ ] **Krok 1: Dodaj test RED dla pierwszego renderu po zmianie klucza.**

```ts
it("keeps the previous model visible while a same-topology replacement starts", () => {
  const previous = { model: { count: 8 }, vectorSegments: null } as never;
  const state = {
    buildKey: "old",
    error: new Error("old failure"),
    result: previous,
    status: "error" as const,
    topologyKey: "topology-1",
  };

  expect(resolveFdmCuboidBuildState({
    currentBuildKey: "new",
    currentTopologyKey: "topology-1",
    snapshot: state,
  })).toMatchObject({
    buildKey: "new",
    error: null,
    result: previous,
    status: "pending",
  });
});
```

- [ ] **Krok 2: Uruchom test RED.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/fdmCuboidBuildState.test.ts
```

Oczekiwany wynik: FAIL z powodu braku `topologyKey` w kontrakcie i braku retencji przed `begin()`.

- [ ] **Krok 3: Wprowadź minimalną zmianę kontrolera.**

Dodaj `topologyKey` do pustego snapshotu i ustawiaj go w `begin`. W `resolveFdmCuboidBuildState` użyj warunku:

```ts
if (snapshot.topologyKey === currentTopologyKey && snapshot.result !== null) {
  return { buildKey: currentBuildKey, error: null, result: snapshot.result, status: "pending" };
}
```

Warunek musi być wykonywany wyłącznie dla zmiany `buildKey`; brak `currentBuildKey` nadal zwraca stan idle, a zmiana topologii nadal fail-closed.

- [ ] **Krok 4: Dodaj test zmiany topologii i uruchom GREEN.**

```ts
it("does not display a previous model after topology changes", () => {
  expect(resolveFdmCuboidBuildState({
    currentBuildKey: "new",
    currentTopologyKey: "topology-2",
    snapshot: {
      buildKey: "old",
      error: null,
      result: { model: { count: 8 } } as never,
      status: "ready",
      topologyKey: "topology-1",
    },
  }).result).toBeNull();
});
```

Uruchom:

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/fdmCuboidBuildState.test.ts src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts
```

Oczekiwany wynik: wszystkie testy PASS.

---

### Zadanie 3: Rozdzielenie diagnostyki częściowego requestu od aktywnej ilości

**Pliki:**

- Zmodyfikuj: `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts`
- Sprawdź: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`

**Interfejs:**

- Zachowaj publiczny Airbox request z `scope_id=part.id`.
- Zachowaj techniczny FDM Airbox request z `scope_kind=airbox` i bez query `scope_id`; jego logiczna tożsamość bufora nadal musi być `scopeId="airbox"` zgodna z metadanymi FMVP.
- Dodaj typ `Viewport3DFieldVectorRequestFailure` z polami `cause`, `key`, `quantityId`, `query` i `requestId` oraz helper `createViewport3DFieldVectorPartialLoadError`, który tworzy istniejący `ResourcePartialLoadError` i dołącza `requestFailures`.
- Rozszerz błąd częściowy kolekcji ilości o stabilną listę nieudanych `requestId/resourceKey/quantityId/query`, aby komunikat nie wybierał przypadkowo `H_demag` z wielo-requestowego klucza.
- `last-good` pozostaje danymi wyświetlanymi; częściowy błąd jest diagnostyką i nie może zerować geometrii.

- [ ] **Krok 1: Dodaj test RED dla mapy porażek kolekcji.**

```ts
it("keeps the failing quantity request explicit in a partial collection error", () => {
  const error = createViewport3DFieldVectorPartialLoadError({
    cause: new Error("backend rejected H_demag"),
    message: "One or more quantity field vectors are not ready",
    partialData: new Map(),
    requestFailures: [{
      cause: new Error("backend rejected H_demag"),
      key: "vector:H_demag:airbox",
      quantityId: "H_demag",
      query: { component: "full", scope_kind: "airbox" },
      requestId: "quantity=H_demag&component=full&scope_kind=airbox",
    }],
  });

  expect(error).toMatchObject({
    name: "ResourcePartialLoadError",
    requestFailures: expect.arrayContaining([
      expect.objectContaining({
        quantityId: "H_demag",
        query: expect.objectContaining({ scope_kind: "airbox" }),
      }),
    ]),
  });
});
```

Loader kolekcji ma wywoływać ten helper w miejscu obecnego `createResourcePartialLoadError`, przekazując metadane requestu z `requestKeys`; test nie może zależeć od prywatnego React hooka.

- [ ] **Krok 2: Uruchom test RED.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport3dResources.test.ts
```

Oczekiwany wynik: FAIL, ponieważ `ResourcePartialLoadError` nie ma jeszcze listy nieudanych requestów.

- [ ] **Krok 3: Dodaj metadane błędu bez zmiany decyzji o retencji.**

Przy `catch` w `useViewport3DQuantityFieldVectors` i `useViewport3DAirboxFieldVectors` zapisz metadane requestu w tablicy; przy tworzeniu błędu przypisz je jako `requestFailures`. Nie zmieniaj `partialData`, `resolveViewport3DFieldVectorCollectionLastGood` ani retry policy.

- [ ] **Krok 4: Uruchom testy GREEN i request identity.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/viewport3dResources.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.test.ts
```

Oczekiwany wynik: PASS; testy muszą nadal potwierdzać per-carrier `scope_id` publicznego Airbox oraz techniczny scope FDM.

---

### Zadanie 4: Weryfikacja produkcyjna i granica routingu

**Pliki:**

- Bez zmian do sprawdzenia: `apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.ts`
- Bez zmian do sprawdzenia: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Testy: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`, `apps/control-room/src/modules/explorer/builders/airboxExplorerNodes.test.ts`

- [ ] **Krok 1: Potwierdź rozdział węzłów.**

`model:airbox` / `airbox.root` ma pozostać overview/polityką, a `model:airbox:visualization` / `airbox.visualization` ma pozostać panelem sterowania. Nie mapuj root do listy display tylko dlatego, że oba targety mają `visualizationTargetId="airbox"`.

- [ ] **Krok 2: Uruchom testy routingu i pełne testy frontendowe.**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/modules/inspector/inspectorRegistry.test.tsx src/modules/explorer/builders/airboxExplorerNodes.test.ts
env TMPDIR=/tmp pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
```

- [ ] **Krok 3: Wykonaj browser smoke.**

Rozdziel trzy klatki: Airbox wireframe, Airbox points, Airbox vectors-only. W każdej potwierdź canvas, niezerowy drawing buffer, brak WebGL context loss, brak ukrycia geometrii obiektu przy oczekiwaniu na build oraz request z właściwym quantity/scope. Browser smoke jest obowiązkowy dla finalnego claimu produkcyjnego.

- [ ] **Krok 4: Uruchom React Doctor dla zmienionych komponentów.**

```bash
cd apps/control-room && npx react-doctor@latest --verbose --scope changed
```

## Kryteria akceptacji

- Zmiana trybu Airbox nie resetuje globalnego stagingu i nie ukrywa geometrii magnetycznej.
- Przy tej samej topologii stary poprawny model pozostaje widoczny do czasu ukończenia nowego builda.
- Publiczny Airbox i techniczny FDM zachowują różne, jawne kontrakty scope.
- Błąd częściowy wskazuje konkretną ilość i query; last-good pozostaje używalny.
- `H_eff` nie jest zamieniany na `H_demag` przez UI ani plan requestów; jeśli backend odrzuca konkretny quantity, komunikat wskazuje dokładnie ten request.
- Root Airbox i child Visualization pozostają osobnymi węzłami do czasu potwierdzenia oczekiwanej nawigacji.
- Testy, typecheck, React Doctor i browser smoke przechodzą; bez browser smoke raport pozostaje statycznym/local-verified, nie production-qualified.
