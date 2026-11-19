# Uruchamianie pojedynczej symulacji z terminala

Użytkownik określił interfejs `just fullmag master skrypt.py`. Terminal pokazuje na żywo budowanie i obliczenia, pozostaje otwarty po zakończeniu obliczeń i zamyka obliczenia oraz kontenery tej grupy po Ctrl+C. Użytkownik potwierdził domyślne UI oraz jawny wariant `just fullmag headless master skrypt.py`.

## Kontrakt

- Domyślny tryb to GUI; jawne prefiksy `gui` i `headless` poprzedzają selektor źródeł i skrypt. Headless zachowuje zdefiniowany frontend grupy w stanie zatrzymanym.

- `master` wybiera główny zarejestrowany checkout na gałęzi master. Skrypt jest rozwiązywany względem wybranych źródeł i przechodzi istniejącą walidację.
- Launcher korzysta z istniejącego Docker DEV, resolvera, prywatnego control volume, receiptów i natywnego drainu.
- Logi buildu i symulacji trafiają do terminala. UI ma jawny adres. Po zakończeniu obliczeń terminal oczekuje na Ctrl+C.
- Ctrl+C zatrzymuje dokładnie przyjęty przebieg, czeka na potwierdzenie Stop i zamyka przypięty backend oraz frontend. Wyniki i wolumeny pozostają zachowane.
- Przerwanie podczas startu i buildu ma własne zamknięcie z potwierdzeniem tożsamości kontenerów oraz stanu native. Zmieniona tożsamość lub niepotwierdzony wynik mutacji zachowuje dowody i zgłasza błąd.
- Istniejący obcy aktywny konsument grupy blokuje przejęcie. Polecenie nie zatrzymuje innych grup.

## Implementacja i weryfikacja

1. Dodać moduł `scripts/fullmag_console.py` oraz receptę `fullmag` z zamkniętym przekazaniem argumentów przez `scripts/just_storage_shell.sh`. Wykorzystać `docker_dev_up`, `docker_dev_run_script` i zarządzane zamykanie usług.
2. Dodać regresje dla dokładnych argumentów rzeczywistej recepty, logów, zakończenia obliczeń, Ctrl+C podczas buildu i obliczeń, podwójnego przerwania, obcej sesji, błędów startu i zmiany tożsamości.
3. Udokumentować komendę w istniejącym przewodniku Docker DEV. Wykonać właściwe testy źródeł, review, commit i CI przed PR do mastera.
4. Przeprowadzić kwalifikację w istniejącej autoryzowanej grupie. Potwierdzić logi, wyniki, UI i zatrzymanie obu usług. Osobno zapisać ograniczenia historycznego runtime po OOM.

Root odpowiada za konsolę, tożsamość i zamykanie. Worker console_entrypoint odpowiada za receptę, shell i zgodność dawnych jawnych bramek kwalifikacji. Worker console_flow_scan odpowiada za headless w istniejącym launcherze i obserwatorze runu. Osobny reviewer sprawdza ownership i przerwania bez mutacji runtime.

## Dowody źródłowe i granica runtime

- 32 nowe regresje Python konsoli oraz 5 testów rzeczywistej granicy just/shell: PASS.
- Regresje istniejącej ścieżki: post-build integration 3, runtime state 9, receipts 62: PASS po dostosowaniu fixture do jawnego headless oraz nowych odczytów.
- Istniejące moduły owned-control, script-output-mounts, idle-stop, run-observer, foreground-shell, recreate, network-failure, interrupted-resume/development: PASS.
- Dwa niezwiązane testy `test_hysteresis_just_targets.py` (hostowy Cargo target i dawny find-prune) zawodzą również dla plików z bazowego `f05e98974db683c0521de56f63ae76a838797270`; brak zmiany tych asercji.
- Nowy entrypoint Docker/browser: NOT VERIFIED. Historyczny `fullmag-master` ma aktywny unknown recreate `c74e96cb2fb64e76a00baa6a89cd8e7c`, przed usunięciem usług i bez potwierdzonego drainu. Nie resetowano go i nie utworzono zastępczej grupy. Osobne recovery pozostaje wymagane przed rzeczywistym uruchomieniem tam konsoli.

- Końcowy handoff workera: 98 testów w `test_docker_volume_activate`, `test_docker_dev_defaults`, `test_docker_dev_run_script`, `test_docker_dev_up`: PASS.
- Końcowe regresje istniejących consumerów: idle-stop 5 (w tym nowy headless drain), pending-resume 14, cancelled-activation 6, retained-device lifecycle 5, post-build 3, receipts 62, interrupted-resume 11, interrupted-development 18: PASS.
- Review source-only: poprawiono wszystkie zgłoszone punkty dotyczące przerwań, ownership, bieżącego ui_mode, zmiany source provenance i nieoczekiwanego frontend OOM.
