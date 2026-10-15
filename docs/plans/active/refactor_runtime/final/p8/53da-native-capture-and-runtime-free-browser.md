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
Close, identyczne archiwum, powrót do launchera oraz zero HTTP/WS current-session
i mutacji solvera. Zdjęcia New/reopened/closed i pełne logi/raport porażki są
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
