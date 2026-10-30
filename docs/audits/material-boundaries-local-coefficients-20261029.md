# Lokalne współczynniki materiałowe — dalsze naprawy FEM/FDM

Baza: `65659dd04429ae01fa8101a78c6dba09d30242c7`. Zakres: zachowanie istniejącego kontraktu fizycznego; bez rozszerzania capability ani zmiany Python → IR.

## FEM: małe wartości Aex

Planner porównywał wszystkie wielkości materiałowe absolutnym progiem `1e-18`, niezależnie od ich jednostki. Regionalne nieostre `Aex=5e-19 J/m` przy bazowym `Aex=0` mogło zostać pominięte po prawidłowym próbkowaniu. Runner otrzymywał wtedy skalar zero zamiast pola węzłowego.

Kontrakt: [regiony i pola materiałowe](../physics/0104-material-regions-parameter-fields-and-interface-couplings.md). Redukcja pola do skalaru musi uwzględniać skalę współczynnika; dodatnia wartość nie może zniknąć wyłącznie z powodu małej liczby wyrażonej w SI. Granice DG0 i niedopuszczone kombinacje GPU pozostają osobnym kontraktem.

## FDM CPU: lokalne Ms w polu anizotropii

Ścieżki pola efektywnego AoS i SoA używały bazowego `Ms` w mianowniku anizotropii mimo dostępnego pola komórkowego. Dla jednakowej magnetyzacji i parametrów anizotropii zmiana lokalnego `Ms` z 800 do 400 kA/m powinna podwoić lokalne pole.

Obowiązują równania [anizotropii jednoosiowej](../physics/0402-uniaxial-anisotropy.md) oraz [kubicznej](../physics/0403-cubic-anisotropy.md): `H_anis = -(mu0 Ms)^-1 dw_anis/dm`, gdzie `Ms` jest lokalne, w A/m, a gęstość energii w J/m³. Poprawka dotyczy CPU reference; nie dowodzi wykonania ani parytetu CUDA. Energia nie otrzymuje dodatkowego mnożnika Ms.

## Plan dowodów

- FEM: regresja regionalnego Aex przy zerowej i małej dodatniej bazie oraz kontrola redukcji pola jednorodnego.
- FDM: rzeczywiste ścieżki pola efektywnego AoS/SoA, anizotropia jednoosiowa/kubiczna, lokalne i jednorodne Ms, kontrola maski i zerowego Ms.
- Kompilacja i testy wyłącznie w grupie Docker tego worktree; wymagane review i CI przed scaleniem.

## Wyniki lokalne

Grupa: `fullmag-worktree-fullmag-033f6660666cdc47`, źródła testów `/opt/fullmag/source`, prywatny target `/build/material-audit-target`.

- FEM RED: regresja nie przeszła z komunikatem `zero baseline regional Aex variation must remain nodal`. Po poprawce pełne `fullmag-plan --lib`: **624 PASS**.
- FDM RED: **4 FAIL / 2 PASS**; zarówno AoS, jak i SoA zwracały połowę prawidłowego pola dla drugiej komórki. Po poprawce wszystkie sześć nowych regresji przechodzi.
- Pełne `fullmag-engine --lib`: **382 PASS, 1 ignored**. Pierwsze uruchomienie ujawniło nieaktualny fixture M2: komórka magnetyczna znajdowała się poza domeną transportu. Fixture skorygowano zgodnie z [kontraktem M2](../physics/0970-spin-hall-drift-diffusion-transport.md); produkcyjny guard pozostaje bez zmian.
- Workflow `bootstrap`, job `rust-contracts`, jawnie uruchamia nowe regresje FDM i FEM. Dotychczasowe filtrowane wywołania Cargo nie obejmowały ich automatycznie.
- Bazowy build API miał E0507 w closure ponawiającym publikację skalarów. `std::slice::from_ref(&entry)` zachowuje pożyczkę zamiast przenosić wpis. Zarządzany build `cuda-fem-gpu` po tej poprawce zakończył fazę `make` z kodem 0.
- Logi: `/build/material-local-fem-red.log`, `/build/material-local-fem-green.log`, `/build/material-local-fdm-red-retry.log`, `/build/material-local-fdm-green-final.log` w zachowanym wolumenie grupy. Pierwszy FDM RED został przerwany wraz z błędem buildu API; nie jest zaliczany jako wynik regresji.

Checkpointy:

- `877ae414a674b887da4094e572359e2cd12503a6` — FEM i regresja.
- `cee88a19ffa751ba1ee51cc49f89c5ae2de9ef29` — FDM AoS/SoA i sześć regresji.
- `aa3db73468be401993457c6c2a147966c8fa2dd5` — zgodność fixture transportowego.
- `bfb44eba979aa9de3b88bd8a60a7a75bdc0bcbd8` — blocker kompilacji publikacji skalarów.

Nie wykonano nowej kwalifikacji urządzenia GPU ani parytetu naukowego wszystkich oddziaływań. Start backendu budował spójny cień źródeł sprzed końcowej poprawki FDM; dowodem tej poprawki są testy aktualnych źródeł, nie ten pakiet runtime. Integracja i CI wymagają osobnego potwierdzenia dla końcowego PR.
