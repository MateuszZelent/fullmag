# ADR 0067 — niezależne grupy Docker DEV

Status: decyzja użytkownika przyjęta 21.10.2026; implementacja etapami.
Data: 2026-10-21.

Stan implementacji:

| Punkt | Stan |
|---|---|
| 1. Ledger per grupa | zaimplementowany w launcherze i runtime (`group-ledger-v1`, 21.10.2026); dowód runtime w sekcji Weryfikacja |
| 2. Statyczne budżety `FULLMAG_DEV_*` | zaimplementowane w launcherze |
| 3. Automatyczny port | zaimplementowany w launcherze |
| 4. Zasada zmian stanu DEV | obowiązuje; globalny ledger dotyczy już tylko release, kwalifikacji i managed runtime |

Pomiar przed punktem 1 (21.10.2026): globalny ledger przechowuje jedną
readiness przypiętą do tożsamości builda (`source_snapshot_sha256`,
`runtime_identity_sha256`). Backend z innym kodem musi ją obrócić, a rotacja
wymaga braku aktywnego właściciela inwentarza (`host_resource_ledger.rs`,
`upgrade_runtime_readiness`). Grupa `zen-nobel` przy działającej grupie Fali 0
zakończyła się błędem „runtime readiness rotation requires the host inventory
owner to be absent”. Ledger per grupa usuwa to sprzężenie: readiness grupy
obraca wyłącznie jej własny backend przy własnym restarcie.

## Kontekst

Kilku agentów pracuje równolegle w osobnych worktree, każdy w swojej grupie
`fullmag-worktree-<id>` (ADR 0061, 0064). Audyt
`docs/audits/2026-10-21-docker-dev-workflow-audit.md` (§5.8, §9) wykazał, że
jedynym twardym sprzężeniem między grupami jest globalny host ledger: obraz
`fullmag-host-ledger-v1.ext4` w hostowym `storage`, montowany przez
uprzywilejowany `nsenter` i współdzielony przez wszystkie grupy jednego
checkoutu. Każdy `just docker-dev` rejestruje grupę jako jego konsumenta, a
migracja polityki pojemności (`bbf3b2f44`, `ac8f72ffd`) wymaga zatrzymania
wszystkich grup. Pozostałe wspólne zasoby to fizyczne CPU/RAM/GPU maszyny
wirtualnej Docker oraz porty loopback frontendu.

## Decyzja

1. **Ledger per grupa w DEV.** Profil volume DEV (`docker_volume_dev`, cargo
   `backend-dev`) używa profilu `group-ledger-v1`: ledger leży we własnym
   nazwanym wolumenie Docker grupy (`fullmag-dev-group-ledger-v1-<klucz>`,
   etykiety projektu Compose), zwykłe pliki i blokada `flock` (`writer.rs`),
   bez obrazu ext4, urządzenia loop, uprzywilejowanego helpera i deskryptora
   pojemności hosta. Polityka ledgera grupy jest jej własnym budżetem. W DEV
   nie ma admisji rezerwacji między grupami. Globalny `host-ledger-v1`
   pozostaje jedynym źródłem prawdy dla release, kwalifikacji i managed
   runtime (`fullmag_docker_runtime`).

   Doprecyzowanie z 21.10.2026 (decyzja użytkownika): zamiast podkatalogu
   wolumenu kontrolnego ledger ma osobny wolumen grupy, widoczny w backendzie
   pod niezmienioną ścieżką `/host-ledger` (`/host-ledger/ledger`). Helpery
   odzyskiwania zatrzymanego backendu montują cały wolumen spod `/host-ledger`
   bez `subpath`, więc zachowują układ i blokady bez zmian. Profil rozpoznaje
   zmienna `FULLMAG_HOST_LEDGER_PROFILE=group-ledger-v1`.
   `FULLMAG_DOCKER_HOST_ID` pozostaje digestem daemona (porównuje go admisja
   storage); logiczny `host_id` ledgera, `node_id` i pin w rejestrze
   `host-ledger-roots` wynikają z `FULLMAG_GROUP_LEDGER_HOST_ID` = SHA-256
   (digest daemona, projekt Compose). Grupa nie ustawia pól globalnego
   overlayu (`FULLMAG_HOST_LEDGER_MOUNT_ROOT`, `FULLMAG_DOCKER_HOST_CAPACITY_*`
   itd.); runtime odrzuca deskryptor pojemności z profilem grupy, a
   `--migrate-host-capacity` nie dotyczy grupy. Kontrola quiescence migracji
   globalnej pomija mounty `/host-ledger` będące wolumenem grupy.
2. **Ochrona między grupami przez statyczne budżety.** Każda grupa dostaje
   limity Compose dla `backend` i `frontend` z `FULLMAG_DEV_BACKEND_CPUS`,
   `FULLMAG_DEV_BACKEND_MEMORY_GIB`, `FULLMAG_DEV_FRONTEND_CPUS` i
   `FULLMAG_DEV_FRONTEND_MEMORY_GIB` (zmienna procesu, potem `.env` głównego
   checkoutu). Wartości domyślne wynikają z pojemności VM, tak aby zmieściły
   się trzy grupy: backend min(8, CPU/4) CPU i min(32, RAM/6) GiB, frontend
   min(4, CPU/10) CPU i 8–16 GiB (dotychczasowe 16 GiB frontendu na dużym hoście). Limity są górnymi granicami, nie
   rezerwacjami: przeciążenie spowalnia grupę, nie zatrzymuje innych. Ta sama
   wartość backendu wyznacza kwotę kontenera, profil natywny
   (`FULLMAG_DOCKER_CPU_MILLIS`, `FULLMAG_DOCKER_MEMORY_BYTES`) oraz
   `CARGO_BUILD_JOBS`. Każda grupa ma jeden równoległy worker GPU
   (`compute_max_concurrency: 1`); `FULLMAG_GPU_ACCESS` wyłącza GPU w grupie.
   Pamięć VRAM nie jest rezerwowana między grupami. Run, dla którego brakuje
   VRAM lub RAM, ma czekać w kolejce z widocznym powodem „oczekiwanie na
   zwolnienie zasobów” na podstawie zmierzonej wolnej pamięci urządzenia
   (osobne zadanie; do czasu wdrożenia brak VRAM kończy run błędem CUDA, bez
   cichego przejścia na CPU).
3. **Port frontendu.** Bez jawnego portu skonfigurowany port jest preferencją
   nowej grupy; zajęty port zastępuje pierwszy wolny w stałej dla projektu
   rotacji kolejnych portów. Porty przypięte przez zatrzymane grupy są
   traktowane jako zajęte. Istniejąca grupa zachowuje swój port.
4. **Zasada zmian stanu DEV.** Zmiana schematu lub polityki stanu DEV
   (ledger, wolumen kontrolny, receipty, dokumenty grupy) jest albo lokalna
   dla jednej grupy i wykonywana przy jej własnym starcie, albo wstecznie
   zgodna, tak że starsze grupy działają bez zmian. Żadna migracja DEV nie
   wymaga zatrzymania cudzych grup ani nie sprawdza ich stanu. Migracje
   globalnego ledgera dotyczą wyłącznie jego konsumentów (kontenerów z
   mountem `/host-ledger`).

### Jawne przeniesienie głównego checkoutu Windows do WSL

Nazwa `fullmag-master` pozostaje nazwą głównej grupy na danym silniku Docker.
Zmiana checkoutu nie uprawnia zwykłego `up` do przejęcia starej tożsamości.
Zatwierdzona przez operatora operacja `scripts/docker_dev_source_transfer.py`
obsługuje przejście ze zweryfikowanego, poddanego kwarantannie namespace
Windows do świeżego namespace WSL. Wymaga zatrzymanych obu usług, braku
aktywnej operacji i potwierdzonego zakończenia próby developmentu.

Pod wspólną blokadą operacji archiwizuje konfiguracje, logi i obrazy warstw
zapisu obu kontenerów w Dockerze, następnie usuwa wyłącznie te zatrzymane
kontenery i pustą sieć grupy. Zachowuje wszystkie wolumeny, bind mounty danych,
stare receipty i rejestr źródłowy. Nowy receipt wiąże obie tożsamości i hashe
poprzedniego rejestru; jego publikacja atomowo wybiera nowy namespace.
Stary klient zostaje odrzucony przez niezgodność tożsamości. Nie migrujemy
sesji Windows do profilu Linux ani nie ponawiamy przyjętego wcześniej runu.

Przerwanie transferu nie zezwala na automatyczny restart ani rollback:
archiwum `source-transfer/<id>` i rejestr wymagają inspekcji. Przywrócenie
starej grupy jest osobną operacją, po zatrzymaniu nowej. Implementacja tej
ścieżki nie jest dowodem poprawności buildu, API, siatki ani WebGL.

## Konsekwencje

- Trzy grupy mogą jednocześnie budować w swoich budżetach i mieć działające
  API niezależnie od kodu, bo readiness każdej grupy leży w jej ledgerze.
- Po wdrożeniu punktu 1 także migracja jednej grupy nie zatrzymuje
  pozostałych, a grupy DEV przestają korzystać z kontroli cgroup2
  i deskryptora pojemności hosta.
- Suma budżetów może przekroczyć VM przy niestandardowych wartościach `.env`;
  skutkiem jest spowolnienie lub OOM wewnątrz grupy, która przekroczyła swój
  limit, nie zatrzymanie innych.
- Rezerwacje istniejące w globalnym ledgerze nie są przenoszone do ledgera
  grupy. Grupa przechodzi na ledger per grupa przy własnym starcie z nowym
  kodem: każdy nowy render launchera wybiera `group-ledger-v1`, a częściowo
  wznowiona operacja zachowuje profil przypięty w swoim receipcie.
  `runtime_service.py` dopuszcza jedną rotację konfiguracji z ledgera
  globalnego na ledger grupy, wyłącznie po uwierzytelnionym drain poprzedniego
  ownera tej grupy; zmieniać się mogą tylko polityka (host ID, budżet,
  topologia) oraz budżety i maski CPU/RAM. Ścieżki, pule, identyfikatory
  zasobów, GPU i współbieżność pozostają dokładne. Konfiguracja już związana z
  host ID grupy nie przechodzi tej ścieżki ponownie.
- Wolumen ledgera grupy jest operacyjnym stanem runtime grupy, nie cache'em
  buildu. Zachowuje się go razem z wolumenem kontrolnym grupy; nie usuwa się
  go przy restarcie ani przy sprzątaniu cache.

## Weryfikacja

Wymagany dowód runtime: trzy grupy z trzech worktree startują i kompilują
równolegle, a restart jednej nie zmienia stanu pozostałych (`docker ps`, logi
backendów). Do czasu tego dowodu implementacja ma status NOT VERIFIED.
Punkt 1 wymaga osobnego dowodu: migracja polityki ledgera jednej grupy przy
działających pozostałych grupach.

Dowód punktu 1 (21.10.2026, Windows, Docker Desktop `desktop-linux`, GPU):

- Grupy `fullmag-worktree-determined-pasteur-cb1518-…` (commit `5c8a96032`,
  snapshot źródeł `d7b8fc0a…`) i `fullmag-worktree-group-ledger-proof-b-…`
  (commit `b3decc875`, snapshot `d1369672…`) zbudowały się równolegle i obie
  miały jednocześnie `Ready: API and runtime service` (porty 3197 i 3202).
  Każdy backend montuje wyłącznie własny wolumen `fullmag-dev-group-ledger-v1-*`
  pod `/host-ledger`; ledger v4 ma host ID grupy i jej budżet, w środowisku nie
  ma pól globalnego overlayu ani helpera `nsenter`.
- Zmiana stanu jednej grupy: B przełączony na inny commit i zrestartowany
  (`docker restart`) przebudował się, obrócił readiness we własnym ledgerze i
  wrócił do `Ready`; kontener A zachował ID, `StartedAt` i `healthy`.
  Następnie restart A (przyrostowy build i `Ready`) nie zmienił kontenera B
  (ID, `StartedAt`, `healthy`, 0 restartów). W obu kierunkach supervisor
  grupy niezrestartowanej zgłaszał w czasie buildu drugiej grupy pojedyncze
  4-sekundowe degradacje obserwacji (wspólne CPU VM) i sam je zamykał;
  admisja nie była zamknięta.
- Trzecia, świeża grupa `fullmag-worktree-group-ledger-proof-c-…` (commit
  `61c1612ae`, liść `ledger/` tworzony przez launcher przed admisją)
  zbudowała się i osiągnęła `Ready` przy działającej B (port 3255); B nie
  zmieniła `StartedAt` ani stanu.
- `_assert_host_capacity_migration_quiescent()` na żywo przy obu działających
  grupach: PASS (backendy grup nie są konsumentami globalnego ledgera).
- Testy interpretowane w kontenerze grupy (`just docker-dev-control-checks`
  oraz moduły ledgera): nowe `test_docker_group_ledger` zielone, w tym
  rotacja konfiguracji global→grupa; 6 niepowodzeń występuje identycznie na
  bazie `7259210af` i nie wynika z tej zmiany.

NOT VERIFIED: jednorazowa rotacja istniejącej grupy z ledgera globalnego na
ledger grupy w runtime (sprawdzona tylko testem kontraktu); ścieżki recovery
zatrzymanego backendu z wolumenem grupy (namespace, container recovery,
orphan recovery); host Linux/WSL. Znane ograniczenie (fail-closed): dowody
runów przyjętych pod ledgerem globalnym (`host_id` daemona) nie pasują do
host ID grupy, więc capture-failure reconcile i pre-ack retry takich runów po
przejściu grupy na własny ledger są odrzucane.


### Jawny świeży start DEV po awarii (22.10.2026)

`recreate-volume --fresh-state` archiwizuje runtime i wybiera nową generację
wolumenu ledgera grupy. Stary ledger zachowuje bez zmian, razem z jego
rezerwacjami; nie oznacza ich jako zwolnione ani nie odtwarza starego zadania.
Warunkiem jest usunięcie dokładnie przypiętych kontenerów poprzedniej generacji
oraz brak innych konsumentów jej ledgera. Budżet i tożsamość grupy pozostają te
same. Inne grupy i globalny ledger pozostają poza zakresem.

Wskaźnik `group-ledger-generation.json` w wolumenie kontrolnym wiąże nowy klucz
wolumenu z zakończonym archiwum runtime. Zwykły start/restart zachowuje tę
generację; tylko jawny świeży start ją zmienia. Poprzednie wolumeny i dane są
zachowywane do osobnej decyzji retencji. Powrót do poprzedniej sesji nie jest
automatycznym rollbackiem: wymaga jej własnej obsługi zachowanego stanu.

Implementacja: `docker_volume_fresh_runtime.py`, `docker_volume_dev.py`,
`docker_group_ledger.py`. Kontrola składni nie zastępuje dowodu stop→archiwum→
nowy ledger→API; do czasu takiego uruchomienia ścieżka ma status NOT VERIFIED.

### Pusta sesja po przerwaniu demona (24.10.2026)

Jawna kwarantanna namespace może objąć dokładnie zatrzymaną generację,
która nie opublikowała żadnego RunIntent i ma pusty grupowy ledger. Zapis
ready w starym ownerze nie jest zmieniany na failed ani uznawany za drain.
Dowód nieobecności prywatnych namespace kontenerów, brak innych konsumentów,
pusty allowlistowany store oraz blokady natywne stanowią odrębny kontrakt
otwarcia nowej pustej sesji. Nie jest to wznowienie starej sesji.

Trwały intent poprzedza usunięcie dokładnej zatrzymanej pary bez force;
niezmienny receipt i CAS rejestru namespace następują po dowodzie usunięcia.
Stare marker/receipt/owner/store/ledger pozostają zachowane, a recovery_id
wyznacza świeży grupowy ledger. Stary request nie może być ponowiony.
Nie ma wyjątków dla store z przyjętym runem ani dla niepustych rezerwacji.
Implementacja: docker_volume_empty_quarantine.py i walidator namespace.
Rollback nie odtwarza starego unknown; wymaga osobnej kanonicznej procedury.
NOT VERIFIED do rzeczywistego wykonania i kontroli zachowania dowodów.
