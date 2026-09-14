"""Exploratory coupled film reference; not FEM or solver qualification.

Neumann cosine Galerkin basis and the full Dirichlet magnetostatic Green
kernel. Hard-coded parameters match the approved DE 100 nm pilot.
The quadrature and mode-count sweeps are diagnostics, not acceptance gates.
Uses exp(-i*omega*time + i*k*y), conjugate to Fullmag. The +i cross
block and +i*sqrt(K)*J*sqrt(K) consistently use that convention.
Complex profiles require conjugation before a Fullmag comparison.
Independent shooting cross-check and modal residuals remain required.
"""
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
def spectrum(k,N,Q):
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
        cross=1j*(k*thickness)*(wb.T@deriv@wb)
        kernel=-q*np.cosh(q*(lo+h))*np.cosh(q*(h-hi))/den
        zz=np.eye(N)+wb.T@kernel@wb
    yy=q*q*(wb.T@G@wb)
    local=np.diag(field+lex2*(q*q+(n*np.pi)**2))
    K=np.block([[local+yy,cross],[cross.conj().T,local+zz]])
    vals,U=eigh(K)
    if vals.min()<=0: raise ValueError('nonpositive stiffness')
    root=(U*np.sqrt(vals))@U.conj().T
    I=np.eye(N); zero=np.zeros((N,N))
    J=np.block([[zero,-I],[I,zero]])
    omega=eigh(1j*root@J@root,eigvals_only=True)
    return (omega[omega>1e-8]*gamma*Ms/(2*np.pi)/1e9).tolist()
for Q in (160,320,640,1280):
    for N in (1,8,16,24):
        for k in (0,10e6,20e6,40e6):
            print(json.dumps({'diagnostic_only':True,'N':N,'quadrature':Q,'k':k,'GHz':spectrum(k,N,Q)[:6]}))
