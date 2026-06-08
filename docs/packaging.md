# Packaging Guide

## Build Overview

Hex4Code is an npm workspaces monorepo consisting of three packages. The build order is:

```
@hex4code/core (typecheck) → hex4code-vscode (esbuild bundle) → @hex4code/cli (typecheck + lint + esbuild bundle)
```

| Step | Package | Artifact | Purpose |
|:----:|:--------|:---------|:--------|
| 1 | `@hex4code/core` | Source code referenced directly (no standalone JS compilation) | Shared core engine, referenced by CLI and VS Code |
| 2 | `hex4code-vscode` | `vscode/out/extension.js` | VS Code extension |
| 3 | `@hex4code/cli` | `packages/cli/dist/cli.js` | Terminal executable |

## Prerequisites

- **Node.js** >= 18.17.0
- **npm** >= 9
- For VS Code extension packaging: `npx vsce` (installed automatically with npm)

## One-Command Build

```bash
npm run build
```

This command runs sequentially: `build:core` → `build:vscode` → `build:cli`.

---

## Detailed Build Steps

### 1. Core Engine (@hex4code/core)

```bash
npm run build:core
# Actually executes: cd packages/core && npm run build
# → npx tsc --noEmit
```

**Note**: The core package does not compile JS output; it only performs TypeScript type checking. The source code is referenced directly by the CLI during esbuild bundling via the `--alias` flag, avoiding double compilation.

### 2. VS Code Extension (hex4code-vscode)

```bash
npm run build:vscode
# Actually executes: cd vscode && npm run bundle
```

esbuild flags:

| Flag | Description |
|------|-------------|
| `--platform=node` | Node.js platform |
| `--format=cjs` | CommonJS format (required by VS Code) |
| `--external:vscode` | Exclude vscode API, provided by VS Code runtime |
| `--sourcemap` | Generate sourcemap for debugging |

**Output**: `vscode/out/extension.js`

### 3. CLI Application (@hex4code/cli)

```bash
npm run build:cli
# Actually executes: cd packages/cli && npm run build
```

Three-step workflow:

```
npm run check         → typecheck + ESLint + Prettier format check
npm run bundle        → esbuild bundle into a single file
chmod +x dist/cli.js → add executable permission
```

esbuild flags explained:

| Flag | Description |
|------|-------------|
| `--bundle` | Bundle all dependencies into a single file |
| `--platform=node` | Node.js platform |
| `--format=esm` | ESM module format |
| `--target=node18` | Compatible with Node.js 18+ |
| `--banner:js="#!/usr/bin/env node"` | Add shebang for direct execution |
| `--jsx=automatic` | React JSX automatic runtime |
| `--packages=external` | Do not bundle node_modules dependencies |
| `--alias:@hex4code/core=../core/src` | Point core package to source directory |

**Output**: `packages/cli/dist/cli.js` (single-file ESM with shebang)

---

## Build Artifacts

| Artifact | Path | Format | Directly Executable |
|:---------|:-----|:------:|:-------------------:|
| CLI application | `packages/cli/dist/cli.js` | ESM | ✅ (includes `#!/usr/bin/env node`) |
| VS Code extension | `vscode/out/extension.js` | CJS | ❌ (requires VS Code to load) |

## VS Code Extension (.vsix) Packaging

First compile the extension, then package it as a `.vsix` installable archive:

```bash
# 1. Compile the extension
npm run build:vscode

# 2. Package as .vsix
cd vscode
npx vsce package --baseImagesUrl=https://github.com/ZZWGBDT/Hex4Code
```

**Output**: `vscode/hex4code-vscode-<version>.vsix`

Installation:

```bash
code --install-extension vscode/hex4code-vscode-1.1.0.vsix
```

## Build Verification

After building, verify the artifacts:

```bash
# Verify CLI
node packages/cli/dist/cli.js --help
# Should display help information

# Verify VS Code extension (check file exists)
ls -la vscode/out/extension.js

# Verify .vsix package (if packaged)
ls -la vscode/*.vsix
```

## Troubleshooting

| Issue | Possible Cause | Solution |
|:------|:---------------|:---------|
| `esbuild` build fails | Node.js version too old | Ensure Node.js >= 18.17.0 |
| `tsc --noEmit` type errors | Code type mismatch | Fix type errors and retry |
| `vsce package` fails | Incorrect publisher or version config | Check the `publisher` and `version` fields in `vscode/package.json` |
| `npm run build:cli` permission error | `chmod` fails on Windows | Does not affect the artifact; manually run `chmod +x dist/cli.js` |
| `--alias` path not found | Incorrect working directory | Ensure `npm run build:cli` is executed from the project root |
| `build` interrupted by Prettier format check failure | Code style inconsistent with project config (indentation, spacing, line endings, quotes, etc.) | In the `packages/cli` directory, run `npx prettier --write "src/**/*.{ts,tsx}"` or `npm run format` to auto-fix, then re-run `npm run build` |
