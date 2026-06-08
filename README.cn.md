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
  <strong>AI 编码助手框架 — 流水线引擎 · 多模型路由 · 三元压缩</strong>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="#功能特性">功能</a> ·
  <a href="#hex4-技术体系">HEX4 技术</a> ·
  <a href="#国产化平台支持">国产化</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#配置">配置</a> ·
  <a href="#架构">架构</a> ·
  <a href="#开发">开发</a> ·
  <a href="#贡献指南">贡献</a>
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

Hex4Code 是一个 AI 编码助手框架。给它一个自然语言任务，它会调度流水线——构建代码、运行测试、索引代码库、管理版本——全程自主完成。

您可以将它嵌入自己的工具链（核心引擎 SDK），在终端中交互使用（CLI），或者在 VS Code 里直接对话（扩展）。支持 DeepSeek、OpenAI、通义千问等任意 OpenAI 兼容模型。

## HEX4 技术体系

HEX4 是一套基于三进制编码（Trit）与TC半环代数的技术体系，包含三个层次：

| 层次 | 技术 | 作用 |
|:----:|:-----|:-----|
| 编码 | **Trit 三进制** | 以 T0/T1/T2 三值单元替代二进制，作为底层数据表示 |
| 压缩 | **DualTrit** | 将 Trit 值与 TC 状态打包为 4bit DualTrit字节，实现约 44% 压缩率 |
| 传播 | **TC 信赖传播** | 基于TC半环代数的七态运算，在工具调用链中传递可信度标记 |

三者形成从编码到压缩再到信赖评估的完整技术栈——以 Trit 为数据基底，以 DualTrit 实现高效压缩，以 TC 传播为每次操作附加可追溯的确定性度量。

## 功能特性

### 流水线引擎 (Pipeline)

内置开发流水线，串联编码全流程：

| 阶段 | 能力 |
|------|------|
| **Build** | 自动识别项目类型，调用构建工具编译 |
| **Test** | 运行测试并解析结果，失败自动进入诊断流程 |
| **CodeIndex** | 对代码库建立索引，支持符号搜索和引用追溯 |
| **Git** | Git 操作封装，自动提交、检查点、diff 查看 |

支持两种代理模式：**流水线模式**（按阶段依次执行）和 **通用模式**（自由对话），按需切换。

### 内置工具

提供 11 个内置工具，覆盖代码开发全流程：

**文件与命令：** `read`、`write`、`edit`、`bash`

**流水线：** `build`、`test`、`git`、`code-index`

**交互与搜索：** `web-search`、`ask-user-question`

### 多模型智能路由

根据任务类型自动选择最优模型：

| 供应商 | 标识 | 说明 |
|--------|------|------|
| DeepSeek | `deepseek` | 支持 Context Caching + Thinking Mode，默认 Provider |
| OpenAI | `openai` | 标准 OpenAI 兼容 API，支持多模态 |
| 通义千问 | `qwen` | 阿里云百炼平台，中文理解强 |
| Gemini | `gemini` | Google，百万级上下文 |
| 文心一言 | `ernie` | 百度千帆平台 |
| MiniMax | `minimax` | 高性价比补全 |
| 智谱 GLM | `glm` | 支持 Thinking Mode |
| Anthropic | `anthropic` | Claude，代码生成和推理领先 |
| Groq | `groq` | 超低延迟，开源模型托管 |
| Mistral | `mistral` | Codestral FIM 补全 |
| Custom | `custom` | 任意 OpenAI 兼容 API |

### 语义缓存

基于 n-gram 特征向量与余弦相似度的语义缓存引擎：

- **匹配机制** — 对输入计算字符 3-gram 指纹，与缓存条目计算余弦相似度，超过阈值（默认 0.85）且同一模型时返回缓存结果
- **淘汰策略** — 支持 TTL 过期（默认 1 小时）+ LRU 淘汰（默认 200 条上限）
- **持久化** — 内存运行，可选持久化到 JSON 文件
- **适用场景** — 重复的代码审查、相似问题问答、常见错误诊断

### 三元压缩 (DualTrit)

Hex4Code 独有的上下文压缩算法，基于三进制编码（Trit）实现：

- **编码原理** — 将 2bit 值与 2bit TC 状态打包为 4bit DualTrit 字节，同时压缩字段名（如 `ok`→`k`、`name`→`n`、`output`→`o`），覆盖 20+ 个常用字段
- **压缩效果** — 典型工具调用结果约 44% 压缩率
- **TC 值映射** — `NONE→0`、`CARRY→1`、`UNCERTAIN→U`、`MIXED→M`，压缩后仍保留可信度信息
- **作用** — 在同等 Token 预算下显著拓展有效对话窗口

### RAG 知识库

基于词袋模型（Bag-of-Words）与余弦相似度的检索增强生成，包含两个层面：

- **Session RAG** — 每次对话中自动提取问答对，生成 BOW 特征向量，后续相似问题时自动召回历史答案
- **知识库加载器** — 扫描 `~/.hex4code/knowledge-base/` 目录下的 Markdown 文件，按标题分块建立索引
- **分词策略** — 英文单词提取 + 中文二元分词 + 项目标识符（如 `hex4_*`、`TC_*`）加权 3 倍
- **用途** — 在对话中自动检索相关代码片段和技术文档作为上下文，减少重复解释

### MCP 协议

支持 Model Context Protocol 标准，可集成 GitHub、数据库、自定义 API 等外部工具。

### Skills 技能系统

支持用户级 (`~/.agents/skills/`) 和项目级 (`./.agents/skills/`) 两种技能目录，以 Markdown 文件扩展自定义指令。

### 会话管理

每次对话自动保存到本地。在 CLI 中通过 `/resume` 恢复上次会话、`/new` 创建新会话、`/exit` 退出。会话数据按项目目录隔离，支持项目级和用户级两层配置。

### 版本更新

近期上线，即将推出。

### 安全

- 敏感操作经确认后执行
- 工作区外路径访问自动触发审批
- API Key 按 Provider 隔离，不跨供应商混用

---

## 国产化平台支持

Hex4Code 已在以下国产计算平台完成端到端验证，覆盖 Node.js / TypeScript 工具链编译部署、CLI 与 TUI 交互、以及核心引擎（三进制 + TC 四态计算）全功能运行：

| 平台 | 芯片架构 | 操作系统 | 验证状态 |
|------|---------|---------|:--------:|
| 算能 (Sophon / SOPHGO) | RISC-V / ARM | Sophon Linux / 算能 Linux | ✅ |
| 申威 (Sunway) | SW-64 | 申威定制 Linux（Deepin / EulerOS） | ✅ |
| 飞腾 (Phytium) | ARMv8 | 麒麟 V10 / UOS 20 | ✅ |
| 海光 (Hygon) | x86_64 | 麒麟 V10 / UOS 20 / 主流 Linux | ✅ |
| 鲲鹏 (Kunpeng) | ARMv8 | 麒麟 V10 / openEuler | ✅ |
| 兆芯 (Zhaoxin) | x86_64 | 麒麟 V10 / UOS 20 / 主流 Linux | ✅ |
| 龙芯 (LoongArch) | LoongArch | 龙芯 Linux / 麒麟 V10 | ✅ |

> 更多平台持续适配中。如需特定国产平台的适配支持，请联系我们或提交 Issue。

---

## 项目结构

```
hex4_code_v1.1/
├── packages/
│   ├── core/          # 核心引擎（会话、路由、缓存、流水线）
│   │   └── src/       # TypeScript 源码
│   └── cli/           # 终端 TUI 应用 (React/Ink)
│       └── src/       # React 源码
├── vscode/            # VS Code 扩展
│   ├── src/           # 扩展源码
│   └── resources/     # WebView UI
├── AGENTS.md          # 项目说明
├── LICENSE            # Apache-2.0 许可证
├── NOTICE             # 版权声明
├── package.json       # 根工作区配置
└── tsconfig.base.json # 共享 TypeScript 配置
```

---

## 快速开始

### 环境要求

- **Node.js** >= 18
- **npm** >= 9

### 1. 克隆

```bash
git clone https://github.com/ZZWGBDT/Hex4Code.git
cd Hex4Code
```

### 2. 安装与编译

```bash
npm install
npm run build
```

编译产物：
- CLI → `packages/cli/dist/cli.js`
- VS Code → `vscode/out/extension.js`

### 3. 运行

```bash
# 开发模式
npx tsx packages/cli/src/cli.tsx

# 或编译后运行
node packages/cli/dist/cli.js
```

### 4. 安装 VS Code 扩展

```bash
code --install-extension vscode/hex4code-vscode-1.1.0.vsix
```

> 打包详情见 [docs/packaging.md](./docs/packaging.md)。

---

## AI 辅助安装

如果您使用 CodeBuddy、Cursor、Windsurf 等 AI 编码工具，可以让 AI 替您完成 Hex4Code 的安装与配置。

### 第一步：让 AI 扫描项目

将下载的 Hex4Code 项目文件夹在 AI 工具中打开（或拖入会话窗口），让 AI 阅读项目结构：

> "请扫描这个 Hex4Code 项目，告诉我它的结构和用途。"

AI 会自动识别这是一个 TypeScript monorepo，包含 core（核心引擎）、cli（终端应用）和 vscode（VS Code 扩展）三个子包。

### 第二步：让 AI 安装 VS Code 扩展

告诉 AI 以 VS Code 扩展形式安装 Hex4Code：

> "请将本项目中的 VS Code 扩展安装到我的 IDE 中。
> 扩展位于 vscode/ 目录，先执行 npm run build:vscode 编译，
> 再执行 code --install-extension vscode/hex4code-vscode-1.1.0.vsix 安装。"

AI 会自动执行编译和安装命令。

### 第三步：手动配置 API

打开聊天界面，点击右上角齿轮状设置按钮，在弹出窗口中点击任意模型供应商（如 DeepSeek），在弹出的输入框中配置 API 密钥。

---

## 使用说明

### CLI 模式

```bash
hex4code                    # 启动 TUI
hex4code --help             # 查看帮助
hex4code --version          # 查看版本
```

启动后进入交互式终端，直接输入自然语言：

```
> 帮我分析这个项目的代码结构
> 给所有 API 接口添加错误处理
> 运行测试并修复失败用例
```

### 快捷键

| 键位 | 动作 |
|------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Alt+左/右` | 按单词移动 |
| `Home/End` | 移动到行首/行尾 |
| `Ctrl+W` | 删除前一个单词 |
| `Ctrl+V` | 粘贴剪贴板图片 |
| `Ctrl+X` | 清除已粘贴的图片 |
| `Esc` | 中断当前模型输出 |
| `Up/Down` | 浏览输入历史 |
| `Ctrl+C`（连按两次） | 退出应用 |
| `/` | 打开技能/命令菜单 |

### Slash 命令

| 命令 | 说明 |
|------|------|
| `/new` | 创建新会话 |
| `/init` | 初始化项目工作流 |
| `/resume` | 恢复上次会话 |
| `/compact` | 压缩会话上下文 |
| `/config` | 显示当前配置 |
| `/context` | 显示上下文使用量 |
| `/cost` | 显示 Token 费用统计 |
| `/doctor` | 运行诊断检查 |
| `/memory` | 管理长期记忆 |
| `/status` | 显示连接状态 |
| `/exit` | 退出应用 |

### 项目指令文件 (AGENTS.md)

在项目根目录执行 `/init` 会生成 `AGENTS.md` 文件，用于给 AI 提供项目级上下文。编辑此文件加入项目说明、编码规范等，AI 会自动读取并遵循：

```markdown
# 项目说明

本项目使用 Vue 3 + TypeScript，采用 Composition API。
- 样式使用 TailwindCSS
- 运行 `npm run lint` 检查代码规范
```

也支持直接手动创建 `AGENTS.md` 写入项目说明。

### VS Code 模式

安装扩展后，侧边栏出现 **Hex4Code** 图标，点击打开聊天面板（WebView），在聊天框中输入自然语言指令即可与 AI 对话。发送时会自动附带上当前打开的编辑器内容作为上下文。

---

## 配置

### 最小配置

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

### 自定义模型端点

在同一 Provider 下可挂载多个自定义 API 端点，每个端点可独立设置地址、密钥和可用模型：

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "sk-main",
      "endpoints": [
        {
          "id": "local-inference",
          "name": "本地推理",
          "baseURL": "http://localhost:8000/v1",
          "compatibility": "openai-compatible",
          "models": ["local-model-v1", "local-model-v2"]
        },
        {
          "id": "proxy-service",
          "name": "第三方中转",
          "baseURL": "https://my-proxy.example.com/v1",
          "apiKey": "sk-proxy",
          "models": ["gpt-4o", "claude-sonnet"]
        }
      ]
    }
  }
}
```

每个端点的说明：

| 字段 | 说明 |
|------|------|
| `id` | 端点唯一标识 |
| `name` | 显示名称（可选） |
| `baseURL` | API 地址 |
| `apiKey` | 该端点专用密钥（可选，不填则继承 Provider 级别） |
| `compatibility` | 兼容模式：`"openai-compatible"` / `"minimax"` / `"ollama"` |
| `models` | 该端点可用的模型名称列表 |

### 非标准 Provider 接入

对于 Ollama 等非标准 OpenAI 兼容服务，需指定 `compatibility` 和 `models`：

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

### 配置优先级

```
环境变量 HEX4CODE_*
> 项目级 ./.hex4code/settings.json
> 用户级 ~/.hex4code/settings.json
> 默认值
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `HEX4CODE_API_KEY` | API 密钥 |
| `HEX4CODE_BASE_URL` | API 端点地址 |
| `HEX4CODE_MODEL` | 默认模型 |
| `HEX4CODE_PROVIDER` | 默认供应商 |

> 完整配置参考（配置项详解、多模型路由、MCP 服务器、Skills 配置）见 [docs/configuration.md](./docs/configuration.md)。

---

## 架构

```
packages/core/          ← 核心引擎（无 UI 依赖）
  ├── models/           模型路由、Provider 客户端
  ├── cache/            语义缓存
  ├── compression/      三元压缩 (DualTrit)
  ├── orchestration/    流水线编排
  ├── tc/               TC 传播
  ├── mcp/              MCP 协议
  ├── tools/            内置工具
  └── session/          会话管理

packages/cli/           ← 终端 TUI（React/Ink）
  ├── ui/               UI 组件
  └── cli.tsx           入口

vscode/                 ← VS Code 扩展
  ├── src/              扩展逻辑
  └── resources/        WebView 前端
```

### 设计原则

1. **引擎无关** — core 包不依赖任何 UI 框架，CLI 和 VS Code 共用同一核心
2. **流水线优先** — 构建→测试→索引→版本管理的开发闭环
3. **模型中立** — 通过 Provider 适配层接入任意 OpenAI 兼容 API
4. **上下文高效** — DualTrit 压缩 + 语义缓存 + RAG 三种手段协同

---

## 测试

```bash
# 运行所有测试
npm test

# 分别运行各包测试
npm run test:core
npm run test:cli
npm run test:vscode
```

测试框架使用 Node.js 原生 test runner（`tsx --test`）。

> 关于全量测试的说明见 [packages/core/src/__tests__/README.md](./packages/core/src/__tests__/README.md)。

---

## 开发

```bash
# 类型检查
npm run typecheck

# 代码检查与格式化
npm run lint                # ESLint 检查
npm run lint:fix            # 自动修复
npm run format              # Prettier 格式化
npm run check               # 类型检查 + lint + 格式检查

# 编译
npm run build

# 开发模式运行 CLI
npx tsx packages/cli/src/cli.tsx

# 编译 CLI
npm run build:cli
```

---

## 贡献指南

欢迎贡献！无论是报告 Bug、提交代码、改进文档，我们都非常欢迎。

### 贡献流程

1. **Fork** 本仓库
2. **Clone**：`git clone https://github.com/ZZWGBDT/Hex4Code.git`
3. **创建分支**：`git checkout -b feat/xxx` 或 `fix/xxx`
4. **修改代码**
5. **本地验证**：`npm run check && npm run build`
6. **Commit**：遵循约定式提交格式
7. **Push** 并提交 Pull Request

### Commit 格式

```
<类型>: <简短描述>
```

| 示例 | 说明 |
|------|------|
| `feat: add multi-model vote` | 新功能 |
| `fix: correct cache key collision` | Bug 修复 |
| `docs: update README configuration` | 文档 |
| `refactor: extract TC propagation` | 重构 |
| `chore: bump esbuild to 0.25` | 构建/CI |

### 分支命名

| 前缀 | 用途 |
|------|------|
| `feat/` | 新功能 |
| `fix/` | Bug 修复 |
| `refactor/` | 重构（不改变行为） |
| `docs/` | 文档 |
| `chore/` | 构建、CI、工具链 |

### 项目原则

- **引擎中立** — core 包不依赖任何 UI 框架，CLI 和 VS Code 共用同一核心
- **优雅失败** — 工具执行失败时，将错误信息以 observation 形式返回给 LLM，避免程序崩溃
- **安全可控** — 所有破坏性操作必须经用户确认，绝不静默执行
- **上下文高效** — 合理利用 DualTrit 压缩和语义缓存，避免不必要的 Token 消耗

### 本地验证

提交前请运行以下命令确认代码质量：

```bash
npm run check    # 类型检查 + ESLint + Prettier
npm run build    # 编译所有包
```

### 从哪里上手

- **修复 Bug** — 在 [Issues](https://github.com/ZZWGBDT/Hex4Code/issues) 中寻找 `bug` 标签
- **新增工具** — 在 `packages/core/src/tools/` 下实现新的工具处理器
- **新增 Provider** — 在 `packages/core/src/models/provider-registry.ts` 中注册
- **改进 CLI UI** — UI 组件在 `packages/cli/src/ui/` 目录，基于 React/Ink
- **改进 VS Code 扩展** — 扩展逻辑在 `vscode/src/` 目录

### 提交 PR 后

- 维护者会在 3-5 个工作日内 Review
- Review 过程中可能会要求修改，请保持沟通
- 合并后你的提交会出现在 [CHANGELOG.md](./CHANGELOG.md) 中

> 详细规范（Bug 报告模板、开发环境搭建、打包发布等）见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 文档

| 文档 | 说明 |
|------|------|
| [API 参考](./docs/api.md) | 核心 API 接口文档 |
| [SDK 指南](./docs/sdk.md) | SDK 集成与使用说明 |
| [架构概览](./docs/architecture.md) | 系统架构设计文档 |
| [配置指南](./docs/configuration.md) | 详细配置说明 |
| [打包说明](./docs/packaging.md) | CLI 与 VS Code 扩展打包 |
| [安全策略](./SECURITY.md) | 安全漏洞报告流程 |
| [更新日志](./CHANGELOG.md) | 版本更新记录 |

---

## 许可证

本项目整体采用 **Apache License 2.0** 许可。详见 [LICENSE](./LICENSE) 文件。

```
Copyright 2026 郑州威光半导体有限公司 (Zhengzhou Weiguang Semiconductor Co., Ltd.)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

---

## 社区与支持

- **代码仓库**：[https://github.com/ZZWGBDT/Hex4Code](https://github.com/ZZWGBDT/Hex4Code)
- **问题反馈**：通过 [GitHub Issues](https://github.com/ZZWGBDT/Hex4Code/issues) 提交
- **讨论交流**：通过 [Discussions](https://github.com/ZZWGBDT/Hex4Code/discussions) 参与

---

<p align="center">
  用 TypeScript、Ink 和 React 构建。
</p>
