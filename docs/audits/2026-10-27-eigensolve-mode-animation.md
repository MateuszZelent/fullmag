# Rzeczywisty mod +10 rad/µm: animacja i wykres

Źródła UI: `8c22f4dcb4e030e70b7af33aa7f253a51aa27164`; runtime solvera: `59f23cd815c6ed24dd9ea5201002cd7918ba24ab`. Wynik: 11,2118866497 GHz, pełny residual 1,6021e-13. To ten sam ukończony run, bez nowego Solve.

## Weryfikacja przeglądarki

`verify_eigen_mode_ui.mjs --verify-animation` zapisuje pięć klatek rzeczywistego modu po Animate i dwie po Stop. Przegląd obrazów oraz różnic pikseli wykazał zmiany wyłącznie w prostokącie powierzchni filmu (około x=156..455, y=161..390). Dwie klatki po Stop są identyczne. Nie stwierdzono błędów konsoli ani utraty kontekstu WebGL. Kontrole właściciela wyniku, generacji, binarnego pola oraz reprezentacji pozostały aktywne.

To PASS animacji i zatrzymania jednego rzeczywistego modu; nie jest to kwalifikacja wszystkich modów, sprzętowego GPU ani poprawności fizycznej przestrzennego pola. Ogólny weryfikator zapisuje `pixelsVerified=false`, dopóki osobny przegląd klatek nie potwierdzi obrazu; stała amplituda może być poprawnym zachowaniem innych modów.

## Wykres

`scripts/plot_eigensolve_reproduction_checkpoint.py` przedstawia osobno 15 historycznych punktów, historyczną referencję 1D open-air basis16, analitykę n=0 dla skończonego airboxu i jeden nowy punkt +10. Nowy punkt ma błąd −0,146% względem zachowanej tabeli 1D. Nie skopiowano historycznych częstotliwości jako nowych wyników. Historyczne Gamma pozostaje selected-only; pełna reprodukcja nowego sweepa, zgodność siatki i zbieżność pozostają otwarte.

Dowody liczbowe i ścieżka zachowanych klatek: `2026-10-27-eigensolve-mode-animation.evidence.json`.
