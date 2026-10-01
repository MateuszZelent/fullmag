# Koszt produkcyjnego okna eigensolve — 2026-10-01

## Wynik i granice dowodu

Źródła wskazują kosztowną sekwencję osobnych solve'ów shift-invert, a nie
ponowne składanie całego operatora Poissona. Nie mamy profilu czasowego,
który pozwala przypisać procent czasu poszczególnym operacjom.
Nie obniżono liczby podokien, wymagania kompletności ani progów residualu.

Przegląd dotyczy worktree `eigensolve-dispersion-plan-20260912`, przy
checkpointcie `6b3b7357e1084aa91e9a5b77b9503e8929d5eb4a` i lokalnym R4 WIP.
Pilot używa starszego, jawnie przypiętego runtime/modelu
`e78a25bac0f95c1190821524545803e4311b8ef9` z buildu #193.
Build i batch naukowy są odrębnymi etapami: numer #193 identyfikuje receipt
runtime, nie osobny job kwalifikacji naukowej.

Odczyt kontenera `21c61a91ee6f` potwierdził aktywny proces. Log pilota Γ t3
pokazuje `active_nodes=328`, `effective_dof=656`, refinament `24/50` i
`window_s=3845.3`. Są to dane obserwowane, bez terminalnej częstotliwości.
Residual wypisywany przy iteracjach liniowych nie zastępuje residualu modu.

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
zwiększenia limitu tylko do 656. Pilot przekracza próg, lecz dokładny koszt
materializacji trzeba policzyć dla wewnętrznego split.

Wycofano liczbowe twierdzenie o historycznych licznikach: wskazany do review
`stage_00_flat_relax/metadata.json` zawiera również duże tablice indeksów.
Wystąpienie liczb 2755/5566/5574 nie dowodzi ich znaczenia jako liczników
solvera. Mechanizm reużycia potwierdzają wymienione źródła, nie ten odczyt.

## Następne działania

1. Dokończyć obecny pilot i odczytać terminalne liczniki/receipt. Nie uruchamiać
   duplikatu ani nie przerywać go wyłącznie z powodu długiego czasu.
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
