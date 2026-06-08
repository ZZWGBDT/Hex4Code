import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import type { TCType } from "./executor";

const MAX_OUTPUT_CHARS = 8000;

type BuildResult = {
  ok: boolean;
  project: string;
  errors: BuildError[];
  warnings: BuildError[];
  durationMs: number;
  exitCode: number | null;
  truncated: boolean;
};

type BuildError = {
  file: string;
  line: number;
  column: number;
  type: "error" | "warning";
  message: string;
};

const GCC_ERROR_RE = /^([^:]+):(\d+):(\d+):\s+(error|warning):\s+(.+)$/m;
// Extended error patterns for gcc/clang/make/ld
const FATAL_ERROR_RE = /^([^:]+):(\d+):(\d+):\s+fatal\s+error:\s+(.+)$/m;
const MAKE_ERROR_RE = /^([^:]+):(\d+):\s+\*\*\*\s+(.+)$/m;
const NOTE_RE = /^([^:]+):(\d+):(\d+):\s+note:\s+(.+)$/m;
const LD_ERROR_RE = /undefined reference to/i;
const CLANG_ERROR_RE = /^([^:]+):(\d+):(\d+):\s+\{?error:\s+(.+)$/m;

export async function handleBuildTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const clean = args.clean === true;
  const flags = typeof args.flags === "string" ? args.flags.trim() : "";

  let projectDir: string;
  if (project && path.isAbsolute(project)) {
    projectDir = project;
  } else if (project) {
    projectDir = path.join(context.projectRoot, project);
  } else {
    projectDir = context.projectRoot;
  }

  if (!fs.existsSync(projectDir)) {
    return {
      ok: false,
      name: "build",
      error: `Project directory not found: ${projectDir}`,
    };
  }

  // Detect build system
  const buildSystem = detectBuildSystem(projectDir);
  if (!buildSystem) {
    return {
      ok: false,
      name: "build",
      error: `No build system detected in ${projectDir}. Supported: Makefile, CMake, Cargo (Rust), package.json (Node.js), go.mod (Go), pom.xml (Maven), build.gradle (Gradle), pyproject.toml/setup.py (Python). Use bash for other build tools.`,
    };
  }

  // Determine source files for manual compilation fallback
  const sourceFiles = collectSourceFiles(projectDir);

  const buildCommand = buildBuildCommand(projectDir, buildSystem, target, clean, flags, sourceFiles);
  const startTime = Date.now();

  const pid = `${project}-build-${Date.now()}`;
  context.onProcessStart?.(pid, buildCommand.command);

  try {
    const result = await executeBuild(buildCommand.command, projectDir, pid);
    const durationMs = Date.now() - startTime;
    const parsed = parseBuildOutput(result.stdout + "\n" + result.stderr, projectDir, durationMs, result.exitCode);

    // ── Confidence: derive certainty from build outcome ──────────────
    // TC_NONE:      clean build, no errors or warnings → fully certain
    // TC_CARRY:     build OK but warnings exist → arithmetic uncertainty
    // TC_UNCERTAIN: build failed (errors) → semantic uncertainty
    // TC_MIXED:     errors AND warnings present → mixed signals
    const buildTcState =
      parsed.ok && parsed.warnings.length === 0
        ? "TC_NONE"
        : parsed.ok && parsed.warnings.length > 0
          ? "TC_CARRY"
          : !parsed.ok && parsed.warnings.length === 0
            ? "TC_UNCERTAIN"
            : "TC_MIXED";

    if (parsed.ok) {
      return {
        ok: true,
        name: "build",
        output: `Build succeeded in ${durationMs}ms.`,
        tcState: buildTcState,
        metadata: {
          project,
          duration_ms: durationMs,
          target: target || "(default)",
          errors: parsed.errors,
          warnings: parsed.warnings,
          truncated: parsed.truncated,
        },
      };
    }

    // Build failed - return structured errors
    const errorSummary =
      parsed.errors.length > 0
        ? `Build failed (${parsed.errors.length} errors, ${parsed.warnings.length} warnings):\n${parsed.errors
            .slice(0, 10)
            .map((e) => `  ${e.file}:${e.line}:${e.column} [${e.type}] ${e.message}`)
            .join("\n")}${parsed.errors.length > 10 ? `\n  ... and ${parsed.errors.length - 10} more errors` : ""}`
        : `Build failed with exit code ${result.exitCode}. No parseable errors found. Raw output:\n${truncateOutput(result.stdout, 2000)}`;

    return {
      ok: false,
      name: "build",
      error: errorSummary,
      tcState: buildTcState,
      metadata: {
        project,
        duration_ms: durationMs,
        errors: parsed.errors,
        warnings: parsed.warnings,
        exit_code: result.exitCode,
        truncated: parsed.truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name: "build",
      error: `Build execution failed: ${message}`,
    };
  } finally {
    context.onProcessExit?.(pid);
  }
}

type BuildSystem = "make" | "cmake" | "cargo" | "npm" | "go" | "maven" | "gradle" | "python";

type BuildSystemInfo = {
  type: BuildSystem;
  file: string;
};

function detectBuildSystem(dir: string): BuildSystemInfo | null {
  const buildFiles: Array<{ file: string; type: BuildSystem }> = [
    // C/C++
    { file: "Makefile", type: "make" },
    { file: "makefile", type: "make" },
    { file: "GNUmakefile", type: "make" },
    { file: "CMakeLists.txt", type: "cmake" },
    // Rust
    { file: "Cargo.toml", type: "cargo" },
    // Node.js
    { file: "package.json", type: "npm" },
    // Go
    { file: "go.mod", type: "go" },
    // Java
    { file: "pom.xml", type: "maven" },
    // Gradle
    { file: "build.gradle", type: "gradle" },
    { file: "build.gradle.kts", type: "gradle" },
    // Python
    { file: "pyproject.toml", type: "python" },
    { file: "setup.py", type: "python" },
    { file: "setup.cfg", type: "python" },
  ];

  // Search current directory
  for (const bf of buildFiles) {
    const fullPath = path.join(dir, bf.file);
    if (fs.existsSync(fullPath)) {
      return { type: bf.type, file: fullPath };
    }
  }

  // Search common build subdirectories (for CMake/build directories)
  for (const sub of ["build", "cmake", "out", "builddir"]) {
    const subDir = path.join(dir, sub);
    if (fs.existsSync(subDir)) {
      for (const bf of buildFiles) {
        const fullPath = path.join(subDir, bf.file);
        if (fs.existsSync(fullPath)) return { type: bf.type, file: fullPath };
      }
    }
  }

  return null;
}

function collectSourceFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".c") || f.endsWith(".cpp") || f.endsWith(".rs") || f.endsWith(".go"));
  } catch {
    return [];
  }
}

function buildBuildCommand(
  projectDir: string,
  buildSystem: BuildSystemInfo,
  target: string,
  clean: boolean,
  flags: string,
  sourceFiles: string[],
): { command: string; cwd: string } {
  const sq = (s: string) => shellQuote(s);

  switch (buildSystem.type) {
    case "make": {
      const cmds: string[] = [];
      if (clean) {
        cmds.push(`make -C ${sq(projectDir)} clean 2>&1`);
      }
      const makeArgs = [`-C`, sq(projectDir)];
      if (target) makeArgs.push(target);
      if (flags) makeArgs.push(flags);
      cmds.push(`make ${makeArgs.join(" ")} 2>&1`);
      return { command: cmds.join("; "), cwd: projectDir };
    }

    case "cmake": {
      return {
        command: `cd ${sq(projectDir)} && cmake --build . ${target ? `--target ${target}` : ""} 2>&1`,
        cwd: projectDir,
      };
    }

    case "cargo": {
      const cmds: string[] = [];
      if (clean) {
        cmds.push(`cargo clean 2>&1`);
      }
      const buildType = target || "";
      cmds.push(`cargo build ${buildType ? `--${buildType}` : ""} 2>&1`);
      return { command: cmds.join("; "), cwd: projectDir };
    }

    case "npm": {
      const cmds: string[] = [];
      if (clean) {
        cmds.push(`rm -rf node_modules dist 2>/dev/null; npm install 2>&1`);
      }
      const script = target || "build";
      cmds.push(`npm run ${script} 2>&1`);
      return { command: cmds.join("; "), cwd: projectDir };
    }

    case "go": {
      const cmds: string[] = [];
      if (clean) {
        cmds.push(`go clean 2>&1`);
      }
      const pkg = target || "./...";
      cmds.push(`go build ${pkg} 2>&1`);
      return { command: cmds.join("; "), cwd: projectDir };
    }

    case "maven": {
      const cmds: string[] = [];
      const goal = target || "compile";
      if (clean) {
        cmds.push(`mvn clean 2>&1`);
      }
      cmds.push(`mvn ${goal} 2>&1`);
      return { command: cmds.join("; "), cwd: projectDir };
    }

    case "gradle": {
      const cmds: string[] = [];
      const task = target || "build";
      if (clean) {
        cmds.push(`gradle clean 2>&1`);
      }
      cmds.push(`gradle ${task} 2>&1`);
      return { command: cmds.join("; "), cwd: projectDir };
    }

    case "python": {
      const cmds: string[] = [];
      if (clean) {
        cmds.push(`rm -rf dist build *.egg-info 2>/dev/null`);
      }
      if (target === "install" || flags.includes("install")) {
        cmds.push(`pip install -e . 2>&1`);
      } else {
        // Default: run a target script or sdist
        const pyTarget = target && fs.existsSync(path.join(projectDir, target))
          ? `python ${target}`
          : `python -m build 2>&1 || python setup.py build 2>&1`;
        cmds.push(pyTarget);
      }
      return { command: cmds.join("; "), cwd: projectDir };
    }

    default:
      throw new Error(`Unsupported build system: ${(buildSystem as any).type}`);
  }
}

const BUILD_TIMEOUT_MS = 300_000; // 5 minutes default

function executeBuild(
  command: string,
  cwd: string,
  pid: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    // Timeout: SIGTERM then SIGKILL
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
      stderr += `\n[BUILD TIMEOUT] Build exceeded ${BUILD_TIMEOUT_MS / 1000}s limit.\n`;
      resolve({ stdout, stderr, exitCode: 124 });
    }, BUILD_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : null });
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      stderr += `\n[Spawn error] ${err.message}\n`;
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

function parseBuildOutput(
  output: string,
  projectDir: string,
  durationMs: number,
  exitCode: number | null,
): BuildResult {
  const errors: BuildError[] = [];
  const warnings: BuildError[] = [];

  // Reset regex lastIndex
  GCC_ERROR_RE.lastIndex = 0;

  // Parse each line with extended patterns
  const lines = output.split("\n");
  for (const line of lines) {
    // Match gcc/clang error/warning, fatal error, clang-style error
    const m = line.match(GCC_ERROR_RE) || line.match(FATAL_ERROR_RE) || line.match(CLANG_ERROR_RE);
    if (m) {
      const entry: BuildError = {
        file: m[1],
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        type: m[4] === "warning" ? "warning" : "error",
        message: m[m.length - 1],
      };
      if (entry.type === "error") errors.push(entry);
      else warnings.push(entry);
      continue;
    }
    // Match make errors (no column field)
    const makeM = line.match(MAKE_ERROR_RE);
    if (makeM) {
      errors.push({ file: makeM[1], line: parseInt(makeM[2], 10), column: 0, type: "error", message: makeM[3] });
      continue;
    }
    // Match linker errors
    if (LD_ERROR_RE.test(line)) {
      errors.push({ file: "(linker)", line: 0, column: 0, type: "error", message: line.trim().substring(0, 200) });
    }
  }

  const truncated = output.length > MAX_OUTPUT_CHARS;
  const ok = exitCode === 0 && errors.length === 0;

  return { ok, project: projectDir, errors, warnings, durationMs, exitCode, truncated };
}

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output;
  return output.slice(0, maxLen) + `\n... (truncated, total ${output.length} chars)`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
