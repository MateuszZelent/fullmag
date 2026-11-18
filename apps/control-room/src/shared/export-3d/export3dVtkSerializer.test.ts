import { describe, expect, it } from "vitest";

import { export3DModel } from "./index";
import type { Export3DTargetInput } from "./export3dTypes";
import { crc32, readStoreZipArchive } from "./export3dZipArchive";

describe("export3dVtkSerializer & export3dZipArchive", () => {
  it("exports FDM active cells to VTU hexahedra in SI meters with sRGB UInt8 magnetic_texture_rgb", async () => {
    const res = await export3DModel({
      targets: [
        {
          kind: "fdm_grid",
          id: "fdm_film",
          gridShape: [2, 2, 1],
          cellSizeM: [10e-9, 10e-9, 5e-9],
          activeMask: [1, 1, 0, 1],
          field: {
            kind: "real",
            quantityId: "M",
            unit: "A/m",
            componentCount: 3,
            values: new Float32Array([
              8e5, 0, 0,
              0, 0, 8e5,
              0, 0, 0, // inactive cell
              0, 0, -8e5,
            ]),
          },
        },
      ],
      options: {
        format: "vtu",
        filename: "film_snapshot",
        colorMode: "orientation",
      },
    });

    expect(res.filename).toBe("film_snapshot.vtu");
    expect(res.coordinateTransform.mode).toBe("si_m");
    expect(res.coordinateTransform.siMetersPerUnit).toBe(1);
    expect(res.stats.cellCount).toBe(3);

    const xml = res.text!;
    expect(xml).toContain('<VTKFile type="UnstructuredGrid"');
    // 3 active cells in a 2x2 L-shape share corners -> 16 unique corner points
    expect(xml).toContain('NumberOfPoints="16" NumberOfCells="3"');
    expect(xml).toContain(
      '<DataArray type="Float32" Name="M" NumberOfComponents="3" format="ascii">800000 0 0 0 0 800000 0 0 -800000</DataArray>',
    );
    expect(xml).toContain(
      '<DataArray type="UInt8" Name="magnetic_texture_rgb" NumberOfComponents="3" format="ascii">255 0 0 255 255 255 0 0 0</DataArray>',
    );
    expect(xml).toContain(
      '<DataArray type="UInt8" Name="types" format="ascii">12 12 12</DataArray>',
    );
  });

  it("exports FEM mixed-topology volume mesh in binary VTU encoding and merges multiple targets", async () => {
    const targets: Export3DTargetInput[] = [
      {
        kind: "fem_mesh",
        id: "tet_part",
        positionsM: [
          0, 0, 0,
          1e-6, 0, 0,
          0, 1e-6, 0,
          0, 0, 1e-6,
        ],
        volumeCells: {
          cellNodes: [0, 1, 2, 3],
          cellOffsets: [0, 4],
          cellTypes: [1],
        },
        field: {
          kind: "real",
          quantityId: "m",
          componentCount: 3,
          values: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1],
        },
      },
      {
        kind: "surface_geometry",
        id: "tri_part",
        positionsM: [2e-6, 0, 0, 3e-6, 0, 0, 2e-6, 1e-6, 0],
        indices: [0, 1, 2],
      },
    ];

    const res = await export3DModel({
      targets,
      options: {
        format: "vtu",
        vtkEncoding: "binary",
      },
    });

    const xml = res.text!;
    expect(xml).toContain('NumberOfPoints="7" NumberOfCells="2"');
    expect(xml).toContain('Name="target_id"');
    expect(xml).toContain('format="binary"');
    expect(xml).toContain('Name="magnetic_texture_rgb" NumberOfComponents="3" format="binary"');

    // Verify binary DataArray base64 decodes with valid 4-byte uint32 byte-length prefix.
    const typesMatch = xml.match(
      /<DataArray type="UInt8" Name="types" format="binary">([^<]+)<\/DataArray>/,
    );
    expect(typesMatch).not.toBeNull();
    const raw = Buffer.from(typesMatch![1]!, "base64");
    expect(raw.readUInt32LE(0)).toBe(2);
    expect(raw[4]).toBe(10); // VTK_TETRA
    expect(raw[5]).toBe(5); // VTK_TRIANGLE
  });

  it("exports animated phase_cycle complex mode and playback_frames to .vtu.zip with series.pvd and valid CRC32", async () => {
    const complexTarget: Export3DTargetInput = {
      kind: "fdm_grid",
      id: "eigen_slab",
      gridShape: [2, 1, 1],
      cellSizeM: [5e-9, 5e-9, 5e-9],
      field: {
        kind: "complex",
        quantityId: "dm",
        componentCount: 3,
        realValues: [1, 0, 0, 0, 1, 0],
        imagValues: [0, 1, 0, -1, 0, 0],
        phasorConvention: "exp_i_omega_t",
      },
    };

    const res = await export3DModel({
      targets: [complexTarget],
      options: {
        format: "vtu_zip",
        filename: "mode_series",
        animationMode: "phase_cycle",
        phaseFrameCount: 6,
        cycleDurationSeconds: 1.5,
      },
    });

    expect(res.filename).toBe("mode_series.vtu.zip");
    expect(res.mimeType).toBe("application/zip");
    expect(res.stats.frameCount).toBe(6);

    const entries = readStoreZipArchive(res.bytes);
    expect(entries.length).toBe(7); // series.pvd + 6 frames
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.has("series.pvd")).toBe(true);

    const pvdText = new TextDecoder().decode(byPath.get("series.pvd")!.data);
    expect(pvdText).toContain('<VTKFile type="Collection"');

    for (let f = 0; f < 6; f += 1) {
      const framePath = `frames/frame_${String(f).padStart(4, "0")}.vtu`;
      expect(pvdText).toContain(`file="${framePath}"`);
      const entry = byPath.get(framePath);
      expect(entry).toBeDefined();
      expect(entry!.crc32).toBe(crc32(entry!.data));
      const frameXml = new TextDecoder().decode(entry!.data);
      expect(frameXml).toContain('<VTKFile type="UnstructuredGrid"');
      expect(frameXml).toContain('Name="magnetic_texture_rgb"');
    }

    // Exporting multi-frame data as single .vtu should emit warning.
    const singleWarn = await export3DModel({
      targets: [complexTarget],
      options: {
        format: "vtu",
        animationMode: "phase_cycle",
      },
    });
    expect(singleWarn.warnings.length).toBeGreaterThan(0);
  });

  it("supports playback_frames in .vtu.zip with explicit physical timesteps", async () => {
    const res = await export3DModel({
      targets: [
        {
          kind: "surface_geometry",
          id: "patch",
          positionsM: [0, 0, 0, 1e-9, 0, 0, 0, 1e-9, 0],
          indices: [0, 1, 2],
          field: {
            kind: "frames",
            quantityId: "m_z",
            componentCount: 1,
            frames: [
              { timeS: 0, values: [0, 0.5, 1] },
              { timeS: 2.5e-11, values: [-1, 0, 1] },
              { timeS: 5.0e-11, values: [1, 0.2, -0.5] },
            ],
          },
        },
      ],
      options: {
        format: "vtu_zip",
        animationMode: "playback_frames",
        colorPalette: "coolwarm",
      },
    });

    const entries = readStoreZipArchive(res.bytes);
    const pvd = new TextDecoder().decode(entries[0]!.data);
    expect(pvd).toContain('timestep="0"');
    expect(pvd).toContain('timestep="2.5e-11"');
    expect(pvd).toContain('timestep="5e-11"');
    expect(entries.length).toBe(4);
  });
});
