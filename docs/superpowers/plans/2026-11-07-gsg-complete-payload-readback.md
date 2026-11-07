# Pełny odczyt zapisanego V/J/H GSG — 07.11.2026

## Wynik i zakres

Sprawdzono komplet 22 payloadów zapisanego wyniku. Brakujące 11 pobrano przez
istniejące publiczne API; wcześniejsze 11 ponownie sprawdzono względem tego
samego właściciela, manifestu, rozmiarów i SHA256. Łącznie 124393748 B,
w tym 102394158 B nowego odczytu HTTP. Kontrole spójności nośników oraz
siedem testów zabezpieczeń HTTP zakończyły się PASS.

Nie wykonano nowego Solve, meshowania, buildu, restartu, zmiany polityki
lub rezerwacji. Nie zmieniono źródeł produkcyjnych. To audyt wyniku zgodny
z zakresem audytowym scientific-documentation-contract, nie nowa metoda
ani kwalifikacja naukowa. Wynik pozostaje inspection_only.

Baza dokumentacji: e5c94c31a5899b5b8a16e32869012470429de0e2.
Nie utożsamiać jej z SHA zbudowanego pakietu. Odczyt wykonano w istniejącym
backendzie 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.

## Tożsamość i nośniki danych

Run: run-40c6990b8231f8fd7194d8b634e780aab9af3a559dbd21b27f8b7bcb8425be5e.
Task: task-902544fbad21c9da53757ca22786517f6866733c15a4e24dd380524b0c4cd859.
Attempt: attempt-b7eaad04933643379cd377462f2899b6, ownership_epoch=1.
Package CAS: f3974e680be1fb2b039d41beddf8d2bff62dfa941b01ec2aba92754d6dd1a645.
Native stage: inspect_gsg. Pełny Study step i właściciel są w dowodach JSON.

Świeże metadane zachowały dokładnie właściciela oraz wszystkie 22 deskryptory.
Każdy odczyt payloadu przypinał attempt_id, ownership_epoch i package_object_ref
na trasie /v2/persistence/projects/{project_id}/runs/{run_id}/antenna-inspections/{step_id}/payloads/{payload_kind}.

| Wielkość / nośnik | Liczność lub wartość | SI |
|---|---:|---|
| V, stabilne węzły przewodnika | 12589 | V |
| J, komórki Tet4 | 34243 | A/m² |
| J, ślady lokalne | cztery wektory na komórkę | A/m² |
| H, węzły kontrolnego samplingu | 20 | A/m |
| Tet4 samplingu H | 24 | indeksy bez jednostki |
| Ściany kanoniczne | 80576 | strumienie A |
| Pary przekroju źródła | 16 | reakcje A |
| Prąd normalizujący | 1.754421457522968e-5 | A |
| Sprawdzony skok V każdej pary | 0.001 | V |

Jest to kontrolny wynik GSG na 20 punktach, nie nowa pełna mapa Universe.
Parametry fizyczne i siatkowe przypina receipt antenna_coincident_prepared_input.v2.
Jego object_id, mesh_digest, materials_digest, requested_execution oraz
stabilne ID sprawdzono względem metadanych i binarnego nośnika węzłów.

## Kontrole zgodności — PASS

Istniejące kodowanie to $s_I=1/I_\mathrm{ref}$ oraz
$X_\mathrm{per\,A}=X_\mathrm{raw}s_I$, dla $X\in\{V,J,H\}$.
$I_\mathrm{ref}$ ma jednostkę A, $s_I$ ma 1/A, a V/J/H na amper odpowiednio
V/A, 1/m² i 1/m. Mnożenie raw * scale jest zgodne z writerem;
raw/I może inaczej zaokrąglać ostatni bit.

- Wszystkie stabilne ID są unikalne. Ordynały komórek oraz ich cztery
  różne ID są poprawne; lokalne xyz są bitowo zgodne z mapą ID→xyz.
- Jlocal/Jcenter wycięte z cells280 są bitowo identyczne z oddzielnymi tablicami.
- V, Jcenter, Jlocal i H przechodzą bitowo dokładną normalizację raw * scale.
- Liczby na sprawdzonych nośnikach są skończone, sigma dodatnia,
  a wszystkie Tet4 źródła i samplingu mają dodatnią orientowaną objętość.
- Ściany mają pełne pokrycie przez Tet4: 56396 wewnętrznych i 24180 brzegowych,
  maksymalnie dwóch właścicieli; pary orientacji outward się znoszą.
- Normalne momenty ze śladów J zgadzają się z kanonicznymi strumieniami;
  bilans każdej komórki przechodzi kontrolę.
- Sampling ma indeksy zero-based w zakresie i pokrywa wszystkie 20 węzłów.
- Wszystkie 16 par source cut ma różne ID, bitowo identyczne xyz i skok 1 mV.
- Receipt JSON nie ma duplikatów kluczy. Istniejący tagged JSON codec daje
  sha256:198e8e9baa72f73897792c4614e52f413d3b8013eaa02ed7a5aeb84d84ef8b8b.
- Powiązania digestów prepared/charge/source/certificate są poprawne.
  Istniejący decoder direct evidence wiąże H z pozycjami, prądem i certyfikatem.

| Diagnostyka | Wynik |
|---|---:|
| Maks. różnica centroidu | 1.6940658945086007e-21 m |
| Maks. różnica Jcenter względem średniej śladów | 2.384185791015625e-7 A/m² |
| Minimalna objętość Tet4 źródła | 1.5793951567476785e-25 m³ |
| Maks. różnica strumienia ze śladów względem DOF | 1.2705494208814505e-21 A |
| Maks. bilans strumieni komórki | 8.470329472543003e-22 A |
| Maks. suma reakcji słabej pary | 1.917682592583736e-18 A |
| Maks. skok styczny dyskretnego J | 1.0206354093570055e9 A/m² |

Diagnostyki zaokrągleń używają zadanej przed odczytem skali 128 epsilon64
razy skalę uczestniczących wartości. Strumienie sprawdzono z bramką
1e-18 A + 1e-10 razy sumę ich modułów. Nie zmieniono progów solvera.

Skok styczny jest cechą dyskretnej reprezentacji RT0, nie dowodem rzeczywistej
nieciągłości prądu w jednorodnym metalu. Nie uśredniano J węzłowo ani nie
zespawano 16 powtórzonych xyz przekroju idealnego źródła.

Nie używano pełnego parsera preimages małego smoke testu poza jego granicami:
zachowano 16 MiB i 4096 komórek; source_preimage ma 69674510 B.
Pełna semantyczna walidacja preimages/certyfikatu pozostaje w kanonicznym
verifierze API. Niezależny skrypt tego audytu sprawdza nośniki, strumienie
i powiązania; nie zastępuje tego verifiera ani nie rozwiązuje układu.

## Rzeczywiste testy HTTP — 7/7 PASS

| Próba | Wynik |
|---|---|
| Poprawne piny H | 200; poprawne SHA, silny ETag |
| Ten sam właściciel i If-None-Match | 304; puste body |
| Nieaktualny epoch z aktualnym ETag | 409, nie 304 |
| Inny package CAS z aktualnym ETag | 409, nie 304 |
| Nieznany payload_kind | 400 |
| Range 0–23 | 206; pierwszy wektor H i Content-Range 0–23/480 |
| Range poza payloadem | 416; Content-Range */480 |

Pierwszy odczyt metadanych zwrócił bytes, lecz kontroler błędnie oczekiwał tuple.
Po odczytaniu całego Client.get poprawiono uprząż; nie był to błąd API.
Zachowano pierwotny zapis niepowodzenia. Poprawiony odczyt obejmował 12 GET
i trwał 74.59 s; testy ochrony wykonały kolejne siedem GET. Nie stosowano retry.

## Źródła i dowody

| Plik | Symbol / odpowiedzialność |
|---|---|
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_v2.rs | records, normalization_scale, floats, build, source_valid, verify_and_decode_source |
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs | verify |
| crates/fullmag-runner/src/antenna_field_solution/closed_loop_balance_v2.rs | verify_balance_certificate |
| crates/fullmag-api/src/router_v2/handlers/data/accepted_antenna_payload.rs | get_accepted_antenna_payload |
| scripts/smoke_antenna_closed_loop_inspection.py | tagged_json_digest, verify_field_evidence |
| scripts/verify_archived_solution_http.py | Client.get |

Dowody i wykonane skrypty zapisano w prywatnym control volume grupy:
 /opt/fullmag/control/verification/gsg-junction-solve-20261107/complete-payload-readback-v1/

| Artefakt | SHA256 |
|---|---|
| http-integrity.json | 508362638feb1186b5a570d9d781700bdf5a4c2dbb881b4835daf95a5dacb522 |
| semantic-consistency.json | 6edee7194815d37f3de15e07a0979f2247d4521d8a57abb3520d0251e3feeebe |
| http-guards.json | 7b1470e5e4ae6a5a6436b06d33400f7a08fb86cc3d1244c5c2572e53ff07eb7b |
| verify_semantic_consistency.py | e8dc6481eab1bb6757b7287f1701e173ea212229388c5f3174adf08be36c4eb4 |

audit-evidence-manifest.json przypina również źródła i oba skrypty HTTP.
fetch_missing_payloads.py celowo nie nadpisuje wcześniejszego katalogu;
nie jest kontrolerem automatycznego ponowienia.

## Wpływ na E0–E12 i pozostałe bramki

E3/E5 uzyskały mocniejszy dowód spójności wyniku i publicznego odczytu.
Nie jest to zaliczenie całej ich macierzy: nie wykonano tu restartu/cold-start
nowego procesu, wszystkich starszych formatów, zmiany sesji podczas żądania
ani odbioru przeglądarki.

Dowód dotyczy zachowanego, rzeczywistego FEM CPU/double V/J/H.
Nie dodaje dowodu wykonania FEM GPU, FDM CPU lub FDM GPU.
API nadal podaje false dla per_ampere_basis, source_fft i llg_drive.

Źródło wymaga zbieżności; wcześniejsze eta=0.03464604656814306 nie zostało
tu przeliczone ani zaakceptowane. Corner25 i naprawa eksportu nadal
oczekują na osobne decyzje. LLG, transmisja i zgodność z publikacją
pozostają niezweryfikowane.
