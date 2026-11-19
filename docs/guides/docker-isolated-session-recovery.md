# Odzyskiwanie sesji w odrębnej przestrzeni kontrolnej

Kontrakt v1 pozwala sprawdzić dowód skopiowania danych do nowej przestrzeni
kontrolnej. Sam wybór przestrzeni nie uruchamia API, nie zmienia właściciela
starej sesji i nie dopuszcza nowych żądań. Kopiowanie, walidacja natywna oraz
przełączenie launchera wymagają osobnej integracji i kwalifikacji.

## Zakres i ograniczenia

Ta ścieżka służy zachowaniu sesji, wyników, historii, checkpointów i modeli
oczekujących na ręczne Compute, gdy nie można bezpiecznie przejąć starego
runtime. Oryginalny stan, certyfikat i OWNER pozostają zachowane. Nie wolno
zastępować sesji pustą ani zmieniać osieroconego `running` na `held` tylko po
to, aby spełnić kontrakt.

V1 wymaga co najmniej jednego runu manual-held. Dopuszcza także zakończone
runy; ich łączna liczba nie przekracza 128. Puste grupy i grupy zawierające
wyłącznie zakończone runy wymagają odrębnego rozszerzenia kontraktu i testów.
Zwykły import FMS nie zastępuje tej ścieżki zachowania oczekujących modeli.

Obserwacja zgodnego GUID VHD/VPD83 i zapisanej ścieżki VHD nie dowodzi
tożsamości pliku używanego przez działającą VM. Ten moduł nie zmienia bramki
adaptera Windows–WSL i nie nadaje uprawnień do modyfikowania starego stanu.

## Dowód kopii

`validate_snapshot_namespace_receipt(receipt, *, project, control_volume,
project_id, worktree_id)` sprawdza strukturę i spójność receiptu
`fullmag.docker-isolated-session-snapshot.v1` w stanie
`snapshot-copied-awaiting-native-admission`. Błędy zgłasza jako
`BuildControlError`. Sukces walidacji strukturalnej nie dowodzi jeszcze
istnienia ani zgodności danych na dysku.

| Pole | Kontrakt |
| --- | --- |
| `recovery_id`, `namespace` | Identyfikator hex32; `namespaces/<recovery_id>` |
| `previous_namespace` | Pusty ciąg albo inna przestrzeń `namespaces/<hex32>` |
| `compose_project`, `control_volume` | Dokładna tożsamość wybranej grupy i wolumenu |
| `source_project_id`, `source_worktree_id` | Dokładne tożsamości źródeł |
| `source_root` | Kanoniczna absolutna ścieżka Linux |
| `source_state_root`, `destination_state_root` | Różne kanoniczne absolutne ścieżki |
| `source_user_data_root`, `destination_user_data_root` | Różne kanoniczne absolutne ścieżki |
| `source_manifest_path`, `request_path`, `original_config_path` | Kanoniczne ścieżki względne do surowego korzenia control; każda ma pole `_sha256` |
| `previous_registry_path` | `namespace-recovery/<recovery_id>/previous-registry.json`, z `previous_registry_sha256` |
| `old_development_attempt`, `old_request_id` | Hex32 próby oraz niepusty identyfikator starego żądania |
| `old_container_ids` | Dokładnie `backend` i `frontend`, różne pełne identyfikatory hex64 |
| `old_image_id` | `sha256:<hex64>` |
| `terminal_run_count`, `held_manual_run_count` | Liczby całkowite, odpowiednio ≥0 i ≥1, suma ≤128; bool nie jest liczbą runów |
| `allow_old_request_replay`, `allow_new_requests` | Oba dokładnie `false` |
| `control_pins` | Najwyżej 32 pary ścieżka względna → SHA-256 |

Minimalny zbiór `control_pins` obejmuje archiwum poprzedniego rejestru,
`development/attempts/<old_development_attempt>/{terminal,compose}.json`,
`runtime-control/runtime-services/{OWNER,LAUNCH}.json` oraz
`runtime-control/runtime-service/{docker-all,process-tree}.json`.
Wszystkie ścieżki poza archiwum rejestru mają prefiks `previous_namespace`,
jeżeli nie jest pusty. Powtórne wskazanie tego samego pliku nie może podawać
innego hasha. Bieżący rejestr i nowy receipt nie mogą być własnymi pinami.

## Wybór przestrzeni

`resolve_snapshot_namespace(control, registry, registry_raw)` porównuje
przekazany rejestr z jego bajtami, identyfikuje grupę i odczytuje receipt
`namespace-recovery/<recovery_id>/terminal.json`. Sprawdza digest receiptu,
manifestu, żądania, oryginalnej konfiguracji i wszystkich pinów kontrolnych.
Każdy odczyt dotyczy surowego korzenia wolumenu, nawet jeżeli obiekt control
ma już ustawiony prefiks przestrzeni.

Po ponownym odczycie identycznych bajtów `namespaces/current.json` resolver
ustawia `namespace`, `namespace_registry` z receiptem pod kluczem
`retirement` oraz `namespace_registry_sha256`. Błąd przed tym punktem nie
może częściowo zmienić obiektu control. Resolver niczego nie zapisuje do
wolumenu i nie publikuje rejestru. Jego podłączenie do istniejącego resolvera
należy do warstwy integracyjnej.

## Obowiązki kopiowania i uruchamiania

1. Operator kwalifikuje dokładnie wybraną zatrzymaną grupę. Kopiowanie musi
   potwierdzić stabilność źródła, fizyczną odrębność celu i brak aktywnego
   konsumenta celu. Różne ciągi ścieżek nie są dowodem rozłączności.
2. Kopia zachowuje komplet danych sesji i artefaktów oraz spójny backup
   SQLite. Nie wolno kopiować samego głównego pliku bazy z pominięciem
   aktywnego WAL. Oryginał pozostaje zachowany; potrzebne dodatkowe miejsce
   należy oszacować przed kopiowaniem.
3. Manifest `fullmag.isolated-session-snapshot-manifest.v1` zawiera `state`,
   `user_data` i obie liczby runów. Każde drzewo ma schemat
   `fullmag.isolated-tree-snapshot.v1`, `source_root`, `root_identity`
   (`device`, `inode`), uporządkowane `directories` i `files` oraz
   `total_bytes` i `file_count`. Rekord pliku zachowuje `path`, `size`,
   `sha256`, `mode`, `inode`, `mtime_ns`. Kopiujący sprawdza cały manifest;
   resolver jedynie uwierzytelnia jego bajty hashem.
4. Publikacja nowego rejestru wymaga blokady operacji oraz compare-and-swap
   względem poprzedniego rejestru. Należy zachować stare receipty i logi.
5. Przy świadomym uruchomieniu launcher może zbudować backend bez skryptu.
   Przed OWNER/API musi uruchomić natywną walidację kopii tylko do odczytu,
   z przypiętymi konfiguracją i żądaniem. Receipt
   `runtime_service_retained_snapshot_validation.v1` musi mieć stan
   `validated-read-only`, zgodne hashe i runy, `owner_changed=false` oraz
   `compute_started=false`.
6. Dopiero osobna bramka uruchomienia dopuszcza nowego właściciela kopii.
   Stare żądanie nie jest odtwarzane; modele manual-held nadal oczekują
   ręcznego Compute. Nie wolno użyć ogólnej autoryzacji nowego żądania ze
   starszych ścieżek quarantine jako zamiennika walidacji natywnej.

Testy struktury i resolvera nie kwalifikują kopiowania, natywnego odczytu
ani runtime. Migracje pozostałych grup pozostają odłożone do ich kolejnego
świadomego uruchomienia; ten moduł nie zatrzymuje innych grup.
