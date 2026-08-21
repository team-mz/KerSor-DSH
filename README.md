# dsh-personal-plugins

统一管理个人 DSH 扩展。当前 KerSor 套件包含 agent preset、可加载 skill、工作区状态卡、只读 run viewer、与 Chat／Trajectory 并列的 KerSor view，以及可选的有限 Mission 启动器；不复制 DSH 上游源码，也不收集 `~/.dsh/settings.yaml`、sessions、storages 或任何凭据。

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
5. 用任务合同描述目标、基线、权威验证命令、禁止修改的文件和停止条件。Agent 应先加载 `kersor` skill，再由 skill 路由到当前 KerSor checkout 的协议。
6. 用 `kersor_status` 查看当前 Session；用会话标题下的 `KerSor` 标签查看优化会话、Workflow 执行图与候选选择。

## 为什么安装时生成 composition

`standard` preset 由 DSH 上游维护。仓库只拥有 KerSor 增量；`scripts/install.py` 每次从当前安装的 `standard/agent.cordis.yml` 生成用户侧 `kersor/agent.cordis.yml`。升级 DSH 后重新执行安装命令即可继承新版 standard，避免维护一份会漂移的副本。

## 安装或更新

需要 Python 3.10+、已安装的 DSH，以及一个 KerSor checkout：

```bash
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor
```

如果 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor` 已存在，先预览，再显式覆盖：

```bash
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --dry-run
python3 scripts/install.py --kersor-root /absolute/path/to/KerSor --force
```

覆盖前，安装器会把旧目录移动到同级时间戳备份。KerSor 的机器路径只写入已安装 preset 的 `.local/kersor-root`，不会进入 Git。

为 Web profile 安装 run viewer 与 KerSor conversation view（建议先安装上面的 preset，让两者共享同一份 checkout 指针）：

```bash
dsh plugin --profile web add "file:$PWD/bundles/kersor-web"
```

若 `dsh` 未加入 `PATH`，可在 DSH checkout 中用 `pnpm dsh plugin --profile web add ...` 执行同一操作，并把 `file:` 后的路径写成此仓库 bundle 的绝对路径。

该 bundle 会安装三个插件，但默认只挂载只读 viewer 与 UI。`@deepseek-ai/dsh-kersor` 启动器只有在 profile patch 中显式登记至少一个 `kersor-mission-v1` Mission 后才应挂载；配置合同见 [`plugins/kersor/README.zh.md`](plugins/kersor/README.zh.md)。

更新仓库后，先移除再重装这一精确 bundle，确保 pnpm 不复用旧的本地目录快照：

```bash
dsh plugin --profile web remove @qhy991/dsh-kersor-web
dsh plugin --profile web add "file:$PWD/bundles/kersor-web"
```

## 公开分发

本仓库当前是包含多个本地 package 的源码分发包，而不是可以从仓库根直接安装的单一 npm package。最可靠的公开安装方式是把 GitHub 仓库设为 public、发布一个不可变 tag，并让使用者 clone 后通过 `file:` 安装 bundle：

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
| GPU kernel 或带 benchmark 的本地优化 | `kersor` skill → `compose optimize` → 当前 `commands/optimize.md` | Session v2、Attempt Result、实测 benchmark |
| 通用本地任务的固定验证循环 | `kersor-task-v1` → `commands/evolve.md` | `output.json` 与 verifier evidence |
| 自主 Workflow / Mission | `kersor-mission-v1` → `commands/evolve.md` | `result.json`、artifact receipts、独立 verifier |
| 固定 HF 模型到 ApxInf 部署 | `kersor` adapter → KerSor `deploy-hf-model-to-apxinf` skill → 静态 Mission task | Host model/deployment gates、`result.json`、独立 verifier |
| 状态、恢复、诊断 | 先调用 `kersor_status`，再读取相应 command protocol | 当前磁盘 Session，不依赖聊天记忆 |

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

推荐提示词至少包含：

```text
目标：<可测量结果>
基线：<命令与数值>
权威验证：<确定性命令>
不可变约束：<禁止修改的文件/接口/数据>
组织要求：<主 agent、只读顾问、唯一集成者、并行边界>
停止条件：<成功门槛、预算、可复现 NO-GO>
```

`kersor_status` 工具只读取当前 DSH task 的工作区，调用时使用空参数 `{}`，不要传 KerSor checkout 或其他路径。它展示阶段、当前轮次、workflow、最佳实测 speedup、目标、fit confidence、`language/backend`、integration pattern、authoring gate／预算、从零隔离、基线见证及其下一步／阻塞原因、Profile 证据／owner、DSH 兼容性、候选所有权和最近决策，并使用 DSH 原生可回放卡片呈现。单一工作区入口同时消除了路径猜测和 host-side bridge 越界面。

Web 侧栏同时显示最近 20 个经典／Session-v2 优化会话摘要，以及 autonomous run 的实时进度。它自动读取 DSH 已登记工作区，并扫描各工作区的 `.kersor/`，无需为当前项目重复配置路径；额外的集中式 Session 根仍可通过 viewer `roots` 配置。Session 卡会直接显示 `language/backend`、integration pattern、fresh／baseline／DSH compatibility／candidate ownership gates、selector 结果与 workflow authoring 预算；展开卡片可查看 artifact 派生的阶段时间线、authoring／seal／save、Proposal validation、dispatch／measurement，以及密封后的 metadata、文件 hash、rationale 和 `workflow.js`。seal 前或 hash 不匹配时不暴露 staging 内容。经典状态由 KerSor 自己的 `SessionStore`／`AttemptResultStore` 解析，并把规范 phase 与建议性 health 分开。Host 用一个原子 `snapshot` 同时发布 Session、run 清单和结构化来源健康，后续只在状态变化时推送替换事件；选中 run 才读取 `runBacklog`，展开经典 Session 才读取 `classicSessionDetail`。`waiting` 按本次 invocation 的终态处理；断连后重读同一 snapshot 路径恢复。viewer 优先使用 `KERSOR_ROOT`，否则复用 preset 的 `.local/kersor-root`。

环境变量 `KERSOR_ROOT` 可以临时覆盖安装时记录的 checkout：

```bash
KERSOR_ROOT=/another/KerSor dsh
```

## 真实案例：VLIW Take-Home 从零优化

[`docs/vliw-takehome-from-scratch.md`](docs/vliw-takehome-from-scratch.md) 给出完整案例：从 Anthropic 官方 `origin/main` 的 147734-cycle starter 创建隔离 worktree，在 DSH 中选择 KerSor preset，禁止读取任何既有优化解，组织架构分析、hazard 审计、向量化／调度和独立验证角色，依次冲击 `<18532` 与 `<2164`。

这个案例同时验证五条链路：skill 发现、goal 持久化、subagent/Workflow 组织、权威 benchmark 守门、KerSor 状态与可视化。每轮实验总结收录在 [`docs/experiments/`](docs/experiments/README.md)。

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

`build.py` 在临时目录中复原 DSH monorepo 布局，借用指定 checkout 的固定 TypeScript 依赖重建 host reflection 与 browser bundle，但不修改 DSH 工作树。`check.py` 覆盖 metadata、preset-local skill 发现配置、安装器渲染与幂等性、强制更新备份、built plugin 合同，以及仓库中意外出现的机器绝对路径。

## 目录

```text
bundles/kersor-web/         # Web profile 的只读 viewer + UI 组合层
plugins/kersor/             # 可选有限 Mission 启动器（Host）
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
