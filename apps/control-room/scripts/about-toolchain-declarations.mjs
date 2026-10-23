import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(appRoot, "../..");
const generatedPath = path.join(
  appRoot,
  "src/modules/start/model/toolchainDeclarations.generated.json",
);
const generatedRepoPath = "apps/control-room/src/modules/start/model/toolchainDeclarations.generated.json";

export function createAboutToolchainDeclarations() {
  const appPackage = readJson("apps/control-room/package.json");
  const rootPackage = readJson("package.json");
  const packageDependencies = requireObject(
    appPackage.dependencies,
    "apps/control-room/package.json dependencies",
  );
  const packageDevDependencies = requireObject(
    appPackage.devDependencies,
    "apps/control-room/package.json devDependencies",
  );
  const rootEngines = requireObject(rootPackage.engines, "package.json engines");

  const nodeVersion = readPinnedNodeVersion();
  const nodeEngineRange = requireString(rootEngines.node, "package.json engines.node");
  assertNodePinSatisfiesEngine(nodeVersion, nodeEngineRange);

  const pythonProject = readRepoFile("packages/fullmag-py/pyproject.toml");
  const pythonProjectSection = readTomlSection(
    pythonProject,
    "project",
    "packages/fullmag-py/pyproject.toml",
  );
  const pythonRequirement = readTomlString(
    pythonProjectSection,
    "requires-python",
    "packages/fullmag-py/pyproject.toml [project]",
  );
  const pythonDependencies = readTomlStringArray(
    pythonProjectSection,
    "dependencies",
    "packages/fullmag-py/pyproject.toml [project]",
  );
  const pythonOptionalDependenciesSection = readTomlSection(
    pythonProject,
    "project.optional-dependencies",
    "packages/fullmag-py/pyproject.toml",
  );
  const meshingDependencies = readTomlStringArray(
    pythonOptionalDependenciesSection,
    "meshing",
    "packages/fullmag-py/pyproject.toml [project.optional-dependencies]",
  );
  const numpyRequirement = readPep508Requirement(
    pythonDependencies,
    "numpy",
    "packages/fullmag-py/pyproject.toml [project.dependencies]",
  );
  const gmshRequirement = readPep508Requirement(
    meshingDependencies,
    "gmsh",
    "packages/fullmag-py/pyproject.toml [project.optional-dependencies.meshing]",
  );

  const rustToolchain = readRepoFile("rust-toolchain.toml");
  const rustToolchainChannel = readTomlString(
    readTomlSection(rustToolchain, "toolchain", "rust-toolchain.toml"),
    "channel",
    "rust-toolchain.toml [toolchain]",
  );
  const cargoManifest = readRepoFile("Cargo.toml");
  const cargoWorkspacePackage = readTomlSection(
    cargoManifest,
    "workspace.package",
    "Cargo.toml",
  );
  const cargoWorkspaceDependencies = readTomlSection(
    cargoManifest,
    "workspace.dependencies",
    "Cargo.toml",
  );
  const cargoEdition = readTomlString(
    cargoWorkspacePackage,
    "edition",
    "Cargo.toml [workspace.package]",
  );
  const pyo3Requirement = readCargoRequirement(
    cargoWorkspaceDependencies,
    "pyo3",
    "Cargo.toml [workspace.dependencies]",
  );
  const tauriRequirement = readCargoRequirement(
    cargoWorkspaceDependencies,
    "tauri",
    "Cargo.toml [workspace.dependencies]",
  );

  const dockerfile = readRepoFile("docker/fem-gpu/Dockerfile");
  const pythonImageVersion = readDockerValue(
    dockerfile,
    "ARG",
    "PYTHON_VERSION",
    "docker/fem-gpu/Dockerfile",
  );
  const gpuRustChannel = readDockerValue(
    dockerfile,
    "ENV",
    "RUST_TOOLCHAIN",
    "docker/fem-gpu/Dockerfile",
    { allowRepeatedIdenticalValues: true },
  );
  const mfemRef = readDockerValue(dockerfile, "ENV", "MFEM_REF", "docker/fem-gpu/Dockerfile");
  const mfemCommit = readDockerCommit(dockerfile, "MFEM_SOURCE_COMMIT");
  const hypreRef = readDockerValue(dockerfile, "ENV", "HYPRE_REF", "docker/fem-gpu/Dockerfile");
  const hypreCommit = readDockerCommit(dockerfile, "HYPRE_SOURCE_COMMIT");
  const libceedRef = readDockerValue(dockerfile, "ENV", "LIBCEED_REF", "docker/fem-gpu/Dockerfile");
  const libceedCommit = readDockerCommit(dockerfile, "LIBCEED_SOURCE_COMMIT");
  const dockerCudaFallback = readDockerCudaFallback(dockerfile);

  const composeToolchain = readRepoFile("compose.toolchain.yaml");
  const composeCudaDefault = readComposeCudaDefault(composeToolchain);

  const reactVersion = readManifestDependency(packageDependencies, "react", "dependencies");
  assertEqual(
    reactVersion,
    readManifestDependency(packageDependencies, "react-dom", "dependencies"),
    "React and React DOM package declarations",
  );
  const typescriptAlias = readNpmAlias(
    readManifestDependency(packageDevDependencies, "typescript", "devDependencies"),
    "apps/control-room/package.json devDependencies.typescript",
  );
  assertEqual(
    typescriptAlias.packageName,
    "@typescript/typescript6",
    "TypeScript compiler npm alias target",
  );
  assertEqual(
    readManifestDependency(packageDevDependencies, typescriptAlias.packageName, "devDependencies"),
    typescriptAlias.version,
    "TypeScript compiler alias and direct package version",
  );
  const nativeTypescriptAlias = readNpmAlias(
    readManifestDependency(packageDevDependencies, "typescript-native", "devDependencies"),
    "apps/control-room/package.json devDependencies.typescript-native",
  );
  assertEqual(nativeTypescriptAlias.packageName, "typescript", "native TypeScript npm alias target");

  return [
    {
      name: "FullMag",
      version: "Build-reported",
      category: "core",
      isAccent: true,
      source: "apps/control-room/src/modules/start/model/buildInfo.ts",
      basis: "The About view substitutes the build-reported version; this is not a static package pin.",
    },
    badge(
      "Python (package)",
      pythonRequirement,
      "core",
      "packages/fullmag-py/pyproject.toml",
      "Project requires-python compatibility range.",
    ),
    badge(
      "Python (GPU image)",
      pythonImageVersion,
      "core",
      "docker/fem-gpu/Dockerfile",
      "Pinned Python source version declared for the GPU image build.",
    ),
    badge(
      "Rust (workspace)",
      `${rustToolchainChannel} / edition ${cargoEdition}`,
      "core",
      "rust-toolchain.toml; Cargo.toml",
      "Workspace toolchain channel and Cargo edition declarations.",
    ),
    badge(
      "Rust (GPU image)",
      gpuRustChannel,
      "core",
      "docker/fem-gpu/Dockerfile",
      "GPU image build toolchain declaration; not an observed runtime version.",
    ),
    badge(
      "Node.js",
      nodeVersion,
      "core",
      ".node-version; package.json",
      `Repository pin constrained by engines.node ${nodeEngineRange}.`,
    ),
    badge(
      "CUDA (Compose default)",
      composeCudaDefault.version,
      "scientific",
      "compose.toolchain.yaml",
      `Default base image ${composeCudaDefault.imageReference}; host overrides are not read.`,
      true,
    ),
    badge(
      "CUDA (Dockerfile fallback)",
      dockerCudaFallback.version,
      "scientific",
      "docker/fem-gpu/Dockerfile",
      `Fallback base image ${dockerCudaFallback.imageReference}; Compose may override it.`,
    ),
    badge(
      "MFEM",
      mfemRef,
      "scientific",
      "docker/fem-gpu/Dockerfile",
      `GPU image source ref ${mfemRef}, pinned commit ${mfemCommit}.`,
    ),
    badge(
      "hypre",
      hypreRef,
      "scientific",
      "docker/fem-gpu/Dockerfile",
      `GPU image source ref ${hypreRef}, pinned commit ${hypreCommit}.`,
    ),
    badge(
      "libCEED",
      libceedRef,
      "scientific",
      "docker/fem-gpu/Dockerfile",
      `GPU image source ref ${libceedRef}, pinned commit ${libceedCommit}.`,
    ),
    badge(
      "Gmsh",
      gmshRequirement,
      "scientific",
      "packages/fullmag-py/pyproject.toml",
      "Python meshing extra dependency requirement.",
    ),
    badge(
      "NumPy",
      numpyRequirement,
      "scientific",
      "packages/fullmag-py/pyproject.toml",
      "Python project dependency requirement.",
    ),
    badge(
      "PyO3",
      pyo3Requirement,
      "scientific",
      "Cargo.toml",
      "Cargo workspace dependency requirement; not the Cargo.lock resolution.",
    ),
    badge(
      "Next.js",
      readManifestDependency(packageDependencies, "next", "dependencies"),
      "ui",
      "apps/control-room/package.json",
      "Frontend package manifest dependency specifier.",
    ),
    badge(
      "React",
      reactVersion,
      "ui",
      "apps/control-room/package.json",
      "Frontend react and react-dom package manifest specifiers.",
    ),
    badge(
      "TypeScript",
      typescriptAlias.version,
      "ui",
      "apps/control-room/package.json",
      `Direct compiler npm alias to ${typescriptAlias.packageName}.`,
    ),
    badge(
      "TypeScript native",
      nativeTypescriptAlias.version,
      "ui",
      "apps/control-room/package.json",
      "Separate native TypeScript package alias.",
    ),
    badge(
      "Three.js",
      readManifestDependency(packageDependencies, "three", "dependencies"),
      "ui",
      "apps/control-room/package.json",
      "Frontend package manifest dependency specifier.",
    ),
    badge(
      "ECharts",
      readManifestDependency(packageDependencies, "echarts", "dependencies"),
      "ui",
      "apps/control-room/package.json",
      "Frontend package manifest dependency specifier.",
    ),
    badge(
      "Tauri",
      tauriRequirement,
      "ui",
      "Cargo.toml",
      "Cargo workspace dependency requirement; not the Cargo.lock resolution.",
    ),
  ];
}

export function findAboutToolchainDeclarationDrift() {
  try {
    if (!existsSync(generatedPath)) {
      return [`${generatedRepoPath} is missing; regenerate it with node scripts/about-toolchain-declarations.mjs --write.`];
    }
    const expected = createAboutToolchainDeclarations();
    const actual = JSON.parse(readFileSync(generatedPath, "utf8"));
    if (stableJson(actual) !== stableJson(expected)) {
      return [`${generatedRepoPath} is stale; regenerate it with node scripts/about-toolchain-declarations.mjs --write.`];
    }
    return [];
  } catch (error) {
    return [`About toolchain declaration check failed: ${errorMessage(error)}`];
  }
}

function badge(name, version, category, source, basis, isAccent = false) {
  return {
    name,
    version,
    category,
    ...(isAccent ? { isAccent: true } : {}),
    source,
    basis,
  };
}

function readJson(relativePath) {
  const filePath = path.join(repoRoot, relativePath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse required JSON ${relativePath}: ${errorMessage(error)}`);
  }
  return requireObject(parsed, relativePath);
}

function readRepoFile(relativePath) {
  try {
    return readFileSync(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    throw new Error(`Cannot read required declaration ${relativePath}: ${errorMessage(error)}`);
  }
}

function requireObject(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`);
  }
  return value;
}

function requireString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value;
}

function readManifestDependency(dependencies, name, sectionName) {
  return requireString(
    dependencies[name],
    `apps/control-room/package.json ${sectionName}.${name}`,
  );
}

function readPinnedNodeVersion() {
  const source = ".node-version";
  const values = readRepoFile(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (values.length !== 1 || !/^\d+\.\d+\.\d+$/.test(values[0] ?? "")) {
    throw new Error(`${source} must contain exactly one pinned semantic version.`);
  }
  return values[0];
}

function assertNodePinSatisfiesEngine(pin, engineRange) {
  const match = engineRange.match(/^>=(\d+\.\d+\.\d+)\s+<(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported package.json engines.node range ${JSON.stringify(engineRange)}.`);
  }
  const pinParts = parseNumericVersion(pin, ".node-version");
  const minimumParts = parseNumericVersion(match[1], "package.json engines.node");
  const upperMajor = Number(match[2]);
  if (compareNumericVersion(pinParts, minimumParts) < 0 || pinParts[0] >= upperMajor) {
    throw new Error(`.node-version ${pin} does not satisfy package.json engines.node ${engineRange}.`);
  }
}

function parseNumericVersion(version, description) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`${description} must use a numeric x.y.z version.`);
  return match.slice(1).map(Number);
}

function compareNumericVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function readTomlSection(contents, sectionName, source) {
  const lines = contents.split(/\r?\n/);
  const header = `[${sectionName}]`;
  const starts = [];
  lines.forEach((line, index) => {
    if (line.trim() === header) starts.push(index);
  });
  if (starts.length !== 1) {
    throw new Error(`${source} must contain exactly one [${sectionName}] section.`);
  }
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function readTomlValue(section, key, description) {
  const matches = section.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    return match?.[1] === key ? [match[2]] : [];
  });
  if (matches.length !== 1) {
    throw new Error(`${description} must declare ${key} exactly once on a single line.`);
  }
  return matches[0];
}

function readTomlString(section, key, description) {
  const raw = readTomlValue(section, key, description);
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    throw new Error(`${description} ${key} must be a quoted TOML string.`);
  }
  return JSON.parse(raw);
}

function readTomlStringArray(section, key, description) {
  const lines = section.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*\[\s*$/);
    if (match?.[1] === key) starts.push(index);
  });
  if (starts.length !== 1) {
    throw new Error(`${description} must declare ${key} as one multiline string array.`);
  }
  const values = [];
  let closed = false;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "]" || line === "],") {
      closed = true;
      break;
    }
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^"((?:[^"\\]|\\.)*)"\s*,?(?:\s+#.*)?$/);
    if (!match) {
      throw new Error(`${description} ${key} contains a non-literal string-array entry.`);
    }
    values.push(JSON.parse(`"${match[1]}"`));
  }
  if (!closed || values.length === 0) {
    throw new Error(`${description} ${key} must be a closed, non-empty string array.`);
  }
  return values;
}

function readPep508Requirement(requirements, packageName, description) {
  const normalizedName = packageName.toLowerCase().replace(/[-_.]/g, "");
  const matches = requirements.filter((requirement) => {
    const match = requirement.match(/^([A-Za-z0-9_.-]+)/);
    return match?.[1]?.toLowerCase().replace(/[-_.]/g, "") === normalizedName;
  });
  if (matches.length !== 1) {
    throw new Error(`${description} must declare ${packageName} exactly once.`);
  }
  const prefix = matches[0].match(/^([A-Za-z0-9_.-]+)/)?.[1] ?? "";
  const specifier = matches[0].slice(prefix.length).trim();
  if (!specifier) throw new Error(`${description} ${packageName} must have an explicit constraint.`);
  return specifier;
}

function readCargoRequirement(section, dependencyName, description) {
  const raw = readTomlValue(section, dependencyName, description);
  let version;
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    version = JSON.parse(raw);
  } else if (raw.startsWith("{") && raw.endsWith("}")) {
    const versionMatches = [...raw.matchAll(/(?:^\{\s*|,)\s*version\s*=\s*"([^"\\]+)"/g)];
    if (versionMatches.length !== 1) {
      throw new Error(`${description} ${dependencyName} must declare exactly one inline version string.`);
    }
    version = versionMatches[0][1];
  } else {
    throw new Error(`${description} ${dependencyName} must be a string or inline-table dependency.`);
  }
  if (/^\d+\.\d+(?:\.\d+)?$/.test(version)) return `^${version}`;
  if (/^(?:\^|~|=|>=|>|<=|<)\S/.test(version)) return version;
  throw new Error(`${description} ${dependencyName} has unsupported Cargo version requirement ${JSON.stringify(version)}.`);
}

function readNpmAlias(specifier, description) {
  const match = specifier.match(/^npm:(.+)@([^@]+)$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`${description} must use an explicit npm:package@version alias.`);
  }
  return { packageName: match[1], version: match[2] };
}

function readDockerValue(contents, directive, name, source, { allowRepeatedIdenticalValues = false } = {}) {
  const values = contents.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(ARG|ENV)\s+([A-Z0-9_]+)=([^\s#]+)\s*$/);
    return match?.[1] === directive && match?.[2] === name ? [match[3]] : [];
  });
  if (values.length === 0 || (!allowRepeatedIdenticalValues && values.length !== 1)) {
    throw new Error(`${source} must declare ${directive} ${name} ${allowRepeatedIdenticalValues ? "at least once" : "exactly once"}.`);
  }
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length !== 1) {
    throw new Error(`${source} has conflicting ${directive} ${name} declarations.`);
  }
  return uniqueValues[0];
}

function readDockerCommit(contents, name) {
  const commit = readDockerValue(contents, "ENV", name, "docker/fem-gpu/Dockerfile");
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`docker/fem-gpu/Dockerfile ENV ${name} must be a full lowercase Git commit.`);
  }
  return commit;
}

function readDockerCudaFallback(contents) {
  const lines = contents.split(/\r?\n/).filter((line) => /^\s*ARG\s+FULLMAG_CUDA_BASE_IMAGE=/.test(line));
  if (lines.length !== 1) {
    throw new Error("docker/fem-gpu/Dockerfile must declare one CUDA base-image fallback.");
  }
  const match = lines[0].match(/^\s*ARG\s+FULLMAG_CUDA_BASE_IMAGE="([^"]+)"\s*$/);
  const imageReference = match?.[1];
  const versionMatch = imageReference?.match(/^nvidia\/cuda:(\d+\.\d+\.\d+)-devel-ubuntu\d+\.\d+$/);
  if (!imageReference || !versionMatch) {
    throw new Error(`Unsupported Dockerfile CUDA fallback reference ${JSON.stringify(imageReference)}.`);
  }
  return { imageReference, version: versionMatch[1] };
}

function readComposeCudaDefault(contents) {
  const imageLines = contents.split(/\r?\n/).filter((line) => /^\s*FULLMAG_CUDA_BASE_IMAGE\s*:/.test(line));
  const digestLines = contents.split(/\r?\n/).filter((line) => /^\s*FULLMAG_CUDA_BASE_IMAGE_DIGEST\s*:/.test(line));
  if (imageLines.length !== 1 || digestLines.length !== 1) {
    throw new Error("compose.toolchain.yaml must declare one CUDA image default and one digest default.");
  }
  const imageMatch = imageLines[0].match(/^\s*FULLMAG_CUDA_BASE_IMAGE\s*:\s*"\$\{FULLMAG_CUDA_BASE_IMAGE:-([^}]+)\}"\s*$/);
  const digestMatch = digestLines[0].match(/^\s*FULLMAG_CUDA_BASE_IMAGE_DIGEST\s*:\s*"\$\{FULLMAG_CUDA_BASE_IMAGE_DIGEST:-([^}]+)\}"\s*$/);
  const imageReference = imageMatch?.[1];
  const declaredDigest = digestMatch?.[1];
  const versionMatch = imageReference?.match(/^nvidia\/cuda:(\d+\.\d+\.\d+)-devel-ubuntu\d+\.\d+@sha256:([a-f0-9]{64})$/);
  if (!imageReference || !declaredDigest || !versionMatch) {
    throw new Error(`Unsupported Compose CUDA default image or digest: ${JSON.stringify(imageReference)}.`);
  }
  assertEqual(versionMatch[2], declaredDigest, "Compose CUDA image and digest defaults");
  return { imageReference, version: versionMatch[1] };
}

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description} disagree: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}.`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runCli(args) {
  const mode = args.length === 0 ? "--check" : args.length === 1 ? args[0] : null;
  if (mode !== "--check" && mode !== "--write") {
    console.error("Usage: node scripts/about-toolchain-declarations.mjs [--check|--write]");
    process.exitCode = 2;
    return;
  }
  try {
    if (mode === "--write") {
      const output = `${JSON.stringify(createAboutToolchainDeclarations(), null, 2)}\n`;
      writeFileSync(generatedPath, output, "utf8");
      console.log(`Wrote ${generatedRepoPath}.`);
      return;
    }
    const failures = findAboutToolchainDeclarationDrift();
    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log("About toolchain declarations are current.");
  } catch (error) {
    console.error(`About toolchain declaration generation failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli(process.argv.slice(2));
}
