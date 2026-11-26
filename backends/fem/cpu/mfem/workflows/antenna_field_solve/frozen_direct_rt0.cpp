// Numeric-only retained DTQ. Source ownership and normalization remain in Rust.
#include "fullmag_fem.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>

#if FULLMAG_HAS_MFEM_STACK
#include "cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp"
#include "cpu/mfem/interactions/oersted/surface_rt0.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <optional>
#include <stdexcept>
#endif

namespace {
struct Range { std::uintptr_t begin, end; };
bool range(const void *pointer,std::uint64_t count,std::uint64_t width,
    std::size_t alignment,Range &result)
{
    const auto begin=reinterpret_cast<std::uintptr_t>(pointer);
    if(!pointer || !count || !width || begin%alignment ||
        count>std::numeric_limits<std::uintptr_t>::max()/width)return false;
    const auto bytes=count*width;
    if(bytes>std::numeric_limits<std::size_t>::max() ||
        bytes>static_cast<std::uint64_t>(std::numeric_limits<std::ptrdiff_t>::max()) ||
        bytes>std::numeric_limits<std::uintptr_t>::max()-begin)return false;
    result={begin,begin+bytes};return true;
}
bool overlaps(Range a,Range b) { return a.begin<b.end && b.begin<a.end; }
bool validate_ranges(const fullmag_fem_frozen_rt0_direct_request_v1 *request,
    fullmag_fem_frozen_rt0_direct_result_v1 *result,
    const fullmag_fem_antenna_operation_observer_v1 *observer)
{
    Range q{},r{},records{},o{},source{},targets{};
    if(!range(request,1,sizeof(*request),alignof(decltype(*request)),q) ||
        !range(result,1,sizeof(*result),alignof(decltype(*result)),r) ||
        overlaps(q,r))return false;
    if(request->abi_version!=FULLMAG_FEM_FROZEN_RT0_DIRECT_ABI_VERSION ||
        request->reserved_flags || request->struct_size!=sizeof(*request) || request->reserved ||
        result->abi_version!=FULLMAG_FEM_FROZEN_RT0_DIRECT_ABI_VERSION ||
        result->reserved_flags || result->struct_size!=sizeof(*result))return false;
    if(observer && (!range(observer,1,sizeof(*observer),alignof(decltype(*observer)),o) ||
        overlaps(o,r)))return false;
    // Check overlap before reading recursively referenced descriptors.
    if(observer && (observer->abi_version!=FULLMAG_FEM_ANTENNA_OPERATION_PROGRESS_ABI_VERSION ||
        observer->reserved_flags || observer->struct_size!=sizeof(*observer) || !observer->callback))
        return false;
    if(!range(result->target_records,result->target_records_capacity,
            sizeof(*result->target_records),alignof(decltype(*result->target_records)),records) ||
        overlaps(records,r) || overlaps(records,q) || (observer && overlaps(records,o)) ||
        !range(request->source,request->source_count,sizeof(*request->source),
            alignof(decltype(*request->source)),source) ||
        !range(request->target_points_xyz,request->target_points_xyz_len,
            sizeof(double),alignof(double),targets))return false;
    return !overlaps(source,r) && !overlaps(source,records) &&
        !overlaps(targets,r) && !overlaps(targets,records);
}
#if FULLMAG_HAS_MFEM_STACK
void require(bool value,const char *message)
{
    if(!value)throw std::invalid_argument(message);
}
#endif
} // namespace

extern "C" int fullmag_fem_evaluate_frozen_rt0_direct_observed_v1(
    const fullmag_fem_frozen_rt0_direct_request_v1 *request,
    fullmag_fem_frozen_rt0_direct_result_v1 *result,
    const fullmag_fem_antenna_operation_observer_v1 *observer)
{
    if(!validate_ranges(request,result,observer))return FULLMAG_FEM_ERR_INVALID;
    result->target_records_len=0;
    std::memset(result->error_message,0,sizeof(result->error_message));
    if(request->execution_lane!=FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",
            "frozen direct RT0 supports only explicit FEM CPU double");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    namespace oe=fullmag::fem::oersted;
    using Frozen=fullmag::fem::transport::AffineRt0Element::FrozenInput;
    try {
        const oe::DirectTetraQuadratureOptions options{
            request->base_quadrature_order,request->maximum_subdivision_depth,
            request->absolute_tolerance_apm,request->relative_tolerance,
            request->maximum_source_target_pairs,
            0,
            oe::DirectTetraExecutionPolicy::CpuDeterministic};
        const auto limits=oe::DirectTetraQuadrature::ResolveWorkLimits(options);
        require(request->target_points_xyz_len%3==0,"frozen direct target XYZ framing");
        const auto count=request->target_points_xyz_len/3;
        require(count>0 && count<=1'000'000 &&
            request->source_count>0 &&
            request->source_count<=oe::DirectTetraQuadrature::maximum_final_leaves_per_target,
            "frozen direct source/target cardinality");
        require(request->source_count<=options.maximum_source_target_pairs/count,
            "frozen direct source-target pair budget exceeded");
        require(result->target_records_capacity>=count,"frozen direct record capacity");
        // Admission and all malformed-input checks precede allocation and progress.
        for(std::uint64_t i=0;i<request->target_points_xyz_len;++i)
            require(std::isfinite(request->target_points_xyz[i]),"frozen direct target is nonfinite");
        for(std::uint64_t i=0;i<request->source_count;++i){
            for(double x:request->source[i].vertices_m)
                require(std::isfinite(x),"frozen direct coordinate is nonfinite");
            for(double x:request->source[i].signed_coefficients_a)
                require(std::isfinite(x),"frozen direct coefficient is nonfinite");
        }
        static_assert(sizeof(Frozen)==sizeof(fullmag_fem_frozen_rt0_element_v1),
            "frozen direct source copy budget");
        std::vector<Frozen> source;
        require(request->source_count<=source.max_size(),"frozen direct source max_size");
        source.reserve(static_cast<std::size_t>(request->source_count));
        for(std::uint64_t i=0;i<request->source_count;++i){
            Frozen value{};
            for(std::size_t j=0;j<12;++j)value.vertices_m[j/3][j%3]=request->source[i].vertices_m[j];
            std::copy_n(request->source[i].signed_coefficients_a,4,value.signed_coefficients_a.begin());
            source.push_back(value);
        }
        std::vector<std::array<double,3>> targets;
        require(count<=targets.max_size(),"frozen direct target max_size");
        targets.reserve(static_cast<std::size_t>(count));
        for(std::uint64_t i=0;i<request->target_points_xyz_len;i+=3)
            targets.push_back({request->target_points_xyz[i],request->target_points_xyz[i+1],
                request->target_points_xyz[i+2]});
        struct Observation {
            fullmag_fem_antenna_operation_observer_v1 target;
            std::chrono::steady_clock::time_point started;
        } observation{observer ? *observer : fullmag_fem_antenna_operation_observer_v1{}, {}};
        std::optional<oe::SurfaceRt0ProgressObserver> progress;
        if(observer){
            observation.started=std::chrono::steady_clock::now();
            progress.emplace(oe::SurfaceRt0ProgressObserver{&observation,
                [](void *context,oe::AntennaProgressPhase phase,std::uint64_t completed,
                    std::uint64_t total,std::uint64_t cells) noexcept {
                    const auto &state=*static_cast<Observation *>(context);
                    const fullmag_fem_antenna_operation_progress_v1 value{
                        FULLMAG_FEM_ANTENNA_OPERATION_PROGRESS_ABI_VERSION,0,sizeof(value),
                        static_cast<std::uint32_t>(phase),0,completed,total,cells,
                        std::chrono::duration<double>(std::chrono::steady_clock::now()-state.started).count()};
                    try {state.target.callback(state.target.user_data,&value);}catch(...){}
                }});
        }
        const auto output=oe::DirectTetraQuadrature::EvaluateFrozenField(
            source,targets,options,progress ? &*progress : nullptr);
        require(output.operator_version==oe::DirectTetraQuadrature::operator_version &&
            output.source_view_identity_digest.empty() && output.h_xyz_apm.size()==count*3 &&
            output.target_diagnostics.size()==count,"frozen direct numeric output contract");
        // Publish records only after the complete operator succeeds.
        for(std::size_t i=0;i<count;++i){
            const auto &d=output.target_diagnostics[i];
            const fullmag_fem_direct_oersted_target_record_v1 row{
                {targets[i][0],targets[i][1],targets[i][2]},
                {output.h_xyz_apm[3*i],output.h_xyz_apm[3*i+1],output.h_xyz_apm[3*i+2]},
                d.estimated_error_apm,d.tolerance_apm,d.roundoff_indicator_apm,
                d.final_leaf_count,d.kernel_evaluations,d.ledger_leaf_visits};
            result->target_records[i]=row;
        }
        const auto &d=output.diagnostics;
        result->source_target_pairs=d.source_target_pairs;
        result->refined_pairs=d.refined_pairs;
        result->unconverged_pair_count=d.unconverged_pair_count;
        result->maximum_pair_error_apm=d.maximum_pair_error_apm;
        result->kernel_evaluations=d.kernel_evaluations;
        result->ledger_leaf_visits=d.ledger_leaf_visits;
        result->base_quadrature_order=options.base_quadrature_order;
        result->maximum_subdivision_depth=options.maximum_subdivision_depth;
        result->absolute_tolerance_apm=options.absolute_tolerance_apm;
        result->relative_tolerance=options.relative_tolerance;
        result->relative_scale_floor_apm=0.;
        result->maximum_source_target_pairs=options.maximum_source_target_pairs;
        result->maximum_final_leaves_per_target=oe::DirectTetraQuadrature::maximum_final_leaves_per_target;
        result->maximum_kernel_evaluations=limits.maximum_kernel_evaluations;
        result->maximum_ledger_leaf_visits=limits.maximum_ledger_leaf_visits;
        result->target_records_len=count;
        return FULLMAG_FEM_OK;
    }catch(const std::invalid_argument &error){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",error.what());
        return FULLMAG_FEM_ERR_INVALID;
    }catch(const std::exception &error){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",error.what());
        return FULLMAG_FEM_ERR_INTERNAL;
    }catch(...){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s","frozen direct RT0 unknown exception");
        return FULLMAG_FEM_ERR_INTERNAL;
    }
#else
    std::snprintf(result->error_message,sizeof(result->error_message),"%s",
        "frozen direct RT0 requires FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}
