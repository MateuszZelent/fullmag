# Odzyskanie Dockera i odbiór UI eigensolve — 28.10.2026

## Wynik

Fullmag działa w dedykowanej grupie worktree pod http://localhost:3217/workspace. Przywrócono istniejące wyniki FEM z archiwum FMS, przez rzeczywisty wybór pliku w UI. Nie wykonano nowego Solve. W przeglądarce zweryfikowano dyspersję DE: 15 punktów od −25 do +25 rad/µm, z Γ, modelem analitycznym n=0 dla skończonego airboxu Dirichleta oraz osobną referencją 1D open-air. Mod Γ ma częstotliwość **9,299249697 GHz**.

Źródła uruchomionego runtime: `7abc39f3ba46a677a3dda12d0493004c87cf7eb6`, snapshot `9da324d0c9dacdc489c025e3b568d63687ff4047b88b4496ea07c31b599ea044`. Branch: `codex/eigensolve-integration-ui-20261026`; checkout: `/home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026`. Ten raport nie zmienia kodu uruchomionego pakietu.

## Naprawy i odzyskanie

1. Przy poprzednim wznowieniu naprawiono obsługę zatrzymanego frontendu przy diagnostycznym backendzie (`34fdcc207`). Zachowano dowody procesów, mountów, terminalnych zadań i zwolnionych rezerwacji.
2. Importowane widmo nie należy do aktywnego magazynu managed observations. Naprawiono jego odkrywanie: pusta lista HTTP 200; konkretne nieistniejące klatki pozostają HTTP 404 (`1aff574e3`). Usunięto rzeczywisty błąd konsoli podczas otwierania Results, zachowując kontrakt aktywnego managed store. Trzy joby [CI API](https://github.com/MateuszZelent/fullmag/actions/runs/40648641404) przeszły.
3. Kolejny restart hosta zatrzymał obie usługi kodem 255. Brakujący przypięty obraz helpera odtworzono przez Compose tej grupy. Nie zmieniono jego digestu. Ogólna diagnostyka brakującego helpera nadal jest myląca (`Cannot authenticate control record`); nie deklarujemy naprawy automatycznego odtwarzania helpera.
4. Zwykłe resume zakończyło się odmową rotacji konfiguracji starego właściciela. Dodano osobny wariant recovery **wyłącznie pustego store i pustego ledgera v4**, z udanym dowodem cgroup przypiętym do kontenera i diagnostycznym drzewem procesów (`7abc39f3b`). Stary wariant niepustych terminalnych katalogów zachowuje wcześniejsze wymagania. Testy regresji najpierw odtworzyły brak obsługi; potem przeszło 479 testów Pythona. Lokalnie nie kompilowano testów Rust/C++/TS.
5. Kontrolowany stop `d251daaed3a847328799d5699035245e`, recreate `3ab8a663f91f425aae8de132b5811b03` i development `731c60a9f12a46378716545195c3d70e` zakończyły się sukcesem. Stary namespace i dane zachowano. Przeszły bramki linux-native-v1 oraz worker-cgroup; backend i frontend są healthy.

## Weryfikacja przeglądarkowa

| Kontrola | Wynik | Dowód |
| --- | --- | --- |
| Import FMS przez UI | PASS | Inspekcja i commit pliku HTTP 200, poprawny run i generation |
| Dyspersja | PASS | Wszystkie 15 punktów zgodne z częstotliwościami źródłowymi; 501 punktów analityki i 15 referencji 1D |
| Oś k | PASS | Przełączenie odległości po ścieżce i podpisanej składowej kᵧ; Γ w zerze |
| Kliknięcie punktu → pole 3D | PASS | Próbki 0, 3, 7, 11, 14 wskazują właściwe pola; po 5127 wartości zespolonych |
| Kliknięcie analityki | PASS | Brak fałszywej akcji otwarcia modu FEM |
| Mod Γ | PASS | Real, Imag, Abs, Phase; właściwy generation i binary data plane |
| Kamera i domena | PASS | Sam film `film_geom`, obwiednia 40 × 40 × 10 nm; airbox niewidoczny |
| Animacja | PASS | Kolejne klatki zmieniają 36939–37207 pikseli; dwie klatki po zatrzymaniu identyczne |
| WebGL | PASS | Widoczny canvas, contextLost=false, niezerowy drawing buffer dla pięciu modów |
| Konsola i HTTP | PASS | Brak błędów JS i HTTP; pozostało ostrzeżenie o deprecated THREE.Clock |
| Rozmiar okna | PASS | Wykres nieucięty przy 1600×1100, 1440×1000 i 1100×900 |
| Bezpieczeństwo odbioru | PASS | Brak prób Solve/Compute Fields; dozwolone jedynie ACK wizualizacji |
| Cudzy WIP | PASS | Hash wszystkich 14 zachowanych plików zgodny z manifestem sprzed integracji |

Pełne receipty, identyfikatory oraz ścieżki screenów zawiera [dowód JSON](2026-10-28-eigensolve-docker-recovery-ui.evidence.json). Raporty i obrazy są w katalogu `/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/eigensolve-ui-recovery-20261028/after-host-restart`.

## Granice dowodu

To odbiór działania UI na zachowanych wynikach, nie nowa kwalifikacja naukowa. Renderowanie Chromium używa SwiftShader, więc nie potwierdza sprzętowego GPU. Zbieżność siatki i airboxu, kompletność widma i próg 0,5% porównania COMSOL A1 nadal wymagają oddzielnych dowodów. Maksymalne odchylenia widoczne w UI (około 0,8271% względem analityki n=0 i 0,5936% względem referencji o innych warunkach brzegowych) nie są certyfikatem solvera. Całego planu integracji ani PR262 nie oznaczono jako zakończonych. Instancja pozostaje uruchomiona zgodnie z prośbą użytkownika.
