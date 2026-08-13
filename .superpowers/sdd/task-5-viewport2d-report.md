# Raport SDD — Task 5: pełny edytor definicji monitora planarnego

## Status

Task 5 zaimplementowano na pełnym generated `PlanarMonitorSchema`. Wspólny kontrolowany `PlanarMonitorDefinitionEditor` obsługuje create i committed patch bez drugiego persisted modelu. Brak roszczeń browser/runtime/production qualification.

## Zakres i kontrakt

- draft przechowuje pełny canonical monitor oraz wyłącznie jawny stan UI: jednostkę display; preview jest wyprowadzany bezpośrednio z canonical frame;
- authored targety to dokładnie `domain`, `magnetic_domain`, `object`, `region`; `mesh_part` i `airbox` pozostają runtime sampling scopes zgodnie z physics 0970;
- edytor obejmuje identity, preset/arbitrary frame, origin/normal/u/v, normalization version, wszystkie extent i pełny union operatorów;
- canonical długości pozostają w SI, a origin/padding/explicit extent/slab thickness są konwertowane dla `m/mm/um/nm`;
- niedostępne targety/operatorzy są widoczne jako disabled z konkretnym reason, a availability diagnostics blokują Apply;
- wykonawcza dostępność targetów jest wyprowadzana fail-closed z aktywnego backendu oraz revisioned scene/region/FDM-membership/FEM-topology resources; authorability nie jest przedstawiana jako dowód wykonania;
- create, patch i duplicate używają wyłącznie typed `kernel.api.model.planarMonitors` facade oraz exact `scene_revision`;
- committed draft jest lokalny do Apply, Discard nie wysyła requestu, a `409` zachowuje draft i pokazuje kontrolowany reload;
- `useSyncExternalStore` otrzymał stały server snapshot, więc resource-local draft nie zmienia SSR/first-client snapshotu;
- zachowano istniejące selection/layout i active-monitor flow; nie dodano ownership Task 6 ani zmian rendererów, OpenAPI i public wire.

## Finalna weryfikacja po poprawce rereview

Finalny przepływ transient preview ma jedno canonical źródło: aktywny `PlanarMonitorDraft.monitor`. Adapter projekcji extentu przekazuje frame i pełny operator do istniejącego wejścia `PlanarMonitorFramePreviewLayer`; `slab_average` renderuje obie płaszczyzny graniczne i łączniki grubości. Istniejący store pozostaje wyłącznie fallbackiem resolved preview committed monitora, gdy nie ma aktywnego draftu. Nie zmieniono Field Map/Task 6 ownership ani publicznego API.

Duplicate wyprowadza jawne, collision-safe `new_id` i `new_name` z aktualnej revisioned collection i przekazuje je przez istniejący typed duplicate facade. Test obejmuje powtarzaną kolizję `_copy` i `_copy_2`.

Bramki wykonane po finalnym diffie:

```text
focused Vitest workspace/store/command/inspector/scene/layer: 6 suites, 163 passed
pnpm --dir apps/control-room typecheck: exit 0
targeted ESLint pozostałe 10 changed files --max-warnings=0: exit 0
check:api-hygiene: exit 0
check:architecture-hygiene: exit 0
git diff --check: exit 0
```

Targeted ESLint dla zmienionego `useViewport3DSceneModel.ts` reprodukuje dokładnie dwa baseline warningi zarówno na `HEAD`, jak i w worktree: unused `viewport3dStore` oraz `_commandState`. Nie dodano nowego warningu; nie wykonano drive-by cleanupu poza Task 5. Nowy unused `kernel` z `PlanarMonitorInspectorPanel` usunięto.

## Ograniczenia

Nie wykonano browser smoke ani runtime/production qualification. Zmiana renderera ogranicza się do istniejącej lekkiej warstwy transient geometry/thickness preview 3D; nie implementuje Field Map ani Task 6.
