# Duży FMS i referencje po ponownym otwarciu — 28.10.2026

Uzupełnienie FMS5 oraz I3/I4 głównego planu eigensolve. Cel pozostaje rzeczywisty signed15 z polami i analityką w UI, również po zmianie procesu API. Nie zmieniamy fizyki ani progów solvera.

## Potwierdzone dowody

- Nowy backend `0.1.0-dev.20261027.ga63b4e44e6f4+9796`, managed iteration `2c5aab51243e495585dac88e88a25375`: SUCCESS.
- Nowy run `run-live-93df870d6af7a8e9d70a3742a0de6e7860b5a072c98b7359c3463c18b49113de`: completed, 15 próbek, 7134 komórki. Wszystkie częstotliwości są identyczne z poprzednim signed15. Gamma: 9299249697.073517 Hz.
- Generacja `sha256:094bf14b5f4e43d1622336ab43a09cbdce64b3e558519dfbb6c616473a5c215b`.
- Rzeczywiste FMS z referencjami: 158456496 bajtów, SHA-256 `2338882b585bc40f9911ec3334676e672cb23c2a55448d4945e711533b57b6cf`. Zapisane w `eigensolve-modal-updated-signed15-20261027` w katalogu wizualizacji tej sesji, obok wcześniejszego FMS bez referencji, CSV, PDF/PNG i capture API.
- Nowy verifier UI: 15 częstotliwości, pięć punktów→zespolone pola, obie osie, trzy rozmiary okna, zero JS errors i zero HTTP failures. Katalog artefaktów HTTP 200, ETag 83 znaki (wartość nagłówka).
- Next 16.3.8 obcina proxy body do 10 MiB, co potwierdza log dla właściwego endpointu `/v2/persistence/imports/inspections`. Backend ma globalny limit JSON 128 MiB (`LOCAL_BRIDGE_BODY_LIMIT_BYTES`). Base64 rzeczywistego archiwum przekracza oba limity. Pierwsza błędna ścieżka helpera zwróciła 404; poprawny endpoint ujawnił proxy 500. Nie wykonano import commit.
- ZIP zawiera startup scene revision 1, current scene revision 3 i captured scene revision 3 oraz dwie definicje referencji. Rewizja dokumentu zmieniła się przez postprocessing. Obecny `validate_imported_accepted_provenance` odrzuca taką różnicę bez rozróżnienia fizyki i prezentacji.

## Kontrakt i kroki

| Zadanie | Stan | Kryterium odbioru |
|---|---|---|
| L1: fizyczna tożsamość a rewizja dokumentu | PASS CI 40601067977, kod 41d2d0cda; wdrożenie otwarte | Pozostawić ścisłe captured scene revision = archiwizowany dokument i zgodność run/session. Przy innym startup revision dopuścić wyłącznie zgodność z oryginalnym revision w odłączonym typed RunIntent oraz istniejącym versioned `SceneExecutionInputIdentity`. Użyć `live_execution_binding::validate_input_binding`; stare intenty bez wersjonowanego hasha nadal wymagają dokładnej rewizji. Odrzucić zmianę materiału/geometry/field, błędny run i brak oryginalnego bindingu. Nie przepisywać historycznego markera ani nie usuwać guardu |
| L2: plikowy transport API | PASS CI 40605186626, kod 55bef9853; wdrożenie otwarte | Dodać osobne file inspect/commit obok istniejących JSON/base64. Raw `application/octet-stream` trafia strumieniowo do prywatnego pliku tymczasowego w istniejącym decode root; byte count i deadline ograniczone, cleanup RAII przy sukcesie/błędzie. Początkowy limit skompresowanego pliku 512 MiB, oddzielny od 64 GiB rozpakowanego grafu i od limitu zwykłego JSON. Commit wymaga jawnego restore_mode oraz tej samej kontroli scope/transition. Wspólne funkcje preflight i publikacji dla obu transportów, bez kopiowania walidatorów |
| L3: proxy i UI | Implementacja gotowa do CI; runtime otwarty | Next proxy buffer dostosowany do jawnego limitu plikowego; pozostałe backendowe limity JSON zachowane. Centralny klient API przyjmuje Blob/File z binarnym body, bez JSON.stringify/base64. Nowe wybory plików w Inspectorze i komendzie importu używają File; historyczne wejścia fmsBase64 pozostają obsługiwane. Anulowanie/scope i generation guards zachowane. Widoczny błąd za dużego pliku przed transferem; żadnego obcinania lub automatycznego replay importu |
| L4: CI i rzeczywisty odbiór | Otwarte | Testy granic/zerwanego streamu/cleanup/stale scope/niezgodnej fizyki; kontrakty klienta i UI; OpenAPI tych samych źródeł. Testy kompilowane wyłącznie w GitHub Actions. Następnie managed build, file inspect rzeczywistego 158 MB FMS przez UI proxy, zmiana procesu API, visualization_only import tego samego archiwum, 15 identycznych częstotliwości, te same sample/raw mode, referencje i pola z importowanego katalogu; strict browser bez HTTP 500 |

Nie podnosimy globalnego limitu JSON jako obejścia. Nie zmieniamy archiwum ręcznie, nie wstrzykujemy prywatnego snapshotu i nie używamy bezpośredniego portu backendu jako dowodu działającego UI. Poprzednie i nowe wyniki pozostają zachowane. Wszystkie istniejące kontrole CAS/generacji/namespace oraz readonly authority obowiązują także dla pliku.

## Źródło konfiguracji proxy

Oficjalna dokumentacja Next, pobrana przez Context7: [proxyClientMaxBodySize](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.mdx). Domyślnie proxy buforuje 10 MB i po przekroczeniu przekazuje obcięte body zamiast jednoznacznego błędu. Opcję należy sprawdzić także w zainstalowanych typach Next 16.3.8. Zwiększenie tego bufora nie zastępuje liczenia bajtów i limitu w backendzie.

L1 korzysta z helpera `session_persistence_accepted_scene.rs`. Dopuszczenie innej startup revision wymaga dokładnego oryginalnego revision z RunIntent i istniejącej `live_execution_binding::validate_input_binding` dla aktualnego dokumentu. Regresje obejmują brak versioned hash w legacy, obcy run, błędny startup revision i zmianę Ms. Test niepustego cold import archiwizuje dokument revision 18 z nienaruszonym markerem wykonania 17 i modern input hash. Parsowanie Rust oraz diff check: PASS; kompilacja wyłącznie w CI.

## Konkretny transport L2

- `POST /v2/persistence/imports/file-inspections`: surowe `application/octet-stream`, odpowiedź jak JSON inspection.
- `POST /v2/sessions/current/persistence/file-imports?restore_mode=visualization_only`: ten sam plik i jawny enum restore_mode. Resume zachowuje dotychczasowe odrzucenie nieobsługiwanego checkpoint restore.
- Limit pliku: 512 MiB, deadline transferu: 300 s. Rzeczywiście otrzymane bajty są liczone także bez Content-Length; niezgodna długość, pusty plik, kodowanie HTTP i błędny typ są odrzucane. Dane trafiają do anonimowego pliku tymczasowego, którego czas życia jest związany z odczytem, bez tokenów uploadu i katalogów pozostawionych po anulowaniu.
- Core preflight działa na blocking worker z owned File/Cursor i wspólną ścieżką publikacji. Nie ma nowego wariantu formatu FMS ani osobnego zestawu walidatorów.
- Scope jest kontrolowane przed i po uploadzie oraz pod finalnym transition guard. Pusty Workspace ma dodatkowy witness epoki; nowsza sesja nie może zostać zastąpiona po spóźnionym transferze.
- Regresje: dokładna granica/za duży stream, niezgodny Content-Length, zero bajtów, timeout i zerwany stream, typ/encoding, błędny ZIP, zmiana scope i oba transporty niepustego cold import. Testy kompilowane pozostają w CI.

## L3 — przekazanie pliku i wybór operacji

UI przekazuje oryginalny `File`/`Blob` przez centralny klient, zachowując nagłówki instancji/sesji, anulowanie oraz zakaz automatycznego powtarzania POST. Nowy wybór pliku i zmiana sesji anulują poprzednią inspekcję. Konfiguracja proxy: 512 MiB i 360 s; backend nadal egzekwuje 512 MiB i 300 s. Proxy buforuje żądanie, backend zapisuje strumieniowo; nie jest to dowód transportu bez buforowania od początku do końca.

Poprawiono dodatkowy błąd kontraktu: `RestoreClass` nie jest `SessionRestoreMode`. Domyślne mapowanie: exact/logical resume → resume; initial_condition_import → visualization_only; config_only → replace_project. Nieznana klasa daje błąd. Jawny wybór operacji pozostaje zachowany, bez automatycznej zamiany nieudanego resume na wizualizację. Komenda otwierania pliku bez wyboru operacji najpierw wykonuje inspekcję i sprawdza ponownie sesję przed importem.

Cztery pliki klienta OpenAPI pochodzą z artefaktu CI 12779783608 dla pełnego SHA 55bef985337d8efa854763261c0ff4c141b3f727; zweryfikowano `FmsFileUpload` jako string/binary. Dodano regresje transportu klienta, mapowania, limitów, zmiany sesji oraz konfiguracji proxy do istniejącej bramki GitHub Actions. Bieżące L3 nie jest jeszcze potwierdzone testami ani wdrożeniem.
