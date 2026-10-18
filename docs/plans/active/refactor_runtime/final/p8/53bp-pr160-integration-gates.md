# P8-53BP — aktualne przeszkody integracji PR #160

Data: 14.10.2026. Status: **IN PROGRESS / integracja nieukończona**.
Odczyt istniejących CI i Git, bez fetch/pull/merge, ponawiania workflow,
kompilowania testów jednostkowych ani zmian w cudzym dirty checkoutcie.

## Dokładne źródła dowodu

- Lokalny master i head PR: `8327547da71dd3c68054d4c36e637bedefc939ec`.
- `git ls-remote`: remote master `e40295e419aaf212fb69885c573ac6d6e60c9e69`.
- PR merge ref: `9b3dd8d1627fdd6d7ab3c8005dbc49ba04148b07`.
- Log Checkout potwierdza merge tego head w powyższy remote master.
  Pole baseRefOid w odczycie PR zwróciło starsze `911902d6...`; nie użyto go
  jako dowodu faktycznie testowanego drzewa.
- [Bootstrap 38501235288](https://github.com/MateuszZelent/fullmag/actions/runs/38501235288): failure.
- [Modal observables 38501235226](https://github.com/MateuszZelent/fullmag/actions/runs/38501235226): failure.
- Prywatny pakiet Windows `cb9c2825...`: bramka
  `81eb7f40d2c8428baae938f5be5bef73` PASS / exit 0 / 10 kontroli / 27 procesów.
  To inne drzewo i zależności niż merge CI; nie zastępuje kwalifikacji integracji.

## Przyczyny i następne czynności

| Zakres | Aktualny błąd | Wymagany następny krok |
|---|---|---|
| Rust / API codegen / checkpoint / FDM smoke | E0004 w fullmag-runner/src/lib.rs:2605, Adaptive match nie obejmuje BackendPlanIR::AntennaExternalLeadInspection | Doprecyzować jawną odmowę lub obsługę tej lane w izolowanym drzewie integracji; zachować brak cichego fallbacku. |
| Field Map / browser / modal contracts | Dwukrotne const monitorId oraz const newName w fieldMapCommands.ts; parse error | Scalić walidację oraz mutację, zachowując aktualny scope/revision/history. git show remote e402 potwierdza oba duplikaty już w remote master. |
| Production TypeScript | ERR_PACKAGE_PATH_NOT_EXPORTED: typescript/bin/tsc | Dostosować kontrolowany launcher do eksportów rzeczywiście przypiętego TypeScript; lokalny starszy toolchain nie dowodzi zgodności. |
| Bootstrap workflow contract | Oczekiwana kolejność kroków nie uwzględnia complete session reachability/archive; oczekiwano 5 checkoutów, jest 6 | Ocenić kontrakt względem wymaganych bramek, zaktualizować regresję bez usuwania kontroli reachability. |
| Pozostałe merge gates | Modal React Doctor zgłasza błąd i ostrzeżenie; część downstream jobs skipped, managed FEM queued | Osobno przeczytać diagnozy, rozwiązać wspólne przyczyny, zebrać wymagane dowody bez uruchamiania zakazanej kompilacji testów. |

Production build i runtime proof lokalnego pakietu nie są podstawą do
scalenia czerwonego merge tree. Nie wpisano remote wariantów Rust do starej
lokalnej definicji ani nie zmieniono cudzej pracy w fullmag-runner/lib.rs.
Główny checkout zawiera kilkadziesiąt cudzych zmian Compute/API/FEM;
bezpieczne poprawki integracyjne wymagają odrębnej izolacji i dokładnej bazy.
Pełne P8/cutover/release pozostaje niezaliczone.

## Przyrost: kompatybilny launcher TypeScript

Na autoryzowanym lokalnym masterze wdrożono mały, zgodny z dotychczasową
wersją TypeScript fragment wcześniej przygotowanej poprawki
`b3ebfeda07591926c0cc917f2332598908761717` z odrębnej izolacji.
Nie scalono całego worktree ani zależności. Przed zmianą launcher był zgodny
z HEAD (git diff --quiet exit 0); nowa regresja nie istniała. Kopię zachowano
w katalogu dowodów tej sesji. Nie zmieniono cudzych plików Compute/API/FEM.

Launcher odczytuje jawny bin.tsc z eksportowalnego package.json TypeScript
zamiast rozwiązywać blokowany subpath typescript/bin/tsc. Zachowuje kolejność
Next typegen → tsc, odtworzenie next-env.d.ts i propagację błędów. Regresja
uruchamia rzeczywisty launcher z lokalnymi fixture CLI, bez kompilatora
TypeScript/Rust, instalacji zależności ani Next build.

Nowa stała recepta `just verify-control-room-typecheck-cli` jest dopuszczona
przez dokładny preflight argumentów i korzysta z managed source wrappera,
profilu windows-control-room-source-check, locka, kontrolowanego TEMP i
terminalnego receiptu. Ogólny storage run odmówił tej trasy jako ciężkiej;
nie obchodzono odmowy ręcznym uruchomieniem. Dodano również interpretowaną
regresję przed dotychczasowym typecheckiem w istniejącym kroku CI.

- Receipt `3ed564ad912c4df1b8589c46f56df5f2`: **PASS, 4/4**, exit 0.
  Ograniczone exports, brak bin.tsc, błąd Next i błąd tsc sprawdzone.
- Production source receipt `50d0f234fed3416582c75c587c4dc26f`: **PASS**,
  exit 0, test sources wykluczone, source_changed_during_run=false.
- W obu source digest before=after:
  `ce8eec8a3f1add30b7e5413bdd0cb6a4f067308701c1d61c9634397aed670c85`.
- Bash parser obu zmienionych skryptów, Python AST i scoped diff check PASS.
- Launcher SHA-256:
  `95264ed31106b1794c99f7e640c81e8c9f3c35154eb0f9970ebacc73473f7812`.
- Regresja SHA-256:
  `86ff334f4a53fac47f493d2b7b2227fcbc1f735d27593b3b83f3555d5b0317a5`.

Nie uruchomiono testów kompilowanych. Nie wykonano nowego buildu backendu,
ponieważ zmiana dotyczy narzędzia kontroli źródeł. Aktualne hosted CI dla
nowej poprawki pozostaje NOT VERIFIED. Publikacja napraw wywołująca workflow
kompilujące testy czeka na odpowiedź użytkownika dotyczącą aktualnego zakazu
z AGENTS.md. Cała integracja i P8 pozostają IN PROGRESS.

Bounded independent source review tego przyrostu: brak actionable P0/P1/P2.
Review nie uruchamiał kompilacji ani CI; odwołuje się do powyższych receiptów.

## Zgoda na CI — 14.10.2026

Użytkownik odpowiedział: „Tak, zezwalam na testy w CI tych napraw” na pytanie
o wyjątek dla napraw integracji i PR #160. Wcześniejsze oczekiwanie na tę
odpowiedź jest zakończone. Wyjątek obejmuje CI wskazanych napraw; nie odwołuje
zakazu lokalnego kompilowania unit testów. Samo zezwolenie nie dowodzi
zielonych kontroli ani scalenia. Ponowny readback PR potwierdza OPEN,
head `bd60ca1f0735a06abf95bdb71b80fbce9c80396f`, merge state UNSTABLE.
Aktualne niepowodzenia wymagają naprawy oraz nowego wyniku CI przed merge.
