# Plan implementacji: Naprawa przepływu siatkowania FEM i interaktywny poradnik gotowości siatki (FEM Mesh Readiness Guide)

**Data:** 2026-10-13  
**Specyfikacja źródłowa:** [`docs/superpowers/specs/2026-10-13-fem-mesh-procedure-and-readiness-guide-design.md`](../specs/2026-10-13-fem-mesh-procedure-and-readiness-guide-design.md)  
**Worktree:** `C:\git\fullmag\worktrees\fem-mesh-guide-20261013` (`codex/fem-mesh-guide-20261013`)

---

## Zadanie 1: Czysty model domenowy i testy jednostkowe poradnika gotowości siatki FEM (`femMeshReadinessGuide`)

### Zmieniane / nowe pliki
- `apps/control-room/src/modules/inspector/panels/mesh-guide/femMeshReadinessGuide.ts` (nowy)
- `apps/control-room/src/modules/inspector/panels/mesh-guide/femMeshReadinessGuide.test.ts` (nowy)

### Zakres zmian
1. Zdefiniowanie typów:
   - `FemMeshGuideStepStatus = "complete" | "recommended" | "action-required" | "stale" | "building" | "failed"`
   - `FemMeshGuideStepId = "geometry" | "materials" | "airbox-domain" | "object-sizing" | "shared-domain-build" | "quality-gates"`
   - `FemMeshGuideAction` (nawigacja do węzła Explorer / Inspector lub wywołanie komendy `mesh.build-shared-domain`).
   - `FemMeshReadinessGuideModel` (ogólny status, licznik ukończonych kroków, `nextStep`, lista 6 kroków z parametrami i podpowiedziami).
2. Implementacja czystej funkcji `buildFemMeshReadinessGuide(input)`:
   - Analiza obiektów z `scene` i błędów z `geometryValidation`.
   - Sprawdzenie przypisania materiałów (`material_id`) dla obiektów sceny.
   - Analiza `universeMeshPolicy` (`config` vs `effective_config`: `airbox_mode`, `padding`, `airbox_h_max`, `airbox_h_min`, `airbox_growth_rate`).
   - Analiza obiektów pod kątem polityk `object_configs` (z `meshing/semantics`) oraz detekcja cienkich warstw (`thin-film` aspect ratio, np. $\min(d_x, d_y, d_z) / \max(d_x, d_y, d_z) \le 0.15$) sugerująca `swept_prism` lub jawny `h_max`.
   - Rozróżnienie zbudowanej siatki `study_domain` (`summary.element_count > 0`, `manifest.source_revision === scene.revision`) od izolowanych siatek obiektów (`object_mesh`) lub nieaktualnej siatki (`stale`).
   - Ocena `qualityGates` (`pass` / `warn` / `fail`).
3. Dodanie wyczerpujących testów jednostkowych w `femMeshReadinessGuide.test.ts`.

### Weryfikacja
- `pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/mesh-guide/femMeshReadinessGuide.test.ts`

---

## Zadanie 2: Komponent UI `FemMeshReadinessGuideCard` i hook `useFemMeshReadinessGuide` oraz style CSS

### Zmieniane / nowe pliki
- `apps/control-room/src/modules/inspector/panels/mesh-guide/useFemMeshReadinessGuide.ts` (nowy)
- `apps/control-room/src/modules/inspector/panels/mesh-guide/FemMeshReadinessGuideCard.tsx` (nowy)
- `apps/control-room/src/design/styles/inspector-mesh.css` (rozszerzenie o klasy `.fm-mesh-guide*`)

### Zakres zmian
1. Implementacja hooka `useFemMeshReadinessGuide` pobierającego dane z istniejących hooków zasobów (`useModelSceneResource`, `useGeometryValidationResource`, `useMeshUniversePolicyResource`, `useMeshSharedDomainPolicyResource`, `useMeshSemanticsResource`, `useMeshSummaryResource`, `useMeshManifestResource`, `useActiveMeshBuildResource`, `useMeshQualityGatesResource`).
2. Implementacja komponentu `FemMeshReadinessGuideCard`:
   - Wariant pełny (`variant="full"` dla `MeshDetailsPanel`) oraz kompaktowy (`variant="compact"` dla `AirboxMeshParametersPanel`, `ObjectMeshPolicyPanel`, `ObjectGeneralPanel`) z możliwością rozwinięcia pełnej listy kroków.
   - Wyświetlanie paska postępu (`completedSteps / totalSteps`), odznaki statusu, wyróżnionego boksu **Next Recommended Action** oraz przycisków nawigacyjnych (ustawiających `kernel.selection.select(...)`) i przycisku **Build Shared-Domain Mesh** (`kernel.commands.execute("mesh.build-shared-domain")`).
3. Dodanie stylów `.fm-mesh-guide*` w `inspector-mesh.css` z zachowaniem tokenów `--fm-*` i zakazu animacji `opacity` w Inspectorze.

### Weryfikacja
- `pnpm --dir apps/control-room typecheck`

---

## Zadanie 3: Naprawa cache invalidation po zapisie polityk siatki oraz subskrypcji selekcji na wstążce `Mesh`

### Zmieniane / nowe pliki
- `apps/control-room/src/modules/ribbon/RibbonModule.tsx`
- `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.ts`
- `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.test.ts` (nowy)
- `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/RegionMeshPolicyPanel.tsx`

### Zakres zmian
1. **`RibbonModule.tsx`**:
   - Rozszerzenie selektora `useSelectionSelector` o `activeTab === "mesh"`, aby przyciski na zakładce `Mesh` (`Build`, `Object Report`) reagowały natychmiast na zmianę zaznaczonego obiektu w Explorerze.
2. **Natychmiastowa aktualizacja zasobów po `replacePolicy` (`AirboxMeshParametersPanel.tsx`, `ObjectMeshPolicyPanel.tsx`, `RegionMeshPolicyPanel.tsx`)**:
   - Po udanym `PUT` zapisanie zwróconego zasobu bezpośrednio do `sharedResourceRuntimeStore.updateData(key, next, next.revision)` oraz wywołanie `.refetch()` na zależnych zasobach (`semantics`, `scene`), co rozwiązuje błąd `mesh_revision === 0` przed pierwszym buildem siatki.
3. **Ulepszenie `airboxMeshPolicyDraft.ts` i `AirboxMeshParametersPanel.tsx`**:
   - Dodanie helpera `draftFromEffectiveUniverseMeshPolicy(resource)` pozwalającego wypełnić formularz wartościami efektywnymi (`effective_config`) lub zbudować poprawny payload `MeshConfigRequest` na bazie `effective_config`, gdy użytkownik klika **Apply & Build Mesh** / **Apply Effective Defaults** przy `config === null`.
   - Zamiana pola `Airbox mode` z surowego `<input>` na `<select className="fm-inspector-select">` z opcjami `auto (bounding-box padding)` oraz `manual (explicit size & center)`.
   - Wyraźne oznaczenie sekcji `Auto Padding` vs `Manual Box Geometry` w zależności od wybranego trybu `airboxMode` oraz pokazywanie aktualnych wartości `effective_config` jako placeholderów i podpowiedzi.

### Weryfikacja
- `pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/airbox/airboxMeshPolicyDraft.test.ts`

---

## Zadanie 4: Integracja poradnika i brakujących kontrolek w `MeshDetailsPanel`, `ObjectMeshPolicyPanel` i `ObjectGeneralPanel`

### Zmieniane / nowe pliki
- `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/mesh-details/SharedDomainMeshPolicySection.tsx` (nowy)
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx`

### Zakres zmian
1. **`MeshDetailsPanel.tsx` + `SharedDomainMeshPolicySection.tsx`**:
   - Osadzenie `FemMeshReadinessGuideCard` (`variant="full"`) na górze widoków `model:mesh`, `model:mesh:shared-domain` oraz `model:mesh:build`.
   - Dodanie sekcji `Shared-Domain Mesh Defaults` (`SharedDomainMeshPolicySection.tsx`) pozwalającej odczytać i zapisać globalne parametry wspólnej siatki (`h_max`, `h_min`, `growth_rate`, `mesh_order`, `gmsh_3d_algorithm`) przez `useMeshSharedDomainPolicyResource` i `api.meshing.sharedDomain.replacePolicy`.
2. **`ObjectMeshPolicyPanel.tsx`**:
   - Osadzenie `FemMeshReadinessGuideCard` (`variant="compact"`).
   - Gdy `"Use object policy"` (`draft.present`) jest wyłączony, wyświetlenie czytelnego banera informującego o dziedziczonych wartościach efektywnych (`effective_config.h_max`, `h_min`, `growth_rate`, `thin_film_strategy`) z przyciskiem **`Enable Object Override`**.
   - Dodanie bezpośredniego przycisku **`Build Shared-Domain Mesh`** obok akcji dla pojedynczego obiektu (`Build Object Mesh`), z objaśnieniem różnicy między podglądem obiektu a siatką dla solvera.
3. **`ObjectGeneralPanel.tsx`**:
   - W trybie FEM (`sessionMode === "fem"`) wyświetlenie na dole panelu obiektu kompaktowej karty `FemMeshReadinessGuideCard` (`variant="compact"`), która po utworzeniu/edycji geometrii od razu prowadzi użytkownika do konfiguracji siatki obiektu (`Configure Object Mesh`) lub budowy siatki domeny.

### Weryfikacja
- `pnpm --dir apps/control-room typecheck`
- `pnpm --dir apps/control-room lint`
- `pnpm --dir apps/control-room check:api-hygiene`
- `pnpm --dir apps/control-room check:architecture-hygiene`
- `pnpm --dir apps/control-room test -- --run` (dla nowych i zmienionych modułów)
