# Dokowanie całego workspace i czytelny układ modów

Cel użytkownika: dowolnie przestawiać Inspector, Explorer i diagnostykę,
również nad/pod innym panelem; ustawić mody po lewej i spektrum po prawej.

1. **Model:** rekurencyjne podziały poziome/pionowe, pojedyncza instancja
   każdego panelu. Układ, kolejność i proporcje zapisuje lokalny
   `fullmag.workspace.dock-tree.v1`. Walidacja odrzuca brakujące/powtórzone
   panele, błędne rozmiary, duplikaty splitów i zbyt głębokie drzewo.
2. **UI:** panel można przeciągnąć do krawędzi całego workspace (pas 12 px)
   albo do krawędzi innego panelu (wewnętrzny pas do 32 px). Podgląd mówi,
   którego obszaru dotyczy operacja. Każdy panel ma także kierunki dokowania
   w menu, a „Reset panel arrangement” przywraca domyślny układ.
   „Modes | Spectrum” dokuje 3D po lewej i Analysis po prawej. Zachowuje
   wybrany wynik; jeśli wynik nie jest wybrany, podpowiada przejście przez
   Results → Modes at k → Show mode in 3D. Back to chart nie zwija już takiej pary.
3. **Weryfikacja:** CI modelu drzewa, SSR, typecheck i właściwe regresje UI;
   przeglądarka z opublikowanym modem: wszystkie panele, podziały wewnętrzne,
   preset, tożsamość canvasów i paneli, zapis/odtworzenie i reset. Bez Solve.
4. **Dowody:** screenshoty i raport końcowy, commit/push bieżącej gałęzi.

Status: **4/4 wykonane** w zakresie dokowania całego workspace;
CI i obie próby przeglądarkowe PASS. Oddzielna bramka aktywnego solvera R6
pozostaje NOT VERIFIED w tym teście (szczegóły poniżej).

## Lifecycle i zgodność

ResizablePanelGroup zawiera wyłącznie kotwice pomiarowe. Wszystkie panele
żyją jako stałe, kluczowane rodzeństwo poza drzewem podziałów. Zmiana
miejsca/dokowanie nie przenosi modułu w React i nie tworzy drugiej instancji.
Istniejące reguły Activity oraz niesuspendowanego Inspectora pozostają;
ukryte i pływające panele usuwają tylko swoje kotwice. Compact-screen drawers
pozostają domyślnym zachowaniem; jawne dokowanie użytkownika ma pierwszeństwo.

Stary zapis kolumn/proporcji pozostaje w localStorage; nowy model ma oddzielny
klucz i rozpoczyna od domyślnego drzewa, bez usuwania starych preferencji.
Rozmiary pływających PanelFrame nadal używają dotychczasowych kluczy.
Dane wyników, model fizyczny i komendy solvera nie należą do tej zmiany.

## Review i granice dowodów

Implementacja: `3eb8898554c875773c1a9cf7e539f5a08ccebf7a`.
[CI 40787829242](https://github.com/MateuszZelent/fullmag/actions/runs/40787829242):
**1451 testów / 63 pliki PASS**, w tym sześć testów modelu dokowania,
SSR workspace, kontrakty Inspectora i modalnego UI. Typecheck i kontrola
architektury PASS. Testów jednostkowych nie kompilowano lokalnie.

React Doctor hook: 89/100, dwa ostrzeżenia `js-set-map-lookups` w istniejącym
wyborze modułów `ViewportTabHost`. Przegląd: tablica wybranych modułów ma
maksymalnie dwa elementy, a lista widocznych pochodzi z małego rejestru UI;
nie jest to pętla po modach ani danych siatki. Brak istotnego problemu
wydajnościowego w tym miejscu (wysoka pewność); bez wyciszania reguł.

Weryfikacja używa opublikowanego wyniku FEM `k_y=+10 rad/µm`,
`11.211886649715792 GHz`, run
`run-live-bf62fc7d346d46ad1cca97c205d6d59a96eeca8f708d37fefacf09dd5cdb5c01`.
Nie uruchamiano nowego Solve i nie aktualizowano backendu. Dowód obejmuje
prezentację wyniku i przełączanie animacji; nie zamyka wcześniejszej bramki
R6 przenoszenia paneli podczas aktywnego solvera. WebGL przez SwiftShader
nie stanowi dowodu użycia fizycznego GPU ani walidacji fizyki.

Zachowano bez zmian SHA-256 14 wcześniejszych plików WIP spoza tego zadania.

## Końcowa próba przeglądarkowa

`verify_eigensolve_workspace_docking_ui.mjs`, Chromium 1600×1100:

- „Modes | Spectrum”: 3D po lewej, Analysis po prawej; Back to chart zachowuje parę.
- Zmiana szerokości Explorera i wysokości diagnostyki rzeczywistym przeciągnięciem separatorów.
- Inspector: lewa krawędź workspace, następnie pod viewportem.
- Explorer: prawa krawędź workspace, następnie nad viewportem.
- Diagnostics: lewa krawędź workspace, następnie po prawej Inspectora.
- Odtworzenie struktury z localStorage w drugiej stronie przeglądarki.
- Przy szerokości 895 px jawne dokowanie Inspectora ma pierwszeństwo przed drawerem.
- Reset układu, ponowny preset i dopasowanie kamery do modu.

Dziesięć checkpointów zachowało te same węzły canvasów wykresu i 3D oraz
Inspectora, Explorera i diagnostyki. Każdy miał widoczny canvas, niezagubiony
kontekst WebGL i niezerowy drawing buffer. Zero błędów pageerror i zero
prób niedozwolonych mutacji; run_id bez zmian. Próba kompaktowa dotyczy
samego układu na nowej stronie, bez odtwarzania wyboru wyniku między kartami.

[Dowody i hashe](2026-10-29-eigensolve-all-panel-docking.evidence.json).

[Końcowy układ mod + spektrum + Inspector](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/all-panel-docking-20261029/final/final-modes-spectrum-inspector.png).

[Podgląd dokowania Inspectora](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/all-panel-docking-20261029/final/inspector-dock-preview.png).

[Dowolny układ wszystkich paneli](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/all-panel-docking-20261029/final/custom-all-panels.png).

[Inspector zadokowany w oknie 895 px](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/all-panel-docking-20261029/final/compact-inspector-docked.png).
