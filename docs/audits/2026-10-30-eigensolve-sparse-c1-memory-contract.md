# Sparse C1 — kontrakt storage estimate, 30.10.2026

Stan: implementacja źródłowa po review, native CI i runtime jeszcze NOT VERIFIED.
Cel: mierzyć operator oryginalnego przypadku q_split1312, bez zmniejszania
siatki, zwiększania limitu dokładnego Schura ani zmiany physical residual gate.

## Źródło estymaty

Pinned PETSc: `1467453aedb62826efc970ceafc4bd6dab8229ab`.
[MatGetInfo_SeqAIJ](https://github.com/petsc/petsc/blob/1467453aedb62826efc970ceafc4bd6dab8229ab/src/mat/impls/aij/seq/aij.c#L1975)
raportuje nz_allocated=maxnz i nz_used=nz, lecz memory=0.
Nie interpretujemy zera jako braku alokacji. Warunki: dokładny MATSEQAIJ,
communicator jednego procesu, PCLU i rzeczywisty builtin MATSOLVERPETSC
potwierdzony dla PC i factor matrix. Inne pakiety/typy dają unavailable.
[Setup LU](https://github.com/petsc/petsc/blob/1467453aedb62826efc970ceafc4bd6dab8229ab/src/ksp/pc/impls/factor/lu/lu.c#L118)
uzupełnia domyślny PC solver type z faktycznego faktora po setupie.

n oznacza liczbę wierszy, z zaalokowane nnz, s=sizeof(PetscScalar),
i=sizeof(PetscInt). Wszystkie działania mają kontrolę overflow; liczniki
muszą być skończone, całkowite, nieujemne i z_allocated>=z_used.

- Kopia P: z*(s+i)+(7*n+4)*i. Narzut obejmuje CSR row pointers, imax/ilen,
  opcjonalny diag, compressed-row i/rindex oraz inode-size.
- Faktor LU: z*(s+i)+(16*n+8)*i+(n+1)*s. Konserwatywny narzut obejmuje
  trwałe indeksy/permutacje, symbolic/inode scratch i numeric setup rtmp.
- Payload wektorów: (13*q_split+5*phi_split)*s. Nie jest to pomiar pełnych
  obiektów PETSc, allocator headers ani RSS.

Podstawą są [SeqAIJ struktury](https://github.com/petsc/petsc/blob/1467453aedb62826efc970ceafc4bd6dab8229ab/src/mat/impls/aij/seq/aij.h)
i [alokacje LU](https://github.com/petsc/petsc/blob/1467453aedb62826efc970ceafc4bd6dab8229ab/src/mat/impls/aij/seq/aijfact.c).
Preflight: kopia P + wektory +2x estymata istniejącego faktora.
Po prywatnym setupie: świeże capacity P/faktora + wektory. Oba admission
porównuje się z cap64MiB. Odrzucenie czyści prywatny workspace. Pomiar nie zastępuje fizycznego kryterium
akceptacji; niedostępność diagnostyki nie zmienia tego kryterium, a problemy
safety handler/cleanup zachowują fail-closed.

## Zakres i granice

Nowy tryb sparse_replay mierzy residual Poissona, production/isolated replay,
repeatability i additivity. Nie materializuje dużego Schura, nie wykonuje
live-PC/fresh-Pmat-LU/dense porównań; mają jawne unavailable i reason.
Default opt-out nie wykonuje dodatkowych query ani alokacji; stary full_small
pozostaje dla małych przypadków. Actual observed bytes pozostają null.
Literal źródła: petsc_seqaij_allocated_storage_estimate_not_rss.
Estymata nie gwarantuje szczytowej pamięci setupu/fill-in ani limitu RSS.
Pozostaje niezależna od równań i kryterium akceptacji modów.

Regresje: istniejący solver >512, wynik opt-out/opt-in i accepted residual,
SeqAIJ z memory0 oraz rzeczywistym CSR, invalid/missing/overflow/budget-1;
rzeczywisty C ABI producer sprawdza delimitery nowych JSON stringów.
Wykonanie wyłącznie w GitHub Actions przed qualified runtime.
