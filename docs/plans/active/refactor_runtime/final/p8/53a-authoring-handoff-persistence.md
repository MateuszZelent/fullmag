# P8-53A — trwały handoff authoring: checkpoint implementacji

Data: 03.10.2026. Zakres: wewnętrzny prymityw zapisu/odczytu, nie gotowy
restart backendu z UI. Kontrakt nadrzędny: [P8-53](53-development-restart-workspace.md)
i [ADR 0050](../../../../../adr/0050-development-backend-restart.md).

## Zrealizowane

`scripts/windows/development_handoff.py` udostępnia:

- `create_handoff(runtime_root, binding, scene, editor, workspace, project_document, *, assets)`:
  zapis pełnego JSON-u sceny bez projekcji na `ScriptBuilderState`; oddzielne
  części mają własne SHA-256. Lista assetów jest obowiązkowa, także gdy jest pusta.
- `load_handoff(runtime_root, handoff_id, expected_binding)`: odczyt z kontrolą
  tożsamości, hashów, rozmiarów, ścieżek i kompletności kapsuły.
- `record_handoff_outcome(...)`: jednokierunkowe przejście `staged` → `restored`
  albo `failed`; identyczne ponowienie jest idempotentne, inne terminalne
  rozstrzygnięcie jest odrzucane. Awaria odtworzenia nie usuwa snapshotu.

Binding zawiera `api_instance_id`, `session_id`, `session_epoch`, `generation_id`,
`source_build_id`, `target_build_id` i `source_sha256`. Zachowuje istniejące
ID scratch `session-<uuidhex>` oraz różne kanoniczne reprezentacje UUID API
i generacji. Tożsamość jest porównywana dokładnie; żaden ogólny reconnect
nie otrzymuje na tej podstawie zgody na adopcję innego API.

Wywołujący przekazuje runtime root z resolvera po preflight. Kapsuły trafiają
do `development-handoffs/<UUID>` pod tym rootem. Assety muszą znajdować się
w runtime root; moduł kopiuje ich zweryfikowane bajty do kapsuły, zamiast
uzależniać restore od mutowalnego pliku wejściowego. Zewnętrzne pliki wymagają
wcześniejszego stagingu przez właściciela importu. Loader zwraca ścieżki kopii
dla przyszłego semantycznego konsumenta; nie przepisuje sam referencji sceny.

Zapis obejmuje atomową publikację katalogu, fsync plików, kontrolę symlinków/
reparse points i aliasów plików, odmowę duplikatów kluczy JSON i NaN oraz limity:
64 MiB snapshotu, 16 KiB receipt, 512 assetów, 256 MiB całej kapsuły.
Sumy kontrolne wykrywają uszkodzenie danych; nie zastępują kontroli właściciela
procesu ani autoryzacji przyszłej komendy restartu.

## Weryfikacja

`just verify-windows-development-handoff` uruchamia wyłącznie interpretowane
regresje. Zamknięta gałąź `scripts/just_storage_shell.sh` deleguje do
`scripts/verify_development_handoff.py`, który sprawdza resolver i rejestr
właściciela, trzyma lease worktree oraz zapisuje log i terminalny receipt.
Nie przygotowuje i nie migruje kompatybilnościowego `target` w checkoutcie.

Wynik: **19/19 testów, 0 skipów, exit 0**. Zakres: zachowanie pełnych danych
nieobecnych w projekcji edytora, binding, uszkodzenie snapshotu/receipt/assetu,
próba wyjścia ze storage, symlink, limit odczytu, niepełna kapsuła, NaN,
duplikaty kluczy JSON, zachowanie kopii po failure i konflikty terminalnych
ponowień. Pięć regresji granicy recepty obejmuje także brak wykonanych testów,
same skipy, zmienione źródła, niezerowy exit, wyjątek po exit 0 oraz odmowę
złożonych lub rozszerzonych poleceń przed preflight.

Receipt i log: `storage/builds/<worktree-id>/development-handoff-checks/checks/`
`bb21349eb99040399881e2cf8e6b2ec5/`. Hash źródeł przed i po jest identyczny:
`17b16140caf92f9ba64e564ed72be2e358bc4ff4da3af3121a29dfbbe12de259`.
Nie budowano testów Rust ani nie uruchamiano solvera.

## Następna integracja i otwarte bramki

1. API tworzy kapsułę wyłącznie po zamknięciu admission i ponownym sprawdzeniu
   autorytatywnego stanu pod `current_live_session_transition`. Musi zweryfikować
   pełny `SceneDocument` i wyliczyć wszystkie referencje do assetów; pusty parametr
   `assets` sam w sobie nie dowodzi, że scena nie potrzebuje plików.
2. Launcher wiąże handoff z własnym lease, generacją i zweryfikowaną kopią EXE.
   Kontrola/drain rezydentnego ownera z ADR 0049 pozostaje osobną bramką.
3. Nowy API waliduje kapsułę i odtwarza bezczynny model przed listen; scene
   pozostaje źródłem prawdy, adapter edytora jest z niej ponownie wyprowadzany.
   Stare komendy, preparation, pola solvera i run nie są przenoszone.
4. Frontend rozwiązuje szkice przed wysłaniem komendy i przyjmuje nowy pin tylko
   przez jednorazowy handoff. Restore UI i tożsamość dokumentu projektu wymagają
   osobnych konsumentów.
5. Wymagany jest realny przebieg Windows/browser z geometrią, regionami i
   materiałami oraz fault gates aktywnego solve, Start/restart, build failure,
   restore failure i drugiego klienta. Wszystkie te bramki są **NOT VERIFIED**.

Ten checkpoint nie zalicza całego P8-53 ani kwalifikacji wydania.
