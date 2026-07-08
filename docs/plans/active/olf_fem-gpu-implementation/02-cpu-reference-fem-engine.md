# S2: CPU Reference FEM Engine w Rust

- Etap: **S2** (po S1 — wymaga MeshIR)
- Priorytet: **HIGH** — baseline do walidacji GPU backendu
- Docelowy crate: `fullmag-engine` (nowy moduł `fem/`)

---

## 1. Cele etapu

1. **Implementacja P1 FEM** w czystym Rust (brak zależności od C++/MFEM).
2. **Oddziaływania**: Exchange + Demag (air-box Poisson) + Zeeman.
3. **Integrator**: Heun (Euler predictor-corrector), potem SSPRK3.
4. **Funkcja**: `execute_reference_fem(plan: &FemPlanIR) -> FemResult` — analogicznie do FDM.
5. **Cel**: Dopasowanie wynikowe z FDM na geometrii Box (cross-backend test).

---

## 2. Architektura modułu

```
crates/fullmag-engine/src/
├── lib.rs               # pub mod fem; + istniejący pub mod fdm;
├── fdm/                 # (istniejący)
│   └── ...
└── fem/
    ├── mod.rs           # pub use, FemEngine, execute_reference_fem()
    ├── mesh.rs          # MeshTopology — from MeshIR, adjacency, node_volumes
    ├── shape.rs         # P1 tetrahedron shape functions + gradients
    ├── assembly.rs      # Stiffness matrix K, Mass matrix M assembly
    ├── operators.rs     # Exchange, Demag, Zeeman field operators
    ├── poisson.rs       # CG solver for -Δu = f with Dirichlet BC
    ├── integrator.rs    # Heun stepper, renormalization
    └── result.rs        # FemStepResult, FemResult (matching FDM format)
```

---

## 3. Elementy bazowe P1

### 3.1 Tetraedr P1 — funkcje kształtu

Liniowy tetraedr P1 ma 4 węzły i 4 funkcje kształtu bazowe:

$$\phi_i(\mathbf{x}) = a_i + b_i x + c_i y + d_i z$$

Gdzie współczynniki wyznaczone z macierzy barycentrycznej:

$$
\begin{pmatrix} 1 & x_0 & y_0 & z_0 \\ 1 & x_1 & y_1 & z_1 \\ 1 & x_2 & y_2 & z_2 \\ 1 & x_3 & y_3 & z_3 \end{pmatrix}
\begin{pmatrix} a_i \\ b_i \\ c_i \\ d_i \end{pmatrix}
= \mathbf{e}_i
$$

Gradienty są **stałe na elemencie** (kluczowa cecha P1):

$$\nabla\phi_i = (b_i, c_i, d_i) = \text{const w elemencie}$$

### 3.2 Macierz sztywności elementowa (exchange)

Dla elementu $e$ o objętości $V_e$:

$$K^e_{ij} = V_e \, \nabla\phi_i \cdot \nabla\phi_j$$

Macierz $4 \times 4$, symetryczna. Grad stały → 1-punktowa kwadratura jest dokładna.

### 3.3 Macierz masowa elementowa

Pełna (consistent):

$$M^e_{ij} = V_e \times \begin{cases} 1/10 & i = j \\ 1/20 & i \neq j \end{cases}$$

Lumped (diagonalna, szybsza):

$$M^e_{ii,\text{lumped}} = V_e / 4$$

**Decyzja**: Lumped mass na start (wymagana dla explicit RK bez rozwiązywania układu).

---

## 4. Zadania szczegółowe

### S2.1 — `MeshTopology` z `MeshIR`

```rust
/// fem/mesh.rs

/// Processed mesh topology ready for FEM computation.
pub struct MeshTopology {
    /// Node coordinates (n_nodes × 3), row-major.
    pub coords: Vec<[f64; 3]>,

    /// Element connectivity (n_elements × 4), 0-based node indices.
    pub elements: Vec<[u32; 4]>,

    /// Lumped node volumes (n_nodes).
    pub node_volumes: Vec<f64>,

    /// Total magnetic volume (sum of magnetic element volumes).
    pub total_volume: f64,

    /// Per-element volumes (n_elements).
    pub element_volumes: Vec<f64>,

    /// Per-element gradients of shape functions:
    /// grad_phi[e][i] = ∇φ_i on element e.
    /// Shape: n_elements × 4 × 3
    pub grad_phi: Vec<[[f64; 3]; 4]>,

    /// Per-element material marker.
    pub element_markers: Vec<u32>,

    /// Boundary nodes (indices).
    pub boundary_nodes: Vec<u32>,

    /// Boundary faces (F × 3).
    pub boundary_faces: Vec<[u32; 3]>,

    /// Number of nodes.
    pub n_nodes: usize,

    /// Number of elements.
    pub n_elements: usize,
}

impl MeshTopology {
    /// Build topology from MeshIR.
    pub fn from_ir(mesh: &MeshIR) -> Result<Self, String> {
        mesh.validate()?;

        let n_nodes = mesh.n_nodes();
        let n_elements = mesh.n_elements();

        // Parse coordinates
        let coords: Vec<[f64; 3]> = (0..n_nodes)
            .map(|i| [mesh.nodes[3*i], mesh.nodes[3*i+1], mesh.nodes[3*i+2]])
            .collect();

        // Parse elements
        let elements: Vec<[u32; 4]> = (0..n_elements)
            .map(|i| [
                mesh.elements[4*i],
                mesh.elements[4*i+1],
                mesh.elements[4*i+2],
                mesh.elements[4*i+3],
            ])
            .collect();

        // Compute gradients and volumes
        let mut element_volumes = Vec::with_capacity(n_elements);
        let mut grad_phi = Vec::with_capacity(n_elements);

        for e in 0..n_elements {
            let [n0, n1, n2, n3] = elements[e];
            let p0 = coords[n0 as usize];
            let p1 = coords[n1 as usize];
            let p2 = coords[n2 as usize];
            let p3 = coords[n3 as usize];

            // Edge vectors
            let d1 = [p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]];
            let d2 = [p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]];
            let d3 = [p3[0]-p0[0], p3[1]-p0[1], p3[2]-p0[2]];

            // Jacobian matrix J = [d1 | d2 | d3]
            // det(J) = d1 · (d2 × d3)
            let cross = [
                d2[1]*d3[2] - d2[2]*d3[1],
                d2[2]*d3[0] - d2[0]*d3[2],
                d2[0]*d3[1] - d2[1]*d3[0],
            ];
            let det = d1[0]*cross[0] + d1[1]*cross[1] + d1[2]*cross[2];
            let vol = det.abs() / 6.0;
            element_volumes.push(vol);

            // J^{-T} columns = gradients of barycentric coords λ1, λ2, λ3
            // λ0 = 1 - λ1 - λ2 - λ3
            // ∇λ_i = J^{-T} e_i for i=1,2,3
            // ∇λ_0 = -(∇λ_1 + ∇λ_2 + ∇λ_3)

            let inv_det = 1.0 / det;
            // J^{-T} = cofactor(J) / det
            // Row i of J^{-T} = column i of adj(J) / det

            let grad1 = [
                (d2[1]*d3[2] - d2[2]*d3[1]) * inv_det,
                (d2[2]*d3[0] - d2[0]*d3[2]) * inv_det,
                (d2[0]*d3[1] - d2[1]*d3[0]) * inv_det,
            ];
            let grad2 = [
                (d3[1]*d1[2] - d3[2]*d1[1]) * inv_det,
                (d3[2]*d1[0] - d3[0]*d1[2]) * inv_det,
                (d3[0]*d1[1] - d3[1]*d1[0]) * inv_det,
            ];
            let grad3 = [
                (d1[1]*d2[2] - d1[2]*d2[1]) * inv_det,
                (d1[2]*d2[0] - d1[0]*d2[2]) * inv_det,
                (d1[0]*d2[1] - d1[1]*d2[0]) * inv_det,
            ];
            let grad0 = [
                -(grad1[0] + grad2[0] + grad3[0]),
                -(grad1[1] + grad2[1] + grad3[1]),
                -(grad1[2] + grad2[2] + grad3[2]),
            ];

            grad_phi.push([grad0, grad1, grad2, grad3]);
        }

        // Lumped node volumes
        let mut node_volumes = vec![0.0_f64; n_nodes];
        for e in 0..n_elements {
            let vol_quarter = element_volumes[e] / 4.0;
            for &ni in &elements[e] {
                node_volumes[ni as usize] += vol_quarter;
            }
        }

        let total_volume: f64 = element_volumes.iter().sum();

        // Parse markers
        let element_markers: Vec<u32> = mesh.element_markers.iter().map(|&m| m as u32).collect();

        // Boundary
        let boundary_nodes: Vec<u32> = mesh.node_markers.iter().enumerate()
            .filter(|(_, &m)| m > 0)
            .map(|(i, _)| i as u32)
            .collect();

        let boundary_faces: Vec<[u32; 3]> = (0..mesh.n_boundary_faces())
            .map(|i| [
                mesh.boundary_faces[3*i],
                mesh.boundary_faces[3*i+1],
                mesh.boundary_faces[3*i+2],
            ])
            .collect();

        Ok(Self {
            coords,
            elements,
            node_volumes,
            total_volume,
            element_volumes,
            grad_phi,
            element_markers,
            boundary_nodes,
            boundary_faces,
            n_nodes,
            n_elements,
        })
    }
}
```

---

### S2.2 — Globalna macierz sztywności (CSR)

```rust
/// fem/assembly.rs

use nalgebra_sparse::{CsrMatrix, CooMatrix};

/// Assemble global stiffness matrix K for exchange.
///
/// K_ij = Σ_e V_e ∇φ_i^e · ∇φ_j^e   (summed over elements where i,j are local nodes)
///
/// For P1: gradients constant on element → exact with 1-point quadrature.
pub fn assemble_stiffness(topo: &MeshTopology) -> CsrMatrix<f64> {
    let mut coo = CooMatrix::new(topo.n_nodes, topo.n_nodes);

    for e in 0..topo.n_elements {
        let vol = topo.element_volumes[e];
        let grads = &topo.grad_phi[e];
        let nodes = &topo.elements[e];

        for i in 0..4 {
            for j in 0..4 {
                let dot = grads[i][0]*grads[j][0]
                        + grads[i][1]*grads[j][1]
                        + grads[i][2]*grads[j][2];
                let val = vol * dot;
                if val.abs() > 1e-30 {
                    coo.push(nodes[i] as usize, nodes[j] as usize, val);
                }
            }
        }
    }

    CsrMatrix::from(&coo)
}


/// Lumped mass vector: M_i = Σ_e (V_e / 4) for all elements containing node i.
///
/// This is exactly `topo.node_volumes`.
pub fn lumped_mass(topo: &MeshTopology) -> &[f64] {
    &topo.node_volumes
}


/// Assemble gradient operator G_x, G_y, G_z.
///
/// (G_x)_{ei} = ∂φ_i/∂x on element e (constant per element).
/// Size: n_elements × n_nodes (sparse, 4 non-zeros per row).
///
/// Potrzebne do: divergence source w demag (∇·M).
pub fn assemble_gradient_operators(topo: &MeshTopology)
    -> (CsrMatrix<f64>, CsrMatrix<f64>, CsrMatrix<f64>)
{
    let mut gx = CooMatrix::new(topo.n_elements, topo.n_nodes);
    let mut gy = CooMatrix::new(topo.n_elements, topo.n_nodes);
    let mut gz = CooMatrix::new(topo.n_elements, topo.n_nodes);

    for e in 0..topo.n_elements {
        let grads = &topo.grad_phi[e];
        let nodes = &topo.elements[e];

        for i in 0..4 {
            gx.push(e, nodes[i] as usize, grads[i][0]);
            gy.push(e, nodes[i] as usize, grads[i][1]);
            gz.push(e, nodes[i] as usize, grads[i][2]);
        }
    }

    (CsrMatrix::from(&gx), CsrMatrix::from(&gy), CsrMatrix::from(&gz))
}
```

---

### S2.3 — Operator wymiany (Exchange)

```rust
/// fem/operators.rs

/// Compute exchange effective field: H_ex = (2A / μ₀Ms) M_lump^{-1} K m
///
/// For vector magnetization m = (mx, my, mz) each with n_nodes components:
///   H_ex_x = (2A / μ₀Ms) * diag(1/node_vol) * K * mx
///   H_ex_y = (2A / μ₀Ms) * diag(1/node_vol) * K * my
///   H_ex_z = (2A / μ₀Ms) * diag(1/node_vol) * K * mz
///
/// Where K is the stiffness matrix.
pub fn exchange_field(
    stiffness: &CsrMatrix<f64>,
    node_volumes: &[f64],
    mx: &[f64], my: &[f64], mz: &[f64],
    a_exchange: f64,  // Exchange stiffness [J/m]
    mu0_ms: f64,      // μ₀Ms [T]
    hx: &mut [f64], hy: &mut [f64], hz: &mut [f64],
) {
    let prefactor = 2.0 * a_exchange / mu0_ms;
    let n = mx.len();

    // K * mx → tmp
    let kmx = spmv(stiffness, mx);
    let kmy = spmv(stiffness, my);
    let kmz = spmv(stiffness, mz);

    for i in 0..n {
        let inv_vol = 1.0 / node_volumes[i];
        hx[i] = prefactor * inv_vol * kmx[i];
        hy[i] = prefactor * inv_vol * kmy[i];
        hz[i] = prefactor * inv_vol * kmz[i];
    }
}

/// Sparse matrix-vector product y = A * x.
fn spmv(a: &CsrMatrix<f64>, x: &[f64]) -> Vec<f64> {
    let n = a.nrows();
    let mut y = vec![0.0; n];
    for i in 0..n {
        let row = a.row(i);
        let mut sum = 0.0;
        for (&col, &val) in row.col_indices().iter().zip(row.values().iter()) {
            sum += val * x[col];
        }
        y[i] = sum;
    }
    y
}
```

---

### S2.4 — Operator demagnetyzacyjny (Poisson solver)

```rust
/// fem/poisson.rs

/// Solve the scalar potential Poisson problem for demagnetizing field.
///
/// Problem: -Δu = -∇·M  in Ω ∪ Ω_air
///          u = 0          on ∂Ω_air (Dirichlet, first-order truncation)
///
/// Then: H_d = -∇u (restricted to magnetic nodes)
///
/// Discretization:
///   K_poisson * u_h = f
///   where f_i = -Σ_e V_e (∇φ_i · M_e)
///   and K_poisson = global stiffness on full (magnetic + air) mesh
///   with Dirichlet rows zeroed and u=0 on boundary.

/// Assemble Poisson RHS from magnetization field.
///
/// f_i = -Σ_{e ∋ i, e ∈ Ω_m} V_e (∇φ_i^e · M_e)
///
/// M_e = (mx_avg, my_avg, mz_avg) — average over 4 nodes of element e.
pub fn assemble_poisson_rhs(
    topo: &MeshTopology,
    mx: &[f64], my: &[f64], mz: &[f64],
    ms: f64,
) -> Vec<f64> {
    let n = topo.n_nodes;
    let mut rhs = vec![0.0; n];

    for e in 0..topo.n_elements {
        // Only magnetic elements contribute source
        if topo.element_markers[e] != 1 { continue; }  // 1 = magnetic

        let nodes = &topo.elements[e];
        let vol = topo.element_volumes[e];
        let grads = &topo.grad_phi[e];

        // Average magnetization on element
        let mx_avg = (0..4).map(|i| mx[nodes[i] as usize]).sum::<f64>() / 4.0;
        let my_avg = (0..4).map(|i| my[nodes[i] as usize]).sum::<f64>() / 4.0;
        let mz_avg = (0..4).map(|i| mz[nodes[i] as usize]).sum::<f64>() / 4.0;

        for i in 0..4 {
            let dot = grads[i][0] * mx_avg + grads[i][1] * my_avg + grads[i][2] * mz_avg;
            // RHS: -∫ ∇φ_i · M dV ≈ -V_e ∇φ_i · M_e
            rhs[nodes[i] as usize] += -vol * ms * dot;
        }
    }

    rhs
}


/// Apply Dirichlet BC (u=0) to system: zero rows/cols, set diagonal to 1.
pub fn apply_dirichlet_bc(
    stiffness: &mut CsrMatrix<f64>,
    rhs: &mut [f64],
    boundary_nodes: &[u32],
) {
    // For each boundary node, zero the row and column, set diagonal = 1, rhs = 0
    let boundary_set: std::collections::HashSet<usize> =
        boundary_nodes.iter().map(|&n| n as usize).collect();

    for i in 0..stiffness.nrows() {
        if boundary_set.contains(&i) {
            // Zero row
            let row = stiffness.row_mut(i);
            for val in row.values_mut() {
                *val = 0.0;
            }
            // Set diagonal = 1 (must exist in sparsity pattern)
            // Handle via separate pass
            rhs[i] = 0.0;
        }
    }
    // Set diagonals of boundary nodes to 1
    for &bnode in boundary_nodes {
        let i = bnode as usize;
        let row = stiffness.row(i);
        for (&col, _) in row.col_indices().iter().zip(row.values()) {
            if col == i {
                // Need mutable access — use index-based approach
                break;
            }
        }
        // Alternative: build modified matrix
        // (Production implementation uses index-based diagonal access)
    }
}


/// CG solver for K * u = f.
///
/// Simple unpreconditioned CG. Production will use AMG preconditioning.
pub fn solve_cg(
    k: &CsrMatrix<f64>,
    rhs: &[f64],
    x: &mut [f64],
    tol: f64,
    max_iter: usize,
) -> (usize, f64) {
    let n = rhs.len();

    // r = rhs - K*x
    let kx = spmv(k, x);
    let mut r: Vec<f64> = (0..n).map(|i| rhs[i] - kx[i]).collect();
    let mut p = r.clone();
    let mut rs_old: f64 = r.iter().map(|&ri| ri * ri).sum();

    if rs_old.sqrt() < tol {
        return (0, rs_old.sqrt());
    }

    for iter in 0..max_iter {
        let kp = spmv(k, &p);
        let p_dot_kp: f64 = p.iter().zip(kp.iter()).map(|(&pi, &ki)| pi * ki).sum();

        if p_dot_kp.abs() < 1e-30 {
            return (iter + 1, rs_old.sqrt());
        }

        let alpha = rs_old / p_dot_kp;

        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * kp[i];
        }

        let rs_new: f64 = r.iter().map(|&ri| ri * ri).sum();

        if rs_new.sqrt() < tol {
            return (iter + 1, rs_new.sqrt());
        }

        let beta = rs_new / rs_old;
        for i in 0..n {
            p[i] = r[i] + beta * p[i];
        }

        rs_old = rs_new;
    }

    (max_iter, rs_old.sqrt())
}


/// Recover demagnetizing field from scalar potential: H_d = -∇u.
///
/// For P1: H_d is constant per element. Average to nodes.
pub fn recover_demag_field(
    topo: &MeshTopology,
    u: &[f64],
    mu0_ms: f64,
    hx: &mut [f64], hy: &mut [f64], hz: &mut [f64],
) {
    let n = topo.n_nodes;
    // Zero output
    for i in 0..n {
        hx[i] = 0.0;
        hy[i] = 0.0;
        hz[i] = 0.0;
    }
    let mut count = vec![0u32; n];

    for e in 0..topo.n_elements {
        let nodes = &topo.elements[e];
        let grads = &topo.grad_phi[e];

        // -∇u on element = -Σ_i u_i ∇φ_i
        let mut grad_u = [0.0; 3];
        for i in 0..4 {
            let ui = u[nodes[i] as usize];
            grad_u[0] += ui * grads[i][0];
            grad_u[1] += ui * grads[i][1];
            grad_u[2] += ui * grads[i][2];
        }

        // H_d = -∇u, distribute to nodes (unweighted average)
        for i in 0..4 {
            let ni = nodes[i] as usize;
            hx[ni] += -grad_u[0];
            hy[ni] += -grad_u[1];
            hz[ni] += -grad_u[2];
            count[ni] += 1;
        }
    }

    // Average
    for i in 0..n {
        if count[i] > 0 {
            let c = count[i] as f64;
            hx[i] /= c;
            hy[i] /= c;
            hz[i] /= c;
        }
    }
}
```

---

### S2.5 — Operator Zeemana

```rust
/// fem/operators.rs (continuation)

/// Compute Zeeman field: H_zeeman = H_ext (uniform, applied to all nodes).
///
/// Trivial for uniform field. For non-uniform: interpolate at node positions.
pub fn zeeman_field(
    n_nodes: usize,
    hx_ext: f64, hy_ext: f64, hz_ext: f64,
    hx: &mut [f64], hy: &mut [f64], hz: &mut [f64],
) {
    for i in 0..n_nodes {
        hx[i] = hx_ext;
        hy[i] = hy_ext;
        hz[i] = hz_ext;
    }
}
```

---

### S2.6 — Integrator Heuna (LLG)

```rust
/// fem/integrator.rs

/// LLG right-hand side: dm/dt = f(m, H_eff)
///
/// f(m, H) = -γ/(1+α²) [m × H + α m × (m × H)]
///
/// Applied per-node. m_i is unit vector.
pub fn llg_rhs(
    mx: &[f64], my: &[f64], mz: &[f64],
    hx: &[f64], hy: &[f64], hz: &[f64],
    gamma: f64,  // gyromagnetic ratio [rad/(s·T)]
    alpha: f64,  // Gilbert damping
    dmx: &mut [f64], dmy: &mut [f64], dmz: &mut [f64],
) {
    let prefactor = -gamma / (1.0 + alpha * alpha);
    let n = mx.len();

    for i in 0..n {
        let (mx_i, my_i, mz_i) = (mx[i], my[i], mz[i]);
        let (hx_i, hy_i, hz_i) = (hx[i], hy[i], hz[i]);

        // m × H
        let txhx = my_i * hz_i - mz_i * hy_i;
        let txhy = mz_i * hx_i - mx_i * hz_i;
        let txhz = mx_i * hy_i - my_i * hx_i;

        // m × (m × H)
        let txxhx = my_i * txhz - mz_i * txhy;
        let txxhy = mz_i * txhx - mx_i * txhz;
        let txxhz = mx_i * txhy - my_i * txhx;

        dmx[i] = prefactor * (txhx + alpha * txxhx);
        dmy[i] = prefactor * (txhy + alpha * txxhy);
        dmz[i] = prefactor * (txhz + alpha * txxhz);
    }
}


/// Heun integrator (Euler predictor + Trapezoidal corrector).
///
/// Step 1 (Euler predictor):
///   m* = m_n + dt * f(m_n, H(m_n))
///   normalize(m*)
///
/// Step 2 (Trapezoidal corrector):
///   m_{n+1} = m_n + (dt/2) * [f(m_n, H(m_n)) + f(m*, H(m*))]
///   normalize(m_{n+1})
pub struct HeunStepper {
    pub n_nodes: usize,
    pub dt: f64,
    pub gamma: f64,
    pub alpha: f64,
    // Scratch buffers
    k1x: Vec<f64>, k1y: Vec<f64>, k1z: Vec<f64>,
    k2x: Vec<f64>, k2y: Vec<f64>, k2z: Vec<f64>,
    m_star_x: Vec<f64>, m_star_y: Vec<f64>, m_star_z: Vec<f64>,
    heff_x: Vec<f64>, heff_y: Vec<f64>, heff_z: Vec<f64>,
}

impl HeunStepper {
    pub fn new(n_nodes: usize, dt: f64, gamma: f64, alpha: f64) -> Self {
        Self {
            n_nodes, dt, gamma, alpha,
            k1x: vec![0.0; n_nodes], k1y: vec![0.0; n_nodes], k1z: vec![0.0; n_nodes],
            k2x: vec![0.0; n_nodes], k2y: vec![0.0; n_nodes], k2z: vec![0.0; n_nodes],
            m_star_x: vec![0.0; n_nodes], m_star_y: vec![0.0; n_nodes], m_star_z: vec![0.0; n_nodes],
            heff_x: vec![0.0; n_nodes], heff_y: vec![0.0; n_nodes], heff_z: vec![0.0; n_nodes],
        }
    }

    /// Perform one Heun step.
    ///
    /// `compute_heff` is a closure that computes H_eff from m.
    /// Signature: compute_heff(mx, my, mz, &mut hx, &mut hy, &mut hz)
    pub fn step<F>(
        &mut self,
        mx: &mut [f64], my: &mut [f64], mz: &mut [f64],
        mut compute_heff: F,
    )
    where
        F: FnMut(&[f64], &[f64], &[f64], &mut [f64], &mut [f64], &mut [f64]),
    {
        let n = self.n_nodes;
        let dt = self.dt;

        // Step 1: compute H_eff(m_n)
        compute_heff(mx, my, mz, &mut self.heff_x, &mut self.heff_y, &mut self.heff_z);

        // k1 = f(m_n, H_eff(m_n))
        llg_rhs(
            mx, my, mz,
            &self.heff_x, &self.heff_y, &self.heff_z,
            self.gamma, self.alpha,
            &mut self.k1x, &mut self.k1y, &mut self.k1z,
        );

        // m* = m_n + dt * k1
        for i in 0..n {
            self.m_star_x[i] = mx[i] + dt * self.k1x[i];
            self.m_star_y[i] = my[i] + dt * self.k1y[i];
            self.m_star_z[i] = mz[i] + dt * self.k1z[i];
        }
        normalize_vectors(&mut self.m_star_x, &mut self.m_star_y, &mut self.m_star_z);

        // Step 2: compute H_eff(m*)
        compute_heff(
            &self.m_star_x, &self.m_star_y, &self.m_star_z,
            &mut self.heff_x, &mut self.heff_y, &mut self.heff_z,
        );

        // k2 = f(m*, H_eff(m*))
        llg_rhs(
            &self.m_star_x, &self.m_star_y, &self.m_star_z,
            &self.heff_x, &self.heff_y, &self.heff_z,
            self.gamma, self.alpha,
            &mut self.k2x, &mut self.k2y, &mut self.k2z,
        );

        // m_{n+1} = m_n + (dt/2) * (k1 + k2)
        for i in 0..n {
            mx[i] += 0.5 * dt * (self.k1x[i] + self.k2x[i]);
            my[i] += 0.5 * dt * (self.k1y[i] + self.k2y[i]);
            mz[i] += 0.5 * dt * (self.k1z[i] + self.k2z[i]);
        }
        normalize_vectors(mx, my, mz);
    }
}


/// Normalize each (mx[i], my[i], mz[i]) to unit length.
fn normalize_vectors(mx: &mut [f64], my: &mut [f64], mz: &mut [f64]) {
    for i in 0..mx.len() {
        let norm = (mx[i]*mx[i] + my[i]*my[i] + mz[i]*mz[i]).sqrt();
        if norm > 1e-30 {
            let inv = 1.0 / norm;
            mx[i] *= inv;
            my[i] *= inv;
            mz[i] *= inv;
        }
    }
}
```

---

### S2.7 — Główna pętla (`execute_reference_fem`)

```rust
/// fem/mod.rs

pub fn execute_reference_fem(plan: &FemPlanIR) -> Result<FemResult, FemError> {
    // 1. Build mesh topology
    let topo = MeshTopology::from_ir(&plan.mesh)?;

    // 2. Assemble operators
    let stiffness = assemble_stiffness(&topo);
    let poisson_stiffness = if plan.has_demag() {
        let mut k = assemble_stiffness(&topo);
        apply_dirichlet_bc(&mut k, &mut vec![0.0; topo.n_nodes], &topo.boundary_nodes);
        Some(k)
    } else {
        None
    };

    // 3. Initialize magnetization
    let (mut mx, mut my, mut mz) = initialize_magnetization(
        &topo, &plan.initial_magnetization
    );

    // 4. Create integrator
    let mut stepper = HeunStepper::new(
        topo.n_nodes,
        plan.fixed_timestep,
        GAMMA_0,  // γ₀ = 2.2128e5 m/(A·s)
        plan.material.alpha,
    );

    // 5. Scratch arrays for H_eff
    let a_ex = plan.material.a_exchange;
    let mu0_ms = MU_0 * plan.material.ms;
    let ms = plan.material.ms;

    // 6. Time integration loop
    let mut results = Vec::new();
    let n_steps = plan.n_steps();

    for step in 0..n_steps {
        // Compute total H_eff = H_ex + H_d + H_ext
        let compute_heff = |mx: &[f64], my: &[f64], mz: &[f64],
                            hx: &mut [f64], hy: &mut [f64], hz: &mut [f64]| {
            // Zero
            for i in 0..topo.n_nodes {
                hx[i] = 0.0; hy[i] = 0.0; hz[i] = 0.0;
            }

            // Exchange
            if plan.has_exchange() {
                let mut hex = vec![0.0; topo.n_nodes];
                let mut hey = vec![0.0; topo.n_nodes];
                let mut hez = vec![0.0; topo.n_nodes];
                exchange_field(
                    &stiffness, &topo.node_volumes,
                    mx, my, mz, a_ex, mu0_ms,
                    &mut hex, &mut hey, &mut hez,
                );
                for i in 0..topo.n_nodes {
                    hx[i] += hex[i]; hy[i] += hey[i]; hz[i] += hez[i];
                }
            }

            // Demag
            if let Some(ref pk) = poisson_stiffness {
                let mut rhs = assemble_poisson_rhs(&topo, mx, my, mz, ms);
                // Apply Dirichlet BC on RHS
                for &bn in &topo.boundary_nodes {
                    rhs[bn as usize] = 0.0;
                }
                let mut u = vec![0.0; topo.n_nodes];
                solve_cg(pk, &rhs, &mut u, 1e-10, 5000);
                let mut hdx = vec![0.0; topo.n_nodes];
                let mut hdy = vec![0.0; topo.n_nodes];
                let mut hdz = vec![0.0; topo.n_nodes];
                recover_demag_field(&topo, &u, mu0_ms, &mut hdx, &mut hdy, &mut hdz);
                for i in 0..topo.n_nodes {
                    hx[i] += hdx[i]; hy[i] += hdy[i]; hz[i] += hdz[i];
                }
            }

            // Zeeman
            if let Some(ref ext) = plan.external_field() {
                for i in 0..topo.n_nodes {
                    hx[i] += ext[0]; hy[i] += ext[1]; hz[i] += ext[2];
                }
            }
        };

        stepper.step(&mut mx, &mut my, &mut mz, compute_heff);

        // Record
        if step % plan.output_interval() == 0 {
            results.push(FemStepResult {
                step,
                time: step as f64 * plan.fixed_timestep,
                energy_exchange: compute_exchange_energy(&stiffness, &mx, &my, &mz, a_ex),
                energy_demag: 0.0, // TODO: compute from u
                energy_zeeman: 0.0, // TODO
                avg_mx: volume_average(&mx, &topo.node_volumes, topo.total_volume),
                avg_my: volume_average(&my, &topo.node_volumes, topo.total_volume),
                avg_mz: volume_average(&mz, &topo.node_volumes, topo.total_volume),
                max_torque: compute_max_torque(&mx, &my, &mz,
                    &stepper.heff_x, &stepper.heff_y, &stepper.heff_z),
            });
        }
    }

    Ok(FemResult {
        steps: results,
        final_mx: mx,
        final_my: my,
        final_mz: mz,
        mesh_nodes: topo.coords.clone(),
        mesh_elements: topo.elements.clone(),
    })
}


/// Volume-weighted average of scalar field.
fn volume_average(field: &[f64], node_volumes: &[f64], total_volume: f64) -> f64 {
    field.iter().zip(node_volumes.iter())
        .map(|(&f, &v)| f * v)
        .sum::<f64>() / total_volume
}


/// Compute exchange energy: E_ex = A ∫|∇m|² dV
/// = A * Σ_comp mᵀ K m
fn compute_exchange_energy(
    stiffness: &CsrMatrix<f64>,
    mx: &[f64], my: &[f64], mz: &[f64],
    a_exchange: f64,
) -> f64 {
    let kmx = spmv(stiffness, mx);
    let kmy = spmv(stiffness, my);
    let kmz = spmv(stiffness, mz);

    let dot_x: f64 = mx.iter().zip(kmx.iter()).map(|(&m, &k)| m * k).sum();
    let dot_y: f64 = my.iter().zip(kmy.iter()).map(|(&m, &k)| m * k).sum();
    let dot_z: f64 = mz.iter().zip(kmz.iter()).map(|(&m, &k)| m * k).sum();

    a_exchange * (dot_x + dot_y + dot_z)
}


/// Maximum torque |m × H|_∞
fn compute_max_torque(
    mx: &[f64], my: &[f64], mz: &[f64],
    hx: &[f64], hy: &[f64], hz: &[f64],
) -> f64 {
    let mut max_t = 0.0_f64;
    for i in 0..mx.len() {
        let tx = my[i]*hz[i] - mz[i]*hy[i];
        let ty = mz[i]*hx[i] - mx[i]*hz[i];
        let tz = mx[i]*hy[i] - my[i]*hx[i];
        let t = (tx*tx + ty*ty + tz*tz).sqrt();
        if t > max_t { max_t = t; }
    }
    max_t
}
```

---

### S2.8 — Struktury wynikowe

```rust
/// fem/result.rs

/// Result of a single FEM time step.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FemStepResult {
    pub step: usize,
    pub time: f64,
    pub energy_exchange: f64,
    pub energy_demag: f64,
    pub energy_zeeman: f64,
    pub avg_mx: f64,
    pub avg_my: f64,
    pub avg_mz: f64,
    pub max_torque: f64,
}

/// Complete result of FEM simulation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FemResult {
    pub steps: Vec<FemStepResult>,
    pub final_mx: Vec<f64>,
    pub final_my: Vec<f64>,
    pub final_mz: Vec<f64>,
    pub mesh_nodes: Vec<[f64; 3]>,
    pub mesh_elements: Vec<[u32; 4]>,
}
```

---

## 5. Zależności Rust (Cargo.toml edycje)

### `crates/fullmag-engine/Cargo.toml`

```toml
[dependencies]
# Existing dependencies...
nalgebra = "0.33"
nalgebra-sparse = { version = "0.10", features = ["serde-serialize"] }
serde = { version = "1", features = ["derive"] }
```

---

## 6. Testy S2

| Test | Opis | Kryterium |
|------|------|-----------|
| `test_mesh_topology_from_ir` | Budowa MeshTopology z prostego tetraedru (5 nodes, 2 tet) | node_volumes sumują się do total_volume |
| `test_stiffness_symmetry` | K powinno być symetryczne | $\|K - K^T\|_F < \epsilon$ |
| `test_stiffness_rowsum_zero` | Suma wierszy K = 0 (Neumann property) | $\|K \mathbf{1}\| < \epsilon$ |
| `test_exchange_uniform_m` | Exchange field = 0 dla jednolitej magnetyzacji | $\|H_{ex}\| < \epsilon$ |
| `test_exchange_energy_gradient_m` | Exchange energy > 0 dla m z gradientem | E_ex > 0 |
| `test_poisson_cg_laplacian` | CG converges for known Poisson solution | Residual < 1e-8 |
| `test_demag_thin_plate` | Czynnik demag N_z ≈ 1 dla cienkiej płyty | $\|N_z - 1\| < 0.15$ |
| `test_heun_energy_decrease` | Relaxation z dużym α: energy monotonically decreasing | energia maleje |
| `test_heun_norm_preservation` | $\|m_i\| ≈ 1$ po 1000 kroków | max defect < 1e-6 |
| `test_zeeman_alignment` | m aligns z H_ext after relaxation | $\langle m_z \rangle > 0.99$ |
| `test_cross_backend_box_exchange` | FEM vs FDM energia wymiany na Box | < 5% difference |

---

## 7. Kryteria akceptacji S2

| # | Kryterium |
|---|-----------|
| 1 | `execute_reference_fem()` działa end-to-end na Box |
| 2 | Exchange energy jest dodatnia i zbieżna |
| 3 | Demag field anty-równoległy do M dla cienkiej płyty |
| 4 | Relaxation z α=1 osiąga stan równowagi (max_torque < 1e-3) |
| 5 | FEM exchange energy na Box ≤ 5% FDM |
| 6 | Norma m zachowana do 1e-6 po 1000 kroków |
| 7 | CG solver zbieżny w < 1000 iteracji dla typowych meshów |

---

## 8. Ryzyka

| Ryzyko | Wpływ | Mitigacja |
|--------|-------|-----------|
| CG bez preconditionera wolny na dużych meshach | Slow S2 | Jacobi preconditioning proste do dodania |
| Air-box truncation daje złą demag | Wyniki niedokładne | Duży air_factor (3-5×), Robin BC w przyszłości |
| nalgebra-sparse nie ma row_mut | Blokuje apply_dirichlet | Build nowy CsrMatrix z zmodyfikowanymi danymi |
| Brak CSR diagonal access | Utrudnia BC | Osobna tablica diagonali |
