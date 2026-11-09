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
