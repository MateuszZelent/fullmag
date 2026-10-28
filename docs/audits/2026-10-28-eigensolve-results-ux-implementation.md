# Wdrożenie audytu Results UX — 2026-10-28

Plan: [audyt](2026-10-28-eigensolve-results-ux-audit.md). Worktree: eigensolve-integration-ui-20261026.

| Etap | Stan | Dowód / pozostałe prace |
| --- | --- | --- |
| R1 | Implementacja + browser PASS; CI oczekuje | Zakładki rozdzielone, kolekcja bez pól pojedynczego artefaktu, poprawione undamped/phasor/residual. `scripts/verify_eigensolve_results_ux.mjs`: cztery różne widoki, brak page errors i mutacji. |
| R2 | Implementacja + browser PASS; CI oczekuje | Kategoria z liczbą badań, zwięzły overview modu i dyspersji, szczegóły zwinięte, bez stopki edycji dla wyników. |
| R3 | Implementacja + browser PASS; CI oczekuje | Etykiety fizycznego k i f, zachowane klucze tożsamości, jawny run i liczba badań kolekcji. |
| R4 | Implementacja + browser PASS; CI oczekuje | Jedno Color by, warunkowe controls, ścisły owner aktywnego pola, Back to chart/Fit mode. |
| R5 | Implementacja + browser PASS; CI oczekuje | Telemetryka na żądanie, przycisk dolnego panelu, responsywny wykres. Pierwszy test wykrył ucięcie przy 1440×900; poprawiono wysokość. |
| R6 | W toku | Macierz browser i CI; specs 13/32/33 zaktualizowane. Badanie z nową osobą pozostaje NOT VERIFIED. |

Dowody R1: `/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/eigensolve-results-ux-implementation-20261028/r1-browser.json`. Baseline audytu odtworzył identyczną treść zakładek. Pierwsza nowa próba harnessu została przerwana timeoutem zrzutu ekranu; nie była zaliczona. Kolejna próba DOM bez screenshotów: PASS, kategoria 0 brakujących wartości, overview bez przewijania, konwencja/tłumienie w Data, residual w Diagnostics. Testy TS zaktualizowane, bez lokalnej kompilacji zgodnie z zakazem; wykonanie w GitHub Actions pozostaje wymagane.

Nie wykonano nowych obliczeń, nie zmieniono kontraktu fizyki. Czternaście wcześniejszych zmian dokumentacji innych etapów pozostaje poza stagingiem. Integracja całego istniejącego PR oraz cleanup nadal wymagają własnych bramek i kontroli WIP.


R2/R3 zapisano w `d8481507975d6b0b48bbe6375e7f5ad2e505c38b`; R1 w `52439e27ac3228ee091ec73a2d85baa65ce9ec0b`. Hook React Doctor nie ukończył analizy (oxlint: `Unexpected discriminant 7 for TSTypeName`); nie jest to dowód PASS. Nie zmieniono konfiguracji ani nie pominięto hooka.

R4/R5 pierwszy browser: brak błędów JavaScript, pola −25/Γ/+25 załadowane z żywym WebGL. Test zatrzymany na ucięciu wykresu przy 1440×900; wynik zachowany jako FAIL w `/tmp/results-r45-workbench/report.json`. Poprawka sizingu i etykiet podlega kolejnej kontroli. To test istniejącego archiwum FEM przez SwiftShader, nie nowe obliczenia ani dowód GPU.


Powtórny browser R4/R5: **PASS**. Raport i screeny: `eigensolve-results-ux-implementation-20261028/r45-browser/` w katalogu wizualizacji tego wątku. Sprawdzono 15 częstotliwości z artefaktu, 2 referencje, 3 rzeczywiste pola (−25, Γ, +25; każde 5127 wartości zespolonych), żywy WebGL i widoczną powierzchnię, brak akcji FEM po kliknięciu referencji, dwie osie k, układy 1600×1100 / 1440×900 / 1100×900 i hide/show dolnego panelu. Błędy JS/HTTP oraz niedozwolone mutacje: 0. Ukrycie dolnego panelu powiększyło wykres; przywrócenie odtworzyło wysokość. Nie wyłączano solvera, nie tworzono drugiego viewportu.
