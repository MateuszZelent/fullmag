# Eigensolve dyspersji — checkpoint implementacji

Data: 2026-09-12. Status zadania: **W TRAKCIE**. Kwalifikacja solvera non-k0: **NOT VERIFIED**.

## Cel i źródła

Realizacja [planu S00–S12](2026-09-12-eigensolve-dispersion-nonzero-k-plan.md), po osobnym zleceniu implementacji. Zakres obejmuje CPU z pełnym dynamicznym demag-k, falowód 2.5D, interakcje, GPU, artefakty, API i Control Room. Etap źródłowy lub pojedynczy test nie zamyka tego celu.

- Baza `master`: `5084a94ed14b151fc865e8def5a5c28401e98b44`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
- Właściciel: `codex:01a0941c-eb15-7261-a7ee-7cf099385525`.
- Rejestr: `eigensolve-dispersion-plan-20260-c5dfad6d7f548079`; reaktywowany do implementacji.
- Fizyczne źródła COMSOL: oba lokalne podręczniki modułu mikromagnetycznego wymienione w planie; szczególnie s. PDF 21–28 i 40–43. Przykład RF jest wzorem sprzężenia pól, a nie gotowym dowodem modalnym.

## Stan etapów

| Etap | Stan | Pozostały warunek |
|---|---|---|
| S00 — baza K0 i dowody | W TRAKCIE | Bieżący managed runtime, Kittel, pełny zaakceptowany handoff |
| S01 — nauka, ADR, kontrakty | W TRAKCIE | Noty, mapy źródeł, walidatory i review |
| S02 — Python/IR | W TRAKCIE | Walidacja k i selektorów, round-trip, testy konsumentów |
| S03 — natywny operator magnetyczny Blocha | W TRAKCIE | Prolongacja fazowa, MFEM sparse/matrix-free, testy i połączenie produkcyjne |
| S04 — dynamiczny demag-k CPU | DO WYKONANIA | Nowy właściciel airbox, sprzężenie, gauge, zbieżność brzegu |
| S05 — natywny solver spektralny | DO WYKONANIA | SLEPc, realifikacja, reszty, kompletność, cancellation/resume |
| S06 — śledzenie gałęzi | W TRAKCIE | Hungarian/gaps, następnie fizyczna metryka i podprzestrzenie |
| S07 — artefakty i API | W TRAKCIE | Stabilne ID, faza/obwiednia, selektory, binarne pola |
| S08 — Control Room | DO WYKONANIA | Authoring, dyspersja, wybór modu i przestrzenna faza; browser/WebGL |
| S09 — falowód 2.5D | DO WYKONANIA | Modified Helmholtz i normalizacja na długość |
| S10 — interakcje | DO WYKONANIA | Anizotropia, DMI seams, Gilbert i legalność |
| S11 — GPU | DO WYKONANIA | Jawna trasa double bez fallbacku, residency i parytet |
| S12 — kwalifikacja i integracja | DO WYKONANIA | Managed benchmarki, review, commity, PR, merge, weryfikacja mastera |

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

Każdy przyrost otrzymuje pełny hash commita, zakres, wykonane polecenie i exit code po weryfikacji. Źródła, build, managed runtime, nauka, browser/WebGL i kwalifikacja wydania są odrębnymi dowodami. Przyrost dokumentacyjny zapisano w commicie `9c5be5d2212995f1437823178e7f7af83ee883e0`: plan i checkpoint (dwa pliki). Kontrole UTF-8, bloków Markdown, etapów S00–S12, linków, whitespace oraz zgodności staged bytes ze sprawdzonymi plikami przeszły (exit 0); plan miał też niezależne review z domkniętymi uwagami. Nie ma jeszcze zweryfikowanego commita kodu ani nowego wyniku runtime. Odrzucenia nieobsługiwanych kombinacji non-k0/demag/GPU pozostają aktywne do dostarczenia właściwej realizacji i dowodów.


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

Jest to kontrakt i fail-closed bridge dla już złożonego operatora. Nie jest to
jeszcze właściciel assemblacji `A_{q\phi}(k)`, `P(k)`, `A_{\phi q}(k)` ani ich
Schur complementu; runner nadal odrzuca plan Floquet z demag-k, dopóki taki
provider nie zostanie podłączony do shared-domain mesh. Kompilacja managed,
wykonanie testów C++ oraz walidacja fizyczna tego adaptera pozostają **NOT
VERIFIED**.


### Przyrost po kolejnym review (12 września)

Poprzedni obrót celu klasyfikuję jako **postęp**: zapisano commit planu, kod i wyniki kontroli. Bieżąca kontynuacja również zmienia źródła; pełny cel S00–S12 pozostaje aktywny.

- S02: Python odrzuca niecałkowite/ujemne/przepełnione ID, niepoprawne wektory i kontrolne punkty ścieżki. Fokus API/IR dla eigensolve: 35 passed; pełny `test_problem_ir.py`: 26 passed. Rust zachowuje `branches`, `sample_selector`, `include_branch_table`; planner pozwala na unię żądań dla różnych selektorów próbek, a testy IR/plannera/runnera zostały wykonane diagnostycznie.
- S06: implementacja Hungarian i luk zachowuje surowe ID; `overlap_prev` jest rzeczywistym znormalizowanym overlapem, a `tracking_confidence` wynikiem 0.85 overlap + 0.15 frequency. Próg filtruje rzeczywisty overlap. Brak wektora ma jawny fallback częstotliwościowy i `overlap_prev=None`. Usunięto klonowanie bieżących dużych wektorów. Fizyczna metryka masowa i podprzestrzenie pozostają do wykonania.
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

Adapter dynamicznego demag-k przyjmuje wyłącznie kompletną macierz dostarczoną
przez przyszłego właściciela `A_{q\phi}(k)`/`P(k)`/`A_{\phi q}(k)`; nie jest
jeszcze takim providerem i nie usuwa runnerowego odrzucenia planu Floquet z
`include_demag`. S04/S05/S08–S12 pozostają otwarte.

### Walidacja po domknięciu przyrostu

- `cargo +nightly check --locked -p fullmag-ir -p fullmag-plan -p fullmag-runner --lib --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0; ostrzeżenia są istniejące lub dotyczą nieużytych elementów oczekujących na integrację.
- `cargo +nightly check --locked -p fullmag-cli --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target` oraz `cargo +nightly check --locked -p fullmag-runner --tests --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0.
- `cargo +nightly test --locked -p fullmag-ir --lib`: 101 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-ir --tests`: 101 unit + 229 integration tests passed, exit 0; `cargo +nightly test --locked -p fullmag-plan --lib`: 461 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib output_publication_tests`: 5 passed; `--lib tracking`: 13 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib eigen`: 226 passed, 1 failed. Jedyna porażka to istniejące `eigen::response_block_real::tests::field_driven_sweep_builds_artifact_ready_response_payload`, równość `1.0000000000000002` vs `1.0`; plik testu nie należy do tego przyrostu.
- Python: pełny `test_problem_ir.py` 26 passed; fokus API/IR dla eigensolve 35 passed; pełny `test_api.py` wykonał 277 passed i 19 failures środowiskowych (brak `h5py`/`zarr`, odmowa zapisu w lokalnym cache/worktree oraz `run_output`), bez błędu w fokusie eigensolve.
- Test kontraktu dokumentacji matematycznej: 9 passed. Walidatory source-map i `git diff --check`: exit 0.
- Próba nowego managed snapshotu nie utworzyła dodatkowego joba: runner zgłosił aktywny lock/storage dla rejestru `eigensolve-dispersion-plan-20260-c5dfad6d7f548079` i nakazał użyć istniejącego joba lub zaczekać. Najnowszy własny snapshot to job `b5200ded44964953a03491183dffaae1`, sequence 19, source digest `b59eadab5a1dd98e7b394403bd722bce864c81ea4d7659e24acd790f70853757`; ostatni odczyt pozostaje `queued` bez exit code. Nie uzyskano kompilacji C++ ani runtime dla bieżącego snapshotu.

Stan integracji pozostaje **W TRAKCIE**. Commity mają przejrzany staged diff;
otwarte pozostają PR, managed C++/SLEPc, provider `A_{q\phi}(k)`/`P(k)`/
`A_{\phi q}(k)`, walidacja fizyczna oraz ścieżki Control Room/GPU.
