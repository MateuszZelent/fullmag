# BORIS–Fullmag N/F SHE v1 — status diagnostyczny

Ten katalog opisuje odtwarzalny harness porównawczy dla jednorodnego stosu
normalny metal/ferromagnetyk (N/F). Nie jest to jeszcze kwalifikacja solvera
ani dowód równoważności BORIS i Fullmag.

## Zakres

- BORIS: `scripts/run_boris_nf_interface.py`, renderer
  `scripts/boris_nf_interface_smoke.py`, niezależny verifier
  `scripts/verify_boris_nf_interface.py`;
- Fullmag: canonical Python DSL → ProblemIR → FDM CPU, `double`, `strict`,
  reciprocal M2, `fdm_coupled_charge_spin_fv_block_gmres.v1`;
- normalizacja: `mu_s = 2 De S/(elC MUB_E)`, tensor `Q_ia` w kolejności
  `row_major_Q_ia`, jawne SI units i orientacja normalnej `N(+z) → F(-z)`;
- porównanie: `scripts/compare_boris_fullmag_she_nf.py`, zawsze ze statusem
  diagnostycznym.

## Wykonane dowody

Managed BORIS artefact:

```text
root=/zfn2/mateuszz/git/fullmag/boris-build/reports/runner-coarse-3
schema=fullmag.boris_she_nf.v1
source_manifest_sha256=ed1ca167fae571b8106b79ed86347de4a6509647db87716c8f6f1559c890cde6
binary_sha256=5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997
cuda_image=nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f
grid=N 4x2x2, F 4x2x2
SHA=iSHA=0.10 on N; F SHA=0.10; Gi=5e14; Gmix=(1.5e15,0)
qualification=diagnostic
```

`exit=143` został zaakceptowany wyłącznie po markerze
`BORIS_NF_STAGE_COMPLETE`, obecności wszystkich OVF i próbek natywnych.
Surowe wartości interfejsu oraz ograniczenie `interior_cell_count=0` są zapisane
w `summary.json` i opisane w `BORIS_FULLMAG_SHE_COMPARISON.md`.

## Fullmag — wynik uruchomienia

Świeży binarny launcher zbudowano przez repozytoryjne `just` w trybie
`cuda-fem-gpu`; ścieżka: `.fullmag/local/bin/fullmag`, commit źródłowy
`813332079e01838f976acee521326b643dce7aaa` (dirty),
`native_sha256=284c14c86212cc918c1ad1770d70049e1918b3271fb0d8545d08f865f65e627b`,
`launcher_sha256=27d7c5ebb3bd1aa47391fc9bc6313d052a6e2b42f05e8cf5f183a84b12ea1843`.
Build i ciężkie dane pozostały poniżej `/zfn2/mateuszz/git/fullmag`.

Pierwsza próba referencyjna:

```text
runner=scripts/run_fullmag_m2_nf_reference.py
output=/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-nf-coarse-run19
execution=FDM / CPU / double / strict
mesh=4x2x4, cell=(1e-7,1e-7,1e-9) m
```

Runtime zatrzymał się fail-closed przed publikacją artefaktu:

```text
Step 0: coupled charge-spin solve: M2 physical balance gate rejected
without committing state: charge=7.139977e-6, spin=5.450726e-8
```

Jest to zachowany dowód `not_run`, nie wynik porównania pól. Analiza kodu
wykazała, że przyczyną był sztuczny floor `max(||P b||_2,1)` w tolerancji
GMRES. Floor usunięto bez zmiany fizycznego progu bilansu; regresyjny N/F
case na tej samej cienkiej komórce oraz 22 testy M2 CPU przechodzą. Runner
zachował `problem_ir.json`, `request.json`, `fullmag.stdout.log` i
`fullmag.stderr.log`; nie utworzono zastępczego artefaktu.

Po usunięciu sztucznego flooru GMRES świeży coarse run został zaakceptowany:

```text
artifact=/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-nf-coarse-run22/
transport/fullmag_m2_nf_reference.json
scaled_charge_residual=6.423463949700895e-15
scaled_spin_residual=3.691253818811614e-15
charge_balance=3.5205103056502695e-11
spin_balance=2.371483382809825e-12
interface_observation_count=8
```

Adapter średnią fluxów liczy po wszystkich ośmiu komórkach płaszczyzny N/F;
nie wybiera jednej próbki i nie ukrywa tej redukcji w artefakcie.

Porównanie z `runner-coarse-4` nie jest parity: status wynosi
`incomparable`. Stały gauge potencjału (`-3.4482757355128163e-4 V`) i globalne
przesunięcie początku siatki `(0,0,-2e-9) m` są zapisane jawnie. Potencjał po
tej normalizacji ma maksymalny błąd względny `3.098487032667977e-4`, lecz
`mu_s`, `Q_ia` i absorbowany flux różnią się istotnie; torque pozostaje
nieporównywalny (`Tsi [A/(m s)]` kontra Gilbert source `[1/s]`).

Pierwsza macierz sześciu przypadków w
`.../reports/fullmag-boris-she-nf-matrix-run24/matrix.json` zakończyła się
fail-closed po stronie Fullmag: cztery przypadki nie zbiegały w 500 iteracjach
GMRES, a dwa fine przekroczyły 300 s. Średnia siatka uruchomiona diagnostycznie
z limitem 2000 iteracji przeszła, więc limit w harnessie jest osobną otwartą
kwestią numeryczną. Nie zmienia to statusu capability ani kwalifikacji.

## Bramy pozostające otwarte

1. ustalić i udokumentować limit/strategię GMRES dla średniej i drobnej siatki,
   a następnie powtórzyć wszystkie sześć tuplek;
2. po przejściu Fullmag wykonać wspólny BORIS/Fullmag artefact na tych samych
   trzech siatkach i dwóch tolerancjach;
3. uzgodnić `Tsi` BORIS (`A/(m s)`, ścieżka `tsi_eff/gamma`) z arealnym torque
   Fullmag — obecnie obserwable torque są oznaczane jako `incomparable`;
4. wykonać CPU↔CUDA, N/T/F i cross-backend gates.

Do czasu zamknięcia tych punktów `SHE-BORIS-001` pozostaje otwarte,
capability matrix nie jest zmieniana, a status pozostaje
`qualification=diagnostic`.
