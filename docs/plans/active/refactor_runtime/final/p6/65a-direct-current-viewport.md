# P6-65a — bezpośredni powrót do bieżącego viewportu

Data: 02.10.2026. Baza: `54a39e600f61460108eeb28d707253fa93f68a7d`.
Status: **źródła, review i browser fixture PASS; native odbiór otwarty**.

## Zachowanie

Zapisany materializowany dataset ma w HUD akcję `Current view`. Korzysta ona
z istniejącego `onClearSelection` i SelectionController; nie tworzy komendy
solvera, requestu API ani nowego globalnego store. Przycisk jest dostępny
wyłącznie dla zapisanego źródła i potwierdzonej tożsamości sesji. Obsługuje
również jawny unavailable zapisanych danych.

Zmiana wyboru powoduje ponowne włączenie istniejących resource hooks bieżącej
sesji. Prywatny cache kamery zapisanej tożsamości pozostaje oddzielny od
CameraRegistry aktywnej sesji. Canvas ani workspace nie są celowo odmontowywane.
Dostępność klawiaturową i styl zapewnia istniejący Button; HUD używa istniejącej
interaktywnej grupy kontrolek.

Nie zmienia się publiczny kontrakt API, units, solver intent ani requested/
resolved provenance. Marker `data-view-source` opisuje aktualnie wybrany
adapter źródła; nie stanowi dowodu naukowej reprezentacji pola.

## Dowody

- Production TypeScript PASS: `3cd10eb3747244a08efea2fc779abef1`, bez unit builds.
- Focused ESLint: exit 0; dwie istniejące uwagi o unused helperach fixture.
- Niezależny review selection.clear, camera epoch/layout fence, callback cleanup
  oraz current/saved enablement: brak P0/P1.
- Browser PASS: `373378d47ba04d3ba20dc86c24975b79`, exit 0, serwer fixture
  zakończony, brak zmiany źródeł podczas kontroli. Digest źródeł:
  `635bb21e9c5ebd667952803f737079f98cb72794bdb2b7a51ac0dbb484cdc5fb`.
- Direct return: rzeczywisty przycisk UI po saved HTTP 503, bez reload;
  ten sam DOM viewport i canvas, WebGL `contextLost=false`, bufor 613×634,
  1312 draw calls, zachowana current camera, brak runtime/camera mutations
  oraz nowych żądań geometrii/supportu/FMDS zapisanej tożsamości.
- Ponowny reopen live pozostaje dodatkową odrębną próbą. Liczniki są przypięte
  do faktycznych montowań workspace; bezpośredni powrót nie tworzy nowego mount.
- Cały wcześniejszy scenariusz F32/F64, A/B camera restore, integralności,
  identity mismatch i unavailable 503 nadal przechodzi.
- Zrzut `pinned-materialized-dataset-direct-current.png` został obejrzany:
  current geometry jest widoczna, Inspector pokazuje brak wyboru. Zachowany
  toast błędu wcześniejszego saved requestu nie jest nowym błędem live.

Dowód znajduje się pod rozwiązaną ścieżką storage:
`builds/fullmag-0950f4dca4ffe38f/windows-control-room-browser-fixture/pinned-dataset-browser/373378d47ba04d3ba20dc86c24975b79/`.
Unit tests nie były kompilowane ani uruchamiane.

Istniejący `useResource` może pozwolić już rozpoczętemu requestowi zakończyć się
po wyłączeniu konsumenta; disabled hook zwraca idle/null, a identity fences
chronią renderer przed takim wynikiem. Nie deklarujemy pełnego transportowego
abortu ani peak-memory kwalifikacji na podstawie tej akcji.

Natywny backend HTTP/archive oraz nauka pozostają NOT VERIFIED. P6 około 52%,
cały plan około 49%; brakujący odbiór native nadal zależy od pojemności runnera.
