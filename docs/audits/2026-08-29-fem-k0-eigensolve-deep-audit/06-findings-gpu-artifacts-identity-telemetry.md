# Audyt: GPU, artefakty, identity i telemetria

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 799–948.

### GPU-01 — P0 — Modalny CUDA eigensolver jest ograniczony do 64 DOF i jednego wątku

**Klasyfikacja:** bounded oracle, nie produkcja; **pewność:** potwierdzony.

**Dowód w implementacji.** W `driven_response_gpu.cu` istnieje `kMaxModalShiftInvertDenseDofs=64`; kernel gęstej eliminacji działa tylko w `block 0/thread 0`.

**Dlaczego jest to błąd lub ograniczenie.** To wykonuje sekwencyjną algebrę na urządzeniu. Nie wykorzystuje GPU do równoległego eigensolve i nie skaluje się do meshu FEM.

**Skutek.** Claim „GPU eigensolve” byłby semantycznie fałszywy poza testem kontraktowym.

**Naprawa.** Zmienić nazwę/engine ID na `cuda_bounded_dense_validation_oracle`; przenieść do osobnego pliku testowego. Produkcyjny lane oprzeć na PETSc/SLEPc z macierzami CUDA.

**Test akceptacyjny.** Oracle odrzuca N>64 z reason; production engine nie może wskazywać tego samego ID.


### GPU-02 — P0 — Brak device-resident produkcyjnego modalnego PETSc/SLEPc

**Klasyfikacja:** brak implementacji produkcyjnej; **pewność:** potwierdzony.

**Dowód w implementacji.** Dispatch/diagnostyka jawnie nie potwierdza `gpu_device_resident_modal_eigensolver`; publiczny modal request nie wybiera takiego engine.

**Dlaczego jest to błąd lub ograniczenie.** Pojedyncze CUDA kernels i action parity nie stanowią pełnego eigensolvera z trwałym operatorem, KSP, preconditionerem i EPS.

**Skutek.** Q2 nie może zostać zaliczone.

**Naprawa.** Po Q1 CPU dodać osobny adapter `slepc_cuda_*`: `MATAIJCUSPARSE`/odpowiednie typy Vec, persistent KSP/HYPRE CUDA, fail-closed policy i profiler receipt.

**Test akceptacyjny.** PETSc object graph przed `EPSSolve`, brak host fallback, parity wartości/residuali/subspace oraz Nsight/PETSc log.


### GPU-03 — P0 — Każde GPU apply alokuje, kopiuje CSR, synchronizuje, kopiuje wynik i zwalnia

**Klasyfikacja:** naruszenie residency; **pewność:** potwierdzony.

**Dowód w implementacji.** Eksportowane descriptor/shift-invert actions wykonują H2D dla bloków i wektorów, kernel, synchronizację, D2H i cleanup przy każdym wywołaniu.

**Dlaczego jest to błąd lub ograniczenie.** Eigensolver wywołuje operator wiele razy. Per-apply transfer całej struktury niszczy wydajność i nie spełnia device-resident contract.

**Skutek.** GPU może być wolniejsze od CPU; profiler pokaże dominację transferów.

**Naprawa.** Kontekst RAII utrzymujący macierze, wektory, workspace i faktoryzacje na urządzeniu przez cały run. Host otrzymuje tylko końcowe mody/telemetrię.

**Test akceptacyjny.** Po setupie liczba H2D macierzy = 0 w matvec loop; brak `cudaMalloc/cudaFree` per apply.


### GPU-04 — P1 — Kod modalny jest ukryty w `driven_response_gpu.cu`

**Klasyfikacja:** taksonomia kodu; **pewność:** potwierdzony.

**Dowód w implementacji.** Jeden plik miesza driven response, descriptor actions i bounded modal eigensolver.

**Dlaczego jest to błąd lub ograniczenie.** Nazwa i ownership utrudniają review, capability detection i budowanie bez przypadkowego włączenia validation oracle do produkcji.

**Skutek.** Błędne claimy oraz zbyt szerokie zależności.

**Naprawa.** Rozdzielić `driven_response_gpu`, `modal_validation_oracle_gpu`, `modal_operator_gpu` i przyszły `slepc_modal_gpu_adapter`.

**Test akceptacyjny.** CMake targety i symbol allowlist nie pozwalają production lane linkować validation oracle.


### GPU-05 — P1 — Własna arytmetyka zespolona i pivot floor nie mają pełnej kontroli kondycji

**Klasyfikacja:** stabilność CUDA oracle; **pewność:** potwierdzony.

**Dowód w implementacji.** Jednowątkowa eliminacja używa własnego typu complex i ekstremalnie małego absolutnego progu.

**Dlaczego jest to błąd lub ograniczenie.** Dla bloków o różnych jednostkach można przejść z prawie osobliwym pivotem i wygenerować ogromny błąd.

**Skutek.** Oracle może dawać pozornie precyzyjny, ale niestabilny wynik.

**Naprawa.** Użyć cuSOLVER/LAPACK dla bounded oracle, raportować condition estimate i backward error.

**Test akceptacyjny.** Losowe similarity scaling, prawie osobliwe bloki, NaN/Inf guards.


### ART-01 — P0 — Udany native solve może wyczyścić `artifact_manifest_path`

**Klasyfikacja:** brak immutable artefaktu; **pewność:** potwierdzony.

**Dowód w implementacji.** Production CPU wrapper po części sukcesów zeruje/pozostawia pustą ścieżkę manifestu.

**Dlaczego jest to błąd lub ograniczenie.** Wynik numeryczny bez manifestu nie wiąże inputu, operatora, runtime'u i pól moda.

**Skutek.** Nie da się później udowodnić, co zostało policzone ani bezpiecznie załadować do FMS/UI.

**Naprawa.** Sukces produkcyjny wymaga atomowego zapisania manifestu i wszystkich obowiązkowych artefaktów; brak zapisu zmienia status na `artifact_commit_failed`.

**Test akceptacyjny.** Fault injection: brak miejsca, przerwany rename, checksum mismatch i restart.


### ART-02 — P1 — JSON jest składany ręcznie, a semantyka bywa rozpoznawana substringiem

**Klasyfikacja:** kruchy format diagnostyki; **pewność:** potwierdzony.

**Dowód w implementacji.** Wrappery konkatenacją tworzą JSON i wykrywają operator terms/flags przez wyszukiwanie tekstu.

**Dlaczego jest to błąd lub ograniczenie.** Kolejność, escaping i przypadkowe wystąpienie tekstu mogą zmienić zachowanie. Diagnostyka nie powinna sterować fizyką.

**Skutek.** Uszkodzony JSON lub błędny feature gate.

**Naprawa.** Typowane struktury + jeden serializer; solver decisions wyłącznie na enumach/bitsetach, JSON tylko jako projekcja wyniku.

**Test akceptacyjny.** Fuzz strings, escaping, reordered JSON i schema validation.


### ART-03 — P0 — Availability pól, solve success, qualification i completeness nie są rozdzielone

**Klasyfikacja:** conflation statusów; **pewność:** potwierdzony.

**Dowód w implementacji.** Historyczny audyt wykrył wyprowadzanie `qualified` z dostępności pól; bieżący backend dodatkowo miesza `complete` z sukcesem/selection.

**Dlaczego jest to błąd lub ograniczenie.** Każde z tych twierdzeń ma innego wystawcę i inne dowody.

**Skutek.** UI może pokazać niekwalifikowany mod jako naukowo zatwierdzony.

**Naprawa.** Osobne certyfikaty: `solve_receipt`, `residual_certificate`, `window_certificate`, `scientific_qualification`; UI nie może ich syntetyzować.

**Test akceptacyjny.** Macierz 16 kombinacji statusów i snapshoty API/UI.


### ID-01 — P1 — `linearization_signature_hash` nie jest hashem kryptograficznym ani kanonicznym

**Klasyfikacja:** słaba tożsamość; **pewność:** potwierdzony.

**Dowód w implementacji.** Kod konkatenacją buduje tekst `name=value;`; inne miejsca używają m.in. FNV-1a do kluczy certyfikatu.

**Dlaczego jest to błąd lub ograniczenie.** Delimiter collision, brak canonical encoding i słaba odporność na kolizję nie nadają się do provenance naukowej.

**Skutek.** Stale cache lub błędne związanie artefaktów.

**Naprawa.** Kanoniczny CBOR/JSON z długościami i BLAKE3/SHA-256; wersja schema w preimage. Hashować także ordering, frame, mass, build i solver config.

**Test akceptacyjny.** Golden digest, property tests kolejności pól i collision-oriented delimiter cases.


### TEL-01 — P1 — Telemetria deklaruje reuse, którego implementacja nie wykonuje

**Klasyfikacja:** myląca telemetria; **pewność:** potwierdzony.

**Dowód w implementacji.** Schur diagnostics mówi o reused mean-zero Poisson setup, choć gęsta faktoryzacja jest odtwarzana w apply.

**Dlaczego jest to błąd lub ograniczenie.** Telemetria ma być dowodem zachowania, a nie intencją.

**Skutek.** Fałszywa kwalifikacja wydajności.

**Naprawa.** Counters muszą pochodzić z rzeczywistych lifecycle events: setup count, factorization count, allocations, H2D/D2H, synchronizations.

**Test akceptacyjny.** Instrumentowany fixture porównuje liczniki z hookami alokacji/solver setup.
