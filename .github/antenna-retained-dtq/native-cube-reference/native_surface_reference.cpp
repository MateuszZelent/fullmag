// Private CI harness for the existing surface operator; no production changes.
#include "native_surface_inputs.hpp"
#include <mfem.hpp>
#include <boost/multiprecision/cpp_int.hpp>
#include <cmath>
#include <initializer_list>
#include <vector>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/resource.h>

using namespace fullmag::fem::oersted;
namespace {
using Clock = std::chrono::steady_clock;

std::uint64_t peak_rss()
{
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) != 0 || usage.ru_maxrss <= 0 ||
        static_cast<std::uint64_t>(usage.ru_maxrss) > std::numeric_limits<std::uint64_t>::max()/1024)
        throw std::runtime_error("real lifetime peak RSS unavailable");
    return static_cast<std::uint64_t>(usage.ru_maxrss)*1024;
}
void quoted(std::ostream &out, const std::string &value)
{
    static constexpr char hex[] = "0123456789abcdef";
    out << '"';
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 0x20) out << "\\u00" << hex[c >> 4] << hex[c & 15];
        else out << c;
    }
    out << '"';
}
template<class T, std::size_t N>
void array(std::ostream &out, const std::array<T,N> &value)
{
    out << '[';
    for (std::size_t i=0; i<N; ++i) { if (i) out << ','; out << value[i]; }
    out << ']';
}
void strings(std::ostream &out, const std::array<std::string,3> &value)
{
    out << '[';
    for (std::size_t i=0; i<3; ++i) { if (i) out << ','; quoted(out,value[i]); }
    out << ']';
}
void field(std::ostream &out, const char *name, const std::string &value)
{
    out << ','; quoted(out,name); out << ':'; quoted(out,value);
}
void work(std::ostream &out, const SurfaceRt0WorkReport &r)
{
    out << "{\"total\":"; array(out,r.total);
    out << ",\"current_target\":"; array(out,r.current_target);
    out << ",\"by_precision\":[";
    for (std::size_t i=0; i<3; ++i) { if(i) out << ','; array(out,r.by_precision[i]); }
    out << ']';
#define REPORT(x) out << ",\"" #x "\":" << r.x
    REPORT(current_target_index); REPORT(maximum_raw_integer_bits);
    REPORT(maximum_reduced_fraction_bits); REPORT(last_sampled_lifetime_peak_rss_bytes);
    REPORT(elapsed_seconds);
#undef REPORT
    out << '}';
}
void phase(std::ostream &out, const SurfaceRt0PhaseReport &r)
{
    out << "{\"wall_time_ns\":"; array(out,r.wall_time_ns);
    out << ",\"total_wall_time_ns\":" << r.total_wall_time_ns
        << ",\"started\":" << r.started << ",\"accounting_issue\":" << r.accounting_issue << '}';
}
void target(std::ostream &out, const SurfaceRt0TargetResult &r)
{
    out << "{\"h_xyz_apm\":"; array(out,r.h_xyz_apm);
    std::array<std::string,3> bits;
    for(std::size_t i=0; i<3; ++i) {
        std::ostringstream text; text.imbue(std::locale::classic());
        text << std::hexfloat << r.h_xyz_apm[i]; bits[i]=text.str();
    }
    out << ",\"h_xyz_apm_hex\":"; strings(out,bits);
    out << ",\"precisions\":[";
    for(std::size_t i=0; i<3; ++i) {
        if(i) out << ','; const auto &p=r.precisions[i];
        out << "{\"evaluated\":" << p.evaluated;
        field(out,"refusal_reason",p.refusal_reason);
        out << ",\"h_xyz_apm\":"; strings(out,p.h_xyz_apm);
        out << ",\"whole_h_xyz_apm\":"; strings(out,p.whole_h_xyz_apm);
        field(out,"sum_local_norm_apm",p.sum_local_norm_apm);
        field(out,"cancellation",p.cancellation);
        field(out,"maximum_face_cancellation",p.maximum_face_cancellation);
        out << '}';
    }
    out << "],\"work\":"; array(out,r.work);
    out << ",\"binary64_requires_highprecision\":" << r.binary64_requires_highprecision;
    field(out,"precision_budget_apm",r.precision_budget_apm);
    field(out,"local_precision_delta_apm",r.local_precision_delta_apm);
    field(out,"local_formula_delta_apm",r.local_formula_delta_apm);
    field(out,"local_formula_delta_80_apm",r.local_formula_delta_80_apm);
    field(out,"binary64_roundoff_indicator_apm",r.binary64_roundoff_indicator_apm);
    out << '}';
}
} // namespace


namespace {
using Affine = fullmag::fem::transport::AffineRt0Element;
using Exact = boost::multiprecision::cpp_rational;
using ExactPoint = std::array<Exact,3>;
void require(bool ok, const char *message)
{
    if (!ok) throw std::runtime_error(message);
}
Exact signed_determinant(const Affine::FrozenInput &input)
{
    std::array<ExactPoint,3> e;
    for (int i=0;i<3;++i) for (int c=0;c<3;++c)
        e[i][c]=Exact(input.vertices_m[i+1][c])-Exact(input.vertices_m[0][c]);
    return e[0][0]*(e[1][1]*e[2][2]-e[1][2]*e[2][1])+
        e[0][1]*(e[1][2]*e[2][0]-e[1][0]*e[2][2])+
        e[0][2]*(e[1][0]*e[2][1]-e[1][1]*e[2][0]);
}
std::string exact_text(const Exact &value)
{
    std::ostringstream out; out.imbue(std::locale::classic()); out << value; return out.str();
}
template<std::size_t N>
void binary(std::ostream &out,const std::array<double,N> &value)
{
    out << '[';
    for (std::size_t i=0;i<N;++i) {
        if(i) out << ',';
        std::ostringstream text; text.imbue(std::locale::classic());
        text << std::hexfloat << value[i]; quoted(out,text.str());
    }
    out << ']';
}
std::vector<Affine::FrozenInput> prepare_sources(std::vector<Affine::Point> &targets)
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mfem::RT_FECollection collection(0, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::GridFunction current(&space);
    mfem::Vector vector(3);
    vector = 0.0;
    vector[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(vector);
    current.ProjectCoefficient(coefficient);
    require(mesh.GetNE()==6,"source setup: exactly six Tet4 required");
    std::vector<Affine::FrozenInput> sources;
    for(int e=0;e<mesh.GetNE();++e) sources.push_back(Affine(current,e).frozen_input());
    const auto &points=sources.front().vertices_m;
    const auto average = [&](std::initializer_list<int> indices) {
        Affine::Point result{0.0,0.0,0.0};
        for(const int index:indices) for(int c=0;c<3;++c) result[c]+=points[index][c];
        const double scale=1.0/static_cast<double>(indices.size());
        for(double &c:result) c*=scale;
        return result;
    };
    targets={average({0,1,2,3}),average({0,1,2}),average({0,1})};
    bool geometry_ok=true, current_ok=true;
    Exact volume=0;
    std::cout << "NATIVE_CUBE_INPUT={\"source_count\":" << sources.size()
        << ",\"source_authentication\":\"synthetic caller binding; NOT accepted-source authentication\""
        << ",\"synthetic_caller_digest_hex\":\"85fe50fbdaa901d91163b6bc49a96753d643c0f1d864271c3fc797577334e096\",\"sources\":[";
    for(std::size_t e=0;e<sources.size();++e) {
        const auto &input=sources[e];
        if(e) std::cout << ',';
        const Exact signed_det=signed_determinant(input);
        Exact det=signed_det;
        if(det<0) det=-det;
        require(det!=0,"source setup: degenerate Tet4");
        volume+=det/6;
        Exact b=0;
        ExactPoint a{{0,0,0}};
        for(int i=0;i<4;++i) {
            require(std::isfinite(input.signed_coefficients_a[i]),"source setup: nonfinite coefficient");
            b+=Exact(input.signed_coefficients_a[i]);
            for(int c=0;c<3;++c) a[c]-=Exact(input.signed_coefficients_a[i])*Exact(input.vertices_m[i][c]);
        }
        b/=det;
        for(auto &c:a) c/=det;
        current_ok=current_ok && a==ExactPoint{{4,0,0}} && b==0;
        geometry_ok=geometry_ok && input.vertices_m==native_surface_inputs::expected_vertices[e];
        std::cout << "{\"element\":" << e << ",\"vertices_m\":[";
        for(int i=0;i<4;++i) {if(i) std::cout << ',';array(std::cout,input.vertices_m[i]);}
        std::cout << "],\"vertices_m_hex\":[";
        for(int i=0;i<4;++i) {if(i) std::cout << ',';binary(std::cout,input.vertices_m[i]);}
        std::cout << "],\"signed_coefficients_a\":";array(std::cout,input.signed_coefficients_a);
        std::cout << ",\"signed_coefficients_a_hex\":";binary(std::cout,input.signed_coefficients_a);
        field(std::cout,"signed_determinant_m3_exact",exact_text(signed_det));
        std::cout << ",\"affine_a_apm2_exact\":[";
        for(int c=0;c<3;++c) {if(c) std::cout << ',';quoted(std::cout,exact_text(a[c]));}
        std::cout << ']';field(std::cout,"affine_b_apm3_exact",exact_text(b));
        std::cout << '}';
    }
    bool targets_ok=targets.size()==3;
    for(std::size_t i=0;i<targets.size();++i) targets_ok=targets_ok && targets[i]==native_surface_inputs::expected_targets[i];
    std::cout << "],\"targets_m\":[";
    for(std::size_t i=0;i<targets.size();++i) {if(i) std::cout << ',';array(std::cout,targets[i]);}
    std::cout << "],\"targets_m_hex\":[";
    for(std::size_t i=0;i<targets.size();++i) {if(i) std::cout << ',';binary(std::cout,targets[i]);}
    std::cout << ']';field(std::cout,"volume_m3_exact",exact_text(volume));
    std::cout << ",\"geometry_match\":" << geometry_ok << ",\"current_match\":" << current_ok
        << ",\"targets_match\":" << targets_ok << '}' << std::endl;
    require(geometry_ok,"source setup: ordered source geometry differs from recorded cube");
    require(volume==1,"source setup: cube volume differs from one m3");
    require(current_ok,"source setup: exported RT0 is not exactly J=(4,0,0), b=0");
    require(targets_ok,"source setup: target geometry/binary64 differs");
    return sources;
}
} // namespace

int main()
{
    std::cout.imbue(std::locale::classic());
    std::cout << std::boolalpha << std::setprecision(std::numeric_limits<double>::max_digits10);
    std::vector<Affine::Point> targets;
    std::vector<Affine::FrozenInput> sources;
    try {
        sources=prepare_sources(targets);
    } catch(const std::exception &error) {
        std::cout << "NATIVE_CUBE_SETUP_REFUSED={\"reason\":";quoted(std::cout,error.what());
        std::cout << "}" << std::endl;
        return 1;
    }
    SurfaceRt0WorkReport report{};
    SurfaceRt0PhaseReport phases{};
    SurfaceRt0Result result{};
    std::string refusal;
    const auto started=Clock::now();
    try {
        result=evaluate_surface_rt0(sources,native_surface_inputs::digest,targets,
            native_surface_inputs::limits,native_surface_inputs::tolerances,peak_rss,report,&phases);
    } catch(const std::exception &error) {
        refusal=error.what();
    }
    std::cout << "NATIVE_CUBE_CALL={\"attempted_calls\":1,\"operator_version\":";
    quoted(std::cout,surface_rt0_operator_version);
    field(std::cout,"status",refusal.empty() ? "RETURNED":"REFUSED");
    field(std::cout,"refusal_reason",refusal);
    std::cout << ",\"external_elapsed_seconds\":" << std::chrono::duration<double>(Clock::now()-started).count()
        << ",\"lifetime_peak_rss_bytes\":" << peak_rss() << ",\"work_report\":";
    work(std::cout,report);
    std::cout << ",\"phase_report\":";phase(std::cout,phases);
    std::cout << ",\"targets\":[";
    for(std::size_t i=0;i<result.targets.size();++i) {if(i) std::cout << ',';target(std::cout,result.targets[i]);}
    std::cout << "]}" << std::endl;
    return refusal.empty() && result.targets.size()==3 ? 0:1;
}
