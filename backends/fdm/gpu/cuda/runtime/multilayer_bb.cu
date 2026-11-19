// Resident FP64 PG-BB vector algebra and layer-local physical reductions.
// The host owns Armijo/BB scalar decisions; no field is downloaded here.
#include "context.hpp"
#include <cuda_runtime.h>
#include <cmath>
#include <algorithm>
#include <cfloat>

namespace fullmag { namespace fdm {
extern void set_cuda_error(Context &, const char *, cudaError_t);
namespace {
constexpr int B = 128;
constexpr int N = 20;
constexpr double MU0 = 4.0 * 3.141592653589793238462643383279502884 * 1e-7;
struct V { double x, y, z; };
__device__ V read(DeviceVectorField f, uint64_t i) {
    return {static_cast<double *>(f.x)[i], static_cast<double *>(f.y)[i], static_cast<double *>(f.z)[i]};
}
__device__ void write(DeviceVectorField f, uint64_t i, V v) {
    static_cast<double *>(f.x)[i]=v.x; static_cast<double *>(f.y)[i]=v.y; static_cast<double *>(f.z)[i]=v.z;
}
__device__ double dot(V a,V b) {return a.x*b.x+a.y*b.y+a.z*b.z;}
__device__ V sub(V a,V b) {return {a.x-b.x,a.y-b.y,a.z-b.z};}
__device__ V scale(V a,double b) {return {a.x*b,a.y*b,a.z*b};}
__device__ V tangent(V m,V a) {return sub(a,scale(m,dot(m,a)/dot(m,m)));}
__device__ bool finite(V v) {return isfinite(v.x)&&isfinite(v.y)&&isfinite(v.z);}
__device__ double length(V v) {return sqrt(dot(v,v));}
__device__ bool max_metric(int k) {return k>=6 && k<=8;}

__global__ void vector_op(DeviceMultilayerLayer l, uint32_t op) {
    const uint64_t i=uint64_t(blockIdx.x)*blockDim.x+threadIdx.x;
    if(i>=l.cell_count) return;
    if(op==1) {
        write(l.pre_step_m,i,read(l.m,i));
        write(l.k1,i,read(l.k3,i));
        write(l.k2,i,read(l.tmp,i));
    } else if(op==3) {
        write(l.m,i,read(l.pre_step_m,i));
    }

}

// Validate the raw retraction before any field operator sees it. Invalid
// active vectors match normalized_vec3(None), so the host can backtrack.
__global__ void trial_op(DeviceMultilayerLayer l, double lambda,
                         double *out, uint64_t blocks) {
    __shared__ double invalid[B], changed[B];
    const uint64_t i=uint64_t(blockIdx.x)*blockDim.x+threadIdx.x;
    double bad=0, diff=0;
    if(i<l.cell_count) {
        const V old=read(l.pre_step_m,i);
        V trial={0,0,0};
        if(!l.active_mask || l.active_mask[i]) {
            const V raw=sub(old,scale(read(l.k1,i),lambda));
            const double n2=dot(raw,raw);
            if(!finite(raw)||!isfinite(n2)||n2<=DBL_MIN) {
                bad=1;
                trial=old;
            } else trial=scale(raw,1.0/sqrt(n2));
        }
        write(l.m,i,trial);
        diff=(trial.x!=old.x||trial.y!=old.y||trial.z!=old.z)?1.0:0.0;
    }
    invalid[threadIdx.x]=bad;changed[threadIdx.x]=diff;__syncthreads();
    for(int stride=B/2;stride>0;stride/=2) {
        if(threadIdx.x<stride) {
            invalid[threadIdx.x]+=invalid[threadIdx.x+stride];
            changed[threadIdx.x]+=changed[threadIdx.x+stride];
        }
        __syncthreads();
    }
    if(threadIdx.x==0) {
        out[18*blocks+blockIdx.x]=changed[0];
        out[19*blocks+blockIdx.x]=invalid[0];
    }
}

__global__ void metrics(DeviceMultilayerLayer l, double *out, uint64_t blocks,
                        bool exchange, bool demag, bool external, V hext, bool history) {
    __shared__ double shared[N][B];
    double v[N]={};
    const uint64_t i=uint64_t(blockIdx.x)*blockDim.x+threadIdx.x;
    if(i<l.cell_count) {
        const V m=read(l.m,i), h=read(l.tmp,i);
        const bool active=!l.active_mask || l.active_mask[i];
        const V g=active ? scale(tangent(m,h),-1.0) : V{0,0,0};
        write(l.k3,i,g);
        if(!finite(m)||!finite(h)||!finite(g) ||
           (active ? fabs(dot(m,m)-1.0)>1e-10 : dot(m,m)!=0)) v[19]=1;
        if(active) {
            const double vol=l.native_grid.dx*l.native_grid.dy*l.native_grid.dz;
            const double w=MU0*l.material.saturation_magnetisation*vol;
            // Exchange energy uses the same masked open or periodic
            // stencil as the field through its quadratic energy identity.
            if(exchange) v[0]=-0.5*w*dot(m,read(l.h_ex,i));
            if(demag) v[1]=-0.5*w*dot(m,read(l.h_demag,i));
            if(external) v[2]=-w*dot(m,hext);
            if(l.has_uniaxial_anisotropy) {
                const double a=m.x*l.anisU[0]+m.y*l.anisU[1]+m.z*l.anisU[2];
                v[3]=-vol*(l.Ku1*a*a+l.Ku2*a*a*a*a);
            }
            if(l.has_cubic_anisotropy) {
                const V a={l.cubic_axis1[0],l.cubic_axis1[1],l.cubic_axis1[2]};
                const V b={l.cubic_axis2[0],l.cubic_axis2[1],l.cubic_axis2[2]};
                const V c={a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x};
                double p=dot(m,a), q=dot(m,b), r=dot(m,c);p*=p;q*=q;r*=r;
                double sigma=p*q+q*r+p*r;
                v[3]+=vol*(l.Kc1*sigma+l.Kc2*p*q*r+l.Kc3*sigma*sigma);
            }
            // Each DMI functional is quadratic in m; Euler's homogeneous
            // identity gives E=-1/2 mu0 Ms V m.H, including the boundary
            // correction in the canonical variational field. The rotated
            // field is read only for the layer that actually owns its term.
            v[4]=-0.5*w*dot(m,read(l.h_dmi,i));
            if(l.has_rotated_interfacial_dmi) v[5]=-0.5*w*dot(m,read(l.h_rotated_dmi,i));
            v[4]+=v[5];
            const V cross={m.y*h.z-m.z*h.y,m.z*h.x-m.x*h.z,m.x*h.y-m.y*h.x};
            v[6]=length(cross); v[7]=length(h);
            if(demag) v[8]=length(read(l.h_demag,i));
            v[9]=m.x;v[10]=m.y;v[11]=m.z;v[12]=1;
            v[13]=w*dot(g,g);
            if(history) {
            const V old=read(l.pre_step_m,i), oldg=read(l.k1,i);
            const V chord=sub(m,old);
            v[14]=-w*dot(read(l.k2,i),chord);
            const V s=tangent(m,chord), y=sub(g,tangent(m,oldg));
            v[15]=w*dot(s,s);v[16]=w*dot(s,y);v[17]=w*dot(y,y);
            v[18]=(m.x!=old.x||m.y!=old.y||m.z!=old.z) ? 1.0:0.0;
            }
        }
    }
    for(int k=0;k<N;k++) shared[k][threadIdx.x]=v[k];
    __syncthreads();
    for(int stride=B/2;stride>0;stride/=2) {
        if(threadIdx.x<stride) for(int k=0;k<N;k++)
            shared[k][threadIdx.x]=max_metric(k)
                ? fmax(shared[k][threadIdx.x],shared[k][threadIdx.x+stride])
                : shared[k][threadIdx.x]+shared[k][threadIdx.x+stride];
        __syncthreads();
    }
    if(threadIdx.x==0) for(int k=0;k<N;k++) out[k*blocks+blockIdx.x]=shared[k][0];
}
__global__ void finish(const double *in, double *out, uint64_t blocks) {
    __shared__ double shared[B];
    int k=blockIdx.x;double v=0;
    for(uint64_t i=threadIdx.x;i<blocks;i+=B)
        v=max_metric(k)?fmax(v,in[k*blocks+i]):v+in[k*blocks+i];
    shared[threadIdx.x]=v;__syncthreads();
    for(int stride=B/2;stride>0;stride/=2) {
        if(threadIdx.x<stride) shared[threadIdx.x]=max_metric(k)
            ?fmax(shared[threadIdx.x],shared[threadIdx.x+stride])
            :shared[threadIdx.x]+shared[threadIdx.x+stride];
        __syncthreads();
    }
    if(threadIdx.x==0) out[k]=shared[0];
}
}

bool context_multilayer_bb(Context &ctx, uint32_t op, double lambda,
                           double *out, uint64_t count) {
    if(op>3 || ((op==0||op==2) && (!out||count!=ctx.multilayer_layers.size()*N))) {
        ctx.last_error="resident BB scalar count/operation mismatch";return false;
    }
    const cudaStream_t stream=context_compute_stream(ctx);
    if(op!=0) {
        if(op==1 && !ctx.multilayer_bb_evaluation_valid) {
            ctx.last_error="resident BB capture requires a fresh evaluated state";return false;
        }
        if(op==2 && (!std::isfinite(lambda) || lambda<=0.0)) {
            ctx.last_error="resident BB trial requires a positive finite step";return false;
        }
        if(op!=1 && !ctx.multilayer_bb_history_valid) {
            ctx.last_error="resident BB has no accepted state";return false;
        }
        if(op==2) {
            ctx.multilayer_bb_evaluation_valid=false;
            uint64_t layer=0;
            for(auto &l:ctx.multilayer_layers) {
                const uint64_t blocks=(l.cell_count+B-1)/B;
                auto err=cudaMemsetAsync(ctx.multilayer_bb_partials,0,blocks*N*sizeof(double),stream);
                if(err!=cudaSuccess) {set_cuda_error(ctx,"resident BB trial status reset",err);return false;}
                trial_op<<<unsigned(blocks),B,0,stream>>>(l,lambda,ctx.multilayer_bb_partials,blocks);
                finish<<<N,B,0,stream>>>(ctx.multilayer_bb_partials,ctx.multilayer_bb_scalars+layer*N,blocks);
                layer++;
            }
            auto err=cudaGetLastError();
            if(err==cudaSuccess) err=fullmag_fdm_receipt_cuda_memcpy_async(ctx,out,ctx.multilayer_bb_scalars,count*sizeof(double),cudaMemcpyDeviceToHost,stream);
            if(err==cudaSuccess) err=cudaStreamSynchronize(stream);
            if(err!=cudaSuccess) {set_cuda_error(ctx,"resident BB trial validity reduction",err);return false;}
            fullmag_fdm_record_control_scalar_d2h(ctx,count*sizeof(double));
            fullmag_fdm_record_control_scalar_host_sync(ctx);
            return true;
        }
        for(auto &l:ctx.multilayer_layers)
            vector_op<<<unsigned((l.cell_count+B-1)/B),B,0,stream>>>(l,op);
        const auto err=cudaGetLastError();
        if(err!=cudaSuccess) {set_cuda_error(ctx,"resident BB vector operation",err);return false;}
        if(op==1) ctx.multilayer_bb_history_valid=true;
        else ctx.multilayer_bb_evaluation_valid=false;
        return true;
    }
    ctx.multilayer_bb_evaluation_valid=false;
    uint64_t maxblocks=0;
    for(auto &l:ctx.multilayer_layers) maxblocks=std::max(maxblocks,(l.cell_count+B-1)/B);
    const bool setup_extension = !ctx.multilayer_bb_partials || !ctx.multilayer_bb_scalars;
    if(!ctx.multilayer_bb_partials) {
        auto err=context_gpu_workspace_cuda_malloc(ctx,&ctx.multilayer_bb_partials,maxblocks*N*sizeof(double));
        if(err!=cudaSuccess) {set_cuda_error(ctx,"allocate resident BB partials",err);return false;}
        ctx.multilayer_bb_partial_capacity=maxblocks;
    }
    if(!ctx.multilayer_bb_scalars) {
        auto err=context_gpu_workspace_cuda_malloc(ctx,&ctx.multilayer_bb_scalars,count*sizeof(double));
        if(err!=cudaSuccess) {set_cuda_error(ctx,"allocate resident BB scalars",err);return false;}
    }
    if(setup_extension) context_mark_gpu_workspace_setup_complete(ctx);
    if(maxblocks>ctx.multilayer_bb_partial_capacity) {ctx.last_error="resident BB workspace shape changed";return false;}
    uint64_t layer=0;
    for(auto &l:ctx.multilayer_layers) {
        const uint64_t blocks=(l.cell_count+B-1)/B;
        metrics<<<unsigned(blocks),B,0,stream>>>(l,ctx.multilayer_bb_partials,blocks,
            ctx.enable_exchange,ctx.enable_demag,ctx.has_external_field,
            {ctx.external_field[0],ctx.external_field[1],ctx.external_field[2]},ctx.multilayer_bb_history_valid);
        finish<<<N,B,0,stream>>>(ctx.multilayer_bb_partials,ctx.multilayer_bb_scalars+layer*N,blocks);
        layer++;
    }
    auto err=cudaGetLastError();
    if(err==cudaSuccess) err=fullmag_fdm_receipt_cuda_memcpy_async(ctx,out,ctx.multilayer_bb_scalars,count*sizeof(double),cudaMemcpyDeviceToHost,stream);
    if(err==cudaSuccess) err=cudaStreamSynchronize(stream);
    if(err!=cudaSuccess) {set_cuda_error(ctx,"resident BB scalar reduction",err);return false;}
    fullmag_fdm_record_control_scalar_d2h(ctx,count*sizeof(double));
    fullmag_fdm_record_control_scalar_host_sync(ctx);
    ctx.multilayer_bb_evaluation_valid=true;
    return true;
}
} }
