import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checks = [
  {
    args: [
      "\\bfetch\\s*\\(",
      "src",
      "--glob",
      "!src/kernel/api/**",
      "--glob",
      "!src/kernel/api/generated/**",
    ],
    label: "direct fetch outside kernel API",
  },
  {
    args: [
      "apps/web|ControlRoomContext|normalizeSession|mergeSession",
      "src",
      "--glob",
      "!**/*.test.*",
      "--glob",
      "!**/*.spec.*",
    ],
    label: "legacy frontend imports or state models",
  },
  {
    args: [
      "\"/v2/",
      "src",
      "--glob",
      "!src/kernel/api/**",
      "--glob",
      "!src/kernel/api/generated/**",
      "--glob",
      "!**/*.test.*",
      "--glob",
      "!**/*.spec.*",
    ],
    label: "hand-built v2 endpoint strings outside API/generated",
  },
  {
    args: [
      "-i",
      `/v1/live/current(?:/|["'])|\\bbootstrap\\b|\\bpoll\\b|["'][^"']*/preview(?:/|["'])`,
      "src",
      "--glob",
      "!src/kernel/api/generated/**",
    ],
    label: "legacy live/bootstrap/poll/preview path",
  },
];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src");

function getAllFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...getAllFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function runNodeFallback() {
  const allFiles = getAllFiles(srcDir);
  let anyFailed = false;

  for (const check of checks) {
    const isCaseInsensitive = check.args.includes("-i");
    const patternStr = isCaseInsensitive ? check.args[1] : check.args[0];
    const regex = new RegExp(patternStr, isCaseInsensitive ? "i" : "");
    const globs = [];
    for (let i = 0; i < check.args.length; i++) {
      if (check.args[i] === "--glob") {
        globs.push(check.args[i + 1]);
      }
    }

    const matches = [];
    for (const file of allFiles) {
      const rel = path.relative(rootDir, file).split(path.sep).join("/");
      let excluded = false;
      for (const glob of globs) {
        if (glob.startsWith("!")) {
          const pattern = glob.slice(1);
          if (pattern === "src/kernel/api/**" && rel.startsWith("src/kernel/api/")) excluded = true;
          if (pattern === "src/kernel/api/generated/**" && rel.startsWith("src/kernel/api/generated/")) excluded = true;
          if (pattern === "**/*.test.*" && rel.includes(".test.")) excluded = true;
          if (pattern === "**/*.spec.*" && rel.includes(".spec.")) excluded = true;
        }
      }
      if (excluded) continue;

      const content = readFileSync(file, "utf8");
      if (regex.test(content)) {
        matches.push(rel);
      }
    }

    if (matches.length > 0) {
      anyFailed = true;
      console.error(`API hygiene check failed: ${check.label}`);
      for (const m of matches) {
        console.error(`  ${m}`);
      }
    }
  }

  if (anyFailed) {
    process.exit(1);
  }
  console.log("API hygiene check passed.");
}

const probe = spawnSync("rg", ["--version"]);
if (probe.error && probe.error.code === "ENOENT") {
  runNodeFallback();
} else {
  let failed = false;

  for (const check of checks) {
    const result = spawnSync("rg", check.args, {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });

    if (result.status === 0) {
      failed = true;
      console.error(`API hygiene check failed: ${check.label}`);
      console.error(result.stdout);
    } else if (result.status !== 1) {
      failed = true;
      console.error(`API hygiene check errored: ${check.label}`);
      console.error(result.stderr || result.stdout);
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log("API hygiene check passed.");
}
