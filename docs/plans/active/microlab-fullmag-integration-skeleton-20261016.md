# Plan integracji Fullmag przez MicroLab — szkielet i bramki

Data: 16.10.2026. Status: **specyfikacja Fullmag przygotowana jako propozycja; API MicroLab niezatwierdzone, provider/runtime niezaimplementowane i niezweryfikowane**.

Powiązany [proponowany kontrakt MicroLab–Fullmag v1](../../specs/microlab-fullmag-broker-v1.md) jest artefaktem do uzgodnienia z właścicielami repozytorium amucontainers. Nie opisuje istniejącej wersji eksportowej API. Zakres tego etapu obejmuje dokumentacyjny szkielet integracji oraz lokalny kontrakt/producent manifestu zaakceptowanych Study outputów, niepodłączony do sieci. Nie zmieniamy repozytorium MicroLab, nie zgadujemy jego produkcyjnych tras i nie deklarujemy kompletnej implementacji Fullmag.

## Cel produktu

Jeden frontend Fullmaga, CLI i Python API mają tworzyć tę samą kanoniczną intencję Run/Task/Attempt. Provider MicroLab ma uwierzytelnić użytkownika, uzyskać i uzgadniać alokację VM, dostarczyć ograniczony grant agentowi oraz przenieść immutable wejścia i wyniki. Slurm i fizyczna polityka klastra pozostają za brokerem.

System ma bezpiecznie obsłużyć dwóch różnych użytkowników oraz wiele równoległych zadań jednego użytkownika na współdzielonym węźle. Sweep ma przekazywać te same zweryfikowane, immutable dane wejściowe wielu workerom, przy jednoczesnym rozdzieleniu ich attemptów, zasobów, scratch i outputów.

## Decyzje przyjęte

- MicroLab jest jedyną granicą połączenia Fullmaga z HPC; Slurm jest pierwszym schedulerem za brokerem.
- Broker principal i przyznane envelope pochodzą z uwierzytelnionej odpowiedzi MicroLab, nie z request body, nazwy konta, hostname ani scheduler job ID.
- Token MicroLab pozostaje po stronie klienta Fullmaga w magazynie poświadczeń OS. Agent, worker, Python, solver, logi i URL nigdy go nie otrzymują.
- Jeden durable idempotent intent odpowiada jednej alokacji na TaskId/AttemptId w pierwszym brokerowym zakresie. Timeout wymaga reconciliation po tym samym intent, a nie nowego create.
- V1 przenosi opaque, versioned artifact manifests z SHA-256. Fullmag jest właścicielem formatu HDF5/Zarr/pozostałych danych; broker ich nie konwertuje.
- Wspólny stan sweepu jest immutable i read-only. Każdy case ma własny task/attempt, mutable runtime, scratch, output i receipt. Broker pool/arrays mogą być późniejszą optymalizacją.
- Bieżący source contract zachowuje odczyt `run_spec.v1`/`run_spec.v2` i `run_intent.v1`; nowe authoringowe intencje używają `run_spec.v3` z jawnym `execution_target.v1` (`local` albo wersjonowany profil `microlab`). Target wchodzi do fingerprintu, ale nie jest brokerowym scope/principalem. Nie ma implementacji `execution_scope_identity.v1` ani historycznego `authority=slurm`. Allocation identity, principal, grants i klient MicroLab pozostają niezaimplementowane.

## Etapy i odbiór

| Etap | Zakres | Kryterium zakończenia | Status |
|---|---|---|---|
| S0 — kontrakt propozycji | Dokumenty, endpoint semantics, schemas, security, reconciliation, resources, transfers, sweeps i test matrix | Repozytoryjna propozycja wewnętrznie spójna; stan API i granice dowodów jawne | **Wykonane dokumentacyjnie** |
| S1 — uzgodnienie MicroLab | Review przez właścicieli amucontainers; wybór auth flow, principal claim, tras/DTO, lifecycle, versioning, quota, transfer i network grants | Zatwierdzony OpenAPI z przykładami, błędami, state machine i contract tests; wskazany snapshot/commit API | **Oczekuje na właścicieli MicroLab** |
| S2 — broker schema i auth w Fullmag | Typowane capability/intent/allocation/grant/resource receipt; broker origin pin; credential OS vault; secret redaction; osobny scope v2 | Server-side owner jest potwierdzony; brak bearer w browser/Python/worker; stare v1 bytes zachowane; source checks i testy kontraktu | **Nie rozpoczęto** |
| S3 — trwała alokacja i recovery | Fullmag durable outbox, idempotent create, by-intent reconcile, ETag/generation fencing, cancel, restart/unknown outcomes | Lost ACK, restart po submit, duplikat, stale cancel i obcy principal przechodzą testy; brak ślepego retry | **Nie rozpoczęto** |
| S4 — staging i wyniki | Resumable transfer grants, manifesty, limity/hash/pin, output receipt i rehydracja do autoryzowanego katalogu | Awaria na granicy chunka jest recoverable; uszkodzone/obce dane nie stają się widoczne; HDF5/Zarr pozostają byte-identical | **Nie rozpoczęto** |
| S5 — wspólny produkt | Ten sam RunIntent z UI, CLI i Python; projekty/taby; odłączenie UI; reopen/reconcile; stany i partial results | Jeden submit niezależnie od liczby widoków; dwa principals i trzy taski jednego użytkownika nie mieszają scope'ów; wyniki mają provenance | **Nie rozpoczęto** |
| S6 — sweep fan-out i optymalizacja | Relax → zatwierdzony equilibrium artifact → N eigensolve cases → typed fan-in; później pool/arrays po pomiarze | N workerów potwierdza ten sam input hash, ma oddzielne mutable buffers/outputy, a partial coverage/mode tracking są poprawne | **Nie rozpoczęto; broker capability do uzgodnienia** |
| S7 — eksport i kwalifikacja | Wersja eksportowa Fullmaga, API/VM site profile, security, runtime, nauka, wydajność i operacyjne recovery | Powtarzalne receipts dla realnego MicroLab/VM i przydziału Slurm, testów wielu użytkowników, solver lane oraz eksportu | **DEFERRED — brak eksportowalnej wersji Fullmaga i dostępu do klastra** |

## Wymagane decyzje i artefakty po stronie MicroLab

Przed S2 właściciele MicroLab muszą dostarczyć lub zatwierdzić:

1. Wspierany login/token acquisition, token audience/expiry/revocation oraz stabilny, niezmienny principal ID.
2. Create/read/cancel lifecycle VM/alokacji i query po idempotency intent.
3. Definicję generation/incarnation, stanów, ETag, lost-ACK i retry.
4. Pola request/grant zasobów wraz z dowodem egzekwowania przez site/OS.
5. Connection grant: audience, expiry, operacje, endpoint transport, TLS/agent identity, revoke/renew.
6. Input/output manifest, chunk/resume/progress/finalize oraz ACL, quota, retention i GC.
7. Semantykę HPC account/partition/QoS wewnątrz profilu MicroLab tak, aby Fullmag przekazywał abstrakcyjny broker profile, a nie wywoływał scheduler.
8. Capability flags dla Slurm arrays/pool i ograniczenia ich użycia.
9. Opublikowany OpenAPI, conformance fixtures oraz versioned release/commit do przypięcia przez Fullmag.

Jeśli istniejące MicroLab API nie może spełnić jednego z warunków, S1 ma zarejestrować konkretną zmianę kontraktu po stronie MicroLab. Fullmag nie implementuje równoległych prywatnych endpointów ani nie interpretuje nieudokumentowanych pól z dirty development code.

## Pierwszy vertical slice po S1

Po potwierdzeniu S1 rekomendowany jest ograniczony slice: użytkownik uwierzytelnia się do przypiętego broker originu; Fullmag utrwala jeden intent; broker zwraca allocation i envelope; klient uzgadnia lost ACK; Fullmag uzyskuje krótkotrwały agent grant; przesyła jeden immutable input bundle; uruchamia jeden zaakceptowany task; agent publikuje jeden output manifest; Fullmag weryfikuje receipt i pokazuje provenance.

Slice początkowo ma tylko jawnie obsługiwany backend/lane/runtime pack. Brak capability, auth, zasobów, zgodnego solvera lub artifact codec blokuje submit z konkretnym powodem. Nie wprowadza bezpośredniego Slurma, automatycznego GPU/CPU fallbacku, konwersji danych w brokerze ani sweeps przed domknięciem H4.

## Kryteria i granice dowodów

- Dokument/parser/link checks dotyczą tylko S0.
- Contract fixture lub mock potwierdza serializację i logikę klienta, nie działanie API/VM.
- Source check nie potwierdza usługi MicroLab, authz, grantów ani bezpieczeństwa sieci.
- Lokalny worker test nie potwierdza izolacji dwóch realnych użytkowników HPC.
- Wykryty GPU ani syntetyczny resource envelope nie potwierdzają scheduler/OS enforcement.
- Test przekazywania pliku nie potwierdza parytetu fizyki, jakości równowagi, kompletności sweepu ani mode tracking.
- Pełna kwalifikacja wymaga exportable Fullmag runtime, zatwierdzonego MicroLab endpointu, VM/agent, site profile oraz osobnych security/runtime/science receipts.

Do czasu S1 API jest **NOT VERIFIED**. Do czasu S7 produkcyjny MicroLab/HPC provider, multi-user isolation, sweeps i solver execution są **NOT VERIFIED**. Stan szczegółowy R2 pozostaje w [checkpoint implementacji](multi-project-hpc-r2-implementation-checkpoint.md).
