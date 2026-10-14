# Audyt poprawności solvera eigensolve dla relacji dyspersji fal spinowych

**Gałąź:** `codex/eigensolve-dispersion-plan-20260912`
**Worktree:** `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`
**HEAD:** `d1926afed` („Raise FEM equilibrium handoff noise floor"), 128 commitów ponad `master` (merge-base `5084a94ed`)
**Data:** 2026-09-15
**Zakres:** poprawność fizyczna i numeryczna ścieżki non-k0 (Floquet/Bloch) — jądro C++ (MFEM/PETSc/SLEPc), warstwa orkiestracji Rust, bramka walidacyjna Python.
**Metoda:** statyczna analiza źródeł + weryfikacja algebraiczna + niezależne przeliczenia numeryczne referencji analitycznej. **Niczego nie skompilowano ani nie uruchomiono** (MFEM jest zewnętrzną zależnością, a ostatni managed build 44 padł z `mfem.hpp: No such file or directory`).

---

## 0. Werdykt

**Ścieżka dyspersji non-k0 nie jest poprawna i nie powinna być uznana za zakwalifikowaną.**

Znaleziono cztery defekty blokujące. Dwa z nich są w samym operatorze fizycznym — czyli zmieniają to, *czym są* obliczone mody, nie tylko jak dobrze się je znajduje. Dwa pozostałe powodują, że bramka naukowa, która miałaby te błędy wykryć, strukturalnie nie może ich wykryć.

Najważniejszy pojedynczy fakt: **w ścieżce Floquet sprzężenie `A_qφ` jest budowane jako `A_φq^H`, podczas gdy ścieżka k=0 w tym samym repozytorium buduje `A_qφ = −μ₀·A_φq^T`** (i ma na to jawny test). Człon demagnetyzacji dynamicznej przy k≠0 wchodzi więc do pencila z **odwrotnym znakiem** i **bez czynnika μ₀** — czyli ok. 8·10⁵ razy za mały i antydemagnetyzujący. Przy typowych parametrach oznacza to, że obliczana „dyspersja" jest praktycznie czystą gałęzią wymienno-zeemanowską: bez przesunięcia ω_M, bez rozszczepienia DE/BV, czyli bez tej fizyki, dla której cała ścieżka powstała.

To znalezisko zostało uzyskane **niezależnie przez dwie ścieżki analizy** (audyt operatorów Blocha i audyt demag-k/solvera modalnego) i potwierdzone przeze mnie bezpośrednio w kodzie oraz w teście k=0.

Dokumenty gałęzi są w tej sprawie uczciwe: `docs/superpowers/plans/2026-09-13-eigensolve-dispersion-progress-audit.md:3` mówi „implementacja częściowa; kwalifikacja NOT VERIFIED", a `2026-09-14-non-k0-current-review.md:3` — „nie gotowe do zatwierdzenia jako zweryfikowany solver dyspersji". Ten audyt nie zaprzecza tej samoocenie; wskazuje, *gdzie konkretnie* leżą błędy.

### Tabela zbiorcza

| # | Waga | Warstwa | Rzecz |
|---|---|---|---|
| B1 | BLOCKER | C++ | `A_qφ = A_φq^H` bez `−μ₀` → zły znak i skala członu demag przy k≠0 |
| B2 | BLOCKER | C++ | use-after-free: `ComplexSparseMatrix` przeżywa swój `SesquilinearForm` |
| B3 | BLOCKER | Python | bramka naukowa nigdy nie porównuje 61-punktowej dyspersji z analityką |
| B4 | BLOCKER | Python | `KS_RELATIVE_TOLERANCE = 2 %` > całej dyspersji BV na Γ–X (1,45 %) |
| H1 | HIGH | Rust | metryka masy FE nigdy nie działa — ciche zejście do iloczynu euklidesowego |
| H2 | HIGH | C++ | źródło Floqueta asemblowane gęsto, O(N²) — ścieżka „produkcyjna" nie skaluje |
| H3 | HIGH | C++ | `PCJACOBI` na macierzy o zerowej diagonali — prekondycjoner to no-op |
| H4 | HIGH | C++ | `EPSSetTarget` rzeczywisty na czysto urojonym widmie → target ignorowany |
| H5 | HIGH | C++ | falowód 2.5D: `∫N_s` zamiast `∫N_s N_v` w źródle osiowym (blok D ×9) |
| H6 | HIGH | C++ | falowód 2.5D: względny znak członu poprzecznego vs osiowego |
| H7 | HIGH | Rust | `eigenvalue.max(0.0)` — ujemne wartości własne raportowane jako 0 Hz |
| H8 | HIGH | Python | na ścieżce k nie ma ani jednego punktu DE — jedyny dyskryminujący test dotyczy innego przebiegu |
| H9 | HIGH | Rust | próg degeneracji 1e-9 wzgl. — obsługa podprzestrzeni zdegenerowanych to kod martwy |
| M1–M17 | MEDIUM | — | patrz §4 |
| L/N | LOW/NIT | — | patrz §5 |

---

## 1. Kontrakt, który implementacja miała zrealizować

Z `docs/physics/0828-fem-frequency-domain-floquet-demag.md`, `docs/physics/0600-fem-eigenmodes-linearized-llg.md`, `docs/adr/0031-fem-nonzero-k-dispersion-representations.md`:

- Ansatz Blocha: `m̃_nk(r) = u_nk(r)·exp(−i k·r)`, `u_nk(r+R) = u_nk(r)`, `m₀·u_nk = 0` (0828:50–58). Konwencja fazy: `p = exp(−i k·Δr)` — jedna, konsekwentna w całym repo.
- Niewiadomą MES jest **pełny zespolony fazor**, pochodne są zwykłymi gradientami, a faza wchodzi wyłącznie przez `C(k)`: działanie to `C(k)^H A C(k)`. ADR-0031 i plan wprost **zakazują** mieszania przesuniętych pochodnych z ograniczeniami fazowymi („liczyłoby k dwa razy").
- Demag dynamiczny przy k≠0: airbox Poisson na wspólnej domenie magnetyk+powietrze, eliminacja Schura `D(k) = −A_qφ(k)·P(k)⁻¹·A_φq(k)` (0828, implementation-status:407–410).
- Residual pełnego deskryptora: `r_q = A_qq q + A_qφ φ − λ B_qq q`, `r_φ = A_φq q + P φ + cη` (0828:215–227).
- Tabela jednostek 0828:265–266 przypisuje `A_qφ` jednostkę **m³ A⁻¹ s⁻¹**, a `A_φq` — **A·m**.

To ostatnie jest istotne: **sprzężone transponowanie nie może być poprawne wymiarowo**, bo oba bloki mają w dokumencie różne jednostki.

---

## 2. Defekty blokujące

### B1 — BLOCKER. Sprzężenie demag przy k≠0 ma zły znak i brakuje mu μ₀

**Ścieżka gęsta** — `backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp:782-788`:

```cpp
std::vector<Complex> a_qphi(static_cast<std::size_t>(q * reduced));
for (std::uint64_t row = 0; row < q; ++row) {
    for (std::uint64_t column = 0; column < reduced_phi; ++column) {
        a_qphi[static_cast<std::size_t>(row * reduced_phi + column)] = std::conj(
            a_phiq[static_cast<std::size_t>(column * q + row)]);
    }
}
```

**Ścieżka rzadka (produkcyjna)** — `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp:3230-3238`:

```cpp
!complex_csr_conjugate_transpose(
    out_result->floquet_a_phiq,
    a_qphi,
    error)) {
...
out_result->floquet_a_qphi = std::move(a_qphi);
```

Kontrakt jest zadeklarowany wprost w nagłówku (`floquet_airbox_operator.hpp:94`: `A_qphi(k) = A_phiq(k)^H`) i w statusie implementacji (`implementation-status:415-425`).

**Ścieżka k=0 w tym samym pliku robi to inaczej i asymetrycznie** — `poisson_airbox_shared_domain.cpp:2440-2460`:

```cpp
a_phiq_full.add(
    test_node, 2u * trial_node + component,
    -test_sign * trial_sign * ms * shape[local_trial] * source_projection * weight);
...
a_qphi_full.add(
    2u * test_node + component, trial_node,
    -test_sign * trial_sign * shape[local_test] *
        (request.mu0_T_m_A * ms / request.gamma0_m_per_a_s) *
        torque_projection * weight);
```

`torque_projection` zawiera czynnik `−γ₀`, który skraca się z `1/γ₀`, więc ścieżka k=0 realizuje `A_qφ = −μ₀·A_φq^T`. Jest to **jawnie zapięte testem** — `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp:1170-1182`:

```cpp
reciprocal_sign_error = std::max(
    reciprocal_sign_error,
    std::abs(feedback + request.mu0_T_m_A * source));
...
check(reciprocal_sign_error <= 1.0e-12 * std::max(1.0, reciprocal_scale),
      "demag feedback must be -mu0 times the transpose Poisson source so the Schur Hessian is positive");
```

**Dlaczego to jest błąd, niezależnie od konwencji znaku:**

1. **Znak.** `D = −A_qφ P⁻¹ A_φq`. Przy `A_qφ = A_φq^H` mamy `D = −A_φq^H P⁻¹ A_φq`, a `P` (DiffusionIntegrator + Bloch) jest hermitowska dodatnio określona — więc `D` jest **ujemnie półokreślona dla każdego q**. Energia magnetostatyczna `(μ₀/2)∫|∇φ|²` jest dodatnią formą kwadratową w δm, więc jej wkład do hesjanu musi być dodatnio półokreślony. Globalny znak `A_φq` nie ma tu znaczenia, bo wchodzi kwadratowo — to nie jest kwestia konwencji.
2. **Skala.** Ani `P` (`floquet_bloch_scalar.cpp:150`, `DiffusionIntegrator` bez współczynnika), ani źródło styczne (`floquet_bloch_scalar.cpp:65-71`, tylko `Ms`) nie niosą `μ₀`. `grep -rn "mu0"` po `floquet_airbox_operator.cpp`, `floquet_bloch_scalar.cpp`, `floquet_dynamic_demag_k.cpp`, `modal/floquet_modal_solver.cpp` **nie zwraca ani jednego trafienia**. Bloki `floquet_a_qq`/`floquet_b_qq` są rzutami `CᴴAC` tych samych macierzy k=0, które μ₀ niosą — więc obie ścieżki są bezpośrednio porównywalne.

**Wniosek:** `D_floquet = −(1/μ₀)·D_k0`, czyli błąd o czynnik ≈ **−7,96·10⁵**.

**Scenariusz awarii.** Film Py, Ms = 8·10⁵ A/m, M w płaszczyźnie, k = 1–20 rad/µm. Wkład dipolowy powinien być rzędu ω_M = γ₀Ms ≈ 2π·28 GHz. Tutaj wchodzi z amplitudą ~10⁻⁶ tego i z przeciwnym znakiem. Wynik: brak plateau dipolowego przy małych k, brak rozszczepienia DE/BV, brak niewzajemności — czyli krzywa praktycznie wymienna. Przy większych siatkach/parametrach `A_qq + D` może stać się silnie ujemnie określona i solver po prostu nie zbiegnie.

**Najtańszy test regresyjny, którego dziś nie ma:** zasembluj ten sam payload dwa razy — raz ścieżką k=0 (`assemble_poisson_airbox_shared_domain`), raz ścieżką Floqueta przy `k = 1e-6 rad/m` — i porównaj `D`. Muszą być zgodne. Dziś różnią się o `−1/μ₀`.

> Uwaga: w `backends/fem/tests/frequency_domain/` **nie ma żadnego testu**, który wiązałby ścieżkę Floqueta z ścieżką k=0 albo z jakąkolwiek referencją fizyczną. Wszystkie testy Floqueta są algebraiczne (redukcja `CᴴAC`, antysymetria, rozwiązanie manufakturowane). Żaden z nich nie mógł wykryć B1.

### B2 — BLOCKER. Use-after-free: macierz operatora skalarnego przeżywa swojego właściciela

`floquet_bloch_scalar.cpp:169-171` tworzy macierz z formy:

```cpp
out_result->operator_matrix.reset(
    out_result->form->AssembleComplexSparseMatrix());
```

MFEM implementuje to jako `new ComplexSparseMatrix(&blfr->SpMat(), &blfi->SpMat(), false, false, conv)` — **`ownReal = false, ownImag = false`**, czyli `ComplexSparseMatrix` tylko *pożycza* dwie macierze rzadkie należące do `SesquilinearForm`, które `~SesquilinearForm()` kasuje.

`floquet_airbox_operator.cpp:560` deklaruje `FloquetBlochScalarAssemblyResult scalar_result{};` jako obiekt lokalny, a na linii 615 przenosi na zewnątrz **tylko macierz**:

```cpp
out_result->scalar_operator = std::move(scalar_result.operator_matrix);
```

`scalar_result.form` (`std::unique_ptr<mfem::SesquilinearForm>`, `floquet_bloch_scalar.hpp:41`) ginie na końcu zakresu. Każde późniejsze użycie `out_result->scalar_operator` — `copy_mfem_complex_matrix(...)` w `poisson_airbox_shared_domain.cpp:3189` i cały most `assemble_floquet_airbox_dynamic_demag_k` — czyta zwolnioną pamięć.

**Scenariusz awarii.** Dowolny przebieg non-k0 z shared-domain (ścieżka produkcyjna, `modal_eigen_solver.cpp:1824`). To UB, więc zwykle „działa", dopóki zwolnione tablice CSR nie zostaną nadpisane — i przestaje przy innym rozmiarze siatki, innym alokatorze, ASAN-ie albo innym kompilatorze. Testy przechodzą, bo pracują na małych blokach.

**Poprawka:** przenieść też `scalar_result.form` do wyniku (albo zbudować `ComplexSparseMatrix` z kopiami będącymi własnością).

*Powiązane (M5):* `k_squared_coefficient`, `k_coefficient` i `robin_coefficient` (`floquet_bloch_scalar.cpp:144-146`) to obiekty lokalne, a integratory MFEM trzymają do nich **wskaźniki**. Sama asemblacja dzieje się jeszcze w zakresie, więc macierz jest poprawna, ale zwrócona forma jest nieużywalna — każde `Update()`/`Assemble()` przez wywołującego to dereferencja zniszczonych obiektów.

### B3 — BLOCKER. Bramka naukowa nigdy nie porównuje dyspersji z analityką

`scripts/validate_comsol_dispersion_scientific_gate.py:892` (`_validate_dispersion_csv`) sprawdza `eigen/dispersion.csv` **wyłącznie** względem `eigen/spectrum.v2.json` i `eigen/branches.v2.json` — czyli dowodzi, że CSV jest wierną serializacją wyjścia solvera, nigdy że to wyjście jest poprawne.

Jedyne porównania analityczne w całej bramce to `_validate_kittel` (jeden punkt, w Γ) i `_validate_ks`, sterowany w całości zewnętrzną listą dowodów (`:1506-1510`). Nic nie wymusza, by ta lista pokrywała ścieżkę k, osiągała jakiekolwiek minimalne |k| ani miała więcej niż jeden wpis na geometrię. Własny fixture bramki (`scripts/test_validate_comsol_dispersion_scientific_gate.py:337-340`) podaje **dokładnie dwie** próbki, każda wskazująca na osobny, jednopunktowy przebieg pomocniczy.

**Konsekwencja:** próbki 1..60 zakwalifikowanej dyspersji C1 — każdy punkt Γ–X–M–Γ poza Γ — mogą być dowolnie błędne, a bramka nadal zwróci `QUALIFIED`. Błąd 12 % przy k = 20 rad/µm nie jest tolerowany — on w ogóle nie jest oglądany.

### B4 — BLOCKER. Tolerancja 2 % jest większa niż cała dyspersja, którą ma pilnować

`scripts/validate_comsol_dispersion_scientific_gate.py:41`:

```python
KS_RELATIVE_TOLERANCE = 2.0e-2
```

**Przeliczyłem to niezależnie** (parametry z `docs/guides/comsol-dispersion-benchmark/parameters.json`: Ms = 8·10⁵ A/m, A = 13 pJ/m, γ₀ = 2,211·10⁵ m/(A·s), µ₀H = 0,1 T, d = 10 nm, a = 200 nm, X = π/a = 1,5708·10⁷ rad/m):

| k/k_X | k [rad/m] | BV [GHz] | DE [GHz] |
|---|---|---|---|
| 0 (Γ) | 0 | 9,309814 | 9,309814 |
| 0,10 | 1,571·10⁶ | 9,280734 | 9,638042 |
| 0,25 | 3,927·10⁶ | 9,252626 | 10,109787 |
| 0,50 | 7,854·10⁶ | 9,246290 | 10,850469 |
| 0,75 | 1,178·10⁷ | 9,288915 | 11,545965 |
| 1,00 (X) | 1,571·10⁷ | 9,378228 | 12,206611 |

Cała ekskursja gałęzi BV na odcinku Γ–X wynosi **1,45 %**. Solver, który zwróciłby stałą wartość Kittela 9,3098 GHz przy **każdym** k, spełnia `|Δ|/max ≤ 2 %` aż do k = **1,933·10⁷ rad/m** — czyli na **całym** odcinku Γ–X (X = 1,571·10⁷).

**Konsekwencja:** solver, którego operator demag-k zwraca zero — dokładnie to, co daje B1 — przechodzi test BV w każdym punkcie kanonicznej ścieżki. Równoważnie: przy Γ pasmo 2 % odpowiada błędowi pola ±3,6 mT na 100 mT, więc każdy błąd pola wewnętrznego poniżej ~3,6 % jest niewidoczny.

Jedyną próbką z realną mocą dyskryminacyjną byłaby DE (przy k = 10⁷ rad/m odchyłka od Γ to +20,7 %) — i tu wchodzi H8.

---

## 3. Defekty wysokiej wagi

### H1 — Metryka masy FE nigdy się nie uruchamia; tracking cicho schodzi do iloczynu euklidesowego

`crates/fullmag-runner/src/eigen/tracking.rs:86-99` odrzuca parę, gdy `a.len() % weights_a.len() != 0`, a `:196-205` zamienia to `None` na nieważony iloczyn:

```rust
(Some(weights_a), Some(weights_b)) => {
    normalized_mass_weighted_complex_overlap(a, b, weights_a, weights_b)
        .or_else(|| normalized_complex_overlap(a, b))
}
```

Zweryfikowałem obie długości:

- `reduced_vector` **nie jest zredukowany**: `eigen_path_artifacts.rs:718-727` buduje `sample_count * 3` wpisów z tablic `real`/`imag` modu, a te są tworzone w `eigen_projection.rs:79-80` jako `vec![[0.0,0.0,0.0]; total_nodes]`, gdzie `total_nodes` = liczba **wszystkich** węzłów siatki (z airboxem). Czyli `3·n_nodes`.
- `node_mass_weights` ma **jeden wpis na aktywny węzeł magnetyczny**: `eigen_native_window.rs:1699-1717` (`node_mass_weights_from_tangent_mass`) zwraca `Vec` o długości `active_nodes`.

Wobec tego dla realnych siatek `3·n_nodes % n_active ≠ 0`, funkcja zwraca `None` i tracking używa surowego iloczynu euklidesowego po DOF-ach MES — dokładnie tej metryki, której moduł miał unikać („Returning `None` keeps the Euclidean overlap as an explicit compatibility fallback for **legacy** artifacts"; to nie jest artefakt legacy, to artefakt produkcyjny). W rzadkim przypadku, gdy reszta z dzielenia wynosi 0, zwracana jest wartość **jeszcze gorsza**: wagi węzłowe sparowane z niezwiązanymi DOF-ami, bez żadnej diagnostyki.

Ta sama asercja długości zabija całą maszynerię podprzestrzeni zdegenerowanych (`tracking_subspace.rs:108-118`), więc `mass_weighted_subspace_transport` zwraca `None` zawsze — cały `tracking_subspace.rs` jest w produkcji kodem martwym (por. H9).

**Co widzi użytkownik:** na siatce gradowanej z airboxem gałęzie zamieniają się etykietami przy zbliżeniach, wykres wygląda gładko, a `modal_overlap_available` nadal raportuje `true`, `tracking_score_source` = `modal_overlap_weighted_score`.

### H2 — Źródło Floqueta asemblowane gęsto, O(N²)

`floquet_bloch_scalar.cpp:433-467` pętli po `output_width = 2·node_count` kolumnach, w każdej tworząc pełną `mfem::LinearForm` na całej siatce i wpisując `real->Add(row, column, ...)` dla **każdego** wiersza bezwarunkowo. Czyli `2N` pełnosiatkowych asemblacji i macierz `N × 2N` gęsta.

Most gęsty jest ograniczony `kMaxMaterializedDofs = 512` (`floquet_airbox_operator.cpp:21`), ale **ścieżka rzadka („produkcyjny MatShell", `modal_eigen_solver.cpp:1824-1830`) nie ma tego limitu**. Dla N = 10⁵ węzłów skalarnych to ~0,5 TB i 2·10⁵ asemblacji. Nie ma strażnika, który zamknąłby to fail-closed.

### H3 — `PCJACOBI` na macierzy o identycznie zerowej diagonali

`modal/floquet_modal_solver.cpp:1112-1116` ustawia `STSetPreconditionerMat(spectral_transform, context.rotated_a_qq)` i `PCSetType(shifted_pc, PCJACOBI)`. `rotated_a_qq` to rzeczywisty rozkład `−i·s·A_qq` (`:434-439`), a `floquet_a_qq = CᴴA_realC` ma **rzeczywistą** diagonalę, więc `Re(−i·s·(A_qq)_jj) = 0` dla każdego j. PETSc podstawia 1.0 w miejsce zer i prekondycjoner degeneruje się do identyczności; pomija też całkowicie część `−σB`.

Dodatkowo `KSPSetErrorIfNotConverged(..., PETSC_TRUE)` (`:1123`) przy `max_linear_iterations = 128` (`slepc_modal_eigen.hpp:44`). Dla realnej siatki nieprekondycjonowany GMRES(128) nie osiągnie `rtol ≈ 1e-13` → twardy błąd `KSPSolve` → `"floquet_slepc_solve_failed"`, raportowane jako awaria *solve* z `pc_type = "jacobi"` w diagnostyce.

Test tego nie łapie, bo fixture (`floquet_modal_solver_test.cpp:307-314`) ma diagonalę `a_qq` **czysto urojoną** — czyli odwrotnie niż produkcja.

### H4 — Rzeczywisty `EPSSetTarget` na czysto urojonym widmie

`slepc_modal_eigen.cpp:246-250`: `EPS_TARGET_MAGNITUDE` + `EPSSetTarget(eps, target_angular_frequency)`. Pencil `(K + D, G)` z K hermitowską i G rzeczywiście skośną ma wartości własne `λ = ±iω`. Przy rzeczywistym `PetscScalar` target `τ` jest rzeczywisty, a `|λ − τ| = √(ω² + τ²)` jest monotoniczne w `|ω|` — **niezależnie od τ**. Solver zawsze zwraca pary o najmniejszym `|ω|`.

Repozytorium zna rozwiązanie: natywna ścieżka MatShell obraca operator przez `−i·phase_sign` (`floquet_modal_solver.cpp:973-977`), dzięki czemu widmo jest rzeczywiste. **Ta rotacja nie jest stosowana na ścieżce `slepc_modal_eigen`.**

Skutek: przy oknie częstotliwości wszystkie zbieżne pary lądują koło ω ≈ 0, filtr je odrzuca i punkt k zwraca `"no_positive_frequency_eigenpair_in_window"` — przy istniejących modach. Bez okna dostaje się po cichu **złe pasmo**.

### H5 — Falowód 2.5D: `∫N_s` zamiast `∫N_s N_v` w źródle osiowym

`floquet_waveguide_cross_section.cpp:269-281`:

```cpp
const double source_weight = area * scale * ms / 3.0;
...
const double transverse = gradients[local_test][0] * frame[0] + gradients[local_test][1] * frame[1];
const double axial = -frame[2];
add_entry(..., a_phiq_perp_row_major, ..., source_weight * transverse);
add_entry(..., a_phiq_axial_row_major, ..., source_weight * axial);
```

Człon poprzeczny to `∫N_s(∇N_v·e)dA = (area/3)(∇N_v·e)` — poprawnie, bo `∇N_v` jest stałe na trójkącie P1. Człon osiowy to `∫N_s N_v e_z dA`, czyli spójna macierz mas: `area/6` (s=v) i `area/12` (s≠v), **nie** `area/3`. Sumy wierszowe: poprawnie `area/3`, w kodzie `area`.

Test zapina błędną wartość (`floquet_waveguide_cross_section_test.cpp:68-69`, komentarz „`integral(N_0)`" zamiast `∫N₀N₀`). Ponieważ `A_phiq` wchodzi w `D` kwadratowo, blok osiowo-osiowy jest **9× za duży**, a mieszany 3×.

### H6 — Falowód 2.5D: niespójny względny znak członu poprzecznego i osiowego

Ta sama pętla: `transverse = +∇⊥N_v·e⊥`, ale `axial = −frame[2]`. Postać słaba `∫∇⊥φ̂·∇⊥v̂* + k²∫φ̂v̂* = ∫M̂⊥·∇⊥v̂* + i k∫M̂_z v̂*` ma **oba** człony prawej strony z tym samym znakiem; człon `∇⊥·M⊥` scałkowano przez części (zmiana znaku), a `−ikM_z` zapisano w postaci silnej bez kompensacji.

Globalny obrót znaku `A_phiq` byłby tu nieszkodliwy (`A_qφ = A_φq^H` → `D` niezmienione), ale **względny** już nie: blok mieszany perp↔axial dostaje zły znak. Fizyczna kompensacja ładunków powierzchniowych i objętościowych — to, co daje dołek BV i rozróżnienie DE/BV w falowodzie o skończonej szerokości — zamienia się we wzmocnienie.

*Waga obniżona do MEDIUM w praktyce:* `assemble_floquet_waveguide_cross_section_blocks` i `build_floquet_waveguide_demag_k_real_split` **nie mają wywołań poza testami** — moduł jest dziś oraclem referencyjnym, nie ścieżką produkcyjną. Ten sam moduł powiela też defekt B1 (`floquet_waveguide_cross_section.cpp:309-321` + `floquet_waveguide_demag_k.cpp:306`).

### H7 — Ujemne wartości własne cicho przycinane do 0 Hz

`crates/fullmag-runner/src/fem/eigen_math.rs:11-15`:

```rust
pub(super) fn angular_frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    gyromagnetic_ratio * eigenvalue.max(0.0)
}
```

Ujemna wartość własna hesjanu stycznego oznacza, że „równowaga" nie jest minimum (miękki mod, niezbieżna relaksacja, zła linearyzacja). Zamiast błędu warstwa raportuje `frequency_real_hz = 0.0`. Przy `FrequencyWindow{frequency_min_hz: 0.0}` (`eigen_solve.rs:811-816`) **wszystkie** takie mody są *zachowywane* w oknie i sortują się na początek; przy `Lowest` sortowanie po surowej wartości własnej wybiera najbardziej ujemne i publikuje je jako 0 Hz.

Ścieżka natywna jest tu poprawna — `eigen_native_result.rs:879-906` twardo odrzuca `Im(λ) ≤ 0`. Defekt dotyczy ścieżki referencyjnej/baseline CPU, wybieralnej dla Floqueta bez demagu.

### H8 — Kanoniczna ścieżka k nie zawiera ani jednego punktu Damona–Eshbacha

`docs/guides/comsol-dispersion-benchmark/kpath.csv` to Γ(0,0) → X(π/a,0) → M(π/a,π/a) → Γ, a równowaga jest wzdłuż +x (`config.py:30`, wymuszone w bramce `:508-511`). Zatem Γ–X (j = 0..20) to **backward volume**, a X–M i M–Γ (j = 21..60) to kąty 14–45° — ani BV, ani DE. **Żadna próbka nie ma k_x ≈ 0 przy k_y ≠ 0**, więc test dopuszczalności DE (`:1559-1560`) nie może być spełniony przez żaden punkt przebiegu C1.

Tymczasem `_load_numeric_bundle` (`:1135`) chętnie wczyta próbkę DE z dowolnego innego drzewa artefaktów pod `case_dir`, a `_validate_benchmark_metadata` **nie sprawdza** ani `eigensolve.k_sampling`, ani rozmiaru komórki w płaszczyźnie (`:475-481`). Jedyny test o realnej mocy dyskryminacyjnej jest więc wykonywany na przebiegu pomocniczym, który nie jest przebiegiem kwalifikowanym.

### H9 — Tolerancja degeneracji 1e-9 względna — klastry nigdy nie powstają

`tracking_subspace.rs:13-17`: `DEGENERACY_RELATIVE_FREQUENCY_TOLERANCE = 1.0e-9`, czyli ~10 Hz przy 10 GHz. Fizycznie zdegenerowana para na niesymetrycznej siatce czworościennej rozszczepia się na poziomie 1e-4…1e-6 względnie (kHz–MHz), a solver iteracyjny i tak nie odtworzy 1e-9 między dwoma różnymi punktami k. Testy sprawdzają tylko częstotliwości **bit-identyczne** (`tracking.rs:1892-1895`).

W połączeniu z H1: żaden klaster nie powstaje, a gdyby powstał, transport i tak zwróciłby `None`. Każda decyzja trackingu spada do dopasowania pojedynczych modów — czyli dokładnie tego reżimu, którego moduł miał unikać.

---

## 4. Defekty średniej wagi

| # | Miejsce | Rzecz |
|---|---|---|
| M1 | `crates/fullmag-engine/src/fem.rs:1092-1096` | `robin_beta = 1/R_equiv`, niezależne od k. Dla problemu Blocha potencjał na zewnątrz zanika jak `e^{−|k∥|z}`, więc poprawny lokalny ABC to `∂φ/∂n + \|k∥\|φ = 0`. Przy k = 3·10⁷ rad/m i R ≈ 1 µm to czynnik 30 → odbicia od obcięcia, ω(k) dryfuje z wysokością pudełka zamiast zbiegać. Brak też kontroli, czy wysokość airboxa ≳ kilka `1/\|k∥\|`. |
| M2 | `poisson_airbox_shared_domain.cpp:3264-3265` | `pure_neumann` dopuszczony przy k≠0 z `require_invertible` i bez gauge k-świadomego; `P_red(k)` jest prawie osobliwa dla małych `\|k\|` (cond ~ `1/(\|k\|L)²`), a próg pivota jest **bezwzględny**. Dodatkowo `phi_mean_weights` liczone z rzeczywistej ścieżki k=0 są przekazywane do operatora Floqueta. |
| M3 | `floquet_bloch_scalar.hpp:22-29`, `.hpp:37/81` | Reprezentacje `shifted_envelope` i `full_field_phase_constrained` „nie mogą być mieszane", ale `shifted_envelope` jest **wartością zerową enuma i domyślną w obu strukturach**, a `assemble_floquet_bloch_scalar_constraint` zawsze nakłada `e^{−ik·R}`. Struktura problemu nie niesie znacznika reprezentacji i nie ma strażnika runtime. Wywołujący, który zapomni jednego pola, dostaje operator odpowiadający `2k` — bez błędu. |
| M4 | `floquet_bloch_scalar.cpp:151-161` | Para `ConvectionIntegrator` + `ConservativeConvectionIntegrator` daje `A_i = C − Cᵀ`, co odpowiada `u = e^{−ik·r}w` (spójnie z resztą repo), ale nagłówek nigdy nie podaje konwencji, a jedyny test sprawdza wyłącznie antysymetrię i niezerowość. To najłatwiejsza rzecz do „naprawienia" w złą stronę. |
| M5 | `floquet_bloch_scalar.cpp:144-146` | Współczynniki (`k_squared_coefficient`, `k_coefficient`, `robin_coefficient`) to obiekty lokalne, a integratory trzymają wskaźniki — zwrócona `SesquilinearForm` jest nieużywalna (por. B2). |
| M6 | `floquet_dynamic_demag_k.cpp:406-408, 423` | `max_abs_hermitian_residual` jest liczony i publikowany, ale `grep` po `backends/fem` (bez `tests/`) pokazuje, że **nikt go nie czyta**. Niehermitowska `D` daje λ z częścią rzeczywistą, którą bramka imaginarna (`floquet_modal_solver.cpp:1203-1207`) odrzuca — i punkt k raportuje „brak modu", bez śladu, że to operator był zepsuty. |
| M7 | `floquet_modal_solver_test.cpp:209-212` vs `floquet_modal_solver.cpp:831` | Test oczekuje `"floquet_sparse_modal_requires_dense_dynamic_demag_owner"`, a źródło produkuje wyłącznie `"floquet_sparse_modal_requires_shared_domain_sparse_owner"` (sprawdziłem: pierwszy string nie występuje nigdzie poza tym testem). Plik jest w `CMakeLists.txt:1067`, a `check()` woła `std::exit(1)`. **Albo ten test nie jest uruchamiany w CI, albo suite już jest czerwony** — co tłumaczy, jak H3 i H4 mogły wejść niezauważone. |
| M8 | `eigen_path.rs:675`, `:809` | `"ambiguous_assignment_count": 0` zakodowane na sztywno w `diagnostics.v2.json`, `spectrum.v2/v3.json` i `branches.v2.json`. Każdy konsument traktujący to jako dowód jednoznaczności trackingu czyta stałą. |
| M9 | `eigen_path_artifacts.rs:948-955` | `finite_or_default(mode.residual_norm, 0.0)` — brakujące lub NaN residuum publikowane jako „dokładnie zbieżne", brakujący wyciek styczny jako „dokładnie styczny". Fail-**open** na dwóch obserwablach, po których ocenia się zbieżność. |
| M10 | `eigen_path_artifacts.rs:994-996` | `residual_relative_l2 = residual_absolute_l2`. W ścieżce natywnej transportowana wartość jest *względna*, w referencyjnej — bezwzględna normą L2. Stały próg liczbowy na tym kluczu nie ma sensu międzyścieżkowo. |
| M11 | `tracking.rs:230-235` | Koszt przypisania to `0.85·overlap + 0.15·frequency`, podczas gdy próg (`overlap_floor`) stosuje się do samego overlapu. Gdy dwa konkurencyjne overlapy różnią się o mniej niż ~0,18 — dokładnie sytuacja avoided crossing — decyduje człon częstotliwościowy, czyli preferencja **diabatyczna**. Stała magiczna bez pokrętła w IR i bez testu. |
| M12 | `eigen_path_artifacts.rs:689-697` + `eigen_native_artifacts.rs:617` | Mody o indeksie ≥ `plan.count` nie dostają wektora trackingowego, więc są dopasowywane wyłącznie po częstotliwości. Przy `frequency_window` solver natywny nie jest obcinany do `plan.count`, więc to zdarza się realnie. Wtedy `score = 1/(1+Δ/scale)` przy `overlap_floor = 0.50` przepuszcza **dowolne dwa mody różniące się mniej niż 2× w częstotliwości** (10 GHz ↔ 20 GHz → 0,667). |
| M13 | `floquet_bloch_scalar.cpp:65-70` vs `poisson_airbox_shared_domain.cpp:2403,2443` | Ścieżka Floqueta mnoży `Ms` **per węzeł** przez funkcję kształtu; ścieżka k=0 interpoluje `Ms` w punkcie kwadratury. Zgodne tylko dla jednorodnego `Ms`. Dla stosu wielomateriałowego obie ścieżki różnią się już w granicy k → 0 — czyli nawet po naprawie B1 kontrola ciągłości k=0 ↔ małe k nie domknie się czysto. |
| M14 | `validate_comsol_dispersion_scientific_gate.py:43` | `CONVERGENCE_RELATIVE_TOLERANCE = 5e-3`, a modelowy efekt airboxa dla t = 10 nm to 1,13·10⁻³ (1→2 µm) i 5,68·10⁻⁴ (2→4 µm). Test zbieżności airboxa nie odróżnia poprawnie zbiegającego rozwiązania od solvera **bez żadnej zależności od airboxa**. |
| M15 | `validate_...gate.py:540` vs `:1080` | Oracle KS używa pola **przyłożonego** i `P₀₀` dla filmu nieskończonego (efektywnie N_z = 1), a kontrola Kittela — `N_z = 0,9975` dla skończonego pudełka Dirichleta. Rozjazd 1,136·10⁻³ jest **większy** niż `KITTEL_RELATIVE_TOLERANCE = 1e-3` i jest po cichu pochłaniany przez luźniejszą tolerancję KS. W pilocie 100 nm ten sam systematyk to −1,12 %. |
| M16 | `include/frequency_domain/mode_kinematics.hpp:10` | `kDefaultZeroFrequencyToleranceRadPerS = 1.0e-9` — **bezwzględny**. Numeryczny mod zerowy/Goldstone'a wyjdzie na poziomie 1e-2…1e2 rad/s, czyli **powyżej** progu, i zostanie zaakceptowany jako mod fizyczny. Deklarowana polityka `"exclude_zero_frequency"` nie jest w zmiennoprzecinku egzekwowana. |
| M17 | `scripts/generate_comsol_analytic_reference.py:131` | Referencyjny CSV używa `k = (π/a)·i/60`, a ścieżka FEM `k = (π/a)·i/20` na Γ–X — **rozjazd 3×** przy identycznie nazwanej kolumnie `sample_index`. Bramka tego pliku nie czyta, więc to pułapka dla ręcznego nakładania wykresów, nie żywy defekt bramki. |
| M18 | `validate_...gate.py:1578-1608` | Kontrola ciągłości KS liczy `zip(rows, rows[1:])`; przy jednej próbce na geometrię lista jest pusta, `maximum_continuity` to `None`, a predykat akceptuje `None`. Siostrzany walidator (`verify_fem_frequency_domain_eigen_artifacts.py:4137`) wymaga ≥ 3 próbek — ten nie. |
| M19 | `examples/fem_eigenmodes_dispersion_de_bv_low_k.py:61` | `max_relative_error = 0.10` przy całkowitej dyspersji BV tego przykładu 0,607 % i DE 4,37 % — czyli **16,5×** i **2,3×** za luźno; górny limit w `verify_...py:4061` to aż 0,25. Solver z wyłączonym demagiem i wymianą w operatorze k-zależnym przechodzi ten test w pełni, łącznie z kontrolą ciągłości. |

---

## 5. Defekty niskiej wagi i uwagi

- `floquet_airbox_operator.cpp:379-386` — nieaktywne węzły magnetyczne są mapowane na klasę 0 z komentarzem zakładającym „identycznie zerowe kolumny źródła", czego nikt nie sprawdza. Gdyby węzeł powierzchni magnetyka trafił do nieaktywnych, całe jego źródło magnetostatyczne wpadłoby bez fazy do klasy 0.
- `floquet_dynamic_demag_k.cpp:190`, `floquet_waveguide_demag_k.cpp:89` — próg pivota **bezwzględny** (`1e-14`). Dla siatki nanometrowej wpisy FEM Poissona same są rzędu 1e-9, więc dobrze uwarunkowany blok leży tylko 5 dekad nad progiem „osobliwości"; standardem jest test względny.
- `floquet_waveguide_demag_k.cpp:202` — akceptuje `k = 0`, podczas gdy provider 3D (`floquet_dynamic_demag_k.cpp:104-109`) słusznie odrzuca.
- `eigen_solve.rs:795-825`, `eigen_execution.rs:975` — `partial_cmp(...).unwrap_or(Equal)` w `sort_by` nie jest porządkiem totalnym; reszta repo poprawnie używa `total_cmp`.
- `assembly_scalar.rs:118-133` (`solve_dense_reference_modes`) — odwraca `M`, tworzy `M⁻¹K` (niesymetryczne!) i podaje do `SymmetricEigen`, a przy osobliwej `M` po cichu podstawia identyczność. Dziś bez wywołań, ale to pułapka.
- `eigen_path.rs:911-931` — legacy `branch_table.csv` ma kolumnę `mode_index` wypełnioną `raw_mode_index`, czyli porządkiem solvera per k, nie gałęzią. Wykres z tego pliku odtwarza dokładnie artefakt „greedy nearest-frequency", któremu tracking ma zapobiegać.
- `native_fem/frequency_domain.rs:990-1008` używa `f64::EPSILON` jako progu Γ, a strażniki runnera `1e-12`.
- `production_cpu_modal_eigen.cpp:1945` przekazuje `request` zamiast `effective_request`; `floquet_modal_solver.cpp:1024-1025` alokuje `q_physical_imag`, które jest zerowane i nigdy nie czytane.
- `validate_...gate.py:1400-1433` — `_bundle_branch_is_lowest_positive` patrzy tylko na gałęzie śledzone, nigdy na `spectrum.samples[*].modes`; niższy mod, który nie awansował do gałęzi, nie unieważnia asercji „fundamentalny".
- `validate_...gate.py:654-655` — próg residuum fazowego **pomija się cicho**, gdy pola nie ma; trzy siostrzane diagnostyki w tej samej funkcji są fail-closed.
- `floquet_modal_solver.cpp:1203-1215` — bramka na części urojonej (`|Im| > max(1e-8, 10·tol)·max(1,|ω|)`) przy ω ≈ 6·10¹⁰ rad/s dopuszcza ~600 s⁻¹ tłumienia jako „zero", a `lambda_real` jest wymuszane na 0. Tłumienie Gilberta α = 10⁻³ daje σ ≈ 6·10⁷ s⁻¹ — trzy rzędy powyżej. Ta ścieżka **nie może** zwrócić modu tłumionego; zamiast jasnego „nieobsługiwane" raportuje `"no_positive_frequency_eigenpair"`.

---

## 6. Co zweryfikowano jako poprawne

To nie jest lista pobożnych życzeń — każdy punkt był aktywnie sprawdzany.

**Konwencja fazy Blocha jest globalnie spójna** (`e^{−i k·Δr}`, `Δr = r_b − r_a`): ograniczenie skalarne (`floquet_bloch_scalar.cpp:247-255`), styczne (`floquet_airbox_operator.cpp:411-429`), prolongacja magnetyczna (`floquet_magnetic_operator.cpp:112`), walidacja par (`:290`), kierunek `translation_m` (`mesh.rs:4222-4226`, `mesh_symmetry_certificate.cpp:287-293`) i jedyny wariant enuma po stronie Rusta (`periodic/constraints.rs:217-226`). **Nie znaleziono ani jednego odwrócenia znaku** między asemblacją, mapowaniem DOF a członami gradientowymi.

**Gradient pola Blocha jest algebraicznie poprawny** w reprezentacji obwiedni: człon masowy `|k|²`, człony skrośne jako para antyhermitowska składająca się w operator hermitowski. **Redukcja do k=0 jest dokładna** — przy `k² = 0` integratory nie są w ogóle dodawane, wszystkie fazy to dokładnie 1, brak członu liniowego w k.

**Sprzężenia hermitowskie są poprawne.** `MultTranspose` na `ComplexOperator` w konwencji `HERMITIAN` realizuje `A^H` (nie `Aᵀ`), więc `C^H A C` w `assemble_floquet_bloch_scalar_reduced_operator` jest właściwe. `FloquetTangentProlongation::restrict_adjoint` liczy `M^H f` i ma jawny test tożsamości `⟨Cq,v⟩ = ⟨q,C^H v⟩`.

**Rozkład rzeczywisty (realifikacja)** `[[Re D, −Im D],[Im D, Re D]]` jest spójny we wszystkich trzech miejscach, a mnożenie operatora przez skalar zespolony `−i·phase_sign` jest legalnym przeskalowaniem wartości własnych.

**Odwzorowanie wartość własna → ω i czynniki 2π są poprawne** w ścieżce natywnej: `ω = Im(λ)`, `f = Im(λ)/2π`, twarde odrzucenie `Im(λ) ≤ 0`, brak składania `|ω|` (co fałszowałoby gałęzie).

**Rama styczna nie ma degeneracji na sferze**: `reference = |m_z| < 0.9 ? ẑ : ŷ` daje najgorszy przypadek `|ref × m| ≈ 0,436`. Skrętność jest zgodna z założeniem bloku żyrotropowego.

**Struktura pencila jest właściwa**: `A_qq` hermitowska, `B_qq` **antyhermitowska** (nie SPD — to sformułowanie żyroskopowe, nie ma tu macierzy mas w klasycznym sensie), więc `EPS_GNHEP` jest poprawnym typem problemu, a solver symetryczny byłby błędem.

**Operator demag nie jest symetryzowany w k**: `P(k)` zależy od `k²`, a sprzężenia są `real_perp ± i·k·real_axial`, więc `D(−k) = conj(D(k))` — to poprawna relacja odwrócenia czasu. *Uwaga do premisy audytu:* dla pojedynczego symetrycznego filmu ω_DE(k) = ω_DE(−k) dokładnie; niewzajemność DE żyje w **profilu modu** (przeskok lokalizacji powierzchniowej między górną a dolną ścianką), nie w częstotliwości. Właściwą regresją jest test profilu, nie test ω(k) ≠ ω(−k).

**Przekazanie równowagi wzdłuż ścieżki k jest poprawne**: `KSolverAdapter::solve_single_k` relaksuje tylko przy pierwszej próbce i przekazuje ten sam `m₀` do każdego kolejnego k; próbki są przetwarzane ściśle sekwencyjnie. Strażnik tożsamości siatki (`handoff.validate_target_plan`) i bramka akceptacji równowagi są **fail-closed**, bez wariantu ostrzegawczego.

**Dwa commity, które wyglądały na poluzowanie tolerancji, nie poluzowały niczego fizycznego**: `ef2e546fd` i `d1926afed` podniosły próg do `1e-7 + 1e-12·scale` A/m, co przy polach ~1e5 A/m daje ~2e-12 względnie — to podłoga szumu reprezentacji, poprawnie uzasadniona w komentarzu.

**Referencja analityczna Kalinikosa–Slavina jest poprawna do precyzji maszynowej.** Zweryfikowałem `verify_fem_frequency_domain_eigen_artifacts.py:3889` przeciw opublikowanej postaci `ω² = (ω_H + ω_M λk²)(ω_H + ω_M λk² + ω_M F₀₀)` dla DE i BV: zgodność 2·10⁻¹⁶ w całym zakresie. `p00_demag_factor` ma poprawną gałąź `expm1` i poprawny szereg Taylora. Stałe kontrolne w `parameters.json` odtwarzają się co do bitu. `kpath.csv` jest wewnętrznie spójny, w rad/m, bez pomyłek stopnie/radiany ani 1/nm vs 1/m.

**Bramka jako całość jest fail-closed** i ma mocne wiązanie proweniencji (SHA-256 wszystkich artefaktów, odrzucenie `analytic_reference_model` jako źródła częstotliwości, odrzucenie przebiegów `validation_only`, stałe podpisy backendu między parami zbieżności). Nie znalazłem ścieżki „przejdź przy braku danych": wszystkie klauzule `except` dopisują powód, puste tablice i NaN są odrzucane. **Problemem nie jest szczelność bramki, tylko jej pokrycie i wartości progów.**

**Dwie niezależne referencje DE-100 nm zgadzają się do ~10⁻⁶** (Galerkin z jądrem Greena vs kolokacja Czebyszewa) — to mocny dowód, że sama referencja sprzężona jest poprawna. Nie jest to jednak dowód dla solvera: raport `2026-09-14-de-100nm-numerical-report.md` sam stwierdza „Brak wartości FEM, tabeli błędów i wykresu porównawczego".

---

## 7. Luki w testach — dlaczego te błędy przetrwały

1. **Nie ma żadnego testu, który wiązałby ścieżkę Floqueta z jakąkolwiek referencją fizyczną.** Wszystkie testy Floqueta w `backends/fem/tests/frequency_domain/` są algebraiczne albo na rozwiązaniach manufakturowanych. Żaden nie mógł wykryć B1, H5 ani H6.
2. **Nie ma testu ciągłości k=0 ↔ małe k.** To jednocześnie najtańszy i najostrzejszy test, jaki można dodać — i dokładnie ten, który złapałby B1.
3. **Test redukcji jest tautologiczny** (`floquet_bloch_scalar_test.cpp:303-312`): odtwarza linijka w linijkę implementację `assemble_floquet_bloch_scalar_reduced_operator`, więc nie wykryje pomyłki transpozycja/sprzężenie ani złej fazy.
4. **Fixture solvera modalnego ma diagonalę odwrotną niż produkcja** (czysto urojoną), co maskuje H3.
5. **Test kontraktowy `floquet_modal_solver_test.cpp:211` musi padać** — co sugeruje, że suite C++ nie jest uruchamiany w bramce merge'owej.
6. **Bramka naukowa, jak wyżej (B3/B4/H8/M18), strukturalnie nie ogląda dyspersji.**

---

## 8. Czego nie udało się ustalić

- Czy brak `μ₀` z B1 jest gdzieś kompensowany. Przeszukałem wszystkie pliki Floqueta — `μ₀` nie występuje w żadnym. Argument wymiarowy i argument znaku czynią kompensację bardzo mało prawdopodobną, ale **rozstrzygnąć może tylko numeryczne porównanie `D` z obu ścieżek przy k → 0⁺**.
- Czy build PETSc/SLEPc jest rzeczywisty (`PetscScalar == double`). H4 zależy od tego; kod odmawia pracy przy `PETSC_USE_COMPLEX` (`floquet_modal_solver.cpp:924-928`), co mocno sugeruje build rzeczywisty.
- Czy suite testów C++ w ogóle chodzi w CI (M7).
- Czy `EigenTargetIR::Lowest` jest kiedykolwiek używany dla ścieżki dyspersji — to decyduje, czy H7 jest awarią warunkową czy gwarantowaną.
- Dokładny stosunek `n_nodes` / `n_active` dla siatek benchmarkowych — rozstrzyga, czy H1 objawia się jako cichy fallback euklidesowy, czy jako metryka policzona ze sparowanych, niezwiązanych DOF-ów. **Obie gałęzie są defektem**; różni je tylko etykieta wagi.
- Czy przebieg pomocniczy DE jest w ogóle produkowany przez managed runner (H8). Znalazłem go tylko w syntetycznym fixture bramki.
- Nie audytowano: `contour_interval_solver.cpp` (ścieżka faktycznie wybierana przy `target_kind == "frequency_window"`, czyli realna trasa sweepu dyspersji), ścieżki DMI przy k≠0 (drugie źródło niewzajemności), ścieżki GPU, oraz `comsol_modal_field_certificate` / `comsol_n0_field_certificate`.
- `progress-audit:53-83` zgłasza **R01 — błędną kolejność pivotów w bounded Schur**. Sprawdzenie ręczne obu implementacji `solve_factored` (`floquet_dynamic_demag_k.cpp:231-247`, `floquet_waveguide_demag_k.cpp:128-136`) wskazuje, że są **spójne** — faktoryzacja zamienia całe wiersze wraz z zapisanymi mnożnikami L. R01 jest więc prawdopodobnie już naprawiony, ale status w dokumencie pozostaje otwarty; warto to formalnie zamknąć.

---

## 9. Rekomendowana kolejność napraw

1. **B1** — jedyny defekt, który zmienia *czym są* mody. Poprawić `A_qφ` na `−μ₀·A_φq^T` w obu ścieżkach (gęstej i rzadkiej), zaktualizować `floquet_airbox_operator.hpp:94` i `implementation-status:415-425`, i **dodać test ciągłości k=0 ↔ k = 1e-6** jako strażnika. Sprawdzić, czy dokumentowa tabela jednostek (0828:265–266) zgadza się z przyjętą normalizacją kodu.
2. **B2** — poprawka jednolinijkowa (przenieść `form` do wyniku); dopóki jej nie ma, każdy wynik non-k0 jest formalnie bez znaczenia.
3. **B4 + B3** — zacieśnić `KS_RELATIVE_TOLERANCE` poniżej fizyki, którą ma pilnować (na gałęzi BV cała ekskursja Γ–X to 1,45 %, więc ≥ 1 % nie dyskryminuje), i porównywać **wszystkie 61 próbek** na śledzonej gałęzi fundamentalnej, a nie listę wybraną przez producenta. Rozszerzyć `_kalinikos_frequency_hz` na dowolny kąt φ w płaszczyźnie (to zmiana ~4-linijkowa) — dziś 40 z 61 próbek nie ma żadnego oracle'a. Rozważyć bramkowanie **kształtu** (`df/dk` albo odchyłki od wartości w Γ) zamiast bezwzględnej częstotliwości na płaskich gałęziach.
4. **H8** — dodać do ścieżki punkt DE (albo wymusić w `_validate_benchmark_metadata` zgodność `k_sampling` i rozmiaru komórki dla przebiegów pomocniczych).
5. **M7** — ustalić, czy suite C++ w ogóle chodzi; naprawić string i uruchomić. Bez tego każda kolejna poprawka jest niesprawdzalna.
6. **H1 + H9** — naprawić niezgodność długości (albo eksportować wektor zredukowany do aktywnych węzłów, albo rozszerzyć wagi na wszystkie węzły siatki) i zamienić bezwzględne/zbyt ciasne progi degeneracji na względne o realistycznej skali. Niezgodność metryki powinna być **twardym błędem**, nie degradacją do metryki euklidesowej.
7. **H3 + H4** — zastosować rotację `−i·phase_sign` również na ścieżce `slepc_modal_eigen`, a prekondycjoner zbudować na macierzy o niezerowej diagonali (np. na `A_qq − σB` zamiast na samej `rotated_a_qq`).
8. **H2** — asemblować źródło jedną pętlą po elementach, wpisując tylko niezerowe wiersze; dodać strażnika rozmiaru na ścieżce rzadkiej.
9. **H7, M6, M9** — zamienić trzy fail-open na fail-closed: ujemna wartość własna to błąd, brakujące residuum to błąd, niehermitowska `D` to błąd.
10. **M1** — uzależnić `robin_beta` od `|k∥|` i dodać kontrolę wysokości airboxa względem `1/|k∥|`.

---

## 10. Załącznik — niezależna weryfikacja numeryczna

Obliczenia własne (`numpy`, podwójna precyzja), parametry C1 z `parameters.json`:
Ms = 8,0·10⁵ A/m, A = 13·10⁻¹² J/m, γ₀ = 2,211·10⁵ m/(A·s), µ₀H = 0,1 T (H = 79 577,47 A/m), d = 10 nm, a = 200 nm.
Wyprowadzone: ω_H/2π = 2,800264 GHz, ω_M/2π = 28,151326 GHz, λ_ex = 2A/(µ₀Ms²) = 3,232835·10⁻¹⁷ m² (l_ex = 5,686 nm).

- Implementacja KS n=0 w repo zgadza się z postacią opublikowaną do **2·10⁻¹⁶** w całym zakresie k, dla obu geometrii.
- Ekskursja gałęzi BV na Γ–X: min 9,242818 GHz, max 9,378226 GHz → **1,45 %** całości.
- Solver zwracający stałą wartość Kittela przechodzi próg 2 %: BV do k = **1,933·10⁷ rad/m** (punkt X leży na 1,571·10⁷), DE tylko do 9,02·10⁵ rad/m.
- Pasmo 2 % wokół f_BV(X) = 9,3782 GHz jest odtwarzane przez **każde** k ∈ [0; 2,10·10⁷] rad/m — 2 % tolerancji na częstotliwości to ponad 100 % tolerancji na k.
- Rozjazd modeli demagnetyzacji między oraclem KS a kontrolą Kittela: **1,136·10⁻³** > `KITTEL_RELATIVE_TOLERANCE = 1e-3`.
- Modelowe przyrosty zbieżności airboxa dla t = 10 nm: 1→2 µm: 1,133·10⁻³; 2→4 µm: 5,675·10⁻⁴ — oba 4–9× poniżej `CONVERGENCE_RELATIVE_TOLERANCE = 5·10⁻³`.
- Pilot DE-100 nm: obie niezależne referencje zgadzają się do 2·10⁻⁶…4·10⁻⁶; KS n=0 odbiega od najniższego pierwiastka referencji sprzężonej o **+52,5 %** (k = 20 Mrad/m) i **+33,1 %** (k = 40 Mrad/m) — przy t/l_ex = 17,6 przybliżenie jednomodowe KS po prostu nie obowiązuje, co raport sam odnotowuje.

---

## 11. Zakres przeczytanego kodu

**Przeczytane w całości:** `floquet_bloch_scalar.{hpp,cpp}`, `floquet_magnetic_operator.{hpp,cpp}`, `floquet_airbox_operator.{hpp,cpp}`, `floquet_dynamic_demag_k.{hpp,cpp}`, `floquet_waveguide_demag_k.{hpp,cpp}`, `floquet_waveguide_cross_section.{hpp,cpp}`, `modal/floquet_modal_solver.{hpp,cpp}`, `slepc_modal_eigen.{hpp,cpp}`, `mfem_exchange_operator.cpp`, `mfem_tangent_space.cpp`, `mfem_linearized_operator.cpp`, `mode_kinematics.{hpp,cpp}`, `eigen_mass_metric.rs`, `tracking.rs`, `tracking_subspace.rs`, `output_selection.rs`, `eigen_math.rs`, `validate_comsol_dispersion_scientific_gate.py`, oraz testy: `floquet_bloch_scalar_test.cpp`, `floquet_airbox_operator_test.cpp`, `floquet_dynamic_demag_k_test.cpp`, `floquet_waveguide_*_test.cpp`, `floquet_modal_solver_test.cpp`. Dokumenty: 0600, 0828, ADR-0031, plan/status/audyt/review 2026-09-12…14, raport DE-100 nm.

**Przeczytane wybiórczo:** `poisson_airbox_shared_domain.cpp` (3302 l. — asemblacja k=0 `A_φq`/`A_qφ`/`B_qq`/`P`, gauge, cała trasa payloadu Floqueta), `production_cpu_modal_eigen.cpp`, `modal_eigen_solver.cpp`, `poisson_airbox_schur_matshell.cpp` (tylko konwencja znaku Schura), `eigen_path*.rs`, `eigen_native_*.rs`, `eigen_tests.rs`, `verify_fem_frequency_domain_eigen_artifacts.py`.

**Nieprzeczytane:** `contour_interval_solver.cpp`, `mfem_dmi_operator.cpp`, `real_frequency_rotated_pencil.cpp`, `dense_poisson_airbox_eigen_oracle.cpp`, jądra GPU/CUDA, `comsol_modal_field_certificate.py`, `comsol_n0_field_certificate.py`, system budowania.

**Nie wykonano:** kompilacji ani żadnego uruchomienia solvera.
