# R-0001-judge

phase: v1
role: judge
agent: t3 gpt-6.2-astra
view: records@129c7b54cac2d31a54c3ef7e07c7128c4a863892
briefs: engines/shared.md, engines/judge.md
product: b4ed5490ff28720817261673e2fb06b828d4b079
audit: 0 violations, 0 denied, 1 flags (sealed/judge/0001/judge-1-audit.json)

## Public report (verbatim, out/public.md)

# R-0001-judge · CONTINUE

F-0003 在候选 b4ed5490ff28720817261673e2fb06b828d4b079 上验收失败。全套 238 项，233 通过、5 失败。公开验收中，配置解析、发布版心跳路径和 VERSION 推送门禁均通过。并发心跳可以对同一闲置期只记一次报警，并保留用户的暂存修改。

| 阻塞项 | 需要恢复的性质 |
|---|---|
| stall-entry:R1-1 | 新 lead 从任一登记产品执行 `start`，都能看到其他产品仍然有效的已提交报警。默认 show、resume 不可用时均须兑现这一点。当前入口返回 64。 |
| registry-discovery:R1-2 | 配置根下的真实记录仓不能因正常的目录层级而被静默漏掉。 |
| stall-independence:R1-3 | 记录足以判定停滞时，即使无法算出下一步，心跳也要持久记录停滞，并报告计算下一步的错误。 |
| product-isolation:R1-4 | 一个产品的记录无法读取时，`stall --all` 仍须给出其余登记产品的结果。 |
| tip-ci-evidence:R1-5 | 在 VERSION 后续提交上记录已收敛，必须有该 tip 的绿色 CI 回执。实际入口接受缺回执的成功声明，也接受红色回执与 CONVERGED 同行。 |
| acceptance-contract:R1-6 | 公开门禁须按已定义的退出状态、发现项和报警身份判定，避免把正确结果判红，也避免在抵达真正的失败点前终止。 |

**实现方**

- 实现本轮承诺的 lead `start`。跨产品读取已提交且仍有效的报警。读取不追加报警。复用现有活动、阶段和报警身份判断。
- 让发现覆盖配置的目录范围，保留对普通代码仓内测试数据的区分。让停滞判定、下一步计算和每个产品的错误各自产生结果。
- 对使用 VERSION 例外的收敛记录，从 tip 的有效 CI 回执取得结论。同步修改 `next` 输出的关轮命令。保留旧轨迹和实际失败的诊断记录。

**攻击方**

- 修正公开 TICK-01 至 05 的共同前置断言。当前命令用 0 表示安静，2 表示有发现。TICK-01 核对活跃产品被计入且安静；TICK-02 保留发现范围；TICK-03、04 必须实际执行新进程的 `start`。
- TICK-05 用产品、阶段与闲置期识别报警。验证每个独立停滞都有一条记录，同一停滞重试时不会重复，已有的暂存修改保留下来。
- 给 R1-2 至 R1-5 增加用户入口回归用例。保留成功与失败对照。重跑完整套件后再交下一轮。

依据为 R-0001-reviewer-frame、I-0001、D-0009 和 F-0003。本轮无需所有者决定。
