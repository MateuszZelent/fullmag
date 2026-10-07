# R4 i porównanie COMSOL A1 — bramki po review

Stan źródeł bazowych: `7b49e7a1d` na branchu
`codex/eigensolve-dispersion-plan-20260912`. Dokument nie dowodzi runtime.

## R4 — ustalenia wymagające spójnego portu

| Priorytet | Luka | Wymagana naprawa i dowód | Stan |
|---|---|---|---|
| P1 | Accepted digest sprawdzany tylko składniowo | Opublikować historyczne accepted fields i niezależnie replayować oba payloady oraz różnice | źródła fa67eb3fd; native/runtime otwarte |
| P1 | V1-only założenia starszego K0 | V1 Ku-free; V2 Ku, także Ku=0; anisotropy, spójne schematy i tolerancje | otwarte |
| P1 | Material namespace hardkodowane V1 | Wybrać namespace z dokładnego schema preimage V1/V2; odrzucać mieszane rodziny | helper 283ee3aaa; integracja/runtime otwarte |
| P1 | Multi-k zmienia RelaxedInitialState na Provided | Walidować przed zmianą i osobno Provided z identycznym m0/mesh/signature/handoff | źródła fefe69fd1; runtime otwarte |
| P1 | Path agregator gubi accepted i identity sidecars | Relokacja per sample, dokładne bajty signed payloads i manifest plural paths | źródła 5a2257f31; Python review i runtime otwarte |
| P1 | K0 binder fixture i topology assumptions | Dodać realny manifest fixture; rozdzielić relax source topology i modal mixedV3 | otwarte |
| P1 | Python verifier V1-only | V1/V2 replay, Ku i mixed-family fail-closed, single/multi-k | otwarte |
| P2 | Canonical material mylone z raw provenance | Oba hashe i scope zachować oddzielnie w source identity | otwarte |
| P1 | Verified constructor odrzuca payloady po kontroli | Zachować accepted endpoint i recomputed certificate w handoff oraz opublikować je w binderze dla każdej próbki; aktualny handoff przechowuje tylko certified fields | otwarte |
| P2 | Modal identity bez jawnego linku recomputed | Wiązać accepted i recomputed payload przez handoff digest oraz źródłowe SHA | otwarte |
| P2 | Cross-build snapshot policy | Jawny kontrakt producent/konsument i regresja niezgodnego snapshotu | otwarte |

Nie przenosić K0 topologyV6 override: modal `mixed_topology_fingerprint_v3()`
i `relax_to_eigen_source_mesh_topology_sha256` opisują różne rzeczy.
Foundation exact preimages jest na remote jako
`2c9ed3c5836ffff9e574271a7c39afd07590b5e5`; nie zamyka całego R4.

Minimalne regresje: V1 pass/mutations fail, V2/Ku=0 pass/anisotropy mutation
fail, mixed family fail, Rust/Python namespace replay, single Floquet,
Provided multi-k, kilka remapped samples, manifest/source identity links,
CPU/GPU topology split. Natywne wykonanie nadal NOT VERIFIED.

## COMSOL A1 — konfiguracja i pierwszy punkt

Źródła: README_COMSOL_A1_dispersion.txt, COMSOL_A1_dispersion.csv,
COMSOL_A1_model_details_user.txt w docs/plans/active/eignensolve_non_k0;
kanoniczny model Fullmaga: tests/standard_problems/mumag/comsol_nonzero_k_dispersion.
Nie używać publicznego przykładu antidot jako zamiennika A1: ma inne parametry.

- Okres200nm, film200×200×10nm, otwórR50nm.
- Airbox200×200×4010nm; Ms8e5A/m, Aex13e-12J/m, gamma0=2.211e5m/(A s), B0=.1T.
- Γ–X–M–Γ:61 punktów, jpath0..60, k_sign+1, phase exp(-ik·Δr).
- L1intencja:5nm,3warstwy,P1tet; air100nm/growth1.3. To nie dowodzi tożsamości siatki.
- Alpha relaksacja.5, eigen0;24mody. COMSOLshift około1GHz,
  Fullmagwindow1MHz–30GHz: porównać zakres i kompletność, nie tylko pierwszy root.

Pierwsze osiem częstotliwości CSV w Γ [GHz]:9.413600,10.184000,11.693000,
13.195000,13.259000,13.642000,14.025000,14.114000. CSV ma lokalne rangi,
bez dowodu śledzonych gałęzi i bez zespolonych modów/residuali.

COMSOL używa envelope psi ze shifted gradient, phi=exp(-ikr)psi oraz
Menv=exp(+ikr)Ms dm. Fullmag używa physical potential i phase constraints
C(k)^H A C(k). Ich ciągła relacja nie dowodzi równej dyskretyzacji ani znaku;
comparator zachowuje unresolved_mixed_sign_reference_convention.
Różne integratory relaksacji wymagają porównania rzeczywistego m0 i pól.

Kolejność: C0Γ → finite-airbox C1Γ → signed DE/BV → A1Γ →
jpath0,10,20,40,50,60 (24mody) → pełne61. Zachować wszystkie rawindices.
Potem L1/L2, air2/4/8µm,24/48modów i oba znaki k; rozwiązać potential mapping.
Częściowy frequency-only comparator nie jest kwalifikacją pełnej A1.

## Stan infrastruktury i integracji

#188 nadal live: ten sam kontener7df4be7c5ace i solverPID11041; ostatnio
Γ refinement27/50, około3h52min czasu procesu. Brak terminalnego nowego punktu.
Stara kapsuła nie zawiera MFEM4.10 ani F01/R4. Nie restartowano procesu.
MFEM source commit2548bbb9440603d6128d34daeaab0009ab53b5fb jest na remote;
nowy image/ABI/runtime pending. Wszystkie S00–S12 pozostają w zakresie celu.

## Aktualizacja po terminalnym #188 i review — 2026-10-01

Powyższe obserwacje żywego #188 są historyczne. Kontroler zakończył się
exit1, kontener nie istnieje, sześć z pięćdziesięciu podokien zawiodło.
Nie ma nowego zaakceptowanego punktu dyspersji. Diagnoza jest w
`2026-10-01-job188-frequency-window-failure.md`.

Accepted/recomputed replay jest zapisany w `fa67eb3fd622c8d38cf9555ddabbc9af3c7257f6`:
producent zapisuje oddzielny endpoint, Rust sprawdza oba payloady oraz różnice,
CLI używa publicznego zweryfikowanego konstruktora, legacy builder jest
wewnętrzny. Import stanu i remesh unieważniają stare kontynuacje.
14 lekkich kontroli i parser CLI przeszły; native i runtime są niewykonane.

Plural path validation jest w review. Wersja identity v2 nie określa obecności
Ku i nie może automatycznie wymuszać accepted fields v2. Obsługa bieżących
manifestów nie jest certyfikacją pełnego R4. Pozostają niezależny replay
payloadów w Pythonie, producent i powiązanie identity, V3/source snapshot,
material namespace V1/V2 i bezpieczny Prepared/Provided multi-k.

Runner potwierdza aktywny #189 z głównego checkoutu; MFEM 4.10 nie jest jeszcze
wdrożony. Źródła i kontrola observed version są zapisane na branchu zadania.
Nie uruchamiać równoległego ciężkiego builda obrazu ani zmieniać cudzego joba.
Po zwolnieniu runnera: nowy obraz i ABI → build aktualnego pełnego SHA bez
kompilacji unit targets → terminalny Γ → pojedyncze signed DE/BV → pełna seria
oraz bramki zbieżności i COMSOL. Pełny zakres S00–S12 pozostaje otwarty.

Następne ustalenie źródłowe: `from_completed_relax_verified` sprawdza accepted
fields i recomputed certificate, następnie legacy builder przechowuje tylko
certified fields. Dlatego sama allowlista agregatora nie zapewnia dowodów
dla izolowanego eigenrun. Binder musi dostać i opublikować wszystkie trzy
payloady, a tożsamość musi wiązać ich digesty. Nowe tablice certified/recomputed
w manifeście są przygotowaniem tej trasy, a nie dowodem jej wykonania.

Checkpoint: Python discovery konsumuje już siedem tablic i ma 25 regresji
PASS (7967801ee4bf85596516c9ef17c9678011ec96f3). Oddzielny moduł field replay
ma osiem grup PASS, lecz nie jest jeszcze podłączony do full R4 gate.
Konflikt różniących się signed bytes pod jedną ścieżką jest fail-closed.
Nie zamyka to brakującego bindera, identity V2, runtime ani nauki.
