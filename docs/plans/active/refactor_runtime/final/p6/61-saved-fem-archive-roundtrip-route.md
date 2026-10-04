# P6-61 — trasa kontroli archiwum zapisanego FEM

Data: 01.10.2026, checkpoint 13:16 UTC.
Baza: `06f2ce914b65cc33663eebfdc86c10f7cf7d11d6`.
Status: procedura i zabezpieczenia źródłowe; rzeczywisty roundtrip **NOT VERIFIED**.
P6 około **52%**, cały plan około **49%**, bez podwyższenia po testach helpera.

## Przebieg

`just verify-saved-fem-archive-roundtrip` korzysta z istniejącego produkcyjnego
`fullmag-bin`, nie buduje kodu ani nie uruchamia solvera. Konfigurację wskazuje
`FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG`. Brak konfiguracji kończy się odmową
przed utworzeniem danych. Adapter shell dopuszcza tylko stały kształt recepty.

Driver sprawdza terminalny coordinator receipt, trusted execution context,
pełne hashe zaufanych plików i wszystkie artefakty managed buildu. Wymaga
exact clean commit/native source snapshot, profilu `fem-cpu-release` i zgodnego
startup stamp każdej komendy. Binary oraz źródła drivera mają hashe w receipcie.

Następnie:

1. Blokuje istniejący natywny descriptor oryginału współdzieloną blokadą
   odczytu: Windows `LockFileEx`, Linux `flock`. Blokada jest nonblocking
   i pozostaje aktywna przez cały przebieg, bez zmiany danych descriptora
   lub dokumentu ownera. Nie wnioskuje o braku writera wyłącznie z PID/age
   ani `released=true`. Legacy LOCK i niezwolniony owner nadal są odrzucane.
2. Sprawdza inventory oraz CURRENT: pinned run musi być w session `run_refs`,
   z run manifest i artifact catalog. Odrzuca symlink/junction, urządzenia,
   zbyt duży magazyn i nieobsługiwane dokumenty projektu przed eksportem.
3. Kopiuje magazyn do własnego rootu. Pomija tylko procesowe `WRITER.lock`
   i `WRITER.owner.json`; dokumenty i CAS pozostają bajtowo identyczne.
   Weryfikuje inventory kopii i niezmienność oryginału.
4. Uruchamia bramkę P6-60, eksport `session save --profile archive`, import
   `session open` do drugiego pustego rootu oraz tę samą bramkę po imporcie.
   Porównuje pełny native snapshot receipt dla dokładnego pinned source.
5. Tworzy kolejną kopię importu, zmienia jeden bajt pierwszego chunku pola
   i wymaga niezerowego kodu oraz błędu integralności CAS. Inny błąd procesu
   nie zalicza tej kontroli negatywnej.
6. Potwierdza niezmienność oryginału, binarium i źródeł drivera. Zachowuje
   wszystkie kopie, archiwum, logi i receipt; niczego nie usuwa.

Każda komenda ma osobne logi, PID i stan. Timeout obserwacji zachowuje proces
oraz `observation_pending`; nie jest błędem solvera, nie ponawia eksportu/importu
i nie powoduje restartu. Kopie leżą pod resolved build storage, również
w Linuxowej trasie zarządzanego storage; brak zatwierdzonej konfiguracji
pozostaje blokadą, bez użycia Windowsowego profilu jako obejścia.

## Wejście i ograniczenia

Konfiguracja JSON znajduje się w kanonicznym storage i zawiera dokładnie:

| Pole | Znaczenie |
|---|---|
| `build_run_root` | Absolutny katalog zakończonego jobu managed runnera. |
| `store` | Absolutny istniejący magazyn przeznaczony do kontroli. |
| `pinned_source` | Plik PinnedSolutionTensorSource, bez latest/active lookup. |
| `source_artifact_id` | Exact source z bindingu tensora, sprawdzany przez P6-60. |
| `expected_commit` | Pełne SHA źródła binarium. |
| `expected_native_source_snapshot_sha256` | Exact native source snapshot z jobu. |

Magazyn ma limit 1 GiB i 50 000 członków, config 16 KiB; preflight wymaga
pojemności dla sześciokrotnego rozmiaru wejścia i 512 MiB zapasu. Nie jest
to pomiar RAM ani peak storage solvera. Trasa nie obejmuje exact resume,
CPU/GPU parity, marker/facet/support certification ani nauki.

Znane ograniczenie istniejącego importera Archive: `current_live_snapshot.json`,
`asset_index.json` i nieznane pliki projektu mają niepełne reachability.
Driver odrzuca taki magazyn z listą plików; nie usuwa ich, nie zmienia profilu
na Solved i nie przedstawia niepełnej kopii jako pełnego Archive roundtrip.
Ich obsługa w ogólnym archiwum pozostaje osobnym otwartym zadaniem.

## Dowody źródłowe

**35 lekkich testów Python PASS**: 22 drivera oraz 13 istniejącego build executor.
Obejmują exact/dirty/ambiguous startup identity, source/result scope, wymagane
hash receipts, copy barrier, link refusal, brak cichego usunięcia dokumentów,
CURRENT/run_refs, adapter recepty oraz rzeczywistą próbę native locka na Windows:
obcy proces z exclusive lock jest odrzucany, po zwolnieniu locka przechodzi,
a descriptor i inventory pozostają niezmienione. Nie kompilowano Rust/C++ tests.
Repo consistency: PASS. Runtime całej trasy nadal **NOT VERIFIED**.
Końcowy niezależny review: brak P0/P1. Uwagę P2 o rozmiarze CURRENT
zamknięto limitem 4 KiB i regresją odmowy przed dekodowaniem manifestu.

Wspólny validator artefaktów używa teraz strumieniowego SHA-256 w chunkach
1 MiB, kompatybilnego z Pythonem 3.10; nie zmienia containment, profili,
provenance ani trust boundary. Ponowna walidacja wszystkich 113 artefaktów
buildu 189 po tej zmianie: PASS, bez zmian w ustawieniach runnera.

## Nowy dowód managed i następny krok

Build **189**, `529ac93e81744c5faf50494306d50a11`, zakończony: coordinator
`phase=terminal`, `state=succeeded`, exit 0. Wszystkie trzy etapy mają exit 0.
Zweryfikowano **113 artefaktów**, 236 078 257 B: brak brakujących plików,
niezgodności SHA/rozmiaru lub ścieżek poza artifacts. Źródło:
`8bb7f068d097d94a5266983d64b07f2ca2d470b9`, native snapshot
`494960d87cdbdefc8fbd4e18fa051c4b3541ac41135e7dfbc4b8da21fe9da193`.
Receipt nadal `qualification=NOT VERIFIED`: dowód buildu P6-55, nie runtime
ani map/geometrii/CLI z P6-57–60.

Build **191** (`78d0c52ecb0245aa85f9411d76f8b914`) zakończony **failed**,
exit 2, native-build exit 2. Rust runner nie widzi nowych modułów quantities/IR
i pól receiptu, chociaż są obecne w exact execution source. Trwa diagnoza
metadata zależności/cache; nie naprawiono jeszcze przyczyny tego buildu.
192 (`5d750ed66e584869ab6e88e48c457c86`) nadal **queued**. Zachowano oba.
192 ma dostarczyć komendę P6-60; jego identyfikatory są w
[checkpointcie P6-60](60-saved-native-snapshot-integrity-gate.md).
Zmiany P6-61 dotyczą drivera i portable hash helpera; nie zlecono nowego buildu
natywnego tylko z powodu tej procedury.

Po buildzie 192 potrzebny jest rzeczywisty accepted FEM run z finalnym mapped
snapshotem i pełną geometrią, przeprowadzenie tej trasy i odczyt terminalnego
receiptu. Dalej otwarte są binary geometry API, resource hooks, renderer,
browser/WebGL i pozostałe bramki P0–P8.
