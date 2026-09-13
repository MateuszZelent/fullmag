# Eigensolve dyspersji — checkpoint implementacji

Data: 2026-09-13. Status zadania: **W TRAKCIE**. Kwalifikacja solvera non-k0: **NOT VERIFIED**.

## Aktualny audyt — 2026-09-13

Nadrzędne bieżące zestawienie: [audyt postępu S00–S12 i R01–R05](2026-09-13-eigensolve-dispersion-progress-audit.md).
HEAD kodu: `3dda82b4e7310f16bb816b6dcc69f59502bc10de`.
Ostatni przyrost dodaje względny residual bloku potencjału; izolowany MSVC
zakończył się exit 0. Nowy audyt ujawnił niespójność pivotów (R01), brak
certyfikacji/propagacji residualu (R02) i niepełne recepty (R03).
Żaden etap S00–S12 nie jest w pełni zamknięty; wcześniejsze procenty bez
mianownika wycofano. Aktualna blokada runnera: allow-list mismatch, exit 1.
GitHub: nieważny token, exit 1. Starsze joby nie zostały ponownie odczytane.

Dalsze sekcje są chronologiczną historią. Opisy „jeszcze nie podłączono”,
„queued/running”, brak miejsca i dawne HEAD-y opisują moment wpisu,
nie aktualny stan. Bieżący rejestr ma niezgodny SHA; otwarte S12.R05b.

## Cel i źródła

Realizacja [planu S00–S12](2026-09-12-eigensolve-dispersion-nonzero-k-plan.md), po osobnym zleceniu implementacji. Zakres obejmuje CPU z pełnym dynamicznym demag-k, falowód 2.5D, interakcje, GPU, artefakty, API i Control Room. Etap źródłowy lub pojedynczy test nie zamyka tego celu.

- Baza `master`: `5084a94ed14b151fc865e8def5a5c28401e98b44`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
- Ostatni zapisany kodowy przyrost: `beca34bb0` (`fix(eigensolve): reject conflicting Floquet wavevectors`), nad rozdzieleniem assemblacji K0 `2e8362463`, handoffem phase/window `bed355f41`, walidacją payloadu `de72a5b1f`, właścicielem solvera `80736831e`, routingiem dynamicznego demag-k `e3fa509db`, zmianą nodalnego `Ms` `c511cb413`, testem wymuszonego GPU `71ce348b0`, routingiem Γ `1114e1aa0` i podłączeniem providera `f2acf7b9b425733899bdfde63cb0566d16d74a59`.
- Właściciel: `codex:01a0941c-eb15-7261-a7ee-7cf099385525`.
- Rejestr: `eigensolve-dispersion-plan-20260-c5dfad6d7f548079`; reaktywowany do implementacji.
- Fizyczne źródła COMSOL: oba lokalne podręczniki modułu mikromagnetycznego wymienione w planie; szczególnie s. PDF 21–28 i 40–43. Przykład RF jest wzorem sprzężenia pól, a nie gotowym dowodem modalnym.

## Stan etapów

| Etap | Stan | Pozostały warunek |
|---|---|---|
| S00 — baza K0 i dowody | W TRAKCIE | Bieżący managed runtime, Kittel, pełny zaakceptowany handoff |
| S01 — nauka, ADR, kontrakty | W TRAKCIE | Noty, mapy źródeł, walidatory i review |
| S02 — Python/IR | W TRAKCIE | Walidacja k i selektorów, round-trip, testy konsumentów |
| S03 — natywny operator magnetyczny Blocha | W TRAKCIE | Prolongacja fazowa i właściciel sparse są zapisane; pozostają MFEM sparse/matrix-free, pełne assembly i managed runtime |
| S04 — dynamiczny demag-k CPU | W TRAKCIE | Bounded dense Schur provider i producent czterech bloków MFEM są zapisane; planner otwiera wyłącznie strict/double/CPU/Full2x2/FloquetAirbox/nonzero-k z Poisson airbox. Pozostają matrix-free/sparse owner, gauge, zbieżność brzegu i managed runtime |
| S05 — natywny solver spektralny | W TRAKCIE | Dodano właściciela Floquet SLEPc dla dense i sparse oraz routing obu ścieżek; pozostają managed SLEPc, residuale oryginalnego układu, kompletność i resume |
| S06 — śledzenie gałęzi | W TRAKCIE | Hungarian/gaps i metryka masy FE są gotowe; pozostają fizyczne podprzestrzenie zdegenerowane |
| S07 — artefakty i API | W TRAKCIE | Stabilne ID, faza/obwiednia, selektory, binarne pola |
| S08 — Control Room | DO WYKONANIA | Authoring, dyspersja, wybór modu i przestrzenna faza; browser/WebGL |
| S09 — falowód 2.5D | W TRAKCIE | Bounded provider i deterministyczny P1 assembler przekroju są zapisane; pozostają typed realization/routing, managed/MFEM owner, open-boundary convergence i porównania TetraX/3D |
| S10 — interakcje | DO WYKONANIA | Anizotropia, DMI seams, Gilbert i legalność |
| S11 — GPU | DO WYKONANIA | Jawna trasa double bez fallbacku, residency i parytet |
| S12 — kwalifikacja i integracja | W TRAKCIE | Managed benchmarki, review, commity, PR, merge, weryfikacja mastera |

## Zweryfikowane warunki wykonania

Repozytorium bazowe ma ModalEigenRequest ABI **19**. Historyczne numery ABI w dokumentach nie zastępują bieżącego nagłówka. Kanoniczny układ styczny to `q[2*node+component]`, zgodnie z `tangent_frame.cpp` i natywnym assembly `A_qq`.

Odczyt runnera: kontener `Fullmag_build_runner` działa w kontekście `desktop-linux`. Job `908c9b8a781a4af4b77c104a07f925ec` innego worktree, dla tego samego commita bazowego, ma stan `blocked`, bez exit code. Nie jest to wynik testu tego zadania. Odczyt storage wskazał 3 343 511 552 bajty wolnego miejsca; dokumentowany próg runnera wynosi 8 GiB. Nie usuwano cudzych buildów, cache ani wyników.

Próba lekkiej kompilacji nowego testu C++ przez `fullmag_storage.py run` została odrzucona przed kompilacją: `Container runner owns heavy builds on this host; submit a snapshot through just runner-build`. Nie obchodzono tej bramki. Nie uzyskano czerwonego ani zielonego wyniku testu C++.

### S00 — zgłoszony build bazy

Po zmianie stanu środowiska ponowny odczyt o 06:40 UTC wykazał 45 222 551 552 bajty wolnego miejsca, `health.accepting_jobs=true` i pusty aktywny slot. Wcześniejszy brak miejsca nie jest aktualną blokadą.

Zgłoszono własny build dokładnego bazowego commita przez `local_runner_cli.py submit --operation build --profile fem-cpu-release --source commit --ref 5084a94ed14b151fc865e8def5a5c28401e98b44` (klient exit 0):

- Job: `1d31af520bb547848e23be8888fde8d8`, sequence 13; ostatni odczyt przy zgłoszeniu: `queued`.
- Source digest kapsuły: `d8cd645e71228de87ec7a8b9252f8317fd5c402a409e25ba5685aca836ce991a`.
- Native source snapshot SHA256: `bd5d415203e5a59041b580bfd1befbd9a70ed38ebd4b6ac16810274b9418c634`, dirty=false.
- Kapsuła: `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/16a8789ca9a746c19369f95b9a94ce86/source`.
- Skonfigurowany obraz CPU: `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`, 2 CPU, 8 GiB RAM.

Kolejny odczyt: job przeszedł do `running` (updated_at 1789195476.7236419). Profil ma `FULLMAG_FEM_WITH_SLEPC=OFF`, więc może potwierdzić bazowy build CPU, lecz nie kwalifikuje solvera modalnego SLEPc ani bramki fizycznej K0.

Ten build dotyczy bazy, a nie bieżących niezacommitowanych zmian. Wynik i receipt wymagają osobnego odczytu; S00 obejmuje następnie uruchomienie i walidację fizyczną K0.

## Zasady zaliczania przyrostów

Każdy przyrost otrzymuje pełny hash commita, zakres, wykonane polecenie i exit code po weryfikacji. Źródła, build, managed runtime, nauka, browser/WebGL i kwalifikacja wydania są odrębnymi dowodami. Przyrost dokumentacyjny zapisano w commicie `9c5be5d2212995f1437823178e7f7af83ee883e0`: plan i checkpoint (dwa pliki). Kontrole UTF-8, bloków Markdown, etapów S00–S12, linków, whitespace oraz zgodności staged bytes ze sprawdzonymi plikami przeszły (exit 0); plan miał też niezależne review z domkniętymi uwagami. Commit kodu `f2acf7b9b425733899bdfde63cb0566d16d74a59` istnieje i przechodzi kontrolę Rust; nie ma jeszcze managed receipt ani wyniku runtime. Odrzucenia nieobsługiwanych kombinacji non-k0/demag/GPU pozostają aktywne poza dostarczonym wariantem CPU.


### S03 — fundament redukcji Blocha

W źródłach dodano `FloquetTangentProlongation`, wewnętrzny opis klas i `FloquetReducedMagneticOperator` oraz target `fem_floquet_magnetic_operator_contract`. To prolongacja fazy i bazy oraz działanie `C†AC` nad zwykłym operatorem MFEM; nie ma jeszcze połączenia z ABI solvera, pełnego magnetycznego assembly ani dynamicznego demag-k.

Niezależne review potwierdziło algebrę `C` i operatora sprzężonego. Po uwagach dodano jawny wewnętrzny budżet pamięci (domyślnie 256 MiB, regulowany przez przyszłego właściciela solvera), kontrolę wymiarów/budżetu przed alokacją oraz testy ogromnego requestu, małego budżetu, niewłaściwego kształtu i rzeczywistej mapy dla obrotu spinowego. Zawężono komentarz dotyczący alokacji: własne bufory są przygotowane, lecz zachowanie dostarczonego operatora MFEM wymaga instrumentacji. Kompilacja i wykonanie nowego testu pozostają NOT VERIFIED.

### Przyrost adaptera dynamicznego demag-k

Do natywnego `ModalEigenRequest` dodano jawny, opcjonalny payload gęstej
macierzy realifikowanej `C(k)` dla dynamicznego demag-k. Dostawca musi przekazać
macierz w tych samych zredukowanych współrzędnych i jednostkach co magnetyczny
Hessian; faza Blocha oraz eliminacja potencjału skalarnego muszą być wykonane
przed granicą ABI. Natywny adapter sprawdza niezerowe `k`, tryb Floquet,
`include_demag`, zgodność rozmiaru `n*n`, finite values, trasę gęstą i brak
konfliktu ze ścieżką CSR, a następnie dodaje macierz do efektywnego Hessianu
przed solverem okna, shift-invert i contour. Digest liniowego pencil obejmuje
ten sam przyrost, a diagnostyka zachowuje jego rodzaj i liczbę wartości.

Był to początkowo kontrakt i fail-closed bridge dla już złożonego operatora.
Commit `f2acf7b9b425733899bdfde63cb0566d16d74a59` podłącza bounded właściciela
assemblacji do shared-domain dla jednego wariantu CPU; skalowalny owner
`A_{q\phi}(k)`, `P(k)`, `A_{\phi q}(k)` nadal pozostaje do wykonania. Kompilacja
managed, wykonanie testów C++ oraz walidacja fizyczna tego operatora pozostają
**NOT VERIFIED**.


### Przyrost po kolejnym review (12 września)

Poprzedni obrót celu klasyfikuję jako **postęp**: zapisano commit planu, kod i wyniki kontroli. Bieżąca kontynuacja również zmienia źródła; pełny cel S00–S12 pozostaje aktywny.

- S02: Python odrzuca niecałkowite/ujemne/przepełnione ID, niepoprawne wektory i kontrolne punkty ścieżki. Fokus API/IR dla eigensolve: 35 passed; pełny `test_problem_ir.py`: 26 passed. Rust zachowuje `branches`, `sample_selector`, `include_branch_table`; planner pozwala na unię żądań dla różnych selektorów próbek, a testy IR/plannera/runnera zostały wykonane diagnostycznie.
- S06: implementacja Hungarian i luk zachowuje surowe ID; `overlap_prev` jest rzeczywistym znormalizowanym overlapem, a `tracking_confidence` wynikiem 0.85 overlap + 0.15 frequency. Próg filtruje rzeczywisty overlap. Brak wektora ma jawny fallback częstotliwościowy i `overlap_prev=None`. Usunięto klonowanie bieżących dużych wektorów. Gdy oba artefakty mają zgodne dodatnie wagi FE, overlap używa metryki masy na aktywny węzeł; starsze lub niezgodne wektory zachowują fallback euklidesowy. Fizyczne podprzestrzenie pozostają do wykonania.
- S07: helper selekcji poprawiono po review. ID obecne jednocześnie w modzie i tabeli gałęzi są legalne; tabela waliduje swoje punkty. Etykieta Γ wybiera wszystkie pasujące próbki w ścieżce Γ–X–Γ. Diagnostyka może wymagać trackingu bez eksportu widma.
- S07: writer FEM używa tożsamości `(sample_index, raw_mode_index)`, rozwiązuje wybór gałęzi po trackingu, zachowuje pełne widmo dla `SaveDispersion` i ogranicza osobno pola. Wyłączenie tabeli gałęzi wyłącza jej pliki i linki w manifeście, ale nie tracking. Niewybrane pola zachowują stabilne ID, dostają `mode_field_available=false` i nie mają aktywnego linku. Wybrane pola wymagają metadanych i binarnego payloadu. Dodano i wykonano regresje, poprawiono zachowanie grupy próbki Zarr; bezpośredni writer orchestratora, API i UI pozostają do integracji.
- `rustfmt --check` dla trzech zmienionych writerów oraz selektora i trackingu: exit 0. Nie jest to dowód kompilacji. `git diff --check`: exit 0.
- S01: oba walidatory source-map i końcowy test dokumentacji matematycznej przeszły. Usunięto pięć zdublowanych wierszy indeksu 0831 oraz poprawiono odwołania 0830 do aktualnych właścicieli symboli.

Odczyt runnera 07:23 UTC: własny job `1d31af520bb547848e23be8888fde8d8` pozostaje `running`, żywy worker i aktywny job są potwierdzone API. Log `native-build` zawiera kompilację Cargo. Wolne miejsce wynosiło 68 298 076 160 bajtów; historyczny błąd braku miejsca nie jest aktualną blokadą. Nadal brak terminalnego receipt. Profil nie wykonuje ukierunkowanych testów Rust/native i ma SLEPc OFF; istniejące osobne przepisy managed runtime wymagają dalszego ustalenia prawidłowej trasy w tym hoście.

Kod C++/Rust i nowe testy są zapisane w osobnych, spójnych commitach, lecz nadal są
**NOT VERIFIED przez managed kompilację lub runtime**. Żaden z poniższych wyników
hostowych nie kwalifikuje relacji dyspersji ani dynamicznego demag-k.

### Zapisane przyrosty implementacji

- `964e9f87f` — kontrakt Python → IR → planner, walidacja żądań dyspersji oraz selektory `branches`/`sample_selector`/`include_branch_table`; testy pozwalają również na samodzielne `dispersion_curve` i `eigen_diagnostics`.
- `509db79c2` — śledzenie gałęzi z Hungarian/gaps i fallbackiem częstotliwościowym oraz publikacja selekcjonowanych artefaktów dyspersji z trwałą tożsamością próbki i surowego modu.
- `4c83ea4b2` — fundament redukcji Floqueta i fail-closed adapter dense real-split dla dostarczonego dynamicznego demag-k w natywnym solverze CPU; digest pencila obejmuje efektywną macierz.
- `1300b8035` — dokumentacja dwóch reprezentacji non-k0, źródeł COMSOL/TetraX oraz granicy między adapterem a przyszłym providerem assemblacji.
- `b360f7490` — overlap śledzenia gałęzi z dodatnią metryką masy FE na aktywny węzeł, z fallbackiem dla niezgodnych starszych artefaktów i regresjami.
- `11183f7e8` — bounded dense provider Schura dynamicznego demag-k: zespolone `A_{qφ}(k)`, `P(k)`, `A_{φq}(k)`, kontrola niezerowego `k`, pivotu, gauge, budżetu i realifikacji ABI; test kontraktu CMake.
- bieżący przyrost S05 — ścieżka `execute_native_cpu_modal_window_from_bloch_floquet_complex` przekazuje callbacki anulowania/postępu, zachowuje `artifact_sample_index` i attestation planera oraz publikuje `eigen/partial.v1.json` po przerwaniu; ukierunkowana kompilacja Rust i test parsera postępu przechodzą.
- `55a9c28be` — writer ścieżki rozróżnia jawny sweep `bias_field_samples` od próbek `k-path`/pojedynczego `k`; Gamma na ścieżce nie otrzymuje już przez przypadek identyfikatora `bias-field-sample-*`. Regresja sprawdza oba namespace'y w `spectrum.v2` i `spectrum.v3`.
- `6ce1ced8e` — jednokowy writer `write_eigen_v2_bundle` publikuje `sample_id` w `spectrum.v2` i `spectrum.v3`, wybierając namespace z planu zamiast oznaczać każdy wynik jako sweep pola; regresja provenance sprawdza `k-sample-0000`.
- `72645805b` — checkpoint doprecyzowuje rozdział namespace'ów artefaktów dla sweepu pola, ścieżki k i pojedynczego k.
- `43fbba45d` — dokumentacja fizyki i spec artefaktów zawierają indeksy obu bounded providerów demag-k oraz kontrakt nieprzezroczystych `sample_id`; walidator map źródeł został uruchomiony na bazie mastera.
- `41e80e534` — bounded MFEM bridge `floquet_airbox_operator`, test redukcji `CᴴP_fullC`/`CᴴAφq`, osobna recepta managed oraz regresja pinowania pojedynczego DOF w providerze Schura; źródła są zapisane, lecz kompilacja z MFEM pozostaje niezweryfikowana.
- `4336d8166` — fail-closed guard w `solve_modal_eigen_contract` blokuje wejście non-k0 Floquet do shared-domain i starszego Poisson-airbox K0; dwie regresje native sprawdzają oba wejścia.
- `d1f2ac9b3` — rozdzielenie reprezentacji `shifted_envelope`/`full_field_phase_constrained` w skalarnej assemblacji Floqueta oraz maskowanie powietrza i redukcja magnetycznych DOF w źródle; testy MFEM zapisane, wykonanie managed nadal oczekuje na poprawny runtime.
- `1894f09a8` — phase-aware Schur bridge redukuje także magnetyczne DOF przez `C_\phi^H A_{\phi q,full} C_q`, zachowując zgodność ze starszym wejściem już zredukowanym.
- `e2a7890c7` — producent shared-domain buduje na jednej siatce MFEM pełnopolowy operator skalarny, `C_\phi(k)`, źródło `A_{\phi q,full}` z maską magnetyczną i nodalnym `M_s` oraz `C_q(k)`; waliduje graf translacji, fazę `-k\cdot R`, kompletność klas i odrzuca niezerowe `k` bez par. To jest seam właściciela natywnego, bez podłączenia do runnera.

- `f2acf7b9b425733899bdfde63cb0566d16d74a59` — runner przekazuje accepted
  shared-domain handoff wraz z fazowym pencilem do produkcyjnego CPU, a
  `modal_eigen_solver` konsumuje go przez k-aware importer i dodaje bounded
  Schur `D(k)` w real-split do magnetycznego Hessianu. Integracja pozostaje
  ograniczona do `Full2x2 + Floquet + include_demag + nonzero-k + native CPU`;
  GPU, SLEPc/managed runtime i większy matrix-free owner są nadal zamknięte.

Adapter dynamicznego demag-k przyjmuje wyłącznie kompletną macierz dostarczoną
przez właściciela `A_{q\phi}(k)`/`P(k)`/`A_{\phi q}(k)`; aktualny bounded
provider buduje tę macierz z zaakceptowanego shared-domain payloadu tylko na
trasie native CPU. S04/S05 pozostają otwarte w zakresie skalowania i
kwalifikacji, a S08–S12 nadal wymagają realizacji.

Provider `floquet_dynamic_demag_k` domyka algebraiczny etap Schura dla małych
problemów walidacyjnych i zwraca `[[Re D,-Im D],[Im D,Re D]]`, gdzie
`D(k)=-A_{qφ}(k)P(k)^{-1}A_{φq}(k)`. Przyjmuje wyłącznie niezerowe,
finite `k`, nie maskuje osobliwości `P(k)`, a `pin_first_dof` jest jawny. Nie
ma jeszcze skalowalnego assemblera bloków na siatce MFEM ani dowodu pełnego
shared-domain modal runtime; poza podłączonym wariantem native CPU runner
pozostaje fail-closed dla non-k0 z demag-k.

W commicie `41e80e534` dodano bounded MFEM bridge
`assemble_floquet_airbox_dynamic_demag_k`. Bridge odczytuje zespolone bloki
`P_full(k)`, `C(k)` i `A_{φq,full}`, materializuje
`P(k)=CᴴP_fullC`, `A_{φq}(k)=CᴴA_{φq,full}` oraz jawne sprzężenie
`A_{qφ}=A_{φq}ᴴ`, a następnie deleguje eliminację do providera Schura. Ma
limit 512 DOF na blok i jeden budżet obejmujący macierze pośrednie, wynik oraz
LU/RHS providera; odrzuca nie-Hermitowskie lub niepełne bloki i nie publikuje
częściowego wyniku. Regresja z fazą `exp(-iπ/2)` sprawdza redukcję seamów i
realifikację wyniku. To nadal bounded oracle: nie jest assemblerem siatkowym,
nie zmienia capability planera i nie otwiera runnerowej ścieżki dynamicznego
demag-k.

Dodano również fail-closed guard na granicy `solve_modal_eigen_contract`: żądanie
Floquet z niezerowym `k` nie może wejść ani przez shared-domain importer, ani
przez starszy syntetyczny blok Poisson-airbox do rzeczywistej ścieżki K0. Guard
zwraca jawny status `unavailable`, wymagany przyszły operator
`bloch_floquet_airbox_shared_domain_operator` i stabilny powód
`nonzero_k_floquet_k0_poisson_path`. Dwie regresje C++ wywołują bezpośredni
native contract, aby sprawdzić oba wejścia. Nie otwiera to jeszcze produkcyjnej
assemblacji non-k0; usuwa tylko możliwość cichego policzenia non-k0 jako K0.

W commicie `d1f2ac9b3` rozdzielono dwie reprezentacje skalarnego problemu Blocha
we właścicielu MFEM. `shifted_envelope` zachowuje człony `k²` i sprzężone
konwekcje w operatorze obwiedni, natomiast
`full_field_phase_constrained` składa wyłącznie zwykłe pochodne; zależność od
`k` w tej drugiej reprezentacji może pochodzić tylko z osobnej macierzy fazowej
`C(k)`. Źródło `M_s δm → φ` przyjmuje teraz maskę elementów magnetycznych i
kompletną mapę klas magnetycznych DOF, redukując kolumny przed późniejszym
sprzężeniem fazowym. Dodano regresje dla braku przesuniętego bloku urojonego,
maskowania powietrza i redukcji klas. To usuwa mieszanie reprezentacji w
przyszłym assemblerze, ale nie podłącza jeszcze producenta `P(k)`,
`A_{qφ}(k)`, `A_{φq}(k)` do shared-domain ani nie otwiera ścieżki runnera.

W S09 dodano analogiczny, jawnie oddzielony provider 2.5D
`floquet_waveguide_demag_k`. Buduje on `P(k)=K⊥+k²M`, przyjmuje osobne
poprzeczne i osiowe sprzężenia `A_qphi`/`A_phiq`, zachowuje znak źródła `−ik
δM_z` w danych wejściowych i zwraca ten sam real-split Schur w przestrzeni
`[Re(q), Im(q)]`. Test kontraktu obejmuje wartość `k²`, granicę `k=0`, pinowanie
gauge oraz błędne kształty/budżet. Jest to bounded oracle dla algebry
falowodu, nie assembler siatki przekroju ani dowód otwartej granicy; kompilacja
i wykonanie testu pozostają **NOT VERIFIED** przez managed runner.

Dodano recepty managed dla tych kontraktów źródłowych:
`verify-fem-modal-floquet-magnetic-contract` uruchamia test operatora Blocha,
a `verify-fem-modal-floquet-airbox-cpu` uruchamia bridge oraz oba ograniczone providery
demag-k. Recepty korzystają z `ensure-managed-fem-runtime` i nie zmieniają
statusu fizycznej assemblacji ani kwalifikacji runtime. Na bieżącym hoście
runner nadal zwraca 503/profile mismatch przed utworzeniem joba, więc te
bramki pozostają **NOT VERIFIED**.

### Walidacja po domknięciu przyrostu

- `cmake -S native -B C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-airbox -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF`: konfiguracja CMake zakończyła się exit 0 i wygenerowała nowy target bridge.
- Bezpośrednia kompilacja MSVC (`FULLMAG_HAS_MFEM_STACK=0`) dla `floquet_airbox_operator.cpp`, jego testu oraz providera `floquet_dynamic_demag_k` zakończyła się exit 0. Zlinkowany test `floquet_dynamic_demag_k_contract` zakończył się exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib fem::eigen_tests::runner_rejects_floquet_dynamic_demag_gate --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-airbox-cargo-target -- --nocapture`: 1 passed, exit 0; runner nadal odrzuca warianty bez podłączonego, certyfikowanego providera.
- Próba kompilacji bridge z `FULLMAG_HAS_MFEM_STACK=1` zatrzymała się na braku `mfem.hpp`; managed test `fem_floquet_airbox_operator_contract` nie został wykonany, więc implementacja MFEM pozostaje **NOT VERIFIED**.
- `cargo +nightly check --locked -p fullmag-ir -p fullmag-plan -p fullmag-runner --lib --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0; ostrzeżenia są istniejące lub dotyczą nieużytych elementów oczekujących na integrację.
- `cargo +nightly check --locked -p fullmag-cli --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target` oraz `cargo +nightly check --locked -p fullmag-runner --tests --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0.
- `cargo +nightly test --locked -p fullmag-ir --lib`: 101 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-ir --tests`: 101 unit + 229 integration tests passed, exit 0; `cargo +nightly test --locked -p fullmag-plan --lib`: 461 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib output_publication_tests`: 5 passed; `--lib tracking`: 13 passed, exit 0.
- Po dodaniu metryki masy FE `cargo +nightly test --locked -p fullmag-runner --lib tracking --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: 15 passed, exit 0.
- Po zmianie S05 `rustfmt +nightly --check crates/fullmag-runner/src/fem/eigen_native_window.rs crates/fullmag-runner/src/fem/eigen_execution.rs`: exit 0; `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/fullmag-eigensolve-cargo-target`: exit 0; `cargo +nightly test --locked -p fullmag-runner --lib fem::eigen_progress --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 1 passed, exit 0. Jest to dowód kompilacji i kontraktu callbacku, nie managed C++ ani physics qualification.
- Po poprawce namespace'ów `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/fullmag-eigensolve-cargo-target`: exit 0; `cargo +nightly test --locked -p fullmag-runner --lib eigen::artifacts --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 41 passed, a `cargo +nightly test --locked -p fullmag-runner --lib eigen::orchestrator --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 3 passed. Ostrzeżenia pozostają istniejące lub dotyczą oczekujących integracji.
- Po poprawce jednokowego writer’a `cargo +nightly test --locked -p fullmag-runner --lib native_eigen_v2_mode_metadata_preserves_operator_provenance --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 1 passed. Kompilacja testu zakończyła się exit 0.
- Po dodaniu wierszy providerów do indeksów źródłowych `python .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base 5084a94ed14b151fc865e8def5a5c28401e98b44`: exit 0; `python -m pytest scripts/test_frequency_domain_math_contract_docs.py -q -p no:cacheprovider`: 9 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib eigen`: 226 passed, 1 failed. Jedyna porażka to istniejące `eigen::response_block_real::tests::field_driven_sweep_builds_artifact_ready_response_payload`, równość `1.0000000000000002` vs `1.0`; plik testu nie należy do tego przyrostu.
- Python: pełny `test_problem_ir.py` 26 passed; fokus API/IR dla eigensolve 35 passed; pełny `test_api.py` wykonał 277 passed i 19 failures środowiskowych (brak `h5py`/`zarr`, odmowa zapisu w lokalnym cache/worktree oraz `run_output`), bez błędu w fokusie eigensolve.
- Test kontraktu dokumentacji matematycznej: 9 passed. Walidatory source-map i `git diff --check`: exit 0.
- Próba nowego managed snapshotu nie utworzyła dodatkowego joba: runner zgłosił aktywny lock/storage dla rejestru `eigensolve-dispersion-plan-20260-c5dfad6d7f548079` i nakazał użyć istniejącego joba lub zaczekać. Najnowszy własny snapshot to job `b5200ded44964953a03491183dffaae1`, sequence 19, source digest `b59eadab5a1dd98e7b394403bd722bce864c81ea4d7659e24acd790f70853757`; ostatni odczyt pozostaje `queued` bez exit code. Nie uzyskano kompilacji C++ ani runtime dla bieżącego snapshotu.
- Bezpośrednia kompilacja MSVC testu kontraktu po dodaniu regresji routingu zakończyła się exit 0 z `FULLMAG_HAS_MFEM_STACK=0` i `/D_USE_MATH_DEFINES`. Kompilacja całego `modal_eigen_solver.cpp` w tym trybie nadal zatrzymuje się na istniejących typach shared-domain dostępnych wyłącznie z MFEM (`PoissonAirboxSharedDomainAssemblyResult`); nie jest to ścieżka kwalifikacyjna FEM. Pełny test z MFEM pozostaje **NOT VERIFIED**.
- Dla `d1f2ac9b3` bezpośrednia kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` zakończyła się exit 0 osobno dla `floquet_bloch_scalar.cpp` i `floquet_bloch_scalar_test.cpp`; zlinkowany test no-MFEM zakończył się exit 0. CMake skonfigurował target, lecz pełna biblioteka zatrzymała się na wcześniejszych błędach bazowych MSVC (`std::snprintf`, `__atomic_*`, brak pól Poisson w trybie bez MFEM), więc nie jest to dowód wykonania ciała MFEM. Managed test `verify-fem-frequency-domain-floquet-bloch-scalar` pozostaje **NOT VERIFIED**.
- Dla `e2a7890c7` bezpośrednia kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` zakończyła się exit 0 osobno dla `floquet_bloch_scalar.cpp`, `floquet_airbox_operator.cpp` i `floquet_airbox_operator_test.cpp`. Test MFEM zawiera ścieżkę sukcesu producenta, niespójnej fazy i braku par, ale na tym hoście ciało MFEM nie zostało wykonane. Pełny target CMake nadal zatrzymuje się na wcześniejszych błędach bazowych bez MFEM; managed test `fem_floquet_airbox_operator_contract` pozostaje **NOT VERIFIED**.
- Dla `f2acf7b9b425733899bdfde63cb0566d16d74a59` `rustfmt +nightly --edition 2021 --check` dla trzech zmienionych plików Rust zakończył się exit 0, `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/git/fullmag-eigensolve-cargo-target` zakończył się exit 0, a test `native_fem::frequency_domain::tests::production_shared_domain_request_accepts_only_the_certified_payload` zakończył się `1 passed`, exit 0.
- Próba `cargo +nightly check --locked -p fullmag-runner --lib --features fem-native --target-dir D:/git/fullmag-eigensolve-fem-native-target` zakończyła się exit 101 podczas budowania zależności native C++. Konfiguracja wygenerowała `FULLMAG_USE_MFEM_STACK=OFF`; log zatrzymuje się na istniejących błędach MSVC (`std::snprintf`, `__atomic_*`, `M_PI`, pola `Context::poisson_demag`) oraz na znanym ukryciu typów shared-domain bez MFEM. Źródła nowych `floquet_bloch_scalar.cpp` i `floquet_airbox_operator.cpp` zostały wykryte w przebiegu, lecz nie uzyskano managed receipt.
- Ponowiony target CMake `fem_floquet_airbox_operator_contract` w konfiguracji bez MFEM zakończył się exit 1 na tej samej bazowej serii błędów; dodatkowe błędy `modal_eigen_solver.cpp` wynikają z wyłączenia `FULLMAG_HAS_MFEM_STACK`, nie z kompilacji nowej gałęzi provider'a. Nie wykonano testu z MFEM.

Próba `just worktree-finish ... state=review` z aktualnym HEAD została
zatrzymana przez ten sam preflight (`Container runner owns heavy builds on this
host`). Rejestr pozostaje więc `active` z historycznym HEAD-em bazowym; nie
wykonywano ręcznej mutacji pliku ani obchodzenia blokady. Następny krok to
zwolnienie/rozliczenie dokładnego lease runnera, a potem ponowienie
`worktree-finish`.

Kontrolny odczyt `python scripts/local_runner_cli.py container-status` oraz
`status b5200ded44964953a03491183dffaae1` po ostatnim commicie zakończył się
exit 1 z komunikatem `Container profile allow-list mismatch`; nie utworzono
nowego joba i nie uzyskano dodatkowego receipt. Managed kompilacja C++/runtime
bieżącego worktree pozostaje zatem **NOT VERIFIED**.

Stan integracji pozostaje **W TRAKCIE**. Bounded provider `A_{q\phi}(k)`/
`P(k)`/`A_{\phi q}(k)` jest podłączony do natywnego właściciela CPU; otwarte
pozostają managed C++/SLEPc, skalowalny matrix-free owner, walidacja fizyczna,
PR oraz ścieżki Control Room/GPU.

### Aktualny przyrost integracyjny non-k0

W worktree domknięto granicę właścicieli dla pierwszego wariantu CPU. Runner
rozpoznaje plan `Full2x2 + Floquet + include_demag + nonzero-k` tylko przy
produkcyjnym native CPU, buduje zaakceptowany
`NativeModalEigenSharedDomainProblem` z handoffu równowagi i przekazuje go
razem z fazowymi macierzami magnetycznymi. Natywny solver C++ używa wtedy
rozszerzonego importera shared-domain: z tej samej siatki i markerów domeny
składa pełnopolowy `P(k)`, `C_\phi(k)`, `A_{\phi q,full}(k)` oraz `C_q(k)`,
wylicza przez Schura `D(k)=-A_{q\phi}(k)P(k)^{-1}A_{\phi q}(k)` i dodaje
realifikację do magnetycznego Hessianu. Flaga `k=0` nie może wejść do tej
gałęzi, a GPU i inne kombinacje pozostają fail-closed.

Ten przyrost ma test kontraktu Rust i kompilację źródeł/targetów bez MFEM.
Pełny build `fem-native` został uruchomiony, ale zakończył się na znanych
problemach konfiguracji hosta (`FULLMAG_USE_MFEM_STACK=OFF`, brak działającego
managed MFEM/SLEPc oraz wcześniejsze błędy MSVC w CUDA/Context); nie jest to
receipt wykonania operatora. Managed runtime, wynik fizyczny `f(k)`, artefakty,
API/UI i GPU nadal mają status **NOT VERIFIED**.

### Przyrost S09 — assembler przekroju 2.5D

Dodano `floquet_waveguide_cross_section`: bounded element-level P1 assembler
dla trójkątnego przekroju 2D. Assembler składa `K_perp`, `M`, jawny warunek
Robin, sprzężenia `A_phiq_perp`/`A_phiq_axial` z maską domeny magnetycznej i
lokalnym `M_s`, a następnie wyprowadza blok sprzężony przez hermitowskie
sprzężenie zwrotne. Wszystkie macierze są skalowane przez odwrotność jawnego
`normalization_length_m`, więc wynik ma normę na jednostkę długości. Jest to
referencyjny właściciel elementowy, nie deklaracja managed MFEM assemblacji ani
dowód zbieżności otwartej granicy.

Izolowany projekt MSVC z assemblerem, providerem Schura i testem kontraktu
skonfigurował się (exit 0), zbudował (exit 0), a wykonanie zakończyło się
`floquet waveguide cross-section contract tests passed` (exit 0). Test
sprawdza macierze masy/stiffness, długość brzegu Robin, znak źródła `-i k M_z`,
sprzężenie hermitowskie, odrzucenie wadliwej mapy oraz przejście przez
real-split Schur. Pełny target `fullmag_fem` nadal zatrzymuje się na
wcześniejszych błędach bez MFEM; nowy plik został w tym przebiegu
przetworzony przez MSBuild bez własnych błędów.

### Przyrost routingu planera dla non-k0

Commit `8d266d778` otwiera w plannerze wąską, jawnie opisaną kombinację
`Full2x2 + Floquet + include_demag + nonzero-k + FloquetAirbox + Poisson`.
Warunki wykonania są strict, double precision i CPU; ścieżki z GPU, innym
warunkiem magnetostatycznym albo inną reprezentacją operatora pozostają
fail-closed. Ścieżka może zawierać Γ: orchestrator materializuje próbkę Γ jako
`Periodic` z istniejącym K0 shared-domain, a punkty niezerowe pozostają w
Floquet Schur. Dla `auto` dispatch przypina tę kombinację do CPU, aby
dostępność GPU w rejestrze nie wybrała nieobsługiwanej realizacji. Planner
publikuje notę provenance o bounded CPU Poisson-airbox Schur providerze.

Weryfikacja tego przyrostu:

- test planera `fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path` — `1 passed`, exit 0;
- pełny `fullmag-plan --lib` — `461 passed`, exit 0;
- testy runnera ścieżki non-k0 — `4 passed`, exit 0;
- `runner_rejects_floquet_dynamic_demag_gate` — `1 passed`, exit 0;
- `fem_eigen_path_rejects_floquet_dynamic_demag_before_sample_solves` — `1 passed`, exit 0;
- `git diff --check` i ukierunkowany `rustfmt --check` — exit 0.

### Przyrost zgodności materiałowej shared-domain

Commit `c511cb413` otwiera nodalne `Ms` w bounded CPU providerze. Natywny
descriptor już przenosi pełny wektor `saturation_magnetisation_a_per_m`, więc
runner nie odrzuca go przed assemblacją; digest wejścia operatora obejmuje teraz
zarówno wektor nodalny, jak i wartość uniform fallback. Certyfikat okresowości
pozostaje obowiązkowy: wartości `Ms` na sparowanych seamach muszą być zgodne.

Regresje `fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path`
(`fullmag-plan`) oraz `shared_domain_builder_rejects_missing_accepted_linearization_state`
i `native_cpu_modal_window_accepts_nonzero_floquet_airbox_demag_path`
(`fullmag-runner`) przeszły; szerokie przebiegi dały odpowiednio `461/461` i
`142/142` testów, exit 0. Nodalne `Aex`, anizotropia, DMI i damping nadal są
jawnie poza tym bounded wariantem.

To jest bramka planowania i routingu, a nie kwalifikacja fizyczna. Nadal brak
managed MFEM/SLEPc receipt, wykonania operatora na siatce, residuali
oryginalnego układu, zbieżności paddingu oraz porównania COMSOL/TetraX. Damping
i GPU pozostają poza otwartym wariantem. Worktree pozostaje
niezintegrowany z `master`; push/PR/merge są zablokowane przez brak poprawnego
uwierzytelnienia GitHub i wcześniejszą odmowę automatycznego review.

### Przyrost dokładnej rozdzielczości wykonania non-k0 — `e3fa509db`

Wprowadzono osobny token `floquet_airbox_cpu_schur_slepc` w `FemEigenEngineIR`.
Planner nadaje go wyłącznie ścisłemu, podwójnej precyzji wariantowi
`Full2x2 + Floquet + include_demag + nonzero-k + FloquetAirbox + Poisson` i
publikuje rozróżnienie żądania urządzenia, urządzenia rozwiązanego, fallbacku
oraz przyczyny wyboru. Jawne GPU, GPU z runtime override i nieznany fallback są
odrzucane; `auto` może zapisać tylko udokumentowany fallback GPU→CPU dla tej
samej fizyki. Runner sprawdza zgodność silnika z zakresem planu i nie pozwala
użyć dynamicznego tokenu dla zwykłego K0. Punkt Γ na ścieżce może zachować
top-level Floquet resolution, ale wykonuje się przez certyfikowany alias K0.

W natywnym solverze C++ naprawiono granicę właścicieli: wynik bounded
shared-domain providera `D(k)` jest przekazywany do `effective_request`, a ten
sam envelope trafia do adaptera dense SLEPc, digestu pencila i diagnostyki.
Kompletny dostarczony dynamiczny payload również otrzymuje osobny engine ID,
więc nie może zostać opisany jako ogólny `production_cpu_modal_eigen_unavailable`.
Regresja C++ została rozszerzona o tę asercję; nie wykonano jej na tym hoście,
ponieważ repozytoryjna recepta zatrzymuje się w preflight z
`Container profile allow-list mismatch`.

Dowody źródłowe tego przyrostu:

- `cargo +nightly check --locked -p fullmag-plan -p fullmag-runner -p fullmag-ir` — exit 0;
- `cargo +nightly test --locked -p fullmag-ir --lib` — `102 passed`, exit 0;
- `cargo +nightly test --locked -p fullmag-plan --lib` — `461 passed`, exit 0;
- `cargo +nightly test --locked -p fullmag-runner fem::eigen_tests --lib` — `142 passed`, exit 0;
- ukierunkowane testy dynamicznego engine/attestation — `3 passed`, exit 0;
- ukierunkowany `rustfmt --check` i `git diff --check` — exit 0.

Brama `just verify-fem-modal-floquet-airbox-cpu` nie doszła do kompilacji C++:
`ensure-managed-fem-runtime` wymaga ścieżki zarządzanego build runnera, a
`python scripts/local_runner_cli.py container-status` zwraca
`local-runner: Container profile allow-list mismatch`. Brak receiptu oznacza,
że managed MFEM/SLEPc, wykonanie na rzeczywistej siatce, residuale, zbieżność
paddingu/warunku otwartego oraz porównanie liczbowe z COMSOL/TetraX nadal mają
status **NOT VERIFIED**. Nie wykonano push/PR/merge ani usunięcia worktree.

### Przyrost właściciela solvera Floquet dense/sparse — `80736831e`

Dodano jawny moduł `cpu/frequency_domain/modal/floquet_modal_solver.*` jako
granicę między fazowo zredukowanym operatorem Blocha a adapterem SLEPc. Moduł
sprawdza finite, niezerowy trójwymiarowy wektor `k`, warunek Floquet, komplet
par periodycznych, marker zaakceptowanego operatora oraz obecność
realifikowanego pencila. Wymuszona ścieżka GPU jest odrzucana bez fallbacku.
Dense CPU z dynamicznym demag-k wymaga payloadu real-split, a sparse CSR bez
demag-k ma osobną funkcję admission i routing; sparse z demag-k jest odrzucany
ze stabilnym powodem i kierowany do właściciela dense Schura. Obie ścieżki są
wywoływane z produkcyjnego adaptera zamiast ogólnego wejścia K0.

Dodano target `fem_floquet_modal_solver_contract` oraz regresje dla poprawnego
non-k0 CPU, braku payloadu demag-k, wymuszonego GPU, zerowego `k`, braku seamów,
poprawnego sparse CSR i odrzucenia sparse+demag. Bezpośrednia kompilacja MSVC
z `FULLMAG_HAS_MFEM_STACK=0` dla nowego modułu, testu, adaptera produkcyjnego,
adaptera SLEPc i kinematyki zakończyła się exit 0; zlinkowany i uruchomiony
`floquet_modal_solver_test.exe` zakończył się exit 0. Jest to dowód źródłowy i
izolowany test kontraktu, nie managed MFEM/SLEPc ani dowód fizycznego `f(k)`.

Pełny `cargo +nightly check --features build-native` ponownie zatrzymał się na
znanych błędach bazowych konfiguracji bez MFEM (`Context::poisson_demag`,
`mkdir`, typy shared-domain); nowe pliki nie zgłosiły własnych błędów w tym
przebiegu. Brama `just verify-fem-modal-floquet-airbox-cpu` nadal zatrzymuje
się przed kompilacją przez `Container profile allow-list mismatch`. Managed
receipt, residual po rekonstrukcji potencjału, zbieżność, porównania COMSOL/
TetraX, UI, GPU oraz PR pozostają **NOT VERIFIED**.

### Walidacja payloadu właściciela Floquet — `de72a5b1f`

Właściciel dense sprawdza teraz rozmiar `n×n` i skończoność real-split
dynamicznego demag-k względem wymiaru pencila; sparse CSR ma analogiczną
walidację kształtu, offsetów, indeksów i wartości. Diagnostyka produkcyjna
rozróżnia model Floquet sparse od ogólnego sparse SLEPc. Regresje obejmują
niepełny i nie-skończony payload dense oraz przyjęcie poprawnego sparse bez
demag-k.

Ponowiona kompilacja MSVC i uruchomienie izolowanego testu kontraktu zakończyły
się exit 0; zmodyfikowany adapter produkcyjny także skompilował się exit 0.
Przyrost nie zmienia granicy kwalifikacji: managed MFEM/SLEPc, fizyczny
residual, zbieżność, porównania COMSOL/TetraX, UI i GPU są nadal **NOT VERIFIED**.

### Konwencja fazy i okno częstotliwości w handoffie SLEPc — `bed355f41`

Produkcja przekazuje teraz `ModalEigenRequest.phase_convention` do wszystkich
czterech konstrukcji żądania SLEPc: dense nearest, dense window, sparse nearest
i sparse window. Wewnętrzny request CSR ma ten sam jawny token i propaguje go do
wspólnego adaptera, więc `exp(+iωt)` oraz `exp(-iωt)` nie są przypadkiem
zamieniane przez wartość domyślną. Właściciel Floqueta odrzuca także ujemne,
nieskończone i odwrócone okna; `(0,0)` pozostaje jawnie rozpoznanym trybem bez
okna, a dodatnie `max > min` jest oznaczane jako wybrane okno.

Regresje obejmują odwrócone i ujemne okno oraz poprawne okno finite; bezpośrednia
kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` dla właściciela, testu, adaptera
SLEPc i adaptera produkcyjnego zakończyła się exit 0, a zlinkowany
`floquet_modal_solver_test.exe` zakończył się exit 0. Jest to dowód kontraktu
źródłowego; managed SLEPc, residual, fizyczne `f(k)`, porównania COMSOL/TetraX,
UI, GPU i integracja PR pozostają **NOT VERIFIED**.

### Rozdzielenie assemblacji dynamicznego Floqueta od K0 — `2e8362463`

Importer `assemble_poisson_airbox_shared_domain_payload` rozpoznaje teraz
dynamiczny wariant wyłącznie wtedy, gdy jednocześnie dostaje wektor `k` oraz
osobny wynik `FloquetAirboxDynamicDemagKResult`. Niepełny handoff, niefinite lub
zerowy `k` oraz brak par periodycznych kończą się stabilnym błędem walidacji.
W wariancie non-k0 importer pomija assemblację legacy K0 i buduje tylko cztery
bloki fazowe oraz ograniczony Schur `D(k)`; wynik oznacza się jako
`floquet_dynamic_demag_k`, aby pustych macierzy K0 nie można było odczytać jako
udanej assemblacji. Wywołanie bez argumentów Floqueta zachowuje dotychczasową
ścieżkę K0.

Zmiana jest zapisana w `2e8362463` i przechodzi `git diff --check`; pełny test
ciała MFEM nie został wykonany, ponieważ managed runner nadal odrzuca profil
(`Container profile allow-list mismatch`), a host nie ma nagłówków MFEM. Wobec
tego managed wykonanie, residual, zbieżność fizyczna, porównania COMSOL/TetraX,
UI, GPU i kwalifikacja wydania pozostają **NOT VERIFIED**.

### Spójność dwóch źródeł wektora Floqueta — `beca34bb0`

Właściciel modalny odrzuca teraz request, w którym legacy
`operator_request.k_vector_rad_m` i append-only `floquet_k_vector_rad_per_m`
opisują różne wartości albo niepełny wymiar. Gdy obecne jest tylko jedno źródło,
pozostaje ono legalnym nośnikiem trójwymiarowego `k`; oba źródła są wymagane do
zgodności, gdy zostały dostarczone jednocześnie. Stabilny powód
`floquet_modal_k_vector_payload_mismatch` chroni przed zmianą fazy bez zmiany
identyfikatora próbki.

Regresja konfliktu przechodzi w izolowanym `floquet_modal_solver_test.exe`
(MSVC, `FULLMAG_HAS_MFEM_STACK=0`), a kompilacja właściciela, adapterów i testu
kończy się exit 0. Managed MFEM/SLEPc, residual, fizyczne `f(k)` i pozostałe
bramki S04–S12 są nadal **NOT VERIFIED**.


### R01 — naprawa LU po audycie

Wykonano permutacje RHS przed podstawianiem z finalnym L. Nowa regresja
3×3 wymusza dwa pivoty i testuje zespolone multiple RHS oraz niezależny
Schur oracle. Natywny MSVC: RED exit 1 przed zmianą, GREEN exit 0 po zmianie
wraz ze wszystkimi wcześniejszymi testami pliku. Managed bramka nadal
kończy się przed kompilacją przez politykę kolejki runnera. R01 jest
naprawione źródłowo; managed potwierdzenie oraz R02 pozostają otwarte.

### R02 — certyfikacja bloku potencjału, częściowo

Provider odrzuca residual powyżej 1e-8 i sprawdza oryginalny wiersz pinowania.
Test obejmuje niezgodny RHS, niezerowy residual oraz brak publikacji outputu;
cały izolowany test C++ providera zakończył się exit 0. Zmieniono importer,
aby zachować certyfikat w diagnostics/result JSON, jawnie bez certyfikowania
pełnego modu. Ta część MFEM pozostaje nieskompilowana przez zablokowaną
managed trasę. Source-map validator noty 0828 i diff check: exit 0.
R02 nie jest zamknięte: S05.R02/full descriptor V9 i managed evidence otwarte.

### S05.R02 — fundament rekonstrukcji potencjału

Dodano owned FloquetPotentialReconstruction w wyniku bridge i natywny
reconstruct_floquet_potential. Zachowuje P/A_phiq/A_qphi i odtwarza
kompleksowy potencjał z oryginalnym residualem obejmującym pinned row.
Cały izolowany test MSVC exit 0: manufactured complex q, dwa pivoty,
zgodny gauge, odrzucenie niezgodnego źródła i brak starego pola po błędzie.
Nie podłączono jeszcze do wektorów SLEPc ani publikacji pól; magnetyczny
residual oraz Bloch BC nie są certyfikowane. S05.R02/V9 nadal OTWARTE.


### Aktualizacja S05.R02 — integracja dense SLEPc

Podłączono rekonstrukcję do nearest/window i każdego zwróconego modu.
Kontrola używa oryginalnego stiffness, sprzężeń i masy, a nie wyłącznie
macierzy Schura. Natywny JSON przenosi podwojony zespolony potencjał oraz
osobne residuale magnetyczny/potencjału. Błędny descriptor odrzuca solve.
Contour z kontekstem rekonstrukcji jest fail-closed. Izolowane testy providera
przechodzą (exit 0), adapter production_cpu_modal_eigen.cpp kompiluje się
MSVC bez MFEM (exit 0). To nie jest wykonanie SLEPc ani końcowa kwalifikacja.
Nadal do wykonania: geometryczne BC/pełna siatka, binary publikacja potencjału
przez runner, contour i managed/physics V9. R02 pozostaje częściowe.

### R03/R05 — naprawa pokrycia recepty i wznowienie rejestru

Na bazie 71a98514c410ebac82a610ccc2a17ff172533a23 rozszerzono managed recipe
do siedmiu kontraktów Floquet, ustawiono CPU realization i oddzielny CMake
build directory, poprawiono czas życia LD_LIBRARY_PATH dla wszystkich testów.
`just --show`, Bash syntax i porównanie targetów z CMake: PASS (7/7).
Nie uruchomiono jeszcze kompilacji w kolejce; receipt i fizyka pozostają otwarte.
Oficjalny resolver register: exit 0, poprawny pełny SHA i aktywny właściciel.
