# KerSor 自主 Workflow：从对话启动并按轮演化

[English](kersor-autonomous-workflow.md) | 中文

这个案例说明如何让 KerSor 在 **DSH 对话内部**完成一次有界优化实验，并在 Web 中观察每轮 Workflow、候选、Host 验证、最佳结果和停止原因。案例数据来自两次验收运行：Fresh27 先把 VLIW 模拟器从 `147734` 降到 `14415 cycles`，Fresh29 再以 `14415` 为新 Session 基线，演示按需创作新 Workflow。

Fresh27、Fresh29 是验收运行的标签，不是特殊命令或固定配置；实际使用时，页面会显示你自己的 Experiment 和 Session 标识。

这里的“自主”有一个重要边界：KerSor **每轮自主生成一个新候选**，但不会每轮都发明一个新 Workflow。Workflow 是可复用的策略和 agent 拓扑；只有现有 Workflow 被耗尽、Router 没有可用替代方案且 authoring 仍有预算时，KerSor 才创作、密封、验证并重新选择一个新 Workflow。

## 1. 一轮实验如何运行

```text
DSH Chat
└── KerSor Experiment（绑定一个可续接的 DSH controller child）
    ├── Setup / Baseline witness / Profile
    └── Round N
        ├── Router：过滤并选择已有 Workflow
        ├── Workflow：读取当前 best 与上一轮实测反馈
        ├── Candidate：生成本轮唯一候选
        ├── Host：先验证 correctness，再运行 benchmark
        ├── Decision：晋升 best、继续或终止
        └── 若路由耗尽：Author → Seal → Validate → Catalog → Reselect
```

职责边界如下：

| 层 | 可以自主决定 | 不能自行宣称 |
|---|---|---|
| Router / selector | 从兼容 Workflow 中选择下一策略 | 绕过 backend、language 或 integration-pattern 约束 |
| Workflow | 分析当前 seed、吸收 transfer evidence、生成候选 | 把静态估算当作实测结果 |
| Workflow author | 在 routing gap 时设计新的 Proposal | 绕过 seal、schema、wire、安全和 provenance 校验 |
| Host reviewer | 运行冻结的 correctness 与 benchmark 命令 | 接受未通过 correctness 的性能数字 |
| Session synthesizer | 根据目标、预算和实测历史决定继续或停止 | 改写冻结的目标、命令或预算 |

整个标准优化路径固定使用 DSH 原生 controller 和 DSH Workflow workers，不需要 Claude Code 或 Codex 作为外部执行器。

## 2. 准备与启动 Web

先按照仓库根目录的[安装说明](../../README.md#五分钟上手)安装 KerSor preset 和 Web bundle。启动 Host 的 Python 必须是可执行文件的绝对路径：

```bash
export DSH_CHECKOUT=/absolute/path/to/deepseek-harness
export KERSOR_PYTHON=/absolute/path/to/python3
cd "$DSH_CHECKOUT"
pnpm dsh web --port 3179
```

然后打开 <http://127.0.0.1:3179/>。如果使用默认端口，可省略 `--port 3179`。

目标工作区必须已经包含任务代码和两条确定性命令：

- correctness 命令只判断候选是否正确；
- benchmark 命令输出唯一 headline metric；
- tests、reference、problem 和 benchmark harness 都属于不可改写的 oracle。

## 3. 从对话启动 Experiment

在 DSH 中添加目标工作区，新建 task，把顶部 preset 切换成 **KerSor**，再发送任务合同。下面是 Fresh29 风格的公开模板；发送前把 Python 占位路径换成实际绝对路径：

```text
请启动一个新的 KerSor 优化实验，由 DSH 完成全部 controller、Workflow 和验证工作。

目标：在保持完全正确的前提下，把当前 14415-cycle VLIW kernel 至少再优化 1.2x。
基线：14415 cycles；这是本次 Session 的增量基线。
不可变约束：不得修改 tests/、problem.py、reference、模拟器常量或 benchmark harness。
停止条件：达到 1.2x，或执行满 6 轮；允许最多创作 3 个 Workflow Proposal。

请加载 kersor skill，并通过 kersor_start 使用以下冻结合同：
- backend=python
- language=python_reference
- integration_pattern=custom_simulator
- target_speedup=1.2
- max_workflows=6
- mode=explore
- workflow_authoring_budget=3
- retrieval_mode=off
- experience_mode=off
- transfer_mode=off
- kernelwiki_experience_export_mode=off
- correctness_command=/absolute/path/to/python3 tests/submission_tests.py CorrectnessTests.test_kernel_correctness
- benchmark_command=/absolute/path/to/python3 tests/submission_tests.py SpeedTests.test_kernel_speedup

启动成功后由 controller child 独立推进；父对话不要轮询、代写候选或直接接管优化。
```

用户不需要手工调用 shell 版 `compose optimize`。顶层 agent 会把合同传给 `kersor_start`；成功后，Experiment 卡会立即出现在当前对话中，controller 的完整工作发生在绑定的 DSH child 中。

若要从官方 `147734-cycle` starter 开始，可把基线和目标分别改为 `147734` 与 `8.0x`。Fresh27 使用这一路径完成后，将 Host 接受的 `14415-cycle` best 作为下一次 fresh Experiment 的显式 seed，即可进入上面的 Fresh29 阶段。

## 4. 在网页中观察什么

### Chat

当前对话中的 KerSor Experiment 卡是这次实验的主入口，应显示：

- canonical phase、当前轮次与总预算；
- 当前 Workflow、Host-measured best 和目标；
- 九个协议阶段及下一动作；
- “查看 DSH 执行对话”入口，用于打开原 controller child 的完整对话。

关闭网页或切换 task 不会停止 controller。Host 重启后，在原父对话请求继续，顶层 agent 会通过 `kersor_resume` 恢复同一个 child。

### KerSor view

与 Chat、Trajectory 并列的 **KerSor** 标签提供跨工作区总览。选择当前 Experiment 后，Round tree 应按因果顺序展示：

```text
Fresh29 · STALLED · 6/6 · best 13358 cycles
├── Baseline / Profile
├── R1 · vliw-bundling · PASS · 13358 · promoted
├── R2 · vliw-bundling · PASS · 13903 · retained R1
├── R3 · vliw-bundling · PASS · 13876 · retained R1
├── R4 · vliw-bundling · PASS · 13392 · workflow exhausted
├── R5 · Author level-aware-gather
│   ├── routing gap → seal → validate → catalog → reselect
│   └── candidate correctness FAIL · estimate excluded
├── R6 · level-aware-gather repair · correctness FAIL · estimate excluded
└── Stop · execution budget exhausted · incumbent retained
```

展示规则应始终保持以下语义：

- **Measured**：只有 Host correctness PASS 后运行 benchmark 得到的值；
- **Promoted**：measured candidate 同时快于 incumbent，才更新 best；
- **Estimated / reported**：Workflow 的预测或未验证输出，只用于诊断；
- **Correctness failed**：不运行或不接受 benchmark，不能贡献 best；
- **Workflow authored**：显示触发它的 routing gap、Proposal seal/validation 和重新选择链路。

选择一个 Experiment 时，其 Round tree 与 Workflow execution tree 应同步定位到同一 Session，避免把当前 Session 卡与另一个旧 run 的对话混在一起。

## 5. Fresh27 / Fresh29 的验收结果

Fresh27 验证了第一段优化及 Host 门禁：

| Round | Workflow | Host 结果 | 处理 |
|---:|---|---|---|
| 1 | `vliw-bundling-kernel-optimization` | correctness FAIL | 性能字段不计入 measured best |
| 2 | `vliw-bundling-kernel-optimization` | PASS，`147734 → 14415` | `10.2486x`，晋升并达到 `8.0x` 目标 |

Fresh29 验证了多轮候选和 authoring escape：

| Round | Workflow | Host 结果 | Session 决策 |
|---:|---|---|---|
| 1 | `vliw-bundling-kernel-optimization` | PASS，`13358 cycles`，`1.0791x` | 晋升为 best |
| 2 | 同一 Workflow，新候选 | PASS，`13903`，`1.0368x` | 保留 R1 |
| 3 | 同一 Workflow，新候选 | PASS，`13876`，`1.0388x` | 保留 R1 |
| 4 | 同一 Workflow，新候选 | PASS，`13392`，`1.0764x` | 保留 R1，旧 Workflow 耗尽 |
| 5 | 自动创作的 `level-aware-gather-kernel-optimization` | correctness FAIL | `1.076x` 估算值排除 |
| 6 | 同一新 Workflow 的修复候选 | correctness FAIL | 估算值排除；6/6 预算耗尽 |

Fresh29 最终 `STALLED` 的含义是“目标未达且执行预算耗尽”，不是基础设施故障。正确的 incumbent `13358 cycles` 被保留，两个错误候选没有污染最佳值。

## 6. 正确理解两种 speedup

Fresh27 和 Fresh29 使用了不同 Session baseline，因此页面必须同时说明口径：

```text
Fresh29 incremental speedup = 14415 / 13358 = 1.0791x
Overall lineage speedup     = 147734 / 13358 = 11.0596x
```

`1.0791x` 回答“Fresh29 自己又优化了多少”；`11.0596x` 回答“从最初 starter 到当前 best 总共优化了多少”。不能直接比较不同 Session 卡上的 speedup，也不能把 Workflow 输出的 `estimated_speedup` 当作任一口径的实测结果。

## 7. 继续已经结束的实验

- controller 仍为 active、只是网页或 Host 中断：回到原父对话请求继续，使用 `kersor_resume` 恢复同一 child；
- Session 已为 `complete`、`stalled` 或 `cancelled`：原绑定已经终止，不能静默增加预算或重复 dispatch；
- 需要继续探索时：先解释终止原因，以已验证 best 为新 seed，冻结新目标和新预算，再从对话启动一个新的 Experiment。新的 Session 保留清晰的 baseline 和 lineage，不篡改旧实验结论。

磁盘中的权威证据位于：

```text
<workspace>/.kersor/<session>/state.json
<workspace>/.kersor/<session>/round-N-summary.md
<workspace>/.kersor/<session>/run-N/host-verification.json
<workspace>/.kersor/<session>/workflow-authoring/proposals/<workflow>/validation.json
```

Chat 卡和 KerSor view 都是这些 canonical artifacts 的投影；若 UI 与磁盘证据冲突，应先把 UI 标记为不可采信并修复投影，而不是改写实验记录。
