# 08. Skonsolidowana mapa napraw

## Aktualizacja reaudytu 2026-07-14

Pierwotne fazy poniżej opisują historyczny program F3D-001–F3D-028. Według
bieżącej macierzy 26 z tych findings jest zamkniętych w pierwotnym zakresie, a
F3D-003 i F3D-013 są częściowe. Aktualny program naprawczy obejmuje również
F3D-029–F3D-032 i ma trzy równoległe tory:

| Tor | Kolejność | Findings | Warunek wyjścia |
|---|---:|---|---|
| P0 — identity/correctness | 1 | F3D-032, F3D-003 | jeden katalog semantic target → Explorer node → carriers; wszystkie generation IDs bez utraty `u64` |
| P0 — renderer/runtime | 2 | F3D-030, F3D-029 | brak pętli React; surface i vectors publikowane niezależnie i w budżecie na reprezentatywnym FEM |
| P1 — sync/evidence | 3 | F3D-013, F3D-031 | terminalny 4xx bez retry loop; zgodny scenariusz CoFeB i pełny artifact również pre-canvas |

Zależności:

1. Najpierw recorder musi zbierać console/pageerror przed mountem, aby naprawy
   F3D-030 nie odbywały się bez śladu.
2. F3D-032 musi ustalić kanoniczne targety i carriery przed optymalizacją
   F3D-029; inaczej można przyspieszyć podwójny lub błędnie przypisany pass.
3. F3D-029 wymaga rozdzielenia publikacji surface od vector work i nie może być
   „naprawione” obniżeniem jakości, ukryciem warstwy ani zmniejszeniem domyślnej
   gęstości.
4. Reprezentatywny gate F3D-031 jest końcowym dowodem, ale jego świeży przebieg
   wymaga najpierw usunięcia niezależnej blokady materializacji mesha CoFeB.
5. Niezacommitowane poprawki Airbox registry pozostają implementacją w toku:
   lokalne testy przechodzą, lecz selection nadal może zapisać ID carriera
   zamiast istniejącego węzła Explorera.

Poniższe fazy zachowano jako historię i szczegółową mapę właścicieli. Nie należy
interpretować ich list „Findings zamykane” jako bieżącego statusu.

## Zasada kolejności

Nie należy zaczynać od kosmetyki Inspektora ani od obniżania jakości renderu.
Najpierw trzeba zamknąć zgodność danych i target identity, ponieważ wszystkie
pozostałe kontrolki zależą od odpowiedzi na dwa pytania:

1. czy bieżąca geometria i pole są wzajemnie zgodne;
2. jaki canonical target faktycznie jest konfigurowany i renderowany.

## Faza 0 — testy blokujące dalsze regresje

Przed zmianą implementacji dodać czerwone testy dla obecnych błędów:

| Test | Findings |
|---|---|
| scene r13 + manifest source r12 -> stale | F3D-001 |
| stale topology -> zero field requests/passes | F3D-002 |
| różne domain generation -> field mismatch | F3D-003 |
| FDM late build/error nie zwraca starego modelu | F3D-004 |
| geometry-only part respektuje part override i projection | F3D-005 |
| backend effective target entry wygrywa | F3D-006 |
| FDM vectors-only i points-only renderują niezależnie | F3D-008 |
| region quantity/style-only pozostaje hidden | F3D-009 |
| airbox style round-trip i atomowy reset | F3D-010 |
| Inspector ACK/refetch/remote update converges | F3D-013 |
| hidden target blokuje pass commands | F3D-014 |
| glyph cache nie przekracza budżetu | F3D-020 |
| wyjątek uploadu nie blokuje kolejki | F3D-023 |

Nie wolno "naprawiać" testu przez usunięcie assertion. Test ma kodować kontrakt
ze specyfikacji i mierzyć efekt na request/render modelu.

## Faza 1 — jeden kontrakt identity i provenance

### Zmiany

1. Stworzyć `VisualizationDomainIdentity` zawierające co najmniej:
   scene revision, domain generation, topology hash/revision i discretization.
2. Stworzyć centralny `resolveFieldDomainCompatibility` i użyć go we wszystkich
   scalar/vector/FDM/FEM/target-buffer ścieżkach.
3. Zachować domain generation w WS/AsyncAPI parserze i invalidation identity.
4. Rozdzielić geometry-renderable od field-compatible.
5. Naprawić freshness scene/manifest i FDM async snapshot identity.

### Findings zamykane

`F3D-001`, `F3D-002`, `F3D-003`, `F3D-004`.

### Kryterium wyjścia

- żaden payload pola bez exact compatibility nie dociera do attribute/glyph build;
- stale geometry jest wyłącznie jawnym ghostem;
- diagnostics podaje wszystkie tokeny identity;
- browser test nie widzi starego pola w żadnej klatce po zmianie generacji.

## Faza 2 — canonical target registry i routing

### Zmiany

1. Dodać jeden resolver target identity oparty o `object_id`, current scene mapping,
   backend `targets.objects/parts` i jawny part fallback.
2. Używać backendowego effective registry jako bazy dla object/part/airbox.
3. Zachować region jako jawny frontend target z manifestowym carrierem, ale nie
   dziedziczyć aktywnych passów.
4. Dopiero po tym naprawić projection routing fixture.

### Findings zamykane

`F3D-005`, `F3D-006`, `F3D-009`, `F3D-011`, `F3D-012`.

### Kryterium wyjścia

- Explorer, Ribbon, Inspector, viewport i PATCH diagnostics pokazują ten sam id;
- trzy projection modes różnią się wizualnie;
- region jest opt-in i ma jawny carrier/degraded reason;
- manifest nie może być `current` dla nośnika ignorowanego przez adapter.

## Faza 3 — usunięcie drugiego store i domknięcie persistence

### Zmiany

1. Przenieść całą backend-supported optymistykę do jednego sync controllera.
2. Dodać ACK/revision reconciliation, pending/error i bounded retry.
3. Uzupełnić serializer airboxu oraz atomowy reset.
4. Dodać semantyczne remove-field dla `Inherited` i clear child regions.
5. Rozdzielić persistent, local viewport i dev-only controls.

### Findings zamykane

`F3D-010`, `F3D-013`, `F3D-015`, `F3D-016`.

### Kryterium wyjścia

- HTTP v2/`targets.*.settings` jest jedynym ownerem persistent state;
- drugi klient i reload nie zmieniają effective wartości;
- błąd PATCH jest widoczny i nie jest ponawiany bez końca;
- Reset/Inherited usuwa serialized state, nie tylko wygląd lokalny.

## Faza 4 — zamknięcie pozostałych P1 i spójne pass controls

### Zmiany

1. Najpierw domknąć P1: FDM vectors-only/points-only, hidden pass commands,
   wyjątki GPU upload coordinatora i budżet glyph cache.
2. Następnie dodać `payloadRevision -> requestedRevision` do diagnostics podczas
   istniejącego stanu syncing.
3. Poprawić semantics toggle/segmented/color controls.

### Findings zamykane

`F3D-007`, `F3D-008`, `F3D-014`, `F3D-017`, `F3D-020`, `F3D-023`.

### Kryterium wyjścia

- każda widoczna kontrolka ma działający renderer pass;
- hidden target nie może być pośrednio włączony przez pass command;
- wyjątek jednego uploadu nie blokuje kolejki, a glyph cache jest bounded;
- syncing diagnostics pokazuje payload i requested revision;
- pełna obsługa klawiatury i dostępnego stanu.

## Faza 5 — realtime identity

### Zmiany

1. Wspólny canonical field-query serializer.
2. Podjąć decyzję kontraktową: pozostawić quantity-wide invalidation jako jedyny
   model albo rozszerzyć backend/AsyncAPI o scope/component exact identity.
3. Tylko w drugim wariancie dodać exact invalidation przed broad quantity fallback.
4. Telemetria liczby refetches na event.

### Finding zamykany

`F3D-018`.

### Kryterium wyjścia

Cache key i URL mają tę samą canonical reprezentację. Obecny quantity fallback ma
test pełnego zakresu; jeżeli schema dostanie exact identity, scoped event odświeża
tylko exact resource/collection key.

## Faza 6 — WebGL/lifecycle/performance bez obniżania jakości

### Kolejność wewnętrzna

P1 `F3D-020` i `F3D-023` są bramką fazy 4 i nie mogą czekać na poniższe P2/P3.
Po ich zamknięciu:

1. Dodać production worker runtime ownership (`F3D-019`).
2. Zmierzyć i ewentualnie naprawić shader attribute GPU lifetime (`F3D-021`).
3. Zmierzyć i ewentualnie współdzielić/kompaktować positions (`F3D-022`).
4. Domknąć listener cleanup i O(M × R) lookup (`F3D-024`, `F3D-025`).

### Kryterium wyjścia

- wyjątek jednego uploadu nie blokuje kolejki;
- cache i worker counts są bounded;
- 3D -> 2D natychmiast zwalnia viewport runtime;
- WebGL buffers/bytes osiągają plateau w stress teście;
- żadna optymalizacja nie obniża domyślnej jakości, gęstości glyphów ani topologii.

## Faza 7 — bramki, które mierzą rzeczywiste właściwości

### Zmiany

1. Oddzielić source hygiene od browser idle/lifecycle.
2. Dodać production-like audit build z bezpiecznym hookiem.
3. Naprawić false-positive regexy i dodać fixture tests.

### Findings zamykane

`F3D-026`, `F3D-027`, `F3D-028`.

### Kryterium wyjścia

- strict gates są zielone na canonical code;
- kontrolowana mutacja leak/loop/direct fetch powoduje czerwony gate;
- CI zapisuje before/peak/after metrics i browser artifacts.

## Proponowane, reviewowalne zestawy zmian

Każdy zestaw powinien być osobnym PR albo wyraźnie oddzielonym review stackiem:

1. **Provenance contract + tests** — F3D-001..003.
2. **FDM async build identity** — F3D-004.
3. **Canonical target/effective registry + projection** — F3D-005,006.
4. **Region target semantics i carriers** — F3D-009,011,012.
5. **Airbox i visualization state synchronization** — F3D-010,013,015,016.
6. **P1 renderer reliability** — F3D-008,014,020,023.
7. **Sync diagnostics i accessibility** — F3D-007,017.
8. **Scoped realtime identity** — F3D-018.
9. **Worker ownership i measured GPU optimizations** — F3D-019,021,022,024,025.
10. **Runtime gates and API hygiene** — F3D-026..028.

Nie łączyć napraw provenance z dużym refactorem plików renderera. Najpierw
minimalny kontrakt i testy, później ewentualne rozdzielenie mixed responsibility.

## Macierz właścicieli i warstw

| Warstwa | Odpowiedzialność naprawy | Findings |
|---|---|---|
| OpenAPI/AsyncAPI/backend visualization | effective registry, serializowane style, WS identity, diagnostics | 003, 006, 010, 016, 018 |
| Kernel visualization | target resolver, sync, configured/effective state | 005, 006, 009, 013-016 |
| Resource/realtime | canonical query identity, revisions, statuses | 007, 018 |
| Viewport scene model | freshness, carriers, demand planning | 001-003, 007, 009, 011 |
| R3F layers/build engine | FDM passes, async identity, GPU/cache/workers | 004, 008, 019-025 |
| Inspector/Ribbon/commands | disabled state, reset, scope, a11y | 009, 010, 012-017 |
| Tests/CI | visual differentiation, lifecycle, strict hygiene | 005, 026-028 |

## Minimalna końcowa macierz browser testów

| Scenariusz | Asercje |
|---|---|
| Current -> scene edit -> rebuilt | brak pola na stale, ghost widoczny, nowe pole dopiero po exact identity |
| Domain generation switch | zero klatek starego koloru/glyphów |
| Object/part projection | trzy tryby różne, target id zgodny w UI/PATCH/renderer |
| Viewport pick -> Explorer | każdy semantyczny target ma istniejący węzeł; click przełącza kartę, rozwija, przewija i podświetla dokładnie ten węzeł |
| Airbox canonical identity | `part:__air__` jest tylko carrierem; zero `object:__air__`/part override'ów i jeden zestaw passów |
| Region authoring | region hidden domyślnie, owner field bez zmian, explicit region HSL tylko na carrierze |
| Airbox reload/reset | wszystkie style round-tripują, reset usuwa override |
| Hidden target | pass controls disabled, configured values zachowane |
| Two clients | zmiana A po ACK nie jest maskowana przez local store B |
| FDM pass matrix | surface/wire/points/vectors samodzielnie i w kombinacjach |
| 3D <-> 2D stress | workery/listenery/WebGL/cache wracają do plateau |
| Upload exception | kolejny target nadal staje się visible |
| Realtime field update | quantity fallback odświeża pełny właściwy zakres; exact scope tylko jeśli schema zostanie rozszerzone |
| CoFeB >= 800k tetra | osobne asercje surface/shader/vector/points/wireframe dla airboxa i wszystkich magnetyków; brak long task > 200 ms |

## Definicja końca programu naprawczego

Program jest zakończony dopiero, gdy:

1. wszystkie P0/P1 są zamknięte testem regresyjnym;
2. każde P2 jest zamknięte albo jawnie zaakceptowane przez wskazanego właściciela
   z uzasadnieniem, ryzykiem i terminem; P2 oznaczone **M** dodatkowo ma pomiar;
3. P3 jest zamknięte albo wpisane do backlogu z właścicielem;
4. pełny typecheck, lint, Vitest, build, API gates i browser gates są zielone;
5. HTTP OpenAPI i WS/AsyncAPI są ponownie sprawdzone, jeśli zmieniono kontrakt;
6. żadna naprawa nie tworzy direct fetch, drugiego store ani always-on render loop;
7. raport powykonawczy zawiera aktualne commands, metrics i screenshots.
