# kersor — DSH 原生 KerSor 控制器与已登记 Mission 启动器

[English](README.md) | 中文

`./control` function plugin 把一个 KerSor 实验绑定到当前 dsh 对话，并在一个持久、可续接的 dsh 子 Session 中执行。包根仍是可选 Host 启动器，让已登记的 [KerSor](https://github.com/qhy991/KerSor) autonomous Mission 可从 dsh 启动，同时不把浏览器变成 shell。

KerSor 文件继续作为优化状态、证据、artifact 与 resume 决策的事实源。父 dsh Session 只持有不可变的 Experiment-to-child 绑定和单调展示 checkpoint；子 dsh Session 持有完整控制器对话与现有 `tool-workflow/*` 执行树。与 [`@deepseek-ai/dsh-kersor-viewer`](../kersor-viewer/README.md) 及 [`@deepseek-ai/dsh-client-ui-kersor-viewer`](../ui-kersor-viewer/README.md) 组合后，可同时获得全局只读视图和 keyed Experiment Chat 节点。

## 对话控制器

在 KerSor agent preset 中挂载 `@deepseek-ai/dsh-kersor/control`。`kersor_start` 预留 Experiment id 与 continuable child id，追加并 flush `kersor/experiment-start`，然后通过进程内 `spawn` provider 启动子任务。`kersor_attach` 为工作区内已有 Session 建立同样的绑定。`kersor_resume` 只接受开放绑定，并把 follow-up 送入原 child；它不能创建第二个 Experiment，也不能静默重复 dispatch。KerSor `phase=stalled` 会把该绑定关闭为 `blocked`：resume 会明确拒绝，下一动作置空；解除 blocker 后，父对话可以创建新 Experiment。

`kersor_start` 可选接收一个不可变 `launch` 对象。提供时，所有字段均为必填：非空 `backend`、`language` 与 `integration_pattern`；正数 `target_speedup`；正整数 `max_workflows`；属于 `auto|guided|explore` 的 `mode`；非负整数 `workflow_authoring_budget`；属于 `on|off` 的显式 `retrieval_mode`、`experience_mode` 与 `kernelwiki_experience_export_mode`；属于 `full|measured-only|off` 的 `transfer_mode`；以及非空单行 `correctness_command` 与 `benchmark_command`。校验后的对象按规范字段顺序存入 `kersor/experiment-start`，resume 会原样复用。它的权威性高于冲突的 objective 或 continuation prose：数字字段保持没有 `x` 或 `%` 后缀的 JSON number，两条命令保持逐字不变。`runtime` 被刻意排除，因为控制器始终使用 `dsh`；Host `KERSOR_PYTHON` 继续是独立的解释器权威。

控制器把 KerSor runtime 固定为 `dsh`。只要 canonical phase 仍为 active，名为 `STALLED` 的 round selection 就只是可恢复的 routing gap：当 Workflow authoring 已启用且 saved-Proposal budget 仍有余量时，child 必须先完成 Phase 3.6、同轮完整 selection commit 及由此产生的 dispatch，之后才能 synthesis terminal `STALLED` decision。顶层对话绑定 controller child 后，执行器策略会把直接委派保留给该对话所有 `kersor/experiment-start` 事件声明的 child id：父侧的 subagent、fork、Workflow、agent-control、job-control 与 status 工具都会被拒绝，而 controller child 仍可创建自己的 DSH 原生 worker。控制器内部仍会拒绝递归 KerSor 控制调用与产品专属 Claude/Codex subagent 工具。stalled、completed 或 cancelled 控制器只能调用 `kersor_status`；该终态状态调用成功后会结束其 Turn。每次成功的 `kersor_status` 调用都会生成去重并 flush 的 checkpoint，其中包含阶段、轮次、已选 Workflow、九个协议里程碑、下一动作与实测摘要字段。父 Turn 完成不会终止 Experiment，也不会把它标成 interrupted。

对话控制器要求 Host `KERSOR_PYTHON` 是非空绝对路径，且能解析为可执行文件。Start 和 attach 会在写入绑定前校验它；resume 会在发送 follow-up 前校验它。解析后的路径会冻结进每条 child 指令；指令要求每条涉及 KerSor bridge、helper 或 setup 的 shell 命令都以显式 `KERSOR_PYTHON='<frozen-path>'` 赋值开头，并禁止使用 `which`、`PATH` 查找、文件系统搜索或替换解释器。

该解释器契约同时也是执行门，而不只是 prompt 指导。每次 Bash 调用前，控制器都会沿调用 Session 的 live `parentSession` 链检查 ancestry；controller 及其每层 descendant 的 KerSor bridge／helper／setup 命令都必须以精确的规范 `KERSOR_PYTHON='<frozen-path>'; export KERSOR_PYTHON;` 前缀开头。整条 ancestry 内都会拒绝 Python 发现与替换。无关 task Bash、KerSor agents／docs 的读取与列举、非 Bash 工具，以及不属于 Experiment ancestry 的 agent 均不受影响。

`kersor_protocol` 持有三种完整的 DSH action：profile handoff、Workflow selection 与 author handoff。Direct controller 只提供 `profile`、`select_workflow` 或 `author`。Host 从 durable Session authority 派生所有路径、current round、冻结 executable 与 adapter root，并通过受管理的 subprocess service 执行固定参数向量。Profile 与 author 会读取完整 canonical dispatch 并启动精确的 foreground child，因此模型不再复制过长 JSON prompt，也不再传递 child id。Selection 会运行 Core filter、读取 Core `selection-handoff.py` context，仅在 `agent-advise` 时启动一个 foreground strategy selector，并在返回前运行 Core finalizer；STALLED、fixed-order、score-only 与 binding explore decision 不启动 child，直接 finalize。Selector child 受到 `read`／`glob`／`grep`／`write` allowlist 强制限制，且只有该 active child 可以恰好一次写入精确 canonical routing decision。Context 会绑定 catalog hash：同 catalog 重复调用已被消费；catalog 变化时允许同轮 re-selection，Core 会归档上一份 decision。仅由环境变量描述的 paired routing 会被拒绝，因为 pair identity 与共享 store 没有 durable Session owner。Profile 会先验证 durable baseline chain；baseline 前的拒绝不会启动工作且可以重试，baseline 后的首次调用才会消费 profile attempt。随后它会在返回前 seal 并 verify child-owned bytes；KerSor 文件继续是语义真源。Attached controller 不能使用该工具。[Host-owned 协议 action 决策](../../../.agents/notes/implemented/simplification/2026-08-24-host-owned-kersor-protocol-actions.md)持有其理由。

规范 setup 边界同时拥有其 Bash 沙箱处置。携带精确 Host 生成命令，且 workdir 缺省、为字面量 `.` 或与规范 controller workspace 字符串完全相同的前台调用，仍是唯一耐久 setup 身份；其他拼写会被拒绝，避免 symlink/`..` 别名跨越鉴权边界。该 registry execution 通过鉴权后，模型写入的任何 `sandbox_permissions` 与 `justification` 都会在 Bash 校验升权或请求审批前被抑制。因此 setup 始终在 Session 常驻 workspace policy 下运行；模型写入的升权既不能通过非法配对阻断首次执行，也不能扩大其权限。授权以 registry 创建的 execution object 为键，并在最终 `tools/result` 再次清理，不能跨越失败、call-id 复用、dispose 或 reload。

Gate B 在接受前台 dispatch producer 的同一项 Host 操作中提交 deterministic runtime-control pass。Producer 写入两份语义文件后，Host 会发布 receipt 与持久 `kersor/dispatch-args-produced` event，通过受管理的 subprocess service 以参数向量调用冻结的 `inject-runtime-controls.py`，验证只有 runtime-control 字段 allowlist 发生变化，再原子发布 transformation receipt 与 `kersor/dispatch-args-transformed`。Controller 不会收到 transform 命令。进程失败或修改无效时，producer 证据会保留，但不会发布成功的 transformation event。[Host-owned 协议 action 决策](../../../.agents/notes/implemented/simplification/2026-08-24-host-owned-kersor-protocol-actions.md)持有其理由。

只有 KerSor Router commit 完成后，selected Workflow 才能 dispatch。Gate B 与 Workflow source validation 共用同一个 Host selection validator；它同时要求 `attempt_plan.status=committed` 与 `attempt_plan.commit.status=committed`、该 commit 必须命名 `selected_workflow.name`，并拒绝缺失或 pending 的 `routing.decided_by`。因此 finalize 前由 selector 写出的 fallback 不能获得 dispatch 或 Workflow authority。

Workflow authoring 在 typed Host seal 前把 staging 独占交给前台 author。Direct controller 在 seal 前不能读取、搜索、列举或修改 staging，author child 则保留 seal 前文件写入与 syntax self-check。当 `kersor_protocol({action: "author"})` 完成时，Host 会在 `kersor/author-produced` 中记录 context hash，以及 in-process start call 创建的 child id；这是 Host binding，不声称其 lineage 已被另一条 replay 独立证明。`kersor_author_commit({action: "seal"})` 从 durable authority 派生所有路径与 executable，在执行前验证 canonical non-symlink staging directory 只包含三份有界 direct file，以固定 argv 调用 Core，随后在 `kersor/author-handoff-sealed` 中只记录完整 handoff receipt 的路径与 SHA-256。Core 继续持有 handoff 的 open-world internal schema。Seal 与 save 之间，只有 direct controller 可以每次通过 `read` 读取一份精确的 canonical staging file；Host 会在每次读取前重新验证当前 receipt，而 alias、hardlink、symlink、search、Bash、descendant 和所有 mutation 仍被拒绝。`kersor_author_commit({action: "save"})` 会验证 canonical write target 与未变化的 receipt bytes，追加并 flush `kersor/author-save-attempted`，再以固定 argv 调用 Core saver。只有当 Core 输出唯一且 canonical 的 Session-local probation Proposal、Host 绑定其 workflow、metadata 与 record file，且第二个固定 Host process 从该 Proposal store 重建 `workflow-catalog.json` 并验证新 entry 后，工具才报告成功。Process failure、malformed success output、缺失 artifact 或 invalid catalog 都保持已消费且不能重试。[Host-owned 协议 action 决策](../../../.agents/notes/implemented/simplification/2026-08-24-host-owned-kersor-protocol-actions.md)持有该边界。

成功的 `workflow` 结果只有一个 Host-owned 文件系统边界。每个 Experiment descendant 都必须传入绝对 `args.exp_dir`，且该路径不能经过 symlink，必须精确解析到 `<workspace>/.kersor/<session>/run-N`。结果到达模型前，Host 会校验规范 `{runId, agentsStarted, result}`，要求 raw `result` 是不超过 4 MiB 的 JSON object，写完完整临时文件后再通过原子、独占 hard link 发布为 `output.json`。路径非法、symlink escape、非对象或超限结果，以及已存在的 output 都会 block Workflow 结果；绝不覆盖任何文件。工具渲染结果可以截断，但该文件来自未截断的规范值。

一旦 `run-N/output.json` 存在，Experiment descendant 可以读取，但不能通过 `write`、`edit`、明显的 Bash 重定向／`tee`／`cp`／`mv`／`rm` 或 Python open/write 路径修改它。只有成功 Workflow 结果由 Host commit。失败 Workflow 不创建文件，因此 controller 可在文件缺失时使用 `write` 一次来创建 failure stub；首次创建后，同一不可变规则生效。

## 配置

通过 `~/.dsh/cordis.patch.yml` 等 overlay 加入 Host 插件：

```yaml
- id: kersor
  name: '@deepseek-ai/dsh-kersor'
  config:
    root: /absolute/path/to/KerSor
    python: /absolute/path/to/python3
    tasks:
      - id: memo
        label: Build repository memo
        mission: /absolute/path/to/memo.mission.json
        runtimeConfig: /absolute/path/to/codex-runtime.json
    credentialRefs:
      - INFINI_API_KEY
    env:
      NO_PROXY: 127.0.0.1,localhost
    maxOutputBytes: 65536
    stopGraceMs: 3000
```

- `root` 是包含 `scripts/run-autonomous-workflow.py` 的 KerSor checkout 绝对路径。
- `python` 是 subprocess provider 执行环境中的绝对可执行路径或 `PATH` 裸名称。
- `tasks` 是完整的浏览器可启动登记表。`mission` 与可选 `runtimeConfig` 必须是绝对路径；remote 调用方只能提交任务 `id`。
- `credentialRefs` 在每次启动时从 dsh credential provider 解析，并以同名环境变量转发。secret 值不会进入任务清单或启动回执。
- `env` 是显式的非 secret 子进程环境；它不会继承 subprocess 边界清除的 credential 形环境变量。
- `maxOutputBytes` 限制每条 launcher 输出流的捕获量；`stopGraceMs` 控制 TERM 到 KILL 的升级等待。

Mission 必须是 JSON `kersor-mission-v1` 文档。其 `workspace`、`session` 与 `runtime` 为标准 KerSor runner 提供路由。Mission 中的相对路径按 Mission 文件位置解析；插件 config 不复制这些路由字段。

## 运行语义

`start(taskId)` 在 dsh 已持有进程树后返回，并包含生成的 `runId` 与预期 `runDir`。它不表示 workflow 已成功启动或完成。`listActive()` 只列出当前 dsh 进程仍持有的 launcher 进程。Workflow 状态来自 viewer 读取的 KerSor run 文件。

插件卸载会终止并等待所有受管进程树退出。dsh 重启不会重新取得一个已脱离 KerSor 进程的所有权；其 run 文件仍可由 viewer 发现。

## 模型体验

### 控制工具与 child prompt

#### 模型看到什么

父模型只看到 start、attach、resume 三个小型工具 schema。每个成功结果都会声明后续工作归 controller 所有，要求父级结束当前 Turn、不得轮询、委派或检查工作区，并携带实际强制停止的 runtime conclusion marker。Start schema 通过逐字段 enum、数字、命令与权威性描述公开可选 typed launch contract。控制器 child 收到冻结目标、当前工作区、解析后的 Host Python 路径、显式 `runtime=dsh`、提供时的规范 launch JSON 及逐字段指令、三种 action 的 `kersor_protocol` contract、两种 action 的 `kersor_author_commit` contract，以及 Host-owned Workflow output contract。它要求 Host 完成 profile 与 author handoff，以及 author seal/save，而不再读取或重建 helper path、dispatch prompt、child identity、receipt field 或 shell command。它被要求在 Workflow 成功后读取 raw `output.json`，不得从受限结果文本重建；只有 Workflow error 且文件缺失时才能创建 stub。Child 还会收到加载已安装 KerSor skill 及通过 `kersor_status` 报告阶段变化的要求；它不会收到父对话历史。Session persistence 会为后续每次 resume 保留解释器、launch 与 custody 指令。

#### Token 影响

父对话只承担工具调用与 checkpoint card 的 token。控制器和每个 Workflow 成员使用独立子历史，因此其 token 不会累积进父对话。Typed handoff 与 commit 不在 controller request 中携带 helper path、shell command、dispatch prompt、child-id 或 receipt-body 文本。Selection 会把 Core-owned prompt 直接传给可选 child；finalization 与 runtime-control transformation 都不会增加 controller 请求或模型可见命令上下文。

#### KV Cache 影响

父对话与每个 child 使用独立 cache prefix。Resume 追加到同一个控制器 child 历史；它不会创建新上下文，也不会使父对话此前的 prefix 失效。

## 已知限制与顺延工作

- `kersor_protocol` 当前只接受 created controller authority。Attached controller 会保留导入的 Session 证据，但在 imported current-action ownership 定义前，不能调用三种完整的 Host action。
- 当前 DSH Session layout 只支持一次 authored producer、seal 与 save。`workflow_authoring_budget` 大于 1 时仍不受支持，直到 author attempt 拥有不同的 canonical identity 与 path。
- 任务是静态部署配置。刻意不支持从浏览器编辑 Mission、runtime config 或任意命令参数。
- remote 不暴露 resume。Resume 校验与策略仍由 KerSor 标准 runner 持有。
- launcher stdout/stderr 为诊断而有界捕获，但不暴露给浏览器；workflow 诊断应读取 KerSor `.runtime` 文件。
- launcher 不从进程退出推断 workflow 成功；viewer 折叠出的 KerSor 状态才是权威状态。
- 关闭页面或切换对话不会停止控制器 child。Host 重启会保留父子两个 Session，但需要显式 `kersor_resume`；当前 Workflow engine 无法从一次前台脚本调用的中间位置恢复。
- 可选的已登记 Mission 启动器是独立兼容面，可能使用 Mission 声明的外部 runtime；对话控制器才是标准 DSH-only 优化路径。
