# ADR 0052 — zasoby wykonania i równoległe przypadki sweepu

Status: **accepted** jako architektura objęta zleceniem implementacji użytkownika.
Data: 2026-10-04. Implementacja i kwalifikacja pozostają w toku; accepted
nie oznacza wsparcia wszystkich opisanych ścieżek przez bieżący runtime.

## Kontekst

Fullmag ma publiczne CPU/device controls, StudyPlan, RunSpecification,
resource pools, trwały scheduler i GPU UUID binding w workerze. Ustawienia
wątków są jednak rozwiązywane przez kilka niezależnych warstw, referencja
execution profile nie jest jeszcze pełnym materializerem, a store-local
resource IDs nie dowodzą wyłączności fizycznego hosta między store'ami.
Compute environment pokazuje odczyty; nie jest katalogiem przydziałów.

Użytkownik potrzebuje jednego modelu łączącego Settings, wymagania solvera,
kilka GPU/socketów CPU, równoległe sweeps oraz docelowo distributed solve.

## Proponowana decyzja

1. Rozdzielamy obserwowany ComputeNodeSnapshot, wersjonowaną NodePolicy,
   ExecutionProfile/RunResourceRequest, immutable BatchSpecification oraz
   allocation i executed receipt. Telemetria nie jest rezerwacją.
2. Jeden resolver materializuje profile i jawne override'y do każdego
   kroku Study/ProblemIR oraz RunSpec. Zachowuje Auto, origin i wersje;
   wykrywa sprzeczności backend/device/precision/mode przed Submit.
3. Rozszerzamy istniejący runtime owner/scheduler i store catalogs.
   Wspólny ledger hosta rezerwuje CPU/RAM/GPU/scratch dla wszystkich store'ów,
   preparation i solve. Fenced prepare/commit i reconciliation poprzedzają
   spawn; release wymaga dowodu zakończenia workera.
4. GPU wiążemy po pełnym UUID i potwierdzamy native receipt; ordinal jest
   lokalny dla maski procesu. CPU allocation steruje rzeczywistymi pulami
   i affinity, ze wskazanym poziomem OS enforcement.
5. Independent batch tworzy trwałe child RunIds i stable CaseIds. Liczba
   równoległych cases jest niezależna od liczby GPU/ranków jednego solve'a.
   Continuation/histereza zachowuje zależności stanu.
6. Settings zarządza zasobami i profilami, Study żądaniem wykonania oraz
   osobnymi solver configs, Compute environment pokazuje fakty, Jobs kolejkę,
   a Results rzeczywisty przydział. Wszystko używa typed API/resource hooks.
7. Wielourządzeniowy pojedynczy solve wymaga PartitionPlan, gang admission,
   collective lifecycle i lane/workflow-specific kwalifikacji numerycznej.
   UI nie otwiera tej możliwości na podstawie samej liczby wykrytych GPU.

## Relacja z istniejącymi decyzjami

Rozwijamy [ADR 0049](0049-native-runtime-owner-control.md), zachowując jednego
właściciela wykonania. [ADR 0037](0037-accepted-preparation-resource-admission.md)
nadal oddziela preparation i solve leases. [ADR 0035](0035-typed-study-artifact-manifest-and-worker-boundary.md)
zachowuje typed outputs/CAS/fencing, a [ADR 0051](0051-project-output-storage.md)
jest jedyną polityką output paths/writer/tmp. Nie tworzymy drugiej kolejki
buildów ani drugiej ścieżki publicznego Python DSL.

## Rozważone alternatywy

| Alternatywa | Powód odrzucenia |
|---|---|
| UI edytuje justfile/env | Brak immutable intent, izolacji równoległych workerów i typowanego kontraktu |
| Tylko zwiększyć max-concurrency | Nie rozwiązuje CPU/RAM budget, UUID overlap między store'ami i wątków native |
| GPU count oznacza też concurrency | Miesza niezależne cases z podziałem jednego operatora i jego pamięci |
| Nowa kolejka sweepów obok schedulera | Dubluje admission, fairness, recovery i katalog wyników |
| Najpierw wdrożyć rozproszony solver | Opóźnia niezależne cases i łączy prostszy problem scheduling z osobną numeryką |

## Konsekwencje i migracja

Potrzebne są wersjonowane kontrakty, profile catalog, host ledger, native
receipts i adaptery Windows/Linux. Koszt złożoności jest uzasadniony ochroną
przed podwójnym przydziałem oraz możliwością odtworzenia wyników. Historyczne
runy pozostają czytelne jako legacy/unreported; nowe pola nie fabrykują
brakujących dowodów. Rollback blokuje nowe admission, zachowując aktywne
runy, journal i wyniki. Distributed capabilities pozostają zamknięte do
kwalifikacji konkretnych workflowów.

Pełna [specyfikacja](../specs/compute-resource-execution-v1.md),
[projekt UI](../design/start-screen/docs/10-compute-settings-and-multi-device.md),
[audyt i plan etapów](../plans/active/compute-execution-20261004/README.md)
określają pola, precedence, błędy, przykłady, właścicieli i bramki.
