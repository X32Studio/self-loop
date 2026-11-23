# R-0003-judge

phase: v1
role: judge
agent: t3 gpt-6.2-astra
view: records@06de129aa1b9f3e3a1d8eb2f69dd33ca9b6071ae
briefs: engines/shared.md, engines/judge.md
product: 378cbf90c1f548f4342093b5b2daaa9b0c58345e
audit: 0 violations, 0 denied, 24 flags (sealed/judge/0003/judge-1-audit.json)

## Public report (verbatim, out/public.md)

# R-0003-judge · CONTINUE

候选 `378cbf90c1f548f4342093b5b2daaa9b0c58345e` 的全套 275 项通过。F-0003 的 VERSION tip 关轮验收仍失败。

| 阻塞项 | 裁决 |
|---|---|
| tip-ci-evidence:R1-5 | **关闭。** 关轮已绑定配置的实际推送仓、tip SHA 和全部必需检查。合法的非默认发布 remote 能从 next 提示一路写到轨迹。 |
| tip-ci-evidence:R2-1 | **仍开放，BLOCKER。** 记录中已有更晚回执时，重跑排序正确。目的仓的必需检查已经重跑失败、尚无新回执时，已有命令仍能写入 CONVERGED/success，蓝图也能写入 done。新一次 next 的提示不能约束已发出的命令。 |

**实现方。** 保留共用的 CI 判定，在写入成功轨迹或新完成事件时核对目的仓当前对该 SHA 的全部必需检查。当前状态无法证绿时保留原记录，给出重新取证动作。next 在这种情况下也应只给出能恢复进度的建议。保留历史记录离线读取、旧格式回执重新取证和 CONTINUE 记录真实失败的能力。

**攻击方。** 给“远端结论已变、尚无新回执”的成功写入补正反例，验证轨迹与蓝图的实际落盘结果；保留重跑恢复、非默认 remote 和完整检查集的对照。RULE-05 应约束查询的目的仓、tip 与最终行，允许写入端再次读取同一个 tip。RULE-09 继续验证错 SHA 被拒。

依据为 D-0009、R-0002-judge 及本轮交接。无需所有者决定。
