// S14: PA vs Assembled benchmark for P1 tetrahedra.
//
// Compares assembled (SpMV) and partial-assembly operator apply
// performance for the Laplacian on P1 tets.
//
// Build with MFEM stack:
//   cmake -DFULLMAG_USE_MFEM_STACK=ON .. && make pa_benchmark
//
// Usage:
//   ./pa_benchmark [mesh_size] [n_apply]
//
// Outputs a CSV row: mesh_size, n_dofs, assembled_ms, pa_ms, ratio

#include <mfem.hpp>
#include <chrono>
#include <iostream>

int main(int argc, char *argv[]) {
    const int mesh_n = argc > 1 ? std::atoi(argv[1]) : 10;
    const int n_apply = argc > 2 ? std::atoi(argv[2]) : 100;

#if defined(MFEM_USE_CUDA)
    mfem::Device device("cuda");
#else
    mfem::Device device("cpu");
#endif

    // Generate a tetrahedral mesh on [0,1]³
    auto *mesh = new mfem::Mesh(
        mfem::Mesh::MakeCartesian3D(mesh_n, mesh_n, mesh_n, mfem::Element::TETRAHEDRON));

    auto *fec = new mfem::H1_FECollection(1, 3);
    auto *fes = new mfem::FiniteElementSpace(mesh, fec);
    const int ndof = fes->GetNDofs();

    // Random input vector
    mfem::Vector x(ndof), y_asm(ndof), y_pa(ndof);
    x.Randomize(42);
    x.UseDevice(true);
    y_asm.UseDevice(true);
    y_pa.UseDevice(true);

    // ── Assembled (FULL) path ──
    {
        mfem::BilinearForm a(fes);
        a.SetAssemblyLevel(mfem::AssemblyLevel::LEGACY);
        a.AddDomainIntegrator(new mfem::DiffusionIntegrator());
        a.Assemble();
        a.Finalize();

        // warm-up
        for (int i = 0; i < 5; ++i) a.Mult(x, y_asm);

        auto t0 = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < n_apply; ++i) {
            a.Mult(x, y_asm);
        }
#if defined(MFEM_USE_CUDA)
        cudaDeviceSynchronize();
#endif
        auto t1 = std::chrono::high_resolution_clock::now();
        double asm_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

        // ── Partial Assembly path ──
        mfem::BilinearForm b(fes);
        b.SetAssemblyLevel(mfem::AssemblyLevel::PARTIAL);
        b.AddDomainIntegrator(new mfem::DiffusionIntegrator());
        b.Assemble();

        for (int i = 0; i < 5; ++i) b.Mult(x, y_pa);

        auto t2 = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < n_apply; ++i) {
            b.Mult(x, y_pa);
        }
#if defined(MFEM_USE_CUDA)
        cudaDeviceSynchronize();
#endif
        auto t3 = std::chrono::high_resolution_clock::now();
        double pa_ms = std::chrono::duration<double, std::milli>(t3 - t2).count();

        double ratio = asm_ms / pa_ms;
        std::cout << "mesh_n,ndof,assembled_ms,pa_ms,ratio\n";
        std::cout << mesh_n << "," << ndof << ","
                  << asm_ms << "," << pa_ms << "," << ratio << "\n";

        // Correctness check: relative error between assembled and PA results
        y_asm -= y_pa;
        double err = y_asm.Norml2() / y_pa.Norml2();
        std::cerr << "relative l2 error (asm vs pa): " << err << "\n";
    }

    delete fes;
    delete fec;
    delete mesh;
    return 0;
}
