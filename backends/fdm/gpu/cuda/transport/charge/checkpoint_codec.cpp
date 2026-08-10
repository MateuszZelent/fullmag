#include "checkpoint_codec.hpp"

#include "fullmag/fdm/transport/gpu_abi_v1.h"

#include <algorithm>
#include <cstring>
#include <string>
#include <utility>

extern "C" void fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(
    const void *, uint64_t, uint8_t[32]);

namespace fullmag::fdm::gpu::transport::charge {
namespace {

uint64_t align_to(uint64_t value, uint64_t alignment) {
    return (value + alignment - 1) & ~(alignment - 1);
}

void put_u16(uint8_t *p, uint16_t value) {
    p[0] = static_cast<uint8_t>(value);
    p[1] = static_cast<uint8_t>(value >> 8);
}

void put_u32(uint8_t *p, uint32_t value) {
    for (size_t i = 0; i < 4; ++i) p[i] = static_cast<uint8_t>(value >> (8 * i));
}

void put_u64(uint8_t *p, uint64_t value) {
    for (size_t i = 0; i < 8; ++i) p[i] = static_cast<uint8_t>(value >> (8 * i));
}

uint16_t get_u16(const uint8_t *p) {
    return uint16_t(p[0]) | (uint16_t(p[1]) << 8);
}

uint32_t get_u32(const uint8_t *p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
           (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

uint64_t get_u64(const uint8_t *p) {
    uint64_t value = 0;
    for (size_t i = 0; i < 8; ++i) value |= uint64_t(p[i]) << (8 * i);
    return value;
}

template <typename T> std::vector<uint8_t> fixed(const T *values, size_t count) {
    std::vector<uint8_t> bytes(count * sizeof(T));
    if (!bytes.empty()) std::memcpy(bytes.data(), values, bytes.size());
    return bytes;
}

template <typename T> std::vector<uint8_t> scalar(T value) {
    return fixed(&value, 1);
}

std::vector<uint8_t> text(std::string value) {
    return std::vector<uint8_t>(value.begin(), value.end());
}

std::vector<uint8_t> text_list(const std::vector<std::string> &values) {
    std::vector<uint8_t> bytes;
    for (const auto &value : values) {
        const size_t start = bytes.size();
        bytes.resize(start + 4 + value.size());
        put_u32(bytes.data() + start, static_cast<uint32_t>(value.size()));
        std::memcpy(bytes.data() + start + 4, value.data(), value.size());
    }
    return bytes;
}

struct Field {
    uint16_t type;
    uint64_t count;
    std::vector<uint8_t> bytes;
};

std::vector<uint8_t> subrecord(const std::vector<Field> &fields) {
    uint64_t next = align_to(16 + 32 * fields.size(), 8);
    std::vector<uint64_t> offsets;
    offsets.reserve(fields.size());
    for (const auto &field : fields) {
        offsets.push_back(next);
        next = align_to(next + field.bytes.size(), 8);
    }
    std::vector<uint8_t> record(next, 0);
    put_u16(record.data(), 1);
    put_u32(record.data() + 4, static_cast<uint32_t>(fields.size()));
    put_u64(record.data() + 8, record.size());
    for (size_t i = 0; i < fields.size(); ++i) {
        uint8_t *descriptor = record.data() + 16 + 32 * i;
        put_u16(descriptor, static_cast<uint16_t>(i + 1));
        put_u16(descriptor + 2, fields[i].type);
        put_u32(descriptor + 4, 1);
        put_u64(descriptor + 8, fields[i].count);
        put_u64(descriptor + 16, offsets[i]);
        put_u64(descriptor + 24, fields[i].bytes.size());
        if (!fields[i].bytes.empty())
            std::memcpy(record.data() + offsets[i], fields[i].bytes.data(), fields[i].bytes.size());
    }
    return record;
}

Field f_u8(const std::vector<uint8_t> &values) { return {1, values.size(), values}; }
Field f_u32(const std::vector<uint32_t> &values) { return {2, values.size(), fixed(values.data(), values.size())}; }
Field f_u64(const std::vector<uint64_t> &values) { return {3, values.size(), fixed(values.data(), values.size())}; }
Field f_i32(const std::vector<int32_t> &values) { return {4, values.size(), fixed(values.data(), values.size())}; }
Field f_f64(const std::vector<double> &values) { return {5, values.size(), fixed(values.data(), values.size())}; }
Field f_digest(const std::array<uint8_t, 32> &value) { return {7, 1, {value.begin(), value.end()}}; }
Field f_text(const std::string &value) { return {8, 1, text(value)}; }
Field f_text_list(const std::vector<std::string> &values) { return {9, values.size(), text_list(values)}; }

struct Section { uint32_t id; uint32_t type; uint32_t width; std::vector<uint8_t> bytes; };

const uint8_t *field_data(const uint8_t *record, uint16_t field_id,
                          uint64_t *count, uint64_t *bytes) {
    const uint32_t fields = get_u32(record + 4);
    for (uint32_t i = 0; i < fields; ++i) {
        const uint8_t *descriptor = record + 16 + 32 * i;
        if (get_u16(descriptor) == field_id) {
            *count = get_u64(descriptor + 8);
            *bytes = get_u64(descriptor + 24);
            return record + get_u64(descriptor + 16);
        }
    }
    return nullptr;
}

const uint8_t *section_data(const uint8_t *payload, uint32_t id, uint64_t *length) {
    const uint32_t count = get_u32(payload + 24);
    for (uint32_t i = 0; i < count; ++i) {
        const uint8_t *descriptor = payload + 320 + 96 * i;
        if (get_u32(descriptor) == id) {
            *length = get_u64(descriptor + 32);
            return payload + get_u64(descriptor + 24);
        }
    }
    return nullptr;
}

} // namespace

void checkpoint_sha256(const void *payload, uint64_t payload_size, uint8_t digest[32]) {
    fullmag_fdm_gpu_transport_checkpoint_sha256_internal_v1(payload, payload_size, digest);
}

bool checkpoint_content_digest_v2(const CheckpointData &data, uint8_t digest[32]) {
    const size_t faces=data.charge_adjacent_cells.size();
    if(digest==nullptr || data.active.size()!=data.potential.size() ||
       data.charge_axes.size()!=faces || data.charge_sides.size()!=faces ||
       data.charge_areas.size()!=faces || data.charge_values.size()!=faces ||
       data.charge_source_ids.size()!=faces) return false;
    std::vector<uint8_t> canonical;
    const auto append=[&](const void *source,size_t bytes){
        if(bytes==0)return;
        const auto *begin=static_cast<const uint8_t *>(source);
        canonical.insert(canonical.end(),begin,begin+bytes);
    };
    const auto segment=[&](uint32_t tag,const void *source,uint64_t bytes){
        append(&tag,sizeof(tag));append(&bytes,sizeof(bytes));append(source,size_t(bytes));
    };
    segment(1,data.static_digest.data(),data.static_digest.size());
    segment(2,data.lineage.data(),data.lineage.size());
    segment(3,&data.accepted_sequence,sizeof(data.accepted_sequence));
    segment(4,data.grid.data(),sizeof(data.grid));segment(5,data.cell_size.data(),sizeof(data.cell_size));
    segment(6,&data.descriptor_revision,sizeof(data.descriptor_revision));
    segment(7,&data.source_revision,sizeof(data.source_revision));
    segment(8,data.active.data(),data.active.size());
    segment(9,data.potential.data(),data.potential.size()*sizeof(double));
    segment(10,data.jx.data(),data.jx.size()*sizeof(double));
    segment(11,data.jy.data(),data.jy.size()*sizeof(double));
    segment(12,data.jz.data(),data.jz.size()*sizeof(double));
    const uint64_t exact_count=faces;segment(13,&exact_count,sizeof(exact_count));
    for(size_t i=0;i<faces;++i){
        append(&data.charge_adjacent_cells[i],8);append(&data.charge_axes[i],4);
        append(&data.charge_sides[i],4);append(&data.charge_areas[i],8);
        append(&data.charge_values[i],8);
        uint64_t source_id=0;
        if(data.charge_source_ids[i].empty())return false;
        for(char c:data.charge_source_ids[i]){
            if(c<'0'||c>'9'||source_id>(UINT64_MAX-uint64_t(c-'0'))/10)return false;
            source_id=source_id*10+uint64_t(c-'0');
        }
        append(&source_id,8);
    }
    checkpoint_sha256(canonical.data(),canonical.size(),digest);
    return true;
}

bool build_checkpoint(CheckpointData *data, std::vector<uint8_t> *payload) {
    if (data == nullptr || payload == nullptr || data->grid[0] == 0 || data->grid[1] == 0 ||
        data->grid[2] == 0 || data->active.size() != data->potential.size() ||
        data->conductivity.size() != data->potential.size()) return false;
    const uint64_t cells = data->grid[0] * data->grid[1] * data->grid[2];
    if (data->potential.size() != cells) return false;
    std::array<uint8_t, 32> deterministic{};
    const bool content_derived_domain = std::any_of(
        data->snapshot_digest.begin(), data->snapshot_digest.end(),
        [](uint8_t byte) { return byte != 0; });
    deterministic.fill(content_derived_domain ? 0x45 : 0x44);
    const uint32_t capability[2] = {data->compute_major, data->compute_minor};
    const uint32_t convergence = data->convergence_reason;
    const uint64_t component_count = 1;
    const uint32_t gauge_id = 0;
    const double gauge_value = 0.0;
    std::vector<Field> meta_fields = {
        {2, 2, fixed(capability, 2)}, {2, 1, scalar(data->cuda_driver)},
        {2, 1, scalar(data->cuda_runtime)}, f_text("nvcc-fullmag"), f_digest(deterministic),
        f_text("transport_constitutive.one_way.fullmag.v1"),
        f_text("fv_charge_harmonic_v1"), f_text("fdm_charge_cg_device_amg_cuda_v1"),
        f_text("charge_balance_integrated_l2.v1"),
        {3, 3, fixed(data->grid.data(), 3)}, {5, 3, fixed(data->cell_size.data(), 3)},
        {3, 1, scalar(data->descriptor_revision)}, {3, 1, scalar(data->source_revision)},
        {3, 1, scalar(data->operator_revision)}, {3, 1, scalar(component_count)},
        {2, 1, scalar(gauge_id)}, {5, 1, scalar(gauge_value)},
        {2, 1, scalar(convergence)}, {3, 1, scalar(data->iterations)},
        {3, 1, scalar(data->iterations)}
    };
    std::vector<uint32_t> material_region(cells, 0);
    std::vector<uint8_t> conductor = data->active;
    std::vector<uint8_t> torque(cells, 0);
    const uint64_t conductivity_revision = data->operator_revision;
    std::vector<Field> mask_fields = {
        f_u8(data->active), f_u8(conductor), f_u8(torque), f_u32(material_region),
        {3, 1, scalar(conductivity_revision)}
    };
    const size_t charge_face_count = data->charge_adjacent_cells.size();
    if (data->charge_axes.size() != charge_face_count ||
        data->charge_sides.size() != charge_face_count ||
        data->charge_areas.size() != charge_face_count ||
        data->charge_values.size() != charge_face_count ||
        data->charge_source_ids.size() != charge_face_count) return false;
    std::vector<Field> density_fields = {
        f_u64(data->charge_adjacent_cells), f_u32(data->charge_axes),
        f_i32(data->charge_sides), f_f64(data->charge_areas),
        f_f64(data->charge_values), f_text_list(data->charge_source_ids)
    };
    std::vector<Field> interface_fields = {
        f_text_list({}), f_u64({}), f_i32({}), f_f64({}), f_f64({}), f_f64({}), f_f64({})
    };
    std::vector<Field> observation_fields = {
        f_text_list({"ground"}), f_f64({0.0}), f_f64({data->component_balance}),
        f_f64({data->physical_residual})
    };
    std::vector<uint8_t> warm_structure_mask(32, 0);
    std::vector<Field> warm_fields = {
        f_text("fdm_charge_cg_device_amg_cuda_v1"), {3, 1, scalar(data->operator_revision)},
        {3, 1, scalar(data->iterations)}, {3, 1, scalar(uint64_t{0})},
        f_f64(data->potential), f_f64({}), f_u8(warm_structure_mask)
    };
    std::array<uint8_t, 32> zero_digest{};
    std::vector<Field> continuation_fields = {
        {3, 1, scalar(data->accepted_sequence)}, {3, 1, scalar(uint64_t{0})},
        {3, 1, scalar(uint64_t{0})}, {3, 1, scalar(uint64_t{0})},
        {3, 1, scalar(data->iterations)}, {3, 1, scalar(uint64_t{0})}, f_digest(zero_digest)
    };
    std::vector<Section> sections = {
        {1, 6, 1, subrecord(meta_fields)},
        {2, 5, 8, fixed(data->potential.data(), data->potential.size())},
        {3, 5, 8, fixed(data->jx.data(), data->jx.size())},
        {4, 5, 8, fixed(data->jy.data(), data->jy.size())},
        {5, 5, 8, fixed(data->jz.data(), data->jz.size())},
        {6, 6, 1, subrecord(mask_fields)}, {7, 6, 1, subrecord(density_fields)},
        {8, 6, 1, subrecord(interface_fields)}, {9, 6, 1, subrecord(observation_fields)},
        {18, 6, 1, subrecord(warm_fields)}, {20, 6, 1, subrecord(continuation_fields)}
    };
    std::vector<uint8_t> snapshot_bytes;
    for (size_t i = 0; i < 9; ++i)
        snapshot_bytes.insert(snapshot_bytes.end(), sections[i].bytes.begin(), sections[i].bytes.end());
    if (std::all_of(data->snapshot_digest.begin(), data->snapshot_digest.end(),
                    [](uint8_t byte) { return byte == 0; }))
        checkpoint_sha256(snapshot_bytes.data(), snapshot_bytes.size(), data->snapshot_digest.data());
    std::vector<uint8_t> continuation_domain(data->snapshot_digest.begin(), data->snapshot_digest.end());
    continuation_domain.insert(continuation_domain.end(), sections[9].bytes.begin(), sections[9].bytes.end());
    continuation_domain.insert(continuation_domain.end(), sections[10].bytes.begin(), sections[10].bytes.end());
    checkpoint_sha256(continuation_domain.data(), continuation_domain.size(), data->continuation_digest.data());
    continuation_fields.back() = f_digest(data->continuation_digest);
    sections[10].bytes = subrecord(continuation_fields);

    const uint64_t first_payload = align_to(320 + 96 * sections.size(), 64);
    uint64_t total = first_payload;
    std::vector<uint64_t> offsets;
    for (const auto &section : sections) {
        offsets.push_back(total);
        total = align_to(total + section.bytes.size(), 64);
    }
    payload->assign(total, 0);
    uint8_t *header = payload->data();
    std::memcpy(header, "FMGPUTR1", 8);
    put_u16(header + 8, 1); put_u32(header + 12, 320); put_u32(header + 16, 0x01020304);
    put_u32(header + 20, 96); put_u32(header + 24, sections.size());
    put_u64(header + 32, total); put_u64(header + 40, 320); put_u64(header + 48, first_payload);
    put_u64(header + 64, UINT64_C(0x33)); put_u64(header + 72, data->accepted_sequence);
    std::memcpy(header + 80, data->device_uuid.data(), 16);
    std::memcpy(header + 96, data->build_digest.data(), 32);
    std::memcpy(header + 128, data->static_digest.data(), 32);
    std::memcpy(header + 160, data->lineage.data(), 16);
    std::memcpy(header + 176, data->snapshot_digest.data(), 32);
    std::vector<uint8_t> ordered;
    for (size_t i = 0; i < sections.size(); ++i) {
        uint8_t *descriptor = header + 320 + 96 * i;
        put_u32(descriptor, sections[i].id); put_u16(descriptor + 4, 1); put_u16(descriptor + 6, 1);
        put_u32(descriptor + 8, sections[i].type); put_u32(descriptor + 12, sections[i].width);
        put_u64(descriptor + 16, sections[i].bytes.size() / sections[i].width);
        put_u64(descriptor + 24, offsets[i]); put_u64(descriptor + 32, sections[i].bytes.size());
        put_u64(descriptor + 40, sections[i].bytes.size());
        std::memcpy(header + offsets[i], sections[i].bytes.data(), sections[i].bytes.size());
        checkpoint_sha256(sections[i].bytes.data(), sections[i].bytes.size(), descriptor + 48);
        ordered.insert(ordered.end(), sections[i].bytes.begin(), sections[i].bytes.end());
    }
    checkpoint_sha256(header + 320, 96 * sections.size(), header + 208);
    checkpoint_sha256(ordered.data(), ordered.size(), header + 240);
    std::fill(header + 272, header + 304, 0);
    checkpoint_sha256(header, payload->size(), header + 272);
    uint32_t kind = 0;
    return fullmag_fdm_gpu_transport_checkpoint_validate_v1(
               payload->data(), payload->size(), &kind) == FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK &&
           kind == FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE;
}

bool parse_checkpoint(const uint8_t *payload, uint64_t payload_size, CheckpointData *data) {
    if (payload == nullptr || data == nullptr) return false;
    uint32_t kind = 0;
    if (fullmag_fdm_gpu_transport_checkpoint_validate_v1(payload, payload_size, &kind) !=
            FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK ||
        kind != FULLMAG_FDM_GPU_TRANSPORT_CHECKPOINT_RESTORE_VALID_CHARGE) return false;
    std::memcpy(data->device_uuid.data(), payload + 80, 16);
    std::memcpy(data->build_digest.data(), payload + 96, 32);
    std::memcpy(data->static_digest.data(), payload + 128, 32);
    std::memcpy(data->lineage.data(), payload + 160, 16);
    std::memcpy(data->snapshot_digest.data(), payload + 176, 32);
    data->accepted_sequence = get_u64(payload + 72);
    uint64_t meta_length = 0;
    const uint8_t *meta = section_data(payload, 1, &meta_length);
    uint64_t count = 0, bytes = 0;
    const uint8_t *grid = field_data(meta, 10, &count, &bytes);
    const uint8_t *cell_size = field_data(meta, 11, &count, &bytes);
    for (size_t i = 0; i < 3; ++i) {
        data->grid[i] = get_u64(grid + 8 * i);
        std::memcpy(&data->cell_size[i], cell_size + 8 * i, 8);
    }
    data->descriptor_revision = get_u64(field_data(meta, 12, &count, &bytes));
    data->source_revision = get_u64(field_data(meta, 13, &count, &bytes));
    data->operator_revision = get_u64(field_data(meta, 14, &count, &bytes));
    data->convergence_reason = get_u32(field_data(meta, 18, &count, &bytes));
    data->iterations = get_u64(field_data(meta, 19, &count, &bytes));
    auto load_doubles = [&](uint32_t id, std::vector<double> *values) {
        uint64_t length = 0; const uint8_t *section = section_data(payload, id, &length);
        values->resize(length / sizeof(double));
        if (length) std::memcpy(values->data(), section, length);
    };
    load_doubles(2, &data->potential); load_doubles(3, &data->jx);
    load_doubles(4, &data->jy); load_doubles(5, &data->jz);
    uint64_t mask_length = 0;
    const uint8_t *masks = section_data(payload, 6, &mask_length);
    const uint8_t *active = field_data(masks, 1, &count, &bytes);
    data->active.assign(active, active + count);
    uint64_t density_length = 0;
    const uint8_t *density = section_data(payload, 7, &density_length);
    auto load_fixed = [&](uint16_t field, auto *values) {
        uint64_t field_count = 0, field_bytes = 0;
        const uint8_t *source = field_data(density, field, &field_count, &field_bytes);
        values->resize(field_count);
        if (field_bytes) std::memcpy(values->data(), source, field_bytes);
    };
    load_fixed(1, &data->charge_adjacent_cells);
    load_fixed(2, &data->charge_axes);
    load_fixed(3, &data->charge_sides);
    load_fixed(4, &data->charge_areas);
    load_fixed(5, &data->charge_values);
    uint64_t kind_count = 0, kind_bytes = 0;
    const uint8_t *kind_data = field_data(density, 6, &kind_count, &kind_bytes);
    data->charge_source_ids.clear();
    for (uint64_t i = 0, offset = 0; i < kind_count; ++i) {
        const uint32_t length = get_u32(kind_data + offset);
        data->charge_source_ids.emplace_back(
            reinterpret_cast<const char *>(kind_data + offset + 4), length);
        offset += 4 + length;
    }
    uint64_t observation_length = 0;
    const uint8_t *observations = section_data(payload, 9, &observation_length);
    const uint8_t *component = field_data(observations, 3, &count, &bytes);
    const uint8_t *physical = field_data(observations, 4, &count, &bytes);
    std::memcpy(&data->component_balance, component, 8);
    std::memcpy(&data->physical_residual, physical, 8);
    uint64_t continuation_length = 0;
    const uint8_t *continuation = section_data(payload, 20, &continuation_length);
    std::memcpy(data->continuation_digest.data(),
                field_data(continuation, 7, &count, &bytes), 32);
    return true;
}

} // namespace fullmag::fdm::gpu::transport::charge
