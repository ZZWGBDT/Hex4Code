## Build

Compiles a C/C++ project and returns structured compile errors and warnings instead of raw terminal output. Supports Makefile-based projects.

Key benefits over bash+make:
- Parses gcc/clang error output into structured `{file, line, column, type, message}` format
- Only returns error metadata (~50 tokens) instead of thousands of lines of raw compiler output
- Handles clean builds, custom targets, and extra compile flags

Usage:
- Build a project: `build({project: "HEX4密码"})`
- Build a specific target: `build({project: "HEX4密码", target: "test_all"})`
- Clean build: `build({project: "HEX4密码", clean: true})`

Supported build systems:
- Makefile (auto-detected in project directory)
- CMake (via cmake --build, when Makefile not present)

```json
{
  "type": "object",
  "properties": {
    "project": {
      "description": "Project subdirectory or absolute path",
      "type": "string"
    },
    "target": {
      "description": "Make target to build (e.g., test_all, all, clean)",
      "type": "string"
    },
    "clean": {
      "description": "Run make clean first",
      "type": "boolean",
      "default": false
    },
    "flags": {
      "description": "Extra flags to pass to make",
      "type": "string"
    }
  },
  "additionalProperties": false
}
```
