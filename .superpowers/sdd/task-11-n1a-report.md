# Task 11 N1a — mixed-P1 native MFEM A_qq

## Status

Zakończono ograniczoną lukę N1a w natywnym operatorze FEM CPU. Native
`A_qq` akceptuje teraz wyłącznie magnetyczne elementy MFEM P1 `tet4` oraz
`prism6`; `pyramid5`, geometrię spoza tej pary i każdy rząd FE inny niż P1
odrzuca fail-closed.

Nie jest to kwalifikacja produkcyjnego runtime ani promowanie capability.
Jest to lokalny kontrakt natywnej assembly w repozytoryjnym kontenerze
MFEM/CUDA.

## Zmienione pliki

- `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`
  - tetra-only gate zastąpiony whitelistą P1 `tet4|prism6` z kontrolą liczby
    local DOF (`4|6`);
  - zachowane są istniejące MFEM `CalcPhysDShape`, kwadratura, transport
    tangent-frame, znak, jednostki i współczynnik `2*A_ex*dot(grad N_i, grad N_j)*w_K`.
- `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp`
  - magnetic `prism6` + oddzielny air `tet4`;
  - niezależny oracle prism: jawne funkcje kształtu, odwrotność afinicznego
    Jacobiego i niezależnie zapisany punkt/ciężar kwadratury rzędu 1;
  - porównanie wszystkich wpisów, action dla deterministycznego wektora oraz
    dodatnio-półokreślonej energii;
  - bezpośrednia kontrola, że air DOF nie mają wierszy ani kolumn `A_qq`;
  - negatywy P1 `pyramid5` i P2 `prism6` z tym samym stabilnym powodem;
  - odświeżone wcześniejsze tetra fixture/asercje do bieżącego kontraktu:
    izolowany output odrzuconej assembly, prawidłowy digest negatywu,
    orientacja air `tet4`, skompaktowane wymiary klas i aktualny binding reason.

## TDD

### RED

Najpierw dodano fixture/oracle/negatywy bez zmiany produkcyjnej. Uruchomiono:

```sh
docker compose --profile fem-gpu run --rm \
  -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
  fem-gpu bash -lc 'cd /workspace && cmake -S native -B native/build \
    -DCMAKE_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-native}" \
    -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON \
    -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=ON && \
    cmake --build native/build --target fem_poisson_airbox_shared_domain_contract && \
    LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} \
    native/build/backends/fem/fem_poisson_airbox_shared_domain_contract'
```

Wynik: exit 1 po zbudowaniu targetu, dokładnie:

```text
FAIL: native magnetic A_qq exchange supports only P1 tetrahedral elements
```

To potwierdziło, że nowa regresja trafia w zamknięty tetra-only gate.

### GREEN

Po minimalnej zmianie whitelisty ponowiono powyższy focused command. Ostatni
run: exit 0; `fullmag_fem` i
`fem_poisson_airbox_shared_domain_contract` zbudowane, binarium zakończyło
się bez `FAIL`.

Wykonano także `git diff --check` z exit 0 przed commitem.

## Self-review

- Produkcyjna zmiana jest ograniczona do jednego gate’u operatora; brak zmian
  runnera, algorytmów eigensolve, API, ABI lub runtime pointerów.
- `pyramid5` nadal nie jest dopuszczony jako magnetic weak form; air mask
  nadal omija wszystkie contribution exchange.
- Oracle nie odczytuje assembled CSR jako oczekiwanej wartości i nie wywołuje
  `CalcPhysDShape`; celowo odtwarza bieżącą quadraturę rzędu 1 operatora.
- Focused target obejmuje istniejące tetra regressions oraz nowe prism6
  coverage.
- Nie dotknięto nieśledzonego `native-debug/`.

## Commit

- `cc901ed4a feat(fem): assemble mixed P1 prism exchange block`

## Managed build/runtime concern

`justfile` został sprawdzony przed buildem. Nie zawiera osobnego recipe dla
`fem_poisson_airbox_shared_domain_contract`; najbliższe
`verify-fem-mixed-p1-native-contract` buduje inne, szersze kontrakty. Focused
test wykonano zamiast hostowego builda w repozytoryjnym kontenerze
`fem-gpu` z MFEM/CUDA. Nie uruchamiano zarządzanego public runtime ani nie
zgłasza się kwalifikacji produkcyjnej.
