# T05 — reakcja terminalowa H1: wynik próby i punkt wznowienia

Data: 2026-10-01. Zakres: przygotowanie podpisanego pomiaru prądu
terminalowego dla przyszłego solve z zadanym prądem. T05 **nie jest
ukończone**.

## Potwierdzone fakty

- Obecna ścieżka charge-only rozwiązuje zadane potencjały Dirichleta.
  `SteadyTransportOracle::boundary_current_a` całkuje odzyskany gradient
  na ścianach; nie jest reakcją dyskretnego operatora. Sam certyfikat
  `measured_port_current` nie ustala żądanego rozdziału prądu.
- W `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
  zapisano docelową definicję
  $F_t=-\sum_{i\in\mathcal D_t}(\sum_j K_{ij}V_j-b_i)$ oraz układ odpowiedzi
  terminalowej. Powiązana mapa źródeł przechodzi walidator; 32 testy kontraktu
  dokumentacji przeszły.
- Dwie próby natywne przez
  `just verify-fem-steady-transport-cpu-only-contract` z buildem pod
  `D:\git\fullmag\storage` zakończyły się tym samym błędem:
  `weak reaction has the wrong inlet current sign or magnitude`.
  Pierwsza używała `BilinearForm::Mult` po `FormLinearSystem`, druga
  `BilinearForm::FullMult`. Kompilacja C++ i audyty konfiguracji przeszły;
  test affine-bar nie przeszedł. Ostatni raport ma `status: fail` w
  `storage/runtimes/<worktree-id>/reports/fem-cpu-only/steady-transport/result.json`.
- Eksperymentalny accessor, stan i test zostały wycofane z worktree.
  Nie ma obecnie nowego API ani zaliczonej bramki reakcji terminalowej.

## Następny krok diagnostyczny

Przed kolejną zmianą produkcyjną wypisać w dedykowanym teście: atrybuty
obu końców pręta, liczbę DOF w każdym terminalu, surowe sumy residualu
`Mult`/`FullMult`, wynik historycznego `boundary_current_a` oraz analityczne
$\pm\sigma A\Delta V/L$. To rozdzieli błąd wyboru markerów/DOF, znaku i
macierzy po eliminacji. Po diagnozie wybrać jedną z metod:

1. osobno zachować nieeliminowaną macierz przed `FormLinearSystem` i liczyć
   reakcję z niej;
2. wyjaśnić na poziomie lokalnych DOF, dlaczego `FullMult` nie spełnił
   kontraktu mimo dokumentowanej sumy $M+M_e$;
3. złożyć reakcję bezpośrednio z lokalnych form elementowych przy tym samym
   $\sigma$ i funkcjach P1;
4. po wykluczeniu błędu wyboru terminali użyć równoważnego pomiaru reakcji
   dostarczanego przez MFEM, jeśli istnieje w wersji 4.7.

Żadna z tych opcji nie jest jeszcze zweryfikowanym rozwiązaniem. Nie
zmieniać tolerancji ani nie przywracać całki z gradientu jako produkcyjnego
certyfikatu. Po przejściu testu na pręcie dodać testy asymetrycznych returns,
odwrócenia znaku, gauge i rozłącznych składowych, a dopiero potem nową
wersję ABI oraz terminal response matrix.

Źródło semantyki eliminacji MFEM 4.7:
https://github.com/mfem/mfem/blob/v4.7/fem/bilinearform.hpp
