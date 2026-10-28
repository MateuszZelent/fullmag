#include "cpu/mfem/workflows/antenna_field_solve/accepted_surface_rt0.hpp"
#include <mfem.hpp>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <locale>
#include <ostream>
#include <stdexcept>
#include <streambuf>
#if defined(__linux__)
#include <sys/resource.h>
#endif

namespace fullmag::fem::antenna_field_solve {
namespace {
using namespace oersted;
void require(bool value, const char *message)
{
    if (!value) throw std::invalid_argument(message);
}
SurfaceRt0WorkLimits limits(const fullmag_fem_surface_rt0_work_limits_v1 &x)
{
    SurfaceRt0WorkLimits r;
    std::copy_n(x.total, surface_rt0_work_kind_count, r.total.begin());
    std::copy_n(x.per_target, surface_rt0_work_kind_count, r.per_target.begin());
    r.maximum_raw_integer_bits=x.maximum_raw_integer_bits;
    r.maximum_reduced_fraction_bits=x.maximum_reduced_fraction_bits;
    r.maximum_lifetime_peak_rss_bytes=x.maximum_lifetime_peak_rss_bytes;
    r.guard_interval_events=x.guard_interval_events;
    r.maximum_total_seconds=x.maximum_total_seconds;
    r.maximum_target_seconds=x.maximum_target_seconds;
    return r;
}
SurfaceRt0Tolerances tolerances(const fullmag_fem_surface_rt0_tolerances_v1 &x)
{
    return {x.absolute_field_apm,x.relative_field,x.cancellation_floor_apm,
        x.scalar_relative_80,x.scalar_relative_120,x.angle_relative_80,x.angle_relative_120,
        x.binary_scalar_epsilon_factor,x.binary_roundoff_epsilon_factor,
        x.binary_cancellation_limit,x.highprecision_cancellation_limit};
}
std::array<std::uint8_t,32> digest(const char *text)
{
    require(text && std::strlen(text)==64,"surface RT0 source digest must contain 64 hex digits");
    const auto nibble=[](char c)->unsigned {
        if(c>='0' && c<='9')return c-'0';
        if(c>='a' && c<='f')return c-'a'+10;
        throw std::invalid_argument("surface RT0 source digest must be lowercase hexadecimal");
    };
    std::array<std::uint8_t,32> result{};
    for(std::size_t i=0;i<32;++i)result[i]=static_cast<std::uint8_t>((nibble(text[2*i])<<4)|nibble(text[2*i+1]));
    return result;
}
std::uint64_t peak_rss()
{
#if defined(__linux__)
    rusage usage{};
    if(getrusage(RUSAGE_SELF,&usage)!=0 || usage.ru_maxrss<=0 ||
        static_cast<std::uint64_t>(usage.ru_maxrss)>std::numeric_limits<std::uint64_t>::max()/1024)
        throw std::runtime_error("surface RT0 lifetime peak RSS measurement failed");
    return static_cast<std::uint64_t>(usage.ru_maxrss)*1024;
#else
    throw std::domain_error("surface RT0 lifetime peak RSS is unsupported on this platform");
#endif
}
// Bounded staging prevents serialization from silently allocating beyond the
// caller's evidence capacity. Nothing reaches caller buffers before completion.
class BoundedJson final : public std::streambuf {
public:
    explicit BoundedJson(std::uint64_t capacity):capacity_(capacity) {}
    const std::string &text() const {return text_;}
protected:
    std::streamsize xsputn(const char *s,std::streamsize n) override {
        if(n<0 || static_cast<std::uint64_t>(n)>capacity_-text_.size())
            throw std::length_error("surface RT0 evidence JSON capacity is too small");
        text_.append(s,static_cast<std::size_t>(n));return n;
    }
    int_type overflow(int_type c) override {
        if(traits_type::eq_int_type(c,traits_type::eof()))return traits_type::not_eof(c);
        const char value=traits_type::to_char_type(c);xsputn(&value,1);return c;
    }
private:
    std::uint64_t capacity_;
    std::string text_;
};
void quoted(std::ostream &out,const std::string &s)
{
    static constexpr char hex[]="0123456789abcdef";
    out << '"';
    for(unsigned char c:s) {
        if(c=='"' || c=='\\')out << '\\' << c;
        else if(c<0x20)out << "\\u00" << hex[c>>4] << hex[c&15];
        else out << c;
    }
    out << '"';
}
template<class T,std::size_t N> void array(std::ostream &out,const std::array<T,N> &a)
{
    out << '[';
    for(std::size_t i=0;i<N;++i){if(i)out << ',';out << a[i];}
    out << ']';
}
void strings(std::ostream &out,const std::array<std::string,3> &a)
{
    out << '[';
    for(std::size_t i=0;i<3;++i){if(i)out << ',';quoted(out,a[i]);}
    out << ']';
}
void key(std::ostream &out,const char *name,const std::string &value)
{
    out << ',';quoted(out,name);out << ':';quoted(out,value);
}
void serialize(std::ostream &out,const SurfaceRt0Result &value,const SurfaceRt0WorkReport &work,
    const SurfaceRt0WorkLimits &l,const SurfaceRt0Tolerances &t,
    const std::vector<std::array<double,3>> &targets,const char *policy,
    const std::string &view_digest,const char *accepted_digest)
{
    out << "{\"schema_version\":\"fem_rt0_surface_snapshot.v1\"";
    key(out,"operator_version",surface_rt0_operator_version);
    key(out,"basis_version",transport::AffineRt0Element::operator_version);
    key(out,"policy_version",policy);key(out,"source_view_identity_digest",view_digest);
    key(out,"accepted_source_state_digest",accepted_digest);
    out << ",\"inspection_only\":true,\"error_certificate_available\":false,\"targets_xyz_m\":[";
    for(std::size_t i=0;i<targets.size();++i){if(i)out << ',';array(out,targets[i]);}
    out << "],\"limits\":{\"total\":";array(out,l.total);
    out << ",\"per_target\":";array(out,l.per_target);
#define FIELD(x) out << ",\"" #x "\":" << l.x
    FIELD(maximum_raw_integer_bits);FIELD(maximum_reduced_fraction_bits);
    FIELD(maximum_lifetime_peak_rss_bytes);FIELD(guard_interval_events);
    FIELD(maximum_total_seconds);FIELD(maximum_target_seconds);
#undef FIELD
    out << "},\"tolerances\":{\"absolute_field_apm\":" << t.absolute_field_apm;
#define FIELD(x) out << ",\"" #x "\":" << t.x
    FIELD(relative_field);FIELD(cancellation_floor_apm);FIELD(scalar_relative_80);FIELD(scalar_relative_120);
    FIELD(angle_relative_80);FIELD(angle_relative_120);FIELD(binary_scalar_epsilon_factor);
    FIELD(binary_roundoff_epsilon_factor);FIELD(binary_cancellation_limit);FIELD(highprecision_cancellation_limit);
#undef FIELD
    out << "},\"work_report\":{\"total\":";array(out,work.total);
    out << ",\"current_target\":";array(out,work.current_target);
    out << ",\"by_precision\":[";
    for(std::size_t i=0;i<3;++i){if(i)out << ',';array(out,work.by_precision[i]);}
    out << ']';
#define FIELD(x) out << ",\"" #x "\":" << work.x
    FIELD(current_target_index);FIELD(maximum_raw_integer_bits);FIELD(maximum_reduced_fraction_bits);
    FIELD(last_sampled_lifetime_peak_rss_bytes);FIELD(elapsed_seconds);
#undef FIELD
    out << "},\"targets\":[";
    for(std::size_t i=0;i<value.targets.size();++i){
        if(i)out << ',';const auto &r=value.targets[i];
        out << "{\"h_xyz_apm\":";array(out,r.h_xyz_apm);out << ",\"precisions\":[";
        for(std::size_t j=0;j<3;++j){
            if(j)out << ',';const auto &p=r.precisions[j];
            out << "{\"evaluated\":" << (p.evaluated?"true":"false");
            key(out,"refusal_reason",p.refusal_reason);out << ",\"h_xyz_apm\":";strings(out,p.h_xyz_apm);
            out << ",\"whole_h_xyz_apm\":";strings(out,p.whole_h_xyz_apm);
            key(out,"sum_local_norm_apm",p.sum_local_norm_apm);key(out,"cancellation",p.cancellation);
            key(out,"maximum_face_cancellation",p.maximum_face_cancellation);out << '}';
        }
        out << "],\"work\":";array(out,r.work);
        out << ",\"binary64_requires_highprecision\":" << (r.binary64_requires_highprecision?"true":"false");
        key(out,"precision_budget_apm",r.precision_budget_apm);
        key(out,"local_precision_delta_apm",r.local_precision_delta_apm);
        key(out,"local_formula_delta_apm",r.local_formula_delta_apm);
        key(out,"local_formula_delta_80_apm",r.local_formula_delta_80_apm);
        key(out,"binary64_roundoff_indicator_apm",r.binary64_roundoff_indicator_apm);out << '}';
    }
    out << "]}";
}
} // namespace

void validate_surface_rt0_request(const fullmag_fem_prepared_closed_loop_rt0_surface_request_v1 &r)
{
    static_assert(surface_rt0_work_kind_count==FULLMAG_FEM_SURFACE_RT0_WORK_KIND_COUNT);
    const auto l=limits(r.options.work_limits);const auto t=tolerances(r.options.tolerances);
    require(r.options.policy_version && r.options.policy_version[0] &&
        std::strlen(r.options.policy_version)<96,"surface RT0 requires a bounded explicit policy version");
    for(const auto *p=reinterpret_cast<const unsigned char *>(r.options.policy_version);*p;++p)
        require(*p>=0x21 && *p<=0x7e,"surface RT0 policy version must be a printable ASCII identifier");
    for(std::size_t i=0;i<surface_rt0_work_kind_count;++i)
        require(l.total[i]>0 && l.per_target[i]>0,"surface RT0 requires every named work limit");
    require(l.maximum_raw_integer_bits && l.maximum_reduced_fraction_bits &&
        l.maximum_lifetime_peak_rss_bytes && l.guard_interval_events &&
        std::isfinite(l.maximum_total_seconds) && l.maximum_total_seconds>0 &&
        std::isfinite(l.maximum_target_seconds) && l.maximum_target_seconds>0,
        "surface RT0 requires positive finite resource limits");
    const std::array<double,11> ts{{t.absolute_field_apm,t.relative_field,t.cancellation_floor_apm,
        t.scalar_relative_80,t.scalar_relative_120,t.angle_relative_80,t.angle_relative_120,
        t.binary_scalar_epsilon_factor,t.binary_roundoff_epsilon_factor,
        t.binary_cancellation_limit,t.highprecision_cancellation_limit}};
    for(double x:ts)require(std::isfinite(x) && x>0,"surface RT0 requires positive finite tolerances");
    require(r.target_points_xyz && r.target_points_xyz_len>0 && r.target_points_xyz_len%3==0,
        "surface RT0 ordered targets are empty or malformed");
    for(std::uint64_t i=0;i<r.target_points_xyz_len;++i)
        require(std::isfinite(r.target_points_xyz[i]),"surface RT0 target is not finite");
    const auto cells=r.rt0.base.mesh.cell_types_len,targets=r.target_points_xyz_len/3;
    require(cells>0,"surface RT0 source mesh is empty");
    const std::array<std::uint64_t,4> multipliers{{1,12,12,36}};
    for(std::size_t i=0;i<4;++i)
        require(cells<=l.per_target[i]/multipliers[i] &&
            cells<=l.total[i]/multipliers[i]/targets,
            "surface RT0 mandatory precision/formula work exceeds caller limits");
    const auto copy_limit=l.total[static_cast<std::size_t>(SurfaceRt0WorkKind::copied_input_bytes)];
    require(cells<=copy_limit/sizeof(transport::AffineRt0Element::FrozenInput),
        "surface RT0 frozen source copy exceeds caller byte limit");
    require(targets<=(copy_limit-cells*sizeof(transport::AffineRt0Element::FrozenInput))/sizeof(std::array<double,3>),
        "surface RT0 ordered target copy exceeds caller byte limit");
    require(targets<=l.total[static_cast<std::size_t>(SurfaceRt0WorkKind::reserved_output_bytes)]/sizeof(SurfaceRt0TargetResult),
        "surface RT0 result reservation exceeds caller byte limit");
    require(peak_rss()<=l.maximum_lifetime_peak_rss_bytes,"surface RT0 process peak RSS exceeds caller limit");
}

void evaluate_accepted_surface_rt0(const transport::ConservativeCurrentView &view,
    const char *accepted_source_state_digest,
    const fullmag_fem_prepared_closed_loop_rt0_surface_request_v1 &request,
    fullmag_fem_prepared_closed_loop_rt0_surface_result_v1 &result,
    SurfaceRt0PhaseReport *phase_report,
    const SurfaceRt0ProgressObserver *observer)
{
    const auto source_digest=digest(view.identity().view_identity_digest.c_str());
    (void)digest(accepted_source_state_digest);
    const auto l=limits(request.options.work_limits);
    const auto t=tolerances(request.options.tolerances);
    const auto count=static_cast<std::uint64_t>(view.space().GetMesh()->GetNE());
    require(count<=l.total[static_cast<std::size_t>(SurfaceRt0WorkKind::copied_input_bytes)]/
        sizeof(transport::AffineRt0Element::FrozenInput),"surface RT0 frozen source copy exceeds caller byte limit");
    std::vector<transport::AffineRt0Element::FrozenInput> source;
    source.reserve(static_cast<std::size_t>(count));
    for(int i=0;i<view.space().GetMesh()->GetNE();++i)
        source.push_back(transport::AffineRt0Element(view.field(),i).frozen_input());
    std::vector<std::array<double,3>> targets;
    targets.reserve(static_cast<std::size_t>(request.target_points_xyz_len/3));
    for(std::uint64_t i=0;i<request.target_points_xyz_len;i+=3)
        targets.push_back({request.target_points_xyz[i],request.target_points_xyz[i+1],request.target_points_xyz[i+2]});
    SurfaceRt0WorkReport report;
    const auto evaluated=evaluate_surface_rt0(source,source_digest,targets,l,t,peak_rss,report,phase_report,observer);
    BoundedJson buffer(result.evidence_json_capacity);std::ostream out(&buffer);
    out.exceptions(std::ios::badbit|std::ios::failbit);out.imbue(std::locale::classic());
    out << std::setprecision(std::numeric_limits<double>::max_digits10);
    serialize(out,evaluated,report,l,t,targets,request.options.policy_version,
        view.identity().view_identity_digest,accepted_source_state_digest);
    require(evaluated.targets.size()==targets.size() && result.h_xyz_apm_capacity>=request.target_points_xyz_len,
        "surface RT0 returned field count differs from caller capacity");
    for(std::size_t i=0;i<evaluated.targets.size();++i)
        std::copy(evaluated.targets[i].h_xyz_apm.begin(),evaluated.targets[i].h_xyz_apm.end(),result.h_xyz_apm+3*i);
    std::copy(buffer.text().begin(),buffer.text().end(),result.evidence_json);
    result.h_xyz_apm_len=request.target_points_xyz_len;
    result.evidence_json_len=buffer.text().size();result.error_message[0]='\0';
}
} // namespace fullmag::fem::antenna_field_solve
