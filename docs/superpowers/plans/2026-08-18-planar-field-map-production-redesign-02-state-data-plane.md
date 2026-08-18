# Plan wdrożenia frontendowego stanu i data plane mapy pola 2D

> **Dla agentów wykonawczych:** WYMAGANY SUB-SKILL: użyj `subagent-driven-development` albo `executing-plans`. Backend schema/API i generated OpenAPI z commitów `2fb09e817` oraz `5aafbe2cd` są wejściem do tego planu.

**Cel:** Podłączyć sparse target wireframe overrides do jednego canonical visualization target registry, zachować jeden planar data plan i naprawić izolację Airbox/Object/Part bez dodatkowych fetchy i bez destabilizacji Inspectora.

**Architektura:** Generated types pozostają transportowym źródłem prawdy. Czysty helper indeksuje istniejące `visualization.targets`, rozwiązuje global fallback lub exact override i buduje pełną replacement list. Explorer selection służy tylko do wyboru edytowanego wpisu prezentacji; data-plane query nadal wynika z planar source/view scope/meta i nie jest sterowane selection.

**Tech Stack:** TypeScript, React 19, generated OpenAPI types, visualization resource sync, resource hooks i Vitest.

## Global Constraints

- Nie twórz frontendowego target union, kolekcji pełnych profili per target, osobnej listy z-order, osobnego aktywnego targetu ani drugiego registry.
- Obsługiwane identity to wyłącznie exact `airbox | object | part` plus niepusty `scope_id`.
- `visualization.targets` dostarcza identity i label; `planar.target_overrides` nie kopiuje label, source, carrier, geometry ownership ani selection.
- Region i inne nieobsługiwane selections są read-only z jawnym reason; nie wolno mapować ich do object po suffixie.
- Global `planar.wireframe_style` pozostaje fallbackiem i ma osobny, świadomie opisany editor.
- Sparse replacement helper zachowuje wszystkie niezwiązane i dormant entries byte-for-byte.
- Optimistic presentation może zmienić effective style, ale canonical source/frame/query identity pozostaje właścicielem resource fetch.
- Style-only update nie zmienia `fieldMapDataPlan`, resource key, `sample_token` ani ETag oczekiwań.
- Jeden komponent jest ownerem subscription do visualization state; child sections nie subskrybują ponownie.
- Pending/ACK nie remountuje Inspectora, nie resetuje focus/scroll/draft, nie dimuje sibling controls i nie uruchamia opacity animation.
- Pierwszy client render odpowiada SSR snapshot.
- Żaden moduł nie buduje ręcznie endpointów `/v2`.

---

### Zadanie 1: Wygenerowany kontrakt i centralne aliasy — część generated zakończona, frontend oczekuje

**Status:**

- [x] `PlanarTargetPresentationOverrideState` exists in generated JSON/types, commit `5aafbe2cd`.
- [x] state publishes the sparse list and patch publishes an optional replacement list.
- [ ] handwritten consumers have not yet been qualified against optional `VisualizationStateResource.targets`.
- [ ] no frontend task below is complete merely because uncommitted helper code exists.

**Pliki:**

- Inspect only: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Inspect only: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Inspect/consume: `apps/control-room/src/kernel/api/apiTypes.ts`
- Test: `apps/control-room/src/kernel/api/openapiV2GeneratedContract.test.ts`

#### Krok 1.1 — uczciwa weryfikacja GREEN wygenerowanego kontraktu

Ten krok nie jest RED: commit `5aafbe2cd` już opublikował kontrakt generated. Uruchom istniejący test kontraktu i potwierdź następujące asercje jako weryfikację GREEN:

~~~typescript
expect(planarOverride.required).toEqual([
  "scope",
  "scope_id",
  "wireframe_style",
]);
expect(planarState.properties.target_overrides.type).toBe("array");
expect(planarPatch.required ?? []).not.toContain("target_overrides");
expect(visualizationState.required ?? []).not.toContain("targets");
~~~

Prawdziwy consumer RED dla opcjonalnego `targets` należy do Zadania 2, Kroku 2.1: `findPlanarRegistryEntry(undefined, AIRBOX_VISUALIZATION_TARGET)` oraz `resolveEffectivePlanarWireframe(..., undefined, ...)` mają wykazać błąd konsumenta przed dodaniem runtime guardu. Nie przedstawiaj zielonego testu generated schema jako failing testu UI.

Uruchom:

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room generate:api
git diff --exit-code -- apps/control-room/src/kernel/api/generated
~~~

Oczekiwany GREEN: test kończy się PASS, a generator nie tworzy diffu. Jeżeli któraś z czterech asercji nie istnieje, dodaj ją jako wzmocnienie testu kontraktu i nadal nazwij ten krok GREEN verification; zachowanie konsumenta pozostaje osobnym RED w Zadaniu 2.

#### Krok 1.2 — reguła importu typów kanonicznych

All handwritten frontend files use:

~~~typescript
import type { components } from "../../kernel/api/generated/openapi-v2-types";
import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../../kernel/api/apiTypes";
import type { VisualizationTargetRef } from
  "../../kernel/visualization/ObjectVisualizationController";

type PlanarTargetOverride =
  components["schemas"]["PlanarTargetPresentationOverrideState"];
type VisualizationTargetRegistryEntry =
  components["schemas"]["VisualizationTargetRegistryEntry"];
type VisualizationTargetRegistryState =
  components["schemas"]["VisualizationTargetRegistryState"];
~~~

Do not duplicate any property list from generated schemas. `VisualizationTargetRegistryState` is a transport alias, not a second domain model.

### Zadanie 2: Refaktoryzacja exact lookup i sparse replacement wokół istniejącego modelu targetu

**Status:** oczekuje. Existing uncommitted `planarTargetPresentation.ts` must be treated as input to refactor, not completed work.

**Pliki:**

- Modify: `apps/control-room/src/kernel/visualization/planarTargetPresentation.ts`
- Modify/Create: `apps/control-room/src/kernel/visualization/planarTargetPresentation.test.ts`
- Reuse: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`

**Dokładne ponownie używane symbole:**

- `VisualizationTargetRef`
- `resolveVisualizationTargetFromSelection`
- `visualizationStateScopeIdForTarget`
- `visualizationTargetKey`
- `AIRBOX_VISUALIZATION_TARGET`

No new selection-target union, identity record or registry wrapper is exported.

#### Krok 2.1 — RED dla opcjonalnego registry

Write these tests before changing helper signatures:

~~~typescript
describe("findPlanarRegistryEntry", () => {
  it("fails closed when the generated registry is absent", () => {
    expect(findPlanarRegistryEntry(undefined, AIRBOX_VISUALIZATION_TARGET))
      .toBeNull();
  });

  it("does not treat an absent registry as an empty editable registry", () => {
    const result = resolveEffectivePlanarWireframe(
      planarWithOverrides,
      undefined,
      AIRBOX_VISUALIZATION_TARGET,
    );
    expect(result).toEqual({
      style: planarWithOverrides.wireframe_style,
      source: "global",
      registryEntry: null,
      inactive: true,
    });
  });
});
~~~

Oczekiwany RED: current helper requires a registry-shaped value or dereferences `targets.airbox`.

#### Krok 2.2 — dokładne sygnatury helperów

Implement this public surface only:

~~~typescript
export function isEditablePlanarTarget(
  target: VisualizationTargetRef,
): boolean {
  return target.kind === "airbox" ||
    target.kind === "object" ||
    target.kind === "part";
}

export function findPlanarRegistryEntry(
  targets: VisualizationStateResource["targets"],
  target: VisualizationTargetRef,
): VisualizationTargetRegistryEntry | null {
  if (!targets || !isEditablePlanarTarget(target)) return null;

  const registry: NonNullable<VisualizationStateResource["targets"]> = targets;
  const scopeId = visualizationStateScopeIdForTarget(target);

  if (target.kind === "airbox") {
    return registry.airbox.scope === "airbox" &&
      registry.airbox.scope_id === scopeId
      ? registry.airbox
      : null;
  }

  const entries = target.kind === "object"
    ? registry.objects
    : registry.parts;
  return entries.find(
    (entry) => entry.scope === target.kind && entry.scope_id === scopeId,
  ) ?? null;
}
~~~

The `NonNullable` binding appears only after `if (!targets) return null`. Do not use a cast, non-null assertion or `targets ?? emptyRegistry`.

#### Krok 2.3 — RED dokładnego dopasowania override

~~~typescript
it.each([
  [objectTarget("film"), partTarget("film")],
  [objectTarget("film"), objectTarget("film-2")],
  [partTarget("part:film"), partTarget("part:film-2")],
])("does not collide %o and %o", (left, right) => {
  const current = [overrideFor(left, redStyle)];
  expect(resolveEffectivePlanarWireframe(planar(current), registry, right))
    .toMatchObject({ source: "global" });
});
~~~

Use `visualizationStateScopeIdForTarget` for scope ID normalization and direct equality for scope. `visualizationTargetKey` may be used for pending keys/log evidence, not for reconstructing registry IDs.

Oczekiwany RED: any label, suffix, array-index or broad-ID comparison collides.

#### Krok 2.4 — effective-style implementation skeleton

~~~typescript
export function resolveEffectivePlanarWireframe(
  planar: PlanarState,
  targets: VisualizationStateResource["targets"],
  target: VisualizationTargetRef | null,
) {
  if (!target || !targets || !isEditablePlanarTarget(target)) {
    return {
      style: planar.wireframe_style,
      source: "global" as const,
      registryEntry: null,
      inactive: Boolean(target),
    };
  }

  const entry = findPlanarRegistryEntry(targets, target);
  if (!entry) {
    return {
      style: planar.wireframe_style,
      source: "global" as const,
      registryEntry: null,
      inactive: true,
    };
  }

  const scopeId = visualizationStateScopeIdForTarget(target);
  const override = planar.target_overrides.find(
    (item) => item.scope === entry.scope && item.scope_id === scopeId,
  );
  return {
    style: override?.wireframe_style ?? planar.wireframe_style,
    source: override ? "override" as const : "global" as const,
    registryEntry: entry,
    inactive: false,
  };
}
~~~

`inactive=true` means a target-specific entry cannot be applied in the current registry revision. It never means “delete this entry”.

#### Krok 2.5 — sparse replacement RED

~~~typescript
it("replaces only one exact target and preserves dormant entries", () => {
  const current = [airboxOverride, objectOverride, dormantPartOverride];
  const next = replacePlanarTargetOverride(
    current,
    AIRBOX_VISUALIZATION_TARGET,
    blueStyle,
  );

  expect(next[0]).toEqual({
    ...airboxOverride,
    wireframe_style: blueStyle,
  });
  expect(next[1]).toBe(current[1]);
  expect(next[2]).toBe(current[2]);
  expect(current[0]).toBe(airboxOverride);
});

it("removes only the selected override when style is null", () => {
  expect(replacePlanarTargetOverride(
    [airboxOverride, objectOverride, dormantPartOverride],
    objectTarget("film"),
    null,
  )).toEqual([airboxOverride, dormantPartOverride]);
});
~~~

Minimalny GREEN:

~~~typescript
export function replacePlanarTargetOverride(
  current: readonly PlanarTargetOverride[],
  target: VisualizationTargetRef,
  style: PlanarTargetOverride["wireframe_style"] | null,
): PlanarTargetOverride[] {
  if (!isEditablePlanarTarget(target)) return [...current];

  const scope = target.kind;
  const scopeId = visualizationStateScopeIdForTarget(target);
  const index = current.findIndex(
    (entry) => entry.scope === scope && entry.scope_id === scopeId,
  );

  if (style === null) {
    return index < 0
      ? [...current]
      : current.filter((_, candidateIndex) => candidateIndex !== index);
  }

  const nextEntry: PlanarTargetOverride = {
    scope,
    scope_id: scopeId,
    wireframe_style: style,
  };
  if (index < 0) return [...current, nextEntry];

  return current.map((entry, candidateIndex) =>
    candidateIndex === index ? nextEntry : entry
  );
}
~~~

No helper accepts label. No helper creates sampling scope.

#### Krok 2.6 — focused gate

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/visualization/planarTargetPresentation.test.ts
pnpm --dir apps/control-room typecheck
git diff --check
~~~

Oczekiwany GREEN: exact tests PASS, optional-registry tests PASS, and no exported parallel target type remains. Proponowany commit after review: `feat: resolve planar presentation with canonical targets`.

### Zadanie 3: Rozwiązanie selection i wejście Inspectora fail-closed

**Status:** oczekuje.

**Pliki:**

- Modify: `apps/control-room/src/modules/inspector/visualization/VisualizationViewContext.ts`
- Modify: `apps/control-room/src/modules/inspector/visualization/VisualizationViewContext.test.ts`
- Modify after context tests: `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx`

#### Krok 3.1 — delete duplicate selection semantics

Wywołaj istniejący resolver dokładnie raz, a następnie zachowaj identyczną kolejność guardów i identyczne reason strings jak w planie master:

~~~typescript
const selectedTarget = resolveVisualizationTargetFromSelection(selection);

if (!selectedTarget) {
  return {
    planarPresentationTarget: null,
    planarPresentationRegistryEntry: null,
    planarPresentationReadOnlyReason:
      "No canonical visualization target is selected.",
    planarPresentationMayPatch: false,
  };
}

if (!isEditablePlanarTarget(selectedTarget)) {
  return {
    planarPresentationTarget: selectedTarget,
    planarPresentationRegistryEntry: null,
    planarPresentationReadOnlyReason:
      "This selection has no editable planar presentation target.",
    planarPresentationMayPatch: false,
  };
}

const targets = visualization.data?.targets;
if (!targets) {
  return {
    planarPresentationTarget: selectedTarget,
    planarPresentationRegistryEntry: null,
    planarPresentationReadOnlyReason:
      "Visualization target registry is unavailable.",
    planarPresentationMayPatch: false,
  };
}

const registry: NonNullable<VisualizationStateResource["targets"]> = targets;
const registryEntry = findPlanarRegistryEntry(registry, selectedTarget);
if (!registryEntry) {
  return {
    planarPresentationTarget: selectedTarget,
    planarPresentationRegistryEntry: null,
    planarPresentationReadOnlyReason:
      "The selected target is absent from the current visualization target registry.",
    planarPresentationMayPatch: false,
  };
}

return {
  planarPresentationTarget: selectedTarget,
  planarPresentationRegistryEntry: registryEntry,
  planarPresentationReadOnlyReason: null,
  planarPresentationMayPatch: true,
};
~~~

Zamrożona kolejność:

1. rozwiązanie selection; brak targetu oznacza brak canonical targetu i kończy ścieżkę przed odczytem registry;
2. odrzucenie resolved targetu o nieobsługiwanym kind;
3. presence guard opcjonalnego `targets` dla resolved, wspieranego targetu;
4. exact membership guard w obecnej rewizji registry;
5. dopiero pełny sukces udostępnia edycję target override.

No exported discriminated union for “selection resolution” is added. View context may expose primitive fields already needed by the component:

~~~typescript
readonly planarPresentationTarget: VisualizationTargetRef | null;
readonly planarPresentationRegistryEntry:
  | VisualizationTargetRegistryEntry
  | null;
readonly planarPresentationReadOnlyReason: string | null;
readonly planarPresentationMayPatch: boolean;
~~~

These fields carry state, not a competing identity model.

#### Krok 3.2 — RED matrix

~~~typescript
it.each([
  [airboxSelection, "airbox", true],
  [objectSelection("film"), "object", true],
  [partSelection("film"), "part", true],
  [regionSelection, "region", false],
  [fdmDomainSelection, "fdm-domain", false],
  [nativeLayerSelection, "fdm-native-layer", false],
])("resolves %o through the canonical target resolver", (
  selection,
  expectedKind,
  editable,
) => {
  const view = buildVisualizationViewContext({ selection, visualization });
  expect(view.planarPresentationTarget?.kind).toBe(expectedKind);
  expect(view.planarPresentationMayPatch).toBe(editable);
});
~~~

Add separate tests:

- [ ] `targets: undefined` yields `mayPatch=false`, nonempty missing-registry reason and null registry entry;
- [ ] object present in selection but absent from registry yields `mayPatch=false`;
- [ ] same label with different ID does not match;
- [ ] `part/film` never matches `object/film`;
- [ ] no test expects a PATCH from unsupported selection.

Oczekiwany RED: current code assumes a present registry, reconstructs target identity, or enables control on unsupported target.

#### Krok 3.3 — minimalny GREEN i komenda

Implement only the ordered guards and data fields above. Keep existing `planarViewScopeForSelection` unchanged as the separate sampling adapter.

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/visualization/VisualizationViewContext.test.ts
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: matrix PASS; missing registry and missing entry are fail-closed; no data-plan code changed. Proponowany commit: `fix: guard planar presentation target resolution`.

### Zadanie 4: Revision-safe optimistic projection bez drugiego store

**Status:** oczekuje.

**Pliki:**

- Modify: `apps/control-room/src/kernel/visualization/planarPresentationProjection.ts`
- Modify: `apps/control-room/src/kernel/visualization/planarPresentationProjection.test.ts`
- Modify: `apps/control-room/src/kernel/visualization/useVisualizationStateResource.test.tsx`
- Inspect: owner of `visualizationSync.queuePatch`

#### Krok 4.1 — RED zachowania stanu

~~~typescript
it("projects one target edit without touching sampling or dormant entries", () => {
  const canonical = visualizationFixture({
    source: authoredSource,
    defaultSlice,
    targetOverrides: [airboxOverride, objectOverride, dormantPartOverride],
  });
  const projected = projectPlanarPresentation(
    canonical,
    patchForTarget(AIRBOX_VISUALIZATION_TARGET, blueStyle),
  );

  expect(projected.planar.source).toBe(canonical.planar.source);
  expect(projected.planar.default_slice).toBe(canonical.planar.default_slice);
  expect(projected.planar.target_overrides[1]).toBe(objectOverride);
  expect(projected.planar.target_overrides[2]).toBe(dormantPartOverride);
});
~~~

Additional RED cases:

- [ ] no optimistic patch returns the canonical list without cloning entries;
- [ ] global wireframe edit changes only fallback and creates no target entry;
- [ ] two rapid target edits build the second replacement from latest optimistic projection;
- [ ] failed request preserves field draft until canonical refetch settles;
- [ ] no silent retry against an unknown revision;
- [ ] request payload contains the full replacement list only when target overrides changed.

#### Krok 4.2 — owner i klucz pending

The existing visualization resource sync remains the only PATCH owner. Use a field-scoped key:

~~~typescript
const pendingKey =
  `planar.target_overrides:${visualizationTargetKey(target)}`;
~~~

The key controls only the selected style inputs. It must not disable the Inspector root, global range, quantity controls or sibling target controls.

#### Krok 4.3 — minimalny GREEN i bramka

- [ ] Reuse `replacePlanarTargetOverride`.
- [ ] Merge against latest canonical + optimistic projection held by existing sync owner.
- [ ] Do not add Zustand/localStorage/context storage for overrides.
- [ ] Let HTTP v2 resource remain source of truth; websocket only invalidates/refetches.

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/visualization/planarPresentationProjection.test.ts \
  src/kernel/visualization/useVisualizationStateResource.test.tsx
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: tests PASS; one owner, one request per committed edit, no second store. Proponowany commit: `fix: preserve planar overrides during optimistic updates`.

### Zadanie 5: Target-aware Inspector z zerem PATCH przy braku registry

**Status:** oczekuje.

**Pliki:**

- Modify: `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/visualization/PlanarPresentationSections.tsx`

#### Krok 5.1 — kontrakt komponentu

`PlanarWireframeSection` receives data/callbacks; it does not subscribe:

~~~typescript
interface PlanarWireframeSectionProps {
  target: VisualizationTargetRef | null;
  registryEntry: VisualizationTargetRegistryEntry | null;
  effectiveStyle: PlanarWireframeStyle;
  source: "global" | "override";
  readOnlyReason: string | null;
  pending: boolean;
  onStyleChange(style: PlanarWireframeStyle): void;
  onUseGlobal(): void;
}
~~~

The parent remains the only visualization resource subscriber and mutation owner.

#### Krok 5.2 — RED behavior matrix

Write explicit tests for:

- [ ] Airbox without override shows registry label and `Global fallback`;
- [ ] first Airbox edit emits exact `scope:"airbox"`, `scope_id:"airbox"` entry and does not change global style;
- [ ] object edit preserves Airbox, part and dormant entry by deep equality;
- [ ] part edit uses registry `scope_id`, not label or reconstructed prefix;
- [ ] `Use global` removes only selected exact entry;
- [ ] unsupported region renders read-only reason and zero `queuePatch` calls;
- [ ] `targets: undefined` renders `Visualization target registry is unavailable`, uses global effective values and emits zero PATCH after click/change attempts;
- [ ] selected object absent from current registry is read-only and emits zero PATCH;
- [ ] same-label object with different ID remains independent.

Complete missing-registry test skeleton:

~~~typescript
it("fails closed when visualization targets are absent", async () => {
  const queuePatch = vi.fn();
  const { user, getByRole, queryAllByRole } = renderPlanarInspector({
    selection: objectSelection("film"),
    visualization: visualizationFixture({ targets: undefined }),
    queuePatch,
  });

  expect(getByRole("status")).toHaveTextContent(
    "Visualization target registry is unavailable",
  );
  expect(
    queryAllByRole("textbox").every(
      (control) => control.hasAttribute("disabled") ||
        control.getAttribute("aria-disabled") === "true",
    ),
  ).toBe(true);
  await user.click(getByRole("button", { name: /use global/i }));
  expect(queuePatch).not.toHaveBeenCalled();
});
~~~

Oczekiwany RED: current component enables a target edit or fabricates registry presence.

#### Krok 5.3 — stability RED

In one test retain references before edit:

~~~typescript
const rootBefore = getByTestId("planar-visualization-section");
const inputBefore = getByLabelText(/wireframe opacity/i);
rootBefore.scrollTop = 117;
inputBefore.focus();
await user.clear(inputBefore);
await user.type(inputBefore, "0.35");
resolveQueuedPatchAck();

expect(getByTestId("planar-visualization-section")).toBe(rootBefore);
expect(document.activeElement).toBe(inputBefore);
expect(rootBefore.scrollTop).toBe(117);
expect(inputBefore).toHaveValue("0.35");
expect(unrelatedControl).not.toBeDisabled();
expect(getAnimationsAffectingOpacity(rootBefore)).toHaveLength(0);
~~~

Oczekiwany RED: remount, focus loss, scroll reset, broad pending disable or opacity animation.

#### Krok 5.4 — minimalny GREEN i bramka

- [ ] Render one stable root for same target identity.
- [ ] Use field-scoped pending key.
- [ ] Preserve draft until ACK/refetch reconciliation.
- [ ] Label inputs with registry entry label plus exact accessible description.
- [ ] Add no opacity transition to persistent/conditional Inspector controls.

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: behavior matrix and stability assertions PASS. Proponowany commit: `fix: isolate planar wireframe controls by target`.

### Zadanie 6: Efektywny styl renderera bez zmiany pojedynczego data planu

**Status:** oczekuje.

**Pliki:**

- Modify: `apps/control-room/src/modules/field-map/model/fieldMapDataPlan.test.ts`
- Modify: `apps/control-room/src/kernel/resources/planarFieldResources.test.ts`
- Modify: `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.ts`
- Modify: `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.test.ts`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`

#### Krok 6.1 — rozwiązanie sampled targetu przez ten sam typ targetu

The adapter returns `VisualizationTargetRef | null`, never a new target record:

~~~typescript
export function resolvePlanarSampleTarget(input: {
  metaScopeKind: string;
  metaScopeId?: string | null;
  monitorTarget: VisualizationTargetRef | null;
}): VisualizationTargetRef | null {
  if (input.metaScopeKind === "airbox") {
    return AIRBOX_VISUALIZATION_TARGET;
  }
  if (input.metaScopeKind === "object" && input.metaScopeId) {
    return { kind: "object", id: input.metaScopeId };
  }
  if (input.metaScopeKind === "mesh_part" && input.metaScopeId) {
    return { kind: "part", id: input.metaScopeId };
  }
  return input.monitorTarget && isEditablePlanarTarget(input.monitorTarget)
    ? input.monitorTarget
    : null;
}
~~~

Before implementing, compare `metaScopeKind` with the generated enum/actual meta schema and use its exact spelling. The skeleton's `mesh_part` branch is accepted only if generated contract confirms it; otherwise use the generated literal. Do not silently broaden it.

#### Krok 6.2 — RED request-count isolation

~~~typescript
it("does not refetch planar data for presentation-only changes", async () => {
  const requests = installPlanarResourceCounters();
  const view = renderFieldMap({ registry, planar: initialPlanar });
  await view.waitForReady();
  const baseline = requests.snapshot();

  for (let index = 0; index < 20; index += 1) {
    view.rerender({
      registry,
      planar: withAirboxStyle(initialPlanar, index),
    });
  }

  expect(requests.deltaFrom(baseline)).toEqual({
    meta: 0,
    scalar: 0,
    vectors: 0,
    emptyMask: 0,
    meshOverlay: 0,
  });
});
~~~

Also assert:

- [ ] `buildFieldMapDataPlan` output deep-equal before/after override change;
- [ ] resource cache keys equal;
- [ ] base scalar buffer identity preserved;
- [ ] only overlay invalidation count changes;
- [ ] missing registry uses global style and never applies dormant override;
- [ ] Explorer selection does not choose renderer style;
- [ ] changing actual `view_scope` may fetch one new sample and is tested separately.

Oczekiwany RED: any style field appears in data-plan key/dependencies or the renderer reads current Explorer selection.

#### Krok 6.3 — minimal GREEN

- [ ] Build exactly one data plan and one family of resource hooks.
- [ ] Resolve current sampled target to `VisualizationTargetRef | null`.
- [ ] Call `resolveEffectivePlanarWireframe(planar, targets, sampledTarget)`.
- [ ] Pass only the resolved style into render model.
- [ ] Keep sparse list, registry and selection out of sampler/worker colorization inputs.
- [ ] Missing registry and absent exact entry use global fallback with inactive evidence.

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/model/fieldMapDataPlan.test.ts \
  src/kernel/resources/planarFieldResources.test.ts \
  src/modules/field-map/model/fieldMapRenderModel.test.ts \
  src/modules/field-map/FieldMapModule.test.tsx
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: all focused tests PASS; request delta is zero for presentation-only changes. Proponowany commit: `feat: apply exact planar target wireframe style`.

### Zadanie 7: Wykonywalny rollback i dokładna reaktywacja

**Status:** oczekuje.

**Pliki:**

- Create: `apps/control-room/src/modules/field-map/fieldMapExperience.ts`
- Create: `apps/control-room/src/modules/field-map/fieldMapExperience.test.ts`
- Modify: `apps/control-room/src/modules/field-map/manifest.ts`
- Modify: `apps/control-room/src/modules/field-map/manifest.test.ts`
- Create: `apps/control-room/src/modules/field-map/LegacyFieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`
- Modify: `apps/control-room/src/kernel/visualization/planarTargetPresentation.test.ts`

Use exactly the owner and build-time flag defined in master Task 9: `NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=scientific|legacy`. `modules/registry.ts` keeps one manifest ID.

#### Krok 7.1 — RED resolvera i loadera

~~~typescript
it("loads the compatibility renderer only for the legacy flag", async () => {
  expect(resolveFieldMapExperience("legacy")).toBe("legacy");
  expect(resolveFieldMapExperience("scientific")).toBe("scientific");
  expect(resolveFieldMapExperience(undefined)).toBe("scientific");
  expect(resolveFieldMapExperience("invalid")).toBe("scientific");
});
~~~

Oczekiwany RED: resolver/module absent. Minimalny GREEN: pure resolver and manifest-owned lazy choice.

#### Krok 7.2 — RED zachowania stanu

- [ ] Seed global fallback, Airbox override, object override and dormant part override.
- [ ] Mount scientific renderer, unmount, mount legacy renderer.
- [ ] Assert zero `queuePatch` calls during both mounts/switch.
- [ ] Assert complete ordered visualization JSON unchanged.
- [ ] Restore session while legacy active and assert same JSON.
- [ ] Rebuild/mount scientific and assert active styles reappear.
- [ ] Add exact dormant part registry entry and assert style reactivates without PATCH.
- [ ] Add same label with a different ID and assert no reactivation.

Oczekiwany RED: current manifest lacks a rollback owner. Minimal GREEN does not dual-write or migrate target preferences.

#### Krok 7.3 — commands

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/fieldMapExperience.test.ts \
  src/modules/field-map/manifest.test.ts \
  src/modules/field-map/FieldMapModule.test.tsx \
  src/kernel/visualization/planarTargetPresentation.test.ts
NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=legacy \
  pnpm --dir apps/control-room build:webpack
NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=scientific \
  pnpm --dir apps/control-room build:webpack
~~~

Oczekiwany GREEN: tests and both builds PASS; no state mutation. Proponowany commit: `test: preserve planar settings through renderer rollback`.

### Zadanie 8: Bramka B — architektura, higiena API, stabilność i liczba requestów

**Status:** oczekuje. Evidence file may be created only after Tasks 1–7 are green.

**Pliki:**

- Create evidence: `.superpowers/sdd/planar-redesign-state-data-plane-evidence.md`
- Verify all frontend files changed in Tasks 1–7.

#### Krok 8.1 — bramki focused i type

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/kernel/api/openapiV2GeneratedContract.test.ts \
  src/kernel/visualization/planarTargetPresentation.test.ts \
  src/kernel/visualization/planarPresentationProjection.test.ts \
  src/kernel/visualization/useVisualizationStateResource.test.tsx \
  src/modules/inspector/visualization/VisualizationViewContext.test.ts \
  src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx \
  src/modules/field-map/model/fieldMapDataPlan.test.ts \
  src/modules/field-map/model/fieldMapRenderModel.test.ts \
  src/modules/field-map/FieldMapModule.test.tsx
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room check:api-hygiene
~~~

Oczekiwany GREEN: all selected suites PASS, typecheck and hygiene exit 0.

#### Krok 8.2 — positive allowlist scan

Correct canonical symbols must produce matches:

~~~bash
rg -n \
  'VisualizationTargetRef|VisualizationTargetRegistryEntry|target_overrides|replacePlanarTargetOverride' \
  apps/control-room/src/kernel/visualization/planarTargetPresentation.ts \
  apps/control-room/src/kernel/visualization/planarTargetPresentation.test.ts \
  apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
  apps/control-room/src/modules/inspector/visualization \
  apps/control-room/src/modules/field-map
~~~

Oczekiwany GREEN: exit 0; every match is in an explicitly listed owner/consumer. Do not call this scan expected-empty.

Executable unexpected-owner gate:

~~~bash
unexpected="$({ rg -l \
  'target_overrides|replacePlanarTargetOverride' \
  apps/control-room/src || true; } \
  | rg -v \
  '^(apps/control-room/src/kernel/api/(apiTypes\.ts|generated/openapi-v2\.(json|types\.ts)|openapiV2GeneratedContract\.test\.ts)|apps/control-room/src/kernel/visualization/planar(TargetPresentation|PresentationProjection|useVisualizationStateResource)(\.test)?\.(ts|tsx)|apps/control-room/src/modules/inspector/visualization/|apps/control-room/src/modules/field-map/)' \
  || true)"
test -z "$unexpected"
~~~

Oczekiwany GREEN: empty `unexpected` and exit 0.

#### Krok 8.3 — forbidden-model negative scan

~~~bash
if rg -n \
  'PlanarOverrideIdentity|PlanarOverrideSelectionResolution|PlanarPresentationTarget|PlanarTargetRegistry|planarTargetZOrder|activePlanarTarget|perTarget(Quantity|Range|Raster|Layer)' \
  apps/control-room/src; then
  echo 'forbidden parallel planar target model found' >&2
  exit 1
fi
~~~

Oczekiwany GREEN: no source matches. The regex contains only forbidden model names, not valid canonical symbols.

#### Krok 8.4 — direct transport negative scan

~~~bash
if rg -n \
  'fetch\(|["`'"']/v2/sessions/current' \
  apps/control-room/src/modules/field-map \
  apps/control-room/src/modules/inspector/visualization; then
  echo 'direct transport found in a React module' >&2
  exit 1
fi
~~~

Oczekiwany GREEN: no direct `fetch()` and no hand-built v2 route in modules. Generated transport/facade and external smoke scripts are outside this negative scope.

#### Krok 8.5 — behavioral evidence

Record this exact matrix:

| Action | visualization PATCH delta | planar meta | scalar | vectors | mask | overlay | Expected style |
|---|---:|---:|---:|---:|---:|---:|---|
| 20 Airbox style edits | 20 committed edits or documented debounced count | 0 | 0 | 0 | 0 | 0 | Airbox override |
| 20 object style edits | 20 committed edits or documented debounced count | 0 | 0 | 0 | 0 | 0 | object override |
| Airbox → Object → Part → Airbox, same view scope | 0 | 0 | 0 | 0 | 0 | 0 | preserved exact styles |
| missing registry | 0 | 0 | 0 | 0 | 0 | 0 | global, read-only |
| missing current target | 0 | 0 | 0 | 0 | 0 | 0 | global, read-only |
| actual view-scope change | as documented | bounded expected fetch | bounded | bounded | bounded | bounded | sampled target style |

Also record root DOM identity, focus target, scrollTop and active opacity animations before/during/after ACK.

#### Krok 8.6 — final gate

~~~bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room check:api-hygiene
git diff --check
git status --short
~~~

Oczekiwany GREEN: commands exit 0; status contains only intended task files plus pre-existing unrelated dirty work. Do not mark Bramka B complete without the behavior table and fail-closed missing-registry evidence.