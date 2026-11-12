#include "gpu/cuda/demag_poisson/pcg_device_scalar_kernels.hpp"
#include <cub/cub.cuh>
#include <cfloat>
#include <cmath>
namespace fullmag::fem {
namespace {
constexpr int block_size = 256;
__device__ bool running(const DemagPcgState* s) { return s->status == DemagPcgStatus::Running; }
__device__ void nonfinite(DemagPcgState* s) {
    atomicCAS(reinterpret_cast<unsigned*>(&s->status),
              static_cast<unsigned>(DemagPcgStatus::Running), static_cast<unsigned>(DemagPcgStatus::Nonfinite));
}
__global__ void initialize_state(DemagPcgState* s, double rt, double at, uint32_t max_it) {
    if (threadIdx.x || blockIdx.x) return;
    *s = {}; s->status = DemagPcgStatus::Running;
    s->relative_tolerance = rt; s->absolute_tolerance = at; s->max_iterations = max_it;
}
__global__ void initialize_vectors(DemagPcgState* s, const double* b, double* x, double* p, double* q, int n, bool fresh) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    if (fresh) x[i] = 0.0;
    p[i] = 0.0; q[i] = 0.0;
    if (!isfinite(b[i]) || !isfinite(x[i])) { x[i] = 0.0; nonfinite(s); }
    if (b[i] != 0.0) atomicOr(&s->rhs_nonzero, 1u);
}
__global__ void dot_partials(const double* a, const double* b, int n, double* partials, DemagPcgState* s) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    double value = 0.0;
    if (i < n && running(s)) {
        value = a[i] * b[i];
        if (!isfinite(value)) { nonfinite(s); value = 0.0; }
    }
    using Reduce = cub::BlockReduce<double, block_size>;
    __shared__ typename Reduce::TempStorage temporary;
    const double sum = Reduce(temporary).Sum(value);
    if (!threadIdx.x) { partials[blockIdx.x] = sum; if (!isfinite(sum)) nonfinite(s); }
}
__global__ void finish_denominator(DemagPcgState* s) {
    if (!running(s)) return;
    if (!s->rhs_nonzero) { s->status = DemagPcgStatus::Converged; return; }
    if (!isfinite(s->denominator)) { s->status = DemagPcgStatus::Nonfinite; return; }
    if (!(s->denominator > 0.0)) { s->status = DemagPcgStatus::Breakdown; return; }
    const double relative = s->relative_tolerance * s->relative_tolerance;
    const double absolute = s->absolute_tolerance * s->absolute_tolerance / s->denominator;
    s->epsilon = fmax(relative, absolute);
    if (!isfinite(s->epsilon)) s->status = DemagPcgStatus::Nonfinite;
}
__global__ void initial_residual(const double* b, const double* ax, double* x, double* r, int n, DemagPcgState* s) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    if (!s->rhs_nonzero && s->status == DemagPcgStatus::Converged) { x[i] = r[i] = 0.0; return; }
    if (!running(s)) { r[i] = 0.0; return; }
    const double value = b[i] - ax[i]; r[i] = value;
    if (!isfinite(value)) nonfinite(s);
    if (value != 0.0) atomicOr(&s->residual_nonzero, 1u);
}
__global__ void gate(const double* input, double* output, int n, const DemagPcgState* s) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) output[i] = running(s) ? input[i] : 0.0;
}
__global__ void alpha(DemagPcgState* s) {
    if (!running(s)) return;
    ++s->iterations;
    s->residual_nonzero = 0;
    if (!isfinite(s->curvature) || !isfinite(s->rho)) { s->status = DemagPcgStatus::Nonfinite; return; }
    if (!(s->curvature > 0.0) || !(s->rho > 0.0)) { s->status = DemagPcgStatus::Breakdown; return; }
    s->alpha = s->rho / s->curvature;
    if (!isfinite(s->alpha)) s->status = DemagPcgStatus::Nonfinite;
    else if (!(s->alpha >= DBL_MIN)) s->status = DemagPcgStatus::Breakdown;
    s->previous_rho = s->rho;
}
__global__ void update(double* x, double* r, const double* p, const double* q, int n, DemagPcgState* s) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n || !running(s)) return;
    const double next_x = x[i] + s->alpha * p[i];
    const double next_r = r[i] - s->alpha * q[i];
    x[i] = next_x; r[i] = next_r;
    if (!isfinite(next_x) || !isfinite(next_r)) nonfinite(s);
    if (next_r != 0.0) atomicOr(&s->residual_nonzero, 1u);
}
__global__ void pcg_finish_rho_kernel(DemagPcgState* s, bool initial) {
    if (!running(s)) return;
    if (!isfinite(s->rho)) { s->status = DemagPcgStatus::Nonfinite; return; }
    if (s->rho < 0.0 || (s->rho == 0.0 && s->residual_nonzero)) { s->status = DemagPcgStatus::Breakdown; return; }
    const double ratio = s->rho / s->denominator;
    s->relative_residual = sqrt(ratio);
    if (!isfinite(ratio)) { s->status = DemagPcgStatus::Nonfinite; return; }
    if (ratio < s->epsilon) { s->status = DemagPcgStatus::Converged; return; }
    if (!initial && s->iterations >= s->max_iterations) { s->status = DemagPcgStatus::MaxIterations; return; }
    if (!(s->rho >= DBL_MIN)) { s->status = DemagPcgStatus::Breakdown; return; }
    if (!initial) {
        s->beta = s->rho / s->previous_rho;
        if (!isfinite(s->beta)) s->status = DemagPcgStatus::Nonfinite;
    }
}
__global__ void direction(const double* z, double* p, int n, DemagPcgState* s, bool initial) {
    const int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    if (!running(s)) { p[i] = 0.0; return; }
    const double value = initial ? z[i] : z[i] + s->beta * p[i];
    p[i] = value; if (!isfinite(value)) nonfinite(s);
}
}
cudaError_t demag_pcg_initialize(DemagPcgState* s, const double* b, double* x, double* p, double* q, int n, bool fresh, double rt, double at, uint32_t max_it, cudaStream_t stream) {
    initialize_state<<<1,1,0,stream>>>(s,rt,at,max_it);
    initialize_vectors<<<(n+255)/256,256,0,stream>>>(s,b,x,p,q,n,fresh);
    return cudaGetLastError();
}
cudaError_t demag_pcg_dot(const double* a,const double* b,int n,double* partial,void* temp,size_t& bytes,double* output,DemagPcgState* s,cudaStream_t stream) {
    const int blocks=(n+255)/256;
    if (!temp) return cub::DeviceReduce::Sum(nullptr,bytes,partial,output,blocks,stream);
    dot_partials<<<blocks,256,0,stream>>>(a,b,n,partial,s);
    auto status=cudaGetLastError();
    return status==cudaSuccess ? cub::DeviceReduce::Sum(temp,bytes,partial,output,blocks,stream) : status;
}
cudaError_t demag_pcg_finish_denominator(DemagPcgState* s,cudaStream_t stream) { finish_denominator<<<1,1,0,stream>>>(s); return cudaGetLastError(); }
cudaError_t demag_pcg_initial_residual(const double* b,const double* ax,double* x,double* r,int n,DemagPcgState* s,cudaStream_t stream) { initial_residual<<<(n+255)/256,256,0,stream>>>(b,ax,x,r,n,s); return cudaGetLastError(); }
cudaError_t demag_pcg_gate(const double* a,double* b,int n,DemagPcgState* s,cudaStream_t stream) { gate<<<(n+255)/256,256,0,stream>>>(a,b,n,s); return cudaGetLastError(); }
cudaError_t demag_pcg_alpha(DemagPcgState* s,cudaStream_t stream) { alpha<<<1,1,0,stream>>>(s); return cudaGetLastError(); }
cudaError_t demag_pcg_update(double* x,double* r,const double* p,const double* q,int n,DemagPcgState* s,cudaStream_t stream) { update<<<(n+255)/256,256,0,stream>>>(x,r,p,q,n,s); return cudaGetLastError(); }
cudaError_t demag_pcg_finish_rho(DemagPcgState* s,bool initial,cudaStream_t stream) { pcg_finish_rho_kernel<<<1,1,0,stream>>>(s,initial); return cudaGetLastError(); }
cudaError_t demag_pcg_direction(const double* z,double* p,int n,DemagPcgState* s,bool initial,cudaStream_t stream) { direction<<<(n+255)/256,256,0,stream>>>(z,p,n,s,initial); return cudaGetLastError(); }
}
