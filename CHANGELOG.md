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

### 2.1 当前活跃期（v1.100.0 ~ v1.119.0，2026-10-24 ~ 2026-11-05）

| 版本 | 日期 | 一句话 |
|---|---|---|
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
