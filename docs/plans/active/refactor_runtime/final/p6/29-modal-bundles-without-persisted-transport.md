# P6-A — bezpośrednie pakiety modalne bez zapisywanego transportu

Data: 30.09.2026

Status: **SOURCE IMPLEMENTED / REVIEW PASS / MANAGED BUILD PASS / TESTS NOT RUN / RUNTIME NOT VERIFIED**.

## Zakres i zachowanie

Bezpośrednie writers Rust `write_path_bundle`, `write_branch_bundle` oraz
`write_mode_bundle` zapisują spectrum v2/v3, path/samples, branches i metadane
modów bez `mode_field_resource_key`. `mode_field_id` pozostaje niezmieniony;
ścieżki binarnych payloadów/Zarr, topologia, real/imag, faza, normalizacja,
residuals, tracking oraz provenance naukowa zachowują dotychczasowe pola.
`dispersion.csv` zachowuje kolumnę ID, lecz pomija kolumnę HTTP. Usunięto
nieużywany prywatny helper generujący route writera. Manifest rodziny i
field-sweep korzystają z przyrostu 28.

Reader spectrum v3 dopuszcza ID bez key; key bez ID oraz empty values pozostają
błędem. Results Index wylicza transport w oddzielnej projekcji `field_ref`,
a nie przez mutację hashed JSON. Wspólny helper API koduje ID jako pojedynczy
segment. Dotychczasowe wymagania siatki i dostępności pozostają zachowane.
DTO/OpenAPI już mają optional key; shape nie wymaga regeneracji.

Czytniki wykresów branch/CSV zachowują legacy key, a przy jego braku wyliczają
route z ID. Wykorzystują centralny typed helper API, kodowanie ID oraz
`view=phase_rotated_real`, `phase_rad=0`. Zlikwidowano lokalne ręczne składanie
endpointu. Poprawiono również `phaseRad` na `phase_rad` w nowym adapterze
Navigatora z przyrostu 28 i dodano asercje obu parametrów query.

Walidator pakietów FEM akceptuje brak transport key w summary, metadata,
branches i CSV. Obecny legacy key nadal podlega kontroli zgodności; orphan
key jest odrzucany. Nadal obowiązują ID, ścieżki i bezpieczeństwo bundle path,
zgodność mode/sample/branch, metadane, payloady, real/imag, liczności,
częstotliwości, residuals, phase/operator provenance oraz wszystkie hashe.
Nie usuwa się integrity hashing ani wymagań naukowych.

## Dowody i dalsza praca

- Parser sześciu zmienionych plików Rust i AST obu plików Python: PASS.
- Regresje authored: nowe bundle bez current routes; CSV bez transport column;
  API projection spectrum v3 bez mutacji payloadu; branch/CSV derived transport;
  walidator pełnego durable fixture i odrzucenie orphan key.
- Testy Rust/C++: **NOT RUN**; aktualny AGENTS.md zabrania ich kompilacji.
- Próba lekkiego pytest walidatora przez zarządzany `fullmag_storage.py run`
  i profil `windows-source-check` zakończyła się exit 1 przed testami:
  `Container runner owns heavy builds on this host; submit a snapshot through just runner-build`.
  Nie obchodzono guardu ani pauzy operatora. Regresje Python: **NOT RUN**.
- TypeScript, browser, managed build, runtime i scientific qualification:
  **NOT VERIFIED**. Review w toku. Operator wznowił runner:
  worker_alive=true, worker_state=running, accepting_jobs=true,
  stop_requested=false. Zlecono osobny snapshot przez zatwierdzony zewnętrzny
  klient z jawnym `--worktree C:/git/fullmag/fullmag` i dołączonym nagłówkiem ABI.
- Przyrost 29 nie jest objęty starszym snapshotem FMR
  `7953ba4088a142c889c5ed9c12be7332`, który ma obecnie stan running.
- Nowy job: `ffb5dd9294b24b6ab869266b99d95b49`, profile `fem-cpu-release`,
  request key `p6-modal-durable-bundles-20260930-v1`, stan queued.
  Source digest:
  `2da071ea51285731216842f033d6d79351da01f5fc31e0840be8cffc396c7604`.
  Capture ID: `5fd6b2318bbd4e05999878cea7c73091`.
  Wynik wymaga terminalnego statusu kolejki oraz receipt zgodnego z tym
  job/profile/digest i sprawdzonym inventory; queued nie oznacza PASS.

To zmiana bezpośrednich Rust writers. Nie dowodzi migracji wszystkich C++
native writers, produkcyjnego przepływu identity przez wszystkie wejścia,
copy-on-write starych bundles ani historycznego pinned API. Bezpośrednie
helpery bundle nie dostały nowego właściciela; exact owner nadal dostarcza
orkiestrator i manifest rodziny. Brak właściciela przy samodzielnym wywołaniu helperów pozostaje otwarty.
P6 pozostaje **52%**; source-only przyrost nie zamyka bramki produkcyjnej.

## Korekty po review — 30.09.2026

Walidator typed field-sweep rozdziela pokrycie wszystkich modów od pokrycia
modów mających pola. Wiersz spectrum-only nie wymaga metadata ani sztucznego
residual=0; odrzuca ID/key/path pola. Wiersz ready wymaga niepustego ID
pola zarówno w sobie, jak i w źródłowym spectrum. Zachowano kontrolę
revision, nieujemnego residual i pełnego pokrycia visualizable modes.
Dostosowano kontrolę dokumentacji do CSV z 18 kolumnami i optional legacy key.
Dodane regresje obejmują wyłącznie envelope spectrum-only; nie dowodzą
zgodności całego legacy pakietu bez pól.

Ponowny niezależny review: brak nowych blockerów po korektach P1/P2.
AST trzech plików Python i diff check: PASS; testy nadal NOT RUN.
Te późniejsze zmiany Python nie są objęte już wysłanym snapshotem
`2da071ea51285731216842f033d6d79351da01f5fc31e0840be8cffc396c7604`.
Job `ffb5dd9294b24b6ab869266b99d95b49` ma obecnie stan running;
poprzedni build FMR zakończył się succeeded. Wynik nowego buildu pozostaje
otwarty do terminalnego statusu i weryfikacji receipt.

## Terminalny wynik buildu — 30.09.2026

Job `ffb5dd9294b24b6ab869266b99d95b49`: **succeeded, exit 0**.
Receipt `fullmag.local-runner.build-receipt.v1` potwierdza profil
`fem-cpu-release`, digest
`2da071ea51285731216842f033d6d79351da01f5fc31e0840be8cffc396c7604`
i trzy etapy exit 0: native-build, frontend-dependencies, frontend-build.
Inwentarz: 112 artefaktów z prawidłowym formatem SHA256 i nieujemnymi
rozmiarami; workspace/index.html jest niepusty. Osiem plików produkcyjnych
Rust/TypeScript zachowuje zgodność bajtową z kapsułą. Nie pobierano ponownie
i nie hashowano niezależnie wszystkich plików wyjściowych.

**Managed build: PASS.** Qualification w receipt pozostaje NOT VERIFIED.
Późniejsze poprawki walidatora Python mają AST/review PASS, lecz nie są
objęte tym receipt; zostały ujęte w kolejnym snapshotcie COW. Testy NOT RUN,
browser, rzeczywisty modal runtime i scientific qualification NOT VERIFIED.

## Kontrola ostrzeżeń React Doctor

Hook commita `745235ea1f26dac15dd6c926219417cd24ad0c68` zakończył się exit 0.
Skan czterech staged plików React: score 82, trzy ostrzeżenia wydajności.
Porównanie pełnych funkcji `duplicateStableIds`,
`fieldSweepSamplesMatchSpectrum` i `singleCrossArtifactRevision` z rodzicem
`e889e6e2ed72494d71b33db24d137ed6796d1b7c` potwierdza, że ich treść jest
niezmieniona. Ostrzeżenia o filter/map i includes odnoszą się do istniejącego
kodu. Nie wykonywano niezwiązanych zmian ani ponownego niezmienionego skanu.
Ten wynik nie zastępuje dowodu zachowania wykresów w przeglądarce.
