COMSOL A1 antidot magnonic crystal dispersion data
==================================================

MODEL GEOMETRY
--------------
2D square antidot lattice represented by one periodic unit cell.

Lattice constant:
  a = 200 nm

Ferromagnetic film thickness:
  t = 10 nm

Circular antidot radius:
  r = 50 nm

MATERIAL PARAMETERS
-------------------
Saturation magnetization:
  Ms = 800 kA/m

Exchange constant:
  Aex = 13 pJ/m

Gyromagnetic coefficient:
  gamma = 2.211e5 m/(A s)

BIAS FIELD
----------
Magnetic flux density:
  Bbias = 0.1 T

Direction:
  +x

RECIPROCAL-SPACE PATH
---------------------
Band structure is sampled along the standard high-symmetry path

  Gamma -> X -> M -> Gamma

with:

  Gamma = (0, 0)
  X     = (pi/a, 0)
  M     = (pi/a, pi/a)

For a = 200 nm:

  pi/a = 15.707963268 rad/um

Sampling:

  jpath = 0...20   : Gamma -> X
  jpath = 20...40  : X -> M
  jpath = 40...60  : M -> Gamma

The wave-vector definitions are:

Gamma -> X:
  kx = (pi/a) * jpath/20
  ky = 0

X -> M:
  kx = pi/a
  ky = (pi/a) * (jpath - 20)/20

M -> Gamma:
  kx = ky = (pi/a) * (60 - jpath)/20

DATA FORMAT
-----------
File:
  COMSOL_A1_dispersion.csv

Columns:

  jpath
      Integer path index from 0 to 60.

  kx_rad_per_um
      x component of the Bloch wave vector in rad/um.

  ky_rad_per_um
      y component of the Bloch wave vector in rad/um.

  frequency_order
      Local frequency ordering at a given k point (1...24).
      This is NOT a tracked band index. Eigenmodes were simply sorted
      by increasing eigenfrequency independently at each k point.

  frequency_GHz
      Eigenfrequency in GHz.

EIGENPROBLEM
------------
Number of sampled k points:
  61

Number of eigenfrequencies per k point:
  24

Total number of eigenfrequencies:
  1464

Gilbert damping used for eigenfrequency calculation:
  alpha = 0

VALIDATION
----------
The Gamma point is calculated twice, at jpath = 0 and jpath = 60.

Maximum absolute difference between the two sorted Gamma spectra:
  0 GHz

For the supplied dataset, the two Gamma spectra are therefore
identical within the exported numerical precision.

NOTES
-----
The quantity frequency_order should not be interpreted as a physical
band number across the full path. At crossings or avoided crossings,
mode ordering by frequency can change. Proper band tracking requires
comparison of eigenmode profiles, e.g. by eigenvector overlap.

The CSV contains raw eigenfrequencies together with the corresponding
Bloch wave-vector coordinates so that the dataset can be compared
directly with an independent numerical model.
