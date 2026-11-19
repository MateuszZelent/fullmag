"""Bounded independent general-map direct2D research; never qualify antenna V/J/H."""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

from antenna_triangle_surface_oracle import (
    Arithmetic, Budget, ReferenceExactArithmetic, Refusal, dependency_provenance,
    dot, mathematical_corpus, positive_reference_panels, reference_radial_value,
    reference_scale, reference_test_identity, require,
)


@dataclass(frozen=True)
class AngularPiece:
    endpoint: Fraction
    sign: int
    length: Fraction
    slope: Fraction


@dataclass(frozen=True)
class PanelPlan:
    vertices: tuple
    p: tuple
    e1: tuple
    e2: tuple
    normal: tuple
    vertex: bool
    c0: Fraction
    c1: Fraction
    c2: Fraction
    v0: Fraction
    cmin: Fraction
    epsilon2: Fraction
    angular_mode: str
    zero_minimum: bool
    pieces: tuple
    certified_midpoint: bool


@dataclass(frozen=True)
class CasePlan:
    identity: str
    panels: tuple
    projected: bool
    scale: Fraction


class MapExactArithmetic(ReferenceExactArithmetic):
    """Map counters are subsets of the same bounded exact-reference work."""
    def binary(self, kind, a, b):
        self.budget.charge("map_exact_operations", "reference-exact")
        return super().binary(kind, a, b)

    def compare(self, a, b, kind, site):
        self.budget.charge("map_exact_predicates", "reference-exact")
        return super().compare(a, b, kind, site)


def prepare_case(vertices, target, budget):
    """Prepare exact routing once; retain original positive-panel order."""
    identity=reference_test_identity(vertices,target)
    budget.activate(identity)
    panels,r,projected=positive_reference_panels(vertices,target,budget)
    scale=reference_scale(vertices,target,budget)
    exact=MapExactArithmetic(budget);plans=[]
    for panel in panels:
        panel=tuple(panel);a,b,c=panel
        e1=exact.vector_sub(b,a);e2=exact.vector_sub(c,a)
        p=exact.vector_sub(r,a);normal=exact.cross(e1,e2)
        vertex=all(exact.compare(x,0,"eq","map_vertex") for x in p)
        if vertex:
            plans.append(PanelPlan(panel,p,e1,e2,normal,True,
                Fraction(0),Fraction(0),Fraction(0),Fraction(0),Fraction(0),Fraction(0),"vertex",True,(),False))
            continue
        pe=exact.cross(p,e1);difference=exact.vector_sub(e2,e1)
        pd=exact.cross(p,difference)
        c0=exact.dot(pe,pe);c1=exact.binary("mul",2,exact.dot(pe,pd));c2=exact.dot(pd,pd)
        curved=exact.compare(c2,0,"gt","map_curvature")
        if curved:
            star=exact.binary("div",exact.binary("sub",0,c1),exact.binary("mul",2,c2))
            if exact.compare(star,0,"ge","map_minimum_left"):
                v0=star if exact.compare(1,star,"ge","map_minimum_right") else Fraction(1)
            else: v0=Fraction(0)
            cmin=exact.binary("add",c0,exact.binary("mul",v0,
                exact.binary("add",c1,exact.binary("mul",c2,v0))))
            require(exact.compare(cmin,0,"ge","map_minimum_nonnegative"),"map negative exact minimum")
        else:
            require(exact.compare(c2,0,"eq","map_constant_curvature"),"map negative exact curvature")
            require(exact.compare(c0,0,"gt","map_constant_positive"),"map nonvertex constant zero C")
            v0=Fraction(0);cmin=c0
        zero=exact.compare(cmin,0,"eq","map_zero_minimum")
        if zero:
            ray=tuple(exact.binary("add",x,exact.binary("mul",v0,d)) for x,d in zip(e1,difference))
            A=exact.dot(ray,ray);B=exact.dot(p,ray)
            require(exact.compare(0,B,"gt","map_root_before") or
                    exact.compare(B,A,"gt","map_root_after"),"map singular exact radial segment")
        epsilon2=exact.binary("div",cmin,c2) if curved and not zero else Fraction(0)
        angular_mode="graded" if curved and not zero else "linear" if curved else "identity"
        midpoint=zero and exact.compare(v0,Fraction(1,2),"eq","map_midpoint")
        pieces=[]
        derivative=exact.binary("add",c1,exact.binary("mul",exact.binary("mul",2,c2),v0))
        for endpoint,sign in ((Fraction(0),-1),(Fraction(1),1)):
            length=exact.binary("mul",sign,exact.binary("sub",endpoint,v0))
            if exact.compare(length,0,"gt","map_positive_span"):
                slope=exact.binary("mul",sign,derivative)
                require(exact.compare(slope,0,"ge","map_outward_slope"),"map negative outward slope")
                pieces.append(AngularPiece(endpoint,sign,length,slope))
                budget.charge("map_angular_pieces","reference-exact")
        plans.append(PanelPlan(panel,p,e1,e2,normal,False,c0,c1,c2,v0,cmin,epsilon2,angular_mode,zero,
            tuple(pieces),midpoint))
    budget.guard()
    return CasePlan(identity,tuple(plans),projected,scale)


class MapArithmetic(Arithmetic):
    def __init__(self,digits,budget): super().__init__(digits,budget,reference=True)

    def call(self,name,*args):
        self.budget.charge("map_transcendental_calls",self.precision)
        self.budget.charge("map_transcendental_"+name,self.precision)
        return super().call(name,*args)

    def test(self,condition,reason):
        self.budget.charge("map_dynamic_checks",self.precision)
        if not condition:
            self.budget.charge("map_roundoff_refusals",self.precision)
            raise Refusal(reason)

    def finite(self,value):
        self.test(self.ctx.isfinite(value),"map nonfinite intermediate")
        return value

    def positive_asinh(self,value):
        self.test(value>=0,"map negative positive-asinh argument")
        return self.call("log1p",value+self.divide(value*value,1+self.call("sqrt",1+value*value)))


def angular_point(arithmetic,panel,piece,z):
    """Positive angular Jacobian; C is evaluated without subtractive cancellation."""
    a=arithmetic;ctx=a.ctx
    a.test(ctx.isfinite(z) and 0<=z<=1,"map angular parameter outside unit interval")
    length=a.number(piece.length);v0=a.number(panel.v0)
    if panel.angular_mode=="graded":
        epsilon=a.call("sqrt",a.number(panel.epsilon2))
        a.test(epsilon>0,"map positive angular scale rounded to zero")
        K=a.positive_asinh(a.divide(length,epsilon))
        offset=epsilon*a.call("sinh",K*z)
        jac=epsilon*K*a.call("cosh",K*z)
    else:
        offset=length*z;jac=length
    # The exactly known endpoints are not a clamp of an approximate interior point.
    if z==0: v=v0;offset=ctx.mpf(0)
    elif z==1: v=a.number(piece.endpoint);offset=length
    else: v=v0+piece.sign*offset
    a.test(z in (0,1) or (0<offset<length and v!=v0 and v!=a.number(piece.endpoint)),
           "map unresolved interior angular monotonicity")
    a.test(ctx.isfinite(v) and 0<=v<=1 and ctx.isfinite(jac) and jac>0,
           "map unresolved angular range or Jacobian")
    C=a.number(panel.cmin)+a.number(piece.slope)*offset+a.number(panel.c2)*offset*offset
    certified_zero=panel.zero_minimum and z==0
    a.test(C>0 or certified_zero,"map unproven rounded zero C")
    return v,jac,C,certified_zero


def radial_parameters(arithmetic,panel,v,C,certified_zero):
    """Stable span and positive terms, local to one outer callback."""
    a=arithmetic;ctx=a.ctx
    p=tuple(a.number(x) for x in panel.p)
    ray=tuple((1-v)*a.number(x)+v*a.number(y) for x,y in zip(panel.e1,panel.e2))
    A=dot(ray,ray);a.test(A>0,"map nonpositive radial norm")
    s=a.call("sqrt",A);B=dot(p,ray);beta=a.divide(B,s)
    R0=a.call("sqrt",dot(p,p));displacement=tuple(x-y for x,y in zip(p,ray))
    R1=a.call("sqrt",dot(displacement,displacement))
    a.test(R0>0 and R1>0,"map unresolved nonvertex endpoint norm")
    if certified_zero:
        a.test(C==0,"map exact zero certificate mismatch")
        if beta<0:
            L=a.call("log1p",a.divide(s,-beta));mode="zero_before"
        elif beta>s:
            L=a.call("log1p",a.divide(s,beta-s));mode="zero_after"
        else: raise Refusal("map singular radial segment")
        Dplus=Dminus=None
    else:
        a.test(C>0,"map uncertified zero transverse norm")
        delta2=a.divide(C,A);delta=a.call("sqrt",delta2)
        a.test(delta>0,"map positive radial scale rounded to zero")
        t0=-beta;t1=s-beta
        if t0>=0 or t1<=0:
            left=-beta if t0>=0 else beta-s
            right=s-beta if t0>=0 else beta
            Ra=R0 if t0>=0 else R1;Rb=R1 if t0>=0 else R0
            L=a.call("log1p",a.divide(s*(1+a.divide(left+right,Ra+Rb)),left+Ra))
        else:
            L=a.positive_asinh(a.divide(beta,delta))+a.positive_asinh(a.divide(s-beta,delta))
        large=R0+abs(t0);small=a.divide(delta2,large)
        Dplus,Dminus=(large,small) if t0>=0 else (small,large)
        mode="positive"
    a.test(ctx.isfinite(L) and L>0,"map nonpositive radial span")
    return s,beta,L,Dplus,Dminus,mode


def mapped_sample(arithmetic,panel,piece,w,z):
    """Pointwise mapped kernel and both Jacobians; no integrated radial formula."""
    v,jv,C,zero=angular_point(arithmetic,panel,piece,z)
    parameters=radial_parameters(arithmetic,panel,v,C,zero)
    return mapped_radial_sample(arithmetic,panel,w,v,jv,parameters)


def mapped_radial_sample(a,panel,w,v,jv,parameters):
    ctx=a.ctx;s,beta,L,Dplus,Dminus,mode=parameters
    a.test(ctx.isfinite(w) and 0<=w<=1,"map radial parameter outside unit interval")
    x=L*w/2
    if mode!="positive":a.budget.charge("map_limit_evaluations",a.precision)
    if mode=="positive":
        ex=a.call("exp",x);em=a.call("exp",-x);sh=a.call("sinh",x)
        u=a.divide((Dplus*ex+Dminus*em)*sh,s)
        ju=a.divide(L*(Dplus*ex*ex+Dminus*em*em),2*s)
    elif mode=="zero_before":
        u=a.divide(-beta*2*a.call("exp",x)*a.call("sinh",x),s)
        ju=a.divide(-beta*L*a.call("exp",2*x),s)
    else:
        u=a.divide(beta*2*a.call("exp",-x)*a.call("sinh",x),s)
        ju=a.divide(beta*L*a.call("exp",-2*x),s)
    if w==0: u=ctx.mpf(0)
    elif w==1: u=ctx.mpf(1)
    a.test(w in (0,1) or 0<u<1,"map unresolved interior radial monotonicity")
    a.test(ctx.isfinite(u) and 0<=u<=1 and ctx.isfinite(ju) and ju>0,
           "map unresolved radial range or Jacobian")
    J=a.call("sqrt",sum(a.number(x)**2 for x in panel.normal))
    value=a.finite(a.divide(J*L*u*jv,s))
    a.test(value>=0,"map negative mapped kernel")
    return value,u,v,ju,jv


def _quadrature(arithmetic,function,degree,method):
    arithmetic.budget.guard()
    result=arithmetic.ctx.quad(function,[0,1],method=method,maxdegree=degree,error=True)
    arithmetic.budget.guard()
    return result


def direct_pass(plan,digits,degree,budget,arithmetic):
    ctx=arithmetic.ctx;values=[];errors=[];inner_errors=[];modes=[]
    for panel in plan.panels:
        J=arithmetic.call("sqrt",sum(arithmetic.number(x)**2 for x in panel.normal))
        if panel.vertex:
            def vertex(v):
                budget.charge("direct2d_evals",digits)
                budget.charge("map_limit_evaluations",digits)
                budget.charge("reference_evals",f"direct2d/{digits}")
                ray=tuple((1-v)*arithmetic.number(x)+v*arithmetic.number(y) for x,y in zip(panel.e1,panel.e2))
                return arithmetic.divide(J,arithmetic.call("sqrt",dot(ray,ray)))
            value,error=_quadrature(arithmetic,vertex,degree,"gauss-legendre")
            values.append(value);errors.append(error);inner_errors.append(ctx.mpf(0));modes.append("exact_vertex_1d")
            continue
        piece_values=[];piece_errors=[];max_inner=ctx.mpf(0)
        for piece in panel.pieces:
            def outer(z):
                nonlocal max_inner
                budget.charge("map_outer_evaluations",digits);budget.guard()
                v,jv,C,zero=angular_point(arithmetic,panel,piece,z)
                parameters=radial_parameters(arithmetic,panel,v,C,zero)
                def inner(w):
                    budget.charge("direct2d_evals",digits)
                    budget.charge("map_radial_evaluations",digits)
                    budget.charge("reference_evals",f"direct2d/{digits}")
                    return mapped_radial_sample(arithmetic,panel,w,v,jv,parameters)[0]
                value,error=_quadrature(arithmetic,inner,degree,"gauss-legendre")
                max_inner=max(max_inner,error)
                return value
            value,error=_quadrature(arithmetic,outer,degree,"gauss-legendre")
            piece_values.append(value);piece_errors.append(error)
        values.append(ctx.fsum(piece_values));errors.append(ctx.fsum(piece_errors));inner_errors.append(max_inner)
        modes.append("general_map_direct2d")
    return _pass_record(ctx,digits,degree,"GENERAL_MAP_DIRECT2D_GL",values,
        angular_error_estimates_diagnostic=[ctx.nstr(x,digits+5) for x in errors],
        inner_error_max_diagnostic=[ctx.nstr(x,digits+5) for x in inner_errors],radial_integration=modes)


def radial_pass(plan,digits,degree,budget,arithmetic):
    ctx=arithmetic.ctx;values=[];errors=[];modes=[]
    for panel in plan.panels:
        J=arithmetic.call("sqrt",sum(arithmetic.number(x)**2 for x in panel.normal))
        p=tuple(arithmetic.number(x) for x in panel.p)
        f1=tuple(arithmetic.number(x) for x in panel.e1);f2=tuple(arithmetic.number(x) for x in panel.e2)
        def angular(v):
            value,mode,_=reference_radial_value(arithmetic,p,f1,f2,v,panel.vertex,
                plan.projected,panel.certified_midpoint)
            return J*value
        value,error=_quadrature(arithmetic,angular,degree,"tanh-sinh")
        values.append(value);errors.append(error)
        modes.append("exact_vertex" if panel.vertex else "exact_projected" if plan.projected else "general_radial_primitive")
    return _pass_record(ctx,digits,degree,"GENERAL_RADIAL_1D_TS",values,
        angular_error_estimates_diagnostic=[ctx.nstr(x,digits+5) for x in errors],radial_integration=modes)


def _pass_record(ctx,digits,degree,method,values,**extra):
    require(all(ctx.isfinite(x) and x>0 for x in values),"reference nonpositive or nonfinite panel integral")
    return {"digits":digits,"maxdegree":degree,"reference_method":method,
        "panels_m":[ctx.nstr(x,digits+5) for x in values],
        "value_m":ctx.nstr(ctx.fsum(values),digits+5),**extra}


def check_gates(plan,direct,radial,ctx):
    scale=ctx.mpf(plan.scale.numerator)/plan.scale.denominator
    comparisons=[];gates={}
    for name,passes in (("direct",direct),("radial",radial)):
        gate=ctx.mpf("1e-30")*(scale+abs(ctx.mpf(passes[-1]["value_m"])))
        gates[name]=ctx.nstr(gate,205)
        for left,right in ((1,2),(4,5),(2,5)):
            total=abs(ctx.mpf(passes[left]["value_m"])-ctx.mpf(passes[right]["value_m"]))
            local=ctx.fsum(abs(ctx.mpf(x)-ctx.mpf(y)) for x,y in zip(passes[left]["panels_m"],passes[right]["panels_m"]))
            require(total<=gate and local<=gate,name+" total/local convergence refused")
            comparisons.append({"method":name,"passes":[left,right],"total_delta_m":ctx.nstr(total,205),"local_delta_m":ctx.nstr(local,205)})
    a,b=direct[-1],radial[-1];gate=ctx.mpf(gates["direct"])
    total=abs(ctx.mpf(a["value_m"])-ctx.mpf(b["value_m"]))
    local=ctx.fsum(abs(ctx.mpf(x)-ctx.mpf(y)) for x,y in zip(a["panels_m"],b["panels_m"]))
    require(total<=gate and local<=gate,"direct/radial total/local convergence refused")
    comparisons.append({"method":"cross","pass":5,"total_delta_m":ctx.nstr(total,205),"local_delta_m":ctx.nstr(local,205)})
    return {"gate_m":gates["direct"],"method_gates_m":gates,"comparisons":comparisons}


def reference_pair(vertices,target,budget=None,completed=None):
    """Six GL and six TS passes, 12 fresh contexts, one immutable exact plan."""
    budget=budget or Budget();plan=prepare_case(vertices,target,budget)
    dependency=dependency_provenance();direct=[];radial=[];gates=None
    for method,records in (("direct",direct),("radial",radial)):
        for digits in (160,200):
            for degree in (8,10,12):
                arithmetic=MapArithmetic(digits,budget) if method=="direct" else Arithmetic(digits,budget,reference=True)
                failure=None
                try:
                    record=(direct_pass if method=="direct" else radial_pass)(plan,digits,degree,budget,arithmetic)
                    records.append(record)
                    if completed is not None: completed(method,record)
                    if method=="radial" and digits==200 and degree==12:
                        gates=check_gates(plan,direct,radial,arithmetic.ctx)
                except BaseException as error:
                    failure=error
                    raise
                finally:
                    try:
                        arithmetic.close_reference()
                        budget.guard()
                    except BaseException as cleanup_error:
                        if failure is not None:
                            raise Refusal(f"{failure}; cleanup admission also failed: {cleanup_error}") from failure
                        raise
    return {"status":"SCALAR REFERENCE CONVERGENCE ONLY","qualification":"NOT VERIFIED",
        "identity":plan.identity,"dependency":dependency,"direct_passes":direct,"radial_passes":radial,
        "gates":gates,"value_m":direct[-1]["value_m"],"original_panel_count":len(plan.panels),
        "independent_native_RT0_V_J_H":False}


def frozen_cases24():
    """The preregistered order; no filtering by a numerical outcome."""
    cases=mathematical_corpus()
    return tuple(c for c in cases if c["id"].endswith("/base") or
        c["id"] in {f"M{i:02}/{transform}" for transform in ("shear","rotate90") for i in (8,10,16)})
