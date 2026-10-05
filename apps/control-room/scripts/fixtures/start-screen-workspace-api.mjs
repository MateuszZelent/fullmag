import { deflateSync } from "node:zlib";

// Fixture answers of the workspace database routes (GET /v2/workspace/items,
// /items/{id}, /roots, POST /scan ...), served through Playwright route
// interception so the real start screen can be driven without a backend.
// The shapes are the BACKEND CONTRACT hand-declared in
// src/modules/start/model/workspaceApiTypes.ts.

const NOW = Date.now();
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** A 320x180 PNG with a dark field and a bright dispersion-like band. */
export function thumbnailPng() {
  const width = 320;
  const height = 180;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const centre = height * 0.55 + Math.abs(x - width / 2) * 0.35 - 30;
      const band = Math.exp(-(((y - centre) / 6) ** 2));
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(17 + 200 * band);
      raw[o + 1] = Math.round(17 + 220 * band);
      raw[o + 2] = Math.round(27 + 228 * band);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const projectItem = {
  id: "wi-project-yig",
  kind: "project",
  path: "D:\\sim\\magnonics\\yig-waveguide-dispersion.fms",
  name: "YIG waveguide - spin-wave dispersion",
  project_id: "yig-waveguide",
  first_seen_at: iso(900),
  last_used_at: iso(1),
  use_count: 12,
  pinned: true,
  status: "ready",
  size_bytes: 1_420_000_000,
  modified_at: iso(3),
  has_thumbnail: true,
  meta: {
    solver: "FDM",
    revision: 42,
    schema_version: "1.2",
    tags: ["magnonics", "dispersion", "YIG"],
  },
};

const scriptItem = {
  id: "wi-script-sp4",
  kind: "script",
  path: "C:\\work\\sp4.py",
  name: "sp4",
  first_seen_at: iso(400),
  last_used_at: iso(5),
  use_count: 7,
  pinned: false,
  status: "ready",
  size_bytes: 2048,
  modified_at: iso(30),
  has_thumbnail: false,
  meta: {
    lines: 120,
    summary: "muMAG standard problem 4",
    uses_fullmag: true,
    last_run: { status: "ok", at: iso(5), duration_seconds: 412, device: "RTX 4090" },
  },
};

const resultItem = {
  id: "wi-result-sp4-run3",
  kind: "result",
  path: "C:\\work\\sp4.out\\run-0003.zarr",
  name: "run-0003",
  first_seen_at: iso(6),
  last_used_at: iso(5),
  use_count: 1,
  pinned: false,
  status: "ready",
  size_bytes: 318_000_000,
  modified_at: iso(5),
  has_thumbnail: true,
  meta: { run_id: "run-0003", status: "completed", source_name: "sp4", duration_seconds: 412 },
};

const otherProject = {
  ...projectItem,
  id: "wi-project-skyrmion",
  name: "Skyrmion lattice - DMI sweep",
  path: "D:\\sim\\topology\\skyrmion-lattice-dmi.fms",
  project_id: "skyrmion",
  pinned: false,
  last_used_at: iso(30),
  size_bytes: 860_000_000,
  has_thumbnail: false,
  meta: { solver: "FDM", revision: 7, schema_version: "1.2", tags: ["skyrmion"] },
};

export const FIXTURE_ITEMS = [projectItem, scriptItem, resultItem, otherProject];

const events = [
  { at: iso(5), kind: "run", actor: "cli", detail: { status: "ok", duration_seconds: 412, device: "RTX 4090", run_id: "run-0003" } },
  {
    at: iso(30),
    kind: "edit",
    actor: "desktop",
    detail: { before: { sha256: "a1b2c3d4e5f6", lines: 112 }, after: { sha256: "e4f5a6b7c8d9", lines: 120 } },
  },
  { at: iso(400), kind: "create", actor: "desktop", detail: {} },
];

export const FIXTURE_DETAILS = {
  "wi-project-yig": {
    item: projectItem,
    detail: {
      kind: "project",
      schema_version: "1.2",
      revision: 42,
      solver: "FDM",
      migrated: false,
      can_write: true,
      mode: "read_write",
      warnings: [],
      summary: {
        model: {
          discretisation: "512 x 512 x 8",
          cell: "2.0 x 2.0 x 5.0 nm",
          periodicity: "x",
          materials: ["YIG"],
          ms: "140 kA/m",
          aex: "3.65 pJ/m",
          alpha: "2.0e-4",
          interactions: ["exchange", "demag", "Zeeman", "Gilbert"],
        },
        execution: { integrator: "RK45 (adaptive)", tolerance: "1e-6", excitation: "sinc, fc = 20 GHz" },
        outputs: { frames: 400, size_bytes: 1_420_000_000 },
      },
      authors: [
        { name: "Mateusz Zelent", role: "creator", affiliation: "AG Magnonics, RPTU", orcid: "0000-0001-2345-6789" },
      ],
      citation: { doi: "10.1234/fullmag.yig" },
      history: [
        { revision: 42, at: iso(3), by: "mz", kind: "edit", summary: "Refined the mesh near the edge", changes: ["mesh.cell 3 nm -> 2 nm"] },
        { revision: 41, at: iso(20), by: "mz", kind: "run", summary: "Dispersion run completed", run_id: "run-0007" },
      ],
      runs: [
        { run_id: "run-0007", started_at: iso(20), status: "ready", duration_seconds: 2940, output_bytes: 1_420_000_000, device: "RTX 4090" },
        { run_id: "run-0006", started_at: iso(60), status: "failed", duration_seconds: 120, error: "Exchange length 5.2 nm is below the cell size 6 nm." },
      ],
      preview: { colouring: "mz" },
    },
    events: [],
    read_at: iso(0),
    linked_results: [resultItem],
  },
  "wi-script-sp4": {
    item: scriptItem,
    detail: {
      kind: "script",
      lines: 120,
      bytes: 2048,
      sha256: "e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819",
      encoding: "utf-8",
      uses_fullmag: true,
      syntax: { ok: true },
      imports: { unresolved: [] },
      env_reads: ["FULLMAG_DEVICE"],
    },
    events,
    read_at: iso(0),
    linked_results: [resultItem],
  },
  "wi-result-sp4-run3": {
    item: resultItem,
    detail: {
      kind: "result",
      format: "zarr",
      format_version: "2",
      run_id: "run-0003",
      source: { kind: "script", path: "C:\\work\\sp4.py", sha256: "e4f5a6b7c8d9e0f1" },
      stages: [
        { id: "relax", kind: "relaxation", steps: 4210, time_s: 0 },
        { id: "field-pulse", kind: "time-evolution", steps: 20000, time_s: 1e-9 },
      ],
      quantities: ["m", "H_demag", "H_ex", "E_total"],
      grid: { nx: 200, ny: 50, nz: 1, dx: 2.5e-9, dy: 2.5e-9, dz: 2.5e-9 },
      frames: 400,
      total_bytes: 318_000_000,
      status: "completed",
      started_at: iso(6),
      finished_at: iso(5),
    },
    events: [{ at: iso(5), kind: "create", actor: "scanner", detail: {} }],
    read_at: iso(0),
    linked_results: [],
    linked_source: scriptItem,
  },
  "wi-project-skyrmion": {
    item: otherProject,
    detail: { kind: "project", schema_version: "1.2", revision: 7, warnings: [], authors: [], history: [], runs: [] },
    events: [],
    read_at: iso(0),
    linked_results: [],
  },
};

const json = (body, status = 200) => ({
  status,
  headers: { "content-type": "application/json", "x-api-contract-version": "1.0.0" },
  body: JSON.stringify(body),
});

/**
 * Serves /v2/workspace/** from the fixtures. Everything else under /v2/ is
 * answered 404 with the contract header, as a backend without that route would.
 * `options.missing` makes the whole workspace family answer 404 (an older backend).
 */
export async function installWorkspaceApi(page, options = {}) {
  const state = { roots: [{ path: "D:\\sim", kinds: ["project", "script", "result"], recursive: true, enabled: true }], calls: [] };
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    state.calls.push(`${request.method()} ${path}${url.search}`);
    if (path === "/v2/sessions") {
      await route.fulfill(json({ schema_version: "fullmag.session-list.v1", sessions: [] }));
      return;
    }
    if (!path.startsWith("/v2/workspace/")) {
      await route.fulfill(json({ error: { code: "not_found", message: "not found" } }, 404));
      return;
    }
    if (options.missing) {
      await route.fulfill(json({ error: { code: "not_found", message: "not found" } }, 404));
      return;
    }
    if (path === "/v2/workspace/items" && request.method() === "GET") {
      await route.fulfill(json({ items: FIXTURE_ITEMS, outcome: { state: "ready" } }));
    } else if (path === "/v2/workspace/items" && request.method() === "POST") {
      await route.fulfill(json(JSON.parse(request.postData() ?? "{}").kind === "script" ? scriptItem : projectItem));
    } else if (path === "/v2/workspace/roots" && request.method() === "GET") {
      await route.fulfill(json({ roots: state.roots }));
    } else if (path === "/v2/workspace/roots" && request.method() === "PUT") {
      state.roots = JSON.parse(request.postData() ?? "{}").roots ?? state.roots;
      await route.fulfill(json({ roots: state.roots }));
    } else if (path === "/v2/workspace/scan") {
      await route.fulfill(json({ scanned: 482, added: 3, updated: 5, missing: 1, skipped: 12, warnings: ["D:\\sim\\old: permission denied"] }));
    } else if (/\/thumbnail$/.test(path)) {
      await route.fulfill({ status: 200, headers: { "content-type": "image/png", "x-api-contract-version": "1.0.0" }, body: thumbnailPng() });
    } else if (/\/(pin|forget)$/.test(path)) {
      await route.fulfill(json({}));
    } else {
      const id = decodeURIComponent(path.split("/")[4] ?? "");
      const answer = FIXTURE_DETAILS[id];
      await route.fulfill(answer ? json(answer) : json({ error: { code: "not_found", message: "no such item" } }, 404));
    }
  });
  return state;
}
