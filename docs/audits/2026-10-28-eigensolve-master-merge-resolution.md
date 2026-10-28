# Integracja mastera — decyzje konfliktowe, 28.10.2026

Scalane źródła: branch `43af3e8ddf4fbaf496da39f4dc403ca5ba14af26` i master `2c67d8f904b1dede9268bbbc8bf6257cbe33aa4f`. Wspólna baza: `1afcb531630d6cd5b8caba1f8a4d4593bb29cdb7`. To integracja na branchu zadania, nie publikacja na masterze. Odczytowy preflight wskazał 12 konfliktów; rzeczywisty merge potwierdził dokładnie te ścieżki.

## Rozwiązanie konfliktów

| Plik | Zachowana semantyka |
|---|---|
| `ControlRoomApi.ts` | Importy saved-results playback z mastera oraz binarnego FMS; pozostają inspectFile/commitFile i zakaz automatycznego compute_fields przy commandability innym niż allowed |
| `projectWorkspaceCommandPolicy.ts` | Obie operacje bez bieżącej sesji: otwarcie results-folder z mastera i restore archiwum. Zachowany jawny allowsEmptySession oraz trwały fence przejścia null→sesja→null |
| `Viewport3DModule.tsx` | Nowy pojedynczy HUD mastera, który już zawiera error i inspection-only notice. Usunięty jedynie stary, zdublowany blok; komunikat inspekcji anteny pozostaje w nowym HUD |
| `live_retirement.rs` | Nowy helper open_retirement_ledger z mastera zwraca ledger. Przeniesiono typed writer-busy retry wyłącznie wokół otwarcia, nie wokół mutującego callbacku. Caller zachowuje jednokrotne wykonanie evidence callback |
| `docker_dev.py` | Zachowane nowe polecenia offline reconciliation/host-device z mastera oraz istniejące storage-only reattest-linux-device; osobne nazwy i dispatch, bez zmiany źródeł aplikacji |
| `docker_dev_codegen.py` | Jedna kanoniczna implementacja dowodu tego samego inode dla aliasu WSL, użyta również przez browser QA. Zachowana normalizacja bezpośredniej ścieżki hosta; brak fallbacku po samym prefiksie |
| `docker_volume_dev.py` | Połączone typed early-startup fence i świeża klasyfikacja błędu readiness. Zachowane shared-cache z mastera oraz klucz generacji frontendu uwzględniający konfigurację; bez przywracania starego configu Next |
| `docker_volume_activate.py` | Nowy finalizer działa w uwierzytelnionym helperze loggera i sprawdza jego tożsamość dwukrotnie. Zachowane dokładne bajty lease, pełne piny poprzedniego immutable terminala i grupa control. CAS chroniony blokadą konkretnej operacji, bez ponownego brania globalnego locka loggera. Najpierw wynik/current, potem terminal; żywy logger zwalnia własny lease |
| `test_docker_live_retirement.py` | Zachowane rzeczywiste filesystem-level testy mastera. Starsze testy CAS przeniesiono na jeden kanoniczny finalizer; nie utrzymuje się drugiej implementacji live-current CAS. Pozostają negatywne przypadki symlink/hardlink, byte drift, lock contention, malformed lease i pin drift. Dodano refusal obu obcych terminali i contention per operacja |
| `test_docker_retirement_refusal.py` | Zachowane upstreamowe rozróżnienie odmowy i nieznanego wyniku, oryginalny kod/komunikat oraz kanoniczna kontrola nieobecności helpera. Mechaniczne oczekiwanie starego helpera zastąpione testami rzeczywistego nowego CAS |
| `test_docker_volume_readiness_receipt.py` | Unia testów typed startup-fence, stale receipt/readiness i znikających lub zatrzymanych kontenerów |
| `docker-volume-development.md` | Zachowane instrukcje recovery terminalnego workera oraz nowe zasady współdzielonego cache i przypiętego helper-source |

Ponadto po automerge usunięto nadmiarowe CR w zakończeniach linii testu viewportu. Test adaptera hosta otrzymał realistyczny mock nieistniejącego registry volume: zachowuje walidację namespace i nie kontaktuje się z prawdziwym Dockerem. Nie wyłączano asercji ani nie zmieniano progów naukowych.

W teście live loggera dawną asercję braku dowolnego flock zastąpiły jawne asercje braku ponownego globalnego locka i obecności locka konkretnej operacji. Sam test trzyma rzeczywisty globalny lock i publikuje pliki, więc dowód braku zakleszczenia pozostał. Osobna regresja potwierdza odmowę publikacji przy zajętej blokadzie operacji.

## Weryfikacja przed commitem

- Interpretowane testy volume/runtime: 473 PASS.
- Interpretowane testy retirement: 131 PASS.
- Interpretowane testy dev/codegen: 192 PASS. Są to grupy poleceń, nie suma unikalnych testów.
- Parser Rust (rustfmt emit stdout): PASS; testów Rust/TypeScript nie budowano lokalnie.
- Kontrakt OpenAPI zachował binary FmsFileUpload oraz oba endpointy file inspect/commit.
- Czternaście cudzych plików zachowało wszystkie SHA-256 i pozostaje poza stagingiem. Backup ma osobny manifest; żaden nie kolidował z incoming master.

Pełny CI dla scalonego drzewa jest wymagany po zapisie merge. Dotychczasowe 1821+1 testów i poprzedni odbiór UI dotyczą wcześniejszego drzewa. Nie są odbiorem tej integracji.

## Runtime i otwarte zadania

Docker nadal nie odpowiada. Nie restartowano współdzielonego środowiska ani nie powtarzano Solve. Zapisane FMS i signed15 pozostają dowodami wcześniejszego runtime. Końcowy strict Gamma, działające UI, naukowa zbieżność/COMSOL oraz PR/master/cleanup pozostają otwarte. Dane techniczne i grupę trzeba odtworzyć zarządzanym launcherem po przywróceniu Dockera, z zachowaniem nowych granic shared-cache.

[Dowód JSON](2026-10-28-eigensolve-master-merge-resolution.evidence.json).
