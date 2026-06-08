<div align="center">
<pre>
  _   _                  _    _  __ 
 | | | |_____  ___ __ _| | _| |/ _|
 | |_| / _ \ \/ / '__| | | | | | |_
 |  _  |  __/>  <| |  | | |_| |  _|
 |_| |_|\___/_/\_\_|   |_|\___/|_|  
</pre>
</div>

<p align="center">
  <strong>AI Coding Assistant Framework — Pipeline Engine · Multi-Model Routing · Ternary Compression</strong>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · English
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#hex4-technology-system">HEX4 Tech</a> ·
  <a href="#domestic-platform-support">Domestic Platforms</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.0-blue" alt="version" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
  <a href="https://github.com/ZZWGBDT/Hex4Code" target="_blank">
    <img src="https://img.shields.io/github/stars/ZZWGBDT/Hex4Code" alt="Star" />
  </a>
</p>

---

> <p align="center"><strong><em>用我们的确定性，对抗世界的熵增；<br>用我们的协作，定义未来的形状。</em></strong></p>
> <p align="center"><strong><em>With our certainty, we counter the world's entropy.<br>With our collaboration, we define the shape of the future.</em></strong></p>


---

## 🎉 1,000 Downloads on AtomGit!

Hex4Code has reached **1,000 downloads** on China's AtomGit open-source platform!

Thank you to everyone who downloaded, tested, and shared the project. Your support keeps us building. Here's to the next milestone!

⭐ Star the repo · 🐛 Report issues · 🤝 Contributions welcome.

---

Hex4Code is an AI coding assistant framework. Give it a natural language task, and it will orchestrate a pipeline — build code, run tests, index your codebase, manage versions — all autonomously.

You can embed it into your toolchain (core engine SDK), use it interactively in the terminal (CLI), or chat with it directly in VS Code (extension). Supports any OpenAI-compatible model including DeepSeek, OpenAI, Qwen, and more.

## HEX4 Technology System

HEX4 is a technology system based on Ternary encoding (Trit) and Tropical Calculus, comprising three layers:

| Layer | Technology | Purpose |
|:-----:|:-----------|:--------|
| Encoding | **Trit (Ternary)** | Three-valued cells (T0/T1/T2) replace binary as the underlying data representation |
| Compression | **DualTrit** | Packs Trit values and TC states into 4-bit dual bytes, achieving ~44% compression ratio |
| Propagation | **TC Trust Propagation** | Seven-state tropical semi-ring operations that propagate confidence markers across tool call chains |

These three layers form a complete technology stack — from encoding to compression to trust evaluation — with Trit as the data foundation, DualTrit for efficient compression, and TC propagation attaching traceable certainty metrics to every operation.

## Features

### Pipeline Engine

Built-in development pipeline that chains the full coding workflow:

| Stage | Capability |
|-------|------------|
| **Build** | Auto-detect project type and compile |
| **Test** | Run tests and parse results, auto-diagnose failures |
| **CodeIndex** | Index codebase for symbol search and reference tracing |
| **Git** | Git operations, auto-commit, checkpoints, diff view |

Supports two agent modes: **Pipeline mode** (step-by-step execution) and **General mode** (freeform conversation).

### Built-in Tools

11 built-in tools covering the full development workflow:

**File & Shell:** `read`, `write`, `edit`, `bash`

**Pipeline:** `build`, `test`, `git`, `code-index`

**Interaction & Search:** `web-search`, `ask-user-question`

### Multi-Model Routing

Automatically selects the optimal model based on task type:

| Provider | ID | Notes |
|----------|-----|-------|
| DeepSeek | `deepseek` | Context Caching + Thinking Mode, default provider |
| OpenAI | `openai` | Standard OpenAI-compatible API, multimodal |
| Qwen | `qwen` | Alibaba Cloud, strong Chinese understanding |
| Gemini | `gemini` | Google, million-token context window |
| ERNIE | `ernie` | Baidu Qianfan platform |
| MiniMax | `minimax` | Cost-effective completions |
| GLM | `glm` | Tsinghua, supports Thinking Mode |
| Anthropic | `anthropic` | Claude, leading code generation and reasoning |
| Groq | `groq` | Ultra-low latency, open-source model hosting |
| Mistral | `mistral` | Codestral FIM completions |
| Custom | `custom` | Any OpenAI-compatible API |

### Semantic Cache

Automatically caches similar LLM responses, reducing duplicate API calls and saving token costs.

### Ternary Compression (DualTrit)

Hex4Code's proprietary context compression algorithm — efficiently compresses conversation history using ternary encoding, extending the effective dialogue window within the same token budget.

### RAG Knowledge Base

Retrieval-augmented generation based on project code — automatically indexes code structure and retrieves relevant code snippets as context during conversations.

### MCP Protocol

Supports the Model Context Protocol standard for integrating external tools such as GitHub, databases, and custom APIs.

### Skills System

Supports user-level (`~/.agents/skills/`) and project-level (`./.agents/skills/`) skill directories, using Markdown files to extend custom instructions.

### Session Management

Every conversation is auto-saved locally. Use `/resume` to restore previous sessions, `/new` to start a fresh conversation, and `/exit` to quit. Session data is isolated by project directory.

### Version Updates

Automatically checks for the latest npm version on startup and prompts in the TUI when an update is available. Update with `npm update -g @hex4code/cli`.

### Safety

- Sensitive operations require confirmation before execution
- Path access outside the workspace triggers automatic approval
- API Keys are isolated per Provider, never shared across vendors

---

## Domestic Platform Support

Hex4Code has been verified end-to-end on the following domestic computing platforms, covering Node.js / TypeScript toolchain compilation and deployment, CLI and TUI interaction, and full core engine operation (ternary + TC four-state computing):

| Platform | Architecture | Operating System | Status |
|----------|:-----------:|:----------------:|:------:|
| Sophon (算能 / SOPHGO) | RISC-V / ARM | Sophon Linux | ✅ |
| Sunway (申威) | SW-64 | Sunway-custom Linux (Deepin / EulerOS) | ✅ |
| Phytium (飞腾) | ARMv8 | Kylin V10 / UOS 20 | ✅ |
| Hygon (海光) | x86_64 | Kylin V10 / UOS 20 / Mainstream Linux | ✅ |
| Kunpeng (鲲鹏) | ARMv8 | Kylin V10 / openEuler | ✅ |
| Zhaoxin (兆芯) | x86_64 | Kylin V10 / UOS 20 / Mainstream Linux | ✅ |
| LoongArch (龙芯) | LoongArch | Loongson Linux / Kylin V10 | ✅ |

> More platforms are being continuously adapted. For support on specific domestic platforms, please contact us or submit an Issue.

---

## Project Structure

```
hex4_code_v1.1/
├── packages/
│   ├── core/          # Core engine (sessions, routing, cache, pipeline)
│   │   └── src/       # TypeScript source
│   └── cli/           # Terminal TUI app (React/Ink)
│       └── src/       # React source
├── vscode/            # VS Code extension
│   ├── src/           # Extension source
│   └── resources/     # WebView UI
├── AGENTS.md          # Project instructions
├── LICENSE            # Apache-2.0 license
├── NOTICE             # Copyright notice
├── package.json       # Root workspace config
└── tsconfig.base.json # Shared TypeScript config
```

---

## Quick Start

### Requirements

- **Node.js** >= 18
- **npm** >= 9

### 1. Clone

```bash
git clone https://github.com/ZZWGBDT/Hex4Code.git
cd Hex4Code
```

### 2. Install & Build

```bash
npm install
npm run build
```

Build outputs:
- CLI → `packages/cli/dist/cli.js`
- VS Code → `vscode/out/extension.js`

### 3. Run

```bash
# Development mode
npx tsx packages/cli/src/cli.tsx

# Or run the compiled version
node packages/cli/dist/cli.js
```

### 4. Install VS Code Extension

```bash
code --install-extension vscode/hex4code-vscode-1.1.0.vsix
```

> See [docs/packaging.md](./docs/packaging.md) for packaging details.

---

## AI Assisted Installation

If you use AI coding tools like CodeBuddy, Cursor, or Windsurf, you can have the AI handle Hex4Code's installation and configuration for you.

### Step 1: Let AI Scan the Project

Open the downloaded Hex4Code project folder in your AI tool and ask it to read the structure:

> "Please scan this Hex4Code project and tell me its structure and purpose."

The AI will recognize this is a TypeScript monorepo with three packages: core (engine), cli (terminal app), and vscode (VS Code extension).

### Step 2: Let AI Install the VS Code Extension

Ask the AI to install the VS Code extension:

> "Please install the VS Code extension from this project into my IDE.
> The extension is in the vscode/ directory. First run npm run build:vscode to compile,
> then run code --install-extension vscode/hex4code-vscode-1.1.0.vsix."

The AI will execute the build and installation commands.

### Step 3: Configure the API Manually

Open the chat interface, click the gear-shaped settings button in the top right corner, select any model provider (e.g. DeepSeek) from the popup window, and enter your API key in the input field.

---

## Usage

### CLI Mode

```bash
hex4code                    # Launch TUI
hex4code --help             # View help
hex4code --version          # View version
```

Start typing natural language commands:

```
> Analyze the code structure of this project
> Add error handling to all API endpoints
> Run tests and fix failing cases
```

### Keybindings

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Alt+Left/Right` | Move by word |
| `Home/End` | Move to start/end of line |
| `Ctrl+W` | Delete previous word |
| `Ctrl+V` | Paste image from clipboard |
| `Ctrl+X` | Clear pasted images |
| `Esc` | Interrupt model output |
| `Up/Down` | Browse input history |
| `Ctrl+C` (twice) | Quit application |
| `/` | Open skills/commands menu |

> **Pasting images on Windows:**
> Windows Terminal and conhost may intercept `Ctrl+V`. If pasting images doesn't work, try pasting via the `/` menu.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new conversation |
| `/init` | Initialize project workflow |
| `/resume` | Resume previous session |
| `/compact` | Compress session context |
| `/config` | Show current configuration |
| `/context` | Show context usage |
| `/cost` | Show token cost statistics |
| `/doctor` | Run diagnostic check |
| `/memory` | Manage long-term memory |
| `/status` | Show connection status |
| `/exit` | Quit application |

### Project Instructions (AGENTS.md)

Run `/init` in the project root to generate an `AGENTS.md` file that provides project-level context to the AI. Edit this file to add project descriptions, coding conventions, etc. The AI will read and follow them automatically:

```markdown
# Project Instructions

This is a Vue 3 + TypeScript project using Composition API.
- Use TailwindCSS for styling
- Run `npm run lint` to check code style
```

You can also create `AGENTS.md` manually.

### VS Code Mode

After installing the extension, a **Hex4Code** icon appears in the sidebar. Click it to open the chat panel (WebView) and start typing natural language instructions. The currently open editor content is automatically attached as context.

---

## Configuration

### Minimal Configuration

```json
{
  "model": "deepseek-chat",
  "thinkingEnabled": true,
  "reasoningEffort": "max",
  "providers": {
    "deepseek": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com"
    }
  }
}
```

### Custom Model Endpoints

Mount multiple custom API endpoints under the same Provider, each with its own URL, key, and model list:

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "sk-main",
      "endpoints": [
        {
          "id": "local-inference",
          "name": "Local Inference",
          "baseURL": "http://localhost:8000/v1",
          "compatibility": "openai-compatible",
          "models": ["local-model-v1", "local-model-v2"]
        },
        {
          "id": "proxy-service",
          "name": "Third-Party Proxy",
          "baseURL": "https://my-proxy.example.com/v1",
          "apiKey": "sk-proxy",
          "models": ["gpt-4o", "claude-sonnet"]
        }
      ]
    }
  }
}
```

Field descriptions:

| Field | Description |
|-------|-------------|
| `id` | Endpoint unique identifier |
| `name` | Display name (optional) |
| `baseURL` | API address |
| `apiKey` | Endpoint-specific key (optional, inherits from Provider level if not set) |
| `compatibility` | Compatibility mode: `"openai-compatible"` / `"minimax"` / `"ollama"` |
| `models` | List of available model names for this endpoint |

### Non-Standard Provider Access

For non-standard OpenAI-compatible services like Ollama, specify `compatibility` and `models`:

```json
{
  "providers": {
    "ollama": {
      "baseURL": "http://localhost:11434/v1",
      "compatibility": "ollama",
      "models": ["llama3", "qwen2"]
    }
  }
}
```

### Configuration Priority

```
Environment variables HEX4CODE_*
> Project level ./.hex4code/settings.json
> User level ~/.hex4code/settings.json
> Default values
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HEX4CODE_API_KEY` | API key |
| `HEX4CODE_BASE_URL` | API endpoint URL |
| `HEX4CODE_MODEL` | Default model |
| `HEX4CODE_PROVIDER` | Default provider |

> Full configuration reference (detailed options, multi-model routing, MCP servers, Skills config) see [docs/configuration.md](./docs/configuration.md).

---

## Architecture

```
packages/core/          ← Core engine (no UI dependency)
  ├── models/           Model routing, Provider clients
  ├── cache/            Semantic cache
  ├── compression/      Ternary compression (DualTrit)
  ├── orchestration/    Pipeline orchestration
  ├── tc/               TC propagation
  ├── mcp/              MCP protocol
  ├── tools/            Built-in tools
  └── session/          Session management

packages/cli/           ← Terminal TUI (React/Ink)
  ├── ui/               UI components
  └── cli.tsx           Entry point

vscode/                 ← VS Code extension
  ├── src/              Extension logic
  └── resources/        WebView frontend
```

### Design Principles

1. **Engine-agnostic** — core package has no UI dependency; CLI and VS Code share the same core
2. **Pipeline-first** — build → test → index → version management development loop
3. **Model-neutral** — connect to any OpenAI-compatible API via the Provider adapter layer
4. **Context-efficient** — DualTrit compression + semantic cache + RAG working together

---

## Testing

```bash
# Run all tests
npm test

# Run individual package tests
npm run test:core
npm run test:cli
npm run test:vscode
```

Uses Node.js native test runner (`tsx --test`).

> See [packages/core/src/__tests__/README.md](./packages/core/src/__tests__/README.md) for notes on test coverage.

---

## Development

```bash
# Type checking
npm run typecheck

# Code linting & formatting
npm run lint                # ESLint check
npm run lint:fix            # Auto-fix
npm run format              # Prettier formatting
npm run check               # Typecheck + lint + format check

# Build
npm run build

# Run CLI in development mode
npx tsx packages/cli/src/cli.tsx

# Build CLI only
npm run build:cli
```

---

## Contributing

Contributions are welcome! Please follow these steps:

1. **Fork** this repository
2. **Clone**: `git clone https://github.com/ZZWGBDT/Hex4Code.git`
3. **Create a branch**: `git checkout -b feat/xxx` or `fix/xxx`
4. **Make changes**, ensure `npm run typecheck` passes
5. **Commit**: `git commit -m "feat: add xxx"`
6. **Push** and open a Pull Request

### Branch Naming

| Prefix | Purpose |
|--------|---------|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `refactor/` | Refactoring (no behavior change) |
| `docs/` | Documentation |
| `chore/` | Build, CI, tooling |

### Coding Guidelines

- Run `npm run check` after making changes to ensure type checking and code formatting pass
- Run `npm run build` before committing to ensure compilation succeeds
- Follow ESLint and Prettier configurations for consistent code style

### Where to Start

- **Add a new tool** — implement a new handler in `packages/core/src/tools/`
- **Add a new Provider** — register in `packages/core/src/models/provider-registry.ts`
- **Improve the CLI UI** — UI components in `packages/cli/src/ui/`

> See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

---

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](./docs/api.md) | Core API interface documentation |
| [SDK Guide](./docs/sdk.md) | SDK integration and usage |
| [Architecture Overview](./docs/architecture.md) | System architecture design |
| [Configuration Guide](./docs/configuration.md) | Detailed configuration reference |
| [Packaging Guide](./docs/packaging.md) | CLI and VS Code extension packaging |
| [Security Policy](./SECURITY.md) | Security vulnerability reporting |
| [Changelog](./CHANGELOG.md) | Version release notes |

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE) for details.

```
Copyright 2026 郑州威光半导体有限公司 (Zhengzhou Weiguang Semiconductor Co., Ltd.)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

---

## Community & Support

- **Repository**: [https://github.com/ZZWGBDT/Hex4Code](https://github.com/ZZWGBDT/Hex4Code)
- **Issues**: via [GitHub Issues](https://github.com/ZZWGBDT/Hex4Code/issues)
- **Discussions**: via [Discussions](https://github.com/ZZWGBDT/Hex4Code/discussions)

---

<p align="center">
  Built with TypeScript, Ink, and React.
</p>
