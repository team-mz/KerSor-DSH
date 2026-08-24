# kersor-viewer — KerSor 活动查看器

[English](README.md) | 中文

在 dsh Web UI 中查看 [KerSor](https://github.com/qhy991/KerSor) 活动。它刻意分开两种投影：最近的优化 Session（包括现有经典 `state.md` 格式），以及实时 autonomous-workflow 运行。本 host 包通过已安装 KerSor preset 的 bridge 获取有上限的 Session 摘要，发现 autonomous run 目录，并 tail 每个活跃 run 的 `.runtime/events.jsonl`。一个生成的 `snapshot` Remote 与一个替换事件原子地携带两份清单及其来源健康状态；`runBacklog` 与 `runResult` 携带选中 run 的折叠进度和候选结果，`runCallDetail` 懒加载一个已知调用保留的消息与活动名称，`classicSessionDetail` 则按需读取一个已经发现的经典 Session。browser 半位于 [`@deepseek-ai/dsh-client-ui-kersor-viewer`](../ui-kersor-viewer/README.md)。

KerSor 始终是唯一状态所有者。bridge 导入 KerSor 规范的 `SessionStore` 与 `AttemptResultStore`；TypeScript 包不重新实现 legacy frontmatter 解析。viewer 会扫描每个已登记 Workspace，并合并规范 Session persistence 中所有合法的绝对 cwd，因此由 API 创建或作为 continuable child 创建的 Session 即使没有 `workspaceRegistry` 记录也保持可见。若 persistence 枚举失败，discovery 会保留最近一次成功读取的持久 cwd 集合及当前已登记 Workspace，并只把最终来源快照标为 degraded，不发布中间 replacement。若 preset 未安装，快照会记录 `not_installed`，autonomous run 发现仍继续工作。

本包只观察、不启动。如需从同一面板启动部署配置中有限的一组 Mission，可组合兄弟启动器 [`@deepseek-ai/dsh-kersor`](../kersor/README.md)。无论是否加载启动器，KerSor run 文件始终是权威状态。

## 配置

插件行在 `cordis.patch.yml` 中接受 config：

```yaml
- id: kersor-viewer
  name: '@deepseek-ai/dsh-kersor-viewer'
  config:
    roots:
      - /absolute/path/to/kersor/.kersor
    noDefaultRoots: false
    scanIntervalMs: 5000
    classicSessionLimit: 20
    classicStaleAfterSeconds: 1800
```

- `roots` — 其直接子目录为 KerSor Session 的额外根；它们会与已登记 DSH Workspace、持久 Session cwd 及默认根一起扫描。
- `noDefaultRoots` — 关闭内置根：`~/.local/share/kersor`、`~/Agent4Kernel/KerSor/.kersor`，以及已安装 `kersor` preset 记录的 checkout（或 `KERSOR_ROOT`）追加 `/.kersor` 后的路径。已登记 Workspace 与持久 Session cwd 根仍保持可见，因为它们是任务状态，不是回退默认值。
- `scanIntervalMs` — run 发现重扫间隔（最小 500 ms）。
- `classicSessionLimit` — 通过已安装 preset bridge 返回的最近优化 Session 数（`0` 关闭，最大 `100`，默认 `20`）。
- `classicStaleAfterSeconds` — 未结束 Session 的建议性无活动阈值（默认 `1800`，最大一天），与 KerSor TUI/doctor 默认值一致。

带 `workflow_status: "waiting"` 的 summary 在 run 发现层属于终态：KerSor controller 已停止并写入 summary，只是 workflow 正在等待外部输入，而非语义完成。Workflow 完成不会让其父优化 Session 进入终态；browser 会把 run 与规范 Session 投影关联，并单独显示尚未完成的 Host measurement 或 decision 阶段。

经典 Session 卡片把 KerSor 的规范 phase 与建议性 health 分开：阈值内存在稳定 artifact 活动是 `active`；陈旧的干净 `CONTINUE` 边界是 `needs_resume`；其他未结束的陈旧工作是 `stale`；终态是 `terminal`。经过时间绝不改写 phase。有界摘要还携带 language/backend、integration pattern、Workflow 创作已用／总预算、严格 fresh-Session isolation、Session 自有 baseline witness 与 profile evidence 状态及其有界规范 blocker、DSH Workflow compatibility、Host 自有 candidate-output ownership、selector 结果、终态停止原因与 Host 验证的 cycles 血缘。展开卡片会按需读取有序且有界的 Round 历史，以及 artifact 派生的阶段时间线、selector 拒绝数、authoring／seal／save 状态、Proposal validation checks、dispatch lifecycle 与有上限的 Workflow 设计文本。每个 Round 会区分可复用 Workflow 与本轮唯一候选，并且只有 Host review 通过后才携带 measurement；错误候选可以保留明确标记的估算值，但永远不能贡献 Session best。通过 portable dispatch 门禁后，只有所选 released／Proposal Workflow 的名称与内容 hash 同时匹配 compatibility 和 catalog owner，bridge 才会公开其声明 phase 与 topology；Session 自创 Workflow 仍须等三文件 author handoff 存在且全部密封 hash 匹配后才会公开。投影同时携带最后稳定 artifact 时间；若绝对内核路径已失效，面板只显示不含路径的状态提醒，不把旧本地路径泄漏到浏览器。

来源健康不会从空数组推断。快照记录每个扫描根、接受的 Session 数、发现的 run 数、backfill/tailer 模式、行计数，以及最近一次有上限的 stage/code issue。周期扫描只在实验或来源健康语义变化后发布；扫描时钟与重复的同类诊断不会发送 replacement，也不会让客户端已展开详情失效。缺失的可选默认根是中性状态；配置根缺失、persistence 枚举失败、权限失败、summary 损坏、事件日志不可读或事件行被拒绝都会成为 degraded 或 failed。persistence 枚举失败不会从本次扫描中移除已登记根或最近一次成功读取的持久根。原始异常、bridge 输出、环境值、工具参数与工具结果绝不会跨过 Remote 边界。调用详情只接受已发现 run 中已经出现在折叠事件流里的调用，最多读取 2 MiB Codex 事件，保留最多 12 条有界 Agent 消息和 40 个工具／搜索名称，超出时报告截断而不转发其余内容。通过的有界 `host-verification.json` 会把结果阶段改成 `host_verified` 并增加实测 cycles／speedup，而不改写原始 Workflow `output.json`；Host 证据缺失或失败时，投影仍只显示估计值。

## 结构

| 文件 | 职责 |
|---|---|
| `src/service.ts` | host 半：一个原子缓存快照、run backlog、tail、折叠与替换事件 |
| `src/diagnostics.ts` | 不含内容的 issue 分类与有上限的出现次数记账 |
| `src/detail.ts` | 按需、有上限地投影 worker 身份、消息和活动名称 |
| `src/classic.ts` | 无 shell、有上限地调用已安装 preset bridge，并校验 wire shape |
| `src/scanner.ts` | 根扫描：session-v2 目录及其 `autonomous-runs/` 子目录 |
| `src/tailer.ts` | 带截断检测的 `events.jsonl` 位置追踪 tail |
| `src/fold.ts` | KerSor 事件流到视图模型的纯函数折叠 |
| `src/result.ts` | 排除源码和任意 report 文本的候选选择投影 |

## Model Experience

无，因为这个 Host 侧观察器只读取 KerSor artifact 供 browser 展示，不登记 prompt、工具 schema 或模型请求输入。

#### KV Cache effect

无：本包不组装或修改模型请求。

## Known Limitations and Deferred Work

- **Worker 模型身份取决于保留证据** —— 较旧 Codex artifact 可能只携带 runner 与 thread id，而没有底层 provider/model；投影会返回明确的缺失值，不从父 dsh 对话推断。
- **调用详情刻意不完整** —— 只渲染有界 Agent 消息与工具／搜索名称；prompt、工具参数、工具结果、命令文本和任意其他事件类型仍只留在 Host。
