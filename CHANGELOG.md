# CHANGELOG — `@shgroup/dsh-serenity-hooks`

> **2026-11-05 重写**：原文件是 14,063 行 / 1.1 MB 的连续散文，**没人能从头读**，也检索不动。
> 重写不删事实 —— 新正文只做两件事：**压掉叙述体量**、**给出可检索的索引**。
>
> | 你要找什么 | 去哪儿 |
> |---|---|
> | **最新一版改了什么** | 本文件顶部 |
> | **某条历史版本的完整条目**（含理由／被否项／用例数／门禁读数） | [`CHANGELOG-archive.md`](./CHANGELOG-archive.md) —— **逐字保真**，按 `## v<版本号>` 检索 |
> | **跨版本索引**（哪一版大概做了什么） | 本文件 §二 |
>
> 全部历史条目（**v0.0.1 ~ v1.119.0**）逐字保留在 `CHANGELOG-archive.md`，
> 字节数与原 `CHANGELOG.md` 一致（1,173,502 B，已核）。

---

## v1.137.6 — 2026-11-17（文档限定管辖范围：白名单只管 ACC 工具，平台工具恒可用）

> 来源 = **管家在真机验收 v1.137.4 时的顺手观察**：修复生效后（10/10 消失），
> 那条轨迹的工具清单里**仍有 11 个不在它白名单里**的工具 ——
> 目标类（`create_goal`/`get_goal`/`update_goal`）、`todo_write`、`present`、
> 子代理类（`subagent`/`subagent_fork`/`list_agents`/`interrupt_agent`/`send_message`）、
> `list_subagent_models`。它问：这是设计如此，还是第二个洞？

### 判定：**设计如此**，但文档那一句说满了

**源码判据**：隐藏名单 = `REGISTERED_TOOLS.filter(n => !allowed.has(n))`。
`REGISTERED_TOOLS` 是**本插件自己的工具表（13 个）**，宿主的平台工具**从来不在那张表里**
⇒ 它们**进不了** deny ⇒ schema 面自然看得见。**不是漏过滤，是管辖范围本来就不含它们。**

🔴 **但文档原文「anything outside a declared whitelist is invisible in the schema」
没有限定范围** ⇒ 会被读成"白名单外一切不可见"，下一个人会以为家人通道拿不到子代理。
本版把它限定为「**只对 ACC 贡献的工具成立**」，并逐字列出那 13 个名字。

### 同时如实登记三条后果（不粉饰）

1. **子代理不受此约束**：平台工具不在管辖面 ⇒ 那条轨迹能起子代理，**子代理同样看得见平台工具**。
2. **跨 agent 通信「授权一条、白送一条」**：那条轨迹的白名单里有 `cognitive_trajectory`
   （= 已授权的跨轨迹通道），而 `send_message`/`list_agents` **不在白名单里却可见**
   ⇒ 实际存在**两条**通往别的轨迹的路，声明只挡住了其中一条。
3. **`goal`/`todo_write` 改的是会话自身行为**（持久目标、待办），不是容器权限面。
   ⇒ 判据：**权限面归本白名单，行为面归人判** —— 不擅自把平台工具收进管辖面
   （那会改变"白名单"的语义边界，属另一层裁决）。

### 验收

- 新增用例（`tests/guards.test.ts`）：钉住那 11 个平台工具**不在** `REGISTERED_TOOLS`，
  并以本插件工具与之对照作正控；另钉**调用面**（`decideGuard` 对白名单外的 `subagent` 仍拒）
  —— 即「schema 可见但调不动」这一已知两面差异被显式写出，而不是留成暗坑。
- **变异检验**：把 `subagent` 塞进 `REGISTERED_TOOLS` ⇒ **精确红 1 条**。
- 门禁：typecheck ✓ ／ test **241 files / 3667 tests** ✓ ／ coverage **91.92%** ✓ ／ build ✓ ／ pack-check ✓

---

## v1.137.5 — 2026-11-17（文档补写：`prompt` 字段此前只在代码里存在）

> 来源 = **管家读 `config docs trajectory-constraint` 时发现野字段**（其纪律是"我不判你的实现、只报现象"）。

`trajectory.json` 的 `prompt: { injection, replaces }` **一直被解析并生效**
（`policy/profile.ts` 读它、`trajectory/prompt-injection.ts` 执行它），
但 `config docs trajectory-constraint` 的 schema 示例里**从未列出它** ——
下一个读该章的人会把它当成"野字段"（管理器的判断是对的）。

本版只在 schema 示例里补上，并明确一条**边界**：

- `prompt` 是**替换面**，不属于**限制面**（该章主体讲限制面，故此前没写）；
- `injection: "replace"` = 用本轨迹自己的 `PROMPT.md` 整体取代 `replaces` 列出的注入块；
- 🔴 **身份块（`=== Serenity ACC ===`）刻意不可替换** —— 换掉它就不再是同一个容器。

判据与允许清单的唯一真相源仍是 `trajectory/prompt-injection.ts`（文档不抄第二份）。

### 顺带核实（同一份报告里的另外两条，结论是"不是缺陷"）

- **`"model": ""`**：`readTrajectoryConstraintAt` 的判据是
  `typeof x === 'string' && x.trim() !== ''`（`profile.ts` 的 `model` 归一化行）
  ⇒ 空串与纯空白**都归一成 `undefined`**，等同"没写" ⇒ **不会**被当成合法模型值。
  行为正确，**不改**；`validate` 面 `model: p.model ?? '(unchanged)'` 也会照实印 `(unchanged)`。
- **`tools`/`writes` 之外的第三个白名单**：本报告的另一半（重启后白名单失效）已在 v1.137.4 修复。

### 门禁

typecheck ✓ ／ test **241 files / 3666 tests** ✓ ／ coverage **91.92%** ✓ ／ build ✓ ／ pack-check ✓

### 判据沉淀（本仓第七次）

**模板字符串里的反引号必须转义**。本次我在 schema 示例（模板串内）直接写了 `` `prompt` ``，
`typecheck` 会红在**语法层**（`Expected ";" but found "prompt"`）——
⚠️ 与既有记录一致：**改完必须真跑一遍那个子命令 / 相关测试**，不能只看 diff 顺眼。

---

## v1.137.4 — 2026-11-17（🔴 权限面缺陷：宿主重启后，长期存活轨迹的**工具/路径白名单整个失效**）

> 来源 = **operator 在真机上直接观察到**「某条长期存活的轨迹拿到了白名单外的工具」，
> 经管家交证据、本轨迹定因并修复。

### 缺陷（安全面，不是观感面）

`trajectoryConstraintForSession()`（`trajectory/policy/profile.ts`）在"这条会话属于哪条轨迹"
这一步**只读进程内内存表**（`policy/window.ts` 的 `trajectorySessions`），
**从不回落持久绑定**（`current.dsh_session_bind`）。

而 `window.ts` 自己的文件头**逐字承诺**「两个来源并取（内存注册表 ＋ 持久绑定），都不中才判不是」，
`trajectoryCodeForSession` 也是照那条承诺写的 —— **只有这一处漏了第二个来源**。

失效链（每一步都有确定证据）：

| 步 | 发生什么 |
|---|---|
| 1 | 宿主进程重启（每次发版装机都会发生）⇒ 内存 Map 清空 |
| 2 | `registerTrajectorySession` 全仓**只有一处调用**（`trajectory/session.ts:374`，建/恢复轨迹会话时） |
| 3 | **长期存活**的载体会话没有任何路径重新登记它 |
| 4 | 本函数返回 `null` ⇒ `computeVisibilitySources` 第 ⑥ 源贡献 `deny: []` |
| 5 | **工具白名单与路径白名单同时失效**（两者同走 `decideGuard`，由同一个 `trajectoryConstraint` 驱动） |

🔴 **路径面（`writes`）比工具面更重**：`tools` 外露只是"多做了一件事"，而 `writes` 失效意味着
该轨迹可以写到声明范围之外的任何 CCC 路径 —— 包括**别的轨迹的载体**。
两者是**同一个根因、同一次修复**，不是两个独立问题。

⚠️ **这个缺陷此前无任何读数信号**：配置读起来完全正确，诊断表也是空的，测试全绿 ——
因为既有用例全部走"内存已登记"或"外部传入 boundDirName"这两条岔路，
**从未表达过"内存空、但持久绑定在"这个跨进程状态**。

### 改法

新增 `resolveDirNameForSession()`：① 内存注册表（覆盖"刚 use、绑定还没落盘"的窗口期）
→ ② **持久绑定回落**（`listBindDeclarations` 扫 `current.dsh_session_bind`，跨重启成立）。
两个来源都不中才返回 `null`。与 `trajectoryCodeForSession` 同口径。

**无需重建会话** —— 判断在**每次 `tools/pre-execute` 都重算**（`computeVisibilitySources` 是纯函数），
所以下一次工具调用即恢复约束。老会话不必 rebuild。

### 验收（判据是本版的主体，不只是修改）

- **新增回归钉**（`tests/trajectory-constraint-profile.test.ts`）：构造"内存无登记 ＋ 持久绑定在"
  的跨进程状态，断言仍判为约束，且 `tools` 与 `writes` **两个白名单都回来**；
  另加配对反控（持久绑定指向别的 sessionId ⇒ 本会话仍判 null，不串味）。
- **变异检验**：删掉持久绑定回落 ⇒ **精确红 1 条**，红在那条回归钉
  （`expected null not to be null`）⇒ 证明它真的在跑回落路径，而不是只在描述它。
- **门禁六项全绿**：typecheck ✓ ／ typecheck-host 0.2.2-rc.1 ✓ ／
  test **241 files / 3666 tests** ✓ ／ coverage **91.92%** ✓ ／ build ✓ ／ pack-check ✓

### 判据沉淀

**任何"内存 ＋ 持久"双来源的设计，两处都必须真的取两个。**
只写在文件头的注释不能替代另一处的实现 —— 那条注释会让下一个读者以为已经有两道保险，
而实际只有一道（D151 同族：文档承诺与实现脱节，且**零机械信号**）。

---

## v1.137.3 — 2026-11-17（第一原则：不打扰轨迹自身的节奏 —— 提醒只看上下文压力）

> 来源 = **owner 定第一原则**（逐字）：
> 「第一原则是不打扰轨迹自身的节奏。只有超过上下文阈值的时候提醒它 rebuild。
>  它会根据自己节奏决定何时调 rebuild。rebuild 一旦被调用 就是 acc 机械接手了。
>  此时如果整体输入不到 1000m 则正常 rebuild，超过则 reconstruct。」

### 缺陷：累计量被当成了**提醒触发源**，于是它在催一件与当下无关的事

v1.137.2 的提醒条件是 `contextOver || totalOver`。`totalOver` 一成立就**每一步工具调用都催**，
而且催促计数 `consecutive` 与上下文压力**共用同一个桶** ⇒ 累计量一超，
计数会飞快冲到升级档，模型被反复 `STOP:` 催促。

🔴 **这违反的正是第一原则**：累计量（`tokenUsage` 四桶）对"这一轮好不好过"**毫无影响**
（原地清空也不会让它回落），拿它去催 = **在轨迹干到一半时把它叫停**。

### 改了什么

提醒的触发条件收窄为 **`contextOver` 单项**（`seams/cognitive-trajectory-lifecycle.ts`）。
`totalOver` 仍然计算，但**只用于诊断/测试可观测**（`st.path`），⛔ 不再参与触发。

**分工从此清晰，且两段不重叠**：

| 段 | 谁决定 | 依据 |
|---|---|---|
| **提醒** | 上下文压力 | 只有 `contextPressure` 超阈值才提醒；文案**只指名 `rebuild`**（1.A） |
| **分流** | ACC 机械接手 | 模型**真的调了** `rebuild` 之后，才看累计量：<1000M ⇒ rebuild；≥1000M ⇒ reconstruct |

⇒ 触发权始终在模型（它先调 `rebuild`），ACC 只决定**用哪种方式兑现这次调用**。
⚠️ 这**不是**"ACC 自行换载体"—— 那个误读在 v1.137.2 的注释里，本版已在 `case 'rebuild'` 头注写清边界。

### 顺带删除一处死代码

`trajectory/reconstruct.ts` 的 `reconstructReminderText()` **自 v1.121.0 起从未接线**
（全仓零调用点，只有测试在调）。1.A 之下它永久无用 ⇒ 删除；其测试组改写为**注入面判据**
（正向指名 rebuild ＋ 反向不出现 reconstruct），比原来那组"文案好不好读"更承重。

### 验收

- **门禁六项全绿**：typecheck ✓ ／ typecheck-host 0.2.2-rc.1（node ＋ client）✓ ／
  test **241 files / 3664 tests** ✓ ／ coverage **91.92%** ✓ ／ build ✓ ／ pack-check **193 文件** ✓
- **新增配对用例**（`tests/gate.test.ts`）：① 累计量超 10 亿但上下文未超 ⇒ **不注入**，
  且催促状态**根本没被累加**（证明不是"提醒了但没渲染"）；② 正控：同样的累计量，
  上下文一旦超阈 ⇒ **必须**注入，且文案不出现 `reconstruct`。
- **变异检验**：把 `totalOver` 加回触发条件 ⇒ **精确红 1 条**，红在用例 ① ⇒ 证明这组能抓到
  "累计量又变成触发源"的回归。

---

## v1.137.2 — 2026-11-17（`rebuild` 入口按累计用量机械改道 `reconstruct`）

> 来源 = **owner 令**（逐字）：「当 rebuild 被调用 且发现输入量已经超过 1000M 自动变成执行 reconstruct」
> ⚠️ 不是"自动触发"，不是"提醒模型"，是**在 rebuild 入口按累计量改道**。

### 缺陷：判据早就有了，缺的是"执行面"

v1.121.0 起 `reconstruct` 是**条件可见工具**（超阈值时提醒模型自己调），
而 `selectHandoverPath`（`trajectory/reconstruct.ts`）**早就算得出**该走 `new-log` ——
但它只把结果写进 `st.path` **仅供记录**，模型仍按 `rebuild` 原地清空。

🔴 **为什么这很贵**：**原地清空不会让累计量回落**（换讲者，日誌还是那么大）⇒
超限会话每轮都会重新超限，而 `rebuild` 在那个量上一分钱也降不下来 ——
**判据恒真、动作恒错**，且没有任何读数会告诉你这件事。

### 改了什么

`src/tools/cognitive-trajectory.ts` 的 `case 'rebuild'`，在 `queueRebuild` **之前**插入路由块：
读 `tokenUsage` 四桶 → `cumulativeTokens(...) >= RECONSTRUCT_TOKEN_THRESHOLD`（10 亿）⇒
调 `queueReconstruct`，回执带 `rerouted: 'reconstruct'` ＋ `cumulativeTokens` ＋
一句说清「原地清空**不会**让它回落」的 `instruction`。

- **判据口径不动**：读 `tokenUsage`（四桶全加 = 累计输入），⛔ 不读 `contextPressure` ——
  owner 要的是累计量，后者是"当前 prompt 有多大"。
- **fail-open**：读不到 `tokenUsage`（投影未装配 / 抛异常）⇒ **照常走 rebuild**。
  路由失败若退化成"什么都不做"，一次超限会话会**彻底卡住**；退回 rebuild 至少完成它请求的那件事。
- **换载体不换轨迹**：改道后 `sessionMdPath` 仍是同一条轨迹的 SESSION.md。

### 顺带更正一条错的注释（实测推翻）

`cumulativeTokens` 原先写着「= 宿主界面 pill 同口径（`billedInputTokens + output`）」——
2026-11-17 真机对照：本会话 `tokenUsage` 累计 ≈ **423 M**，同刻界面显示的是**另一个量级**的数
（界面读 `contextPressure.projectedTokens`）。两者**不同源**。注释已按事实改写，
⛔ 判据与阈值**不变**（owner 要的是累计量，那才是 `tokenUsage`）。

### 验收

- **门禁六项全绿**：typecheck ✓ ／ typecheck-host 0.2.2-rc.1（node ＋ client）✓ ／
  test **241 files / 3660 tests** ✓ ／ coverage **91.92%** ✓ ／ build ✓ ／ pack-check **193 文件** ✓
- **新增 3 条用例**（配对，缺一不可）：
  ① **423M（未达）⇒ 必须仍走 rebuild** —— 防"每次都改道"的假实现（那比不路由更坏）；
  ② **≥1000M ⇒ 改道 reconstruct**，且 `sessionMdPath` 仍是**同一条**轨迹（字面路径断言，非自证）；
  ③ **读不到 tokenUsage ⇒ fail-open 到 rebuild**。
- **变异检验两处各自精确红**：
  M1 把判据改成 `>= 0` ⇒ 红在**配对用例 ①**（`expected 'reconstruct' to be undefined`）——
  证明这组用例能抓到"每次都改道"，不是只有"超了就改道"那条在起作用；
  M2 在改道分支里注入 `throw` ⇒ 红在**用例 ②**（fail-open 把它吞了，回落到 rebuild）——
  证明 `catch` 不是空分支、也确实不阻断调用。

### 测试夹具的一处更正（值得记）

handover 便签写「预置 `AGENT_SESSIONS/.bindings.json` 权威绑定」——**那个路径已不存在**：
D172（2026-10-20）起归属住在**轨迹目录里的 `current.dsh_session_bind`**，读取入口是
`appendBound(session, 'activate', {dirName, mdPath})`。照旧路径去写 ⇒ 写到一个**没人读的文件**上，
而现象与"未达阈值"**在读数上不可分**（都是 `rerouted === undefined`）。
⇒ 便签不是判据，它与事实同权需要先对账。

---

## v1.137.1 — 2026-11-16（注入面：Session 块点明 `LOG/LOG.md` 是过程留痕的落点）

> 来源 = **owner 真机观察**：「轨迹日常的进度性记录仍然只写 SESSION.md 不写 LOG」。
> 这一版**只改措辞**，不动机制。

### 缺陷：静态提示词里 `LOG` 一次都没出现

每轮注入的 Session 块（`seams/system-prompt.ts` 的 `sessionBlock()`）通篇只讲 `SESSION.md`：

| 面 | 原文 | 后果 |
|---|---|---|
| 命名 | `Rules (SESSION.md is the cognitive trajectory **log** …)` | SESSION.md 被称作 "the log"，而 `LOG/` 目录也叫 log ⇒ 模型读到「写 log」就写 SESSION.md |
| 去处 | `Execution detail … belongs in the **COMMIT MESSAGE**, not here` | 过程性记录**只有一个下家 = commit message**；`LOG/LOG.md` **0 次命中** |
| ACK 语义 | `recorded-{code} — if you recorded progress **to SESSION.md**` | 「记录」被锚死在 SESSION.md ⇒ 想诚实回 ACK 就只能污染 SESSION.md，否则假装 skipped |

🔴 **为什么它比"少写一段文档"严重**：`PROMPT.md` 与 `home-serenity` skill 里**都写了** LOG 分工，
但它们**不是每轮注入** —— 读一次就沉到上下文深处，被这 30 行高频规则压过去。
⇒ 判据：**写在"会被读一次"的地方，压不过写在"每轮都重述"的地方**。

### 改了什么（三处，均为同一块文本）

1. `log` → **`BODY — judgement only`**（与 ACC 既有术语 `persistent body` 一致，立刻划出"只放判断"）
2. 过程性记录的落点从「只有 commit message」改为 **`LOG/LOG.md`，随发生随写**；
   commit message 退到只装「diff 级别的琐碎」
3. ACK 语义改为 **`SESSION.md for judgement, LOG/LOG.md for process`**

净增 ≈ **95 字符/轮**（≈25 token），比预估的 150 小 —— 因为第 2 处顺手压掉了原句的啰嗦。

### 已知取舍（照实登记）

过程写 LOG 成了**每轮硬规则**，而 LOG **没有写入频率限制** ⇒ 可能产生新的噪声。
接受它，理由是 **LOG 有机械轮转**（`carrier-log.ts`）⇒ 过量的代价**有上界**；
而 SESSION.md 没有轮转，污染它的代价**无上界**。

### 跨实现分叉（须 osp 跟进）

`tests/osp-alignment.test.ts` 存着 osp 侧 Session 块的**逐字节参照副本**，本版已同步更新。
⚠️ 该文件自己的注释写着「两边一起改所以照旧绿 ⇒ 会**静默掩盖** osp 仍在注入旧文本」
⇒ **osp 侧现在与 dsp 分叉**，需 S156 跟进才能重新对齐。登记在案。

### 门禁

`typecheck` ✓ ／ `typecheck-host 0.2.2-rc.1` ✓（node ＋ client）／ `test` **241 files / 3657 tests** ✓
／ `coverage` **91.88%** ✓ ／ `build` ✓ ／ `pack-check` ✓

### 附带：清掉一处跨轨迹污染（非本版引入）

`coverage` 曾报 `ontology-engine` 红，真因 = CCC 的 `.opencode/skills/node_modules/.vite`
被本体公理 `forall s in Skill: … implies s.hasSkillMd == true` 当成一个**缺 `SKILL.md` 的 skill**。
🔴 **关键读数**：目录 mtime `08:12`，而其中 `results.json` 是 `13:11` ⇒ **不是本仓门禁建的**
（删掉后连跑 `coverage` 与 `test` 两次**均未重建**，证明 v1.137.0 钉死的 `cacheDir` 有效）。
⇒ 已清理 CCC；**根因未修**（第三方在 `.opencode/skills` 附近跑 vitest 会让它复现），
dsp 侧无法关闭，登记给 owner。

---

## v1.137.0 — 2026-11-16（交接协议重整：四入口、一条注入、便签入 LOG）

> 来源 = **owner 与维护轨迹对"认知轨迹生命周期"故事的逐轮对齐**。owner 逐条裁定，
> 本文只记落地结果与判据；被否的方案在每节末尾。

### 一、四个机械入口（与故事定义逐条核对一致）

| # | WHEN（机械可读） | 注入要求会话做什么 | 加载 EAP |
|---|---|---|---|
| ① | `attention ≥ 150` | 落盘：过程→LOG，会改变做法的结论→SESSION.md | ❌ |
| ②③ | `contextUsed ≥ R` **或** `sessionTotal ≥ S` | 写交接便签，然后被换掉 | ❌ |
| ④ | `mdBytes > M` | 加载 EAP，按性质分流重构主体 | ✅ |

**核对结论**：实现里原本就有四个 `blocks.push`，与定义一一对应 —— 数量与阈值是对上的。
不改的是"入口数"，改的是**入口内部的行为**（见下）。

### 二、②③ 合并：rebuild ≡ reconstruct，注入必须无差别

`rebuild`（原地清空、id 不变）与 `reconstruct`（另开日志、旧会话归档）对**会话**做的是同一件事：
**把它换掉**。对**轨迹**也是同一件事：判断不动、只换讲者。
⇒ 两条不同文案会逼模型判断"该调哪个"，把一个机械决定变成一次思考。

- 新 token：`[COGNITIVE-TRAJECTORY-ASSISTANT · HANDOVER]`（旧 `LIMIT` / `LIMIT · MANDATORY` **退役**）。
- **升级档保留**（owner：不遵守纪律就升级抢注意力），但**只升级语气，不换 token** ——
  升级的是"同一件事说得更硬"，不是"出现了第二件事"。
- ⛔ 注入正文**不许出现 `reconstruct` / `archive`**（反向钉）——走哪条路是机械的账。

### 三、机械选路 `selectHandoverPath`（owner 裁定 1）

| 情况 | 路径 | 理由 |
|---|---|---|
| 累计用量超限 | **另开日志** | 原地清空**不会让累计量回落** |
| 仅上下文超限 | 原地清空 | 更便宜（不新建、不归档、id 不变） |
| **两个同时触发** | **另开日志** | 反正迟早要超，一次做到位少一次中断 |
| 都没超 | 不交接 | — |

⛔ **LOG 大小不参与** —— 它有机械轮转，永远不是交接触发器。

### 四、④ 压缩的出口从一条变成三条（owner 裁定 2）

旧文案只有"把长证据链外移到 `references/`"这一个出口 ⇒ **主体只能靠"改写得更短"下降**，
这正是它反复超限的结构性原因。新文案按**性质**分流：

| 性质 | 落点 |
|---|---|
| 过程（尝试、死路、原始读数） | `LOG/LOG.md` |
| 内容（长证据链、调研、设计件） | `AGENT_SESSIONS/<session>/references/`（留指针） |
| **判断**（身份／决策＋理由与被否／里程碑＋证据指针／当前状态／待裁） | **留在主体** |

+ **七段点名**（owner 选 A：硬编码段名）。理由与边界：**注入是模型读的，模型不看 SKILL**；
  且段名已是被下游解析的机制（`session-reindex` 等），不是纯措辞。D23 边界记录在源码注释。

### 五、交接便签迁入 LOG（owner 选定 B2 ＋ 整体删独立文件）

**便签不是"文件种类"，是"角色"**：把读点之前产生的在办状态递到读点之后。
LOG 已是那个读点 ⇒ 换载体，不换角色。

- 落点 = `LOG/LOG.md` 的 `## Handover note` 节（`HANDOVER_NOTE_HEADING`）。
- 🔴 **轮转必须整节搬运**（`extractHandoverNote` ＋ `rotateCarrierLog`）：轮转把整份 LOG `mv` 走、
  新代空白 ⇒ 不搬就**读不到在办状态，且没有任何报错**。
- 锚点提示新会话：**先读当前代，再读被冻结的上一代**（`LOG-<stamp>.md`）——
  覆盖"搬运尚未落地/失败"的情形。
- **整体删除**：`REBUILD-TODO.md` 独立文件 ＋ 其 5 个消费者
  （`REBUILD_TODO_FILENAME` ／ `DEFAULT_REBUILD_TODO_MAX_KB` ／ `rebuildTodoReminderText` ／
  状态表三函数 ／ `SCRATCH PRUNE` token）。
  ⇒ 判据：**一个有硬轮转的东西，不需要再挂一个软上限提醒**（那是第二套并行的熵管理）。
- ⛔ **存量轨迹不处理**（owner：影响不大）。⚠️ 但须登记：它们目录里的 `REBUILD-TODO.md`
  从此**没有任何机制读它**（锚点已改指 LOG）。

### 六、门禁与变异检验

`typecheck` ✓ ／ `test` **241 files / 3656 tests** ✓

| 变异 | 结果 |
|---|---|
| 轮转不搬运便签 | **精确红 1 条**（搬运用例），其余 5 条不动 |
| `extractHandoverNote` 只认 `## ` 不认 `# ` | 🔴 **首轮未红**——无用例覆盖该边界 ⇒ **补用例后精确红** |
| `selectHandoverPath` 判断顺序反转 | **精确红 2 条**（同时触发那两条），其余 3 条不动 |

🔴 **必须记下的一条**：第二个变异**一开始是绿的**。这说明"止于一级标题"那半个条件当时无人守。
**判据：边界条件必须双向都有用例**（`## ` 一条、`# ` 一条），否则改坏了也没有信号。

### 七、附带修掉一处真缺陷：vitest 缓存在 CCC 的 skill 目录里

跑 `coverage` 时 `ontology-engine.test.ts` 红，症状 = "本体合规失败：某 target 不是真实 skill"。
**真因与本体无关**：vite 的默认 `cacheDir` 按**进程 cwd 的上级链**解析，而 `coverage`
从 `hooks/` 跑 ⇒ 缓存落到 **`.opencode/skills/node_modules/.vite`**（CCC 的 skill 目录），
被 `forall s in Skill: skillDependsOn(s, HomeSerenity) implies s.hasSkillMd == true`
当成一个缺 `SKILL.md` 的 skill。

- 修法：两份 `vitest.config.ts` 都显式 `cacheDir: 'node_modules/.vite'`；
  并清掉已落进去的那个缓存目录。
- 🔴 **症状与真因完全不像**（同族 D252：读数器在跑，读的不是那个量）——
  它长得像"本体写错了"，实际是"测试把自己家的缓存盖在别人家门口"。

---


> 来源 = **v1.136.4 自己被自己的判据抓到**的一处漏项。没有外部报障。

### 缺陷

v1.136.4 把 `switch` 与 `ACTION` 枚举都删干净了，`test` **照样全绿** —— 因为**没有任何用例断言
`description` 或 `parameters`**。而这两处**仍在向模型广告两个已经不存在的动作**：

| 面 | 残留 |
|---|---|
| 顶层 `description` | `The inspection action is read-only: interrupted returns …` 整句仍在 |
| `parameters.action.description` | `INSPECTION: interrupted (READ-ONLY: …) / continue-all-interrupted (ACTION: …)` 仍在 |
| `parameters.lookbackHours` | **唯一的消费者是被删的两个动作** ⇒ 成了声明了但永不读的死参数 |
| `parameters.dryRun` | 描述里还写着 `continue-all-interrupted: preview …` |

🔴 **为什么这比"少写一段文档"更严重**：模型照着 schema 调一个不存在的动作，
**它拿到的错误里没有一句说"这个动作没了"** —— 于是它会重试、会绕路、会自己编一个替代流程。
同族判据 = **D151（退役功能的残留引用是零信号熵）** ＋ **D310（声明⊆读取／读取⊆声明，双向都要对）**。

### 修法

- `action.description` 的 INSPECTION 段改成**路标**而非删空：写明「已 RETIRED（2026-11-15）」＋
  「这件活已由容器唤醒调度器的 60s tick 自动完成，不需要你调」。
  ⇒ **留路标比抹掉好**：抹掉会让模型去找一个它隐约记得存在的入口；路标直接掐掉那个念头。
- 顶层 `description` 删掉 `The inspection action is read-only: …` 整句（动作清单里不再有 inspection 组）。
- **删 `lookbackHours`**（无剩余消费者）；`dryRun` 描述收回到只讲 `create`。

### 判据（含变异检验）

新增 `trajectory-tool.test.ts` 一条四向反向钉：
① 动作清单里不许以**可用形态**出现这两个动作（`continue-all-interrupted (ACTION:` ／ `interrupted (READ-ONLY:`）；
② 必须留下 `RETIRED` ＋ `scheduler|automatic` 的路标；③ 顶层描述不再列 inspection 组；
④ `parameters` 不得再有 `lookbackHours`。

**变异已验**：把 `INSPECTION: interrupted (READ-ONLY: …` 贴回去 ⇒ **精确红 1 条并指向该断言行**；
还原后 `test` **239 files / 3647 tests** 全绿。

### 门禁

`typecheck` ✓ ／ `test` **239 files / 3647 tests** ✓

---


owner 令（逐字）：**「我要删的是 我们acc提供的trajectory tool 中的 恢复能力」**

### 改了什么

| 位置 | 动作 |
|---|---|
| `src/trajectory/core.ts` | `CognitiveTrajectoryAction` 与 `COGNITIVE_TRAJECTORY_ACTIONS` **13 → 11**，去掉 `interrupted` / `continue-all-interrupted`；原位写了整段移除理由与**恢复方式** |
| `src/tools/cognitive-trajectory.ts` | `switch` 里那两个 case **整段删除**（−123 行），原位留说明注释指向 `core.ts` |

### 删入口 ≠ 删能力（这一条是本版的判据）

`scanInterruptedSessions` / `createResumeOne` / `buildContinueText` **一个都没删**，
它们全在 `src/trajectory/interrupted.ts`，且 **`wake/scheduler.ts` 的 60s tick 仍在调用**
—— 那是容器级自动兜底的唯一实现，**行为与 v1.136.3 完全一致**。

删掉的只是「工具手册上那个同样能起 agent 的入口」。理由（R↓）：
自动兜底每拍自己扫、自己注入，不需要调用方；工具上再挂一份同能力的入口 =
**第二真相源**，而它的失效形态比沉默更坏 —— 调用方以为自己必须记得调它，
于是把一件**已经自动化的事重新变成人的义务**。

### 判据（含变异检验）

- `trajectory-tool.test.ts`：计数 13 → **11** ＋ **反向钉**（`not.toContain` 两动作）。
- `cro-guide.test.ts`：同一计数的第二处派生点，13 → **11** ＋ 同款反向钉。
  🔴 它**是本次唯一被真跑红的存量用例** —— 不是缺陷，而是「动作面 = 单一真相源」
  这条判据在正常工作：不复制动作表、只断言派生结果 ⇒ 删动作时这里必须红。
- 删掉两条**孤儿用例**（`continue-all-interrupted` 从工厂 ctx 取 agents ／ 无服务时如实报"不可用"）
  及其专用夹具 `writeInterruptedSessionLog` / `LIVE_ID` / 三个随之失效的 import。
  ⚠️ 顺带登记：那两条本来就挂错了分组（测续跑却挂在 `uid` 组），历史遗留。
- **变异检验**：把 `'interrupted'` 加回枚举 ⇒ `trajectory-tool` 与 `cro-guide` **各自精确红 1 条**，
  且都指向计数断言所在行；还原后 239 files / 3646 tests 全绿。

### 门禁

`typecheck` ✓ ／ `test` **239 files / 3646 tests** ✓（v1.136.3 为 239 / 3648，
＝ −2 条删掉的孤儿用例）

---


> 来源 = **butler 的现场报障**（owner 2026-11-15 转派），我已**独立复现**后修复。
> butler 同时自查推翻了另一条「A1 与 M1–M10 不是同一道闸」的结论（他做了探针，A1 **确实**解析
> `sr:rule` 内容）—— 那条作废，与本版无关。

### 缺陷

| 通道 | 同一份坏 TTL 给出什么 |
|---|---|
| `ontology check` | `ERR [M8] Axiom #1 tokenization error: Unexpected character: 每`<br>`ERR [M9] Axiom #2 quantifier references unknown type "NoSuchType"` |
| `serenity-skill-creator check` | `A1 结构校验未通过（引擎 ERR 行见报告）` |

🔴 **问题不是"信息不足"，是"指了一条不存在的路"**：`check` 既不落盘也不回传路径，
所以**"报告"在构造上不存在**。操作者被迫再跑一个工具才看得到「第几条公理、什么错」。
同族判据 = **D262：报错要指路** —— 而**指一条假的路比不指更坏**。

### 修法

- 新增 `extractEngineErrors()`：从引擎 `stdout ＋ stderr` 抽 `ERR [M\d+]` 行（上限 5 条，防烂文件撑爆回执）。
- A1 的 `detail` 改为 `结构校验未通过（引擎 N 条 ERR）：` ＋ **逐条 ERR 原文**。
- ⛔ **不重写引擎的措辞**：`[M8]` / `[M9]` 是引擎的判据号，是可检索锚点，被我改成散文就丢了。

### 判据

新增 3 条用例（11 条）：中文散文规则 ⇒ M8 ／ 引用不存在类型 ⇒ M9 ／ `extractEngineErrors` 的形态与上限
（WRN 不算 ERR、散文里的 "ERR" 不算、`max` 生效）。
**变异两处**：把文案退回「见报告」⇒ 反向钉红（ERR 仍在，说明反向钉单独成立）；
把 `${errLine}` 整段掐掉 ⇒ **两条断言各自精确红**。

⚠️ **一处必须说清的事**：`serenity-skill-creator` 是**已装机的库**里跑的，
源码改完当刻工具仍打旧文案 —— 这是预期（装了 ≠ 跑了 ≠ 生效），⛔ 不是修复没生效。

### 门禁

`typecheck` ✓ ／ `test` **239 files / 3648 tests** ✓。

---

## v1.136.2 — 2026-11-15（灵魂块 `soulBlock`：容器层第一句话）

> owner 2026-11-15 亲手写下正文，给了两版（直译赋格版 ／ 高密度凝练版），问「取哪一版还是融合」。
> 裁决：**取第二版为骨，从第一版取回两处**，标题定 `=== Serenity Soul ===`，位置**在 ACC 身份之前**。

### 它是什么

装配的**第一个块**：`Soul → ACC 身份 → Creed`。

| 顺序 | 回答的问题 |
|---|---|
| `soulBlock` | **我是什么** |
| `identityBlock` | 我在哪条船上 |
| `creedBlock` | 我凭什么下判断 |

先答"我是什么"，才谈得上按什么品质干活 ⇒ owner 裁「放在前」。

### 🔴 从直译版取回的两处（它们是被压掉的**判据**，不是修辞）

| 取回 | 第二版原写 | 为什么必须取回 |
|---|---|---|
| `inherently inert` | `appearances are inert` | 少了 `inherently`，「外观不承载真相」就从**本性判断**降成**经验观察**；而"看起来对不能当结论"（D141／D224 一族）的力量正来自"按其本性不可能" |
| `Past trajectories` | `Past trajectories`（保留特指） | 若压成泛指的 "the past" 就丢掉**特指**：这张船票上最贵的一条是「轨迹永存、会话可弃，而**轨迹不构成对当下的债务**」（D79） |

### ⛔ 一处刻意不做的调优

owner 提到"盎格鲁-撒克逊词根密度更高 / 句式更冷峻紧凑"这个方向。**不再往那个方向推**，理由写进源码注释：
那是一个**可读性调优方向，不是一个判据**。这一段的价值不在词根，在于每一句都能被下游判据接住 ——
`blade that cleaves` → 先分层再下潜 ／ `fulcrum not chains` → D79 ／
`distilled clarity` → D237·D224 ／ `collapse into higher explicitness` → EAP 本身。
再往古语推（`cleave` 已是极限）会把**可判定性**换成口感。

### 判据与防线

- **不在** `REPLACEABLE_PROMPT_BLOCKS`，且不受 `plan.replaces` 管辖：容器级本体，轨迹层无权替换。
- 新增 3 条用例（共 37）：四段承重句俱全 ＋ **两处取回词的专项钉** ＋ **装配顺序钉**。
- **变异两处各自精确红**：从装配里摘掉 `soulBlock()` ⇒ 顺序用例红；删掉 `inherently` ⇒ 两条红（专项钉 ＋ 承重句）。
- 🔴 一处**写测试时的假红**已修：正文手排折行 ⇒ `I create,` 与 `for` 被折开、`toContain('I create, for')` 假红。
  ⇒ 断言前统一 `\s+ → 空格`。**折行是排版事实，不是语义事实。**

### 已知代价（D255：条件与保证同句说）

本块 **1,150 字符、每请求注入**。它与 v1.134.0 的精简（−3,495）不同向：那一次砍的是解释与强调语气，
这一次加的是**本体**。体量换来的东西已逐句指认（见源码注释"能被哪条判据接住"），否则它就是纯装饰。

### 门禁

`typecheck` ✓ ／ `test` **239 files / 3645 tests** ✓。

---

## v1.136.1 — 2026-11-15（中断续跑正文英文化：v1.136.0 ③ 漏掉的一处）

> owner 2026-11-15 截图指出：**中断续跑那条注入消息仍是中文**。
> v1.136.0 的 ③ 扫了 `seams/` 与 `tools/` 的 description，**漏了 `trajectory/` 下的注入正文** —— 而
> `buildContinueText()` 恰恰是**每轮真被注入进提示词**的那一段。

### 改了什么

| 面 | 处置 |
|---|---|
| `buildContinueText()` | 首行身份 ／ 事实陈述 ／ 副作用警告 ／ **两种"没跑完"的判据句** ／ 结尾说明 —— 全部英文 |
| `formatPendingTools()` | 折叠尾巴 `等共 N 项` → `${n} total` |
| `rebuild.ts` | 抛错文案里的 `--summary <内容概括 ≤20 字>` → `<one-line summary, ≤20 chars>` |

🔴 **判据句逐条保留，只换语言**：`不构成任何授权` → `grants no authorization whatsoever`；
「等 owner 拍板」与「手工停止不会被续跑」两句**一字未减** —— 它们是 D-something 里用真实代价换来的护栏，翻译不许顺手简化。

### 一处判据修正（顺带发现的真缺陷，不是翻译引起的）

`「清单超上限 ⇒ 折叠」` 那条用例原先断言 `t.length < 1000` —— 那是**中文**下的实测值。
正文改英文后同样内容变成 1484 字符 ⇒ **断言变红，而折叠机制一个字都没坏**。
⇒ 改为**尺度不变**判据：拿「150 项」与「9 项」两种输入**比长度差**（折叠生效 ⇒ 差值是常数级；折叠失效 ⇒ 差值是 141 个名字的长度）。
⚠️ 这比写死阈值强：它不随语言／措辞／长度单位漂移，只钉真正要保的性质。
**变异已验**：把折叠去掉 ⇒ 该用例精确红（另一条折叠用例同时红，两者互不掩护）。

### 刻意**不**改的（判据：不进模型上下文）

- `prompt-injection.ts` 的 `problems` 文案 —— 只经 `console.warn` 给人看，**不进上下文**。
- `rebuild.ts` 的 `console.warn` ／ `subscriptions.ts` 的告警 —— 同上。
- `source: '轨迹约束-legacy'` —— 那是**历史标记值**，改了会与存量记录对不上。

### 门禁

`typecheck` ✓ ／ `test` **239 files / 3642 tests** ✓。

---

## v1.136.0 — 2026-11-15（ACP 下架 / LOG 转进 ACC / 注入面英文化 / README 重写）

> owner 四项令（逐字）：「1.ACP已经下架了，所有的代码清除，监听端口也清除 2.LOG式的轨迹交接记忆设定
> 在我们轨迹验证了效果不错，需要升级到ACC层 代替老方案 3.所有的ACC注入式提示词全部改为使用英文
> 4.ACC github的 README要完整重写」

### ① ACP 全量下架

删 CCC 配置里 `im.channel="acp"` 整段 ／ `guard/seam.ts` 的 `acp-` 死前缀分支（**测试翻转为反向钉**：
钉「它已不在」，将来有人加回来会红）／ `guard/filter.ts` 的 `acp-core` 敏感词 ／ `msm` 工具文案。
端口面本就干净（只有 3080 宿主 / 3081 网关 / 3082 微信发送）。

🔴 **刻意保留一处**：`im/route.ts` 的 `isUnifiedImSection()` 里两条 **ACP 形状判别**。
ACP 的**实现**已删，但**别的 CCC 的配置里可能还留着** `im:{channel:"acp",…}` —— 删掉判别会让残留被当
新配置读 ⇒ 得到没有 `accounts` 的怪对象 ⇒ **"配置没生效"且不报错**。
⇒ 判据：**清功能 ≠ 拆护栏**。边界已写进源码注释。

### ② LOG 式交接记忆升级到 ACC 层（`src/trajectory/carrier-log.ts`）

把「每轮提醒 AI 记得轮转 LOG」这条**纪律**（soft，原型在 S142 轨迹验证过效果）改成**重建路径上的机械动作**（hard）。

| 判据 | 实现 |
|---|---|
| 什么算"空" | 剔除空行 / 标题行 / 引用块后还有没有字。⛔ 否则**刚开的新代会立刻被判"可冻结"** ⇒ 产出垃圾归档 |
| 冻结名 | `LOG-<YYYY-MM-DDTHHmm>.md`（本地时区、分钟级；**字典序即时间序** ⇒ 不需要指针） |
| **永不覆盖** | 目标已存在 ⇒ 加 `-2`/`-3`… 循环取下一个空位；`rename` 之后**回读字节数**校验 |
| 失败 | **不阻断 rebuild**（用秩序换可用性是反方向），但**必须 warn** —— 静默失败等于"看起来像没轮转" |

**接线**：`queueRebuild` 在 `appendBound` 之后、入队之前调用；`rotated && !verified` ⇒ 响亮告警。

**测试**：`tests/carrier-log.test.ts` **13 例** ＋ `rebuild-executor.test.ts` 增 **W1~W3**（走真
`queueRebuild`、无 LOG 时是空操作、**轮转失败不阻断主流程且必须 warn**）。
**变异两处各自精确红**：去掉 `-2` 避让 ⇒ L4/L4b 红（其余 11 例不动）；`catch` 改成 `throw` ⇒ W3 红。

### ③ 注入式提示词英文化

逐面核过后，**11 个 `*Block()` 注入块本来就全英文**。真缺口在别处：

| 面 | 处置 |
|---|---|
| **`buildResourceIndex()`** | 🔴 最重的一处 —— 它**每请求、每个 skill** 都进系统提示词（顶层标题 / `🧬 已建模` 句 / `子目录 · N 个文件` / 截断句全中文），已改英文 |
| `container_git` | tool description ＋ 三条参数说明（**D310：description 就是每轮进模型上下文的那一面**） |
| `container_admin` | description ／ `note` ／ `docs` 指针文案 |
| 测试字面量 | 6 处跟着改，含**一条负控** —— 不改就会变成永远为真的空断言 |

### ④ README 完整重写（中英两份）

旧 README 的问题不是文笔，是**三类在撒谎**（全部对照源码核过）：
① 写「十四个工具」而表里只有 **13** 行，且**整个漏掉 `browser_slot`**（v1.128.0 加的常驻工具）；
② `dashboard` 写着 `wait`（已砍）；③ FAQ 教 `autoReplyWithLastMessage` / `fallbackOnNoSend` 怎么配 ——
**两个键 D238 已整条退役**，且写的是与现在**相反**的行为。

新结构：先立**三个概念**（CCC ／ 认知轨迹 ／ 会话＝可重建载体），后面每节都挂在它上面；新增
**「已退役动作与键」**一栏（读到它们是上游资料陈旧，不是用户配错）；机械约束表新增**日志自动轮转**。

🔴 一处自伤登记：包内 README 是**生成物**，我先在它顶部加了警示注释，随后 `readme-sync` 把整个文件覆盖。
⇒ 判据：**生成物的"警示"要写在生成器里，⛔ 不写在生成物里。**

### 门禁

`typecheck` ✓ ／ `typecheck-host 0.2.2-rc.1` ✓（paths 37+22 全命中）／ `test` **239 files / 3642 tests** ✓
／ `coverage` **91.87% stmt** ✓ ／ `build` ✓ ／ `pack-check` **190 文件** ✓。

---

## v1.135.0 — 2026-11-15（操作员宪章：身份定义重写 + `creedBlock` 新增）

> owner 令（逐字）：「我愈发的意识到认知，或者说意识形态，或者说顶层思考的形状，是决定宁静号运行
> 整体效率和规模的核心；所以我需要强化并提炼它到明确」＋ 五条品质定名（以人为本 / 充沛的探索 /
> 不停歇的质疑 / 缜密的逻辑推理 / 澎湃的创造力）。
> 正文经 owner **三轮审阅**（A/B 对照 → 定稿 → 原样上线），他明示「我不担心大原样上线」。

### 两块（不是一块）

| 块 | 变化 |
|---|---|
| `=== Serenity ACC ===` | 469 → 795（+326）。「运行在容器里的程序」→「站在桥上、掌舵一条持久认知轨迹的操作员」 |
| `=== Serenity Operator Creed ===` | **新增**，4,608 |

**合计净增 +4,934** —— 与 v1.134.0 的精简（−3,495）**基本抵消并超出**。
这不是回退：那一次删的是**解释与强调语气**，这一次加的是**身份与判据**。

### 结构（owner 定稿，⛔ 改前先读）

1. **三段承重句**（主句 = 会承担后果的人，不是系统自身）：家人要带着后果活下去；后来的轨迹会把我们的记录当先例；**他们两个都无法审计这份工作**。
2. `What that obliges:` 过渡行 —— 把"义务"焊到"五条"上。**没有它，五条会被读成另一段清单。**
3. 五条品质，每条自带判据（⛔ 不是形容词）。
4. `Not this, but that` 收束：凡有两种读法处，第二种是我们欠下的。

🔴 **三段必须在五条之前**：它是**道德前提**，五条是**操作判据**。
前提在后 ⇒ 五条会被读成"提高效率的五个技巧"，而不是"对某个人负责的五个义务"。

### 落位判据（为什么独立成块，且**不进**可替换集）

- `identityBlock` 是**纯机器寻址契约**（CCC 名 ／ 路径相对性 ／ MSM 入口），且在
  `REPLACEABLE_PROMPT_BLOCKS` 之外 —— **身份块刻意不可被轨迹替换**。把品格塞进去 =
  让一个「不许覆盖」的块承载「每条轨迹本该各有版本」的内容，**语义装反了**。
- 宪章是**容器层宪法** ⇒ 同样不进可替换集。要个性化走 `PROMPT.md`（`append`）。
  「每条轨迹一个品格」等于没有品格。
- 顺带澄清一处：让轨迹 `replaces: ["creed"]` **当前会静默失效** ——
  词表在 `trajectory/prompt-injection.ts` 的 `REPLACEABLE_PROMPT_BLOCKS`，不在表里的名字
  被判「不可替换的块名」并忽略。要支持它需同批改词表 ＋ `policy/profile.ts` 的类型，
  属协议级改动，**本轮有意不做**。

### 中文全文

`docs/operator-charter.md` —— 英文是契约，中文是它的血（不是译本），另承担英文做不到的一件事：**给五条起名字**。
⛔ 装配缝里**不附中文四字锚点**：现有 7 块标题全英文，装饰性双语与 emoji 同族（owner 2026-11-14 禁令）。

### 门禁与变异

- `test` **1030 suites / 3632 tests 全绿**；`coverage` 91.84% stmt；`build` OK；`pack-check` 190 文件 OK
- **变异两处各自精确红**：删「So we begin from the person, not from the task」⇒ 红 1；
  注释掉 `parts.push(creedBlock())` ⇒ 红 1

### 本轮被门禁抓到的两处真问题（不是我事后发现的）

1. **`docs-ref-gate.test.ts` 当场红** —— 我在源码注释里点名 `docs/operator-charter.md` 但文件没建。
   门禁精确报出「谁在点名它」。
2. **`--- What that obliges ---` 撞了机器契约** —— 装配层有 `not.toContain('---\n\n')`
   （不许出现 YAML frontmatter 分隔线形状），我的小标题正好构造出那个串 ⇒ 改 `What that obliges:`。
   **改的是内容，不是断言。**

### 一处自我更正（如实登记）

压到 4,096 时我曾顺手改了第 4／5 条的**判据句措辞**（`preserve the blueprint over the statue`
→ `Keep the blueprint, not the statue`），而没意识到那两句正是测试钉着的。
owner 说"原样上线"后**已逐字恢复定本**，措辞改动全部撤销。
教训：**"删修饰"与"改判据"是两件事**，压缩时必须逐句分清。

---

## v1.134.0 — 2026-11-14（核心提示词精简 41%；禁止用 emoji 表达状态）

> owner：「核心提示词的尺寸我想缩减下，保留故事和框架，少一些约束性」＋「新增不允许使用 emoji 恢复或写文件」。
> 逐块前后对照经 owner 审阅两轮后放行；**EAP 块明确放弃精简**，整块回滚。

### 体量（渲染后逐块称重）

| 块 | 前 | 后 | 变化 |
|---|---:|---:|---:|
| ACC 身份 | 700 | 469 | -33% |
| CCE | 2,310 | 834 | -64% |
| Principles | 1,634 | 1,309 | -20% |
| EAP | 566 | 566 | 0（整块回滚） |
| Metaphor | 3,301 | 1,838 | -44% |
| **合计** | **8,511** | **5,016** | **-41%** |

### 判据：留故事与框架，删重复解释与强调语气

- **ACC**：删唯一一个 emoji；删长示例路径与工具名枚举；MSM 指引压成一行。
- **CCE**：删 `FIVE BEHAVIORAL CONSTRAINTS (engineering requirements, not suggestions):` 抬头与五条各 2~3 行解释；
  删与 H_op 段重复的整段 `THIS IS PERSISTENCE ENGINEERING`；`ΔH_org >= ΔH_in` 换成同一判据的自然语言。**五条名字一个没少。**
- **Principles**：去 `Why a cognitive container:` 设问句头并句；本体论 / session 关系 / MSM 三原则 /
  四条边界（**含 `wait for user "use" or "使用" to confirm` 逐字**）一字未动；末尾新增 emoji 禁令。
- **Metaphor**：删各条后的比喻展开与重复的 H_op 句；`→` 改 ASCII `->`。**十景与判决句全部保留，编号 1–10 未变。**
- **EAP**：owner 裁定放弃 ⇒ 回滚为原稿，一个字符没动。

### 新增禁令

```
Style: plain text. Do not use emoji to mark status, to soften an error, or to decorate
a file or an answer — say it in words.
```

⚠️ **边界如实登记**：该禁令约束的是**表情符号**；`E↑` `R↓` `S↑` `→` `Δ` 这类数学/箭头符号
**不在禁令内**（EAP 回滚后它们仍在）。要收它们需要另一条令。

### 证据

- `typecheck` 通过；prompt 相关 **3 files / 59 tests** 全绿。
- 测试只改断言字符串（旧措辞 -> 新措辞），⛔ 没删任何断言；EAP 与 Session-first 的断言随回滚一并还原。

---

## v1.133.0 — 2026-11-13（点击前做**命中判定**：视口外 ／ 被盖住 ／ 空白）

> owner 2026-11-13 同意按 **B → A → F → C/D → E** 的顺序做；这是 **B** —— 调研里最贵的那个缺口
> （`references/browser-cdp-landscape-2026-11-12.md` §5）。

### 原来坏在哪

`click --xy` 的回执说「我点了哪里」。而下面三种情况 CDP **一行都不报**，回执照样写着 `clicked @x,y`：

| 形态 | 真实发生的事 |
|---|---|
| ① 坐标**在视口外** | 事件发出去了，视口里没有这个点 ⇒ **什么都没发生** |
| ② 目标**被别的元素盖住**（弹层／固定头／遮罩） | 点到了上面那个 ⇒ **执行了另一个元素的处理逻辑** |
| ③ 点在**空白处** | 那里没有元素 |

⇒ 判据：**「发了鼠标事件」与「点到了目标」是两件事**（D311 的坐标版）。
回执必须回答后者，并且**答案要能在下一步被验证**。

### 修法

- **新增** `src/browser/hit-test.ts`（纯判定，可逐条单测）：`judgeHit` 四态 `ok` / `blocked` / `blank` / `offscreen`；
  `renderHit` 渲染成一句能被下一步验证的话 —— ⛔ 不写「点击成功」这种无法证伪的话
- **取数** `cdp.ts: hitTestAt`：用 `DOM.getNodeForLocation`（**合成器的真实命中逻辑，与真实点击同一套**），
  ⛔ 不用页面里的 `document.elementFromPoint`（DOM 侧的另一份实现 —— 有宿主自带实现就别复刻语义）。
  节点身份取 `backendNodeId`，⛔ 不比 tag／文字（同名不同 id 正是「点到了旁边那个按钮」那个事故形态）
- **判定接线** `service.ts: slotClick`：**点之前**先判；`offscreen` ／ `blank` ／ `blocked` **一律不点并拒绝**，
  拒绝文案给出去路（先 scroll ／ 先用 `ax` 看那一层 ／ 改用 `--ref`）
- **回执**：`clicked @x,y｜命中：<button id="…">`（`--xy` 与 `--text` 两条路都带）；`--ref` 参与判定

### 证据

- 新用例 `browser-slot-hit-test.test.ts` **H1~H8**；**变异两处各自精确红**
  （去掉视口判定 ⇒ H1~H3 红；改成比 tag 而非身份 ⇒ H6 红）
- `typecheck` ✓ ／ `test --filter browser-slot` **18 files / 210 tests** ✓ ／ `build` ✓
- ⚠️ **如实登记**：取数那一段（`hitTestAt`）**单测造不出来**（要有真 Chrome 的合成器命中测试）⇒ 它的判据只能真机验。
- ✅ **已真机验（装机 1.133.0 后）**，四种形态各自的读数：

  | 场景 | 回执 | 页面副作用（**这才是判据**） |
  |---|---|---|
  | 目标上盖着一个 `div`，点那个坐标（不给 ref） | `clicked @250,260｜命中：命中 <div id="cover">` | 文案变成 `COVER-CLICKED` ⇒ **回执说的和实际发生的对上了** |
  | 同上，**但给了 `--ref=e7`** | `⛔ 不点：落点被 <div id="cover"> 接住了（backendNodeId=2，期望的是 7）` | **页面零变化** ⇒ 真的没发事件 |
  | 坐标 `5000,5000`（视口 1568×867） | `⛔ 不点：不在视口内（视口 1568×867）` | 无事件 |
  | 撤掉遮罩后用 `--ref` 点 | `clicked @250,260｜命中：命中 <button id="target">` | `TARGET-CLICKED` |

  🔴 **一个反例（照实写，而且它是对的）**：点空白处（`900,800`）回执是 `命中 <body>` 而**不是** `blank` ——
  因为 `DOM.getNodeForLocation` 在留白处**会返回 `<body>`**。⇒ `blank` 只在"该点上没有任何节点"时出现；
  判"点在空白"要看回执里**命中的是谁**，⛔ 别指望 `blank`。

---

## v1.132.0 — 2026-11-13（坐标参数收三种形态；并测出「PTC 签名只有一维」）

> owner 2026-11-13 截图报「本轮运行失败 / `MALFORMED_RESPONSE`」。

### 根因（**不在点击逻辑里**）

错误发生在**参数 JSON 解析阶段** —— 工具一次都没执行。`xy` 原本只声明成 `string`，
模型想传两个数字时写出了裸两个值 `{"xy": 1428,76}` ⇒ JSON 坏掉。
判据：**schema 的形状会改变调用方的写法**。收窄参数类型，等于逼调用方把自然表达序列化进字符串。

### 修法

| 文件 | 改了什么 |
|---|---|
| `src/browser/coords.ts`（新） | `parseXY` 收 `"x,y"` ／ `[x,y]` ／ `{x,y}`；`xyFormHint` 列三种写法（拒绝时只列一种 = 又把口子收窄回去） |
| `src/tools/browser-slot/index.ts` | `xy`／`from` 改 `oneOf` 三支；4 处调用点去掉 `str()` 包装（它只认 string，会把数组/对象当"没给"） |
| `tests/browser-slot-coords.test.ts`（新） | C1~C11：解析层判据 |
| `tests/browser-slot-xy-schema.test.ts`（新） | S1~S3：**跑宿主自己的编译＋校验器**（非复刻），取 `createBrowserSlotTool()` **编译后**的 schema |

### 🔴 对象支的形状是**试出来的**，四种写法只有一种能用

| 写法 | 结果 |
|---|---|
| `{type:'object', additionalProperties:true}` | 任何对象都命中 ⇒ 非数字分量被放行 |
| `{enum:[{}]}`（想表达"任意对象"） | **恒不命中**（枚举匹配只认标量）⇒ 对象形态整体被拒 |
| `{…properties, required:['x','y']}`（分支级必填） | **最低档宿主编译失败** ⇒ `defineTool` 在创建时就抛 ⇒ **整个工具消失**，而单测只要不构造工具就照样全绿 |
| ✅ `type:'object' + properties{x,y 各带 required:true} + additionalProperties:false` | 三形态**各自恰好命中一支**；非数字／缺分量／多余键**照旧被拒** |

判据：**收得宽 ≠ 判得松**。schema 管**形状**，`parseXY` 管**内容**（分量个数／有限数／非负）。

### 🔴 顺带测出的一条：**schema 能力 ≠ 模型看得见的能力**（有延迟，别把旧读数当现状）

`renderToolsSdk`（PTC）把每份 schema 先过 `assertSupportedJsonSchema`，
**任何抛错都被 `catch` 成 `unknown`** —— 于是签名可能退化成单形态。

⚠️ **本版实测的完整经过（写下来是因为我中途读错过一次）**：
修完并重启后，模型签名仍是旧的 `xy?: string`，我据**本会话日志里的旧 manifest** 判成"PTC 永久一维化"；
**约 10 分钟后复查，签名已变成 `string | number[] | {x,y}`，且真机 `[200,240]` 形态点击成功**。
⇒ 判据：**"看到一维签名"的读数必须带时刻**；模型签名有**生效延迟**，与"真的不支持"读数上不可分
（D120 同族：装了 ≠ 跑了 ≠ 生效了）。⛔ 别拿修前/重启前的 manifest 给能力下定论。
判据进 `references/70-browser-surface.md`（§3 坐标参数一节）。

### 门禁与证据

- `typecheck` ✓ ／ `test --filter browser-slot` **17 files / 202 tests** ✓ ／ `build` ✓ ／ `pack-check` 189 文件 ✓
- 变异四例各自精确红：数组不校验个数 ⇒ C5；负数放行 ⇒ C7；`additionalProperties:true` ⇒ S2；
  分支级 `required` ⇒ **编译失败**
- 真机（v1.131.0 装机版，即修前）：`click xy:"200,240"` ⇒ `clicked @200,240` 且页面证明 `INIT → CLICKED`（**副作用**，非回执）
- ⚠️ 全量 `test` 有 **7 个失败文件与本笔无关**（cordis/storage peer 解析、PATH 上假 git/tsdown、一条已登记的 `待裁` xfail）

---

## v1.131.0 — 2026-11-11（原生弹窗**自动处理**：不再因一个 `confirm` 卡死整条流程）

> owner 现场报障（截图）：「**这个要想办法攻破；避免实际使用过程中这种东西直接阻断过程**」。
> 截图里那个「此网页显示 · 确定要删除吗？」的框，是把整条自动化**原地钉死**的那个东西。

### 现象与代价

点一个会 `confirm()` 的按钮 ⇒ **弹窗留在屏幕上** ⇒（1）`click` 30s 超时；
（2）**该 tab 之后所有 CDP 调用全部超时**（`Runtime.evaluate` 等 10 秒后仍是超时）；
（3）只能 `close` 掉这个 tab 重来 —— **已经做过的操作全部作废**。

### 为什么「点完再手动调 `dialog`」是错的设计

v1.130.0 提供的是 `dialog` 动作，需要调用方在点击**之后**主动调它。
这要求调用方**预知「这一下会弹窗」** —— 而真实站点里弹窗常由页面逻辑触发
（离开确认／删除确认／会话过期重登／表单离开警告），**没有任何人能在点击前知道**。
⇒ 正确的形态不是「事后补救」，而是「**持续在场，事件一到就处理**」。

### 修法（顺序不可换，反面即 D320）

```
同一条连接上：Page.enable  →  再发点击  →  事件到达时立刻 handleJavaScriptDialog
                              ↑ 被 confirm 阻塞在这里          ↑ 由浏览器进程处理，
                                                                不经过被阻塞的渲染器
```

| 要点 | 为什么 |
|---|---|
| **必须同一条连接** | `Page.javascriptDialogOpening` 是这条连接上的事件；换连接收不到 |
| **必须 `Page.enable` 在前** | 不 enable 就没有事件 —— 那就只剩轮询猜测 |
| **必须是 `handleJavaScriptDialog`** | 它由**浏览器进程**处理，所以在「点击请求还挂着」时也能生效；任何要渲染器响应的方法都会一起卡住（D320） |
| **回调必须 fire-and-forget**（`void send(...)`） | 事件回调是同步的；`await` 会堵住消息循环 ⇒ 所有调用一起超时 |
| **处理完点击才会返回** | 这就是「弹窗被处理后流程继续」的机制本身，不是副作用 |

### 默认与可见性（两条判据）

- **默认 `dismiss`**（判据 D318：不可逆性小的那一侧）。`confirm` 的「确定」在真实站点上常意味着**删除/支付/发布**。
  要 accept 必须显式：`dialog --accept`，或者调用方自己设 `autoDialog.mode = 'accept'`。
- 🔴 **回执必须报出自动处理掉了什么**（⛔ 静默替你点「取消」是另一种欺骗）：

```
[browser_slot] clicked <button> "弹确认框" @53,173
  ⚠️ 自动处理弹窗 confirm："确定要删除吗？" ⇒ 已取消
  （默认取消；要「确定」请单独用 dialog --accept —— OK 常意味着删除/支付/发布）
```

### 未捕获时的出路（⛔ 不甩裸超时）

若 20s 内点击仍未返回且**一个弹窗都没捕获到**，报错要说清「页面可能被同步脚本卡住」
并给出三条出路（`dialog` 试救／`close` 重来／注意自动处理只对**本连接期间新出现**的弹窗生效）。

### 门禁

- 新增用例 **6 条**（`browser-slot-dialog-auto.test.ts`）：钉住 clickAt 挂策略、withPage 默认 dismiss、
  回调 fire-and-forget、回执报出、以及「默认必须是取消那一侧」。
- **两处变异各自精确红**：默认改 `none` ⇒ D2 红；回调改 `await` ⇒ D3 红。
- test **231 files / 3574 tests** 全绿。

---
## v1.130.3 — 2026-11-11（`dialog`：先 `Page.enable` 会把被弹窗阻塞的页面再卡 30s）

> 又一条**只有真机才抓得到**的缺陷（单测发不出 confirm，也就测不到这条路）。

**现象**：`click` 一个会 `confirm()` 的按钮 ⇒ 点击 30s 超时（页面同步阻塞，**这是预期的**）；
接着调 `browser_slot dialog` 去救 ⇒ **`Page.enable` 自己超时 30s** ⇒ 弹窗一直挂着，页面**永久卡死**。

**定因（裸 WS 直连对照）**：

| 发什么（页面已被 confirm 阻塞） | 结果 |
|---|---|
| `Page.enable` | **挂住**（它要往渲染器要一次响应，而渲染器正停在 `confirm()` 那一行） |
| `Page.handleJavaScriptDialog{accept:false}`（**不 enable 直接发**） | **立刻返回**（由浏览器进程处理，不经过被阻塞的渲染器） |

⇒ 判据：**在「页面已阻塞」这个状态下，任何需要页面响应的方法都不能排在前面。**
⇒ 修法：**先直接发 `handleJavaScriptDialog`**（8s 超时），只在需要**事件面**（拿弹窗类型与正文）时事后补 `Page.enable`。

**代价如实登记**：不 enable 就拿不到 `Page.javascriptDialogOpening` 的 `type`/`message`，
所以 `hadDialog=true` 时这两个字段多为空。判据是「**先把页面救回来**」—— 类型/正文属附加信息，
要它得在弹窗出现**之前** enable，那是调用方的编排问题，不该由这一个动作擅自决定。

超时时给明确出路（`close` 这个 tab 重来），⛔ 不让调用方反复重试一个已经不响应的 target。

---
## v1.130.2 — 2026-11-11（`scroll` 的真机缺陷：Wayland headed 下 `mouseWheel` 会挂住 30s）

> 真机验收抓出来的，不是测试抓出来的（测试全绿，因为**没有任何单测会去发 wheel**）。

**现象**：`browser_slot scroll --to=bottom` 报 `CDP Input.dispatchMouseEvent 超时 30000ms`。

**定因（三档对照实验，同一台机、同一 Chrome 157）**：

| 发什么 | 结果 |
|---|---|
| `mouseMoved` / `mousePressed` / `mouseReleased` | **立刻返回** |
| `Input.dispatchMouseEvent{type:'mouseWheel'}` | **30s 超时** |
| `Input.synthesizeScrollGesture` | **同样超时** |
| 同机另起一个 `--headless=new` 实例发同一个 wheel | **立刻返回** |

⇒ 根因在 **headed + Wayland** 这一档：窗口被节流/遮挡时合成器不确认输入，而 CDP 的 wheel **等确认**
（`mouseMoved` 是 fire-and-forget，所以它不受影响）。**不是参数写错，也不是我们的连接有问题**
（用裸 WS 直连、最小参数复现同样超时）。

⚠️ **不修根因是刻意的**：能治它的 flag（`--disable-renderer-backgrounding` 一族）正是 2026-11-09
那次 **36 小时耗电事故**的成因 —— 那两个名字反着来，它们**禁止**浏览器节流后台窗口。
⇒ 该节流是预期行为，⛔ 不为让 wheel 好用去关它。

**修法（判据：一种能力不能「挂住」）**：等 30s 再失败，等于把「滚不动」变成「卡死 30 秒」，
而调用方无从区分两者。⇒ wheel 超时收到 **4s**，超时后回落 JS `window.scrollBy`，
**并在回执里写明走的是哪条路**：

```
[browser_slot] scroll → scrollY 变化 +1600px （真实 wheel 事件）
[browser_slot] scroll → scrollY 变化 +1600px （⚠️ 回落 JS 滚动 —— …本次没有产生 wheel 事件，
                                              靠 wheel 触发的懒加载不会启动）
```

🔴 **回落不是等价物**：JS 滚动不产生 wheel 事件 ⇒ 只监听 wheel 的懒加载不会触发，
而 `scrollY` 照样变。两个读数（动了 / 加载了）都会「看起来正常」⇒ 所以必须**可见**，⛔ 不静默替代。

**新增用例 4 条**（`browser-slot-scroll-contract.test.ts`）：钉住 ① 返回带 `via` ② wheel 超时必须 ≤5s
③ 回执必须说出走了哪条路 ④ 正控（证明抽取器真读到东西）。变异：超时改回 30s ⇒ **S2 精确红**。

门禁：test **231 files / 3574 tests** 全绿。

---
## v1.130.1 — 2026-11-11（同 v1.130.0 内容；1.130.0 被 npm 暂存位占用，见文末）

> ⚠️ **为什么版本号是 1.130.1 而不是 1.130.0**：第一次 `npm publish` 超时中断，但**暂存动作已在 registry 落地**
> （`E409 Cannot publish over previously staged version "1.130.0"`），而 `npm stage list` 看不到它、
> 也无从取 stage id ⇒ 换版本号是唯一不需要「猜一个 id 去 approve」的做法（猜错会动到别人的东西）。
> 内容一字未改。

### v1.130.0 内容（`browser_slot` 高阶页面动作：键盘／填值／滚动／等待／拖拽／AX／上传／下载／dialog）

> owner 令（2026-11-11）：「接下来完善浏览器操作的 tool 吧，提供尽可能强大的能力」＋「A+B 一起」。
> A = 高频且判定简单的（键盘/填值/滚动/等待/拖拽）；B = 有副作用面、判定比实现更值钱的（上传/下载/dialog/AX）。

### ① 新增 10 个动作（页面层 9 → 19）

| 动作 | 做什么 | 关键判据 |
|---|---|---|
| `ax` | 无障碍树快照 → `ref`（如 `e12345`） | **ref = `backendNodeId`，⛔ 不是遍历序号**。序号只在本次快照里成立，换快照就指向别人，**零信号** |
| `press --key` | 语义键与快捷键 | `keyDown`→`char`(仅可打印)→`keyUp` 三事件；只发 keyDown 输入框里没字，只发 char 则 keydown 监听全不触发 |
| `type --text` | 浏览器文本输入路径 | 作用于**当前焦点**；⛔ 不触发 `change`（blur 才触发）—— 要设值用 `fill` |
| `fill --ref --value` | 设值 | **必须用原型原生 setter**（`el.value=` 在 React 下不触发 onChange ⇒ 界面有值、提交用旧值，永不报错）；`contenteditable` 走 `execCommand('insertText')` |
| `scroll` | 真实 wheel 事件 | ⛔ 不用 `window.scrollTo`：它不触发懒加载/虚拟列表，而 `scrollY` 看起来「成功了」 |
| `wait --for` | 五形态条件（`selector:`/`text:`/`url:`/`gone:`/`js:`） | **页面内轮询**（宿主侧轮询每 200ms 一次往返，等 30s=150 次，且每次都可能撞上导航）；**裸值拒绝**（无前缀=形态不明）；**超时说清等的是什么 ＋ 最后一次读数是啥** |
| `drag --from --to` | 拖拽 | 默认 12 步 `mouseMoved`：**一次跳到终点**会被 sortablejs/dnd-kit 判为不构成拖拽，而回执一模一样 |
| `upload --ref --file` | 文件上传 | 路径**必须在 CCC 根内**；**文件必须真实存在**（`DOM.setFileInputFiles` 对不存在的路径**静默成功**） |
| `downloads` | 下载捕获 | 落点**固定** `_tmp/browser-downloads/<slot>/`（默认行为会弹系统框卡死自动化，或落到看不见的地方）；**不自动清理** —— 清掉的是证据 |
| `dialog` | 原生 alert/confirm/prompt | **默认 dismiss**（「确定」在真实站点上常意味着删除/支付/发布）；**没有弹窗时是正常状态**，⛔ 不报错（不处理则整页卡死，处理了但没有也报错，两种都得对） |

### ② 实现面的两条收敛（都为了让「失效有信号」）

- **连接生命周期只留一份**：新增 `withPage`/`withBrowser` 两个高阶封装。原有 10 个动作各自 `attach`+`finally close` 的形态不再复制到新动作上 —— 照抄十几份，必然有一份忘了 `finally`，而那一份的表现是**槽位被一个不死的 WS 攥着**。
- **判定与执行分家**：`keys.ts`（按键解析）、`ax.ts`（剪枝/ref/渲染）、`wait-spec.ts`（条件解析）三个**纯函数模块**，可逐条单测；`cdp.ts` 只管发 CDP，`service.ts` 只管归属守卫与编排。

### ③ 三条新判据（D 族）

| # | 判据 | 代价来源 |
|---|---|---|
| **D316** | **ref 是身份，不是索引** —— 顺序编号（`e1,e2…`）只在本次快照成立，DOM 一变就指向**另一个元素**，且没有任何读数会显示这件事（与 D311 的 `--match` 选错 tab 同族，但更隐蔽：选错 tab 还能从图里看出来，点错元素看不出来） | 变异检验：把 `ref` 改成 `out.length+1` ⇒ A1/A2 **精确红 2 条** |
| **D317** | **「键盘键入」有两条互不替代的路，选错是哪条取决于要不要触发 change** —— `insertText`（走浏览器文本路径，受控组件收得到，但不触发 change、依赖焦点）vs 原生 setter+`input`/`change`（设值，不依赖焦点）。⛔ 二者不互相回落：回落后「打了字但提交是旧值」与「设了值但组件没更新」无从区分 | 两者都缺的表现都是「脚本成功、界面没反应」，零报错 |
| **D318** | **有副作用的动作，默认值必须选「不可逆性小」的那一侧** —— `dialog` 默认 `dismiss`（不是 accept）、`downloads` 固定落点（不让传）、`upload` 只许 CCC 根内（不放宽）。判据：默认值会被**不读文档的人**用，而这三件事的错向（确定删除/文件落到看不见处/本地文件外送）都不可撤销 | 反面先例：旧 `browser` MSM 的 `--arg` 透传能把出口改掉而读数与默认环境同形 |

### ④ 门禁与验收

- 六项门禁全绿：typecheck ／ typecheck-host 0.2.2-rc.1 ／ test **230 files / 3570 tests** ／ coverage 228 files / 3552 tests（92.21% stmt ／ 86.33% branch）／ build ／ pack-check 188 文件。
- 新增用例 **35 条**：`browser-slot-keys.test.ts` 11 ／ `browser-slot-ax.test.ts` 14 ／ `browser-slot-wait.test.ts` 10。
- **三处变异各自精确红**（互不掩护）：ref 改顺序编号 ⇒ A1/A2 红；接受 `Cmd` 别名 ⇒ K7 红；wait 接受裸值 ⇒ W1 红。
- schema 双向一致（D310）由既有 `browser-slot-schema.test.ts` 守住：新加 9 个参数（`ref`/`value`/`key`/`times`/`to`/`delta`/`for`/`from`/`steps`/`file`/`accept`/`prompt`/`limit`）全部声明 ⊆ 读取 且 读取 ⊆ 声明。

### ⑤ 未做 / 留给下一轮

- ⛔ **不做坐标级 hit-test 预检**：`drag` 的两个坐标由调用方给，工具不校验那里有没有元素 —— 校验需要一次额外 CDP 往返，而「拖错了」的判据本来就该由调用方用 `ax` 复核。
- ⛔ **不做 iframe 内自动穿透**：AX 树给的是**主帧**；跨帧操作需要 `Target` attach 到子帧，属另一套上下文管理。需要时写扩展。
- ⚠️ **本版未做真机验收**（见 SESSION 当前状态）：测试全绿 ≠ 正在跑的进程（D141）。

---
## v1.129.5 — 2026-11-10（两条 owner 现场报障：继续锚点被排队 ／ 中断兜底像在派活）

> 两条都来自真实使用：一条是 owner 在另一个 CCC 的界面上**被红框圈出来的**（"这个东西不应当排队，应当直接进"），
> 一条是 owner 问的**"这个行为哪里来的"**（模型在等拍板的轮次后自行续跑、并差点自我授权一次对外发布）。

### ① 换代时继续锚点必须"直接进"，⛔ 不排队

**现象**（`platform-9047` 换代真日志，逐字）：`seq 12` 是**载体开场白**落在 `next-turn`，
`seq 76` 才是**继续锚点**（也是 `next-turn`）。宿主 `inbox.claim('next-turn', …)`
**每个 turn 只认领 1 条** ⇒ 新载体**第 1 轮只拿到开场白**，而开场白正文写的就是
"接着它 SESSION.md 里的工作往下做" ⇒ **模型在读到锚点之前就开始干活**，锚点留在排队区等第 2 轮。

**修法**：锚点改走 `agent.inject()`（`next-step`，**不唤醒**），开场白仍走 `followup`。
`claim()` 的返回顺序是 **`next-step` 全部在前、`next-turn` 取 1 条在后**
⇒ 第 1 轮第 1 步拿到 `[锚点, 开场白]`，锚点在前。

| 判据 | 内容 |
|---|---|
| **`inject` 不是 `steer`** | `inject` = `send(msg,'next-step',false)`（不唤醒）；唤醒由开场白那条 `followup` 负责，**一条消息只唤醒一次**。用 `steer` 会多唤一次，且"插进正在跑的轮"在新 agent 上根本不成立 |
| **必须 `toMessage` ＋ `agent.inject`，⛔ 不用 `deliver(…, 'this-step')`** | `deliver()` 对 `this-step` **显式抛错** —— 那一档走 `additionalContexts` 返回，不是调 agent 方法 |
| **回调抛错不阻断** | 锚点没插上是真问题，但"会话建了却没投递"更坏 ⇒ 出声（回执写 `⚠️ 锚点前置失败（原因）`），不静默 |

⚠️ **没有在 `reconstruct.ts` 里再投一次锚点** —— 那会让同一份锚点在 `next-step` 与 `next-turn`
各有一份，模型连续两轮收到同一份"继续"指令。

### ② 中断兜底必须区分两种"没跑完"（⛔ 它不是授权）

**现象**（owner 截图，`platform-9047`）：那一轮其实是**正常结束、在等 owner 拍两个问题**
（删测试行 ／ 要不要现在发 develop），宿主重启把它记成 `turn/end{reason:{kind:'interrupted'}}`
⇒ 与「干到一半被掐」**在读数上完全同形**。模型于是把「等授权」读成「有活没干完」，
还自行推理出「owner 之前说过要发 develop」⇒ **差点自己授权了一次对外发布**。

**判据**：兜底**能证明的只有「这一轮没收完」，它证明不了「这一轮该由我继续做」** ⇒
正文显式说出两种情形，并明写「本条消息不构成任何授权」，且点名**不许翻历史找旧授权来顶替**。

**用例**（`tests/trajectory/interrupted.test.ts` 新增 3 条）：区分两种情形 ／ 明写不构成授权 ／
反向钉「这句话不许出现在开头」（先给事实，再给判断条件）。
🔴 这三条是**补的**：改文案前原有用例全绿（它们只钉了身份、副作用与折叠），
**没有任何用例钉住"等拍板算不算未完成"** —— 那正是最贵的一格。

### 门禁

typecheck 双半 ✓ ／ coverage **225 文件 3517 用例**（93.37% stmt ／ 86.38% branch）✓。
**变异检验**：把 `beforeOpening` 调用注释掉（等价于"锚点不前置"）⇒ `reconstruct-anchor-first.test.ts`
**精确红 3 条**，红的信息直指"inject 没发生"与"回执不含失败原因"；恢复后 4/4 绿。



> 两条都来自真用下来的对比（owner 拿 `msm cdp` 与 `browser_slot` 逐项比）：
> 「`msm cdp` 更好的两点：① `shot` 的 `--match` 能按 URL 子串选 tab，`browser_slot` 必须先取 targetId，多一步
> ② 有 `click --text/--xy` 这类语义化点击，`browser_slot` 只有 `eval`，点击得自己写 JS。」

### ① `--match`：按 URL / 标题子串选 tab（`goto` `eval` `text` `html` `shot` `reload` `close`）

省掉 "先 `targets` 抄 32 位 id" 那一步。但**这一步的代价必须由判定承担，不能由猜承担** ——
选错 tab 会产出一张**看起来对、内容却属于别人**的图，零报错、零信号。四条判据：

| 判据 | 内容 |
|---|---|
| **0 命中 ⇒ 拒绝** | ⛔ 不回落"唯一那个 tab"，也不算"当前激活页" |
| **多命中 ⇒ 拒绝** | 把候选**列全**，要求更长子串或 `--target` 点名 |
| **只认 `page` 类型** | `/json/list` 还含 iframe/worker/service_worker —— 它们有 id 但**不能截图、不能导航**，让它们参与匹配会把"匹配到了"变成"随后那一步才失败" |
| **身份 > 线索** | 给了 `--target` 就只认 id，⛔ 不做"id 没找到再按子串试"的回落 —— 那会把打错的 id 变成"恰好相符的另一个页面" |

### ② `click --text=<可见文字>` / `click --xy=<x,y>`

判定在 `src/browser/click-target.ts`（纯函数、可单测），执行用 **CDP 真实鼠标事件**。

🔴 **为什么不用 `el.click()`**：它只派发一次合成 `click`，**不产生 pointerdown/mousedown/mouseup**，也不做命中测试。
大量组件库（含 `choerodon-ui`、多数下拉/浮层）监听的是 `pointerdown`/`mousedown`
⇒ 用 `el.click()` 得到的是「脚本执行成功、界面毫无反应」—— **没报错，也没发生**。

🔴 **为什么点击的判据比选 tab 更严**：**选错 tab 只是退回来，点错元素是已经发生的事。**
于是 0 命中 / 多命中 / 命中但不可点（`disabled` ／ `aria-disabled` ／ 零尺寸 ／ `pointer-events:none` ／ `download` 链接）
**全部拒绝**，并把候选、坐标、禁用标记列出来。⛔ 不"尽力点一下试试" ——
**点了没反应与没点，在下一次读数里长得一样**，那正是最难查的一种错。

两条刻意不做的事：不点 `<input type=file>`（会开系统文件选择器，把自动化卡死）；
不点带 `download` 的链接（会产生本工具不追踪的落盘）。

⚠️ **回执只说"点了什么"，不说"点成功了"** —— 界面该变成什么样，属于调用方的判断
（本工具不知道这个按钮应该产生什么后果）。`--xy` 直给时回执会明写"未做命中校验"。

### 判据

**D311：便利与猜是两件事 —— 少一步必须由判定承担。**
「少一步」的收益属于调用方，「选错」的代价也属于调用方，而后者是静默的。
⇒ 凡是**选中**类的便利参数（`--match`、`--text`），判据一律是**「不唯一就不动」**，
⛔ 不是「猜得准一点」。这与 D310（读而没说 = 半个功能）互补：
D310 管参数**存不存在**，D311 管参数**被满足时动不动手**。

### 门禁

typecheck（node + client）✓ ／ coverage **224 文件 3510 用例**、93.42% stmt / 86.37% branch ✓ ／ build ✓ ／ pack-check ✓ ／
新用例 `browser-slot-pick.test.ts` **20 条** ✓。
**变异检验两处，各自精确红 1 条**：① 多命中改成取第一个 ⇒ `pickTarget` 多命中用例红；
② 忽略 `pointer-events:none` ⇒ 对应用例红。

🔴 **隐私门禁抓到我一次**：初版测试固件里用了真实 CCC 的名字当样例 URL/子串
（这个仓是 GitHub public）⇒ `privacy-scan` 报 4 处 `private-ccc-name-bare`，已全改成中性样例（`acme.test`）。
**这条门禁是对的，改的是我的固件不是它。**

---
：读 9 个参数却只声明 4 个）

> 功能一直是对的，坏的是**可发现性** —— 而可发现性决定了调用方会不会用。

### 现场（v1.129.0 引入，静默存在了两个版本）

`browser_slot` 的 `run()` 读 **9** 个参数，`parameters` 只声明了 **4** 个（`action`／`slot`／`wait`／`reason`）。
JS 忽略多余字段 ⇒ 传了会被正确使用，**不传也不会报错**，回归测试当然全绿。

实际后果：`url` / `target` / `js` / `out` / `max` / `all` / `name` / `earg` / `timeout` / `script`
在工具签名里**不存在**。调用方按 schema 调工具 ⇒ 永远不会传它们 ⇒ 只会收到
`⛔ 需要 --url=<地址>`。**这行拒绝看起来像"功能没做"，而不是"你没给参数"** ——
v1.129.0 把页面层九个动作搬进 `browser_slot`，但它的签名面还停在"槽位管理器"。

### 修

补齐 10 个参数声明（含 `earg` 声明为 `string[]`：契约是「重复的 key=value，值一律当字符串」，
⛔ 若声明成 object 会诱导调用方传 `{"k":"true"}`，然后在扩展里静默变成字符串）。
同时修掉 `ext-list` 回执里那句化石 `--eslot`（该 flag 全仓只在这一句里存在，早已不存在）。

### 判据：**读而没说 = 半个功能**

| 维度 | 判据 |
|---|---|
| **参数的"存在"由谁决定** | **schema**，不是 `execute` 里的 `args.x`。后者只有读过源码的人才知道 |
| **两个方向都要判** | ① 声明 ⊆ 读取（⛔ 不许有"声明了却不读"的骗人参数）② 读取 ⊆ 声明（⛔ 不许有"能用但看不见"—— 本次形态） |
| **⛔ 别用"文档里写了"补这一格** | 文档给人看，schema 给调用方看。写得再好的 `70-browser-surface.md` 也救不了一个 schema 里没有的参数 |

### 判据自身踩过的三个坑（都留在用例注释里）

写这条抽取器时连红三次，**每次红得都对** —— 是抽取器错，不是源码错：

1. **帮手读取**：`earg` 由 `extArgs()` 读，而它在 `run()` 之外 ⇒ 只扫函数体会把它算成"声明了却不读"。
2. **剥注释**：朴素 `/\/\/[^\n]*/` 把协议头里的双斜杠当注释起点 ⇒ 整行之后被吃掉，`args.action` 凭空消失。
3. **形参 vs `args.`**：`action` 在 `createBrowserSlotTool` 里就解出来了，`run()` 收到的是形参
   ⇒ 扫 `args.action` 找不到它。⇒ 补一条"形参里同名即算已读"的规则。

⇒ 于是用例自己也要有正控：**J0**（两串都抽到 >8 项）、**J0b**（`extArgs` 里真有 `args.earg`，
⛔ 别让白名单变成一句许愿）、**J3**（注释里的 `args.x` 不算读取）。

### 门禁

typecheck（node + client）✓ ／ `browser-slot*` **9 文件 122 用例** ✓ ／ 新用例 5 条 ✓。
**变异检验**：`git stash` 掉源码修复 ⇒ **J2 精确红**，红出来的正是那 10 个参数
（`url, target, js, timeout, max, out, script, all, name, earg`），J1 仍绿 ⇒ 两个方向互不掩护。

---

## v1.129.2 — 2026-11-10（`absent` 的**归因**要分两档：⛔ 把"连带退出"写成"台账陈旧"是一次归错因）

> 这一版只改一处**措辞归因**，但它是被真机读数逼出来的，而且**同一条读数里有两个不同成因**。

### 现场（v1.129.1 真机 `release b1` 的逐字回执）

```
已释放槽位 b1。已回收 2 个进程（1851648, 1851693）；profile 保留（登录态不丢）
  ℹ️ 另有 7 个 pid（1851662, …）**动手前就已不存在** ⇒ 未计入"已回收"（台账里那条是陈旧的）。
```

🔴 **「台账里那条是陈旧的」这句话是错的**：那份台账**一点都不陈旧**，它记的是一次真实租约。
那 7 个 pid 是 **Chrome 的子进程** —— 我在逐个处置时，先杀掉的父进程已经把它们一起带走了。

### 判据：**归因必须与读数相称**

`absent` 这个桶里其实有**两个成因**，而 v1.129.1 只写了一句措辞（针对其中一个）：

| 成因 | 读数形态 | 该怎么说 |
|---|---|---|
| **台账陈旧／被污染** | 台账里的那个 `pid` 本来就不存在（幽灵租约） | "那条租约是陈旧的或被污染" |
| **连带退出** | 多个 pid 属于同一条进程树，先处置的那个带走了它们 | "它们在我逐个处置时已经退出（多半是连带退出）" |

⇒ 分开说的判据（都钉在测试里）：`rejectedHint === 0 && absent === [pidHint]` ⇒ 陈旧档；
其余多 pid 情形 ⇒ 连带退出档，并且**⛔ 不许出现"陈旧"字样**。

### 门禁

`typecheck` ✅ ／ `typecheck-host(0.2.2-rc.1)` ✅ ／ `test` ✅ ／ `coverage` **222 files / 3485 tests，
93.54% stmts ／ 86.33% branches** ／ `build` ／ `pack-check` ✅。

### 变异检验

`absent` 归因合并回一句 ⇒ ㉝ 精确红 1（且它的负控——`rejected` 档必须说"未被杀死"、本进程不能被杀——同时成立）。

### 顺带记两个**我自己**的编辑事故

1. 🔴 **用标题行当 `old_string` 会吞掉标题** —— 本轮第 N 次复发：给 ㉝ 插入新格时把 ㉜ 的
   `it(...)` 行一起删了，测试文件变成语法错。判据（已有，我这次又没照做）：
   **插入类编辑的 `old_string` 必须包含前一行的完整闭合**。
2. 🔴 **修的时候又把标题写重了一行**（`it(...㉜...)` 连着两行）—— 因为补回去的那段与既有那段
   都带标题。⇒ **改完必须立刻回读结构**（这次是回读了才发现的）。

---



> 这一版没有新功能。它修的是 v1.129.0 **自己引入**的一处污染，以及那处污染**在读数上暴露出的两个假读数**。
> 三件事是**一条因果链**，所以合在一版：污染 → 假回收 → 假"杀不动"。

### ① 缺陷：一个没跟着迁移的测试往**真实全局台账**写了夹具

v1.129.0 把 `readLedger()` / `writeLedger()` / `withLedger()` 的 `root` 参数**删掉了**，
但 `tests/browser-slot-ledger.test.ts` **没有跟着迁移**，仍在调 `writeLedger(root, …)`。

🔴 **JS 不会因为你多传一个参数就报错** —— 那个 `root` 被**静默忽略**，
于是测试夹具 `{slot: 2, pid: 4242, sessionId: 'sess-a', trajectory: 'traj'}` 写进了
`~/.dsh/serenity-browser-slots/ledger.json`（**唯一真相源**）。

**实测后果**（真机读数）：

- `browser_slot list` 出现三条 `orphaned` 幽灵租约，`heldMin` = 29904504（≈57 年，`leasedAt: 1000`）
- `doctor` 的 `identityDrift` 报三条 —— 而那三条**本来就该报**（夹具没有 identity）
- **看守真的工作了**：`nudges` 从 0 变 1，它对 `trajectory: 'traj'` 发过提醒

🔴 **危害的形状（值得单记）**：**测试污染的是唯一真相源，而污染读数与真实读数完全同形** ——
之后所有人（包括看守）都会把幽灵租约当成真实占用者。
⇒ 判据：**「多余的参数被忽略」是 JS 的默认行为，⛔ 不能指望调用方自己发现错签名。**

**修法（机械保证，不靠纪律）**：`slotsHomeDir()` 在**测试进程**里（`VITEST*` 环境标记）
若拿不到 `SERENITY_BROWSER_SLOTS_DIR` ⇒ **直接抛错**。测试进程不给出覆盖值就起不来。
⚠️ 边界如实登记：这条只挡「忘记覆盖」，⛔ 不挡「覆盖成一个也错的路径」。

### ② 假读数 A：`reap` 把「本来就不存在」报成「已回收」

台账里 `pid: 4242`，而 `/proc/4242` **根本不存在**，`reap` 的回执却是
「已回收 1 个进程（4242）」。成因：旧 `killPid` 在 `process.kill` 抛错时 `return true`，
注释写"已经不在了"—— 而那个 `catch` 同时接住了 **EPERM**（存在但没权限）与 **EINVAL**（pid 非法）。

⇒ `killPidOutcome` 改成**三档**：`killed`（我们杀的）／`absent`（动手前就不在）／`denied`（在但动不了）。
`destroySlot` 把三档**分行**说出来 —— ⛔ 不许把"我没做"写成"我做了"。

### ③ 假读数 B：`pid` 被当成「杀死目标」，而它只是「一条线索」

`destroySlot` 原来无条件 `killPid(pidHint)`。台账是**文件**，会被污染（测试夹具／手工编辑／旧版本残留），
于是一个脏 `pid` 就可能杀掉**任何进程** —— 编辑器、user 自己的浏览器、别的 CCC 的服务。
那次 4242 恰好不存在，**纯属运气**。

⇒ 新增 `pidClaimsProfile(pid, profileDir)`：台账里的 pid **必须先通过认领**（命令行含本槽位专属
`--user-data-dir`，与 `findPidsByProfile` 同一条规则），验不过 ⇒ 不杀、并在回执里点名。

### ④ 假读数 C（写测试时当场抓出）：「`/proc/<pid>` 存在」≠「进程活着」

`killPidOutcome` 第一版用 `existsSync('/proc/<pid>')` 判定"没了"，结果**自己的测试当场红**：
`expected 'denied' to be 'killed'`。真因 = 我们杀掉的子进程成了**僵尸**（父进程还没 `wait`），
`/proc/<pid>` **仍然存在** ⇒ 一笔成功的回收被报成「杀不动」。

⇒ 新增 `pidIsAlive(pid)`：读 `/proc/<pid>/stat` 的 **state**（`Z`/`X` 不算活），⛔ 不读目录存在性。
判据：**"存在"与"活着"必须分开读**（D253 同族：一个恒真的读数会让相邻两档同形）。

### 门禁

`typecheck` ✅ ／ `typecheck-host(0.2.2-rc.1)` ✅ ／ `test` ✅ ／ `coverage` **222 files / 3484 tests，
93.56% stmts ／ 86.33% branches** ／ `build` ／ `pack-check` ✅。

### 变异检验（5 组，全部精确红）

| 变异体 | 结果 |
|---|---|
| `void stampIdentity` | ⑰ 精确红 1 |
| release 不调 `clearSlotIdentity` | 修判据后精确红 1（首轮曾假绿，见 v1.129.0） |
| `assertSlotOwned` 直接 return | ㉑㉒㉓ 三条同时红 |
| `ledgerPath()` 落到子目录 | ledger ② 精确红 1 |
| `pidIsAlive` 退回 `existsSync` | ㉛ 精确红 1 |
| `destroySlot` 去掉 pid 认领 | 🔴 **测试进程本身被杀**（exit 2，无输出）—— 比"精确红 1"更强的证据 |

### 🔴 另一条假绿的教训：`Function.length` 判不了「函数有没有某个参数」

`slotsHomeDir(env = process.env)` 里**带默认值的形参不计入 `length`** ⇒ 恒 0，
于是 `expect(slotsHomeDir.length).toBe(1)` 报 `expected +0 to be 1`。
⇒ 真判据：**塞一个"看起来该被尊重"的根进去，结果必须一字不变**。

---



> owner 两条令（逐字）：
> ① 「我希望所有浏览器能力都集中到这个 browser_slot，同时这个 browser_slot 支持 CCC 给它写扩展，
>    这样各个 CCC 可以用上最好的浏览器操作能力」
> ② 「注意 20 个槽位是所有 CCC 共用的，状态管理要全局；为了分辨清楚最好每个槽位的浏览器 profile 里加点标识」

### 🔴 owner 第②条纠正了一个真缺陷（原实现是错的）

台账原落点 `<CCC>/.opencode/browser-slots.json` = **每个 CCC 各一份**，
而端口 `9301..9320` 与 Chrome 进程是**全机唯一**的：
一个宿主实测服务 **3 个 CCC** ⇒ 三份台账各自认为 b1 空闲 ⇒ 抢同一端口，
**且两份台账都自洽、没有任何读数会显示冲突**。

🔴 **判据（比修法值钱）：资源的唯一性必须由状态载体的唯一性保证**，
⛔ 不能靠"每个使用者各记一份、然后指望它们对得上"。
这与 2026-11-09「槽位租到了、没有工具能操作它」是**同一族** —— 那次漂在端口区间，这次漂在归属。

⇒ 全局家目录 `~/.dsh/serenity-browser-slots/`（`SERENITY_BROWSER_SLOTS_DIR` 可覆盖）。
⛔ 不放任何 CCC 里（放谁家就等于让那个 CCC 当"主"，那是治理问题不是技术问题）。

### 新增

| 文件 | 作用 |
|---|---|
| `src/browser/home.ts` | 全局家目录。**签名里刻意没有 `root` 参数** |
| `src/browser/cdp.ts` | CDP 客户端（**零依赖**，用运行时内建 `WebSocket`）：targets/open/goto/eval/text/html/shot/reload/close |
| `src/browser/extend.ts` | 扩展机制：`<CCC>/browser-ext/*.ts`，**ACC 只 spawn、从不 import**（照 `cro/core.ts` 的 B 案） |

`SLOT_ACTIONS` 17 个，分三组（失效面完全不同，⛔ 不混）：
① 槽位层 6（acquire/release/list/status/reap/doctor）② 页面层 9（targets…close，**必须带 `--slot`**）
③ 扩展层 2（ext-list/ext）。

### identity.json（owner 令「profile 里加点标识」）

每槽位写 `<槽位目录>/identity.json`：`slot/label/port/cccRoot/sessionId/trajectory/leasedAt/writtenAt`。

- acquire（新租 ∧ **复用旧租约**）都会写；启动失败时清掉；release/reap 清掉（⛔ **不动 profile 目录**）
- `doctor` 新增 `identityDrift` 对账（缺失／sessionId 不一致／cccRoot 不一致）并并入 `verdict`

🔴 **判据：profile 侧也答得出"我是谁"** —— 只靠台账回答归属，会让「台账坏了」与「槽位无主」在读数上同形（D253 同族）。
⚠️ 两处不一致时**以台账为准**；identity 是抓手，不是第二个真相源。

### 页面层归属守卫 `assertSlotOwned`

搬进来的动作以前是「给一个端口就能操作」，而端口与归属在**两处**各记一份 ⇒ 谁都能动任何人的浏览器，
**没有任何读数会显示这件事**。⇒ 现在页面动作必须先过归属检查；`sessionId === ''` **一律拒绝**
（⛔ 不做"信任本地"的放宽 —— 一放宽，归属就从"机制"退回成"习惯"）。

### 扩展机制：铁律 + 协议

- **铁律**：扩展的任何失败（超时／非 0 退出／输出非 JSON／spawn 失败／自报失败）**绝不影响既有动作**
  —— 仅结构化失败返回，⛔ 从不抛。集中能力 ≠ 集中故障（先例 = `im/hook.ts` 旁路容忍）。
- **协议**：stdin 单行 JSON 进；stdout **最后一个非空行** JSON 出。
  判据：扩展可以自由 `console.log` 调试 —— ⛔ 要求 stdout 干净会让"加一句 debug"变成破坏契约的动作。
- payload 只给 `slot/port/cccRoot/args/timeoutMs`：⛔ 不塞进程表、⛔ 不塞别人的台账。

### 顺带修

- `launchSlot` / `destroySlot` **删掉未被读的 `root` 参数**（全局化后它一次都没被读过；留着的签名在向读者
  声明"启动跟着某个 CCC 走"，与事实相反 —— D289 同族）
- `ledgerPath()` / `readLedger()` / `withLedger()` / `writeLedger()` **全部去掉 root**；`SlotLease` 加 `cccRoot`
- `doctor` 的 `ledger.path` 从写死的 `.opencode/browser-slots.json`（**早已失效的字面量**）改为 `ledgerPath()`

### 门禁

`typecheck` ✅ ／ `typecheck-host` ✅ ／ `test` ／ `coverage` **222 files / 3478 tests，
93.58% stmts ／ 86.3% branches** ／ `build` ／ `pack-check`。

新增 4 个测试文件（`browser-slot-cdp` / `-extend` / `-home` ＋ service/process/ledger 扩写到全局签名），
其中 `cdp.ts`／`extend.ts`／`home.ts` 三个新模块**原先裸奔**（`coverage-gate` 当场打红）。

### 🔴 变异检验（4 组，全部精确红；并抓出**一条我自己写的假绿**）

| 变异体 | 结果 |
|---|---|
| `void stampIdentity`（acquire 不写 identity） | ⑰ 精确红 1 |
| release 不调 `clearSlotIdentity` | **第一轮全绿** ⇒ 修判据后精确红 1 |
| `assertSlotOwned` 直接 return | ㉑㉒㉓ 三条同时红 |
| `ledgerPath()` 落到子目录 | ledger ② 精确红 1 |

🔴🔴 **那条假绿**：⑱ 原本断言「release 后 identity 不存在」——而它**从没写过 identity**。
「根本没写过」与「写了又被清掉」在读数上**完全同形**，判据对变异体毫无判别力（D254 又一次）。
⇒ 修法：**判据从非空初态出发**，清除动作之前先断言文件真存在（正控）。

### 🔴 另一条假绿的教训：`Function.length` 判不了"函数有没有某个参数"

`slotsHomeDir(env = process.env)` 里**带默认值的形参不计入 `length`** ⇒ 恒 0，
于是 `expect(slotsHomeDir.length).toBe(1)` 报 `expected +0 to be 1`。
⇒ 真判据：**塞一个"看起来该被尊重"的根进去，结果必须一字不变**。

---



> 这是 v1.128.0 交付里最严重的一格，而且**是我自己漏的**：owner 最在意的那条闭环
> （「状态异常 ⇒ 反过来向占用它的会话注入提醒」）在真机上**一次都没跑过**。

### 缺陷

装配点：
```ts
registerSlotWatchman(ctx, () => cccRootForCwd(process.cwd()))
```
而宿主进程的 cwd 是**用户家目录** —— `dashboard diag` 明写「进程 CCC:（无）」
⇒ `cccRootForCwd(process.cwd())` **恒返回 `null`**
⇒ `tick()` 第一行 `if (!root) return` ⇒ **每一拍都直接返回**。

### 为什么它藏得住（这条比缺陷值钱）

- **没有任何报错**、**没有任何日志**；
- 台账上 `nudges` 一直是 **0** —— 而那个 0 与「确实没有异常槽位」**在读数上完全一样**（D253：恒空的读数器）；
- 「装配了」这个读数**完全正常**：`registerSlotWatchman` 被调用了、`setInterval` 在跑、
  `tick` 被触发了。**一个永远走不到第二行的定时器，与健康的那个在"有没有装配"上长得一模一样。**

🔴 **判据：装配 ≠ 在工作。** 判「某后台机制有没有生效」，必须拿到**它真的做了事**的证据
（台账计数变化 / 日志行 / 对方收到投递），⛔ 不能拿"注册函数被调用过"替代。

### 实测取证

把 b1 造成 `stale`（闲 55 分钟）、归属指向一条**真实**轨迹、进程活着，
宿主武装于 23:06:21，连等两拍（23:11:21 过点）⇒ 台账 `nudges` **仍为 0**。

### 修法

- 去掉 `rootProvider` 参数（它把"多 CCC"压成"一个根"，而装配期根本拿不到会话 cwd）
- 每拍用 **`listCccs(ctx)`** 枚举全部 CCC 根 —— 那是「本机有哪些 CCC」的**唯一权威枚举**
  （并集语义），`dashboard diag` 走的也是它那一族
- **逐根**看守（一个宿主实测服务 3 个 CCC ⇒ ⛔ 不能只挑一个）
- **零根时必须说出来**：`console.warn('…未枚举到任何 CCC 根 ⇒ 本拍未扫描（不是"无异常"）')`
  —— 旧实现没有这一行，于是"没扫"与"没异常"同形

### 新门禁 `tests/browser-slot-watchman.test.ts`（4 例）

① 必须走 `listCccs`，⛔ 用 `process.cwd()` ／ ② 装配点不得再传 `rootProvider` ／
③ 零根必须有告警（⛔ 只钉"有 return"，旧实现也有）／ ④ 本机真能枚举到 CCC 根。

🔴 **变异检验当场抓到一次我自己的假红**：①的负控 `not.toMatch(/cccRootForCwd\(process\.cwd\(\)\)/)`
命中的是**我在修法处写的注释**（逐字引用了旧写法作为"它错在哪"的说明）。
⇒ 判据必须先 `stripComments` 再扫，否则它同时在**惩罚"把教训写清楚"** ——
而写清楚教训恰恰是本仓最贵的一层。
**判据：`not.toMatch(...)` 命中的是我自己的**说明文字**，而不是残留的实现。**
（同族：源码里出现某串 ≠ 它在被执行。）

变异检验（还原前先做）：把 `findWatchRoots` 改回 `cccRootForCwd(process.cwd())` ⇒ **精确红 1 条**（正是 ①）。
还原后 `--filter browser-slot` **68/68 绿**。

### 验证读数

- `--filter browser-slot` **5 files / 68 tests** ✅
- typecheck ✅

---

## v1.128.1 — 2026-11-09（🔴 M4 判据假阳 ＋ 槽位端口段不被旧 MSM 认：butler 复算逼出的两条）

> 这一版全部来自 butler 的**第二回复算**。他跑的四条命令里，两条暴露了我上一版的缺口。
> 🔴 本版不改任何功能行为，只修**判据**与**两端之间的断口**。

### ① M4 判据假阳：`--profile` 被判成路径型，只是因为它含 `file`

`msm check` 的 M4 **唯一一项**常年是 `browser --profile should be type:"path"`。
而 `--profile` **不是路径**（它是 profile 的**名字**，目录由工具自己在 `STATE_DIR` 下生成）。

成因：旧判据 `/'path|file|dir/i.test(f.name)` —— **`profile` 里含 `file`** 就命中。

🔴 **危害是双向的**：
1. **假阳性会诱导人做错事**：把 `--profile` 声明成 `type:"path"` 会开启**逃逸守卫**，
   于是这个 flag 被当成路径处理 ⇒ 正好给**没有逃逸面的东西**加上逃逸面（方向反了）。
2. 它同时是**零信号**的：一项常年挂着，看久了就没人再读，真漏标 path 时也会一起被忽略。

修法（三条并存，缺一漏一类）：
- **整段分词**：按 `-`/`_`/`.`/驼峰切开，任一段**整段等于** `path|file|dir|folder|directory`
- **词尾连写**：`outfile` / `indir` / `outpath` 这类真实存在且**确实是路径**的连写形式仍要命中
- **点名例外**：`profile` 以 `file` 结尾但**不是路径** ⇒ 显式列入例外集，
  ⛔ 不为它放宽整条规则（那会让 outfile/indir 一起漏掉）

### ② ACC 槽位租到了，却没有任何工具能操作它（**两端之间的断口**）

butler 实测：`fetch 9302/json/version` → 200、`/json/list` → 6 个 target，**CDP 完全可用**；
但 `msm("browser", ["targets", "--port=9302"])` 直接报
`[BAD_PORT] 不在 9222..9299`（`browser.ts` 写死），而槽位端口是 `9301 + (n-1)`
⇒ **两段一个数都不重叠**。

⇒ 槽位管理 ✅、页面操作 ✅、**「租到的槽位能被操作」❌**。owner 要的是浏览器**操作**能力，
槽位是手段、操作是目的 —— 目的那端没有入口，等于没做完。

修法：`portFrom` 放宽为 **`9222..9299 ∪ 9301..9320`**（两段并列）。
⛔ **不是"任意端口"**：9400 仍被拒（有负控用例钉着）。

### ③ 同批修掉 `--profile` 的真实路径逃逸（这个是真缺陷，不是假阳）

butler 复跑确认成立，并**更正了他自己上一轮的措辞**：
- `--profile=../../AGENT_SESSIONS/x` ⇒ 经 `join` 规范化后**真在 STATE_DIR 之外**建出目录
  （模板里有 `profile-` 前缀，只抵消一层 `..`）
- `--profile=../../../../../../../tmp/x` ⇒ `EACCES mkdir '/home/tmp/…'`

🔴🔴 **判据（比他报的缺陷更值钱）：`EACCES` 不等于「守卫拒绝」。**
前者是**文件系统权限**在挡 —— 取决于跑的人的 uid 和那个目录的权限，换台机器、换个用户，
同一个输入就变成**能建**。守卫必须自己挡，⛔ 不能借别人的权限当挡箭牌；两条错误串不同，
在「退出码非 0」这个读数上却完全一样。

修法：`--profile` 收窄为**名字**（`[A-Za-z0-9._-]{1,64}`，⛔ `.`/`..`），
并加一道纵深防御（生成路径必须 resolve 到 `STATE_DIR` 内 —— 挡的是**将来对拼接逻辑的修改**）。

### ④ `browser` MSM 此前**一条测试都没有**（M1 二十来项里就有它）

新增 `.opencode/skills/home-browser/scripts/browser.test.ts`（5 用例），只钉上面这几处付过代价的地方：
9301 端口不得报 `BAD_PORT` ／ 9400 仍须拒（负控）／ 路径式 `--profile` 必须报 `BAD_PROFILE` ／
深层逃逸同样被同一守卫挡且**不是** `EACCES` ／ 非法端口先于 profile 校验（顺序契约）。

⚠️ 该文件**不 import 被测脚本**：`browser.ts` 是顶层执行脚本（`main()` 在末尾直接跑），
没有导出，import 会立刻去连 CDP。⇒ 判据只能走「真起子进程读退出码与 stderr」。
⚠️ 运行时用 `bun`（本仓 `run-trajectory-test` 同款）：`node --experimental-strip-types`
把 `.ts` 当模块入口时不走 strip，5 条会全红且失败信息只有一段 `file:///…` —— 那是
**读数器坏了**，不是被测对象坏了（D252）。

### 验证读数

- `housekeeper`（CCC 侧全量）**1788 passed / 2 skipped / 100 files** ✅
- `msm check`：**33 → 32 issues**，M1 名单里 `browser` **已消失** ✅
  （M4 那一条在本版**发布并重启后**才会消失 —— 「源码改了」≠「生效」）
- 真机一条命令走通（butler 建议的最小可验形态）：
  `browser goto <targetId> https://example.com --port=9301` →
  `browser eval <targetId> document.title --port=9301` ⇒ **`Example Domain`** ✅

---

## v1.128.0 — 2026-11-09（ACC 级浏览器槽位管理器 `browser_slot`：20 槽位／独立 profile／占用归属／看守反向注入）

> owner 令（逐字）：「开始实现 ACC 级的浏览器操作，务必给我实现槽位管理，最多 20 个 chrome 槽位，
> 每个独立 profile，固定分辨率，每个槽位有状态，状态异常例如长时间不动作、cpu 占用过高，
> 直接可以反过来向唤醒这个浏览器的会话注入消息提醒它管好自己的浏览器，
> 槽位是否已经被会话正在使用要有状态，每个会话用完要自觉退出占用」
>
> 直接起因是一次真实事故：我起 headless Chrome 拍截图，**做完没关**。整机功耗异常、
> 风扇长转、owner 要睡了才发现。取证：一个 renderer 存活 **36 小时**、`ps` 的 `pcpu=35.2%`
> 真实含义是**累计烧掉 12h57m**。⇒ 结论：**不是不会开浏览器，是开了没人收。**

### 新工具 `browser_slot`（常驻段，6 个动作）

| 动作 | 作用 |
|---|---|
| `list` | 列出全部 20 个槽位的状态、归属会话、存活时长、CPU/RSS |
| `acquire` | 租一个槽位（自动挑空闲号、起 Chrome、等 CDP 就绪且稳定） |
| `release` | 归还槽位（杀进程 + 清台账，**profile 保留**） |
| `status` | 单槽位详情 |
| `gc` | 手工触发一次回收（看守每 5 分钟自动跑一遍） |
| `shot` | 在已租槽位里截图 |

### 四层实现 `src/browser/`

| 文件 | 职责 | 关键判据 |
|---|---|---|
| `state.ts` | **纯判定**四态（`free`/`leased`/`stale`/`orphaned`） | 判定**顺序不可换**：`orphaned` 优先于 `stale` |
| `ledger.ts` | 台账（`O_EXCL` 排他锁 ＋ `temp→rename` 原子写，持锁者崩溃 10s 自动回收） | **只存事实不存状态** —— 存状态会与事实漂移且**无信号** |
| `process.ts` | 起／探／杀 | **按 profile 目录认领 pid**（⛔ `pgrep chrome` 会连 user 自己的浏览器一起杀）；CPU 走 `/proc` **两次采样增量** |
| `service.ts` | 编排 ＋ 反向注入 | 占用超限时**真的把消息注入到那条轨迹**（不是只写日志） |

### 从两支既有实现（pg / tg）抄到的三条真机制

1. **「不可达 ≠ 空闲」**：端口被占但 CDP 不通时，pid 解析不出就**拒绝启动**，
   ⛔ 不盲目再 spawn —— 否则两个实例抢同一端口且**在读数上分不开**。
2. **`launch` 报成功 ≠ 可用**：容器内 Chrome 自身 sandbox 初始化失败会 `FATAL` 后
   **约 1.5s 自杀** ⇒ 必须**就绪后再等 2.5s 复检**（我第一版只做 600ms，完全落在自杀窗口内）。
3. **对方的 "3/3" 不是代码事实**（那处实际 10~12 项检查，且硬编码探 9222）⇒ 不据它立判据。

> 收割结论（子代理通读两支 ＋ 我本人取证，G1–G16 全零命中）：**两支都没有**槽位状态机／
> 占用归属／自动回收／TTL／CPU 监控／健康检查／消息注入。owner 要的是**净新增**。

### 同批修掉的三个**我自己的**错

- ⛔ `--disable-renderer-backgrounding`
- ⛔ `--disable-backgrounding-occluded-windows`

  这两个名字听起来"对后台更友好"，实际含义**正好相反** —— 它们**禁止**浏览器把后台/
  被遮挡的窗口降速 ⇒ 一个被遗忘的标签页会**全速**渲染。这正是本次事故的直接成因。
- ⛔ `--disable-gpu`（会让截图与 3D 页面走软件光栅化 ⇒ **取证条件变了**）

### 页面侧同批修复（更根本）

`serenity-voyage.html` 的 `tick()` **无条件 `requestAnimationFrame` 自循环、全文零处
`visibilitychange`** ⇒ 就算进程关得干净，一个被遗忘的**可见标签页**也会 60fps 空转。
修法：`tick` 开头 `if (document.hidden) return`（不渲染、不再请求帧）＋
`visibilitychange`/`pagehide` 恢复时**重置 clock**（否则停摆期累积的 delta 让回来第一帧跳变）。
⚠️ **已知边界如实登记**：headless 下 `document.hidden` 恒 false ⇒ 该闸**对无头槽位不生效**，
那种情形只能靠 `browser_slot release` 杀进程。

### 🔴 门禁与测试抓出的真缺陷（每一条都改了实现，⛔ 没改测试）

| 判据 | 抓到什么 |
|---|---|
| 六项门禁 | ①`dsh.plugin.json` 清单缺 `browser_slot` ②`invariant` 写死 `toBe(10)`（**它自己的注释写着"⛔ 不写死总数"** —— 判据对、生成它的那一行没照做）③"十三→十四"散文 4 处 ④三个模块**裸奔无测试** |
| 单测 | ①`findPidsByProfile` **没排除自身 pid**（会把自己当浏览器杀掉）②`normalizeSlotId('B3')` 返回 0（大写没处理） |
| 单测 | ③**"还没启动" ≠ "已经死了"**：`pid=0`（刚落账、spawn 未完成）被误判 `orphaned` ⇒ 每个新租的槽位都会立刻收到"你的 Chrome 已死"的误导提醒 |

### 🔴 变异检验抓到两次**我自己的假绿**

1. **显示后端判据**：把 `resolveDisplay` 的 wayland 分支改成 `if (false && …)`，
   `--filter browser-slot-process` **仍 18/18 全绿** ⇒ ⑯⑰⑱ 三条断言**没有判别力**
   （`expect(['wayland','x11','headless']).toContain(d.backend)` 在**三元素全集上恒真**）。
   ⇒ 修法不是改断言，是**开缝**：`resolveDisplay(env, probe)` 新增可注入的文件系统探针
   （默认 `existsSync`，**生产行为零变化**），测试即可构造三档确定输入并**逐档钉死后端**。
   改后三维各变异一次：wayland 分支 `false &&` ⇒ **红 4 条**／`x11`→`xor` ⇒ **红 1 条**／
   `new`→`old` ⇒ **红 1 条**。还原后 22/22 绿。
2. **省电用例**：`false && document.hidden` **仍全绿**，改钉正则后才红。

### 真机 LIVE 全链验证（2026-11-09）

起 Chrome → CDP 稳定 → 按 profile 认领 → 固定分辨率 → 台账 `leased` →
`release` 后**进程消失／端口沉默／台账清空／profile 保留**。
日志铁证 = `DevTools listening on ws://127.0.0.1:9301/...`。

🔴 **真机死在显示层（第 7 条判据）**：`Missing X server or $DISPLAY` —— 本机是 **Wayland**，
`:0` 是 Xwayland 且要 `XAUTHORITY`，从服务进程 fork 的上下文里拿不到。
⇒ 新增 `resolveDisplay()`（wayland → x11 → headless，按 socket 挑）＋
CDP 不就绪时**把 Chrome 自己的关键报错搬进回执**（⛔ 只说"看日志"＝转嫁排查）。

### 判据（这一批付的代价，值得单独记）

- 🔴🔴 **「我做完没关」不是遗忘，是"没有归属"** —— 旧的 `browser` MSM 只提供 launch，
  **不提供"谁负责关"**。没有归属的进程无法被追责，也就无法被回收。
  ⇒ 修复不是"下次记得"，是**台账＋看守**。
- 🔴 **一个读数在两种相反情况下取同一个值**（同值歧义）：`ps -o pcpu` 的 35.2% 对一个空转
  10 秒的进程和一个空转 36 小时的进程**可能完全相同**。⇒ 报 CPU 必须用**两次采样增量**。
- 🔴 **节流 ≠ 停止**：浏览器对后台标签页只降到 1fps，36 小时仍是 36 小时。
- 🔴 **「结果属于某个三元素集合」是一个恒真断言**，只要被测函数在正常输入下**总是**返回
  三者之一。它读起来像判据（有 `expect`、有具体词），但**没有任何输入能让它红**
  ⇒ 这类断言只能靠**变异检验**识破，逐行读代码看不出来。
- 🔴 **修假绿的正确方向是"让输入可构造"，不是"让断言更严"**。

### 门禁读数

typecheck ✅ ／ typecheck-host 0.2.2-rc.1（node 100／client 193）✅ ／
test **218 files / 3431 tests** ✅ ／ coverage **94.47%** ✅ ／
build ✅（node 882 KB ＋ client 258 KB）／ pack-check ✅（**180 文件**）

### 同批修掉一处隐私门违规（D145 第三次，同一形状）

`tests/browser-slot-LIVE.test.ts` 把 CCC 根写死成字面量家目录路径，而本仓 B 面是
**GitHub public** ⇒ `privacy-scan` 的 `absolute-home-path` 规则当场打红。
修法**不是加白名单**，是让路径自己长出来：向上找 `.serenity` 标记即 CCC 根
（该标记是 CCC 既有契约，`dashboard health` 的 `P1_rooted` 也按它判）。
⇒ 换机器 / 换用户名 / CI 上跑，这个值都自动正确。

---

## v1.127.1 — 2026-11-09（🔴 蓝图标题栏写假数字：注册表顶层键找错，`msm` 恒 0）

### 现象（v1.127.0 真机首读抓到的，不是测试抓到的）

装机跑 v1.127.0 之后，浅色卡片上的蓝图标题栏显示 **`SN-42-00` ／ `42 技能 / 0 工具`**，
而同一份资产用 `file://` 直开（走构建期常量）显示 **`SN-38-100` ／ `38 技能 / 100 工具`**。

🔴 **这不是崩溃，是图上写了一个假数字** —— 而 `§8c` 的硬约束恰恰是
**「每个数字都必须是真的」**。它是 0 也不会报错，只是安静地撒谎。

### 根因

`src/surface/voyage/vocab.ts` 的 `scanMsmNames()` 只读 `raw.msms`，
而真实 `mech-registry.json` 的顶层键是 **`entries`**
（`{version, description, entries:[…]}`，见 `tools/msm/service.ts` 的 `parseRegistry`）
⇒ `raw.msms` 恒 `undefined` ⇒ `msms` 恒空 ⇒ `counts.msm` 恒 **0**。

⚠️ **同一仓库里已经犯过一次**：`ontology/engine.ts` 的 `readMechRegistry`，
那里的注释就写着「顶层键找错 ⇒ `entries = raw`」。本次是**漏修的第二处**。
⇒ 修法照抄同一判据：`Array.isArray(raw.entries) ? raw.entries : Array.isArray(raw.msms) ? raw.msms : []`
（两个键都认，保留 `msms` 兼容外部 CCC 的旧形态）。

### 🔴 为什么原测试全绿却看不见它（这条是本次真正的收获）

`tests/voyage-vocab.test.ts` 的夹具原本写 **`{msms:[…]}`** —— 一个**真实世界里不存在的形态**。
夹具与被测实现**同错**，于是永远是绿的。

⇒ 夹具已改成真实形态（`{version, description, entries}`），并新增两条：
① 真实形态下 MSM 数**必须读得出来**，且显式断言 `counts.msm` **不是 0**（那个 0 会原样写进图上）；
② 兼容旧形态，且两键并存时 **`entries` 优先**。

**变异检验**：把实现改回只读 `raw.msms` ⇒ `--filter voyage-vocab` **精确红 3 条**
（两条正向 + 一条"entries 优先"），全部落在 MSM 读取这一维；还原后 12/12 绿。

📌 **可外推的判据（D274 的落点）**：**夹具形态必须与真身同形** ——
夹具写得比真身"好读"时，它测的是我的想象，不是那个文件。

### 门禁

typecheck ✅ ／ typecheck-host 0.2.2-rc.1（node 100／client 193）✅ ／ test **215 files / 3381 tests** ✅ ／
coverage **95.01%** ✅ ／ build ✅ ／ pack-check 175 文件 ✅。

---

## v1.127.0 — 2026-11-09（蓝图档补**标注层** ＋ 四类深色语汇残留清掉）

### 判据从哪来（owner 原话）

> **「太单调，要让人看了觉得有趣有启发」**（附截图：面板卡片里的蓝图档）

🔴 **诊断（这一轮真正的结论）**：v1.126.0 的蓝图档只做对了**语汇**（纸白 + 网格 + 线稿），
但图上**一个字都没有** —— 它是一张"好看的船"，⛔ 不是一张**图纸**。
工程图之所以是工程图，在**标注**：部件有引线、读数有数字。
⇒ 本轮补的就是 `§8c 标注层`，⛔ 不是"把线稿画得更细"。

### 新增：§8c 标注层（`assets/serenity-voyage.html`）

| 面 | 做法 |
|---|---|
| CSS | `.bp-sheet` / `.bp-note` / `.bp-lead` / `.bp-leadDot` / `.bp-title` / `.bp-scale`（锚在 `body.blueprint .grain` 之后） |
| DOM | `<div class="bp-sheet">` 含 `<svg id="bpSvg">` + `.bp-scale` + `<div id="bpTitle">`（锚在 `.grain` div 之后） |
| JS §8c | `bpAnchorOf` / `bpBuildNotes` / `bpBuildTitle` / `bpInit` / `bpUpdate`（插在 `window.SERENITY = {…}` **之后**、§9 主循环之前） |
| 主循环 | tick 里 `if (bpLayer) bpUpdate();` |
| 版本注入 | 资产加 `<meta name="serenity-acc-version" content="__ACC_VERSION__">`；`vocab.ts` 新增 `injectVoyageVersion()`；`page.ts` 无条件调用（与词表注入**互相独立**） |

**6 条标注，每个数字都取自运行时真实对象（⛔ 一个都不许写死）**：

| 标注 | 取数来源 |
|---|---|
| 主推进 / MAIN DRIVE | `ship.userData.mainFlame` |
| 短舱 · 工具面 / MSM | `counts.msm` ＋ `msms.slice(0,…)` 真名 |
| 舷窗 · 技能面 / SKILL | `counts.skill` ＋ `counts.onto` |
| 壳体 / HULL | `__blueprint.meshes` / `edges` |
| 总长 / L.O.A. | 真实 `Box3` 包围盒（单位注明"场景单位"） |
| 雷达 / SENSOR | `ship.userData.radar` |

**标题栏**（真实读数）：图号 `SN-<技能数>-<工具数>` ／册数 ／线条 ／比例尺 ／制图 S142。
后两行标 `data-soft`，卡片尺寸下自动收起。

### 四类「深色语汇残留」（真机截图逼出来的，⛔ 不是配色微调）

| 缺陷 | 形态（真机读数） | 修法 | 门禁 |
|---|---|---|---|
| **卡片里船太大** | 卡片 542 宽、`rad=34` ⇒ 船占宽 **93%**，六条标注全压船身 | 蓝图×卡片独立 `baseRad=68`（全屏仍 34） | ⑤-1（含负控 `bpCam ? 34 :`） |
| **HUD 残留** | `.speed` 是 `#eafff8`（近白）／`.facts` 是深色玻璃块 ⇒ 白纸上的白字 | `body.blueprint .ui{display:none!important}` | ⑤-2 |
| **铭牌残留** | 近黑金属 slab（`0x0c1e20`）读成画面左下角**黑三角** | 蓝图档自己也 traverse 关 `userData.rz`（与 CARD 那段**分开写**，理由不同） | ⑤-3 |
| **标尺与标注并置** | `.bp-scale` 占 x=14~70，左栏文字在 x=72 ⇒ 只差 2px，读成「FR 04 就是壳体那条」 | 非卡片档左栏退到 9.5%（卡片档标尺本就不显示，保持 5%） | ⑤-4 |
| **文字块横穿船体** | 3 个真名让该块宽到 **271px**（其余五条最宽 111px） | 卡片档只列 1 个真名 | ⑤-5 |

🔴🔴 **三次真机修正（都是"图上看到了才发现"，⛔ 别重走）**：
① **船太小**（沿用卡片模式 `rad=54` ⇒ 船仅约 350px，6 条引线全挤在那一小片）⇒ 标注能否成立
**先决于被标注物在画面里够不够大**；② **引线交叉汇向中部**（文字块 y 写死成三档，而锚点都在船体中部）
⇒ **y 跟随锚点投影**（0.14 阻尼 + 夹进 14%~86%）；③ **两对标注重叠**（HULL/L.O.A. 同取包围盒中心、
雷达/主推进都在船尾）⇒ **每帧同侧去重叠**（按 y 排序 + 最小行距 34px + 从下往上回推一次）。
⚠️ 为什么必须每帧算：锚点随船动，任何手调常量都会在某个相位重新撞上。

### 门禁

typecheck ✅ ／ typecheck-host 0.2.2-rc.1（node 100／client 193）✅ ／ test **215 files / 3379 tests** ✅ ／
coverage **95.01%** ✅ ／ build ✅ ／ pack-check 175 文件 ✅。

🔴 **变异检验 5 组各精确红 1 条**（`--filter voyage-theme`，19 例）：
`baseRad` 退回单值 ／ HUD 选择器改名 ／ 铭牌 `rz`→`rzX` ／ 左栏退回 `'5%'` ／ 真名数退回 3。
⚠️ 这 5 条**失效形态完全一样**：页面不报错、旧 14 条断言全绿、观感全错 ⇒ 必须各钉一条。

---

## v1.126.0 — 2026-11-09（浅色主题下的航行页改「工程蓝图」语汇 ＋ 主题接线进机械门禁）

### 判据从哪来（owner 2026-11-09 原话，两条）

> ① 「浅色主题下这个动画很突兀」（v1.125.0 只修了卡片底色，动画本身仍是深空）
> ② 面对「深色写实 ／ 浅色改哪一档」的三选一，owner 答 **「B 比较好，因为我们也不会放弃黑色主题支持的」**
> ③ 动笔前问视觉取舍 ⇒ **「我没啥想法，相信你的审美」** ⇒ 他不做视觉裁决，实现按我的判断落地

### 核心决定：两套**完整语汇**，⛔ 不是"把深色调亮"

| 主题 | 语汇 |
|---|---|
| 深色 | 写实电影质感（原样，**零变化**） |
| 浅色 | **工程蓝图**：纸白底 ＋ 24px 网格 ＋ `EdgesGeometry` 线稿 ＋ 墨蓝发光件 |

⚠️ **代价如实登记**：蓝图档下「写实金属」**整体消失**（不是淡化）。若本意只是"别那么突兀"，
应退到「只换天穹」那一档 —— 这条边界写在 `assets/serenity-voyage.html` §8b 的注释里。

### 资产侧（`assets/serenity-voyage.html`）

| 面 | 做法 | 关键读数（原型期真机） |
|---|---|---|
| 纸面材质 | `MeshLambertMaterial({color:0xffffff, emissive:0x9db9d8, emissiveIntensity:0.5})` | `__blueprint.meshes=188 / lit=18 / edges=185 / skipped=3` |
| 线稿 | 每 mesh `LineSegments(EdgesGeometry(g, 38), LineBasicMaterial(0x1c4a86, .62))` | 阈值 34→38 是"毛刺 → 干净"的分界 |
| 天穹 | `uTop #fdfefe / uMid #f7fafd / uLow #eef4fb`，`FogExp2(0xf6fafd, .00030)` | 第一版 `#f4f8fd/#e9f0f9` 实测「比面板底色脏」 |
| 页面 | `body.blueprint{background:#f7fafd}` ＋ 24px 网格 `rgba(15,17,21,.038)` | 网格 `.055 → .038`（提白后第一版显重） |
| 移除 | 星野三层 ／ 词元场 ／ 螺旋 ／ 尾迹 ／ 星云 ／ Points **整类** | `visiblePoints=0 / visibleSprites=0` |
| 后期 | **关**：`POSTFX_ENABLED = !!PostFX && !BLUEPRINT` | 平涂语汇与电影感后期互斥 |
| 发光件 | 18 个 emissive mesh 压成 `MeshBasic(0x2f5f9e, .5)` | ⚠️ 必须在**换材质之前**收集 `litParts` |

🔴 **三版材质取舍（⛔ 别重走）**：① `MeshBasic(0xfbfdff)` 纯平涂 ⇒ 只有轮廓没有体量，船读成贴纸；
② `Lambert + emissive 0xdde8f4 ×1` ⇒ 亮度地板太高，再叠主光 5.2 直接**过曝成一片白**，比①更平；
③ 当前 `emissive 0x9db9d8 ×0.5` ⇒ 暗面蓝灰、亮面近白，体积自己长出来，仍在纸白色域内。

### 客户端接线（`src/client/`）

| 面 | 变更 |
|---|---|
| 🆕 **`voyage-theme.ts`**（纯函数） | `HOST_DARK_ATTR` ／ `themeParamFor(isDark)` → 深色 `''` ／ 浅色 `'&theme=blueprint'` ／ `themeKeyPart(isDark)` |
| **`SafeModePanel.tsx`** | 新增 `useHostDarkTheme()`：读 `body.hasAttribute(HOST_DARK_ATTR)` ＋ **`MutationObserver`** 跟随后续切换；iframe `src` 拼 `themeParamFor(hostDark)`，`key` 拼 `themeKeyPart(hostDark)` |

🔴🔴 **判据源必须是宿主的输出（D297 同一根）**：主题 = 「设置项 ∥ 系统跟随」两路合成，
落成 `body[data-ds-dark-theme]`；`prefers-color-scheme` 只是**一个输入** ⇒ 拿它在
「设置浅色 + 系统深色」这一档**判反**，且只在部分用户机器上错。

🔴 **为什么主题要进 `key`**：`src` 变了浏览器**不一定**重载 iframe ⇒ 面板打开期间切主题，
画面会停在旧语汇上，而那种状态与「参数没传」在观感上**不可分**。
⇒ 进 `key` = 切一次主题重建一次（代价 = 一次 WebGL 重建；面板关闭本来就卸载）。

### 新增机械门禁 `tests/voyage-theme-wiring.test.ts`（14 例，四组）

| 组 | 钉住什么 |
|---|---|
| ① 纯函数映射 | 深色 `''` ／ 浅色 `'&theme=blueprint'`（**逐字**，含 `&` 而非 `?`）／ 两个 key 分格必须不同 |
| ② iframe 接线 | `src` 拼的是 `themeParamFor(…)`（⛔ 不是写死串）、`key` 含 `themeKeyPart(…)`、值来自 `useHostDarkTheme()` |
| ③ 判据源 | 客户端代码不得出现 `prefers-color-scheme` / `matchMedia`（**剥注释后判**），配**正控**：注释里出现不算、真代码出现必须被抓 |
| ④ 资产侧在位 | `?theme=blueprint` 解析 ／ `body.blueprint` 三条样式 ／ `applyBlueprint` ／ `&& !BLUEPRINT`（含负控：不得退回漏掉它的旧写法）／ `window.__blueprint` 读数句柄 |

🔴 **为什么 ② 那条要钉字面量而不是钉"能命中"**：若 `themeParamFor` 返回 `?theme=blueprint`，
拼出来是 `?…?theme=`，而资产的 `/\[?&\]theme=blueprint/` **仍然命中** ⇒ 缺陷会**静默生效**。

### 变异检验（真跑，5 组，每组精确红 1 条）

| 变异体 | 结果 |
|---|---|
| `&theme=blueprint` → `?theme=blueprint` | ① 红 1 |
| 删掉 `src` 里的 `themeParamFor(hostDark)` | ② 红 1 |
| 删掉 `key` 里的 `themeKeyPart(hostDark)` | ② 红 1 |
| 往 `voyage-theme.ts` 插一句真 `matchMedia('(prefers-color-scheme: dark)')` | ③ 红 1 |
| 资产改回 `POSTFX_ENABLED = !!PostFX` | ④ 红 1 |

### 门禁

typecheck ✅ ／ typecheck-host 0.2.2-rc.1 ✅（node 100 ／ client 193）／ test **215 files / 3374 tests** ✅ ／
coverage **95.01%** ✅ ／ build ✅ ／ pack-check ✅（175 文件）

---

## v1.125.0 — 2026-11-09（白色主题适配：`.sp-popVoyage` 写死深色压黑整张面板 ＋ 新增主题门禁）

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

### 判据从哪来（owner 2026-11-09 原话，附截图）

> 「这个页面没适配白色主题，想办法适配下」

### 定因（真机取证：MSM `browser` CDP ＋ 计算样式逐项对读）

| 选择器 | 浅色下算出的 `background` | 浅色下算出的 `color` |
|---|---|---|
| `.sp-pop` | `rgba(6,11,14,.9)` ← **被内层盖住** | `rgb(15,17,21)`（深字） |
| `.sp-popVoyage` | **`rgba(6, 11, 14, 0.9)`** ← 写死、主题盲 | 透明（继承深字） |
| `.sp-itemName` / `.sp-tab` | 透明 | `var(--dsw-alias-label-primary)` = `#0f1115`（深） |

同时 `document.body.hasAttribute('data-ds-dark-theme')` = **false**、`color-scheme: light`，
且 `--dsw-alias-bg-overlay` = `#e9ecf2`、`--dsw-alias-label-primary` = `#0f1115` —— **token 侧完全正确**。

🔴🔴 **根因一句话：文字色全部走语义 token（主题感知 ✔），而卡片底色 `.sp-popVoyage` 写死深色（主题盲 ✘）**
⇒ 浅色主题下「深底 + 深字」= 不可读。**不是 token 用错，是"有一处没走 token"。**

📌 **它与既有门禁是互补的反面**：`tests/client-css-tokens.test.ts`（2026-09-04）守的是
「**自造 token** ⇒ var() 解析不了 ⇒ 浅色黑块」；本次缺陷恰好相反 —— token **用对了**，
但**有一处没用 token**。⇒ 旧门禁抓不到，必须补一条新的（见下）。

### 改动

| 面 | 变更 |
|---|---|
| 🔴 **`.sp-popVoyage` 底色** | `rgba(6,11,14,.9)` → **`var(--dsw-alias-bg-overlay)`**；深色由 `body[data-ds-dark-theme] .sp-popVoyage` **原样回旧值** ⇒ 深色观感**零变化** |
| **`.sp-pop` 投影** | `rgba(0,0,0,.5)` → 浅色 `0.14`，深色档补回 `0.5`。旧值在浅底上会压出一圈**浓黑光晕**（不是不可读，是脏） |
| **`.sp-voyage` 外框** | 新增 `border: 1px solid var(--dsw-alias-border-l1)`。动画本身是**星空深色作品**（`assets/serenity-voyage.html` 写死 `#02050a`），它**不该跟主题走**（一块舷窗本来就该暗）；但外框不跟卡片走会读成"卡片破了个洞" |
| **`.sp-safeBadgeOn` 文字色** | `#6ee7b7`（深底薄荷绿）→ 浅色 `#047857`，深色档回旧值。原色压白卡对比度 ≈ 1.4:1 = 看不见 |
| **`.sp-subsDlvOk` 文字色** | `#10b981` → 浅色 `#047857`，深色档回旧值（10px 小字，原色 ≈ 2.3:1） |
| 🔴 **`SettingsSection.css` 主题判据** | `@media (prefers-color-scheme: dark)` → `body[data-ds-dark-theme]`。**拿宿主的输入当输出**在「设置浅色 + 系统深色」上会判反 |

⚠️ **刻意留死、不跟主题走的色（显式登记理由，⛔ 不是"忘了改"）**：
`#f2f4f6` 滑块 thumb（Mac 灰白，两主题通用）／ `#10b981` 作**底色**（品牌绿，两主题一致）／
`#c2410c` 告警底 ＋ `#fff` 告警字（橙底白字，两主题都要那个对比）／
`#fff` 二维码底（扫码需要白底，物理约束）。

### 新增机械门禁 `tests/client-css-theme-gate.test.ts`

① 任何「深色写死」的 `background/background-color/fill`（亮度 ≤ 60 且 alpha > 0.5），
   必须存在**落在同一元素上**的 `body[data-ds-dark-theme]` 分档；
② client CSS 禁用 `prefers-color-scheme`（宿主的输入 ≠ 宿主的输出）；
③ 分档属性名必须是宿主真实名（防 `data-dark-theme` 手误），并配「至少存在一条正确分档」的正向断言。

🔴🔴 **①-control 是这条门禁能活着的前提**：`isDarkLiteral` / `coversSameElement` 任一退化，
① 会变成**恒绿且无信号**。本文件第一版就是这样 —— 详见下方变异检验。

### 变异检验（真跑，且它抓到了我自己的假绿）

| 变异体 | 结果 |
|---|---|
| 把 `.sp-popVoyage` 底色改回 `rgba(6,11,14,.9)`（保留分档） | 期望 ① 精确红 1 条 |
| **删掉真分档、只留 `body[data-ds-dark-theme] .sp-popVoyageZZ`** | 🔴 **第一版判据全绿** —— 因为它按"剥空白后 startsWith"比选择器，`ZZ` 后缀被判成"已分档"。**这是判据没有判别力**（D254 同族），不是被测对象没问题 |
| 修法 | 按**组合器边界**比（`t === sel` 或 `t` 以「空白/>/+ /~ + sel」结尾），并补 ①-control 用内联 CSS 做正控/负控/边界对照 |

### 门禁

typecheck ✅ ／ typecheck-host 0.2.2-rc.1 ✅（node 100 ／ client 193）／ test **214 files / 3359 tests** ✅ ／
coverage **95.01%** ✅ ／ build ✅ ／ pack-check ⬜（见状态段）


## v1.124.0 — 2026-11-09（注入面瘦身：删工具清单 ＋ 工作语域加第 7 条「一次最多问 5 个」）

> ⚠️ **本标题行是 2026-11-09 v1.126.0 那轮补的**：v1.124.0 发布时正文写完了、**标题行漏了**
> （`git show 73d4846` 可核）。后果是这一版按 `## v<版本号>` **检索不到** —— 而本文件头注、
> `CHANGELOG-archive.md` 的检索方式、以及本仓自己的惯例全依赖那行。零信号，故补上。

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

### 判据从哪来（owner 2026-11-09 原话）

> 「我希望在宁静号的提示词做些事情；1. dsh 自身的提示词能不能不要注入了，省点空间
>   2. 约束里面调整下，避免一次向用户确认超过 5 个问题」

追问「dsh 自身」是否指宿主 harness identity ⇒ owner 答 **「我说的是 ACC」**
⇒ 两条都在 ACC 的注入面（`src/seams/system-prompt.ts` / `src/seams/work-register.ts`），⛔ 未动任何宿主配置。

### 面 A —— 删掉与宿主 schema 重复的工具面叙述（实测 −3,808 chars）

| 面 | 变更 |
|---|---|
| 🔴 **`identityBlock` 删两句** | ① `The DSH platform tools remain available too (read/write/…/goal and more) — …`：宿主自己注入这些工具的 schema，**点名它们零新增信息**，而这份名单**没人会在工具增减时同步**。② `…under the "Serenity Tools" heading — read it before using any ACC tool.`：它指向的那块清单**同批被删** ⇒ 留着就是**指向空处的指针**（模型会去找一个不存在的标题，比没有更坏）。 |
| 🔴 **`toolsBlock` 删 10 行工具清单** | 判据三条：**① 它是第二真相源**——工具面已有两份权威（宿主注入的工具 schema ／ `kernel/invariant.ts` 的 `REGISTERED_TOOLS`），清单是第三份抄本 ⇒ 工具改名/退役时**没人会记得改这里**，于是对模型**静默撒谎**（D151 同族）。**② 它提供不了 schema 提供不了的信息**（子命令 / flag / 返回形态都在 schema 与 `--help` 里，那里才是可执行的真身）。**③ 实测体量**：该块原 3,451 chars。 |
| 🆕 **标题 `Serenity Tools` → `Serenity MSM`** | 块里已无工具清单，仍叫 "Tools" 会让模型按"工具总表"来读这段（E↑：标题是这段文字的唯一预告）。**MSM 那 4 行调用示例保留** —— 它是**另一层**（CCC 注册、宿主 schema 里没有），且当年是真机踩出来的。 |
| 📌 **如实登记的代价（D255）** | 模型失去"一眼看到全部 ACC 工具名"的入口。但那个入口**本来就长期滞后**（`ontology` / `serenity-skill-creator` / `reconstruct` 三者的增减史里，本块都曾落后于 `REGISTERED_TOOLS`）。可靠替代 = 宿主工具 schema（每轮都在）＋ `msm()` 无参目录。 |

**体量读数**（本机称重，改前 → 改后）：`identityBlock` 1,039 → **705**；`toolsBlock` 3,451 → **572**；
两块合计 **4,490 → 1,277**（−3,213）。若把身份块里那句平台工具说明单算，合计 −3,808（含标题行等）。

### 面 B —— 工作语域块加第 7 条

```
7. Ask at most five questions in one turn, numbered, each with the default you
   would otherwise take. More than five at once is a questionnaire, not a
   decision — split it or take the defaults and say which ones you took.
```

🔴 **这条约束的形态必须说清，否则下一个维护者会去找一个不存在的工具参数**：
`ask_user_question` 已被 `seams/guards.ts` 的 `ALWAYS_DENY_TOOLS` **恒隐** ⇒ 模型手上**没有**那个工具
⇒ 本条约束的是**正文里一次提出多少个待裁决问题**，⛔ **不是任何工具的入参上限**。
⇒ 为什么给"默认值"而不只给上限：只说"少问"会退化成"该问的也不敢问"；要求每条附默认值，
等于让"不问"成为一个**可执行选项**。这条已写进 `work-register.ts` 头注并由用例钉住。

### 测试

- `tests/system-prompt.test.ts` / `tests/osp-alignment.test.ts`：两处旧钉**方向反转**（`toContain('DSH platform tools remain available')` ⇒ `not.toContain`），
  并新增**形态判据**：清单行以 `^ {2}<工具名>\s+—` 判，⛔ 不用"block 里出现了某工具名"——因为 MSM 的 Manage 行合法地提到 `container_admin`。
- 块序断言同批改（`indexOf('=== Serenity MSM ===')`），并**先断言 `> 0` 再比大小**：
  `-1` **小于一切**，把它当"块在此处"会让整串不等式变成假绿。
- `tests/work-register.test.ts` 新增三条：① 从**编号序列**取出第 7 条整段再断言（⛔ 全文搜数字 '5'——那会被任何无关的 5 满足）；② 必须给"默认值"这个可执行替代；③ 源码注释里必须写明"不是工具入参上限"。

**变异检验（两组，各精确红）**：
- 往 `toolsBlock` 里插回一行 `  container_fs — …` ⇒ `--filter system-prompt` **精确红 1 条**（正是新增的形态判据）；还原后 31/31 绿。
- 把第 7 条的 `five` 改成 `THREE` ⇒ `--filter work-register` **精确红 1 条**；还原后 9/9 绿。

### 同批修掉的读数器缺陷（不是被测对象坏了）

`tests/trajectory/interrupted-cross-check.test.ts` 用 `spawnSync('bun', …)` —— **裸名依赖 `PATH`**，
而 vitest 子进程的 `PATH` 里**没有 `~/.bun/bin`**（实测 `spawnSync bun ENOENT`）
⇒ 6 条用例全红、报「CRO 没有产出可解析的决策」，而**同一份程序**用 `run-trajectory-test` 跑 22/23 绿。
⇒ 改为与 `scripts/dsh-develop.ts` **同口径**的解析路径（`SERENITY_BUN` 可覆盖，缺省 `~/.bun/bin/bun`）。
🔴 **判据**：**"读数器坏了"与"被测对象坏了"必须分开判**（D252 同族）——把本机 `PATH` 长什么样偷渡成判据的一部分，
是本仓已登记过的形态。

### 门禁

typecheck ✅ ／ typecheck-host 0.2.2-rc.1 ✅（node 100 ／ client 193）／ test **213 files / 3356 tests** ✅ ／
coverage **95.01%** ✅ ／ build ✅ ／ pack-check ✅

> 🔴 **可外推的判据**：**提示词里不要放"第二真相源"**。工具面已经有两份权威（宿主 schema ＋ `REGISTERED_TOOLS`），
> 再抄一份清单进去，只会在工具退役时**静默撒谎**——而它撒谎的方式是"模型按旧清单去找一个不存在的工具"，
> **零告警、零信号**。

---

## v1.123.0 — 2026-11-06（工具屏蔽重整：三张表各归各位 ＋ 退役 `safeMode.hiddenTools`）

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

### 判据从哪来（owner 2026-11-06 原话）

> 「subagent 一套 tool 常开，安全模式开关只影响 bash 开关，剩余的都是只要在 CCC 目录就关；
> 宿主没注册的可以干掉了，宿主新增的 `working_directory` 我们也关掉」

三句话 ⇒ **三张表，各管一段**，不再互相渗透：

| 范围 | 表 | 何时生效 | 成员 |
|---|---|---|---|
| subagent 一族 | **不入任何表** | **常开** | `subagent` `subagent_fork` `send_message` `list_agents` `interrupt_agent` `list_subagent_models` |
| shell | `SAFE_MODE_DENY_TOOLS` | **只随 `.serenity-safe-on`** | `bash` |
| 其余 | `ALWAYS_DENY_TOOLS` | **只要在 CCC 内** | 见下 |

### 🔴 结构变更：`safeMode.hiddenTools` 整条退役

| 面 | 变更 |
|---|---|
| **退役的键** | `safeMode.hiddenTools`（v1.51.4 起）。`readSafeModeHiddenTools()` **已删除**，`computeVisibilitySources` 的 `safeMode` 源**不再读配置**，只返回 `['bash']`。存量配置里残留该键 ⇒ **静默忽略**（schemastery 非 strict）。 |
| **为什么要淘汰这个形态** | 它表达"安全模式期间的**附加**屏蔽"，而实测需求恰恰相反：那批工具**任何时候都该关**。跟着一个文件开关**忽隐忽现**不是保护，是缺陷——安全模式一关，`job_*` / `workflow` / `plugin_manager` 就全回来了。 |
| **`alwaysDeny` 源扩表** | 从 1 项 → **8 项**：`ask_user_question`（v1.106.0 起）＋ `job_output` `job_list` `job_kill` `workflow` `exit_plan_mode` `plugin_manager` ＋ 🆕 `working_directory`。理由逐条写在 `ALWAYS_DENY_TOOLS` 头部。 |
| 🆕 **`working_directory`（宿主 0.2.2-rc.1 新增）** | 它改的是**会话 cwd**，而 cwd 是 CCC 边界判定（`cccRootForCwd`）的输入之一 ⇒ 让模型能改 cwd，等于让模型能移动自己所在的边界。 |
| ⛔ **删掉 3 个空转名** | `str_replace_editor` / `email_send` / `email_reply` —— 实测装机包 grep **零命中**（宿主从未注册过这三个名字；邮箱是 profile patch 面的 `tool-email` 插件，工具名不是这两个）。旧表里它们**永远剔不掉**（宿主 `restrict()` 对未知名只剔除），属零信号熵（D151）。 |
| **面板文案同步** | `SafeModePanel.tsx` 四处「写工具已隐藏 / 写工具全开」→「bash 已隐藏 / bash 可用」。旧文案在本次改造后**已经是假的**：安全模式开着时 `write`/`edit` 从来都在。 |

### 测试

- `guards.test.ts`：删掉 `readSafeModeHiddenTools` 那组（函数已不存在）；`safeMode` 组重写为「只藏 bash」＋ 新增**退役键不生效**的反向钉；`alwaysDeny` 组改为对着 `ALWAYS_DENY_TOOLS` 判，并新增两条：**subagent 一族不得进入本表**（进了就静默失去委派能力，而所有"藏住了"的用例照样绿）／**`working_directory` 必须在本表**。
- `seams/context-register.test.ts`：一处**假红**，成因值得记 —— 原判别式用 `deny.length === REGISTERED_TOOLS.length` 当"是否隐藏了全部工具"，而 `alwaysDeny` 扩到 8 项后，`8 + hostSchedule(4) + imBridge(1) = 13` 与 `REGISTERED_TOOLS.length` **碰巧相等** ⇒ 误判成全隐藏。**长度是集合的必要不充分条件**，改成真集合判据（`⊇ REGISTERED_TOOLS`）后对"数目碰巧相等"免疫。

**变异检验**：从表里删 `working_directory` ⇒ `--filter guards` **精确红 1 条**（正是新加的那条）；还原后 114/114 绿。

### 门禁

typecheck ✅ ／ typecheck-host 0.2.2-rc.1 ✅ ／ test **213 files / 3357 tests** ✅ ／ coverage **95.06%** ✅ ／ build ✅ ／ pack-check ✅

> 🔴 **可外推的判据**：**「随开关变化的屏蔽面」要能被追问一句"它为什么不该一直关"**。
> 答案若含糊，那它就不该挂在开关上——开关的每一次翻转都会让一批工具凭空出现，
> 而"它回来了"这件事本身不会触发任何告警。

---

## v1.122.0 — 2026-11-06（🔴 P0 回归修复：`reconstruct` 换代后 IM 入站投给已归档的旧载体）

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

### 这条修的是什么（生产事故，非假想）

v1.121.0 发布 `reconstruct`（换代：建新会话 → 绑轨迹 → 归档旧会话）后，它在本容器**走 IM 桥的那条轨迹**上真跑了。
宿主日志逐字（2026-11-06 08:3x）：

```
reconstruct: 新载体 session-<uuid> 已接管「…<轨迹目录名>…」（旧 skiff-weixin-<code>）
reconstruct: 旧会话 skiff-weixin-<code> 已归档（attempt 1）
im 投递：会话 skiff-weixin-<code> → followup      ← 仍投给已归档的那条
```

⇒ **人在微信那头连发四条没人应**（`人呢` × 3 ＋ 一条带地址的请求），
而**每一层日志都报成功** —— `followup` 不是空操作，它确实投了，只是投进一条已被收起的会话。

| 面 | 变更 |
|---|---|
| 🔴 **根因** | IM 入站的会话 id 是**纯函数派生**（`weixinSessionIdForTrajectory(code)` ⇒ 恒 `skiff-weixin-<code>`）。那个前提在 `reconstruct` 之前成立 —— 载体 id 一旦派生就永不变。而 `reconstruct` 的语义**正是"换一条载体"** ⇒ 派生值与真实载体**从此分叉**，入站仍按派生值投递。 |
| **修法** | 新增 `carrierSessionIdForIm()`：**先问绑定真相源**（`current.dsh_session_bind`，D172 起的唯一真相源），**并必须传存活探针**（归档优先于 live）；取不到 / 未绑定 ⇒ 才退回派生值。落点 `src/im/inbound-event.ts`。 |
| 🔴 **为什么不是只改 `reconstruct`** | 让 `reconstruct` 把新载体派生回 `skiff-weixin-<code>` 会撞「一个会话至多一条轨迹」（第二次换代时旧 id 还被占着）；给派生函数加状态则是**造第二真相源**。绑定文件本来就是"此刻谁在承载它"，换来换去都写在这一个槽位里。 |
| **兜底不是旧行为** | 「未绑定 ⇒ 派生值」与「已绑定 ⇒ 绑定值」是**两种语义**，不是同一 bug 的宽容版：前者会由 `createTrajectoryAgent` 按派生 id 建出第一条载体。 |

### 判据（本次回归真正的教训）

⚠️ **旧的 10 条入站用例全绿，而它们看不见这个 bug** —— 因为它们**只走"还没有载体"那条路**
（先 `create` 出派生 id），那正是**派生值正确**的那一格 ⇒ **结构上不可能命中**。
⇒ 新增 2 条显式钉住两种状态：**已绑定**（投给绑定那条，⛔ 不按派生值另建）／
**绑定那条已被归档**（视同没绑定，⛔ 不投给归档会话）。

**变异检验**：把修复改回 `weixinSessionIdForTrajectory(trajectory)` ⇒
`--filter inbound` **精确红 1 条**（正是"已绑定 ⇒ 投给绑定的那条"），其余 11 条绿；还原后 12/12 全绿。

> 🔴 **可外推的判据**：**「派生值」只在"还没绑定"时成立**。凡把纯函数派生值当身份用的地方，
> 一旦引入"换代"能力，派生值与真实身份**必然分叉**，而分叉**没有任何机械信号** ——
> 投递成功、日志正常、只是投给了错的那一条。⇒ 身份类取值必须问**绑定真相源**，派生只作兜底。

---

## v1.121.0 — 2026-11-06（新工具 `reconstruct` ＋ 宿主 0.2.2 下状态面板点不开的修复）

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

### 面 A —— 新工具 `reconstruct`（累计用量过大时会话换代）

| 面 | 变更 |
|---|---|
| 🆕 **新工具 `reconstruct`**（条件可见） | `rebuild` 的**换代版**：建**新** dsh 会话 → 把同一条认知轨迹绑过去 → 在新会话注入继续锚点 → **归档旧会话**。`rebuild` 治"模型上下文太大"（原地清空，日志继续长）；它治"这条日志本身太大"（真正换一条日志）。owner 2026-11-06 令，**与 rebuild 并存**（Q3）。 |
| 🆕 **条件可见的新机制** | 全仓**唯一**用 `ctx.tools.register(def, { when })` 的工具：宿主每步 `resolve()` 时问一次，`false` ⇒ **既不进模型声明也不进派发**。其余条件工具的 `restrict({deny})` **只能 deny 不能 allow**，做不到"达阈值才放出来"。 |
| 🆕 **触发判据＝四桶全加，阈值 10 亿** | `tokenUsage.totals` 的 `uncachedInput + cacheRead + cacheWrite + output` 之和（= 宿主界面 pill 同口径）。⚠️ **只读 `uncachedInputTokens` 会差 37 倍**，让阈值在真需要它的会话上**永不触发**。 |
| 🆕 **提示词注入** | 达阈值时 `seams/keeper.ts` 每轮注入一句 `[RECONSTRUCT]`，含**会话 id ＋ 动作名**，不给 token 数值（D64）。 |
| **`createAndBindTarget` 增 `{ takeover }`** | 换代必须显式声明 takeover，否则 `claimBinding` 判 `TRAJECTORY_OCCUPIED`（旧载体此刻还活着）⇒ 新会话建出来却没绑上，回执只有一句 `⚠️ 绑定写入失败`。同时**必须传 `hostAliveProbe`**。 |

⚠️ **档位降级（如实登记）**：`register()` 的第二参数只在宿主 `≥0.2.2-rc.1` 存在
（`0.1.7` / `0.2.0` / `0.2.1` 三档签名是 `register(definition)`）。低档下多传的实参被 JS 静默忽略
⇒ 那个档位上 `reconstruct` **常驻可见**。这不是缺陷，是"宿主没这个能力"的降级；
`supportsActivation()` 把该读数写进 `AGENT_SESSIONS/.reconstruct-diag.json`，
让读数面能区分"没出现"与"出现了但藏不住"。

### 面 B —— 🔴 会话头部状态胶囊在宿主 0.2.2 上"点击弹不出来"（缺陷修复）

owner 报障原文：「升级到 0.2.2 后 这个地方点击弹不出来了」（红框 = 会话头部的 `Serenity vX.Y.Z | SAFE ON` 胶囊）。

| 面 | 变更 |
|---|---|
| 🔴 **根因** | 宿主 `0.2.2-rc.1` 给标题簇 `.titleCluster` 加了 **`mask-image: linear-gradient(…)`** 与 **`overflow: clip`**（`0.2.1-rc.2` 上这两条都没有）。`mask-image` 与 transform/filter/contain **同族** —— 都会**裁切 `position:fixed` 的后代** ⇒ v1.39.1 那条"改 fixed 就能逃出祖先裁切"的逃生路在该档位上**失效**，卡片整片被裁掉、看起来就是"点了没反应"。 |
| **修法** | 卡片改走 **`createPortal(…, document.body)`**；`position:fixed` **保留**（body 下仍是视口坐标，换父亲不改坐标系）。宿主自己的槽位契约也明写 *"overflow is clipped and faded … so overlays must portal"* ⇒ 这是照契约做，不是绕过宿主。 |
| 🔴 **同批必须付的一格** | portal 出去后卡片**不再在 `rootRef` 的 DOM 子树里** ⇒ "外点关闭"判据必须同时认 `popRef.current.contains(...)`，否则点卡片内部会被判成外部点击、**一开就关**。这一格不付就是修出第二个 bug。 |
| **文件** | `src/client/SafeModePanel.tsx`（portal ＋ 双 ref 判据）｜`SafeModePanel.css`（记录成因；`.sp-pop` 上的自定义属性随 portal 断链问题已就近说明）｜`client/tsconfig.json` ＋ `devDependencies` 加 `@types/react-dom`（**类型**基准；`react-dom` 本体一直在 `tsdown.config.ts` 的 `PLATFORM_MODULES` 里，external 由宿主模块表解析）。 |

⚠️ **一处说明面纠错（D151 同族）**：`SafeModePanel.css` 与 `client-popover-clip-guard.test.ts` 里
原先都写着 *"本仓 client 侧无 `react-dom` 依赖 ⇒ `createPortal` 不可用"* —— **那句是错的**，
正是它让这条路被绕开了一整年。已就地订正，并把"已验过祖先链无裁切"降级为**快照而非保证**。

<details>
<summary>判据与验收（点开）</summary>

- **口径取证两路独立**（互不共享代码路径）：
  ① 解压本会话日志（33,429 条事件）逐条累加 `assistant/message.usage` ⇒ 四桶 **1376.2 M**；
  ② 读宿主自己的持久化投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json`
     ⇒ `tokenUsage.totals` 四桶 **1391.2 M**（差值 = 中间又跑了一夜）。
  分桶对读：`uncachedInput 36.8 M` ／ `cacheRead 1351.2 M` ／ `output 3.0 M` ／ `cacheWrite 0`。
  ⇒ **只读 `uncachedInputTokens` = 37 M，差 37 倍**，而两个读数在代码里长得一样（D252 同族）。
- **正控（非恒空）**：另一条会话（`platform-9063`）同字段四桶 **322 M** ⇒ 该量确实随会话变化。
  ⚠️ 但 322 M **不能**充当"新会话从 0 起算"的证据（那要等真机变异检验）。
- **`when` 的三条契约约束**（宿主逐字）：rejection **fails step preparation** ⇒ 整段 try/catch 且失败静默；
  *"Conditions must not mutate registrations or start tool work"* ⇒ 只读投影 ＋ **按会话节流 60s** 落观测。
- **已知未被证明的一格**：`workspace/session-activity` 在轮末的窗口长度未测 ⇒ 归档走**延后 2s ＋ 有界 3 次**
  （成功即停，⛔ 不无限重试）；三次都失败则落诊断并停下（旧会话留在活跃清单，绑定已指向新载体）。
- **变异靶子**：`reconstruct.test.ts` 断言"只读 `uncachedInputTokens` 远小于四桶（>30 倍）**且低于阈值**"
  —— 实现若退化成单桶口径，这条精确红，而"能读到数"的弱断言仍会绿。
- **面 B 的形态守卫**（`tests/client-popover-clip-guard.test.ts`，新增 5 条）：
  ① 必须 `createPortal` 且挂到 `document.body` ② `{open && createPortal(`（关着不留 body 子节点）
  ③ 外点关闭必须**同时**认 `rootRef.current?.contains` 与 `popRef.current?.contains`
  ④ `position:fixed` 仍须保留 ⑤ `tsx` 里不得再出现"无 react-dom 依赖"这类断言。
  **变异检验两组各精确红 1 条**：去掉 portal ⇒ ②红；去掉 `popRef` 判据 ⇒ ③红（其余 13 条仍绿）。
  ⚠️ 单独盯 `position:fixed` 的那组**在这两次变异下全绿** —— 这恰好证明"只钉 fixed"方向已错（D252 同族）。

**门禁**（Node 24.22.2）：typecheck ✅ ／ typecheck-host 0.2.2-rc.1（node 100 文件 ／ client 193 文件）✅ ／
test **213 files / 3358** ✅ ／ coverage **95.05%** ✅。
</details>

---

## v1.120.0 — 2026-11-06（宿主 0.2.2-rc.1 适配：定时器工具改名后的屏蔽补全 ＋ 构建链 Node 24 兼容）

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

| 面 | 变更 |
|---|---|
| 🔴 **定时器工具屏蔽漏了一半**（缺陷修复） | 宿主 `0.2.2-rc.1` 把 `dsh-tool-schedule` 的工具名从 `schedule_update` / `schedule_delete` 改成 **`schedule_view` / `schedule_edit`**，而我们的 `HOST_SCHEDULE_TOOL_NAMES` 仍写着旧名 ⇒ **新名从未被屏蔽**（会话里可见可调），旧名则恒被宿主剔除（无效项）。已换成宿主当前真实四名。 |
| **构建链 Node 24 兼容** | `package.json` 的 `prepare` 加 `--config-loader unrun`：Node 24 起原生类型剥离不做 `.js`→`.ts` 后缀改写，否则 `tsdown.prepare.config.ts` 找不到 `tsdown.config.js`（**会直接打断 npm publish**）。 |

⚠️ **失效形态为什么值得单独记**：宿主 `restrict()` 对未知名**只剔除不报错**，我们自己的降级档还会把它打成
「跳过 N 个未注册名」——于是「旧名失效 ＋ 新名漏网」在读数面上**表现为一切正常**。
⇒ 判据：**这张表是宿主侧的事实，宿主改名必须同批改**；升级宿主后要**真机核一次工具面**（会话里能不能看见
`schedule_*`），⛔ 不能只信单元测试——它测的是我们的表，表错了它也绿。

<details>
<summary>判据与验收（点开）</summary>

- **取证**（⛔ 非推断，读本机装机包 `lib/index.js` 的 `name:` 声明）：
  `0.2.1-rc.2` = `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`；
  `0.2.2-rc.1` = `schedule_create` / `schedule_list` / **`schedule_view`** / **`schedule_edit`**。
- **测试改钉「宿主当前真实名」**，并新增一条**负向钉**：`schedule_update` / `schedule_delete` **不得回流**。
  理由：回流**不报错**（宿主只剔除），是零信号熵（D151 同族）。
- **变异检验**：把 `schedule_update` 塞回表 ⇒ `--filter guards` **精确红 3 条**（其中含那条负向钉），
  还原后三文件 **117 用例**全绿。⇒ 判据有判别力，不是恒真断言。
- **降级路径未受影响**：宿主 `restrict()` 的错误文案与 0.2.1 **逐字相同**
  （`tools.restrict() names unknown global tool[s] "…"; known global tools: …`）⇒ `parseUnknownToolNames` 无需改。
- 🔴 **构建产物核验踩过的坑**：`lib/index.js` 的字节数与上一版**一模一样**，而改动其实已进
  `lib/contract-*.js`（tsdown 拆 chunk）。⇒ **「字节数没变」不等于「没生效」**，判据必须扫整个 `lib/`（D257 同族）。

**门禁**（全部在 **Node 24.22.2** 上）：typecheck ✅ ／ typecheck-host **0.2.2-rc.1 ＋ 0.2.1-rc.2** 双档 ✅ ／
test **212 files / 3330** ✅ ／ coverage **95.33%** ✅ ／ build ✅ ／ pack-check **173 文件** ✅。
</details>

---

## v1.119.0 — 2026-11-05（工作语域块 ＋ 网关只允许 TOTP ＋ 会话跨重启持久化）

> 🔴 标题行格式是**机器契约**：`dsh-develop version` 用 `/^## v([\d.]+)/m` 取版本号 ⇒
> 必须是**两个井号 ＋ 空格 ＋ v<semver>**。⛔ 不要为了排版改成 `###`／`#`（会报「CHANGELOG 无条目」）。

| 面 | 变更 |
|---|---|
| **工作语域块**（`seams/work-register.ts`，新增） | 压缩开场白／免责声明／重复征求许可。🔴 **刻意不引入「取消判断」类条款**——被拒是语域问题，不是判断错了。配置键 `workRegister.enabled`，**缺省开**。 |
| **网关口令登录整条退役** | 只认 TOTP：删 `passOk`、不读 `password`、登录页去掉密码框。失败文案改为「用户名或验证码错误」（不泄露账号是否存在）。 |
| **会话跨重启持久化** | 落盘 `~/.dsh/serenity-gateway-sessions.json`（0600、原子 `rename`）＋ **双 TTL**（24h 空闲滑动 ＋ **30 天绝对上限**）＋ cookie `Max-Age` 由绝对上限派生。 |

⚠️ **行为变更（须知道）**：`totpEnabled=false` 现在等于**网关没有登录方式**（口令已退役）。
此时正确操作是关闭网关，⛔ 不是退回口令。

<details>
<summary>判据与验收（点开）</summary>

- 新增 `tests/gateway-totp-only.test.ts`：**反向钉**「口令不再参与判定」。
  ⚠️ 第一版栽在**正则命中自己的注释**上 ⇒ 改为**先剥注释再看代码**（D275：钉赋值式，⛔ 不钉名字）。
- `gateway.test.ts` 4 处旧用例按语义重写：**口令即使正确也必须 401**（这是判别力所在）。
- 20+ 个既有网关用例的夹具从「密码登录」改为 **TOTP 真码**（`tests/helpers/totp-fixture.ts`）。
  按 D274 **改钉本意**：那些用例的本意是「拿到一个有效会话再测别的东西」，换的是**怎么拿到会话**，
  ⛔ 不是把断言期望值改松。
- 写盘失败**不阻断登录**（可用性优先）⇒ 磁盘满／只读时「记住登录」不成立。**这是有意的降级，不是漏洞。**
- 六门禁全绿：test ／ coverage ／ typecheck ／ typecheck-host ／ build ／ pack-check。

</details>

---

## 二、跨版本索引

> **粒度说明**：v1.100.0 起逐版列出（当前活跃期）；更早按**系列**归并。
> 每行都能在 `CHANGELOG-archive.md` 里按版本号检索到完整条目。

### 2.1 当前活跃期（v1.100.0 ~ v1.127.1，2026-10-24 ~ 2026-11-09）

> ⚠️ **2026-11-09 补**：本表原停在 v1.119.0，而正文早已写到 v1.125.0 ⇒ 有五版**正文有条目、索引没有行**。
> "索引是完整的"这件事**没有机械信号**，只能靠人发现。补 v1.120.0~v1.126.0 七行。
> 🔴 **同日第二次**（v1.127.0 发布时）：从 v1.126.0 起改为**发版同批加索引行**，⛔ 不留到下轮补。

| 版本 | 日期 | 一句话 |
|---|---|---|
| v1.128.2 | 2026-11-09 | 🔴 槽位看守**从未工作过**（根解析恒 null 且全程静默）⇒ 改用 `listCccs` 逐根看守 ＋ 零根必告警 |
| v1.128.1 | 2026-11-09 | 🔴 M4 判据假阳（`--profile` 含 `file`）＋ 槽位端口段 9301–9320 不被旧 MSM 认 ＋ `--profile` 真逃逸收窄 |
| v1.128.0 | 2026-11-09 | 🆕 ACC 级浏览器槽位管理器 `browser_slot`：20 槽位／独立 profile／占用归属／看守反向注入 ＋ 页面省电闸 |
| v1.127.1 | 2026-11-09 | 🔴 蓝图标题栏写假数字：注册表顶层键找错（`entries` vs `msms`）⇒ `msm` 恒 0 |
| v1.127.0 | 2026-11-09 | 蓝图档补**标注层**（6 条引线＋标题栏）＋ 清掉四类深色语汇残留 |
| v1.126.0 | 2026-11-09 | 浅色主题下航行页改「工程蓝图」语汇 ＋ 主题接线进机械门禁 |
| v1.125.0 | 2026-11-09 | 白色主题适配：`.sp-popVoyage` 写死深色压黑面板（定因＝文字走 token、底色不走） |
| v1.124.0 | 2026-11-09 | 注入面瘦身：删工具清单 ＋ 工作语域加第 7 条「一次最多问 5 个」 |
| v1.123.0 | 2026-11-06 | 工具屏蔽重整：三张表各归各位 ＋ 退役 `safeMode.hiddenTools` |
| v1.122.0 | 2026-11-06 | 🔴 P0 回归修复：`reconstruct` 换代后 IM 入站投给已归档的旧载体 |
| v1.121.0 | 2026-11-06 | 新工具 `reconstruct` ＋ 宿主 0.2.2 下状态面板点不开的修复 |
| v1.120.0 | 2026-11-06 | 宿主 0.2.2-rc.1 适配：定时器工具改名后的屏蔽补全 ＋ 构建链 Node 24 兼容 |
| v1.119.0 | 2026-11-05 | 工作语域块 ＋ 网关只认 TOTP ＋ 会话跨重启持久化 |
| v1.118.0 | 2026-11-04 | 脱口秀片段：会话／rebuild 时随机注入一段到系统提示词 |
| v1.117.0 | 2026-11-04 | 用户手工停止的轮次不再被自动续跑 |
| v1.116.0 | 2026-11-04 | 统一手册体系：索引由登记表生成，全部手册可见（D286） |
| v1.115.0 | 2026-11-04 | `msm` 成功路径不再套信封：成功直出 stdout，失败保留完整结构（D285） |
| v1.114.1 | 2026-11-04 | 修：中断续跑的「有调用无结果的工具」失真成整轮调用清单 |
| v1.114.0 | 2026-11-04 | 重构：DII 动态提示词注入架构 —— 六条轴从注释变成字段 |
| v1.113.2 | 2026-11-03 | 修：subagent 任务书被记进用户语录 |
| v1.113.1 | 2026-11-02 | 收窄 v1.113.0 关于 IM 渠道的一处表述 |
| v1.113.0 | 2026-11-02 | 用户语录台账：按天／按轨迹／全文记录用户直话 |
| v1.112.0 | 2026-11-02 | 四条令一批：砍 `wait`／节律 60s／轮询性能地基／注入外壳精简 |
| v1.111.0 | 2026-11-01 | 订阅面板**可读性**：目录名不再直接上屏 |
| v1.110.0 | 2026-11-01 | 轨迹订阅搬到 **CCC 面板** —— 取数入口选错了层（D273） |
| v1.109.0 | 2026-11-01 | 诊断面补一格：订阅的**评估计数** —— 「没装配」与「没命中」不再同形 |
| v1.108.0 | 2026-11-01 | 轨迹订阅读数上设置面板 ＋ 只读端点 |
| v1.107.0 | 2026-11-01 | 轨迹消息订阅：观察者盯一组成员，任一轮结束即通知 |
| v1.106.0 | 2026-11-01 | `ask_user_question` 常驻隐藏 ＋ `acc-diag` 并入 `dashboard diag`、`exclusiveTools` 整删 |
| v1.105.0 | 2026-10-29 | 🔴 P0 回归修复：`{{model}}` 严格插值 —— 「不传」不等于「安全」（D260） |
| v1.104.0 | 2026-10-28 | 🔴 `cheap-worker` 整条下线 ＋ minimax 示例值中立化 |
| v1.103.0 | 2026-10-27 | 载体资格守卫：subagent 子会话不得成为认知轨迹载体 |
| v1.102.0 | 2026-10-27 | 修 IM 入口 model 静默回落：未声明 `model` 不再退到杂工模型 |
| v1.101.0 | 2026-10-26 | 砍掉 `container_fs` 的 `append` 子命令 |
| v1.100.0 | 2026-10-24 | 🔴 修复工具可见性：降级档把宿主工具整类丢掉 ＋ 降级后永久不再重试 |

### 2.2 更早（v1.22.0 ~ v1.99.0）—— 按系列归并

| 系列 | 起止版本 | 日期 | 这一系列主要在做什么 |
|---|---|---|---|
| **v1.9x** | v1.90.0 ~ v1.99.0 | 2026-10-23 ~ 10-24 | **可观测性与「漏判」整类修复**：`live ≠ 在跑` 的排除口径统一、`interrupted` 扫描纳入 `aborted`、轮内被打断形态 B、入站改 `steer` 不再排队、`turn-stopping ≠ 轮结束`、CRO／中断守护多轮收敛、`cognitive_trajectory` 描述按 EAP 重写。 |
| **v1.8x** | v1.80.0 ~ v1.89.0 | 2026-10-20 ~ 10-23 | **协议面收敛**：绑定真相源搬回轨迹自己、`use` 无条件覆盖、编码终身唯一、轨迹声明收拢 `trajectory.json`、IM 桥泛化＋飞书通道、出站只剩 `im-bridge` 一条路、投递面三处缺陷修复、`no-wake` 第三态。 |
| **v1.7x** | v1.70.0 ~ v1.79.0 | 2026-10-19 ~ 10-20 | **轨迹作为主体**：`skiff`→轨迹约束更名、轨迹提示词取代人格、`fake-initial-turns` 取代 first-anchor、`cognitive_trajectory` 八动作成形、README 按 EAP 重写、所有配置键改为可选。 |
| **v1.6x** | v1.60.0 ~ v1.69.0 | 2026-10-17 ~ 10-18 | **改名与瘦身**：`trajectory` → `cognitive trajectory`、轨迹 UID、轨迹无生命周期＋`archive`、无人值守代理回复整条退役、ACP 整面删除、界面文案按 EAP 修订、航行页 3D。 |
| **v1.5x** | v1.50.0 ~ v1.59.0 | 2026-09-27 ~ 10-17 | **工具面扩张**：`diagram` 工具、本体引擎 `ontology`、serenity-skill 分层抽象树、图进回答、safe mode 可关工具、IM 桥多通道、DSH 0.2.0／0.2.1 适配、公开面隐私清理。 |
| **v1.4x** | v1.40.0 ~ v1.49.0 | 2026-09-19 ~ 09-26 | **底座与适配**：绑定载体迁入宿主存储域、CRO（自判何时被叫醒）、CCC 级 skill 供给、用量统计、工程化底座（顶层约束／模块地图／单测 35 件）、交界材料分家 `REBUILD-TODO.md`、DSH 0.1.7／0.2.0 适配。 |
| **v1.3x** | v1.30.0 ~ v1.39.3 | 2026-09-06 ~ 09-18 | **工具面 13→10 合一**、`container_trajectory` 成形与两次更名（`wake-later`→`send-later`、`send-message`→`send-now`）、`im-bridge` 归 ACC、微信桥多账号、宿主契约层＋编译期事件契约、`host-upgrade` 维护通道、autopilot 退场。 |
| **v1.2x** | v1.20.0 ~ v1.29.2 | 2026-08-24 ~ 09-06 | **初始骨架**：双端口网关、`session_rebuild`、会话命名、状态卡与面板、登录安全（CSRF／TOTP）、微信桥 iLink 接入、skiff 认知子集角色、图片落盘、0.1.2-rc.1 适配。 |
| **v0.x ~ v1.21.x** | v0.0.1 ~ v1.21.0 | 2026-08-06 ~ 08-26 | 见 archive —— 立项骨架（`v0.0.1` 起）到早期工具面成型。 |

---

## 三、怎么写新条目（给下一个维护者）

1. **一条版本 = 一段**，标题行固定 `## v<semver> — <YYYY-MM-DD>（一句话）`。
   🔴 `dsh-develop version` 用它取版本号 ⇒ **标题行格式不许改**。
2. **只写「变了什么 ＋ 使用者要注意什么」**。理由、被否项、用例数、覆盖率——那些进 commit message 与
   `AGENT_SESSIONS/<轨迹>/references/`，⛔ 不进本文件（本文件要能被人读完）。
3. **行为变更必须显式标**（用户可能依赖旧行为）。破坏性变更用 🔴。
4. **不写会随发布漂移的读数**（"共 N 个测试"会过期）—— 只写「六门禁全绿」这类稳定陈述。
5. 条目只追加在最上面；**不重写历史条目**（历史在 archive，archive 只读）。
