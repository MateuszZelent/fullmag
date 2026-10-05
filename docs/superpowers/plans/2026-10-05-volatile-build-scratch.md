# RAM-dysk dla odtwarzalnych danych buildu Ă˘â‚¬â€ť plan wdroÄąÄ˝enia

Cel: wykonaĂ„â€ˇ polecenie operatora dotyczĂ„â€¦ce RAM-dysku przy zachowaniu trwaÄąâ€šych
wynikÄ‚Ĺ‚w i dowodÄ‚Ĺ‚w. [Decyzja](../../adr/0053-volatile-build-scratch.md).
Nie zastĂ„â„˘puje peÄąâ€šnego planu eigensolve S00Ă˘â‚¬â€śS12.

## Stan wejÄąâ€şciowy

Na hoÄąâ€şcie potwierdzono NTFS, etykietĂ„â„˘ RAMDRIVE, okoÄąâ€šo80GiB pojemnoÄąâ€şci,
folder `R:\fullmag_builds` zarejestrowany jako scratch projektu. TrwaÄąâ€šy storage zachowany.
Runner po restarcie Docker jest zdrowy i bez aktywnych jobÄ‚Ĺ‚w. SĂ„â€¦ to pomiary
hosta; worker UID i nowy mount jeszcze NOT VERIFIED.

## Etapy i kryteria

1. **Rejestracja roli i resolver.** Osobny trwaÄąâ€šy rejestr, marker i generacja
   ulotnego rootu. Odrzuca obce/niezarejestrowane/przekierowane rooty, overlap
   z checkoutem i brak dysku. Reset pustego enrolled namespace tworzy nowĂ„â€¦
   generacjĂ„â„˘ bez utraty trwaÄąâ€šych danych. Interpreter regression checks.
2. **Windows.** Jednorazowy TMP na skonfigurowanym scratchu; przyrostowe
   poÄąâ€şrednie dane Cargo domyÄąâ€şlnie pozostajĂ„â€¦ trwaÄąâ€še,
   koÄąâ€žcowy target/pakiet/Python/frontend w trwaÄąâ€šym storage. Adapter PowerShell
   nadal odrzuca Äąâ€şcieÄąÄ˝ki poza przypisanym namespace. ZarzĂ„â€¦dzany build bez unit
   compilation; trzy binaria i manifest/hash na trwaÄąâ€šym dysku.
3. **Runner i sonda Desktop.** Operator-owned dodatkowy mount, dokÄąâ€šadna
   atestacja, mapping daemon-host, namespace worktree/profil/job. Nie dodawaĂ„â€ˇ
   mountÄ‚Ĺ‚w do payloadu joba. TrwaÄąâ€ša kolejka/capsule/CAS/cache zaleÄąÄ˝noÄąâ€şci i
   artefakty; odtwarzalne workspace/build intermediates na scratchu.
   Sonda UID65532 i operacji filesystemu przed uÄąÄ˝yciem. ZachowaĂ„â€ˇ wszystkie
   siedem profili, osobne wymogi Linux/ext4 i zakaz lokalnych unit builds.
4. **Recovery i cleanup.** ZapisaĂ„â€ˇ role/generacjĂ„â„˘/relative path/mounty w
   trwaÄąâ€šym journal. Brak lub zmiana generacji nie daje success. Reconcile
   dokÄąâ€šadny kontener i lease; utracone wykonanie wymaga nowego joba. Cleanup
   tylko po terminalnym stanie, publikacji artefaktÄ‚Ĺ‚w i braku uÄąÄ˝ytkownikÄ‚Ĺ‚w.
5. **Konfiguracja operatora i dowÄ‚Ĺ‚d.** Kopia lokalnego `.env`, rejestracja
   jawnego rootu i ustawienie nowego klucza bez zmiany trwaÄąâ€šego rootu.
   Deployment koordynatora przy pustym slocie, health/atestacja/probe;
   exact-source managed build i trwaÄąâ€še artefakty. Dopiero wtedy oznaczyĂ„â€ˇ
   konfiguracjĂ„â„˘ odpowiedniej trasy jako wykonanĂ„â€¦. Nadal osobna nauka/UI.

## Checkpoint 05.10.2026

- Rejestracja: **PASS**. `FULLMAG_PROJECT_SCRATCH_ROOT=R:\fullmag_builds`
  zapisany w lokalnym `.env`, oryginaÄąâ€š zabezpieczony prywatnie w storage.
  Rejestr w `storage/index/volatile-build-scratch.json`; marker/generacja na R:.
  Nie zmieniono trwaÄąâ€šego rootu ani systemowego TEMP.
- Helper: **17/17 interpretowanych regresji PASS**. Reset pustego namespace
  jest jawnĂ„â€¦ akcjĂ„â€¦ `python -B scripts/fullmag_storage.py prepare-scratch`.
  Read-only resolve nie odtwarza danych. Aktywny build trzyma wspÄ‚Ĺ‚lnĂ„â€¦ bramkĂ„â„˘;
  reset podczas jego pracy i uÄąÄ˝ycie nieaktualnej generacji sĂ„â€¦ odrzucane.
- Resolver: bazowy zestaw **39 kontroli (2 skip), PASS** przed rozdzieleniem
  runtime. Po zmianie runtime wykryto jednÄ… niezgodnoĹ›Ä‡ istniejÄ…cego testu;
  poprawiono zbÄ™dny ponowny resolve dla layoutu bez scratch i ten test przeszedĹ‚.
  Regresja brakujÄ…cego RAM markera oraz jawnego odtworzenia **PASS**.
  Uruchomienie istniejÄ…cego trwaĹ‚ego pakietu nie wymaga RAM-dysku. PowerShell: **4/4 PASS**, w tym junction w istniejĂ„â€¦cym przodku.
- Natywny Windows w tym worktree: kod dla build-only TMP gotowy, peÄąâ€šny build
  **NOT VERIFIED** Ă˘â‚¬â€ť admission odrzucony przez aktywny build gÄąâ€šÄ‚Ĺ‚wnego checkoutu.
  Nie zatrzymano tego buildu ani dziaÄąâ€šajĂ„â€¦cego UI.
- GÄąâ€šÄ‚Ĺ‚wny checkout: rÄ‚Ĺ‚wnolegÄąâ€šy wĂ„â€¦tek wdraÄąÄ˝a P8-57 z
  `FULLMAG_WINDOWS_VOLATILE_ROOT=R:/fullmag/volatile`: kopia ÄąĹźrÄ‚Ĺ‚deÄąâ€š kompilatora
  i TMP na R:, target/cache i artefakty trwaÄąâ€še. Ten kod jest jeszcze dirty.
  Nie kopiowano ani nie nadpisywano jego plikÄ‚Ĺ‚w. Wykryta niezgodnoÄąâ€şĂ„â€ˇ sterownika
  R: z `GetFinalPathNameByHandleW` wymaga pozostawienia ÄąĹźrÄ‚Ĺ‚deÄąâ€š Tauri na C:.
- Docker: **BLOCKED**. Ograniczona sonda read-only, UID65532, dokÄąâ€šadny obraz
  koordynatora `sha256:69422110f29c0897e9872ae9f6227e9c9fc34e6d640774268c8e012b81cf0814`
  zakoÄąâ€žczyÄąâ€ša siĂ„â„˘ przed utworzeniem kontenera: `bind source path does not exist:
  /run/desktop/mnt/host/r/fullmag_builds`. Hostowy marker istnieje; Docker
  Desktop nie udostĂ„â„˘pnia R:. Nie zmieniono konfiguracji/mountÄ‚Ĺ‚w koordynatora.
- Runner: trwaÄąâ€ša trasa dziaÄąâ€ša, 7 profili zachowanych, brak aktywnych jobÄ‚Ĺ‚w
  podczas pomiaru. Nowa trasa scratch nie moÄąÄ˝e byĂ„â€ˇ automatycznie dopuszczona
  bez sondy widocznoÄąâ€şci, zapisu UID i semantyki filesystemu.

NastĂ„â„˘pne kroki: udostĂ„â„˘pniĂ„â€ˇ R: demonowi Docker i ponowiĂ„â€ˇ sondĂ„â„˘; dopiero po PASS
wÄąâ€šĂ„â€¦czyĂ„â€ˇ dokÄąâ€šadny mount scratch, potwierdziĂ„â€ˇ recovery/retencjĂ„â„˘ i wykonaĂ„â€ˇ managed
FEM runtime-v2. Nie przenosiĂ„â€ˇ istniejĂ„â€¦cych runÄ‚Ĺ‚w. Integracja kodu Windows
z P8-57 wymaga zachowania dirty pracy drugiego wĂ„â€¦tku. RAM routing nie zamyka
bramek solvera, nauki ani UI.
