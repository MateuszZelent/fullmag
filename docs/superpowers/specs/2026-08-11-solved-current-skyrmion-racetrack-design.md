# Produkcyjny racetrack ze skyrmionem i rozwiązanym transportem

**Status:** zatwierdzony projekt; oczekuje na przegląd zapisanej specyfikacji

**Data:** 2026-08-11

**Aktywny zakres:** wyłącznie etap 1 roadmapy transportowej

**Pierwsza realizacja produkcyjna:** FDM / CUDA / FP64 / strict

## 1. Wynik końcowy

Użytkownik definiuje racetrack w Python DSL albo Control Room, dodaje transport
charge/spin tylko do wybranych obiektów, inicjalizuje albo relaksuje skyrmion i
uruchamia dynamikę. Fullmag rozwiązuje kolejno charge, direct SHE oraz steady
spin, przekazuje wynikowy transportowy SOT/STT do LLG i publikuje trajektorię,
prędkość oraz kąt Halla.

Etap jest ukończony dopiero wtedy, gdy cały przepływ działa publicznie,
fail-closed i bez ukrytego prescribed torque:

```text
Python/UI
  -> canonical ProblemIR
  -> FDM/CUDA capability plan
  -> accepted charge snapshot: V, J_c
  -> direct SHE + steady spin: mu_s, Q
  -> interfacial and volumetric angular-momentum transfer
  -> transport torque on the ferromagnet
  -> accepted LLG trajectory
  -> skyrmion center, velocity and Hall angle
  -> artifacts, checkpoint, provenance and qualification
```

Pole Oersteda i CPP-MTJ nie należą do tego przepływu i nie mogą opóźniać ani
pozornie rozszerzać kwalifikacji etapu 1.

## 2. Model fizyczny

Racetrack składa się z warstwy heavy-metal oraz sprzężonej z nią warstwy
ferromagnetycznej. Charge solver wyznacza podpisane, konserwatywne pole `J_c`.
Direct spin Hall effect w heavy-metalu wytwarza tensor prądu spinowego `Q`.
Steady drift-diffusion wyznacza wektorową akumulację spinową `mu_s`.

Poprzeczna absorpcja spinu na zorientowanym interfejsie HM/FM oraz
objętościowe reakcje wymiany i dephasing przekazują moment pędu do
ferromagnetyka. Torque transportowy jest wyznaczany z bilansu momentu pędu, a
nie z lokalnie podstawionej sprawności prescribed SOT.

LLG zachowuje kanoniczną konwencję Gilberta, znaki prądu, `theta_SH`, normalnej
interfejsu i momentu elektronu. Energia magnetyczna workloadu obejmuje co
najmniej exchange, demag, anisotropy oraz właściwy dla stabilnego skyrmionu
interfacial DMI. Pole Oersteda jest świadomie wyłączone w etapie 1 i jego brak
jest zapisany w `ProblemIR` oraz proweniencji.

## 3. Zamrożony zakres pierwszego workloadu

Pierwszy workload produkcyjny ma następujące granice:

- prostokątny racetrack HM/FM na pełnej strukturze FDM;
- jawne `backend=fdm`, `device=gpu`, `precision=double`, `mode=strict`;
- brak PBC, termicznego szumu, FP32, wielu urządzeń i adaptacyjnej geometrii;
- jedno źródło charge z kompletnymi elektrodami oraz jawnym gauge;
- jeden materiał HM z direct SHE i jeden materiał FM;
- jeden zorientowany interfejs HM/FM z jawnym mixing conductance;
- steady one-way M1 bez iSHE i bez transient spin M3;
- torque transportowy przekazywany device-to-device do RHS LLG;
- deterministyczna relaksacja i deterministyczny przebieg dynamiczny;
- brak pola Oersteda;
- jedna wersjonowana rodzina geometrii i parametrów materiałowych wybrana na
  podstawie literatury przed zakodowaniem fixture.

Wyjście poza ten zakres failuje w plannerze. W szczególności executor nie może
zastąpić GPU przez CPU, FP64 przez FP32, transportowego torque przez prescribed
SOT ani steady spin przez inną formułę.

## 4. Dwanaście bramek realizacji

### 4.1. Bramka 1 — workload, znaki i jednostki

Powstaje wersjonowany fixture zawierający geometrię HM/FM, parametry charge i
spin transportu, parametry magnetyczne, DMI, elektrody, orientację interfejsu,
stan początkowy i harmonogram prądu. Każdy parametr ma źródło, jednostkę SI,
zakres ważności oraz docelowe pole `ProblemIR`.

Bramka przechodzi, gdy Python i UI tworzą semantycznie identyczny znormalizowany
`ProblemIR`, a odwrócenie osi, normalnej lub prądu daje z góry określoną zmianę
znaków wszystkich wielkości pochodnych.

### 4.2. Bramka 2 — rozwiązany charge transport

Publiczny runtime materializuje descriptor FDM/CUDA i tworzy zaakceptowany,
niezmienny snapshot `V`, `J_x`, `J_y`, `J_z`, topologii oraz rewizji źródła.
Akceptacja wymaga lokalnego residual, bilansu elektrod, zgodności gauge i
kontroli numerycznej spójności przewodnika.

Testy obejmują rozwiązanie analityczne jednorodnego przewodnika, odwrócenie
prądu, skalowanie amplitudy, niezależny CPU oracle oraz CUDA FP64 parity.

### 4.3. Bramka 3 — direct SHE i steady spin

Spin solver konsumuje wyłącznie zaakceptowany uchwyt snapshotu charge oraz
jego generację. Wyznacza `mu_s` i jeden globalnie zorientowany tensor fluxu
`Q`. Nie może otrzymywać równoległych, możliwych do podrobienia tablic `J_c`.

Testy obejmują analityczny profil `she_1d_film_v1`, residual lokalny, bilans
spinu, zbieżność przestrzenną, odwrócenie `J_c` i `theta_SH` oraz porównanie
CPU-reference z CUDA FP64.

### 4.4. Bramka 4 — interfejs HM/FM

Zorientowany interfejs publikuje longitudinal injection/backflow, transverse
absorption i odpowiadające im dwa ślady spinowe. Mixing conductance zachowuje
część rzeczywistą i urojoną bez zamiany normalnej interfejsu.

Testy obejmują granicę transparentną, zerowy mixing, czysto rzeczywisty i
czysto urojony mixing, odwrócenie orientacji oraz niezależny bilans momentu
pędu po obu stronach interfejsu.

### 4.5. Bramka 5 — transportowy SOT/STT

Torque jest liczony z objętościowej reakcji spinu i poprzecznej absorpcji
powierzchniowej, następnie mapowany wyłącznie na wskazany ferromagnetyczny
target. Prescribed SOT/STT nie uczestniczy w tym workloadzie.

Testy sprawdzają jednostki RHS LLG, prefaktor, kierunek damping-like i
field-like, odwrócenie prądu, odwrócenie `theta_SH`, target mask oraz zgodność
z niezależnym oraclem algebraicznym i CPU-reference.

### 4.6. Bramka 6 — sprzężenie transportu z LLG

Charge snapshot, spin solve, torque i LLG należą do jednego lifecycle etapu.
Odrzucony krok integratora przywraca magnetyzację, snapshoty pochodne,
telemetrię i liczniki generacji. Zaakceptowany krok publikuje tylko spójny stan.

Testy obejmują stały krok, próbę adaptacyjną, rollback, restart, wszystkie
wspierane integratory jawne oraz zakaz host round-trip w gorącej pętli CUDA.

### 4.7. Bramka 7 — przygotowanie skyrmionu

Racetrack inicjalizuje kanoniczny skyrmion Néela, a następnie relaksuje go bez
prądu i bez transportowego torque. Artefakt stanu równowagi zapisuje pełne `m`,
energię, ładunek topologiczny, środek, promień oraz kryterium stopu.

Stabilność wymaga zachowania znaku i wartości ładunku topologicznego w
zadeklarowanej tolerancji, braku dryfu środka oraz zbieżności energii i promienia
na co najmniej trzech siatkach.

### 4.8. Bramka 8 — dynamika racetracku

Zaakceptowany stan równowagi jest pobudzany rozwiązanym prądem. Publikowana jest
pełna trajektoria `m(t)`, `J_c(t)`, `mu_s(t)`, `Q(t)`, torque oraz pozycja
skyrmionu dla dodatniego i ujemnego prądu oraz co najmniej trzech amplitud.

Test odrzuca anihilację skyrmionu, niekontrolowaną interakcję z krawędzią,
utratę bilansu transportu i nieciągłość stanu na granicach kroków.

### 4.9. Bramka 9 — pomiar kąta Halla

Środek skyrmionu jest wyznaczany z wersjonowanego momentu gęstości ładunku
topologicznego, z jawną obsługą krawędzi. Odcinek transientu jest odrzucany
według kryterium stabilizacji prędkości, a nie ręcznie wybranej liczby ramek.

Na zaakceptowanym oknie wykonywana jest ważona regresja pozycji. Kąt ma
definicję

```math
\Theta_H=\operatorname{atan2}(v_\perp,v_\parallel).
```

Artefakt publikuje `v_parallel`, `v_perp`, `Theta_H`, przedział regresji,
niepewność, residua dopasowania, znak średniego prądu oraz wersję algorytmu.
Testy obejmują syntetyczne trajektorie, odwrócenie osi i prądu, szum pomiarowy,
brak ruchu oraz zbliżenie do krawędzi.

### 4.10. Bramka 10 — porównanie z MuMax3

MuMax3 nie jest oraclem solved-current ani spin accumulation. Porównanie jest
podzielone na dwie jawne części:

1. Fullmag transport jest walidowany przez rozwiązania analityczne,
   CPU-reference, bilanse i zbieżność dla `V`, `J_c`, `mu_s`, `Q` i torque.
2. Zaakceptowany Gilbert-source torque `T_tr_G` Fullmag w `s^-1` jest
   eksportowany jako wersjonowane pole wejściowe `B_eq` w `T`. Dla kanonicznego
   jawnego równania Gilberta obowiązuje dokładnie
   `B_eq = (m × T_tr_G) / gamma_e`; exporter odrzuca nietangentne `T_tr_G`, a
   nie wykonuje ukrytej projekcji. Manifest rozdziela digest źródłowego
   `T_tr_G` od digestu wstrzykniętego `B_eq`, zapisuje `alpha`,
   `gamma_rad_s_T`, konwencję Gilberta oraz zasadę
   `frozen_from_accepted_fullmag_snapshot`. Fullmag i MuMax3 otrzymują
   identyczną geometrię magnetyczną, siatkę, stan początkowy, exchange,
   anisotropy, DMI, demag policy, integrator, krok czasu oraz to samo,
   zamrożone pole `B_eq`.

Porównywane są pełne pola `m(t)`, energia, `Q(t)`, położenie, `v_parallel`,
`v_perp` i `Theta_H`. Osobno raportuje się literalną konfigurację MuMax3 oraz
zbieżniejszą konfigurację demag, aby błąd kernela referencyjnego nie był
przypisany transportowi Fullmag. Kadencja jest częścią tożsamości: fixed-step
Heun, `dt`, czas trwania, `TableAutoSave`, `AutoSave(m)` i digest rzeczywistej
tabeli MuMax3 muszą być zgodne z manifestem. Zgodność tej bramki nie promuje
MuMax3 do orakla transportu i nie pozwala zastąpić solved-current prescribed
torque.

### 4.11. Bramka 11 — pełny kontrakt produktu

Python DSL i Control Room round-tripują każdy parametr fixture bez raw-JSON
obejścia. Brak modułu transportu oznacza brak węzłów charge/spin/torque w
`ProblemIR` i Explorer; zerowy prąd nie decyduje o obecności modułu.

Planner, runtime, OpenAPI, zasoby v2, Inspector, viewport, quantity catalog i
eksport skryptu używają jednego słownika capability. Użytkownik może utworzyć,
uruchomić, obserwować i odtworzyć workload w obu powierzchniach authoringu.

### 4.12. Bramka 12 — kwalifikacja produkcyjna

Końcowy gate uruchamia wersjonowany publiczny scenariusz na zarządzanym
runtime CUDA z zapisaną tożsamością GPU, sterownika, runtime, build digest i
source commit. Obejmuje pełny restart/checkpoint, deterministyczne powtórzenie,
budżet pamięci wyliczony z deskryptora i wolnej pamięci, pomiar wydajności oraz
kontrolę braku niejawnego fallbacku i transferów host-device w gorącej pętli.

Macierz capability otrzymuje awans wyłącznie dla dokładnego tuple i workloadu,
które przeszły wszystkie bramki. Inne siatki, materiały, FP32, PBC, transient
spin, Oersted, FEM i MTJ pozostają niekwalifikowane.

## 5. Warunki fail-closed

Wykonanie kończy się przed publikacją zaakceptowanego stanu, gdy:

- graf transportu, BC, gauge, target albo orientacja interfejsu są niepełne;
- snapshot charge jest obcy, niezaakceptowany, nieaktualny lub ma inną rewizję;
- wymagane pole, operator albo capability nie istnieją dla wymuszonego tuple;
- solver próbuje użyć CPU, FP32 albo prescribed torque jako fallbacku;
- residual, bilans elektrod, bilans spinu lub bilans momentu pędu przekracza
  normatywną tolerancję;
- krok LLG jest odrzucony, a pełny wspólny stan nie został przywrócony;
- skyrmion zanika, opuszcza ważne okno pomiarowe albo algorytm kąta Halla nie
  ma wystarczającego odcinka ruchu ustalonego;
- requested intent, resolved execution i artefakty mają niespójne rewizje.

Nie publikuje się częściowych pól jako zaakceptowanego wyniku naukowego.

## 6. Definicja produkcyjnego ukończenia

Etap 1 jest zamknięty tylko wtedy, gdy:

- wszystkie dwanaście bramek mają świeże, wersjonowane artefakty `pass`;
- publiczny workload działa od Python/UI do zarządzanego CUDA FP64 runtime;
- solved-current, SHE, spin accumulation i torque mają niezależne orakle oraz
  badania zbieżności;
- LLG, trajektoria i kąt Halla przechodzą wspólny-limit comparison z MuMax3;
- CPU-reference i CUDA FP64 są zgodne w zadeklarowanych tolerancjach;
- nie ma ukrytego fallbacku, prescribed torque ani utraty round-trip;
- checkpoint/restart zachowuje tożsamość źródła i wynik w deklarowanym trybie;
- capability matrix promuje wyłącznie dokładnie zakwalifikowany workload;
- plan główny i dokumentacja fizyki zawierają źródła, jednostki, ograniczenia,
  dowody oraz uczciwy zakres kwalifikacji.

Dopiero po spełnieniu tej definicji wolno rozpocząć projekt etapu 2 — pola
Oersteda.
