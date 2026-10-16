# Kontrakt brokera MicroLab–Fullmag v1

Status: **propozycja kontraktu do uzgodnienia z właścicielami MicroLab**. To nie jest opis istniejącego API ani dowód implementacji. Przed kodowaniem MicroLab musi zatwierdzić równoważny, wersjonowany OpenAPI oraz semantykę tożsamości, alokacji, grantów i transferu.

Normatywne słowa MUST, MUST NOT, SHOULD i MAY opisują wymagania przyszłego kontraktu. Nazwy tras poniżej są propozycją; MicroLab może zaproponować inne, jeżeli zachowa semantykę i testy kontraktowe.

## 1. Cel i granice odpowiedzialności

Fullmag tworzy i obserwuje obliczenia HPC wyłącznie przez skonfigurowany broker MicroLab. MicroLab uwierzytelnia użytkownika, przydziela wirtualne środowisko, pośredniczy w dostępie do schedulera i zwraca Fullmagowi zweryfikowany envelope zasobów oraz ograniczony kanał połączenia. Slurm jest pierwszym schedulerem za brokerem. Fullmag MUST NOT uruchamiać sbatch, squeue, sacct, SSH do login node ani równoważnego bezpośredniego adaptera.

Fullmag pozostaje właścicielem kanonicznego ProblemIR/RunSpec, semantyki Study, identyfikatorów Project/Run/Case/Task/Attempt, solvera, walidacji naukowej, manifestów wyników i provenance. MicroLab pozostaje źródłem prawdy dla principalu brokera, lifecycle VM/alokacji, skutecznego przydziału, grantów połączenia i trasowania do schedulera.

Kontrakt obsługuje dwa przepływy:

- Sterowanie kampanią z desktopowego Fullmaga: klient zapisuje trwałą intencję, tworzy alokację przez MicroLab, przesyła immutable wejścia, uruchamia task i uzgadnia wynik.
- Headless Fullmag uruchomiony wewnątrz środowiska utworzonego przez MicroLab: proces wykonuje przyjęty task w przydzielonym scope, bez ujawniania tokenu użytkownika agentowi ani solverowi.

V1 przyjmuje jedną alokację brokera na jeden Fullmag TaskId i AttemptId. Wiele niezależnych przypadków może działać równolegle. Optymalizacja do puli workerów lub Slurm arrays jest późniejszą capability MicroLab; nie zmienia semantyki tasków ani ich izolacji.

## 2. Tożsamości i obiekty

| Obiekt | Właściciel i znaczenie |
|---|---|
| Principal | Stabilny, niezmienny identyfikator zweryfikowany przez MicroLab z tokenu uwierzytelnionego użytkownika. Nie jest polem żądania tworzącego alokację. |
| Fullmag deployment | Prywatny deployment przypisany server-side do principalu. Rozdziela projekty, durable intents, credentials i output catalog. |
| Client intent | Trwała w Fullmag identyfikacja jednego zamiaru utworzenia albo anulowania alokacji. Jest kluczem uzgadniania lost ACK, nie credentialem. |
| Project/Run/Case/Task/Attempt | Kanoniczne identyfikatory domenowe Fullmaga. Ich zakres jest kontrolowany przez Fullmag i nie jest zastępowany identyfikatorem joba schedulera. |
| Broker allocation | Opaque ID zwrócone przez MicroLab wraz z principalem, generacją/incarnation, statusem i audytowalnym envelope. |
| Generation | Licznik przypisany do broker allocation. Restart lub podmiana VM/agent incarnation unieważnia starszy connection grant i wymaga nowego. |
| Resource envelope | Zasoby przyznane przez MicroLab i egzekwowane przez site/OS. Żądanie Fullmaga ani telemetry hosta nie zwiększa envelope. |
| Artifact manifest | Lista niezmiennych obiektów wejścia/wyjścia z SHA-256, rozmiarem, codec/media type i pochodzeniem. Hash potwierdza treść, nie prawo odczytu. |
| Connection grant | Krótko ważne capability do konkretnego allocation, generation, task/attempt, audience i zestawu operacji. Nie jest tokenem użytkownika. |
| Transfer grant | Odrębne krótkotrwałe capability do jednego transferu i kierunku. Nie daje prawa do odczytu innych danych principalu. |

Bieżąca granica kompatybilności Fullmaga to `run_spec.v1`/`run_spec.v2` oraz `run_intent.v1`. Audyt źródeł nie wykazał zaimplementowanego `execution_scope_identity.v1` ani historycznego pola `authority=slurm`; nie należy opisywać ich jako istniejącego kontraktu. Powiązanie z brokerem musi zostać wprowadzone jako jawny, wersjonowany scope/fingerprint po decyzjach H0, z zachowaniem odczytu istniejących RunSpec i RunIntent.

## 3. Uwierzytelnienie i granica zaufania

1. Fullmag wysyła token użytkownika wyłącznie w nagłówku Authorization do skonfigurowanego HTTPS originu MicroLab. Sposób wydania i odnowienia tokenu określa wspierana polityka MicroLab; Fullmag nie zgaduje endpointu token exchange.
2. Fullmag przechowuje token w systemowym magazynie poświadczeń bieżącego użytkownika. Token MUST NOT znaleźć się w przeglądarkowym JavaScript, URL, logach, projekcie, archiwum, RunSpec, Pythonie, zmiennych środowiskowych workera ani argumentach procesu solvera.
3. Fullmag przypina origin brokera w zaufanej konfiguracji, weryfikuje TLS, odrzuca redirecty do innego originu oraz nie przyjmuje hosta MicroLab z projektu, skryptu lub odpowiedzi UI.
4. Principal pochodzi wyłącznie z uwierzytelnionego kontekstu MicroLab. Broker MUST zwrócić stabilną tożsamość albo udostępnić równoważny, serwerowo weryfikowalny introspection contract. Samo dekodowanie tokenu, nazwa konta lub pole przesłane przez Fullmag nie jest dowodem principalu.
5. Każdy odczyt, mutacja, transfer i anulowanie są autoryzowane względem principalu; zasób obcego principalu jest ukryty jako 404 albo równoważna odpowiedź niewyciekająca istnienia.
6. VM i agent nie otrzymują tokenu użytkownika MicroLab ani Fullmag service bearer. Agent otrzymuje wyłącznie osobny grant ograniczony do jego allocation/generation/task/attempt. Grant jest przesyłany nagłówkiem Authorization, nigdy w query string lub URL.
7. Grant połączenia wiąże target audience i tożsamość agent incarnation. Fullmag sprawdza endpoint i tożsamość połączenia z odpowiedzi brokera. Agent odrzuca grant przeterminowany, unieważniony, o złej generacji, principalu, audience lub task/attempt.

Token użytkownika MicroLab i lokalny Fullmag service bearer są odrębnymi poświadczeniami, nie są wymienne i nie trafiają do siebie nawzajem. Fullmag nie wysyła swojego service bearer do MicroLab, chyba że przyszły, osobno zatwierdzony kontrakt zdefiniuje klienta service-to-service. Frontend rozmawia wyłącznie z typed API Fullmaga; nie łączy się bezpośrednio z brokerem i nie otrzymuje tokenu użytkownika MicroLab.

## 4. Proponowany HTTP surface

Wszystkie operacje control-plane używają uwierzytelnienia użytkownika MicroLab. Odpowiedzi JSON zawierają contract_version=fullmag-broker.v1. Zmiana zachowania niezgodna wstecz wymaga nowej wersji i wspieranego okresu migracji.

| Operacja | Proponowana trasa | Gwarancja |
|---|---|---|
| Odczyt capability i limitów | GET /api/v1/fullmag/capabilities | Negocjacja wersji, runtime packów, protokołów, limitów transferu i opcji wykonania. Brak wymaganej capability blokuje submit. |
| Utworzenie alokacji | POST /api/v1/fullmag/allocations | Wymaga Idempotency-Key równemu trwałemu client_intent_id. |
| Uzgodnienie zamiaru | GET /api/v1/fullmag/allocations/by-intent/{client_intent_id} | Odczyt wyłącznie w obrębie principalu; używany po utracie odpowiedzi. |
| Odczyt alokacji | GET /api/v1/fullmag/allocations/{allocation_id} | Zwraca aktualny ETag, revision, generation, lifecycle i skuteczny envelope. |
| Anulowanie | POST /api/v1/fullmag/allocations/{allocation_id}/cancel | Idempotentne, warunkowe przez If-Match; nie oznacza natychmiastowego zakończenia procesu ani usunięcia wyników. |
| Uzyskanie connection grant | POST /api/v1/fullmag/allocations/{allocation_id}/connection-grants | Wymaga wskazania aktualnego generation oraz task/attempt; zwraca krótko ważny grant i zweryfikowane endpointy. |
| Unieważnienie connection grant | POST /api/v1/fullmag/connection-grants/{grant_id}/revoke | Idempotentne; broker odrzuca następne attach z tym grantem. |
| Rozpoczęcie transferu | POST /api/v1/fullmag/allocations/{allocation_id}/transfers | Idempotentne; wiąże kierunek, manifest, allocation/generation i task/attempt. |
| Stan/wznowienie transferu | GET /api/v1/fullmag/transfers/{transfer_id} | Zwraca zaakceptowane chunki, brakujące zakresy, expiry i aktualną wersję transferu. |
| Zapis albo odczyt chunka | PUT lub GET /api/v1/fullmag/transfers/{transfer_id}/chunks/{index} | Wymaga transfer grant w Authorization; granice, SHA-256 i kierunek są sprawdzane przez broker. |
| Publikacja kompletnego transferu | POST /api/v1/fullmag/transfers/{transfer_id}/complete | Broker weryfikuje całość, atomowo publikuje manifest/receipt i odrzuca niepełne lub niespójne dane. |

MicroLab może dostarczyć równoważny transport, np. agentowy relay, jeżeli OpenAPI opisze tę samą autoryzację, idempotencję, resume, integrity, ownership i lifecycle. Nie należy implementować klienta na podstawie samych proponowanych nazw tras.

## 5. Schematy i semantyka żądań

### 5.1 Capability

Odpowiedź capabilities MUST zawierać:

- contract_version i obsługiwane schematy RunIntent;
- stabilny principal_ref i deployment binding wyprowadzony z uwierzytelnienia, bez ujawniania sekretów;
- feature flags: allocation_create, reconcile_by_intent, cancel, connection_grant, resumable_transfer, input/output manifest, optional allocation_pool i scheduler_array;
- akceptowane architektury/OS ABI/runtime pack SHA-256, solver lanes, precision oraz ograniczenia profili zasobów;
- limity: maksymalny rozmiar artefaktu, transferu i liczby obiektów, chunk size, liczba równoległych chunków, deadline i zasady retencji;
- obsługiwane typy endpointów agenta i wymaganą metodę weryfikacji jego tożsamości.

Capability jest wiążąca dla żądania. Fullmag nie może cicho zmienić wymaganego runtime, lane, GPU, precision ani formatów wyniku, aby dopasować je do środowiska.

### 5.2 RunIntent utworzenia alokacji

Żądanie POST /allocations MUST zawierać:

- contract_version;
- client_intent_id będący UUID o wystarczającej losowości, zapisany trwale przed pierwszym requestem;
- Fullmag project_id, run_id, task_id i attempt_id;
- hash kanonicznego, zaakceptowanego RunSpec/ProblemIR i input manifestu;
- solver/runtime identity: Fullmag release/build artifact SHA-256, architektura, ABI, backend lane, requested/resolved device, precision oraz wymagane capabilities;
- requested_resources w jednoznacznych jednostkach: cpu_threads, memory_bytes, wall_time_seconds, devices i opcjonalny broker profile_ref;
- żądane output format ids i politykę publikacji; przykładowo HDF5 lub Zarr jest formatem payloadu Fullmaga, nie formatem konwersji MicroLab;
- zaakceptowane artefakty wejściowe z manifestu.

Principal, broker allocation ID, skuteczny resource envelope, VM endpoint, job ID schedulera i state revision MUST NOT być przyjmowane od klienta jako autorytatywne wartości. Broker przypisuje i zwraca je sam.

Powtórzenie identycznego client_intent_id i kanonicznie identycznego ciała zwraca ten sam allocation ID oraz jego aktualny stan. To samo ID z innym ciałem zwraca 409 idempotency_conflict. Rekord idempotencji trwa co najmniej tak długo jak alokacja i okres odzyskiwania/retencji ustalony przez MicroLab; usunięcie rekordu nie może umożliwić przypadkowego ponownego utworzenia aktywnego joba.

Pierwsze zaakceptowanie żądania zwraca 202 Accepted wraz z allocation_id, client_intent_id, ETag, state_revision i aktualnym state. Ponowienie tego samego intent zwraca 200 OK z tym samym allocation_id i najnowszym stanem. Odpowiedź błędu przed utworzeniem alokacji musi zawierać jawny kod, który odróżnia odrzucenie od unknown outcome.

### 5.3 BrokerAllocation i ResourceEnvelope

Odpowiedź alokacji MUST zawiera allocation_id, client_intent_id, zweryfikowany principal_ref, contract_version, allocation_generation, monotoniczną state_revision/ETag, lifecycle state, czas utworzenia i aktualizacji oraz skuteczny resource envelope.

Resource envelope MUST odróżniać request od grant i opisywać:

- liczbę CPU/threads i ich binding albo potwierdzony limit OS;
- memory_bytes i źródło egzekwowania limitu;
- absolutny deadline/walltime;
- urządzenia GPU ze stabilną identyfikacją w obrębie allocation oraz przyznaną pamięcią/limitem, jeżeli dotyczy;
- architekturę, ABI, runtime image/pack digest;
- allocation identity i generation, na których opiera się dowód grantów.

Wartości requested mogą być większe od zwróconego grant tylko wtedy, gdy Fullmag jawnie dopuściło dany zakres podczas planowania. Wymuszony backend/device nie może mieć cichego fallbacku. Telemetry, hostname, scheduler job ID, kolejka ani ustawienie środowiska nie zwiększają grantów.

### 5.4 Stany

Broker raportuje stan alokacji z zamkniętego, wersjonowanego zbioru co najmniej: accepted, queued, provisioning, ready, stopping, cancelled, failed, expired. Agent raportuje osobny stan task attempt: staged, queued, running, cancelling, succeeded, failed, cancelled. Client-side unknown jest stanem obserwacji Fullmaga, a nie terminalną odpowiedzią brokera.

Każda zmiana stanu zwiększa state_revision i aktualizuje ETag. Przejścia są monotoniczne albo mają jawne zdarzenie reconciliation z audit trail. Utracony ACK nie jest odrzuceniem ani sukcesem. Restart VM/agent zmienia allocation_generation i unieważnia wszystkie granty starszej generacji. Ponowienie obliczenia oznacza nowy Fullmag AttemptId zgodnie z retry policy; nie wolno ponownie wykonać starego attempt pod tym samym receipt.

Status może być odpytywany przez GET z If-None-Match. Push events/SSE są opcjonalnym usprawnieniem, nie źródłem prawdy.

### 5.5 ConnectionGrant i TransferIntent

Żądanie connection-grants zawiera allocation_generation, task_id, attempt_id oraz żądane operacje z zamkniętego zbioru capability. Odpowiedź zawiera grant_token, grant_id, principal_ref, allocation_id, allocation_generation, task_id, attempt_id, audience, issued_at, expires_at, allowed_operations i endpoints. Każdy endpoint zawiera protocol, broker-attested target identity oraz dane TLS/mTLS potrzebne do jej weryfikacji. Endpointów nie wolno wnioskować z hostname, numeru joba ani zmiennej środowiskowej. Grant nie może przekraczać żądanych praw; wznowienie VM wymaga nowego generation i grantu.

Rozpoczęcie transferu zawiera contract_version, transfer_intent_id, direction, allocation_generation, task_id, attempt_id oraz manifest_digest i manifest artifacts. Każdy artifact zawiera artifact_id, role, logical_name, sha256, byte_length, media_type i codec/schema_version. Odpowiedź zawiera transfer_id, principal_ref, allocation_id, generation, attempt_id, direction, state, chunk_size_bytes, chunk_count, max_parallel_chunks, expires_at, transfer_grant, missing_chunks i request_id. Serwer MAY zwrócić gotowe endpointy, lecz grant nadal musi być w nagłówku Authorization, a nie w URL. Ponowienie identycznego transfer_intent_id zwraca ten sam transfer_id i nowe ograniczone transfer_grant; nie tworzy drugiej kopii.

GET transfer status używa tokenu użytkownika i ponownie sprawdza ownership. Operacje na bajtach i complete wymagają transfer_grant. Upload klienta i stage-out agenta są różnymi kierunkami z osobnym grantem; agent nie może użyć tokenu klienta. Finalizacja zwraca immutable transfer receipt z manifest_digest, obiektami zweryfikowanymi po SHA-256, allocation/generation, task/attempt, principal_ref i czasem publikacji.

## 6. Durable intent, reconciliation i anulowanie

Fullmag najpierw atomowo zapisuje client_intent_id, principal/deployment binding, kanoniczny request fingerprint, Run/Task/Attempt, stan pending i znacznik czasu. Dopiero potem wysyła POST. Wysłana intencja pozostaje niezmienna; poprawka zasobów lub solvera wymaga nowego attempt/intentu.

Po timeout, rozłączeniu, restarcie procesu lub błędzie parsowania odpowiedzi Fullmag przechodzi w unknown i uzgadnia stan przez GET by-intent albo ponowne POST z tym samym kluczem oraz identycznym ciałem. Nie tworzy drugiego klucza i nie retryuje z losowym allocation ID, dopóki broker nie potwierdzi odrzucenia albo braku aktywnej alokacji. Jeżeli broker jest nieosiągalny, UI/CLI pokazuje outcome unknown i blokuje duplikujące działanie.

Anulowanie:

- ma własny durable cancel_intent_id i idempotency key;
- wysyła aktualne If-Match/ETag i dokładny allocation_id + generation;
- jest bezpieczne do ponowienia z tym samym intencją;
- niezgodny If-Match/ETag zwraca 412 precondition_failed; nieaktualny allocation_generation zwraca 409 generation_conflict. Fullmag odczytuje wtedy stan i nie anuluje nowej generacji bez jawnego ponownego zamiaru;
- kończy allocation/attempt zgodnie z receipt brokera, ale nie usuwa accepted input ani opublikowanych wyników;
- nie upoważnia do czyszczenia cudzych scratch, outputów lub artifacts.

Każda odpowiedź błędu ma stabilne pola code, request_id, retryable i opcjonalne field_errors/retry_after_seconds, bez sekretów. 400 oznacza niepoprawny schemat/żądanie, 401 brak ważnego uwierzytelnienia, 403 odmowę uprawnień, 404 brak lub ukrycie zasobu obcego principalu, 409 konflikt idempotency/generation/state, 412 niezgodny ETag, 413 limit rozmiaru, 422 nieobsługiwaną wersję/capability, 429 limit z Retry-After, a 5xx błąd serwera. Chwilowa niedostępność także niesie Retry-After. Retry create używa wyłącznie pierwotnej idempotency key. 5xx po wysłanym żądaniu traktuje się jako unknown, chyba że odpowiedź jednoznacznie poświadcza odrzucenie przed mutacją.

## 7. Transfer artefaktów wejściowych i wyników

MicroLab przenosi treść jako nieprzezroczyste obiekty manifestu; nie interpretuje ani nie konwertuje danych naukowych. Format wyniku, w tym HDF5/Zarr, codec, jednostki i semantyka pochodzą z Fullmag artifact contract. Manifest zawiera co najmniej artifact_id, logical_name, role, SHA-256, byte_length, media_type, codec/schema_version, source Project/Run/Task/Attempt oraz read-only flagę dla zaakceptowanego wejścia.

direction=input oznacza przesłanie zaakceptowanych obiektów z klienta Fullmaga do brokerowego agenta/VM przed uruchomieniem taska. direction=output oznacza publikację artefaktów przez agenta/VM i pobranie ich przez autoryzowany Fullmag deployment. W obu kierunkach manifest wiąże tę samą principal/allocation/generation/task/attempt authority; broker nie może zamienić kierunku ani wskazać ścieżki z innego deploymentu.

Rozpoczęcie transferu wiąże transfer_intent_id, allocation_id, generation, attempt_id, direction (input/output) i digest manifestu. Powtórzenie identycznej intencji wznawia ten sam transfer. Wersja kontraktu ustala rozmiar chunku; maksymalny chunk nie przekracza 64 MiB. Każdy chunk podaje indeks, Content-Range i SHA-256. Powtórne wysłanie identycznego indeksu/hash jest idempotentne; różna treść pod tym samym indeksem daje 409. Odczyt statusu zwraca brakujące indeksy. Finalizacja wymaga wszystkich bajtów, sprawdzenia SHA-256 całego obiektu, rozmiaru i manifestu oraz atomowego receipt/pinu przed udostępnieniem readerom.

Broker MUST NOT ujawniać capability transferu w URL, logu lub query. Transfer token jest oddzielny od tokenu użytkownika, ograniczony do transfer_id, kierunku, principalu, allocation/generation i expiry. Transfer można bezpiecznie wznowić po odnowieniu krótkotrwałego grantu; nie wznawia się go przez zmianę digestu.

Wynik zostaje opublikowany jako manifest immutable przed oznaczeniem attempt jako succeeded. Pełny workspace/session store nie jest kopiowany ani współdzielony przez writable network FS. Transfer może pobrać tylko obiekty przypisane autoryzowanemu runowi/deploymentowi; hash nie daje dostępu cross-user.

## 8. Równoległy sweep i wspólny stan równowagi

Współdzielenie stanu jest dozwolone tylko dla zweryfikowanego, immutable equilibrium artifact, którego hash, codec, siatka, materiał, jednostki, lane i kompatybilność runtime zgadzają się z wymaganiami każdego child case. Manifest stanu jest read-only i przypięty do Study. Broker może deduplikować bajty tylko w granicy tenant/principal oraz zachowując ACL; content hash nie omija autoryzacji.

Każdy eigensolve case ma własny CaseId, TaskId, AttemptId, operator, scratch, mutable buffers, output reservation i receipt. Workery dostają ten sam zaakceptowany input hash, ale nie współdzielą żywego obiektu solvera ani mutable GPU memory. Utrata jednego workera nie oznacza sukcesu pozostałych; fan-in jawnie zapisuje coverage/partial status i kolejność CaseId potrzebną do mode tracking.

V1 uruchamia child attempts przez niezależne alokacje. Capability allocation_pool lub scheduler_array może zmniejszyć koszt przydziału dopiero po osobnej weryfikacji envelope każdego child task, fencing, worker loss, walltime/drain, output ownership i cache eviction. Zewnętrzna optymalizacja nie zmienia Study DAG ani publicznego wyniku.

## 9. Wymagania bezpieczeństwa i multi-user HPC

- Dwaj użytkownicy na jednym węźle mają odrębne principal, credentials, deployment namespace, allocations, scratch i output ACL. U1 nie może listować, podłączać, anulować ani sprzątać zasobów U2.
- Jeden użytkownik może utrzymywać co najmniej trzy niezależne task intents równocześnie; każdy ma osobną AttemptId, alokację/grant, deadline, output i stan uzgadniania.
- Porty agenta nie są publicznym API. Inbound i outbound network policy, TLS/mTLS, port allocation i target identity są obowiązkiem MicroLab/site i muszą być opisane w capabilities oraz potwierdzone testem.
- MicroLab ustala i audytuje limity per-user/per-tenant, quota i retencję. Fullmag nie omija ich przez równoległe karty, retry lub kolejne tokeny.
- Uwierzytelnione operacje mutujące i grant issuance są audytowane z principal, allocation, generation, intent, request_id i czasem; sekrety i payloady naukowe nie są logowane.
- Odpowiedzi oraz manifesty mają limity rozmiaru i walidację schematu; nieznane wersje, nadmiarowe zasoby, niezgodny grant, cross-origin endpoint i brak owner binding blokują operację.

## 10. Odbiór kontraktu

Przed napisaniem produkcyjnego adaptera MicroLab musi dostarczyć wersjonowany OpenAPI, przykładowe request/response, state machine, principal claim semantics, resource enforcement evidence, security model connection/transfer grants, retention/quotas, retry/lost-ACK behavior i zgodność backwards. OpenAPI i examples muszą generować sprawdzalne schema/contract tests.

Minimalne testy kontraktu i integracji obejmują:

1. Dwa principals na jednej VM/physical node; brak cross-owner list/read/cancel/transfer.
2. Trzy intents jednego principalu bez kolizji, przekroczenia wspólnych zasobów ani mieszania wyników.
3. Utrata odpowiedzi po create: reconciliation zwraca jeden allocation, bez drugiego scheduler joba.
4. Ten sam key z innym request body: deterministic conflict.
5. Restart agenta i zmiana generation: stary grant odrzucony, nowy grant audytowany.
6. Resource envelope i GPU/CPU binding zgodne z OS/scheduler receipt; request nie podnosi grant.
7. Transfer restartowany po częściowym uploadzie; zły chunk/full-object hash jest odrzucany i nie pojawia się w katalogu.
8. Idempotentne/stale cancel nie usuwa nowego allocation ani obcego projektu.
9. Fan-out N eigensolve cases: wspólny input SHA, odrębny task/output, stabilny fan-in i partial coverage po awarii.
10. HDF5/Zarr i inne dopuszczone output payloady przechodzą bez modyfikacji bajtów.
11. Brak bezpośrednich połączeń/procesów Slurma w kliencie Fullmaga.

Testy kontraktu, symulator, lokalny broker fixture, uruchomiony MicroLab, VM/agent, rzeczywisty HPC i walidacja solvera są oddzielnymi poziomami dowodów. Zielony test lokalny nie oznacza, że MicroLab API istnieje, że VM jest dostępna ani że fizyka/równoległość została zakwalifikowana.

## 11. Stan dowodów i źródła

Read-only przegląd repozytorium amucontainers/containers_admin2 zapisany 16.10.2026 wskazywał clean openapi.json na commit 721c0bc4f29eb43928189f875cc9d7ce84747a65. Opublikowane schematy /api/v1/jobs/ i /api/v1/tasks/ nie opisywały generic Fullmag RunSpec ani VM/allocation lifecycle; POST /jobs/ wymagał template_name, a /tasks/ był związany z plikiem .mx3. Zbadane lokalne pliki auth/jobs były dirty względem tego commita i nie zostały przyjęte jako publiczny kontrakt. Nie modyfikowano repozytorium MicroLab.

W związku z tym trasy i payloady tego dokumentu są propozycją dla wspólnego review, nie działającym endpointem. Bieżący branch Fullmaga dodaje typowany ArtifactTransferManifestV1 oraz lokalnego producenta manifestu zaakceptowanych, zakończonych Study outputów z CAS. Producent nie jest podłączony do trasy ani transportu; obecny wycinek obejmuje wyłącznie magnetization JSON i scalar JSON, a fail-closed odrzuca manifesty z accepted_state_ref lub observation_source, których jeszcze nie serializuje. Nie ma producenta wejść, klienta MicroLab, tokenu, scoped grants, idempotentnego outboxu, HTTP ani importu wyników. Runtime MicroLab, VM, agent, scheduler, transfer, multi-user isolation, sweep i solver pozostają NOT VERIFIED. Zasady allocation envelope opisuje [Compute Resource Execution v1](compute-resource-execution-v1.md), architekturę HPC opisuje [HPC Cluster Execution v1](hpc-cluster-execution-v1.md), a etapy wdrożenia [plan integracji](../plans/active/microlab-fullmag-integration-skeleton-20261016.md) i [checkpoint R2](../plans/active/multi-project-hpc-r2-implementation-checkpoint.md).
