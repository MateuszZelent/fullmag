# Druga poprawka po re-review — FDM GPU public pure-Neumann charge

Data: 2026-08-11
Worktree: `codex/fdm-gpu-public-neumann`
Zakres: wyłącznie poprawki I1-R1 i I2-R1 dla publicznej ścieżki FDM/CUDA M1.

## Przyczyna

Weryfikacja Rust sprawdzała dotąd bilans przez sumę terminali
`sum(abs(A_f * J_n,f))`. Natywny owner CUDA nie wykonuje jednak tej redukcji:
dla każdej zewnętrznej ściany odejmuje `A_f * J_n,f` od `rhs` komórki
sąsiadującej, a następnie liczy sumę i normę L1 już z wektora `rhs`.
W siatce `1 x 1 x 1` przeciwne elektrody trafiają do tej samej komórki, więc
prąd `+1` oraz `-1 + 1e-15` daje inną decyzję niż kontrola po terminalach.

Ponadto publiczny preflight nie dowodził, że `area_m2` przekazane do ABI jest
geometrycznie kanoniczne dla `cell_size`.

## Implementacja

- Planner i runner składają teraz per-cell RHS w tej samej kolejności jak owner
  CUDA: komórka, oś `x/y/z`, strona ujemna/dodatnia. Reguła jest
  `abs(sum(rhs)) <= 64 * eps_f64 * sum(abs(rhs))`; dla zerowej normy legalne
  jest wyłącznie dokładne zero.
- Preflight runnera wyprowadza wymagane pola powierzchni z rozmiaru komórki:
  `hy*hz`, `hx*hz`, `hx*hy`, i odrzuca różnicę większą niż względne `1e-12`.
- Dodano testy RED/GREEN dla niezbilansowanej oraz zbilansowanej siatki
  `1 x 1 x 1` i dla niekanonicznego `area_m2`; przypadki błędne nie wywołują
  ABI.
- Uaktualniono publikacyjną notę fizyczną, kanoniczny plan oraz rejestr SDD,
  aby nie deklarowały nieprawdziwej reguły terminalowej.

## Dowody RED

- Przed poprawką runner akceptował przypadek `1 x 1 x 1` z elektrodami
  `+1` i `-1 + 1e-15` A/m2 i dochodził do mock ABI.
- Przed poprawką planner zwracał `Ok(())` dla tego samego przypadku zamiast
  błędu `current_density_electrodes_must_have_finite_area_weighted_balance`.
- Przed poprawką podwojone `area_m2` ściany izolującej dochodziło do ABI.

## Dowody GREEN

- `fullmag-plan`: 340/340 testów.
- `fullmag-runner`: 817/817 testów.
- Walidator source mapy noty 0970 oraz jego zestaw testów: 10/10.
- Kontraktowa dokumentacja FDM GPU: 16/16.
- Zarządzany, kontenerowy test CUDA:

  ```text
  env COMPOSE_PROJECT_NAME=fullmag just verify-fdm-gpu-public-charge-zero-mean-runtime
  ```

  zakończył się kodem 0. Natywny przebieg GPU FP64 (`2 x 1 x 1`) podał
  `V=[-0.025,+0.025] V`, `J_x=-2e13 A/m2`, `iterations=1`, residual
  algebraiczny `4.1150157270026995e-17`, residual fizyczny `0`, bilans
  komponentu `0` i bilans elektrod `0`. Provenance potwierdza
  `gauge_policy=zero_mean_per_free_component`, CUDA runtime `12040` i device
  UUID `fcb9fbf1828437c7af5b76bcbf2d2937`.

## Granica kwalifikacji

Ta poprawka kwalifikuje wyłącznie publiczną, pełnosiatkową ścieżkę M1
OhmicPoisson FDM/CUDA FP64 z czystym problemem Neumanna. Nie rozszerza fizyki
do racetracku ze skyrmionem, SHE→SOT/STT, CPP MTJ/TMR/GMR, spin accumulation,
mixing conductance ani sprzężonego Oersteda; są to osobne pozycje planu.
Końcowa akceptacja tej zmiany nadal wymaga niezależnego second re-review.
