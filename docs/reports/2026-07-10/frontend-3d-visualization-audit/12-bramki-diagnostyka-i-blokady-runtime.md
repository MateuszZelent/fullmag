# 12. Bramki, diagnostyka i blokady runtime

## Rozszerzenie F3D-031 — realny WebGL gate nie jest reprezentatywnym gate'em CoFeB

**Priorytet:** P1 — wysoki, składnik F3D-031  
**Stan:** nowy zakres; historyczny F3D-026 pozostaje zamknięty

### Dowód

`audit:viewport-3d-memory-churn` przeszedł na bazowej rewizji, ale używa fixture
FDM. `audit:viewport-3d-fem-topology-uploads` również przeszedł, lecz jego
topologia ma około 162 KB positions i mierzy głównie współdzielenie uploadów
1/10/100 partów. Żaden gate nie odtwarza 833–909 tys. tetraedrów, scoped field
colors, airbox H_eff i jednoczesnych vector glyphs.

Świeży przebieg bieżącego worktree pozostaje zielony: memory-churn wykonał 120
przełączeń przy heap 17,9 -> 19,8 MB i geometrii 5 -> 5, a topology-upload gate
utrzymał positions na 162,2–164,0 KB w 12 przypadkach. To wzmacnia historyczny
dowód lifecycle/upload, ale nie rozszerza fixture o produkcyjny field pipeline.

### Plan naprawy

1. Dodać deterministyczny, zapisany artefakt FEM o realistycznej liczbie
   node/element indices albo generowany fixture o równoważnym koszcie.
2. Wymusić surface + vectors dla airboxa, permalloy i CoFeB, nie tylko upload
   topologii.
3. Mierzyć time-to-first-geometry, time-to-surface-color,
   time-to-first-vector, long tasks, event-loop delay i screenshot.
4. Uruchamiać gate po każdej zmianie viewport build engine/resource hooks.

### Kryterium akceptacji

Gate musi nie tylko zobaczyć canvas, ale pikselowo i diagnostycznie potwierdzić
każdy pass dla airboxa i magnetyków w ustalonym budżecie czasu.

## Rozszerzenie F3D-031 — recorder traci dowód awarii pre-canvas

**Priorytet:** P1 — wysoki, składnik F3D-031  
**Stan:** nowy zakres; historyczny F3D-028 pozostaje zamknięty

### Dowód

`record-diagnostics.mjs` zapisuje pełny artifact dopiero po `runScenario()`.
Dla viewportu `runScenario()` najpierw czeka na widoczny canvas. W catch
zapisywany jest tylko `999-failure.png`, a błąd jest ponownie rzucany. Przy
timeoutie aktualnego CoFeB powstały screenshots, ale nie `summary.json`,
console stream, page errors, request log ani in-page diagnostics.

### Plan naprawy

1. Rozpocząć zbieranie console/pageerror/network/CDP przed `page.goto`.
2. W `finally` zawsze próbować wyeksportować częściowy in-page artifact.
3. Niezależnie od in-page recorder zapisać Playwright-side `failure.json` z
   błędem, stackiem, URL, DOM excerpt i stanem canvas/WebGL.
4. Rozdzielić timeout sesji-ready, viewport-mounted, canvas-ready i
   pass-visible; raportować etap, a nie jeden ogólny timeout.

### Kryterium akceptacji

Każdy exit, również przed mountem React, musi pozostawić czytelny JSON,
screenshot i console/pageerror log. Negative control z celowym update-depth
musi dać użyteczny component stack.

## F3D-031 — gate CoFeB jest rozjechany z aktualnym przykładem

**Priorytet:** P1 — wysoki  
**Stan:** otwarte w bazowej rewizji; bieżące niezacommitowane zmiany wymagają
ponownej weryfikacji

### Dowód

W bazowej rewizji przykład tworzył tylko `permalloy_layer` i
`cofeb_top_ring`; bottom ring był zakomentowany. Miał jeden aktywny
`add_minimize`, a relax był zakomentowany. Mimo tego:

- `smoke-viewport-3d-mixed-targets.mjs` domyślnie wymagał
  `cofeb_bottom_ring`;
- `run-cofeb-rings-relax-diagnostics` oczekiwał logu `stage 2/2 completed`;
- recipe ustawiało zmienne relax, których przykład nie konsumował.

Nowy test przykładu jest wyłącznie statycznym testem AST. Deklaruje intent
`single swept-prism layer`, ale nie dowodzi realizacji mesha: shared-domain OCC
z airboxem i wieloma obiektami nadal używa tetrahedral/fallback
`free_tetrahedral`. Gate nie może raportować pryzmatów bez `actual_method` z
build reportu.

### Plan naprawy

1. Zdefiniować jeden manifest scenariusza testowego: target IDs, stage count,
   quantities i oczekiwane passy.
2. Odczytywać oczekiwania smoke z aktualnego scene/stages resource, nie z
   hard-coded historycznego układu.
3. Testować istniejące magnetyki + airbox; opcjonalny bottom ring sprawdzać
   tylko, jeżeli scene go publikuje.
4. Czekać na terminalny stan wszystkich opublikowanych stages zamiast regexu
   `2/2`.
5. Dodać test statyczny porównujący IDs i liczbę etapów example vs gate.
6. Wymagać build reportu i boundary certificate z rzeczywistego retry Gmsh;
   test AST nie jest dowodem geometrii, markerów ani metody elementów.

### Kryterium akceptacji

Gate uruchomiony na bieżącym przykładzie nie może zakończyć się fałszywym
błędem z powodu nieistniejącego targetu/etapu i musi sprawdzić aktualne passy.

## BLOKADA-RUNTIME-001 — bazowy master nie materializuje scenariusza CoFeB

**Zakres:** backend/mesh, poza bilansem findings frontendu  
**Wpływ na audyt:** blokuje świeży end-to-end proof

Zarządzane uruchomienie na `9f0c64f5` wygenerowało mesh 908 917 tetraedrów i
144 659 węzłów, po czym materializacja została odrzucona przez serię błędów:
`magnetic boundary is incomplete: exterior magnetic face [...] has no boundary
marker`. API i frontend zakończyły się przed publikacją gotowej domeny.

W worktree pojawiły się później niezacommitowane zmiany i test regresyjny dla
conformal OCC. Nie są dowodem zamknięcia, dopóki managed runtime nie przejdzie
na tej samej wersji i nie uruchomi browser proof.

### Plan naprawy poza tym audytem

1. Odtworzyć przez managed FEM recipe i zapisać minimalny mesh certificate.
2. Porównać boundary extraction przed i po integracji mesh-production.
3. Naprawić marker generation albo jednoznacznie odrzucić niepoprawną geometrię
   przed startem UI z krótkim, agregowanym komunikatem.
4. Po naprawie uruchomić reprezentatywny gate CoFeB z F3D-031; nie uznawać
   naprawy runtime za naprawę rendererów.

### Kryterium wyjścia z blokady

Aktualny przykład musi osiągnąć topology ready, field catalog ready oraz
scoped `m`/airbox `H_eff` przed rozpoczęciem końcowego browser proof.
