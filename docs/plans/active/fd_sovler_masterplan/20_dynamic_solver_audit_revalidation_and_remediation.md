---
title: Rewalidacja audytu i instrukcja napraw solvera dynamicznego FEM
date: 2026-07-10
status: revalidated_blockers_found
scope:
  - FEM frequency-domain modal eigen
  - FEM frequency-driven CPU and GPU
  - modal basis and modal-reduced response
  - Poisson-airbox, Floquet and tangent-space contracts
  - native C ABI and buffer safety
excluded:
  - FDM
  - nonlinear time-domain LLG
source_revision: ec9e68893a9932de4bbea940ff608356402d9cc5
implementation_changes: none
---

# Rewalidacja audytu solvera dynamicznego FEM i kompletna instrukcja napraw

## 1. Odpowiedź krótka

Zgadzam się z głównym wnioskiem audytu: obecny zestaw lane'ów modalnych,
modal-reduced, Poisson-airbox i przyszłego device-resident FGMRES nie daje
jeszcze podstaw do bezwarunkowego certyfikowania wszystkich wyników
dynamicznych jako produkcyjnych.

Nie zgadzam się jednak z audytem bez zastrzeżeń. Audyt był wykonany na
ograniczonym pakiecie 19 nagłówków. Bieżące repozytorium zawiera realne
implementacje `.cpp` i `.cu`, a część podanych ocen miesza trzy różne rzeczy:

1. potwierdzony błąd wykonywanej ścieżki produkcyjnej,
2. potwierdzony błąd niepodłączonego kontraktu, który jest blockerem przed
   przyszłą promocją,
3. ograniczenie starego zestawu wejściowego albo tezę już nieaktualną w
   bieżącym kodzie.

Wszystkie sześć konkretnych reprodukcji z audytu nadal występuje na podanej
rewizji:

```text
negative_certificate_allowed=1
cache_collision=1
overflowed_basis_extent_allowed=1
one_iteration_config_certified_by_256_iteration_claim=1
callback_received_infinite_omega=1
infinite_omega_probe_accepted=1
```

Ich ekspozycja jest jednak różna:

- defekty `modal_basis.hpp` są obecnie niepodłączonymi blockerami promocji
  `modal_reduced`, a nie udowodnioną korupcją aktualnego artefaktu produkcyjnego;
- defekty `gpu_device_krylov.hpp` dotyczą przyszłego device-resident FGMRES;
  bieżący `production_gpu` wykonuje hostowy GMRES z callbackami operatora CUDA;
- publiczny C ABI, błędne targetowanie SLEPc, zerowy RHS w hostowym GMRES,
  ukryte zależności stanu linearyzacji i brak pełnego kontraktu Floquet dla
  tekstur są problemami aktualnego kodu, a nie wyłącznie szkieletem;
- GPU-G5a jest tiny dense validation kernel, ale publikuje zbyt szeroki
  `gpu_device_resident_modal_eigensolver=true`; wymaga natychmiastowej korekty
  statusu niezależnie od późniejszego skalowalnego eigensolvera.

## 2. Zakres i znaczenie statusów

Ten dokument obejmuje wyłącznie FEM. FDM jest poza zakresem. Nie zmienia on
implementacji solvera; jest wykonywalnym planem napraw z przypisaniem plików,
testów i warunków odbioru.

Statusy użyte w ledgerze:

| Status | Znaczenie |
|---|---|
| **potwierdzone — aktywne** | błąd może dotknąć obecnie wykonywanej ścieżki lub publicznego ABI |
| **potwierdzone — dormant** | błąd istnieje, ale dotyczy niepodłączonego helpera/lane'u; jest blockerem promocji |
| **częściowo potwierdzone** | rdzeń tezy jest trafny, lecz bieżący kod ma już część wymaganych zabezpieczeń |
| **nieaktualne / obalone** | teza nie opisuje bieżącego repozytorium |
| **niewykonane runtime** | analiza źródła jest rozstrzygająca, lecz bieżący managed gate zablokował inny dirty workstream |

Priorytety:

- **P0** — blokuje publiczne bezpieczeństwo ABI albo promocję naukową lane'u;
- **P1** — konieczne utwardzenie przed pełną kwalifikacją;
- **P2** — porządek kontraktu, diagnostyki lub utrzymania bez bieżącego ryzyka
  błędnego wyniku.

## 3. Dowody użyte w rewalidacji

Sprawdzono bieżące nagłówki, implementacje CPU/CUDA, testy i routing, w tym:

- `backends/fem/include/frequency_domain/modal_basis.hpp`;
- `backends/fem/include/frequency_domain/gpu_device_krylov.hpp`;
- `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`;
- `backends/fem/src/frequency_domain/driven_response_solver.cpp`;
- `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp`;
- `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`;
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`;
- `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`;
- `backends/fem/src/frequency_domain/linearization_state.cpp`;
- `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp`;
- `native/include/fullmag_fem.h` i `backends/fem/src/api.cpp`;
- kanoniczne noty fizyczne i poprzedni audyt
  `19_eigensolve_frequency_driven_physics_numerics_audit.md`.

Reproducer skompilowano jako C++20 z ostrzeżeniami i uruchomiono na aktualnych
nagłówkach. Repozytoryjna bramka
`just verify-fem-frequency-domain-native-contract` została uruchomiona zgodnie
z regułą managed/container-first, lecz nie dotarła do testów frequency-domain.
Odbudowę zatrzymały niezależne, istniejące zmiany w GPU relaxation:
`nonlinear_cg.cpp` przekazuje `uint8_t *magnetic_node_mask` do nowego argumentu
`const double *lumped_mass`. Tego obcego workstreamu nie naprawiano w ramach
niniejszego audytu.

## 4. Ledger wszystkich tez z dostarczonego audytu

| ID | Teza | Werdykt na bieżącym kodzie | Priorytet i ekspozycja |
|---|---|---|---|
| A-01 | ujemny lub niespójny certyfikat bazy modalnej jest akceptowany | **potwierdzone — dormant** | P0 przed promocją `modal_reduced` |
| A-02 | klucz cache bazy modalnej ma kolizje delimiter-injection | **potwierdzone — dormant** | P0 przed użyciem cache |
| A-03 | `expected_vector_size * vector_count` może się zawinąć | **potwierdzone — dormant** | P0 przed device FGMRES; należy też przeaudytować aktywne extenty |
| A-04 | konfiguracja GPU wymaga i przyjmuje wyniki przyszłego/starego solve | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-05 | `max_iterations=1` może użyć deklaracji testu 256 iteracji | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-06 | `omega=+inf` przechodzi probe; brak powiązania z omega diagnostyki | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-07 | reguła residualu 64/256 odrzuca early convergence i zero | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-08 | nie ma jednego kanonicznego równania dynamicznego | **częściowo potwierdzone** | P0 architektury; noty i wspólne `apply` już istnieją, brak jednego typu |
| A-09 | definicja `gamma`, `gamma0`, `mu0`, Hz/rad/s jest niejednoznaczna | **częściowo potwierdzone** | P0 API; dokumentacja rozstrzyga, nagłówki nadal dublują semantykę |
| A-10 | brak centralnego mapowania lambda na częstotliwość i zanik | **potwierdzone — aktywne** | P0 testów znaku i obu fazorów |
| A-11 | count modów w oknie nie certyfikuje odpowiedzi wymuszonej | **potwierdzone — dormant** | P0 przed `modal_reduced` |
| A-12 | tłumiona/nonnormalna diagonalna ekspansja eigenmodalna wymaga lewych i prawych modów | **potwierdzone — dormant** | P0 przed tym wariantem ROM; nie dotyczy każdego rational/reduced-basis engine |
| A-13 | certyfikat countu nie przechowuje dowodu metody ani provenance | **potwierdzone — dormant** | P0 przed użyciem certyfikatu |
| A-14 | descriptor pencil Poisson-airbox wymaga eliminacji/deflacji algebraicznej | **potwierdzone — validation-only** | P0 przed produkcyjnym Poisson modal; realne assembly jest fail-closed |
| A-15 | device FGMRES nie ma pełnej pętli | **potwierdzone — dormant** | P0 promocji; `production_loop_available=false` |
| A-16 | baza Arnoldiego zawsze musi mieć osobne `m+1` slotów | **częściowo potwierdzone** | P1; `V(m)+work` może być poprawne, lecz kontrakt tego nie opisuje |
| A-17 | probe nadpisuje bufor `solution` | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-18 | probe nie sprawdza wyniku, aliasingu ani async errors | **potwierdzone — dormant** | P0 przed device FGMRES |
| A-19 | zdublowana konwencja fazowa może się różnić | **częściowo naprawione** | P1; pola są zdublowane, ale driven validator odrzuca mismatch |
| A-20 | zdublowane rodzaje wzbudzenia nie mają jednej kanonizacji | **potwierdzone — aktywne** | P1/P0 przy rozszerzaniu drive'ów |
| A-21 | dwa wektory Floqueta mogą się różnić | **potwierdzone — aktywne** | P0 dla modal/Floquet; driven ma tylko część kontroli |
| A-22 | kilka wariantów problemu może być aktywnych jednocześnie | **potwierdzone — aktywne** | P0 routingu; obecnie działa precedencja zamiast exact-one |
| A-23 | orientacja ramki stycznej nie jest określona | **częściowo potwierdzone** | P1; implementacja buduje prawoskrętną ramkę, API tego nie gwarantuje |
| A-24 | scalar edge block nie przenosi ogólnej ramki | **częściowo potwierdzone** | P1; overload z ramkami robi `E_i^T E_j`, overload bez ramek jest ryzykowny |
| A-25 | DMI jest błędnie reprezentowane przez scalar edge block | **nieaktualne dla bieżącej ścieżki** | DMI ma osobny operator elementowy; nie należy go kierować przez edge scalar |
| A-26 | Floquet potrzebuje transportu `E_b^T E_a`, nie tylko fazy | **potwierdzone — aktywne** | P0 dla niejednorodnego `m0` |
| A-27 | faza powinna wynikać z `k dot T` | **częściowo naprawione** | driven sprawdza `phase=-k dot T`; modal nadal wymaga wspólnej kanonizacji |
| A-28 | `MeshSymmetryCertificate` nie certyfikuje topologii FEM | **potwierdzone — aktywne** | P0 przed produkcyjnym periodic FEM |
| A-29 | `max_airbox_phi_pair_mismatch` nie ma danych phi | **potwierdzone — aktywne** | P1; pole zawiera dziś residual geometrii pod błędną nazwą |
| A-30 | dense oracle deklaruje alpha=0 i k=0 bez danych do kontroli | **potwierdzone — validation-only** | P1 |
| A-31 | dense matrix views nie mają długości/stride | **potwierdzone — aktywne** | P0 dla granicy niezaufanych buforów |
| A-32 | `struct_size==0` i exact `sizeof` nie dają bezpiecznej ewolucji ABI | **potwierdzone — aktywne** | P0 publicznego C ABI |
| A-33 | `struct_size` ma niespójne typy | **potwierdzone** | P1; symptom braku wspólnej polityki ABI |
| A-34 | STL typy przechodzą obecnie bezpośrednio przez C ABI | **obalone** | `std::string/vector` są wewnętrzne; C wynik używa owned `char *` |
| A-35 | `noexcept` z alokacjami może zakończyć proces | **potwierdzone — aktywne** | P0 niezawodności biblioteki |
| A-36 | CSR nie ma długości buforów | **nieaktualne** | długości już istnieją; nadal brakuje pełnej polityki canonical CSR |
| A-37 | stan linearyzacji ma ukryte/ignorowane zależności | **potwierdzone — aktywne** | P0 reprodukowalności |
| A-38 | nie dostarczono implementacji `.cpp/.cu` solverów | **prawda tylko dla audytowanego pakietu, fałsz dla repo** | bieżące repo ma CPU GMRES, SLEPc, CUDA operator i testy |
| A-39 | cały obecny GPU driven solver jest jedynie probe | **obalone** | realny host GMRES + CUDA operator; nie jest device-resident |
| A-40 | realny shift SLEPc poprawnie targetuje `lambda=i omega` | **obalone** | P0: co najmniej trzy adaptery używają realnego `EPSSetTarget(...)` |
| A-41 | `require_nonzero_rhs=false` działa we wszystkich lane'ach | **obalone** | P0/P1: wspólny host GMRES odrzuca zerowy RHS |
| A-42 | bieżący Poisson-airbox modal składa produkcyjną słabą formę FEM | **obalone** | validation-only P0 przed promocją: adapter akceptuje tylko synthetic algebraic oracle i realne warianty odrzuca |
| A-43 | GPU-G5a jest skalowalnym, persistent device-resident modal eigensolverem | **obalone — mylący aktywny artifact** | P0 status/provenance: one-shot dense, kernel `<<<1,1>>>`, a artifact ustawia `gpu_device_resident_modal_eigensolver=true` |

## 5. Kanoniczny stan docelowy

Jedno źródło prawdy powinno definiować:

```text
B_alpha dq/dt = L q + b(t)
L v_j = lambda_j B_alpha v_j
A_plus(omega)  = +i omega B_alpha - L   dla exp(+i omega t)
A_minus(omega) = -i omega B_alpha - L   dla exp(-i omega t)
gamma0 = mu0 * abs(gamma)                [m / (A s)]
omega = 2*pi*f                            [rad / s]
```

Kanoniczny obiekt musi być tym samym obiektem używanym przez eigensolver,
direct/FGMRES driven response, obliczanie true residualu, preconditioner
qualification i modal-reduced validation. Nie wolno odtwarzać znaków, `mu0`,
fazora albo macierzy masy osobno w każdym lane'ie.

Minimalny interfejs wewnętrzny:

```cpp
struct LinearizedDynamicPencil {
    DynamicPencilMetadata metadata;
    ApplyRealOperator apply_L;
    ApplyRealOperator apply_B_alpha;
    ApplyComplexOperator apply_Aomega;
    ApplyAdjointOperator apply_L_adjoint;
    ApplyAdjointOperator apply_B_adjoint;
    OperatorDigest digest;
};
```

`apply_Aomega` powinno być budowane centralnie z `apply_L`, `apply_B_alpha` i
jednego enumu fazora. Dedykowana zoptymalizowana/fused implementacja może je
zastąpić dopiero po teście równoważności z konstrukcją referencyjną.

## 6. Kolejność wdrażania

Napraw nie należy wykonywać w kolejności przypadkowej. Zależności są
następujące:

1. Zamrozić uczciwe statusy lane'ów i nie promować `modal_reduced`,
   `gpu_device_krylov` ani realnego Poisson-airbox.
2. Wprowadzić kanoniczny pencil, jednostki, fazor i kanonizację requestu.
3. Naprawić publiczny ABI, checked arithmetic i granice wyjątków.
4. Naprawić stan linearyzacji, podpisy operatora i certyfikaty provenance.
5. Naprawić eigensolver: shift, descriptor/gauge, lewy/prawy modal contract.
6. Naprawić modal response: true residual, backward error, enrichment/fallback.
7. Domknąć Floquet transport ramek i topologiczny certyfikat siatki.
8. Dopiero potem implementować pełny device-resident FGMRES.
9. Wykonać managed runtime, physics i convergence gates przed zmianą statusu
   capability na produkcyjny.

## 7. Szczegółowe instrukcje napraw

### DS-01. Jeden typ kanonicznego pencilu dynamicznego

**Status:** częściowo potwierdzone, P0 architektury.

#### Dowód i precyzyjna korekta audytu

Kanoniczne noty już definiują relację eigen/driven, a implementacja nie jest
całkowicie rozłączna. `assemble_mfem_modal_dense_operator_payload()` buduje
kolumny przez `apply_mfem_linearized_cpu_operator()`. Driven response wywołuje
tę samą funkcję dla części operatora MFEM. To ogranicza ryzyko dwóch zupełnie
niezależnych równań.

Brakuje jednak jednego typu, który wiąże `L`, `B_alpha`, fazor, jednostki,
podpis operatora i adjoint. Top-level requesty nadal mówią równolegle o
`stiffness`, `gyrotropic`, `mass`, `frequency mass`, `Aomega` i damping policy.

#### Instrukcja implementacji

1. W backend-neutral warstwie frequency-domain utworzyć
   `linearized_dynamic_pencil.hpp/.cpp`; nie dodawać nowej fizyki do
   `Context` ani `mfem_bridge.cpp`.
2. Zdefiniować jeden enum fazora oraz jedną strukturę metadanych z:
   `gamma0_si`, `field_unit=A_per_m`, `frequency_unit=Hz`,
   `angular_frequency_unit=rad_per_s`, `eigenvalue_unit=per_s`, damping model,
   tangent-frame convention i operator digest.
3. Wymagać osobnych, read-only akcji `apply_L(q)` i `apply_B_alpha(q)`.
4. Zbudować referencyjne `apply_Aomega` wyłącznie jako:

   ```text
   y = sign(phase) * i * omega * B_alpha(x) - L(x).
   ```

5. Zachować fused CPU/GPU `Aomega` jako optymalizację, ale przed rejestracją
   wymagać parity testu z referencyjną kompozycją na losowych wektorach.
6. Eigensolver ma przyjmować ten sam pencil, nie trzy niezależne macierze bez
   słownika. Adapter dense/CSR może materializować `L` i `B_alpha` kolumnami.
7. True residual eigensolvera i driven solvera musi wywoływać canonical pencil,
   a nie operator odtworzony z wyniku.
8. Dodać akcje adjoint/transpose do tego samego kontraktu; bez nich lane
   damped modal-reduced pozostaje niedostępny.
9. Usunąć ręcznie powielane konstrukcje `Aomega` dopiero po migracji wszystkich
   callerów i testach równoważności.

#### Pliki docelowe

- nowe `backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp`;
- nowe `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp`;
- `mfem_linearized_operator.*`, `mfem_modal_operator_payload.*`;
- `modal_eigen_solver.cpp`, `driven_response_solver.cpp`;
- CPU/GPU operator adapters, bez łączenia ownership lane'ów CPU i GPU.

#### Testy i warunek odbioru

- losowe `x`: `fused_Aomega(x)` zgodne z referencyjnym `i*omega*B-L` dla obu
  fazorów;
- ta sama sygnatura operatora w eigen, driven i true-residual artifact;
- macrospin: `A(lambda)v=0` w częstotliwości zwróconej przez eigensolver;
- zmiana dowolnego parametru fizycznego zmienia digest;
- brak alternatywnego top-level równania w aktywnych lane'ach.

### DS-02. Jednostki `gamma`, `gamma0`, `mu0`, częstotliwości i shiftu

**Status:** częściowo potwierdzone, P0 API i naukowej reprodukowalności.

#### Stan bieżący

Noty fizyczne rozstrzygają, że dla pól w `A/m` obowiązuje
`gamma0=mu0*abs(gamma)` w `m/(A s)`. Nagłówki nadal mają dwa modele:
`gamma_rad_s_T + mu0_T_m_A` w modal request oraz `gamma0` w operator/driven.
Pola shiftu Poisson-airbox nie mają sufiksu jednostki.

#### Instrukcja implementacji

1. Na publicznej granicy zachować wielkości fizyczne, ale nazwać je
   jednoznacznie: `gamma_abs_rad_per_s_t`, `mu0_t_m_per_a`,
   `gamma0_m_per_a_s`.
2. Kanonizator requestu ma policzyć dokładnie jedną wewnętrzną wartość
   `gamma0_m_per_a_s`.
3. Jeśli caller poda równocześnie `gamma`, `mu0` i `gamma0`, sprawdzić zgodność
   względną w tolerancji określonej w kontrakcie; konflikt odrzucić.
4. Nie używać `rad` jako wymiaru numerycznego w przeliczeniach, ale zachować go
   w nazwach/provenance, aby odróżnić `Hz` i `rad/s`.
5. Zmienić pola shiftu na `shift_sigma_real_per_s` i
   `shift_sigma_imag_rad_per_s`, albo zastąpić je typed complex eigenvalue.
6. Każdy artifact ma przechowywać jednocześnie `frequency_hz`, `omega_rad_s`,
   `lambda_real_per_s`, `lambda_imag_rad_per_s`, phase convention i gamma
   provenance.
7. Usunąć surowe, bezjednostkowe pola dopiero w nowej wersji ABI; stary adapter
   ma je jawnie przeliczyć i oznaczyć jako legacy.

#### Testy i warunek odbioru

- macrospin z danym `gamma` i `mu0` daje ten sam wynik co równoważne `gamma0`;
- celowe pominięcie `mu0` daje failing test z błędem skali, nie akceptację;
- round-trip `f -> omega -> f` zachowuje wartość w ustalonej tolerancji;
- artifact nie zawiera bezjednostkowego pola `sigma` ani `gamma0` bez
  definicji.

### DS-03. Centralne mapowanie wartości własnych, fazora i znaku tłumienia

**Status:** potwierdzone, P0 walidacji fizycznej.

#### Instrukcja implementacji

1. Dodać czystą funkcję:

   ```cpp
   ModeKinematics map_eigenvalue(
       ComplexEigenvalue lambda,
       FrequencyDomainPhaseConvention phase);
   ```

2. Funkcja zwraca `frequency_hz`, `omega_rad_s`, `decay_rate_per_s`, branch
   sign i flagę stabilności.
3. Dla `exp(+i omega t)` dodatnia gałąź ma `Im(lambda)>0`, a stabilny zanik
   `Re(lambda)<=0`. Dla `exp(-i omega t)` znak części urojonej gałęzi dodatniej
   jest przeciwny; definicja zaniku pozostaje jawna i testowana.
4. Filtry modów, artifact writer, contour count i modal response mają używać
   tej funkcji zamiast lokalnych porównań `lambda_imag > 0`.
5. Przy tolerancji zero/soft mode nie przypisywać arbitralnie gałęzi; zwrócić
   `zero_frequency_mode`.
6. Zapisać w artifactach zarówno surowe `lambda`, jak i wynik mapowania.

#### Testy

- macrospin `alpha=0`: para sprzężona i właściwe `+/- omega`;
- macrospin `alpha>0`: obie gałęzie stabilne w wybranej konwencji;
- przełączenie fazora daje właściwą transformację przez sprzężenie;
- zero mode nie jest usuwany przez filtr dodatniej częstotliwości bez jawnej
  polityki.

### DS-04. Jedna kanonizacja requestu i tagged source zamiast precedencji flag

**Status:** potwierdzone, P0 routingu.

#### Dowód

`ModalEigenRequest` i `DrivenFrequencyResponseSolveRequest` zawierają wiele
niezależnych flag `enabled`. Modal routing wybiera najpierw tiny, potem
Poisson, potem production; driven routing również ma precedencję. Validator nie
wymaga dokładnie jednego źródła całego problemu. Phase mismatch w driven jest
już odrzucany, lecz samo dublowanie pozostaje. Dwa wektory `k` nie są
kanonicznie porównywane we wszystkich lane'ach.

#### Instrukcja implementacji

1. Zdefiniować wewnętrzny sum type:

   ```text
   CanonicalOperatorSource =
       TinyValidation
     | MfemMatrixFree
     | ExplicitDense
     | ExplicitCsr
     | PoissonAirboxDescriptor
     | ExternalProvider
   ```

2. Dodać jedną funkcję `canonicalize_dynamic_solve_request()` wywoływaną przed
   plannerem lub alokacją.
3. Policz aktywne źródła. `0` oraz `>1` zwracają `validation_error` z listą
   konfliktujących pól; żadnej cichej precedencji.
4. Wybrać phase convention, `k`, boundary, demag, drive kind i operator source
   dokładnie raz. Zduplikowane legacy pola wolno zaakceptować tylko, gdy są
   bitowo/numerycznie zgodne.
5. Faza per pair ma być wynikiem kanonizacji `k` i translacji; dostarczona faza
   jest tylko wartością do cross-checku.
6. Zmapować `FrequencyDomainExcitationKind` oraz `FrequencyDriveKind` w jedną
   semantykę fizyczną. `field A/m`, `tangent RHS`, torque i external provider
   muszą pozostać rozróżnione.
7. Wynik kanonizacji ma być immutable i zawierać digest. Backend nie powinien
   ponownie interpretować flag wejściowych.
8. Wprowadzić nową wersję C ABI; stary request tłumaczyć przez adapter, a nie
   rozszerzać kolejnymi flagami ogona.

#### Testy

- każda para jednocześnie aktywnych wariantów jest odrzucana;
- sprzeczne phase/k/drive są odrzucane przed callbackiem;
- zgodne legacy duplikaty dają jeden canonical request;
- wszystkie legalne warianty przechodzą round-trip Python/ProblemIR/native;
- artifact zapisuje requested source i resolved source bez utraty intentu.

### DS-05. Walidacja inwariantów certyfikatu bazy modalnej

**Status:** potwierdzone — dormant, P0 przed promocją `modal_reduced`.

#### Dowód

`modal_basis_completeness_allows_response()` sprawdza relacje tylko w jedną
stronę i nie wymaga nieujemnego residualu. Reproducer potwierdza akceptację
ujemnych countów i residualu. Helper ma obecnie tylko callerów testowych.

#### Instrukcja implementacji

1. Oddzielić `validate_modal_basis_certificate()` od decyzji o użyciu w
   odpowiedzi.
2. Odrzucić nieznane wartości enumów, nie tylko `method==none`.
3. Wymagać nieujemności wszystkich countów i zmierzonych residuali.
4. Zdefiniować semantykę countu: dodatnie gałęzie, pary sprzężone,
   degeneracje/klastry i zero modes.
5. Dla nietruncatedowanego wyniku wymagać co najmniej:

   ```text
   returned_modes == accepted_modes_before_cap
   accepted_modes_before_cap == certified_modes_in_window
   actual_mode_array_length == returned_modes
   result_truncated == false
   0 <= every measured residual <= allowed residual
   ```

6. `estimated_modes_in_window` traktować jako estymatę, nie granicę dowodu. Jeśli
   ma być countem certyfikowanym, zmienić nazwę i zapisać metodę dowodu.
7. Certyfikat ma być generowany przez eigensolver, nie przyjmowany jako zaufane
   pola callera.
8. Rozróżnić przyczyny: invalid, truncated, provenance mismatch, left/right
   residual failed, response residual failed.

#### Testy

- wszystkie ujemne count/residual, NaN i infinity są odrzucane;
- `returned > accepted`, `returned < accepted` bez truncation i zły array
  length są odrzucane;
- unknown enum jest odrzucany;
- fuzzing struktury nie może zwrócić `allowed=true` bez wszystkich inwariantów.

### DS-06. Kanoniczny, odporny na kolizje klucz cache

**Status:** potwierdzone — dormant, P0 przed cache modalnym.

#### Instrukcja implementacji

1. Zdefiniować schemat `modal_basis_cache_key.v2` jako kanoniczny payload
   binarny `tag + length + bytes`.
2. Nie sklejać nieescapowanych stringów. Stały separator nie rozwiązuje
   problemu bez length-prefix.
3. `double` kodować jako znormalizowane bity IEEE-754 w ustalonej kolejności
   bajtów; `-0.0` normalizować do `+0.0`; NaN/inf odrzucać.
4. Payload musi obejmować wszystko, co zmienia pencil lub interpretację bazy:
   mesh topology/DOF ordering, equilibrium, materiały, interakcje, boundary,
   Floquet transport, demag, phase, gamma0, damping, tangent gauge,
   częstotliwości, normalizację i wersję assemblera.
5. Policzyć SHA-256 istniejącą wspólną implementacją repozytorium. Nie dodawać
   trzeciej niezależnej biblioteki haszującej.
6. Obok digestu przechowywać canonical metadata i przy cache hit ponownie
   sprawdzać schema/operator digest/certificate tolerance.
7. Tą samą poprawką zastąpić pozorny
   `LinearizationStateNative::linearization_signature_hash`, który jest dziś
   delimiter-concatenated stringiem, nie hashem.

#### Testy

- dostarczone dwa zestawy kolizyjne dają różne digesty;
- długie arbitralne stringi działają bez stałego bufora 512;
- locale nie zmienia digestu;
- `+0.0` i `-0.0` dają ten sam digest;
- zmiana pojedynczego bitu parametru pencil zmienia digest;
- golden payload daje identyczny digest na wspieranych kompilatorach.

### DS-07. Oddzielić kompletność spektrum od poprawności modalnej odpowiedzi

**Status:** potwierdzone — dormant, P0 przed `modal_reduced`.

#### Instrukcja implementacji

1. Utworzyć dwa niezależne artefakty:
   `SpectrumCountCertificate` i `ModalResponseEligibilityCertificate`.
2. Nigdy nie pozwalać, aby sam count w oknie aktywował response lane.
3. Dla każdego punktu sweepu policzyć z oryginalnym canonical pencil:

   ```text
   r(omega) = b - A(omega) x_modal(omega)
   relative_residual = norm(r) / max(norm(b), rhs_floor)
   backward_error = norm(r) /
       (operator_norm_estimate * norm(x) + norm(b) + scale_floor)
   ```

4. Nie obliczać decydującego residualu z macierzy odtworzonej z tych samych
   modów. Obecny validation helper robi właśnie taki self-referential check.
5. Gdy residual przekracza tolerancję, wykonać adaptive enrichment/guard modes
   albo rational Krylov correction.
6. Jeśli enrichment nie pomaga, jawnie przełączyć punkt na full direct/FGMRES;
   provenance ma zapisać fallback per point.
7. Szczególnie kontrolować brzegi okna, bliskie bieguny, silnie nienormalne
   przypadki i punkty o dużej kondycji.
8. `sparse_direct_sample` traktować jako response validation evidence, nie jako
   dowód count completeness.

#### Testy

- certyfikowany count w oknie, ale silnie wzbudzony mod poza oknem powoduje
  enrichment albo fallback;
- modal result zgadza się z niezależnym direct solve w amplitudzie i fazie;
- każdy zaakceptowany punkt spełnia true residual i backward error;
- sztucznie usunięty near-window pole jest wykrywany.

### DS-08. Diagonalna ekspansja eigenmodalna: lewe/prawe mody i kondycja

**Status:** potwierdzone — dormant, P0 przed tłumioną/nonnormalną diagonalną
ekspansją eigenmodalną.

Ten wymóg nie obejmuje automatycznie całej rodziny `modal_reduced`. Rational
Krylov, projection-based reduced basis albo Petrov-Galerkin mogą działać bez
jawnych lewych wektorów własnych, ale muszą mieć własną trial/test basis,
zredukowany operator i kontrolę original-operator residual z DS-07.

#### Instrukcja implementacji

1. Dla Poisson descriptor najpierw wykonać finite Schur reduction z DS-10.
   Poniższej normalizacji nie stosować bezpośrednio do pełnego singularnego
   `B` z zerowym blokiem algebraicznym.
2. Rozszerzyć artifact modów o zespolone prawe `V` i lewe `W` wektory.
3. Dla finite pencilu:

   ```text
   L v_j = lambda_j B v_j
   w_j^H L = lambda_j w_j^H B
   W^H B V = I
   ```

4. Odpowiedź liczyć jako biortogonalną ekspansję, nie projekcję prawymi modami
   w iloczynie euklidesowym.
5. Dla matrix-free operatora zaimplementować `MATOP_MULT_TRANSPOSE` lub adjoint
   odpowiadający rzeczywistej reprezentacji pencilu.
6. W SLEPc wybrać solver wspierający two-sided, włączyć
   `EPSSetTwoSided()` i pobrać `EPSGetLeftEigenvector()`.
7. Zapisywać prawy residual, lewy residual, normę `W^H B V-I`, najmniejsze
   singular values overlap matrix i condition estimate.
8. Degeneracje/klastry traktować jako niezmiennicze podprzestrzenie, nie
   arbitralnie parowane pojedyncze wektory.
9. Dla defective lub źle uwarunkowanej bazy zablokować ten engine i użyć
   rational Krylov/full solve.
10. Ewentualny skrót dla `alpha=0` musi wynikać z jawnie udowodnionej struktury
   gyrotropic/Hamiltonian; nie wolno zakładać `W=V`.

#### Alternatywny reduced-basis/rational Krylov engine

Jeżeli planner wybiera nie diagonalną ekspansję eigenmodalną, lecz ogólny ROM,
artifact musi przechowywać trial basis `V`, test basis `W` albo jawny Galerkin
contract, zredukowane `L_r`, `B_r`, residual estimator i warunki enrichment.
Akceptację nadal wyznacza residual/backward error oryginalnego pencilu, nie
sama jakość rozwiązania zredukowanego.

#### Testy

- nienormalny pencil 2x2/4x4, gdzie projekcja prawymi modami jest błędna, a
  biortogonalna zgadza się z direct solve;
- damped macrospin odtwarza peak, linewidth i phase;
- obrót bazy wewnątrz klastra nie zmienia odpowiedzi;
- near-defective problem deterministycznie wyłącza modal lane.

Źródła implementacyjne: oficjalne
[SLEPc EPSSetTwoSided](https://slepc.upv.es/release/manualpages/EPS/EPSSetTwoSided.html)
i
[EPSGetLeftEigenvector](https://slepc.upv.es/release/manualpages/EPS/EPSGetLeftEigenvector.html).

### DS-09. Certyfikat kompletności musi zawierać dowód i provenance

**Status:** potwierdzone — dormant, P0.

#### Instrukcja implementacji

1. Jedna typed struktura ma być źródłem walidacji i JSON, bez ręcznie
   rozbieżnych pól.
2. Związać certyfikat z: schema, operator/equilibrium digest, wymiarem, oknem,
   backendem, precision, run ID, build ID i tolerancją.
3. Dla contour count zapisać kontur w płaszczyźnie zespolonej, rzędy
   kwadratury, historię refinement, residuale shifted solves, rank/singular
   values projektora i margines modów od granicy konturu.
4. Dla sparse-direct evidence zapisać dokładny problem i sampling, lecz nie
   nazywać tego automatycznie certyfikatem countu.
5. Odrzucić reuse certyfikatu dla innego pencilu, okna, urządzenia lub
   łagodniejszej tolerancji.
6. Podpis kryptograficzny nie jest potrzebny do lokalnej integralności, ale
   cryptographic digest payloadu jest potrzebny do jednoznacznego wiązania.

#### Testy

- podmiana operator digest, window lub tolerance unieważnia certyfikat;
- niestabilny contour count między refinementami nie daje `certified`;
- mod leżący w marginesie granicy wymusza rozszerzenie konturu/ambiguous;
- JSON round-trip nie traci żadnego pola dowodowego.

### DS-10. Descriptor pencil Poisson-airbox: eliminacja części algebraicznej i gauge

**Status:** potwierdzone — validation-only, P0 przed promocją produkcyjnego
modal Poisson. Realne warianty są obecnie fail-closed, więc nie jest to dowód
korupcji działającego produkcyjnego lane'u.

#### Stan bieżący

Pencil ma blok dynamiczny `q` i algebraiczny `phi`, a prawa strona ma zerowy
blok dla `phi`. Bieżący solver filtruje skończone liczby i dodatnią część
urojoną, ale nie implementuje pełnej klasyfikacji finite/infinite/gauge modes.
Walidacja boundary/gauge została ostatnio utwardzona: synthetic pure-Neumann
mean-zero jest akceptowany, a niezaimplementowane Robin/Dirichlet są odrzucane.
To naprawia fail-closed, nie tworzy jeszcze produkcyjnego solvera descriptor.

#### Zalecane rozwiązanie podstawowe: Schur elimination

1. Złożyć kanoniczne bloki słabej formy na wspólnej domenie magnet + airbox.
2. Zdefiniować Poisson block `P=A_phiphi` z polityką zależną od BC:
   - Robin `beta>0`: bez gauge;
   - Dirichlet: eliminacja essential DOF, bez gauge;
   - pure Neumann/k=0 periodic: mean-zero lub prawdziwy nullspace po kontroli
     kompatybilności RHS.
3. Udostępnić stabilną akcję `P^{-1}` albo rozwiązanie układu augmented dla
   mean-zero.
4. Zredukować algebraiczne `phi`:

   ```text
   phi(q) = -P^{-1} A_phiq q
   L_eff q = A_qq q + A_qphi phi(q)
   L_eff q = lambda B_qq q.
   ```

5. Eigensolver rozwiązuje wyłącznie finite dynamic pencil na `q`; infinite
   algebraic modes nie pojawiają się w przestrzeni Krylova.
6. Po znalezieniu `q` rekonstruować `phi` i liczyć oddzielnie residuale:

   ```text
   r_q   = A_qq q + A_qphi phi - lambda B_qq q
   r_phi = A_phiq q + A_phiphi phi
   r_g   = mean_weights^T phi          tylko gdy gauge jest wymagany.
   ```

7. Certyfikat ma wymagać przejścia każdego bloku; żadnego `min(residual_slepc,
   residual_reconstructed)`.
8. Zapisać conditioning/failure Poisson solve, liczbę iteracji, nullspace i BC
   provenance.

#### Alternatywa

Pełny descriptor eigensolver jest dopuszczalny tylko, jeśli jawnie obsługuje
singularne `B`, deflację części algebraicznej, finite eigenvalue extraction i
gauge. To jest bardziej złożone niż Schur i nie powinno być wybierane bez
udokumentowanej korzyści.

#### Testy

- full dense descriptor kontra Schur dla małej macierzy;
- mean-zero kontra pinned gauge dają te same `q`, częstotliwość i pole
  fizyczne;
- Robin/Dirichlet nie dostają sztucznego gauge;
- wstrzyknięty algebraic/infinite mode nie jest raportowany jako fizyczny;
- oba residuale blokowe i gauge residual spełniają tolerancję.

### DS-11. Naprawić targetowanie `lambda=i*omega` w SLEPc

**Status:** potwierdzone — aktywne, P0.

#### Dowód

`slepc_modal_eigen.cpp`, `poisson_airbox_modal_eigen.cpp` oraz
`poisson_airbox_schur_matshell.cpp` ustawiają dodatni `target_omega` jako realny
`PetscScalar`, a następnie wybierają mody na podstawie części urojonej. W obrazie
używany jest real-scalar SLEPc. Realny shift szuka sąsiedztwa osi rzeczywistej,
nie punktu `i*omega`.

Oficjalna dokumentacja SLEPc stwierdza, że kompleksowego targetu nie można
podać w real-scalar build:
[EPSSetTarget](https://slepc.upv.es/release/manualpages/EPS/EPSSetTarget.html).
Shift-invert działa jako `(A-sigma B)^-1 B`:
[STSINVERT](https://slepc.upv.es/release/manualpages/ST/STSINVERT.html).

#### Instrukcja implementacji

Wybrać i udokumentować jedną z dwóch poprawnych dróg:

1. **Preferowana dla modalnego lane'u:** osobny complex-scalar PETSc/SLEPc
   runtime i target `sigma = i*omega_target` dla `exp(+i omega t)`.
2. **Alternatywa real-scalar:** jawna real-block reprezentacja kompleksowego
   shiftu oraz `STShell`, której akcja jest matematycznie równoważna
   `(L-i*omega_target B)^-1 B`. Nie wystarczy zmiana sorting enumu.

Następnie:

3. Centralny mapper fazora ma wyznaczać znak urojonego shiftu.
4. Artifact ma zapisać `sigma_real`, `sigma_imag`, scalar build kind i
   spectral transform kind.
5. Usunąć nazwę `target_angular_frequency` z argumentu, jeśli typ pozostaje
   realny i może być błędnie interpretowany; użyć typed complex shift.
6. Dodać runtime assertion, że target reprezentuje właściwą oś dla wybranego
   pencilu.

#### Testy

- macierz z modami przy `+/- i*omega1`, `+/- i*omega2`: target przy `omega2`
  wybiera drugi mod, nie mod najbliższy realnemu `omega2`;
- oba fazory wybierają właściwą gałąź;
- wynik complex build i real-block STShell jest zgodny dla małego oracle;
- test musi failować z obecną realną wartością `EPSSetTarget(target_omega)`.

### DS-12. Zastąpić synthetic Poisson-airbox realnym assemblerem FEM

**Status:** potwierdzone — validation-only, P0 przed promocją. Rozszerza
ustalenia dokumentu 19; synthetic oracle działa, realne assembly jest
fail-closed.

#### Stan bieżący

Bieżący adapter `poisson_airbox_modal_eigen.cpp` akceptuje wyłącznie
`synthetic_algebraic_oracle`. Realne Robin/Dirichlet assembly nie jest
zaimplementowane. Obecność `.cpp` i SLEPc nie oznacza jeszcze weak-form FEM.

#### Instrukcja implementacji

1. Wejściem assemblera musi być wspólna siatka FEM `D=Omega_m union Omega_air`,
   nie tylko chmury węzłów ani deklarowany `M_eff`.
2. Złożyć `A_phiphi` z:

   ```text
   integral_D grad(psi) dot grad(phi) dV
   + beta integral_Gamma_open psi phi dS     dla Robin.
   ```

3. Złożyć sprzężenie magnetostatyczne z
   `integral_Omega_m Ms*delta_m dot grad(psi) dV`, zachowując znak
   `H_demag=-grad(phi)`.
4. Restrykcje PBC/Floquet stosować na pełnej przestrzeni FE oraz DOF, nie tylko
   na współrzędnych par węzłów.
5. Dla k=0 wdrożyć politykę gauge z DS-10. Dla non-k0 użyć zespolonego
   `grad_k/div_k`; nie zastępować go statycznym Poissonem k=0.
6. Nie wstrzykiwać oczekiwanej częstotliwości Kittela do macierzy. Kittel ma
   być niezależnym oracle po rozwiązaniu.
7. Zapisać mesh/material/boundary/assembly digests i rzeczywiste parametry
   airboxa w artifactach.
8. Dopiero po przejściu convergence studies zmienić lane z
   `validation_synthetic_payload` na produkcyjny.

#### Testy

- manufactured Poisson solution i niezależna kontrola znaku;
- zbieżność po zagęszczeniu magnet/airbox oraz zwiększaniu airbox extent;
- Kittel ideal-film bez wstrzykiwania `M_eff` do operatora;
- zgodność full i Schur solve;
- reciprocity/symmetry właściwa dla wybranej reprezentacji;
- PBC k=0 i Floquet `k<->-k` na kompatybilnej siatce.

### DS-13. Checked arithmetic dla wszystkich extentów i bajtów

**Status:** potwierdzone, P0 bezpieczeństwa pamięci.

#### Instrukcja implementacji

1. Utworzyć jedną bibliotekę pomocniczą:

   ```cpp
   bool checked_add_u64(uint64_t a, uint64_t b, uint64_t &out);
   bool checked_mul_u64(uint64_t a, uint64_t b, uint64_t &out);
   bool checked_to_size_t(uint64_t value, size_t &out);
   bool checked_bytes(uint64_t count, size_t element_size, size_t &out);
   ```

2. Zabronić bezpośrednich obliczeń extentów w validatorach i allocatorach.
3. Objąć co najmniej:
   - `n*vector_count`, `n*(restart+1)`, `n*restart`;
   - `(restart+1)*restart`, `restart+1`;
   - `node_count*2`, `node_count*3`, `n*n`;
   - `frequency_count*tangent_dof_count`;
   - `row_count+1`, liczby bloków i `sizeof(T)*count`;
   - CUDA grid/block count przed konwersją do `int`.
4. Zanim nastąpi pointer arithmetic, sprawdzić również offset + extent.
5. Ustalić rozsądne limity runtime dla restartu, countu modów i wymiaru dense;
   samo uniknięcie overflow nie chroni przed alokacją petabajtów.
6. Naprawić także `tangent_workspace_shape(node_count*2/*3)` i aktywne
   alokacje hostowego GMRES `V/Z/H`, nie tylko reproducer w nagłówku GPU.

#### Testy

- boundary table: `0`, `1`, `UINT64_MAX/3`, `UINT64_MAX/2`, `UINT64_MAX`;
- każdy zawinięty iloczyn/suma zwraca validation error przed dereference;
- property/fuzz tests dla wszystkich publicznych wymiarów;
- ASan/UBSan dla CPU oraz Compute Sanitizer dla CUDA.

### DS-14. Rozdzielić static config, solve result i qualification certificate GPU

**Status:** potwierdzone — dormant, P0 przed device FGMRES.

#### Instrukcja implementacji

1. Zastąpić bieżący `FGMRESDeviceEngineConfig` trzema typami:

   ```text
   FGMRESDeviceStaticConfig
     device, stream, callbacks, tolerances, restart, allocation policy

   FGMRESDeviceSolveRequest
     frequency point, rhs, initial guess, operator/preconditioner digests

   FGMRESDeviceRunResult
     status, stop reason, iterations, residual history, transfers, timings
   ```

2. Static validator nie może wymagać `iteration_count`, `r64`, `r256`,
   `apply_count` ani końcowych residuali.
3. Run result może utworzyć tylko engine; caller nie może dostarczać pól
   świadczących o własnej poprawności.
4. Qualification certificate tworzy osobny kwalifikator po zakończonym runie.
5. Certyfikat wiąże schema/build, operator/preconditioner digest, `n`, precision,
   GPU UUID/compute capability, phase, omega/sweep digest, restart/tolerances,
   run ID i CPU-reference fixture.
6. API dzielić na:

   ```text
   validate_static_config()
   run_device_fgmres()
   certify_completed_run()
   ```

7. Capability może ustawić tylko zaufana fabryka runtime; nigdy caller-supplied
   diagnostics.

#### Testy

- świeża, poprawna konfiguracja przechodzi bez historii runu;
- sfabrykowane `iterations_256` nie może wpłynąć na static validation;
- certyfikat innego operatora/device/omega jest odrzucany;
- run result jest immutable dla callera.

### DS-15. Kryterium residualu, early convergence, happy breakdown i zero RHS

**Status:** potwierdzone; dormant dla reguły 64/256, aktywne dla zero RHS.

#### Instrukcja implementacji

1. Próbki residualu zapisywać jako sekwencję
   `(iteration, tracked, recomputed_true, converged, stop_reason)`.
2. Early convergence przed 64/256 jest sukcesem, jeśli recomputed true residual
   spełnia tolerancję.
3. `r64=r256=0` jest sukcesem, a brak ścisłej monotoniczności nie może
   unieważnić poprawnego końcowego rozwiązania.
4. Trend 64/256 pozostawić jako test kwalifikacyjny dla wybranych fixture'ów,
   nie warunek każdego solve.
5. Oddzielić wartości obserwowane od progów:

   ```text
   observed_tracked_recomputed_mismatch
   allowed_tracked_recomputed_mismatch
   observed_device_to_cpu_residual_ratio
   allowed_device_to_cpu_residual_ratio
   ```

6. Dodać jawny `happy_breakdown_tolerance` oraz rozróżnić happy i unhappy
   breakdown. Hostowy GMRES nie powinien zamieniać dokładnego breakdownu w
   ogólny `singular Krylov basis` bez testu true residual.
7. Zero RHS obsłużyć wspólnie przed wyborem lane'u:

   ```text
   require_nonzero_rhs=false && norm(b)==0
   => x=0, residual=0, iterations=0, stop_reason=zero_rhs, status=ok.
   ```

8. `require_nonzero_rhs=true` zachowuje validation error.
9. Kryterium końcowe opierać na recomputed true residual/backward error, nie
   wyłącznie residualu z Hessenberga.

#### Testy

- identity system: jedna iteracja;
- dokładny happy breakdown;
- zero RHS dla validation, production CPU, production GPU, periodic-airbox i
  Floquet projection;
- stagnation na precision floor nie jest fałszywą porażką po osiągnięciu
  tolerancji;
- tracked/recomputed mismatch przekraczający politykę jest wykrywany.

### DS-16. Bezpieczny probe callbacków GPU

**Status:** potwierdzone — dormant, P0.

#### Instrukcja implementacji

1. Wprowadzić osobne typy `DeviceComplexConstVectorView` i
   `DeviceComplexMutableVectorView`.
2. Probe używa wyłącznie engine-owned `rhs_probe`, `operator_output_probe` i
   `preconditioner_output_probe`; nigdy produkcyjnego `solution`.
3. Odrzucić `NaN`, `+/-inf`, zero i ujemne omega zgodnie z publicznym
   kontraktem dodatnich częstotliwości.
4. Usunąć zdublowane omega. Jeden `FrequencyPointContext` ma zawierać ID,
   omega i phase convention; callback oraz diagnostyka dostają ten sam obiekt.
5. Jawna alias policy musi zabronić:
   - `real==imag`;
   - overlap input/output bez capability in-place;
   - overlap RHS/solution/scratch/V/Z/H;
   - wskaźników z innego device ordinal.
6. Sprawdzić CUDA pointer attributes zamiast ufać enumowi `location=device`.
7. Przed callbackiem wypełnić output sentinel/NaN. Po callbacku:
   - zsynchronizować właściwy stream/event;
   - odebrać async error;
   - potwierdzić zapis całego outputu i finite values;
   - sprawdzić checksum wejścia przed/po;
   - w małym kwalifikatorze porównać operator z CPU oracle.
8. Sprawdzić liniowość `Aomega`; nie wymagać liniowości od elastycznego,
   potencjalnie nieliniowego preconditionera FGMRES.

#### Testy

- `+inf`, NaN, zero, ujemne i niezgodne finite omega są odrzucane;
- probe nie zmienia RHS ani initial guess;
- callback no-op i częściowy zapis nie przechodzą;
- host pointer oznaczony jako device jest odrzucany;
- błąd asynchroniczny kernela jest zwracany po synchronizacji.

### DS-17. Pełny device-resident FGMRES i uczciwy status GPU

**Status:** potwierdzone — dormant, P0 promocji.

#### Korekta audytu

Aktualny `production_gpu` nie jest samym probem. Wywołuje rzeczywisty hostowy
GMRES, który ma `V(m+1)`, `Z(m)`, `H`, podwójny MGS, Givens, restart i
recomputed true residual. Operator CUDA wykonuje jednak H2D, synchronizację i
D2H przy każdym apply. Poprawna nazwa to `gpu_operator_host_krylov`, nie
device-resident FGMRES.

#### Wymagany layout

```text
V: n x (m+1)
Z: n x m
H: (m+1) x m complex
rotations: m
g: m+1
y: m
r, w, Ax: po n
```

Wariant `V=n*m + work_vector` jest dopuszczalny tylko po formalnym opisaniu,
gdzie mieszka `v_(j+1)`, kiedy jest kopiowany i jak capacity chroni zapis.

#### Instrukcja implementacji

1. Zaimplementować device `copy/scal/axpy/dotc/nrm2`.
2. Zaimplementować MGS z reorthogonalizacją albo inną jawnie zwalidowaną
   stabilną ortogonalizację.
3. Dodać zespolone Givens/QR, least-squares update i przechowywanie `Z_j` dla
   zmiennego prawego preconditionera.
4. Dodać restart, early convergence, happy/unhappy breakdown, true residual
   recomputation i residual replacement po restarcie.
5. Dodać cancellation/progress bez wymuszania transferu pełnych wektorów.
6. Hessenberg, rotations i residual state mają pozostać na urządzeniu. Jeśli
   host odczytuje skalary w checkpointach, telemetry ma uczciwie raportować
   bounded D2H; nie deklarować literalnego zera transferów.
7. Workspace wyliczać jedną checked funkcją layoutu; `workspace_vector_count>=4`
   nie jest wystarczające.
8. Ustawić `production_loop_available=true` wyłącznie po rzeczywistym
   podłączeniu engine'u i runtime qualification.
9. Do czasu promocji planner ma odrzucać forced device-FGMRES jako unavailable,
   a aktualne artifacty zachować jako `gpu_operator_host_krylov` i
   `gpu_device_resident_solver=false`.

#### Testy i promocja

- nonsymmetric complex system zgodny z CPU/PETSc FGMRES;
- zmienny/nieliniowy right preconditioner;
- restart `m=1`, mały `m`, wiele restartów;
- divergence/stagnation/NaN z jawnym stop reason;
- Compute Sanitizer bez OOB/race;
- transfer trace zgodny z deklaracją;
- real GPU managed gate, CPU parity i artifact z build/device/operator digests.

Referencja algorytmiczna:
[PETSc KSPFGMRES](https://petsc.org/main/manualpages/KSP/KSPFGMRES/).

### DS-18. Jawny kontrakt ramki stycznej i bezpieczny edge operator

**Status:** częściowo potwierdzone, P1; P0 dla gauge-invariant Floquet.

#### Korekta audytu

Bieżąca implementacja buduje `e1=reference x m`, `e2=m x e1`, więc zachodzi
`e1 x e2=m`. Overload edge operatora przyjmujący ramki oblicza pełne
`E_i^T E_j`, dlatego scalar `stiffness` jest współczynnikiem kartezjańskiego
exchange, a nie błędnym zamiennikiem transportu. Problemem jest drugi overload
bez ramek, który nie dokumentuje wymogu identycznych lokalnych baz.

DMI nie powinno być wciskane w ten typ. Bieżący kod ma dedykowany elementowy
operator DMI; tę separację należy zachować.

#### Instrukcja implementacji

1. W `TangentFrameNode` zapisać inwarianty:
   `|m|=|e1|=|e2|=1`, wzajemną ortogonalność i `e1 x e2=m`.
2. `TangentFrameDiagnostics` rozszerzyć o maksymalny błąd handedness/determinant.
3. W testach generować losowe `m`, a nie tylko osiowe przypadki.
4. Usunąć publiczny overload edge bez ramek albo nazwać go
   `apply_tangent_edge_operator_identical_gauge()` i wymagać jawnego
   certyfikatu `identical_frame_gauge=true`.
5. Produkcyjny exchange ma zawsze używać overloadu z ramkami lub pełnych
   bloków 2x2.
6. DMI i surface/PMA Hessian pozostają osobnymi typed operatorami; enum edge
   ma odrzucać DMI zamiast przyjmować scalar.
7. Dodać checked arithmetic do `tangent_workspace_shape()`.

#### Testy

- `det([e1,e2,m])=+1` dla losowych kierunków;
- niezależne obroty gauge `E_i -> E_i R_i` nie zmieniają lifted Cartesian
  wyniku exchange;
- overload identical-gauge odrzuca różne ramki;
- DMI edge scalar jest compile-time lub runtime rejected.

### DS-19. Floquet: faza i transport ramki jako jeden constraint

**Status:** potwierdzone — aktywne, P0 dla tekstur i non-k0.

#### Stan bieżący

Driven validator sprawdza już `phase_rad=-k dot translation` modulo `2*pi`.
`FrequencyDomainFloquetPeriodicPair` nadal przenosi tylko fazę. Osobny
`MeshSymmetryCertificate` oblicza bloki transportu, ale solve request nie
wiąże ich z constraintem. Zastosowanie scalar phase do surowych `[u,v]` jest
poprawne tylko przy identycznym gauge ramek.

#### Instrukcja implementacji

1. Utworzyć canonical `FloquetTangentConstraint`:

   ```text
   source_dofs, destination_dofs
   translation_m[3]
   k_rad_per_m[3]
   phase = exp(-i k dot T)
   frame_transport_2x2 = E_dst^T E_src
   pair/topology digest
   ```

2. Nie przyjmować `phase_rad` jako niezależnego źródła prawdy. Jeśli legacy
   caller ją podaje, porównać modulo `2*pi` i odrzucić mismatch.
3. Nakładać constraint:

   ```text
   q_dst = phase * (E_dst^T E_src) * q_src.
   ```

4. Scalar `phi` używa tylko phase; magnetization używa phase i transportu.
5. Ten sam constraint ma służyć assembly, matrix-free apply, RHS projection,
   lift outputu i residualowi.
6. Dla wielu translacji sprawdzić cycle consistency oraz kompozycję faz i
   transportów.
7. Modal i driven muszą używać tego samego canonicalizera; usunąć osobne
   walidacje po migracji.
8. Non-k0 demag wymaga `grad_k/div_k` i zespolonej przestrzeni FE; sama
   projekcja po operatorze nie jest równoważna.

#### Testy

- losowe niezależne obroty gauge ramek po obu stronach szwu nie zmieniają
  eigenvalues ani lifted response;
- `k=0` zgadza się ze statycznym PBC;
- `k<->-k` daje właściwe parowanie dla realnych parametrów;
- cycle inconsistency fazy lub transportu jest odrzucana;
- modal i driven mają identyczny constraint digest.

### DS-20. Certyfikat periodycznej siatki musi obejmować topologię FEM

**Status:** potwierdzone — aktywne, P0.

#### Instrukcja implementacji

1. Jeśli obiekt ma nadal nazywać się `MeshSymmetryCertificate`, rozszerzyć
   request o:
   - mapę elementów source/destination;
   - lokalną permutację węzłów i orientację;
   - mapę boundary faces;
   - FE space/order i mapę true DOF;
   - Jacobian/reference-map consistency;
   - region/material attributes;
   - airbox i magnetic constraint maps.
2. Jeśli zakres ma pozostać węzłowy, zmienić nazwę na
   `PeriodicNodePairCertificate` i zabronić używania go jako dowodu pełnego
   FEM PBC.
3. `frame_transport_tolerance` musi dostać jednoznaczną semantykę albo zostać
   usunięta. Dziś mierzy odległość `E_dst^T E_src` od identyczności, ale jest
   tylko walidowana jako liczba. Jeżeli kontrakt wymaga identical gauge, wynik
   ponad tolerancją ma być rejectem. Jeżeli dopuszcza arbitralny gauge, duży
   obrót 2x2 jest legalny i tolerancja powinna mierzyć błąd ortogonalności
   transportu, nie odległość od `I`.
4. Zmienić `max_airbox_phi_pair_mismatch` na
   `max_airbox_translation_residual_m`, bo bieżąca implementacja liczy
   geometrię, nie wartości `phi`.
5. Jeśli potrzebna jest kontrola `phi`, dodać jawne complex phi source/dest i
   porównać je dopiero po solve; nie mieszać z certyfikatem siatki.
6. Haszować topology/DOF/pair maps kanonicznym SHA-256 i wiązać z operatorem.
7. Certyfikat ma mieć jawne `certificate_scope=node_pairs|full_fe_topology`.

#### Testy

- zgodne chmury węzłów z inną triangulacją są odrzucane jako full topology;
- odwrócona orientacja elementu/face jest wykrywana;
- permutacja numeracji zachowująca mapę DOF jest akceptowana;
- identical-gauge policy odrzuca transport daleki od `I`, a arbitrary-gauge
  policy akceptuje poprawny obrót i odrzuca nieortogonalny blok;
- nazwa i jednostka każdego residualu odpowiadają faktycznie liczonym danym.

### DS-21. Utwardzić dense Poisson oracle bez rozszerzania jego claimu

**Status:** potwierdzone — validation-only, P1/P0 dla buffer safety.

#### Instrukcja implementacji

1. `DenseRealMatrixView` rozszerzyć o `value_count` i `leading_dimension`.
2. Sprawdzić checked `rows*leading_dimension`, minimalny capacity i finite
   values przed każdym odczytem.
3. Zastąpić string `gauge_policy` enumem; nieznane wartości odrzucać.
4. Jeśli oracle ma sprawdzać `alpha=0` i `k=0`, dodać rzeczywiste dane
   `alpha`, `has_k`, `k[3]`. Alternatywnie usunąć deklaratywne flagi
   `require_*`, których nie da się zweryfikować.
5. Wynik domyślny ustawić na `unavailable`, a `ok` dopiero po pełnej
   walidacji/certyfikacji.
6. Sprawdzać wynik `snprintf`; przy truncation zwrócić artifact/diagnostic
   error albo użyć owned string wewnętrznie.
7. Zachować jawne `synthetic_no_mesh=true`; oracle nie może ustawiać
   production assembly claim.
8. Dodać osobne pola residuali Schur, q-block, phi-block i gauge.

#### Testy

- za krótki bufor i zły leading dimension są odrzucane;
- false declaration alpha/k nie może przejść bez danych;
- diagnostics truncation jest wykrywana;
- default-constructed result nie sugeruje sukcesu;
- oracle nadal przechodzi swoje małe golden cases.

### DS-22. Bezpieczna ewolucja publicznego C ABI

**Status:** potwierdzone — aktywne, P0.

#### Dlaczego nie da się naprawić samego warunku

W driven request pola `abi_version` i `struct_size` leżą w ogonie. Biblioteka
musi je odczytać, zanim wie, czy starszy caller w ogóle zaalokował ten ogon.
`struct_size=0` nie zapobiega out-of-bounds. Exact `sizeof` odrzuca z kolei
większe przyszłe struktury. Modal C request nie ma `struct_size`.
Obecny `fullmag_fem_frequency_domain_solve_result` również nie ma
`abi_version/struct_size`, więc samo naprawienie requestu powtórzyłoby problem
przy przyszłym rozszerzeniu wyniku.

#### Instrukcja implementacji

1. Nie rozszerzać dalej bieżących struktur w miejscu.
2. Wprowadzić nowy symbol ABI i prefix-first header:

   ```c
   typedef struct {
       uint32_t abi_version;
       uint32_t reserved;
       uint64_t struct_size;
   } fullmag_fem_abi_header;
   ```

3. Wprowadzić również nowy, prefix-first
   `fullmag_fem_frequency_domain_solve_result_v13`; nie rozszerzać starego
   resultu w miejscu.
4. Nowy symbol ma przyjmować oba rozmiary osobno, aby nie musiał odczytać
   nieistniejącego ogona przed sprawdzeniem capacity:

   ```c
   int fullmag_fem_fd_solve_v13(
       const void *request,
       uint64_t request_size,
       fullmag_fem_frequency_domain_solve_result_v13 *out_result,
       uint64_t out_result_size);

   void fullmag_fem_fd_result_release_v13(
       fullmag_fem_frequency_domain_solve_result_v13 *result,
       uint64_t result_size);
   ```

5. Najpierw odczytać wyłącznie prefix requestu mieszczący się w
   `request_size`; przed zapisem sprawdzić minimalny prefix wyniku w
   `out_result_size`.
6. Dla każdego pola requestu użyć warunku
   `offsetof(field)+sizeof(field) <= struct_size`; brakujące pola dostać
   wersjonowany default.
7. Każde pole wyniku zapisywać tylko, gdy
   `offsetof(field)+sizeof(field) <= out_result_size`. Release musi stosować tę
   samą zasadę, żeby nie odczytać wskaźników spoza layoutu callera.
8. Akceptować większe requesty i result capacities oraz ignorować nieznany
   ogon, jeśli version policy to dopuszcza.
9. Ujednolicić `struct_size` do `uint64_t`; w C ABI używać `uint32_t/int32_t`
   zamiast C++ `bool` i enumów o nieokreślonym rozmiarze.
10. Stare symbole zamrozić. Jeśli nie istnieje wiarygodna definicja wszystkich
   historycznych layoutów, jawnie wymagać rekompilacji zamiast udawać bezpieczną
   kompatybilność.
11. Dodać ABI layout manifest/golden tests dla 32/64-bit offsetów i alignment.
12. Result release pozostawić idempotentne; allocator i deallocator muszą
    pozostać po stronie tej samej biblioteki.

#### Testy

- minimalna starsza struktura bez ogona nie powoduje OOB w ASan;
- większa przyszła struktura jest akceptowana;
- każde pole graniczne jest testowane z size kończącym się przed i za polem;
- mniejszy i większy `out_result_size` nie powoduje zapisu/odczytu poza
  capacity, również w `release_v13`;
- modal i driven mają tę samą politykę version/size;
- C compiler, C++ compiler i Rust bindgen zgadzają się co do layoutu.

### DS-23. Granica wyjątków, `noexcept` i ownership

**Status:** potwierdzone — aktywne, P0 niezawodności; część tezy ABI obalona.

#### Korekta audytu

`FrequencyDomainContractResult`, `LinearizationStateNative` i
`MeshSymmetryCertificate` są wewnętrznymi typami C++. Same `std::string` i
`std::vector` nie przechodzą przez publiczny C ABI. C result używa owned
`char *` i idempotentnego release, co jest prawidłowym kierunkiem.

Problem pozostaje: funkcje oznaczone `noexcept` alokują wektory/stringi,
operują na filesystemie i wywołują callbacki bez nadrzędnego `try/catch`.
`std::bad_alloc` może wywołać `std::terminate`.

#### Instrukcja implementacji

1. Wewnętrzne funkcje intensywnie alokujące nie powinny być `noexcept`, chyba
   że łapią wszystkie wyjątki lokalnie.
2. Każdy eksport C/FFI ma mieć jeden outer boundary:

   ```cpp
   try { ... }
   catch (const std::bad_alloc &) { return allocation_error; }
   catch (const std::exception &e) { return internal_error_with_message; }
   catch (...) { return internal_error; }
   ```

3. Żaden wyjątek nie może przekroczyć C ABI.
4. Callbacki C traktować jako non-throwing. Dla callbacków C++ dodać adapter,
   który łapie wyjątek i mapuje go na status.
5. Alokować result strings dopiero po zbudowaniu wewnętrznego wyniku; przy
   częściowej porażce zwolnić już zaalokowane pola.
6. Dodać status `allocation_error` albo stabilne mapowanie na `internal_error`;
   nie mylić z błędem fizyki/solve.
7. Utrzymać jeden model ownership publicznych wyników: library-owned + library
   release. `const char *` w requestach jest borrowed tylko na czas calla.

#### Testy

- fault-injection allocator na każdym etapie zwraca status, nie terminate;
- throwing C++ callback jest bezpiecznie mapowany przez adapter;
- release po partial allocation i wielokrotny release są bezpieczne;
- sanitizer nie wykrywa leak/double-free.

### DS-24. Pełne kontrakty dense i CSR

**Status:** częściowo potwierdzone, P0/P1.

#### Stan bieżący

`CsrMatrixView` ma już długości `row_offsets`, `column_indices` i `values`, a
walidacja sprawdza podstawowe extenty i bounds. Dense modal matrices nadal nie
mają capacity. CSR używa 64-bitowych wymiarów i 32-bitowych indeksów bez jednej
centralnej, publicznej polityki.

#### Instrukcja implementacji

1. Każdy dense view: `rows`, `columns`, `leading_dimension`, `value_count`,
   layout enum i element type.
2. Checked capacity ma poprzedzać finite scan i assembly.
3. CSR schema ma jawnie ustalić:
   - index base 0;
   - `row_offsets_len==rows+1`;
   - monotonic row offsets i `last==nnz`;
   - column bounds;
   - sortedness policy;
   - duplicate policy.
4. Rekomendowana canonicalizacja na granicy: posortować kolumny, zsumować
   duplikaty, opcjonalnie usunąć dokładne zera i zapisać canonical digest.
5. Jeśli indeksy zostają `uint32_t`, jawnie odrzucić dimensions/nnz większe niż
   `UINT32_MAX`; alternatywnie wprowadzić osobny CSR64.
6. PETSc/SLEPc conversion ma sprawdzać zakres `PetscInt` niezależnie od C view.
7. Matrix ownership/lifetime udokumentować: borrowed immutable przez czas calla
   albo copied into solver-owned storage.

#### Testy

- empty rows, unsorted entries, duplicates i oba index bases;
- `row_offsets.back()!=nnz`, za krótki buffer i column out of range;
- granica `UINT32_MAX` i `PetscInt`;
- dense padding/leading dimension;
- canonical equivalent CSR daje ten sam digest i operator action.

### DS-25. Stan linearyzacji bez ukrytych zależności i fałszywych opcji

**Status:** potwierdzone — aktywne, P0 reprodukowalności.

#### Dowód

`build_linearization_state_from_equilibrium()` nie dostaje siatki, materiałów,
assemblera `H_eff` ani wag masowych, ale opcje deklarują recompute i periodic
symmetry. Bieżąca implementacja ignoruje te opcje i ustawia wszystkie
`tangent_lumped_mass=1.0`. Nie zachowuje magnetic/airbox mesh IDs, airbox node
count ani `phi0`. Pole nazwane hash jest zwykłą konkatenacją.

#### Instrukcja implementacji

1. Rozdzielić dwie operacje:
   - `import_and_validate_equilibrium_snapshot()` — sprawdza pola i IDs;
   - `assemble_linearization_state(context, snapshot)` — używa jawnej siatki,
     materiałów, operatorów, mas i periodic certificate.
2. Druga funkcja przyjmuje immutable `LinearizationAssemblyContext`, a nie
   globalny registry ukryty za stringami.
3. `recompute_h_eff0_and_compare=true` ma rzeczywiście ponownie złożyć pełne
   `H_eff0` z tych samych interakcji i porównać per term oraz total.
4. Obliczyć prawdziwy FEM lumped mass z przestrzeni/dyskretyzacji; nie wpisywać
   jedynek poza synthetic fixture.
5. `require_symmetric_periodic_mesh` ma wymagać full topology certificate z
   DS-20; `periodic_seam_tolerance` musi być użyta.
6. Zachować w stanie: magnetic/airbox mesh IDs, node/DOF counts, `phi0` wraz z
   gauge, material/physics/boundary digests, tangent frame convention.
7. Wszystkie extenty sprawdzać przed `resize(node_count*3)`.
8. Zbudować canonical binary payload i SHA-256 zamiast delimiter stringa.
9. Jeśli opcji nie da się jeszcze wykonać, usunąć ją albo fail-closed; nie
   raportować sukcesu z ignorowaną opcją `true`.

#### Testy

- zmiana mesh/material/boundary unieważnia snapshot;
- recomputed `H_eff0` wykrywa celowo zmienioną interakcję;
- real lumped masses są dodatnie i zgodne z całką objętości;
- periodic option bez certyfikatu jest odrzucana;
- Poisson state zachowuje `phi0`, gauge i airbox identity;
- delimiter-injection nie powoduje kolizji signature.

### DS-26. Term-by-term zgodność exchange, PMA/anizotropii, DMI i demag

**Status:** wymagany P0 gate wspólnego pencilu; nie jest osobną reprodukcją
crash, lecz zamyka ryzyko różnych operatorów eigen/driven.

#### Instrukcja implementacji

1. Każda interakcja ma wystawić jeden backend-neutral kontrakt
   linearyzacji/Jacobian-vector product, z którego korzystają eigen i driven.
2. Dla exchange zachować pełny transport ramek `E_i^T E_j` oraz prawidłowe
   natural/periodic boundary terms.
3. Dla uniaxial anisotropy/PMA zapisać jawnie axis, `K_u`, `M_s`, jednostki i
   znak Hessianu wokół `m0`; rozróżnić volume PMA i surface anisotropy.
4. Dla DMI zachować osobny elementowy operator:
   - interfacial i bulk jako różne typed variants;
   - właściwe słabe boundary terms;
   - region-dependent `D` i `M_s`;
   - zgodność orientacji normalnej i PBC/Floquet.
5. Dla demag oddzielić static `H_demag0`, dynamic tangent action i Poisson
   potential provenance. Static field nie może udawać dynamic response.
6. Zbudować term-isolation harness. Dla każdego termu porównać directional
   derivative pełnego FEM effective-field/RHS z linearyzowanym apply. Jest to
   test różniczki operatora FEM, nie osobny backend FDM.
7. Następnie sprawdzić sumę termów i tę samą akcję przez:
   - modal materialization;
   - driven matrix-free CPU;
   - GPU operator callback;
   - true residual.
8. Artifact ma raportować per-term enabled flag, digest, normę akcji i
   parity error; nie tylko ogólne `operator_ok`.

#### Testy

- jednorodny exchange zero mode i niezerowy spin-wave mode;
- PMA easy-axis/easy-plane ze znanym znakiem krzywizny;
- interfacial i bulk DMI z odwróceniem `D -> -D` oraz normalnej;
- DMI/PMA na niejednorodnych materiałach i ramkach;
- static/dynamic demag rozdzielone w fixture;
- eigen/driven/GPU parity per term i dla ich sumy;
- losowy obrót tangent gauge nie zmienia lifted Cartesian action.

### DS-27. GPU-G5a: usunąć mylący claim device-resident modal eigensolvera

**Status:** potwierdzone — aktywny błąd readiness/provenance, P0 przed
jakąkolwiek promocją GPU Poisson modal.

#### Dowód i właściwy zakres

`driven_response_gpu.cu:2169-2183` wykonuje one-shot `cudaMalloc` i H2D trzech
dense macierzy. `:2186-2200` uruchamia dense inverse iteration jako
`<<<1,1>>>`, a `:2217-2225` natychmiast zwalnia stan. Mimo to artifact w
`:2249-2273` publikuje `gpu_device_resident_modal_eigensolver=true`.

To może być legalny tiny validation kernel: obliczenia iteracji faktycznie
zachodzą na urządzeniu i nie ma transferu per iteration. Nie jest to jednak
persistent, skalowalny ani produkcyjny eigensolver Poisson-airbox. Wąski
`gpu_dense_k0_macrospin_modal_eigen` oparty o cuSolverDN jest osobnym
zwalidowanym wyjątkiem i nie promuje G5a ani szerszego GPU modal.

#### Natychmiastowa naprawa statusu

1. Zastąpić jeden boolean rozdzielonymi faktami:

   ```text
   operator_storage=device
   eigensolver_iteration_location=device
   persistent_solver_context=false
   scalable_sparse_or_matrix_free=false
   validation_only=true
   production_modal_claim=false
   ```

2. Zmienić lane/adapter na nazwę zawierającą `dense_validation_contract`.
3. Wprowadzić jawny mały limit `augmented_dof_count` i checked dense extents;
   większy problem ma zwrócić `unavailable`, nie próbować alokacji `n^2`.
4. Artifact ma raportować setup H2D/D2H, one-shot allocations, grid size
   `1x1`, supported mode count i brak persistent context.
5. Verifier ma odrzucać `production_modal_claim=true` dla tego adaptera.

#### Droga do rzeczywistego GPU modal eigensolvera

1. Wybrać jawny algorytm i zakres:
   - cuSolverDN tylko dla ściśle ograniczonych dense oracle;
   - GPU sparse/matrix-free Arnoldi/Krylov-Schur/contour dla dużego FEM.
2. Użyć persistent solver context/workspaces, bez alokacji i kopiowania pełnych
   macierzy na każde wywołanie.
3. Podłączyć canonical `L/B`, poprawny complex shift, descriptor Schur i full
   residual z DS-01/10/11.
4. Obsłużyć wiele modów, restart/locking, degeneracje, convergence reasons i
   cancellation.
5. Dla diagonalnej odpowiedzi eigenmodalnej dodać dual/left basis z DS-08;
   nie jest to wymagane dla samego eigenvalue oracle ani innego ROM.
6. Capability promować osobno dla: dense tiny validation, narrow K0
   macrospin, Poisson-airbox k=0 i non-k0 Floquet. Jeden wyjątek nie promuje
   pozostałych.

#### Testy

- schema test odrzuca dawną kombinację `validation_only=true` i
  `production/device-resident claim=true`;
- oversized dense problem failuje przed alokacją;
- setup/per-iteration transfer counters zgadzają się z trace;
- persistent context test nie obserwuje `cudaMalloc/cudaFree` w iteracyjnym
  wywołaniu;
- multi-mode GPU result ma CPU parity i full residual;
- capability matrix zachowuje wąski cuSolverDN K0 wyjątek bez rozszerzania go
  na Poisson/Floquet.

## 8. Tezy już naprawione albo wymagające korekty w stosunku do audytu

Poniższych punktów nie należy ponownie implementować tak, jakby kod ich w
ogóle nie miał. Trzeba zachować istniejące zabezpieczenia podczas dalszych
zmian.

### 8.1. Implementacje solverów istnieją

Repozytorium zawiera m.in. hostowy restarted GMRES, SLEPc modal eigen, Poisson
Schur/full residual helpers i operator CUDA. Ograniczenie „brak `.cpp/.cu`”
było poprawne dla dostarczonego audytorowi pakietu, nie dla tego checkoutu.

### 8.2. Rekonstrukcja residualu Poisson została poprawiona

Obecny kod liczy residuale blokowe i nie wybiera już korzystniejszego minimum
między residualem SLEPc a rekonstrukcją. DS-10 wymaga zachowania tej własności.

### 8.3. Boundary/gauge działa fail-closed

Niezaimplementowane kombinacje Robin/Dirichlet są obecnie odrzucane, a
synthetic pure-Neumann wymaga mean-zero. Nadal brakuje realnego assemblera i
produkcyjnych wariantów BC, ale nie wolno cofnąć fail-closed.

### 8.4. CSR ma już jawne długości

`row_offsets_len`, `column_indices_len` i `values_len` istnieją. DS-24 rozszerza
politykę o canonical CSR i dense capacities; nie zaleca ponownego dodawania
tych samych pól.

### 8.5. Driven phase mismatch jest sprawdzany

Validator wymaga zgodności outer i inner phase convention. Nadal należy
usunąć dublowanie przez kanonizację DS-04.

### 8.6. Driven Floquet sprawdza `phase=-k dot translation`

Ta kontrola istnieje modulo `2*pi`. Brakuje transportu ramek i wspólnej
kanonizacji z modal path, co rozwiązuje DS-19.

### 8.7. Exchange overload z ramkami transportuje współrzędne

Nie należy zastępować go stałym blokiem 2x2. Należy usunąć/ograniczyć overload
bez ramek i utrzymać dedykowany operator DMI.

### 8.8. Publiczny wynik ma sensowny model ownership

Owned `char *` i idempotentny release są poprawnym modelem C ABI. Problemem są
version/size i exception boundaries, nie sama obecność wewnętrznych typów STL.

### 8.9. Produkcyjny GPU driven wykonuje realny solver

Hostowy GMRES ma pełne `V/Z/H`, Givens, restart i recomputed residual. CUDA jest
obecnie operatorem z transferem na każde apply. Nie wolno nazywać tego
device-resident, ale nie wolno też opisywać jako samego probu.

## 9. Plan wdrożenia z checkpointami review

### Workstream 1 — kanoniczna semantyka

Zakres: DS-01 do DS-04.

Checkpoint:

- physics note i typed pencil zatwierdzone;
- brak zmiany wyniku istniejących legalnych CPU fixture'ów;
- eigen, driven i residual używają jednego digestu;
- request conflicts fail przed wyborem backendu.

### Workstream 2 — bezpieczeństwo granic

Zakres: DS-13, DS-21 do DS-24.

Checkpoint:

- ASan/UBSan i ABI size matrix przechodzą;
- żaden unchecked extent na publicznej granicy;
- nowy versioned symbol ABI, stary layout zamrożony;
- exception injection nie kończy procesu.

### Workstream 3 — linearyzacja i interakcje

Zakres: DS-18, DS-25, DS-26.

Checkpoint:

- real mass weights i canonical snapshot digest;
- recomputed `H_eff0` oraz term-by-term derivative parity;
- exchange, PMA, DMI i demag mają wspólne semantics eigen/driven.

### Workstream 4 — eigensolver i modal response

Zakres: DS-05 do DS-12 oraz DS-27 dla osobnego GPU modal readiness.

Checkpoint:

- poprawny complex shift;
- dla diagonalnej ekspansji: left/right/biorthogonality artifact; dla innego
  ROM: jawna trial/test basis i reduced-operator contract;
- count certificate nie odblokowuje response;
- każdy modal point ma original-operator residual i fallback;
- production Poisson claim nadal false, dopóki real FEM convergence nie
  przejdzie.
- G5a raportuje validation-only zamiast ogólnego device-resident claimu.

### Workstream 5 — Floquet i periodyczny Poisson

Zakres: DS-19, DS-20 oraz część DS-10/DS-12.

Checkpoint:

- full FE topology certificate;
- phase + frame transport używane przez wszystkie operacje;
- k=0 parity i `k<->-k` reciprocity;
- pełne residuale q/phi/gauge.

### Workstream 6 — device FGMRES

Zakres: DS-14 do DS-17.

Checkpoint:

- static/run/certificate split;
- bezpieczny probe;
- pełna pętla i workspace device;
- CPU parity, Compute Sanitizer i transfer trace;
- niezależny review przed zmianą capability.

Każdy workstream powinien być osobnym, reviewowalnym zestawem zmian. Nie należy
łączyć przebudowy C ABI, nowego eigensolvera, Floqueta i device FGMRES w jeden
diff.

## 10. Minimalny zestaw testów akceptacyjnych po naprawach

| Test | Lane'y | Warunek akceptacji |
|---|---|---|
| canonical pencil composition | CPU/GPU operator | fused `Aomega` zgodne z `sign*i*omega*B-L` |
| macrospin `alpha=0` | eigen + driven | para `+/-i*omega0`, właściwe `mu0` i `2*pi` |
| macrospin `alpha>0` | eigen + driven | stabilny znak zaniku, peak/linewidth/phase zgodne |
| phase convention duality | wszystkie | wyniki obu fazorów powiązane przez właściwe sprzężenie |
| exchange-only | CPU/GPU | poprawny zero mode i znana dyspersja małego fixture FEM |
| PMA/anizotropia | CPU/GPU | właściwy znak easy-axis/easy-plane i częstotliwość macrospin |
| DMI interfacial/bulk | CPU/GPU | poprawna zmiana znaku i term-by-term derivative parity |
| tangent gauge invariance | eigen + driven | losowe obroty lokalnych ramek nie zmieniają lifted wyniku |
| direct kontra diagonal eigenmodal | CPU | biortogonalny modal odtwarza direct solve i true residual |
| direct kontra rational/Petrov ROM | CPU | reduced operator z dual basis odtwarza direct solve i true residual |
| out-of-window contribution | modal-reduced | enrichment/fallback zamiast fałszywego certificate pass |
| Poisson full kontra Schur | CPU | identyczne `q`, oba residuale blokowe poniżej tolerancji |
| gauge mean-zero kontra pin | CPU | te same wielkości fizyczne i finite eigenfrequencies |
| real FEM airbox convergence | CPU | zbieżność po mesh/airbox refinement bez wstrzyknięcia oracle |
| FGMRES one-step | CPU/device GPU | identity zbiega w jednej iteracji |
| happy breakdown | CPU/device GPU | sukces z true residual, nie singular-basis error |
| zero RHS | wszystkie driven | zero response, zero iteracji albo jawny reject tylko gdy wymagany |
| overflow/fuzz | ABI/CPU/GPU | każdy zawinięty extent odrzucony przed odczytem/alokacją |
| ABI prefix sizes | C/Rust | mniejsze i większe legalne struktury bez OOB |
| Floquet `k=0` | modal + driven | zgodność ze statycznym PBC |
| Floquet `k<->-k` | modal + driven | właściwe parowanie dla realnego problemu |
| GPU transfer trace | device FGMRES | telemetry zgodna z rzeczywistymi checkpoint transfers |
| GPU modal readiness | GPU eigen | tiny/dense, narrow K0 i produkcyjne sparse/matrix-free claims są rozdzielone |

## 11. Wymagane bramki repozytoryjne

Najpierw musi wrócić do zieleni istniejąca managed bramka:

```text
just verify-fem-frequency-domain-native-contract
```

Następnie należy dodać osobne recipes zamiast rozszerzać jeden test
kontraktowy do roli dowodu wszystkiego:

```text
just verify-fem-frequency-domain-modal-reduced-runtime
just verify-fem-frequency-domain-poisson-airbox-production
just verify-fem-frequency-domain-floquet-runtime
just verify-fem-frequency-domain-device-fgmres
just verify-fem-frequency-domain-gpu-modal-production
just verify-fem-frequency-domain-abi-sanitizers
```

Są to nazwy proponowane, nie istniejące obecnie dowody. Każdy recipe musi:

1. używać managed/container runtime;
2. zapisać bounded artifact z revision/build/backend/device/operator digests;
3. wykonać niezależne porównanie, nie tylko sprawdzić `status=ok`;
4. odrzucić stale artifact;
5. nie promować capability na podstawie host-only smoke testu.

## 12. Kryteria promocji poszczególnych lane'ów

### `modal_reduced`

Może stać się dostępny dopiero, gdy istnieją: provenance-bound basis/ROM
certificate, jawna trial/test projection, per-frequency original-operator
residual, adaptive enrichment i full-solver fallback. Jeśli engine używa
diagonalnej ekspansji eigenmodalnej dla nonnormalnego pencilu, dodatkowo wymaga
lewych/prawych modów i biortogonalności. Rational Krylov/Petrov-Galerkin może
spełnić kontrakt przez własną dual basis i zredukowany operator.

### `poisson_airbox_modal_cpu`

Może stać się produkcyjny dopiero po real weak-form FEM assembly, poprawnym
complex shift, finite descriptor handling, full residual reconstruction i
mesh/airbox convergence.

### `gpu_operator_host_krylov`

Może pozostać legalnym osobnym lane'em, jeśli artifact uczciwie raportuje host
Krylov i transfery. Nie wolno aliasować go do device-resident solvera.

### `gpu_device_krylov`

Pozostaje unavailable, dopóki pełna pętla, algebra device, bezpieczny probe,
qualification certificate, Compute Sanitizer i GPU runtime parity nie przejdą.

### `gpu_modal_eigen`

G5a pozostaje dense validation-only i nie może publikować ogólnego
`gpu_device_resident_modal_eigensolver=true`. Wąski cuSolverDN K0 macrospin
pozostaje osobną capability. Poisson-airbox i non-k0 GPU modal wymagają własnych
scalable/persistent runtime gates.

### `floquet_dynamic_demag`

Pozostaje unavailable poza jawnie wąskimi slice'ami, dopóki constraint nie
przenosi frame transport, a demag nie implementuje zgodnego `grad_k/div_k` na
pełnej przestrzeni FE.

## 13. Definicja ukończenia całego programu napraw

Audyt można zamknąć dopiero wtedy, gdy jednocześnie:

- wszystkie A-01 do A-43 mają test regresyjny albo udokumentowane obalenie;
- nie ma aktywnego publicznego P0;
- canonical pencil jest jedynym źródłem `L/B/Aomega`;
- requesty są kanonizowane przed backendem;
- ABI jest size-safe i exception-safe;
- każdy reduced response ma jawny dual/projection contract i true
  residual/backward error; diagonalna ekspansja eigenmodalna dodatkowo ma
  lewe/prawe mody i biortogonalność;
- Poisson-airbox używa realnej słabej formy FEM i poprawnej polityki gauge;
- Floquet przenosi phase oraz tangent-frame transport;
- device FGMRES jest rzeczywiście wykonywany albo nadal uczciwie unavailable;
- wszystkie odpowiadające im managed gates i physics/convergence gates są
  zielone na świeżych artefaktach;
- capability matrix, planner, runtime provenance i dokumentacja opisują ten
  sam stan bez rozszerzania claimu ponad dowód.

## 14. Werdykt końcowy rewalidacji

Dostarczony audyt jest wartościowy i wszystkie jego sześć konkretnych
reproducerów jest poprawnych. Jego końcowy zakaz bezwarunkowego zaufania do
pełnego solvera dynamicznego jest zasadny.

Korekta brzmi: nie wszystkie znalezione problemy są obecnie wykonywanymi P0.
Część jest dormant blockerem niepodłączonego `modal_reduced` albo
`gpu_device_krylov`; część została już częściowo naprawiona; część tez była
skutkiem braku `.cpp/.cu` w przekazanym pakiecie. Jednocześnie bieżący kod ma
dodatkowe aktywne blokery oraz braki promocji, których sam header-only audyt nie
mógł rozstrzygnąć. Aktywne defekty obejmują realny target SLEPc na urojonym
spektrum, publiczny tail-sized C ABI, zerowy RHS w hostowym GMRES, ignorowane
zależności stanu linearyzacji i mylący GPU-G5a readiness claim. Synthetic-only
Poisson assembly jest natomiast fail-closed brakiem promocji, nie dowodem
korupcji aktywnego produkcyjnego lane'u.

Naprawy należy realizować w kolejności z sekcji 6 i 9. Zmiana pojedynczych
warunków walidatora nie wystarczy do naukowej promocji żadnego z lane'ów.

## 15. Mapa dowodów źródłowych na rewizji audytu

Numery linii poniżej odnoszą się do `source_revision` z frontmatter. Mają
ułatwić implementację problem po problemie; przy późniejszych zmianach należy
ponownie wyszukać symbole, a nie ufać starym numerom.

| Remediation | Główne dowody w kodzie |
|---|---|
| DS-01 | `mfem_modal_operator_payload.cpp:190-215`; `driven_response_solver.cpp:4357-4457`; `operator_contract.hpp:68-79` |
| DS-02 | `modal_eigen_request.hpp:16-17,99-100`; `operator_contract.hpp:36`; `excitation.hpp:45` |
| DS-03 | `slepc_modal_eigen.cpp:303-345`; `poisson_airbox_modal_eigen.cpp:1322-1350` |
| DS-04 | `driven_response_solver.cpp:1021-1031,1032-1330`; `modal_eigen_solver.cpp:1215-1516`; `modal_eigen_request.hpp:61-109` |
| DS-05 | `modal_basis.hpp:54-66,136-190`; `frequency_domain_contract.cpp:5915-5956` |
| DS-06 | `modal_basis.hpp:193-252`; `linearization_state.cpp:61-67,295-300` |
| DS-07 | `modal_basis.hpp:136-190`; `modal_response.cpp:141-305`; `frequency_solve_planner.hpp:80-85` |
| DS-08 | `modal_response.hpp:9-27`; `modal_response.cpp:131-188`; `slepc_modal_eigen.cpp:245,313-340` |
| DS-09 | `modal_basis.hpp:54-66`; `modal_eigen_solver.cpp:394-407`; `contour_interval_solver.cpp:1152-1183` |
| DS-10 | `poisson_airbox_modal_eigen.cpp:284-503,711-769,960-1074,1322-1350` |
| DS-11 | `slepc_modal_eigen.cpp:245-252`; `poisson_airbox_modal_eigen.cpp:1263-1269`; `poisson_airbox_schur_matshell.cpp:982-986` |
| DS-12 | `poisson_airbox_modal_eigen.cpp:354-377`; `modal_eigen_solver.cpp:1236-1516`; dokument 19, F-01 i F-02 |
| DS-13 | `gpu_device_krylov.hpp:299-310,375`; `tangent_frame.cpp:53-59`; `production_cpu_driven_response.cpp:725-731`; `driven_response_gpu.cu:1356-1395` |
| DS-14 | `gpu_device_krylov.hpp:62-63,107-118,187-287,313-348` |
| DS-15 | `gpu_device_krylov.hpp:187-258`; `production_cpu_driven_response.cpp:670-733,843-993`; `driven_response_solver.hpp:144` |
| DS-16 | `gpu_device_krylov.hpp:10-14,260-310,443-470`; `frequency_domain_contract.cpp:1768-1780` |
| DS-17 | `gpu_device_krylov.hpp:120-169,423`; `driven_response_solver.cpp:12019-12058`; `driven_response_gpu.cu:1356-1460` |
| DS-18 | `tangent_frame.cpp:53-125`; `operator_terms.cpp:59-99`; `operator_terms.hpp:29-36` |
| DS-19 | `frequency_domain_contract.hpp:35-43`; `driven_response_solver.cpp:15575-15658,15900-15920`; `mesh_symmetry_certificate.hpp:80-85` |
| DS-20 | `mesh_symmetry_certificate.hpp:16-85`; `mesh_symmetry_certificate.cpp:393-399,581-603` |
| DS-21 | `dense_poisson_airbox_eigen_oracle.hpp:17-89`; `dense_poisson_airbox_eigen_oracle.cpp:205-260` |
| DS-22 | `fullmag_fem.h:539-641,686-761`; `api.cpp:1464-1504,2025-2329`; `driven_response_solver.hpp:124-126` |
| DS-23 | `modal_eigen_solver.cpp:1215-1516`; `linearization_state.cpp:83-303`; `api.cpp:765-895` |
| DS-24 | `modal_eigen_request.hpp:30-40,64-80`; `dense_poisson_airbox_eigen_oracle.hpp:23-27`; CSR validators w `poisson_airbox_modal_eigen.cpp:284-503` |
| DS-25 | `linearization_state.hpp:19-65`; `linearization_state.cpp:83-303` |
| DS-26 | `mfem_linearized_operator.cpp:49-340`; `mfem_modal_operator_payload.cpp:105-245`; `driven_response_gpu.cu:1381-1445` |
| DS-27 | `driven_response_gpu.cu:2169-2225,2249-2273`; `capability-matrix-v0.md:110-113`; dokument 19, F-19/F-20 |

Dowody oficjalnych bibliotek użyte do oceny numeryki:

- [SLEPc EPS manual](https://slepc.upv.es/release/documentation/manual/eps.html);
- [SLEPc EPSSetTarget](https://slepc.upv.es/release/manualpages/EPS/EPSSetTarget.html);
- [SLEPc shift-and-invert](https://slepc.upv.es/release/manualpages/ST/STSINVERT.html);
- [SLEPc two-sided eigensolver](https://slepc.upv.es/release/manualpages/EPS/EPSSetTwoSided.html);
- [PETSc FGMRES](https://petsc.org/main/manualpages/KSP/KSPFGMRES/).
