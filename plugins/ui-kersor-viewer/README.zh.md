# @deepseek-ai/dsh-client-ui-kersor-viewer

[English](README.md) | 中文

KerSor 活动界面的 browser 半：与 Chat、Trajectory 并列的 conversation view 先展示 host 包 [`@deepseek-ai/dsh-kersor-viewer`](../kersor-viewer/README.md) 提供的最近经典／Session-v2 优化摘要，再列出 autonomous-workflow run，并渲染选中 run 的实时阶段／调用进度。Chat 还会为每次 `kersor_start` 或 `kersor_attach` 生成一个持久 Experiment 节点，展示控制器状态、轮次、Workflow、加速比、下一动作和九个协议里程碑；节点操作可打开精确的 continuable dsh controller child，因此结束后仍能检查完整对话与嵌套 Workflow 节点。stalled checkpoint 会显示为 blocked 且不保留下一动作，fold 会忽略其后无效的 reopen。紧凑的双列 Session 卡片展示建议性 health、规范 phase、最后活动时间、轮次预算、Host 验证的 best／目标加速比、language/backend、integration pattern、Workflow 创作已用／总预算、Session 自有门禁、selector 结果、选中 Workflow、fit confidence、存储格式、状态提醒数，以及最新规范决策的预览。展开卡片先显示终止原因、增量与全链路 cycles 血缘和 Round 树，再显示下层阶段时间线。每个 Round 会命名其 Workflow 与候选，区分 Host PASS／FAIL 与是否晋升，把估算和 measurement 视觉隔离，并为经过密封的 Session 自创 Workflow 展示 authoring escape 链。所选 Workflow 的声明阶段仍单独显示为通过 hash 验证的 portable dispatch envelope 拓扑树。内联 baseline 与 profile blocker 保留有界规范原因。门禁通过为绿色、待定为琥珀色、失败为红色；stalled／cancelled Session 会隐藏建议性 fit 徽标，因为历史 fit 不能覆盖终态 decision。

可选 Host 启动器 [`@deepseek-ai/dsh-kersor`](../kersor/README.md) 处于 active 后，同一面板还会列出部署配置中的任务和 dsh 当前持有的 launcher 进程，并提供启动／停止操作。该 capability 由规范的 Host 插件清单判定；UI 不会仅因 Client namespace 存在就探测 launcher endpoint。Host 条目缺失或未 active 时，面板仍会挂载，只是不显示控制区。

**一个 store，一个 Host 快照。** 视图数据存在一个 `useSyncExternalStore` observable 里。首次加载、视图挂载和重连会读取 `kersorViewer/snapshot`；之后替换式 `kersor/event` 帧更新同一份原子 projection。后台根扫描只在得到变化后的结果时发布，并保留最近一次成功内容，不会重新进入可见 loading。选择 run 时读取 `runBacklog` 获取折叠详情；展开经典 Session 时读取 `classicSessionDetail`，之后只在该 Session 的活动 revision 改变时刷新，并在请求期间保留旧详情。API Remotes assembly 是生成 contribution 生命周期的唯一 owner；本 UI 只消费已组装的 namespace，不会再次挂载。launcher 发现会先检查 `pluginInventory/list`，再决定是否调用 `kersor/listTasks` 或 `listActive`，因此只读 profile 不会探测缺失的 launcher route。Autonomous run 与带 runtime 事件的经典 `run-N` 目录进入同一条 phase/call fold。初始选择优先当前对话工作区；全局发现的 Session 仍可选择，并带有「非当前对话工作区」徽标。run 标签组合 Session、补零轮次与 Workflow，内部身份仍是完整 run 目录。

**Session 与 Workflow 生命周期保持分离。** 选择 Session 时会同时选择其最新的已发现 run，并把执行清单过滤到同一个 Session；选择 run 时也会展开其所属 Session，因此两个历史实验不会再拼成一个画面。DSH 原生工作没有生成独立 runtime event log 时，Round 树仍然可见。另一棵执行树把 Workflow phase 和 call 嵌套到 Session round 下，将 fan-out phase 标为并行，并追加 Host 候选所有权、measurement 与 decision 节点。Workflow 已返回而 Session 仍 active 时显示「Workflow 已完成 · Session 等待 Host 验证」，而不是「已完成」。从 `output.json` 提取的有界字段只展示估算；实测 cycles 与 speedup 只能来自通过的 Host review，并把阶段标为 `host_verified`。点击 Agent 节点后懒加载 `runCallDetail`，显示记录的 runner、模型 provenance 或明确缺失、thread id、有界 Agent 消息，以及工具／搜索名称；参数与结果永不渲染。

**Chat 节点由事件拥有。** `src/client/experiment-definition.ts` 只折叠所选父 dsh Session 的 `kersor/experiment-*` 事件，形成一个稳定 keyed 节点；它不会扫描全局 viewer store。包的 node 侧 `apply` 仍为空，因为 Session event 生产属于 `@deepseek-ai/dsh-kersor/control`，而发现、tail 与全局活动视图仍属于 host viewer。

**状态记账保持分离。** 经典 Session 与 autonomous 清单原子到达，形成一致的活动视图；折叠 run 详情与 launcher 持有的进程树仍是独立记账。进程从清单消失不会把 workflow 标成完成；状态由 KerSor Session store、summary 与事件决定。

## Model Experience

无，因为这个 browser 侧观察器只读取 KerSor Remote，不登记 prompt、工具 schema 或模型请求输入。

#### KV Cache effect

无：本包不组装或修改模型请求。

## Known Limitations and Deferred Work

- **一个标签页选中的 run 不会同步到另一个** —— 选择是页面内组件状态，刻意如此：浏览行为不改写任何 host 状态。
- **详情跟随选择** —— 清单与来源健康实时更新；选中 run 的 backlog 在选择时读取，经典 Session inspector 只在重连或活动 revision 改变后刷新。
- **模型身份可能缺失** —— 较旧 runtime 保留的 worker artifact 可能记录了 Codex runner 与 thread，却没有底层 provider/model；视图显示「未记录」，不会从父 dsh 对话推断。
- **控制区不编辑启动配置** —— 任务路径、runtime config、凭据与环境仍是 Host 部署配置；浏览器只发送已登记 task id 或一条受管 run 的精确目录。
