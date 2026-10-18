# P1/P8 — przechwycenie źródeł i rzeczywisty browser lifecycle bez sesji

Data: 15.10.2026. Baza: `9545f242abf30f24efc496fbb44c8403c130f946`.
Cały plan pozostaje IN PROGRESS, bez awansu procentów na podstawie harnessu.

## Build Windows

Po potwierdzonym zniknięciu wcześniej obserwowanego procesu PID 160168
uruchomiono `just windows-workspace-build dev dev 3197 auto`. Próba
7427d69bf0194d8786a3235062596e86 zakończyła się przed Cargo: po trzech
próbach snapshot odmówił zmienionego podczas kopiowania owned_worker_process.rs.
Log zachowany pod windows-native-fdm-cpu-dev/logs/native-build-<id>.log.
Nie uruchamiano częściowego pakietu i nie nazwano tego błędem kompilatora.

Snapshot dotychczas kopiował całą posortowaną listę plików przed końcowym
confirm_origin. Przeniesiono kopiowanie i sprawdzenie chronionych źródeł
przed długą kopię frontend/docs/qualification inputs. Manifest nadal obejmuje
wszystkie faktycznie skopiowane bajty, a chronione wejścia nadal mają tę samą
kontrolę źródłową. Źródła po tym etapie są niezależne od origin. Nie obiecano
odporności na bezustanne edycje podczas samego chronionego etapu.

Interpretowane regresje: 17/17 PASS; pełny receipt i granice w
[P8-54](54-manual-native-build-snapshot.md). Natywny build nowej wersji tej
ścieżki jeszcze wymagany. Staging nieudanych prób, cache, logi i manifesty
zachowane; niczego nie usunięto. Ponowna ocena retencji po potwierdzeniu
następcy i referencji.

Kolejna próba e87965eccad443abba20c0a4441e3f4a poprawnie utrwaliła snapshot
f806cb8b7b64dea062682051d72255187a573c14ed8b72f1ffbbc120df796c87
z bazą 1a0198ef31d16b7f283e50c79ace24538a05b9cd i jawnym dirty provenance.
Przeszła do przygotowania zależności. Wynik kompilacji i publikacja nowego
manifestu pozostają wymagane; samo przechwycenie nie zalicza buildu.

Wynik próby e87965eccad443abba20c0a4441e3f4a: **PASS, exit 0**,
terminalny build-status.json zakończony 15.10.2026 10:07:50 UTC.
Profil backend-dev, source_identity_check=passed, manifest SHA-256
340c667b3756a46f089338ac9216897598631d674eaef6b72472ea2072678a32.
Backend, pomocnicze procesy i desktop skompilowano z utrwalonej kopii mimo
późniejszych commitów checkoutu. Nie kompilowano lokalnych testów jednostkowych.
To build natywnego pakietu Windows, bez awansu FEM/GPU/solver/release.
Po etapie zachowano cache przyrostowy, nowy pakiet, snapshot, log i provenance;
brak usuwania danych. Wolne miejsce: C 23.91 GiB, R 69.91 GiB.
Starsze dane wymagają ponownej oceny referencji przed ewentualnym cleanup.

Na dokładnym powyższym manifeście uruchomiono nową bramkę browser lifecycle.
Jej wynik nie jest jeszcze znany; sam udany build nie zalicza M1.

## Nowa zamknięta bramka M1

Przygotowana recepta `just verify-windows-project-document-browser <build_id>`
rozszerza istniejący verifier wyłącznie w osobnym frozen project-document
scope. Wymaga dokładnego 64-hex hasha manifestu zweryfikowanego natywnego
pakietu; nie buduje, nie instaluje zależności i nie uruchamia istniejącej
sesji użytkownika. Nie korzysta z wycofanego restartu developerskiego z UI.

Backend jest prywatnym procesem API istniejącego verifiera. Frontend jest
kontrolowaną kopią aktualnego produktu /workspace na localhost:3269, z
walidowanymi istniejącymi zależnościami. Nie ma fixture route ani mock API.
Cykl ma wykazać sessions=[] przed/po, stałą instancję API, New/Save/Open/Save/
Close, identyczne archiwum, powrót do launchera oraz zero żądań runtime-session,
WS current-session i mutacji solvera (hostowe aliasy opisano poniżej).
Zdjęcia New/reopened/closed i pełne logi/raport porażki są
artefaktami. Własne PID-y są rejestrowane, procesy czekają na terminalny stan,
a port ma być zamknięty. Źródła, zależności i helper muszą pozostać zgodne.

To dowód dokumentu bez RuntimeSession, nie geometry/material authoring bez
sesji, launchera EXE, solvera, fizyki ani release qualification. Te bramki
pozostają osobne. Runtime i browser tej nowej recepty: NOT VERIFIED.

Kontrole przygotowania: Node parser / Python AST / just dry-run PASS.
Pięć interpretowanych kontroli błędnego scope/trybu/URL PASS bez uruchamiania
API ani przeglądarki: receipt
windows-control-room-source-check/project-browser-input-validation/e6cd2bc03c4545d384808e2faf8bb2a0.
Nie jest to dowód udanego cyklu New/Open/Save.

Pierwsze rzeczywiste wykonanie a0cbe81fea6f4f73ab09b8b038ef5918 zakończyło
się **FAIL**: New/Save/Open/Save/Close i byte_roundtrip przeszły, sessions=[]
przed/po i ten sam API instance, lecz test odrzucił sześć GET host CPU/GPU.
Oba handlery platform/system.rs nie przyjmują State ani RuntimeSession;
wersjonowany compute-resource-execution-v1.md jawnie zachowuje te aliasy
session diagnostics jako adapter host telemetry, a test session_scope.rs
wyklucza je z wymogu session scope header. To zbyt szeroki warunek verifiera,
nie dowód utworzenia runtime ani powód do usunięcia sprzętu z launchera.

Doprecyzowanie scope: wymagane jest zero żądań
runtime-session i zero WS/mutacji sesji. Wyłącznie dokładne GET
/v2/sessions/current/diagnostics/cpu oraz /gpu są osobno raportowanymi
host_telemetry_requests. Pełna lista current_session_requests pozostaje
w raporcie; Python wymaga jej równości liście host i sprawdza każdy literal.
POST do tych ścieżek, suffix, status i solver-profile nie uzyskują wyjątku.
Nowa regresja tej granicy daje **4/4 PASS** razem z wcześniejszymi ochronami.
Migracja aliasów do platformy pozostaje pracą P3a, nie jest tu pozorowana.

Wszystkie własne procesy pierwszej próby są terminalne/waited, port 3269
zamknięty; źródła i zależności zachowały fingerprinty. Raport i logi porażki
zachowane. Scenariusz po precyzyjnym dopasowaniu kontraktu wymaga powtórzenia.

Review wskazało lukę: samo sessions=[] przed/po oraz brak current-session
requests nie wyklucza chwilowego POST /v2/sessions i późniejszego DELETE.
Tryb absent odrzuca teraz każdą mutację kolekcji /v2/sessions i jej potomków.
Wspólny klasyfikator jest rzeczywiście używany przez obserwator żądań.
Interpretowana regresja Node: **3/3 PASS**, exit 0 (POST kolekcji, DELETE ID,
PATCH current, dozwolone discovery/persistence, zachowane solver guards obu
trybów). Nie uruchamia przeglądarki, API ani kompilatora i nie zapisuje plików.

## Kolejne CI i meshing

Python 116345739491 potwierdził Gmsh 45/45, sceny 127/127 i ordered-stage
82 PASS + 39 subtestów. Dalsze meshing 337 testów: 6 errors / 1 skip.
Pięć błędów dotyczyło fixture: dwa mocki generate bez object_id, trzy przypadki
finalizacji ring z błędnym mapowaniem płaszczyzny źródłowej. Uzupełniono jawne
ID i asercje wiązania oraz face-Z + extrusion step. Walidacje dodatnich,
zerowych i ujemnych tetów zachowane.

Celowany interpretowany odbiór mocków: **4 PASS + 2 subtesty**, 333 deselected,
exit 0, source hashes przed/po zgodne (test, problem.py, meshing/__init__.py,
_gmsh_swept.py). Receipt:
windows-control-room-source-check/meshing-fixture-contracts/fc6304426d9e41a9a3a4d8cc843f66ac.
Nie uruchamiał generatora jakości jako substytutu tej bramki; dotyczy tylko
fixture identity/finalization. Pełne meshing CI nadal wymagane.

Szósty błąd jest rzeczywistą odmową all-family quality: baseline mixed box
80×60×16 nm, airbox 100×80×100 nm, lokalny target 2 nm, bez local floor;
prism6=0.5646, pyramid5=0.2927, tet4=0.0843146 < 0.1. Źródłowy audyt wykazał,
że repair tetrahedra obsługuje degeneracje, a optimizer rusza tylko apexy
piramid i optymalizuje ich jakość; dodatni, niskiej jakości tet może pozostać.
Nie wiadomo jeszcze, czy konkretne złe tety są incydentne z tymi apexami.
Wymagany pomiar tags/connectivity/centroid i przecięcia z apexami przed/po
optymalizacji. Nie obniżono bramki, nie pominięto testu ani nie zmieniono
baseline na łatwiejszy. Numerical fix wymaga osobnego odbioru i dokumentacji.

UI 116350825864: 8536 PASS / 1 FAIL / 13 skip. Test retencji invalidował status
przed jego minRefetchIntervalMs; kolekcja odświeżyła się, status jeszcze nie.
Test przesuwa zegar Date.now poza rzeczywisty statusRefreshIntervalMs przed
invalidacją, zachowując wymóg wykonania obu odrzuconych żądań i retained draft.
Nowy odbiór CI wymagany; produkcja bez zmian.

Odbiór po publikacji c689caee2188a86e645e26aa03270e9212c1f7ca:
[bootstrap 38717371012, job 116363230322](https://github.com/MateuszZelent/fullmag/actions/runs/38717371012/job/116363230322)
**SUCCESS**. Typecheck/lint oraz 828 plików testowych: **8537 PASS / 13 skip**,
0 FAIL; compute performance audit, dodatkowe 3 testy benchmarku i produkcyjny
build Next również zakończone poprawnie. Zamknięto źródłowy odbiór regresji
retencji powłoki. To nie zastępuje natywnego browser lifecycle ani kwalifikacji
solverów. Python/Rust tego runu nadal w toku w chwili checkpointu.

Python job 116363230506 zakończył się: 337 testów meshing, **1 error / 1 skip**.
Wcześniejsze pięć błędów fixture nie powraca. Jedynym błędem pozostaje dokładnie
test_swept_source_face_lower_bounds_compose_before_generation i tet4
0.08431461176486649 < 0.1. Artefakt CI 11964501312 zachowany. Progu nie zmieniono.
