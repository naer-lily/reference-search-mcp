# AGENTS.md

本文为 AI 编码代理（Claude Code、Cursor、pi 等）提供本仓库的背景与约定。项目是**自用工具**：用户是画师，用它为绘画创作搜集参考图。

## 项目意图（重要，改动前先读）

- 用户用自然语言描述想要的视觉参考（如"暗色天空下的绿色极光"），本 MCP 服务器负责：解析关键词 → 多图源并行搜索 → 拼编号拼图 →（可选）视觉模型筛选 → 按 ID 下载整图到本地。
- 本质是"视觉能力外包"：给纯文本模型一双眼睛（server 模式）；调用方若是多模态模型，走 client 模式（`filter:false` / `FILTER_MODE=client`），服务器只做机械部分。
- 自用项目：优先实用、可跑、少抽象。不要在不需要的地方引入框架（服务器端 LLM 只是 3 个有界函数，不是 agent）。

## 常用命令

```bash
npm install --ignore-scripts   # 必须带 --ignore-scripts（pi 官方推荐，避免生命周期脚本）
npm run build                  # tsc 编译到 dist/
npm test                       # vitest 全量（含真实 MCP stdio 集成测试，会 spawn 子进程）
npm run typecheck              # tsc --noEmit
npm run smoke -- --query "..." [--keywords ...] [--criteria ...] [--collect a1,a2] [--iterate "..."] [--no-filter]
npm run handshake -- --query "..." --keywords "..."   # MCP stdio 握手（先 build）
npx tsx scripts/debug-pi.ts        # 诊断：pi 层文本工具调用
npx tsx scripts/debug-vision.ts    # 诊断：视觉模型对最近一轮拼图的原始响应
```

## 架构地图

```
src/
  mcp/server.ts   MCP stdio 服务器 + 4 工具（image_search_start / iterate / collect / status）
  llm/pi.ts       pi-ai 之上的 LLM 层：工具调用循环 + 3 个有界函数
  providers/      图源适配器（ddg/bing/wikimedia/openverse/serper），并行 + 失败隔离
  grid/           sharp 拼图构建（编号徽章/占位格）+ pHash 去重
  session/        会话状态机（轮次 a/b/c、seen 哈希、TTL 清理）
  service.ts      SearchService 编排层（MCP 与测试共用），业务逻辑都在这
  net.ts          fetch 封装（UA/重试/超时/大小限制/热链 referer）
scripts/          smoke / handshake / debug-*（真实网络与真实模型的验证入口）
tests/            vitest：离线单测（FakeLlm/FakeProvider/data: URL）+ 真实 MCP stdio 集成
```

## 关键设计决策（改动前必读）

1. **LLM 结果一律工具调用交付，绝无文本 JSON fallback**：参数 schema 由 provider 强制；无效参数（如不存在的 ID）靠"执行器回执错误 → 模型下一轮自愈"。tool_choice 策略（实测 DeepSeek）：thinking 开启时**不能**强制 tool_choice（API 400 "Thinking mode does not support this tool_choice"）→ 用 auto + 未调用工具时**对话逼问**（runToolLoop 追加"你必须调用工具"消息）；thinking 关闭（PI_THINKING=off）时**强制指定函数**（openai-completions 传 `{type:"function",function:{name}}` + `samplingParams.reasoning_effort="none"`；anthropic 传 `{type:"tool",name}`）。模型始终未调用工具 → 抛 `LlmDeliveryError`，service 层转 warning 或 UserError。
2. **双模式**：`FILTER_MODE=auto|server|client`，调用级可用 `filter` 参数覆盖。server=服务器视觉筛选（纯文本调用方）；client=调用方自己看拼图选 ID（省一次视觉调用）。`collect` 接受任意有效 ID——调用方可无视 `selectedIds` 自己挑。
3. **多组关键词**：`submit_keywords` 的 `groups:[{label,terms}]` 支持多角度需求（如 M1911 正面/侧面/正侧面），各组并行搜索、去重后拼一张图，metadata 带 `group` 标签。单组兼容。
4. **ID 规则**：轮次字母 + 序号（`a1`、`b12`）。跨轮去重用**精确 aHash 匹配**（`session.seenHashes`，64bit 二进制串）。
5. **迭代循环由调用方 AI 驱动**：服务器 LLM 只有 3 个有界函数（解析关键词 / 解读反馈 / 筛选拼图），不引入 agent 框架。

## pi-ai 集成要点（踩过的坑，别重踩）

- `createModels()` 是空壳：必须用 `builtinModels()`（`@earendil-works/pi-ai/providers/all`）注册内置提供商。
- 认证解析在 Models 层：用 `models.stream(model, context, opts)` / `streamSimple`，**不要**直接调 `provider.streamSimple`（会报 "No API key"）。
- 强制 tool_choice 需要 `models.stream`（`ApiStreamOptions`）；`streamSimple` 的 toolChoice 只有 `"auto"|"none"`。
- 自定义 OpenAI 兼容端点（`PI_CUSTOM_PROVIDER_*`）：动态导入 `@earendil-works/pi-ai/api/${api}` —— **不要加 .js 后缀**（导出映射已带扩展名，会变成 `.js.js`）。
- pi 版本 pin 精确版本（当前 0.84.3）；升级前先看 CHANGELOG，目录里模型可能变化（如 deepseek-v4-flash-vision-exp 不在内置目录，需自定义端点）。
- 图源抓取走 `src/net.ts` 的 `fetchBuffer`：支持 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`（undici ProxyAgent）；不要直接调全局 fetch（无代理）。

## 约定与禁忌

- **绝不提交 .env**（含真实 API key）；真实配置走 .env（gitignored），模板走 .env.example。
- TypeScript：strict、ESM（NodeNext，相对导入带 `.js` 后缀）。
- 测试夹具注意：**纯色图对 aHash 是退化输入**（全 1/全 0 位，不同颜色也会判重）；夹具图要有结构性差异（乘性扰动，不是整体亮度偏移）。
- MCP 集成测试 spawn 真实 `dist/index.js` 时，cwd 必须是**没有 .env 的临时目录**——否则 dotenv 会加载 LLM 配置，破坏"无 LLM 降级"测试假设。
- 图源适配器实现 `SearchProvider` 接口；失败必须隔离（抛 `ProviderError` 或错误返回），不拖垮并行查询。
- 修改 LLM 层后：先跑 `scripts/debug-*.ts` 验证真实模型行为，再跑 `npm test`。
- 文档语言：README/AGENTS.md 中文；代码注释英文。

## 本机验证状态（2026-08）

- DeepSeek `deepseek-v4-flash`（文本）+ `deepseek-v4-flash-vision-exp`（视觉，自定义端点）已验证全链路：自然语言关键词解析（含多组关键词）、视觉筛选（select/reject/refine 工具 + 每图中文视觉描述）、collect 下载均工作。
- 本机网络：bing 稳定；ddg/wikimedia 间歇性超时（环境问题，warnings 有提示）。
- 41 个测试全绿。
