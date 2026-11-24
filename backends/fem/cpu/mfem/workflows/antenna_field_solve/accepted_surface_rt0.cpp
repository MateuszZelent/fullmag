#include "cpu/mfem/workflows/antenna_field_solve/accepted_surface_rt0.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/surface_rt0_io.hpp"
#include <mfem.hpp>
#include <stdexcept>

namespace fullmag::fem::antenna_field_solve {
void validate_surface_rt0_request(const fullmag_fem_prepared_closed_loop_rt0_surface_request_v1 &r)
{
    surface_rt0_io::validate_request(r.options,r.rt0.base.mesh.cell_types_len,
        r.target_points_xyz,r.target_points_xyz_len);
}

void evaluate_accepted_surface_rt0(const transport::ConservativeCurrentView &view,
    const char *accepted_source_state_digest,
    const fullmag_fem_prepared_closed_loop_rt0_surface_request_v1 &request,
    fullmag_fem_prepared_closed_loop_rt0_surface_result_v1 &result,
    oersted::SurfaceRt0PhaseReport *phase_report,
    const oersted::SurfaceRt0ProgressObserver *observer)
{
    // Preserve the old source validation and copying before entering shared IO.
    (void)surface_rt0_io::digest(view.identity().view_identity_digest.c_str());
    (void)surface_rt0_io::digest(accepted_source_state_digest);
    const auto l=surface_rt0_io::limits(request.options.work_limits);
    const auto count=static_cast<std::uint64_t>(view.space().GetMesh()->GetNE());
    if(count>l.total[static_cast<std::size_t>(oersted::SurfaceRt0WorkKind::copied_input_bytes)]/
        sizeof(transport::AffineRt0Element::FrozenInput))
        throw std::invalid_argument("surface RT0 frozen source copy exceeds caller byte limit");
    std::vector<transport::AffineRt0Element::FrozenInput> source;
    source.reserve(static_cast<std::size_t>(count));
    for(int i=0;i<view.space().GetMesh()->GetNE();++i)
        source.push_back(transport::AffineRt0Element(view.field(),i).frozen_input());
    std::vector<std::array<double,3>> targets;
    targets.reserve(static_cast<std::size_t>(request.target_points_xyz_len/3));
    for(std::uint64_t i=0;i<request.target_points_xyz_len;i+=3)
        targets.push_back({request.target_points_xyz[i],request.target_points_xyz[i+1],request.target_points_xyz[i+2]});
    surface_rt0_io::evaluate(source,view.identity().view_identity_digest,accepted_source_state_digest,
        targets,request.options,{result.h_xyz_apm,result.h_xyz_apm_capacity,result.h_xyz_apm_len,
            result.evidence_json,result.evidence_json_capacity,result.evidence_json_len,result.error_message},
        phase_report,observer);
}
} // namespace fullmag::fem::antenna_field_solve
