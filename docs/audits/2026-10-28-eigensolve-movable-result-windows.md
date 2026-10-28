# Niezależne okna wyników — wdrożenie i dowody

Worktree: `eigensolve-integration-ui-20261026`.
Gałąź: `codex/eigensolve-integration-ui-20261026`.
Implementacja: `4b07d1ec33d1726a7601dc350f561d59a3acd248`.
Korekta testu: `73db1ef6cedc1f5792147e7b56790ce6bdc3bb89`.
Końcowe źródła UI: `1ba049b9a35f4fe013e65c02a4bdb11dda315ec8`.
UI: <http://localhost:3217/workspace>.

## Obsługa

- Każdy moduł środka workspace ma własną ramkę. Wykres i 3D można niezależnie
  przesunąć uchwytem z kropkami po lewej stronie nagłówka. Przeciągnięcie
  zadokowanego uchwytu od razu odpina okno.
- Pływające okno skaluje się prawym dolnym rogiem. Uchwyty obsługują także
  strzałki klawiatury (10 px; Shift: 40 px).
- Menu `…` zawiera Float/Dock oraz Maximize/Restore. Kliknięcie okna albo
  jego zakładki wysuwa je nad pozostałe okna.
- Dwa zadokowane widoki można ułożyć obok siebie lub pionowo, zamienić miejscami
  i zmieniać ich proporcje separatorem.
- `X` ukrywa konkretne okno. Zakładka przywraca je; fokus po ukryciu wraca
  do tej zakładki. Sam fokus nie otwiera okna: aktywacja zakładek jest ręczna.
- Pozycje i rozmiary pływających okien są zapamiętywane lokalnie w przeglądarce.
  Inspector, Explorer i dolny panel korzystają z dotychczasowego PanelFrame.

To okna wewnątrz workspace, bez tworzenia dodatkowych okien systemowych.
Zadokowany środek obsługuje dwa widoki; dowolnie zagnieżdżone drzewo dockowania
z wieloma grupami zakładek nie jest częścią tego etapu.

## Kontrakt i implementacja

`ViewportTabHost` używa oddzielnej warstwy stałych, kluczowanych okien.
ResizablePanelGroup zawiera wyłącznie puste kotwice; ResizeObserver przekazuje
ich położenie/rozmiar do ramek. Przesunięcie, float/dock, zmiana orientacji
oraz zamiana miejsc nie przenoszą rendererów do innego rodzica React.
Nie dublujemy instancji modułu.

Widoczne moduły — aktywny, towarzyszący i odpięte okna — pozostają zamontowane.
Ukrycie ciężkiego modułu zwalnia renderer; przywrócenie ładuje go ponownie
z zachowanym wyborem wyniku. Ukrycie okna nie zmienia stanu solvera.
PanelFrame zachowuje dotychczasowy kontrakt Inspectora i dodaje opcjonalne
`dragToFloat`, `onModeChange` oraz jawne zdarzenie `onDock`.

Stan trybu ramki jest raportowany rodzicowi przez stabilny callback; rodzic
pomija identyczne wartości. React Doctor zgłasza trzy ostrzeżenia tej synchronizacji
przez effect. Nie zostały wyciszone. Kontrolowany, wspólny model całego dockowania
pozostaje możliwym dalszym refaktorem; nie jest warunkiem przedstawionego
kontraktu dwóch widoków i okien pływających.

## Weryfikacja

| Zadanie | Stan |
| --- | --- |
| 1. Kontrakt okien i lifecycle | Gotowe |
| 2. Implementacja przeciągania/skalowania/dockowania | Gotowe |
| 3. CI i pełna próba przeglądarkowa | PASS |
| 4. Raport, screenshoty, commit i push | Dowody gotowe; źródła wypchnięte |

CI poprzedniej korekty: [40778031882](https://github.com/MateuszZelent/fullmag/actions/runs/40778031882)
— 1431 testów / 60 plików PASS; architecture hygiene PASS.
Końcowy przebieg: [40778835631](https://github.com/MateuszZelent/fullmag/actions/runs/40778835631)
— również 1431/1431 testów, 60/60 plików, architecture hygiene PASS.
React Doctor: 84/100, 7 ostrzeżeń (w tym opisana synchronizacja trybu ramki);
nie jest to deklaracja braku długu technicznego.
Testy były kompilowane wyłącznie w GitHub Actions.

Próba: `scripts/verify_eigensolve_window_layout_ui.mjs`.
Dane: opublikowany mod FEM dla `k=(0,10e6,0) rad/m`, około 11,211887 GHz,
run `run-live-bf62fc7d346d46ad1cca97c205d6d59a96eeca8f708d37fefacf09dd5cdb5c01`.
Frontend korzysta z HMR w swojej istniejącej grupie Docker. Backend nie wymagał
przebudowania ani restartu; pozostaje wersja
`0.1.0-dev.20261028.gf2900016cce3.dirty.sc8c068e22f14+9797`.

Test blokuje wszystkie mutacje poza preferencjami wizualizacji i potwierdzeniami
klienta. Sprawdza tożsamość canvasów w kolejnych operacjach, żywy kontekst WebGL,
niezerowy drawing buffer, powrót zespolonego pola po ukryciu, fokus i odtworzenie
geometrii okna w drugiej stronie tego samego kontekstu przeglądarki.

Niepowodzenia roboczych prób zachowano w katalogu dowodów: pierwsza została
zakłócona przez HMR; druga próbowała kliknąć zasłonięte okno bez wysunięcia go;
kolejna utraciła zdarzenie z ograniczonej historii diagnostycznej. Zwiększenie
bufora wyłącznie w teście potwierdziło odtworzenie pola. Osobno poprawiono
użycie Playwright: wiele stron wymaga jawnego browser.newContext().
Asercje nie zostały pominięte; końcowy scenariusz wykonał je wszystkie: **PASS**.

W 12 checkpointach operacji layoutu zachowano tożsamość obu canvasów,
`isContextLost() == false` i niezerowy drawing buffer. Ukrycie zwolniło ciężkie
renderery; przywrócenie odtworzyło pole `analysis:eigen:sample-0000:mode-0000`
z 5127 zespolonymi wartościami i widoczną powierzchnią magnetyku. Pozycja oraz
rozmiar pływającej ramki po otwarciu drugiej karty były identyczne.
Nie wystąpiły błędy JavaScript ani próby niedozwolonych mutacji. Run ID pozostał
bez zmian. Szczegóły i hashe artefaktów: [evidence JSON](2026-10-28-eigensolve-movable-result-windows.evidence.json).

Screeny z rzeczywistego UI: [okna pływające](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/movable-result-windows-20261028/final/floating-chart-mode-inspector.png)
oraz [widoki zadokowane](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/movable-result-windows-20261028/final/docked-chart-mode-inspector.png).

## Granice dowodów

Próba dotyczy istniejącego wyniku i animacji w Chromium/SwiftShader. Nie jest
nowym testem GPU ani naukową kwalifikacją dyspersji. W tej próbie solver jest
zakończony; brak komend numerycznych i zachowany run ID nie zastępują próby
podczas aktywnego Solve. Wcześniejszy raport R6 dokumentuje taką próbę dla
wcześniejszej wersji paneli, nie automatycznie dla tych nowych ramek.

Zachowano wszystkie 14 obcych plików WIP; ich hashe sprawdzono względem
manifestu ochronnego. Nie usuwano danych ani nie zmieniano innych grup Docker.
