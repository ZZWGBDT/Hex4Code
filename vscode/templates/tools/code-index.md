## CodeIndex

Searches for C/C++ symbols (functions, structs, enums, macros, typedefs) across the codebase using an in-memory index. Supports fuzzy matching by name.

Key benefits over bash+grep:
- Returns structured results with file:line, signatures, and doc comments
- No need to pipe through grep/sort/awk
- Understands C syntax — distinguishes function definitions from calls
- Much lower token cost than raw grep output

Usage:
- `codeIndex({query: "tc_propagate"})` — fuzzy find all symbols containing "tc_propagate"
- `codeIndex({query: "TCState", type: "struct"})` — find struct definitions only
- `codeIndex({query: "hex4_ternary", project: "HEX4密码"})` — limit to a project
- `codeIndex({query: "H4_OK", type: "macro"})` — find macro definitions

```json
{
  "type": "object",
  "properties": {
    "query": {
      "description": "Symbol name to search (case-insensitive fuzzy match)",
      "type": "string"
    },
    "type": {
      "description": "Filter by symbol kind",
      "enum": ["function", "struct", "enum", "macro", "typedef"]
    },
    "project": {
      "description": "Limit search to a project subdirectory",
      "type": "string"
    },
    "context": {
      "description": "Context lines to show (1-20)",
      "type": "number"
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```
