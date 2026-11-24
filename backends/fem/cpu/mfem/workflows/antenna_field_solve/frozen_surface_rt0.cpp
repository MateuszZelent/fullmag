// H-only C boundary: no MFEM transport/context ownership or source authentication.
#include "fullmag_fem.h"
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>

#if FULLMAG_HAS_MFEM_STACK
#include "cpu/mfem/workflows/antenna_field_solve/surface_rt0_io.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <optional>
#include <stdexcept>
#endif

namespace {
struct Range { std::uintptr_t begin, end; };
bool range(const void *pointer, std::uint64_t count, std::uint64_t width,
    std::size_t alignment, Range &result)
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

// No output is touched before all descriptors and recursively referenced input
// ranges are known disjoint. OS memory accessibility is the caller's contract.
bool validate_ranges(const fullmag_fem_frozen_rt0_surface_request_v1 *request,
    fullmag_fem_frozen_rt0_surface_result_v1 *result,
    fullmag_fem_surface_rt0_profile_result_v1 *profile,
    const fullmag_fem_antenna_operation_observer_v1 *observer)
{
    Range request_range{},result_range{},profile_range{},observer_range{};
    if(!range(request,1,sizeof(*request),alignof(decltype(*request)),request_range) ||
        !range(result,1,sizeof(*result),alignof(decltype(*result)),result_range) ||
        overlaps(request_range,result_range))return false;
    if(request->abi_version!=FULLMAG_FEM_FROZEN_RT0_SURFACE_ABI_VERSION ||
        request->reserved_flags || request->struct_size!=sizeof(*request) || request->reserved ||
        result->abi_version!=FULLMAG_FEM_FROZEN_RT0_SURFACE_ABI_VERSION ||
        result->reserved_flags || result->struct_size!=sizeof(*result))return false;
    if(profile && (!range(profile,1,sizeof(*profile),alignof(decltype(*profile)),profile_range) ||
        profile->abi_version!=FULLMAG_FEM_SURFACE_RT0_PROFILE_ABI_VERSION ||
        profile->reserved_flags || profile->struct_size!=sizeof(*profile)))return false;
    if(observer && (!range(observer,1,sizeof(*observer),alignof(decltype(*observer)),observer_range) ||
        observer->abi_version!=FULLMAG_FEM_ANTENNA_OPERATION_PROGRESS_ABI_VERSION ||
        observer->reserved_flags || observer->struct_size!=sizeof(*observer) || !observer->callback))return false;
    std::array<Range,4> outputs{};
    outputs[0]=result_range;
    if(!range(result->h_xyz_apm,result->h_xyz_apm_capacity,sizeof(double),alignof(double),outputs[1]) ||
        !range(result->evidence_json,result->evidence_json_capacity,1,1,outputs[2]))return false;
    const std::size_t output_count=profile ? 4 : 3;
    if(profile)outputs[3]=profile_range;
    for(std::size_t i=0;i<output_count;++i)
        for(std::size_t j=0;j<i;++j)if(overlaps(outputs[i],outputs[j]))return false;
    const auto input=[&](const void *pointer,std::uint64_t count,std::uint64_t width,std::size_t alignment){
        Range r{};if(!range(pointer,count,width,alignment,r))return false;
        for(std::size_t i=0;i<output_count;++i)if(overlaps(outputs[i],r))return false;
        return true;
    };
    // Scan each bounded string byte only after proving that byte is not output.
    const auto text=[&](const char *pointer,std::uint64_t maximum){
        if(!pointer)return false;
        const auto begin=reinterpret_cast<std::uintptr_t>(pointer);
        for(std::uint64_t i=0;i<maximum;++i){
            if(i>std::numeric_limits<std::uintptr_t>::max()-begin)return false;
            const auto *byte=reinterpret_cast<const char *>(begin+i);
            if(!input(byte,1,1,1))return false;
            if(*byte=='\0')return true;
        }return false;
    };
    return input(request,1,sizeof(*request),alignof(decltype(*request))) &&
        (!observer || input(observer,1,sizeof(*observer),alignof(decltype(*observer)))) &&
        input(request->source,request->source_count,sizeof(*request->source),alignof(decltype(*request->source))) &&
        input(request->target_points_xyz,request->target_points_xyz_len,sizeof(double),alignof(double)) &&
        text(request->source_view_identity_digest,65) && text(request->accepted_source_state_digest,65) &&
        text(request->options.policy_version,96);
}

#if FULLMAG_HAS_MFEM_STACK
void require(bool condition,const char *message)
{
    if(!condition)throw std::invalid_argument(message);
}
void publish_profile(fullmag_fem_surface_rt0_profile_result_v1 *output,
    const std::optional<fullmag::fem::oersted::SurfaceRt0PhaseReport> &report)
{
    if(!output || !report)return;
    output->available=report->started ? 1 : 0;
    output->accounting_issue=report->accounting_issue ? 1 : 0;
    output->operator_wall_time_ns=report->total_wall_time_ns;
    std::copy(report->wall_time_ns.begin(),report->wall_time_ns.end(),output->phase_wall_time_ns);
}
#endif
} // namespace

extern "C" int fullmag_fem_evaluate_frozen_rt0_surface_observed_v1(
    const fullmag_fem_frozen_rt0_surface_request_v1 *request,
    fullmag_fem_frozen_rt0_surface_result_v1 *result,
    fullmag_fem_surface_rt0_profile_result_v1 *profile,
    const fullmag_fem_antenna_operation_observer_v1 *observer)
{
    if(!validate_ranges(request,result,profile,observer))return FULLMAG_FEM_ERR_INVALID;
    result->h_xyz_apm_len=0;result->evidence_json_len=0;result->error_message[0]='\0';
    if(profile){
        profile->available=0;profile->accounting_issue=0;profile->operator_wall_time_ns=0;
        std::memset(profile->phase_wall_time_ns,0,sizeof(profile->phase_wall_time_ns));
    }
    if(request->execution_lane!=FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",
            "frozen RT0 surface supports only explicit FEM CPU double");
        return FULLMAG_FEM_ERR_INVALID;
    }
#if FULLMAG_HAS_MFEM_STACK
    namespace io=fullmag::fem::antenna_field_solve::surface_rt0_io;
    namespace oe=fullmag::fem::oersted;
    std::optional<oe::SurfaceRt0PhaseReport> phases;
    if(profile)phases.emplace();
    int status=FULLMAG_FEM_OK;
    try {
        require(result->h_xyz_apm_capacity>=request->target_points_xyz_len,
            "frozen RT0 H capacity is smaller than the ordered target buffer");
        // Includes pair/formula/copy/output lower bounds and actual peak RSS.
        // All validation precedes source/target vector reservations.
        io::validate_request(request->options,request->source_count,
            request->target_points_xyz,request->target_points_xyz_len);
        (void)io::digest(request->source_view_identity_digest);
        (void)io::digest(request->accepted_source_state_digest);
        using Frozen=fullmag::fem::transport::AffineRt0Element::FrozenInput;
        static_assert(sizeof(Frozen)==sizeof(fullmag_fem_frozen_rt0_element_v1),
            "frozen RT0 source copying must retain the reviewed byte budget");
        std::vector<Frozen> source;
        require(request->source_count<=source.max_size(),"frozen RT0 source count exceeds vector max_size");
        source.reserve(static_cast<std::size_t>(request->source_count));
        for(std::uint64_t i=0;i<request->source_count;++i){
            const auto &input=request->source[i];
            Frozen value;
            for(std::size_t j=0;j<12;++j){
                require(std::isfinite(input.vertices_m[j]),"frozen RT0 source coordinate is not finite");
                value.vertices_m[j/3][j%3]=input.vertices_m[j];
            }
            for(std::size_t j=0;j<4;++j){
                require(std::isfinite(input.signed_coefficients_a[j]),"frozen RT0 coefficient is not finite");
                value.signed_coefficients_a[j]=input.signed_coefficients_a[j];
            }
            source.push_back(value);
        }
        std::vector<std::array<double,3>> targets;
        const auto count=request->target_points_xyz_len/3;
        require(count<=targets.max_size(),"frozen RT0 target count exceeds vector max_size");
        targets.reserve(static_cast<std::size_t>(count));
        for(std::uint64_t i=0;i<request->target_points_xyz_len;i+=3)
            targets.push_back({request->target_points_xyz[i],request->target_points_xyz[i+1],request->target_points_xyz[i+2]});
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
            progress->emit(oe::AntennaProgressPhase::preparing_source,0,count,request->source_count);
        }
        io::evaluate(source,request->source_view_identity_digest,request->accepted_source_state_digest,
            targets,request->options,{result->h_xyz_apm,result->h_xyz_apm_capacity,result->h_xyz_apm_len,
                result->evidence_json,result->evidence_json_capacity,result->evidence_json_len,result->error_message},
            phases ? &*phases : nullptr,progress ? &*progress : nullptr);
    } catch(const std::domain_error &error){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",error.what());
        status=FULLMAG_FEM_ERR_UNAVAILABLE;
    } catch(const std::invalid_argument &error){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",error.what());
        status=FULLMAG_FEM_ERR_INVALID;
    } catch(const std::exception &error){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s",error.what());
        status=FULLMAG_FEM_ERR_INTERNAL;
    } catch(...){
        std::snprintf(result->error_message,sizeof(result->error_message),"%s","frozen RT0 surface raised an unknown exception");
        status=FULLMAG_FEM_ERR_INTERNAL;
    }
    publish_profile(profile,phases);
    return status;
#else
    std::snprintf(result->error_message,sizeof(result->error_message),"%s",
        "frozen RT0 surface requires FULLMAG_USE_MFEM_STACK=ON");
    return FULLMAG_FEM_ERR_UNAVAILABLE;
#endif
}
