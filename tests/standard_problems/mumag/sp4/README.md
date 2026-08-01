# µMAG Standard Problem 4

Problem jest zdefiniowany przez oficjalną specyfikację NIST. Dane pod
`references/` są niezmienne, kontrolowane SHA-256 i używane bez dostępu do
sieci. `common/` posiada kontrakt, parsery, metryki i fail-closed validator;
`fem/` materializuje ten kontrakt przez publiczne API Fullmag.

Kwalifikacja wymaga strict FEM CPU oraz strict FEM GPU w `double`, bez
fallbacku. GPU musi raportować `device_hypre_poisson`; tryb
`hybrid_cpu_poisson` jest niedozwolony. Oba lane'y wykonują dwa przypadki
pola, three-mesh matrix (`3.0`, `2.0`, `1.5 nm`) i oba airboxy. Końcowa bramka
sprawdza też parytet CPU/GPU.

## Metodologia relaksacji

Relaksacja stanu S i dynamika po załączeniu pola są dwiema niezależnymi
osiami numerycznymi. MuMax3 `Relax()` tymczasowo wymusza adaptacyjny
Bogacki--Shampine RK23, `FixDt=0` i brak precesji, po czym przywraca solver
wybrany dla dynamiki. Dlatego krok `1e-14 s`, potrzebny w FEM do stabilnej
relaksacji, nie jest automatycznie krokiem fizycznej dynamiki SP4.

Zarządzana kwalifikacja uruchamia na każdym wymaganym meshu i airboxie:

- `llg_overdamped` z RK23, `dt_max=1e-14 s`;
- `projected_gradient_bb` bez RK i bez czasu fizycznego;
- `nonlinear_cg` bez RK i bez czasu fizycznego;
- każdy algorytm na FEM CPU i FEM GPU.

Każdy z sześciu wyników musi mieć `converged=true`, skończone artefakty,
malejącą energię w zaakceptowanej końcówce i końcowy
`max_torque_T <= 1e-5 T`. Stan GPU/RK23 zostaje wybrany dopiero po zgodności
wszystkich końcowych stanów i przejściu mapy stanu S NIST. Jego SHA-256 oraz
fingerprint mesha są następnie wymagane przez każdy przebieg dynamiki.

Uruchomienie pełnej kwalifikacji:

```text
just verify-fem-standard-problem-4
```

Wynik może otrzymać status `passed` wyłącznie po przejściu wszystkich bramek
NIST, zbieżności, proweniencji i parytetu.

Pojedynczy scenariusz użytkownika można uruchomić tak:

```text
just fullmag build=True fem gpu tests/standard_problems/mumag/sp4/fem/scenarios/case_a_rk4_fixed.py
```

Bez `--output-dir` powstaje obok skryptu jeden bundle
`case_a_rk4_fixed.zarr/`. Końcowa dynamika jest w `artifacts/`, relaksacja i
etapy konfiguracyjne w `stages/`, tabela zaakceptowanych kroków w odpowiednim
`scalars.csv`/`tables/`, a seria pola w `fields/m.zarr`. Ponowne uruchomienie
tego samego skryptu usuwa poprzedni automatyczny bundle i zapisuje świeży.
Jawny `--output-dir` nie jest automatycznie usuwany.

Skrypty `case_a_*.py` i `case_b_*.py` przygotowują wspólny stan S przez
adaptacyjny RK23, a dopiero etap reversal używa nazwanego solvera (`heun`,
`rk23`, `rk4`, `rk45`; fixed albo adaptive). Bazowy krok/cap dynamiki wynosi
`2e-13 s`.

Skrypty `relax_*.py` badają wyłącznie przygotowanie stanu S. Obejmują PG-BB,
NCG, stabilne Heun/RK23/RK4, sweep RK45 fixed
`{2e-13, 1e-13, 5e-14, 2e-14, 1e-14} s` oraz adaptacyjne RK23/RK45 z
`dt_max=1e-14 s`.

Aby po zwykłym uruchomieniu aplikacji dopisać zweryfikowany wynik do jednego
CSV i odświeżyć wykresy PNG, użyj wrappera scenariusza:

```text
just fem-sp4-scenario gpu \
  tests/standard_problems/mumag/sp4/fem/scenarios/relax_llg_rk23_adaptive.py \
  gpu-rk23-relax-001 true
```

Domyślny rejestr to
`.fullmag/reports/standard-problems/mumag/sp4/fem/ledger/results.csv`, a PNG
powstają w sąsiednim `plots/`. `attempt_id` jest unikalny i nigdy nie jest
nadpisywany. Wiersze relaksacji nie udają trajektorii NIST; przechowują
algorytm, właściwą politykę RK (jeśli istnieje), energię, torque, kryterium
stopu i hashe artefaktów. Wiersze dynamiki przechowują trajektorie, pierwsze
przejście `mx=0` i metryki obwiedni NIST.
