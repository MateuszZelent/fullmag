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

## RED → GREEN

Pierwszy focused RED: 12 failures / 10 pass — brak pełnego modelu, edytora i transakcji. Osobny RED paneli: 6/6 failures — brak Apply/Discard, konfliktu, duplicate i hydration parity.

Finalne bramki:

```text
focused Vitest: 8 suites, 219 passed
Python SceneDocument/canonical export: 2 passed
pnpm --dir apps/control-room typecheck: exit 0
pnpm --dir apps/control-room lint: exit 0
check:api-hygiene: exit 0
check:architecture-hygiene: exit 0
React Doctor --diff: exit 0, bez zgłoszeń
git diff --check: exit 0
```

Pythonowa regresja wykonuje UI-like create i patch przez `SceneDocument -> builder -> canonical Python -> ProblemIR` i porównuje pełne monitory bez dryfu.

## Szerszy suite i ograniczenia

Przypadkowo uruchomiony przez wrapper pełny frontend Vitest miał 537 zielonych plików i 5141 zielonych testów. Pozostały niezależne failures: pusty `scripts/smoke-viewport-2d.test.mjs`, dwa oczekiwania `ObjectVisualizationController` (`H_demag` oczekiwane, `m` otrzymane) oraz dwa sandboxowe `listen EPERM` w smoke transport. Ujawnione stare oczekiwanie `CrossSectionInspectorPanel` zaktualizowano do SSR-safe snapshotu i ponownie zakwalifikowano w focused suite.

Nie wykonano browser smoke ani runtime/production qualification; Task 5 zmienia warstwę authoring/transactions i testy kontraktu, nie renderer.
