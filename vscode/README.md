# Hex4Code

[Hex4Code](https://marketplace.visualstudio.com/items?itemName=hex4code-vscode) is an AI coding assistant extension for Visual Studio Code, specifically optimized for the latest `deepseek-v4` model.

## Configuration

Create `~/.hex4code/settings.json` with:

```json
{
  "env": {
    "MODEL": "deepseek-v4-pro",
    "BASE_URL": "https://api.deepseek.com",
    "API_KEY": "sk-..."
  },
  "thinkingEnabled": true,
  "reasoningEffort": "max"
}
```

## Key Features

### **Skills**

Hex4Code supports agent skills that allows you to extend the assistant's capabilities:

- **User-level Skills**: discovered and activated from `~/.agents/skills/`.
- **Project-level Skills**: loaded from `./.agents/skills/` for project-specific workflows, with legacy `./.hex4code/skills/` compatibility.

### **Optimized for DeepSeek**

- Specifically tuned for DeepSeek model performance.
- Reduce costs by using [Context Caching](https://api-docs.deepseek.com/guides/kv_cache).
- Natively supports [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) and Thinking Effort Control.

## Supported Models

- `deepseek-v4-pro` (Recommended)
- `deepseek-v4-flash`
- `deepseek-chat`
- Any other OpenAI-compatible model

## Screenshot

![screenshot](resources/hex4code_screenshot.png)

## Hex4Code CLI

```bash
npm install -g @hex4code/cli
```

> The VSCode plugin and CLI share configuration and data, but they have no dependencies at runtime.

- GitHub： https://github.com/ZZWGBDT/Hex4Code

## FAQ

### How can I move Hex4Code from the left sidebar to the right (Secondary Side Bar) in VS Code?

![faq1](resources/faq1.gif)

### Does Hex4Code support understanding images?

Hex4Code supports multimodal, but `deepseek-v4` does not support multimodal yet. Some models have multimodal capabilities but impose strict limits on multi-turn dialogue requests. For multimodal input, we recommend using the Volcano Ark `Doubao-Seed-2.0-pro` model, which has the best integration.

### How to automatically send a notification after a task completes?

Write a shell notification script that calls a notification webhook, then set the `notify` field in `~/.hex4code/settings.json` to the full path of the script. For detailed steps. Refer to the project documentation for details

### Does it support Coding Plan?

Yes. Just set `env.BASE_URL` in `~/.hex4code/settings.json` to an OpenAI-compatible API endpoint. Take Volcano Ark's Coding Plan as an example, configure `~/.hex4code/settings.json` as follows:

```json
{
  "env": {
    "MODEL": "ark-code-latest",
    "BASE_URL": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "API_KEY": "**************"
  },
  "thinkingEnabled": true
}
```

## Getting Help

- Report bugs or request features on GitHub Issues (https://github.com/ZZWGBDT/Hex4Code/issues)
