# Dyspersja i analiza modów — UI

## Cel i izolacja

Czytelny wykres obliczonej dyspersji oraz przejście od punktu do konkretnego
modu, jego parametrów i pola zespolonego w tym samym workspace. Zmiany
powstają na branchu codex/dispersion-mode-ui-20261008 z bazowego commita
1195663c67943cb57f6716bdd73639d9fe917e4f. Poprzednie worktree zawiera
równoległe zmiany API/pól i nie jest nadpisywane. Cały wcześniejszy plan
S00–S12 nadal obowiązuje; ten etap realizuje priorytet UI.

## Zadania i dowody odbioru

1. U1 — zachować pełną tożsamość punktów, falowe wektory SI i wiązanie
   wyboru z istniejącymi hooks/API. Centralny wykres oferuje współrzędną
   ścieżki oraz dostępne podpisane składowe k; nie odgaduje znaku z path_s.
   Jednostki prezentacji GHz i rad/µm nie zmieniają danych SI. Testy modelu
   obejmują ujemne k, brak wektora, crossing/powtarzane k i stabilne indeksy.
2. U2 — wykres i lista pasm: czytelne osie, zoom, legenda, punkty numeryczne
   odróżnione od analityki, zaznaczenie i eksport. Dane pozostają ograniczone,
   ECharts ma jednego właściciela i sprzątanie zasobów.
3. U3 — wybór punktu/modu: rzeczywiste częstotliwość, k, indeks/pasmo,
   residual, damping/linewidth, dostępność pola i provenance. Akcja pola
   przechodzi przez kernel commands do istniejącego viewportu.
4. U4 — analiza pola: real/imag/abs/phase, składowa i faza, legenda skali
   oraz istniejące sterowanie glyphs/surface. Animacja nie zmienia
   fizycznych danych, działa tylko jawnie uruchomiona i zwalnia zasoby.
5. U5 — mały runtime FEM: film DE 40×40×10 nm, Ms=800 kA/m, A=13 pJ/m,
   Bx=0.1 T, PBC xy, finite Dirichlet air ±2 µm, siatka L0 10 nm,
   trzy warstwy, 15 punktów signed od −25 do +25 rad/µm. Runtime236
   ze zweryfikowanego receiptu; podstawowe kryteria residualu zachowane.
   Nie tworzymy syntetycznych wyników ani nie odbijamy dodatnich punktów.
   Mała siatka służy do demonstracji UI, nie do pełnej kwalifikacji nauki.
6. U6 — źródła/typecheck/lint/React Doctor i wykonywalne regresje w GitHub
   Actions (lokalny zakaz kompilowania unit tests pozostaje). Browser proof
   na realnej sesji: niepusty wykres, wybór punktu i pola, widoczny canvas,
   niezagubiony WebGL, niezerowy drawing buffer, zmiana fazy i składowej,
   powrót do wykresu bez stale field lub utraty tożsamości. Fixture proof
   jest dodatkowy i nie zastępuje runtime/browser proof na danych solvera.
7. U7 — review, spójne commity, push i integracja według wymaganych bramek.

## Stan początkowy

Wykres Analysis istnieje i ma resource hooks, legendę, eksport i selection.
Adapter ogólnego ChartSeries nie zachowuje jeszcze wektora k na punkcie;
inspector korzysta z bogatszego EigenDispersionPoint. Przed zmianami trzeba
zamknąć to przejście bez dodatkowego pobierania komponentowego.
Runtime ma osobny zapis sesji; nie uznajemy HTTP 200 za potwierdzenie GUI.

## Aktualne wykonanie

Benchmark signed15 L0 został zlecony z dokładnym modelem ba0045fef5978e67063047c5896384923d30960a
i runtime236/source digest d912feb0287423ba6a7adc832de6af14d192281cf9235c87c11c0d5f77e534ac.
Parametry: okno 8.5–16 GHz, EPS 1e-9, inner FGMRES 1e-12/restart30,
physical gate 1e-8, serial, capture-session, loopback API 8169.
Stan i wyniki pozostają NOT VERIFIED do terminalnego receiptu i kontroli artefaktów.
