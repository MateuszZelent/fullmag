# Zatrzymanie diagnostycznego API przed przejęciem runtime

## Problem i zakres

Pakiet backendu został zbudowany, lecz jego start odmówił ponownego użycia zużytej autoryzacji container recovery wobec późniejszej historii LAUNCH. Obecne diagnostyczne API nie przejęło runtime. Historyczny OWNER jest Failed, a process-tree pozostaje historycznym shutdown_unknown. Nie wolno użyć go jako dowodu tożsamości obecnego procesu ani zmienić dawnych receiptów.

## Rozwiązanie

`scripts/docker_volume_startup_diagnostic.py` identyfikuje faktyczny proces i instancję API przez /proc, środowisko, startup fence i zgodne nagłówki HTTP. Zachowuje osobny hash historycznego process-tree. Rzeczywista kontrola `just docker-dev-inspect-startup-diagnostic` przeszła: PID 2834, brak aktywnych rezerwacji; dowód `verification/antenna-operation-profile-20261026/startup-diagnostic-inspection-03.json` w wolumenie kontrolnym grupy anten.

Nowa recepta `just docker-dev-stop-startup-diagnostic` ma domyślne preview i osobne apply. Wymaga zakończonego failed-confirmed resume, pełnych pinów kontenerów/obrazów/StartedAt, kanonicznego requestu, zgodnego preview oraz ponownego odczytu dowodów pod lease. Przed sygnałem sprawdza namespace i natywne proofy zwolnienia zasobów z obu rodzin lease. Wysyła najwyżej jeden stop do wskazanego backendu. Zachowuje frontend, OWNER, konfigurację, historyczny process-tree, storage i cache. Niepewność po sygnale pozostawia journal stop-planned i unknown do odrębnego uzgodnienia; nie upoważnia do ponowienia stopu.

`scripts/docker_volume_startup_diagnostic_restart.py` uwierzytelnia osobny journal stopped-confirmed, jego immutable terminal, dawną completed recovery oraz niezmienione zasoby. Dopiero wtedy oddzielny StartupDiagnosticStopContext przekazuje restart tej samej sesji bez ponownej aktywacji skryptu i bez dawnych zmiennych recovery. Recreate i start ponownie weryfikują kontekst pod własnymi lease oraz wymagają dowodu zakończonego usunięcia starego namespace. Nie zmieniono schematów native stop ani post-build continuation.

## Weryfikacja i ograniczenia

W istniejącym backendzie Docker wykonano 41 interpretowanych kontroli: 20 stop/request/workflow, 4 read-only inspection, 17 restart/authentication. Wszystkie PASS; nie kompilowano testów jednostkowych. Scenariusze workflow z mockowanym daemonem nie stanowią dowodu rzeczywistego zatrzymania. Weryfikują m.in. brak sygnału bez preview lub po zmianie dowodów, pojedynczy sygnał przy kompletnym dowodzie oraz zachowanie niepewności po niepotwierdzonym stopie.

Rzeczywiste preview, apply, recreate i zdrowe API pozostają NOT VERIFIED do czasu terminalnego wyniku aktywnego resume 6f44e81b7f8e476c8d9588731ae0a562. Nie wolno skracać oczekiwania przez zabicie obserwatora, zmianę jego stanu ani podmianę historycznych dowodów. Po udanym przywróceniu należy odtworzyć zachowaną scenę przy pustej sesji, sprawdzić V/J/H przez publiczne HTTP i dopiero dalej kwalifikować pełne Universe. Cały zakres E0–E12 pozostaje nieukończony.

## Uzupełnienie po niezależnym review

Przegląd wykrył dwie luki. Po stopie kontynuacja nie odczytywała ponownie historycznego process-tree; regresja odtworzyła brak odmowy w wariancie zachowanych i usuniętych kontenerów. Dodano odczyt aktualnych bajtów i porównanie z przypiętym journalem. Druga luka dotyczyła rewalidacji resume-recreation wewnątrz nowego lease: walidator odrzucał własny marker active. Dopuszcza teraz tylko dokładną bieżącą operację startu, zgodny pełny token, stan starting, project/volume/root, proof SHA, durable receipt i ponownie zweryfikowanego helpera. Zwykłe wywołania nadal odrzucają dowolny active.

Dodatkowa regresja wykonuje rzeczywisty blok startu z powiązaniem kontekstu operacji; chroni przed przekazaniem argumentu do niewłaściwego wywołania. Sprawdzono też podmianę helpera, w tym repin mutujący obiekt operacji. Po poprawkach: 19 interpretowanych kontroli kontynuacji i 64 kontroli native-failed/recreate PASS. Są to dowody kodu, nie rzeczywistego stop/recreate/start; te pozostają do wykonania po zakończeniu obecnej obserwacji.

## Rzeczywisty stop, odtworzenie i start

Resume 6f44e81b7f8e476c8d9588731ae0a562 zakończył się failed-confirmed po limicie gotowości. Świeża odczytowa inspekcja 04 PASS. Kanoniczny request verification/antenna-operation-profile-20261026/startup-diagnostic-stop-request-01.json, SHA256 4eff47ed3f1b9fb33112dbb8139ccbb0a04d7f1c51b4452900a527a867184227. Preview a1ac7bf447b14299906bbe211caa35f6 PASS. Apply ccb8ce02c2e349298a6280225809e7dd succeeded/stopped-confirmed; journal SHA256 9d6c0f7da715ef5e6cf6b41b6e0a859c2257ad8e2b3b8c1402b494f36ef8055e. Frontend zachowany, OWNER/config/process-tree i zwolnione zasoby zgodne przed/po. Stop wykonano raz.

Pierwsze recreate odmówiło w preflight, przed usunięciem usług: pomocnik z samym mountem /state nie widział OWNER, ponieważ runtime-services ma oddzielny overmount wolumenu kontrolnego. Rzeczywisty docker inspect potwierdził tę topologię. Zamiast odtwarzać niepełny widok mountów, _owner_digest używa teraz bounded control.read_bytes dla kanonicznego runtime-control/runtime-services/OWNER.json. Dwadzieścia interpretowanych kontroli kontynuacji PASS. Nie ponowiono stopu.

Po poprawce recreate-services 3afb8cfbbd104cfc963a2b120880407a succeeded, z zachowaniem sesji i cache. Nowy development aa0121dc39f84ebfa89b804f13881921 succeeded; config 5ae11c7ec51fbc05cebde982e3b7281f82e5318d23d6765ab136d45302b33fb6. Toolchain, image-dev i image-backend cache hit. Make exit0 po 169139 ms, pakiet 24 pliki, bramki linux-native-v1 i worker-cgroup PASS. Backend bc88d6b29b61d71ceb0daee0ac62acfb03883ebbf9222ee8066d24f9f8778a5a; frontend 03fdc7ca40f41c311f0f175d0423bed05c031ae4eae89bebf001993b0d092802. Snapshot zbudowanych źródeł 33c2d640f729efc944ae1a0d2fd4a4253dec1bde846814ca74e45aad4f02183e, commit fab33fc0bedcb54c2b4fab5f544e8447ebcaf64d + dirty. Native library SHA256 17794907b49625598ba1bae75558e710f8adce05019a5ef3fc2397c1ade37d2d; nie przeniesiono kwalifikacji innego binarium.

Health 200/status ok, active_session=false i current status 404 potwierdzono przed importem. Zachowany FMS (31291773 B, SHA256 c05d8176471e7de2e8ef439375f362223a22e0023a6e64c1a267bde861f9ed87) przywrócono przez publiczne persistence/imports: 200, visualization_only/config_only, bez ostrzeżeń. Dowód verification/antenna-operation-profile-20261026/startup-recovery-scene-import-01.json. Nie uruchomiono nowego Solve. Odczytowa walidacja historycznych V/J/H jest osobnym krokiem; pełne pole Universe i E0–E12 nadal nieukończone.

Publiczny cold-inspection istniejącego run-antenna-operation-profile-on-20261026-01 po restarcie: 31 kontroli PASS. V: 678 wartości, 5424 B, V; lokalne J: 22380 wartości, 179040 B, A/m²; H: 42 wartości = 14 wektorów, 336 B, A/m. Hashe zgodne z manifestem, odpowiedzi ETag/Range oraz odmowy obcych pinów poprawne, authoring_unchanged=true i new_solve=false. Raport verification/antenna-operation-profile-20261026/recovered-api-on-run-http-01.json w wolumenie kontrolnym. To dowód publicznego odczytu historycznego zaakceptowanego wyniku po restarcie; nie dowód nowego solve ani pełnej mapy Universe.
