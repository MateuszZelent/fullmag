# Kontrakt akceptacji równowagi eigensolve sterowany przez użytkownika

- Status: zatwierdzony projekt
- Data: 2026-08-12
- Zakres: FEM `relax -> eigenmodes`, import certyfikowanego stanu równowagi
- Powiązana nota fizyczna: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`

## 1. Problem

Publiczne `tolA` i `tolT` definiują kryterium momentu etapu relaksacji, ale
runner modalny nakłada następnie niezależny warunek
`max_torque_Apm / max(max_H_eff_Apm, 1 A/m) <= 1e-6`. Powstają dwa różne
kryteria równowagi: jawne użytkownika i ukryte backendu. Ukryty próg może
odrzucić etap poprawnie zakończony zgodnie z autorskim kryterium energii albo
momentu.

## 2. Decyzja

Akceptacja równowagi jest własnością zakończonego etapu relaksacji i jego
jawnego kontraktu stopu. Eigensolve nie narzuca drugiego kryterium fizycznego.

Etap `relax` może przekazać zaakceptowany handoff, jeżeli:

1. zakończył się statusem `completed` i `converged=true`;
2. powodem zatrzymania jest `torque` albo `energy`;
3. wartość końcowa metryki jest skończona i nie przekracza progu zapisanego w
   `StageCompletionIR`;
4. mesh, indeksowanie, rejestr części i magnetyzacja są związane digestami.

`max_steps`, limit czasu, anulowanie, stagnacja bez spełnionego kryterium oraz
błąd backendu nie tworzą zaakceptowanego handoffu.

## 3. Semantyka kryteriów

### 3.1 Kryterium momentu

`tolA` jest zapisane w `A/m`. `tolT` jest na granicy Python API przeliczane na
`A/m` przez `tolA = tolT / mu0`. Handoff przechowuje rodzaj metryki, wartość,
próg i jednostkę. Ponowne obliczenie momentu przed linearyzacją jest
diagnostyką i kontrolą skończoności, a nie nową bramką tolerancji.

### 3.2 Kryterium energii

Jeżeli użytkownik włączył kryterium energii i etap zakończył się jego
spełnieniem, stan jest zaakceptowany do linearyzacji nawet wtedy, gdy moment
nie spełnia osobnego progu momentu. Artefakt zapisuje końcowy moment i względny
moment, aby użytkownik mógł ocenić jakość przybliżenia.

### 3.3 Diagnostyka względnego momentu

Wielkość `max_torque_Apm / max(max_H_eff_Apm, 1 A/m)` pozostaje obserwablem.
Nie ma wartości domyślnej ani progu akceptacji i nie może zmienić statusu
etapu, handoffu, eigensolve ani produkcyjnej kwalifikacji.

## 4. Źródła równowagi

### 4.1 `equilibrium_source="relax"`

Eigensolve konsumuje wyłącznie immutable handoff bez ponownej relaksacji i bez
przebudowy meshu. Handoff zachowuje pełny `StageCompletionIR` oraz jego digest.

### 4.2 `equilibrium_source="artifact"`

Artefakt musi zawierać certyfikat akceptacji: producenta, kryterium, metrykę,
próg, wartość końcową, jednostkę, status, powód zatrzymania oraz digesty meshu,
materiałów, fizyki, BC i magnetyzacji. Sam wektor magnetyzacji jest
niewystarczający.

### 4.3 `equilibrium_source="provided"`

Produkcja traktuje go jak import artefaktu i wymaga certyfikatu. Niecertyfikowany
wektor pozostaje dozwolony wyłącznie w jawnych adapterach testowych, bez
production implication.

## 5. Model danych i kompatybilność

Publiczne Python API i `ProblemIR` relaksacji nie zmieniają się. Zmiana dotyczy
wewnętrznej granicy wykonania:

- `AcceptedFemRelaxStageHandoff.v2` przechowuje kanoniczny snapshot completion;
- `equilibrium_artifact.v7` przechowuje `acceptance_criterion`, końcowe
  obserwable i `representation_integrity`;
- stare `equilibrium_artifact.v6` z wyłącznie względnym progiem `1e-6` nie są
  automatycznie promowane; wymagają migracji z dowodem źródłowym albo ponownej
  relaksacji;
- natywna linearyzacja otrzymuje fakt zaakceptowania i digest certyfikatu, nie
  hardkodowany próg względny.

## 6. Warunki integralności

Pozostają fail-closed i niezależne od fizycznego kryterium relaksacji:

- skończoność magnetyzacji i pól;
- norma `m0` w tolerancji reprezentacji;
- zgodność liczby węzłów, indeksowania i meshu;
- zgodność materiałów, fizyki, BC, demag i okresowości;
- zgodność digestów oraz brak remeshu między etapami.

## 7. Provenance i UI

Artefakty oraz API Results publikują:

- `acceptance_criterion = torque | energy | independent_certificate`;
- `metric_kind`, `metric_value`, `threshold`, `unit`;
- końcowe `max_torque_Apm`, `max_torque_T`, `max_torque_relative`;
- `source_stage_id`, `completion_sha256`, `equilibrium_content_sha256`;
- osobno `representation_integrity`.

UI nie może przedstawiać względnego momentu jako ukrytej bramki. Inspector
równowagi pokazuje kryterium wybrane przez użytkownika oraz pozostałe
obserwable diagnostyczne.

## 8. Testy akceptacyjne

1. Relax zakończony momentem poniżej `tolA` tworzy handoff i uruchamia eigen.
2. Relax zakończony energią tworzy handoff mimo momentu powyżej `tolA`.
3. `max_steps`, anulowanie i błąd nie tworzą handoffu.
4. Zmiana hardkodowanego względnego momentu nie wpływa na status.
5. Artefakt bez certyfikatu jest odrzucany przed assembly.
6. Certyfikowany artefakt zachowuje kryterium i digest w round-tripie.
7. Relax i eigen używają dokładnie tego samego meshu i magnetyzacji.
8. CPU i GPU stosują identyczną semantykę akceptacji.

## 9. Poza zakresem

- automatyczny dobór tolerancji przez backend;
- ocena, czy wybrane przez użytkownika kryterium daje wystarczającą dokładność
  konkretnej publikacji;
- migracja starego artefaktu bez dostępnego completion/provenance;
- zmiana algorytmu relaksacji.

## 10. Samokontrola projektu

- Brak placeholderów i niejawnych wartości domyślnych.
- Kryterium fizyczne i kontrole integralności są rozdzielone.
- CPU/GPU oraz relax/artifact używają jednego kontraktu.
- Nie powstaje drugi publiczny model ani backendowy override intencji.
