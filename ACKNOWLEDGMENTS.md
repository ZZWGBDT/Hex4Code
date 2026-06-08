# Acknowledgments

---

## Background

Hex4Code was created by **Zhengzhou Weiguang Semiconductor Co., Ltd.**
during the development of the **HEX4 Asymmetric Ternary + TC Computing System**.

In our daily R&D, we found that general-purpose AI coding tools had a
fundamental gap in adapting to the HEX4 technology stack — they could
neither understand the semantics of ternary encoding and TC confidence
propagation, nor provide targeted optimization for token consumption.
At the same time, our prior work on DualTrit compression and confidence
merge algorithms offered exactly the answers these problems demanded.

So we made a decision: rather than waiting for tools to adapt to us,
we would build an AI coding assistant deeply integrated with the HEX4
technology stack ourselves.

---

## Technical Approach

### Model Selection

After a comprehensive evaluation of mainstream large language models,
**DeepSeek** stood out as uniquely compatible with the HEX4 asymmetric
ternary + TC computing paradigm across the following dimensions:

| Dimension | DeepSeek Advantage | Impact on HEX4 |
|-----------|:-----------------:|----------------|
| Context Window | Up to 1M tokens | Accommodates full DualTrit-compressed context alongside TC propagation chains |
| Thinking Mode | Native support | TC four-state confidence determination requires deep reasoning capability |
| Structured Output | Stable and reliable | Unambiguous parsing of DualTrit-encoded compact JSON payloads |
| Token Economics | Cost-effective | Combined with DualTrit's ~44% compression yields significant cost reduction |
| API Compatibility | OpenAI-compatible | Zero-friction integration, allowing full focus on upper-layer innovation |

No other model we evaluated matched DeepSeek's combination of context depth,
reasoning capability, and economic efficiency — each of which is essential
for the HEX4 technology stack to function at its full potential.

### Engineering Reference

At the architecture level, we studied and drew inspiration from
**[deepcode]**'s open-source implementation. Its tool execution framework,
session management patterns, and agent loop design provided a clear
engineering reference that enabled Hex4Code's early prototype to take
shape rapidly, allowing us to focus our energy on the differentiated
innovations of the HEX4 technology stack.

---

## Development Timeline

| Timeline | Milestone | Description |
|----------|-----------|-------------|
| **Hours 0–3** | First working prototype | Architecture reference from deepcode, integrated HEX4 DualTrit compression, completed basic session management and tool execution pipeline |
| **Hour 3** | Production deployment | Prototype immediately adopted for daily R&D, replacing general-purpose AI coding tools across the team |
| **Hours 3–24** | First production iteration | Refined prompt templates and tool argument parsing based on real-world usage feedback |
| **Hours 24–72** | Core systems solidified | Completed TC confidence propagation, pipeline orchestration engine, and semantic cache — the three pillars of the HEX4 toolchain |
| **Hours 72–168** | Multi-model routing + MCP | Expanded Provider registry to 9 backends, integrated MCP protocol for external tool servers, implemented Skills system for user and project-level customization |
| **Hour 168 (Day 7)** | **v1.1.0 open-source release** | Hex4Code v1.1.0 officially released under the Apache-2.0 license on both AtomGit and GitHub |

The entire seven-day journey followed a single principle: **iterate in
production**. The team used the tool they were building every single day
to develop the HEX4 computing system itself. Every commit, every fix,
and every feature was driven by a real pain point encountered hours
earlier. There were no sprints, no roadmap meetings — just continuous
feedback between the tool and the work it was built to accelerate.

---

## Special Thanks

### DeepSeek

We thank the **DeepSeek** team for building the large language model most
natively compatible with the HEX4 asymmetric ternary + TC computing system.
DeepSeek V4's ultra-long context window, native Thinking Mode, and robust
structured output support allow the two core innovations of Hex4Code —
DualTrit ternary compression encoding and TC four-state confidence
propagation — to operate at their full potential in production. Without
DeepSeek's breakthroughs in model capability, our technical vision would
have remained theoretical.

### deepcode

We thank **[deepcode]** for its open-source implementation. Its engineering
practices in tool execution scheduling, session lifecycle management, and
agent loop design provided an invaluable architectural foundation for
Hex4Code's early development. Standing on the shoulders of this work, we
were able to complete the first working prototype within three hours and
direct our creative energy toward the differentiated innovations of the
HEX4 technology stack — rather than reinventing the fundamentals.

### Zhengzhou Weiguang Semiconductor Team

We thank every team member who participated in Hex4Code's development and
production validation during the seven days of intensive iteration. Your
ethos of "using it while building it" — testing each change against real
HEX4 computing system R&D tasks the moment it landed — was the engine that
transformed a three-hour prototype into a production-grade open-source
release.

### The Open-Source Community

We thank AtomGit and GitHub for providing the platforms that make open-source
collaboration possible, and every developer who uses, provides feedback on,
or contributes to Hex4Code. Hex4Code will always remain open source — we
believe the best tools are shaped by the communities that use them, and the
best innovations emerge when they are shared freely.

---

## License

```
Hex4Code — AI-powered coding assistant with multi-model routing,
semantic cache, and pipeline orchestration.

Copyright © 2026 郑州威光半导体有限公司
(Zhengzhou Weiguang Semiconductor Co., Ltd.)

Licensed under the Apache License, Version 2.0.
You may obtain a copy of the License at:
    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied.
```

---

> **Note**: `[deepcode]` in this document refers to the specific open-source
> project we studied and drew architectural inspiration from. For the latest
> information about that project, please refer to its official repository.
> All code in Hex4Code derived from its reference implementation has been
> properly attributed in accordance with the relevant open-source license.
