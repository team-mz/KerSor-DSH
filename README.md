# dsh-personal-plugins

统一管理个人 DSH 扩展。当前 KerSor 套件包含 agent preset、可加载 skill、工作区状态卡、对话绑定的 DSH 原生 Experiment 控制器、只读 run viewer、与 Chat／Trajectory 并列的 KerSor view，以及可选的有限 Mission 启动器；不收集 `~/.dsh/settings.yaml`、sessions、storages 或任何凭据。

## 五分钟上手

1. 安装或更新 preset：

   ```bash
   python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --force
   ```

2. 首次安装 Web bundle；若已经安装过，使用下文的“移除再重装”更新流程：

   ```bash
   dsh plugin --profile web add "file:$PWD/bundles/kersor-web"
   ```

3. **重启 DSH Web 进程**。已经运行的 Host 不会自动采用新 preset composition 或新的浏览器 bundle。
4. 在 DSH 中添加目标工作区，新建会话，把 agent preset 从“标准模式”切换为 **KerSor**。
5. 用任务合同描述目标、基线、权威验证命令、禁止修改的文件和停止条件。顶层 Agent 加载 `kersor` skill 后，将 GPU／benchmark 优化交给 `kersor_start`；DSH-native 的固定 `task-v1` 与适应性 `mission-v1` 都通过 Host 侧 `kersor_evolve`，显式外部 Codex Task 才使用 workspace-confined bridge，二者都不能改写成优化合同。已有优化 Session 用 `kersor_attach`，之后只用 `kersor_resume` 恢复原 controller child。
6. Chat 中的 KerSor Experiment 卡显示九阶段进度和下一动作；点击「查看 DSH 执行对话」进入完整控制器对话。会话标题下的 `KerSor` 标签继续提供跨工作区总览、Workflow 执行图与候选选择。

## 为什么安装时生成 composition

`standard` preset 由 DSH 上游维护。仓库只拥有 KerSor 增量；`scripts/install.py` 每次从当前安装的 `standard/agent.cordis.yml` 生成用户侧 `kersor/agent.cordis.yml`。升级 DSH 后重新执行安装命令即可继承新版 standard，避免维护一份会漂移的副本。

## 安装或更新

需要 Python 3.10+、已安装的 DSH，以及一个 KerSor checkout。若要使用
generic evolve，安装时还必须能解析 Bash、Node、jq；只有选择外部兼容 runtime
时才需要 Codex 或 Claude Code。安装器会冻结这些命令的
绝对路径，缺失或随后移动时 bridge 会要求重新安装，而不会回退到会话 PATH：

```bash
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor
```

若把可选的 Claude-compatible 后端接到 Infini-AI，可在可信安装阶段同时冻结
wrapper 和模型 ID；密钥仍由 wrapper 从本机凭据存储读取，不会写入 preset：

```bash
python3 scripts/install.py \
  --kersor-root /absolute/path/to/KerSor \
  --claude-command /absolute/path/to/claude-infini \
  --claude-model deepseek-v4-flash \
  --force
```

这只是 `runtime=claude` 的兼容路径：Claude Code 在这里充当 agent CLI，实际模型
是 Infini-AI 的 `deepseek-v4-flash`。它不等同于 DSH-native Mission，也不应被描述
为“Claude 模型执行”。

如果 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor` 已存在，先预览，再显式覆盖：

```bash
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --dry-run
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --force
```

覆盖前，安装器会把旧目录移动到同级时间戳备份。KerSor 的机器路径只写入已安装 preset 的 `.local/kersor-root`，不会进入 Git。

上面的 `--kersor-root` 和直接安装 `file:<checkout>` 适合本地开发，但不构成冻结发布证据：pnpm 的目录依赖可以让 checkout 与 profile 中的文件共享 inode，修改源码会同时改变正在使用的 Web package。正式测试或发布必须先从三个明确的 Git commit 构建只读 release；构建只读取 commit objects，展开 Core 记录的每个 submodule commit，要求 schema v2 `dsh-mirror.json` 的 136 项与三个 package 物理树完全一致，并把每项声明为 authority tracked、authority derived-build 或 personal distribution-owned。对于 Git 忽略的 74 个 `lib/**`，prepare 会从 exact DeepSeek Harness commit 读取中央 build receipt，核对输入闭包和固定 Node／pnpm／命令，再在独立 clean snapshot 中执行 frozen filtered install 与 canonical build；重建产物必须同时匹配 authority receipt 和 personal commit，之后才会制作四个本地 tarball：

```bash
python3 scripts/release.py prepare \
  --personal-root /path/to/dsh-personal-plugins \
  --personal-commit <40-hex-personal-commit> \
  --core-root /path/to/KerSor \
  --core-commit <40-hex-core-commit> \
  --authority-root /path/to/deepseek-harness \
  --authority-commit <40-hex-harness-commit> \
  --node /absolute/path/to/node-24.19.0 \
  --pnpm /absolute/path/to/pnpm \
  --output /path/to/immutable-kersor-release
```

Release 模式的 preset 指针只能指向该 release 内的只读 Core，不会探测 Codex 凭据目录，并会写入安装 receipt：

```bash
python3 scripts/install.py \
  --release /path/to/immutable-kersor-release \
  --force
```

Web package 继续通过 DSH 自己的 plugin manager 安装，但输入改为 release 内的 bundle tarball；安装器把 profile 的 pnpm import method 固定为 `copy`，并实测每个安装文件均非 symlink、`nlink=1`、不与源码共享 inode。已有 `node_modules` 的 profile 会从其 `.modules.yaml` 读取既有 pnpm store，只接受同一用户拥有、无任何 symlink 路径段且不可被 group／world 写入的绝对物理目录；经验证后，安装器仍通过隔离环境把 `.modules.yaml` 中的原始路径拼写传给 pnpm，并在安装后复核原始路径和 device／inode 均未变化。新 profile 只能在最小化的 release runtime HOME 下创建隔离 store；该 HOME 同时以空的 0600 npm 配置隔离调用者的 user／global npm 配置。最终 receipt 绑定 store 原始路径、真实路径、owner、device／inode 和 mode：

```bash
python3 scripts/release.py install-web \
  --release /path/to/immutable-kersor-release \
  --dsh-home /path/to/.dsh \
  --profile web \
  --node /absolute/path/to/node \
  --pnpm /absolute/path/to/pnpm \
  --dsh-bin /absolute/path/to/dsh/apps/cli/lib/bin.js
```

最终只读门禁同时核验 Core、preset、四个 Web package、profile manifest／lock、工具身份和 receipt。任一字节、pointer、依赖形式、inode 或 mode 漂移都会失败；通过后仍须重启 DSH，已经运行的 Host 不能为新安装字节作证：

```bash
python3 scripts/release.py verify-installed \
  --release /path/to/immutable-kersor-release \
  --dsh-home /path/to/.dsh \
  --profile web
```

Release lock 内的 bundle 依赖绑定其 tarball 绝对路径，因此 release 目录不得移动、覆盖或删除。验证器记录 exact authority tree、build receipt、输入／输出摘要、实际 Node binary 的 SHA／platform／arch、pnpm wrapper，以及 resolved `node_modules/pnpm` 的完整跨平台文件树；prepare 前后会复核这些本机工具身份，authority receipt 则绑定 pnpm package tree 与版本。单独篡改 ignored build、personal mirror、receipt 或 pnpm 执行包都不能通过 clean rebuild。Node binary 的本机 SHA 是 release lock 明示的外部信任根，不冒充跨平台 authority 证明；该门禁也不能防御已控制同一账户及全部这些输入的攻击者。

为 Web profile 安装 run viewer 与 KerSor conversation view（建议先安装上面的 preset，让两者共享同一份 checkout 指针）：

```bash
dsh plugin --profile web add "file:$PWD/bundles/kersor-web"
```

若 `dsh` 未加入 `PATH`，可在 DSH checkout 中用 `pnpm dsh plugin --profile web add ...` 执行同一操作，并把 `file:` 后的路径写成此仓库 bundle 的绝对路径。

该 bundle 会安装三个插件，但默认只在 Host 挂载只读 viewer 与 UI。Preset 会从已安装 package 的 `@deepseek-ai/dsh-kersor/control` 子路径挂载 `kersor_start`／`attach`／`resume`；包根启动器只有在 profile patch 中显式登记至少一个 `kersor-mission-v1` Mission 后才应挂载。配置合同见 [`plugins/kersor/README.zh.md`](plugins/kersor/README.zh.md)。

当前对话事件要求 DSH build 已认识 `kersor/experiment-start` 与 `kersor/experiment-checkpoint`。在包含这些事件的正式 DSH release 发布前，应从本仓库镜像所对应的 DSH source checkout 启动 Web Host；旧 build 即使能加载插件，也会在重启读取日志时拒绝未知的必需事件。

更新仓库后，先移除再重装这一精确 bundle，确保 pnpm 不复用旧的本地目录快照：

```bash
dsh plugin --profile web remove @qhy991/dsh-kersor-web
dsh plugin --profile web add "file:$PWD/bundles/kersor-web"
```

## 公开分发

本仓库当前是包含多个本地 package 的源码分发包，而不是可以从仓库根直接安装的单一 npm package。clone 后通过 `file:` 安装 bundle 只提供简便的开发体验；需要可复现发布证据时，必须锁定不可变 tag／commit 并使用上面的 release tarball 流程，不能把 live checkout 当作 installed artifact：

```bash
git clone --branch <release-tag> https://github.com/qhy991/dsh-personal-plugins.git
cd dsh-personal-plugins
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --force
dsh plugin --profile web add "file:$PWD/bundles/kersor-web"
```

发布者在测试通过后创建并推送不可变 tag（将 `<release-tag>` 替换为本次版本）：

```bash
git tag <release-tag>
git push origin main
git push origin <release-tag>
```

公开 CI 只验证该 tag 自带的镜像清单、构建产物、安装器、桥接器、可移植性和无凭据合同，不读取发布者的私有 DSH fork。需要 DSH monorepo 的 Host／Client Vitest 集成套件属于镜像生成前的本地发布门；其结果不能由公开仓库在没有私有源码权限时重新生成。

使用者应锁定 tag 或 commit；Git package 和本地 package 的安装代码运行在 agent 沙箱之外，只应安装可信源码。升级时先 `git pull` 或切换到新 tag，再按上文执行精确 remove／add 和 Web Host 重启。

若需要 `dsh plugin --profile web add @scope/package` 的单行安装体验，下一步应把 launcher、Host viewer、Client viewer 和 bundle 分别发布到有权限的 npm scope，并把 bundle 中的 `file:` 依赖改成相同 release family 的 semver 依赖。在完成重命名、依赖改写和四包发布之前，不应宣称当前 GitHub 根目录支持 `github:owner/repo` 直接安装。

若 DSH 使用非默认位置：

```bash
python3 scripts/install.py \
  --dsh-home /path/to/.dsh \
  --standard-preset /path/to/standard/agent.cordis.yml \
  --kersor-root /path/to/KerSor
```

## 如何选择运行方式

| 任务 | 建议入口 | 权威状态／证据 |
|---|---|---|
| GPU kernel 或带 benchmark 的本地优化 | 顶层 `kersor_start` → continuable DSH controller → `runtime=dsh` optimize | 父 Experiment 绑定、Session v2、Attempt Result、实测 benchmark |
| 通用本地任务的固定验证循环 | KerSor preset → Host `kersor_evolve` → `runtime=dsh` → DSH `spawn` child；显式外部 Codex 请求保留 bridge | 固定 DSH route／usage receipt、Core artifact transaction、`output.json` 与 verifier evidence |
| 自主 Workflow / Mission（只读或单文件事务） | KerSor preset → Host `kersor_evolve` → `runtime=dsh` → DSH `spawn` child | 固定 `deepseek-official/kimi-k2.7-code` route receipt、durable usage／terminal evidence、Core transaction／Host gate、`result.json` |
| 超出 DSH 单文件 Mission 事务边界的自主 Workflow / Mission | KerSor preset → Host `kersor_evolve` → 外部 Codex／Claude-compatible worker | `result.json`、artifact receipts、独立 verifier |
| 固定 HF 模型到 ApxInf 部署 | `kersor` adapter → KerSor `deploy-hf-model-to-apxinf` skill → 有限 dsh Mission 注册 | Host model／deployment gates、`result.json`、独立 verifier |
| 状态、恢复、诊断 | child 调用 `kersor_status`；父对话用 `kersor_resume` 恢复同一 child | 当前磁盘 Session + 原 DSH child，不依赖聊天记忆 |

`kersor-task-v1` 的 `native_subagents: 1..4` 在 DSH route 上创建有界 adviser
树：每轮仍只有一个可写 primary Worker，但它会先启动指定数量的前台只读
adviser。adviser 只能读取公开 workspace，不能写入、继续委派或后台遗留；
KerSor preset 在 DSH 原生 `tool-subagent` 配置处关闭后台能力，因此模型侧 schema
只保留 `description` 与 `prompt`，前台结算只有这一条权威路径；
若 Guard 已用持久化 error result 证明越界写入从未执行，该次调用只作为普通工具
错误留在对话中，不再回滚 Agent 随后对声明 artifact 作出的合法修改；缺失或伪造
拒绝证据仍会 fail closed。
所有 Agent 的 provider attempts 共用同一个 activation ledger，成功 receipt
必须列出精确的 requested/spawned/completed 数量与 adviser Session ids。Host
verifier 与事务边界不因多 Agent 而放宽；若调用方显式声明 token budget，整棵
adviser 树继续共享同一个有限预算。

不要把 CUDA Workflow 硬套到 Python、VLIW、Verilog 或普通工程任务。任务类型不匹配时，稳定 `optimize` 路径应先确定性拒绝不兼容的已发布 Workflow，再通过有界 workflow authoring 创作 task-native Proposal；workflow evolution 只属于显式 research runner。任务自己的测试命令始终是唯一验收门。

自定义模拟器任务的推荐入口：

```text
compose optimize --path <task-dir> \
  --integration-pattern custom_simulator \
  --allow-workflow-authoring --workflow-authoring-budget 1 \
  --fresh-session
```

`custom_simulator` 必须来自任务事实或用户明确合同，不能按 `.py` 后缀猜测。进入文件修改前，Session 应显示真实的 `language/backend/integration pattern`；无兼容 Workflow 时先显示 `STALLED`，直到 Phase 3.6 验证并重新 catalog 一个 Proposal。

在 DSH Workspace Write 中，Phase 3.6 的 Proposal 必须保存在 Session 内的 `workflow-authoring/proposals/`，Catalog 也从同一 store 生成；不要要求写 KerSor checkout。`author-context.json.dispatch` 是唯一 subagent envelope，必须原样传入而不是由 parent 重写 metadata 模板；其中 `run_in_background:false` 会让工具阻塞到作者完成。不要用 `list_agents` 轮询，也不要检查或写 staging 进度。author 返回后的第一步是把三个文件封存在 `author-handoff.json`；save 必须携带该 seal，任何 parent 修补都会因 hash 不匹配而被拒绝。结构校验通过后仍要做语义安全审查：Workflow 只能返回候选或评测 Session-local 副本，不能在证明正确且更快之前覆盖规范 checkpoint。任务的 tests、reference、problem 与 benchmark harness 都是不可改写的 oracle。

“从头开始”还必须使用 `--fresh-session` 与全新 worktree；只有任务工作区没有 `.kersor` 历史时，外置空 `KERSOR_SESSION_ROOT` 才是有效替代。setup 会同时检查存储根和任务工作区，关闭 retrieval、experience、transfer 与 seed analysis，并拒绝先前或 partial Session。基线也必须由当前 Session 亲自见证：已经知道 task-native 命令时，Session 创建后先用 `baseline-witness.py init` 原子创建 `test-method.md`，再运行 `record` 与 `verify` 校验命令、Session config 与 kernel hash；不要手写最小 Markdown，也不要用代码 span 包住命令。创建 Session 前跑出的数字或复制进 Markdown 的历史数值不算证据。baseline 后必须通过 `profile-handoff.py context` 调用唯一的前台 kernel-profiler；parent 返回后的第一动作以 child Session id seal 精确 profile 字节，selection 与 authoring 都会重新 verify，非空但无 provenance 的文件也会失败。dispatch 前还要用 `prepare-dsh-workflow.mjs` 生成 `dsh-workflow.json` 与 `dsh-compatibility.json`，通过后用 `candidate-ownership.py seal` 锁定规范 kernel、tests、problem、既有 diff 与非 Session 文件。只以 `meta/script/args` 调用一次 DSH Workflow，返回后的第一步必须执行 ownership `verify`；子 Agent 只能返回源码或分析，由 host 在 Session 内落盘和评测。任一门禁或 Workflow 调用失败时，不得由 parent 修补、重试或直接接管优化，必须把 Session 转成 `stalled`。与 Chat、Trajectory 并列的 KerSor view 会分别显示“从零隔离”“基线见证”“Profile 证据／来源”“DSH 兼容”和“候选所有权”徽标，并在 baseline 未完成时显示 `init`、`record + verify` 或“新建 Session”下一步及规范失败原因，因此执行边界无需翻文件即可确认。

验证 setup 合同时不要直接解析 `session-config.json` 的内部层级。使用
`bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get <field>` 读取稳定投影；
fresh task-native 路径应依次确认 `fresh_session_required`、
`baseline_witness_required`、`candidate_ownership_required` 为 `true`，integration pattern
与任务合同一致，retrieval／experience／transfer／KernelWiki experience export 四个 mode
为 `off`。raw JSON 形状不是 DSH 调用合同。

Session 启动同样只有一个入口：
`bash "$kersor_root/scripts/setup-session.sh" "$TASK_DIR" ...`。`commands/`
存放 Markdown 协议，不是可执行脚本目录；任务路径必须作为第一个位置参数，setup 非零
退出时不得猜测备用路径。

Phase 2 的 `kernel-profile.md` 是 selection／authoring 的 Session 自有证据，不是可选
说明文字。fresh Session 先生成唯一 `profile-handoff/context.json`，把其中 envelope 原样
交给一个前台 kernel-profiler subagent，再以返回的 child Session id 创建 exclusive seal。
parent 代写、字段不规范、integration pattern 漂移或 seal 后修改都会 fail closed；侧栏的
“Profile 证据”与“Profile 来源”徽标会同时显示结果和 owner，失败时直接显示 blocker。

## 在 DSH 中使用

在 DSH 中新建 task 并选择 `KerSor` preset。遇到 kernel 优化、通用本地任务演化、KerSor 状态或恢复请求时，加载 `kersor` skill。skill 会读取 KerSor checkout 中当前的 `AGENTS.md` 与 command protocol；KerSor 仓库仍是行为和参数的唯一权威来源。

已经冻结合同的通用任务不需要先请求模型决定是否启动。在 composer 直接输入 `/kersor-evolve {"contract":"/absolute/path/to/task.json","runtime":"dsh"}`；DSH human-command plane 会在同一 Session 记录 `command/run` 与 `command/done`，并直接进入相同的 Host launcher。模型可见的 `kersor_evolve` tool 继续服务于自然语言任务先由 agent 冻结合同时的兼容路径。两条入口共享验证、RPC、预算与唯一 Session claim，不形成第二个执行实现。

通用任务与优化控制面是两条独立路径。自然语言通用请求由 agent 先只读分析工作区，再把最小权限、Completion 和既有确定性 verifier 冻结到工作区内的 `kersor-task-v1` 或 `kersor-mission-v1`。固定 Task 和 Mission 的 DSH-native 路径都由 Host 侧 `kersor_evolve` 接管；只有用户明确要求外部 Codex Task 时才保留 workspace-confined bridge 与外层写权限证明。`kersor_evolve` 必须是该回合第一且唯一执行动作；它从安装目录冻结 Python 和 bridge、以前台进程处理取消和有界输出，只接受当前顶层 DSH 工作区内的绝对合同路径，或固定 Task 的规范同级 `task.json`，并只返回唯一 JSON terminal。DSH 的每次 activation 和 Host evaluator 分别拥有自己的有界超时；canonical DSH activation 的默认值与上限均为 3600 秒（60 分钟），Host evaluator 仍保持独立的最多 120 秒上限。外层进程不再叠加一个会在后续 round 中误杀正常 Core 工作流的静态短 watchdog。一次有效调用会接管本回合：同一回合中模型已提交的后续工具也由单调 guard 在执行前拒绝；非取消异常被投影为 `status=failed` 业务终态并结束回合，不能由模型改写合同后重试。DSH 的 `turn/end=completed` 只表示该模型回合已结束；只有 `kersor_evolve` 的 Host-owned status 与 Core 终态证据均为 `completed` 时才算成功。DSH Host 还会从受信 Core activation 的规范 phase 推导 `planner`／`worker` 角色，拒绝调用方自报角色，避免成本与轨迹统计错标。外壳启动会 fail closed，避免继承调用 agent 的嵌套 Seatbelt；安装记录的 KerSor core 也必须物理位于工作区外，Host tool 与 bridge 会分别复核。安装器会把当时可信的 Bash／Python／Node／jq 以及 Codex／Claude 可执行文件绝对路径、可选的 Codex auth home 路径写入 preset 私有清单（不复制凭据）；generic bridge 仍会完整校验安装记录 checkout、合同 hash、runtime config、Session 身份与权限。材料化器可以把匹配的可信 runtime config 复制到任务目录，但 bridge 只接受与对应安装配置逐字节相同、常规、单链接且 inode 独立的副本，并在 launch 时再次绑定预期 SHA-256。

Fixed Task 正常终态会由 Core 在 run 内保存不可变 `candidate-snapshot/`。Suite reset 后，新 Session 可在 slash-command JSON 或 tool args 中增加 `"predecessor_run":"/absolute/workspace/.kersor/<run>"`，创建 fresh successor；Host 会验证旧 Task、output、manifest 与 blob 后恢复候选，旧 run 保持只读。`resume:true` 仍只恢复同一个中断 run，不能与 `predecessor_run` 同时使用。

仅固定 Task 的 Codex shell 路径会用唯一、必清理的 `O_EXCL` 文件证明 workspace 可写且 HOME 根不可写，并在证明与安装记录一致时发布 `KERSOR_CODEX_OUTER_SANDBOX=workspace-write`。Host 的 DSH-native Task 与 Mission 路径都不发布该 marker，也不依赖外层证明；其每个不可信 agent 与 evaluator 都必须由 core 的 canonical config 和 Host 在每次 activation 建立匹配路由的隔离边界。Host 与 core 子进程环境都从空 allowlist 构造，只发布冻结的 HOME／TMP／PATH 与必要 KerSor 路由；不会继承 AWS、GitHub、SSH、OpenAI 或其他 ambient token。Codex 可使用冻结 HOME 中的本地 CLI 登录；Claude-compatible 路径可由安装时冻结的 wrapper 自行从 Host-owned 凭据存储加载路由与密钥。安装器还能冻结该路径的模型 ID，bridge 会把它作为 `KERSOR_CLAUDE_MODEL` 传给 core。canonical broker 仍精确要求 `filesystem_sandbox=required` 与 preflight。

Host evaluator 必须使用 `command-v1` 的 `filesystem_policy: "read-only"`、`network_policy: "denied"`、`output_policy: "sealed"`，可选 timeout 必须在 `(0,120]`，可选输出上限必须在 `[1,4194304]`，且不得 `materialize`。安全的 standalone evaluator 由 Core 直接执行；若 agent capability 通过 `candidate_verifier` 引用 evaluator，该 evaluator 才额外要求不可重试、精确的 Host-owned 输出以及与候选事务逐字段绑定的 gate，多个候选 capability 可以共享同一个 evaluator。fact projection 也只能读取 `passed`、`exit_code`、`timed_out` 或 `artifact_set_sha256`，不能投影 stdout／stderr／解析输出。其 argv 与所有后代进程会进入 fail-closed 的真实只读文件系统边界。外部 `runtime=codex|claude` 继续使用这些规则；Claude-compatible 路径只接受 KerSor canonical `config/runtime-claude-autonomous.json`，并依据 capability/transaction artifacts 在精确只读工具集与精确 mutation 工具集之间切换。

DSH-native Mission 接受 `side_effect=none|read`，也接受由 Mission authority 准入、Core 活事务绑定的单文件 `side_effect=write` capability。Planner 与只读 worker 只看见 `read/glob/grep`；事务 Execute worker 才额外获得只指向声明 artifact 的 `edit/write`。路径别名、链接、控制树、Bash、delegation、Workflow 与递归 KerSor 都被拒绝，candidate verifier 仍由 Core 在活快照内执行并决定提交或回滚。`kersor-dsh-host-rpc-v3` 允许省略 `activation_budget`：Host 仍在 registration-bound `llm/prepared-stream` seam 绑定模型 route 并记录 usage，但 usage 缺失或不完整只作为证据，不会否决 completed output。若调用方显式声明正数预算，v3 继续按 actual dispatch context window 为 main request、retry、自动 title 与 compaction 预留，并保留原有 upper-bound charge 与 typed exhaustion 语义。Route／context integrity、Typed `DSH_CHILD_QUOTA` 与 denied mutation 的严格门禁不变。每个顶层 DSH session 仍只能调用一次 `kersor_evolve`。

显式有限预算下，DSH adapter registration 是 dispatch context window 的唯一 owner，经 nonce 认证的 personal Host 是预算计量 TCB；Core 不复制或重新推导 registration context。V3 receipt 的 `metered_attempt_tokens` 与 `unmetered_reservation_tokens` 是 Host attestation，Core 校验其 charge、coverage 与 activation cap。预算省略时不生成该 attestation，usage completeness 仅作观测；denied mutation 仍由 durable tool-result 与事务边界独立判定。

同步 guard 拒绝首个 `edit`／`write` 时，即使 child 随后报告 completed，Host 也只在同一
step 找到唯一 durable failed `tool/result` 后生成不含路径的
`DSH_MUTATION_PERMISSION_DENIED`，清空 child output，再由 Core 回滚 transaction；固定
Task 最多获得一次 bounded corrective round。被拒的 read/search，以及已允许 edit 的
普通工具失败，仍只是同轮反馈，不触发该终态。

Child execution event 的 `seq` 必须从 0 连续，fresh `turn=1` 的 step 从 1 逐一闭合，并由唯一 `turn/end` 关闭执行；清理期间只有 `session/title` metadata 可以跟在 terminal 后面，任何新的 assistant／tool／step／turn 事件仍使证据失效。Quota 终末 step 不允许 retry、output、tool 或 usage；近似 code/status、坐标漂移、failure 不匹配、result output 不一致或任一先前 step 未完整计量，都会降级为普通 incomplete `DSH_CHILD_TERMINAL_ERROR`。一般非配额 usage 只有在 lifecycle 与 prepared-stream ledger 一致时才完整；child deadline 使用 typed `DSH_CHILD_TIMEOUT`，`blocked`／`aborted`／`interrupted` 分别投影为 `refusal`／`aborted`／`error`。

推荐提示词至少包含：

```text
目标：<可测量结果>
基线：<命令与数值>
权威验证：<确定性命令>
不可变约束：<禁止修改的文件/接口/数据>
组织要求：<主 agent、只读顾问、唯一集成者、并行边界>
停止条件：<成功门槛、预算、可复现 NO-GO>
```

`kersor_status` 工具只读取当前 DSH task 的工作区，调用时使用空参数 `{}`，不要传 KerSor checkout 或其他路径。它展示阶段、当前轮次、workflow、最佳实测 speedup、目标、fit confidence、`language/backend`、integration pattern、authoring gate／预算、从零隔离、基线见证及其下一步／阻塞原因、Profile 证据／owner、DSH 兼容性、候选所有权和最近决策，并使用 DSH 原生可回放卡片呈现。对于 generic Mission，它会用最新且唯一、经 Core verifier 接受的 `autonomous-runs` 终态投影 `completed`／`stalled`／`resumable`，同时单独保留冻结的 canonical Session phase；它不会为了显示终态改写 `state.json`，无法证明的链接、歧义或畸形证据会被排除。单一工作区入口同时消除了路径猜测和 host-side bridge 越界面。

Profile 只有在 KerSor 的权威 `profile-handoff.py verify` 通过且 seal 记录可归属的 DSH child Session id 时才显示 `pass`；缺失 id 以及 `none`、`null`、`unknown` 这类占位值均为失败证据。规范 phase 一旦为 `complete`、`stalled` 或 `cancelled`，残留的 profile、authoring staging 或 dispatch 标记不会再把任何步骤投影为 active，也不会把 Session 标成可继续或活跃。

Web 侧栏同时显示最近 20 个经典／Session-v2 优化会话摘要，以及 autonomous run 的实时进度。它自动读取 DSH 已登记工作区，并扫描各工作区的 `.kersor/` 与 `.kersor-autonomous/`，无需为当前项目重复配置路径；额外的集中式 Session 根仍可通过 viewer `roots` 配置。Session 卡会直接显示 `language/backend`、integration pattern、fresh／baseline／DSH compatibility／candidate ownership gates、selector 结果与 workflow authoring 预算；展开卡片可查看 artifact 派生的阶段时间线、authoring／seal／save、Proposal validation、dispatch／measurement，以及密封后的 metadata、文件 hash、rationale 和 `workflow.js`。seal 前或 hash 不匹配时不暴露 staging 内容。经典状态由 KerSor 自己的 `SessionStore`／`AttemptResultStore` 解析，并把规范 phase 与建议性 health 分开。Host 用一个原子 `snapshot` 同时发布 Session、run 清单和结构化来源健康，后续只在状态变化时推送替换事件；选中 run 才读取 `runBacklog`，展开经典 Session 才读取 `classicSessionDetail`。`waiting` 按本次 invocation 的终态处理；断连后重读同一 snapshot 路径恢复。viewer 优先使用 `KERSOR_ROOT`，否则复用 preset 的 `.local/kersor-root`。

环境变量 `KERSOR_ROOT` 可以临时覆盖 status／compose 等经典入口所用的 checkout；安全敏感的 generic `evolve` 路径始终只使用安装时记录值，若要切换必须重新安装 preset：

```bash
KERSOR_ROOT=/another/KerSor dsh
```

## 真实案例：VLIW Take-Home 从零优化

[`docs/vliw-takehome-from-scratch.md`](docs/vliw-takehome-from-scratch.md) 给出完整案例：从 Anthropic 官方 `origin/main` 的 147734-cycle starter 创建隔离 worktree，在 DSH 中选择 KerSor preset，禁止读取任何既有优化解，组织架构分析、hazard 审计、向量化／调度和独立验证角色，依次冲击 `<18532` 与 `<2164`。

这个案例同时验证五条链路：skill 发现、goal 持久化、subagent/Workflow 组织、权威 benchmark 守门、KerSor 状态与可视化。每轮实验总结收录在 [`docs/experiments/`](docs/experiments/README.md)。

若要使用当前 DSH 原生对话控制器，并观察“每轮新候选、按需创作新 Workflow、Host-measured 门禁、Round tree 与增量／全链路 speedup”，参见[自主 Workflow 完整案例](docs/use-cases/kersor-autonomous-workflow.zh.md)（[English](docs/use-cases/kersor-autonomous-workflow.md)）。

## 故障排查

### `skill "kersor" is unknown or no longer available`

先确认新会话顶部显示的是 **KerSor**，而不是“标准模式”：preset-local skill 只注入选择了 KerSor preset 的新会话；在标准模式中直接要求加载 `kersor` 会得到该错误。若已经选对模式，旧安装可能把 skill 复制到 preset 内却没有把 preset-local `skills/` 加入 `skill-filesystem.customSkillDirs`。更新仓库后重新运行安装器并重启 DSH Web：

```bash
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --force
```

重新新建会话并先切到 KerSor preset；初始 skill catalog 应包含 `kersor`。若仍失败，检查生成的 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/agent.cordis.yml` 是否把同目录下的 `skills` 写入 `customSkillDirs`。

### Web 侧栏仍是旧版本

本地 `file:` 依赖可能被 pnpm 作为旧目录快照复用。执行精确移除／重装流程，然后重启 Web Host；只执行 `add --force` 不足以证明文件已刷新。

### `kersor_status` 返回 `additionalProperties: false`

这表示 bridge 的结构化输出与 preset 中工具 schema 版本不一致。更新本仓库，重新安装 preset 并重启 DSH Web；不要让 agent 绕过状态门继续修改：

```bash
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --force
```

仓库回归测试会精确比较 status 输出、schema properties 和 required keys，避免新增字段再次只在直接渲染测试中通过、却被 DSH 工具边界拒绝。

## 验证

```bash
python3 scripts/build.py --dsh-root /absolute/path/to/deepseek-harness
python3 scripts/check.py
```

`build.py` 在临时目录中复原 DSH monorepo 布局，借用指定 checkout 的固定 TypeScript 依赖重建 host reflection 与 browser bundle，但不修改任一工作树。它会在构建前后核对 schema-v2 mirror、Authority commit、中央 build receipt 与 74 个派生产物；更新镜像必须显式运行 `scripts/sync_plugins.py sync --harness <checkout> --write`，临时构建本身不会回写 receipt-owned `lib`。`check.py` 覆盖 metadata、preset-local skill 发现配置、安装器渲染与幂等性、强制更新备份、built plugin 合同，以及仓库中意外出现的机器绝对路径。

## 目录

```text
bundles/kersor-web/         # Web profile 的只读 viewer + UI 组合层
plugins/kersor/             # DSH 原生对话控制器 + 可选有限 Mission 启动器
plugins/kersor-viewer/      # Session 摘要、run 发现、tail、fold 与 snapshot remotes
plugins/ui-kersor-viewer/   # 优化会话、执行图与候选选择的 KerSor view（Client）
presets/kersor/
  preset.yml                 # DSH picker metadata
  skills/kersor/SKILL.md     # 只负责路由到 KerSor 的轻量适配层
  bin/kersor_bridge.py       # checkout 定位、doctor、compose 入口
  plugins/kersor-status.mjs  # 工作区受限的结构化状态工具与原生卡片
scripts/install.py           # 从当前 standard preset 生成并安装
scripts/build.py             # 在临时 DSH 布局中可复现地重建插件产物
scripts/check.py             # 零依赖本地/CI 验证
tests/                       # 安装合同回归测试
docs/experiments/            # 每轮真实任务实验的假设、证据、结论与下一步
docs/vliw-takehome-from-scratch.md
                             # VLIW 比赛从零评测教程与反作弊边界
```
