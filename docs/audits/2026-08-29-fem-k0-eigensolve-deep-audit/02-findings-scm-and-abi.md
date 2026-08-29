# Audyt: rejestr problemów SCM i ABI

> Część modularna pełnego dokumentu `2026-08-29-fem-k0-eigensolve-deep-code-and-physics-audit.md` z 2026-08-29. Zakres oryginalnych linii: 215–378.

## 6. Rejestr problemów

Łącznie: **50** ustaleń, w tym **32 P0** i **18 P1**.

| ID | Priorytet | Typ | Problem |
|---|---:|---|---|
| SCM-01 | P0 | defekt repozytorium | Pusty cel symlinków uniemożliwia czysty checkout i unieważnia CI |
| SCM-02 | P0 | ryzyko integracji | Kod, raporty i historyczne poprawki są rozdzielone między `master` i rescue |
| SCM-03 | P1 | tożsamość artefaktów | Commit SHA i tree SHA mogą zostać pomylone |
| ABI-01 | P0 | defekt ABI | Publiczne struktury modalne C nie mają `struct_size` |
| ABI-02 | P1 | martwy kontrakt | Wewnętrzne `struct_size` istnieje, lecz nie jest egzekwowane |
| ABI-03 | P0 | defekt kontraktu wykonania | Modalne ABI nie wybiera jawnie lane'u i silnika CPU/GPU |
| ABI-04 | P1 | brak introspekcji | ABI layout/fingerprint nie obejmuje struktur modalnych |
| PHY-01 | P0 | błąd fizyczny | `m0` jest renormalizowane bez ponownego obliczenia `H_eff0`, demagu i energii |
| PHY-02 | P0 | martwe zabezpieczenia fizyczne | Opcje periodyczności i recompute są deklarowane, ale ignorowane |
| PHY-03 | P0 | błąd kwalifikacji równowagi | `accepted_for_linearization` i dostarczone `H_eff0` są traktowane jako zaufana prawda |
| PHY-04 | P1 | niewłaściwa norma | Torque residual jest czysto nodalny i nieważony |
| PHY-05 | P0 | błąd dyskretyzacji/metadanych | `tangent_lumped_mass` jest wypełnione jedynkami |
| PHY-06 | P0 | niepełna tożsamość fizyczna | Identyfikatory magnetic mesh, airbox mesh, `phi0` i liczba węzłów airboxa nie są wiązane |
| PHY-07 | P0 | błąd konwencji fazy | Nieznana konwencja fazy może zostać potraktowana jako `exp(-iωt)` |
| PHY-08 | P1 | gauge bazy stycznej | Baza styczna skacze przy `|m_z|=0.9` |
| NUM-01 | P0 | błąd wyboru spektrum | SLEPc dostaje rzeczywisty target `+ω`, choć kod interpretuje wartości własne jako `λ≈±iω` |
| NUM-02 | P0 | niepełny solve | Liczba pobranych par własnych nie gwarantuje spełnienia żądania po filtracji |
| NUM-03 | P0 | niewłaściwy residual | Residual SLEPc z problemu zredukowanego nie jest residualem pełnego descriptor pencil |
| NUM-04 | P0 | fałszywa kompletność | Diagnostyka publikuje `"complete": true` dla wyników niecertyfikowanych lub selected-only |
| NUM-05 | P0 | brak certyfikatu okna | Partitioning okna nie potrafi potwierdzić kompletności |
| NUM-06 | P1 | utrata metadanych | Konwencja fazy nie jest konsekwentnie propagowana do adaptera i artefaktów |
| NUM-07 | P0 | wadliwy certyfikat algorytmiczny | Contour solver utożsamia rangę projekcji z liczbą modów |
| NUM-08 | P0 | naruszenie tolerancji użytkownika | Contour solver po cichu luzuje residual co najmniej do `1e-7` |
| NUM-09 | P1 | martwe limity | Część limitów iteracji contour jest tylko walidowana lub raportowana |
| NUM-10 | P1 | stabilność numeryczna | Własne gęste solve używają absolutnych progów pivotu bez skalowania |
| NUM-11 | P1 | niepełna telemetria | Raport `linear_iterations_total` może zawierać tylko ostatni solve |
| PERF-01 | P0 | błąd architektury sparse | „Sparse payload” powstaje przez pełne zmaterializowanie `N×N` |
| PERF-02 | P0 | złożoność demagu | Materializacja dynamicznego demagu może mieć koszt około `O(N³)` |
| PERF-03 | P1 | ukryta densyfikacja | Sparse mass jest densyfikowana do overlap/dedup |
| PERF-04 | P0 | brak persistent Schur | Poisson Schur MatShell odtwarza gęsty solve w każdym `MatMult` |
| PERF-05 | P1 | błędna kwalifikacja wydajności | Explicit Schur jest budowany przez probing każdej kolumny |
| PERF-06 | P1 | brak skalowalnego solve | Domyślne `PCLU` jest sekwencyjne i nie stanowi ścieżki dużych problemów |
| POI-01 | P0 | oracle przedstawiony zbyt szeroko | Poisson-airbox eigensolve jest ograniczony do syntetycznego algebraicznego oracle |
| POI-02 | P0 | niewystarczający certyfikat PBC | Periodic certificate sprawdza głównie schema i dodatnią liczbę par |
| POI-03 | P1 | rozjazd kontraktu BC | API akceptuje więcej typów BC, niż wspiera descriptor route |
| GPU-01 | P0 | bounded oracle, nie produkcja | Modalny CUDA eigensolver jest ograniczony do 64 DOF i jednego wątku |
| GPU-02 | P0 | brak implementacji produkcyjnej | Brak device-resident produkcyjnego modalnego PETSc/SLEPc |
| GPU-03 | P0 | naruszenie residency | Każde GPU apply alokuje, kopiuje CSR, synchronizuje, kopiuje wynik i zwalnia |
| GPU-04 | P1 | taksonomia kodu | Kod modalny jest ukryty w `driven_response_gpu.cu` |
| GPU-05 | P1 | stabilność CUDA oracle | Własna arytmetyka zespolona i pivot floor nie mają pełnej kontroli kondycji |
| ART-01 | P0 | brak immutable artefaktu | Udany native solve może wyczyścić `artifact_manifest_path` |
| ART-02 | P1 | kruchy format diagnostyki | JSON jest składany ręcznie, a semantyka bywa rozpoznawana substringiem |
| ART-03 | P0 | conflation statusów | Availability pól, solve success, qualification i completeness nie są rozdzielone |
| ID-01 | P1 | słaba tożsamość | `linearization_signature_hash` nie jest hashem kryptograficznym ani kanonicznym |
| TEL-01 | P1 | myląca telemetria | Telemetria deklaruje reuse, którego implementacja nie wykonuje |
| TEST-01 | P0 | niewystarczające testy | Contour i część SLEPc są kwalifikowane głównie na 2×2 makrospinie |
| TEST-02 | P0 | brak Q1 | Brak świeżego kompletnego CPU window na obecnym source identity |
| TEST-03 | P0 | brak Q2 | Brak profiler-backed GPU qualification |
| UI-01 | P0 | brak konsolidacji funkcji | Control Room na `master` nie zawiera odnajdywalnego widma/eigenmode control opisanego historycznie |
| UI-02 | P0 | brak Q3 | Brak świeżego live WebGL proof na tym samym candidate |

## 6.1. Szczegółowe ustalenia

### SCM-01 — P0 — Pusty cel symlinków uniemożliwia czysty checkout i unieważnia CI

**Klasyfikacja:** defekt repozytorium; **pewność:** potwierdzony.

**Dowód w implementacji.** GitHub Actions dla `master` kończy `actions/checkout` błędami przy `.claude/skills/*` oraz `.worktrees`. W drzewie Git wpisy `.claude/skills/*` mają tryb symlinku, ale wskazują na pusty blob `e69de29...`, czyli nie zawierają poprawnej ścieżki celu.

**Dlaczego jest to błąd lub ograniczenie.** Bez odtwarzalnego checkoutu żaden test, build ani certyfikat nie jest powtarzalny. Jest to blokada wcześniejsza niż fizyka lub solver: obecne czerwone workflow nie uruchamiają testów, tylko zatrzymują się podczas materializacji drzewa.

**Skutek.** Brak wiarygodnego baseline'u; niemożność rozróżnienia regresji eigensolvera od uszkodzenia repozytorium; każdy historyczny GREEN staje się niewystarczający dla obecnego `master`.

**Naprawa.** Usunąć puste symlinki z repozytorium albo zastąpić je prawidłowymi, relatywnymi celami istniejącymi w drzewie. `.worktrees` nie powinno być wersjonowanym symlinkiem do lokalnego katalogu. Dodać test `git archive`/fresh checkout na Linux i Windows oraz guard odrzucający symlinki z pustym celem.

**Test akceptacyjny.** Nowy runner wykonuje checkout bez ostrzeżeń; `git ls-tree -r` nie zawiera symlinków z pustym blobem; wszystkie workflow przechodzą przynajmniej etap checkout.


### SCM-02 — P0 — Kod, raporty i historyczne poprawki są rozdzielone między `master` i rescue

**Klasyfikacja:** ryzyko integracji; **pewność:** potwierdzony dla referencji zdalnych; stan lokalny pochodzi z audytu wejściowego.

**Dowód w implementacji.** Zdalny `codex/eigensolve-master-rescue` wskazuje `e587df3c5ade76026346cc36671fc885a9d95d18` i jest rozbieżny z bieżącym `master` `9d7bd3191959513ad31879a9c5ccecaa48e28558`. Historyczny audyt opisuje dodatkowo lokalne, niewypchnięte commity oraz zaginiony worktree; tego fragmentu nie można potwierdzić wyłącznie przez GitHub.

**Dlaczego jest to błąd lub ograniczenie.** Nie da się kwalifikować „implementacji” bez jednej tożsamości źródła. Cherry-pick całej gałęzi może wnieść stare kontrakty, a pominięcie rescue może utracić poprawki FMS/API/UI.

**Skutek.** Ryzyko utraty kodu, regresji ABI i testowania innego źródła niż to, które później trafi do `master`.

**Naprawa.** Wykonać inwentaryzację commitów i niezacommitowanych patchy, a następnie przenosić logiczne batch'e na świeżą gałąź z aktualnego `master`. Każdy batch powinien mieć source-map, testy i osobny commit.

**Test akceptacyjny.** `git range-diff`, manifest keep/drop/rebuild, brak unikalnych zmian w porzuconych worktree oraz czysty branch finalizacyjny.


### SCM-03 — P1 — Commit SHA i tree SHA mogą zostać pomylone

**Klasyfikacja:** tożsamość artefaktów; **pewność:** potwierdzony.

**Dowód w implementacji.** Bieżący commit to `9d7bd3191959513ad31879a9c5ccecaa48e28558`, natomiast jego drzewo to `e67dff3c0597f43e8c16a1d7165e2a3a18290214`. Są to różne obiekty Git i pełnią różne role.

**Dlaczego jest to błąd lub ograniczenie.** Tree SHA nie identyfikuje rodziców, metadanych commita ani grafu historii. Dwa commity mogą wskazywać to samo drzewo. Receipt oparty tylko na tree SHA nie potwierdza brancha ani procesu promocji.

**Skutek.** Fałszywe powiązanie runtime'u, manifestu lub dowodu z niewłaściwym kandydatem.

**Naprawa.** W każdym manifeście przechowywać jawnie `commit_sha`, `tree_sha`, `dirty=false`, `branch/ref`, `build_recipe_digest` i `toolchain_digest`; nigdy nie nazywać obu pól ogólnym `source_sha`.

**Test akceptacyjny.** Test schema oraz negatywny test podmieniający commit przy niezmienionym drzewie.


### ABI-01 — P0 — Publiczne struktury modalne C nie mają `struct_size`

**Klasyfikacja:** defekt ABI; **pewność:** potwierdzony.

**Dowód w implementacji.** `native/include/fullmag_fem.h`: `FullmagFemModalEigenRequest` i `FullmagFemLinearizedOperatorRequest` mają `abi_version`, ale nie mają rozmiaru struktury, mimo że zawierają wiele pól i są rozszerzane.

**Dlaczego jest to błąd lub ograniczenie.** Samo `abi_version` nie chroni przed odczytem poza buforem, gdy starszy klient przekazuje krótszą strukturę, a nowa biblioteka czyta pola dodane później. Append-only ABI wymaga rozpoznania dostępnego prefiksu.

**Skutek.** Undefined behavior, błędy zależne od kompilatora i trudne do wykrycia konflikty klient–biblioteka.

**Naprawa.** Wprowadzić nowe, wersjonowane struktury vNext zaczynające się od `abi_version`, `struct_size`, `flags`, `reserved[]`. Biblioteka odczytuje wyłącznie pola mieszczące się w `min(struct_size, sizeof(vNext))`, waliduje minimalny prefiks i zeruje brakujące pola.

**Test akceptacyjny.** Macierz kompatybilności: stary klient/nowa biblioteka, nowy klient/stara biblioteka, skrócony prefiks, nadmiarowy ogon, błędny alignment i canary za końcem bufora.


### ABI-02 — P1 — Wewnętrzne `struct_size` istnieje, lecz nie jest egzekwowane

**Klasyfikacja:** martwy kontrakt; **pewność:** potwierdzony.

**Dowód w implementacji.** Wewnętrzne requesty C++ mają pole `struct_size`, ale `solve_modal_eigen_contract` sprawdza głównie wersje ABI i nie używa rozmiaru do bezpiecznego dekodowania pól.

**Dlaczego jest to błąd lub ograniczenie.** Pole sugeruje bezpieczeństwo, którego kod faktycznie nie zapewnia. To gorsze niż jawny brak funkcji, bo review i telemetria mogą założyć, że kontrakt jest chroniony.

**Skutek.** Niespójność między C i C++, potencjalne odczyty nieprawidłowych pól oraz fałszywe poczucie kompatybilności.

**Naprawa.** Albo usunąć martwe pole w niepublicznym typie, albo uczynić je obowiązkowym elementem jednego dekodera vNext. Wszystkie entrypointy muszą przechodzić przez ten sam preflight.

**Test akceptacyjny.** Mutation test zmieniający każde pole za deklarowanym `struct_size` nie może wpływać na wynik.


### ABI-03 — P0 — Modalne ABI nie wybiera jawnie lane'u i silnika CPU/GPU

**Klasyfikacja:** defekt kontraktu wykonania; **pewność:** potwierdzony.

**Dowód w implementacji.** `FullmagFemModalEigenRequest` nie ma pola odpowiadającego produkcyjnemu modalnemu `execution_lane`/`engine_id`. Istniejące pola device dotyczą specjalnego bounded action Poisson-airbox, a nie pełnego eigensolvera.

**Dlaczego jest to błąd lub ograniczenie.** Bez jawnej semantyki klient nie wie, czy uruchomiono CPU SLEPc, bounded CUDA oracle, host fallback czy przyszły PETSc CUDA. Telemetria nie może udowodnić polityki fail-closed.

**Skutek.** Cichy fallback, błędne claimy GPU i brak powtarzalności wydajności.

**Naprawa.** Dodać typowane `execution_lane`, `engine_id`, `device_policy`, `fallback_policy`, `scalar_kind` i `required_capabilities`. Nie rozpoznawać silnika po stringu diagnostycznym.

**Test akceptacyjny.** Tabela legalności planner/ABI; brak GPU musi zakończyć się kontrolowanym błędem, gdy `fallback_policy=forbid`.


### ABI-04 — P1 — ABI layout/fingerprint nie obejmuje struktur modalnych

**Klasyfikacja:** brak introspekcji; **pewność:** potwierdzony.

**Dowód w implementacji.** Publiczna funkcja layoutu opisuje głównie driven response; nie publikuje rozmiarów i offsetów kompletnego request/result modalnego.

**Dlaczego jest to błąd lub ograniczenie.** Generator bindingów i runtime nie mogą sprawdzić, czy widzą ten sam układ danych.

**Skutek.** Drift FFI wykrywany dopiero jako błąd numeryczny lub crash.

**Naprawa.** Dodać modalny layout descriptor i fingerprint generowany z kanonicznego schema; bindingi Python/Rust/TS mają testować go przy inicjalizacji.

**Test akceptacyjny.** Golden layout na wspieranych platformach oraz negatywny test z przesuniętym offsetem.
