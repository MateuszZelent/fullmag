#include "fullmag/fdm/transport/gpu_abi_v1.h"
#include "../gpu/cuda/transport/charge/checkpoint_codec.hpp"
#include "../gpu/cuda/transport/spin/checkpoint_codec.hpp"

#include <openssl/sha.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#ifndef FULLMAG_SOURCE_ROOT
#error "FULLMAG_SOURCE_ROOT must point at the repository root"
#endif

namespace {
void check(bool condition, const char *message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        std::exit(1);
    }
}

uint16_t u16(const uint8_t *p) {
    return uint16_t(p[0]) | (uint16_t(p[1]) << 8);
}

uint32_t u32(const uint8_t *p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
           (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

uint64_t u64(const uint8_t *p) {
    uint64_t value = 0;
    for (size_t i = 0; i < 8; ++i) value |= uint64_t(p[i]) << (8 * i);
    return value;
}

void put_u32(uint8_t *p, uint32_t value) {
    for (size_t i = 0; i < 4; ++i) p[i] = uint8_t(value >> (8 * i));
}

void put_u64(uint8_t *p, uint64_t value) {
    for (size_t i = 0; i < 8; ++i) p[i] = uint8_t(value >> (8 * i));
}

void digest(const uint8_t *data, size_t size, uint8_t *out) {
    SHA256(data, size, out);
}

std::vector<uint8_t> frozen_hex(const char *begin_marker, const char *end_marker) {
    std::ifstream input(std::string(FULLMAG_SOURCE_ROOT) +
                        "/docs/specs/spin-transport-runtime-contract-v1.md");
    check(input.good(), "frozen runtime specification must be readable");
    const std::string text((std::istreambuf_iterator<char>(input)), {});
    const size_t begin = text.find(begin_marker);
    const size_t end = text.find(end_marker, begin);
    check(begin != std::string::npos && end != std::string::npos,
          "checkpoint golden markers must exist");
    std::vector<uint8_t> bytes;
    int high = -1;
    for (size_t i = begin + std::strlen(begin_marker); i < end; ++i) {
        const char c = text[i];
        const int digit = c >= '0' && c <= '9' ? c - '0' :
                          c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                          c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (digit < 0) continue;
        if (high < 0) high = digit;
        else {
            bytes.push_back(uint8_t((high << 4) | digit));
            high = -1;
        }
    }
    check(high < 0, "golden hex must contain complete bytes");
    return bytes;
}

std::vector<uint8_t> spin_fixture() {
    namespace charge = fullmag::fdm::gpu::transport::charge;
    namespace spin = fullmag::fdm::gpu::transport::spin;
    charge::CheckpointData c{};
    c.grid = {2, 1, 1}; c.cell_size = {1.0, 1.0, 1.0};
    c.compute_major = 8; c.compute_minor = 9; c.cuda_driver = 13010;
    c.cuda_runtime = 12040; c.descriptor_revision = 3; c.source_revision = 4;
    c.operator_revision = 5; c.accepted_sequence = 7; c.iterations = 2;
    c.convergence_reason = FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
    c.active = {1, 1}; c.conductivity = {1.0, 1.0}; c.potential = {1.25, 0.75};
    c.jx.assign(3, 0.0); c.jy.assign(4, 0.0); c.jz.assign(4, 0.0);
    c.interface_source_ids = {41};
    c.interface_topology_ids = {7};
    c.interface_axes = {0};
    c.interface_face_linear = {1};
    c.interface_negative_cells = {0};
    c.interface_positive_cells = {1};
    c.interface_from_cells = {0};
    c.interface_to_cells = {1};
    c.interface_orientations = {1};
    c.interface_from_trace_v = {1.25};
    c.interface_to_trace_v = {0.75};
    c.interface_delta_trace_v = {0.5};
    c.interface_charge_current_density = {0.0};
    c.device_uuid.fill(0x30);
    c.build_digest.fill(0x31); c.static_digest.fill(0x32); c.lineage.fill(0x33);
    std::vector<uint8_t> charge_payload;
    check(charge::build_checkpoint(&c, &charge_payload),
          "charge runtime codec must build immutable interface traces");
    charge::CheckpointData charge_parsed{};
    check(charge::parse_checkpoint(charge_payload.data(), charge_payload.size(),
                                   &charge_parsed) &&
              charge_parsed.interface_from_trace_v == c.interface_from_trace_v &&
              charge_parsed.interface_to_trace_v == c.interface_to_trace_v &&
              charge_parsed.interface_delta_trace_v == c.interface_delta_trace_v &&
              charge_parsed.device_uuid == c.device_uuid &&
              charge_parsed.build_digest == c.build_digest &&
              charge_parsed.static_digest == c.static_digest &&
              charge_parsed.lineage == c.lineage,
          "charge checkpoint must preserve immutable accepted charge traces");
    spin::SpinCheckpointData s{};
    s.source_revision = c.source_revision; s.operator_revision = 6;
    s.preconditioner_revision = 7; s.iterations = 3; s.work_budget = 9;
    s.mu_s = {0.1, 0.2, 0.3, 0.4, 0.5, 0.6};
    s.qx.assign(9, 0.0); s.qy.assign(12, 0.0); s.qz.assign(12, 0.0);
    for (auto &values : s.reactions) values = {0.0, 0.0};
    for (auto &values : s.torque) values = {0.0, 0.0};
    s.interface_source_ids = {41}; s.interface_topology_ids = {7};
    s.interface_axes = {0}; s.interface_face_linear = {1};
    s.interface_negative_cells = {0}; s.interface_positive_cells = {1};
    s.interface_from_cells = {0}; s.interface_to_cells = {1};
    s.interface_orientations = {1};
    for (auto &values : s.interface_values) values = {0.0};
    s.warm_iterate = s.mu_s;
    std::vector<uint8_t> payload;
    check(spin::build_checkpoint(c, s, &payload),
          "spin runtime codec must build one canonical payload");
    spin::SpinCheckpointData parsed{};
    check(spin::parse_checkpoint(payload.data(), payload.size(), &parsed) &&
              parsed.source_revision == s.source_revision &&
              parsed.operator_revision == s.operator_revision &&
              parsed.mu_s == s.mu_s && parsed.qx == s.qx && parsed.qy == s.qy &&
              parsed.qz == s.qz &&
              parsed.reactions == s.reactions && parsed.torque == s.torque &&
              parsed.interface_source_ids == s.interface_source_ids &&
              parsed.interface_topology_ids == s.interface_topology_ids &&
              parsed.interface_axes == s.interface_axes &&
              parsed.interface_face_linear == s.interface_face_linear &&
              parsed.interface_negative_cells == s.interface_negative_cells &&
              parsed.interface_positive_cells == s.interface_positive_cells &&
              parsed.interface_from_cells == s.interface_from_cells &&
              parsed.interface_to_cells == s.interface_to_cells &&
              parsed.interface_orientations == s.interface_orientations &&
              parsed.interface_values == s.interface_values &&
              parsed.warm_iterate == s.warm_iterate &&
              parsed.spin_digest == s.spin_digest &&
              parsed.warm_start_digest == s.warm_start_digest &&
              parsed.continuation_digest == s.continuation_digest,
          "spin runtime codec must parse its canonical payload");
    return payload;
}

void rehash(std::vector<uint8_t> &bytes) {
    const uint32_t count = u32(bytes.data() + 24);
    std::vector<uint8_t> ordered;
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *descriptor = bytes.data() + 320 + 96 * i;
        const uint64_t offset = u64(descriptor + 24);
        const uint64_t length = u64(descriptor + 32);
        digest(bytes.data() + offset, size_t(length), descriptor + 48);
        ordered.insert(ordered.end(), bytes.begin() + offset,
                       bytes.begin() + offset + length);
    }
    digest(bytes.data() + 320, size_t(count) * 96, bytes.data() + 208);
    digest(ordered.data(), ordered.size(), bytes.data() + 240);
    std::memset(bytes.data() + 272, 0, 32);
    digest(bytes.data(), bytes.size(), bytes.data() + 272);
}

uint8_t *section(std::vector<uint8_t> &bytes, uint32_t id) {
    const uint32_t count = u32(bytes.data() + 24);
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *descriptor = bytes.data() + 320 + 96 * i;
        if (u32(descriptor) == id) return bytes.data() + u64(descriptor + 24);
    }
    return nullptr;
}

uint8_t *descriptor(std::vector<uint8_t> &bytes, uint32_t id) {
    const uint32_t count = u32(bytes.data() + 24);
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *candidate = bytes.data() + 320 + 96 * i;
        if (u32(candidate) == id) return candidate;
    }
    return nullptr;
}

uint8_t *field_data(uint8_t *record, uint16_t field_id) {
    const uint32_t count = u32(record + 4);
    for (uint32_t i = 0; i < count; ++i) {
        uint8_t *field = record + 16 + 32 * i;
        if (u16(field) == field_id) return record + u64(field + 16);
    }
    return nullptr;
}

uint32_t validate(std::vector<uint8_t> &bytes, uint32_t *kind) {
    return fullmag_fdm_gpu_transport_checkpoint_validate_v1(
        bytes.data(), bytes.size(), kind);
}

void rehash_legacy_charge(std::vector<uint8_t> &bytes) {
    std::memset(field_data(section(bytes,1),5),0x44,32);
    std::vector<uint8_t> snapshot;
    for(uint32_t id=1;id<=9;++id){
        uint8_t *d=descriptor(bytes,id);const uint64_t length=u64(d+32);
        uint8_t *s=section(bytes,id);snapshot.insert(snapshot.end(),s,s+length);
    }
    digest(snapshot.data(),snapshot.size(),bytes.data()+176);
    uint8_t *continuation_digest=field_data(section(bytes,20),7);
    std::memset(continuation_digest,0,32);
    std::vector<uint8_t> continuation(bytes.begin()+176,bytes.begin()+208);
    for(uint32_t id:{18U,20U}){
        uint8_t *d=descriptor(bytes,id);const uint64_t length=u64(d+32);
        uint8_t *s=section(bytes,id);continuation.insert(continuation.end(),s,s+length);
    }
    digest(continuation.data(),continuation.size(),continuation_digest);
    rehash(bytes);
}
}  // namespace

int main() {
    auto codec = frozen_hex("FMGPUTR1_GOLDEN_HEX_BEGIN", "FMGPUTR1_GOLDEN_HEX_END");
    auto restore = frozen_hex("FMGPUTR1_RESTORE_GOLDEN_HEX_BEGIN",
                              "FMGPUTR1_RESTORE_GOLDEN_HEX_END");
    auto spin_restore = spin_fixture();
    namespace charge = fullmag::fdm::gpu::transport::charge;
    charge::CheckpointData trace_a{};
    trace_a.grid = {2, 2, 2}; trace_a.cell_size = {1.0, 2.0, 3.0};
    trace_a.active.assign(8, 1); trace_a.conductivity.assign(8, 1.0);
    trace_a.potential.assign(8, 0.0);
    trace_a.jx.assign(12, 0.0); trace_a.jy.assign(12, 0.0); trace_a.jz.assign(12, 0.0);
    trace_a.interface_source_ids = {42, 41}; trace_a.interface_topology_ids = {8, 7};
    trace_a.interface_axes = {2, 1}; trace_a.interface_face_linear = {7, 2};
    trace_a.interface_negative_cells = {3, 0}; trace_a.interface_positive_cells = {7, 2};
    trace_a.interface_from_cells = {7, 0}; trace_a.interface_to_cells = {3, 2};
    trace_a.interface_orientations = {-1, 1};
    trace_a.interface_from_trace_v = {0.25, 1.25};
    trace_a.interface_to_trace_v = {0.5, 0.75};
    trace_a.interface_delta_trace_v = {-0.25, 0.5};
    trace_a.interface_charge_current_density = {-2.0, 3.0};
    charge::CheckpointData trace_b = trace_a;
    auto reverse = [](auto &values) { std::reverse(values.begin(), values.end()); };
    reverse(trace_b.interface_source_ids); reverse(trace_b.interface_topology_ids);
    reverse(trace_b.interface_axes); reverse(trace_b.interface_face_linear);
    reverse(trace_b.interface_negative_cells); reverse(trace_b.interface_positive_cells);
    reverse(trace_b.interface_from_cells); reverse(trace_b.interface_to_cells);
    reverse(trace_b.interface_orientations); reverse(trace_b.interface_from_trace_v);
    reverse(trace_b.interface_to_trace_v); reverse(trace_b.interface_delta_trace_v);
    reverse(trace_b.interface_charge_current_density);
    std::array<uint8_t, 32> trace_digest_a{}, trace_digest_b{}, trace_digest_mutated{};
    check(charge::checkpoint_content_digest_v2(trace_a, trace_digest_a.data()) &&
              charge::checkpoint_content_digest_v2(trace_b, trace_digest_b.data()) &&
              trace_digest_a == trace_digest_b,
          "accepted trace digest must be independent of interface record order");
    trace_b.interface_from_trace_v[0] += 1.0;
    trace_b.interface_delta_trace_v[0] += 1.0;
    check(charge::checkpoint_content_digest_v2(trace_b, trace_digest_mutated.data()) &&
              trace_digest_mutated != trace_digest_a,
          "accepted trace mutation must change the scientific snapshot digest");
    std::vector<uint8_t> trace_payload;
    check(charge::build_checkpoint(&trace_a, &trace_payload),
          "Y/Z multicell charge checkpoint build must succeed");
    charge::CheckpointData trace_parsed{};
    check(charge::parse_checkpoint(trace_payload.data(), trace_payload.size(), &trace_parsed) &&
              trace_parsed.interface_source_ids == trace_b.interface_source_ids &&
              trace_parsed.interface_topology_ids == trace_b.interface_topology_ids &&
              trace_parsed.interface_axes == trace_b.interface_axes &&
              trace_parsed.interface_face_linear == trace_b.interface_face_linear &&
              trace_parsed.interface_negative_cells == trace_b.interface_negative_cells &&
              trace_parsed.interface_positive_cells == trace_b.interface_positive_cells &&
              trace_parsed.interface_from_cells == trace_b.interface_from_cells &&
              trace_parsed.interface_to_cells == trace_b.interface_to_cells &&
              trace_parsed.interface_orientations == trace_b.interface_orientations,
          "Y/Z multicell interface identity must round-trip in canonical order");
    auto mutate_identity_token=[&](std::vector<uint8_t> &payload,size_t record,size_t token,const char *value){
        uint8_t *list=field_data(section(payload,8),1);size_t offset=0;
        for(size_t i=0;i<record;++i)offset+=4+u32(list+offset);
        const uint32_t length=u32(list+offset);uint8_t *identity=list+offset+4;
        size_t current=0,start=0;
        for(size_t i=0;i<=length;++i)if(i==length||identity[i]==':'){
            if(current==token){check(std::strlen(value)==i-start,"mutation token length drift");
                std::memcpy(identity+start,value,i-start);return;}
            ++current;start=i+1;
        }
        check(false,"identity mutation token missing");
    };
    auto expect_section8_rejected=[&](std::vector<uint8_t> mutation,const char *message){
        rehash_legacy_charge(mutation);uint32_t mutation_kind=0;
        check(validate(mutation,&mutation_kind)==FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,message);
    };
    auto bad_axis=trace_payload;mutate_identity_token(bad_axis,0,3,"9");
    expect_section8_rejected(std::move(bad_axis),"section8 axis outside XYZ must fail after rehash");
    auto bad_face_range=trace_payload;mutate_identity_token(bad_face_range,0,4,"9");
    put_u64(field_data(section(bad_face_range,8),2),9);
    expect_section8_rejected(std::move(bad_face_range),"section8 face outside axis range must fail after rehash");
    auto bad_adjacency=trace_payload;mutate_identity_token(bad_adjacency,0,6,"7");
    mutate_identity_token(bad_adjacency,0,8,"7");
    expect_section8_rejected(std::move(bad_adjacency),"section8 nonadjacent cells must fail after rehash");
    auto bad_canonical=trace_payload;mutate_identity_token(bad_canonical,0,4,"3");
    put_u64(field_data(section(bad_canonical,8),2),3);
    expect_section8_rejected(std::move(bad_canonical),"section8 wrong canonical face must fail after rehash");
    auto bad_orientation=trace_payload;mutate_identity_token(bad_orientation,1,9,"+1");
    put_u32(field_data(section(bad_orientation,8),3)+4,1);
    expect_section8_rejected(std::move(bad_orientation),"section8 orientation inconsistent with from/to must fail after rehash");
    auto duplicate_identity=trace_payload;
    mutate_identity_token(duplicate_identity,1,1,"41");
    mutate_identity_token(duplicate_identity,1,2,"7");
    expect_section8_rejected(std::move(duplicate_identity),"section8 duplicate source/topology must fail after rehash");
    for(uint16_t field=4;field<=7;++field){
        auto nonfinite=trace_payload;const uint64_t bits=field%2?UINT64_C(0x7ff0000000000000):UINT64_C(0x7ff8000000000000);
        put_u64(field_data(section(nonfinite,8),field),bits);
        expect_section8_rejected(std::move(nonfinite),"section8 non-finite V/J must fail after rehash");
    }
    uint32_t kind = 0;

    check(validate(codec, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID,
          "published codec golden remains the byte oracle");
    check(validate(restore, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE,
          "published restore golden remains the byte oracle");
    check(validate(spin_restore, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_SPIN,
          "spin restore fixture must cover complete sections 1-20");

    auto wrong_spin_mask = spin_restore;
    put_u64(wrong_spin_mask.data() + 64, UINT64_C(0x33));
    rehash(wrong_spin_mask);
    check(validate(wrong_spin_mask, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "spin restore must require the exact frozen inclusion mask");
    for (auto *golden : {&codec, &restore, &spin_restore}) {
        for (size_t i = 0; i < golden->size(); ++i) {
            (*golden)[i] ^= 1;
            check(validate(*golden, &kind) ==
                      FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
                  "one-bit golden mutations must still fail closed");
            (*golden)[i] ^= 1;
        }
    }

    put_u64(codec.data() + 72, UINT64_C(42));
    rehash(codec);
    check(validate(codec, &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
              kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_CODEC_VALID,
          "a canonical non-golden checkpoint must validate semantically");

    auto exhausted_sequence = codec;
    put_u64(exhausted_sequence.data() + 72, UINT64_MAX);
    rehash(exhausted_sequence);
    check(validate(exhausted_sequence, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "accepted snapshot sequence must never wrap through UINT64_MAX");

    auto wrong_section_type = codec;
    put_u32(descriptor(wrong_section_type, 2) + 8,
            FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_U64);
    rehash(wrong_section_type);
    check(validate(wrong_section_type, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "section registry must reject the wrong known-section element type");

    auto unknown_convergence_reason = codec;
    put_u32(field_data(section(unknown_convergence_reason, 1), 18), 99);
    rehash(unknown_convergence_reason);
    check(validate(unknown_convergence_reason, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "closed convergence registry must reject an unknown value");

    auto missing_charge_warm_start = restore;
    put_u32(descriptor(missing_charge_warm_start, 18), 19);
    rehash(missing_charge_warm_start);
    check(validate(missing_charge_warm_start, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "charge restore dependencies must require charge warm-start state");

    auto missing_spin_warm_start = spin_restore;
    put_u32(descriptor(missing_spin_warm_start, 19), 21);
    rehash(missing_spin_warm_start);
    check(validate(missing_spin_warm_start, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "spin restore dependencies must require section 19");

    for (const auto &[section_id, expected_fields] :
         {std::pair<uint32_t, uint32_t>{10, 20}, {16, 27}, {17, 10}}) {
        auto stale_field_registry = spin_restore;
        put_u32(section(stale_field_registry, section_id) + 4, expected_fields - 1);
        rehash(stale_field_registry);
        check(validate(stale_field_registry, &kind) ==
                  FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
              "spin subrecords must use exact frozen field registries");
    }

    auto changed_spin_source_revision = spin_restore;
    uint8_t *spin_source = field_data(section(changed_spin_source_revision, 10), 10);
    put_u64(spin_source, u64(spin_source) + 1);
    rehash(changed_spin_source_revision);
    check(validate(changed_spin_source_revision, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "spin source revision must match the accepted charge identity");

    auto changed_warm_preconditioner = spin_restore;
    uint8_t *warm_preconditioner = field_data(section(changed_warm_preconditioner, 19), 2);
    put_u64(warm_preconditioner, u64(warm_preconditioner) + 1);
    rehash(changed_warm_preconditioner);
    check(validate(changed_warm_preconditioner, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "spin warm-start revision must match spin metadata");

    auto changed_spin_budget = spin_restore;
    uint8_t *spin_budget = field_data(section(changed_spin_budget, 20), 6);
    put_u64(spin_budget, u64(spin_budget) + 1);
    rehash(changed_spin_budget);
    check(validate(changed_spin_budget, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "continuation spin work budget must match spin metadata");

    auto invalid_interface_face = spin_restore;
    put_u64(field_data(section(invalid_interface_face, 16), 4), UINT64_MAX);
    rehash(invalid_interface_face);
    check(validate(invalid_interface_face, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "spin interface topology must remain inside the frozen grid");

    auto changed_continuation_digest = spin_restore;
    field_data(section(changed_continuation_digest, 20), 7)[0] ^= 1;
    rehash(changed_continuation_digest);
    check(validate(changed_continuation_digest, &kind) ==
              FULLMAG_FDM_GPU_TRANSPORT_ERROR_CHECKPOINT_INCOMPATIBLE,
          "continuation digest must use exact field-7 zeroing domain");

    std::cout << "checkpoint semantic validator contract passed\n";
    return 0;
}
