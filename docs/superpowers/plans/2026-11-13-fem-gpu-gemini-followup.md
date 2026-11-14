# FEM GPU — plan wdrożenia zweryfikowanych zaleceń Gemini

> **Dla wykonawców:** realizować etapy w bieżącym worktree, używając `subagent-driven-development` dla niezależnego, ograniczonego podzadania lub `executing-plans` dla pracy własnej. Zlecenie użytkownika obejmuje implementację, weryfikację i integrację; plan nie tworzy dodatkowej bramki zgody.

**Cel:** przyspieszyć FEM GPU na niezmienionym SP4, zachowując operator fizyczny, energie, torque, niezależne residuum i pełny Zarr.

**Architektura:** operatory i ich bufory pozostają w natywnym `backends/fem`; Rust odpowiada za orkiestrację i zapis dowodów. Zmiany mierzyć oddzielnie od przygotowania backendu i I/O. Publiczny Python/ProblemIR pozostaje wspólny dla czterech realizacji.

**Technologie:** MFEM/HYPRE/CUDA/CUB, C++/Rust, istniejąca grupa Docker Compose przypięta do tego worktree.

**Specyfikacja:** raport Gemini przekazany 13.11.2026, sekcje C1–C7; obowiązujące kontrakty `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`, `docs/physics/0581-fem-gpu-direct-minimizer-preconditioning.md`, `docs/architecture/backend-golden-masterplan.md` i `AGENTS.md`.

## Stan początkowy i granice

- Worktree: `/home/kkingstoun/.codex/worktrees/sp4-comparison-20261102/fullmag`; branch `codex/sp4-fem-gpu-bb-preconditioner-20261111`.
- HEAD `3a27fb6c4c5fb35e3b5b79ce08826525812546fc`; potwierdzony remote master `438d917ff31694ca5b5bfb15a85cf317b1d688ec` jest przodkiem HEAD.
- Grupa: `fullmag-worktree-fullmag-a8342df1f0247d61`. Build, natywne testy i runtime tylko przez zarządzany launcher, w stałym backendzie tej grupy.
- Cudza zmiana `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` pozostaje poza commitami zadania; SHA-256 zastanego pliku `548f29641e29221d91431827d8d7b99fd81f84c06e5394ecd68e70dac30ae0bd`.
- Istniejąca lokalna poprawka C6 łączy dwie normy w jeden 16-bajtowy odczyt. Nadal używa jednego bloku oraz skalowanej normy. Wieloblokowość, pinned output i fuzja PCG nie są wdrożone.
- Bramka zarządzana `fem-demag-poisson` przeszła po regresji RED→GREEN licznika D2D: attempt `c1321d9442c641bd910f25b1b67a4a0e`, snapshot `49e15a11671533dd16b06b2ce09ee838630427abc4523affa484edf5e621cae0`, biblioteka `c078a75a57a5655c1f0fbd9965c52745711f1fb6771de8c99f97e23d7053e785`; compile/test exit 0, odpowiednio 13,122 s / 5,200 s. To dowód testów natywnych, a nie nowego czasu ani parytetu SP4.
- Nowy ext4 na E: zawiera zachowaną kopię danych, ale przełączenie i zwolnienie oryginałów WSL nie są zakończone. Nie rozpoczynać nowej symulacji przy niewystarczającym miejscu. Nie formatować ani nie tworzyć dysku ponownie.

## Niezmienne kryteria

- Ścisłe FEM GPU bez fallbacku CPU; FDM CPU, FDM GPU i FEM CPU zachowują swoje kontrakty.
- Każdy solve Poissona certyfikuje rzeczywiste `A*x-b`, z progiem względnym `1e-12`; nie zastępować go residuum rekurencji PCG.
- Zachować wewnętrzne tolerancje Poissona i istniejące doprecyzowanie Armijo. BB: bieżące `1e-10` wewnętrznie i jawny certyfikat `1e-8`, bez luzowania dla wyniku czasowego.
- Po terminalnym latch PCG najwyżej 7 dodatkowych wywołań AMG. Zachować limity iteracji oraz osobne liczniki Physical/HotLoop i ich zakresy rollbacku.
- W kwalifikacji statycznej wspólny torque `1e-8 T`; względny błąd całkowitej energii do `1e-9`, niezerowych składowych do `2e-6`, zerowych do `1e-30 J`.
- Kohorta historycznych ~45 s używa `1e-6 T`: jej pomiar A/B ma identyczny próg. Nie mieszać go z kwalifikacją przy `1e-8 T`.
- Każdy bieg ma sąsiednie `.py` i kompletne `.zarr` na ext4 hosta, wraz z siatką, źródłami i provenance. Nie usuwać wyników ani nie ograniczać zapisu w celu poprawienia czasu.
- Wnioski o przyspieszeniu wymagają identycznych wejść, biblioteki/źródeł przypiętych hashami, wyłączonego profilera w kohorcie czasowej i przeplatanych powtórzeń. Czasy CPU i GPU oraz nakładające się fazy nie są addytywne.

## Ryzyka wymagające osobnych regresji

1. Zero RHS, NaN/Inf, gwałtownie mniejsza liczba iteracji i rejected solve: ograniczone AMG oraz brak skażenia kolejnego rozwiązania.
2. Energię zaakceptowanej próby wolno reużyć; torque, moment i pozostałe obserwable muszą pochodzić z aktualnego stanu.
3. Refinement Armijo, rollback i trzy końcowe potwierdzenia: brak energii/potencjału z odrzuconej lub innej próby.
4. Zmiana macierzy, siatki, materiału, granicy lub ustawień solvera: invalidacja warm-startu i przygotowanych grafów.
5. Nowe redukcje i maskowanie składowych: skończoność, zakres dynamiczny, dodatnia krzywizna i niezależny certyfikat każdej składowej.

## Etapy wykonania

### 1. C6 — wspólny odczyt norm certyfikatu

Pliki: `backends/fem/gpu/cuda/demag_poisson/demag_kernels.{cu,hpp}`, `hypre_device_solver.cpp` oraz istniejące fixtures residuum i test `demag_poisson_contract.cpp`.

- [x] Zachować obliczenie rzeczywistego residuum, skalowaną normę, błędy RHS/NaN/Inf i osobną ścieżkę jednorzędową.
- [x] Dwie normy odczytać jednym transferem 16 B, bez alokacji w gorącej pętli; poprawić liczniki i regresje aliasowania/ekstremalnego zakresu.
- [x] Poprawić błędną asercję mandatory przez odczyt `ctx.transfer_audit.audit.mandatory_controls_hot_loop` przed i po solve.
- [x] Zarządzana bramka `fem-demag-poisson`: kompilacja i wykonanie; sprawdzić liczby certyfikatów, nie tylko mniejszą liczbę fence.
- [ ] Review i osobny commit tego etapu po adekwatnej weryfikacji.

### 2. C7 — energia zaakceptowanego trialu bez ponownej redukcji

Pliki: `gpu/cuda/integrators/rk/rk_step_stats.{hpp,cu}`, `gpu/cuda/relaxation/pgbb.cpp`, `tests/cuda_pgbb_reuse_contract.cpp`, względem `backends/fem`.

- [x] Dodać wewnętrzną finalizację przyjmującą hostowe `terms_j` z ostatniej zaakceptowanej próby. Overlay obejmuje wyłącznie 9 publikowanych energii (Robin boundary pozostaje osobną diagnostyką), przed walidacją i publikacją.
- [x] Zachować świeżą redukcję observable, dotychczasowy odczyt 18 slotów, timing, fence, błędy oraz skutki uboczne finalizera. GPU scalar scratch może być nadpisany przez obliczenia BB: nie traktować go jako cache energii.
- [x] Wyłącznie zwykły zaakceptowany krok korzysta z nowej ścieżki. Potwierdzenia stacjonarne i ścieżki błędów zachowują pełną finalizację. Refinement przekazuje dokładnie swój zaakceptowany snapshot.
- [x] Regresja w istniejącym allowlisted `fem-cuda-pgbb-reuse`: zatruć resident energy slots, odzyskać wszystkie energie, zachować niezerowe torque/moment oraz odrzucenie NaN/Inf. Zachować testy key drift i zużywania tokenu cache.
- [x] Bramka natywna i niezależny review C7. Nie zmieniać pointerów magnetyzacji ani ABI.
- [ ] Commit zweryfikowanego etapu; pełny pomiar SP4 pozostaje oddzielną bramką.

### 3. C4 i kompletność pomiarów

Właściciele: natywny lifecycle `backends/fem/cpu/mfem/runtime/backend_lifecycle.cpp`, inicjalizacja Poissona w `backends/fem/gpu/cuda/demag_poisson/operators.cpp`, `crates/fullmag-runner/src/native_fem.rs` i istniejące struktury telemetrii/artifacts.

- [ ] Rozdzielić mierzone przygotowanie siatki/przestrzeni, operatora, AMG i początkowych obserwacji, używając jawnych czasów hosta oraz istniejących granic synchronizacji; nie dodawać fence tylko dla licznika.
- [ ] Przed rozszerzeniem publicznej struktury sprawdzić istniejące wersjonowane snapshoty i ich odbiorców. Uzupełnić serializację i jednostki; nie reinterpretować starego ABI.
- [ ] Regresja: timingi są dostępne również bez aktywnego accepted-step attempt, a Physical nie gubi 8 B inicjalnej kopii D2D. Dane odrzuconych prób nie znikają z Physical.
- [ ] Profil W1/W6 z pełnym Zarr i bliźniakami OFF: kompletność CUPTI bez dropped records i jawny narzut profilera. Nie kwalifikować starego częściowego śladu.

### 4. C1 — najdroższa część: AMG/SpMV i replay

Właściciele: `gpu/cuda/runtime/hypre_device_policy.cpp`, `gpu/cuda/demag_poisson/hypre_device_solver.cpp`, ich workspace i natywne kontrakty.

- [ ] Oddzielnie porównać vendor/native SpMV na identycznym operatorze. Polityka HYPRE jest procesowa: wybór musi być jednokrotny, jawny i zapisany w provenance; nie przedstawiać globalnego przełączenia jako ustawienia tylko jednego poziomu.
- [ ] Oddzielny eksperyment wygładzacza Chebysheva. Zachować liniowość, symetrię i dodatnią określoność wymaganą przez CG, wspólną tolerancję i certyfikat. Jawnie raportować faktyczny outer engine; obecny DeviceScalarPCG kwalifikuje relax/coarse 18.
- [ ] Sprawdzić capture-safety HYPRE i strumieni przed replay. Graf posiada bufory i klucz operatora; status D2H i niezależny certyfikat pozostają poza capture. Błąd capture nie uprawnia do CPU fallbacku.
- [ ] Native regresje zero/NaN/Inf, zmiany workspace i limitu post-latch; następnie porównanie SP4 A/B. Promować szybszy wariant dopiero po spełnieniu bramek naukowych.

### 5. C2 — certyfikowany warm-start zaakceptowanego potencjału

Właściciele: `gpu/cuda/demag_poisson/{operators.hpp,stage_compute.cpp,hypre_device_solver.cpp}`, stan/rollback PGBB i nota 0532.

- [ ] Przed zmianą opisać następstwo zaakceptowanego potencjału w nocie naukowej i source map: niezmienione równanie, mianownik `b^T C b`, klucz macierzy i wszystkie invalidacje.
- [ ] Bufor zaakceptowanego potencjału pozostaje na GPU, alokowany przy przygotowaniu. Próba czyta ten bufor, ale publikuje następcę dopiero po pełnej akceptacji Armijo/finalizacji; odrzucenie nie zmienia zapisanego potencjału.
- [ ] Pierwszy solve, zmiana klucza, błąd i końcowe potwierdzenia używają świeżego startu. Każdy warm solve nadal przechodzi rzeczywiste `A*x-b`; certyfikat nie jest pomijany.
- [ ] Regresje: exact/near warm guess, odrzucona i refined próba, rollback, zmiana operatora oraz recovery po błędzie. Osobno zmierzyć PCG iterations, solve i czas całego biegu.

### 6. C5/C6 — dalsza praca wyłącznie na GPU

Właściciele: `gpu/cuda/relaxation/bb_exchange_mass{,_kernels}.{cpp,cu,hpp}`, `pcg_device_scalar_kernels.cu`, `demag_kernels.cu`, przygotowanie scratch i ich fixtures.

- [ ] Dla BB przygotować wariant trzech niezależnych, maskowanych CG z osobnymi skalarami każdej składowej; obecny wspólny CG nie pozwala bezwarunkowo pominąć jednej składowej. Zachować prawdziwy certyfikat każdej składowej i istniejącą projekcję/descent check.
- [ ] Porównać oba algorytmy na zamrożonym operatorze i RHS dla kroków `1e-12`, `1e-9`, `1e-6 m/A`, następnie całe SP4. Zmiana trajektorii wymaga bramek energii i torque, nie deklaracji bitowej identyczności.
- [ ] Zbadać fuzję update/gate/zero-z z zachowaniem statusów terminalnych i granic kernelowych potrzebnych do widoczności błędów. Wieloblokowa norma zachowuje skalowanie, NaN/Inf i prealokowany scratch; nie obiecywać bitowej identyczności po zmianie kolejności redukcji.
- [ ] Osobne native regresje i pomiary; nie luzować tolerancji, żeby osiągnąć raportowe `<5 ms`.

### 7. Rozstrzygnięcia C3 i pozostałej części C7

- [x] Odrzucić history-only pierwszą paczkę `last_iterations-1`: kontrprzykład `last=66`, bieżące `I=1` daje 64 post-latch AMG. Budżet odczytów statusu nie dowodzi zachowania limitu 7.
- [ ] Zachować ten kontrprzykład jako wykonywalny guard dla każdej nowej polityki kolejkowania/replay; optymalizować narzut uruchomień bez osłabienia limitu.
- [x] Brak pracy nad domniemaną alokacją `solver_kind`: już w audytowanym commicie jest `const char*`.
- [ ] Zamiany pointerów `m_stage/m` nie wdrażać jako prostego swapu po akceptacji. Ewentualna zmiana musi objąć ewaluację wszystkich triali, odrzucenia, aliasy i lifetime snapshotów; nie blokuje etapu 2.

### 8. Pomiary, cztery realizacje i integracja

- [ ] Dokończyć przełączenie magazynu SP4 i potwierdzić rzeczywisty zapis nowego Zarr na nowym ext4. Usuwanie oryginałów wyłącznie po kwalifikacji; pozostałe dane E: chronione.
- [ ] Wykonać przygotowaną serię 18 biegów BB/CPU i przeplatane porównania nowych wariantów Poissona. Każda tabela podaje źródła, bibliotekę, siatkę, tolerancję, kroki, iteracje, wszystkie energie, torque, certyfikat i pełny Zarr.
- [ ] Zachować rozróżnienie: zgodność FEM CPU/GPU na jednej siatce nie zamyka rozbieżności FEM z FDM/MuMax3 ani dynamiki A/B.
- [ ] Wznowić pozostałe porównania czterech solverów z MuMax3 GPU i interaktywny viewer dopiero z przypiętymi aktualnymi wynikami.
- [ ] Każdy niezależny zweryfikowany etap commitować selektywnie; końcowo review, CI SP4, PR do master, merge i lokalna weryfikacja integracji. Worktree/środowisko wycofać dopiero bez aktywnych konsumentów i unikalnej pracy.

## Rejestr wykonania

- 13.11.2026: użytkownik zlecił wdrożenie zweryfikowanych zaleceń. Etap 1 wymaga ponownej natywnej bramki po błędzie asercji; etap 2 przekazany bounded workerowi. Nowego przyspieszenia SP4 ani zakończenia migracji nie potwierdzono.
