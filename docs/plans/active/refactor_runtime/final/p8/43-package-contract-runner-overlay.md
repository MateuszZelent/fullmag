# P8-43 — kontrola kompletności pakietu w rzeczywistym runnerze

Data: 03.10.2026. Źródłowy kontrakt: commit
`39f08ebc4a10912fcdda9af1ac5b84f36119b50b` (P8-42).

## Zakres

Overlay przygotowano na faktycznie wdrożonym obrazie P8-41, zamiast
zastępować rozszerzony executor jego krótszą wersją z mastera.
Trzy profile release wymagają 15 niepustych plików: pięciu bazowych
i dziesięciu binariów accepted runtime, w tym `fullmag-runtime-service`.
Koordynator wymaga ich wpisów w receipt oraz zgodnych rozmiarów i SHA-256.
Puste opcjonalne logi nadal są dozwolone.

Zachowano osiem definicji profili obrazu. Specjalistyczne gałęzie kontroli
receipt dla runtime SLEPc i kontraktów naukowych są identyczne ze źródłem
wdrożonego obrazu. Walidator entrypointu nadal przyjmuje jawny argument
`required_outputs`, używany przez istniejącą ścieżkę FEM headless.
Wspólny selector nie nadaje legalności profilu ani nie zastępuje tych
specjalistycznych wymagań. Operatorowa lista siedmiu profili pozostaje
osobną granicą admission.

## Tożsamość i dowody

| Element | Wartość / wynik |
|---|---|
| Obraz bazowy | `sha256:1aa31b600114e35dac112821bfe0ee1317a00641077bf4ecee546e0747550665` |
| Obraz overlay | `sha256:80c50398c7a382f8eb35dc50dc747803b740a9d5fc98bbbed7d139b23bfa10ff` |
| SHA-256 entrypointu | `5841976a2f72ee83a47dbf17b234d72c63ad5fdc38a787eeec4c1ccc9d3504f0` |
| SHA-256 executora | `70f12132f62707b6db0b43bb232dcc07944d4659a0fc010dda808cd7210378f0` |
| Interpretowane testy w obrazie | 7 PASS, exit 0; bez kompilacji Fullmaga |
| EntryPoint: każdy wymagany plik brakujący/pusty | 90 podprzypadków PASS, 15 × 2 × 3 profile |
| Receipt: każdy accepted/runtime-service wpis brakujący | 30 podprzypadków PASS, 10 × 3 profile |
| Pełny receipt, pusty opcjonalny log | PASS dla trzech release profiles |
| Jawne headless outputs FEM | PASS; zgodność istniejącego wywołania zachowana |
| Pozostałe definicje i stałe modułów | Porównanie AST PASS; specjalistyczne gałęzie receipt także identyczne tekstowo |
| Hashe plików odczytane z obrazu | Zgodne z przygotowanym kontekstem |
| Niezależny review | PASS, bez P0/P1; minimalność i zgodność specjalistycznych kontraktów |
| Wdrożenie | DEPLOYED przez własną kontrolowaną pauzę pustej kolejki, managed replace i resume |
| Kontener koordynatora | `72f939ec50a5512805832295f63fa5db537fddae22d0c600dd789537f44fda18` |
| Stan po wznowieniu | `ok=true`, `worker_alive=true`, `accepting_jobs=true`, bez aktywnych jobs i błędu wykonawcy |
| Mounty i allow-list | Identyczne przed i po wymianie; siedem profili operatorowych zachowanych |
| Job 218 | Cała odpowiedź status przed/po identyczna; queued, zachowana kapsuła i request key |
| Build 218 / runtime / kwalifikacja | QUEUED / NOT VERIFIED / NOT VERIFIED |

Kontekst, baseline dwóch wdrożonych plików, zmienione pliki, Dockerfile,
interpretowany verifier i `verification.json` zapisano w kanonicznym storage:
`runs/fullmag-0950f4dca4ffe38f/package-runner-overlay/a03373d3e02148cdae95468447932563`.
Obraz powstał przez dwie operacje COPY, z przypiętej lokalnej bazy,
bez pobierania obrazu i bez sieci podczas budowy.

## Wdrożenie i pozostała bramka

Po niezależnym review potwierdzono zdrową kolejkę bez aktywnego joba.
Własna pauza `1670b686a58048b78508590d8399c1e0` poprzedziła wymianę
przez zatwierdzony klient runnera. `resume` zwrócił `resumed=true`.
Rzeczywiste hashe i osiem profili odczytano z nowego kontenera; są zgodne
z przygotowanym obrazem. Pełne lokalne dowody znajdują się w
`deployment.json` obok `verification.json` w powyższym kontekście.
Aktualny job 218 (`5a2659ca616448fdacd75e16f004e2af`) zachował
source digest `bedb167cb41845460cccf9634af8bfc8418f29641e27ac014f14cef05e2c71a8`.
Nie zgłoszono zastępczego joba ani nie anulowano istniejącego.

Brak miejsca dotyczy dysku Windows C:, na którym znajduje się kanoniczny
storage. Po wymianie pomiar wyniósł 8 038 526 976 B, poniżej minimum
8 589 934 592 B. Wolne miejsce wewnętrznego dysku Docker nie usuwa tej blokady.
Nie usunięto cache, danych sesji, wyników ani katalogów wykonania.
Weryfikacja fixture nie zastępuje terminalnego buildu, pełnego receipt,
uruchomienia natywnego Windows, dowodu UI ani kwalifikacji naukowej.
Procenty etapów pozostają bez zmiany.
