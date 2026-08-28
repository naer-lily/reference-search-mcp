# reference-search-mcp

> 自用工具：画师找绘画参考图。AI 编码代理请先读 [AGENTS.md](AGENTS.md)。

一个给 AI 用的**参考图搜索 MCP 服务器**：接收自然语言查询 → 解析为关键词 → 并行搜索多个图源 → 缩略图去重 → 拼成**带编号的拼图** → 多模态模型**通过工具调用**筛选（而不是裸 JSON 输出）→ 客户端驱动迭代（a、b、c… 轮，跨轮去重）→ 按 ID 下载整图返回文件路径。

```
调用方 AI (MCP 客户端)
   │  image_search_start("找适合播客封面的太空插画素材")
   ▼
[reference-search-mcp]                        ┌──────────────────────┐
  ├─ LLM 层 (pi)  NL → 关键词 (submit_keywords 工具)          │ 搜索适配器（并行）    │
  ├─ providers    DDG / Bing / Wikimedia / Openverse / Serper │  ddg ─┐             │
  ├─ 去重         pHash（跨轮 seen 集合）                      │  bing ─┤ 结果合并    │
  ├─ 拼图         sharp 编号拼图 round-a.png（a1..aN）         │  wikimedia ─┘       │
  ├─ 视觉筛选     pi vision 模型看拼图，调用 select_images /   └──────────────────────┘
  │               reject_images / refine_search 工具
  ▼
{ round:"a", gridPath, selectedIds:["a3","a17"], metadata:[...] }
   │  image_search_iterate("不要 a3，多找像 b7 的") → round b（重复图自动剔除）
   │  image_search_collect(session, ["b1","c12"]) → 本地文件路径 + manifest.json
```

## 为什么结果用"工具调用"交付，而不是结构化 JSON？

筛选模型对拼图的选择，通过 `select_images` / `reject_images` / `refine_search` 等**函数调用**表达：

- 参数 schema 由模型服务商强制校验——天然是合法 JSON，没有 markdown 围栏、散文夹杂、键名漂移问题；
- 多意图一次表达（选 + 拒 + 建议下一轮关键词）；
- 传了无效 ID（如 `a99`）时执行器回执错误，模型**下一轮自行修正**；
- 与 MCP 外层同构：外层是调用方 AI 通过工具用我们，内层是我们通过工具用模型。

**绝无文本 JSON fallback**——工具调用是唯一交付通道。tool_choice 策略（实测 DeepSeek v4-flash）：

- **thinking 开启**（默认，本任务建议开启）：DeepSeek 的 thinking 模式**拒绝**强制 tool_choice（实测 400 "Thinking mode does not support this tool_choice"），故用 `auto` + 模型未调用工具时**对话逼问**（追加"你必须调用工具"，≤LLM_MAX_TURNS 轮）；
- **thinking 关闭**（`PI_THINKING=off`）：`tool_choice` **强制指定函数**（openai-completions 传 `{type:"function",function:{name}}` + `reasoning_effort:"none"`），100% 保证调用。

LLM 层基于 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-ai`，MIT）：统一多提供商 API（Anthropic / OpenAI / DeepSeek / Gemini / 通义 / Kimi / MiniMax…）、自动认证解析、内置模型目录、重试工具。**不引入重型 agent 框架**——服务器端 LLM 只是三个有界函数（解析关键词 / 解读反馈 / 筛选拼图），真正的迭代循环由调用方 AI 驱动。

## 快速开始

要求：Node ≥ 22.19。

```bash
npm install --ignore-scripts
npm run build
```

### 1. 配置 LLM（pi 认证，二选一）

```bash
# 方式 A：环境变量（任意 pi 支持的提供商）
export DEEPSEEK_API_KEY=sk-...          # 文本解析（便宜）
export ANTHROPIC_API_KEY=sk-ant-...     # 视觉筛选
# 或 OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY ...

# 方式 B：pi 的登录体系（支持订阅制）
npx @earendil-works/pi-coding-agent /login   # 或直接 pi /login
```

模型选择（可选）：

```bash
export PI_TEXT_MODEL=deepseek/deepseek-v4-flash
export PI_VISION_MODEL=anthropic/claude-sonnet-4-5
# 本任务建议开启思考，不要设 off；设 off 会切换为强制 tool_choice
# export PI_THINKING=off|minimal|low|medium|high
```

自定义 OpenAI 兼容端点（Qwen-VL / GLM-4V / Ollama 等）：

```bash
export PI_CUSTOM_PROVIDER_API=openai-completions
export PI_CUSTOM_PROVIDER_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export PI_CUSTOM_PROVIDER_MODELS=qwen-vl-max,qwen-turbo
export PI_CUSTOM_PROVIDER_API_KEY=sk-...
```

**DeepSeek 视觉模型**（`deepseek-v4-flash-vision-exp`，不在 pi 内置目录里，走自定义端点）：

```bash
export DEEPSEEK_API_KEY=sk-...
export PI_TEXT_MODEL=deepseek/deepseek-v4-flash
export PI_VISION_MODEL=deepseek-vision/deepseek-v4-flash-vision-exp
export PI_CUSTOM_PROVIDER_ID=deepseek-vision
export PI_CUSTOM_PROVIDER_API=openai-completions
export PI_CUSTOM_PROVIDER_BASE_URL=https://api.deepseek.com
export PI_CUSTOM_PROVIDER_MODELS=deepseek-v4-flash-vision-exp
export PI_CUSTOM_PROVIDER_API_KEY_ENV=DEEPSEEK_API_KEY
```

**没有 LLM 凭据也能用（降级模式）**：`start`/`iterate` 时显式传 `keywords`，跳过自动解析与筛选，返回全部候选。

### 2. 配置图源

```bash
export PROVIDERS=ddg,bing,wikimedia          # 默认；并行查询
export OPENVERSE_TOKEN=...                   # 启用 openverse（CC 图库）
export SERPER_API_KEY=...                    # 启用 serper（Google 图搜）
export SAFE_SEARCH=true
export HTTPS_PROXY=http://127.0.0.1:7890      # 可选：部分图源被墙时走代理
```

### 3. 接入 MCP 客户端

Claude Code：

```json
{
  "mcpServers": {
    "reference-search": {
      "command": "node",
      "args": ["D:/path/to/reference-search-mcp/dist/index.js"],
      "env": { "DEEPSEEK_API_KEY": "...", "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

自研 stdio 客户端：`node dist/index.js`，标准 MCP 协议，工具返回 JSON 文本块。

## 双模式：这个 MCP 是"视觉能力外包"

这个 MCP 的本质是**给纯文本模型一双眼睛**：搜索、拼图、编号是机械部分；视觉筛选（看拼图选编号）是"外包的视觉能力"。调用方是否多模态，决定服务器要不要替它看：

| 模式 | 适用调用方 | 服务器行为 | 交互 |
|---|---|---|---|
| `server`（`FILTER_MODE=server`） | 纯文本模型 | 文本解析关键词 + 视觉筛选 | 返回 `selectedIds` + reasons（视觉模型的"看图报告"） |
| `client`（`FILTER_MODE=client` 或 `filter:false`） | 多模态模型 | 只做机械部分，不调用视觉模型（省一次视觉 API） | 返回拼图路径 + 全部候选编号，调用方**自己看拼图自己选 ID** |
| `auto`（默认） | 任意 | 配了视觉模型就筛，没配就降级 | 同 server / client |

`collect` 本来就接受任意有效 ID——多模态调用方可以无视 `selectedIds` 自己挑。每次调用也可用 `filter: false` 覆盖全局配置。

## 工具契约

| 工具 | 入参 | 返回要点 |
|---|---|---|
| `image_search_start` | `query`, `keywords?`, `criteria?`, `count?`, `safe_search?`, `filter?` | `session_id`, `round:"a"`, `grid_path`, `filtered`, `selected_ids`, `metadata`（编号→title/域名/license/尺寸/URL）, `keywords_used`, `warnings` |
| `image_search_iterate` | `session_id`, `feedback`（可引用 `a3`/`b12`）, `keywords?`, `filter?`… | 下一轮 `round:"b"`…；跨轮 pHash 去重（`dedupe_skipped`）；LLM 经 `refine_search` 调整关键词 |
| `image_search_collect` | `session_id`, `ids:["b1","c12"]` | `files`（本地路径/URL/license/宽高）, `manifest_path`, `failures`（逐 ID） |
| `image_search_status` | `session_id` | 各轮选中/拒绝、当前关键词、已收集 |

**ID 规则**：轮次字母 + 格序号。`a3` = 第 1 轮第 3 格，`b12` = 第 2 轮第 12 格。所有引用与 collect 均以此为准。

## 配置参考

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROVIDERS` | `ddg,bing,wikimedia` | 启用图源，逗号分隔 |
| `OPENVERSE_TOKEN` / `SERPER_API_KEY` | — | 可选图源凭据 |
| `GRID_COLUMNS` / `GRID_ROWS` | 6 / 8 | 每轮 48 格；`GRID_CELL_SIZE` 默认 256px |
| `SESSION_TTL_MINUTES` | 120 | 会话与临时拼图自动清理 |
| `DATA_DIR` / `OUT_DIR` | 系统 temp / `./out` | 数据与收集产物目录 |
| `HTTP_TIMEOUT_MS` | 15000 | 抓取超时 |
| `LLM_MAX_TURNS` | 3 | 内层工具循环最大轮数（含逼问轮） |
| `FILTER_MODE` | `auto` | `auto` \| `server` \| `client`（见"双模式"） |
| `PI_TEXT_MODEL` / `PI_VISION_MODEL` / `PI_THINKING` | 自动挑选 | LLM 模型选择；**建议开启思考，不要设 off**（设 off 切换为强制 tool_choice） |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | — | 图源抓取代理（部分图源被墙时配置） |

## 架构

```
src/
  mcp/        # MCP server（stdio）与 4 个工具注册
  llm/        # pi-ai 之上的工具调用循环：parseKeywords / interpretFeedback / filterGrid
  providers/  # SearchProvider 接口 + ddg/bing/wikimedia/openverse/serper 适配器，并行容错
  grid/       # sharp 拼图构建（编号徽章/占位格）、pHash 去重
  session/    # 会话状态机（轮次 a/b/c、seen 哈希、TTL 清理）
  collect/    # 整图下载（UA/Referer/重试/校验）、manifest 生成
  service.ts  # 编排：search → dedupe → grid → filter → round state
```

## 测试与脚本

```bash
npm test                              # 41 个测试：单测 + 真实 MCP stdio 集成测试
npm run smoke -- --query "space nebula" --keywords "nebula,art" --collect "a1,a2" [--iterate "更多星球"]
npm run handshake -- --query "cat" --keywords "cat"     # MCP stdio 握手冒烟（先 build）
npx tsx scripts/debug-pi.ts           # 诊断：真实 parseKeywords（工具调用 + 多组关键词）
npx tsx scripts/debug-vision.ts       # 诊断：视觉模型对最近一轮拼图的原始响应
```

## 注意事项

- **多角度查询**：自然语言需求含多个方面时（如"M1911 各角度"），关键词解析产出**分组关键词**（正面/侧面/正侧面…），各组并行搜索、去重后拼成**一张图**，metadata 每行带 `group` 标签。
- **每图描述**：视觉筛选时 `select_images` 的 note 填每张选中图的简短视觉描述（中文，面向绘画参考：角度/构图/光照/风格），随 `reasons` 字段交付——纯文本调用方也能"看到"图。
- **版权**：`metadata`/`manifest` 透传 license（Wikimedia/Openverse 自带），商用素材请自行核验来源授权。
- **热链保护**：部分站点（如 people.com.cn/Etsy）拒绝第三方下载，collect 会逐 ID 报告失败；403 时可用浏览器直接打开 URL。
- **图源网络问题**：ddg/wikimedia 在部分网络环境（如中国大陆）不可达或间歇超时——warnings 会提示"网络不可达：配置 HTTPS_PROXY 后重试"；bing 通常稳定。
- **降级模式**：无 LLM 凭据时需显式传 `keywords`，且不自动筛选（返回全部候选）。
