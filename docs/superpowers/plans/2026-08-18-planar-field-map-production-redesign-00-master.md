# Produkcyjny redesign mapy pola 2D — nadrzędny plan wdrożenia

> **Dla agentów wykonawczych:** WYMAGANY SUB-SKILL: użyj `subagent-driven-development` (zalecane) albo `executing-plans`. Wykonuj zadania kolejno, zaczynaj zmianę zachowania od testu RED i kończ każde zadanie osobnym review.

**Cel:** Dostarczyć produkcyjny widok pola 2D z prawdziwymi danymi solvera, kartezjańskimi osiami zależnymi od płaszczyzny, poziomą legendą oraz niezależnymi ustawieniami wireframe Airboxa, obiektów i części siatki bez tworzenia drugiego rejestru targetów.

**Architektura:** Backend próbkuje jeden aktywny planar source i jeden aktywny scope przez istniejący `PlanarSamplingEngine`. Tożsamości Airboxa, obiektów i części pochodzą wyłącznie z `VisualizationStateResource.targets`; `planar.target_overrides` jest rzadką, prezentacyjną listą stylów wireframe z globalnym `planar.wireframe_style` jako fallbackiem. Field-map pozostaje jednym rasterem i jednym stosem canvasów, a UI rozwiązuje efektywny styl aktywnego targetu przez dokładne `(scope, scope_id)`.

**Tech Stack:** Rust, Axum, Serde, Utoipa/OpenAPI v2, TypeScript 5.8, React 19, Next.js 16, Canvas 2D, Web Worker, Vitest, Playwright i tokeny CSS `--fm-*`.

## Global Constraints

- Źródłami prawdy są `docs/adr/0020-planar-field-map-and-monitor.md`, `docs/specs/frontend-v2/15-viewport-2d-module.md`, `docs/adr/0011-resource-first-api.md` i `docs/specs/resource-first-control-room-api-v2.md`.
- Nie twórz drugiego planar target union, kolekcji pełnych profili per target, osobnej listy z-order, osobnego aktywnego targetu ani równoległego registry.
- `visualization.targets` jest jedynym canonical registry; etykieta, aktualny Explorer selection i pozycja w tablicy nie są tożsamością.
- Pierwszy kontrakt override dopuszcza tylko `airbox | object | part`; region, full, FDM domain i native layer pozostają nieobsługiwane do jawnego rozszerzenia registry/OpenAPI.
- `planar.target_overrides` przechowuje wyłącznie `{scope, scope_id, wireframe_style}`; quantity, component, range, raster opacity, layer visibility i sampling policy pozostają globalnym profilem planar.
- `planar.wireframe_style` pozostaje globalnym fallbackiem; usunięcie wpisu override przywraca fallback bez kopiowania wartości.
- PATCH pomijający `target_overrides` nie zmienia listy; PATCH zawierający listę zastępuje ją atomowo; istniejący frontendowy sync owner serializuje mutacje i uzgadnia odpowiedź z rewizją zasobu.
- Wpis nieobecny w późniejszej rewizji registry pozostaje zapisany jako dormant, jest ignorowany przy renderowaniu, emituje diagnostic i reaktywuje się tylko po powrocie dokładnie tej samej identity.
- UI nie usuwa wpisów dormant, nie remapuje po label/suffix i nie nadpisuje niezwiązanych wpisów podczas edycji jednego targetu.
- Style-only PATCH zmienia visualization-state revision/ETag i stylowany `render.png`, ale nie zmienia planar `sample_token` ani ETagów scalar/vector/mask/mesh-overlay.
- Publiczne zasoby pola v2 korzystają z istniejącego `resolve_current_spatial_field`; nie dodawaj drugiego resolvera bez osobnego RED.
- Niespójność payloadu, gridu, topology, generation lub revision kończy się jawnym 409/422; prawidłowe jednorodne zero pozostaje legalnym `ready`.
- Przekroje `xy`, `xz`, `yz` pokazują osie świata `x/y`, `x/z`, `y/z`; użytkownik nie widzi `u/v` dla osi kanonicznych.
- Przekrój ukośny pokazuje `x′/y′` i wektory kierunkowe w bazie świata.
- Legenda jest pozioma, poza obszarem danych i obsługuje `auto`, `manual`, `symmetric`, `uniform`, `stale` i `error`.
- Fizyczny aspect ratio wynika z `frame.bounds_uv_m` i nie jest deformowany przez resize.
- Jeden mount ma jeden base canvas, jeden overlay canvas, jeden worker i jeden `ResizeObserver`; idle nie utrzymuje ciągłego RAF.
- Wszystkie klasy CSS zaczynają się od `fm-` i konsumują tokeny `--fm-*`.
- Frontend nie buduje ręcznie endpointów `/v2`; używa generated transport, fasady i resource hooks.
- Nie obniżaj rozdzielczości, vector budget ani jakości jako obejścia wydajności.
- Nie dotykaj niezwiązanych dirty changes. Przed każdym commitem uruchom osobno `git diff --cached --name-only`.

---

## 1. Stan wykonania potwierdzony commitami

| Etap | Status | Dowód |
|---|---|---|
| RED parzystej liczby warstw FDM | zakończony | `b1464b481` |
| Snap default slice do środka komórki i walidacja overflow | zakończony | `a750062ca`, `d47029f97` |
| Zgodność source meta/vector/planar i legalne zero | zakończony | `48ed0c3f6` |
| ADR/spec: canonical registry plus sparse overrides | zakończony | `b01cbb807` |
| Czysty model osi kartezjańskich | zakończony | `2a82ae803` |
| Backend schema/API override, exact identity, dormant/reactivation | zakończony | `2fb09e817` |
| Generated OpenAPI JSON i TypeScript types | zakończony | `5aafbe2cd` |
| Frontend helper/effective style/Inspector | oczekuje | brak commitu |
| Plot frame, pozioma legenda, renderer integration | oczekuje | brak commitu |
| Browser i live API qualification | oczekuje | brak raportu produkcyjnego |

Nie uznawaj aktualnych niestage'owanych zmian UI za zakończone. Checkbox może zostać zaznaczony dopiero po wąskim commicie, zielonym focused teście i review.

## 2. Pakiet planów i kolejność zależności

1. `2026-08-18-planar-field-map-production-redesign-01-backend-api.md`
   - zachowuje ukończony fix danych;
   - dokumentuje ukończony schema/API override;
   - domyka ETag identity, persistence i bezpośrednią bramkę API.
2. `2026-08-18-planar-field-map-production-redesign-02-state-data-plane.md`
   - konsumuje generated types;
   - dodaje frontendowy exact-key resolver i sparse replacement helper;
   - przełącza Inspector i efektywny styl bez zmiany data query.
3. `2026-08-18-planar-field-map-production-redesign-03-renderer-qualification.md`
   - integruje commitowany model osi;
   - buduje plot frame, legendę i readout;
   - kwalifikuje API, styl targetów, lifecycle, accessibility i 3D recovery.

Nie rozpoczynaj zadań zależnych od brakującej bramki. Backend ETag/persistence może być rozwijany równolegle z czystym frontendowym modelem osi, ale Inspector nie może wysyłać nowego PATCH przed wygenerowaniem i zaadaptowaniem contract types.

## 3. Mapa odpowiedzialności

### Backend/API

- `crates/fullmag-api/src/planar_sampling/source.rs`: fizyczne położenie default FDM slice.
- `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`: sample identity i data-plane ETags; bez presentation-only identity.
- `crates/fullmag-api/src/schemas/visualization_state.rs`: `PlanarTargetPresentationOverrideState`, global fallback i sparse list.
- `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`: validation, exact registry membership, replacement PATCH, dormant diagnostics i effective render style.
- `crates/fullmag-api/src/session_persistence.rs`: restore schema bez utraty overrides.
- `crates/fullmag-api/src/router_v2/tests.rs`: endpointowe RED/GREEN i ETag matrix.
- `apps/control-room/src/kernel/api/generated/openapi-v2.json` oraz `openapi-v2-types.ts`: generowane źródła kontraktu; nie edytować ręcznie.

### Frontend state i data plane

- `apps/control-room/src/kernel/visualization/planarTargetPresentation.ts`: exact key, registry lookup, fallback, dormant i sparse replacement.
- `apps/control-room/src/kernel/visualization/planarPresentationProjection.ts`: canonical/optimistic projection bez utraty `target_overrides`.
- `apps/control-room/src/modules/inspector/visualization/VisualizationViewContext.ts`: mapowanie wyłącznie obsługiwanych selections do exact registry identity.
- `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx`: jeden owner patchy i stabilny Inspector.
- `apps/control-room/src/modules/inspector/visualization/PlanarPresentationSections.tsx`: edycja effective target wireframe oraz akcja „Use global”.
- `apps/control-room/src/modules/field-map/model/fieldMapDataPlan.ts`: pojedynczy canonical query; style nigdy nie wchodzą do key.
- `apps/control-room/src/kernel/resources/planarFieldResources.ts`: zachowanie linków, tokenu, rewizji i ETagów z meta.

### Renderer i kwalifikacja

- `apps/control-room/src/modules/field-map/model/planarAxisModel.ts`: commitowany model osi.
- `apps/control-room/src/modules/field-map/model/planarLegendModel.ts`: jawne stany legendy.
- `apps/control-room/src/modules/field-map/renderer/PlanarAxes.tsx`: SVG/DOM chrome dla osi.
- `apps/control-room/src/modules/field-map/components/PlanarColorLegend.tsx`: pozioma legenda.
- `apps/control-room/src/modules/field-map/FieldMapModule.tsx`: pojedynczy data plan i effective style aktywnego targetu.
- `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx`: jeden lifecycle canvas/worker/observer.
- `apps/control-room/src/design/styles/field-map.css`: grid plotu, osie, legenda, responsive/accessibility.
- `apps/control-room/scripts/smoke-viewport-2d.mjs`: live API, browser, memory i screenshot evidence.

## 4. Zamrożone interfejsy i właściciele tożsamości

Backendowy kontrakt, już opublikowany:

~~~rust
pub struct PlanarTargetPresentationOverrideState {
    pub scope: VisualizationScopeKind,
    pub scope_id: String,
    pub wireframe_style: PlanarWireframeStyleState,
}

pub struct PlanarVisualizationState {
    pub wireframe_style: PlanarWireframeStyleState,
    pub target_overrides: Vec<PlanarTargetPresentationOverrideState>,
}
~~~

Frontend nie publikuje drugiego modelu targetu. Jedyną tożsamością przekazywaną między selection, Inspectorem i rendererem jest istniejący `VisualizationTargetRef` z `ObjectVisualizationController.ts`. Jedynym opisem wpisu registry jest generated `VisualizationTargetRegistryEntry`.

~~~typescript
import type { components } from "../api/generated/openapi-v2-types";
import type { VisualizationStateResource } from "../api/apiTypes";
import type { VisualizationTargetRef } from "./ObjectVisualizationController";
import {
  resolveVisualizationTargetFromSelection,
  visualizationStateScopeIdForTarget,
  visualizationTargetKey,
} from "./ObjectVisualizationController";

type PlanarState = components["schemas"]["PlanarVisualizationState"];
type PlanarTargetOverride =
  components["schemas"]["PlanarTargetPresentationOverrideState"];
type VisualizationTargetRegistryEntry =
  components["schemas"]["VisualizationTargetRegistryEntry"];
type VisualizationTargetRegistryState =
  components["schemas"]["VisualizationTargetRegistryState"];

export function findPlanarRegistryEntry(
  targets: VisualizationStateResource["targets"],
  target: VisualizationTargetRef,
): VisualizationTargetRegistryEntry | null;

export function resolveEffectivePlanarWireframe(
  planar: PlanarState,
  targets: VisualizationStateResource["targets"],
  target: VisualizationTargetRef | null,
): Readonly<{
  style: PlanarState["wireframe_style"];
  source: "global" | "override";
  registryEntry: VisualizationTargetRegistryEntry | null;
  inactive: boolean;
}>;

export function replacePlanarTargetOverride(
  current: readonly PlanarTargetOverride[],
  target: VisualizationTargetRef,
  style: PlanarTargetOverride["wireframe_style"] | null,
): PlanarTargetOverride[];
~~~

Obowiązkowa kolejność guardów w każdym konsumencie `targets`:

~~~typescript
const selectedTarget = resolveVisualizationTargetFromSelection(selection);

if (!selectedTarget) {
  return {
    mode: "read-only" as const,
    reason: "No canonical visualization target is selected.",
    effectiveStyle: planar.wireframe_style,
    registryEntry: null,
    mayPatch: false,
  };
}

if (!isEditablePlanarTarget(selectedTarget)) {
  return {
    mode: "read-only" as const,
    reason: "This selection has no editable planar presentation target.",
    effectiveStyle: planar.wireframe_style,
    registryEntry: null,
    mayPatch: false,
  };
}

const targets = visualization.data?.targets;
if (!targets) {
  return {
    mode: "read-only" as const,
    reason: "Visualization target registry is unavailable.",
    effectiveStyle: planar.wireframe_style,
    registryEntry: null,
    mayPatch: false,
  };
}

const registry: NonNullable<VisualizationStateResource["targets"]> = targets;
const registryEntry = findPlanarRegistryEntry(registry, selectedTarget);
if (!registryEntry) {
  return {
    mode: "read-only" as const,
    reason: "The selected target is absent from the current visualization target registry.",
    effectiveStyle: planar.wireframe_style,
    registryEntry: null,
    mayPatch: false,
  };
}
~~~

`NonNullable<VisualizationStateResource["targets"]>` wolno zastosować wyłącznie po runtime presence guardzie. Zabronione są casty `as NonNullable<...>`, wartości domyślne udające pusty registry oraz lookup przed guardem. Przy braku registry wszystkie sparse overrides są nieaktywne dla renderera; UI używa globalnego fallbacku, pokazuje jawny read-only reason i emituje zero PATCH.

`replacePlanarTargetOverride` korzysta z `visualizationStateScopeIdForTarget(target)` i pól istniejącego `VisualizationTargetRef`. Zachowuje kolejność i wszystkie niezwiązane, również dormant, wpisy. `style=null` usuwa tylko exact entry. Nowy wpis jest dopisywany na końcu; kolejność nie jest z-orderem i nie ma znaczenia kompozycyjnego.

## 5. Zakazane założenia usunięte z poprzedniego planu

- Brak równoległego planar target union obejmującego domain, region i mesh part.
- Brak kolekcji pełnych profili kopiujących quantity, component, range i layers per target.
- Brak oddzielnej listy target z-order i renderowania wielu niezależnych scalar payloadów.
- Brak per-target resource controller i concurrent target budget.
- Brak osobnego aktywnego targetu sterującego viewportem.
- Brak migracji globalnego profilu do sztucznego profilu `domain`.
- Brak założenia, że region jest legalnym planar override.
- Brak zmiany sample tokenu po zmianie stylu.
- Brak użycia Explorer selection jako data-plane identity.

## 6. Bramka A — backend/API

- [x] Default FDM slice dla parzystej liczby warstw trafia w środek niższej komórki.
- [x] Frakcje `0`, `0.5`, `1`, płaszczyzny `xy/xz/yz` i walidacja overflow mają testy.
- [x] Meta/vector/planar używają tego samego bieżącego źródła `m`.
- [x] Legalne pole zerowe nie jest traktowane jako błąd.
- [x] Schema/API publikuje sparse `target_overrides`, exact registry validation i dormant diagnostics.
- [x] Generated OpenAPI JSON/types zawiera `PlanarTargetPresentationOverrideState`.
- [ ] Style-only PATCH pozostawia byte-identical sample token i data-plane ETags.
- [ ] Style-only PATCH zmienia visualization-state ETag i właściwy styled `render.png` ETag.
- [ ] Persisted restore zachowuje global fallback, active overrides i dormant overrides.
- [ ] Live SP4 API raportuje `nonzero_count > 0` i zgodne min/max/revisions.

## 7. Bramka B — frontend state/data plane

- [ ] Exact `(scope, scope_id)` rozróżnia Airbox, dwa obiekty i dwie części o podobnych labelach.
- [ ] Override jest stosowany tylko, gdy identity nadal istnieje w canonical registry.
- [ ] Dormant entry jest zachowany, nieaktywny i widoczny diagnostycznie.
- [ ] Edycja Airboxa zachowuje byte-identical object/part/dormant entries.
- [ ] Edycja obiektu zachowuje Airbox i global fallback.
- [ ] Usunięcie exact entry natychmiast przywraca global fallback.
- [ ] Style-only optimistic update nie zmienia data query i wykonuje zero meta/scalar requestów.
- [ ] Pending/ACK nie remountuje Inspectora, nie resetuje focus/scroll/draft i nie dimuje niezwiązanych kontrolek.
- [ ] Unsupported region selection pokazuje read-only reason i nie emituje PATCH.
- [ ] Brak ręcznie zbudowanych `/v2` URL poza warstwą API.

## 8. Bramka C — renderer/UX/produkcja

- [ ] `xy/xz/yz` pokazują właściwe osie świata i współrzędną normalną.
- [ ] Oblique pokazuje `x′/y′` i oba direction vectors.
- [ ] Ticki nie kolidują przy 320, 640 i 1200 px; fizyczny aspect ratio error jest mniejszy niż 0.5%.
- [ ] Legenda jest pozioma i poprawna dla uniform/symmetric/stale/error.
- [ ] Airbox i obiekt zachowują różne style po sekwencji Airbox → Object → Airbox.
- [ ] Przełączenie targetu nie tworzy drugiego raster requestu poza tym, który wynika z faktycznej zmiany `view_scope`.
- [ ] Jeden base canvas, overlay canvas, worker i observer pozostają ograniczone po 100 cyklach.
- [ ] Idle nie generuje ciągłego RAF.
- [ ] Po powrocie do 3D `gl.isContextLost() == false`, a drawing buffer ma dodatnie wymiary.
- [ ] SP4 browser range zgadza się z bezpośrednio zdekodowanym FMVP.
- [ ] Mocha i Latte przechodzą kontrast, focus ring, zoom 200% i screenshot review.

## 9. Rollback bez utraty ustawień — konkretny owner i test

Rollback jest jawnie własnością manifestu modułu, nie ad-hoc warunkiem w rendererze. Plan dodaje build-time flagę `NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE` o wartościach `scientific | legacy`.

**Pliki:**

- Create: `apps/control-room/src/modules/field-map/fieldMapExperience.ts`
- Create: `apps/control-room/src/modules/field-map/fieldMapExperience.test.ts`
- Modify: `apps/control-room/src/modules/field-map/manifest.ts`
- Modify: `apps/control-room/src/modules/field-map/manifest.test.ts`
- Create: `apps/control-room/src/modules/field-map/LegacyFieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`

Owner flagi:

~~~typescript
export type FieldMapExperience = "scientific" | "legacy";

export function resolveFieldMapExperience(
  value: string | undefined,
): FieldMapExperience {
  return value === "legacy" ? "legacy" : "scientific";
}
~~~

Owner wyboru implementacji:

~~~typescript
component: () =>
  resolveFieldMapExperience(
    process.env.NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE,
  ) === "legacy"
    ? import("./LegacyFieldMapModule")
    : import("./FieldMapModule"),
~~~

`modules/registry.ts` nadal rejestruje dokładnie jeden `fieldMapManifest`. Flaga nie zmienia ID modułu, persisted layoutu ani visualization state. `LegacyFieldMapModule.tsx` jest jawnie dodawanym compatibility rendererem bazującym na zachowanym static PNG/export workflow; plan nie twierdzi, że taki moduł już istnieje.

RED przed implementacją:

~~~typescript
it.each([
  [undefined, "scientific"],
  ["scientific", "scientific"],
  ["legacy", "legacy"],
  ["unexpected", "scientific"],
])("resolves %s to %s", (input, expected) => {
  expect(resolveFieldMapExperience(input)).toBe(expected);
});

it("switches renderer without issuing a visualization patch", async () => {
  const queuePatch = vi.fn();
  const stateBefore = fixtureVisualizationState({
    targetOverrides: [airboxOverride, objectOverride, dormantPartOverride],
  });

  const first = renderFieldMapManifest({ experience: "scientific", queuePatch });
  first.unmount();
  renderFieldMapManifest({ experience: "legacy", queuePatch });

  expect(queuePatch).not.toHaveBeenCalled();
  expect(readVisualizationState()).toEqual(stateBefore);
});
~~~

Oczekiwany RED: test modułu nie może zaimportować `fieldMapExperience.ts`, a manifest zawsze ładuje jedną obecną implementację. Minimalny GREEN: dodać resolver flagi, dwa lazy importy i compatibility component bez efektu zapisującego state. Nie przenosić stanu do flagi.

Weryfikacja:

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/fieldMapExperience.test.ts \
  src/modules/field-map/manifest.test.ts \
  src/modules/field-map/FieldMapModule.test.tsx
NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=legacy \
  pnpm --dir apps/control-room build:webpack
NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=scientific \
  pnpm --dir apps/control-room build:webpack
~~~

Oczekiwany GREEN: oba buildy kończą się kodem 0; test potwierdza ten sam manifest ID, zero PATCH podczas switchu i identyczny ordered JSON global fallback + active overrides + dormant override.

Rollback nie może:

- usuwać `planar.target_overrides` z persisted state;
- kopiować override do globalnego fallbacku;
- usuwać wpisów dormant;
- cofać `PlanarMonitor`, `ProblemIR` lub canonical Python;
- włączać dual-write starego aliasu;
- usuwać testów exact identity i ETag isolation.

## 10. Komendy końcowe

~~~bash
cargo test -p fullmag-api planar
cargo test -p fullmag-api visualization_planar_target_overrides
pnpm --dir apps/control-room generate:api
git diff --exit-code -- apps/control-room/src/kernel/api/generated
pnpm --dir apps/control-room exec vitest run src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room exec vitest run src/kernel/visualization/planarTargetPresentation.test.ts
pnpm --dir apps/control-room exec vitest run src/kernel/resources/planarFieldResources.test.ts
pnpm --dir apps/control-room exec vitest run src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx
pnpm --dir apps/control-room exec vitest run src/modules/field-map
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room smoke:viewport-2d
~~~

## 11. Definicja ukończenia

Redesign jest ukończony dopiero po zapisaniu dowodów dla bramek A, B i C. Zielony typecheck, pojedynczy screenshot, sam backend schema albo sam niezerowy endpoint nie są kwalifikacją produkcyjną. Każde twierdzenie o API wymaga zdekodowanego payloadu i ETag/revision evidence, a każde twierdzenie o UI wymaga testu komponentu oraz realnego browser smoke.
