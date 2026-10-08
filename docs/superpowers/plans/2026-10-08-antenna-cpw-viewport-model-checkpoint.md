# CPW — podgląd przewodników i pozycjonowanie całego zespołu

## Zakres przyrostu

Kontynuacja T04/T15 planu `2026-09-08-microwave-antenna-refactoring-plan.md`.
Zmiany produkcyjne zapisano w commicie
`737ba11e0580c219facdf93be22d945cd2877201`; PR #147 pozostaje Draft.
Jest to authoring i podgląd geometrii, nie wykonanie prądu ani pola anteny.

`apps/control-room/src/modules/viewport-3d/viewport3dPrimitiveModel.ts::buildViewport3DPrimitiveRenderModel`
rozpoznaje CPW, buduje trzy oddzielne loftowane przewodniki i wyznacza bounds
z rzeczywistych wierzchołków. Nie używa nieaktualnych bounds jako geometrii.
Niepoprawny layout zostaje pominięty z diagnostyką, bez fikcyjnego boxa.
`::objectMeshState` wymaga zgodności rewizji siatki i sceny także dla CPW.

`apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayerModel.ts::createPrimitiveObjectGeometry`
przenosi preview CPW do rzeczywistej `THREE.BufferGeometry`, zachowując indeksy
i ID przewodników. Wspólne pole `antennaPreview` zastępuje nazwę specyficzną
dla microstrip; produkcyjna warstwa nadal posiada istniejący tracker i cleanup.

`apps/control-room/src/modules/inspector/panels/antenna/AntennaPlacementModel.ts::resolveAntennaPlacement`
obsługuje CPW przez ten sam kanoniczny builder. Odstęp jest dodatnią różnicą
obwiedni całego zespołu przewodników oraz targetu w world Z, nie wewnętrzną
szczeliną CPW ani minimalną odległością euklidesową. Pozostałe ograniczenia
rewizji, target identity, blokady i eksportowalnych transformacji pozostają.

## Dowody wykonania

- `apps/control-room/scripts/check-microstrip-viewport-model.mjs`: **15 PASS**.
  Trzy nowe regresje CPW potwierdzają oddzielne indeksy trzech przewodników,
  ich niestandardowe ID niezależnie od kolejności wejściowej, recentering
  rzeczywistej geometrii Three.js, freshness i odmowę każdego z pięciu
  niepoprawnych wymiarów stacji. Bufor jest zwalniany również po błędzie asercji.
- `apps/control-room/scripts/check-antenna-placement-model.mjs`: **17 PASS**.
  Nowe przypadki mierzą odstęp 50 nm po przeliczeniu pełnej geometrii CPW
  nad/pod targetem. Obrót przenosi asymetrię mas do osi Z, dzięki czemu test
  nie może przejść na podstawie samego przewodnika sygnałowego. Sprawdzono
  zachowanie XY, ID, niemutowanie sceny i odmowę błędnych szczelin/szerokości mas.
  Po niezależnym review wzmocniono asercje: każdy przewodnik posiada dokładnie
  60 indeksów i wykorzystuje 12 wierzchołków; zakresy tworzą pełną partycję.
  Oczekiwane przesunięcia +245 nm i −615 nm wyprowadzono niezależnie z sekcji
  i obrotu, a nie z tego samego buildera co resolver.
- `just check-control-room-production-source`: **passed/0**, receipt
  `b52e7b4ed40a4ed99bb7dd4c25f8871b`, profil
  `windows-control-room-source-check/production-source` tego worktree.
  Digest przed i po:
  `21d8c5b3de754a2ebd72532fe977d689c5b88a6ba0bc2f28ebea037ccf03a552`;
  `source_changed_during_run=false`. Produkcyjny TypeScript, bez kompilacji
  testów jednostkowych, native solvera lub pakietu Next.
- `just lint-control-room-source`: **passed/0** dla digestu powyżej, receipt
  `6984d61591574e4fa8606dc4cf31740e`. Po kontroli zmieniono jedynie pięć linii
  asercji/komentarza w skryptach interpretowanych; produkcyjny TS pozostał
  niezmieniony. Końcowy fingerprint skryptów wymaga odrębnego receipt lintu.
- `scripts/check-architecture-hygiene.mjs`, wykonany z `apps/control-room`:
  **PASS**.

## Pozostałe bramki i następny krok

Regresje interpretują rzeczywiste modele TypeScript i budują geometrię Three.js,
ale **nie uruchamiają renderera**. Nowy CPW viewport pozostaje **NOT VERIFIED**
w przeglądarce: wymagane widoczny canvas, aktywny kontekst WebGL, niezerowy
drawing buffer, złoty kolor, widok nad/pod próbką, brak box fallbacku,
zatrzymanie renderowania w idle i zwolnienie zasobów po zmianie/unmount warstwy.
Należy użyć izolowanego managed fixture z produkcyjną `PrimitiveObjectLayer`
i `Viewport3DInvalidationProvider`, bez restartu sesji użytkownika na 3197.

Transakcja Apply placement dla CPW, kreator CPW, rzeczywiste endpointy,
conductor/current bridge, samodzielny solve, reuse do LLG/Relax, FFT,
cztery lane i trwały zapis pozostają otwarte. Ten checkpoint nie zamyka
T04/T15 ani pełnego T00–T18; nie zmienia kwalifikacji naukowej.
