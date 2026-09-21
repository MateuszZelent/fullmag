# P2-D — semanticzna historia authoringu

Data checkpointu: 21.09.2026. To jest ograniczony slice historii edycji dla
Control Room; nie zamyka całego P2-D.

## Zakres wykonany

`apps/control-room/src/kernel/authoring/AuthoringHistoryController.ts`
przechowuje przed i po pełnej scenie authoringu, a Undo/Redo wykonuje jako
revision-fenced `replace_scene` przez istniejące API transakcji. Po ACK wynik
przechodzi przez wspólny cache sceny i invalidation dependents. Jeżeli scena ma
nowszą rewizję niż wpis historii, operacja kończy się błędem i nie nadpisuje
obcej zmiany.

Komendy `workspace.undo` i `workspace.redo` są podpięte do command registry,
menu Edit, quick actions i skrótów `Ctrl+Z`/`Ctrl+Y`. Historia jest czyszczona
po zmianie sesji oraz po New/Open/Close projektu. Podstawowe mutacje geometrii
z Inspectora i komend lifecycle rejestrują jeden wpis po udanym commit; preview
draftu nie tworzy wpisu.

`apps/control-room/src/kernel/authoring/PendingFormRegistry.ts` utrzymuje
aktywny formularz Inspectora jako jeden wspólny wpis command context. Gating
Apply wymaga staged + dirty + valid i odrzuca formularz zablokowany lub już
aplikowany; Reset działa dla staged/live dirty. Komendy
`workspace.apply-inspector` i `workspace.reset-inspector` są dostępne w menu
Edit, quick actions i przez skrót Apply.

`apps/control-room/src/modules/inspector/InspectorHistoryBridge.ts` brackets
każdą staged sesję zarejestrowaną przez `useRegisterInspectorEditSession`
autorytatywnym odczytem sceny przed i po Apply. Zmiana rewizji tworzy dokładnie
jeden wpis historii, niezależnie od tego, czy Apply został wywołany z action
bara, dialogu zmiany selekcji, czy command registry. Tryby `liveViewport` i
`immediate` pozostają poza tym wrapperem, bo nie są staged transakcją sceny.

`apps/control-room/src/kernel/authoring/authoringHistoryMutation.ts` domyka
analogiczną granicę dla immediate mutations. Helper pobiera snapshot przed
mutacją, przekazuje `baseRevision` do API, rozpoznaje `committed_scene` lub
pełny SceneResource po ACK i zapisuje pojedynczy wpis dopiero po wzroście
rewizji. Komendy region/coupling oraz panele region/coupling, texture,
absorbing boundary, antenna, material fields, spin/transport delete, spin
interface delete i monitorów korzystają z tej ścieżki. ACK z samą rewizją
uruchamia drugi odczyt pełnej sceny; niepełny payload nie może stać się
snapshotem Undo.

## Dowody

- `AuthoringHistoryController.test.ts`: **3 passed** — undo/redo przez
  `replace_scene`, revision fence dla zewnętrznej zmiany i clear po zmianie
  dokumentu.
- `PendingFormRegistry.test.ts`: **4 passed** — rejestracja i aktualizacja
  aktywnego formularza, gating Apply/Reset, lock/applying guard oraz błąd
  callbacku.
- `InspectorHistoryBridge.test.ts`: **4 passed** — snapshot przed/po staged
  Apply, no-op/live/immediate bez wpisu i odporność na niedostępny snapshot.
- `authoringHistoryMutation.test.ts`: **4 passed** — base-revision fencing,
  cache fallback, no-op i refetch pełnej sceny po ACK z samą rewizją.
- `regionCommandContributions.test.ts`: **5 passed** — immediate region/coupling
  commands zapisują historię po revision-fenced ACK.
- `geometryLifecycleCommandContributions.test.ts`: **40 passed** po dodaniu
  rejestracji historii do komend create/delete.
- testy komend/menu/skrótów: **35 passed**; Undo/Redo i Apply/Reset są widoczne
  i mają wspólny stan enabled/disabled.
- połączona bramka Inspectora: **28 passed**; registry, command routing, menu
  i edit-session.
- macierz paneli Inspectora: **8 plików / 116 passed**; staged session hook,
  resource hydration, SSR stability, ACK i routing paneli.
- `pnpm --dir apps/control-room typecheck`: **PASS**.
- `pnpm --dir apps/control-room check:architecture-hygiene`: **PASS**.
- targeted ESLint: **PASS** (`--max-warnings=0`).

## Granice

To nie jest jeszcze pełny odbiór P2-D. Wrapper obejmuje staged sesje, a helper
immediate pokrywa wskazane komendy i panele, ale wieloetapowy material
authoring, pozostałe direct handlers i część ścieżek domenowych nadal wymagają
jawnego bracketingu. Brakuje pełnego zachowania selection/focus po Undo oraz
browserowego scenariusza Apply → Undo → Redo. Historia nie cofa uruchomionego
runu i nie zastępuje durable history po stronie backendu.
