# Koszt produkcyjnego okna eigensolve — 2026-10-01

## Wynik i granice dowodu

Źródła wskazują kosztowną sekwencję osobnych solve'ów shift-invert, a nie
ponowne składanie całego operatora Poissona. Terminalna diagnostyka pozwala
przypisać 98,81765% sumy czasu podokien nieudanym solve'om. Nie mamy jeszcze
profilu rozdzielającego assembly, preconditioner, EPSSolve i Poisson apply.
Nie obniżono liczby podokien, wymagania kompletności ani progów residualu.

Przegląd dotyczy worktree `eigensolve-dispersion-plan-20260912`, przy
checkpointcie `6b3b7357e1084aa91e9a5b77b9503e8929d5eb4a` i lokalnym R4 WIP.
Pilot używa starszego, jawnie przypiętego runtime/modelu
`e78a25bac0f95c1190821524545803e4311b8ef9` z buildu #193.
Build i batch naukowy są odrębnymi etapami: numer #193 identyfikuje receipt
runtime, nie osobny job kwalifikacji naukowej.

Pilot Γ t3 zakończył się błędem kompletnego okna: 36 podokien poprawnych,
14 nieudanych (`slepc_diverged`). Suma czasów podokien wynosi 14 845,011149 s;
nieudane zajęły 14 669,491091 s, poprawne 175,520058 s. To suma pomiarów
podokien, nie wall time całego pipeline'u ani buildu. Pojedynczy mod Γ
9,299249697 GHz przeszedł kontrolę oryginalnego residualu, ale nie powstał
kompletny wynik widma. [Tożsamość logu i wynik](2026-10-01-mfem410-gamma-window-outcome.md).

## Mechanizm potwierdzony w źródłach

Główne źródło: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`.

| Mechanizm | Symbol/obszar | Konsekwencja |
|---|---|---|
| 16 podokien bazowych i 34 refinements | harmonogram produkcyjnego okna | 50 seryjnych podproblemów; retry może zwiększyć liczbę solve'ów |
| Jeden kontekst i faktoryzacja Poissona | window operator context | istniejące współdzielenie działa; nie uzasadnia ponownego montażu całego operatora |
| Schur MatShell | operator apply | zastosowanie operatora rozwiązuje Poissona, real split wymaga dwóch takich solve'ów |
| Limit cache dokładnego preconditionera 512 | `kProductionWindowExactPreconditionerMaxDimension` | warunek dotyczy wewnętrznego `split_count`, a nie samego publicznego `effective_dof` |
| Sparse fallback per shift | `create_production_shift_preconditioner` | powtarzane wpisy wartości/assembly oraz konfiguracja i faktoryzacja PC |
| Osobny EPS/ST/KSP na podokno | `solve_poisson_airbox_modal_eigen_cpu_schur` | ograniczone ncv nie usuwa kosztu 50 niezależnych solve'ów |

Ogólne okno CSR/Floquet w `production_cpu_modal_eigen.cpp` również wykonuje
shifty seryjnie. Nie deklarujemy równoległego liczenia punktów ani shiftów.

`configure_production_cpu_operator_context` ustawia `split_count=2*q_count`;
harmonogram okna wyznacza wymiar jako `2*problem.q_dof_count`. Przy porównaniu
progu cache należy odczytać rzeczywisty wymiar wewnętrzny. Sam komunikat
`effective_dof=656` nie jest pomiarem wymiaru tej macierzy i nie uzasadnia
zwiększenia limitu tylko do 656. Terminalna diagnostyka podaje q_dof_count=656,
phi_dof_count=5084 oraz augmented_dof_count=5740. Z kodu realnego splitu
wynika split_count=1312; nie jest to nowy pomiar telemetrii. Runtime #193
nie publikuje czasu ani liczników materializacji dokładnego preconditionera.

Wycofano liczbowe twierdzenie o historycznych licznikach: wskazany do review
`stage_00_flat_relax/metadata.json` zawiera również duże tablice indeksów.
Wystąpienie liczb 2755/5566/5574 nie dowodzi ich znaczenia jako liczników
solvera. Mechanizm reużycia potwierdzają wymienione źródła, nie ten odczyt.

## Następne działania

1. Terminalny pilot i liczniki odczytano. Przygotować świeży runtime nearest
   dla Γ/±DE/±BV i kontrolować oryginalne residuale oraz selected-only output.
   Zachować osobną bramkę naprawy rozbiegania i kompletności pełnego okna.
2. Zmierzyć per-shift assembly, factorization PC, setup EPS/ST/KSP, EPSSolve,
   retry oraz apply/Poisson solve. Rozdzielić setup od czasu rozwiązania.
3. Zbadać współdzielenie pattern/preallocation sparse fallbacku i aktualizację
   wartości dla shiftu; zachować osobną faktoryzację numeryczną.
4. Osobno porównać koszt dokładnego cache dla rzeczywistego wymiaru split.
   Zwiększenie limitu
   wymaga pomiaru: materializacja sama wykonuje wiele zastosowań Schura.
5. Każdą zmianę solvera sprawdzić na identycznym źródle/modelu z pełnymi
   residualami, guard modes i certyfikatem pokrycia okna.

Istniejący dense oracle pozostaje referencją. Nie uznajemy go za produkcyjną
kwalifikację SLEPc ani za rozwiązanie kosztu na podstawie samej nazwy solvera.
Główne bramki S00–S12, R4, signed DE/BV i COMSOL pozostają otwarte.
