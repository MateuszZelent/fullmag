#include "fullmag_fdm.h"
#include <stddef.h>

#define FULLMAG_ABI_ASSERT(X) _Static_assert((X), #X)
#define FULLMAG_ABI_OFFSETOF(T, F) offsetof(T, F)
#include "gpu_transport_layout_abi_v1_assertions.h"

FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_context_handle_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_charge_snapshot_handle_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_buffer_view_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_charge_cell_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_charge_material_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_charge_face_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_charge_formula_ids_v1) == 8);
FULLMAG_ABI_ASSERT(_Alignof(fullmag_fdm_gpu_transport_error_v1) == 8);
FULLMAG_ABI_ASSERT(sizeof(fullmag_fdm_gpu_transport_charge_cell_v1) == 48);
FULLMAG_ABI_ASSERT(sizeof(fullmag_fdm_gpu_transport_charge_material_v1) == 56);
FULLMAG_ABI_ASSERT(sizeof(fullmag_fdm_gpu_transport_charge_face_v1) == 88);
FULLMAG_ABI_ASSERT(sizeof(fullmag_fdm_gpu_transport_charge_formula_ids_v1) == 64);
FULLMAG_ABI_ASSERT(offsetof(fullmag_fdm_gpu_transport_charge_face_v1, source_id) == 80);

int main(void) { return 0; }
