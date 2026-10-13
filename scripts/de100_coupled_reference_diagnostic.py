"""Exploratory coupled film reference; not FEM or solver qualification.

Neumann cosine Galerkin basis and the full Dirichlet magnetostatic Green
kernel. Hard-coded parameters match the approved DE 100 nm pilot.
The quadrature and mode-count sweeps are diagnostics, not acceptance gates.
Uses exp(-i*omega*time + i*k*y), conjugate to Fullmag. The +i cross
block and +i*sqrt(K)*J*sqrt(K) consistently use that convention.
Complex profiles require conjugation before a Fullmag comparison.
Independent shooting cross-check remains required.
"""
from dataclasses import dataclass
import numpy as np
from scipy.linalg import eigh
from numpy.polynomial.legendre import leggauss
import json
mu0=4*np.pi*1e-7
Ms=8e5
gamma=2.211e5
thickness=100e-9
h=20.5
field=.1/(mu0*Ms)
lex2=2*13e-12/(mu0*Ms**2*thickness**2)

CODE_CONVENTION = "exp(-iwt+iky)"
FULLMAG_CONVENTION = "exp(+iwt-iky)"
_FREQUENCY_SCALE_GHZ = gamma*Ms/(2*np.pi)/1e9


@dataclass(frozen=True)
class CoupledMode:
    """One positive lossless mode in the orthonormal thickness basis.

    ``my`` and ``mz`` are the L2-normalized coefficients of the transverse
    magnetization. ``transformed`` is ``sqrt(K) @ m``. The latter is kept so
    tests can verify the similarity transform used by the Hermitian solve.
    """

    omega: float
    my: np.ndarray
    mz: np.ndarray
    transformed: np.ndarray
    relative_residual: float

    @property
    def coefficients(self):
        return np.concatenate((self.my, self.mz))

    @property
    def frequency_ghz(self):
        return self.omega*_FREQUENCY_SCALE_GHZ


def _convention_factors(convention):
    """Return (cross-sign, LL time-sign) for a conjugate phasor pair."""

    if convention == CODE_CONVENTION:
        # exp(-i omega t + i k y), as used by this diagnostic.
        return 1.0, 1.0
    if convention == FULLMAG_CONVENTION:
        # exp(+i omega t - i k y), the canonical Fullmag phasor.
        return -1.0, -1.0
    raise ValueError(f"unknown phase convention: {convention!r}")


def _assert_hermitian(matrix, name, tolerance=2e-12):
    scale=max(1.0, float(np.max(np.abs(matrix))))
    error=float(np.max(np.abs(matrix-matrix.conj().T)))
    if not np.isfinite(error) or error > tolerance*scale:
        raise ValueError(f"{name} is not Hermitian: relative error {error/scale:g}")


def _assemble_stiffness(k, N, Q, *, convention=CODE_CONVENTION):
    """Assemble the dimensionless Hermitian magnetic stiffness matrix.

    The basis is orthonormal on x=z/thickness in [-1/2, 1/2]. The Green
    kernel is for -d2/dx2 + q2 on the finite Dirichlet airbox [-h, h].
    """

    cross_sign, _ = _convention_factors(convention)
    q=abs(k)*thickness
    x,w=leggauss(Q); x=x/2; w=w/2
    n=np.arange(N)
    basis=np.cos(np.pi*np.outer(x+.5,n))
    basis[:,1:]*=np.sqrt(2)
    wb=w[:,None]*basis
    lo=np.minimum(x[:,None],x[None,:])
    hi=np.maximum(x[:,None],x[None,:])
    if q==0:
        G=(lo+h)*(h-hi)/(2*h)
        cross=np.zeros((N,N),complex)
        zz=np.eye(N)-np.outer(wb.sum(axis=0),wb.sum(axis=0))/(2*h)
    else:
        den=np.sinh(2*q*h)
        G=np.sinh(q*(lo+h))*np.sinh(q*(h-hi))/(q*den)
        lower=-np.sinh(q*(x[:,None]+h))*np.cosh(q*(h-x[None,:]))/den
        upper=np.cosh(q*(x[None,:]+h))*np.sinh(q*(h-x[:,None]))/den
        deriv=np.where(x[:,None]<x[None,:],lower,upper)
        np.fill_diagonal(deriv,((lower+upper)/2).diagonal())
        cross=cross_sign*1j*(k*thickness)*(wb.T@deriv@wb)
        kernel=-q*np.cosh(q*(lo+h))*np.cosh(q*(h-hi))/den
        zz=np.eye(N)+wb.T@kernel@wb
    yy=q*q*(wb.T@G@wb)
    local=np.diag(field+lex2*(q*q+(n*np.pi)**2))
    K=np.block([[local+yy,cross],[cross.conj().T,local+zz]])
    _assert_hermitian(K, "stiffness matrix")
    return K


def _factor_stiffness(K):
    """Return eigenvalues, eigenvectors, sqrt(K), and inverse sqrt(K)."""

    vals,U=eigh(K)
    scale=max(1.0, float(np.max(np.abs(vals))))
    positivity_tolerance=2e-12*scale
    if not np.all(np.isfinite(vals)) or vals[0] <= positivity_tolerance:
        raise ValueError(f"stiffness is not positive definite: min={vals[0]:g}")
    root=(U*np.sqrt(vals))@U.conj().T
    inverse_root=(U*(1/np.sqrt(vals)))@U.conj().T
    _assert_hermitian(root, "sqrt(stiffness)")
    _assert_hermitian(inverse_root, "inverse sqrt(stiffness)")
    return vals,U,root,inverse_root


def _symplectic_matrix(N):
    I=np.eye(N); zero=np.zeros((N,N))
    return np.block([[zero,-I],[I,zero]])


def _relative_ll_residual(K, J, m, omega, time_sign):
    lhs=time_sign*1j*J@K@m
    rhs=omega*m
    denominator=max(float(np.linalg.norm(lhs)), float(np.linalg.norm(rhs)), np.finfo(float).tiny)
    return float(np.linalg.norm(lhs-rhs)/denominator)


def _positive_modes(k, N, Q, *, convention=CODE_CONVENTION):
    """Solve all positive lossless modes and return L2-normalized profiles."""

    K=_assemble_stiffness(k, N, Q, convention=convention)
    _,_,root,inverse_root=_factor_stiffness(K)
    _, time_sign=_convention_factors(convention)
    J=_symplectic_matrix(N)
    modal_operator=time_sign*1j*root@J@root
    _assert_hermitian(modal_operator, "Hermitian modal operator")
    eigenvalues,eigenvectors=eigh(modal_operator)
    positive=eigenvalues>1e-8
    negative=eigenvalues < -1e-8
    if int(np.count_nonzero(positive)) != N or int(np.count_nonzero(negative)) != N:
        raise ValueError(
            f"expected {N} positive and {N} negative roots, got "
            f"{np.count_nonzero(positive)} and {np.count_nonzero(negative)}"
        )
    modes=[]
    for index in np.flatnonzero(positive):
        omega=float(eigenvalues[index])
        transformed=eigenvectors[:,index]
        m=inverse_root@transformed
        m=m/np.linalg.norm(m)
        transformed_from_m=root@m
        residual=_relative_ll_residual(K,J,m,omega,time_sign)
        modes.append(CoupledMode(
            omega=omega,
            my=m[:N].copy(),
            mz=m[N:].copy(),
            transformed=transformed_from_m.copy(),
            relative_residual=residual,
        ))
    return modes


def spectrum(k,N,Q):
    """Preserve the original frequency-only diagnostic API."""

    return [mode.frequency_ghz for mode in _positive_modes(k, N, Q)]


def main():
    for Q in (160,320,640,1280):
        for N in (1,8,16,24):
            for k in (0,10e6,20e6,40e6):
                print(json.dumps({'diagnostic_only':True,'N':N,'quadrature':Q,'k':k,'GHz':spectrum(k,N,Q)[:6]}))


if __name__ == "__main__":
    main()
