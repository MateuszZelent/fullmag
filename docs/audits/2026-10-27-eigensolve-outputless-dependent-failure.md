# Zapis wyników i projekcja awarii przed solverem

## Dowód runtime

Run `run-live-d09922a123c1f1747cf50f28727abad89e0c16e9dc371e7511a091d57f9e9268` zakończył worker kodem 1: przygotowanie storage zwróciło Permission denied; solver nie wystartował. Katalog runu ma rewizję 13: relax=failed, eigenmodes=accepted/blocked awaiting dependency resolution and runtime admission, bez attempt ani artefaktów. API nadal pokazywało running/rev6. Projekcja odrzucała brak katalogu artefaktów.

## Przyczyna i poprawka

Katalog examples ma uid/gid 1000 i tryb 0755. Worker uid65532 należy do grupy1000. Starszy signed15.zarr miał 0770, nowy katalog signed14 nie istniał. Utworzono wyłącznie dwa nowe katalogi signed14_nonzero.zarr i gamma_selected.zarr z trybem0770; nie zmieniono istniejących katalogów ani źródeł. Zapis/fsync jako rzeczywisty użytkownik kontenera przeszedł dla obu.

Ponowna aktywacja a102337352c148f1b951c80aaa2b55da została odrzucona przed mutacją przez live_retirement_busy. Nie uruchomiono nowego solvera.

Poprawka projekcji dopuszcza brak katalogu artefaktów po failed/cancelled/interrupted, gdy pozostałe zadania są wyłącznie nieuruchomione, accepted i zablokowane dokładnym kontraktem zależności. Aktywne, zakończone sukcesem, posiadające attempt albo artefakty pozostają odrzucone. Zniknięcie wcześniej obserwowanego katalogu nadal jest błędem.

## Weryfikacja i dalsza praca

Dodano regresję pozytywną oraz negatywne przypadki etapów aktywnych, sukcesu, gotowości, attempt i artefaktów. diff --check PASS. Testy Rust wymagają GitHub Actions; lokalnie ich nie kompilowano. Poprawka nie została jeszcze zbudowana w runtime. Potrzebne: CI, zarządzany build, potwierdzenie projekcji failed oraz wznowienie signed14 i osobnego Gamma. Automatyczny preflight zapisu nowych katalogów pozostaje do uzupełnienia.

## Kontrolowane odblokowanie istniejącego runtime

Publiczne API cancellation przyjęło zamknięcie wyłącznie nieuruchomionego eigenmodes z kontrolą expected_catalog_revision=13 i cancellation_id=cancel-blocked-signed14-storage-20261027 (HTTP202, revision14). Scheduler wykonał żądanie; kolejka jest pusta, live API przeszło z running/rev6 na failed/rev7. Nie edytowano katalogu runu, lease ani receiptów. To potwierdza mechanizm awarii projekcji, ale nie jest wykonaniem nowej poprawki Rust.

Uruchomiono aktywację signed14 z request_id=eigensolve-signed14-after-terminal-20261027 na istniejącym runtime 7cabba8; wynik należy sprawdzić w receipcie aktywacji i aktualnym procesie workera.

Aktywacja 094965cd3f41459183df988d75f4248a zakończona succeeded. Nowy run run-live-78af971e5683452fdac585a84f99efc0496abce914a05474c3b4e270fb267279: relax succeeded; eigenmodes running. Potwierdzono żywy worker PID6439 oraz sześć zapisanych checkpointów (katalog rev105). Nie jest to jeszcze ukończony sweep.

Skrypt wykresu odczytuje siedem checkpointów poprzedniej próby z walidacją residualów i osobnym oznaczeniem. PNG/PDF wygenerowane oraz PNG obejrzane. Provenance zachowuje hash dowodów i stan nieukończonego sweepa. AST obu nowych przykładów PASS; przykład Gamma jeszcze nie wykonany.

## Wynik obliczeń signed14

Run 78af971e wykonał wszystkie 14 próbek i zapisał checkpointy. Worker zakończył się kodem1 podczas publikacji: deferred physical-potential artifact ownership is inconsistent at eigen/mode_fields/sample_0000/mode_0000/physical_potential.v1.json. Katalog rev189: relax succeeded, eigenmodes failed. API poprawnie failed/rev73. Wszystkie14 checkpointów mają full_descriptor_certified=true i eps_full <= 2.72e-11 przy progu1e-8. Zapisano osobny evidence JSON i wykres z jawnym oznaczeniem błędu publikacji; nie jest to zatwierdzony wynik końcowy. Gamma nadal nie wykonana.

Po zakończeniu workera zniknął cel dowiązania /usr/bin/docker -> /mnt/wsl/docker-desktop/cli-tools/usr/bin/docker. API nadal odpowiadało health=ok. Nie restartowano Dockera/WSL. Pozostaje ustalić dokładną rozbieżność manifestu z certyfikatem modu w eigen_path_artifacts.rs::materialize_selected_path_physical_potential_artifacts; walidator nie został osłabiony.
