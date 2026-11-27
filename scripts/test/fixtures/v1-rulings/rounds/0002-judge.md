# R-0002-judge

phase: v1
role: judge
agent: t3 gpt-5.4-pro
view: records@cb701ce69c7db606ba35fbc6d25bafb4bbce38aa
briefs: engines/shared.md, engines/judge.md
product: 1968e39419d8aff7a1cbaa7716d44a30fe6717ac
audit: 0 violations, 0 denied, 32 flags (sealed/judge/0002/judge-1-audit.json)

## Public report (verbatim, out/public.md)

# R-0002-judge · CONTINUE

F-0003 候选 `1968e39419d8aff7a1cbaa7716d44a30fe6717ac` 的完整套件为 261 项通过、1 项失败。公开 RULE-12 复现了错误关轮：上游仓的 CI 成功，就能给实际推往 fork 的同一提交写入 `CONVERGED/success`。更换验收种子后结果一致。

| 阻塞项 | 状态与依据 |
|---|---|
| stall-entry:R1-1 | 已关闭。默认 show 及 resume 不可用时，新会话都能只读展示其他产品仍有效的报警。 |
| registry-discovery:R1-2 | 已关闭。正常目录深度下的独立记录仓可发现，普通代码仓中跟踪的夹具保持安静。 |
| stall-independence:R1-3 | 已关闭。next 失败时，可判定的停滞仍被提交，近期活跃的对照只报 next 错误。 |
| product-isolation:R1-4 | 已关闭。坏账本得到自己的诊断，其余登记产品仍各有结果。 |
| acceptance-contract:R1-6 | 已关闭。TICK-01 至 05 已覆盖退出契约、新会话入口、不同产品与闲置期的报警身份，以及暂存修改的保全。 |
| **tip-ci-evidence:R1-5** | **仍开放。** 缺回执、红回执及错 SHA 已被拒绝。带 VERSION tip 的收敛行仍须证明实际推送目的仓的全部必需检查通过。 |
| **tip-ci-evidence:R2-1** | **新开。** 目的仓、SHA 和检查集相同，已得到的最新失败结论仍能被旧绿回执盖过。next 推荐和轨迹写入都须反映最新结论。 |

**实现方**应让 next 的关轮命令与 trajectory 的写入门禁共用一套 CI 判定。按配置的推送 remote、实际 push URL、tip SHA 和完整必需检查取证，沿用 CI 门禁对重跑的判定。证据不足时给出取证命令。保留历史行的可读性、合法绿色关轮及 CONTINUE 记录真实失败的能力。

**攻击方**应保留 RULE-12，并给上述两项性质各配绿、红对照。从用户入口核对推荐命令、追加结果和最终轨迹，覆盖非默认发布 remote 的合法关轮。

依据为 R-0001-judge、D-0009 及 D-0014。修后须在新的候选 SHA 上重判。本轮无需所有者决定。
