## Test

Runs a test binary and parses its output into structured PASS/FAIL results. Understands the HEX4 custom test framework (`T(name)` / `OK()` / `NG()` macros) as well as common formats (PASS/FAIL markers, "X/Y tests passed" summaries).

Key benefits over bash+./test_all:
- Returns structured pass/fail counts instead of raw terminal output
- Extracts failure names and error messages automatically
- Supports auto-discovery of test binaries
- Timeout protection prevents hanging on runaway tests

Usage:
- `test({binary: "./test_all"})` — run all tests
- `test({project: "HEX4密码"})` — auto-discover and run tests in a project
- `test({binary: "./test_all", filter: "tc_inject"})` — run specific test by name
- `test({binary: "./test_all", timeout: 120})` — with custom timeout

HEX4 test framework recognition:
- `T("test_name") = PASS` — pass
- `T("test_name") = FAIL` → failure extracted
- `OK()` / `NG(message)` — assertion result
- `X/Y passed` — summary line

```json
{
  "type": "object",
  "properties": {
    "project": {
      "description": "Project subdirectory where the test binary lives",
      "type": "string"
    },
    "binary": {
      "description": "Test binary path (auto-discovers if omitted)",
      "type": "string"
    },
    "filter": {
      "description": "Test name filter passed to the binary",
      "type": "string"
    },
    "timeout": {
      "description": "Timeout in seconds (default 60)",
      "type": "number"
    }
  },
  "additionalProperties": false
}
```
