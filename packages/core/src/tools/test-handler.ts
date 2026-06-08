import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

// ── Types ────────────────────────────────────────────────────────────

type TestResult = {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  failures: TestFailure[];
  summary: string;
  truncated: boolean;
};

type TestFailure = {
  name: string;
  file?: string;
  line?: number;
  message: string;
  diagnosis?: string;
};

// ── Framework patterns ──────────────────────────────────────────────────
// Custom test framework: T(name), OK(), NG(msg)
const T_PASS_RE = /^T\s*\(\s*["']([^"']+)["']\s*\)\s*[=:]\s*(PASS|OK|passed|1|true)/im;
const T_FAIL_RE = /^T\s*\(\s*["']([^"']+)["']\s*\)\s*[=:]\s*(FAIL|NG|failed|0|false)/im;
const NG_RE = /NG\s*[:(]\s*(.+)$/im;
// Common PASS/FAIL markers
const PASS_RE = /^(?:PASS|\[\s*PASS\s*\]|\u2713)\s*:?\s*(.+)$/im;
const FAIL_RE = /^(?:FAIL|\[\s*FAIL\s*\]|\u2717)\s*:?\s*(.+)$/im;
// Summary patterns
const TEST_COUNT_RE = /(\d+)\s*\/(\d+)\s*(?:passed|tests passed|ok)/im;
const ALL_PASSED_RE = /all\s+(\d+)\s*(?:tests?\s+)?passed/im;
// GoogleTest
const GTEST_PASS_RE = /\[\s*PASSED\s*\]\s+(\d+)\s+test/im;
const GTEST_FAIL_RE = /\[\s*FAILED\s*\]\s+(\d+)\s+test/im;
const GTEST_CASE_RE = /\[\s*(PASSED|FAILED)\s*\].*$/im;
// Catch2
const CATCH2_SUMMARY_RE = /test\s+cases?:\s*(\d+)\s*\|\s*(\d+)\s+passed\s*\|\s*(\d+)\s+failed/im;
const CATCH2_PASS_RE = /^(PASSED|FAILED):\s*(.+)$/im;
// CTest
const CTEST_SUMMARY_RE = /(\d+)%\s*tests\s+passed,\s*(\d+)\s+tests\s+failed/im;
// TAP
const TAP_OK_RE = /^ok\s+\d+\s*[- ](.+)$/im;
const TAP_NOTOK_RE = /^not\s+ok\s+\d+\s*[- ](.+)$/im;

export async function handleTestTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  const binary = typeof args.binary === "string" ? args.binary.trim() : "";
  const filter = typeof args.filter === "string" ? args.filter.trim() : "";
  const timeout = typeof args.timeout === "number" ? Math.max(5, args.timeout) : 60;

  // Resolve project directory
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
      name: "test",
      error: `Project directory not found: ${projectDir}`,
    };
  }

  // Resolve binary path
  let binaryPath = binary;
  if (!path.isAbsolute(binaryPath)) {
    binaryPath = path.join(projectDir, binaryPath || findTestBinary(projectDir));
  }

  if (!fs.existsSync(binaryPath)) {
    // Try to build first
    return {
      ok: false,
      name: "test",
      error: `Test binary not found: ${binaryPath}. Try running the build tool first.`,
      metadata: { searched_path: binaryPath, project_dir: projectDir },
    };
  }

  const startTime = Date.now();
  const pid = `test-${Date.now()}`;
  const command = `${binaryPath}${filter ? ` --filter "${filter}"` : ""}`;
  context.onProcessStart?.(pid, command);

  try {
    const result = await executeTest(binaryPath, filter, projectDir, timeout);
    const durationMs = Date.now() - startTime;
    const parsed = parseTestOutput(result.stdout + "\n" + result.stderr, durationMs);
    for (const f of parsed.failures) f.diagnosis = diagnoseFailure(f.name, projectDir);

    // ── Confidence: derive certainty from test outcome ───────────────
    // TC_NONE:      all tests pass → fully certain
    // TC_CARRY:     passed but with warnings/diagnostics in output
    // TC_UNCERTAIN: test failures exist → semantic uncertainty
    // TC_MIXED:     failures with ambiguous diagnosis (cannot determine root cause)
    const testTcState =
      parsed.ok && parsed.passed === parsed.total
        ? "TC_NONE"
        : parsed.ok && parsed.failures.length === 0
          ? "TC_CARRY"
          : parsed.failures.some(
                (f) => !f.diagnosis || f.diagnosis === "(unavailable)" || f.diagnosis === "Test not found",
              )
            ? "TC_MIXED"
            : "TC_UNCERTAIN";

    const output = buildTestOutput(parsed);

    return {
      ok: parsed.ok,
      name: "test",
      output,
      tcState: testTcState,
      metadata: {
        project,
        binary: binaryPath,
        total: parsed.total,
        passed: parsed.passed,
        failed: parsed.failed,
        duration_ms: durationMs,
        failures: parsed.failures.length > 0 ? parsed.failures : undefined,
        truncated: parsed.truncated,
        filter: filter || undefined,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name: "test",
      error: `Test execution failed: ${message}`,
    };
  } finally {
    context.onProcessExit?.(pid);
  }
}

// ── Binary discovery ─────────────────────────────────────────────────

function findTestBinary(dir: string): string {
  const candidates = ["test_all", "test", "run_tests", "test_runner", "tests", "all_tests"];
  for (const name of candidates) {
    const fullPath = path.join(dir, name);
    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) return name;
      } catch {
        // try next
      }
    }
  }

  // Find any executable with "test" in name
  try {
    const entries = fs.readdirSync(dir);
    for (const e of entries) {
      if (e.includes("test") || e.includes("Test")) {
        const fullPath = path.join(dir, e);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && (stat.mode & 0o111) !== 0) return e;
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  return "./test_all";
}

// ── Execution ────────────────────────────────────────────────────────

function executeTest(
  binaryPath: string,
  filter: string,
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, filter ? [filter] : [], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeout * 1000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("close", () => resolve({ stdout, stderr }));
    child.on("error", (err) => reject(err));
  });
}

// ── Output parsing ───────────────────────────────────────────────────

const MAX_OUTPUT = 5000;

function parseTestOutput(raw: string, durationMs: number): TestResult {
  const lines = raw.split("\n");
  const failures: TestFailure[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;

  // Strategy: try multiple patterns
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    // Pattern 1: Custom T("name") = PASS/FAIL
    const tPass = line.match(T_PASS_RE);
    if (tPass) {
      total += 1;
      passed += 1;
      continue;
    }
    const tFail = line.match(T_FAIL_RE);
    if (tFail) {
      total += 1;
      failed += 1;
      // Look for NG message in remaining lines until next T() or end
      let msg = "";
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim().match(T_PASS_RE) || lines[j].trim().match(T_FAIL_RE)) break;
        const ngMatch = lines[j].match(NG_RE);
        if (ngMatch) {
          msg = ngMatch[1].trim();
          break;
        }
      }
      failures.push({
        name: tFail[1],
        message: msg || "Assertion failed (no NG message)",
        line: i + 1,
      });
      continue;
    }

    // Pattern 2: PASS/FAIL marker at start
    const passMatch = line.match(PASS_RE);
    if (passMatch) {
      total += 1;
      passed += 1;
      continue;
    }
    const failMatch = line.match(FAIL_RE);
    if (failMatch && !line.startsWith("#")) {
      total += 1;
      failed += 1;
      const name = failMatch[1].trim();
      failures.push({
        name: name.substring(0, 80),
        message: name,
        line: i + 1,
      });
      continue;
    }

    // Pattern 3: GoogleTest [  PASSED  ] / [  FAILED  ]
    const gtestPass = line.match(GTEST_CASE_RE);
    if (gtestPass && gtestPass[1] === "PASSED") {
      total += 1;
      passed += 1;
      continue;
    }
    if (gtestPass && gtestPass[1] === "FAILED") {
      total += 1;
      failed += 1;
      failures.push({ name: `GTEST: ${line.substring(0, 60)}`, message: line.substring(0, 100), line: i + 1 });
      continue;
    }

    // Pattern 4: Catch2 PASSED:/FAILED:
    const catch2Match = line.match(CATCH2_PASS_RE);
    if (catch2Match) {
      total += 1;
      if (catch2Match[1] === "PASSED") {
        passed += 1;
      } else {
        failed += 1;
        failures.push({ name: catch2Match[2].substring(0, 60), message: catch2Match[2], line: i + 1 });
      }
      continue;
    }

    // Pattern 5: TAP ok / not ok
    const tapNotOk = line.match(TAP_NOTOK_RE);
    if (tapNotOk) {
      total += 1;
      failed += 1;
      failures.push({ name: tapNotOk[1].substring(0, 60), message: tapNotOk[1], line: i + 1 });
      continue;
    }
    const tapOk = line.match(TAP_OK_RE);
    if (tapOk) {
      total += 1;
      passed += 1;
      continue;
    }
  }

  // If no tests found via patterns, try summary patterns
  if (total === 0) {
    for (const line of lines) {
      const countMatch = line.match(TEST_COUNT_RE);
      if (countMatch) {
        passed = parseInt(countMatch[1], 10);
        total = parseInt(countMatch[2], 10);
        failed = total - passed;
        break;
      }
      const allMatch = line.match(ALL_PASSED_RE);
      if (allMatch) {
        total = parseInt(allMatch[1], 10);
        passed = total;
        failed = 0;
        break;
      }
      // "X/Y test(s) passed"
      const altMatch = line.match(/(\d+)\s+of\s+(\d+)\s+test/i);
      if (altMatch) {
        passed = parseInt(altMatch[1], 10);
        total = parseInt(altMatch[2], 10);
        failed = total - passed;
        break;
      }
    }
  }

  // Fallback: if raw text shows no failures, assume success
  if (total === 0 && raw.length > 0) {
    // Try to count unique test names
    const testNames = new Set<string>();
    for (const line of lines) {
      const nameMatch = line.match(/^T\s*\(\s*["']([^"']+)["']\s*\)/);
      if (nameMatch) testNames.add(nameMatch[1]);
    }
    total = testNames.size || 1;
    passed = raw.toUpperCase().includes("FAIL") ? total - 1 : total;
    failed = total - passed;
  }

  const truncated = raw.length > MAX_OUTPUT;

  return {
    ok: failed === 0 && total > 0,
    total,
    passed,
    failed,
    durationMs,
    failures,
    summary: `${passed}/${total} passed${failed > 0 ? ` (${failed} failed)` : ""}`,
    truncated,
  };
}

function diagnoseFailure(name: string, projectDir: string): string {
  try {
    const files = findTestFiles(projectDir);
    let testCode = "";
    let testFile = "";
    for (const f of files) {
      const content = fs.readFileSync(f, "utf8");
      const escaped = name.replace(/["']/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("T\\s*\\(\\s*[\"']" + escaped + "[\"']\\s*\\)");
      const tMatch = content.match(re);
      if (tMatch) {
        testFile = f;
        const lines = content.split("\n");
        const lineIdx = content.substring(0, tMatch.index).split("\n").length - 1;
        testCode = lines.slice(Math.max(0, lineIdx - 1), Math.min(lines.length, lineIdx + 6)).join("\n");
        break;
      }
    }
    if (!testFile) return "Test not found";
    const fn = name.replace(/^test_/, "");
    const ff = findFuncFile(fn, projectDir);
    let d = "Test: " + path.relative(projectDir, testFile);
    if (ff) d += "\nFunc: " + fn + " -> " + path.relative(projectDir, ff);
    d += "\n" + testCode;
    return d;
  } catch {
    return "(unavailable)";
  }
}

function findTestFiles(dir: string): string[] {
  let results: any = [];
  try {
    if (!results) results = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isFile() && (e.name.startsWith("test_") || e.name.includes("_test")) && /\.(c|cpp)$/.test(e.name))
        results!.push(f);
      else if (e.isDirectory() && !e.name.startsWith(".")) results.push(...findTestFiles(f));
    }
  } catch {}
  return results;
}

function findFuncFile(name: string, dir: string): string | null {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isFile() && /\.(c|h)$/.test(e.name)) {
        if (fs.readFileSync(f, "utf8").includes(name + "(")) return f;
      } else if (e.isDirectory() && !e.name.startsWith(".")) {
        const found: string | null = findFuncFile(name, f);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function buildTestOutput(result: TestResult): string {
  const lines: string[] = [`Results: ${result.summary}`, `Duration: ${result.durationMs}ms`];

  if (result.failures.length > 0) {
    lines.push("");
    lines.push(`Failures (${result.failures.length}):`);
    for (const f of result.failures) {
      const loc = f.line ? ` (line ${f.line})` : "";
      lines.push(`  ✗ ${f.name}${loc}`);
      if (f.message) lines.push("    " + f.message);
      if (f.diagnosis) lines.push("    Dx: " + f.diagnosis.split("\n")[0].substring(0, 200));
    }
  }

  if (result.truncated) {
    lines.push("");
    lines.push("(Output was truncated due to length)");
  }

  return lines.join("\n");
}
