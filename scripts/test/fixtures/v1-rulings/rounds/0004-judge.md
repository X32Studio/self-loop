# R-0004-judge

phase: v1
role: judge
agent: t3 gpt-5.4
view: records@b594c0e06db66776964ea68be6f18d17ffea7f92
briefs: engines/shared.md, engines/judge.md
product: b9073ee45ca07f58d37e3e0b05eb4e6374c39a3f
audit: 0 violations, 0 denied, 39 flags (sealed/judge/0004/judge-1-audit.json)

## Public report (verbatim, out/public.md)

# R-0004-judge · CONTINUE

候选 `b9073ee45ca07f58d37e3e0b05eb4e6374c39a3f`。本地全套 286/286，换种子的公开验收 44/44。F-0003 首轮范围仍有一个会产生错误收敛记录的阻塞。

| 项 | 判定 | 需要维持的性质 |
|---|---|---|
| tip-ci-evidence:R2-1 | CLOSED | 使用目标循环的配置时，带回执的成功追加和有循环配置的蓝图完成声明，都会在写入时核对目的仓和所引 SHA 的必需检查。重跑失败或无法读取时保留原账本。 |
| tip-ci-evidence:R1-5 | REOPENED · BLOCKER | 一条成功轨迹必须由**接收该行的循环**的目的仓和必需检查证明。显式配置与目标账本可以属于两个循环，当前写端只验证前者，结果可以在 CI 已失败的循环落下成功行。 |

**实现方。** 在权威轨迹写入端绑定记录仓、循环配置和 CI 范围。保留从外部目录提供等价配置及合法发布 remote 的行为。有冲突时应在写入前指出冲突。现有的远端读取和重跑排序可以继续复用。

**攻击方。** 通过公开 CLI 覆盖多循环配置与账本错配，检查接收账本的实际内容，再用身份一致的合法输入验证通过。保留同一目的仓上重跑失败、恢复与不可读的正反例。

**可后续处理。** 远端恢复后，`next` 有时会推荐一个写端根据现有记录必然拒绝的命令。拒绝消息给出的重新取证命令已经验证可恢复。让推荐端先检查候选回执是否满足写端的本地条件。无回执的同 SHA 收敛由 D-0014 第 1 项安排在 slice 3；CONTINUE 引用历史 CI 和无循环配置的蓝图离线证据均列为 SHELVED。

负责人可按既有决策继续。候选的远端 CI 在本会话中不可读，未取得双平台绿单。
