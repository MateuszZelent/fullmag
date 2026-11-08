// Actual MFEM import/assembly and legacy/versioned ABI qualification for u32 labels.
#include "fullmag_fem.h"
#include "core/fem_marker_map.hpp"
#include "core/fem_mesh.hpp"
#include "cpu/mfem/runtime/mfem_mesh_builder.hpp"
#include "backend_handle.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <numeric>
#include <string>
#include <vector>
#if FULLMAG_HAS_MFEM_STACK
#include <mfem.hpp>
#endif

namespace {
void require(bool condition, const std::string &message)
{
    if (!condition) { std::fprintf(stderr, "FAIL regional markers: %s\n", message.c_str()); std::exit(1); }
}
std::string error(fullmag_fem_backend *handle = nullptr)
{
    const char *value = fullmag_fem_backend_last_error(handle);
    return value == nullptr ? "no native diagnostic" : value;
}
constexpr double edge = 8e-9, aex = 13e-12, ms = 8e5;
constexpr double mu0 = 4e-7 * 3.14159265358979323846;
using Vec = std::array<double, 12>;
const Vec initial{1,0,0, 0,1,0, 0,0,1, -1,0,0};
const Vec tangent{0,1,.25, .5,0,-.25, .5,-.75,0, 0,.125,-.375};
const double gradients[4][3] = {{-1,-1,-1},{1,0,0},{0,1,0},{0,0,1}};

struct Fixture {
    fullmag::fem::FemMeshRuntimeState source;
    explicit Fixture(const std::vector<uint32_t> &labels)
    {
        source.n_elements = static_cast<uint32_t>(labels.size());
        source.n_nodes = 4u * source.n_elements;
        source.n_boundary_faces = 4u * source.n_elements;
        source.cell_markers = labels;
        source.cell_offsets.push_back(0u); source.facet_offsets.push_back(0u);
        const uint32_t faces[4][3] = {{1,2,3},{0,3,2},{0,1,3},{0,2,1}};
        for (uint32_t element = 0; element < source.n_elements; ++element) {
            const double x = 3.0 * edge * element;
            const double nodes[12] = {x,0,0, x+edge,0,0, x,edge,0, x,0,edge};
            source.nodes_xyz.insert(source.nodes_xyz.end(), nodes, nodes + 12);
            source.cell_types.push_back(FULLMAG_FEM_CELL_TET4);
            source.cell_global_ordinals.push_back(element);
            for (uint32_t node = 0; node < 4u; ++node) source.cell_nodes.push_back(4u*element+node);
            source.cell_offsets.push_back(static_cast<uint32_t>(source.cell_nodes.size()));
            for (const auto &face : faces) {
                source.facet_global_ordinals.push_back(source.facet_types.size());
                source.facet_types.push_back(FULLMAG_FEM_FACET_TRI3);
                source.facet_roles.push_back(FULLMAG_FEM_FACET_ROLE_EXTERIOR);
                source.facet_markers.push_back(labels[element]);
                for (uint32_t node : face) source.facet_nodes.push_back(4u*element+node);
                source.facet_offsets.push_back(static_cast<uint32_t>(source.facet_nodes.size()));
            }
        }
    }
    fullmag_fem_mesh_desc descriptor() const
    {
        fullmag_fem_mesh_desc d{}; d.abi_version=FULLMAG_FEM_MESH_DESC_ABI_VERSION; d.struct_size=sizeof(d);
#define BIND(name) d.name=source.name.data(); d.name##_len=source.name.size()
        BIND(nodes_xyz); BIND(cell_types); BIND(cell_offsets); BIND(cell_nodes); BIND(cell_markers); BIND(cell_global_ordinals);
        BIND(facet_types); BIND(facet_roles); BIND(facet_offsets); BIND(facet_nodes); BIND(facet_markers); BIND(facet_global_ordinals);
#undef BIND
        return d;
    }
};

#if FULLMAG_HAS_MFEM_STACK
void import_cases()
{
    using namespace fullmag::fem;
    std::string why; FemMarkerMaps maps; std::unique_ptr<mfem::Mesh> mesh;
    for (uint32_t count : {255u,256u,257u,1000u}) {
        std::vector<uint32_t> labels(count); std::iota(labels.begin(), labels.end(), 1u);
        Fixture f(labels);
        require(build_mfem_mesh(f.source, mesh, why, &maps), why);
        require(maps.domain.size()==count && maps.boundary.size()==count &&
            mesh->attributes.Max()==static_cast<int>(count) && mesh->bdr_attributes.Max()==static_cast<int>(count),
            "storage/attributes must depend on distinct count");
        for (uint32_t i=0;i<count;++i) {
            uint32_t canonical=0;
            require(maps.domain.canonical(mesh->GetAttribute(static_cast<int>(i)), canonical) && canonical==labels[i],
                    "actual MFEM domain lost canonical label");
        }
    }
    const std::vector<uint32_t> labels{0u,1u,2147483648u,UINT32_MAX};
    Fixture sparse(labels);
    require(build_mfem_mesh(sparse.source, mesh, why, &maps), why);
    require(maps.domain.size()==4 && maps.boundary.size()==4 && mesh->attributes.Max()==4 &&
        mesh->bdr_attributes.Max()==4, "sparse u32 labels expanded MFEM storage");
    require(maps.domain.attribute(1)==1 && maps.domain.attribute(2147483648u)==2 &&
        maps.domain.attribute(UINT32_MAX)==3 && maps.domain.attribute(0)==4,
        "deterministic nonzero ordering/air-zero separation");
    std::array<unsigned,4> boundary_counts{};
    for (int i=0;i<mesh->GetNBE();++i) {
        uint32_t canonical=0;
        require(maps.boundary.canonical(mesh->GetBdrAttribute(i),canonical), "boundary reverse map absent");
        const auto found=std::find(labels.begin(),labels.end(),canonical);
        require(found!=labels.end(), "boundary label changed"); ++boundary_counts[found-labels.begin()];
    }
    require(boundary_counts==std::array<unsigned,4>{4,4,4,4}, "boundary zero aliases one");
    uint32_t unused=0;
    require(maps.domain.attribute(17)==0 && !maps.domain.canonical(0,unused) &&
        !maps.boundary.canonical(5,unused), "missing label/attribute accepted");
    CompactMarkerMap permuted; auto reversed=labels; std::reverse(reversed.begin(),reversed.end());
    require(permuted.assign(reversed,why),why);
    for (uint32_t label:labels) require(permuted.attribute(label)==maps.domain.attribute(label), "map depends on encounter order");
    Fixture duplicate(std::vector<uint32_t>(1000,UINT32_MAX));
    require(build_mfem_mesh(duplicate.source,mesh,why,&maps),why);
    require(maps.domain.size()==1 && maps.boundary.size()==1 && mesh->attributes.Max()==1,
        "repeated high labels do not require per-element map buckets");
    Fixture next({257u}); require(build_mfem_mesh(next.source,mesh,why,&maps),why);
    require(maps.domain.attribute(UINT32_MAX)==0 && maps.domain.attribute(257)==1, "reimport retained stale map");
    next.source.cell_types[0]=UINT32_MAX;
    require(!build_mfem_mesh(next.source,mesh,why,&maps) && !mesh && maps.domain.size()==0 && maps.boundary.size()==0,
        "failed import published stale mesh/maps");
    std::printf("regional_marker_import counts=255,256,257,1000 sparse_u32=passed zero_one=distinct reimport=passed\n");
}

fullmag_fem_plan_desc plan(Fixture &f, const Vec &m, bool gpu)
{
    fullmag_fem_plan_desc p{}; p.mesh=f.descriptor(); p.material={ms,aex,.1,2.211e5};
    p.fe_order=1; p.hmax=edge; p.precision=FULLMAG_FEM_PRECISION_DOUBLE;
    p.integrator=FULLMAG_FEM_INTEGRATOR_RK4; p.enable_exchange=1;
    p.initial_magnetization_xyz=m.data(); p.initial_magnetization_len=m.size();
    p.dt_seconds=1e-16; p.eager_initial_effective_field=1;
    p.mfem_device_string=gpu?"cuda":"cpu"; p.gpu_device_index=gpu?0:-1;
    p.demag_solver.solver=FULLMAG_FEM_LINEAR_SOLVER_CG;
    p.demag_solver.preconditioner=gpu?FULLMAG_FEM_PRECONDITIONER_AMG:FULLMAG_FEM_PRECONDITIONER_JACOBI;
    p.demag_solver.relative_tolerance=1e-12; p.demag_solver.max_iterations=1000;
    p.gpu_demag_mode=gpu?FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON:FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED;
    return p;
}
using Handle=std::unique_ptr<fullmag_fem_backend,decltype(&fullmag_fem_backend_destroy)>;
Handle own(fullmag_fem_backend *h) { require(h!=nullptr,error()); return Handle(h,fullmag_fem_backend_destroy); }
Vec field(fullmag_fem_backend *h, fullmag_fem_observable kind)
{
    Vec v{}; require(fullmag_fem_backend_copy_field_f64(h,kind,v.data(),v.size())==FULLMAG_FEM_OK,error(h)); return v;
}
fullmag_fem_step_stats snapshot(fullmag_fem_backend *h)
{
    fullmag_fem_step_stats s{}; require(fullmag_fem_backend_snapshot_stats(h,&s)==FULLMAG_FEM_OK,error(h)); return s;
}
void compare(const Vec &actual,const Vec &expected,double tolerance,const char *what)
{
    double scale=0,delta=0;
    for(size_t i=0;i<actual.size();++i){require(std::isfinite(actual[i]),what);scale=std::max(scale,std::abs(expected[i]));delta=std::max(delta,std::abs(actual[i]-expected[i]));}
    std::printf("regional_marker_compare what=%s relative_error=%.17g tolerance=%.17g\n",what,delta/std::max(scale,1e-30),tolerance);
    require(delta<=tolerance*std::max(scale,1e-30),what);
}
Vec exchange_field_oracle(const Vec &m)
{
    Vec h{};
    // Lumped P1 mass V/4 and stiffness A*V*grad(N_i).grad(N_j), independently.
    for(int i=0;i<4;++i)for(int j=0;j<4;++j)for(int c=0;c<3;++c)for(int axis=0;axis<3;++axis)
        h[3*i+c]+=-8*aex/(mu0*ms*edge*edge)*gradients[i][axis]*gradients[j][axis]*m[3*j+c];
    return h;
}
double exchange_energy_oracle(const Vec &m)
{
    double norm=0;
    for(int c=0;c<3;++c)for(int axis=0;axis<3;++axis){double g=0;for(int i=0;i<4;++i)g+=gradients[i][axis]*m[3*i+c]/edge;norm+=g*g;}
    return aex*edge*edge*edge/6*norm;
}
void check_energy(double actual,double expected)
{
    std::printf("regional_marker_energy actual_J=%.17g expected_J=%.17g relative_error=%.17g tolerance=1e-10\n",
        actual,expected,std::abs(actual-expected)/std::max(std::abs(expected),1e-30));
    require(std::isfinite(actual)&&std::abs(actual-expected)<=1e-10*std::max(std::abs(expected),1e-30),"independent exchange energy");
}
void step(fullmag_fem_backend *h,bool gpu)
{
    if(gpu)require(fullmag_fem_backend_set_gpu_execution_request_v1(h,FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE)==FULLMAG_FEM_OK,error(h));
    fullmag_fem_step_stats s{};require(fullmag_fem_backend_step(h,1e-16,&s)==FULLMAG_FEM_OK,error(h));
    require(s.step==1 && s.rhs_evaluations>0,"accepted RK4 step not executed");
    if(gpu){fullmag_fem_gpu_execution_receipt_v1 r{};r.abi_version=FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;r.struct_size=sizeof(r);
        require(fullmag_fem_backend_gpu_execution_receipt_v1(h,&r)==FULLMAG_FEM_OK,error(h));
        require(r.execution_class==FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT && r.accepted_step_count==1 &&
            r.fallback_count==0 && r.executed_host_operator_mask==0 && r.executed_unknown_operator_mask==0 &&
            (r.executed_device_operator_mask&r.required_operator_mask)==r.required_operator_mask,
            "GPU mapping qualification did not execute strictly on device");
        std::printf("regional_marker_gpu_receipt class=%u precision=%u accepted=%llu fallback=%llu required=%llu executed_device=%llu executed_host=%llu executed_unknown=%llu\n",
            r.execution_class,r.precision,static_cast<unsigned long long>(r.accepted_step_count),
            static_cast<unsigned long long>(r.fallback_count),static_cast<unsigned long long>(r.required_operator_mask),
            static_cast<unsigned long long>(r.executed_device_operator_mask),static_cast<unsigned long long>(r.executed_host_operator_mask),
            static_cast<unsigned long long>(r.executed_unknown_operator_mask));}
}
void exchange_cases(bool gpu)
{
    Vec baseline{};
    for(uint32_t marker:{1u,UINT32_MAX}){
        std::printf("regional_marker_case lane=%s canonical_marker=%u\n",gpu?"gpu-double":"cpu-double",marker);
        Fixture f({marker});auto p=plan(f,initial,gpu);auto h=own(fullmag_fem_backend_create(&p));
        fullmag_fem_device_info device{};require(fullmag_fem_backend_get_device_info(h.get(),&device)==FULLMAG_FEM_OK,error(h.get()));
        require((device.is_gpu_enabled!=0)==gpu,"requested native device not resolved");
        if(gpu)require(fullmag_fem_backend_set_gpu_execution_request_v1(h.get(),FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE)==FULLMAG_FEM_OK,error(h.get()));
        // Device-Hypre creation defers initial fields; snapshot computes the
        // accepted observable cache before the public copy-field operation.
        const auto initial_stats=snapshot(h.get());
        compare(field(h.get(),FULLMAG_FEM_OBSERVABLE_H_EX),exchange_field_oracle(initial),1e-9,"initial H_ex oracle");
        check_energy(initial_stats.exchange_energy_joules,exchange_energy_oracle(initial));
        step(h.get(),gpu);const Vec m=field(h.get(),FULLMAG_FEM_OBSERVABLE_M);
        compare(field(h.get(),FULLMAG_FEM_OBSERVABLE_H_EX),exchange_field_oracle(m),1e-9,"stepped H_ex oracle");
        check_energy(snapshot(h.get()).exchange_energy_joules,exchange_energy_oracle(m));
        if(marker==1)baseline=m;else compare(m,baseline,1e-10,"canonical label changed trajectory");
        double energy[2]{};constexpr double epsilon=1e-6;
        for(int side=0;side<2;++side){Vec perturbed=initial;const double sign=side==0?-1:1;
            for(size_t i=0;i<12;++i)perturbed[i]+=sign*epsilon*tangent[i];
            for(size_t i=0;i<4;++i){double n=0;for(size_t c=0;c<3;++c)n+=perturbed[3*i+c]*perturbed[3*i+c];n=std::sqrt(n);for(size_t c=0;c<3;++c)perturbed[3*i+c]/=n;}
            require(fullmag_fem_backend_upload_magnetization_f64(h.get(),perturbed.data(),perturbed.size())==FULLMAG_FEM_OK,error(h.get()));
            energy[side]=snapshot(h.get()).exchange_energy_joules;}
        const Vec expected_h=exchange_field_oracle(initial);double derivative=0;
        for(size_t i=0;i<12;++i)derivative-=mu0*ms*(edge*edge*edge/24)*tangent[i]*expected_h[i];
        std::printf("regional_marker_derivative measured_J=%.17g expected_J=%.17g epsilon=%.17g tolerance=1e-6\n",(energy[1]-energy[0])/(2*epsilon),derivative,epsilon);
        require(std::abs((energy[1]-energy[0])/(2*epsilon)-derivative)<=1e-6*std::max(std::abs(derivative),1e-30),"exchange E directional derivative");
    }
    std::printf("regional_marker_exchange lane=%s high_u32=passed H_E_derivative=passed strict_step=passed\n",gpu?"gpu-double":"cpu-double");
}

void selector_cases(bool gpu)
{
    for(auto bc:{FULLMAG_FEM_DEMAG_AIRBOX_ROBIN,FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET}){
        Fixture low({1u});std::fill(low.source.facet_markers.begin(),low.source.facet_markers.end(),99u);
        auto p=plan(low,initial,gpu);p.enable_demag=1;p.demag_realization=bc;p.poisson_boundary_marker=99;p.robin_beta_mode=2;p.robin_beta_factor=2;
        fullmag_fem_plan_desc_v3 legacy{};legacy.abi_version=FULLMAG_FEM_PLAN_DESC_V3_ABI_VERSION;legacy.struct_size=sizeof(legacy);
        legacy.base.abi_version=FULLMAG_FEM_PLAN_DESC_V2_ABI_VERSION;legacy.base.struct_size=sizeof(legacy.base);legacy.base.base=p;
        Vec reference{};double reference_energy=0;
        {auto h=own(fullmag_fem_backend_create_v4(&legacy,nullptr));step(h.get(),gpu);reference=field(h.get(),FULLMAG_FEM_OBSERVABLE_H_DEMAG);reference_energy=snapshot(h.get()).demag_energy_joules;}
        Fixture high({UINT32_MAX});auto high_p=plan(high,initial,gpu);high_p.enable_demag=1;high_p.demag_realization=bc;
        high_p.poisson_boundary_marker=-1;high_p.robin_beta_mode=2;high_p.robin_beta_factor=2;
        fullmag_fem_plan_desc_v4 extended{};extended.abi_version=FULLMAG_FEM_PLAN_DESC_V4_ABI_VERSION;extended.struct_size=sizeof(extended);
        extended.base=legacy;extended.base.base.base=high_p;extended.poisson_boundary_marker=UINT32_MAX;
        {auto h=own(fullmag_fem_backend_create_v5(&extended,nullptr));require(h->context.poisson_demag.boundary_marker==static_cast<int64_t>(UINT32_MAX),"u32 selector narrowed before BC import");
            step(h.get(),gpu);compare(field(h.get(),FULLMAG_FEM_OBSERVABLE_H_DEMAG),reference,1e-7,"Poisson marker relabeling changed H_demag");
            const double energy=snapshot(h.get()).demag_energy_joules;
            require(std::abs(energy-reference_energy)<=1e-8*std::max(std::abs(reference_energy),1e-30),"Poisson marker relabeling changed energy");}
        extended.poisson_boundary_marker=2;
        require(fullmag_fem_backend_create_v5(&extended,nullptr)==nullptr,"unknown canonical boundary selector accepted");
        extended.poisson_boundary_marker=UINT32_MAX;extended.reserved=1;
        require(fullmag_fem_backend_create_v5(&extended,nullptr)==nullptr,"nonzero v4 reserved accepted");
        extended.reserved=0;--extended.struct_size;
        require(fullmag_fem_backend_create_v5(&extended,nullptr)==nullptr,"truncated v4 descriptor accepted");
        require(fullmag_fem_backend_create_v4(&extended.base,nullptr)==nullptr,"legacy negative selector reinterpreted as u32");
    }
    std::printf("regional_marker_poisson lane=%s Robin_Dirichlet=passed legacy_layout_and_refusal=passed\n",gpu?"gpu-double":"cpu-double");
}
#endif
} // namespace

void run_regional_marker_cpu_contract()
{
#if FULLMAG_HAS_MFEM_STACK
    import_cases();exchange_cases(false);selector_cases(false);
#endif
}
void run_regional_marker_gpu_contract()
{
#if FULLMAG_HAS_MFEM_STACK && FULLMAG_HAS_CUDA_RUNTIME
    exchange_cases(true);selector_cases(true);
#endif
}
