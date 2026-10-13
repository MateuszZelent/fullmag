# Plan 4207003016 — pełne strumieniowe archiwum Docker logs

Status: niezależne SOURCE review11files PASS oraz hosted Linux/Windows PASS. Real Docker/storage i power-loss pozostają NOT VERIFIED.

## Przyczyna i wynik

Executor pobiera pełny logs text i encoduje całość. Unix adapter ma 16 MiB cap oraz buforujący demux; Windows CLI capture_output również buforuje całość. Kontrakt wymaga wszystkich dostępnych logów przed usunięciem zakończonego kontenera, więc duże logi obecnie deterministycznie blokują retencję.

Osobna jawna streaming capability musi objąć Unix engine i Windows CLI, Service oraz entrypointy. Małe JSON i tail telemetry zachowują swój cap. Brak stream capability daje odmowę, bez buffered fallback.

## Inwarianty

- Bounded reads/chunks niezależnie od wielkości pojedynczej linii; Unix demux incremental 8-byte headers z odmową truncation. Windows checked child exit i zamknięcie/reaping procesu, bez deadlocku stderr.
- Dokładne emitowane log bytes, incremental strict UTF-8 validation, SHA-256 oraz licznik bajtów, bez decode/reencode zmieniającego bajty. Nie deklarujemy rekonstrukcji chronologii rozdzielonych stdout/stderr.
- Exclusive temp i fsync; pełny log i receipt muszą być opublikowane przed exact rm bez force/volumes. Istniejące odmienne archiwum nie może zostać nadpisane ani usunięte po niepewnym wyniku. Publication conflict lub receipt failure blokuje dalsze usuwanie; zachowujemy dowody partial/unknown, bez automatycznego retry.
- IO failure, invalid UTF-8, truncated frame, nonzero child exit albo receipt failure zachowują kontener/execution. Nie uznajemy capacity za gwarancję fizycznego miejsca.

## Własność i dowody

Worker: unix_docker.py, coordinator.py (logs adapter), retention_executor.py, retention_service.py, container_main.py oraz powiązane testy i nowy test_local_runner_docker_logs.py. Root: guide, ten plan, CI hooks, audit i review. Brak lokalnych testów/buildów/importów/Docker/cleanup.

GHA: rzeczywisty child output większy niż16 MiB, także jedna długa linia; exact SHA/count, split frames i UTF-8, bounded read spies; wszystkie before-delete failure cases oraz preservation poprzedniego archive/receipt. Linux/Windows required. Generic zielone testy nie zastępują tych przypadków. Managed Docker runtime i realstorage pozostają odrębnymi niekwalifikowanymi bramkami.

## Zachowanie istniejącego formatu i kolejności kanałów

Zachowujemy pojedynczy worker-full.log. Unix emituje payload bytes w kolejności odebranych ramek demux. Windows CLI zachowuje dotychczasowy format stdout bytes, następnie stderr bytes; nie jest to odtworzona chronologia. Oba pipe muszą być równocześnie opróżniane bounded reads do exclusive kontrolowanych prywatnych spoolów; po checked exit ich odczyt jest porcjowany stdout-then-stderr. Nie stosujemy unbounded queue ani readline. Spools i zapis finalnego archiwum wymagają fizycznego miejsca; błąd I/O nadal blokuje rm. Nie migrujemy publicznego archiwum na dwa pliki ani nowy bundle.

## Required po pełnym review — publication barrier i cleanup

POSIX musi po obu exclusive canonical publikacjach wykonać checked fsync dokładnego run_root (pinned regular directory, no-follow, dev/inode oraz before/after identity) zanim wywoła rm. Awaria zachowuje częściowe archiwum/receipt i kontener/execution. Receipt przed barrier nie deklaruje jego sukcesu; observed barrier wraca w container_cleanup. Windows nie ma kwalifikowanego portable directory barrier: fsync plików i receipt z jawnym unavailable/weaker descriptor, następnie worker_full_log_directory_sync_unavailable przed rm. Nie udajemy NTFS power-loss proof ani nie obniżamy warunku delete. Windows streaming transport i bezpieczna odmowa mogą być testowane; rzeczywisty cleanup Windows pozostaje zablokowany tą capability.

Thread start musi być potwierdzony przed wpisaniem do listy join. Cleanup procesu, readerów, pipes i spoolów wykonuje niezależne kroki, zachowuje primary failure i nie usuwa/nie zamyka zasobów używanych przez żywy drainer po bounded join. Required regressions: parent fsync event ordering/failure oraz rzeczywisty child z błędem start drugiego readera, reaping/closed resources/no emit.

## Ukończony źródłowy fragment

Domknięto parent barrier, reader-start/cleanup, unknown-live-spool retry i preflight template actual5mandatorycleanupfields. Regresja envelope używa rzeczywistego producenta, a retry validplan-fedc5678 osiąga właściwy guard. Syntetyczny drainer timeout.01 nie zmienia productiontimeout. AST11files i diff-check PASS. Bootstrap scope=retention ma dwa dodatkowe kroki Unix Engine i actual subprocess streaming na Linux/Windows. Nie wykonano lokalnych testów/buildów/Docker.

## Hosted dowód

[GHA37985345068](https://github.com/MateuszZelent/fullmag/actions/runs/37985345068) exact275e2bc6a:SUCCESS. Linux114005841626 i Windows114005841314:92retention tests,10Engine protocol,9actualCLI streaming PASS (platformowe skips osobno). Actual child ponad16MiB/longline/exactSHA, second-reader-start/unknown-spool no-retry PASS obuOS. Linux wykonał directory event ordering/fsync failure i actualproducer→capacity envelope; Windows pominął te niemożliwe capability i wykonał explicit unavailable/no-rm preservation. FakeDocker/rm nie kwalifikuje prawdziwego Docker. Windows cleanup nadal blocked, nie fakeNTFS power-loss proof.
