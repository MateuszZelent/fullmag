# 10. Reaudyt najnowszej wersji — 2026-07-14

## Zakres i rewizja

- repozytorium: `/home/kkingstoun/git/fullmag/fullmag`;
- gałąź: `master`;
- bazowa rewizja odtworzenia:
  `9f0c64f5bd14d0b47e84727179b817bd6f1d1830`;
- scenariusz reprezentatywny:
  `examples/permalloy_layer_cofeb_rings_relax_300nm.py`;
- frontend: Next.js 16.2.6, React/R3F/Three.js, typed HTTP v2 i binary
  field data-plane.

Reaudyt nie zakłada, że merge `79bb92eb` nadal dowodzi poprawności. Każdy stan
poniżej został ponownie porównany z aktualnym kodem, testami i dostępnymi
dowodami runtime.

W trakcie reaudytu współdzielony worktree otrzymał dalsze, niezacommitowane
zmiany innych agentów w API, viewport, airbox i przykładzie CoFeB. Nie są one
automatycznie liczone jako naprawa: dopóki nie przejdą reprezentatywnego
browser proof, pozostają implementacją w toku. Audyt nie modyfikuje tych zmian.

## Werdykt

Frontend 3D nie jest obecnie udowodniony jako produkcyjnie sprawny dla dużego
FEM. Kontrolki i backend mogą zgodnie deklarować `visible` oraz dostępność
quantity, a mimo to surface, tekstura magnetyzacji i wektory nie pojawiają się.
Points i wireframe korzystają z prostszej ścieżki topologii i dlatego mogą
pozostać widoczne.

Dokładne zgłoszenie użytkownika — points i wireframe widoczne tylko dla
airboxa, bez tekstur/surface/vectorów dla ferromagnetyków — jest zgodne z
zachowanymi profilami i analizą ścieżki danych. Nie zostało jednak w całości
ponownie odtworzone na świeżym runtime po bieżących niezacommitowanych zmianach,
Aktualizacja 2026-07-15 usunęła blokadę dowodową: aktualny przykład CoFeB
materializuje mesh, publikuje topology/fields i przechodzi izolowany smoke
produkcyjnego viewportu na portach web/API 3193/8195.

Z 28 historycznych findings:

| Stan | Liczba | Findings |
|---|---:|---|
| Naprawione w pierwotnym zakresie | 26 | F3D-001–002, F3D-004–012 oraz F3D-014–028 |
| Częściowo naprawione | 0 | — |

Dodane w reaudytcie problemy F3D-029–F3D-032 zostały zamknięte 2026-07-15.
Kod, testy kontraktowe, browser click/reveal oraz realny CoFeB FEM smoke są
zielone; szczegóły napraw i bieżące dowody zapisano w pliku `11`.

## Najmocniejsze dowody runtime

### R1 — reprezentatywny FEM z wektorami

Zachowany profil
`.fullmag/reports/cofeb-rings-relax-diagnostics/step0-browser-8195/summary.json`
dotyczy tej samej sesji CoFeB przy 832 944 komórkach FEM. Pokazuje:

- `field-color` worker: około **48 423 ms**;
- najdłuższy long task: **47 673 ms**;
- maksymalne opóźnienie event loop: **49 961 ms**;
- screenshot: timeout po 5 s;
- CoFeB surface: `surface-colors-unavailable` i `surface-rejected` mimo
  `full-vector-complete` dla scoped payloadu;
- retained surface wskazuje poprzedni full-domain field zamiast aktualnego
  scoped field;
- airbox: `vector-segments-unavailable`, choć demand został uznany za
  `sampled-ok max_samples=1200`.

To jest bezpośredni dowód błędu poniżej visible-state gates i resource
selection: w budowie derived buffers oraz publikacji render modelu.

### R2 — ten sam FEM bez wektorów

Profil
`.fullmag/reports/cofeb-rings-relax-diagnostics/step0-browser-8196-no-vectors/summary.json`
przy 834 048 komórkach pokazuje:

- surface przechodzi z `stale-visible` do `ready`;
- screenshot zostaje zapisany;
- najdłuższy long task spada do **3 854 ms**;
- maksymalne opóźnienie event loop spada do około **3 884 ms**.

Różnica izoluje aktywną ścieżkę vectors/derived work jako czynnik eskalujący
awarię, nie sam transport topologii.

### R3 — syntetyczne gate'y są zielone

Na bieżącym dirty worktree:

- `audit:viewport-3d-memory-churn` — pass, 120 przełączeń, fixture FDM,
  heap 17,9 -> 19,8 MB i geometrie 5 -> 5;
- `audit:viewport-3d-fem-topology-uploads` — pass, 12 przypadków 1/10/100
  partów i upload positions około 162,2–164,0 KB.

Te wyniki nadal dowodzą historycznych napraw cache/lifecycle/uploadów, lecz nie
obejmują rzeczywistego kosztu full-domain FEM, scoped surface colors ani
airbox vector segments.

### R4 — świeże odtworzenie aktualnego scenariusza

`just run-cofeb-rings-relax-diagnostics gpu auto 3192 viewport-3d` uruchomił
zarządzany runtime FEM i wygenerował mesh 908 917 tetraedrów / 144 659 węzłów.
Recorder zakończył się po 120 s na oczekiwaniu na `.fm-viewport-3d canvas` i nie
zapisał pełnego artefaktu. Następne uruchomienie na bieżącym `masterze` zostało
zatrzymane przez niezależny błąd materializacji: wiele zewnętrznych ścian
magnetycznych nie miało boundary markerów. Jest to blokada end-to-end opisana w
pliku `12`, nie dowód naprawy frontendu.

### R5 — data-plane był dostępny przed regresją materializacji

W sesji, która osiągnęła `topology_revision=4` i `field_revision=33`, binary
endpointy zwracały poprawne FMVP v3 dla:

- `m`, scope `object:permalloy_layer`;
- `m`, scope `object:cofeb_top_ring`;
- `H_eff`, scope `airbox`, `max_samples=1200`.

Payloady miały zgodny topology hash i dokładny generation ID. Zawęża to brak
surface/vector do frontendowego decoded-buffer/render-model path, a nie do
braku quantity po stronie backendu.

### R6 — twardy katalog semantycznych targetów jest zaimplementowany

Na niezacommitowanych zmianach przeszły:

- wspólny katalog `targetId -> explorerNodeId -> carrierIds`, test złożonego
  kontraktu renderer/Explorer i przypadek zdegradowanego `object_segment`;
- focused suite selection/Explorer/viewport oraz typecheck;
- trzy testy API: jeden kanoniczny Airbox i tylko orphan part fallbacki,
  canonical-over-legacy precedence oraz migracja `object:__air__`.
- świeży production audit build;
- browser click/reveal na świeżym bundle'u: kliknięcie regionu w canvasie
  wybrało dokładnie
  `model:object:fixture-region-owner:regions:fixture-region-owner:core`.

Implementacja usuwa syntetyczny `__air__` z renderera i Explorera, mapuje role
`air|airbox` wyłącznie do `model:airbox`, mapuje prawidłowego ownera do
`model:object:*`, a stale/orphan carrier do jawnego
`model:mesh:unassigned:*`. Picking zachowuje ID carriera wyłącznie jako
metadane transportowe, natomiast selection `nodeId` zawsze wskazuje istniejący
węzeł. Explorer przełącza kartę, rozwija ścieżkę, zachowuje zaznaczenie mimo
filtra i przewija wiersz. F3D-032 nie jest jeszcze oznaczone jako całkowicie
zamknięte, bo browser gate nie policzył jeszcze pojedynczych passów Airboxa.

Aktualizacja `outer_boundary` z 2026-07-15: pomocniczy carrier o tej roli jest
odrzucany zarówno przy projekcji manifestu, jak i bezpośrednio w kanonicznym
builderze katalogu, więc nie może utworzyć `part:*` ani węzła `Unassigned mesh`.
Explorer wystawia stabilne `Universe -> Boundary Faces`; status jest
`unavailable` bez carriera, `mesh-stale` dla nieaktualnej generacji i
`mesh-ready` wyłącznie dla aktualnego manifestu z `outer_boundary`. Produkcyjny
audyt Chromium potwierdził `outerBoundaryUnassignedNodeCount=0`, jeden carrier,
cztery ściany, manifest `ready`, dedykowany Inspector oraz zdrowy WebGL po
kliknięciu. Zakres Airboxa pozostaje weryfikowany oddzielnie.

## Macierz 28 historycznych findings

| Finding | Stan 2026-07-14 | Aktualny dowód / ograniczenie |
|---|---|---|
| F3D-001 | Naprawione | Jawne scene/manifest provenance i testy freshness pozostają w kodzie. |
| F3D-002 | Naprawione | Stale topology nadal blokuje field-bearing passy. |
| F3D-003 | Naprawione | Publiczne generation IDs są dokładnymi stringami dziesiętnymi w JSON, OpenAPI, AsyncAPI i typach TS; fixture powyżej `2^53` nie traci precyzji. |
| F3D-004 | Naprawione | Late FDM build jest odrzucany według aktualnego build key. |
| F3D-005 | Naprawione | Canonical part target routing pozostaje zaimplementowany i testowany. |
| F3D-006 | Naprawione | Effective target registry jest konsumowane; zgłoszona awaria występuje niżej. |
| F3D-007 | Naprawione | HUD zawiera requested/current revisions, demands, buffers i derived work. |
| F3D-008 | Naprawione | Niezależne FDM passy są nadal obecne; gate FDM przechodzi. |
| F3D-009 | Naprawione | Region display pozostaje opt-in. |
| F3D-010 | Naprawione | Airbox style/reset pozostają serializowane. |
| F3D-011 | Naprawione | Object segment aliases i degraded carriers są jawne. |
| F3D-012 | Naprawione | Inspector mutuje wybrany canonical target. |
| F3D-013 | Naprawione | Trwałe 4xx jest terminalne, transient retry jest ograniczony, optimistic overlay jest wycofywany, a Inspector publikuje target/error/requestId i dokładny retry. |
| F3D-014 | Naprawione | Hidden target blokuje pass controls. |
| F3D-015 | Naprawione | Inherited/reset usuwa backend override. |
| F3D-016 | Naprawione | Local renderer preferences mają osobnego ownera. |
| F3D-017 | Naprawione | Kontrolki publikują stan dla accessibility tree. |
| F3D-018 | Naprawione | Canonical field query identity i exact invalidation pozostają obecne. |
| F3D-019 | Naprawione w starym zakresie | Lease-owned worker lifecycle przechodzi fixture gate; nie dowodzi braku nowej pętli React. |
| F3D-020 | Naprawione w starym zakresie | Glyph cache ma budżet/LRU; problemem jest koszt jednego reprezentatywnego buildu, nie nieograniczony cache. |
| F3D-021 | Naprawione | Syntetyczny WebGL lifecycle i buffer accounting przechodzą. |
| F3D-022 | Naprawione w starym zakresie | Positions osiągają plateau na fixture FEM; derived field-color/vector work pozostaje niepokryte. |
| F3D-023 | Naprawione | Upload queue izoluje failed ticket i rollback. |
| F3D-024 | Naprawione | Pointer listeners są czyszczone symetrycznie. |
| F3D-025 | Naprawione | Region map używa indeksu O(R + M). |
| F3D-026 | Naprawione w pierwotnym zakresie | Gate montuje realny R3F/WebGL i pokrywa historyczny lifecycle. Brak dużego CoFeB jest nowym rozszerzeniem F3D-031. |
| F3D-027 | Naprawione | Semantyczny API hygiene gate pozostaje obecny. |
| F3D-028 | Naprawione w pierwotnym zakresie | Production audit build posiada runtime i zapisuje historycznie wymagane evidence. Pełny artifact pre-canvas dla CoFeB jest nowym rozszerzeniem F3D-031. |

## Klasyfikacja nowych problemów

| Finding | Priorytet | Stan |
|---|---|---|
| F3D-029 — derived pipeline FEM nie publikuje surface/vector w budżecie | P0 | zamknięte; realny CoFeB smoke zielony, switch <200 ms |
| F3D-030 — `Maximum update depth exceeded` nie ma deterministycznego gate'a ani pełnego śladu | P0 | zamknięte; produkcyjny Chromium negative-control, pre-canvas boundary, remount latch i pełny failure artifact |
| F3D-031 — gate CoFeB i recorder są rozjechane z aktualnym przykładem | P1 | zamknięte; aktualny target/stage contract i izolowane porty |
| F3D-032 — renderowany/pickowalny cel nie ma jednego kanonicznego węzła Explorera | P0 | zamknięte; invariant click/reveal oraz realne build evidence magnet/airbox |

Plany naprawy i kryteria akceptacji są w plikach `11` i `12`.

## Wykonane komendy

```text
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
  PASS — 120 switches, fixture FDM, heap 17.9 -> 19.8 MB, geometry 5 -> 5

pnpm --dir apps/control-room audit:viewport-3d-fem-topology-uploads
  PASS — 12 syntetycznych przypadków FEM, positions 162.2–164.0 KB

pnpm --dir apps/control-room typecheck
  PASS

pnpm --dir apps/control-room lint
  PASS — zero warnings

env TMPDIR=/tmp pnpm --dir apps/control-room test
  PARTIAL — 328 plików / 3069 testów pass; 2 niezależne failure:
  sandbox EPERM przy spawnSync oraz oczekiwanie zmienione równolegle w viewport3dResources

focused frontend selection/Explorer/viewport
  PASS — 5 plików, 144 testy

focused fullmag-api Airbox identity/override tests
  PASS — 3 testy

pnpm --dir apps/control-room build:audit:webpack
  PASS — świeży Next.js 16.2.6 production audit bundle

CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 CONTROL_ROOM_SCREENSHOT_SCENES=fdm
  PARTIAL — canvas/WebGL i dokładny click -> Explorer node PASS;
  późniejsza niezależna kontrolka projection nie została ujawniona

just run-cofeb-rings-relax-diagnostics gpu auto 3192 viewport-3d
  FAIL — timeout 120 s na .fm-viewport-3d canvas; brak pełnego artefaktu

just run-cofeb-rings-relax-interactive gpu auto
  FAIL — materializacja mesha odrzucona przez brak boundary markerów
```

## Czego reaudyt nie twierdzi

- Nie twierdzi, że `setWorkerRuntimeCounts()` jest już udowodnioną przyczyną
  `Maximum update depth`; jest to kandydat wymagający stack trace i testu.
- Nie przypisuje frontendowi błędu boundary markerów.
- Nie uznaje aktywnej kontrolki ani HTTP 200 za dowód widocznego renderu.
- Nie uznaje małego fixture za dowód produkcyjnego FEM.
- Nie uznaje niezacommitowanych zmian innych agentów za naprawę bez ponownego
  runtime/browser proof.
- Nie uznaje samego click/reveal za pełny dowód braku podwójnych passów Airboxa;
  ten osobny browser gate pozostaje wymagany do ostatecznego zamknięcia
  F3D-032.
