# Produkcja aktualnego bindingu runtime SP4

**Cel:** wydać sprawdzony rekord istniejącego formatu v1 dla obecnego endpointu
grupy 3274, zachowując pierwotny plan, loader oraz wszystkie dane.

**Specyfikacja:** ADR 0081, sekcja bindingu runtime. Ten etap nie wykonuje
Attach, drainu, kopii, admission, Solve, rejestracji ani usuwania.

## Kontrakt

`previous_runtime_pins` pozostają pinami pierwotnego planu. Stop i recreation
muszą natomiast wskazywać tego samego rzeczywistego poprzednika obecnego
development. Nie nazywamy tego poprzednika pierwotnym runtime planu.
Recreation i development współdzielą uwierzytelniony stop; nie twierdzimy,
że istnieje bezpośrednia krawędź przyczynowa recreation → development.
`historical_owner_continuity=not-proven`, `namespace_admitted=false` oraz
`data_migrated=false` pozostają obowiązkowe. Oryginalne rooty device/inode,
StateRoot i budżety usług muszą być zachowane.

## Implementacja

- [x] `scripts/docker_data_volume_runtime_binding_evidence.py`:
  czyste `qualify_witnesses(plan, *, compose_project, control_volume,
  source_root, witnesses, records)` sprawdza pełne treści trzech terminali,
  obu snapshotów zatrzymanej pary i Compose. Zwraca `runtime_pins`,
  `runtime_source`, `compose`, `stopped_pair`.
- [x] `scripts/test_docker_data_volume_runtime_binding_evidence.py`:
  RED/GREEN dla poprawnego aktualnego poprzednika różnego od pinów planu;
  odmowa zmienionego stopu, snapshotu, obrazu, scope, fresh state, usuwanych
  kontenerów, kolejności czasu i wspólnego observation.
- [x] `scripts/docker_dev_data_volume_runtime_binding.py`:
  `qualify_runtime_successor(source_root, *, volume_id, plan_sha256,
  witnesses, backend, image_id, publish=False)` domyślnie tylko odczytuje.
  Sprawdza rzeczywiste kontenery/Compose, bindy, rooty, istniejący certyfikat,
  owner/probe i namespace. Publikacja używa hostlock oraz lease istniejącej
  grupy i zapisuje wyłącznie nowy binding oraz receipt operacyjny.
- [x] Testy hostowego publikatora: brak zapisu po drift, zachowanie istniejącego
  bindingu i odmowa obcego planu/roli; brak uruchamiania lub zatrzymywania usług.
- [x] Review i adekwatne testy: 637 PASS w 51 modułach obowiązkowej bramki.
- [x] Commit oraz push istniejącego brancha SP4: `bab622a08668c93cb47973b5ec180c5452dc1abb`.
- [x] Odczytowa kwalifikacja rzeczywistej grupy i jawna publikacja
  nowego bindingu.
- [x] Sprawdzenie opublikowanego rekordu niezmienionym loaderem v1 przy
  przygotowaniu requestu Linux.

## Odbiór

Nowy SHA wskazuje wyłącznie obecną zdrową parę. Stary `b604…`, plan oraz
Create pozostają identyczne. Każdy następny etap migracji nadal musi
wykonać własne świeże kontrole. Testy modeli nie dowodzą rzeczywistego Attach,
migracji ani nowego wyniku SP4. UI pozostaje uruchomione.
