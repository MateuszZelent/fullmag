# Natywna usługa runtime — kontrakt v1

Data: 03.10.2026. Status: implemented in source; runtime NOT VERIFIED.
Decyzja: [ADR 0049](../adr/0049-native-runtime-owner-control.md).

## Proces i konfiguracja

Program `fullmag-runtime-service --config <absolute-json-path>` nie wymaga
Docker, WSL ani Linux na Windows. Nie otwiera UI. Domyślny produktowy start,
discovery klienta i UI attach/detach pozostają osobną integracją P7-C.

Konfiguracja ma maksymalnie 64 KiB, odrzuca nieznane pola i wymaga:

| Pole | Kontrakt |
|---|---|
| schema_version | runtime_service_config.v1 |
| store_root | Absolutny root istniejącego SessionStore, bez parent traversal; ten sam co API. |
| target_id | Portable repository ID targetu lokalnego. |
| compute_pool_id / preparation_pool_id | Różne portable ID. |
| compute_resources | Niepuste jawne FmsSchedulerResourceOffer CPU/GPU. |
| preparation_resources | Niepuste jawne FmsPreparationResourceOffer. |
| worker_timeout_seconds / preparation_timeout_seconds | Dodatnie istniejące timeouty supervisorów. |
| heartbeat_interval_milliseconds | Dodatni interwał heartbeatów workera/preparera. |
| startup_timeout_seconds | Dodatni, maksymalnie 300 sekund na publisher i każdy boot/ready handshake. |
| drain_timeout_seconds | Dodatni deadline wspólnego drain obu schedulerów. |

Budżety są konfiguracją operatora, nie pomiarem sprzętu. Żadna domyślna oferta
nie udaje wykrytej pamięci ani GPU. ID zasobów solve i preparation są rozłączne;
operator musi przydzielić budżety mieszczące się we wspólnej pojemności hosta.
Scheduler compute ma max-concurrency=1, max-tasks=0 i brak automatycznych retry;
preparation ma osobny max-concurrency=1. Dostępność wykonania pozostaje określona
przez istniejący planner/worker; deklaracja GPU nie daje cichego fallbacku CPU.

## Własność i kolejność

Jedna blokada runtime-services/OWNER.lock obejmuje cały store. Jest stabilnym
native file lock, nie plikiem PID. OWNER.json zawiera ostatni obserwowany stan,
token instancji/procesu, host/PID/target, generacje pul, adres sterowania i dzieci.
Starting/ready/draining/unknown po utracie blokady wymagają kontrolowanego recovery.
Nie kasować ownera ani lease’ów w celu obejścia tej odmowy.

1. Walidacja konfiguracji, pełnej tożsamości source-pinned buildu i binariów.
2. Zajęcie ownera; publikacja compute/preparation przez CAS generacji.
3. Start obu schedulerów z --startup-gate stdin-v1 i --owner-control stdin-v1.
4. Oba boot events zgodne z PID/owner/rolą/protokołem/commit/snapshot.
5. Bajt 0x01 zwalnia początkową bramkę obu schedulerów; dopiero wtedy otwierają store.
6. Oba ready events zgodne także z pool ID i generacją; owner ready.
7. UI jest klientem; jego zamknięcie nie zamyka writerów schedulerów.

Po początkowej bramce kolejny bajt 0x01 żąda drain. EOF przed bramką odrzuca
startup; EOF po niej drenuje i kończy scheduler błędem. Logi dzieci pozostają
w runtime-services/<owner-token>; odczyt eventów jest ograniczony do 64 KiB
początku lub końca pliku. Retencja wieloletnich logów pozostaje do integracji.

## Prywatny kanał sterowania

Usługa nasłuchuje wyłącznie na losowym porcie IPv4 loopback. Adres jest w
owner descriptor. Klient wysyła JSON zakończony LF, maksymalnie 4096 bajtów:

```json
{"schema_version":"runtime_service_control.v1","owner_token":"<token-z-descriptora>","command":"drain"}
```

Nieznane pola, wersja, polecenie i obcy token są odrzucane. Timeout klienta
nie jest dowodem zatrzymania. Odpowiedź draining potwierdza żądanie; terminalne
zakończenie potwierdza dopiero owner drained wraz z wynikami obu procesów.
Ready w pliku nie dowodzi żywego ownera: przyszły attach musi sprawdzić kanał
instancji i build, nie bazować na wieku/PID ani samym pliku.

Oba admissions zamyka się przed oczekiwaniem na procesy. Aktywne workery kończą
się według supervisor/lease/receipt. Błąd jednego schedulera drenuje drugi,
lecz owner kończy jako failed/unknown, nigdy jako poprawny drained.

## Eksport i dowody

Operational lock/descriptor/logs nie zawierają korzeni naukowych CAS i nie są
pakowane do FMS. Import nie przejmuje katalogu runtime-services i zachowuje
wymóg pustego staging store. Nie resetuje to żadnej istniejącej sesji.

Wymagane dowody runtime: single-owner conflict, boot mismatch przed admission,
ready obu schedulerów, zamknięcie UI podczas runu, reconnect, drain obu przy
awarii jednego, invalid token bez mutacji, service crash → EOF drain, restart
bez automatycznego przejęcia unknown, Windows bez konsoli i osobno Linux.
Kontrole parsera i pakowania nie zastępują tych bramek ani kwalifikacji fizyki.

Publikatory oraz obaj schedulery i ich workery wymagają zgodnej tożsamości
commita/snapshotu przekazanej przez ownera. Deadline publikatora lub drain
nie zabija niepotwierdzonego procesu: owner zapisuje unknown z PID dziecka,
pozostawia lease’y i blokuje automatyczny restart. Częściowa publikacja puli
zachowuje faktycznie odczytane generacje, także gdy druga publikacja zawiodła.
Ready przygotowania nie zależy od wolnego slotu: jest ogłaszane przed recovery
aktywnych lease’ów. Timeouty pracy/drain mają limit jednego roku, heartbeat
maksymalnie godzinę; nie zmieniają semantyki solvera ani Stop zadania.

Terminalny odczyt obu pul i zapis ownera odbywają się po drain pod native writer
transaction SessionStore. Drained wymaga istniejących pul o zgodnym ID, generacji
i pełnym zestawie zasobów. Znany brak/mismatch daje failed, błąd obserwacji daje
unknown; oba stany kończą proces usługi błędem. Status dziecka unknown oznacza
brak potwierdzonej obserwacji i nie jest deklaracją running ani exited.
