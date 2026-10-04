# P3-B/P5-B — heartbeat lease lokalnego procesu

Data checkpointu: 26.09.2026. Baza źródeł:
`master@09f9080ffab400bd049a1296b467e75ad80840f1` z bieżącym przyrostem
przypiętym przez hash treści w receiptach.

## Zrealizowany kontrakt

Supervisor accepted workera wymaga teraz jawnego dodatniego
`--heartbeat-interval-milliseconds`, krótszego od timeoutu procesu. Podczas
obserwacji żywego potomka odnawia dokładny aktywny resource lease i zwiększa
`heartbeat_sequence` o jeden. Heartbeat nie tworzy nowego właściciela:
run/task/attempt, ownership epoch, resource, lease token, kind i budget muszą
pozostać identyczne.

Publikacja workera akceptuje równą lub nowszą sekwencję heartbeat wyłącznie dla
tego samego właściciela. SessionStore sprawdza bieżący lease i zapis katalogu
artefaktów pod jednym writer lockiem, więc heartbeat nie tworzy losowego
konfliktu pomiędzy odczytem lease a publikacją. Release, obcy token, resource,
attempt lub epoch nadal odrzucają publikację.

Chwilowy `StoreWriterBusy` nie jest utratą własności. Supervisor ponawia
heartbeat, a worker ma ograniczone do pięciu sekund retry całego idempotentnego
przepływu. Pending inbox, immutable started/completed receipt i CAS recovery
zapobiegają drugiemu uruchomieniu solvera. Inny błąd heartbeat kończy potomka
przed zwrotem. Po terminalnym lifecycle timer jest wyłączany, ale supervisor
czeka na potwierdzony exit i dopiero wtedy zwalnia ostatnią wersję lease.

## Zarządzana weryfikacja

- `just verify-api-accepted-supervisor-e2e`: **1/1 PASS**, receipt
  `9387e8bc595c47f7acc6d8ed9f257cd2`, source hash
  `96bd26a640e4d571e8b322dab54042a59610c6624316fdc7d30d64d1be7952db`;
- `just verify-api-accepted-supervisor`: **6/6 PASS**, receipt
  `2459696b3a7f4ff092658063ba7d86d4`;
- `just verify-session-persistence`: **86/86 PASS**, receipt
  `198f3e3da00942bda03b9641af90c0af`;
- `just verify-project-application`: **49/49 PASS**, receipt
  `537f59e416944eccb1a3ebbb02b02170`;
- `just verify-api-project-runs`: **6/6 PASS, 2 ignored**, receipt
  `e5c2287444e840a5af84f4a89d0eedc7`.

Wszystkie receipty mają `source_changed_during_run=false`. E2E potwierdza
dodatnią sekwencję heartbeat względem claimu początkowego, terminalny
`Succeeded`, kompletny manifest/CAS oraz `Released` po exit.

## Granica dowodu

To jest heartbeat liveness lokalnego procesu dla ograniczonego lane FDM
CPU/double/strict. Nie jest to jeszcze `HeartbeatAck` z procesu na zdalnym
transporcie, deadline-based orphan reclamation ani dowód postępu solvera.
Brakuje nadal automatycznego schedulera, operator cancel, retry orchestration,
crash recovery supervisora, bezpiecznego przejęcia orphan lease, puli większej
niż jeden i kwalifikacji FDM GPU oraz FEM CPU/GPU. Sam wiek heartbeat nigdy nie
uprawnia do release ani ponownego przydziału resource.
