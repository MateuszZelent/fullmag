# 11. Regresje renderera FEM, shaderów i wektorów

## F3D-003 — utrata precyzji `domain_generation_id` w JSON/OpenAPI

**Priorytet:** P0 — krytyczny  
**Stan:** częściowo naprawione

### Symptom i dowód

Binary FMVP v3 oraz mesh manifest przenoszą pełne 64 bity i frontendowy codec
zachowuje je jako string. Równolegle status, field catalog i inne schema nadal
definiują generation jako Rust `u64` serializowane do JSON number; wygenerowany
TypeScript deklaruje wiele pól `domain_generation_id: number`.

W zachowanym profilu tej samej domeny status zawierał
`4228960224618299400`, podczas gdy topology identity i FMVP zawierały dokładne
`4228960224618299214`. Różnica jest typowym skutkiem przekroczenia
`Number.MAX_SAFE_INTEGER`.

### Wpływ

Każdy cache key, invalidation, freshness gate lub diagnostics oparty na JSON
number może połączyć różne generacje albo fałszywie odrzucić zgodny payload.
Istniejący exact check FMVP chroni główną ścieżkę pola, ale nie cały kontrakt.

### Plan naprawy

1. Zmienić wszystkie publiczne generation IDs w JSON/OpenAPI na canonical
   decimal string, bez mieszanego `number|string`.
2. Zaktualizować Rust schema, OpenAPI, wygenerowane typy i frontendowe facade.
3. Dodać jedną funkcję normalizacji tylko na granicy legacy; wewnątrz UI
   używać wyłącznie string.
4. Włączyć generation ID do exact cache/invalidation identity bez konwersji
   przez `Number()`.
5. Dodać fixture powyżej `2^53` do statusu, catalogu, realtime i FMVP.

### Test regresyjny i kryterium akceptacji

- jedna generacja `9007199254741001` musi być identyczna bajtowo po przejściu
  status -> facade -> cache key -> diagnostics;
- OpenAPI nie może generować `number` dla żadnego publicznego generation ID;
- dwie generacje różniące się o 1 powyżej `2^53` muszą tworzyć różne keys.

## F3D-013 — trwałe odrzucenie PATCH nadal może wejść w bezterminowy retry

**Priorytet:** P1 — wysoki  
**Stan:** częściowo naprawione

### Symptom i dowód

Optimistic overlay jest już powiązany z rewizją i uzgadniany po ACK/refetch,
więc pierwotny bezterminowy local override został ograniczony. Pozostała luka
dotyczy błędów trwałych: synchronizacja może ponawiać również odpowiedzi 4xx,
bez limitu oraz bez jednego terminalnego stanu odrzucenia widocznego w
Inspectorze i diagnostyce.

### Plan naprawy

1. Sklasyfikować 4xx walidacyjne/konfliktowe jako terminalne dla konkretnego
   mutation id; ponawiać automatycznie wyłącznie błędy transient.
2. Dodać bounded exponential backoff i limit prób dla transient network/5xx.
3. Po terminalnym rejection wycofać optimistic overlay albo oznaczyć go jako
   odrzucony draft; HTTP v2 pozostaje stanem kanonicznym.
4. Pokazać request id, target id, błąd i akcję retry w Inspectorze/diagnostyce.

### Test regresyjny i kryterium akceptacji

- 400/409 wykonuje najwyżej jedną automatyczną próbę i kończy stanem `rejected`;
- transient 503 ma skończony backoff i limit;
- po odrzuceniu View ribbon, Inspector i renderer znów pokazują ten sam stan
  z ostatniego HTTP resource snapshotu.

## F3D-029 — derived pipeline FEM nie dostarcza surface i vectors

**Priorytet:** P0 — krytyczny  
**Stan:** otwarte

### Symptom

W zgłoszonym scenariuszu CoFeB points i wireframe pozostają widoczne tylko dla
airboxa; dla ferromagnetyków nie pojawiają się również te passy. Surface z
teksturą magnetyzacji i vector glyphs nie są publikowane albo blokują interfejs
na dziesiątki sekund. Zachowane profile potwierdzają awarię surface/vector i
pokazują, dlaczego prostsza ścieżka topologii może przetrwać dla części targetów,
ale świeże pełne odtworzenie dokładnej macierzy passów blokuje obecnie błąd
materializacji mesha. Visible-state gates, quantity catalog i binary endpoint
mogą być poprawne.

### Dowód i mechanizm

Profil CoFeB z 832 944 komórkami pokazał:

- scoped `m` dla `cofeb_top_ring_geom`: `full-vector-complete`;
- surface mimo tego: `surface-colors-unavailable` / `surface-rejected`;
- retained surface wskazywał starszy full-domain field, nie aktualny scoped
  field;
- airbox H_eff: demand `sampled-ok max_samples=1200`, ale wynik
  `vector-segments-unavailable`;
- `field-color` worker trwał 48,4 s, a main thread miał long task 47,7 s;
- wyłączenie wektorów przywracało surface `ready` i screenshot.

Problem znajduje się więc między decoded field buffers a publikacją geometry
attributes/glyph segments, nie w Inspektorze i nie w samym HTTP selection.

### Plan naprawy

1. Rozdzielić gotowość surface i vectors: vector build nie może blokować
   publikacji geometry/surface.
2. Publikować natychmiast solid-color surface z aktualnej topologii, a shader
   attributes podmieniać atomowo po ukończeniu scoped color build.
3. Dla FEM liczyć kolory tylko dla node indices aktualnego partu; zabronić
   przypadkowego full-domain color transform dla targetu scoped.
4. Ustalić spójny current/retained key: scoped field nie może być odrzucony
   dlatego, że cache nadal trzyma full-domain field tej samej quantity.
5. Budować airbox vectors wyłącznie z już zdekodowanej próbki 1200 punktów;
   segment generation nie może zależeć od pełnej topologii airboxa.
6. Wprowadzić chunking i budżet czasu publikacji oraz anulowanie late work po
   zmianie target/revision.
7. Dodać telemetry `requested -> decoded -> segments/colors -> uploaded ->
   visible` z liczbą elementów i powodem każdej degradacji.

### Test regresyjny i kryterium akceptacji

Na reprezentatywnej domenie co najmniej 800 tys. tetraedrów:

- canvas jest widoczny i niepusty;
- permalloy i CoFeB mają widoczny surface najpóźniej 5 s po topology ready;
- orientation/scalar shader pojawia się najpóźniej 10 s po field ready;
- airbox pokazuje 1200 wektorów bez pełnodomenowego color/segment buildu;
- żaden long task nie przekracza 200 ms;
- niezależne screenshot assertions dowodzą różnicy surface, vectors, points i
  wireframe dla airboxa oraz obu obiektów magnetycznych.

## F3D-030 — `Maximum update depth exceeded` nie jest przechwytywane

**Priorytet:** P0 — krytyczny  
**Stan:** otwarte; zgłoszenie runtime, przyczyna jeszcze nieudowodniona

### Symptom i dowód

React zgłasza `Maximum update depth exceeded`, po czym viewport lub cały moduł
nie montuje canvasa. Obecny recorder czeka na canvas przed eksportem, więc ten
rodzaj awarii nie pozostawia pełnego artefaktu ani stack trace.

W kodzie istnieje konkretny kandydat wymagający falsyfikacji:
`useViewport3DWorkerRuntime()` publikuje snapshot przy każdej zmianie schedulera,
a `Viewport3DResourceTracker.setWorkerRuntimeCounts()` tworzy nowy snapshot i
wywołuje `notify()` również wtedy, gdy trzy wartości się nie zmieniły. Nie jest
to jeszcze dowód przyczyny; podobny audyt należy wykonać dla wszystkich store
updates wykonywanych w effect/render callbacks.

### Plan naprawy

1. Najpierw dodać gate odtwarzający błąd i zapisujący pełny React component
   stack przed jakąkolwiek naprawą.
2. Instrumentować źródło każdego store notification i liczbę commitów React na
   jedną zmianę resource revision.
3. Dodać equality guard do worker counts i wszystkich snapshot setterów, które
   publikują identyczny stan.
4. Zabronić setterów store w render path; scheduler events batchować poza
   bieżącym React commit.
5. Dodać error boundary viewportu, który zachowuje shell i eksportuje forensic
   artifact zamiast usuwać cały canvas bez diagnozy.

### Test regresyjny i kryterium akceptacji

- 1000 identycznych worker/scheduler notifications nie powoduje więcej niż
  jednego dodatkowego React commit;
- topology/field revision churn nie generuje ostrzeżenia update-depth;
- pageerror i component stack są zapisane również wtedy, gdy canvas nigdy się
  nie zamontuje;
- gate działa w dev i production buildzie oraz ma negative control, który
  wykrywa celową pętlę store -> render -> store.

## F3D-032 — renderer i Explorer nie dzielą twardej listy obiektów

**Priorytet:** P0 — krytyczny  
**Stan:** otwarte; Airbox identity repair jest w toku, ale bez dowodu browser

### Symptom

Kliknięcie geometrii airboxa może wybrać równoległy carrier
`part:__air__`/`__air__` zamiast jedynego kanonicznego `airbox`. Explorer pokazuje
węzeł `model:airbox`, więc zaznaczenie viewportu nie podświetla żadnego
istniejącego wiersza. Równoległe identity mogą otrzymać niezależne override'y i
uruchomić nakładające się shadery, surface, wireframe albo vectors.

Ten problem jest ogólny: `onSelectPart()` zapisuje `nodeId` części FEM i
`mesh-part:*`, podczas gdy Model Explorer zwykle zawiera obiekt sceny, nie tę
część. Explorer porównuje aktywność przez dokładne `activeNodeId === node.id`;
nie ma także ogólnego reveal/expand/scroll dla wyboru pochodzącego z viewportu.
Po późniejszym załadowaniu manifestu model Inspectora może ponownie zinterpretować
taki selection ref jako target `part`, mimo że wcześniejszy resolver ustawień
zwrócił już kanoniczny `airbox`.

### Root cause

System ma dwa różne poziomy tożsamości, które nie są wymuszane jednym
kontraktem:

- semantyczny cel UI: `airbox`, `object:*`, `region:*`, jawny fallback `part:*`;
- data-plane/render carrier: mesh part, object segment, primitive lub region
  overlay.

Carrier bywa traktowany jako osobny selection/visualization target, mimo że nie
ma węzła Explorera. Bieżące niezacommitowane zmiany poprawnie filtrują
syntetyczny `__air__` w registry, normalizują legacy override'y i mapują rolę
`air` na `airbox`, ale nadal nie stanowią uniwersalnego guardu
renderer ↔ Explorer ani browserowego dowodu kliknięcia.

Dodatkowo primitive model i adapter sceny Explorera nadal mogą przyjąć
syntetyczny scene object `__air__`, bo filtr registry nie usuwa go z
`model/scene`. Może on zostać wyrenderowany obok kanonicznego Airboxa jako drugi
primitive/pick target. Resolver ufa też każdemu niepustemu `object_id` bez
sprawdzenia, czy taki obiekt istnieje w aktualnej scenie, podczas gdy backend
usuwa każdy part z `object_id` z fallback registry. Stary lub błędny owner id
tworzy więc target bez możliwego węzła Explorera.

Skupione testy bieżącego patcha są zielone: 144 testy frontendu w pięciu suite
oraz trzy testy API canonicalizacji Airboxa. Nie podważają findingu, ponieważ
żaden nie sprawdza dwukierunkowego invariant render target → Explorer node ani
browserowego click/reveal. Jeden z testów adaptera wprost nadal oczekuje
`nodeId` carriera.

### Twardy kontrakt i plan naprawy

1. Zbudować w warstwie kernel/domain jeden kanoniczny katalog semantycznych,
   pickowalnych targetów. Każdy wpis musi zawierać `targetId`, dokładnie jeden
   `explorerNodeId` oraz zero lub więcej wewnętrznych carrier IDs.
2. Explorer i render-model builder muszą konsumować ten sam katalog. Viewport
   nie może importować modułu Explorer ani samodzielnie konstruować alternatywnej
   tożsamości.
3. Renderer działa fail-closed: target bez `explorerNodeId` nie otrzymuje żadnego
   naukowego passu ani pickingu; publikuje bounded diagnostic
   `unaddressable-render-target` zamiast niewidzialnego „ducha”.
4. `part:__air__` pozostaje wyłącznie carrierem `airbox`. Część magnetyczna
   mapuje się do owning `object:*`; prawdziwy orphan `part:*` jest renderowalny
   dopiero po dodaniu jawnego fallback node do Explorera. Samo niepuste
   `object_id` nie wystarcza — owner musi istnieć w aktualnym scene catalogu.
5. Picking zapisuje kanoniczny `SelectionRef`. Explorer przełącza właściwą
   kartę, rozwija pełną ścieżkę rodziców, zachowuje wybrany węzeł mimo filtra,
   przewija go do widoku i ustawia jako aktywny/klawiaturowy wiersz.
6. Osie, grid, gizma, bounds i selection shell pozostają jawnie
   `non-semantic/non-pickable`; nie są obiektami naukowymi i nie tworzą węzłów.
7. Syntetyczne `__air__`/air-role scene objects są odrzucane na kanonicznej
   granicy zasobu i defensywnie w primitive modelu oraz builderze Explorera.

### Test regresyjny i kryterium akceptacji

- API target registry zawiera dokładnie jeden `airbox`, zero `__air__` objects i
  zero air-role part targets;
- kliknięcie carriera `part:__air__` ustawia `nodeId=model:airbox`, rozwija jego
  rodziców, przewija wiersz do widoku i podświetla go; test obejmuje role `air`
  i `airbox`;
- kliknięcie części magnetycznej podświetla owning object; kliknięcie jawnego
  orphan fallbacku podświetla wygenerowany part node;
- stale `object_id`, którego nie ma w scenie, nie może utworzyć targetu object;
- scena zawierająca `__air__` i manifest `part:__air__` daje dokładnie jeden
  Airbox w render modelu i Explorerze oraz zero primitive `__air__`;
- test render-modelu odrzuca każdy semantyczny target bez Explorer mapping i
  zapisuje dokładnie jeden diagnostic;
- browser smoke liczy jeden surface/wireframe/vector pass dla airboxa i nie
  znajduje równoległych `object:__air__`/`part:__air__` ustawień;
- invariant obowiązuje dla FDM, FEM, obiektów, regionów, airboxa i jawnych part
  fallbacków.
