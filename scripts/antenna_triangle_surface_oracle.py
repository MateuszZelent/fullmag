"""Independent scalar triangle potential research; never solve or qualify antenna V/J/H."""
from __future__ import annotations

import argparse
import gc
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import struct
import time

PRECISIONS = ("binary64", 80, 120)
LIMITS = {"pairs_target": 100000, "pairs_case": 5000000,
          "transc_target": 2000000, "transc_case": 100000000,
          "predicates_target": 500000, "predicates_case": 20000000,
          "reference_test": 10000000, "reference_case": 100000000,
          "reference_comparisons_test":174,"reference_comparisons_case":9396,
          "seconds_target": 3600, "seconds_case": 28800, "ram_bytes": 2147483648}
PREREG_SHA = "99542b067f51776d3994781bc77c36d2d94cf5be39bcca4f6b3296e90619fd3b"
WHEEL_SHA = "a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c"
REFERENCE_COMPARISON_PREREG_SHA = "27780e798891c31a9f7f9f6dac29f9c5cc1f3fb82f7d38ba596535375ad6e328"
IDENTITY_PREREG_SHA = "c229d09c9307975fae190e6a09107fb6f79f9c1ddd340f80e08a89675e0774f0"
GENERAL_RADIAL_PREREG_SHA = "b85ac657bac1ff765ee83ac9168e9403891e2f46993dae31b0197b4ef65439a4"
VERTEX_LIFECYCLE_PREREG_SHA = "acafaa0cb2a736393f11216f6d06fb2ceae5c00d3d7cc167fd832aeb0d89e278"
ADDENDUM_SHA = "a5be5fa1e1e42b26502b3a9dcf1197b38a9adba859504adaf14ca6f82be09af8"


class Refusal(ValueError):
    """A mathematical, geometric or bounded-work refusal, never a false zero."""


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def dependency_provenance():
    import mpmath
    require(mpmath.__version__=="1.3.0", "unregistered mpmath version")
    require(".whl" in mpmath.__file__, "wheel provenance required; global installation unregistered")
    wheel=Path(mpmath.__file__.split(".whl")[0]+".whl")
    digest=hashlib.sha256(wheel.read_bytes()).hexdigest()
    require(digest==WHEEL_SHA, "mpmath wheel pin mismatch")
    return {"version":mpmath.__version__,"import_path":mpmath.__file__,"wheel_sha256":digest}


def sub(a, b):
    return tuple(x-y for x,y in zip(a,b))


def dot(a, b):
    return sum(x*y for x,y in zip(a,b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def rational_points(points):
    result=[]
    for point in points:
        require(len(point)==3, "three coordinates required")
        values=tuple(float(x) for x in point)
        require(all(math.isfinite(x) for x in values), "nonfinite binary64 input")
        result.append(tuple(Fraction.from_float(x) for x in values))
    return tuple(result)


# Keep one Windows ABI type/function identity; dynamic ctypes pointer types are cached.
import os
if os.name=="nt":
    import ctypes
    from ctypes import wintypes
    class _MemoryCounters(ctypes.Structure):
        _fields_=[("cb",wintypes.DWORD),("PageFaultCount",wintypes.DWORD),
                  *[(name,ctypes.c_size_t) for name in ("PeakWorkingSetSize","WorkingSetSize",
                    "QuotaPeakPagedPoolUsage","QuotaPagedPoolUsage","QuotaPeakNonPagedPoolUsage",
                    "QuotaNonPagedPoolUsage","PagefileUsage","PeakPagefileUsage")]]
    _memory_kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    _memory_psapi=ctypes.WinDLL("psapi",use_last_error=True)
    _get_current_process=_memory_kernel.GetCurrentProcess
    _get_current_process.argtypes=[]
    _get_current_process.restype=wintypes.HANDLE
    _get_process_memory_info=_memory_psapi.GetProcessMemoryInfo
    _get_process_memory_info.argtypes=[wintypes.HANDLE,ctypes.POINTER(_MemoryCounters),wintypes.DWORD]
    _get_process_memory_info.restype=wintypes.BOOL


def peak_ram_bytes():
    """Current single-process lifetime peak; this helper spawns no children."""
    if os.name=="nt":
        counters=_MemoryCounters();counters.cb=ctypes.sizeof(counters)
        require(_get_process_memory_info(_get_current_process(),ctypes.byref(counters),counters.cb),
                "peak RAM measurement unavailable")
        return int(max(counters.PeakWorkingSetSize,counters.PeakPagefileUsage))
    import resource
    import sys
    peak=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform=="darwin" else peak*1024)


@dataclass
class Budget:
    counts: Counter = field(default_factory=Counter)
    by_target: dict = field(default_factory=lambda:defaultdict(Counter))
    precision: dict = field(default_factory=lambda:defaultdict(Counter))
    started: float = field(default_factory=time.monotonic)
    target_started: dict = field(default_factory=dict)
    target: str = "unset"
    max_fraction_bits: int = 0
    peak_ram: int = 0
    soft_reference_evals: int | None = None
    reference_raw_max_bits: int = 0

    def activate(self, target):
        self.target=target
        self.target_started.setdefault(target,time.monotonic())
        self.guard()

    def guard(self):
        elapsed=time.monotonic()-self.started
        require(elapsed<=LIMITS["seconds_case"], "case wall-time exhausted")
        if self.target in self.target_started:
            require(time.monotonic()-self.target_started[self.target]<=LIMITS["seconds_target"],
                    "target wall-time exhausted")
        self.peak_ram=max(self.peak_ram,peak_ram_bytes())
        require(self.peak_ram<=LIMITS["ram_bytes"], "actual peak RAM exhausted")

    def charge(self, kind, precision=None):
        self.counts[kind]+=1;self.by_target[self.target][kind]+=1
        if precision is not None: self.precision[str(precision)][kind]+=1
        target=self.by_target[self.target]
        if kind=="pairs":
            require(target[kind]<=LIMITS["pairs_target"] and self.counts[kind]<=LIMITS["pairs_case"], "analytic pair limit")
        if kind in ("sqrt","log","log1p","atan2"):
            total=sum(self.counts[k] for k in ("sqrt","log","log1p","atan2"))
            local=sum(target[k] for k in ("sqrt","log","log1p","atan2"))
            require(local<=LIMITS["transc_target"] and total<=LIMITS["transc_case"], "transcendental call limit")
        if kind=="exact_predicates":
            require(target[kind]<=LIMITS["predicates_target"] and self.counts[kind]<=LIMITS["predicates_case"], "exact predicate limit")
        if kind.startswith("reference_comparison_"):
            self.counts["reference_comparisons"]+=1;target["reference_comparisons"]+=1
            if precision is not None: self.precision[str(precision)]["reference_comparisons"]+=1
        if kind=="reference_comparisons" or kind.startswith("reference_comparison_"):
            require(self.counts["reference_comparisons"]<=LIMITS["reference_comparisons_case"], "case reference comparison limit")
            require(target["reference_comparisons"]<=LIMITS["reference_comparisons_test"], "target reference comparison limit")
        if kind=="reference_evals":
            require(self.counts[kind]<=LIMITS["reference_case"], "case reference evaluation limit")
            require(target[kind]<=LIMITS["reference_test"], "target reference evaluation limit")
            if self.soft_reference_evals is not None:
                require(self.counts[kind]<=self.soft_reference_evals, "INCOMPLETE: soft execution allocation exhausted")
        if sum(self.counts.values())%256==0: self.guard()

    def watch(self, values):
        for value in values:
            bits=max(value.numerator.bit_length(),value.denominator.bit_length())
            self.max_fraction_bits=max(self.max_fraction_bits,bits)
            require(bits<=8192, "exact rational bit-length limit")

    def report(self):
        # A terminal refusal must remain serializable; never re-run admission here.
        return {"counts":dict(self.counts),"by_target":{k:dict(v) for k,v in self.by_target.items()},
                "by_precision":{k:dict(v) for k,v in self.precision.items()},
                "max_fraction_bits":self.max_fraction_bits,"reference_raw_max_bits":self.reference_raw_max_bits,"elapsed_seconds":time.monotonic()-self.started,
                "peak_ram_bytes":self.peak_ram,"peak_ram_scope":"single process lifetime peak last measured by guard; no child processes",
                "terminal_snapshot_rechecks_admission":False,
                "primitive_arithmetic_status":"division calls instrumented; other scalar additions/multiplications NOT exhaustively counted",
                "library_internal_counter_scope":"isolated reference ctx sqrt/log/log1p/atan2/exp/sinh/cosh/tanh entry calls; internal libmp arithmetic NOT exhaustively counted",
                "limits":LIMITS}


class Arithmetic:
    def __init__(self, precision, budget, reference=False):
        self.precision=precision;self.budget=budget;self.reference=reference
        self._original_functions={}
        if precision=="binary64": self.ctx=None
        else:
            import mpmath
            require(mpmath.__version__=="1.3.0", "mpmath version differs from frozen pin")
            self.ctx=mpmath.mp.clone();self.ctx.dps=precision
            if reference:
                # Isolated-context wrappers also count quadrature node/error helper calls.
                for name in ("sqrt","log","log1p","atan2","exp","sinh","cosh","tanh"):
                    original=getattr(self.ctx,name)
                    self._original_functions[name]=original
                    def counted(*args,_name=name,_original=original,**kwargs):
                        budget.charge("reference_"+_name,"reference"+str(precision))
                        return _original(*args,**kwargs)
                    setattr(self.ctx,name,counted)

    def close_reference(self):
        # Dispose only this fresh context; never reset the shared Budget or peak.
        if self.reference and self.ctx is not None:
            self.ctx._tanh_sinh.clear();self.ctx._gauss_legendre.clear()
            for name,original in self._original_functions.items(): setattr(self.ctx,name,original)
            self._original_functions.clear();self.ctx=None
            gc.collect()

    def number(self, x):
        if isinstance(x,Fraction):
            if self.ctx is None: return float(x)
            return self.ctx.mpf(x.numerator)/self.ctx.mpf(x.denominator)
        return float(x) if self.ctx is None else self.ctx.mpf(x)

    def call(self, name, *args):
        if not self.reference: self.budget.charge(name,self.precision)
        function=getattr(math if self.ctx is None else self.ctx,name)
        value=function(*args)
        if self.reference: self.budget.charge("reference_dynamic_finite","reference-angular")
        require(math.isfinite(value) if self.ctx is None else self.ctx.isfinite(value), "nonfinite "+name)
        return value

    def divide(self, a, b):
        self.budget.charge("reference_divisions" if self.reference else "divisions",self.precision)
        if self.reference: self.budget.charge("reference_dynamic_division_nonzero","reference-angular")
        require(b!=0, "zero denominator")
        value=a/b
        if self.reference: self.budget.charge("reference_dynamic_finite","reference-angular")
        require(math.isfinite(value) if self.ctx is None else self.ctx.isfinite(value), "nonfinite division")
        return value

    def sum(self, values):
        return math.fsum(values) if self.ctx is None else self.ctx.fsum(values)

    def text(self, value):
        return repr(float(value)) if self.ctx is None else self.ctx.nstr(value,self.precision+5)


def prepare_geometry(vertices, target, budget):
    require(len(vertices)==3, "three physical vertices required")
    v=rational_points(vertices);r=rational_points([target])[0]
    for p in (*v,r): budget.watch(p)
    edges=[sub(v[(i+1)%3],v[i]) for i in range(3)]
    N=cross(sub(v[1],v[0]),sub(v[2],v[0]));NN=dot(N,N)
    budget.charge("exact_predicates");require(NN>0, "zero original physical face area")
    for edge in edges:
        budget.charge("exact_predicates");require(dot(edge,edge)>0, "zero original physical edge")
    hnum=dot(N,sub(r,v[0]));budget.charge("exact_predicates")
    dnums=[dot(sub(v[i],r),cross(edges[i],N)) for i in range(3)]
    for _ in dnums: budget.charge("exact_predicates")
    q=tuple(r[k]-N[k]*hnum/NN for k in range(3))
    relative=[sub(x,r) for x in v]
    maximum=max(abs(x) for p in (*relative,*edges) for x in p)
    exponent=maximum.numerator.bit_length()-maximum.denominator.bit_length()
    if maximum<Fraction(2)**exponent: exponent-=1
    exponent=max(-1074,min(1023,exponent))
    scale=Fraction(2)**exponent
    budget.watch((*N,NN,hnum,*dnums,*q,scale))
    return {"v":v,"r":r,"q":q,"N":N,"hnum":hnum,"dnums":dnums,"edges":edges,"scale":scale}


def solid_angle(vectors, radii, numerator, arithmetic):
    w0,w1,w2=vectors;R0,R1,R2=radii
    denominator=R0*R1*R2+R0*dot(w1,w2)+R1*dot(w2,w0)+R2*dot(w0,w1)
    require(numerator!=0, "nonzero exact height rounded to zero solid-angle numerator")
    return 2*arithmetic.call("atan2",numerator,denominator)


def analytic_pass(geometry, precision, budget):
    arithmetic=Arithmetic(precision,budget);budget.charge("pairs",precision)
    g=geometry;s=g["scale"]
    vectors=[tuple(arithmetic.number(-x/s) for x in sub(v,g["r"])) for v in g["v"]]
    edges=[tuple(arithmetic.number(x/s) for x in e) for e in g["edges"]]
    N=tuple(arithmetic.number(x/s**2) for x in g["N"])
    normN=arithmetic.call("sqrt",dot(N,N));require(normN>0,"face normal range")
    lengths=[arithmetic.call("sqrt",dot(e,e)) for e in edges]
    require(all(x>0 for x in lengths), "physical edge range")
    h=arithmetic.divide(arithmetic.number(g["hnum"]/s**3),normN)
    require(g["hnum"]==0 or h!=0, "exact nonzero h underflow")
    radii=[arithmetic.call("sqrt",dot(w,w)) for w in vectors]
    require(all(R>0 or g["r"]==g["v"][i] for i,R in enumerate(radii)),"exact nonzero vertex radius underflow")
    d=[arithmetic.divide(arithmetic.number(x/s**4),L*normN) for x,L in zip(g["dnums"],lengths)]
    qvector=tuple(arithmetic.number(x/s) for x in sub(g["r"],g["q"]))
    fans=[];logs=[];omegas=[]
    for i in range(3):
        j=(i+1)%3
        # Exact d numerator is also the fan-area predicate: never use rounded q.
        if g["dnums"][i]==0:
            fans.append(arithmetic.number(0));logs.append(arithmetic.number(0));omegas.append(arithmetic.number(0));continue
        require(d[i]!=0, "exact nonzero d underflow")
        xi=-dot(vectors[i],edges[i])/lengths[i]
        xj=xi+lengths[i]
        rho2=h*h+d[i]*d[i];require(rho2>0,"nonzero exact rho squared underflow")
        left=arithmetic.divide(rho2,radii[i]-xi) if xi<0 else radii[i]+xi
        right=arithmetic.divide(rho2,radii[j]+xj) if xj>0 else radii[j]-xj
        D=left+right;require(D>0,"stable edge denominator range")
        try:
            ratio=arithmetic.divide(2*lengths[i],D)
            log=arithmetic.call("log1p",ratio)
        except (Refusal,OverflowError):
            if precision!=120: raise
            log=arithmetic.call("log",D+2*lengths[i])-arithmetic.call("log",D)
        logs.append(log)
        if g["hnum"]==0: omega=arithmetic.number(0)
        else:
            numerator=arithmetic.number(dot(sub(g["r"],g["q"]),cross(sub(g["r"],g["v"][i]),sub(g["r"],g["v"][j])))/s**3)
            omega=solid_angle((qvector,vectors[i],vectors[j]),(abs(h),radii[i],radii[j]),numerator,arithmetic)
        omegas.append(omega);fans.append(d[i]*log-h*omega)
    if g["hnum"]==0: whole_omega=arithmetic.number(0)
    else:
        numerator=arithmetic.number(dot(sub(g["r"],g["v"][0]),cross(sub(g["r"],g["v"][1]),sub(g["r"],g["v"][2])))/s**3)
        whole_omega=solid_angle(vectors,radii,numerator,arithmetic)
    fan=arithmetic.sum(fans);whole=arithmetic.sum([d[i]*logs[i] for i in range(3)])-h*whole_omega
    require(fan>0 and whole>0,"nonpositive physical potential; cancellation/range refusal")
    signed_sum=arithmetic.sum(omegas)
    angular_delta=abs(signed_sum-whole_omega)
    physical_scale=arithmetic.number(s)
    value=fan*physical_scale
    if precision=="binary64":
        require(math.isfinite(value) and value>0,"binary64 potential range")
        require(abs(h*angular_delta)*physical_scale<=4096*math.ulp(1.)*(physical_scale+abs(value)),"weighted binary64 angle mismatch")
    else:
        require(angular_delta<=arithmetic.number("1e-55" if precision==120 else "1e-45")*(1+abs(whole_omega)),"highprecision angle mismatch")
    return {"precision":precision,"value_m":arithmetic.text(value),"whole_m":arithmetic.text(whole*physical_scale),
            "fans_m":[arithmetic.text(x*physical_scale) for x in fans],
            "omega":None if g["hnum"]==0 else arithmetic.text(whole_omega),
            "face_cancellation":arithmetic.text(arithmetic.divide(arithmetic.sum([abs(d[i]*logs[i]) for i in range(3)])+abs(h*whole_omega),fan)),
            "h_zero":g["hnum"]==0,"d_zero":[x==0 for x in g["dnums"]],"status":"evaluated"}


def evaluate_triangle(vertices, target, budget=None):
    budget=budget or Budget()
    key=struct.pack("<3d",*map(float,target)).hex();budget.activate(key)
    geometry=prepare_geometry(vertices,target,budget);passes=[]
    for precision in PRECISIONS:
        try: passes.append(analytic_pass(geometry,precision,budget))
        except (Refusal,OverflowError,ValueError,ZeroDivisionError) as error:
            passes.append({"precision":precision,"status":"REFUSED","reason":str(error)})
    require(all(p["status"]=="evaluated" for p in passes[1:]),"highprecision pass refused: "+json.dumps(passes))
    arithmetic=Arithmetic(120,budget);ctx=arithmetic.ctx
    high=ctx.mpf(passes[2]["value_m"]);scale=arithmetic.number(geometry["scale"])
    whole=ctx.mpf(passes[2]["whole_m"])
    local_delta=ctx.fsum(abs(ctx.mpf(a)-ctx.mpf(b)) for a,b in zip(passes[1]["fans_m"],passes[2]["fans_m"]))
    require(abs(high-whole)<=ctx.mpf("1e-55")*(scale+abs(high)),"120digit whole/fan mismatch")
    require(abs(ctx.mpf(passes[1]["value_m"])-high)<=ctx.mpf("1e-45")*(scale+abs(high)) and local_delta<=ctx.mpf("1e-45")*(scale+abs(high)),"80/120 local precision mismatch")
    resolved="120digits"
    if passes[0]["status"]=="evaluated":
        low=ctx.mpf(passes[0]["value_m"])
        binary_gate=4096*ctx.mpf(2)**-52*(scale+abs(high))
        low_local=ctx.fsum(abs(ctx.mpf(a)-ctx.mpf(b)) for a,b in zip(passes[0]["fans_m"],passes[2]["fans_m"]))
        if abs(low-high)>binary_gate or low_local>binary_gate:
            passes[0]["status"]="REFUSED";passes[0]["reason"]="binary64/local120 discrepancy; 120digit fallback"
    scalar=float(high)
    if not math.isfinite(scalar) or scalar==0: scalar=None
    require(ctx.mpf(passes[-1]["face_cancellation"])<=ctx.mpf("1e40"), "120-digit face cancellation exceeds preregistered 1e40")
    return {"status":"MATHEMATICAL EVALUATION ONLY","qualification":"NOT VERIFIED","resolved_precision":resolved,
            "binary64_requires_highprecision":passes[0]["status"]=="REFUSED" or ("face_cancellation" in passes[0] and ctx.mpf(passes[0]["face_cancellation"])>ctx.mpf("1e8")),
            "value_m":arithmetic.text(high),"finite_binary64_value_m":scalar,"passes":passes,
            "local_potential_precision_delta_m":arithmetic.text(local_delta),
            "current_owner_weighted_errors":"NOT VERIFIED: no current or field input",
            "geometry_input_hex":{"vertices":[[float(x).hex() for x in p] for p in vertices],"target":[float(x).hex() for x in target]}}


class ReferenceExactArithmetic:
    """Count and bound raw integer intermediates before Fraction cancellation."""
    def __init__(self,budget): self.budget=budget

    def number(self,value):
        value=Fraction(value);self.budget.watch([value]);return value

    def integer(self,kind,a,b):
        self.budget.charge("reference_integer_"+kind,"reference-exact")
        value=a+b if kind=="add" else a-b if kind=="sub" else a*b
        bits=value.bit_length()
        self.budget.reference_raw_max_bits=max(self.budget.reference_raw_max_bits,bits)
        require(bits<=8192,"INCONCLUSIVE reference exact raw intermediate bit-length limit")
        return value

    def binary(self,kind,a,b):
        a=self.number(a);b=self.number(b)
        self.budget.charge("reference_fraction_"+kind,"reference-exact")
        if kind in ("add","sub"):
            left=self.integer("mul",a.numerator,b.denominator)
            right=self.integer("mul",b.numerator,a.denominator)
            numerator=self.integer(kind,left,right)
            denominator=self.integer("mul",a.denominator,b.denominator)
        elif kind=="mul":
            numerator=self.integer("mul",a.numerator,b.numerator)
            denominator=self.integer("mul",a.denominator,b.denominator)
        else:
            require(self.compare(b,0,"ne","division_nonzero"),"reference exact zero denominator")
            numerator=self.integer("mul",a.numerator,b.denominator)
            denominator=self.integer("mul",a.denominator,b.numerator)
        return self.number(Fraction(numerator,denominator))

    def compare(self,a,b,kind,site):
        a=self.number(a);b=self.number(b)
        self.budget.charge("reference_comparison_"+site,"reference-exact")
        left=self.integer("mul",a.numerator,b.denominator)
        right=self.integer("mul",b.numerator,a.denominator)
        if kind=="gt": return left>right
        if kind=="ge": return left>=right
        if kind=="ne": return left!=right
        return left==right

    def absolute(self,value):
        value=self.number(value)
        self.budget.charge("reference_integer_abs","reference-exact")
        numerator=abs(value.numerator)
        bits=numerator.bit_length()
        self.budget.reference_raw_max_bits=max(self.budget.reference_raw_max_bits,bits)
        require(bits<=8192,"INCONCLUSIVE reference exact raw abs bit-length limit")
        return self.number(Fraction(numerator,value.denominator))

    def vector_sub(self,a,b): return tuple(self.binary("sub",x,y) for x,y in zip(a,b))

    def dot(self,a,b):
        total=Fraction(0)
        for x,y in zip(a,b): total=self.binary("add",total,self.binary("mul",x,y))
        return total

    def cross(self,a,b):
        return tuple(self.binary("sub",self.binary("mul",a[i],b[j]),self.binary("mul",a[j],b[i]))
                     for i,j in ((1,2),(2,0),(0,1)))

    def sum(self,values):
        total=Fraction(0)
        for value in values: total=self.binary("add",total,value)
        return total


def reference_test_identity(vertices,target):
    require(len(vertices)==3,"three physical reference vertices required")
    rational_points((*vertices,target))  # Validate finite original binary64 inputs.
    values=[float(x) for point in (*vertices,target) for x in point]
    payload=b"triangle-reference-test.v2\0"+struct.pack("<12d",*values)
    return "reference:"+hashlib.sha256(payload).hexdigest()


def reference_scale(vertices,target,budget):
    budget.activate(reference_test_identity(vertices,target))
    exact=ReferenceExactArithmetic(budget)
    v=rational_points(vertices);r=rational_points([target])[0]
    candidates=[exact.absolute(x) for point in v for x in exact.vector_sub(point,r)]
    maximum=candidates[0]
    for candidate in candidates[1:]:
        if exact.compare(candidate,maximum,"gt","gate_scale_max"): maximum=candidate
    return maximum


def positive_reference_panels(vertices, target, budget=None):
    # Literal independent partition, preserving comparison order and short circuits.
    budget=budget or Budget();budget.activate(reference_test_identity(vertices,target));exact=ReferenceExactArithmetic(budget)
    v=rational_points(vertices);r=rational_points([target])[0]
    for point in (*v,r): budget.watch(point)
    N=exact.cross(exact.vector_sub(v[1],v[0]),exact.vector_sub(v[2],v[0]));NN=exact.dot(N,N)
    require(exact.compare(NN,0,"gt","face_area"),"reference degenerate face")
    q=tuple(exact.binary("sub",r[k],exact.binary("div",exact.binary("mul",N[k],exact.dot(N,exact.vector_sub(r,v[0]))),NN)) for k in range(3))
    inside=all(exact.compare(exact.dot(N,exact.cross(exact.vector_sub(v[(i+1)%3],v[i]),exact.vector_sub(q,v[i]))),0,"ge","barycentric") for i in range(3))
    panels=[(q,v[i],v[(i+1)%3]) for i in range(3)] if inside else [v]
    panels=[p for p in panels if exact.compare(exact.dot(exact.cross(exact.vector_sub(p[1],p[0]),exact.vector_sub(p[2],p[0])),N),0,"ne","fan_zero")]
    require(all(exact.compare(exact.dot(exact.cross(exact.vector_sub(p[1],p[0]),exact.vector_sub(p[2],p[0])),N),0,"gt","fan_orientation") for p in panels),"reference partition orientation")
    summed=tuple(exact.sum(exact.cross(exact.vector_sub(p[1],p[0]),exact.vector_sub(p[2],p[0]))[k] for p in panels) for k in range(3))
    require(all(exact.compare(x,y,"eq","area_identity") for x,y in zip(summed,N)),"reference partition area")
    return panels,r,inside


def reference_pass(vertices, target, digits, degree, budget):
    arithmetic=Arithmetic(digits,budget,reference=True)
    try:
        result=_reference_pass_context(vertices,target,digits,degree,budget,arithmetic)
    finally:
        arithmetic.close_reference()
    budget.guard()  # Include cleanup time and actual lifetime peak in admission.
    return result


def reference_radial_value(arithmetic,p,f1,f2,v,vertex,projected,certified_midpoint):
    """Integrate only the Duffy radial coordinate; never use an edge kernel."""
    ctx=arithmetic.ctx;budget=arithmetic.budget
    budget.charge("reference_evals",f"reference{arithmetic.precision}/angular")
    def compare(a,b,kind):
        budget.charge("reference_dynamic_"+kind,"reference-angular")
        return a==b if kind=="zero" else a>=b if kind=="nonnegative" else a>b
    def divided(a,b): return arithmetic.divide(a,b)
    ray=tuple((1-v)*x+v*y for x,y in zip(f1,f2))
    A=dot(ray,ray);require(compare(A,0,"positive"),"reference nonpositive radial norm")
    s=arithmetic.call("sqrt",A)
    if vertex:
        value=divided(ctx.mpf(1),s);mode="exact_vertex";condition=ctx.mpf(1)
    elif projected:
        R0=arithmetic.call("sqrt",dot(p,p))
        R1=arithmetic.call("sqrt",A+dot(p,p))
        value=divided(ctx.mpf(1),R0+R1);mode="exact_projected";condition=ctx.mpf(1)
    else:
        B=dot(p,ray);beta=divided(B,s)
        R0=arithmetic.call("sqrt",dot(p,p))
        displacement=tuple(x-y for x,y in zip(p,ray))
        R1=arithmetic.call("sqrt",dot(displacement,displacement))
        transverse=cross(p,ray);delta2=divided(dot(transverse,transverse),A)
        require(compare(delta2,0,"nonnegative"),"reference negative transverse norm")
        if compare(delta2,0,"zero"):
            require(certified_midpoint and compare(v,ctx.mpf(".5"),"zero"),
                    "reference unproven rounded radial zero")
            if compare(0,beta,"positive"):
                term=divided(beta*arithmetic.call("log1p",divided(s,-beta)),A)
                first=divided(ctx.mpf(1),s)
            elif compare(beta,s,"positive"):
                term=divided(beta*arithmetic.call("log1p",divided(s,beta-s)),A)
                first=-divided(ctx.mpf(1),s)
            else: raise Refusal("reference singular radial segment")
            value=first+term
            condition=divided(abs(first)+abs(term),abs(value)) if compare(abs(value),0,"positive") else ctx.inf
        else:
            # R-|t| = delta^2/(R+|t|), so no cancellation in D.
            t0=-beta;t1=s-beta
            E=2*t0 if compare(t0,0,"nonnegative") else -2*t1 if compare(0,t1,"nonnegative") else ctx.mpf(0)
            D=divided(delta2,R0+abs(t0))+divided(delta2,R1+abs(t1))+E
            require(compare(D,0,"positive"),"reference unresolved radial denominator")
            L=arithmetic.call("log1p",divided(2*s,D))
            first=divided(A-2*B,R1+R0);term=beta*L
            numerator=first+term
            condition=divided(abs(first)+abs(term),abs(numerator)) if compare(abs(numerator),0,"positive") else ctx.inf
            value=divided(numerator,A)
        mode="general_radial_primitive"
    budget.charge("reference_dynamic_finite","reference-angular")
    require(ctx.isfinite(value),"reference nonfinite radial primitive")
    budget.charge("reference_dynamic_finite","reference-angular")
    require(ctx.isfinite(condition),"reference nonfinite radial condition")
    require(compare(value,0,"positive"),"reference nonpositive radial primitive")
    return value,mode,condition


def _reference_pass_context(vertices, target, digits, degree, budget, arithmetic):
    ctx=arithmetic.ctx;exact=ReferenceExactArithmetic(budget)
    panels,r,projected=positive_reference_panels(vertices,target,budget)
    # Membership authenticates the frozen original geometry, not a rounded cross.
    identity=reference_test_identity(vertices,target)
    midpoint_ids={reference_test_identity(c["vertices"],c["target"])
                  for c in mathematical_corpus() if c["id"].startswith("M08/")}
    certified_midpoint=identity in midpoint_ids
    values=[];errors=[];radial_modes=[];conditions=[]
    for panel in panels:
        a,b,c=panel;e1=exact.vector_sub(b,a);e2=exact.vector_sub(c,a);N=exact.cross(e1,e2)
        area=arithmetic.call("sqrt",sum(arithmetic.number(x)**2 for x in N))
        p=tuple(arithmetic.number(x) for x in exact.vector_sub(r,a))
        f1=tuple(arithmetic.number(x) for x in e1);f2=tuple(arithmetic.number(x) for x in e2)
        vertex=all(exact.compare(x,y,"eq","vertex_identity") for x,y in zip(r,a))
        max_condition=ctx.mpf(1);mode="exact_vertex" if vertex else "exact_projected" if projected else "general_radial_primitive"
        def angular(v):
            nonlocal max_condition
            value,actual_mode,condition=reference_radial_value(arithmetic,p,f1,f2,v,vertex,projected,certified_midpoint)
            require(actual_mode==mode,"reference radial branch metadata mismatch")
            budget.charge("reference_dynamic_max","reference-angular")
            max_condition=max(max_condition,condition)
            return area*value
        value,error=ctx.quad(angular,[0,1],method="tanh-sinh",maxdegree=degree,error=True)
        values.append(value);errors.append(error);radial_modes.append(mode);conditions.append(max_condition)
    return {"digits":digits,"maxdegree":degree,"reference_method":"GENERAL_RADIAL_1D",
            "panels_m":[ctx.nstr(v,digits+5) for v in values],
            "value_m":ctx.nstr(ctx.fsum(values),digits+5),"radial_integration":radial_modes,
            "radial_error_marker":["exact_algebraic_reduction"]*len(panels),
            "radial_cancellation":[ctx.nstr(v,digits+5) for v in conditions],
            "outer_error_estimates":[None]*len(panels),
            "angular_error_estimates_diagnostic":[ctx.nstr(v,digits+5) for v in errors]}

def reference_triangle(vertices,target,budget):
    budget.activate(reference_test_identity(vertices,target))
    positive_reference_panels(vertices,target,budget)
    passes=[]
    for digits in (160,200):
        for degree in (8,10,12): passes.append(reference_pass(vertices,target,digits,degree,budget))
    ctx=Arithmetic(200,budget).ctx;final=passes[-1];value=ctx.mpf(final["value_m"])
    scale=reference_scale(vertices,target,budget)
    gate=ctx.mpf("1e-30")*(ctx.mpf(scale.numerator)/scale.denominator+abs(value))
    for a,b in ((passes[1],passes[2]),(passes[4],passes[5]),(passes[2],passes[5])):
        local=ctx.fsum(abs(ctx.mpf(x)-ctx.mpf(y)) for x,y in zip(a["panels_m"],b["panels_m"]))
        require(abs(ctx.mpf(a["value_m"])-ctx.mpf(b["value_m"]))<=gate and local<=gate,"reference convergence refused")
    return {"status":"reference convergence only","passes":passes,"value_m":final["value_m"],"gate_m":ctx.nstr(gate,205)}


def mathematical_corpus():
    vertices=((0.,0.,0.),(1.,0.,0.),(0.,1.,0.))
    points=[*vertices,(.5,0.,0.),(0.,.5,0.),(.5,.5,0.),(.25,.25,0.),(2.,2.,0.),(-1.,.25,0.),
            (.25,.25,.5),(.25,.25,-.5),(2.,2.,.5),(-1.,.25,-.5),(.5,0.,2.**-12),
            (.25,.25,-2.**-12),(.5,0.,2.**-40),(.25,.25,-2.**-40),(2.**20,-2.**20,2.**20)]
    transforms={"base":lambda p:p,"shear":lambda p:(p[0],p[1],p[2]+p[0]/2-p[1]/4),
                "rotate90":lambda p:(-p[1],p[0],p[2])}
    return [{"id":f"M{i:02}/{name}","vertices":[transform(p) for p in vertices],"target":transform(point)}
            for name,transform in transforms.items() for i,point in enumerate(points,1)]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root",required=True)
    parser.add_argument("--output-dir",required=True)
    parser.add_argument("--first-case-only",action="store_true",help="Execute frozen M01/base only; full scope remains NOT VERIFIED")
    parser.add_argument("--reference",action="store_true")
    parser.add_argument("--soft-reference-evals",type=int)
    args=parser.parse_args()
    from fullmag_storage import resolve_layout, validate_path
    dependency=dependency_provenance()  # Verify pinned bytes before mathematical evaluation.
    layout=resolve_layout(Path(args.repo_root),profile="windows-source-contracts")
    allowed=Path(layout["runs_root"])/"e2"/"triangle-analytic-v2"
    output=validate_path(args.output_dir,allowed,"triangle research output")
    output.mkdir(parents=True,exist_ok=False)
    budget=Budget(soft_reference_evals=args.soft_reference_evals);records=[]
    cases=mathematical_corpus()
    if args.first_case_only: cases=cases[:1]
    for case in cases:
        record=dict(case)
        record["reference_test_identity"]=reference_test_identity(case["vertices"],case["target"])
        try:
            record["analytic"]=evaluate_triangle(case["vertices"],case["target"],budget)
            if args.reference:
                record["reference"]=reference_triangle(case["vertices"],case["target"],budget)
                ctx=Arithmetic(200,budget).ctx
                reference=ctx.mpf(record["reference"]["value_m"]);gate=ctx.mpf(record["reference"]["gate_m"])
                for value in (record["analytic"]["value_m"],record["analytic"]["passes"][-1]["whole_m"]):
                    require(abs(ctx.mpf(value)-reference)<=gate,"analytic/reference200 mismatch")
                record["analytic_reference_comparison"]="PASS for this scalar pair only"
        except (Refusal,ImportError) as error:
            record["status"]="REFUSED / NOT VERIFIED";record["reason"]=str(error)
        records.append(record)
        if "reason" in record and any(x in record["reason"] for x in ("soft execution","case wall-time","case reference","actual peak RAM","unresolved_reference_predicate_contract")): break
    import sys
    report={"schema":"triangle_analytic_v2_math_evidence.v1","prereg_sha256":PREREG_SHA,"subdivision_addendum_sha256":ADDENDUM_SHA,"reference_comparison_prereg_sha256":REFERENCE_COMPARISON_PREREG_SHA,"reference_identity_prereg_sha256":IDENTITY_PREREG_SHA,"vertex_lifecycle_prereg_sha256":VERTEX_LIFECYCLE_PREREG_SHA,"general_radial_prereg_sha256":GENERAL_RADIAL_PREREG_SHA,"reference_method":"GENERAL_RADIAL_1D","independent_direct2d_validation":"NOT VERIFIED / NOT EXECUTED",
            "source_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"test_source_sha256":hashlib.sha256(Path(__file__).with_name("test_antenna_triangle_surface_oracle.py").read_bytes()).hexdigest(),"runtime":{"python":sys.version,"mpmath":dependency},
            "qualification":"NOT VERIFIED","terminal_status":"REFUSED / NOT VERIFIED" if any("reason" in r for r in records) else "SCALAR SUBSET ONLY / NOT VERIFIED","antenna_V_J_H":False,"corpus_count":54,"completed_records":len(records),
            "unexecuted_corpus_ids":[c["id"] for c in mathematical_corpus() if c["id"] not in {r["id"] for r in records}],
            "scalar_subset_reference_pass":len(records)==54 and args.reference and not any("reason" in r for r in records),"reference_independence_qualification":False,"full_preregistered_math_scope_pass":False,"corpus_scope":"54 base/shear/rotate scalar pairs; full identity/extreme and RT0 scope NOT VERIFIED","reference_exact_budget_status":"raw/reduced Fraction bits guarded; actual exact-domain comparisons guarded174/test and9396/54subset; full runtime reference budget NOT VERIFIED","RT0_volume_regression":"NOT VERIFIED / NOT IMPLEMENTED in scalar helper","records":records,"budget":budget.report()}
    with (output/"math-evidence.json").open("x",encoding="utf-8",newline="\n") as f:json.dump(report,f,ensure_ascii=False,allow_nan=False,indent=2);f.write("\n")
    print(json.dumps({"records":len(records),"reference":args.reference,"qualification":"NOT VERIFIED","budget":report["budget"]},allow_nan=False))
    return 0 if not any("reason" in r for r in records) else 2


if __name__=="__main__":
    raise SystemExit(main())
