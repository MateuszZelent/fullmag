# Bramka storage oparta na właściwościach

## Decyzja i zakres

Wymóg ext4/loop/backing image opisuje historyczną infrastrukturę Linux,
nie wymagania numeryczne FEM. Zachowujemy tę trasę jako
`linux-ext4-loop-v1`. Nowa trasa `capabilities-v1` sprawdza żywe operacje
na docelowym filesystemie; nazwa `v9fs`, NTFS czy ext4 nie stanowi wyniku testu.

Role są oddzielne: źródła, artefakty i build. Build potrzebuje właściwości
rzeczywiście używanych przez wybrany toolchain (np. linki, wykonywalność, mmap).
Case sensitivity pozostaje mierzoną właściwością, nie udowodnionym ogólnym
wymogiem Fullmaga. Historyczny profil sondy nadal raportuje swój wynik FAIL;
nowy build Desktop musi mieć własny dowód, bez przepisywania starego raportu.
Nie narzucamy tych wymagań eksportowi zwykłych
plików wynikowych. Kapsuła źródeł w jobie pozostaje readonly; sonda używa
wyłącznie własnego, zapisywalnego katalogu testowego na tym samym storage.

Nie zmieniamy lokalizacji `.env`, nie tworzymy wolumenu Docker, nie
przenosimy dysku Docker Desktop, nie dotykamy cudzych kontenerów ani cache.

## Operacyjne sprawdzenie Docker Desktop

Po jawnym skonfigurowaniu obrazu diagnostycznego runnera:

Poniższe sondy dotyczą wcześniejszego, hostowego etapu. Po skonfigurowaniu
`Fullmag_build_runner` są odrzucane, żeby Windows nie zapisywał kolejki SQLite
posiadanej przez kontener. Bieżąca trasa: [lokalny runner](local-container-runner.md).

```text
just runner-storage-probe build
just runner-storage-probe artifact
just runner-storage-probe source
just runner-storage-probe-case-sensitive
```

Recepta używa resolvera, blokady worktree oraz blokady koordynatora. Odmawia
przy aktywnym jobie runnera. Tworzy unikalny katalog sondy pod build profilem
i evidence pod runami worktree. Nie używa GPU, sieci, kontenera privileged
ani socketu Docker w kontenerze. Limit: 1 CPU i 512 MiB.

Wariant `case-sensitive` próbuje ustawić flagę NTFS wyłącznie na nowym pustym
katalogu sondy. Nie zmienia istniejących katalogów, ACL ani całego storage.
Wynik jest sprawdzany przez WinAPI, nie tylko exit code `fsutil` (narzędzie
potrafi zwrócić 0 z tekstem odmowy dostępu). Odmowa kończy próbę przed Docker
create; wymaganego podniesienia uprawnień nie wykonujemy automatycznie.

`coordinator.json` zachowuje image ID, engine ID, pełny container ID, rzeczywiste
mounty, hash skryptu i raportu, ścieżkę hosta oraz exit code. Raport sondy
zawiera fingerprint mountu przed/po, wyniki poszczególnych operacji i mały
pomiar I/O. Nie wolno używać tego pomiaru jako benchmarku kompilacji Fullmaga.
Kontener po zakończeniu i dane sondy pozostają do inspekcji; brak automatycznego
prune. Sonda ma trwały lease w tej samej kolejce. Przerwany start wymaga
`runner-reconcile` dla potwierdzonego pełnego ID; wynik recovery sondy to
`interrupted`, a nie automatycznie PASS. Niejednoznaczne create bez ID zachowuje
nazwę kontenera i lease. `acknowledge-uncreated` wolno użyć tylko po dowodzie,
że create nie dotarło do daemona i proces wywołujący zakończył pracę.

## Co oznacza wynik

`passed` oznacza przejście wykonanych prób dla konkretnego mountu, obrazu
i roli. Nie jest dowodem zachowania po utracie zasilania, restartu Docker VM,
atomowości we wszystkich możliwych przeplotach ani synchronizacji blokad
między Win32 a Linux. Hostowy lease pozostaje konieczny.

`failed` wskazuje konkretną brakującą właściwość. Nie wolno zmieniać testu na
PASS dlatego, że filesystem jest jedynym dostępnym. Można natomiast odrębnie
zakwalifikować mniej wymagającą rolę albo zaprojektować adapter.

Każdy raport zachowuje `qualification: NOT VERIFIED`. Dopuszczenie storage
do właściwej kwalifikacji wymaga jeszcze rzeczywistego builda, managed FEM,
przerwania i restartu workera, publikacji failed candidate bez utraty current,
oraz powiązania dowodu storage z manifestem source/binary/image/artifacts.
Sonda nie zmienia etykiet GitHub ani nie kwalifikuje runnera `fem-managed`.

## Kompatybilność i migracja

Istniejące recepty Linux z bezpośrednimi guardami ext4, resolver managed view,
export/restore i SP4 zachowują swój kontrakt do jawnej migracji konsumenta.
Nie ma globalnego `skip-storage-check`. Nieznany profil ma być odrzucany.
Wynik starego profilu nie może być przepisany na dowód nowego profilu.

Rollback polega na pozostaniu przy starej trasie; nie wymaga usuwania danych
ani zmiany aktywnego mountu. Ta zmiana nie dotyka fizyki, DSL, IR ani API.

## Dowody na tym hoście, 2026-09-11

Windows volume: NTFS; Docker Desktop `findmnt`: `9p` (wcześniejsze `stat -f`
podawało `v9fs`). Obraz diagnostyczny:
`sha256:109e9023aa594b0ff3ea59e7f9b24014d2351e4103ced1deece608cb45455092`.
Hash sondy: `fc3fd4d261b84b7b784059e415605a07197df05946778ddad845562aaa0823e7`.

| Rola | Job | Wynik |
| --- | --- | --- |
| build | 5338a503198f422a9ac4df6281e573b1 | FAIL: wyłącznie case sensitivity |
| artifact | 65dd6d7dcf3c4396ba0663ad2f52b3a8 | PASS wykonanych prób |
| source | b51c4940ffba47c6b256524d0504c356 | PASS wykonanej próby |

Raporty: `storage/runs/<worktree-id>/<job-id>/evidence/capabilities.json`.
Job build próbował ustawić flagę NTFS; `fsutil` wypisał odmowę dostępu mimo
exit 0. Odczyt WinAPI potwierdził flagę false. Pozostałe osiem prób builda
przeszło. Nie jest to dowód, że właściwy build Fullmaga zakończy się poprawnie.

Pierwszy job `e5f5936e62bb413a9aa4425bf5c528d7` ujawnił błąd hosta:
Docker zwrócił te same mounty w innej kolejności. Porównanie naprawiono i
objęto regresją; zakończony kontener z exit 2 odzyskano jako `interrupted`.
Nie usunięto żadnego kontenera ani wyniku. Obecnie brak aktywnego lease sondy.

Testy: 75 testów runnera PASS; 16 testów capability OK, z czego 5 testów
Linux pominiętych na Windows. Żywe operacje dla trzech ról wykonano wewnątrz
Linux Docker Desktop. Pełny build, restart VM, managed FEM i integracja CI:
**NOT VERIFIED**.
