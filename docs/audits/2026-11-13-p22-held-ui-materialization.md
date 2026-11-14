# P22 — kwalifikacja zachowanego UI Compute przed materializacją

Rzeczywista operacja zmiany materiału i Run This Stage przyjęła niezmienny RunIntent `run-live-6b6552a649f3cd4a87309ab4b48a1f0c83c0a884636a180dea580f83e0bf8cd0`, lecz nie zapisała katalogu ani start release. Oryginalny command ID pozostaje w request receipt. Nie ponowiono Compute i nie utworzono zastępczego runu.

Ten fragment dodaje odczytowy `continue-held-ui-volume --preview`, prywatny most startu API i weryfikację tożsamości przed przyszłym odtworzeniem. **Apply jest wyłączone. Prywatny Rust restore kończy się jawną odmową po odczytowej walidacji, zanim zapisze katalog, frontier lub release.** To etap wdrożenia; nie jest kompletnym recovery ani odbiorem P22.

Dowody wiążą dokładny DEV attempt, Compose/control/namespace, źródło i stan, obie inkarnacje usług, stare API, scenę, intent, receipt i brak natywnego startu. Plan pomija zmienny uptime. Docelowy most tworzy niezmienny launch record i nie powtarza nieustalonego uruchomienia API. Dawne tryby importu, anulowania, recovery i startup script są wykluczone przed ich wykonaniem.

Odczyt rzeczywistego intentu potwierdził raw SHA-256 `dddf6f4c67202a38f43dd0aa8ae9492866b142b452afa138b10a2891e554e62d`. Wewnętrzny `live_workspace.session_epoch` wynosi **1**. Publiczny `session_epoch` ma format `session_id@1794582150656`, a `created_at` jest stringiem `1794582150656`. Osobny pin `session_created_at_unix_ms` zachowuje ten czas; nie zastępuje licznika kontekstu. Pierwszy rzeczywisty podgląd odrzucił wcześniejsze błędne założenie bez zmiany intentu. Drugi podgląd po poprawce zakończył się timeoutem odczytu Dockera; dalsza obserwacja potwierdziła działający i zdrowy ten sam backend. Nie wykonano stop ani rebuild.

Trzy konfiguracje mają odrębne role: `source_scope.runtime_config_sha256` oznacza zachowany DEV Compose config; `preflight.native_config_sha256` starą konfigurację natywną; `target_runtime.config_sha256` konfigurację natywną nowego buildu. Opaque `accepted_store_binding` różni się od natywnego HostResourceLedger `store_id`.

Weryfikacja lokalna obejmuje izolowane testy Python mostu/CLI i odczytowego kontrolera, parsery źródła oraz diff checks. Sześć nowych testów Rust wymaga zarządzanej kompilacji i CI. Aktualny runtime nadal zawiera binarkę `9f146c29bb682a465bb8bf6e0c672efa4d84b7c6`; zmiany tego fragmentu nie zostały uruchomione w kontenerze.

Pozostają: rzeczywisty odczytowy plan, typed stop i prawdziwe quiescence/drain, rewalidowany recreate/build, hydration tej samej sesji/sceny, katalog/frontier oraz release z oryginalnym receipt. Odbiór wymaga dokładnie jednego wykonania A z Ms=600000, odczytu oryginalnej komendy, następnie pełnego cyklu materiał/tekstura/Stage/mesh/Study. S46 nadal wymaga minimum 1 GiB dostępnego w WSL; inwentarz nie jest zgodą na usunięcie cache.
