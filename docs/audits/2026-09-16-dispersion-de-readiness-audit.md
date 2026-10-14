# Audyt gotowości dyspersji DE z demagiem — 2026-09-16

## Wniosek

Kod zawiera natywną ścieżkę FEM CPU dla niezerowego k, ale nie mamy jeszcze zweryfikowanej serii częstotliwości DE z dynamicznym demagiem dla aktualnego snapshotu. Nie należy uznawać zgodności kontroli C0 bez demagu za potwierdzenie C1. Najkrótsza droga do wiarygodnego wykresu prowadzi przez mały, osobny benchmark DE, diagnostykę operatora demagu i poprawki opisane poniżej.

Audyt obejmuje aktualny dirty worktree, istotne ścieżki operatorów/solverów, benchmark, bramki naukowe, dokumentację oraz dostępny przebieg tego wątku i artefakty. To przegląd ukierunkowany na pierwszy poprawny wykres, nie pełna certyfikacja całego repozytorium. Nie zmieniano solvera ani nie uruchamiano nowego builda; nie kompilowano testów jednostkowych. Nowy wynik C0 pochodzi z wcześniej uruchomionego zadania.

## Tożsamość i aktualne dowody

- Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- HEAD: `a7723cf0b3dd179f32da5294dbda8dcd685b6e14`; liczne zmiany niezacommitowane, zatem HEAD sam nie identyfikuje badanych źródeł.
- Managed build: `895df90a7cc9434b805f0318322c43b4`, profil `fem-cpu-slepc-runtime-v1`, zakończony powodzeniem; kwalifikacja pozostaje `NOT VERIFIED`.
- Source digest buildu: `1187434515ec5e2c8eaee415d73b0ed21f7b5c5e5385e0efd37bef6e9c0f45d7`.
- Source snapshot SHA256: `828ac13bdab9c36e2a40389a7823992f047ec581f92a418f0bf04ed913dc0181`.
- Obraz: `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`.
- Run C0: `1b899bd9566a487fa0d44473dbb5f902`, `return_code=0`, `timed_out=false`, `completed_unqualified`, około 1245 s całego zadania.
- Katalog dowodów: `C:/git/fullmag/storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/895df90a7cc9434b805f0318322c43b4/comsol-dispersion/1b899bd9566a487fa0d44473dbb5f902`.
- `run-result.json` i `c0/runtime.log`: jeden mod przy k=0, bez demagu, **2.800264212917637 GHz**; analityka **2.800264212915110 GHz**, błąd względny około **9.02e-13**. To rzeczywisty wynik solvera dla kontroli C0, nie krzywa dyspersji.
- Siatka C0: 108843 węzły, 615578 tetraedrów, 5099 węzłów magnetycznych. Odczytany rozmiar domeny 200 × 200 × 4010 nm. Tak duża domena jest kosztowna jak na kontrolę bez demagu.
- Bramka C0 odrzuca identyfikator siatki oraz brak zbieżności mesh/mode_count; kompletna kwalifikacja wymaga ponadto C1 i A1. Zgodny Kittel/Larmor nie znosi tych braków.

## Ustalenia wymagające naprawy

### DE-01 — P1: niezgodne wersje identyfikatora siatki blokują bramkę

**Potwierdzone w kodzie i aktualnym C0.** `crates/fullmag-runner/src/types.rs:2288`, `fem_mesh_topology_fingerprint`, wywołuje `fem_mesh_topology_fingerprint_v3`. Handoff w `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs:183` korzysta z tej funkcji. Natomiast `scripts/validate_comsol_dispersion_scientific_gate.py:850–868` przelicza i porównuje bezwarunkowo `mesh_topology_fingerprint_v2` z `scripts/comsol_mesh_identity.py`.

W aktualnym artefakcie pola `source_mesh_topology_sha256` wynosi `sha256:1ec41d9f6e34f60fa358aa24379f58444d326a41eb476b78aaa78cbaf2c5abe8`, a `source_mesh_identity.topology_fingerprint` ma inną wartość: `sha256:6ceea5e1c7c1da469c4a18e1f7ec461ef019d446a4233b385f1c1132ad023183`. Bramka zgłasza `modal field topology differs from the numeric mesh`. Niezależne ponowne przeliczenie v2 z `c0/metadata.json` dało dokładnie `sha256:6ceea5e1c7c1da469c4a18e1f7ec461ef019d446a4233b385f1c1132ad023183`, czyli wartość `source_mesh_identity`, a nie hash v3 handoffu.

Skutek: poprawny wynik liczbowy może być odrzucony przez porównanie różnych kontraktów hash. Różnica hash nie dowodzi sama w sobie innej geometrii. Naprawa musi ujednolicić wersjonowanie producentów, handoffu, metadanych i walidatorów; nie wolno wyłączyć kontroli ani akceptować dowolnego z dwóch hash. Potrzebny test zgodnej siatki i negatywny test zmienionej kolejności węzłów/topologii.

### DE-02 — P1: globalne składanie kolumna po kolumnie ogranicza wykonalność nonzero-k

**Potwierdzone w kodzie, koszt konkretnego C1 jeszcze niezmierzony.** `backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp:418–481`, `assemble_floquet_bloch_scalar_tangent_source`, tworzy każdą kolumnę przez nowy globalny `LinearForm.Assemble()` i przegląd wszystkich wierszy. Bez mapy magnetycznej szerokość to `2*dof_count` całej domeny, łącznie z powietrzem.

`backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp:584–600` nie ustawia dostępnego `magnetic_reduced_node`. Ścieżka jest osiągalna przez `modal_eigen_solver.cpp:1800–1875` i `operators/poisson_airbox_shared_domain.cpp:3118–3168`; sam końcowy operator `MatShell` nie usuwa tego etapu składania.

Dla N=108843 oznaczałoby to 217686 globalnych składań oraz około 23.7 miliarda odwiedzin wierszy. Jest to oszacowanie struktury pętli, nie pomiar C1 ani deklaracja alokacji gęstej macierzy. Poprawka: bezpośrednie lokalne składanie rzadkiego prostokątnego sprzężenia na elementach magnetycznych i redukcja Blocha. Samo podanie mapy magnetycznej zmniejsza koszt, ale pozostawia globalne składanie dla każdej kolumny.

### DE-03 — P1: rzeczywisty target dla nieobróconego widma ±iω

**Potwierdzona niespójność adaptera; nieudowodniona przyczyna starej rozbieżności C1.** `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp:213–315` ustawia target `2*pi*f` na osi rzeczywistej dla surowego uogólnionego problemu stiffness/gyrotropic, którego częstotliwości odczytuje następnie z części urojonej λ. Rzadka ścieżka tego adaptera przekazuje macierze bez obrotu (`:500–555`).

Odległość punktu iω od rzeczywistego targetu σ to sqrt(σ²+ω²), więc taki shift nie wybiera modów w pobliżu zadanej częstotliwości. Może preferować niskie mody i pominąć zadane okno. Dobry residual zwróconej pary nie dowodzi kompletności okna.

Oddzielny `modal/floquet_modal_solver.cpp` jawnie obraca problem i odwzorowuje wynik z powrotem na λ; rzeczywisty target jest tam uzasadniony tym przekształceniem. Nie należy mechanicznie zmieniać obu solverów tak samo. Naprawa wspólnego adaptera wymaga testu co najmniej dwóch znanych częstotliwości, niezerowego targetu, znaku konwencji i residualu pierwotnego równania.

### DE-04 — P1 dla walidacji: orchestrator nie dostarcza dowodów, których wymaga bramka

**Potwierdzone.** `scripts/run_comsol_dispersion_benchmark.py:918–945` zapisuje puste `analytic_controls` oraz `pending` dla mesh, airbox i mode_count (airbox nie dotyczy C0). Następnie uruchamia pełną bramkę. Zwykłe pojedyncze wywołanie C1 nie może samo zamknąć kwalifikacji.

To prawidłowe odrzucenie niepełnego dowodu, a nie fałszywy sukces. Brakuje wykonania i agregacji porównań. Potrzebny osobny, jawnie ograniczony benchmark kilku punktów DE oraz późniejsze zebranie pełnych dowodów C0/C1/A1. Nie obniżać wymogu 61 próbek/8 pasm kanonicznego C1 tylko po to, aby krótki przebieg przeszedł.

### DE-05 — P2: obecne konfiguracje nie są krótkim benchmarkiem DE dla parametrów C1

`tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py:138–153`: ścieżka Γ–X–M–Γ, przy M0 wzdłuż x, zaczyna się konfiguracją BV (k równoległe do M). Dalsze odcinki są ukośne; nie dostarczają prostego ciągu niezerowych punktów wzdłuż y. Konfiguracja 61 punktów/24 żądanych modów jest nadmierna do pierwszej diagnozy.

`examples/fem_eigenmodes_dispersion_de_bv_low_k.py` stosuje inny materiał i film: Ms=140 kA/m, A=3.5 pJ/m, B=0.05 T, t=20 nm oraz tolerancję 10%. Nie jest bezpośrednim zamiennikiem Py C1. Tolerancja 10% może ukryć mały sygnał dyspersji. Wartości przykładu mogą pozostać jego jawnymi parametrami, ale nie powinny pełnić roli uniwersalnych limitów solvera.

### DE-06 — P2: protokół zbieżności airboxu wymaga rozdzielenia błędu fizycznej granicy od błędu FEM

`validate_comsol_dispersion_scientific_gate.py:2258–2349` wymaga małych różnic obu par coarse–medium oraz medium–fine, a także zgodności z primary. Dla poprawnego modelu Γ z Dirichletem zmiana paddingu 1→2→4 µm daje fizyczne przesunięcia większe niż próg 2e-4. Zatem taki trzyrozmiarowy zestaw nie przejdzie nawet przy dokładnym rozwiązaniu każdego skończonego pudełka.

Nie jest to dowód błędnego demagu ani powód do arbitralnego poluzowania progu. Należy osobno sprawdzić zgodność z dokładnym rozwiązaniem skończonego pudełka i zbieżność do granicy otwartej; dla tej drugiej dobrać większe domeny lub uzasadnioną ekstrapolację. Obecne wymaganie bliskości wszystkich poziomów primary jest również silniejsze niż standardowe badanie zbieżności coarse→fine.

### DE-07 — P2: dokumentacja statusu miesza implementację i walidację

`docs/audits/2026-09-16-fix-status-update.md` opisuje blokadę kompilacji `mfem.hpp`, podczas gdy nowszy managed build zakończył się powodzeniem. Fragmenty `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md` około linii 678, 697 i 996 opisują brak podłączenia ścieżki nonzero-k, mimo istniejącego kodu. Uaktualnić pojęcia: kod istnieje, snapshot zbudowany, dany przypadek wykonany, fizyka zweryfikowana — to cztery różne stany.

## Ryzyka do sprawdzenia, nie potwierdzone przyczyny błędu fizycznego

1. Preconditioner `context.a_qq` w `modal/floquet_modal_solver.cpp:1127` jest przybliżeniem energetycznym; nie jest automatycznie przekątną obróconego, przesuniętego operatora. Zmierzyć residual i iteracje wewnętrznego KSP. Sam ten wybór nie dowodzi błędnej częstotliwości.
2. Γ i niezerowe k przechodzą przez różne gałęzie (`crates/fullmag-runner/src/fem/eigen_path_guards.rs:110–150`). Potrzebna ciągłość k→0 na identycznej geometrii i warunkach potencjału.
3. Sprawdzić rzeczywiste markery Dirichleta, rozmiary airboxu, pary periodyczne i wsparcie Ms na siatce C1. Deklaracja geometrii nie jest jeszcze dowodem poprawnego warunku na każdej ścianie.
4. Model KS n=0 zakłada określony profil po grubości. Pełny FEM może odbiegać od przybliżenia wskutek mieszania modów. Nie wolno dopasowywać każdej wyższej lub złożonej gałęzi do tego samego wzoru n=0.
5. COMSOL może używać periodycznej obwiedni ψ, a Fullmag pełnego potencjału z fazą na szwie. Różna reprezentacja jest dopuszczalna po jawnej transformacji; dodanie ik do zwykłego gradientu pełnego pola oznaczałoby podwójne uwzględnienie Blocha.

## Co już istnieje, a czego nie wolno uznać za zakończone

- W źródłach istnieją pełnopolowa periodyczność Blocha, operator demagu i wywołanie natywnego solvera. Relacja sprzężeń `A_qphi=-mu0*A_phiq^H` jest obecna w `poisson_airbox_shared_domain.cpp:3247–3248`. Nie traktować tych elementów jako całkowicie brakującej implementacji.
- Nowszy build i wynik C0 usuwają tezę „nie umiemy policzyć żadnej częstotliwości”. Nie usuwają braków C1.
- Historyczna częstotliwość C1 Γ około 8.906582 GHz pozostaje rozbieżnością do wyjaśnienia na konkretnym artefakcie. Przeliczenie jej na „efektywny airbox około 50 nm” jest dopasowaniem modelu odwrotnego, nie dowodem rzeczywistego błędu geometrii.
- Jedna warstwa elementów nie jest sama w sobie dowodem przyczyny: zgodna siatka P1 potrafi reprezentować odcinkami liniowy potencjał jednorodnego Γ. Trzeba sprawdzić operator, warunki i zbieżność.
- Aktywność CPU, licznik heartbeat lub proces solvera nie dowodzą zbieżności. Wcześniejszego licznika `846` nie należy bez prześledzenia implementacji nazywać liczbą iteracji EPS.
- Nie znaleziono podstaw, aby różnicę rzędu procentów tłumaczyć konwencją wartości mu0; różnica stosowanych stałych jest o wiele mniejsza.

## Macierz dowodów w tym audycie

| Zakres | Stan |
|---|---|
| Managed build konkretnego snapshotu FEM CPU | PASS buildu, bez kwalifikacji fizyki |
| C0, Γ, bez demagu | Częstotliwość zgodna; artefakty niekwalifikowane |
| C1, Γ, demag aktualnego snapshotu | NOT VERIFIED |
| Kilka niezerowych k w DE z demagiem | NOT VERIFIED |
| Zbieżność siatki/airboxu/liczby modów | NOT VERIFIED |
| Pełny benchmark C0/C1/A1, 61 punktów, 8 pasm | NOT VERIFIED |
| FEM GPU i FDM CPU/GPU dla tego benchmarku | Nieobjęte dowodem; bez deklaracji parytetu |

Nie podaję procentu ukończenia solvera: duża część kodu istnieje, ale kilka otwartych warunków może całkowicie zmienić poprawność wyniku. Postęp należy mierzyć zamykaniem wymienionych bramek.

## Źródła fizyczne i dalszy plan

[Harms i Duine, 2021](https://arxiv.org/abs/2109.10597) omawiają ograniczenia diagonalnego przybliżenia Kalinikosa–Slavina i rozwiązanie warunków brzegowych. [Przykład TetraX DE](https://www.tetrax.software/version_1.3.3/tetrax/examples/thick_film_dispersion_with_perturbation.html) ilustruje porównanie obliczeń z przybliżeniami analitycznymi. Są to odniesienia metodologiczne; nie zastępują zgodnych parametrów i wyników Fullmag.

Plan działań: [minimalna walidacja DE](../superpowers/plans/2026-09-16-dispersion-de-minimal-validation-plan.md).

## Stan po rozpoczęciu napraw — 2026-09-16

Poniższy stan dotyczy bieżących, jeszcze niewykwalifikowanych zmian w tym samym worktree. Nie zastępuje nowego managed builda ani wykonania C1/DE.

| Punkt | Zmiana w kodzie | Weryfikacja | Stan |
|---|---|---|---|
| DE-01 | Walidator modalnych pól i producenci `source_mesh_identity` używają wspólnego fingerprintu mixed-mesh v3; historyczne v2/v6 pozostają odpowiednio dla equilibrium/certyfikatu okresowego i accepted relax-to-eigen handoffu. Dodano zgodność Python↔Rust oraz rozdzielono kontrakt stanu od modal source. | Test fingerprintu v3 i lekkie testy walidatora; nowy artefakt C0 po zmianie jeszcze nie istnieje. | implementacja wykonana, runtime `NOT VERIFIED` |
| DE-02 | `assemble_floquet_bloch_scalar_tangent_source` montuje lokalne wpisy elementowe, maskuje elementy niemagnetyczne i zachowuje mapę redukcji oraz część urojoną $\mathbf k\cdot\mathbf m$. Zniknęła globalna pętla `LinearForm` dla każdej kolumny. | Test kontraktu źródłowego; istniejący test MFEM wymaga managed kompilacji. | implementacja wykonana, pomiar skali otwarty |
| DE-03 | Wspólny adapter SLEPc tworzy real-frequency-rotated pencil $R(A)y=\omega R(iG)y$, ustawia podpisany `STSetShift`, rekonstruuje $\lambda=i\omega$ i publikuje formę algebraiczną. | Test kontraktu źródłowego; brak świeżego runtime SLEPc po zmianie. | implementacja wykonana, runtime `NOT VERIFIED` |
| DE-04 | Orchestrator przyjmuje opcjonalny `--scientific-evidence-root`; kopiuje tylko regularne pliki, wymaga zgodności hashy artefaktów bieżącego runu i pozostawia bramkę fail-closed bez pakietu. | Testy stagingu i odrzucenia starego hash; pełny agregat C0/C1/A1 nadal nieuruchomiony. | mechanizm dostarczony, kwalifikacja otwarta |

Naprawy są zmianami źródłowymi, a nie dowodem poprawnej dyspersji. Następny dowód musi użyć nowego builda z tego worktree, najpierw małego przypadku DE i co najmniej dwóch punktów $k$, a dopiero potem pełnej bramki COMSOL.

Kontrola po rozpoczęciu napraw: testy fingerprintu v2/v3, wiązania stanu,
adaptera SLEPc, lokalnego montażu źródła Floqueta, stagingu zewnętrznych dowodów
i pełnego walidatora naukowego przechodzą (łącznie **102 passed, 2 deselected**).
Fixture’y zbieżności są zgodne z progiem 0,02%; nie zmieniano progu walidacji.
git diff --check nie zgłasza błędów treści. Próba sprawdzenia
just runner-container-status i just runner-doctor nie uzyskała odpowiedzi
Docker Desktop, dlatego kompilacja managed oraz wykonanie solvera pozostają
NOT VERIFIED.
