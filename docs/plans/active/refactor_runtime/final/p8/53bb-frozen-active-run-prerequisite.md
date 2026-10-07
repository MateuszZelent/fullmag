# P8-53BB — rzeczywisty aktywny solver z przypiętego pakietu Windows

Data: 06.10.2026. Status: IN PROGRESS. Bramka przygotowuje rzeczywisty
worker do sprawdzenia odmowy restartu oraz Start-vs-freeze. Samo uruchomienie
solvera nie zamyka tych dwóch warunków ani kwalifikacji fizyki.

## Kontrakt

- Odrębna zarządzana recepta `verify-windows-frozen-active-run-runtime build_id`.
- `build_id` jest dokładnym, lowercase SHA-256 manifestu gotowego pakietu.
- Manifest, źródła i EXE przechodzą istniejącą głęboką walidację tożsamości.
- Brak albo mismatch przypiętego manifestu kończy próbę przed zapisem i uruchomieniem; brak fallbacku
  do Cargo, nowego targetu lub bieżących zmienianych źródeł.
- Python używa źródeł DSL ze zweryfikowanego frozen snapshotu, zgodnie z
  kontraktem zarządzanego Windows venv. Import path, wersja pakietu i ABI
  są sprawdzane. Hash interpretera przed/po jest tożsamością rzeczywistego
  środowiska testu, a nie domniemanym historycznym hashem z buildu.
- Test musi obserwować rzeczywisty `run_id`, `solver_steps >= 1` oraz stan
  running/paused. Nie zastępuje ich syntetycznym ledgerem ani timerem.
- API i CLI są własnymi procesami próby; cleanup i wait mają terminalne
  dowody, niezależne od rezultatu funkcjonalnego.
- Pomiar importu/ABI Pythona zaczyna się dopiero po utworzeniu własnego
  receiptu dla zweryfikowanego natywnego pakietu. Błąd takiego pomiaru
  zachowuje PID/wait/exit helpera i nie uruchamia API ani solvera.

## Dotychczasowa trasa

`verify-project-active-run-runtime` ma istniejący realny FDM CPU solve
i test reconnect. Dotychczasowy tryb buduje API/CLI z aktualnych źródeł;
nowy frozen tryb ma korzystać z gotowego pakietu bez takiego buildu.
`verify-project-api-runtime --include-project-run` jest syntetyczny:
sprawdza accepted/blocked bez działającego workera i nie zastępuje tej bramki.

## Weryfikacja wrappera

- Dry-run nowej recepty z prawidłowym digestem: poprawne przekazanie flagi.
- Git Bash `-n` dla wrappera: PASS; nie użyto systemowego `bash.exe`/WSL.
- Nieprawidłowy digest `INVALID`: odmowa wrappera przed driverem, internal
  exit 2 (just exit 1); nie wykonano buildu ani startu solvera.
- Tryb frozen drivera, jego regresje i realny runtime: w realizacji.

## Pierwszy preflight runtime

Driver zgłosił 5/5 PASS interpretowanych regresji. Review wykryło i poprawiono
zapis custody pomiaru Pythona: probe uruchamia się dopiero w scope receiptu,
a timeout/przerwanie zachowują wynik stop/wait albo unknown.

Pierwsze rzeczywiste `just verify-windows-frozen-active-run-runtime e5d8a135567436dcbaab881af770e92afa5c702a0f8040df603838177e82d73c`
zakończyło się odmową preflightu (handle 2399 terminalny, just exit 1,
wewnętrzny exit 2). Nie uruchomiono solvera ani buildu; nie powstał runtime
receipt, ponieważ odmowa nastąpiła przed scope runu.

Przyczyna: `manifest.build_source_snapshot` jest skróconym bindingiem trzech
pól, a przekazanie dict do `build_snapshot.verify_snapshot` oznacza kontrolę
pełnego metadata obiektu. `_verify_snapshot_full` odrzucił niezgodny kształt.
Nie jest to dowód uszkodzenia D. Poprawka używa `record_path`, a potem
porównuje zweryfikowane pola z bindingiem manifestu, zgodnie z istniejącym
`runtime_bundle` validator. Regresja musi odróżniać compact binding od pełnych
metadanych; wcześniejszy mock tego nie obejmował.

W pierwszym przyroście observer Node pozostawał w bieżącym checkoutcie.
Finalny driver utrwala samodzielny plik MJS w katalogu runu i zapisuje
źródłową ścieżkę, wykonaną kopię oraz SHA-256. Kontroluje hash kopii przed
i po wykonaniu. Dowód solvera dodatkowo wymaga `run_id` i `solver_steps`
z zasobu API.

Publiczny restart pozostaje wyłączony. Procentów całego planu nie zmieniono.

## Diagnoza bindingu Pythona

Receipt `cf93a2db49e84c0781dfef0c180875dd` zakończył się `failed`, exit 1,
przed startem API i solvera. Probe Pythona: PID 104092, waited, exit 0,
output drained. Jedynym niezgodnym polem było `soabi`: Windows CPython 3.12
zwrócił `null`, mimo zgodnych wersji, cache tagu, platformy `win-amd64`,
architektury `AMD64`, ścieżki importu frozen DSL i wersji pakietu D.

Odrębny pomiar tego samego zarządzanego interpretera potwierdził
`EXT_SUFFIX=.cp312-win_amd64.pyd` oraz obecność tego dokładnego sufiksu
w `importlib.machinery.EXTENSION_SUFFIXES`. Poprawka kontroli ma wykorzystać
te jawne dowody ABI; niezgodny SOABI, sufiks lub loader nadal muszą powodować
odmowę. Historyczny failed receipt pozostaje zachowany.

Kontrola została poprawiona: exact suffix i loader są obowiązkowe, a brak
SOABI jest dopuszczalny tylko przy pozostałych zgodnych polach Windows
CPython. Interpretowane regresje: **7/7 PASS**, obejmują rzeczywisty kształt
null SOABI, obcy suffix, brak obsługi loadera oraz jawnie obcy SOABI.
Review nowych fragmentów ABI/snapshot/observer: brak actionable findings.
W próbie `c575d6492d504616bceb7622920a2070` binding probe przeszedł:
PID 94784, waited, exit 0, output drained, pusta lista mismatch fields.
Cała próba zakończyła się **PASS, exit 0**, bez kompilacji (`build_skipped=true`,
`build_command=[]`).

## Rzeczywisty frozen runtime — wynik

Receipt: `c575d6492d504616bceb7622920a2070`, profil
`windows-project-active-run-runtime`, API `127.0.0.1:41374`.
Pin pakietu D: `e5d8a135567436dcbaab881af770e92afa5c702a0f8040df603838177e82d73c`.

- Rzeczywisty FDM CPU `flat_relax`: session `session-1791252617522-96160`,
  run `run-session-1791252617522-96160`, solver `running`, obserwowany krok 1.
- Websocket hello seq 13; reconnect `after_seq=13`, hello seq 14.
  Cztery snapshoty HTTP zachowały tę samą sesję i run, stan running,
  dostępność zasobów i niemalejące rewizje. Wszystkie obserwowały krok 1:
  dowód nie ustanawia długotrwałego przyrostu kroków ani wydajności solvera.
- Wykonany observer jest utrwaloną kopią; SHA-256
  `dd6a4f625921493d4ffbcd62deabbdadbdbe4b1049c15ffa1cee521a0c348ee0`.
- Własny helper Python PID 94784: waited, exit 0, output drained.
  CLI PID 96160 i API PID 29744: waited, exit 1 po kontrolowanym zakończeniu
  aktywnej próby przez driver. Te kody cleanup nie są ukończeniem solve.
- Bieżący checkout nie zmienił się w tej próbie. Pakiet i źródła frozen
  zostały niezależnie zweryfikowane; nie dotknięto workspace użytkownika.

Zamknięto prerequisite rzeczywistego aktywnego solvera i bounded reconnect.
Odmowa acquisition podczas rzeczywistego running/paused, wyścig Start/freezing,
walidacja naukowa, publiczny restart i kwalifikacja wydania pozostają otwarte.

## Follow-up — 06.10.2026

Późniejszy punkt [P8-53BC](53bc-real-active-run-restart-refusal.md) zamknął
managed refusal dla running i paused oraz wyścig Start/freeze. Ten raport
pozostaje dowodem prerequisite rzeczywistego frozen FDM CPU runtime i bounded
reconnect; nie zastępuje pozostałych bramek naukowych ani wydania.
