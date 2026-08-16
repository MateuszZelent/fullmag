# Task 11 — Control Room racetrack (aktualna architektura)

## Zakres wykonany

- Explorer pozostaje oparty na kanonicznym `physics_graph.v1`. Dodano regresję
  racetracka z `J=0`: `Charge transport`, `Spin transport` i `Transport torque`
  zostają pod obiektem `racetrack`, a `HM/FM interface` pod gałęzią
  cross-object; nie powstaje globalny duplikat.
- Fallbackowe etykiety modułów grafu i tytuły dedykowanych tras Inspectorów
  używają tej samej terminologii racetracka.
- Każdy z czterech węzłów nadal przechodzi przez istniejące typowane refy
  `physics.current-transport`, `physics.spin-transport`,
  `physics.spin-interface` i `physics.spin-torque`; istniejące trasy prowadzą
  do oddzielnych paneli, bez importu między modułami.

## Hall trajectory / angle

Nie dodano panelu ani adaptera udającego dane. Aktualny `fullmag-api` nie
publikuje resource-first v2 trajektorii/Hall angle: brak routera, OpenAPI,
wygenerowanych typów, fasady i revisioned hooka. Istniejący zasób
`topological-charge` jest pojedynczym snapshotem obiektowym i nie jest
zamiennikiem zaakceptowanej serii, intervalu, regresji, niepewności ani reason
code. UI pozostaje fail-closed do czasu dostarczenia kanonicznego zasobu przez
Task 8; nie dodano endpointu, `fetch()`, WebSocket payloadu ani starego
`modules/analysis`.

## OpenAPI i smoke

Nie uruchomiono generowania OpenAPI, ponieważ nie zmieniono kontraktu backendu.
Planowa ścieżka `apps/control-room/e2e/solved-current-racetrack.spec.ts` nie
istnieje w obecnej aplikacji; obecnym runtime smoke transportu jest
`apps/control-room/scripts/smoke-transport-authoring-ui-runtime.mjs`.

## Weryfikacja

- RED (zamierzone): dodano asercje dla obiektowego grafu `J=0` i terminologii
  tras Inspectorów przed zmianą implementacji.
- `corepack pnpm --dir apps/control-room test -- physicsGraphTree.test.ts` —
  zablokowane przed uruchomieniem testu: brak `apps/control-room/node_modules`,
  `vitest: not found`.
- `corepack pnpm --dir apps/control-room test -- inspectorRegistry.test.tsx`
  — ten sam blocker (`vitest: not found`).
- `corepack pnpm --dir apps/control-room typecheck` — zablokowane zanim
  TypeScript uruchomił sprawdzanie: skrypt odtwarza `next-env.d.ts`, lecz
  przypisany worktree jest w tej operacji zamontowany read-only (`EROFS`);
  ostrzeżenie pnpm potwierdza też brak lokalnego `node_modules`.
- `git diff --check` — bez diagnostyki białych znaków dla plików Task 11.

## Granica kwalifikacji

Zmiana pokrywa kontrakt prezentacji i selekcji Control Room, nie jest dowodem
wykonania GPU, publikacji artefaktów ani kwalifikacji fizycznej racetracka.
