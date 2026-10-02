# DE ±2 — korekta hipotezy diagnostycznej GMRES

Data: 2026-10-02. Stan: diagnoza, bez poprawki numerycznej i bez nowych obliczeń.
Cel: odróżnić awarię shifted solve od bramki fizycznego residualu 1e-8.

## Dowody z rzeczywistego wykonania

Job #203 d30406a2ef6d42cb9120ce04d58d646a, source snapshot
e262dd9442467e521fe1f1b82ee081f16f9b1eddab337236305bd5151625dca5.
Baza danych: scientific-batches/nonzero-k-validation/d30406a2ef6d42cb9120ce04d58d646a.

- signed15-v1/cases/kp2-attempt-001/de-smoke-k2/runtime.log: GMRES recursion
  6.81589e-16, recomputed 1.98915e-12, początek cyklu 1.28921e-13.
  Stos błędu biegnie przez STMatSolve/STApply do EPS Krylov-Schur.
- Dynamic-demag operator probe przeszedł, lecz nie znaleziono zaakceptowanego
  modu. Probe nie dowodzi sukcesu shifted solve ani całego eigensolve.
- priority-validated-de-kp10-t3/de-smoke-k10/eigen/diagnostics/solver.v1.json
  publikuje ksp_pc_side=1 i ksp_norm_type=2. To PC_RIGHT oraz
  KSP_NORM_UNPRECONDITIONED, nie PC_LEFT.
- Immutable source tree kapsuły 4f7472dd4ad94b819855473ec81d751f zawiera jawne
  KSPSetPCSide(shifted_ksp, PC_RIGHT) oraz
  KSPSetNormType(shifted_ksp, KSP_NORM_UNPRECONDITIONED).
  Bieżący floquet_modal_solver.cpp zachowuje te same wywołania.
- Fizyczny Poisson w tym źródle używa KSPPREONLY/PCLU bez przesunięcia
  faktoryzacji (MAT_SHIFT_NONE). Nie jest iteracyjnym CG rozwiązaniem wewnątrz
  tego Schur MatShell. Pole cpu runtime poisson_solver=CG opisuje wcześniejszy
  etap relax i nie może zastępować odczytu modalnego właściciela.

## Wniosek i plan następnej próby

Hipoteza, że wystarczy przełączyć outer KSP z PC_LEFT na PC_RIGHT, jest
sprzeczna ze źródłem i zaakceptowanymi artefaktami. Sam błąd ±2 nie zachowuje
końcowego KSPGetPCSide po niebezpiecznym EPSSolve unwind; nie dopisujemy więc
nieobserwowanej wartości do jego wyniku. Nie ma dowodu, że SLEPc zmienił side.

Różnica norm przy restarcie potwierdza problem numeryczny shifted solve;
nie wyznacza jeszcze jego przyczyny. Zależność od normalizacji, działania
Schur MatShell, faktoryzacji i restartu wymaga rozdzielenia. Nie wolno uznać
małej normy rekursji za residual fizycznego modu.

1. Po kwalifikacji nowego runtime powtórzyć ±2 z zapisaniem rzeczywistej
   konfiguracji przed EPSSolve, żeby porównać ją także przy terminalnym błędzie.
2. Zmierzyć na tych samych wektorach błąd powtarzalności i liniowości Schur
   action oraz true residual przesuniętego równania. Rozdzielić forward error
   Poissona i cancellation magnetic/feedback zamiast zakładać błąd tolerancji CG.
3. Na małym, jawnie ograniczonym oracle porównać shell action z materializacją
   tego samego operatora, bez zastępowania pełnej produkcyjnej realizacji dense.
4. Dopiero pomiar uzasadnia wybór poprawki skalowania/preconditionera/Krylov.
   Nie podnosić breakdown tolerance ani nie osłabiać physical residual 1e-8
   wyłącznie po to, żeby pilot zakończył się sukcesem.
5. Ponowić signed k, odtworzyć pełny block residual i zweryfikować pola;
   dopiero wtedy dodać punkty do wykresu. ±10 pozostają osobnymi dowodami.

Źródła semantyki enum i norm (oficjalne PETSc; wersja bieżącej dokumentacji
jest nowsza od użytego runtime 3.24.6, a konfigurację dowodzi kapsuła):
[PCSide](https://petsc.org/release/manualpages/PC/PCSide/),
[KSPNormType](https://petsc.org/release/manualpages/KSP/KSPNormType/).

Mapa źródeł: backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp
(owner shifted KSP, Poisson LU, EPSSolve, diagnostics),
backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp
(agregacja podokien i diagnostyki),
scripts/validate_de_smoke_rows.py oraz scripts/validate_de_physical_potential.py
(niezależne artefakty i pełne bramki). Parser/source review nie dowodzi runtime.

## Dodatkowe rozdzielenie hipotez — bieżący odczyt

Konfiguracja zachowanej kampanii signed15-v1 dla obu znaków k=2 rad/µm
ma odniesienie n0 9.7257242838410924 GHz i okno
[8.990724283841093, 9.990724283841093] GHz. Środek okna to
9.490724283841093 GHz; nie jest to 11 GHz z osobnej próby ±10.
Okno obejmuje oczekiwaną podstawową gałąź, więc prosty błąd polegający na
użyciu okna ±10 dla ±2 nie wyjaśnia obecnej awarii. Źródło:
signed15-v1/signed15-config.json w storage kampanii #203 oraz
cases/kp2-attempt-001/run-request.json (frequency_window_override_ghz).
Nie jest to dowód kompletności widma ani zbieżności.

W aktualnym właścicielu natywnym próg materializacji dokładnego
preconditionera Schura wynosi 512 wymiarów real-split. Powyżej niego
create_native_floquet_shifted_preconditioner duplikuje rotated_a_qq, czyli
korzysta z przybliżenia magnetic-only. Mały dense oracle ma oddzielną
bramkę q_complex_dof_count <= 256, czyli real-split <= 512.
Dlatego nie można przenosić skuteczności małego exact-Schur fixture na
większy benchmark ani uznać odmowy oracle za brak operatora produkcyjnego.
Te progi nie zostały zmienione. Następna diagnostyka powinna mierzyć
powtarzalność i liniowość action na kilku wektorach bez globalnej
materializacji, podawać rzeczywisty wymiar i użyty preconditioner oraz
zachowywać rozdział faktów od hipotezy przyczyny.
