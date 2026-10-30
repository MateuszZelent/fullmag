# Punkt wznowienia po odzyskaniu miejsca WSL

27.10.2026. Branch codex/eigensolve-integration-ui-20261026, źródła przed tym checkpointem 147fa9851cc89648e4506610eaa9f3810d8f2c61. Worktree /home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026. Pełny cel pozostaje niezrealizowany.

## Odbiór wymagań planu

| Etap | Stan i dowód | Pozostały zakres |
|---|---|---|
| I0 | Audyt i kopie WIP zachowane | Pełne rozliczenie starych linii nadal otwarte |
| I1 | Inwentarz 388 commitów; f0986ede i 8ea04862 częściowo zaadaptowane z osobnymi raportami | Pozostałe fragmenty i linie wymagają review; nie uznano całych commitów za wdrożone |
| I2 | Podpisane osie k i regresje źródłowe/fixture | Pełny aktualny sweep i odbiór jego wykresu nadal otwarte |
| I3 | Run/stage/sample/mode/equilibrium/generation oraz realne pola ±10 odebrane | Akcja punkt wykresu → właściwy mod dla pełnego sweepa |
| I4 | Gamma nearest i ±10: real/imag/abs/phase, WebGL2 i animacja; +10 w zbliżeniu samego magnetyka; negatywne metadata i komunikat błędu PASS | Nie rozszerzać tego dowodu na nieobliczone próbki |
| I5 | PR262 OPEN, draft, mergeStateStatus DIRTY | Rozwiązanie konfliktów, wymagane review i CI, merge oraz kontrolowany cleanup po pełnym odbiorze |
| I6 | Source fixes 97c6c430d, 148075e43, 43ae3beba i UI 147fa9851 wypchnięte | Nowy managed runtime tych poprawek; dalsze niezaadaptowane kontrakty starej implementacji |
| I7 | Historyczny native signed14 + osobny Gamma nearest; realne ±10 w aktualnym UI | Nowy Gamma window, pełny sweep, wykres z analityką, kompletność, serial/adaptive, zbieżność mesh/airbox i COMSOL A1 ≤0,5% |

## Potwierdzone kontrole źródeł

- API/retirement: bootstrap/rust 40481439173 PASS.
- Pure-Neumann C ABI: bootstrap/native-modal 40482575121 PASS.
- MFEM shared-domain assembly: bootstrap/positive-mass 40482578832 PASS, job 122116318685.
- Import certificate digest: eigensolve-method-contracts 40483507450 PASS.
- UI 147fa9851: eigensolve-ui-method-contracts 40486139519 PASS, job 122128288004; testy, architecture hygiene, complete frontend typecheck i pinned React Doctor wszystkie PASS.
- Rzeczywisty browser pozytywny i izolowany negatywny: 2026-10-27-eigensolve-mode-field-status-ui.evidence.json. Negatywny probe zmienia wyłącznie odpowiedź w kontekście browser, nie dane solvera.

## Aktualny runtime i nierozstrzygnięta operacja

Backend nadal używa fde189663, bundle 0.1.0-dev.20261027.gfde189663bbe+9796. Nie traktować późniejszych commitów jako wykonanych przez solver. Bieżący run 016c843af31ca21339d8be8854dd6cb5ecc6a15af2373a8e9152e6658be4d874 completed. API health było healthy/active_session. Najnowsza prywatna przeglądarka z animacją +10 pozostawiona; trzy wcześniejsze własne okna zamknięte z zachowaniem wyników.

Managed development d78ffec013fb4611926ef9afd2f4e0a9; config SHA256 642e5110681eb90a39057e3c33c64e87549e36f01c8c6bccf7f6c131a31443a4. Port UI3217. Nie restartowano Dockera ani innych grup.

Retirement bce31153098a456a8f7e67326e3760a4 wymaga uzgodnienia przed nowym żądaniem aktywacji. Exact inputs SHA256 d1e2801c9b2195455593137e9c85498959dda572d8e1e3a17d852f5de443b015. Request `eigensolve-gamma-window-storage-fixed-20261027`, script examples/fem_eigen_mode_ui_de_gamma_window.py. Nie omijać stanu przez nowy request ID. Odczytać image-owned receipt i archiwum, następnie użyć istniejącego managed reconcile/resume. Żaden nowy solver Gamma nie został potwierdzony.

Katalog examples/fem_eigen_mode_ui_de_gamma_window.zarr ma 0770. Wcześniejszy Gamma window zatrzymał się przed solverem na 0750; nie jest to dowód SIGSEGV. Nie rozluźniać residualów i nie wyłączać demag dla uzyskania wyniku.

## Blokada i warunki wznowienia

Ten sam pełny wolumin WSL powtarza się przez co najmniej trzy kolejne kontynuacje. Ostatni odczyt /dev/sdf: 344 GB, ~326 GB użyte, ~60 MiB dostępne, 100%. C: miał ~15 GB i jest innym woluminem. Nie uruchamiać nowego buildu ani pełnej serii przy tym stanie.

Własne tymczasowe zależności wykresów przeniesiono z /tmp/eigen-plot-packages do katalogu wizualizacji użytkownika /eigensolve-plot-python-dependencies. 4198 plików porównano SHA256 przed usunięciem wyłącznie tymczasowego źródła; receipt eigensolve-plot-dependencies-relocation.json. Odzysk ok.157 MiB nie wystarczył. Nie ma zatwierdzonego bezpiecznego planu usunięcia cudzych cache/wyników. Docker to Docker Desktop: sprzątanie jego danych nie jest automatycznie odzyskiem miejsca na /dev/sdf.

Wznowienie wymaga zwolnienia co najmniej kilku GB (roboczo 5–10 GB, lepiej 15–20 GB) wewnątrz WSL lub konkretnego autoryzowanego planu dla zbędnych danych. Pytanie do użytkownika pozostaje otwarte. Nie tworzyć zastępczych zadań tylko dla kolejnych zielonych kontroli: krytyczna ścieżka to uruchomienie solvera.

Po zmianie stanu dysku: sprawdzić df i aktywnych ownerów; uzgodnić dokładny retirement; przeprowadzić Gamma window na zachowanej fizyce i źródłach; zdiagnozować ewentualną awarię native; załadować zweryfikowane nowe źródła przez managed Docker lifecycle; wykonać signed15 i pozostałe bramki naukowe, wykres i UI; dopiero potem I5. Zachować wszystkie istniejące dirty/untracked pliki — są wymienione przez git status i nie należały do ostatnich commitów.

## Aktualizacja po zwolnieniu miejsca — faktycznie wznowione obliczenia

Odczyt 27.10.2026: WSL początkowo 5,2 GiB wolnego, C: 21 GiB. Blokada
miejsca opisana powyżej jest historyczna. Managed retirement bce31153…
został dokończony przez wznowienie istniejącego żądania; nie edytowano lease.

Gamma frequency-window, run 83027577…, CPU/double, runtime fde189663,
dotarł do solvera. Relaksacja succeeded; eigensolve exit 1. Wyszukiwanie
ukończyło 49/50 podokien i znalazło kandydat około 9,299249697 GHz z pełnym
residualem rzędu 1e-11. Cały wynik został prawidłowo odrzucony jako
frequency_window_subwindow_failed; nie jest gotowym widmem ani dowodem
kompletności. Pełny zachowany ogon diagnostyki i tożsamości są w
2026-10-27-eigensolve-gamma-window-space-resumed.evidence.json.

Nowy run 7c8847d7… został przyjęty i faktycznie uruchomił eigenmodes.
Budżet solver_max_outer_iterations zwiększono 2000 → 10000 w Gamma-window
i signed15; nie zmieniono residualu 1e-8, EPS/KSP 1e-9, restart8,
dynamicznego demag, geometrii, Dirichleta, okna ani siatki. To próba
zwiększenia budżetu zbieżności, nie potwierdzona naprawa przyczyny.
Odbiór tego przebiegu i uruchomienie signed15 pozostają otwarte.

Postprocesor przyjmuje teraz aktualne API evidence z przypięciem SHA
skryptu, run/stage/generation, pełnego residualu i parametrów analityki.
Zachowana referencja 1D jest dopuszczana tylko po zgodności towarzyszącej
krzywej finite-airbox z bieżącą fizyką. Siedem lekkich regresji Python PASS;
legacy render do /tmp PASS. Nie generowano fikcyjnych nowych punktów FEM.

Postprocesor i regresje zapisano na origin w commicie 1b8cb43a2.

## Wynik eksperymentu iteracji i następna korekta

Run 7c8847d7… zakończył się failed po około 21 minutach. Ponownie 49/50
podokien succeeded; samo zwiększenie max_outer_iterations do 10000 nie
naprawiło wyszukiwania. Dowód: gamma-window-outer10000.evidence.json.
Przywrócono 2000 w obu przykładach; nie mnożymy kosztu signed15 bez dowodu.

CPU window NEV=4 miał NCV=16, natomiast refinement NEV=8/NCV=32 przeszedł
34/34 podokna. To przesłanka do sprawdzenia niedostatecznej podprzestrzeni,
nie ostateczny dowód przyczyny. Zmieniono wyłącznie politykę workspace:
NCV=min(split_dimension, max(NEV+1, 4*NEV, 32)) dla window; standalone
pozostaje bez zmian. Polityka raportowana jako
bounded_quadruple_nev_floor32_window_v3. NEV, tolerancje, coverage i niezależne
residuale pozostają niezmienione. Nowy test kontroluje jeden fizyczny mod,
NEV=4 i NCV=32 na fixture o split_dimension≥32; istniejące testy kontrolują
cap wymiaru oraz każde z 50 podokien. Kompilacja testów wyłącznie w CI.
Kwalifikacja runtime tej korekty: NOT VERIFIED do ponownego przebiegu.

Dokumentacja SLEPc sprawdzona przez Context7 /gitlab_slepc/slepc:
https://gitlab.com/slepc/slepc/-/blob/main/doc/source/documentation/hands-on/hands-on1.md
(opcja zwiększenia NCV przy niedostatecznej zbieżności, kosztem pamięci).

## Nowy runtime i odrębny błąd przed uruchomieniem workera

Managed rebuild succeeded: development 7f3fb666598749d38cf43e0dddd59ef5,
config 3cfcfd19ec16c4f144170074e15880c6e59615981194fd773cba59280c58aa78,
pakiet 7261e2b8068260afb607410842f17e7e9640709c. CI MFEM 40495171889
uruchomione; nie uznano go z góry za PASS.

Gamma floor32 run 9e60157a… nie dotarł do solvera. Compute scheduler
zakończył się na load exact accepted worker step for CPU environment:
typowany StoreWriterBusy po krótkim retry. Usługa zamknęła admission,
API pozostało diagnostyczne. To nie jest wynik eksperymentu NCV.

Korekta w accepted_study_supervisor.rs: tylko odczyt konfiguracji CPU
przed host launch token i spawn klasyfikuje StoreWriterBusy jako istniejący
WorkerLaunchDeferred. Zwalnia wyłącznie slot supervision; zachowuje claim,
lease i oryginalny durable Start. Scheduler już obsługuje ten typ przez
deferral tej samej pracy z możliwością cancellation/drain. Nie zmieniono
obsługi błędów po spawn ani błędów niezgodności danych. Regresja sprawdza
typowaną przyczynę, zachowanie błędu o podobnym tekście i sukces.

Stop-diagnostic-volume bez modyfikacji lease zatrzymał dokładną instancję
ze statusem stopped-execution-unknown, zachowując owner/process receipts.
Próba ścieżki pending-activation odmówiła, bo helper 331e7112… już nie istniał;
nie zmieniano ręcznie markerów ani rezerwacji. Następny krok: managed fresh
archive/recreate i ponowienie Gamma; nowy sweep nadal NIE został wykonany.

## Gamma frequency-window odebrane na poprawionym runtime

Pakiet eb15c85205eac95ea6f16a3fdcb2c16471b3a24c, development
cddca28e50fd4bceaf176a1d384c41fd, config
42b32463f1a205b05121d6af4a49b47a5669e3e47c3a99072fa314b4fe0b8649.
Run afe29d88…: obie fazy succeeded, API completed i owner-bound generation
sha256:a930b1a5c7d95e8766d4889bb70dc428a76a73708bedc9d8ab17273ee5b3b3ba.
Gamma 9299249697,073517 Hz, eps_full=1,652629543376944e-13 przy 1e-8.
Analityka finite-Dirichlet: 9299249697,068401 Hz; różnica 5,5e-11%.

Natywny certyfikat potwierdza 50/50 podokien (base 16, refinement 34),
NCV=32/32, NEV=4/8, min_subspace_overlap=1, search_stability=stable.
window_complete=false i count_certificate=not_performed pozostają jawne:
to zaakceptowane wybrane widmo, nie dowód wszystkich modów w oknie.
Dowód: 2026-10-27-eigensolve-gamma-floor32-published.evidence.json.

Browser PASS: actual complex binary, Real/Imag/Abs/Phase, aktywny WebGL,
animacja i zatrzymanie. Bounds [40,40,10] nm obejmują magnetyk bez airboxu.
Dowód: 2026-10-27-eigensolve-gamma-floor32-ui.evidence.json; zrzuty zachowane
w eigensolve-current-results/gamma-window-floor32-*.png w wizualizacjach.
CI MFEM 40495171889 PASS; CI Rust 40497276333 w toku.

Signed15 run 33b8b56d… przyjęty i rzeczywiście running. Model source SHA
8d48ad08356352d69713b29465a70e2c0ea4135f66069f3d82c2ce853dacfa2f.
Zakres [-25,-20,-15,-10,-7,-5,-2,0,2,5,7,10,15,20,25] rad/um.
Odbiór 15 punktów, wykresu i modów sweepa pozostaje otwarty do terminala.

## Wznowienie po kolejnym restarcie WSL/Docker

Oba zachowane kontenery były Exited 255; port 3217 nie odpowiadał.
18 GiB wolnego WSL i 169 GiB C: potwierdzone. Ścisły resume odmówił na
host_device 2128 → 2096, przy zgodnym inode 4599197, root ext4 i engine
81a2002d-4c88-48aa-b4da-fed771788cfa. Nie edytowano ręcznie certyfikatu.

Dodano managed `reattest-linux-device`: preview/plan SHA, kontrola zatrzymanych
konsumentów i źródeł, starego ownera/sentinela/probe; następnie ponowny native
probe pod blokadą BuildControl. Dwanaście lekkich testów Python PASS.
Rzeczywista re-atestacja succeeded: cb18b531e3d945868bed78915fe564ec,
plan 3bddc5473e80f7b24f307f04a407f096abae0fcfceb09de7501ffde53865d548,
cert SHA c13de118b9ee2762b6e103c72ebf8d92b70b9e74e99833627170804516caf5bf.
Nie uruchomiła API ani solvera i nie zmieniła żadnego lease/wyniku.

Signed15 33b8b56d… zakończył się SIGSEGV w procesie workera; wcześniejszy
wpis running jest historyczny. Gamma-window i jego browser PASS zachowane.
Diagnostyka kolejnej akcji: sprawdzić checkpointy poszczególnych k, odtworzyć
przejście nonzero → Gamma i uzyskać natywny backtrace; nie zastępować pełnego
sweepa wyłącznie zachowanym sukcesem Gamma.

## Potwierdzony duży stos na wejściu K0

Checkpointy raw_native_returned istnieją dla sample-0000…0006 (ostatni ky=-2e6);
brak checkpointu Gamma sample-0007. Nie są to zaakceptowane publiczne wyniki
całego sweepa. Walidator poisson_airbox_modal_eigen.cpp nadal wykonywał
`*result = PoissonAirboxModalEigenResult{}`. Disassembly aktualnej biblioteki
libfullmag_fem.so, validate_problem przy 0x26f0d0, rezerwuje 0xc3000+0x168
bajtów stosu; to około 780 KiB przed sprawdzeniem wejścia.

Usunięto ten tymczasowy obiekt przez destrukcję i placement new w pamięci
obiektu caller-owned, identycznie jak już w entry CPU Schur. Dodano test
publicznego wejścia na pthread stack 256 KiB: odrzuca niepoprawne żądanie,
wraca bez SIGSEGV i czyści poprzednią zawartość modów. Kompilacja testu tylko
w CI. Związek z SIGSEGV signed15 wymaga ponownego runtime, a nie samej analizy
źródeł. Referencyjne lokalne validation_result w pozostałych ścieżkach nadal
wymagają osobnej oceny; nie uznano całego kontraktu stosu za zamknięty.

Po re-atestacji resume 49bffae4… zatrzymał się poprawnie na starej tożsamości
native ownera vs nowy build. Istniejąca procedura stop-bootstrap-volume
potwierdziła dokładną diagnostyczną instancję i zatrzymała ją, zachowując
OWNER i wszystkie lease. Kolejne odtworzenie: fresh-state przez launcher.

## Pełny signed15 zakończony natywnie; naprawa projekcji po retry

Na runtime 4f6469b1c run d09693e8… miał pierwszy attempt Relax odrzucony
przed solverem przez nieaktualny compute-node sample. Po potwierdzeniu
publikowanych bieżących pomiarów wykonano publiczny POST task/retry:
retry-de-signed15-current-node-sample-20261027, expected_catalog_revision=10.
API zwróciło 202 i revision=11; zachowano ten sam run oraz zależności.
Nie poluzowano progu świeżości ani nie edytowano ledgeru.

Retry Relax epoch 2 i Eigen epoch 1 zakończyły się succeeded. Catalog revision
213; 15 checkpointów, w tym Gamma sample 7 i oba końce ±25. Maksymalny pełny
residual 2,7173e-11 < 1e-8. Gamma 9,299249697073517 GHz; −25:
13,560765016846203 GHz, +25: 13,5609139692644 GHz. Dokładne wszystkie
częstotliwości, residuale, katalog i SHA widma: signed15-stack-fixed-native
.evidence.json. Przejście Floquet → Gamma w tym runie nie miało SIGSEGV.
CI MFEM 40560264377 (w tym publiczne wejście na stosie 256 KiB) PASS.

API pozostawało na starym failed/revision=6. Ustalona przyczyna:
live_accepted_projection::poll_once przestawało czytać durable catalog po
terminalnym wyniku tego samego runu. Poprawka zachowuje ochronę starych
wyników po zmianie computational input, lecz dla niezmienionego input dalej
obserwuje katalog i explicit retry. Regresja obejmuje failed/cancelled/completed,
metadata-only edit, zmienioną fizykę i nowy run. Runtime/UI tej poprawki
pozostają do odebrania po kontrolowanym przeładowaniu; nie nazywamy starego
stanu API sukcesem. Chronimy ukończoną generację przed ponownym Solve.
