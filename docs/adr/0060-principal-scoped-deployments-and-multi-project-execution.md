# ADR 0060 — deploymenty przypisane do principalu i wiele projektów

Status: **accepted for Fullmag-side R2 implementation**. Kontrakt HTTP/API MicroLab pozostaje propozycją do zatwierdzenia przez właścicieli brokera w S1; ta decyzja nie jest dowodem działającej ani zakwalifikowanej integracji HPC.
Data: 16.10.2026.

## Kontekst

Fullmag ma obsłużyć wiele otwartych projektów i równoległych obliczeń w jednym
frontendzie, a także dwóch różnych użytkowników na tym samym węźle oraz wiele
zadań jednego użytkownika. W HPC Fullmag łączy się wyłącznie przez MicroLab;
Slurm jest adapterem brokera, nie dostępnym dla Fullmaga API.

Bieżący API ma procesowe `AppState.current_live_state` oraz rozbudowany zestaw
tras `/v2/sessions/current/...`. `x-fullmag-session-scope` wiąże żądanie z
bieżącą sesją/epoką/instancją API i odrzuca opóźnione żądania, ale nie
uwierzytelnia użytkownika. `local_compute_operator_token` jest krótką
zdolnością lokalnego operatora wyłącznie do zapisów NodePolicy, nie principalem
MicroLab. Kernel frontendu ma pojedynczy mutable `ProjectDocumentController`.

Źródła zachowują odczyt `run_spec.v1` i `run_spec.v2`, a nowe zlecenia
używają `run_spec.v3` z `execution_target.v1`; zewnętrzna koperta pozostaje
`run_intent.v1`. Nie ma implementacji `execution_scope_identity.v1`. RunSpec
opisuje zaakceptowaną pracę, ustawienia solvera i wybrany provider/profile,
ale nigdy tożsamość principalu ani credential.

## Decyzja

1. **Granica tenantów:** pierwszy release używa prywatnego Fullmag deploymentu
   przypisanego do jednego principalu i jego SessionStore. Lokalny deployment
   działa w granicy konta OS; deployment HPC jest przypisany server-side do
   principalu uwierzytelnionego przez MicroLab. Tożsamość pochodzi z zaufanej
   warstwy auth/OS, nigdy z ProjectId, nazwy, ścieżki, hostname, scheduler job
   ID, headera request scope ani treści RunSpec.
2. **Brak wspólnego multi-user API w pierwszym release:** współdzielony proces
   Fullmaga nie może obsługiwać wielu principalów, dopóki nie ma kompletnego
   auth middleware, per-principal ACL dla projektów/runów/CAS, izolacji
   pamięciowych cache/realtime oraz testów odmowy między tenantami. Oddzielne
   deploymenty i OS/broker ACL są granicą izolacji; service bearer do lokalnych
   operacji nie zastępuje tego kontraktu.
3. **Wiele projektów w jednym deployment:** jeden principal może mieć wiele
   otwartych dokumentów i kart oraz równoległe Task/Attempt. Dokument ma własny
   authoring, revisions, drafty, selekcję, historię i widok. Zamknięcie lub
   przełączenie karty nie zatrzymuje runu. UI utrzymuje najwyżej jeden aktywny
   renderer 3D; nieaktywne karty nie subskrybują ciężkich zasobów.
4. **Izolacja prób:** każdy Task/Attempt ma własne admission/allocation,
   process attempt, scratch/tmp, logi, output i receipt. Sweep może współdzielić
   wyłącznie immutable, zweryfikowane wejścia po digest; workery nie zapisują do
   wspólnego stanu wejściowego. Jedna alokacja brokera na Task/Attempt jest
   pierwszym zakresem; pule/arrays są późniejszą optymalizacją MicroLab.
5. **Rozdział danych i authority:** RunSpecification/ProblemIR opisują co
   rozwiązać i requested execution. `run_spec.v3` zawiera jawny
   `execution_target.v1`: `local` albo `microlab` z `profile_id` i
   `profile_revision`. To wybór wykonania, nie principal/DeploymentId,
   allocation, generation ani grant. Interfejsy UI, CLI i publiczny Python
   muszą używać tego samego kontraktu. Principal i grants są wiązane wyłącznie
   po stronie zaufanego API/provider adaptera.
6. **API sesji:** nowe operacje adresują jawny Project/Session/Run/Task scope,
   expected revision i deployment context. `/v2/sessions/current/...` pozostaje
   nazwanym adapterem zgodności do czasu migracji konsumentów i osobnej bramki
   usunięcia. `x-fullmag-session-scope` nadal służy fencingowi stale-request i
   cache, nigdy autoryzacji. Zmiana scope API nie może adoptować innego
   principalu ani innego deploymentu.
7. **HPC:** Fullmag rozmawia wyłącznie z przypiętym broker originem MicroLab.
   Broker uwierzytelnia principal, tworzy/uzgadnia allocation i dostarcza
   skuteczny envelope. Slurm, login node, SSH, sbatch/squeue/sacct oraz
   scheduler credentials pozostają poza Fullmag. Worker otrzymuje tylko grant
   ograniczony do allocation/generation/Task/Attempt; nigdy token użytkownika.
8. **Legacy:** zachować odczyt RunSpec v1/v2 i RunIntent v1 bez
   przepisywania ich payloadów. Brak targetu w v1/v2 rozwiązuje się jako
   `local` tylko w pamięci; nowe authoringowe zlecenia zapisują jawny target
   w v3, który wchodzi do fingerprintu. Brak scope dla historycznego runu
   pozostaje `legacy/unreported`, nie jest uzupełniany domysłem.

## Rozważone alternatywy

| Alternatywa | Decyzja |
|---|---|
| Jeden wspólny Fullmag API/store dla wielu użytkowników | Odrzucone w pierwszym release: obecny procesowy stan i cache nie są tenant-scoped; wymaga osobnego projektu pełnego auth/ACL/memory-isolation. |
| Osobny Fullmag backend dla każdej karty lub Taska | Odrzucone: powiela runtime ownera i store, komplikuje sweeps, recovery i resource admission. |
| Jeden przydział GPU/VM na użytkownika, współdzielony przez dowolne taski | Odrzucone: nie zapewnia Task/Attempt fencing, sumowania envelope ani oddzielnych scratch/output. |
| Bezpośredni provider Slurm w Fullmag | Odrzucone: MicroLab jest zatwierdzoną granicą auth/VM/brokera; Fullmag nie przechowuje credentials klastra. |

## Konsekwencje, migracja i dowody

Najpierw powstaje typed authority/scope, potem jawny rejestr dokumentów i
sesji, scoped transport/commands/realtime, a następnie frontendowe karty i
równoległe wykonanie. Zmiany scope wymagają OpenAPI i wygenerowanych typów;
komponent React nie tworzy własnego fetch ani własnego modelu API. Stary
`current` pozostaje adapterem do czasu udowodnionej migracji.

Wymagane bramki obejmują dwóch różnych principalów na jednym węźle (brak
cross-read/attach/cancel/delete), trzy równoległe zadania jednego principalu
(oddzielne allocation/attempt/tmp/output), delayed A response po przełączeniu
na B, reconnect po restarcie API oraz sweep z tym samym input digest i
niezależnymi writable outputami. Źródła, kontrakty i lokalne smoke nie
zastępują dowodu MicroLab/VM/Slurm ani kwalifikacji naukowej.

Szczegóły etapów: [R2 HPC](../plans/active/multi-project-hpc-execution-20261005.md),
[R2 integration skeleton](../plans/active/microlab-fullmag-integration-skeleton-20261016.md),
[multi-project tabs](../plans/active/multi-project-tabs-20261005.md),
[compute resource execution](../specs/compute-resource-execution-v1.md),
[MicroLab broker proposal](../specs/microlab-fullmag-broker-v1.md).
