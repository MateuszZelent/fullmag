# Resistive gap excitation for the full-wave FIT reference

- Status — Draft reference extension
- Baseline — `7d36c49e2`
- Related notes — [Full-wave FIT antenna reference](0953-fullwave-fit-antenna.md) and [harmonic RF antenna](0952-harmonic-rf-antenna-cpw.md)

## 1. Physical problem

A finite copper GSG waveguide is excited at its end face. The full-wave research FIT solver currently imposes scalar terminal voltages and circuit loads with a constrained boundary trace. In the independent Palace control, two gap rectangles carry a prescribed tangential surface drive and a passive sheet admittance. The uncovered inlet retains the natural magnetic boundary. Comparing these two source models requires preserving the geometry, material stack, outlet and monitor while changing only the inlet boundary. The input-port dimensions, placement and calibration of the published CST project are unavailable.

## 2. Governing equations and SI units

Use peak phasors with physical time convention $e^{i\omega t}$. The volume has conductivity $\sigma$ in S/m, permittivity $\varepsilon$ in F/m and permeability $\mu$ in H/m. It obeys $\nabla\times E=-i\omega\mu H$ and $\nabla\times H=(\sigma+i\omega\varepsilon)E$. At a port patch with outward normal $n$, tangential projection $E_t$, tangential driving direction $d$ and uniform positive real sheet admittance $Y_s$ in S,

$$
 n\times H=-Y_s E_t+2Y_s E_{\rm inc}d .
$$

The first term absorbs outward power on both tangential components. The second launches the uniform incident field along $d$. The boundary is magnetic on uncovered surfaces, except where a separate PEC or termination is specified. A conductance on the total field is not a voltage constraint.

For $N$ rectangular patches forming one real port with resistance $R$ in Ω, assign branch resistance $NR$ to each patch of length $\ell$ along $d$ and perpendicular width $w$ in m. Its sheet resistance is $R_s=NRw/\ell$ in Ω per square and $Y_s=1/R_s$. For total incident power $P_{\rm inc}$ in W and phase $\phi$ in rad, the incident field is $E_{\rm inc}=\sqrt{2 R P_{\rm inc}}e^{i\phi}/\ell$ in V/m. The incident magnetic amplitude is $Y_s E_{\rm inc}$ in A/m. A patch has incident power $\tfrac12 Y_s|E_{\rm inc}|^2 w\ell=P_{\rm inc}/N$. A matched 50 Ω pair with $\ell=95$ nm, $w=10$ nm, $P_{\rm inc}=1$ W and opposite transverse directions has $R_s=10.52631579\,\Omega$, $|E_{\rm inc}|=1.05263158\times10^8$ V/m and $|Y_s E_{\rm inc}|=10^7$ A/m per patch. Unit incident power is a solver calibration. The absolute current and field in the CST article cannot be inferred from it.

With test field $v$, the surface contribution to the curl–curl weak equation is $i\omega\int_\Gamma v_t\cdot Y_s E_t\,dS$ on the left and $2i\omega\int_\Gamma v_t\cdot Y_s E_{\rm inc}d\,dS$ on the right. The time-average power extracted on the patch is $\tfrac12\int_\Gamma Y_s |E_t|^2\,dS$. The incident and reflected waves must be separated before comparing S-parameters.

## 3. Discretization

The first CPU double reference uses the existing orthogonal FIT volume operator. On a rectangular x-normal grid face with dimensions $\Delta y$, $\Delta z$, let the two parallel y-edges carry voltage-integral degrees of freedom. Exact integration of the piecewise linear trace yields a block $Y_s(\Delta z/6\Delta y)\begin{pmatrix}2&1\\1&2\end{pmatrix}$. Interchanging y and z gives the block for the other tangential pair. There are no cross terms because these direction vectors are orthogonal. A uniform y-directed surface drive places $Y_s E_{\rm inc}d_y\Delta z$ in each y-edge entry of the right-hand vector before multiplication by $i\omega$. Opposite gap orientations reverse only the drive sign. PEC edge values are removed from both matrix and source. The sheet is integrated on material-aligned end faces. No interpolation across an element is needed to place a gap edge.

An H(curl) FEM reference uses the same weak form and the tangential traces of edge basis functions; Palace is the independent implementation. Micromagnetic FDM receives a sampled complex H field only after validation of the electromagnetic stage. It does not apply RF surface conditions itself. FEM micromagnetics would consume that same physical quantity through its target projection. No GPU or single precision qualification is implied. A hybrid run keeps electromagnetic and micromagnetic provenance separate and records the source and target grids and phase.

## 4. API, runtime and output

The boundary is initially an explicit research input with quantities expressed in SI. The canonical Python, ProblemIR, planner, capability matrix, runner, OpenAPI and browser surfaces have no new admitted configuration at this stage. Native admission would put positive frequency, resistance, phase, incident power, direction and named disjoint gap surfaces on the existing antenna field solve stage. Planner validation must reject unresolvable surfaces, overlapping PEC, inconsistent terms and unsupported wave-mode terminations. A qualified native runtime would expose electric and magnetic phasors, copper current, outlet condition, physical power balance, mesh revision, original inputs and resolved port model using the existing field and artifact resources. Browser authoring would export the same port declaration to canonical Python and inspect H and J through the accepted artifact carrier. No production fallback should erase a requested surface port.

## 5. Validation gates

1. Check the analytic surface matrix with constant tangential fields, both tangential directions, multiple nonuniform faces, and limits of the uniform two-gap power identity. The block must be symmetric positive semidefinite. A zero incident drive has no source and retains damping. Opposite patch directions preserve the matrix. Test on the small reference grid before a volume solve.
2. Solve a simple matched and a mismatched guide with known incident phase and check energy. Compare through the same PEC mask, exact boundary patches, admittances and phasor convention. Report real power supplied by the drive, passive port dissipation, copper heat and any other exit flux. For the insulating uniform fixture this balance is limited by algebraic residual and arithmetic. For the physical guide also check mesh convergence and direct probes in both tools.
3. Run the 65 nm and 260 nm signal CPWs at 22.12 GHz with 95 nm gaps and 10 nm copper, 21 identical longitudinal sections and a common 20 nm transverse line 7.5 nm below copper. Validate complex H_y with the same inlet-current orientation and compare own-peak spectra. Record current closure, power and independent readback residual before interpreting a match with the published CST curves. A fair Palace A/B comparison requires the same outlet as FIT. Use a separately matched pair with resistive output first if the FIT wave outlet is unavailable. Identify the original CST outlet and monitor as unresolved inputs.

## 6. Completeness and deferred work

- [x] Governing boundary, assumptions and reproducible uniform-patch normalizations
- [x] Discrete surface operator and analytic fixture
- [x] Full-volume FIT solver and matched/mismatched analytical TEM fixtures
- [ ] Independent full-wave CPW1/CPW2 comparisons and mesh refinement
- [ ] Native stage, compiler, planner and artifact integration after qualification
- [ ] OpenAPI resource coverage, browser controls and Python round trip after qualification

An exact modal outlet, open boundary treatment, curved sheet ports and material-conformal edge integration remain separate work. A different outlet or monitor precludes attributing the entire residual to the inlet. The independent comparison to CST and the downstream spin dynamics have separate acceptance evidence.

## 7. References

- [Gruszecki et al., Scientific Reports 6, 22367](https://doi.org/10.1038/srep22367)
- [Palace boundary documentation at the pinned revision](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/docs/src/guide/boundaries.md)
- [Palace port normalization and source model at the pinned revision](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/palace/models/lumpedportoperator.cpp)
