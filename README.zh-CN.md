<div align="center">

<img src="assets/social-preview.jpg" alt="self-loop — X32 Studio 面向 Coding Agent 的自治交付协议" width="100%" />

# self-loop

### 把混乱的 Agent 乌合之众，整编为可信赖、能直接交付的 Agent 组织——把注意力还给人，让你在街边喝咖啡时它们照常交付。

<p>
  <b>中文</b> · <a href="README.md">English</a> · <a href="docs/getting-started.md">Getting Started</a> · <a href="docs/METHODOLOGY.md">Methodology</a> · <a href="SKILL.md">Skill Spec</a>
</p>

<sub>作者：<a href="https://x32studio.com">X32 Studio</a> · MIT 协议 · v0.8.0</sub>

</div>

---

> **在 AI 时代，算力和 Agent 实例可以无限复制，人最宝贵、也最大的瓶颈是 Attention（注意力）。**
>
> 能否管控好自己的 Agent Swarm、把它们整编成真正可信赖的交付组织，直接决定了不同人的能力上限：
> - **没有 `self-loop`：** 一群缺乏治理的 Agent 只是混乱的**乌合之众**——自己给自己批作业、在错误前提上死打补丁、上下文腐败；你被迫全程盯盘、在混乱中疲于奔命直到精疲力尽。
> - **有了 `self-loop`：** 你可以直接坐在**街边喝咖啡**，让你的 Agent 组织（第一性帧评审 + 跨厂商 Critic / Actor / Judge 独立验收 + SSOT 权威文档门禁 + 前提审计硬门禁）自主推进并直接交付——只在真正需要人类战略拍板时，才把带推荐答案的选项打包交给你。

2026 年市面上的大多数 "agent loop"，本质上都是一个 `while true` 外壳：让模型改代码、跑单测、把报错塞回上下文，直到返回 0。

在玩具任务上这能跑通；但在真实工程里，缺乏组织治理的 Agent 乌合之众会以 4 种可预测的方式失控：

1. **糊弄验收**：写实现和写检查的是同一个模型，它天然倾向于修改测试或绕开约束来凑绿灯。
2. **在错误前提上死打补丁**：同一处问题连续修两次都失败，重试循环只会打出第 3、4、5 个补丁，把代码越改越烂。
3. **文档与上下文腐败**：架构设计、历史轮次记录和临时结论混在一起，几轮之后没人知道系统到底保证了什么。
4. **提示词约束必然衰减**：只写在 Prompt 里的规矩过几轮就会被遗忘，最后还是把人绑回屏幕前当全职监工。

**`self-loop` 把混乱的 Coding Agent 群落（Claude Code / Codex / Antigravity / T3 Code）整编成可信赖、能直接交付的 Agent 组织**：它把**第一性帧评审**、**跨厂商对抗裁判**、**SSOT 权威文档校验**、**轨迹报警前提审计**与 **Git/CI 硬门禁**拧成闭环。

---

## v0.8.0 调度与集成引擎

**生成引擎 → 调度与集成引擎 → 对抗引擎**。生成引擎制定计划与工作包契约。调度与集成引擎结合 `arch-facts` 的导入图与符号 glob 分析耦合，分波并行调度 Actor，并集成已交接的提交。对抗引擎由一个统一 Critic 或多个并行 Critic 审查，再由跨厂商 Judge 裁决。

使用 `self-loop.mjs dispatch analyze|waves|integrate` 分析耦合、查看调度波次或集成提交。调用角色时追加 `call.mjs --plan PL-NNNN --package <id>` 所示的两个参数，将调用绑定到已提交的工作包。

## v0.7.0 核心新特性

- **有界视野窗口（Bounded Horizon Window，`window.mjs` / `metrics/windows.jsonl`）**：为跨多轮架构重构提供受控窗口（`horizon: 2..12`，经历 `slack` → `converging` → `gate-due`），到期后由 `call.mjs` 机械拒绝继续 `actor`（退出码 `7`），仅接受经已提交跨厂商 `CONVERGED` 裁定 + 精确树 `suite-green` + 远端 CI 验证的 `verified` 关闭，或经 `reviewer-diagnosis` 诊断后的 `reframed` 关闭。
- **异步周期外循环（`arch-facts.mjs`、`reviewer-architecture`、`T1`–`T4`）**：将高频内循环交付与周期性全仓架构评审解耦（`T1` 按交付节奏触发、即使 0-bug 连续绿灯也推进；`T3` 响应结构/反腐化越界）。`call.mjs` 在严格只读 `FILE_TOOLS` 隔离下向 `reviewer-architecture` 注入确定性 `arch-facts.json` 与干净产品工作树，超过 `outerGrace` 宽限未落地则机械阻断后续 `actor`（退出码 `7`）。
- **确定性反腐化、注释膨胀与代码活度扫描器（`anti-rot.mjs`）**：自动扫描兼容残留（legacy/compat/fallback）、死导出、硬编码宿主路径/回环端口、跳过/待办测试腐化与臃肿解释性注释（坚持文档级 SSOT、拒绝过时代码注释），驱动 `T3` 报警及代码-设计活度 QA 与奥卡姆剃刀反身审计。
- **可靠的 Owner 原话捕获与蒸馏门禁（`owner-words.mjs`、`reviewer-distill`、`self-loop.mjs start`）**：确定性过滤 T3/Harness 编排信封，在 `start` 时探测 Antigravity `hooks.json` 健康状态，并将实质性未处理 Owner 原话路由至异步 `reviewer-distill`，超 1 轮宽限忽略即机械阻断 `actor`（退出码 `7`）。

<details>
<summary>v0.6.0 历史亮点</summary>

- **开箱即用的仓内 `.self-loop/` 记录初始化与零配置自动发现**：运行 `self-loop.mjs init [--local-exclude] [--register]` 即可在项目根目录自动初始化受 Git 忽略的嵌套记录仓 `.self-loop/`，无需额外路径配置即可直接 `start` / `next` / `stall`。
- **一等公民 Antigravity Harness 与 T3 Code Runner（`F-0009`）**：原生支持 `hooks install|check|uninstall --harness antigravity`、Antigravity 会话与 Owner 原话同步，以及 T3 Code 子线程执行（`t3:claude`、`t3:codex`、`t3:antigravity`）。
- **`t3:antigravity` 与 `t3:claude` 受限 `reviewer` 支持**：Frame Reviewer 除 Claude CLI `--restricted` 外，现支持在 T3 Code（`t3:antigravity` / `t3:claude`）中以无产品工作树受限模式运行，并由 fail-closed 审计校验工具与相对路径边界。
- **AWS CodeCommit + CodeBuild CI Forge（`F-0013`）**：统一 `FORGES` 调度层，同时支持 GitHub Actions（`github-actions/*`）与 AWS CodeCommit / CodeBuild（`codebuild/*`），强制 STS 账号绑定、规范化端点解析、GRC `CODE_COMMIT_ENDPOINT` fail-closed 防护及凭据脱敏。
- **SSOT 权威文档校验、漂移门禁与角色视图注入（`F-0014`）**：`ssot-check.mjs`（`check` / `attest`）对绑定的权威文档执行 Rung-2 锚点与干净工作树脚本校验、Rung-3 `ssot-drift` 漂移筛查与受保护分支严格阻断，并在 `actor` / `judge` 工作区注入只读 `ssot-status.md`。
- **全新 6 篇 `docs/` 完整文档体系**：涵盖快速入门、架构原理、概念与记录、Harness 接入、代码托管与 CI、发布与版本门禁。

</details>

---

## 核心差异：为什么不是又一个重试脚本

| 维度 | 传统重试循环 | `self-loop` |
|---|---|---|
| **谁来质疑方向？** | 只能靠人 | **`Frame Reviewer`（第一性评审员）**：每阶段开始与报警触发时，从目的、轨迹与 Git 事实推导方案，可直接给出 `REFRAME` |
| **谁来裁定完成？** | 自己判自己 | **跨厂商独立裁判（`Judge`）**：强制与 `Actor` 使用不同厂商模型，在干净检出上复跑全套测试并封存完整裁定 |
| **连续失败怎么处理？** | 继续打补丁直到超时 | **前提审计门禁**：`trajectory.mjs alarms` 触发后，`call.mjs` 直接**拒绝**后续修复调用，直到记录 `PREMISE` + 可证伪的 `OBSERVATION` |
| **权威文档防腐败** | 文档静默过时、与代码脱节 | **SSOT 门禁（`ssot-check.mjs`）**：Rung-2 锚点与校验脚本守住每次推送；Rung-3 漂移跟踪契约变更并守住受保护晋升 |
| **规矩靠什么保证？** | Prompt 叮嘱 | **5 级机械化阶梯**：物理构造隔离 → 硬门禁 → 轨迹筛查 → 模型判断 → `DEBT.md` 显式欠账 |
| **何时算真正关闭？** | 模型口头汇报 "All green" | **精确树证明**：`suite-green.mjs` 精确 Git 树回执 + `ci-green.mjs` 远端推送目标真实 CI `success`（GitHub / AWS CodeBuild）+ `gated-push.mjs` |
| **人的注意力花在哪？** | 全程盯着防止跑偏 | **带推荐答案的小批次决策**：以「每个经核实任务消耗的人工分钟数」为核心指标 |

---

## 5 级机械化阶梯（能用代码约束的，绝不靠模型自觉）

1. **构造隔离（做不到）**：每个角色的工作视图由 `call.mjs` 从某个精确提交按白名单导出，Critic/Actor 物理上根本看不到 `sealed/`；Frame Reviewer 通过 Claude `--restricted` 或 fail-closed 审计的 `t3:antigravity` / `t3:claude` 受限执行。
2. **硬门禁（确定性拒绝）**：`gated-push.mjs` 在推送前核对精确 Git 树测试回执、SSOT 门禁、已提交的裁判 `CONVERGED` 与推送目的仓库的实时 CI，任一缺失直接退出码 `2`。
3. **筛查报警（路由诊断）**：`trajectory.mjs alarms` 与 `ssot-check.mjs` 监控同一区域多轮停滞、同类阻断反复、CI 缺失、模块膨胀与文档漂移，只报事实与证据，不无故误杀。
4. **模型判断**：由带工具的 Lead 模型结合门禁证据做决策。
5. **文字欠账（`DEBT.md`）**：所有暂未代码化的规则公开登记在 [`DEBT.md`](DEBT.md)，每个阶段持续向高阶梯迁移。

---

## 公开复盘：工程诚实胜过神话叙事

- **为什么我们在 v0.3 亲手删掉了整个自动编排层（教训 `L-0002`）**：v0.2 曾写了 865 行编排器状态机去自动判断收敛和关轮，两轮独立评审都在里面抓出误判，越补越复杂。于是在 v0.3 整层删除，脚本只做**确定的隔离调用与事实门禁**，判断还给带工具的 Lead。
- **12 个真实历史拐点的盲测回放**：能看到轨迹的评审员抓出了 **~90% 的真实工程问题**，但只能完全复现约 **1/6 的人类方向重构**。因此 `self-loop` 不吹嘘“零人工全自动”，而是把人的稀缺注意力精准收束到最高杠杆的方向拍板上。

---

## 5 分钟快速上手

> 环境要求：**Node.js >= 22**（Antigravity 会话读取需要 `>= 22.13` 内置 `node:sqlite`）与 **Git**；零外部依赖，无需 `npm install`。

```bash
# 1. 克隆并运行完整单元测试
git clone https://github.com/X32Studio/self-loop.git
cd self-loop
git checkout v0.7.0
npm test

# 2. 运行 5 秒门禁体验 Demo（无需 API Key / 联网）
# 直观体验：记录校验 → 触发报警后 call.mjs 拒绝继续打补丁（exit 7）→ 精确树测试回执 → 受保护推送拒绝（exit 2）
npm run demo

# 3. 在你的项目里一键初始化仓内 .self-loop/ 记录并注册
cd /path/to/your-project
node /path/to/self-loop/scripts/self-loop.mjs init --register
```

安装为 Claude Code / Agent 技能：
```bash
mkdir -p ~/.claude/skills
cp -r . ~/.claude/skills/self-loop
```

---

## 完整文档导航

- **入门与操作指南**：[`docs/getting-started.md`](docs/getting-started.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/concepts-and-records.md`](docs/concepts-and-records.md) · [`docs/harnesses.md`](docs/harnesses.md) · [`docs/forges-and-ci.md`](docs/forges-and-ci.md) · [`docs/release-and-versioning.md`](docs/release-and-versioning.md) · [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md)
- **运行时规范契约**：[`SKILL.md`](SKILL.md) · [`RECORDS.md`](RECORDS.md) · [`REQUIREMENTS.md`](REQUIREMENTS.md) · [`DEBT.md`](DEBT.md)

---

## 作者与开源协议

由 **[X32 Studio](https://x32studio.com)** 建造 · 基于 [MIT License](LICENSE) 开源。
