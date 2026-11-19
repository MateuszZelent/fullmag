# CoFeB na masterze — wynik odbioru, 29.10.2026

## Wynik

`fullmag-master` działa pod <http://127.0.0.1:3198/workspace>, z limitem
**128 GiB / 16 CPU**. Oryginalny przykład
`examples/permalloy_layer_cofeb_rings_relax_300nm.py` zakończył **10 iteracji
minimizacji BB**, FEM / GPU / double / strict, engine `fem_native_gpu`.
To iteracje minimizacji, nie kroki czasowe LLG; czas fizyczny wynosi 0 s.

Siatka ma **1 087 250 komórek** i 183 764 węzły. Native receipt i API
potwierdzają Completed, accepted step 10. Compute Fields wykonano raz,
po zakończeniu runu. Pozostawiono działające usługi i załadowane wyniki.

## Naprawy i ochrona danych

- Granice cylindra uwzględniają unormowaną `axis`; dla osi X półwymiary
  wynoszą `[height/2, radius, radius]`. Bounds API potwierdziło zmax pierścienia
  **310,8 nm** oraz niezmienione Universe **2,8 × 2,1 × 1,2 µm**.
- Study catalog o rozmiarze **81 275 356 B** był błędnie czytany z limitem
  **16 MiB** przeznaczonym dla metadanych. Definition/catalog otrzymały
  odrębny limit odczytu **256 MiB**; StudyPlan zachowuje 16 MiB. Submit i batch
  sprawdzają zgodne limity przed publikacją CAS i RunIntent. Nie usunięto
  walidacji hash, typów, tożsamości ani requested/resolved execution.
- Whitelist ukończonego mesh workspace rozpoznaje `isolated_snapshot_restore`.
  Explicit fresh-state archiwizuje wcześniejszy stan i wygasza tylko stary
  bootstrap po dokładnym succeeded archive/recreate i prawdziwym native drain.
- Nieuruchomioną aktywację z błędem katalogu zamknięto istniejącą ścieżką
  preparation-abort, rozszerzoną o Ready/catalog-failure. Wymaga ona manual
  RunIntent, braku RunCatalog/release/claim/workera i aktywnych rezerwacji.
  Końcowy stop miał exit0, obu schedulerów exited_success i uwierzytelniony
  nativeDrained. Stary intent, marker, receipt i dane zachowano.
- Zdrowy publisher zmienia `runtime_state.snapshot_sha256` w ledgerze.
  Wyłącznie wariant catalog-failure pomija ten jeden wskaźnik przy porównaniu;
  readiness, policy, owner i rezerwacje pozostają objęte fingerprintem.
- Managed browser validator używa teraz kanonicznego `metadata_cache_key`,
  tak samo jak producent wolumenu. Zachowano kontrole nazwy, etykiet i mountów;
  poprzednia kopia wzoru pomijała metadane i odmawiała przed startem przeglądarki.

Nie tworzono worktree, nie uruchamiano testów jednostkowych, nie wykonywano
commit/push, reset/stash ani kasowania wyników. Zachowano równoległe merge i
zmiany `external_solvers/3`. Buildy aplikacji odbyły się w backendzie grupy.
Wymagana przypięta konserwacja cache zakończyła się succeeded
`d3361d22698343f8970fcd2b2b066a2f`; nie użyto globalnego prune.

## Dowody wykonania i wizualizacji

[Pełny zapis metadanych, hashów i komend](../diagnostics/2026-10-29-cofeb-master-step10/runtime-evidence.json).

| Dowód | Wynik |
|---|---|
| `m/full` | 183 764 próbki, 551 292 wartości f64; wszystkie skończone |
| `H_demag/airbox` | 157 393 próbki, 472 179 wartości f64; skończone, niezerowe |
| `H_eff/airbox` | Taki sam zakres Airbox, wartości skończone i niezerowe |
| Frame wszystkich trzech pól | source_step=10, stale_by_steps=0, state=complete; ta sama sesja i domena |
| Hash `m` w odpowiedzi otrzymanej przez przeglądarkę, API i native GPU snapshot | identyczny: `f87c4d4ea756c9a9f287c12d0465c07981cd9d3dd3296207e0cabfed44392f26` |
| Energia bieżąca | step10, total `-3.668191276379833e-16 J` |
| GPU | RTX 4080 SUPER, `GPU-fcb9fbf1-8284-37c7-af5b-76bcbf2d2937`, native execution receipt |
| Browser | widoczny canvas, WebGL2 contextLost=false, drawing buffer 617×495, zero błędów strony/HTTP |
| Obejrzany PNG | kolorowane powierzchnie `m` i glify wektorów w Airboxie |

![Magnetyzacja i H_demag po 10 iteracjach](../diagnostics/2026-10-29-cofeb-master-step10/viewport-m-hdemag.png)

Dodatkowo przechwycono [rzeczywiste odpowiedzi binarne przeglądarki](../diagnostics/2026-10-29-cofeb-master-step10/browser-field-network.json). Hash m jest zgodny z GPU; odpowiedzi H_demag dla 9600 i 1200 próbek odpowiadają dokładnie tym samym deterministycznym zapytaniom do API. Nie porównywano hashów próbkowanego H_demag z pełnym polem 157 393 węzłów.

Browser używał SwiftShader. Jest to dowód renderu WebGL, niezależny od
powyższego dowodu rzeczywistych obliczeń GPU. Sam sygnał DOM data-ready nie
kwalifikuje danych; odczyt binarny sprawdzono osobno. Nie wykonywano pełnych
bramek R7, kwalifikacji numerycznej ani nowej próby FDM/FEM CPU.

## Przypięte wersje i czasy

- Build native: `b502a4c2a838301e5091ea8b840918ee854fc399` + lokalne poprawki;
  snapshot `e03aae332099a71882223973fb63dc7587d2776683f4a1d31cc305edfa7aa633`.
- Development `176c53b2754048829eb049e7d7239863`, Compose SHA256
  `5b9568299bb7e0ee0ec63b5d7df209d7b448cf764a59995ed1e4187b4df50db8`.
- Aktywacja `da24dcf82a1048438126c12540703dea`, succeeded; run
  `run-live-f83f7552cf05f87b1eeb213f88de34fbf9202abcbf918bfa8634bb8f17db68c1`.
- Jedno Solve: `fm-2d70d294-0839-45e8-a081-9686a0237185`, completed.
  Jedno Compute Fields: `fm-6b08ecf0-a9f2-4f70-b64d-5d5aecd5ab84`, completed.
- Managed browser: `bdd1ea76bff04970b0efde4f0f017478`, succeeded.
- Build aplikacji: **92,017 s**; materializacja: **464,135 s**; native domain
  preparation: **240,602 s**. Łącznie przygotowanie: **11 min 44,737 s**.
  Od przyjęcia Solve do completed w journalu: **658,951 s**. Compute Fields:
  **0,373 s**. Są to czasy całych etapów, nie pomiar samych kernelów GPU.
- Równoległe FF przesunęły źródła frontendu przez a9a47 do
  `b2b159c58fb921efbf278c120d12d268d958d03b` podczas odbioru. Zachowano je;
  istotne hashe napraw i skryptu nie zmieniły się. Frontend HMR i native build
  mają zatem osobne provenance. Nowe zmiany backendu dotyczące widoku 2D nie
  zostały wdrożone tym wcześniejszym buildem; nie przypisujemy im tego odbioru.

## Pozostałe problemy — nie maskować wyniku

1. **Skalary telemetrii są niespójne.** `/data/scalars?...&limit=1&tail=true`
   zwraca prepared row i observation_frame kroku 0; `/status`, końcowe energie
   i powyższe pola pochodzą z kroku 10. Dlatego stopka pokazuje Step 0 i starą
   energię. To błąd wyboru/proweniencji danych skalarnych, nie miganie React
   ani dowód niewykonania solvera. Trzeba poprawić źródło terminalnych scalar
   windows i ich frame, zamiast podmieniać numer w UI. Render m/H_demag
   powyżej jest oddzielnie sprawdzony.
2. **Duże wejścia nadal uruchamiają się długo.** Przejście katalogu i domeny
   jest poprawne, lecz powtarzane walidacje/serializacje pozostają kandydatem
   do profilowania. Nie udowodniono profilu kosztów; nie deklarujemy pełnej
   optymalizacji. Limit 256 MiB dokumentu nie jest limitem RAM symulacji.
3. Lokalne poprawki tego zadania nie są jeszcze commit/push na remote.
   Integracja nowych równoległych PR wymaga zachowania tych zmian i oddzielnego
   odbioru, bez rutynowego restartowania ukończonej sesji ani ponawiania Solve.
